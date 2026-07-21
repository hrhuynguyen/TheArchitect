import { defaultRequirementsProfile } from "@architect/contracts";
import Fastify from "fastify";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  ownerCookieName,
  participantCookieName,
} from "../auth/cookies.js";
import { hashOwnerToken } from "../auth/ownerToken.js";
import { signParticipant } from "../auth/participant.js";
import { registerArchitectureRoutes } from "./architecture.routes.js";
import { ArchitectureServiceError } from "./revision.service.js";

const signingSecret = "architecture-cookie-signing-secret-32-characters";
const ownerPepper = "architecture-owner-token-pepper-32-characters";
const ownerToken = "owner-token-a";
const roomId = "room-a";
const participantId = "participant-a";
const requirements = defaultRequirementsProfile();
const architecture = {
  version: "architecture/v1" as const,
  requirements,
  resources: [],
  relationships: [],
  decisions: [],
  unresolvedQuestions: [],
};
const state = {
  architecture: {
    version: "working-architecture/v1" as const,
    revisionId: "revision-a",
    architecture,
  },
  layout: {
    version: "architecture-layout/v1" as const,
    revisionId: "revision-a",
    nodes: [],
  },
};
const revision = {
  id: "revision-b",
  roomId,
  version: 2,
  architecture,
  layout: { ...state.layout, revisionId: "revision-b" },
  requirements,
  stage: "prototype" as const,
  authorType: "participant" as const,
  authorId: participantId,
  rationale: "Capture the accepted graph.",
  createdAt: "2026-07-21T12:00:00.000Z",
};
const event = {
  id: "event-b",
  roomId,
  kind: "architecture_revision_saved",
  status: "succeeded" as const,
  actorType: "participant" as const,
  actorId: participantId,
  title: "Architecture revision saved",
  summary: "Capture the accepted graph.",
  details: { revisionId: "revision-b", baseRevisionId: "revision-a", version: 2 },
  traceId: "request-7",
  createdAt: "2026-07-21T12:00:00.000Z",
};
const operationBody = {
  baseRevisionId: "revision-a",
  operations: [{
    type: "add_resource" as const,
    resource: {
      id: "queue",
      type: "SQS" as const,
      name: "Queue",
      properties: {},
      origin: "explicit" as const,
      reason: "Added manually.",
      approvalStatus: "not-required" as const,
    },
  }],
};
const saveBody = {
  baseRevisionId: "revision-a",
  rationale: "Capture the accepted graph.",
};

let ownerTokenHash: string;
beforeAll(async () => {
  ownerTokenHash = await hashOwnerToken(ownerToken, ownerPepper);
});

function cookie(name: string, value: string) {
  return `${name}=${encodeURIComponent(value)}`;
}

function memberCookie(targetRoom = roomId, targetParticipant = participantId) {
  return cookie(
    participantCookieName(targetRoom),
    signParticipant(
      { roomId: targetRoom, participantId: targetParticipant },
      signingSecret,
    ),
  );
}

function ownerCookie(targetRoom = roomId, token = ownerToken) {
  return cookie(ownerCookieName(targetRoom), token);
}

function setup(options: {
  operationError?: Error;
  revisionError?: Error;
  historyError?: Error;
} = {}) {
  const rooms = new Map([
    [roomId, { id: roomId, ownerTokenHash }],
    ["room-b", { id: "room-b", ownerTokenHash: "other-owner" }],
  ]);
  const members = new Set([`${roomId}:${participantId}`, "room-b:participant-b"]);
  const service = {
    applyOperations: vi.fn(async () => {
      if (options.operationError) throw options.operationError;
      return { ok: true as const, state, diagnostics: [] };
    }),
    saveRevision: vi.fn(async () => {
      if (options.revisionError) throw options.revisionError;
      return { revision, event };
    }),
    listHistory: vi.fn(async () => {
      if (options.historyError) throw options.historyError;
      return { revisions: [revision], events: [event] };
    }),
  };
  const database = {
    participant: {
      async findFirst({ where }: any) {
        return members.has(`${where.roomId}:${where.id}`) ? { id: where.id } : null;
      },
    },
    room: {
      async findUnique({ where }: any) { return rooms.get(where.id) ?? null; },
    },
  };
  const app = Fastify({ logger: false });
  registerArchitectureRoutes(app, {
    database,
    service: service as never,
    getConfig: () => ({
      nodeEnv: "test",
      cookieSigningSecret: signingSecret,
      ownerTokenPepper: ownerPepper,
    }),
  });
  return { app, members, rooms, service };
}

describe("authenticated architecture routes", () => {
  it("allows only a signed durable participant to mutate working architecture", async () => {
    const { app, service } = setup();
    try {
      const operations = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/operations`,
        headers: { cookie: memberCookie() },
        payload: operationBody,
      });
      expect(operations.statusCode).toBe(200);
      expect(service.applyOperations).toHaveBeenCalledWith({
        roomId,
        request: operationBody,
      });

      const saved = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/revisions`,
        headers: { cookie: memberCookie() },
        payload: saveBody,
      });
      expect(saved.statusCode).toBe(201);
      expect(service.saveRevision).toHaveBeenCalledWith({
        roomId,
        participantId,
        traceId: expect.any(String),
        request: saveBody,
      });

      for (const url of [
        `/api/rooms/${roomId}/operations`,
        `/api/rooms/${roomId}/revisions`,
      ]) {
        const owner = await app.inject({
          method: "POST",
          url,
          headers: { cookie: ownerCookie() },
          payload: url.includes("operations") ? operationBody : saveBody,
        });
        expect(owner.statusCode).toBe(401);
      }
      expect(service.applyOperations).toHaveBeenCalledOnce();
      expect(service.saveRevision).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("allows a durable participant or room owner to read revision history", async () => {
    const { app, service } = setup();
    try {
      for (const header of [memberCookie(), ownerCookie()]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/rooms/${roomId}/revisions`,
          headers: { cookie: header },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          revisions: [{ id: "revision-b" }],
          events: [{ id: "event-b" }],
        });
      }
      expect(service.listHistory).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it.each([
    ["missing", undefined],
    ["tampered", cookie(
      participantCookieName(roomId),
      `${signParticipant({ roomId, participantId }, signingSecret)}x`,
    )],
    ["cross-room", memberCookie("room-b", "participant-b")],
  ])("denies %s credentials", async (_name, header) => {
    const { app } = setup();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/rooms/${roomId}/revisions`,
        ...(header ? { headers: { cookie: header } } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        code: "unauthorized",
        message: "Unauthorized",
      });
    } finally {
      await app.close();
    }
  });

  it("maps stale bases to 409 and invalid state or layout to 422", async () => {
    for (const [error, expectedStatus] of [
      [new ArchitectureServiceError("STALE_REVISION", "revision-newer"), 409],
      [new ArchitectureServiceError("INVALID_LAYOUT"), 422],
    ] as const) {
      const { app } = setup({ operationError: error });
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/rooms/${roomId}/operations`,
          headers: { cookie: memberCookie() },
          payload: operationBody,
        });
        expect(response.statusCode).toBe(expectedStatus);
        expect(response.json()).toMatchObject({
          code: expectedStatus === 409 ? "stale_revision" : "invalid_architecture_request",
        });
        expect(response.json()).not.toHaveProperty("stack");
      } finally {
        await app.close();
      }
    }
  });

  it("rejects malformed strict bodies before invoking the service", async () => {
    const { app, service } = setup();
    try {
      const operations = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/operations`,
        headers: { cookie: memberCookie() },
        payload: { ...operationBody, ignored: true },
      });
      const revisionResponse = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/revisions`,
        headers: { cookie: memberCookie() },
        payload: { ...saveBody, rationale: " " },
      });
      expect(operations.statusCode).toBe(422);
      expect(revisionResponse.statusCode).toBe(422);
      expect(service.applyOperations).not.toHaveBeenCalled();
      expect(service.saveRevision).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("maps missing architecture to 404 and unexpected failures to 503", async () => {
    const missing = setup({
      historyError: new ArchitectureServiceError("ARCHITECTURE_NOT_FOUND"),
    });
    try {
      const response = await missing.app.inject({
        method: "GET",
        url: `/api/rooms/${roomId}/revisions`,
        headers: { cookie: memberCookie() },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await missing.app.close();
    }

    const unavailable = setup({ operationError: new Error("database secret") });
    try {
      const response = await unavailable.app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/operations`,
        headers: { cookie: memberCookie() },
        payload: operationBody,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "architecture_unavailable",
        message: "Architecture unavailable",
      });
    } finally {
      await unavailable.app.close();
    }
  });
});

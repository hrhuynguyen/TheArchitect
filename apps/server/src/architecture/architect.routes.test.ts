import {
  ArchitectApiErrorResponseSchema,
  ArchitectTurnListSchema,
  ArchitectTurnSchema,
} from "@architect/contracts";
import Fastify from "fastify";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  ownerCookieName,
  participantCookieName,
} from "../auth/cookies.js";
import { hashOwnerToken } from "../auth/ownerToken.js";
import { signParticipant } from "../auth/participant.js";
import { ArchitectServiceError } from "./architect.service.js";
import { registerArchitectRoutes } from "./architect.routes.js";

const signingSecret = "architect-route-signing-secret-at-least-32-characters";
const ownerPepper = "architect-route-owner-pepper-at-least-32-characters";
const ownerToken = "owner-token-a";
const roomId = "room-a";
const participantId = "participant-a";

const proposalTurn = ArchitectTurnSchema.parse({
  id: "turn-a",
  roomId,
  baseRevisionId: "revision-a",
  message: "Add a queue.",
  actorType: "participant",
  actorId: participantId,
  idempotencyKey: "turn-request-a",
  sourceSnapshotVersion: 7,
  sourceProtectedDigest:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  traceId: "architect:turn-a",
  state: "proposal_ready",
  kind: "proposal",
  responseText: "I can add an SQS queue.",
  operations: [{
    type: "add_resource",
    resource: {
      id: "orders-queue",
      type: "SQS",
      name: "Orders queue",
      properties: {},
    },
    reason: "Buffer order work across transient worker failures.",
  }],
  appliedRevisionId: null,
  error: null,
  createdAt: "2026-07-21T12:00:00.000Z",
  reviewedAt: null,
  reviewedByParticipantId: null,
  reviewRationale: null,
});

const createBody = {
  message: "Add a queue.",
  idempotencyKey: "turn-request-a",
};
const applyBody = {
  baseRevisionId: "revision-a",
  idempotencyKey: "apply-request-a",
  rationale: "The queue improves failure isolation.",
};
const rejectBody = {
  idempotencyKey: "reject-request-a",
  rationale: "Keep the synchronous design for this release.",
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

function setup(error?: Error) {
  const rooms = new Map([
    [roomId, { id: roomId, ownerTokenHash }],
    ["room-b", { id: "room-b", ownerTokenHash: "other-owner" }],
  ]);
  const members = new Set([`${roomId}:${participantId}`, "room-b:participant-b"]);
  const service = {
    runTurn: vi.fn(async () => {
      if (error) throw error;
      return proposalTurn;
    }),
    listTurns: vi.fn(async () => {
      if (error) throw error;
      return { turns: [proposalTurn] };
    }),
    applyPatch: vi.fn(async () => {
      if (error) throw error;
      return ArchitectTurnSchema.parse({
        ...proposalTurn,
        state: "applied",
        appliedRevisionId: "revision-b",
        reviewedAt: "2026-07-21T12:01:00.000Z",
        reviewedByParticipantId: participantId,
        reviewRationale: applyBody.rationale,
      });
    }),
    rejectPatch: vi.fn(async () => {
      if (error) throw error;
      return ArchitectTurnSchema.parse({
        ...proposalTurn,
        state: "rejected",
        reviewedAt: "2026-07-21T12:01:00.000Z",
        reviewedByParticipantId: participantId,
        reviewRationale: rejectBody.rationale,
      });
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
  const app = Fastify({
    logger: false,
    routerOptions: { maxParamLength: 256 },
  });
  registerArchitectRoutes(app, {
    database,
    service: service as never,
    getConfig: () => ({
      nodeEnv: "test",
      cookieSigningSecret: signingSecret,
      ownerTokenPepper: ownerPepper,
    }),
  });
  return { app, members, service };
}

describe("authenticated architect routes", () => {
  it("allows a participant or verified owner to create and list turns", async () => {
    const { app, service } = setup();
    try {
      for (const [header, expectedActor] of [
        [memberCookie(), { type: "participant", id: participantId }],
        [ownerCookie(), { type: "owner", id: `owner:${roomId}` }],
      ] as const) {
        const created = await app.inject({
          method: "POST",
          url: `/api/rooms/${roomId}/architect/turns`,
          headers: { cookie: header },
          payload: createBody,
        });
        expect(created.statusCode).toBe(201);
        expect(() => ArchitectTurnSchema.parse(created.json())).not.toThrow();
        expect(service.runTurn).toHaveBeenLastCalledWith({
          roomId,
          actor: expectedActor,
          request: createBody,
        });

        const listed = await app.inject({
          method: "GET",
          url: `/api/rooms/${roomId}/architect/turns`,
          headers: { cookie: header },
        });
        expect(listed.statusCode).toBe(200);
        expect(() => ArchitectTurnListSchema.parse(listed.json())).not.toThrow();
        expect(listed.json()).toMatchObject({ turns: [{ id: "turn-a" }] });
      }
      expect(service.listTurns).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("allows only a durable participant to apply or reject", async () => {
    const { app, service } = setup();
    try {
      const applied = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/architect/patches/turn-a/apply`,
        headers: { cookie: memberCookie() },
        payload: applyBody,
      });
      expect(applied.statusCode).toBe(200);
      expect(() => ArchitectTurnSchema.parse(applied.json())).not.toThrow();
      expect(service.applyPatch).toHaveBeenCalledWith({
        roomId,
        proposalId: "turn-a",
        participantId,
        traceId: expect.any(String),
        request: applyBody,
      });

      const rejected = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/architect/patches/turn-a/reject`,
        headers: { cookie: memberCookie() },
        payload: rejectBody,
      });
      expect(rejected.statusCode).toBe(200);
      expect(() => ArchitectTurnSchema.parse(rejected.json())).not.toThrow();
      expect(service.rejectPatch).toHaveBeenCalledWith({
        roomId,
        proposalId: "turn-a",
        participantId,
        request: rejectBody,
      });

      for (const action of ["apply", "reject"]) {
        const owner = await app.inject({
          method: "POST",
          url: `/api/rooms/${roomId}/architect/patches/turn-a/${action}`,
          headers: { cookie: ownerCookie() },
          payload: action === "apply" ? applyBody : rejectBody,
        });
        expect(owner.statusCode).toBe(401);
      }
      expect(service.applyPatch).toHaveBeenCalledOnce();
      expect(service.rejectPatch).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("denies a valid signed participant cookie after the durable membership is removed", async () => {
    const { app, members, service } = setup();
    members.delete(`${roomId}:${participantId}`);
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/rooms/${roomId}/architect/turns`,
        headers: { cookie: memberCookie() },
      });
      expect(response.statusCode).toBe(401);
      expect(ArchitectApiErrorResponseSchema.parse(response.json())).toEqual({
        code: "unauthorized",
        message: "Unauthorized",
      });
      expect(service.listTurns).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("denies an invalid owner token and cross-room mutations", async () => {
    const { app, service } = setup();
    try {
      const invalidOwner = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/architect/turns`,
        headers: { cookie: ownerCookie(roomId, "invalid-owner-token") },
        payload: createBody,
      });
      const crossRoomApply = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/architect/patches/turn-a/apply`,
        headers: { cookie: memberCookie("room-b", "participant-b") },
        payload: applyBody,
      });
      expect(invalidOwner.statusCode).toBe(401);
      expect(crossRoomApply.statusCode).toBe(401);
      expect(() => ArchitectApiErrorResponseSchema.parse(invalidOwner.json())).not.toThrow();
      expect(() => ArchitectApiErrorResponseSchema.parse(crossRoomApply.json())).not.toThrow();
      expect(service.runTurn).not.toHaveBeenCalled();
      expect(service.applyPatch).not.toHaveBeenCalled();
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
  ])("denies %s credentials without cross-room disclosure", async (_name, header) => {
    const { app } = setup();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/rooms/${roomId}/architect/turns`,
        ...(header ? { headers: { cookie: header } } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ code: "unauthorized", message: "Unauthorized" });
    } finally {
      await app.close();
    }
  });

  it("rejects loose bodies before service invocation", async () => {
    const { app, service } = setup();
    try {
      for (const [url, payload] of [
        [`/api/rooms/${roomId}/architect/turns`, { ...createBody, ignored: true }],
        [`/api/rooms/${roomId}/architect/patches/turn-a/apply`, {
          ...applyBody,
          baseRevisionId: "",
        }],
        [`/api/rooms/${roomId}/architect/patches/turn-a/reject`, {
          ...rejectBody,
          rationale: "",
        }],
      ]) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: { cookie: memberCookie() },
          payload,
        });
        expect(response.statusCode).toBe(422);
      }
      expect(service.runTurn).not.toHaveBeenCalled();
      expect(service.applyPatch).not.toHaveBeenCalled();
      expect(service.rejectPatch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects oversized patch ids before service invocation", async () => {
    const { app, service } = setup();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/architect/patches/${"p".repeat(201)}/apply`,
        headers: { cookie: memberCookie() },
        payload: applyBody,
      });
      expect(response.statusCode).toBe(422);
      expect(() => ArchitectApiErrorResponseSchema.parse(response.json())).not.toThrow();
      expect(service.applyPatch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["REVISION_CONFLICT", 409, "revision_conflict"],
    ["WORKING_STATE_CONFLICT", 409, "working_state_conflict"],
    ["TERMINAL_CONFLICT", 409, "terminal_conflict"],
    ["IDEMPOTENCY_CONFLICT", 409, "idempotency_conflict"],
    ["DESTRUCTIVE_CONFIRMATION_REQUIRED", 422, "destructive_confirmation_required"],
    ["INVALID_AGENT_PATCH", 422, "invalid_agent_patch"],
    ["ARCHITECT_TURN_NOT_FOUND", 404, "architect_turn_not_found"],
  ] as const)("maps %s to a bounded response", async (code, status, publicCode) => {
    const { app } = setup(new ArchitectServiceError(code, "revision-current"));
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/architect/patches/turn-a/apply`,
        headers: { cookie: memberCookie() },
        payload: applyBody,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code: publicCode });
      expect(() => ArchitectApiErrorResponseSchema.parse(response.json())).not.toThrow();
      expect(JSON.stringify(response.json())).not.toContain("provider");
      expect(JSON.stringify(response.json())).not.toContain("sourceProtectedState");
    } finally {
      await app.close();
    }
  });

  it("maps unknown failures to a bounded unavailable response without internals", async () => {
    const raw = "raw-service-stack-and-secret";
    const { app } = setup(new Error(raw));
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/rooms/${roomId}/architect/turns`,
        headers: { cookie: memberCookie() },
      });
      expect(response.statusCode).toBe(503);
      expect(ArchitectApiErrorResponseSchema.parse(response.json())).toEqual({
        code: "architect_unavailable",
        message: "Architect unavailable",
      });
      expect(response.body).not.toContain(raw);
      expect(response.body).not.toContain("stack");
    } finally {
      await app.close();
    }
  });

  it("maps a future architect service code to the bounded unavailable response", async () => {
    const { app } = setup(new ArchitectServiceError("FUTURE_CODE" as never));
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/rooms/${roomId}/architect/turns`,
        headers: { cookie: memberCookie() },
      });
      expect(response.statusCode).toBe(503);
      expect(ArchitectApiErrorResponseSchema.parse(response.json())).toEqual({
        code: "architect_unavailable",
        message: "Architect unavailable",
      });
    } finally {
      await app.close();
    }
  });
});

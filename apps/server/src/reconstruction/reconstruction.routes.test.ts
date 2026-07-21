import { defaultRequirementsProfile } from "@architect/contracts";
import Fastify from "fastify";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  ownerCookieName,
  participantCookieName,
} from "../auth/cookies.js";
import { hashOwnerToken } from "../auth/ownerToken.js";
import { signParticipant } from "../auth/participant.js";
import { ReconstructionRequestError } from "./reconstruction.service.js";
import { registerReconstructionRoutes } from "./reconstruction.routes.js";

const signingSecret = "route-cookie-signing-secret-at-least-32-characters";
const ownerPepper = "route-owner-token-pepper-at-least-32-characters";
const ownerToken = "owner-token-a";
const roomId = "room-a";
const participantId = "participant-a";
const IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const requestBody = {
  imageDataUrl: IMAGE,
  mimeType: "image/png",
  requirements: defaultRequirementsProfile(),
  sourceSnapshotVersion: 7,
};
const running = {
  jobId: "job-a",
  sourceSnapshotVersion: 7,
  state: "running" as const,
  result: null,
  error: null,
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
  debug?: boolean;
  nodeEnv?: "development" | "test" | "production";
  reconstructError?: Error;
} = {}) {
  const rooms = new Map([
    [roomId, { id: roomId, ownerTokenHash }],
    ["room-b", { id: "room-b", ownerTokenHash: "not-owner-a" }],
  ]);
  const members = new Set([`${roomId}:${participantId}`, "room-b:participant-b"]);
  const service = {
    reconstruct: vi.fn(async () => {
      if (options.reconstructError) throw options.reconstructError;
      return running;
    }),
    currentJob: vi.fn(async (requestedRoom: string) =>
      requestedRoom === roomId ? running : null),
    jobById: vi.fn(async (requestedRoom: string, jobId: string) =>
      requestedRoom === roomId && jobId === "job-a" ? running : null),
    debugAnalyze: vi.fn(async () => ({
      provider: { provider: "openai", model: "gpt-5.6" },
      intent: { version: "infrastructure-intent/v1", resources: [], relationships: [] },
      diagnostics: [],
      stageDecision: {
        version: "stage-decision/v1",
        stage: "prototype",
        confidence: "high",
        reasons: ["Prototype fit."],
        requiresApproval: false,
        proposedUpgrades: [],
      },
      deploymentPlan: {
        version: "deployment-plan/v1",
        stage: "prototype",
        requiresApproval: false,
        approvalsSatisfied: true,
        pendingApprovalResourceIds: [],
        pendingApprovalRelationshipIds: [],
        architecture: {
          version: "architecture/v1",
          requirements: defaultRequirementsProfile(),
          resources: [],
          relationships: [],
          decisions: [],
          unresolvedQuestions: [],
        },
      },
      semanticGraph: {
        version: "architecture/v1",
        requirements: defaultRequirementsProfile(),
        resources: [],
        relationships: [],
        decisions: [],
        unresolvedQuestions: [],
      },
    })),
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
  registerReconstructionRoutes(app, {
    database,
    service: service as never,
    getConfig: () => ({
      nodeEnv: options.nodeEnv ?? "test",
      cookieSigningSecret: signingSecret,
      ownerTokenPepper: ownerPepper,
      enableDebugRoutes: options.debug ?? false,
    }),
  });
  return { app, members, rooms, service };
}

describe("authenticated reconstruction routes", () => {
  it("allows a durable member and owner to discover and poll room jobs", async () => {
    const { app } = setup();
    try {
      for (const header of [memberCookie(), ownerCookie()]) {
        const current = await app.inject({
          method: "GET",
          url: `/api/rooms/${roomId}/reconstruction`,
          headers: { cookie: header },
        });
        expect(current.statusCode).toBe(200);
        expect(current.json()).toEqual(running);
        const poll = await app.inject({
          method: "GET",
          url: `/api/rooms/${roomId}/reconstruction/job-a`,
          headers: { cookie: header },
        });
        expect(poll.statusCode).toBe(200);
        expect(poll.json()).toEqual(running);
      }
    } finally {
      await app.close();
    }
  });

  it("allows only the signed durable participant to submit reconstruction", async () => {
    const { app, service } = setup();
    try {
      const member = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/reconstruction`,
        headers: { cookie: memberCookie() },
        payload: requestBody,
      });
      expect(member.statusCode).toBe(202);
      expect(service.reconstruct).toHaveBeenCalledWith({
        roomId,
        participantId,
        request: requestBody,
      });

      const owner = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/reconstruction`,
        headers: { cookie: ownerCookie() },
        payload: requestBody,
      });
      expect(owner.statusCode).toBe(401);
      expect(service.reconstruct).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["missing", undefined],
    ["tampered", cookie(participantCookieName(roomId), `${signParticipant({ roomId, participantId }, signingSecret)}x`)],
    ["cross-room", memberCookie("room-b", "participant-b")],
  ])("denies %s credentials", async (_name, header) => {
    const { app } = setup();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/rooms/${roomId}/reconstruction`,
        ...(header ? { headers: { cookie: header } } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ code: "unauthorized", message: "Unauthorized" });
    } finally {
      await app.close();
    }
  });

  it("does not reveal a job through a different room", async () => {
    const { app } = setup();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/rooms/room-b/reconstruction/job-a",
        headers: { cookie: memberCookie("room-b", "participant-b") },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: "reconstruction_not_found",
        message: "Reconstruction not found",
      });
    } finally {
      await app.close();
    }
  });

  it("rejects malformed and oversized bodies before service invocation", async () => {
    const { app, service } = setup();
    try {
      const malformed = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/reconstruction`,
        headers: { cookie: memberCookie() },
        payload: { ...requestBody, mimeType: "image/jpeg" },
      });
      expect(malformed.statusCode).toBe(422);

      const oversized = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/reconstruction`,
        headers: { cookie: memberCookie(), "content-type": "application/json" },
        payload: JSON.stringify({ ...requestBody, imageDataUrl: "A".repeat(7_100_001) }),
      });
      expect(oversized.statusCode).toBe(413);
      expect(service.reconstruct).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("maps stable request failures without exposing thrown details", async () => {
    const { app } = setup({
      reconstructError: new ReconstructionRequestError("REQUIREMENTS_MISMATCH"),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/reconstruction`,
        headers: { cookie: memberCookie() },
        payload: requestBody,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        code: "invalid_reconstruction_request",
        message: "Invalid reconstruction request",
      });
      expect(JSON.stringify(response.json())).not.toContain("REQUIREMENTS_MISMATCH");
    } finally {
      await app.close();
    }
  });

  it("registers debug only when enabled outside production and authorizes member or owner", async () => {
    for (const config of [
      { debug: false, nodeEnv: "test" as const, expected: 404 },
      { debug: true, nodeEnv: "production" as const, expected: 404 },
      { debug: true, nodeEnv: "development" as const, expected: 200 },
    ]) {
      const { app, service } = setup(config);
      try {
        for (const header of [memberCookie(), ownerCookie()]) {
          const response = await app.inject({
            method: "POST",
            url: `/api/debug/rooms/${roomId}/reconstruction`,
            headers: { cookie: header },
            payload: {
              imageDataUrl: IMAGE,
              mimeType: "image/png",
              requirements: defaultRequirementsProfile(),
            },
          });
          expect(response.statusCode).toBe(config.expected);
        }
        expect(service.debugAnalyze).toHaveBeenCalledTimes(
          config.expected === 200 ? 2 : 0,
        );
      } finally {
        await app.close();
      }
    }
  });
});

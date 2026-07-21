import {
  READINESS_THRESHOLD,
  VoteMutationResponseSchema,
  evaluateVote,
  type VoteKind,
} from "@architect/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { participantCookieName } from "../auth/cookies.js";
import { signParticipant } from "../auth/participant.js";
import { VoteClosedError } from "./vote.service.js";

const secret = "route-cookie-secret".repeat(2);
const roomConfig = {
  nodeEnv: "test" as const,
  cookieSigningSecret: secret,
};
const roomId = "room-a";
const participantId = "participant-a";

function cookie(
  cookieRoomId = roomId,
  claims = { roomId: cookieRoomId, participantId },
) {
  return `${participantCookieName(cookieRoomId)}=${signParticipant(claims, secret)}`;
}

function routeHarness(closed = false) {
  const rooms = new Set([roomId, "room-b"]);
  const members = new Set([`${roomId}:${participantId}`]);
  const voterIds = new Set<string>();
  const calls: Array<{ action: "cast" | "remove"; participantId: string; kind: VoteKind }> = [];
  const voteService = {
    async castVote(_roomId: string, verifiedParticipantId: string, kind: VoteKind) {
      if (closed) throw new VoteClosedError();
      calls.push({ action: "cast", participantId: verifiedParticipantId, kind });
      voterIds.add(verifiedParticipantId);
      return {
        kind,
        phase: "reconstructing" as const,
        snapshot: evaluateVote({
          activeParticipantIds: [verifiedParticipantId],
          voterIds: [...voterIds],
          threshold: READINESS_THRESHOLD,
        }),
        transition: {
          claimed: true,
          jobId: "job-a",
          sourceSnapshotVersion: 1,
        },
      };
    },
    async removeVote(_roomId: string, verifiedParticipantId: string, kind: VoteKind) {
      calls.push({ action: "remove", participantId: verifiedParticipantId, kind });
      voterIds.delete(verifiedParticipantId);
      return {
        kind,
        phase: "sketch" as const,
        snapshot: evaluateVote({
          activeParticipantIds: [verifiedParticipantId],
          voterIds: [...voterIds],
          threshold: READINESS_THRESHOLD,
        }),
        transition: null,
      };
    },
    async destroy() {},
  };
  const voteParticipantDatabase = {
    participant: {
      async findFirst({ where }: { where: { id: string; roomId: string } }) {
        return members.has(`${where.roomId}:${where.id}`) ? { id: where.id } : null;
      },
    },
    room: {
      async findUnique({ where }: { where: { id: string } }) {
        return rooms.has(where.id) ? { id: where.id } : null;
      },
    },
  };
  const app = buildApp({
    roomConfig,
    voteParticipantDatabase,
    voteService: voteService as never,
  });
  return { app, calls, members, rooms, voterIds };
}

const opened: Array<ReturnType<typeof routeHarness>["app"]> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

function setup(closed = false) {
  const harness = routeHarness(closed);
  opened.push(harness.app);
  return harness;
}

describe("authenticated vote routes", () => {
  it("binds POST and DELETE to the verified persisted participant", async () => {
    const { app, calls, voterIds } = setup();

    const cast = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/votes/ready`,
      headers: { cookie: cookie() },
    });
    expect(cast.statusCode).toBe(200);
    expect(VoteMutationResponseSchema.parse(cast.json())).toMatchObject({
      kind: "ready",
      phase: "reconstructing",
      snapshot: { voterIds: [participantId] },
      transition: {
        claimed: true,
        jobId: "job-a",
        sourceSnapshotVersion: 1,
      },
    });
    expect(voterIds).toEqual(new Set([participantId]));

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${roomId}/votes/ready`,
      headers: { cookie: cookie() },
    });
    expect(removed.statusCode).toBe(200);
    expect(VoteMutationResponseSchema.parse(removed.json())).toMatchObject({
      phase: "sketch",
      snapshot: { tally: 0, voterIds: [] },
      transition: null,
    });
    expect(calls).toEqual([
      { action: "cast", participantId, kind: "ready" },
      { action: "remove", participantId, kind: "ready" },
    ]);
    expect(voterIds.size).toBe(0);
  });

  it.each([
    ["missing", undefined],
    ["tampered", `${participantCookieName(roomId)}=tampered`],
    [
      "cross-room",
      `${participantCookieName(roomId)}=${signParticipant(
        { roomId: "room-b", participantId },
        secret,
      )}`,
    ],
    [
      "stale",
      cookie(roomId, { roomId, participantId: "participant-missing" }),
    ],
  ])("returns the same 401 for a %s participant credential", async (_case, header) => {
    const { app, calls } = setup();
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/votes/ready`,
      ...(header ? { headers: { cookie: header } } : {}),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "unauthorized", message: "Unauthorized" });
    expect(calls).toEqual([]);
  });

  it("rejects participant impersonation and every browser-authored authority field", async () => {
    const { app, calls } = setup();
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/votes/ready`,
      headers: { cookie: cookie() },
      payload: {
        participantId: "participant-b",
        name: "Impostor",
        color: "#000000",
        activeParticipantIds: ["participant-b"],
        threshold: 0,
        sourceRevision: 999,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      code: "invalid_vote_request",
      message: "Invalid vote request",
    });
    expect(calls).toEqual([]);
  });

  it.each(["not-a-kind", "READY"]) (
    "returns stable 422 for invalid kind %j",
    async (kind) => {
      const { app, calls } = setup();
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${roomId}/votes/${kind}`,
        headers: { cookie: cookie() },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        code: "invalid_vote_request",
        message: "Invalid vote request",
      });
      expect(calls).toEqual([]);
    },
  );

  it("does not expose a kind-less vote mutation route", async () => {
    const { app, calls } = setup();
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/votes`,
      headers: { cookie: cookie() },
    });

    expect(response.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it("returns a stable 404 for a room that does not exist", async () => {
    const { app, calls } = setup();
    const missingRoom = "room-missing";
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${missingRoom}/votes/ready`,
      headers: { cookie: cookie(missingRoom, { roomId: missingRoom, participantId }) },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "room_not_found", message: "Room not found" });
    expect(calls).toEqual([]);
  });

  it("returns stable 409 when durable room phase has closed readiness", async () => {
    const { app, calls } = setup(true);
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/votes/ready`,
      headers: { cookie: cookie() },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "vote_closed",
      message: "Readiness voting is closed",
    });
    expect(calls).toEqual([]);
  });
});

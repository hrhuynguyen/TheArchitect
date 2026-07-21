import {
  CreateRoomResponseSchema,
  JoinRoomResponseSchema,
  RoomSummarySchema,
} from "@architect/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { verifyOwnerToken } from "../auth/ownerToken.js";
import {
  createRoomService,
  type ParticipantRecord,
  type RoomRecord,
  type RoomRepository,
} from "./room.service.js";

const ownerTokenPepper = "p".repeat(32);
const roomConfig = {
  nodeEnv: "test" as const,
  cookieSigningSecret: "s".repeat(32),
};

class MemoryRoomRepository implements RoomRepository {
  readonly rooms = new Map<string, RoomRecord>();
  #nextRoom = 1;

  async create(input: {
    mode: RoomRecord["mode"];
    ownerTokenHash: string;
    participant: ParticipantRecord;
  }): Promise<RoomRecord> {
    const room: RoomRecord = {
      id: `room-${this.#nextRoom++}`,
      mode: input.mode,
      phase: "sketch",
      ownerTokenHash: input.ownerTokenHash,
      participants: [{ ...input.participant }],
    };
    this.rooms.set(room.id, room);
    return room;
  }

  async findById(roomId: string): Promise<RoomRecord | null> {
    return this.rooms.get(roomId) ?? null;
  }

  async upsertParticipant(
    roomId: string,
    participant: ParticipantRecord,
  ): Promise<RoomRecord | null> {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const index = room.participants.findIndex(
      (candidate) => candidate.id === participant.id,
    );
    if (index === -1) room.participants.push({ ...participant });
    else room.participants[index] = { ...participant };
    return room;
  }
}

function createTestApp(repository = new MemoryRoomRepository()) {
  const roomService = createRoomService(repository, { ownerTokenPepper });
  return {
    app: buildApp({ roomConfig, roomService }),
    repository,
  };
}

function cookieHeader(
  cookies: Array<{ name: string; value: string }>,
): string {
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

function cookieWithPrefix(
  cookies: Array<{ name: string; value: string }>,
  prefix: string,
) {
  const cookie = cookies.find(({ name }) => name.startsWith(prefix));
  expect(cookie).toBeDefined();
  return cookie!;
}

describe("room routes", () => {
  it("creates a durable room and issues owner and participant cookies", async () => {
    const { app, repository } = createTestApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/rooms",
        payload: { name: "  Ada  ", color: "#10a37f", mode: "shared" },
      });

      expect(response.statusCode).toBe(201);
      const body = CreateRoomResponseSchema.parse(response.json());
      expect(body).toMatchObject({
        id: "room-1",
        phase: "sketch",
        mode: "shared",
        isOwner: true,
        joinPath: "/room/room-1",
      });
      expect(body.participants).toEqual([
        expect.objectContaining({ name: "Ada", color: "#10a37f" }),
      ]);

      const ownerCookie = cookieWithPrefix(
        response.cookies,
        "architect_owner_",
      );
      const participantCookie = cookieWithPrefix(
        response.cookies,
        "architect_participant_",
      );
      for (const cookie of [ownerCookie, participantCookie]) {
        expect(cookie).toMatchObject({
          httpOnly: true,
          path: "/",
          sameSite: "Lax",
          maxAge: 60 * 60 * 24 * 30,
        });
        expect(cookie.secure).toBeUndefined();
      }
      expect(ownerCookie.name).toBe("architect_owner_room-1");
      expect(participantCookie.name).toBe(
        "architect_participant_room-1",
      );

      const stored = repository.rooms.get(body.id)!;
      expect(stored.ownerTokenHash).not.toContain(ownerCookie.value);
      await expect(
        verifyOwnerToken(
          ownerCookie.value,
          stored.ownerTokenHash,
          ownerTokenPepper,
        ),
      ).resolves.toBe(true);
      expect(JSON.stringify(body)).not.toContain(ownerCookie.value);
    } finally {
      await app.close();
    }
  });

  it("joins a shared room without elevating the participant to owner", async () => {
    const { app } = createTestApp();

    try {
      await app.inject({
        method: "POST",
        url: "/api/rooms",
        payload: { name: "Ada", color: "#10A37F", mode: "shared" },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/rooms/room-1/join",
        payload: {
          name: "  Grace  ",
          color: "#abcdef",
          ownerToken: "attacker-controlled",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JoinRoomResponseSchema.parse(response.json());
      expect(body.isOwner).toBe(false);
      expect(body.participants).toEqual([
        expect.objectContaining({ name: "Ada" }),
        expect.objectContaining({ name: "Grace", color: "#abcdef" }),
      ]);
      expect(response.cookies).toHaveLength(1);
      expect(response.cookies[0]!.name).toBe(
        "architect_participant_room-1",
      );
    } finally {
      await app.close();
    }
  });

  it("upserts a returning participant from its signed room cookie", async () => {
    const { app } = createTestApp();

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/rooms",
        payload: { name: "Ada", color: "#10A37F", mode: "shared" },
      });
      const participantCookie = cookieWithPrefix(
        created.cookies,
        "architect_participant_",
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/rooms/room-1/join",
        headers: { cookie: cookieHeader([participantCookie]) },
        payload: { name: "Ada Lovelace", color: "#AABBCC" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().participants).toEqual([
        expect.objectContaining({ name: "Ada Lovelace", color: "#AABBCC" }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("rejects a different participant joining a solo room", async () => {
    const { app } = createTestApp();

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/rooms",
        payload: { name: "Ada", color: "#10A37F", mode: "solo" },
      });
      const participantCookie = cookieWithPrefix(
        created.cookies,
        "architect_participant_",
      );

      const rejected = await app.inject({
        method: "POST",
        url: "/api/rooms/room-1/join",
        payload: { name: "Grace", color: "#ABCDEF" },
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toEqual({
        code: "solo_room_unavailable",
        message: "Solo rooms do not accept other participants",
      });

      const returning = await app.inject({
        method: "POST",
        url: "/api/rooms/room-1/join",
        headers: { cookie: cookieHeader([participantCookie]) },
        payload: { name: "Ada", color: "#123456" },
      });
      expect(returning.statusCode).toBe(200);
      expect(returning.json().participants).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    { name: "   ", color: "#10A37F", mode: "shared" },
    { name: "x".repeat(61), color: "#10A37F", mode: "shared" },
    { name: "Ada", color: "10A37F", mode: "shared" },
    { name: "Ada", color: "#GGGGGG", mode: "shared" },
    { name: "Ada", color: "#10A37F", mode: "private" },
  ])("returns stable 422 for an invalid create payload: %o", async (payload) => {
    const { app } = createTestApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/rooms",
        payload,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        code: "invalid_room_request",
        message: "Invalid room request",
      });
    } finally {
      await app.close();
    }
  });

  it("returns stable 422 for an invalid join profile", async () => {
    const { app } = createTestApp();

    try {
      await app.inject({
        method: "POST",
        url: "/api/rooms",
        payload: { name: "Ada", color: "#10A37F", mode: "shared" },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/rooms/room-1/join",
        payload: { name: "", color: "blue" },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        code: "invalid_join_request",
        message: "Invalid join request",
      });
    } finally {
      await app.close();
    }
  });

  it("returns stable 404 responses for unknown rooms", async () => {
    const { app } = createTestApp();

    try {
      const joined = await app.inject({
        method: "POST",
        url: "/api/rooms/missing/join",
        payload: { name: "Ada", color: "#10A37F" },
      });
      const fetched = await app.inject({
        method: "GET",
        url: "/api/rooms/missing",
      });

      for (const response of [joined, fetched]) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          code: "room_not_found",
          message: "Room not found",
        });
      }
    } finally {
      await app.close();
    }
  });

  it("derives owner status from the room-scoped owner cookie and stored hash", async () => {
    const { app } = createTestApp();

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/rooms",
        payload: { name: "Ada", color: "#10A37F", mode: "shared" },
      });
      const ownerCookie = cookieWithPrefix(created.cookies, "architect_owner_");

      const anonymous = await app.inject({
        method: "GET",
        url: "/api/rooms/room-1",
      });
      expect(RoomSummarySchema.parse(anonymous.json()).isOwner).toBe(false);

      const owner = await app.inject({
        method: "GET",
        url: "/api/rooms/room-1",
        headers: { cookie: cookieHeader([ownerCookie]) },
      });
      expect(owner.statusCode).toBe(200);
      expect(RoomSummarySchema.parse(owner.json()).isOwner).toBe(true);

      const impostor = await app.inject({
        method: "GET",
        url: "/api/rooms/room-1",
        headers: {
          cookie: `architect_owner_room-1=${"x".repeat(ownerCookie.value.length)}`,
        },
      });
      expect(RoomSummarySchema.parse(impostor.json()).isOwner).toBe(false);
    } finally {
      await app.close();
    }
  });
});

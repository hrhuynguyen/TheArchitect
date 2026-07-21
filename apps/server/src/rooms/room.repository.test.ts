import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../db/client.js";
import {
  createRoomService,
  prismaRoomRepository,
  type ParticipantRecord,
  type RoomRecord,
  type RoomRepository,
} from "./room.service.js";

const participant: ParticipantRecord = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Grace",
  color: "#ABCDEF",
};

const room: RoomRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  mode: "shared",
  phase: "sketch",
  ownerTokenHash: "stored-hash",
  participants: [],
};

function knownPrismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("simulated database race", {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Prisma room repository", () => {
  it.each(["P2003", "P2025"])(
    "maps deletion-race error %s to a missing room",
    async (code) => {
      vi.spyOn(prisma.participant, "upsert").mockRejectedValueOnce(
        knownPrismaError(code),
      );

      await expect(
        prismaRoomRepository.upsertParticipant(room.id, participant),
      ).resolves.toBeNull();
    },
  );

  it("does not swallow unrelated Prisma failures", async () => {
    const unrelated = knownPrismaError("P2002");
    vi.spyOn(prisma.participant, "upsert").mockRejectedValueOnce(unrelated);

    await expect(
      prismaRoomRepository.upsertParticipant(room.id, participant),
    ).rejects.toBe(unrelated);
  });
});

describe("room service deletion race", () => {
  it("turns a post-lookup missing room into the stable 404", async () => {
    const repository: RoomRepository = {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue(room),
      upsertParticipant: vi.fn().mockResolvedValue(null),
    };
    const service = createRoomService(repository, {
      ownerTokenPepper: "p".repeat(32),
    });

    await expect(
      service.join(room.id, { name: "Grace", color: "#ABCDEF" }),
    ).rejects.toMatchObject({
      code: "room_not_found",
      message: "Room not found",
      statusCode: 404,
    });
  });
});

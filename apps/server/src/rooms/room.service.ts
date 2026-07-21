import type {
  ParticipantProfile,
  RoomMode,
  RoomPhase,
} from "@architect/contracts";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  createOwnerToken,
  hashOwnerToken,
  verifyOwnerToken,
} from "../auth/ownerToken.js";
import { prisma } from "../db/client.js";
import { PublicError } from "../observability/errors.js";

export type ParticipantRecord = ParticipantProfile & {
  id: string;
};

export type RoomRecord = {
  id: string;
  mode: RoomMode;
  phase: RoomPhase;
  ownerTokenHash: string;
  participants: ParticipantRecord[];
};

export type CreateRoomPersistenceInput = {
  mode: RoomMode;
  ownerTokenHash: string;
  participant: ParticipantRecord;
};

export interface RoomRepository {
  create(input: CreateRoomPersistenceInput): Promise<RoomRecord>;
  findById(roomId: string): Promise<RoomRecord | null>;
  upsertParticipant(
    roomId: string,
    participant: ParticipantRecord,
  ): Promise<RoomRecord | null>;
}

type RoomServiceConfig = {
  ownerTokenPepper: string | (() => string);
};

export type RoomService = ReturnType<typeof createRoomService>;

function resolvePepper(config: RoomServiceConfig): string {
  return typeof config.ownerTokenPepper === "function"
    ? config.ownerTokenPepper()
    : config.ownerTokenPepper;
}

function roomNotFound(): PublicError {
  return new PublicError("room_not_found", "Room not found", 404);
}

export function createRoomService(
  repository: RoomRepository,
  config: RoomServiceConfig,
) {
  return {
    async create(input: ParticipantProfile & { mode: RoomMode }) {
      const ownerToken = createOwnerToken();
      const ownerTokenHash = await hashOwnerToken(
        ownerToken,
        resolvePepper(config),
      );
      const participant: ParticipantRecord = {
        id: randomUUID(),
        name: input.name,
        color: input.color,
      };
      const room = await repository.create({
        mode: input.mode,
        ownerTokenHash,
        participant,
      });

      return { ownerToken, participantId: participant.id, room };
    },

    async join(
      roomId: string,
      profile: ParticipantProfile,
      returningParticipantId?: string,
    ) {
      const existing = await repository.findById(roomId);
      if (!existing) throw roomNotFound();

      const returningParticipant = returningParticipantId
        ? existing.participants.find(
            (participant) => participant.id === returningParticipantId,
          )
        : undefined;
      if (existing.mode === "solo" && !returningParticipant) {
        throw new PublicError(
          "solo_room_unavailable",
          "Solo rooms do not accept other participants",
          409,
        );
      }

      const participant: ParticipantRecord = {
        id: returningParticipant?.id ?? randomUUID(),
        name: profile.name,
        color: profile.color,
      };
      const room = await repository.upsertParticipant(roomId, participant);
      if (!room) throw roomNotFound();

      return { participantId: participant.id, room };
    },

    async get(roomId: string): Promise<RoomRecord> {
      const room = await repository.findById(roomId);
      if (!room) throw roomNotFound();
      return room;
    },

    async isOwner(room: RoomRecord, token: string | undefined) {
      if (!token) return false;
      return verifyOwnerToken(
        token,
        room.ownerTokenHash,
        resolvePepper(config),
      );
    },
  };
}

function toRoomRecord(room: {
  id: string;
  mode: RoomMode;
  phase: RoomPhase;
  ownerTokenHash: string;
  participants: ParticipantRecord[];
}): RoomRecord {
  return {
    id: room.id,
    mode: room.mode,
    phase: room.phase,
    ownerTokenHash: room.ownerTokenHash,
    participants: room.participants.map(({ id, name, color }) => ({
      id,
      name,
      color,
    })),
  };
}

function isRoomDeletionRace(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2003" || error.code === "P2025")
  );
}

export const prismaRoomRepository: RoomRepository = {
  async create(input) {
    const room = await prisma.room.create({
      data: {
        mode: input.mode,
        ownerTokenHash: input.ownerTokenHash,
        participants: { create: input.participant },
      },
      include: { participants: true },
    });
    return toRoomRecord(room);
  },

  async findById(roomId) {
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: { participants: { orderBy: { joinedAt: "asc" } } },
    });
    return room ? toRoomRecord(room) : null;
  },

  async upsertParticipant(roomId, participant) {
    try {
      await prisma.participant.upsert({
        where: { id: participant.id },
        create: { ...participant, roomId },
        update: {
          name: participant.name,
          color: participant.color,
          lastSeenAt: new Date(),
        },
      });
    } catch (error) {
      if (isRoomDeletionRace(error)) return null;
      throw error;
    }
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: { participants: { orderBy: { joinedAt: "asc" } } },
    });
    return room ? toRoomRecord(room) : null;
  },
};

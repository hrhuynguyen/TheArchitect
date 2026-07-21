import {
  AwarenessCursorSchema,
  RoomPhaseSchema,
  type AwarenessIdentity,
  type AwarenessProfile,
} from "@architect/contracts";

type RegistryOptions = {
  cleanupIntervalMs?: number;
  now?: () => number;
  staleAfterMs?: number;
};

type RegistryEntry = {
  profile: AwarenessProfile;
  sockets: Set<string>;
};

export function createAwarenessRegistry(options: RegistryOptions = {}) {
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 15_000;
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 45_000;
  const rooms = new Map<string, Map<string, RegistryEntry>>();
  const sockets = new Map<
    string,
    { participantId: string; roomId: string }
  >();
  let destroyed = false;

  const removeSocket = (socketId: string) => {
    const owner = sockets.get(socketId);
    if (!owner) return;
    sockets.delete(socketId);
    const room = rooms.get(owner.roomId);
    const entry = room?.get(owner.participantId);
    entry?.sockets.delete(socketId);
    if (entry?.sockets.size === 0) room?.delete(owner.participantId);
    if (room?.size === 0) rooms.delete(owner.roomId);
  };

  const cleanup = () => {
    const cutoff = now() - staleAfterMs;
    for (const [roomId, room] of rooms) {
      for (const [participantId, entry] of room) {
        if (Date.parse(entry.profile.lastSeenAt) <= cutoff) {
          for (const socketId of entry.sockets) sockets.delete(socketId);
          room.delete(participantId);
        }
      }
      if (room.size === 0) rooms.delete(roomId);
    }
  };

  const cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
  cleanupTimer.unref?.();

  return {
    connect(roomId: string, socketId: string, identity: AwarenessIdentity) {
      if (destroyed) return;
      removeSocket(socketId);
      let room = rooms.get(roomId);
      if (!room) {
        room = new Map();
        rooms.set(roomId, room);
      }
      let entry = room.get(identity.participantId);
      if (!entry) {
        entry = {
          profile: {
            ...identity,
            lastSeenAt: new Date(now()).toISOString(),
          },
          sockets: new Set(),
        };
        room.set(identity.participantId, entry);
      } else {
        entry.profile = {
          ...entry.profile,
          name: identity.name,
          color: identity.color,
          phase: identity.phase,
          lastSeenAt: new Date(now()).toISOString(),
        };
      }
      entry.sockets.add(socketId);
      sockets.set(socketId, { roomId, participantId: identity.participantId });
    },

    disconnect(roomId: string, socketId: string) {
      if (sockets.get(socketId)?.roomId !== roomId) return;
      removeSocket(socketId);
    },

    heartbeat(roomId: string, socketId: string) {
      const owner = sockets.get(socketId);
      if (!owner || owner.roomId !== roomId) return;
      const entry = rooms.get(roomId)?.get(owner.participantId);
      if (entry) entry.profile.lastSeenAt = new Date(now()).toISOString();
    },

    updateParticipant(
      roomId: string,
      participantId: string,
      update: Record<string, unknown>,
    ) {
      const entry = rooms.get(roomId)?.get(participantId);
      if (!entry) return;

      if (update.cursor === null) delete entry.profile.cursor;
      else {
        const cursor = AwarenessCursorSchema.safeParse(update.cursor);
        if (cursor.success) entry.profile.cursor = cursor.data;
      }
      const phase = RoomPhaseSchema.safeParse(update.phase);
      if (phase.success) entry.profile.phase = phase.data;
      entry.profile.lastSeenAt = new Date(now()).toISOString();
    },

    list(roomId: string): AwarenessProfile[] {
      return [...(rooms.get(roomId)?.values() ?? [])]
        .map((entry) => ({
          ...entry.profile,
          ...(entry.profile.cursor
            ? { cursor: { ...entry.profile.cursor } }
            : {}),
        }))
        .sort((left, right) =>
          left.participantId.localeCompare(right.participantId),
        );
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(cleanupTimer);
      rooms.clear();
      sockets.clear();
    },
  };
}

export type AwarenessRegistry = ReturnType<typeof createAwarenessRegistry>;

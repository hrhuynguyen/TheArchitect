import {
  AwarenessCursorSchema,
  RoomPhaseSchema,
  type AwarenessCursor,
  type AwarenessIdentity,
  type AwarenessProfile,
  type RoomPhase,
} from "@architect/contracts";

type RegistryOptions = {
  cleanupIntervalMs?: number;
  now?: () => number;
  staleAfterMs?: number;
};

type ClientPresence = {
  cursor?: AwarenessCursor;
  lastSeenAt: number;
  phase: RoomPhase;
};

type SocketPresence = {
  clients: Map<number, ClientPresence>;
  identity: AwarenessIdentity;
  lastSeenAt: number;
  visible: boolean;
};

export function createAwarenessRegistry(options: RegistryOptions = {}) {
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 15_000;
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 45_000;
  const rooms = new Map<string, Map<string, SocketPresence>>();
  const sockets = new Map<string, string>();
  const listeners = new Set<(roomId: string) => void>();
  let destroyed = false;

  const notify = (roomId: string) => {
    for (const listener of listeners) {
      try {
        listener(roomId);
      } catch {
        // Presence bookkeeping must survive a failed transport notification.
      }
    }
  };

  const removeSocket = (socketId: string) => {
    const roomId = sockets.get(socketId);
    if (!roomId) return;
    sockets.delete(socketId);
    const room = rooms.get(roomId);
    room?.delete(socketId);
    if (room?.size === 0) rooms.delete(roomId);
  };

  const cleanup = () => {
    const cutoff = now() - staleAfterMs;
    for (const [roomId, room] of rooms) {
      let changed = false;
      for (const socket of room.values()) {
        if (socket.visible && socket.lastSeenAt <= cutoff) {
          socket.visible = false;
          changed = true;
        }
      }
      if (changed) notify(roomId);
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
      room.set(socketId, {
        clients: new Map(),
        identity: {
          participantId: identity.participantId,
          name: identity.name,
          color: identity.color,
          phase: identity.phase,
        },
        lastSeenAt: now(),
        visible: true,
      });
      sockets.set(socketId, roomId);
      notify(roomId);
    },

    disconnect(roomId: string, socketId: string) {
      if (sockets.get(socketId) !== roomId) return;
      removeSocket(socketId);
      notify(roomId);
    },

    heartbeat(roomId: string, socketId: string) {
      if (sockets.get(socketId) !== roomId) return;
      const socket = rooms.get(roomId)?.get(socketId);
      if (!socket) return;
      const wasVisible = socket.visible;
      socket.lastSeenAt = now();
      socket.visible = true;
      if (!wasVisible) notify(roomId);
    },

    updateClient(
      roomId: string,
      socketId: string,
      clientId: number,
      update: Record<string, unknown>,
    ) {
      if (sockets.get(socketId) !== roomId) return;
      const socket = rooms.get(roomId)?.get(socketId);
      if (!socket) return;

      const timestamp = now();
      const previous = socket.clients.get(clientId);
      const phase = RoomPhaseSchema.safeParse(update.phase);
      const cursor = AwarenessCursorSchema.safeParse(update.cursor);
      socket.clients.set(clientId, {
        ...(update.cursor === null
          ? {}
          : cursor.success
            ? { cursor: cursor.data }
            : previous?.cursor
              ? { cursor: previous.cursor }
              : {}),
        phase: phase.success
          ? phase.data
          : (previous?.phase ?? socket.identity.phase),
        lastSeenAt: timestamp,
      });
      socket.lastSeenAt = timestamp;
      socket.visible = true;
      notify(roomId);
    },

    removeClient(roomId: string, socketId: string, clientId: number) {
      if (sockets.get(socketId) !== roomId) return;
      if (rooms.get(roomId)?.get(socketId)?.clients.delete(clientId)) {
        notify(roomId);
      }
    },

    list(roomId: string): AwarenessProfile[] {
      const participants = new Map<
        string,
        {
          identity: AwarenessIdentity;
          identitySeenAt: number;
          lastSeenAt: number;
          presence?: ClientPresence;
        }
      >();

      for (const socket of rooms.get(roomId)?.values() ?? []) {
        if (!socket.visible) continue;
        const existing = participants.get(socket.identity.participantId);
        const entry = existing ?? {
          identity: socket.identity,
          identitySeenAt: socket.lastSeenAt,
          lastSeenAt: socket.lastSeenAt,
        };
        if (socket.lastSeenAt >= entry.identitySeenAt) {
          entry.identity = socket.identity;
          entry.identitySeenAt = socket.lastSeenAt;
        }
        entry.lastSeenAt = Math.max(entry.lastSeenAt, socket.lastSeenAt);
        for (const presence of socket.clients.values()) {
          if (!entry.presence || presence.lastSeenAt >= entry.presence.lastSeenAt) {
            entry.presence = presence;
          }
        }
        participants.set(socket.identity.participantId, entry);
      }

      return [...participants.values()]
        .map(({ identity, lastSeenAt, presence }) => ({
          participantId: identity.participantId,
          name: identity.name,
          color: identity.color,
          ...(presence?.cursor ? { cursor: { ...presence.cursor } } : {}),
          phase: presence?.phase ?? identity.phase,
          lastSeenAt: new Date(lastSeenAt).toISOString(),
        }))
        .sort((left, right) =>
          left.participantId.localeCompare(right.participantId),
        );
    },

    subscribe(listener: (roomId: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(cleanupTimer);
      rooms.clear();
      sockets.clear();
      listeners.clear();
    },
  };
}

export type AwarenessRegistry = ReturnType<typeof createAwarenessRegistry>;

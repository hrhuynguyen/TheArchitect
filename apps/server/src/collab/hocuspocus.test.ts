import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { participantCookieName } from "../auth/cookies.js";
import { signParticipant } from "../auth/participant.js";
import { createAwarenessRegistry } from "./awareness.registry.js";
import {
  authenticateParticipant,
  createHocuspocusServer,
} from "./hocuspocus.js";
import { createSnapshotService } from "./snapshot.service.js";

const secret = "cookie-signing-secret-at-least-32-characters";
const roomId = "00000000-0000-4000-8000-000000000001";
const participantId = "00000000-0000-4000-8000-000000000002";

function cookieHeader(
  documentRoomId: string,
  claims = { roomId: documentRoomId, participantId },
): string {
  const value = signParticipant(claims, secret);
  return `${participantCookieName(documentRoomId)}=${encodeURIComponent(value)}`;
}

function participantDatabase() {
  return {
    participant: {
      findFirst: vi.fn().mockResolvedValue({
        id: participantId,
        name: "Grace",
        color: "#ABCDEF",
        room: { phase: "sketch" },
      }),
    },
  };
}

describe("Hocuspocus participant authentication", () => {
  it("authenticates an existing participant from the exact room cookie", async () => {
    const database = participantDatabase();

    await expect(
      authenticateParticipant({
        cookieSigningSecret: secret,
        database,
        documentName: roomId,
        requestHeaders: { cookie: cookieHeader(roomId) },
      }),
    ).resolves.toMatchObject({
      roomId,
      participant: {
        participantId,
        name: "Grace",
        color: "#ABCDEF",
        phase: "sketch",
      },
    });
    expect(database.participant.findFirst).toHaveBeenCalledWith({
      where: { id: participantId, roomId },
      select: {
        id: true,
        name: true,
        color: true,
        room: { select: { phase: true } },
      },
    });
  });

  it.each([
    ["missing", undefined],
    ["tampered", `${participantCookieName(roomId)}=tampered`],
    [
      "cross-room",
      cookieHeader(roomId, {
        roomId: "00000000-0000-4000-8000-000000000099",
        participantId,
      }),
    ],
  ])("rejects a %s credential with the same public error", async (_case, cookie) => {
    const database = participantDatabase();

    await expect(
      authenticateParticipant({
        cookieSigningSecret: secret,
        database,
        documentName: roomId,
        requestHeaders: cookie ? { cookie } : {},
      }),
    ).rejects.toThrow("Unauthorized");
  });

  it("rejects a signed participant that no longer exists", async () => {
    const database = participantDatabase();
    database.participant.findFirst.mockResolvedValueOnce(null);

    await expect(
      authenticateParticipant({
        cookieSigningSecret: secret,
        database,
        documentName: roomId,
        requestHeaders: { cookie: cookieHeader(roomId) },
      }),
    ).rejects.toThrow("Unauthorized");
  });

  it("allows a valid participant to authenticate again after reconnecting", async () => {
    const database = participantDatabase();
    const input = {
      cookieSigningSecret: secret,
      database,
      documentName: roomId,
      requestHeaders: { cookie: cookieHeader(roomId) },
    };

    await authenticateParticipant(input);
    await authenticateParticipant(input);

    expect(database.participant.findFirst).toHaveBeenCalledTimes(2);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("transient awareness registry", () => {
  it("tracks validated cursor and phase changes without trusting profile identity fields", () => {
    let now = Date.parse("2026-07-21T12:00:00.000Z");
    const registry = createAwarenessRegistry({ now: () => now });
    registry.connect(roomId, "socket-a", {
      participantId,
      name: "Grace",
      color: "#ABCDEF",
      phase: "sketch",
    });

    now += 1_000;
    registry.updateParticipant(roomId, participantId, {
      participantId: "spoofed-id",
      name: "Spoofed name",
      color: "#000000",
      cursor: { x: 12, y: 34 },
      phase: "architect",
    });

    expect(registry.list(roomId)).toEqual([
      {
        participantId,
        name: "Grace",
        color: "#ABCDEF",
        cursor: { x: 12, y: 34 },
        phase: "architect",
        lastSeenAt: "2026-07-21T12:00:01.000Z",
      },
    ]);
    registry.destroy();
  });

  it("refreshes heartbeat time and keeps a participant until their last socket disconnects", () => {
    let now = Date.parse("2026-07-21T12:00:00.000Z");
    const registry = createAwarenessRegistry({ now: () => now });
    const profile = {
      participantId,
      name: "Grace",
      color: "#ABCDEF",
      phase: "sketch" as const,
    };
    registry.connect(roomId, "socket-a", profile);
    registry.connect(roomId, "socket-b", profile);
    registry.disconnect(roomId, "socket-a");
    now += 5_000;
    registry.heartbeat(roomId, "socket-b");

    expect(registry.list(roomId)[0]?.lastSeenAt).toBe(
      "2026-07-21T12:00:05.000Z",
    );

    registry.disconnect(roomId, "socket-b");
    expect(registry.list(roomId)).toEqual([]);
    registry.destroy();
  });

  it("removes stale entries and clears its bounded cleanup timer", () => {
    vi.useFakeTimers();
    let now = 0;
    const registry = createAwarenessRegistry({
      cleanupIntervalMs: 100,
      now: () => now,
      staleAfterMs: 1_000,
    });
    registry.connect(roomId, "socket-a", {
      participantId,
      name: "Grace",
      color: "#ABCDEF",
      phase: "sketch",
    });

    now = 1_001;
    vi.advanceTimersByTime(100);

    expect(registry.list(roomId)).toEqual([]);
    registry.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("snapshot service", () => {
  it("flushes a phase transition immediately and a final shutdown snapshot", async () => {
    const persistRoomSnapshot = vi.fn().mockResolvedValue(1);
    const service = createSnapshotService({ persistRoomSnapshot });
    const document = new Y.Doc();
    document.getMap("meta").set("phase", "sketch");
    service.track(roomId, document);

    document.getMap("meta").set("phase", "architect");
    await service.changed(roomId, document);
    await service.shutdown();

    expect(persistRoomSnapshot).toHaveBeenNthCalledWith(
      1,
      roomId,
      document,
      "phase_transition",
    );
    expect(persistRoomSnapshot).toHaveBeenNthCalledWith(
      2,
      roomId,
      document,
      "shutdown",
    );
  });

  it("retains a failed write across unload/reconnect so shutdown retries it", async () => {
    const failure = new Error("database unavailable");
    const persistRoomSnapshot = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(2);
    const service = createSnapshotService({ persistRoomSnapshot });
    const document = new Y.Doc();
    service.track(roomId, document);
    document.getMap("shared").set("message", "not-yet-persisted");
    service.changed(roomId, document);

    await expect(service.store(roomId, document)).rejects.toBe(failure);
    service.release(roomId);
    document.destroy();
    const reconnected = new Y.Doc();
    service.track(roomId, reconnected);
    expect(reconnected.getMap("shared").get("message")).toBe(
      "not-yet-persisted",
    );
    await expect(service.shutdown()).resolves.toBeUndefined();

    expect(persistRoomSnapshot).toHaveBeenLastCalledWith(
      roomId,
      reconnected,
      "shutdown",
    );
    reconnected.destroy();
  });
});

function createCollaborationDatabase() {
  const snapshots: Array<{
    roomId: string;
    version: number;
    payload: Uint8Array;
    reason: string;
  }> = [];
  const participants = new Map([
    [
      participantId,
      {
        id: participantId,
        roomId,
        name: "Grace",
        color: "#ABCDEF",
        room: { phase: "sketch" as const },
      },
    ],
  ]);
  let snapshotFailure: unknown;

  const database = {
    participant: {
      async findFirst(input: { where: { id: string; roomId: string } }) {
        const participant = participants.get(input.where.id);
        return participant?.roomId === input.where.roomId ? participant : null;
      },
    },
    yjsSnapshot: {
      async findFirst(input: { where: { roomId: string } }) {
        return (
          snapshots
            .filter((snapshot) => snapshot.roomId === input.where.roomId)
            .sort((left, right) => right.version - left.version)[0] ?? null
        );
      },
      async aggregate(input: { where: { roomId: string } }) {
        const roomVersions = snapshots
          .filter((snapshot) => snapshot.roomId === input.where.roomId)
          .map((snapshot) => snapshot.version);
        return {
          _max: {
            version: roomVersions.length ? Math.max(...roomVersions) : null,
          },
        };
      },
      async create(input: {
        data: {
          roomId: string;
          version: number;
          payload: Uint8Array;
          reason: string;
        };
      }) {
        if (snapshotFailure) throw snapshotFailure;
        const record = { ...input.data, payload: Buffer.from(input.data.payload) };
        snapshots.push(record);
        return record;
      },
    },
    async $transaction<T>(callback: (transaction: unknown) => Promise<T>) {
      return callback(database);
    },
  };

  return {
    allowSnapshotWrites() {
      snapshotFailure = undefined;
    },
    database,
    failSnapshotWrites(error: unknown) {
      snapshotFailure = error;
    },
    participants,
    snapshots,
  };
}

function cookieWebSocket(cookie?: string) {
  return class CookieWebSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, cookie ? { headers: { cookie } } : undefined);
    }
  };
}

function connectProvider(options: {
  cookie?: string;
  document?: Y.Doc;
  room?: string;
  url: string;
}) {
  let resolveSynced!: () => void;
  let resolveDenied!: (reason: string) => void;
  const synced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });
  const denied = new Promise<string>((resolve) => {
    resolveDenied = resolve;
  });
  const provider = new HocuspocusProvider({
    WebSocketPolyfill: cookieWebSocket(options.cookie),
    document: options.document ?? new Y.Doc(),
    name: options.room ?? roomId,
    onAuthenticationFailed({ reason }) {
      resolveDenied(reason);
    },
    onSynced({ state }) {
      if (state) resolveSynced();
    },
    token: "",
    url: options.url,
  });
  return { denied, provider, synced };
}

async function eventually(
  assertion: () => void,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe("Hocuspocus WebSocket integration", () => {
  it("syncs an authenticated room, flushes shutdown, and restores on reconnect", async () => {
    const memory = createCollaborationDatabase();
    const registry = createAwarenessRegistry();
    const collaboration = createHocuspocusServer({
      awarenessRegistry: registry,
      debounceMs: 20,
      env: { COOKIE_SIGNING_SECRET: secret, WS_PORT: 0 },
      maxDebounceMs: 50,
      prisma: memory.database,
    });
    const listening = await collaboration.listen({ host: "127.0.0.1", port: 0 });
    const cookie = cookieHeader(roomId);
    const first = connectProvider({ cookie, url: listening.webSocketUrl });
    const secondDocument = new Y.Doc();
    const second = connectProvider({
      cookie,
      document: secondDocument,
      url: listening.webSocketUrl,
    });

    await Promise.all([first.synced, second.synced]);
    first.provider.awareness?.setLocalStateField("profile", {
      participantId,
      name: "Client-supplied name is ignored",
      color: "#000000",
      cursor: { x: 10, y: 20 },
      phase: "architect",
    });
    first.provider.document.getMap("meta").set("phase", "architect");
    await eventually(() => {
      expect(
        memory.snapshots.some(({ reason }) => reason === "phase_transition"),
      ).toBe(true);
    });
    first.provider.document.getMap("shared").set("message", "durable");
    await eventually(() => {
      expect(secondDocument.getMap("shared").get("message")).toBe("durable");
    });
    await eventually(() => {
      expect(
        memory.snapshots.some(({ reason }) => reason === "debounced_change"),
      ).toBe(true);
    });
    await eventually(() => {
      expect(registry.list(roomId)).toEqual([
        expect.objectContaining({
          participantId,
          name: "Grace",
          color: "#ABCDEF",
          cursor: { x: 10, y: 20 },
          phase: "architect",
        }),
      ]);
    });
    first.provider.destroy();
    await eventually(() => expect(registry.list(roomId)).toHaveLength(1));
    await collaboration.destroy();
    await collaboration.destroy();
    second.provider.destroy();

    expect(memory.snapshots.some(({ reason }) => reason === "phase_transition")).toBe(
      true,
    );
    expect(memory.snapshots.at(-1)?.reason).toBe("shutdown");
    const persistedDocument = new Y.Doc();
    Y.applyUpdate(
      persistedDocument,
      new Uint8Array(memory.snapshots.at(-1)!.payload),
    );
    expect(persistedDocument.share.has("awareness")).toBe(false);
    persistedDocument.destroy();

    const reconnectRegistry = createAwarenessRegistry();
    const reconnectedServer = createHocuspocusServer({
      awarenessRegistry: reconnectRegistry,
      env: { COOKIE_SIGNING_SECRET: secret, WS_PORT: 0 },
      prisma: memory.database,
    });
    const reconnectedListening = await reconnectedServer.listen({
      host: "127.0.0.1",
      port: 0,
    });
    const restoredDocument = new Y.Doc();
    const reconnected = connectProvider({
      cookie,
      document: restoredDocument,
      url: reconnectedListening.webSocketUrl,
    });
    await reconnected.synced;

    expect(restoredDocument.getMap("shared").get("message")).toBe("durable");

    reconnected.provider.destroy();
    await reconnectedServer.destroy();
  });

  it.each([
    ["missing", undefined, participantId],
    ["tampered", `${participantCookieName(roomId)}=tampered`, participantId],
    [
      "cross-room",
      cookieHeader(roomId, {
        roomId: "00000000-0000-4000-8000-000000000099",
        participantId,
      }),
      participantId,
    ],
    ["unknown participant", cookieHeader(roomId), "remove"],
  ])("denies a %s WebSocket credential without detail", async (_case, cookie, setup) => {
    const memory = createCollaborationDatabase();
    if (setup === "remove") memory.participants.delete(participantId);
    const registry = createAwarenessRegistry();
    const collaboration = createHocuspocusServer({
      awarenessRegistry: registry,
      env: { COOKIE_SIGNING_SECRET: secret, WS_PORT: 0 },
      prisma: memory.database,
    });
    const listening = await collaboration.listen({ host: "127.0.0.1", port: 0 });
    const connection = connectProvider({ cookie, url: listening.webSocketUrl });

    await expect(connection.denied).resolves.toBe("permission-denied");

    connection.provider.destroy();
    await collaboration.destroy();
  });

  it("rejects an occupied WebSocket port without an unhandled listener error", async () => {
    const firstMemory = createCollaborationDatabase();
    const first = createHocuspocusServer({
      awarenessRegistry: createAwarenessRegistry(),
      env: { COOKIE_SIGNING_SECRET: secret, WS_PORT: 0 },
      prisma: firstMemory.database,
    });
    const listening = await first.listen({ host: "127.0.0.1", port: 0 });
    const secondMemory = createCollaborationDatabase();
    const second = createHocuspocusServer({
      awarenessRegistry: createAwarenessRegistry(),
      env: { COOKIE_SIGNING_SECRET: secret, WS_PORT: listening.port },
      prisma: secondMemory.database,
    });

    try {
      await expect(
        second.listen({ host: "127.0.0.1", port: listening.port }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await second.destroy();
      await first.destroy();
    }
  });

  it("retains a failed disconnect store for reconnect and a later final flush", async () => {
    const memory = createCollaborationDatabase();
    const persistenceErrors = vi.fn();
    const collaboration = createHocuspocusServer({
      awarenessRegistry: createAwarenessRegistry(),
      debounceMs: 20,
      env: { COOKIE_SIGNING_SECRET: secret, WS_PORT: 0 },
      maxDebounceMs: 50,
      onPersistenceError: persistenceErrors,
      prisma: memory.database,
    });
    const listening = await collaboration.listen({ host: "127.0.0.1", port: 0 });
    const cookie = cookieHeader(roomId);
    const first = connectProvider({ cookie, url: listening.webSocketUrl });
    await first.synced;
    memory.failSnapshotWrites(new Error("database unavailable"));
    first.provider.document.getMap("shared").set("message", "retained");
    first.provider.destroy();

    await eventually(() => expect(persistenceErrors).toHaveBeenCalled());
    expect(memory.snapshots).toEqual([]);

    memory.allowSnapshotWrites();
    const reconnectedDocument = new Y.Doc();
    const reconnected = connectProvider({
      cookie,
      document: reconnectedDocument,
      url: listening.webSocketUrl,
    });
    await reconnected.synced;
    expect(reconnectedDocument.getMap("shared").get("message")).toBe("retained");

    await collaboration.destroy();
    reconnected.provider.destroy();
    expect(memory.snapshots.at(-1)?.reason).toBe("shutdown");
    const restored = new Y.Doc();
    Y.applyUpdate(restored, new Uint8Array(memory.snapshots.at(-1)!.payload));
    expect(restored.getMap("shared").get("message")).toBe("retained");
    restored.destroy();
  });
});

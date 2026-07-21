import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  defaultRequirementsProfile,
} from "@architect/contracts";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { createSnapshotService } from "./snapshot.service.js";
import {
  createYjsRepository,
  type SnapshotDatabase,
  type SnapshotRecord,
} from "./yjs.repository.js";

function createMemoryDatabase() {
  const snapshots: SnapshotRecord[] = [];
  let createFailure: unknown;
  let beforeTransaction: (() => void) | undefined;
  let room = {
    id: "room-a",
    phase: "sketch" as "sketch" | "reconstructing" | "architect" | "deploy",
    currentRevisionId: null as string | null,
  };
  let lease = {
    id: "job-a",
    roomId: "room-a",
    state: "publishing",
    architectureRevisionId: null as string | null,
    leaseToken: "lease-current",
    leaseExpiresAt: new Date("2026-07-21T12:01:00.000Z"),
  };

  const database = {
    yjsSnapshot: {
      async findFirst({ where }) {
        return (
          snapshots
            .filter((snapshot) => snapshot.roomId === where.roomId)
            .sort((left, right) => right.version - left.version)[0] ?? null
        );
      },
      async aggregate({ where }) {
        await Promise.resolve();
        const versions = snapshots
          .filter((snapshot) => snapshot.roomId === where.roomId)
          .map((snapshot) => snapshot.version);
        return { _max: { version: versions.length ? Math.max(...versions) : null } };
      },
      async create({ data }) {
        await Promise.resolve();
        if (createFailure) throw createFailure;
        if (
          snapshots.some(
            (snapshot) =>
              snapshot.roomId === data.roomId &&
              snapshot.version === data.version,
          )
        ) {
          throw Object.assign(new Error("unique room snapshot version"), {
            code: "P2002",
          });
        }
        const snapshot: SnapshotRecord = {
          ...data,
          payload: Buffer.from(data.payload),
        };
        snapshots.push(snapshot);
        return snapshot;
      },
    },
    transitionJob: {
      async findFirst({ where }: any) {
        return (where.id === undefined || lease.id === where.id) &&
            lease.roomId === where.roomId &&
            (where.state === undefined || lease.state === where.state) &&
            (where.leaseToken === undefined || lease.leaseToken === where.leaseToken) &&
            (where.leaseExpiresAt === undefined ||
              lease.leaseExpiresAt > where.leaseExpiresAt.gt) &&
            (where.architectureRevisionId === undefined ||
              lease.architectureRevisionId !== null)
          ? {
              id: lease.id,
              architectureRevisionId: lease.architectureRevisionId,
            }
          : null;
      },
    },
    room: {
      async findUnique({ where }: { where: { id: string } }) {
        return room.id === where.id ? { ...room } : null;
      },
    },
    async $transaction(callback) {
      const hook = beforeTransaction;
      beforeTransaction = undefined;
      hook?.();
      return callback(database);
    },
  } as SnapshotDatabase;

  return {
    database,
    snapshots,
    beforeNextTransaction(operation: () => void) {
      beforeTransaction = operation;
    },
    setRoom(value: typeof room) {
      room = value;
    },
    setLease(value: typeof lease) {
      lease = value;
    },
    failCreatesWith(error: unknown) {
      createFailure = error;
    },
  };
}

function documentWithPhase(phase: string): Y.Doc {
  const document = new Y.Doc();
  document.getMap("meta").set("phase", phase);
  return document;
}

function documentWithArchitecture(revisionId: string, name: string): Y.Doc {
  const document = documentWithPhase("architect");
  document.getMap(ARCHITECTURE_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
    version: "working-architecture/v1",
    revisionId,
    architecture: {
      version: "architecture/v1",
      requirements: defaultRequirementsProfile(),
      resources: [{
        id: "bucket",
        type: "S3",
        name,
        properties: {},
        origin: "explicit",
        reason: "Required by the durability regression fixture.",
        approvalStatus: "not-required",
      }],
      relationships: [],
      decisions: [],
      unresolvedQuestions: [],
    },
  });
  document.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
    version: "architecture-layout/v1",
    revisionId,
    nodes: [{ resourceId: "bucket", x: 0, y: 0 }],
  });
  return document;
}

describe("Yjs snapshot repository", () => {
  it("rejects a SnapshotService payload encoded before an atomic revision commit", async () => {
    const memory = createMemoryDatabase();
    memory.setRoom({
      id: "room-a",
      phase: "architect",
      currentRevisionId: "revision-a",
    });
    const repository = createYjsRepository(memory.database);
    const live = documentWithArchitecture("revision-a", "Before");
    const snapshots = createSnapshotService({
      persistRoomSnapshot: repository.persistRoomSnapshot,
    });
    snapshots.track("room-a", live);
    live.getMap("shared").set("dirty", true);
    await snapshots.changed("room-a", live);

    memory.beforeNextTransaction(() => {
      const committed = documentWithArchitecture("revision-b", "After");
      memory.snapshots.push({
        roomId: "room-a",
        version: 1,
        payload: Y.encodeStateAsUpdate(committed),
        reason: "architecture_revision",
      });
      memory.setRoom({
        id: "room-a",
        phase: "architect",
        currentRevisionId: "revision-b",
      });
      live.getMap(ARCHITECTURE_MAP_KEY).set(
        ARCHITECTURE_CURRENT_KEY,
        committed.getMap(ARCHITECTURE_MAP_KEY).get(ARCHITECTURE_CURRENT_KEY),
      );
      live.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(
        ARCHITECTURE_CURRENT_KEY,
        committed
          .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
          .get(ARCHITECTURE_CURRENT_KEY),
      );
      committed.destroy();
    });

    await expect(snapshots.store("room-a", live)).rejects.toThrow(
      "Snapshot architecture revision is stale",
    );
    const restarted = await repository.loadRoomDocument("room-a");
    expect(
      restarted
        .getMap(ARCHITECTURE_MAP_KEY)
        .get(ARCHITECTURE_CURRENT_KEY),
    ).toMatchObject({ revisionId: "revision-b" });
    expect(memory.snapshots).toHaveLength(1);

    restarted.destroy();
    live.destroy();
  });

  it("restores only the latest Yjs snapshot after a new process loads the room", async () => {
    const memory = createMemoryDatabase();
    const repository = createYjsRepository(memory.database);

    await repository.persistRoomSnapshot(
      "room-a",
      documentWithPhase("sketch"),
      "first",
    );
    await repository.persistRoomSnapshot(
      "room-a",
      documentWithPhase("architect"),
      "second",
    );

    const restored = await repository.loadRoomDocument("room-a");

    expect(restored.getMap("meta").get("phase")).toBe("architect");
  });

  it("returns an empty Y.Doc when a room has no snapshot", async () => {
    const repository = createYjsRepository(createMemoryDatabase().database);

    const restored = await repository.loadRoomDocument("empty-room");

    expect(restored).toBeInstanceOf(Y.Doc);
    expect(restored.getMap("meta").size).toBe(0);
  });

  it("stores encoded update bytes, reasons, and monotonic versions", async () => {
    const memory = createMemoryDatabase();
    const repository = createYjsRepository(memory.database);
    const document = documentWithPhase("sketch");

    await expect(
      repository.persistRoomSnapshot("room-a", document, "debounced_change"),
    ).resolves.toBe(1);
    document.getMap("meta").set("phase", "reconstructing");
    await expect(
      repository.persistRoomSnapshot("room-a", document, "phase_transition"),
    ).resolves.toBe(2);

    expect(memory.snapshots.map(({ version, reason }) => ({ version, reason }))).toEqual([
      { version: 1, reason: "debounced_change" },
      { version: 2, reason: "phase_transition" },
    ]);
    expect(memory.snapshots[1]?.payload).toBeInstanceOf(Uint8Array);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, new Uint8Array(memory.snapshots[1]!.payload));
    expect(restored.getMap("meta").get("phase")).toBe("reconstructing");
  });

  it("retries a unique-version race so concurrent writers get distinct versions", async () => {
    const memory = createMemoryDatabase();
    const repository = createYjsRepository(memory.database);

    const versions = await Promise.all([
      repository.persistRoomSnapshot(
        "room-a",
        documentWithPhase("sketch"),
        "writer-a",
      ),
      repository.persistRoomSnapshot(
        "room-a",
        documentWithPhase("architect"),
        "writer-b",
      ),
    ]);

    expect(versions.sort((left, right) => left - right)).toEqual([1, 2]);
    expect(
      memory.snapshots
        .map((snapshot) => snapshot.version)
        .sort((left, right) => left - right),
    ).toEqual([1, 2]);
  });

  it("propagates non-retryable persistence failures", async () => {
    const memory = createMemoryDatabase();
    const failure = new Error("database unavailable");
    memory.failCreatesWith(failure);
    const repository = createYjsRepository(memory.database);

    await expect(
      repository.persistRoomSnapshot(
        "room-a",
        documentWithPhase("sketch"),
        "failure",
      ),
    ).rejects.toBe(failure);
    expect(memory.snapshots).toHaveLength(0);
  });

  it("atomically rejects a stale reconstruction lease before inserting a snapshot", async () => {
    const memory = createMemoryDatabase();
    memory.setRoom({
      id: "room-a",
      phase: "reconstructing",
      currentRevisionId: null,
    });
    memory.setLease({
      id: "job-a",
      roomId: "room-a",
      state: "publishing",
      architectureRevisionId: "revision-a",
      leaseToken: "lease-current",
      leaseExpiresAt: new Date("2026-07-21T12:01:00.000Z"),
    });
    const repository = createYjsRepository(memory.database, {
      now: () => new Date("2026-07-21T12:00:00.000Z"),
    });
    const document = documentWithArchitecture("revision-a", "Reconstructed");

    await expect(repository.persistRoomSnapshot(
      "room-a",
      document,
      "reconstruction_architecture",
      {
        jobId: "job-a",
        token: "lease-stale",
        expectedState: "publishing",
      },
    )).rejects.toThrow("Reconstruction snapshot lease was lost");
    expect(memory.snapshots).toHaveLength(0);

    await expect(repository.persistRoomSnapshot(
      "room-a",
      document,
      "reconstruction_architecture",
      {
        jobId: "job-a",
        token: "lease-current",
        expectedState: "publishing",
      },
    )).resolves.toBe(1);
    expect(memory.snapshots).toHaveLength(1);
  });

  it("rejects an unfenced pre-architecture snapshot after reconstruction links a revision", async () => {
    const memory = createMemoryDatabase();
    memory.setRoom({
      id: "room-a",
      phase: "reconstructing",
      currentRevisionId: null,
    });
    memory.setLease({
      id: "job-a",
      roomId: "room-a",
      state: "publishing",
      architectureRevisionId: "revision-a",
      leaseToken: "lease-current",
      leaseExpiresAt: new Date("2026-07-21T12:01:00.000Z"),
    });
    const repository = createYjsRepository(memory.database);
    const document = documentWithPhase("reconstructing");

    try {
      await expect(repository.persistRoomSnapshot(
        "room-a",
        document,
        "debounced_change",
      )).rejects.toThrow("Snapshot architecture revision is stale");
      expect(memory.snapshots).toHaveLength(0);
    } finally {
      document.destroy();
    }
  });
});

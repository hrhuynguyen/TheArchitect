import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  createYjsRepository,
  type SnapshotDatabase,
  type SnapshotRecord,
} from "./yjs.repository.js";

function createMemoryDatabase() {
  const snapshots: SnapshotRecord[] = [];
  let createFailure: unknown;

  const database: SnapshotDatabase = {
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
    async $transaction(callback) {
      return callback(database);
    },
  };

  return {
    database,
    snapshots,
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

describe("Yjs snapshot repository", () => {
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
});

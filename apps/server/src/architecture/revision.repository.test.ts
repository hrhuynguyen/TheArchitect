import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  defaultRequirementsProfile,
} from "@architect/contracts";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { createRevisionRepository } from "./revision.repository.js";

type Row = Record<string, any>;

class MemoryDatabase {
  rooms: Row[] = [{
    id: "room-a",
    phase: "architect",
    currentRevisionId: "revision-a",
  }];
  revisions: Row[] = [{
    id: "revision-a",
    roomId: "room-a",
    version: 1,
    stage: "prototype",
  }];
  snapshots: Row[] = [];
  history: Row[] = [];
  failHistory = false;
  retryOnce = false;
  transactionAttempts = 0;
  transactionOptions: unknown[] = [];

  constructor() {
    this.snapshots.push({
      id: "snapshot-1",
      roomId: "room-a",
      version: 1,
      payload: snapshotPayload(protectedState()),
      reason: "architecture_fixture",
    });
  }

  #client(state = this) {
    return {
      room: {
        findUnique: async ({ where }: any) =>
          state.rooms.find((row) => row.id === where.id) ?? null,
        updateMany: async ({ where, data }: any) => {
          const row = state.rooms.find((candidate) =>
            candidate.id === where.id &&
            candidate.phase === where.phase &&
            candidate.currentRevisionId === where.currentRevisionId,
          );
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      },
      architectureRevision: {
        findFirst: async ({ where }: any) =>
          state.revisions.find((row) =>
            row.id === where.id && row.roomId === where.roomId,
          ) ?? null,
        aggregate: async ({ where }: any) => ({
          _max: {
            version: Math.max(
              0,
              ...state.revisions
                .filter((row) => row.roomId === where.roomId)
                .map((row) => row.version),
            ) || null,
          },
        }),
        create: async ({ data }: any) => {
          const row = {
            ...data,
            createdAt: new Date("2026-07-21T12:00:00.000Z"),
          };
          state.revisions.push(row);
          return row;
        },
        findMany: async ({ where }: any) => state.revisions
          .filter((row) => row.roomId === where.roomId && row.architecture)
          .sort((left, right) => right.version - left.version),
      },
      yjsSnapshot: {
        findFirst: async ({ where }: any) => state.snapshots
          .filter((row) => row.roomId === where.roomId)
          .sort((left, right) => right.version - left.version)[0] ?? null,
        aggregate: async ({ where }: any) => ({
          _max: {
            version: Math.max(
              0,
              ...state.snapshots
                .filter((row) => row.roomId === where.roomId)
                .map((row) => row.version),
            ) || null,
          },
        }),
        create: async ({ data }: any) => {
          const row = { id: `snapshot-${state.snapshots.length + 1}`, ...data };
          state.snapshots.push(row);
          return row;
        },
      },
      historyEvent: {
        create: async ({ data }: any) => {
          if (this.failHistory) throw new Error("history unavailable");
          const row = {
            ...data,
            createdAt: new Date("2026-07-21T12:00:00.000Z"),
          };
          state.history.push(row);
          return row;
        },
        findMany: async ({ where }: any) => state.history
          .filter((row) => row.roomId === where.roomId)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
      },
    };
  }

  async $transaction<T>(
    operation: (transaction: any) => Promise<T>,
    options: unknown,
  ): Promise<T> {
    this.transactionAttempts += 1;
    this.transactionOptions.push(options);
    if (this.retryOnce && this.transactionAttempts === 1) {
      throw Object.assign(new Error("serialization race"), { code: "P2034" });
    }
    const state = {
      rooms: structuredClone(this.rooms),
      revisions: structuredClone(this.revisions),
      snapshots: structuredClone(this.snapshots),
      history: structuredClone(this.history),
    };
    const result = await operation(this.#client(state));
    this.rooms = state.rooms;
    this.revisions = state.revisions;
    this.snapshots = state.snapshots;
    this.history = state.history;
    return result;
  }

  get architectureRevision() { return this.#client().architectureRevision; }
  get historyEvent() { return this.#client().historyEvent; }
}

const requirements = defaultRequirementsProfile();
const architecture = {
  version: "architecture/v1" as const,
  requirements,
  resources: [],
  relationships: [],
  decisions: [],
  unresolvedQuestions: [],
};
const layout = {
  version: "architecture-layout/v1" as const,
  revisionId: "revision-b",
  nodes: [],
};

function protectedState(name?: string) {
  const protectedArchitecture = {
    ...architecture,
    resources: name ? [{
      id: "bucket",
      type: "S3" as const,
      name,
      properties: {},
      origin: "explicit" as const,
      reason: "Protected-state revision race fixture.",
      approvalStatus: "not-required" as const,
    }] : [],
  };
  return {
    architecture: {
      version: "working-architecture/v1" as const,
      revisionId: "revision-a",
      architecture: protectedArchitecture,
    },
    layout: {
      version: "architecture-layout/v1" as const,
      revisionId: "revision-a",
      nodes: name ? [{ resourceId: "bucket", x: 0, y: 0 }] : [],
    },
  };
}

function snapshotPayload(state: ReturnType<typeof protectedState>) {
  const document = new Y.Doc();
  try {
    document.getMap(ARCHITECTURE_MAP_KEY).set(
      ARCHITECTURE_CURRENT_KEY,
      state.architecture,
    );
    document.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(
      ARCHITECTURE_CURRENT_KEY,
      state.layout,
    );
    return Y.encodeStateAsUpdate(document);
  } finally {
    document.destroy();
  }
}

function commitInput() {
  const document = new Y.Doc();
  const expectedProtectedState = protectedState();
  document.getMap(ARCHITECTURE_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
    ...expectedProtectedState.architecture,
    revisionId: "revision-b",
  });
  document.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
    ...expectedProtectedState.layout,
    revisionId: "revision-b",
  });
  const candidateSnapshotPayload = Y.encodeStateAsUpdate(document);
  document.destroy();
  return {
    roomId: "room-a",
    baseRevisionId: "revision-a",
    revisionId: "revision-b",
    eventId: "event-b",
    architecture,
    layout,
    requirements,
    author: { type: "participant" as const, id: "participant-a" },
    rationale: "Capture the accepted graph.",
    traceId: "request-7",
    snapshotPayload: candidateSnapshotPayload,
    expectedProtectedState,
  };
}

describe("revision repository", () => {
  it("atomically commits revision, history, room pointer, and rebased Yjs snapshot", async () => {
    const database = new MemoryDatabase();
    const repository = createRevisionRepository({ database: database as never });
    const input = commitInput();

    const result = await repository.commitRevision(input);

    expect(result).toMatchObject({
      kind: "committed",
      revision: {
        id: "revision-b",
        roomId: "room-a",
        version: 2,
        stage: "prototype",
        authorType: "participant",
      },
      event: {
        id: "event-b",
        kind: "architecture_revision_saved",
        status: "succeeded",
        traceId: "request-7",
      },
    });
    expect(database.rooms[0].currentRevisionId).toBe("revision-b");
    expect(database.snapshots).toHaveLength(2);
    expect(database.snapshots[1]).toMatchObject({
      roomId: "room-a",
      version: 2,
      reason: "architecture_revision",
      payload: Buffer.from(input.snapshotPayload),
    });
    expect(database.transactionOptions[0]).toMatchObject({
      isolationLevel: "Serializable",
    });
  });

  it("returns stale without partial rows when the room pointer moved", async () => {
    const database = new MemoryDatabase();
    database.rooms[0].currentRevisionId = "revision-newer";
    const repository = createRevisionRepository({ database: database as never });

    await expect(repository.commitRevision(commitInput())).resolves.toEqual({
      kind: "stale",
      currentRevisionId: "revision-newer",
    });
    expect(database.revisions).toHaveLength(1);
    expect(database.history).toHaveLength(0);
    expect(database.snapshots).toHaveLength(1);
  });

  it("returns working conflict without partial writes when an operation advances the protected state", async () => {
    const database = new MemoryDatabase();
    database.snapshots.push({
      roomId: "room-a",
      version: 2,
      payload: snapshotPayload(protectedState("Operation winner")),
      reason: "architecture_operations",
    });
    const repository = createRevisionRepository({ database: database as never });

    await expect(repository.commitRevision(commitInput())).resolves.toEqual({
      kind: "working_conflict",
    });
    expect(database.rooms[0].currentRevisionId).toBe("revision-a");
    expect(database.revisions).toHaveLength(1);
    expect(database.history).toHaveLength(0);
    expect(database.snapshots).toHaveLength(2);
  });

  it("rolls back all writes if any atomic revision write fails", async () => {
    const database = new MemoryDatabase();
    database.failHistory = true;
    const repository = createRevisionRepository({ database: database as never });

    await expect(repository.commitRevision(commitInput())).rejects.toThrow(
      "history unavailable",
    );
    expect(database.rooms[0].currentRevisionId).toBe("revision-a");
    expect(database.revisions).toHaveLength(1);
    expect(database.history).toHaveLength(0);
    expect(database.snapshots).toHaveLength(1);
  });

  it("retries serializable conflicts and lists immutable records newest first", async () => {
    const database = new MemoryDatabase();
    database.retryOnce = true;
    const repository = createRevisionRepository({ database: database as never });

    await expect(repository.commitRevision(commitInput())).resolves.toMatchObject({
      kind: "committed",
    });
    expect(database.transactionAttempts).toBe(2);
    await expect(repository.listHistory("room-a")).resolves.toMatchObject({
      revisions: [{ id: "revision-b", version: 2 }],
      events: [{ id: "event-b" }],
    });
  });
});

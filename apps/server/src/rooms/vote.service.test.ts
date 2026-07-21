import {
  READINESS_THRESHOLD,
  SERVER_VOTES_MAP_KEY,
  VoteMutationResponseSchema,
  VoteSnapshotSchema,
  evaluateVote,
  type RoomPhase,
} from "@architect/contracts";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import { createActiveDocumentRegistry } from "../collab/active-document.registry.js";
import { createAwarenessRegistry } from "../collab/awareness.registry.js";
import { VoteClosedError, createVoteService } from "./vote.service.js";

type Job = {
  id: string;
  roomId: string;
  sourceRevision: number;
  kind: "ready";
  traceId: string;
};

function transitionKey(roomId: string, revision: number, kind = "ready") {
  return `${roomId}:${revision}:${kind}`;
}

class MemoryVoteDatabase {
  rooms = new Map<string, RoomPhase>();
  jobs = new Map<string, Job>();
  failPhaseUpdate = false;
  beforeCommit?: () => Promise<void>;
  phaseReads = 0;
  #tail = Promise.resolve();

  transitionJob: {
    findUnique(input: unknown): Promise<Job | null>;
    findFirst(input: unknown): Promise<Job | null>;
  };
  room = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      this.phaseReads += 1;
      const phase = this.rooms.get(where.id);
      return phase ? { phase } : null;
    },
  };

  constructor(roomId = "room-a") {
    this.rooms.set(roomId, "sketch");
    this.transitionJob = {
      findUnique: async ({ where }: { where: { roomId_sourceRevision_kind: { roomId: string; sourceRevision: number; kind: "ready" } } }) => {
        const key = where.roomId_sourceRevision_kind;
        return this.jobs.get(transitionKey(key.roomId, key.sourceRevision, key.kind)) ?? null;
      },
      findFirst: async ({ where }: { where: { roomId: string; kind: "ready" } }) =>
        [...this.jobs.values()].find(
          (job) => job.roomId === where.roomId && job.kind === where.kind,
        ) ?? null,
    } as typeof this.transitionJob;
  }

  async $transaction<T>(operation: (transaction: unknown) => Promise<T>) {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const rooms = new Map(this.rooms);
    const jobs = new Map(this.jobs);
    let nextJob = jobs.size + 1;
    try {
      const result = await operation({
        room: {
          updateMany: async ({ where, data }: { where: { id: string; phase: RoomPhase }; data: { phase: RoomPhase } }) => {
            if (this.failPhaseUpdate) throw new Error("phase update failed");
            if (rooms.get(where.id) !== where.phase) return { count: 0 };
            rooms.set(where.id, data.phase);
            return { count: 1 };
          },
        },
        transitionJob: {
          create: async ({ data }: { data: Omit<Job, "id"> }) => {
            const key = transitionKey(data.roomId, data.sourceRevision, data.kind);
            if (jobs.has(key)) throw Object.assign(new Error("unique"), { code: "P2002" });
            const job = { ...data, id: `job-${nextJob++}` };
            jobs.set(key, job);
            return job;
          },
        },
      });
      await this.beforeCommit?.();
      this.rooms = rooms;
      this.jobs = jobs;
      return result;
    } finally {
      release();
    }
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function presence(
  roomId: string,
  participantIds: ReadonlyArray<string>,
) {
  const awareness = createAwarenessRegistry();
  for (const participantId of participantIds) {
    awareness.connect(roomId, `socket-${participantId}`, {
      participantId,
      name: participantId,
      color: "#123456",
      phase: "sketch",
    });
  }
  return awareness;
}

function harness(options: {
  active?: boolean;
  onPostCommitPersistenceError?: (error: unknown) => void;
  participantIds?: string[];
  phaseRetryAttempts?: number;
  persist?: (roomId: string, document: Y.Doc, reason: string) => Promise<number>;
} = {}) {
  const roomId = "room-a";
  const stored = new Map<string, Uint8Array>();
  const database = new MemoryVoteDatabase(roomId);
  const awarenessRegistry = presence(roomId, options.participantIds ?? ["participant-a"]);
  let revision = 0;
  const persistRoomSnapshot = options.persist ?? (async (id: string, document: Y.Doc) => {
    revision += 1;
    stored.set(id, Y.encodeStateAsUpdate(document));
    return revision;
  });
  const documents = createActiveDocumentRegistry({
    async loadRoomDocument(id) {
      const document = new Y.Doc();
      const update = stored.get(id);
      if (update) Y.applyUpdate(document, update);
      return document;
    },
  });
  const live = new Y.Doc();

  return {
    awarenessRegistry,
    database,
    documents,
    live,
    persistRoomSnapshot,
    roomId,
    stored,
    async start() {
      const service = createVoteService({
        awarenessRegistry,
        database,
        documents,
        onPostCommitPersistenceError: options.onPostCommitPersistenceError,
        phaseRetryAttempts: options.phaseRetryAttempts,
        persistRoomSnapshot,
      });
      const deactivate = options.active === false
        ? async () => undefined
        : await documents.activate(roomId, live);
      return { deactivate, service };
    },
    async stop(service: { destroy(): Promise<void> }, deactivate: () => Promise<void>) {
      await service.destroy();
      await deactivate();
      await documents.destroy();
      awarenessRegistry.destroy();
      live.destroy();
    },
  };
}

function readReady(document: Y.Doc) {
  return VoteSnapshotSchema.parse(
    document.getMap(SERVER_VOTES_MAP_KEY).get("ready"),
  );
}

describe("server-authoritative vote state", () => {
  it("includes a verified requester during a heartbeat race and never trusts browser totals", async () => {
    const test = harness({ participantIds: ["participant-b"] });
    const { deactivate, service } = await test.start();
    try {
      const response = await service.castVote(
        test.roomId,
        "participant-a",
        "ready",
      );

      expect(VoteMutationResponseSchema.parse(response)).toMatchObject({
        kind: "ready",
        phase: "sketch",
        snapshot: {
          tally: 1,
          total: 2,
          ratio: 0.5,
          met: false,
          threshold: READINESS_THRESHOLD,
          voterIds: ["participant-a"],
        },
        transition: null,
      });
      expect(readReady(test.live)).toEqual(response.snapshot);
      expect(test.database.jobs).toHaveLength(0);
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("removes inactive voters and broadcasts a recomputed canonical snapshot", async () => {
    const test = harness({ participantIds: ["a", "b", "c"] });
    const { deactivate, service } = await test.start();
    try {
      await service.castVote(test.roomId, "a", "deploy_localstack");
      await service.castVote(test.roomId, "b", "deploy_localstack");
      const votes = test.live.getMap(SERVER_VOTES_MAP_KEY);
      expect(VoteSnapshotSchema.parse(votes.get("deploy_localstack"))).toMatchObject({
        tally: 2,
        total: 3,
        voterIds: ["a", "b"],
      });

      test.awarenessRegistry.disconnect(test.roomId, "socket-b");
      await service.settle();

      expect(VoteSnapshotSchema.parse(votes.get("deploy_localstack"))).toMatchObject({
        tally: 1,
        total: 2,
        voterIds: ["a"],
      });
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("lets a solo participant claim readiness once and keeps repeated POST idempotent", async () => {
    const test = harness();
    const { deactivate, service } = await test.start();
    try {
      const first = await service.castVote(test.roomId, "participant-a", "ready");
      const replay = await service.castVote(test.roomId, "participant-a", "ready");

      expect(first).toMatchObject({
        phase: "reconstructing",
        transition: {
          claimed: true,
          jobId: "job-1",
          sourceSnapshotVersion: 1,
        },
      });
      expect(replay).toMatchObject({
        phase: "reconstructing",
        transition: {
          claimed: false,
          jobId: "job-1",
          sourceSnapshotVersion: 1,
        },
      });
      expect(test.database.rooms.get(test.roomId)).toBe("reconstructing");
      expect([...test.database.jobs.values()]).toEqual([
        expect.objectContaining({
          id: "job-1",
          roomId: test.roomId,
          sourceRevision: 1,
          kind: "ready",
        }),
      ]);
      expect(test.live.getMap("meta").get("phase")).toBe("reconstructing");
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("does not broadcast met readiness before the durable phase commit", async () => {
    const test = harness();
    const observedDurablePhases: Array<RoomPhase | undefined> = [];
    test.live.getMap(SERVER_VOTES_MAP_KEY).observe(() => {
      const parsed = VoteSnapshotSchema.safeParse(
        test.live.getMap(SERVER_VOTES_MAP_KEY).get("ready"),
      );
      if (parsed.success && parsed.data.met) {
        observedDurablePhases.push(test.database.rooms.get(test.roomId));
      }
    });
    const { deactivate, service } = await test.start();
    try {
      await service.castVote(test.roomId, "participant-a", "ready");
      expect(observedDurablePhases).toEqual(["reconstructing"]);
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("keeps an unmet vote private until its candidate snapshot persists", async () => {
    const persistenceStarted = deferred();
    const allowPersistence = deferred();
    const test = harness({
      participantIds: ["participant-a", "participant-b"],
      persist: vi.fn(async () => {
        persistenceStarted.resolve();
        await allowPersistence.promise;
        return 1;
      }),
    });
    const { deactivate, service } = await test.start();
    try {
      const pending = service.castVote(test.roomId, "participant-a", "ready");
      await persistenceStarted.promise;

      expect(test.live.getMap(SERVER_VOTES_MAP_KEY).has("ready")).toBe(false);
      allowPersistence.resolve();
      await expect(pending).resolves.toMatchObject({
        phase: "sketch",
        snapshot: { tally: 1, total: 2, met: false },
      });
      expect(readReady(test.live)).toMatchObject({ tally: 1, met: false });
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("publishes vote and phase together only after commit and preserves concurrent live edits", async () => {
    const commitStarted = deferred();
    const allowCommit = deferred();
    const test = harness();
    test.database.beforeCommit = async () => {
      commitStarted.resolve();
      await allowCommit.promise;
    };
    const published: Array<{ met: boolean; phase: unknown }> = [];
    test.live.getMap(SERVER_VOTES_MAP_KEY).observe(() => {
      const ready = VoteSnapshotSchema.safeParse(
        test.live.getMap(SERVER_VOTES_MAP_KEY).get("ready"),
      );
      if (ready.success) {
        published.push({
          met: ready.data.met,
          phase: test.live.getMap("meta").get("phase"),
        });
      }
    });
    const { deactivate, service } = await test.start();
    try {
      const pending = service.castVote(test.roomId, "participant-a", "ready");
      await commitStarted.promise;

      expect(test.database.rooms.get(test.roomId)).toBe("sketch");
      expect(test.live.getMap(SERVER_VOTES_MAP_KEY).has("ready")).toBe(false);
      test.live.getMap("canvas").set("concurrent-stroke", "preserved");

      allowCommit.resolve();
      await expect(pending).resolves.toMatchObject({
        phase: "reconstructing",
        snapshot: { met: true },
      });
      expect(test.database.rooms.get(test.roomId)).toBe("reconstructing");
      expect(test.live.getMap("canvas").get("concurrent-stroke")).toBe(
        "preserved",
      );
      expect(published).toEqual([{ met: true, phase: "reconstructing" }]);
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("DELETE removes only the requester vote and never creates a transition claim", async () => {
    const test = harness({ participantIds: ["a", "b"] });
    const { deactivate, service } = await test.start();
    try {
      await service.castVote(test.roomId, "a", "ready");
      const response = await service.removeVote(test.roomId, "a", "ready");

      expect(response).toMatchObject({
        phase: "sketch",
        snapshot: { tally: 0, total: 2, met: false, voterIds: [] },
        transition: null,
      });
      expect(test.database.rooms.get(test.roomId)).toBe("sketch");
      expect(test.database.jobs.size).toBe(0);
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("overwrites an invalid persisted value without using it to claim", async () => {
    const test = harness({ participantIds: ["a", "b"], active: false });
    const forged = new Y.Doc();
    forged.getMap(SERVER_VOTES_MAP_KEY).set("ready", {
      tally: 99,
      total: 1,
      ratio: 99,
      met: true,
      threshold: READINESS_THRESHOLD,
      voterIds: ["attacker"],
    });
    test.stored.set(test.roomId, Y.encodeStateAsUpdate(forged));
    forged.destroy();
    const { deactivate, service } = await test.start();
    try {
      const response = await service.castVote(test.roomId, "a", "ready");
      expect(response).toMatchObject({
        phase: "sketch",
        snapshot: { tally: 1, total: 2, met: false, voterIds: ["a"] },
        transition: null,
      });
      expect(test.database.jobs.size).toBe(0);
    } finally {
      await test.stop(service, deactivate);
    }
  });
});

describe("readiness transition failure and concurrency boundaries", () => {
  it("leaves Room sketch and creates no job when the source snapshot cannot persist", async () => {
    const test = harness({ persist: vi.fn().mockRejectedValue(new Error("snapshot offline")) });
    const { deactivate, service } = await test.start();
    try {
      await expect(
        service.castVote(test.roomId, "participant-a", "ready"),
      ).rejects.toThrow("snapshot offline");
      expect(test.database.rooms.get(test.roomId)).toBe("sketch");
      expect(test.database.jobs.size).toBe(0);
      expect(test.live.getMap(SERVER_VOTES_MAP_KEY).has("ready")).toBe(false);
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("rolls back a created job when the durable phase update fails", async () => {
    const test = harness();
    test.database.failPhaseUpdate = true;
    const { deactivate, service } = await test.start();
    try {
      await expect(
        service.castVote(test.roomId, "participant-a", "ready"),
      ).rejects.toThrow("phase update failed");
      expect(test.database.rooms.get(test.roomId)).toBe("sketch");
      expect(test.database.jobs.size).toBe(0);
      expect(test.live.getMap(SERVER_VOTES_MAP_KEY).has("ready")).toBe(false);
      expect(test.live.getMap("meta").has("phase")).toBe(false);
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("closes queued DELETE and new-voter POST after readiness commits", async () => {
    const sourcePersistenceStarted = deferred();
    const allowSourcePersistence = deferred();
    let calls = 0;
    const test = harness({
      persist: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          sourcePersistenceStarted.resolve();
          await allowSourcePersistence.promise;
        }
        return calls;
      }),
    });
    const { deactivate, service } = await test.start();
    try {
      const ready = service.castVote(test.roomId, "participant-a", "ready");
      await sourcePersistenceStarted.promise;
      const remove = service.removeVote(test.roomId, "participant-a", "ready");
      const newVoter = service.castVote(test.roomId, "participant-new", "ready");
      allowSourcePersistence.resolve();

      await expect(ready).resolves.toMatchObject({ phase: "reconstructing" });
      await expect(remove).rejects.toBeInstanceOf(VoteClosedError);
      await expect(newVoter).rejects.toBeInstanceOf(VoteClosedError);
      expect(test.database.rooms.get(test.roomId)).toBe("reconstructing");
      expect(test.live.getMap("meta").get("phase")).toBe("reconstructing");
      expect(readReady(test.live)).toMatchObject({ met: true, tally: 1 });
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("keeps a committed transition replayable when the post-commit Yjs persist fails", async () => {
    let calls = 0;
    const observeFailure = vi.fn();
    const persist = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("post-commit snapshot offline");
      return calls;
    });
    const test = harness({ onPostCommitPersistenceError: observeFailure, persist });
    const { deactivate, service } = await test.start();
    try {
      const first = await service.castVote(test.roomId, "participant-a", "ready");
      const replay = await service.castVote(test.roomId, "participant-a", "ready");

      expect(first.transition).toEqual({
        claimed: true,
        jobId: "job-1",
        sourceSnapshotVersion: 1,
      });
      expect(replay.transition).toEqual({
        claimed: false,
        jobId: "job-1",
        sourceSnapshotVersion: 1,
      });
      expect(test.database.rooms.get(test.roomId)).toBe("reconstructing");
      expect(test.database.jobs.size).toBe(1);
      expect(test.live.getMap("meta").get("phase")).toBe("reconstructing");
      expect(readReady(test.live).met).toBe(true);
      expect(observeFailure).toHaveBeenCalledWith(
        expect.objectContaining({ message: "post-commit snapshot offline" }),
      );
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("queues an immutable phase snapshot retry before publishing to the live document", async () => {
    const retryStarted = deferred();
    const allowRetry = deferred();
    const observeFailure = vi.fn();
    let calls = 0;
    const test = harness({
      onPostCommitPersistenceError: observeFailure,
      persist: vi.fn(async () => {
        calls += 1;
        if (calls === 2) throw new Error("phase snapshot offline");
        if (calls === 3) {
          retryStarted.resolve();
          await allowRetry.promise;
        }
        return calls;
      }),
    });
    const { deactivate, service } = await test.start();
    try {
      const response = await service.castVote(
        test.roomId,
        "participant-a",
        "ready",
      );
      await retryStarted.promise;

      expect(response.phase).toBe("reconstructing");
      expect(test.database.jobs.size).toBe(1);
      expect(test.live.getMap(SERVER_VOTES_MAP_KEY).has("ready")).toBe(false);
      test.live.getMap("canvas").set("during-retry", "preserved");

      allowRetry.resolve();
      await service.settle();
      expect(readReady(test.live)).toMatchObject({ met: true, tally: 1 });
      expect(test.live.getMap("meta").get("phase")).toBe("reconstructing");
      expect(test.live.getMap("canvas").get("during-retry")).toBe("preserved");
      expect(observeFailure).toHaveBeenCalledOnce();
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("reports an exhausted phase snapshot retry while leaving one durable job", async () => {
    let calls = 0;
    const observeFailure = vi.fn();
    const failure = new Error("phase persistence unavailable");
    const test = harness({
      onPostCommitPersistenceError: observeFailure,
      phaseRetryAttempts: 2,
      persist: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return 1;
        throw failure;
      }),
    });
    const { deactivate, service } = await test.start();
    await expect(
      service.castVote(test.roomId, "participant-a", "ready"),
    ).resolves.toMatchObject({ phase: "reconstructing" });

    await expect(service.destroy()).rejects.toThrow(
      "Phase snapshot retry failed",
    );
    expect(test.database.rooms.get(test.roomId)).toBe("reconstructing");
    expect(test.database.jobs.size).toBe(1);
    expect(test.live.getMap(SERVER_VOTES_MAP_KEY).has("ready")).toBe(false);
    expect(observeFailure).toHaveBeenCalledTimes(3);

    await deactivate();
    await test.documents.destroy();
    test.awarenessRegistry.destroy();
    test.live.destroy();
  });

  it("accepts one concurrent threshold crossing and closes the later new voter", async () => {
    const test = harness({ participantIds: ["a", "b", "c", "d", "e"] });
    const { deactivate, service } = await test.start();
    try {
      await service.castVote(test.roomId, "a", "ready");
      await service.castVote(test.roomId, "b", "ready");
      await service.castVote(test.roomId, "c", "ready");

      const [first, second] = await Promise.allSettled([
        service.castVote(test.roomId, "d", "ready"),
        service.castVote(test.roomId, "e", "ready"),
      ]);

      expect(first).toMatchObject({
        status: "fulfilled",
        value: {
          transition: {
            claimed: true,
            jobId: "job-1",
            sourceSnapshotVersion: 4,
          },
        },
      });
      expect(second).toMatchObject({
        status: "rejected",
        reason: expect.any(VoteClosedError),
      });
      expect(test.database.jobs.size).toBe(1);
      expect(test.database.rooms.get(test.roomId)).toBe("reconstructing");
      expect(readReady(test.live).voterIds).toEqual(["a", "b", "c", "d"]);
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("stops presence listeners idempotently", async () => {
    const persist = vi.fn(async () => 1);
    const test = harness({ participantIds: ["a", "b"], persist });
    const { deactivate, service } = await test.start();
    await service.castVote(test.roomId, "a", "deploy_aws");
    await service.destroy();
    await service.destroy();
    const before = persist.mock.calls.length;

    test.awarenessRegistry.disconnect(test.roomId, "socket-b");
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(before);

    await deactivate();
    await test.documents.destroy();
    test.awarenessRegistry.destroy();
    test.live.destroy();
  });

  it("does not query durable voting state for cursor-only awareness traffic", async () => {
    const test = harness();
    const { deactivate, service } = await test.start();
    const before = test.database.phaseReads;

    test.awarenessRegistry.updateClient(
      test.roomId,
      "socket-participant-a",
      7,
      { cursor: { x: 12, y: 24 }, phase: "sketch" },
    );
    await service.settle();

    expect(test.database.phaseReads).toBe(before);
    await test.stop(service, deactivate);
  });

  it("coalesces repeated membership changes to the latest room state", async () => {
    const recomputeStarted = deferred();
    const allowRecompute = deferred();
    let blockPresence = false;
    let revision = 0;
    const test = harness({
      participantIds: ["a", "b", "c"],
      persist: vi.fn(async (_roomId, _document, reason) => {
        revision += 1;
        if (blockPresence && reason === "vote_presence") {
          blockPresence = false;
          recomputeStarted.resolve();
          await allowRecompute.promise;
        }
        return revision;
      }),
    });
    const { deactivate, service } = await test.start();
    try {
      await service.castVote(test.roomId, "a", "deploy_aws");
      const before = test.database.phaseReads;
      blockPresence = true;
      test.awarenessRegistry.disconnect(test.roomId, "socket-b");
      await recomputeStarted.promise;
      test.awarenessRegistry.disconnect(test.roomId, "socket-c");
      test.awarenessRegistry.connect(test.roomId, "socket-c", {
        participantId: "c",
        name: "c",
        color: "#123456",
        phase: "sketch",
      });
      allowRecompute.resolve();
      await service.settle();

      expect(test.database.phaseReads - before).toBe(2);
      expect(
        VoteSnapshotSchema.parse(
          test.live.getMap(SERVER_VOTES_MAP_KEY).get("deploy_aws"),
        ),
      ).toMatchObject({ tally: 1, total: 2, voterIds: ["a"] });
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("does not let a blocked room delay membership recomputation in another room", async () => {
    const roomB = "room-b";
    const database = new MemoryVoteDatabase();
    database.rooms.set(roomB, "sketch");
    const awarenessRegistry = createAwarenessRegistry();
    for (const [id, currentRoom] of [
      ["a1", "room-a"],
      ["a2", "room-a"],
      ["b1", roomB],
      ["b2", roomB],
    ] as const) {
      awarenessRegistry.connect(currentRoom, `socket-${id}`, {
        participantId: id,
        name: id,
        color: "#123456",
        phase: "sketch",
      });
    }
    const documents = createActiveDocumentRegistry({
      async loadRoomDocument() {
        return new Y.Doc();
      },
    });
    const liveA = new Y.Doc();
    const liveB = new Y.Doc();
    const deactivateA = await documents.activate("room-a", liveA);
    const deactivateB = await documents.activate(roomB, liveB);
    const roomAStarted = deferred();
    const allowRoomA = deferred();
    const roomBFinished = deferred();
    let blockPresence = false;
    let revision = 0;
    const service = createVoteService({
      awarenessRegistry,
      database,
      documents,
      async persistRoomSnapshot(currentRoom, _document, reason) {
        revision += 1;
        if (blockPresence && reason === "vote_presence") {
          if (currentRoom === "room-a") {
            roomAStarted.resolve();
            await allowRoomA.promise;
          } else if (currentRoom === roomB) {
            roomBFinished.resolve();
          }
        }
        return revision;
      },
    });

    try {
      await service.castVote("room-a", "a1", "deploy_localstack");
      await service.castVote(roomB, "b1", "deploy_localstack");
      blockPresence = true;
      awarenessRegistry.disconnect("room-a", "socket-a2");
      await roomAStarted.promise;
      awarenessRegistry.disconnect(roomB, "socket-b2");

      await expect.poll(
        async () =>
          Promise.race([
            roomBFinished.promise.then(() => true),
            new Promise<false>((resolve) =>
              setTimeout(() => resolve(false), 10),
            ),
          ]),
        { timeout: 250 },
      ).toBe(true);
      allowRoomA.resolve();
      await service.settle();
    } finally {
      allowRoomA.resolve();
      await service.destroy();
      await deactivateA();
      await deactivateB();
      await documents.destroy();
      awarenessRegistry.destroy();
      liveA.destroy();
      liveB.destroy();
    }
  });

  it("claims once when a nonvoter disconnect raises readiness to the threshold", async () => {
    const test = harness({ participantIds: ["a", "b", "c", "d", "e", "f"] });
    const { deactivate, service } = await test.start();
    try {
      for (const participantId of ["a", "b", "c", "d"]) {
        await service.castVote(test.roomId, participantId, "ready");
      }
      expect(readReady(test.live)).toMatchObject({ tally: 4, total: 6, met: false });
      expect(test.database.jobs.size).toBe(0);

      test.awarenessRegistry.disconnect(test.roomId, "socket-f");
      await service.settle();
      expect(readReady(test.live)).toMatchObject({ tally: 4, total: 5, met: true });
      expect(test.database.rooms.get(test.roomId)).toBe("reconstructing");
      expect(test.database.jobs.size).toBe(1);
      expect(test.live.getMap("meta").get("phase")).toBe("reconstructing");

      test.awarenessRegistry.disconnect(test.roomId, "socket-e");
      await service.settle();
      expect(test.database.jobs.size).toBe(1);
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("derives deploy vote response phase from durable Room state", async () => {
    const test = harness();
    const { deactivate, service } = await test.start();
    try {
      await service.castVote(test.roomId, "participant-a", "ready");
      const deployVote = await service.castVote(
        test.roomId,
        "participant-a",
        "deploy_localstack",
      );

      expect(deployVote.phase).toBe("reconstructing");
      expect(deployVote.transition).toBeNull();
      await expect(
        service.removeVote(test.roomId, "participant-a", "ready"),
      ).rejects.toThrow("Readiness voting is closed");
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("does not let a concurrently queued deploy vote regress a readiness transition", async () => {
    const readyPersistenceStarted = deferred();
    const allowReadyPersistence = deferred();
    let revision = 0;
    const test = harness({
      persist: vi.fn(async () => {
        revision += 1;
        if (revision === 1) {
          readyPersistenceStarted.resolve();
          await allowReadyPersistence.promise;
        }
        return revision;
      }),
    });
    const { deactivate, service } = await test.start();
    try {
      const ready = service.castVote(test.roomId, "participant-a", "ready");
      await readyPersistenceStarted.promise;
      const deploy = service.castVote(
        test.roomId,
        "participant-a",
        "deploy_aws",
      );
      allowReadyPersistence.resolve();
      const [readyVote, deployVote] = await Promise.all([ready, deploy]);

      expect(readyVote.phase).toBe("reconstructing");
      expect(deployVote.phase).toBe("reconstructing");
      expect(test.database.rooms.get(test.roomId)).toBe("reconstructing");
      expect(test.live.getMap("meta").get("phase")).toBe("reconstructing");
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("returns one job and one claimed caller for direct concurrent duplicate claims", async () => {
    const test = harness({ active: false });
    const { deactivate, service } = await test.start();
    try {
      const [first, second] = await Promise.all([
        service.claimTransition(test.roomId, 7, "ready"),
        service.claimTransition(test.roomId, 7, "ready"),
      ]);
      expect(new Set([first.jobId, second.jobId])).toEqual(new Set(["job-1"]));
      expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
      expect(test.database.jobs.size).toBe(1);

      await expect(
        service.claimTransition(test.roomId, -1, "ready"),
      ).rejects.toThrow("Invalid source revision");
      await expect(
        service.claimTransition(test.roomId, 1.5, "ready"),
      ).rejects.toThrow("Invalid source revision");
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it.each(["architect", "deploy"] as const)(
    "closes readiness in durable %s phase without regressing Yjs meta",
    async (phase) => {
      const test = harness();
      test.database.rooms.set(test.roomId, phase);
      test.live.getMap("meta").set("phase", phase);
      const { deactivate, service } = await test.start();
      try {
        for (const action of [
          () => service.castVote(test.roomId, "participant-a", "ready"),
          () => service.removeVote(test.roomId, "participant-a", "ready"),
        ]) {
          await expect(action()).rejects.toBeInstanceOf(VoteClosedError);
        }
        expect(test.database.jobs.size).toBe(0);
        expect(test.live.getMap("meta").get("phase")).toBe(phase);
      } finally {
        await test.stop(service, deactivate);
      }
    },
  );

  it("allows only an exact same-voter POST replay while reconstructing", async () => {
    const test = harness({ participantIds: ["participant-a", "participant-b"] });
    const { deactivate, service } = await test.start();
    try {
      await service.castVote(test.roomId, "participant-a", "ready");
      const first = await service.castVote(
        test.roomId,
        "participant-b",
        "ready",
      );
      expect(first.transition).toEqual({
        claimed: true,
        jobId: "job-1",
        sourceSnapshotVersion: 2,
      });

      const replay = await service.castVote(test.roomId, "participant-a", "ready");
      expect(replay.transition).toEqual({
        claimed: false,
        jobId: "job-1",
        sourceSnapshotVersion: 2,
      });
      await expect(
        service.castVote(test.roomId, "participant-new", "ready"),
      ).rejects.toBeInstanceOf(VoteClosedError);
      await expect(
        service.removeVote(test.roomId, "participant-a", "ready"),
      ).rejects.toBeInstanceOf(VoteClosedError);
      expect(test.database.jobs.size).toBe(1);
    } finally {
      await test.stop(service, deactivate);
    }
  });

  it("normalizes stale Yjs phase from durable state without claiming after sketch", async () => {
    const test = harness({ participantIds: ["a", "b"] });
    test.database.rooms.set(test.roomId, "architect");
    test.live.getMap("meta").set("phase", "reconstructing");
    test.live.getMap(SERVER_VOTES_MAP_KEY).set(
      "ready",
      evaluateVote({
        activeParticipantIds: ["a", "b"],
        voterIds: ["a"],
        threshold: READINESS_THRESHOLD,
      }),
    );
    const { deactivate, service } = await test.start();
    try {
      test.awarenessRegistry.disconnect(test.roomId, "socket-b");
      await service.settle();

      expect(test.database.rooms.get(test.roomId)).toBe("architect");
      expect(test.database.jobs.size).toBe(0);
      expect(test.live.getMap("meta").get("phase")).toBe("architect");
    } finally {
      await test.stop(service, deactivate);
    }
  });
});

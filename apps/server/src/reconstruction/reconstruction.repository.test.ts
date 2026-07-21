import { defaultRequirementsProfile } from "@architect/contracts";
import { describe, expect, it } from "vitest";
import {
  createReconstructionRepository,
  type ReconstructionLease,
} from "./reconstruction.repository.js";

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") return (expected as Row[]).some((item) => matches(row, item));
    if (key === "AND") return (expected as Row[]).every((item) => matches(row, item));
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const condition = expected as Row;
      if ("in" in condition && !condition.in.includes(actual)) return false;
      if ("notIn" in condition && condition.notIn.includes(actual)) return false;
      if ("lte" in condition && !(actual && actual <= condition.lte)) return false;
      if ("lt" in condition && !(actual && actual < condition.lt)) return false;
      if ("gte" in condition && !(actual && actual >= condition.gte)) return false;
      if ("gt" in condition && !(actual && actual > condition.gt)) return false;
      if ("equals" in condition && actual !== condition.equals) return false;
      return true;
    }
    return actual === expected;
  });
}

class MemoryDatabase {
  rooms: Row[] = [{ id: "room-a", phase: "reconstructing", currentRevisionId: null }];
  jobs: Row[] = [{
    id: "job-a",
    roomId: "room-a",
    sourceRevision: 7,
    kind: "ready",
    state: "claimed",
    traceId: "transition-a",
    errorCode: null,
    attempt: 0,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    attemptParticipantId: null,
    attemptInputDigest: null,
    activeAiTraceId: null,
    architectureRevisionId: null,
    result: null,
    diagnostics: null,
    cleanupCompletedAt: null,
    phasePublishedAt: null,
    finishedAt: null,
    createdAt: new Date("2026-07-21T12:00:00.000Z"),
    updatedAt: new Date("2026-07-21T12:00:00.000Z"),
  }];
  aiRuns: Row[] = [];
  revisions: Row[] = [];
  history: Row[] = [];
  #tail = Promise.resolve();

  #client(state = this) {
    const find = (rows: Row[], where?: Row) => rows.find((row) => matches(row, where));
    const updateMany = (rows: Row[], input: { where?: Row; data: Row }) => {
      let count = 0;
      for (const row of rows) {
        if (!matches(row, input.where)) continue;
        Object.assign(row, input.data, { updatedAt: input.data.updatedAt ?? row.updatedAt });
        count += 1;
      }
      return { count };
    };
    return {
      room: {
        findUnique: async ({ where }: any) => find(state.rooms, where) ?? null,
        updateMany: async (input: any) => updateMany(state.rooms, input),
      },
      transitionJob: {
        findUnique: async ({ where }: any) => find(state.jobs, where) ?? null,
        findFirst: async ({ where }: any) => find(state.jobs, where) ?? null,
        findMany: async ({ where }: any) => state.jobs.filter((row) => matches(row, where)),
        updateMany: async (input: any) => updateMany(state.jobs, input),
      },
      aiRun: {
        create: async ({ data }: any) => {
          const row = { id: `ai-${state.aiRuns.length + 1}`, ...data };
          if (state.aiRuns.some((item) => item.traceId === row.traceId)) {
            throw Object.assign(new Error("unique ai trace"), { code: "P2002" });
          }
          state.aiRuns.push(row);
          return row;
        },
        updateMany: async (input: any) => updateMany(state.aiRuns, input),
      },
      architectureRevision: {
        aggregate: async ({ where }: any) => ({
          _max: {
            version: Math.max(
              0,
              ...state.revisions
                .filter((row) => matches(row, where))
                .map((row) => row.version),
            ) || null,
          },
        }),
        create: async ({ data }: any) => {
          if (state.revisions.some(
            (item) => item.roomId === data.roomId && item.version === data.version,
          )) throw Object.assign(new Error("revision version race"), { code: "P2002" });
          const row = { id: `revision-${state.revisions.length + 1}`, ...data };
          state.revisions.push(row);
          return row;
        },
      },
      historyEvent: {
        create: async ({ data }: any) => {
          if (state.history.some((item) => item.id === data.id)) {
            throw Object.assign(new Error("history duplicate"), { code: "P2002" });
          }
          const row = { ...data };
          state.history.push(row);
          return row;
        },
      },
    };
  }

  get room() { return this.#client().room; }
  get transitionJob() { return this.#client().transitionJob; }

  async $transaction<T>(operation: (transaction: any) => Promise<T>) {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const state = {
      rooms: structuredClone(this.rooms),
      jobs: structuredClone(this.jobs),
      aiRuns: structuredClone(this.aiRuns),
      revisions: structuredClone(this.revisions),
      history: structuredClone(this.history),
    };
    try {
      const result = await operation(this.#client(state));
      this.rooms = state.rooms;
      this.jobs = state.jobs;
      this.aiRuns = state.aiRuns;
      this.revisions = state.revisions;
      this.history = state.history;
      return result;
    } finally {
      release();
    }
  }
}

const requirements = defaultRequirementsProfile();
const intent = {
  version: "infrastructure-intent/v1" as const,
  resources: [{ id: "bucket", type: "S3" as const, name: "Uploads", properties: {} }],
  relationships: [],
};
const architecture = {
  version: "architecture/v1" as const,
  requirements,
  resources: [{
    id: "bucket",
    type: "S3" as const,
    name: "Uploads",
    properties: {},
    origin: "explicit" as const,
    reason: "The source explicitly includes an object store.",
    approvalStatus: "not-required" as const,
  }],
  relationships: [],
  decisions: [],
  unresolvedQuestions: [],
};
const analysis = {
  provider: { provider: "anthropic" as const, model: "claude-sonnet-4-5" },
  intent,
  diagnostics: [],
  stageDecision: {
    version: "stage-decision/v1" as const,
    stage: "prototype" as const,
    confidence: "high" as const,
    reasons: ["The bounded workload fits a prototype."],
    requiresApproval: false,
    proposedUpgrades: [],
  },
  deploymentPlan: {
    version: "deployment-plan/v1" as const,
    stage: "prototype" as const,
    requiresApproval: false,
    approvalsSatisfied: true,
    pendingApprovalResourceIds: [],
    pendingApprovalRelationshipIds: [],
    architecture,
  },
};

function setup() {
  const database = new MemoryDatabase();
  let now = new Date("2026-07-21T12:00:00.000Z");
  let sequence = 0;
  const repository = createReconstructionRepository({
    database: database as never,
    leaseOwner: "worker-a",
    primaryProvider: { provider: "openai", model: "gpt-5.6" },
    now: () => now,
    createToken: () => `lease-${++sequence}`,
    createId: () => "revision-1",
  });
  return {
    database,
    repository,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

async function claim(
  setupValue: ReturnType<typeof setup>,
  participantId = "participant-a",
  inputDigest = "digest-a",
) {
  return setupValue.repository.claimAttempt({
    roomId: "room-a",
    jobId: "job-a",
    sourceSnapshotVersion: 7,
    participantId,
    inputDigest,
  });
}

function claimedLease(result: Awaited<ReturnType<typeof claim>>): ReconstructionLease {
  if (result.kind !== "claimed") throw new Error(`Expected claimed, received ${result.kind}`);
  return result.lease;
}

describe("reconstruction repository", () => {
  it("resolves the unique ready transition for an exact source revision", async () => {
    const test = setup();
    test.database.jobs.push({
      ...structuredClone(test.database.jobs[0]),
      id: "job-b",
      sourceRevision: 8,
      traceId: "transition-b",
      createdAt: new Date("2026-07-21T12:01:00.000Z"),
    });

    await expect(test.repository.readBySource("room-a", 7)).resolves.toMatchObject({
      jobId: "job-a",
      sourceSnapshotVersion: 7,
    });
  });

  it("does not replace a fresh running attempt and seeds the real primary identity", async () => {
    const test = setup();
    const first = await claim(test);
    const duplicate = await claim(test, "participant-b", "digest-b");

    expect(first.kind).toBe("claimed");
    expect(duplicate).toMatchObject({ kind: "in_flight", state: "running" });
    expect(test.database.jobs[0]).toMatchObject({
      attempt: 1,
      attemptParticipantId: "participant-a",
      attemptInputDigest: "digest-a",
      activeAiTraceId: "transition-a:attempt:1",
    });
    expect(test.database.aiRuns).toEqual([
      expect.objectContaining({
        traceId: "transition-a:attempt:1",
        task: "reconstruct",
        provider: "openai",
        model: "gpt-5.6",
        status: "running",
      }),
    ]);
  });

  it("reclaims an expired attempt, safely abandons its run, and fences the old token", async () => {
    const test = setup();
    const oldLease = claimedLease(await claim(test));
    test.advance(30_001);
    const newLease = claimedLease(await claim(test, "participant-b", "digest-b"));

    expect(newLease).toMatchObject({ attempt: 2, aiTraceId: "transition-a:attempt:2" });
    expect(test.database.aiRuns[0]).toMatchObject({
      status: "failed",
      errorCode: "AI_ATTEMPT_ABANDONED",
    });
    await expect(test.repository.commitAnalysis(oldLease, analysis)).resolves.toEqual({ kind: "lost" });
    await expect(test.repository.commitAnalysis(newLease, analysis)).resolves.toMatchObject({
      kind: "publishing",
      revision: { id: "revision-1", version: 1 },
    });
  });

  it("renews only a live fenced lease and records selected fallback terminal identity", async () => {
    const test = setup();
    const lease = claimedLease(await claim(test));
    test.advance(10_000);
    const renewed = await test.repository.renewLease(lease);
    expect(renewed.kind).toBe("renewed");
    expect(renewed.kind === "renewed" && renewed.lease.expiresAt.toISOString())
      .toBe("2026-07-21T12:00:40.000Z");

    await expect(test.repository.recordAiTerminal(renewed.kind === "renewed" ? renewed.lease : lease, {
      traceId: lease.aiTraceId,
      task: "reconstruct",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      status: "succeeded",
    })).resolves.toEqual({ kind: "recorded" });
    expect(test.database.aiRuns[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      status: "succeeded",
      finishedAt: expect.any(Date),
    });
  });

  it("commits exactly one revision and deterministic history event", async () => {
    const test = setup();
    const lease = claimedLease(await claim(test));
    const [first, second] = await Promise.all([
      test.repository.commitAnalysis(lease, analysis),
      test.repository.commitAnalysis(lease, analysis),
    ]);

    expect([first.kind, second.kind].sort()).toEqual(["lost", "publishing"]);
    expect(test.database.revisions).toHaveLength(1);
    expect(test.database.history).toEqual([
      expect.objectContaining({
        id: "reconstruction:job-a",
        roomId: "room-a",
        actorType: "participant",
        actorId: "participant-a",
      }),
    ]);
    expect(test.database.jobs[0]).toMatchObject({
      state: "publishing",
      architectureRevisionId: "revision-1",
      result: expect.objectContaining({
        provider: analysis.provider,
        architectureRevisionId: "revision-1",
      }),
    });
  });

  it("returns terminal state without starting another attempt", async () => {
    const test = setup();
    test.database.jobs[0].state = "failed";
    test.database.jobs[0].errorCode = "AI_UNAVAILABLE";
    test.database.jobs[0].finishedAt = new Date();

    await expect(claim(test)).resolves.toMatchObject({
      kind: "terminal",
      state: "failed",
      errorCode: "AI_UNAVAILABLE",
    });
    expect(test.database.aiRuns).toHaveLength(0);
  });

  it("allows one state-specific recovery lease without stealing a fresh owner", async () => {
    const test = setup();
    test.database.jobs[0].state = "publishing";
    test.database.jobs[0].architectureRevisionId = "revision-existing";
    const first = await test.repository.claimRecovery({ jobId: "job-a", work: "publishing" });
    const second = await test.repository.claimRecovery({ jobId: "job-a", work: "publishing" });

    expect(first.kind).toBe("claimed");
    expect(second).toMatchObject({ kind: "in_flight", state: "publishing" });
    expect(test.database.jobs[0].leaseToken).toBe("lease-1");
  });

  it("lists only publishing, pending cleanup, and pending phase mirror work", async () => {
    const test = setup();
    test.database.jobs.push(
      { ...structuredClone(test.database.jobs[0]), id: "job-failed", state: "failed", cleanupCompletedAt: null },
      { ...structuredClone(test.database.jobs[0]), id: "job-success", state: "succeeded", phasePublishedAt: null },
      { ...structuredClone(test.database.jobs[0]), id: "job-done", state: "succeeded", phasePublishedAt: new Date() },
      { ...structuredClone(test.database.jobs[0]), id: "job-running", state: "running" },
    );

    await expect(test.repository.listRecoverable()).resolves.toEqual([
      expect.objectContaining({ jobId: "job-failed", work: "failed_cleanup" }),
      expect.objectContaining({ jobId: "job-success", work: "phase_mirror" }),
    ]);
  });

  it("finishes success, failure cleanup, and phase mirror only under their fences", async () => {
    const success = setup();
    const successLease = claimedLease(await claim(success));
    await success.repository.commitAnalysis(successLease, analysis);
    await expect(success.repository.completeSuccess(successLease)).resolves.toEqual({ kind: "completed" });
    expect(success.database.rooms[0]).toMatchObject({ phase: "architect", currentRevisionId: "revision-1" });
    await expect(success.repository.completePhaseMirror(successLease)).resolves.toEqual({ kind: "completed" });
    expect(success.database.jobs[0]).toMatchObject({ state: "succeeded", phasePublishedAt: expect.any(Date) });

    const failure = setup();
    const failedLease = claimedLease(await claim(failure));
    await failure.repository.recordFailure(failedLease, {
      code: "AI_UNAVAILABLE",
      message: "Architecture reconstruction is temporarily unavailable.",
    }, [{ level: "error", code: "AI_UNAVAILABLE" }]);
    expect(failure.database.rooms[0].phase).toBe("reconstructing");
    await expect(failure.repository.completeFailureCleanup(failedLease)).resolves.toEqual({ kind: "completed" });
    expect(failure.database.rooms[0].phase).toBe("sketch");
    expect(failure.database.jobs[0]).toMatchObject({ cleanupCompletedAt: expect.any(Date) });
  });
});

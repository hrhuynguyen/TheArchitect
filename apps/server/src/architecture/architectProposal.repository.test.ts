import { defaultRequirementsProfile } from "@architect/contracts";
import { describe, expect, it } from "vitest";

import { createArchitectProposalRepository } from "./architectProposal.repository.js";

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const condition = expected as Row;
      if ("lte" in condition && !(actual instanceof Date && actual <= condition.lte)) {
        return false;
      }
      if ("in" in condition && !condition.in.includes(actual)) return false;
      return true;
    }
    return actual === expected;
  });
}

class MemoryDatabase {
  proposals: Row[] = [];
  aiRuns: Row[] = [];
  failAiCreate = false;
  #tail = Promise.resolve();

  #client(state = this) {
    const updateMany = (rows: Row[], input: { where?: Row; data: Row }) => {
      let count = 0;
      for (const row of rows) {
        if (!matches(row, input.where)) continue;
        Object.assign(row, input.data);
        count += 1;
      }
      return { count };
    };
    return {
      architectProposal: {
        findFirst: async ({ where }: any) =>
          state.proposals.find((row) => matches(row, where)) ?? null,
        findUnique: async ({ where }: any) =>
          state.proposals.find((row) => row.id === where.id) ?? null,
        findMany: async ({ where, orderBy, take }: any) => {
          const rows = state.proposals.filter((row) => matches(row, where));
          if (orderBy?.createdAt === "desc") {
            rows.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
          }
          return rows.slice(0, take ?? rows.length);
        },
        create: async ({ data }: any) => {
          if (state.proposals.some((row) =>
            row.roomId === data.roomId &&
            row.actorType === data.actorType &&
            row.actorId === data.actorId &&
            row.idempotencyKey === data.idempotencyKey,
          )) throw Object.assign(new Error("duplicate turn"), { code: "P2002" });
          const timestamp = data.createdAt ?? new Date("2026-07-21T12:00:00.000Z");
          const row = {
            id: data.id,
            ...data,
            createdAt: timestamp,
            updatedAt: timestamp,
            reviewedAt: null,
          };
          state.proposals.push(row);
          return row;
        },
        updateMany: async (input: any) => updateMany(state.proposals, input),
      },
      aiRun: {
        create: async ({ data }: any) => {
          if (this.failAiCreate) throw new Error("ai run unavailable");
          const row = {
            id: `ai-${state.aiRuns.length + 1}`,
            ...data,
            startedAt: data.startedAt ?? new Date("2026-07-21T12:00:00.000Z"),
            finishedAt: null,
            errorCode: null,
          };
          state.aiRuns.push(row);
          return row;
        },
        updateMany: async (input: any) => updateMany(state.aiRuns, input),
      },
    };
  }

  get architectProposal() { return this.#client().architectProposal; }

  async $transaction<T>(operation: (transaction: any) => Promise<T>) {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const state = {
      proposals: structuredClone(this.proposals),
      aiRuns: structuredClone(this.aiRuns),
    };
    try {
      const result = await operation(this.#client(state));
      this.proposals = state.proposals;
      this.aiRuns = state.aiRuns;
      return result;
    } finally {
      release();
    }
  }
}

const sourceProtectedState = {
  architecture: {
    version: "working-architecture/v1" as const,
    revisionId: "revision-a",
    architecture: {
      version: "architecture/v1" as const,
      requirements: defaultRequirementsProfile(),
      resources: [],
      relationships: [],
      decisions: [],
      unresolvedQuestions: [],
    },
  },
  layout: {
    version: "architecture-layout/v1" as const,
    revisionId: "revision-a",
    nodes: [],
  },
};

function createInput(overrides: Row = {}) {
  return {
    id: "turn-a",
    roomId: "room-a",
    baseRevisionId: "revision-a",
    message: "Should this architecture use a queue?",
    actor: { type: "participant" as const, id: "participant-a" },
    idempotencyKey: "turn-request-a",
    sourceSnapshotVersion: 7,
    sourceProtectedDigest:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sourceProtectedState,
    traceId: "architect:turn-a",
    primaryProvider: { provider: "openai" as const, model: "gpt-5.2" },
    ...overrides,
  };
}

const addQueueProposal = {
  kind: "proposal" as const,
  responseText: "I can add an SQS queue for asynchronous order work.",
  operations: [{
    type: "add_resource" as const,
    resource: {
      id: "orders-queue",
      type: "SQS" as const,
      name: "Orders queue",
      zone: "regional" as const,
      properties: { fifo: true },
    },
    reason: "Buffer order work across transient worker failures.",
  }],
};

function setup() {
  const database = new MemoryDatabase();
  const repository = createArchitectProposalRepository({
    database: database as never,
    now: () => new Date("2026-07-21T12:00:00.000Z"),
  });
  return { database, repository };
}

describe("architect proposal repository", () => {
  it("atomically creates one thinking turn and running AI row per idempotency key", async () => {
    const { database, repository } = setup();

    const results = await Promise.all([
      repository.createThinking(createInput()),
      repository.createThinking(createInput({
        id: "turn-duplicate",
        traceId: "architect:turn-duplicate",
      })),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      "created",
      "existing",
    ]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "created",
        turn: expect.objectContaining({
          id: "turn-a",
          state: "thinking",
          operations: [],
        }),
      }),
      expect.objectContaining({
        kind: "existing",
        turn: expect.objectContaining({
          id: "turn-a",
          traceId: "architect:turn-a",
        }),
      }),
    ]));
    expect(database.proposals).toHaveLength(1);
    expect(database.aiRuns).toEqual([
      expect.objectContaining({
        roomId: "room-a",
        traceId: "architect:turn-a",
        task: "architect",
        provider: "openai",
        model: "gpt-5.2",
        status: "running",
      }),
    ]);

    const rollback = setup();
    rollback.database.failAiCreate = true;
    await expect(rollback.repository.createThinking(createInput())).rejects.toThrow(
      "ai run unavailable",
    );
    expect(rollback.database.proposals).toHaveLength(0);
  });

  it("records one AI terminal outcome only while the matching turn is thinking", async () => {
    const { database, repository } = setup();
    await repository.createThinking(createInput());

    await expect(repository.recordAiTerminal("turn-a", {
      traceId: "wrong-trace",
      task: "architect",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      status: "succeeded",
    })).resolves.toEqual({ kind: "lost" });
    await expect(repository.recordAiTerminal("turn-a", {
      traceId: "architect:turn-a",
      task: "architect",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      status: "succeeded",
    })).resolves.toEqual({ kind: "recorded" });
    await expect(repository.recordAiTerminal("turn-a", {
      traceId: "architect:turn-a",
      task: "architect",
      provider: "openai",
      model: "gpt-5.2",
      status: "succeeded",
    })).resolves.toEqual({ kind: "lost" });
    expect(database.aiRuns[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      status: "succeeded",
      finishedAt: expect.any(Date),
    });
  });

  it("completes explanations, proposals, and failures only from thinking", async () => {
    const explanation = setup();
    await explanation.repository.createThinking(createInput());
    await expect(explanation.repository.completeTurn("room-a", "turn-a", {
      kind: "explanation",
      responseText: "A queue is useful when the work can be asynchronous.",
      operations: [],
    })).resolves.toMatchObject({
      kind: "completed",
      turn: { state: "answered", kind: "explanation", operations: [] },
    });
    await expect(explanation.repository.completeTurn(
      "room-a",
      "turn-a",
      addQueueProposal,
    )).resolves.toEqual({ kind: "lost" });

    const proposal = setup();
    await proposal.repository.createThinking(createInput());
    await expect(proposal.repository.completeTurn(
      "room-a",
      "turn-a",
      addQueueProposal,
    )).resolves.toMatchObject({
      kind: "completed",
      turn: { state: "proposal_ready", operations: [{ type: "add_resource" }] },
    });

    const failed = setup();
    await failed.repository.createThinking(createInput());
    await failed.repository.recordAiTerminal("turn-a", {
      traceId: "architect:turn-a",
      task: "architect",
      provider: "openai",
      model: "gpt-5.2",
      status: "succeeded",
    });
    await expect(failed.repository.failTurn("room-a", "turn-a", {
      code: "INVALID_AGENT_PATCH",
      message: "The architect proposed an invalid graph change.",
    })).resolves.toMatchObject({
      kind: "completed",
      turn: { state: "failed", error: { code: "INVALID_AGENT_PATCH" } },
    });
    expect(failed.database.aiRuns[0]).toMatchObject({
      status: "succeeded",
      errorCode: null,
    });
  });

  it("conditionally interrupts stale thinking without replay or repeated mutation", async () => {
    const { database, repository } = setup();
    await repository.createThinking(createInput());
    await repository.createThinking(createInput({
      id: "turn-b",
      idempotencyKey: "turn-request-b",
      traceId: "architect:turn-b",
    }));
    await repository.recordAiTerminal("turn-b", {
      traceId: "architect:turn-b",
      task: "architect",
      provider: "openai",
      model: "gpt-5.2",
      status: "succeeded",
    });
    database.proposals[0].updatedAt = new Date("2026-07-21T11:00:00.000Z");
    database.proposals[1].updatedAt = new Date("2026-07-21T11:00:00.000Z");

    await expect(repository.interruptStaleThinking(
      new Date("2026-07-21T11:59:00.000Z"),
    )).resolves.toEqual({ interrupted: 2 });
    expect(database.proposals[0]).toMatchObject({
      state: "failed",
      errorCode: "TURN_INTERRUPTED",
      operations: [],
    });
    expect(database.aiRuns[0]).toMatchObject({
      status: "failed",
      errorCode: "TURN_INTERRUPTED",
    });
    expect(database.aiRuns[1]).toMatchObject({
      status: "succeeded",
      errorCode: null,
    });
    await expect(repository.interruptStaleThinking(
      new Date("2026-07-21T12:01:00.000Z"),
    )).resolves.toEqual({ interrupted: 0 });
    expect(database.aiRuns).toHaveLength(2);
  });

  it("lists newest first and makes rejection idempotent but terminally exclusive", async () => {
    const { database, repository } = setup();
    await repository.createThinking(createInput());
    await repository.completeTurn("room-a", "turn-a", addQueueProposal);
    database.proposals[0].createdAt = new Date("2026-07-21T12:01:00.000Z");

    await expect(repository.rejectProposal({
      roomId: "room-a",
      proposalId: "turn-a",
      participantId: "participant-a",
      idempotencyKey: "reject-a",
      rationale: "Keep order processing synchronous for this release.",
    })).resolves.toMatchObject({ kind: "rejected", turn: { state: "rejected" } });
    await expect(repository.rejectProposal({
      roomId: "room-a",
      proposalId: "turn-a",
      participantId: "participant-a",
      idempotencyKey: "reject-a",
      rationale: "Keep order processing synchronous for this release.",
    })).resolves.toMatchObject({ kind: "rejected", idempotent: true });
    await expect(repository.rejectProposal({
      roomId: "room-a",
      proposalId: "turn-a",
      participantId: "participant-a",
      idempotencyKey: "reject-b",
      rationale: "A different terminal action must not replace the first.",
    })).resolves.toEqual({ kind: "terminal_conflict", state: "rejected" });
    await expect(repository.listTurns("room-a")).resolves.toMatchObject({
      turns: [{ id: "turn-a", state: "rejected" }],
    });
    await expect(repository.readTurn("room-a", "turn-a")).resolves.toMatchObject({
      id: "turn-a",
      state: "rejected",
    });
    await expect(repository.readTurn("room-b", "turn-a")).resolves.toBeNull();
  });
});

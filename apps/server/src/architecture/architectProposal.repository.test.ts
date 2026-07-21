import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  defaultRequirementsProfile,
  type ReconstructionYjsState,
} from "@architect/contracts";
import { applyArchitectOperations } from "@architect/infra";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { protectedStateDigest } from "./architect.service.js";
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
      if ("not" in condition && actual === condition.not) return false;
      return true;
    }
    return actual === expected;
  });
}

class MemoryDatabase {
  proposals: Row[] = [];
  aiRuns: Row[] = [];
  rooms: Row[] = [{
    id: "room-a",
    phase: "architect",
    currentRevisionId: "revision-a",
  }];
  revisions: Row[] = [];
  snapshots: Row[] = [];
  history: Row[] = [];
  failAiCreate = false;
  failHistory = false;
  #tail = Promise.resolve();

  constructor() {
    this.revisions.push({
      id: "revision-a",
      roomId: "room-a",
      version: 1,
      architecture: sourceProtectedState.architecture.architecture,
      layout: sourceProtectedState.layout,
      requirements: sourceProtectedState.architecture.architecture.requirements,
      stage: "prototype",
      authorType: "participant",
      authorId: "participant-a",
      rationale: "Initial architecture.",
      createdAt: new Date("2026-07-21T11:00:00.000Z"),
    });
    this.snapshots.push({
      id: "snapshot-1",
      roomId: "room-a",
      version: 7,
      payload: snapshotPayload(sourceProtectedState),
      reason: "architecture_fixture",
      createdAt: new Date("2026-07-21T11:00:00.000Z"),
    });
  }

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
        findFirst: async ({ where }: any) =>
          state.aiRuns.find((row) => matches(row, where)) ?? null,
        updateMany: async (input: any) => updateMany(state.aiRuns, input),
      },
      room: {
        findUnique: async ({ where }: any) =>
          state.rooms.find((row) => matches(row, where)) ?? null,
        updateMany: async (input: any) => updateMany(state.rooms, input),
      },
      architectureRevision: {
        findFirst: async ({ where }: any) =>
          state.revisions.find((row) => matches(row, where)) ?? null,
        findUnique: async ({ where }: any) =>
          state.revisions.find((row) => matches(row, where)) ?? null,
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
          const row = {
            ...data,
            createdAt: data.createdAt ?? new Date("2026-07-21T12:00:00.000Z"),
          };
          state.revisions.push(row);
          return row;
        },
      },
      yjsSnapshot: {
        findFirst: async ({ where }: any) => state.snapshots
          .filter((row) => matches(row, where))
          .sort((left, right) => right.version - left.version)[0] ?? null,
        aggregate: async ({ where }: any) => ({
          _max: {
            version: Math.max(
              0,
              ...state.snapshots
                .filter((row) => matches(row, where))
                .map((row) => row.version),
            ) || null,
          },
        }),
        create: async ({ data }: any) => {
          const row = {
            id: `snapshot-${state.snapshots.length + 1}`,
            ...data,
            createdAt: new Date("2026-07-21T12:00:00.000Z"),
          };
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
      },
    };
  }

  get architectProposal() { return this.#client().architectProposal; }
  get room() { return this.#client().room; }
  get architectureRevision() { return this.#client().architectureRevision; }

  async $transaction<T>(operation: (transaction: any) => Promise<T>) {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const state = {
      proposals: structuredClone(this.proposals),
      aiRuns: structuredClone(this.aiRuns),
      rooms: structuredClone(this.rooms),
      revisions: structuredClone(this.revisions),
      snapshots: structuredClone(this.snapshots),
      history: structuredClone(this.history),
    };
    try {
      const result = await operation(this.#client(state));
      this.proposals = state.proposals;
      this.aiRuns = state.aiRuns;
      this.rooms = state.rooms;
      this.revisions = state.revisions;
      this.snapshots = state.snapshots;
      this.history = state.history;
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
      resources: [{
        id: "worker",
        type: "Lambda" as const,
        name: "Order worker",
        properties: {},
        origin: "explicit" as const,
        reason: "Added by a participant.",
        approvalStatus: "not-required" as const,
      }],
      relationships: [],
      decisions: [],
      unresolvedQuestions: [],
    },
  },
  layout: {
    version: "architecture-layout/v1" as const,
    revisionId: "revision-a",
    nodes: [{ resourceId: "worker", x: 10, y: 20 }],
  },
};

function snapshotPayload(state: ReconstructionYjsState) {
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
    return Buffer.from(Y.encodeStateAsUpdate(document));
  } finally {
    document.destroy();
  }
}

function createInput(overrides: Row = {}) {
  return {
    id: "turn-a",
    roomId: "room-a",
    baseRevisionId: "revision-a",
    message: "Should this architecture use a queue?",
    actor: { type: "participant" as const, id: "participant-a" },
    idempotencyKey: "turn-request-a",
    sourceSnapshotVersion: 7,
    sourceProtectedDigest: protectedStateDigest(sourceProtectedState),
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

function candidateState(
  operations = addQueueProposal.operations,
  revisionId = "revision-b",
  destructiveConfirmation?: {
    confirmed: true;
    rationale: string;
  },
) {
  const result = applyArchitectOperations(
    sourceProtectedState.architecture.architecture,
    operations,
    destructiveConfirmation,
  );
  if (!result.ok) throw new Error("invalid architect test proposal");
  const resourceIds = new Set(
    result.architecture.resources.map((resource) => resource.id),
  );
  return {
    architecture: {
      version: "working-architecture/v1" as const,
      revisionId,
      architecture: result.architecture,
    },
    layout: {
      ...sourceProtectedState.layout,
      revisionId,
      nodes: sourceProtectedState.layout.nodes.filter((node) =>
        resourceIds.has(node.resourceId)
      ),
    },
  };
}

function applyInput(overrides: Row = {}) {
  const candidate = candidateState();
  return {
    roomId: "room-a",
    proposalId: "turn-a",
    participantId: "participant-a",
    baseRevisionId: "revision-a",
    idempotencyKey: "apply-request-a",
    rationale: "The queue improves failure isolation.",
    destructiveConfirmation: undefined,
    revisionId: "revision-b",
    revisionEventId: "event-revision-b",
    proposalEventId: "event-proposal-a",
    traceId: "apply:turn-a",
    candidateState: candidate,
    snapshotPayload: snapshotPayload(candidate),
    ...overrides,
  };
}

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
    await repository.createThinking(createInput({
      id: "turn-other-room",
      roomId: "room-b",
      idempotencyKey: "turn-request-other-room",
      traceId: "architect:turn-other-room",
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
    database.proposals[2].updatedAt = new Date("2026-07-21T11:00:00.000Z");

    await expect(repository.heartbeatThinking(
      "room-a",
      "turn-a",
      "architect:turn-a",
    )).resolves.toEqual({ kind: "renewed" });
    await expect(repository.heartbeatThinking(
      "room-a",
      "turn-b",
      "architect:turn-b",
    )).resolves.toEqual({ kind: "lost" });

    await expect(repository.interruptStaleThinking("room-a",
      new Date("2026-07-21T11:59:00.000Z"),
    )).resolves.toEqual({ interrupted: 1 });
    expect(database.proposals[0]).toMatchObject({ state: "thinking" });
    expect(database.proposals[1]).toMatchObject({
      state: "failed",
      errorCode: "TURN_INTERRUPTED",
      operations: [],
    });
    expect(database.proposals[2]).toMatchObject({
      roomId: "room-b",
      state: "thinking",
    });
    expect(database.aiRuns[0]).toMatchObject({
      status: "running",
      errorCode: null,
    });
    expect(database.aiRuns[1]).toMatchObject({
      status: "succeeded",
      errorCode: null,
    });
    await expect(repository.interruptStaleThinking("room-a",
      new Date("2026-07-21T12:01:00.000Z"),
    )).resolves.toEqual({ interrupted: 1 });
    expect(database.proposals[0]).toMatchObject({
      state: "failed",
      errorCode: "TURN_INTERRUPTED",
    });
    expect(database.aiRuns[0]).toMatchObject({
      status: "failed",
      errorCode: "TURN_INTERRUPTED",
    });
    expect(database.aiRuns).toHaveLength(3);
    expect(database.aiRuns[2]).toMatchObject({
      roomId: "room-b",
      status: "running",
    });
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

  it("atomically applies a proposal with a revision, two history events, and snapshot", async () => {
    const { database, repository } = setup();
    await repository.createThinking(createInput());
    await repository.completeTurn("room-a", "turn-a", addQueueProposal);

    await expect(repository.readProposalSource("room-a", "turn-a")).resolves
      .toMatchObject({
        turn: { state: "proposal_ready" },
        sourceProtectedState,
        operations: [{ type: "add_resource" }],
      });
    await expect(repository.applyProposalRevision(applyInput())).resolves
      .toMatchObject({
        kind: "applied",
        idempotent: false,
        turn: { state: "applied", appliedRevisionId: "revision-b" },
        publication: {
          state: {
            architecture: {
              revisionId: "revision-b",
              architecture: {
                resources: [
                  { id: "worker", origin: "explicit" },
                  { id: "orders-queue", origin: "inferred-minimal" },
                ],
              },
            },
          },
        },
      });
    expect(database.rooms[0].currentRevisionId).toBe("revision-b");
    expect(database.revisions).toHaveLength(2);
    expect(database.snapshots).toHaveLength(2);
    expect(database.snapshots[1]).toMatchObject({
      version: 8,
      reason: "architect_proposal:turn-a",
    });
    expect(database.history).toEqual([
      expect.objectContaining({
        id: "event-revision-b",
        kind: "architecture_revision_saved",
      }),
      expect.objectContaining({
        id: "event-proposal-a",
        kind: "architect_proposal_applied",
      }),
    ]);
    for (const event of database.history) {
      expect(event.traceId).toBe("apply:turn-a");
      const serialized = JSON.stringify(event.details);
      expect(serialized).not.toContain("Should this architecture use a queue?");
      expect(serialized).not.toContain(addQueueProposal.responseText);
      expect(serialized).not.toContain("Order worker");
      expect(Object.keys(event.details).sort()).toEqual(
        event.kind === "architecture_revision_saved"
          ? ["baseRevisionId", "proposalId", "revisionId", "version"]
          : [
              "baseRevisionId",
              "destructiveConfirmed",
              "participantId",
              "proposalId",
              "revisionId",
            ],
      );
    }

    database.rooms[0].phase = "deploy";
    await expect(repository.applyProposalRevision(applyInput({
      baseRevisionId: "changed-retry-body",
    }))).resolves
      .toMatchObject({ kind: "applied", idempotent: true });
    expect(database.revisions).toHaveLength(2);
    expect(database.snapshots).toHaveLength(2);
    expect(database.history).toHaveLength(2);
  });

  it("rejects stale revisions and same-revision protected-state changes with zero writes", async () => {
    const stale = setup();
    await stale.repository.createThinking(createInput());
    await stale.repository.completeTurn("room-a", "turn-a", addQueueProposal);
    stale.database.rooms[0].currentRevisionId = "revision-newer";
    await expect(stale.repository.applyProposalRevision(applyInput())).resolves
      .toEqual({ kind: "stale", currentRevisionId: "revision-newer" });
    expect(stale.database.proposals[0].state).toBe("proposal_ready");
    expect(stale.database.revisions).toHaveLength(1);
    expect(stale.database.snapshots).toHaveLength(1);
    expect(stale.database.history).toHaveLength(0);

    const working = setup();
    await working.repository.createThinking(createInput());
    await working.repository.completeTurn("room-a", "turn-a", addQueueProposal);
    const changed = structuredClone(sourceProtectedState);
    changed.architecture.architecture.resources[0]!.name = "Manually renamed worker";
    working.database.snapshots.push({
      id: "snapshot-2",
      roomId: "room-a",
      version: 8,
      payload: snapshotPayload(changed),
      reason: "architecture_operations",
      createdAt: new Date("2026-07-21T11:30:00.000Z"),
    });
    await expect(working.repository.applyProposalRevision(applyInput())).resolves
      .toEqual({ kind: "working_conflict" });
    expect(working.database.proposals[0].state).toBe("proposal_ready");
    expect(working.database.revisions).toHaveLength(1);
    expect(working.database.snapshots).toHaveLength(2);
    expect(working.database.history).toHaveLength(0);
  });

  it("requires human confirmation for destructive proposals and rolls back every write on failure", async () => {
    const destructive = setup();
    await destructive.repository.createThinking(createInput());
    await destructive.repository.completeTurn("room-a", "turn-a", {
      kind: "proposal",
      responseText: "I can remove the order worker.",
      operations: [{
        type: "remove_resource",
        resourceId: "worker",
        reason: "The worker is no longer part of the requested design.",
      }],
    });
    await expect(destructive.repository.applyProposalRevision(applyInput()))
      .resolves.toEqual({ kind: "destructive_confirmation_required" });
    expect(destructive.database.proposals[0].state).toBe("proposal_ready");
    expect(destructive.database.revisions).toHaveLength(1);
    const removalOperations = [{
      type: "remove_resource" as const,
      resourceId: "worker",
      reason: "The worker is no longer part of the requested design.",
    }];
    const destructiveConfirmation = {
      confirmed: true as const,
      rationale: "I reviewed and approve removal of the obsolete worker.",
    };
    const removalCandidate = candidateState(
      removalOperations,
      "revision-b",
      destructiveConfirmation,
    );
    await expect(destructive.repository.applyProposalRevision(applyInput({
      candidateState: removalCandidate,
      snapshotPayload: snapshotPayload(removalCandidate),
      destructiveConfirmation,
    }))).resolves.toMatchObject({ kind: "applied", idempotent: false });
    expect(destructive.database.proposals[0]).toMatchObject({
      destructiveConfirmed: true,
      destructiveConfirmationRationale:
        "I reviewed and approve removal of the obsolete worker.",
    });
    expect(destructive.database.history[1].details).toMatchObject({
      destructiveConfirmed: true,
    });

    const rollback = setup();
    await rollback.repository.createThinking(createInput());
    await rollback.repository.completeTurn("room-a", "turn-a", addQueueProposal);
    rollback.database.failHistory = true;
    await expect(rollback.repository.applyProposalRevision(applyInput()))
      .rejects.toThrow("history unavailable");
    expect(rollback.database.rooms[0].currentRevisionId).toBe("revision-a");
    expect(rollback.database.proposals[0].state).toBe("proposal_ready");
    expect(rollback.database.revisions).toHaveLength(1);
    expect(rollback.database.snapshots).toHaveLength(1);
    expect(rollback.database.history).toHaveLength(0);
  });

  it("rejects caller candidates, snapshots, and bases that differ from the reviewed proposal", async () => {
    const maliciousCandidate = setup();
    await maliciousCandidate.repository.createThinking(createInput());
    await maliciousCandidate.repository.completeTurn(
      "room-a",
      "turn-a",
      addQueueProposal,
    );
    const injected = candidateState();
    injected.architecture.architecture.resources[1]!.name =
      "Unreviewed privileged queue";
    await expect(maliciousCandidate.repository.applyProposalRevision({
      ...applyInput(),
      candidateState: injected,
      snapshotPayload: snapshotPayload(injected),
    })).resolves.toEqual({ kind: "invalid_candidate" });
    expect(maliciousCandidate.database.rooms[0].currentRevisionId).toBe("revision-a");
    expect(maliciousCandidate.database.revisions).toHaveLength(1);
    expect(maliciousCandidate.database.history).toHaveLength(0);

    const mismatchedSnapshot = setup();
    await mismatchedSnapshot.repository.createThinking(createInput());
    await mismatchedSnapshot.repository.completeTurn(
      "room-a",
      "turn-a",
      addQueueProposal,
    );
    await expect(mismatchedSnapshot.repository.applyProposalRevision({
      ...applyInput(),
      snapshotPayload: snapshotPayload(sourceProtectedState),
    })).resolves.toEqual({ kind: "invalid_candidate" });
    expect(mismatchedSnapshot.database.revisions).toHaveLength(1);
    expect(mismatchedSnapshot.database.snapshots).toHaveLength(1);

    const malformedSnapshot = setup();
    await malformedSnapshot.repository.createThinking(createInput());
    await malformedSnapshot.repository.completeTurn(
      "room-a",
      "turn-a",
      addQueueProposal,
    );
    await expect(malformedSnapshot.repository.applyProposalRevision({
      ...applyInput(),
      snapshotPayload: new Uint8Array([255, 0, 17]),
    })).resolves.toEqual({ kind: "invalid_candidate" });
    expect(malformedSnapshot.database.revisions).toHaveLength(1);
    expect(malformedSnapshot.database.history).toHaveLength(0);

    const mismatchedBase = setup();
    await mismatchedBase.repository.createThinking(createInput());
    await mismatchedBase.repository.completeTurn(
      "room-a",
      "turn-a",
      addQueueProposal,
    );
    await expect(mismatchedBase.repository.applyProposalRevision({
      ...applyInput(),
      baseRevisionId: "revision-client-other",
    })).resolves.toEqual({ kind: "stale", currentRevisionId: "revision-a" });
    expect(mismatchedBase.database.proposals[0].state).toBe("proposal_ready");
    expect(mismatchedBase.database.revisions).toHaveLength(1);
    expect(mismatchedBase.database.history).toHaveLength(0);
  });

  it("fences apply/reject races and review idempotency keys across proposals", async () => {
    const applyWins = setup();
    await applyWins.repository.createThinking(createInput());
    await applyWins.repository.completeTurn("room-a", "turn-a", addQueueProposal);
    const [applied, rejected] = await Promise.all([
      applyWins.repository.applyProposalRevision(applyInput()),
      applyWins.repository.rejectProposal({
        roomId: "room-a",
        proposalId: "turn-a",
        participantId: "participant-a",
        idempotencyKey: "reject-race",
        rationale: "Reject concurrently.",
      }),
    ]);
    expect(applied).toMatchObject({ kind: "applied" });
    expect(rejected).toEqual({ kind: "terminal_conflict", state: "applied" });
    expect(applyWins.database.revisions).toHaveLength(2);
    expect(applyWins.database.history).toHaveLength(2);

    const rejectWins = setup();
    await rejectWins.repository.createThinking(createInput());
    await rejectWins.repository.completeTurn("room-a", "turn-a", addQueueProposal);
    await rejectWins.repository.rejectProposal({
      roomId: "room-a",
      proposalId: "turn-a",
      participantId: "participant-a",
      idempotencyKey: "reject-wins",
      rationale: "Reject before apply.",
    });
    await expect(rejectWins.repository.applyProposalRevision(applyInput()))
      .resolves.toEqual({ kind: "terminal_conflict", state: "rejected" });
    expect(rejectWins.database.revisions).toHaveLength(1);
    expect(rejectWins.database.history).toHaveLength(0);

    await rejectWins.repository.createThinking(createInput({
      id: "turn-b",
      idempotencyKey: "turn-request-b",
      traceId: "architect:turn-b",
    }));
    await rejectWins.repository.completeTurn("room-a", "turn-b", addQueueProposal);
    await expect(rejectWins.repository.rejectProposal({
      roomId: "room-a",
      proposalId: "turn-b",
      participantId: "participant-a",
      idempotencyKey: "reject-wins",
      rationale: "Reusing a review key is not a new action.",
    })).resolves.toEqual({ kind: "idempotency_conflict" });
    expect(rejectWins.database.proposals[1].state).toBe("proposal_ready");

    const applyKey = setup();
    await applyKey.repository.createThinking(createInput());
    await applyKey.repository.completeTurn("room-a", "turn-a", addQueueProposal);
    await applyKey.repository.applyProposalRevision(applyInput());
    await applyKey.repository.createThinking(createInput({
      id: "turn-b",
      idempotencyKey: "turn-request-b",
      traceId: "architect:turn-b",
    }));
    await applyKey.repository.completeTurn("room-a", "turn-b", addQueueProposal);
    await expect(applyKey.repository.applyProposalRevision(applyInput({
      proposalId: "turn-b",
      revisionId: "revision-c",
      revisionEventId: "event-revision-c",
      proposalEventId: "event-proposal-b",
    }))).resolves.toEqual({ kind: "idempotency_conflict" });
    expect(applyKey.database.proposals[1].state).toBe("proposal_ready");
    expect(applyKey.database.revisions).toHaveLength(2);
    expect(applyKey.database.history).toHaveLength(2);
  });
});

import {
  ArchitectOperationSchema,
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  ArchitectProviderOutputSchema,
  ArchitectTurnListSchema,
  ArchitectTurnSchema,
  ArchitectureLayoutSchema,
  ArchitectureSchema,
  ReconstructionYjsStateSchema,
  DestructiveConfirmationSchema,
  architectTurnErrorSchema,
  type ArchitectProviderOutput,
  type ArchitectOperation,
  type ArchitectTurn,
  type ArchitectTurnError,
  type DestructiveConfirmation,
  type ReconstructionYjsState,
} from "@architect/contracts";
import { applyArchitectOperations } from "@architect/infra";
import {
  Prisma,
  type ArchitectProposal,
  type PrismaClient,
} from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";

import type {
  AiRunTerminalMetadata,
  ProviderIdentity,
} from "../ai/provider.js";
import { protectedStateDigest } from "./protected-state.js";

const TRANSACTION_RETRIES = 3;
const INTERRUPTED_MESSAGE =
  "The architect turn was interrupted. Submit a new request to retry.";

type ArchitectDatabase = Pick<
  PrismaClient,
  | "$transaction"
  | "architectProposal"
  | "room"
  | "architectureRevision"
  | "yjsSnapshot"
  | "historyEvent"
>;

export type ArchitectActor = Readonly<{
  type: "participant" | "owner";
  id: string;
}>;

export type CreateThinkingInput = Readonly<{
  id: string;
  roomId: string;
  baseRevisionId: string;
  message: string;
  actor: ArchitectActor;
  idempotencyKey: string;
  sourceSnapshotVersion: number;
  sourceProtectedDigest: string;
  sourceProtectedState: ReconstructionYjsState;
  traceId: string;
  primaryProvider: ProviderIdentity;
}>;

export type RejectProposalInput = Readonly<{
  roomId: string;
  proposalId: string;
  participantId: string;
  idempotencyKey: string;
  rationale: string;
}>;

export type ApplyProposalRevisionInput = Readonly<{
  roomId: string;
  proposalId: string;
  participantId: string;
  baseRevisionId: string;
  idempotencyKey: string;
  rationale: string;
  destructiveConfirmation?: DestructiveConfirmation;
  revisionId: string;
  revisionEventId: string;
  proposalEventId: string;
  traceId: string;
  candidateState: ReconstructionYjsState;
  snapshotPayload: Uint8Array;
}>;

class ApplyRollbackError extends Error {
  constructor(readonly result: Readonly<{ kind: "stale_after_claim" | "proposal_lost" }>) {
    super(result.kind);
    this.name = "ApplyRollbackError";
  }
}

function isRetryable(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ((error as { code?: unknown }).code === "P2034" ||
        (error as { code?: unknown }).code === "P2002"),
  );
}

function publicTurn(row: ArchitectProposal): ArchitectTurn {
  const failedError = row.state === "failed"
    ? architectTurnErrorSchema.parse({
        code: row.errorCode,
        message: row.errorMessage,
      })
    : null;
  return ArchitectTurnSchema.parse({
    id: row.id,
    roomId: row.roomId,
    baseRevisionId: row.baseRevisionId,
    message: row.message,
    actorType: row.actorType,
    actorId: row.actorId,
    idempotencyKey: row.idempotencyKey,
    sourceSnapshotVersion: row.sourceSnapshotVersion,
    sourceProtectedDigest: row.sourceProtectedDigest,
    traceId: row.traceId,
    state: row.state,
    kind: row.kind,
    responseText: row.responseText,
    operations: row.operations,
    appliedRevisionId: row.appliedRevisionId,
    error: failedError,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewedByParticipantId: row.reviewedByParticipantId,
    reviewRationale: row.reviewRationale,
  });
}

function sourceState(row: ArchitectProposal): ReconstructionYjsState {
  return ReconstructionYjsStateSchema.parse(row.sourceProtectedState);
}

function proposalOperations(row: ArchitectProposal): ArchitectOperation[] {
  return ArchitectOperationSchema.array().min(1).max(200).parse(row.operations);
}

function protectedStateFromSnapshot(
  snapshot: Readonly<{ payload: Uint8Array }> | null,
): ReconstructionYjsState | null {
  if (!snapshot) return null;
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, new Uint8Array(snapshot.payload));
    return ReconstructionYjsStateSchema.parse({
      architecture: document
        .getMap(ARCHITECTURE_MAP_KEY)
        .get(ARCHITECTURE_CURRENT_KEY),
      layout: document
        .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
        .get(ARCHITECTURE_CURRENT_KEY),
    });
  } catch {
    return null;
  } finally {
    document.destroy();
  }
}

function publicationState(row: Readonly<{
  id: string;
  architecture: Prisma.JsonValue;
  layout: Prisma.JsonValue;
}>): ReconstructionYjsState {
  return ReconstructionYjsStateSchema.parse({
    architecture: {
      version: "working-architecture/v1",
      revisionId: row.id,
      architecture: ArchitectureSchema.parse(row.architecture),
    },
    layout: ArchitectureLayoutSchema.parse(row.layout),
  });
}

export function createArchitectProposalRepository({
  database,
  now = () => new Date(),
}: Readonly<{
  database: ArchitectDatabase;
  now?: () => Date;
}>) {
  const transaction = async <T>(
    operation: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < TRANSACTION_RETRIES; attempt += 1) {
      try {
        return await database.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === TRANSACTION_RETRIES - 1) {
          throw error;
        }
      }
    }
    throw lastError;
  };

  const createThinking = async (input: CreateThinkingInput) => {
    const sourceProtectedState = ReconstructionYjsStateSchema.parse(
      input.sourceProtectedState,
    );
    return transaction(async (client) => {
      const existing = await client.architectProposal.findFirst({
        where: {
          roomId: input.roomId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (existing) {
        return Object.freeze({
          kind: "existing" as const,
          turn: publicTurn(existing),
        });
      }

      const createdAt = now();
      const proposal = await client.architectProposal.create({
        data: {
          id: input.id,
          roomId: input.roomId,
          baseRevisionId: input.baseRevisionId,
          message: input.message,
          kind: null,
          actorType: input.actor.type,
          actorId: input.actor.id,
          idempotencyKey: input.idempotencyKey,
          sourceSnapshotVersion: input.sourceSnapshotVersion,
          sourceProtectedDigest: input.sourceProtectedDigest,
          sourceProtectedState: sourceProtectedState as Prisma.InputJsonValue,
          operations: [],
          responseText: null,
          state: "thinking",
          traceId: input.traceId,
          appliedRevisionId: null,
          errorCode: null,
          errorMessage: null,
          reviewIdempotencyKey: null,
          reviewedByParticipantId: null,
          reviewRationale: null,
          destructiveConfirmed: false,
          destructiveConfirmationRationale: null,
          createdAt,
          updatedAt: createdAt,
          reviewedAt: null,
        },
      });
      await client.aiRun.create({
        data: {
          roomId: input.roomId,
          traceId: input.traceId,
          task: "architect",
          provider: input.primaryProvider.provider,
          model: input.primaryProvider.model,
          status: "running",
          startedAt: createdAt,
        },
      });
      return Object.freeze({
        kind: "created" as const,
        turn: publicTurn(proposal),
      });
    });
  };

  const recordAiTerminal = async (
    turnId: string,
    metadata: AiRunTerminalMetadata,
  ) => transaction(async (client) => {
    if (metadata.task !== "architect") return { kind: "lost" } as const;
    const turn = await client.architectProposal.findFirst({
      where: {
        id: turnId,
        traceId: metadata.traceId,
        state: "thinking",
      },
      select: { id: true },
    });
    if (!turn) return { kind: "lost" } as const;
    const recorded = await client.aiRun.updateMany({
      where: {
        traceId: metadata.traceId,
        task: "architect",
        status: "running",
      },
      data: {
        provider: metadata.provider,
        model: metadata.model,
        status: metadata.status,
        errorCode: metadata.errorCode ?? null,
        finishedAt: now(),
      },
    });
    return recorded.count === 1
      ? { kind: "recorded" } as const
      : { kind: "lost" } as const;
  });

  const completeTurn = async (
    roomId: string,
    turnId: string,
    outputInput: ArchitectProviderOutput,
  ) => {
    const output = ArchitectProviderOutputSchema.parse(outputInput);
    return transaction(async (client) => {
      const completedAt = now();
      const completed = await client.architectProposal.updateMany({
        where: { id: turnId, roomId, state: "thinking" },
        data: {
          state: output.kind === "explanation" ? "answered" : "proposal_ready",
          kind: output.kind,
          responseText: output.responseText,
          operations: output.operations as Prisma.InputJsonValue,
          errorCode: null,
          errorMessage: null,
          updatedAt: completedAt,
        },
      });
      if (completed.count !== 1) return { kind: "lost" } as const;
      const row = await client.architectProposal.findUnique({
        where: { id: turnId },
      });
      if (!row) return { kind: "lost" } as const;
      return Object.freeze({
        kind: "completed" as const,
        turn: publicTurn(row),
      });
    });
  };

  const failTurn = async (
    roomId: string,
    turnId: string,
    errorInput: ArchitectTurnError,
  ) => {
    const error = architectTurnErrorSchema.parse(errorInput);
    return transaction(async (client) => {
      const failedAt = now();
      const row = await client.architectProposal.findFirst({
        where: { id: turnId, roomId, state: "thinking" },
      });
      if (!row) return { kind: "lost" } as const;
      const failed = await client.architectProposal.updateMany({
        where: { id: row.id, roomId, state: "thinking" },
        data: {
          state: "failed",
          kind: null,
          responseText: null,
          operations: [],
          errorCode: error.code,
          errorMessage: error.message,
          updatedAt: failedAt,
        },
      });
      if (failed.count !== 1) return { kind: "lost" } as const;
      await client.aiRun.updateMany({
        where: { traceId: row.traceId, task: "architect", status: "running" },
        data: {
          status: "failed",
          errorCode: error.code,
          finishedAt: failedAt,
        },
      });
      const terminal = await client.architectProposal.findUnique({
        where: { id: row.id },
      });
      if (!terminal) return { kind: "lost" } as const;
      return Object.freeze({
        kind: "completed" as const,
        turn: publicTurn(terminal),
      });
    });
  };

  const heartbeatThinking = async (
    roomId: string,
    turnId: string,
    traceId: string,
  ) => transaction(async (client) => {
    const running = await client.aiRun.findFirst({
      where: { roomId, traceId, task: "architect", status: "running" },
      select: { id: true },
    });
    if (!running) return { kind: "lost" } as const;
    const heartbeat = await client.architectProposal.updateMany({
      where: { id: turnId, roomId, traceId, state: "thinking" },
      data: { updatedAt: now() },
    });
    return heartbeat.count === 1
      ? { kind: "renewed" } as const
      : { kind: "lost" } as const;
  });

  const interruptStaleThinking = async (roomId: string, cutoff: Date) =>
    transaction(async (client) => {
      const interruptedAt = now();
      const stale = await client.architectProposal.findMany({
        where: { roomId, state: "thinking", updatedAt: { lte: cutoff } },
        take: 500,
      });
      let interrupted = 0;
      for (const row of stale) {
        const failed = await client.architectProposal.updateMany({
          where: {
            id: row.id,
            roomId,
            state: "thinking",
            updatedAt: { lte: cutoff },
          },
          data: {
            state: "failed",
            kind: null,
            responseText: null,
            operations: [],
            errorCode: "TURN_INTERRUPTED",
            errorMessage: INTERRUPTED_MESSAGE,
            updatedAt: interruptedAt,
          },
        });
        if (failed.count !== 1) continue;
        interrupted += 1;
        await client.aiRun.updateMany({
          where: {
            traceId: row.traceId,
            task: "architect",
            status: "running",
          },
          data: {
            status: "failed",
            errorCode: "TURN_INTERRUPTED",
            finishedAt: interruptedAt,
          },
        });
      }
      return Object.freeze({ interrupted });
    });

  const listTurns = async (roomId: string) => {
    const rows = await database.architectProposal.findMany({
      where: { roomId },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return ArchitectTurnListSchema.parse({ turns: rows.map(publicTurn) });
  };

  const readTurn = async (roomId: string, turnId: string) => {
    const row = await database.architectProposal.findFirst({
      where: { id: turnId, roomId },
    });
    return row ? publicTurn(row) : null;
  };

  const readProposalSource = async (roomId: string, proposalId: string) => {
    const row = await database.architectProposal.findFirst({
      where: { id: proposalId, roomId },
    });
    if (!row) return null;
    const turn = publicTurn(row);
    if (turn.kind !== "proposal") {
      return Object.freeze({ turn, sourceProtectedState: null, operations: [] });
    }
    return Object.freeze({
      turn,
      sourceProtectedState: sourceState(row),
      operations: proposalOperations(row),
    });
  };

  const appliedPublication = async (
    client: Pick<Prisma.TransactionClient, "architectureRevision">,
    row: ArchitectProposal,
    idempotent: boolean,
  ) => {
    if (!row.appliedRevisionId) return null;
    const revision = await client.architectureRevision.findFirst({
      where: { id: row.appliedRevisionId, roomId: row.roomId },
    });
    if (!revision) return null;
    return Object.freeze({
      kind: "applied" as const,
      idempotent,
      turn: publicTurn(row),
      publication: Object.freeze({ state: publicationState(revision) }),
    });
  };

  const applyProposalRevision = async (input: ApplyProposalRevisionInput) => {
    try {
      return await transaction(async (client) => {
        const row = await client.architectProposal.findFirst({
          where: { id: input.proposalId, roomId: input.roomId },
        });
        if (!row) return { kind: "not_found" } as const;

        if (
          row.state === "applied" &&
          row.reviewedByParticipantId === input.participantId &&
          row.reviewIdempotencyKey === input.idempotencyKey
        ) {
          return (await appliedPublication(client, row, true)) ??
            { kind: "not_found" as const };
        }
        const idempotencyOwner = await client.architectProposal.findFirst({
          where: {
            roomId: input.roomId,
            reviewedByParticipantId: input.participantId,
            reviewIdempotencyKey: input.idempotencyKey,
          },
          select: { id: true },
        });
        if (idempotencyOwner && idempotencyOwner.id !== row.id) {
          return { kind: "idempotency_conflict" } as const;
        }
        if (input.baseRevisionId !== row.baseRevisionId) {
          const room = await client.room.findUnique({
            where: { id: input.roomId },
            select: { currentRevisionId: true },
          });
          return {
            kind: "stale" as const,
            currentRevisionId: room?.currentRevisionId ?? null,
          };
        }
        const candidate = ReconstructionYjsStateSchema.safeParse(
          input.candidateState,
        );
        const traceValid = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
          input.traceId,
        );
        if (!candidate.success || !traceValid) {
          return { kind: "invalid_candidate" } as const;
        }
        const room = await client.room.findUnique({
          where: { id: input.roomId },
          select: { id: true, phase: true, currentRevisionId: true },
        });
        if (!room || room.phase !== "architect") {
          return { kind: "not_found" } as const;
        }
        if (room.currentRevisionId !== row.baseRevisionId) {
          return {
            kind: "stale" as const,
            currentRevisionId: room.currentRevisionId,
          };
        }
        if (row.state !== "proposal_ready") {
          return {
            kind: "terminal_conflict" as const,
            state: row.state,
          };
        }

        const source = sourceState(row);
        if (
          row.sourceProtectedDigest !== protectedStateDigest(source) ||
          source.architecture.revisionId !== row.baseRevisionId
        ) return { kind: "invalid_candidate" } as const;
        const operations = proposalOperations(row);
        const destructive = operations.some((operation) =>
          operation.type === "remove_resource" ||
          operation.type === "remove_relationship"
        );
        const checked = applyArchitectOperations(
          source.architecture.architecture,
          operations,
          input.destructiveConfirmation,
        );
        if (!checked.ok) {
          return checked.diagnostics.some((diagnostic) =>
              diagnostic.code === "ARCHITECT_DESTRUCTIVE_CONFIRMATION_REQUIRED"
            )
            ? { kind: "destructive_confirmation_required" as const }
            : { kind: "invalid_candidate" as const };
        }
        const destructiveConfirmation = destructive
          ? DestructiveConfirmationSchema.parse(input.destructiveConfirmation)
          : null;
        const resourceIds = new Set(
          checked.architecture.resources.map((resource) => resource.id),
        );
        const expectedCandidate = ReconstructionYjsStateSchema.parse({
          architecture: {
            version: "working-architecture/v1",
            revisionId: input.revisionId,
            architecture: checked.architecture,
          },
          layout: {
            ...source.layout,
            revisionId: input.revisionId,
            nodes: source.layout.nodes.filter((node) =>
              resourceIds.has(node.resourceId)
            ),
          },
        });
        const candidateFromSnapshot = protectedStateFromSnapshot({
          payload: input.snapshotPayload,
        });
        if (
          !isDeepStrictEqual(candidate.data, expectedCandidate) ||
          !isDeepStrictEqual(candidateFromSnapshot, expectedCandidate)
        ) return { kind: "invalid_candidate" } as const;

        const latestSnapshot = await client.yjsSnapshot.findFirst({
          where: { roomId: input.roomId },
          orderBy: { version: "desc" },
          select: { payload: true },
        });
        const latestProtectedState = protectedStateFromSnapshot(latestSnapshot);
        if (
          !latestProtectedState ||
          protectedStateDigest(latestProtectedState) !==
            row.sourceProtectedDigest ||
          !isDeepStrictEqual(latestProtectedState, source)
        ) return { kind: "working_conflict" } as const;

        const baseRevision = await client.architectureRevision.findFirst({
          where: { id: row.baseRevisionId, roomId: input.roomId },
          select: { id: true, stage: true },
        });
        if (!baseRevision) return { kind: "not_found" } as const;
        const revisionVersion =
          ((await client.architectureRevision.aggregate({
            where: { roomId: input.roomId },
            _max: { version: true },
          }))._max.version ?? 0) + 1;
        const snapshotVersion =
          ((await client.yjsSnapshot.aggregate({
            where: { roomId: input.roomId },
            _max: { version: true },
          }))._max.version ?? 0) + 1;

        const claimed = await client.architectProposal.updateMany({
          where: {
            id: row.id,
            roomId: input.roomId,
            state: "proposal_ready",
            appliedRevisionId: null,
          },
          data: { state: "applying", updatedAt: now() },
        });
        if (claimed.count !== 1) {
          throw new ApplyRollbackError({ kind: "proposal_lost" });
        }
        const roomFenced = await client.room.updateMany({
          where: {
            id: input.roomId,
            phase: "architect",
            currentRevisionId: row.baseRevisionId,
          },
          data: { currentRevisionId: input.revisionId },
        });
        if (roomFenced.count !== 1) {
          throw new ApplyRollbackError({ kind: "stale_after_claim" });
        }

        await client.architectureRevision.create({
          data: {
            id: input.revisionId,
            roomId: input.roomId,
            version: revisionVersion,
            architecture: expectedCandidate.architecture
              .architecture as Prisma.InputJsonValue,
            layout: expectedCandidate.layout as Prisma.InputJsonValue,
            requirements: expectedCandidate.architecture.architecture
              .requirements as Prisma.InputJsonValue,
            stage: baseRevision.stage,
            authorType: "participant",
            authorId: input.participantId,
            rationale: input.rationale,
          },
        });
        await client.historyEvent.create({
          data: {
            id: input.revisionEventId,
            roomId: input.roomId,
            kind: "architecture_revision_saved",
            status: "succeeded",
            actorType: "participant",
            actorId: input.participantId,
            title: "Architecture revision saved",
            summary: input.rationale,
            details: {
              proposalId: row.id,
              revisionId: input.revisionId,
              baseRevisionId: row.baseRevisionId,
              version: revisionVersion,
            },
            traceId: input.traceId,
          },
        });
        await client.historyEvent.create({
          data: {
            id: input.proposalEventId,
            roomId: input.roomId,
            kind: "architect_proposal_applied",
            status: "succeeded",
            actorType: "participant",
            actorId: input.participantId,
            title: "Architect proposal applied",
            summary: input.rationale,
            details: {
              proposalId: row.id,
              revisionId: input.revisionId,
              baseRevisionId: row.baseRevisionId,
              participantId: input.participantId,
              destructiveConfirmed: destructive,
            },
            traceId: input.traceId,
          },
        });
        await client.yjsSnapshot.create({
          data: {
            roomId: input.roomId,
            version: snapshotVersion,
            payload: Buffer.from(input.snapshotPayload),
            reason: `architect_proposal:${row.id}`,
          },
        });
        const reviewedAt = now();
        const applied = await client.architectProposal.updateMany({
          where: {
            id: row.id,
            roomId: input.roomId,
            state: "applying",
            appliedRevisionId: null,
          },
          data: {
            state: "applied",
            appliedRevisionId: input.revisionId,
            reviewIdempotencyKey: input.idempotencyKey,
            reviewedByParticipantId: input.participantId,
            reviewRationale: input.rationale,
            destructiveConfirmed: destructive,
            destructiveConfirmationRationale:
              destructiveConfirmation?.rationale ?? null,
            reviewedAt,
            updatedAt: reviewedAt,
          },
        });
        if (applied.count !== 1) {
          throw new ApplyRollbackError({ kind: "proposal_lost" });
        }
        const terminal = await client.architectProposal.findUnique({
          where: { id: row.id },
        });
        if (!terminal) throw new ApplyRollbackError({ kind: "proposal_lost" });
        return (await appliedPublication(client, terminal, false)) ??
          { kind: "not_found" as const };
      });
    } catch (error) {
      if (!(error instanceof ApplyRollbackError)) throw error;
      if (error.result.kind === "stale_after_claim") {
        const room = await database.room.findUnique({
          where: { id: input.roomId },
          select: { currentRevisionId: true },
        });
        return {
          kind: "stale" as const,
          currentRevisionId: room?.currentRevisionId ?? null,
        };
      }
      const row = await database.architectProposal.findFirst({
        where: { id: input.proposalId, roomId: input.roomId },
      });
      if (
        row?.state === "applied" &&
        row.reviewedByParticipantId === input.participantId &&
        row.reviewIdempotencyKey === input.idempotencyKey
      ) {
        return (await appliedPublication(database, row, true)) ??
          { kind: "not_found" as const };
      }
      return {
        kind: "terminal_conflict" as const,
        state: row?.state ?? "missing",
      };
    }
  };

  const rejectProposal = async (input: RejectProposalInput) =>
    transaction(async (client) => {
      const row = await client.architectProposal.findFirst({
        where: { id: input.proposalId, roomId: input.roomId },
      });
      if (!row) return { kind: "not_found" } as const;
      const idempotencyOwner = await client.architectProposal.findFirst({
        where: {
          roomId: input.roomId,
          reviewedByParticipantId: input.participantId,
          reviewIdempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      });
      if (idempotencyOwner && idempotencyOwner.id !== row.id) {
        return { kind: "idempotency_conflict" } as const;
      }
      if (
        row.state === "rejected" &&
        row.reviewedByParticipantId === input.participantId &&
        row.reviewIdempotencyKey === input.idempotencyKey
      ) {
        return Object.freeze({
          kind: "rejected" as const,
          idempotent: true as const,
          turn: publicTurn(row),
        });
      }
      if (row.state !== "proposal_ready") {
        return Object.freeze({
          kind: "terminal_conflict" as const,
          state: row.state,
        });
      }
      const reviewedAt = now();
      const rejected = await client.architectProposal.updateMany({
        where: { id: row.id, roomId: input.roomId, state: "proposal_ready" },
        data: {
          state: "rejected",
          reviewIdempotencyKey: input.idempotencyKey,
          reviewedByParticipantId: input.participantId,
          reviewRationale: input.rationale,
          reviewedAt,
          updatedAt: reviewedAt,
        },
      });
      if (rejected.count !== 1) {
        return { kind: "terminal_conflict", state: row.state } as const;
      }
      const terminal = await client.architectProposal.findUnique({
        where: { id: row.id },
      });
      if (!terminal) return { kind: "not_found" } as const;
      return Object.freeze({
        kind: "rejected" as const,
        idempotent: false as const,
        turn: publicTurn(terminal),
      });
    });

  return Object.freeze({
    createThinking,
    recordAiTerminal,
    completeTurn,
    failTurn,
    heartbeatThinking,
    interruptStaleThinking,
    readTurn,
    readProposalSource,
    applyProposalRevision,
    listTurns,
    rejectProposal,
  });
}

export type ArchitectProposalRepository = ReturnType<
  typeof createArchitectProposalRepository
>;

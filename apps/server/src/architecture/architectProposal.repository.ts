import {
  ArchitectProviderOutputSchema,
  ArchitectTurnListSchema,
  ArchitectTurnSchema,
  ReconstructionYjsStateSchema,
  architectTurnErrorSchema,
  type ArchitectProviderOutput,
  type ArchitectTurn,
  type ArchitectTurnError,
  type ReconstructionYjsState,
} from "@architect/contracts";
import {
  Prisma,
  type ArchitectProposal,
  type PrismaClient,
} from "@prisma/client";

import type {
  AiRunTerminalMetadata,
  ProviderIdentity,
} from "../ai/provider.js";

const TRANSACTION_RETRIES = 3;
const INTERRUPTED_MESSAGE =
  "The architect turn was interrupted. Submit a new request to retry.";

type ArchitectDatabase = Pick<
  PrismaClient,
  "$transaction" | "architectProposal"
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

  const interruptStaleThinking = async (cutoff: Date) =>
    transaction(async (client) => {
      const interruptedAt = now();
      const stale = await client.architectProposal.findMany({
        where: { state: "thinking", updatedAt: { lte: cutoff } },
        take: 500,
      });
      let interrupted = 0;
      for (const row of stale) {
        const failed = await client.architectProposal.updateMany({
          where: {
            id: row.id,
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

  const rejectProposal = async (input: RejectProposalInput) =>
    transaction(async (client) => {
      const row = await client.architectProposal.findFirst({
        where: { id: input.proposalId, roomId: input.roomId },
      });
      if (!row) return { kind: "not_found" } as const;
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
    interruptStaleThinking,
    readTurn,
    listTurns,
    rejectProposal,
  });
}

export type ArchitectProposalRepository = ReturnType<
  typeof createArchitectProposalRepository
>;

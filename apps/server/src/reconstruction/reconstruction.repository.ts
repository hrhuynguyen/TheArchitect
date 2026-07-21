import {
  ReconstructionAnalysisSchema,
  ReconstructionPublicErrorSchema,
  ReconstructionResultSchema,
  type ReconstructionAnalysis,
  type ReconstructionPublicError,
  type ReconstructionResult,
} from "@architect/contracts";
import {
  Prisma,
  type PrismaClient,
  type TransitionJob,
  type TransitionState,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AiRunTerminalMetadata, ProviderIdentity } from "../ai/provider.js";

export const RECONSTRUCTION_LEASE_MS = 30_000;
const TRANSACTION_RETRIES = 3;
const ABANDONED_ATTEMPT_CODE = "AI_ATTEMPT_ABANDONED";

type ReconstructionDatabase = Pick<PrismaClient, "$transaction" | "transitionJob">;

export type ReconstructionLease = Readonly<{
  jobId: string;
  token: string;
  attempt: number;
  aiTraceId: string;
  expiresAt: Date;
}>;

export type ReconstructionRecoveryWork =
  | "publishing"
  | "failed_cleanup"
  | "phase_mirror";

export type ReconstructionJobRecord = Readonly<{
  jobId: string;
  roomId: string;
  sourceSnapshotVersion: number;
  state: TransitionState;
  traceId: string;
  errorCode: string | null;
  result: ReconstructionResult | null;
  architectureRevisionId: string | null;
  cleanupCompletedAt: Date | null;
  phasePublishedAt: Date | null;
}>;

type ClaimResult =
  | Readonly<{ kind: "claimed"; lease: ReconstructionLease; state: "running" }>
  | Readonly<{
      kind: "in_flight";
      jobId: string;
      state: "claimed" | "running" | "publishing";
    }>
  | Readonly<{
      kind: "terminal";
      jobId: string;
      state: "succeeded" | "failed";
      result: ReconstructionResult | null;
      errorCode: string | null;
    }>
  | Readonly<{ kind: "not_found" }>;

type RecoveryClaimResult =
  | Readonly<{ kind: "claimed"; lease: ReconstructionLease; state: TransitionState }>
  | Readonly<{ kind: "in_flight"; jobId: string; state: TransitionState }>
  | Readonly<{ kind: "lost" }>;

type ReconstructionRepositoryOptions = Readonly<{
  database: ReconstructionDatabase;
  leaseOwner: string;
  primaryProvider: ProviderIdentity;
  now?: () => Date;
  createToken?: () => string;
  createId?: () => string;
}>;

function isRetryableTransactionError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ((error as { code?: unknown }).code === "P2034" ||
        (error as { code?: unknown }).code === "P2002"),
  );
}

function resultFromJson(value: Prisma.JsonValue | null): ReconstructionResult | null {
  const parsed = ReconstructionResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function publicJob(job: TransitionJob): ReconstructionJobRecord {
  return Object.freeze({
    jobId: job.id,
    roomId: job.roomId,
    sourceSnapshotVersion: job.sourceRevision,
    state: job.state,
    traceId: job.traceId,
    errorCode: job.errorCode,
    result: resultFromJson(job.result),
    architectureRevisionId: job.architectureRevisionId,
    cleanupCompletedAt: job.cleanupCompletedAt,
    phasePublishedAt: job.phasePublishedAt,
  });
}

function terminalClaim(job: TransitionJob): ClaimResult {
  if (job.state === "succeeded" || job.state === "failed") {
    return Object.freeze({
      kind: "terminal",
      jobId: job.id,
      state: job.state,
      result: resultFromJson(job.result),
      errorCode: job.errorCode,
    });
  }
  return Object.freeze({ kind: "in_flight", jobId: job.id, state: job.state });
}

function recoveryMatches(job: TransitionJob, work: ReconstructionRecoveryWork): boolean {
  if (work === "publishing") {
    return job.state === "publishing" && job.architectureRevisionId !== null;
  }
  if (work === "failed_cleanup") {
    return job.state === "failed" && job.cleanupCompletedAt === null;
  }
  return job.state === "succeeded" && job.phasePublishedAt === null;
}

export function createReconstructionRepository({
  database,
  leaseOwner,
  primaryProvider,
  now = () => new Date(),
  createToken = randomUUID,
  createId = randomUUID,
}: ReconstructionRepositoryOptions) {
  if (!leaseOwner.trim()) throw new Error("Reconstruction lease owner is required");
  if (!primaryProvider.model.trim()) throw new Error("Primary provider model is required");

  const transaction = async <T>(operation: (client: Prisma.TransactionClient) => Promise<T>) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < TRANSACTION_RETRIES; attempt += 1) {
      try {
        return await database.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        lastError = error;
        if (!isRetryableTransactionError(error) || attempt === TRANSACTION_RETRIES - 1) {
          throw error;
        }
      }
    }
    throw lastError;
  };

  const readById = async (roomId: string, jobId: string) => {
    const job = await database.transitionJob.findFirst({ where: { id: jobId, roomId } });
    return job ? publicJob(job) : null;
  };

  const readCurrent = async (roomId: string) => {
    const job = await database.transitionJob.findFirst({
      where: { roomId, kind: "ready" },
      orderBy: { createdAt: "desc" },
    });
    return job ? publicJob(job) : null;
  };

  const claimAttempt = async (input: Readonly<{
    roomId: string;
    jobId: string;
    sourceSnapshotVersion: number;
    participantId: string;
    inputDigest: string;
  }>): Promise<ClaimResult> => transaction(async (client) => {
    const claimedAt = now();
    const job = await client.transitionJob.findUnique({ where: { id: input.jobId } });
    if (
      !job ||
      job.roomId !== input.roomId ||
      job.sourceRevision !== input.sourceSnapshotVersion ||
      job.kind !== "ready"
    ) return { kind: "not_found" } as const;

    if (job.state === "succeeded" || job.state === "failed" || job.state === "publishing") {
      return terminalClaim(job);
    }
    if (
      job.state === "running" &&
      job.leaseExpiresAt !== null &&
      job.leaseExpiresAt > claimedAt
    ) return terminalClaim(job);

    const attempt = job.attempt + 1;
    const token = createToken();
    const expiresAt = new Date(claimedAt.getTime() + RECONSTRUCTION_LEASE_MS);
    const aiTraceId = `${job.traceId}:attempt:${attempt}`;
    const oldAiTraceId = job.state === "running" ? job.activeAiTraceId : null;
    const fenced = await client.transitionJob.updateMany({
      where: {
        id: job.id,
        OR: [
          { state: "claimed" },
          { state: "running", leaseExpiresAt: { lte: claimedAt } },
          { state: "running", leaseExpiresAt: null },
        ],
      },
      data: {
        state: "running",
        attempt,
        leaseOwner,
        leaseToken: token,
        leaseExpiresAt: expiresAt,
        attemptParticipantId: input.participantId,
        attemptInputDigest: input.inputDigest,
        activeAiTraceId: aiTraceId,
        errorCode: null,
        diagnostics: Prisma.DbNull,
      },
    });
    if (fenced.count !== 1) {
      const current = await client.transitionJob.findUnique({ where: { id: job.id } });
      return current ? terminalClaim(current) : { kind: "not_found" } as const;
    }

    if (oldAiTraceId) {
      await client.aiRun.updateMany({
        where: { traceId: oldAiTraceId, status: "running" },
        data: {
          status: "failed",
          errorCode: ABANDONED_ATTEMPT_CODE,
          finishedAt: claimedAt,
        },
      });
    }
    await client.aiRun.create({
      data: {
        roomId: job.roomId,
        traceId: aiTraceId,
        task: "reconstruct",
        provider: primaryProvider.provider,
        model: primaryProvider.model,
        status: "running",
      },
    });
    return Object.freeze({
      kind: "claimed",
      state: "running",
      lease: Object.freeze({ jobId: job.id, token, attempt, aiTraceId, expiresAt }),
    });
  });

  const renewLease = async (lease: ReconstructionLease) => transaction(async (client) => {
    const renewedAt = now();
    const expiresAt = new Date(renewedAt.getTime() + RECONSTRUCTION_LEASE_MS);
    const fenced = await client.transitionJob.updateMany({
      where: {
        id: lease.jobId,
        leaseToken: lease.token,
        leaseExpiresAt: { gt: renewedAt },
        state: { in: ["running", "publishing", "failed", "succeeded"] },
      },
      data: { leaseExpiresAt: expiresAt },
    });
    return fenced.count === 1
      ? { kind: "renewed", lease: Object.freeze({ ...lease, expiresAt }) } as const
      : { kind: "lost" } as const;
  });

  const recordAiTerminal = async (
    lease: ReconstructionLease,
    metadata: AiRunTerminalMetadata,
  ) => transaction(async (client) => {
    if (
      metadata.traceId !== lease.aiTraceId ||
      metadata.task !== "reconstruct"
    ) return { kind: "lost" } as const;
    const job = await client.transitionJob.findFirst({
      where: {
        id: lease.jobId,
        state: "running",
        leaseToken: lease.token,
        activeAiTraceId: lease.aiTraceId,
      },
      select: { id: true },
    });
    if (!job) return { kind: "lost" } as const;
    const recorded = await client.aiRun.updateMany({
      where: { traceId: lease.aiTraceId, status: "running" },
      data: {
        provider: metadata.provider,
        model: metadata.model,
        status: metadata.status,
        errorCode: metadata.errorCode ?? null,
        finishedAt: now(),
      },
    });
    return recorded.count === 1 ? { kind: "recorded" } as const : { kind: "lost" } as const;
  });

  const commitAnalysis = async (
    lease: ReconstructionLease,
    analysisInput: ReconstructionAnalysis,
  ) => {
    const analysis = ReconstructionAnalysisSchema.parse(analysisInput);
    return transaction(async (client) => {
      const job = await client.transitionJob.findUnique({ where: { id: lease.jobId } });
      if (
        !job ||
        job.state !== "running" ||
        job.leaseToken !== lease.token ||
        job.activeAiTraceId !== lease.aiTraceId ||
        !job.attemptParticipantId
      ) return { kind: "lost" } as const;

      const fenced = await client.transitionJob.updateMany({
        where: {
          id: job.id,
          state: "running",
          leaseToken: lease.token,
          activeAiTraceId: lease.aiTraceId,
          architectureRevisionId: null,
        },
        data: { state: "publishing" },
      });
      if (fenced.count !== 1) return { kind: "lost" } as const;

      const latest = await client.architectureRevision.aggregate({
        where: { roomId: job.roomId },
        _max: { version: true },
      });
      const revisionId = createId();
      const version = (latest._max.version ?? 0) + 1;
      const layout = {
        version: "architecture-layout/v1",
        revisionId,
        nodes: [],
      };
      const revision = await client.architectureRevision.create({
        data: {
          id: revisionId,
          roomId: job.roomId,
          version,
          architecture: analysis.deploymentPlan.architecture as Prisma.InputJsonValue,
          layout,
          requirements: analysis.deploymentPlan.architecture.requirements as Prisma.InputJsonValue,
          stage: analysis.stageDecision.stage,
          authorType: "ai",
          authorId: `${analysis.provider.provider}:${analysis.provider.model}`,
          rationale: "Reconstructed from the room sketch and validated requirements.",
        },
      });
      const result = ReconstructionResultSchema.parse({
        ...analysis,
        traceId: job.traceId,
        architectureRevisionId: revision.id,
      });
      await client.historyEvent.create({
        data: {
          id: `reconstruction:${job.id}`,
          roomId: job.roomId,
          kind: "reconstruction",
          status: "succeeded",
          actorType: "participant",
          actorId: job.attemptParticipantId,
          title: "Architecture reconstructed",
          summary: "Created a validated architecture revision from the room sketch.",
          details: {
            revisionId: revision.id,
            version: revision.version,
            provider: analysis.provider.provider,
            model: analysis.provider.model,
            stage: analysis.stageDecision.stage,
          },
          traceId: job.traceId,
        },
      });
      const linked = await client.transitionJob.updateMany({
        where: { id: job.id, state: "publishing", leaseToken: lease.token },
        data: {
          architectureRevisionId: revision.id,
          result: result as Prisma.InputJsonValue,
          diagnostics: analysis.diagnostics.map(({ level, code }) => ({ level, code })),
        },
      });
      if (linked.count !== 1) throw new Error("Reconstruction commit fence changed inside transaction");
      return Object.freeze({
        kind: "publishing" as const,
        revision: Object.freeze({
          id: revision.id,
          roomId: revision.roomId,
          version: revision.version,
          architecture: analysis.deploymentPlan.architecture,
          layout,
          requirements: analysis.deploymentPlan.architecture.requirements,
          stage: analysis.stageDecision.stage,
        }),
        result,
      });
    });
  };

  const recordFailure = async (
    lease: ReconstructionLease,
    errorInput: ReconstructionPublicError,
    diagnostics: ReadonlyArray<Readonly<{ level: "error" | "warning" | "info"; code: string }>> = [],
  ) => {
    const error = ReconstructionPublicErrorSchema.parse(errorInput);
    return transaction(async (client) => {
      const failed = await client.transitionJob.updateMany({
        where: { id: lease.jobId, state: "running", leaseToken: lease.token },
        data: {
          state: "failed",
          errorCode: error.code,
          result: Prisma.DbNull,
          diagnostics: diagnostics.slice(0, 2_000) as Prisma.InputJsonValue,
          finishedAt: now(),
        },
      });
      return failed.count === 1 ? { kind: "failed" } as const : { kind: "lost" } as const;
    });
  };

  const completeSuccess = async (lease: ReconstructionLease) => transaction(async (client) => {
    const completedAt = now();
    const job = await client.transitionJob.findFirst({
      where: {
        id: lease.jobId,
        state: "publishing",
        leaseToken: lease.token,
        architectureRevisionId: { not: null },
      },
    });
    if (!job?.architectureRevisionId) return { kind: "lost" } as const;
    const fenced = await client.transitionJob.updateMany({
      where: { id: job.id, state: "publishing", leaseToken: lease.token },
      data: { state: "succeeded", finishedAt: completedAt },
    });
    if (fenced.count !== 1) return { kind: "lost" } as const;
    const room = await client.room.updateMany({
      where: { id: job.roomId, phase: "reconstructing" },
      data: { phase: "architect", currentRevisionId: job.architectureRevisionId },
    });
    if (room.count !== 1) throw new Error("Room phase changed before reconstruction success");
    return { kind: "completed" } as const;
  });

  const completeFailureCleanup = async (lease: ReconstructionLease) => transaction(async (client) => {
    const completedAt = now();
    const fenced = await client.transitionJob.updateMany({
      where: {
        id: lease.jobId,
        state: "failed",
        leaseToken: lease.token,
        cleanupCompletedAt: null,
      },
      data: {
        cleanupCompletedAt: completedAt,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (fenced.count !== 1) return { kind: "lost" } as const;
    const job = await client.transitionJob.findUnique({ where: { id: lease.jobId } });
    if (!job) throw new Error("Reconstruction job disappeared during cleanup");
    const room = await client.room.updateMany({
      where: { id: job.roomId, phase: "reconstructing" },
      data: { phase: "sketch" },
    });
    if (room.count !== 1) throw new Error("Room phase changed before reconstruction cleanup");
    return { kind: "completed" } as const;
  });

  const completePhaseMirror = async (lease: ReconstructionLease) => transaction(async (client) => {
    const completed = await client.transitionJob.updateMany({
      where: {
        id: lease.jobId,
        state: "succeeded",
        leaseToken: lease.token,
        phasePublishedAt: null,
      },
      data: {
        phasePublishedAt: now(),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    return completed.count === 1 ? { kind: "completed" } as const : { kind: "lost" } as const;
  });

  const claimRecovery = async (input: Readonly<{
    jobId: string;
    work: ReconstructionRecoveryWork;
  }>): Promise<RecoveryClaimResult> => transaction(async (client) => {
    const claimedAt = now();
    const job = await client.transitionJob.findUnique({ where: { id: input.jobId } });
    if (!job || !recoveryMatches(job, input.work)) return { kind: "lost" } as const;
    if (job.leaseToken && job.leaseExpiresAt && job.leaseExpiresAt > claimedAt) {
      return { kind: "in_flight", jobId: job.id, state: job.state } as const;
    }
    const token = createToken();
    const expiresAt = new Date(claimedAt.getTime() + RECONSTRUCTION_LEASE_MS);
    const completionFence = input.work === "failed_cleanup"
      ? { cleanupCompletedAt: null }
      : input.work === "phase_mirror"
        ? { phasePublishedAt: null }
        : { architectureRevisionId: { not: null } };
    const fenced = await client.transitionJob.updateMany({
      where: {
        id: job.id,
        state: job.state,
        ...completionFence,
        OR: [
          { leaseToken: null },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: claimedAt } },
        ],
      },
      data: { leaseOwner, leaseToken: token, leaseExpiresAt: expiresAt },
    });
    if (fenced.count !== 1) return { kind: "in_flight", jobId: job.id, state: job.state } as const;
    const aiTraceId = job.activeAiTraceId ?? `${job.traceId}:attempt:${job.attempt}`;
    return Object.freeze({
      kind: "claimed",
      state: job.state,
      lease: Object.freeze({
        jobId: job.id,
        token,
        attempt: job.attempt,
        aiTraceId,
        expiresAt,
      }),
    });
  });

  const listRecoverable = async () => {
    const jobs = await database.transitionJob.findMany({
      where: {
        OR: [
          { state: "publishing", architectureRevisionId: { not: null } },
          { state: "failed", cleanupCompletedAt: null },
          { state: "succeeded", phasePublishedAt: null },
        ],
      },
    });
    return jobs
      .flatMap((job) => {
        const work = job.state === "publishing"
          ? "publishing"
          : job.state === "failed"
            ? "failed_cleanup"
            : "phase_mirror";
        return recoveryMatches(job, work)
          ? [{ jobId: job.id, roomId: job.roomId, work } as const]
          : [];
      })
      .sort((left, right) => left.jobId.localeCompare(right.jobId));
  };

  return Object.freeze({
    readCurrent,
    readById,
    claimAttempt,
    claimRecovery,
    renewLease,
    recordAiTerminal,
    commitAnalysis,
    recordFailure,
    completeSuccess,
    completeFailureCleanup,
    completePhaseMirror,
    listRecoverable,
  });
}

export type ReconstructionRepository = ReturnType<
  typeof createReconstructionRepository
>;

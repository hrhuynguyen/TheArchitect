import {
  DebugReconstructionRequestSchema,
  ReconstructionJobEnvelopeSchema,
  ReconstructionRequestSchema,
  RequirementsProfileSchema,
  SERVER_VOTES_MAP_KEY,
  VoteSnapshotSchema,
  type DebugReconstructionRequest,
  type ReconstructionJobEnvelope,
  type ReconstructionPublicError,
  type ReconstructionRequest,
} from "@architect/contracts";
import { createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";
import {
  AiRecorderError,
  type AiProvider,
  type AiRunRecorder,
  type AiRunTerminalMetadata,
} from "../ai/provider.js";
import type { ReconstructionPublisher } from "./reconstruction.publisher.js";
import {
  ReconstructionPipelineError,
  analyzeReconstruction,
} from "./reconstruction.pipeline.js";
import type {
  ReconstructionJobRecord,
  ReconstructionLease,
  ReconstructionRepository,
  ReconstructionRecoveryWork,
} from "./reconstruction.repository.js";
import { InvalidPngError, validateReconstructionPng } from "./png.js";

export const RECONSTRUCTION_HEARTBEAT_MS = 10_000;

const PUBLIC_FAILURES = Object.freeze({
  AI_UNAVAILABLE: {
    code: "AI_UNAVAILABLE",
    message: "Architecture reconstruction is temporarily unavailable.",
  },
  RECONSTRUCTION_INVALID: {
    code: "RECONSTRUCTION_INVALID",
    message: "The sketch could not be converted into a valid architecture.",
  },
  RECONSTRUCTION_FAILED: {
    code: "RECONSTRUCTION_FAILED",
    message: "Architecture reconstruction could not be completed.",
  },
} satisfies Record<string, ReconstructionPublicError>);

type RequestErrorCode =
  | "INVALID_REQUEST"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_INVALID"
  | "NOT_SOURCE_VOTER"
  | "REQUIREMENTS_MISMATCH";

export class ReconstructionRequestError extends Error {
  constructor(readonly code: RequestErrorCode) {
    super("The reconstruction request is invalid.");
    this.name = "ReconstructionRequestError";
  }
}

type SourceDatabase = Readonly<{
  yjsSnapshot: {
    findUnique(input: {
      where: { roomId_version: { roomId: string; version: number } };
      select: { payload: true };
    }): Promise<{ payload: Uint8Array } | null>;
  };
}>;

type ReconstructionServiceOptions = Readonly<{
  repository: ReconstructionRepository;
  publisher: ReconstructionPublisher;
  sourceDatabase: SourceDatabase;
  createProvider(recordTerminal: AiRunRecorder): AiProvider;
  safetySecret: string;
  heartbeatMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}>;

function publicFailure(code: string | null): ReconstructionPublicError {
  if (code === "AI_UNAVAILABLE" || code === "RECONSTRUCTION_INVALID") {
    return PUBLIC_FAILURES[code];
  }
  return PUBLIC_FAILURES.RECONSTRUCTION_FAILED;
}

function envelope(job: ReconstructionJobRecord): ReconstructionJobEnvelope {
  if (job.state === "succeeded") {
    if (!job.result) throw new Error("Succeeded reconstruction has no result");
    return ReconstructionJobEnvelopeSchema.parse({
      jobId: job.jobId,
      sourceSnapshotVersion: job.sourceSnapshotVersion,
      state: job.state,
      result: job.result,
      error: null,
    });
  }
  if (job.state === "failed") {
    return ReconstructionJobEnvelopeSchema.parse({
      jobId: job.jobId,
      sourceSnapshotVersion: job.sourceSnapshotVersion,
      state: job.state,
      result: null,
      error: publicFailure(job.errorCode),
    });
  }
  return ReconstructionJobEnvelopeSchema.parse({
    jobId: job.jobId,
    sourceSnapshotVersion: job.sourceSnapshotVersion,
    state: job.state,
    result: null,
    error: null,
  });
}

function failureFor(error: unknown): ReconstructionPublicError {
  if (
    error instanceof ReconstructionPipelineError &&
    error.code === "AI_UNAVAILABLE"
  ) return PUBLIC_FAILURES.AI_UNAVAILABLE;
  return PUBLIC_FAILURES.RECONSTRUCTION_FAILED;
}

export function createReconstructionService({
  repository,
  publisher,
  sourceDatabase,
  createProvider,
  safetySecret,
  heartbeatMs = RECONSTRUCTION_HEARTBEAT_MS,
  setInterval: scheduleInterval = globalThis.setInterval,
  clearInterval: cancelInterval = globalThis.clearInterval,
}: ReconstructionServiceOptions) {
  if (!safetySecret) throw new Error("Reconstruction safety secret is required");
  let destroyed = false;

  const readEnvelope = async (roomId: string, jobId: string) => {
    const job = await repository.readById(roomId, jobId);
    return job ? envelope(job) : null;
  };

  const currentJob = async (roomId: string) => {
    const job = await repository.readCurrent(roomId);
    return job ? envelope(job) : null;
  };

  const jobById = async (roomId: string, jobId: string) =>
    readEnvelope(roomId, jobId);

  const safetyIdentifier = (roomId: string, principalId: string) =>
    createHmac("sha256", safetySecret)
      .update("architect:reconstruction:safety:v1\0")
      .update(roomId)
      .update("\0")
      .update(principalId)
      .digest("base64url");

  const startHeartbeat = (lease: ReconstructionLease) => {
    let stopped = false;
    let renewing = false;
    const timer = scheduleInterval(() => {
      if (stopped || renewing) return;
      renewing = true;
      void repository.renewLease(lease).then((result) => {
        if (result.kind === "lost") stopped = true;
      }).catch(() => undefined).finally(() => {
        renewing = false;
      });
    }, heartbeatMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return () => {
      stopped = true;
      cancelInterval(timer);
    };
  };

  const recordedProvider = (
    recorder: AiRunRecorder,
  ) => {
    let terminal: AiRunTerminalMetadata | null = null;
    const provider = createProvider(async (metadata) => {
      await recorder(metadata);
      terminal = metadata;
    });
    return Object.freeze({ provider, terminal: () => terminal });
  };

  const validateSource = async (
    roomId: string,
    participantId: string,
    request: ReconstructionRequest,
  ) => {
    const source = await sourceDatabase.yjsSnapshot.findUnique({
      where: {
        roomId_version: {
          roomId,
          version: request.sourceSnapshotVersion,
        },
      },
      select: { payload: true },
    });
    if (!source) throw new ReconstructionRequestError("SOURCE_NOT_FOUND");
    const document = new Y.Doc();
    try {
      try {
        Y.applyUpdate(document, source.payload);
      } catch {
        throw new ReconstructionRequestError("SOURCE_INVALID");
      }
      const ready = VoteSnapshotSchema.safeParse(
        document.getMap(SERVER_VOTES_MAP_KEY).get("ready"),
      );
      const sourceRequirements = RequirementsProfileSchema.safeParse(
        document.getMap("requirements").get("current"),
      );
      if (!ready.success || !ready.data.met || !sourceRequirements.success) {
        throw new ReconstructionRequestError("SOURCE_INVALID");
      }
      if (!ready.data.voterIds.includes(participantId)) {
        throw new ReconstructionRequestError("NOT_SOURCE_VOTER");
      }
      if (!isDeepStrictEqual(sourceRequirements.data, request.requirements)) {
        throw new ReconstructionRequestError("REQUIREMENTS_MISMATCH");
      }
    } finally {
      document.destroy();
    }
  };

  const completeFailure = async (
    roomId: string,
    lease: ReconstructionLease,
    error: ReconstructionPublicError,
    diagnostics: ReadonlyArray<Readonly<{
      level: "error" | "warning" | "info";
      code: string;
    }>> = [],
  ) => {
    const failed = await repository.recordFailure(lease, error, diagnostics);
    if (failed.kind === "lost") return readEnvelope(roomId, lease.jobId);
    try {
      await publisher.publishFailureCleanup({ roomId });
    } catch {
      return readEnvelope(roomId, lease.jobId);
    }
    await repository.completeFailureCleanup(lease);
    return readEnvelope(roomId, lease.jobId);
  };

  const completePublication = async (
    lease: ReconstructionLease,
    publication: Readonly<{
      roomId: string;
      revisionId: string;
      architecture: Parameters<ReconstructionPublisher["publishArchitecture"]>[0]["architecture"];
      layout: Parameters<ReconstructionPublisher["publishArchitecture"]>[0]["layout"];
    }>,
  ) => {
    try {
      await publisher.publishArchitecture(publication);
    } catch {
      return readEnvelope(publication.roomId, lease.jobId);
    }
    const completed = await repository.completeSuccess(lease);
    if (completed.kind === "lost") {
      return readEnvelope(publication.roomId, lease.jobId);
    }
    try {
      await publisher.publishArchitectPhase({ roomId: publication.roomId });
    } catch {
      return readEnvelope(publication.roomId, lease.jobId);
    }
    await repository.completePhaseMirror(lease);
    return readEnvelope(publication.roomId, lease.jobId);
  };

  const reconstruct = async (input: Readonly<{
    roomId: string;
    participantId: string;
    request: ReconstructionRequest;
  }>): Promise<ReconstructionJobEnvelope> => {
    if (destroyed) throw new Error("Reconstruction service stopped");
    const parsed = ReconstructionRequestSchema.safeParse(input.request);
    if (!parsed.success) throw new ReconstructionRequestError("INVALID_REQUEST");
    await validateSource(input.roomId, input.participantId, parsed.data);
    let png;
    try {
      png = validateReconstructionPng(parsed.data);
    } catch (error) {
      if (error instanceof InvalidPngError) {
        throw new ReconstructionRequestError("INVALID_REQUEST");
      }
      throw error;
    }

    const claimed = await repository.claimAttempt({
      roomId: input.roomId,
      jobId: (await repository.readCurrent(input.roomId))?.jobId ?? "",
      sourceSnapshotVersion: parsed.data.sourceSnapshotVersion,
      participantId: input.participantId,
      inputDigest: png.digest,
    });
    if (claimed.kind === "not_found") {
      throw new ReconstructionRequestError("SOURCE_NOT_FOUND");
    }
    if (claimed.kind !== "claimed") {
      const current = await readEnvelope(input.roomId, claimed.jobId);
      if (!current) throw new ReconstructionRequestError("SOURCE_NOT_FOUND");
      return current;
    }

    const stopHeartbeat = startHeartbeat(claimed.lease);
    try {
      const boundary = recordedProvider(async (metadata) => {
        const recorded = await repository.recordAiTerminal(claimed.lease, metadata);
        if (recorded.kind === "lost") throw new AiRecorderError(metadata.traceId);
      });
      let analysis;
      try {
        analysis = await analyzeReconstruction({
          aiTraceId: claimed.lease.aiTraceId,
          safetyIdentifier: safetyIdentifier(input.roomId, input.participantId),
          imageDataUrl: png.imageDataUrl,
          mimeType: parsed.data.mimeType,
          requirements: parsed.data.requirements,
        }, boundary);
      } catch (error) {
        const failed = await completeFailure(
          input.roomId,
          claimed.lease,
          failureFor(error),
        );
        if (!failed) throw new ReconstructionRequestError("SOURCE_NOT_FOUND");
        return failed;
      }

      const blocking = analysis.diagnostics
        .filter(({ level }) => level === "error")
        .map(({ level, code }) => ({ level, code }));
      if (blocking.length > 0) {
        const failed = await completeFailure(
          input.roomId,
          claimed.lease,
          PUBLIC_FAILURES.RECONSTRUCTION_INVALID,
          blocking,
        );
        if (!failed) throw new ReconstructionRequestError("SOURCE_NOT_FOUND");
        return failed;
      }

      let committed;
      try {
        committed = await repository.commitAnalysis(claimed.lease, analysis);
      } catch (error) {
        const current = await repository.readById(input.roomId, claimed.lease.jobId);
        if (current?.state === "publishing" || current?.state === "succeeded") {
          return envelope(current);
        }
        const failed = await completeFailure(
          input.roomId,
          claimed.lease,
          failureFor(error),
        );
        if (!failed) throw new ReconstructionRequestError("SOURCE_NOT_FOUND");
        return failed;
      }
      if (committed.kind === "lost") {
        const current = await readEnvelope(input.roomId, claimed.lease.jobId);
        if (!current) throw new ReconstructionRequestError("SOURCE_NOT_FOUND");
        return current;
      }
      const completed = await completePublication(claimed.lease, {
        roomId: committed.revision.roomId,
        revisionId: committed.revision.id,
        architecture: committed.revision.architecture,
        layout: committed.revision.layout,
      });
      if (!completed) throw new ReconstructionRequestError("SOURCE_NOT_FOUND");
      return completed;
    } finally {
      stopHeartbeat();
    }
  };

  const recoverOne = async (
    jobId: string,
    roomId: string,
    work: ReconstructionRecoveryWork,
  ) => {
    const claimed = await repository.claimRecovery({ jobId, work });
    if (claimed.kind !== "claimed") return;
    const stopHeartbeat = startHeartbeat(claimed.lease);
    try {
      if (work === "publishing") {
        const publication = await repository.readPublication(jobId);
        if (publication) await completePublication(claimed.lease, publication);
      } else if (work === "failed_cleanup") {
        try {
          await publisher.publishFailureCleanup({ roomId });
        } catch {
          return;
        }
        await repository.completeFailureCleanup(claimed.lease);
      } else {
        try {
          await publisher.publishArchitectPhase({ roomId });
        } catch {
          return;
        }
        await repository.completePhaseMirror(claimed.lease);
      }
    } finally {
      stopHeartbeat();
    }
  };

  const recover = async () => {
    if (destroyed) return;
    const candidates = await repository.listRecoverable();
    for (const candidate of candidates) {
      try {
        await recoverOne(candidate.jobId, candidate.roomId, candidate.work);
      } catch {
        // Each recoverable state remains durable and can be retried later.
      }
    }
  };

  const debugAnalyze = async (input: Readonly<{
    roomId: string;
    principalId: string;
    request: DebugReconstructionRequest;
  }>) => {
    const request = DebugReconstructionRequestSchema.parse(input.request);
    const boundary = recordedProvider(async () => undefined);
    const analysis = await analyzeReconstruction({
      aiTraceId: `debug-${createHmac("sha256", safetySecret)
        .update(`${input.roomId}\0${input.principalId}\0${Date.now()}`)
        .digest("hex")
        .slice(0, 32)}`,
      safetyIdentifier: safetyIdentifier(input.roomId, input.principalId),
      ...request,
    }, boundary);
    return Object.freeze({
      ...analysis,
      semanticGraph: analysis.deploymentPlan.architecture,
    });
  };

  return Object.freeze({
    reconstruct,
    currentJob,
    jobById,
    debugAnalyze,
    recover,
    async settle() {},
    async destroy() { destroyed = true; },
  });
}

export type ReconstructionService = ReturnType<
  typeof createReconstructionService
>;

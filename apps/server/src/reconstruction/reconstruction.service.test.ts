import {
  SERVER_VOTES_MAP_KEY,
  defaultRequirementsProfile,
  evaluateVote,
  type InfrastructureIntent,
  type ReconstructionAnalysis,
} from "@architect/contracts";
import { z } from "zod";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import {
  AiProviderError,
  type AiProvider,
  type AiRunRecorder,
  type AiTask,
  type ArchitectProtocol,
  type ArchitectTurnInput,
  type ProviderIdentity,
  type ReconstructionInput,
} from "../ai/provider.js";
import {
  ReconstructionRequestError,
  createReconstructionService,
} from "./reconstruction.service.js";

const IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const requirements = defaultRequirementsProfile();
const intent: InfrastructureIntent = {
  version: "infrastructure-intent/v1",
  resources: [{ id: "bucket", type: "S3", name: "Uploads", properties: {} }],
  relationships: [],
};

class RecordingProvider implements AiProvider {
  constructor(
    private readonly recorder: AiRunRecorder,
    private readonly events: string[],
    private readonly output: InfrastructureIntent | Error = intent,
    private readonly wait?: Promise<void>,
    private readonly inputs: ReconstructionInput[] = [],
  ) {}

  identity(_task: AiTask): ProviderIdentity {
    return { provider: "openai", model: "gpt-5.6" };
  }

  async reconstruct(input: ReconstructionInput) {
    this.inputs.push(input);
    this.events.push("provider-start");
    await this.wait;
    this.events.push("provider-finish");
    if (this.output instanceof Error) {
      await this.recorder({
        traceId: input.traceId,
        task: "reconstruct",
        provider: "openai",
        model: "gpt-5.6",
        status: "failed",
        errorCode: "AI_PROVIDER_ERROR",
      });
      throw this.output;
    }
    await this.recorder({
      traceId: input.traceId,
      task: "reconstruct",
      provider: "openai",
      model: "gpt-5.6",
      status: "succeeded",
    });
    return this.output;
  }

  async architect<TInput, TOutputSchema extends z.ZodObject>(
    _input: ArchitectTurnInput<TInput>,
    _protocol: ArchitectProtocol<TInput, TOutputSchema>,
  ): Promise<z.output<TOutputSchema>> {
    throw new Error("not used");
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function snapshot(voterIds = ["participant-a"], profile = requirements) {
  const document = new Y.Doc();
  document.getMap(SERVER_VOTES_MAP_KEY).set("ready", evaluateVote({
    activeParticipantIds: voterIds,
    voterIds,
    threshold: 0.8,
  }));
  document.getMap("requirements").set("current", profile);
  const payload = Y.encodeStateAsUpdate(document);
  document.destroy();
  return payload;
}

function setup(options: {
  output?: InfrastructureIntent | Error;
  providerWait?: Promise<void>;
  publishArchitectureFailure?: Error;
  failureCleanupWait?: Promise<void>;
  phaseMirrorFailure?: Error;
  commitLost?: boolean;
  initialState?: "claimed" | "running" | "publishing" | "succeeded" | "failed";
} = {}) {
  const events: string[] = [];
  const providerInputs: ReconstructionInput[] = [];
  const sourcePayload = snapshot();
  const lease = {
    jobId: "job-a",
    token: "lease-a",
    attempt: 1,
    aiTraceId: "transition-a:attempt:1",
    expiresAt: new Date(Date.now() + 30_000),
  };
  const analysisResult = { current: null as ReconstructionAnalysis | null };
  const job: any = {
    jobId: "job-a",
    roomId: "room-a",
    sourceSnapshotVersion: 7,
    state: options.initialState ?? "claimed",
    traceId: "transition-a",
    errorCode: null,
    result: null,
    architectureRevisionId: null,
    cleanupCompletedAt: null,
    phasePublishedAt: null,
  };
  const repository = {
    async readCurrent(roomId: string) { return roomId === job.roomId ? { ...job } : null; },
    async readById(roomId: string, jobId: string) {
      return roomId === job.roomId && jobId === job.jobId ? { ...job } : null;
    },
    async claimAttempt() {
      events.push("claim-commit");
      if (job.state === "claimed") {
        job.state = "running";
        return { kind: "claimed" as const, state: "running" as const, lease };
      }
      if (["succeeded", "failed"].includes(job.state)) {
        return {
          kind: "terminal" as const,
          jobId: job.jobId,
          state: job.state,
          result: job.result,
          errorCode: job.errorCode,
        };
      }
      return { kind: "in_flight" as const, jobId: job.jobId, state: job.state };
    },
    renewLease: vi.fn(async (value) => ({ kind: "renewed" as const, lease: value })),
    async recordAiTerminal() { return { kind: "recorded" as const }; },
    async commitAnalysis(_lease: unknown, analysis: ReconstructionAnalysis) {
      events.push("revision-commit");
      if (options.commitLost) return { kind: "lost" as const };
      analysisResult.current = analysis;
      job.state = "publishing";
      job.architectureRevisionId = "revision-a";
      job.result = { ...analysis, traceId: job.traceId, architectureRevisionId: "revision-a" };
      return {
        kind: "publishing" as const,
        revision: {
          id: "revision-a",
          roomId: "room-a",
          version: 1,
          architecture: analysis.deploymentPlan.architecture,
          layout: {
            version: "architecture-layout/v1" as const,
            revisionId: "revision-a",
            nodes: [],
          },
          requirements,
          stage: analysis.stageDecision.stage,
        },
        result: job.result,
      };
    },
    async recordFailure(_lease: unknown, error: { code: string }) {
      events.push("failure-commit");
      job.state = "failed";
      job.errorCode = error.code;
      return { kind: "failed" as const };
    },
    async completeSuccess() {
      events.push("success-commit");
      job.state = "succeeded";
      return { kind: "completed" as const };
    },
    async completeFailureCleanup() {
      events.push("cleanup-commit");
      job.cleanupCompletedAt = new Date();
      return { kind: "completed" as const };
    },
    async completePhaseMirror() {
      job.phasePublishedAt = new Date();
      return { kind: "completed" as const };
    },
    async listRecoverable() {
      if (job.state === "publishing") return [{ jobId: job.jobId, roomId: job.roomId, work: "publishing" as const }];
      if (job.state === "failed" && !job.cleanupCompletedAt) return [{ jobId: job.jobId, roomId: job.roomId, work: "failed_cleanup" as const }];
      if (job.state === "succeeded" && !job.phasePublishedAt) return [{ jobId: job.jobId, roomId: job.roomId, work: "phase_mirror" as const }];
      return [];
    },
    async claimRecovery({ work }: { work: string }) {
      return { kind: "claimed" as const, state: job.state, lease: { ...lease, token: `recovery-${work}` } };
    },
    async readPublication() {
      if (!analysisResult.current && job.result) {
        analysisResult.current = job.result;
      }
      const analysis = analysisResult.current;
      if (!analysis) return null;
      return {
        roomId: job.roomId,
        revisionId: "revision-a",
        architecture: analysis.deploymentPlan.architecture,
        layout: { version: "architecture-layout/v1" as const, revisionId: "revision-a", nodes: [] },
      };
    },
  };
  const publisher = {
    async publishArchitecture() {
      events.push("architecture-persist", "architecture-publish");
      if (options.publishArchitectureFailure) throw options.publishArchitectureFailure;
    },
    async publishFailureCleanup() {
      events.push("cleanup-persist");
      await options.failureCleanupWait;
      events.push("cleanup-publish");
    },
    async publishArchitectPhase() {
      events.push("phase-mirror");
      if (options.phaseMirrorFailure) throw options.phaseMirrorFailure;
    },
  };
  const createProvider = vi.fn((recorder: AiRunRecorder) =>
    new RecordingProvider(
      recorder,
      events,
      options.output,
      options.providerWait,
      providerInputs,
    ));
  const service = createReconstructionService({
    repository: repository as never,
    publisher: publisher as never,
    sourceDatabase: {
      yjsSnapshot: {
        async findUnique({ where }: any) {
          return where.roomId_version.roomId === "room-a" && where.roomId_version.version === 7
            ? { payload: sourcePayload }
            : null;
        },
      },
    },
    createProvider,
    safetySecret: "test-cookie-signing-secret",
  });
  return {
    createProvider,
    events,
    job,
    lease,
    providerInputs,
    publisher,
    repository,
    service,
  };
}

const request = {
  imageDataUrl: IMAGE,
  mimeType: "image/png" as const,
  requirements,
  sourceSnapshotVersion: 7,
};

describe("reconstruction service", () => {
  it("creates one revision and advances only after architecture publication", async () => {
    const test = setup();
    await expect(test.service.reconstruct({
      roomId: "room-a",
      participantId: "participant-a",
      request,
    })).resolves.toMatchObject({ state: "succeeded", result: { architectureRevisionId: "revision-a" } });
    expect(test.events).toEqual([
      "claim-commit",
      "provider-start",
      "provider-finish",
      "revision-commit",
      "architecture-persist",
      "architecture-publish",
      "success-commit",
      "phase-mirror",
    ]);
    expect(test.providerInputs[0]?.safetyIdentifier).not.toContain(
      "participant-a",
    );
    expect(test.providerInputs[0]?.safetyIdentifier).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  it.each([
    ["missing source", "room-missing", "participant-a", request],
    ["non-voter", "room-a", "participant-b", request],
    ["requirements mismatch", "room-a", "participant-a", {
      ...request,
      requirements: { ...requirements, traffic: "high" as const },
    }],
  ])("rejects %s facts before provider invocation", async (_name, roomId, participantId, input) => {
    const test = setup();
    await expect(test.service.reconstruct({ roomId, participantId, request: input }))
      .rejects.toBeInstanceOf(ReconstructionRequestError);
    expect(test.createProvider).not.toHaveBeenCalled();
  });

  it("returns a fresh in-flight attempt without invoking or replacing provider input", async () => {
    const test = setup({ initialState: "running" });
    await expect(test.service.reconstruct({ roomId: "room-a", participantId: "participant-a", request }))
      .resolves.toMatchObject({ state: "running", result: null, error: null });
    expect(test.createProvider).not.toHaveBeenCalled();
  });

  it("records compiler-invalid analysis, cleans Yjs, then reopens voting", async () => {
    const invalid: InfrastructureIntent = {
      version: "infrastructure-intent/v1",
      resources: [],
      relationships: [{ sourceId: "missing-a", targetId: "missing-b", kind: "connects" }],
    };
    const test = setup({ output: invalid });
    await expect(test.service.reconstruct({ roomId: "room-a", participantId: "participant-a", request }))
      .resolves.toMatchObject({ state: "failed", error: { code: "RECONSTRUCTION_INVALID" } });
    expect(test.events).toEqual([
      "claim-commit",
      "provider-start",
      "provider-finish",
      "failure-commit",
      "cleanup-persist",
      "cleanup-publish",
      "cleanup-commit",
    ]);
  });

  it("maps provider outage to a stable failed envelope", async () => {
    const test = setup({ output: new AiProviderError("trace-a") });
    const result = await test.service.reconstruct({ roomId: "room-a", participantId: "participant-a", request });
    expect(result).toMatchObject({
      state: "failed",
      error: {
        code: "AI_UNAVAILABLE",
        message: "Architecture reconstruction is temporarily unavailable.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("trace-a");
  });

  it("keeps a committed revision publishing when Yjs persistence fails", async () => {
    const test = setup({ publishArchitectureFailure: new Error("snapshot unavailable") });
    await expect(test.service.reconstruct({ roomId: "room-a", participantId: "participant-a", request }))
      .resolves.toMatchObject({ state: "publishing", result: null, error: null });
    expect(test.events).not.toContain("success-commit");
    expect(test.events).not.toContain("failure-commit");
  });

  it("does not let a stale worker convert a lost commit fence into failure", async () => {
    const test = setup({ commitLost: true });
    await expect(test.service.reconstruct({ roomId: "room-a", participantId: "participant-a", request }))
      .resolves.toMatchObject({ state: "running", result: null, error: null });
    expect(test.events).not.toContain("failure-commit");
    expect(test.events).not.toContain("cleanup-commit");
  });

  it("keeps failure cleanup pending until its Yjs snapshot is published", async () => {
    const cleanup = deferred();
    const invalid: InfrastructureIntent = {
      version: "infrastructure-intent/v1",
      resources: [],
      relationships: [{ sourceId: "missing-a", targetId: "missing-b", kind: "connects" }],
    };
    const test = setup({ output: invalid, failureCleanupWait: cleanup.promise });
    const running = test.service.reconstruct({ roomId: "room-a", participantId: "participant-a", request });
    await vi.waitFor(() => expect(test.events).toContain("cleanup-persist"));
    expect(test.job).toMatchObject({ state: "failed", cleanupCompletedAt: null });
    expect(test.events).not.toContain("cleanup-commit");
    cleanup.resolve();
    await expect(running).resolves.toMatchObject({ state: "failed" });
    expect(test.job.cleanupCompletedAt).toBeInstanceOf(Date);
  });

  it("renews a running lease while provider work is pending", async () => {
    vi.useFakeTimers();
    const waiting = deferred();
    const test = setup({ providerWait: waiting.promise });
    try {
      const running = test.service.reconstruct({ roomId: "room-a", participantId: "participant-a", request });
      await vi.waitFor(() => expect(test.events).toContain("provider-start"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(test.repository.renewLease).toHaveBeenCalled();
      waiting.resolve();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers publishing without invoking AI or duplicating analysis", async () => {
    const test = setup({ initialState: "publishing" });
    test.job.result = {
      provider: { provider: "openai", model: "gpt-5.6" },
      intent,
      diagnostics: [],
      stageDecision: {
        version: "stage-decision/v1",
        stage: "prototype",
        confidence: "high",
        reasons: ["Prototype fit."],
        requiresApproval: false,
        proposedUpgrades: [],
      },
      deploymentPlan: {
        version: "deployment-plan/v1",
        stage: "prototype",
        requiresApproval: false,
        approvalsSatisfied: true,
        pendingApprovalResourceIds: [],
        pendingApprovalRelationshipIds: [],
        architecture: {
          version: "architecture/v1",
          requirements,
          resources: [{
            id: "bucket",
            type: "S3",
            name: "Uploads",
            properties: {},
            origin: "explicit",
            reason: "Explicit input.",
            approvalStatus: "not-required",
          }],
          relationships: [],
          decisions: [],
          unresolvedQuestions: [],
        },
      },
      traceId: "transition-a",
      architectureRevisionId: "revision-a",
    };
    await test.service.recover();
    expect(test.createProvider).not.toHaveBeenCalled();
    expect(test.events).toEqual([
      "architecture-persist",
      "architecture-publish",
      "success-commit",
      "phase-mirror",
    ]);
  });

  it("recovers failed cleanup and succeeded phase mirror without AI", async () => {
    const failed = setup({ initialState: "failed" });
    failed.job.errorCode = "RECONSTRUCTION_INVALID";
    await failed.service.recover();
    expect(failed.createProvider).not.toHaveBeenCalled();
    expect(failed.events).toEqual([
      "cleanup-persist",
      "cleanup-publish",
      "cleanup-commit",
    ]);
    expect(failed.job.cleanupCompletedAt).toBeInstanceOf(Date);

    const succeeded = setup({ initialState: "succeeded" });
    succeeded.job.result = {
      traceId: "transition-a",
      provider: { provider: "openai", model: "gpt-5.6" },
      intent,
      diagnostics: [],
      stageDecision: {
        version: "stage-decision/v1",
        stage: "prototype",
        confidence: "high",
        reasons: ["Prototype fit."],
        requiresApproval: false,
        proposedUpgrades: [],
      },
      deploymentPlan: {
        version: "deployment-plan/v1",
        stage: "prototype",
        requiresApproval: false,
        approvalsSatisfied: true,
        pendingApprovalResourceIds: [],
        pendingApprovalRelationshipIds: [],
        architecture: {
          version: "architecture/v1",
          requirements,
          resources: [{
            id: "bucket",
            type: "S3",
            name: "Uploads",
            properties: {},
            origin: "explicit",
            reason: "Explicit input.",
            approvalStatus: "not-required",
          }],
          relationships: [],
          decisions: [],
          unresolvedQuestions: [],
        },
      },
      architectureRevisionId: "revision-a",
    };
    await succeeded.service.recover();
    expect(succeeded.createProvider).not.toHaveBeenCalled();
    expect(succeeded.events).toEqual(["phase-mirror"]);
    expect(succeeded.job.phasePublishedAt).toBeInstanceOf(Date);
  });

  it("leaves a failed phase mirror recoverable", async () => {
    const test = setup({
      initialState: "succeeded",
      phaseMirrorFailure: new Error("snapshot unavailable"),
    });
    await test.service.recover();
    expect(test.job.phasePublishedAt).toBeNull();
    expect(test.createProvider).not.toHaveBeenCalled();
  });

  it("never recovers claimed or running jobs without browser bytes", async () => {
    for (const state of ["claimed", "running"] as const) {
      const test = setup({ initialState: state });
      await test.service.recover();
      expect(test.createProvider).not.toHaveBeenCalled();
      expect(test.events).toEqual([]);
    }
  });

  it("runs debug through the same pipeline without repository, publisher, or job mutation", async () => {
    const test = setup();
    const before = structuredClone(test.job);
    const claim = vi.spyOn(test.repository, "claimAttempt");
    const commit = vi.spyOn(test.repository, "commitAnalysis");
    const publish = vi.spyOn(test.publisher, "publishArchitecture");

    await expect(test.service.debugAnalyze({
      roomId: "room-a",
      principalId: "participant-a",
      request: {
        imageDataUrl: IMAGE,
        mimeType: "image/png",
        requirements,
      },
    })).resolves.toMatchObject({
      provider: { provider: "openai", model: "gpt-5.6" },
      semanticGraph: { version: "architecture/v1" },
    });
    expect(claim).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(test.job).toEqual(before);
  });
});

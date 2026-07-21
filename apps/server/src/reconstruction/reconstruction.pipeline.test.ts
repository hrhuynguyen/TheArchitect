import {
  defaultRequirementsProfile,
  type InfrastructureIntent,
} from "@architect/contracts";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createFailoverProvider } from "../ai/failover.js";
import {
  AiRecorderError,
  AiTimeoutError,
  type AiProvider,
  type AiRunTerminalMetadata,
  type AiTask,
  type ArchitectProtocol,
  type ArchitectTurnInput,
  type ProviderIdentity,
  type ReconstructionInput,
} from "../ai/provider.js";
import {
  ReconstructionPipelineError,
  analyzeReconstruction,
  type RecordedReconstructionProvider,
} from "./reconstruction.pipeline.js";

const IMAGE_SENTINEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const SAFETY_SENTINEL = "opaque-safety-secret";
const RAW_ERROR_SENTINEL = "raw-provider-secret";
const requirements = defaultRequirementsProfile();
const intent: InfrastructureIntent = {
  version: "infrastructure-intent/v1",
  resources: [{ id: "bucket", type: "S3", name: "Uploads", properties: {} }],
  relationships: [],
};

class StubProvider implements AiProvider {
  constructor(
    private readonly providerIdentity: ProviderIdentity,
    readonly reconstruct: (input: ReconstructionInput) => Promise<InfrastructureIntent>,
  ) {}

  identity(_task: AiTask) {
    return this.providerIdentity;
  }

  async architect<TInput, TOutputSchema extends z.ZodObject>(
    _input: ArchitectTurnInput<TInput>,
    _protocol: ArchitectProtocol<TInput, TOutputSchema>,
  ): Promise<z.output<TOutputSchema>> {
    throw new Error("not used");
  }
}

function recorded(
  primary: AiProvider,
  fallback: AiProvider | null = null,
): { boundary: RecordedReconstructionProvider; terminal: () => AiRunTerminalMetadata | null } {
  let metadata: AiRunTerminalMetadata | null = null;
  const provider = createFailoverProvider(primary, fallback, {
    recordTerminal: async (value) => { metadata = value; },
  });
  return {
    boundary: { provider, terminal: () => metadata },
    terminal: () => metadata,
  };
}

const pipelineInput = {
  aiTraceId: "trace-a",
  safetyIdentifier: SAFETY_SENTINEL,
  imageDataUrl: IMAGE_SENTINEL,
  mimeType: "image/png" as const,
  requirements,
};

describe("reconstruction analysis pipeline", () => {
  it("compiles provider output and returns selected terminal provenance", async () => {
    const primary = new StubProvider(
      { provider: "openai", model: "gpt-5.6" },
      vi.fn(async () => intent),
    );
    const test = recorded(primary);

    const result = await analyzeReconstruction(pipelineInput, test.boundary);

    expect(result).toMatchObject({
      provider: { provider: "openai", model: "gpt-5.6" },
      intent,
      deploymentPlan: { architecture: { requirements } },
    });
    expect(primary.reconstruct).toHaveBeenCalledWith({
      traceId: "trace-a",
      safetyIdentifier: SAFETY_SENTINEL,
      imageDataUrl: IMAGE_SENTINEL,
    });
    expect(analyzeReconstruction.length).toBe(2);
  });

  it("uses fallback terminal identity rather than the primary identity", async () => {
    const primary = new StubProvider(
      { provider: "openai", model: "gpt-5.6" },
      async () => { throw new AiTimeoutError("trace-a"); },
    );
    const fallback = new StubProvider(
      { provider: "anthropic", model: "claude-sonnet-4-5" },
      async () => intent,
    );
    const test = recorded(primary, fallback);

    await expect(analyzeReconstruction(pipelineInput, test.boundary)).resolves.toMatchObject({
      provider: { provider: "anthropic", model: "claude-sonnet-4-5" },
    });
  });

  it("keeps blocking compiler diagnostics in the shared analysis result", async () => {
    const invalidGraph: InfrastructureIntent = {
      version: "infrastructure-intent/v1",
      resources: [],
      relationships: [{ sourceId: "missing-a", targetId: "missing-b", kind: "connects" }],
    };
    const test = recorded(new StubProvider(
      { provider: "openai", model: "gpt-5.6" },
      async () => invalidGraph,
    ));

    const result = await analyzeReconstruction(pipelineInput, test.boundary);
    expect(result.diagnostics.some((diagnostic) => diagnostic.level === "error")).toBe(true);
  });

  it("maps provider failure to one stable error without the raw cause", async () => {
    const test = recorded(new StubProvider(
      { provider: "openai", model: "gpt-5.6" },
      async () => { throw new Error(RAW_ERROR_SENTINEL); },
    ));

    const promise = analyzeReconstruction(pipelineInput, test.boundary);
    await expect(promise).rejects.toBeInstanceOf(ReconstructionPipelineError);
    await expect(promise).rejects.toMatchObject({ code: "AI_UNAVAILABLE" });
    await expect(promise).rejects.not.toHaveProperty("cause");
    await promise.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain(RAW_ERROR_SENTINEL);
    });
  });

  it("rejects provider success when the bound recorder has no terminal metadata", async () => {
    const provider = new StubProvider(
      { provider: "openai", model: "gpt-5.6" },
      async () => intent,
    );
    await expect(analyzeReconstruction(pipelineInput, {
      provider,
      terminal: () => null,
    })).rejects.toBeInstanceOf(AiRecorderError);
  });

  it("does not leak image, safety, or raw provider data through output or metadata", async () => {
    const primary = new StubProvider(
      { provider: "openai", model: "gpt-5.6" },
      async () => intent,
    );
    const test = recorded(primary);
    const result = await analyzeReconstruction(pipelineInput, test.boundary);
    const serialized = JSON.stringify({ result, terminal: test.terminal() });

    expect(serialized).not.toContain(IMAGE_SENTINEL);
    expect(serialized).not.toContain(SAFETY_SENTINEL);
    expect(serialized).not.toContain(RAW_ERROR_SENTINEL);
  });
});

import type { InfrastructureIntent } from "@architect/contracts";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type {
  AiProvider,
  AiTask,
  ArchitectProtocol,
  ArchitectTurnInput,
  ProviderIdentity,
  ReconstructionInput,
} from "../ai/provider.js";
import { createReconstructionProviderRuntime } from "./reconstruction.runtime.js";

class StubProvider implements AiProvider {
  constructor(
    private readonly providerIdentity: ProviderIdentity,
    private readonly output: InfrastructureIntent,
  ) {}
  identity(_task: AiTask) { return this.providerIdentity; }
  async reconstruct(_input: ReconstructionInput) { return this.output; }
  async architect<TInput, TOutputSchema extends z.ZodObject>(
    _input: ArchitectTurnInput<TInput>,
    _protocol: ArchitectProtocol<TInput, TOutputSchema>,
  ): Promise<z.output<TOutputSchema>> { throw new Error("not used"); }
}

const intent: InfrastructureIntent = {
  version: "infrastructure-intent/v1",
  resources: [],
  relationships: [],
};
const baseEnv = {
  NODE_ENV: "test" as const,
  AI_PROVIDER: "openai" as const,
  OPENAI_API_KEY: "fake-openai-key",
  OPENAI_VISION_MODEL: "gpt-5.6",
  OPENAI_AGENT_MODEL: "gpt-5.6",
  ANTHROPIC_API_KEY: "fake-anthropic-key",
  ANTHROPIC_MODEL: "claude-sonnet-4-5",
  AI_PROVIDER_TIMEOUT_MS: 60_000,
  AI_PROVIDER_MAX_RETRIES: 1,
  AI_OUTPUT_REPAIR_ATTEMPTS: 1,
};

describe("reconstruction runtime provider wiring", () => {
  it("seeds the configured primary identity and binds one recorder to failover", async () => {
    const primary = new StubProvider(
      { provider: "openai", model: "gpt-5.6" },
      intent,
    );
    const fallback = new StubProvider(
      { provider: "anthropic", model: "claude-sonnet-4-5" },
      intent,
    );
    const recordTerminal = vi.fn(async () => undefined);
    const runtime = createReconstructionProviderRuntime(baseEnv, {
      createOpenAi: vi.fn(() => primary),
      createAnthropic: vi.fn(() => fallback),
    });

    expect(runtime.primaryIdentity).toEqual({ provider: "openai", model: "gpt-5.6" });
    await runtime.createProvider(recordTerminal).reconstruct({
      traceId: "trace-a",
      safetyIdentifier: "opaque-a",
      imageDataUrl: "data:image/png;base64,AAAA",
    });
    expect(recordTerminal).toHaveBeenCalledOnce();
    expect(recordTerminal).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      model: "gpt-5.6",
      status: "succeeded",
    }));
  });

  it("uses deterministic local reconstruction without a key only in nonproduction", async () => {
    const runtime = createReconstructionProviderRuntime({
      ...baseEnv,
      AI_PROVIDER: "test",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "",
    });
    expect(runtime.primaryIdentity).toEqual({
      provider: "openai",
      model: "deterministic-test",
    });
    await expect(runtime.createProvider(async () => undefined).reconstruct({
      traceId: "trace-a",
      safetyIdentifier: "opaque-a",
      imageDataUrl: "data:image/png;base64,AAAA",
    })).resolves.toMatchObject({ version: "infrastructure-intent/v1" });

    expect(() => createReconstructionProviderRuntime({
      ...baseEnv,
      NODE_ENV: "production",
      AI_PROVIDER: "test",
    })).toThrow("Deterministic AI provider is not available in production");
  });
});

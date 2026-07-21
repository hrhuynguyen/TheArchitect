import { defaultRequirementsProfile } from "@architect/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  AiTimeoutError,
  type AiProvider,
  type ProviderIdentity,
} from "../ai/provider.js";
import { ARCHITECT_PROTOCOL } from "./architect.protocol.js";
import { createArchitectProviderRuntime } from "./architect.runtime.js";

const baseEnv = {
  NODE_ENV: "test" as const,
  AI_PROVIDER: "test" as const,
  OPENAI_API_KEY: "",
  OPENAI_VISION_MODEL: "vision-model",
  OPENAI_AGENT_MODEL: "agent-model",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_MODEL: "",
  AI_PROVIDER_TIMEOUT_MS: 60_000,
  AI_PROVIDER_MAX_RETRIES: 1,
  AI_OUTPUT_REPAIR_ATTEMPTS: 1,
};

const protocolInput = {
  architecture: {
    version: "architecture/v1" as const,
    requirements: defaultRequirementsProfile(),
    resources: [],
    relationships: [],
    decisions: [],
    unresolvedQuestions: [],
  },
  requirements: defaultRequirementsProfile(),
  history: [],
};

function stubProvider(
  identity: ProviderIdentity,
  architect: (input: unknown) => Promise<unknown>,
): AiProvider {
  return {
    identity: () => identity,
    reconstruct: async () => ({
      version: "infrastructure-intent/v1",
      resources: [],
      relationships: [],
    }),
    architect: (async (input, protocol) =>
      protocol.outputSchema.parse(await architect(input))) as AiProvider["architect"],
  };
}

describe("architect provider runtime", () => {
  it("provides deterministic explanation and SQS proposal modes without credentials", async () => {
    const runtime = createArchitectProviderRuntime(baseEnv);
    const terminal = vi.fn(async () => undefined);
    const provider = runtime.createProvider(terminal);

    await expect(provider.architect({
      traceId: "architect-explain",
      safetyIdentifier: "opaque-user",
      input: { ...protocolInput, message: "Explain this architecture." },
    }, ARCHITECT_PROTOCOL)).resolves.toMatchObject({
      kind: "explanation",
      operations: [],
    });
    await expect(provider.architect({
      traceId: "architect-queue",
      safetyIdentifier: "opaque-user",
      input: { ...protocolInput, message: "Add an SQS queue." },
    }, ARCHITECT_PROTOCOL)).resolves.toMatchObject({
      kind: "proposal",
      operations: [{ type: "add_resource", resource: { type: "SQS" } }],
    });
    expect(runtime.primaryIdentity).toEqual({
      provider: "openai",
      model: "deterministic-architect-test",
    });
    expect(terminal).toHaveBeenCalledTimes(2);
  });

  it("never permits the deterministic provider in production", () => {
    expect(() => createArchitectProviderRuntime({
      ...baseEnv,
      NODE_ENV: "production",
    })).toThrow("Deterministic AI provider is not available in production");
  });

  it("uses injected OpenAI as primary and records configured Anthropic fallback terminal metadata", async () => {
    const primary = stubProvider(
      { provider: "openai", model: "openai-architect" },
      async () => { throw new AiTimeoutError("fallback-trace"); },
    );
    const fallback = stubProvider(
      { provider: "anthropic", model: "anthropic-architect" },
      async () => ({
        kind: "explanation",
        responseText: "The fallback explains the current architecture.",
        operations: [],
      }),
    );
    const createOpenAi = vi.fn(() => primary);
    const createAnthropic = vi.fn(() => fallback);
    const runtime = createArchitectProviderRuntime({
      ...baseEnv,
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "configured-openai-key",
      ANTHROPIC_API_KEY: "configured-anthropic-key",
      ANTHROPIC_MODEL: "anthropic-architect",
    }, { createOpenAi, createAnthropic });
    const terminal = vi.fn(async () => undefined);

    await expect(runtime.createProvider(terminal).architect({
      traceId: "fallback-trace",
      safetyIdentifier: "opaque-user",
      input: { ...protocolInput, message: "Explain this architecture." },
    }, ARCHITECT_PROTOCOL)).resolves.toMatchObject({ kind: "explanation" });
    expect(runtime.primaryIdentity).toEqual({
      provider: "openai",
      model: "openai-architect",
    });
    expect(createOpenAi).toHaveBeenCalledOnce();
    expect(createAnthropic).toHaveBeenCalledOnce();
    expect(createOpenAi).toHaveBeenCalledWith(expect.objectContaining({
      architectModel: "agent-model",
      visionModel: "vision-model",
      execution: {
        timeoutMs: 60_000,
        maxRetries: 1,
        outputRepairAttempts: 1,
      },
    }));
    expect(createAnthropic).toHaveBeenCalledWith(expect.objectContaining({
      model: "anthropic-architect",
      execution: {
        timeoutMs: 60_000,
        maxRetries: 1,
        outputRepairAttempts: 1,
      },
    }));
    expect(terminal).toHaveBeenCalledWith({
      traceId: "fallback-trace",
      task: "architect",
      provider: "anthropic",
      model: "anthropic-architect",
      status: "succeeded",
    });
    expect(JSON.stringify(terminal.mock.calls)).not.toContain(
      "configured-openai-key",
    );
    expect(JSON.stringify(terminal.mock.calls)).not.toContain(
      "configured-anthropic-key",
    );
  });

  it("does not construct or invoke an Anthropic fallback when it is unconfigured", async () => {
    const primaryError = new AiTimeoutError("primary-only-trace");
    const primary = stubProvider(
      { provider: "openai", model: "openai-architect" },
      async () => { throw primaryError; },
    );
    const createAnthropic = vi.fn();
    const runtime = createArchitectProviderRuntime({
      ...baseEnv,
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "configured-openai-key",
    }, {
      createOpenAi: () => primary,
      createAnthropic,
    });
    const terminal = vi.fn(async () => undefined);

    await expect(runtime.createProvider(terminal).architect({
      traceId: "primary-only-trace",
      safetyIdentifier: "opaque-user",
      input: { ...protocolInput, message: "Explain this architecture." },
    }, ARCHITECT_PROTOCOL)).rejects.toBe(primaryError);
    expect(createAnthropic).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledWith({
      traceId: "primary-only-trace",
      task: "architect",
      provider: "openai",
      model: "openai-architect",
      status: "failed",
      errorCode: "AI_TIMEOUT",
    });
  });
});

import type { InfrastructureIntent } from "@architect/contracts";
import { z } from "zod";
import { createAnthropicProvider } from "../ai/anthropic.provider.js";
import { createFailoverProvider } from "../ai/failover.js";
import { createOpenAiProvider } from "../ai/openai.provider.js";
import {
  AiConfigurationError,
  type AiProvider,
  type AiRunRecorder,
  type ArchitectProtocol,
  type ArchitectTurnInput,
} from "../ai/provider.js";
import type { ServerEnv } from "../config/env.js";

type ReconstructionProviderEnv = Pick<
  ServerEnv,
  | "NODE_ENV"
  | "AI_PROVIDER"
  | "OPENAI_API_KEY"
  | "OPENAI_VISION_MODEL"
  | "OPENAI_AGENT_MODEL"
  | "ANTHROPIC_API_KEY"
  | "ANTHROPIC_MODEL"
  | "AI_PROVIDER_TIMEOUT_MS"
  | "AI_PROVIDER_MAX_RETRIES"
  | "AI_OUTPUT_REPAIR_ATTEMPTS"
>;

type RuntimeDependencies = Readonly<{
  createOpenAi?: typeof createOpenAiProvider;
  createAnthropic?: typeof createAnthropicProvider;
}>;

function deterministicProvider(): AiProvider {
  const output: InfrastructureIntent = Object.freeze({
    version: "infrastructure-intent/v1",
    resources: [
      Object.freeze({
        id: "sketch-storage",
        type: "S3",
        name: "Sketch storage",
        properties: Object.freeze({}),
      }),
    ],
    relationships: [],
  });
  return Object.freeze({
    identity: () => Object.freeze({
      provider: "openai" as const,
      model: "deterministic-test",
    }),
    reconstruct: async () => output,
    architect: async <TInput, TOutputSchema extends z.ZodObject>(
      input: ArchitectTurnInput<TInput>,
      _protocol: ArchitectProtocol<TInput, TOutputSchema>,
    ): Promise<z.output<TOutputSchema>> => {
      throw new AiConfigurationError(input.traceId);
    },
  });
}

export function createReconstructionProviderRuntime(
  env: ReconstructionProviderEnv,
  dependencies: RuntimeDependencies = {},
) {
  if (env.NODE_ENV === "production" && env.AI_PROVIDER === "test") {
    throw new Error("Deterministic AI provider is not available in production");
  }
  const execution = {
    timeoutMs: env.AI_PROVIDER_TIMEOUT_MS,
    maxRetries: env.AI_PROVIDER_MAX_RETRIES,
    outputRepairAttempts: env.AI_OUTPUT_REPAIR_ATTEMPTS,
  };
  const primary = env.AI_PROVIDER === "test"
    ? deterministicProvider()
    : (dependencies.createOpenAi ?? createOpenAiProvider)({
        apiKey: env.OPENAI_API_KEY,
        visionModel: env.OPENAI_VISION_MODEL,
        architectModel: env.OPENAI_AGENT_MODEL,
        execution,
      });
  const fallback = env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL
    ? (dependencies.createAnthropic ?? createAnthropicProvider)({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL,
        execution,
      })
    : null;
  const primaryIdentity = primary.identity("reconstruct");

  return Object.freeze({
    primaryIdentity,
    createProvider: (recordTerminal: AiRunRecorder) =>
      createFailoverProvider(primary, fallback, { recordTerminal }),
  });
}

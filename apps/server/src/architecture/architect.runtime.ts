import { z } from "zod";

import { createAnthropicProvider } from "../ai/anthropic.provider.js";
import { createFailoverProvider } from "../ai/failover.js";
import { createOpenAiProvider } from "../ai/openai.provider.js";
import {
  AiConfigurationError,
  parseArchitectInput,
  type AiProvider,
  type AiRunRecorder,
  type ArchitectProtocol,
  type ArchitectTurnInput,
} from "../ai/provider.js";
import type { ServerEnv } from "../config/env.js";

type ArchitectProviderEnv = Pick<
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

function messageFrom(input: unknown): string {
  return input !== null
      && typeof input === "object"
      && "message" in input
      && typeof input.message === "string"
    ? input.message
    : "";
}

function deterministicProvider(): AiProvider {
  return Object.freeze({
    identity: () => Object.freeze({
      provider: "openai" as const,
      model: "deterministic-architect-test",
    }),
    reconstruct: async () => {
      throw new AiConfigurationError("architect-reconstruct");
    },
    architect: async <TInput, TOutputSchema extends z.ZodObject>(
      rawInput: ArchitectTurnInput<TInput>,
      protocol: ArchitectProtocol<TInput, TOutputSchema>,
    ): Promise<z.output<TOutputSchema>> => {
      const input = parseArchitectInput(rawInput, protocol);
      const asksForQueue = /\b(?:sqs|queue)\b/i.test(messageFrom(input.input));
      const output = asksForQueue
        ? {
            kind: "proposal",
            responseText: "I can add an SQS queue to buffer asynchronous work.",
            operations: [{
              type: "add_resource",
              resource: {
                id: "architect-orders-queue",
                type: "SQS",
                name: "Orders queue",
                zone: "regional",
                properties: {},
              },
              reason: "Buffer asynchronous work across transient worker failures.",
            }],
          }
        : {
            kind: "explanation",
            responseText: "The current architecture contains the resources and relationships shown on the shared canvas.",
            operations: [],
          };
      return protocol.outputSchema.parse(output);
    },
  });
}

export function createArchitectProviderRuntime(
  env: ArchitectProviderEnv,
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

  return Object.freeze({
    primaryIdentity: primary.identity("architect"),
    createProvider: (recordTerminal: AiRunRecorder) =>
      createFailoverProvider(primary, fallback, { recordTerminal }),
  });
}

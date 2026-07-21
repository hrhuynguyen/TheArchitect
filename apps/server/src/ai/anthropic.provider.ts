import type { InfrastructureIntent } from "@architect/contracts";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import { z } from "zod";
import {
  AiConfigurationError,
  AiOutputError,
  AiProviderError,
  AiRefusalError,
  AiTimeoutError,
  assertStrictObjectSchema,
  parseAiExecutionOptions,
  parseArchitectInput,
  parseReconstructionInput,
  type AiExecutionOptions,
  type AiProvider,
  type AiTask,
  type ArchitectProtocol,
  type ArchitectTurnInput,
  type ProviderIdentity,
  type ReconstructionInput,
} from "./provider.js";
import {
  normalizeReconstructionWire,
  reconstructionWireSchema,
} from "./reconstruction-wire.js";
import {
  ARCHITECT_PROMPT,
  ARCHITECT_REPAIR_PROMPT,
} from "./prompts/architect.js";
import {
  RECONSTRUCTION_PROMPT,
  RECONSTRUCTION_REPAIR_PROMPT,
} from "./prompts/reconstruct.js";

type AnthropicRequestOptions = Readonly<{
  timeout: number;
  maxRetries: number;
}>;

export type AnthropicClient = Readonly<{
  messages: Readonly<{
    parse(
      request: MessageCreateParamsNonStreaming,
      options: AnthropicRequestOptions,
    ): Promise<unknown>;
  }>;
}>;

export type AnthropicProviderOptions = Readonly<{
  apiKey: string;
  model: string;
  execution?: Partial<AiExecutionOptions>;
  client?: AnthropicClient;
}>;

type ParsedResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{ success: false }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputParsed(response: unknown): unknown {
  return isRecord(response) && "parsed_output" in response
    ? response.parsed_output
    : null;
}

function isRefusal(response: unknown): boolean {
  return isRecord(response) && response.stop_reason === "refusal";
}

function isTruncated(response: unknown): boolean {
  return isRecord(response) && response.stop_reason === "max_tokens";
}

function isTransientStatus(status: number | undefined): boolean {
  return (
    status === 408
    || status === 409
    || status === 429
    || (status !== undefined && status >= 500)
  );
}

function isStructuredOutputParseError(error: unknown): boolean {
  return (
    error instanceof Anthropic.AnthropicError
    && Object.getPrototypeOf(error) === Anthropic.AnthropicError.prototype
  );
}

function mapAnthropicError(error: unknown, traceId: string): Error {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiTimeoutError(traceId);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiProviderError(traceId, "AI_PROVIDER_TRANSIENT", true);
  }
  if (error instanceof Anthropic.APIError && isTransientStatus(error.status)) {
    return new AiProviderError(traceId, "AI_PROVIDER_TRANSIENT", true);
  }
  return new AiProviderError(traceId);
}

function createFormat<TOutput>(
  schema: z.ZodType<TOutput>,
  traceId: string,
) {
  try {
    const format = zodOutputFormat(schema);
    assertStrictObjectSchema(format.schema);
    return format;
  } catch {
    throw new AiConfigurationError(traceId);
  }
}

function validatedConfiguration(
  apiKey: string,
  model: string,
  traceId: string,
): void {
  if (apiKey.trim().length === 0 || model.trim().length === 0) {
    throw new AiConfigurationError(traceId);
  }
}

function defaultClient(apiKey: string): AnthropicClient {
  const client = new Anthropic({ apiKey });
  return {
    messages: {
      parse: (request, options) => client.messages.parse(request, options),
    },
  };
}

function withRepairPrompt(
  basePrompt: string,
  repairPrompt: string,
  attempt: number,
): string {
  return attempt === 0 ? basePrompt : `${basePrompt}\n\n${repairPrompt}`;
}

export function createAnthropicProvider({
  apiKey,
  model,
  execution: executionInput,
  client: injectedClient,
}: AnthropicProviderOptions): AiProvider {
  const execution = parseAiExecutionOptions(executionInput);
  let client = injectedClient;
  const getClient = (): AnthropicClient => {
    client ??= defaultClient(apiKey);
    return client;
  };

  const identity = (_task: AiTask): ProviderIdentity =>
    Object.freeze({ provider: "anthropic" as const, model });

  const runStructured = async <TOutput>(
    traceId: string,
    requestForAttempt: (attempt: number) => MessageCreateParamsNonStreaming,
    parseOutput: (output: unknown) => ParsedResult<TOutput>,
  ): Promise<TOutput> => {
    for (
      let attempt = 0;
      attempt <= execution.outputRepairAttempts;
      attempt += 1
    ) {
      let response: unknown;
      try {
        response = await getClient().messages.parse(requestForAttempt(attempt), {
          timeout: execution.timeoutMs,
          maxRetries: execution.maxRetries,
        });
      } catch (error) {
        if (error instanceof z.ZodError || isStructuredOutputParseError(error)) {
          continue;
        }
        throw mapAnthropicError(error, traceId);
      }
      if (isRefusal(response)) throw new AiRefusalError(traceId);
      if (isTruncated(response)) continue;
      try {
        const parsed = parseOutput(outputParsed(response));
        if (parsed.success) return parsed.data;
      } catch {
        // The next bounded iteration is the only output-repair path.
      }
    }
    throw new AiOutputError(traceId);
  };

  const reconstruct = async (
    rawInput: ReconstructionInput,
  ): Promise<InfrastructureIntent> => {
    const input = parseReconstructionInput(rawInput);
    validatedConfiguration(apiKey, model, input.traceId);
    const format = createFormat(reconstructionWireSchema, input.traceId);
    const imageData = input.imageDataUrl.slice("data:image/png;base64,".length);
    return runStructured<InfrastructureIntent>(
      input.traceId,
      (attempt) => ({
        model,
        max_tokens: 4_096,
        metadata: { user_id: input.safetyIdentifier },
        system: RECONSTRUCTION_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: withRepairPrompt(
                  RECONSTRUCTION_PROMPT,
                  RECONSTRUCTION_REPAIR_PROMPT,
                  attempt,
                ),
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: imageData,
                },
              },
            ],
          },
        ],
        output_config: { format },
      }),
      (output): ParsedResult<InfrastructureIntent> => {
        const wire = reconstructionWireSchema.safeParse(output);
        if (!wire.success) return { success: false };
        try {
          return {
            success: true,
            data: normalizeReconstructionWire(wire.data),
          };
        } catch {
          return { success: false };
        }
      },
    );
  };

  const architect = async <TInput, TOutputSchema extends z.ZodObject>(
    rawInput: ArchitectTurnInput<TInput>,
    protocol: ArchitectProtocol<TInput, TOutputSchema>,
  ): Promise<z.output<TOutputSchema>> => {
    const input = parseArchitectInput(rawInput, protocol);
    validatedConfiguration(apiKey, model, input.traceId);
    const format = createFormat(protocol.outputSchema, input.traceId);
    return runStructured<z.output<TOutputSchema>>(
      input.traceId,
      (attempt) => ({
        model,
        max_tokens: 4_096,
        metadata: { user_id: input.safetyIdentifier },
        system: `${ARCHITECT_PROMPT}\n\n${protocol.systemPrompt}`,
        messages: [
          {
            role: "user",
            content: withRepairPrompt(
              input.renderedInput,
              ARCHITECT_REPAIR_PROMPT,
              attempt,
            ),
          },
        ],
        output_config: { format },
      }),
      (output): ParsedResult<z.output<TOutputSchema>> => {
        const result = protocol.outputSchema.safeParse(output);
        return result.success
          ? { success: true, data: result.data }
          : { success: false };
      },
    );
  };

  return Object.freeze({ identity, reconstruct, architect });
}

import type { InfrastructureIntent } from "@architect/contracts";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
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

type OpenAiRequestOptions = Readonly<{
  timeout: number;
  maxRetries: number;
}>;

export type OpenAiClient = Readonly<{
  responses: Readonly<{
    parse(
      request: ResponseCreateParamsNonStreaming,
      options: OpenAiRequestOptions,
    ): Promise<unknown>;
  }>;
}>;

export type OpenAiProviderOptions = Readonly<{
  apiKey: string;
  visionModel: string;
  architectModel: string;
  execution?: Partial<AiExecutionOptions>;
  client?: OpenAiClient;
}>;

type ParsedResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{ success: false }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRefusal(response: unknown): boolean {
  if (!isRecord(response) || !Array.isArray(response.output)) return false;
  return response.output.some(
    (output) =>
      isRecord(output)
      && output.type === "message"
      && Array.isArray(output.content)
      && output.content.some(
        (content) => isRecord(content) && content.type === "refusal",
      ),
  );
}

function outputParsed(response: unknown): unknown {
  return isRecord(response) && "output_parsed" in response
    ? response.output_parsed
    : null;
}

function responseDisposition(
  response: unknown,
  traceId: string,
): "accept" | "repair" {
  if (!isRecord(response) || typeof response.status !== "string") {
    return "accept";
  }
  if (response.status === "completed") return "accept";
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (
      isRecord(details)
      && details.reason === "content_filter"
    ) {
      throw new AiRefusalError(traceId);
    }
    return "repair";
  }
  if (response.status === "failed") {
    const error = response.error;
    const code = isRecord(error) && typeof error.code === "string"
      ? error.code
      : "unknown";
    if (code === "bio_policy" || code === "image_content_policy_violation") {
      throw new AiRefusalError(traceId);
    }
    if (code === "vector_store_timeout") {
      throw new AiTimeoutError(traceId);
    }
    if (code === "server_error" || code === "rate_limit_exceeded") {
      throw new AiProviderError(traceId, "AI_PROVIDER_TRANSIENT", true);
    }
    throw new AiProviderError(traceId);
  }
  throw new AiProviderError(traceId);
}

function isTransientStatus(status: number | undefined): boolean {
  return (
    status === 408
    || status === 409
    || status === 429
    || (status !== undefined && status >= 500)
  );
}

function mapOpenAiError(error: unknown, traceId: string): Error {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiTimeoutError(traceId);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new AiProviderError(traceId, "AI_PROVIDER_TRANSIENT", true);
  }
  if (error instanceof OpenAI.APIError && isTransientStatus(error.status)) {
    return new AiProviderError(traceId, "AI_PROVIDER_TRANSIENT", true);
  }
  return new AiProviderError(traceId);
}

function createFormat<TOutput>(
  schema: z.ZodType<TOutput>,
  name: string,
  traceId: string,
) {
  try {
    const format = zodTextFormat(schema, name);
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

function defaultClient(apiKey: string): OpenAiClient {
  const client = new OpenAI({ apiKey });
  return {
    responses: {
      parse: (request, options) => client.responses.parse(request, options),
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

export function createOpenAiProvider({
  apiKey,
  visionModel,
  architectModel,
  execution: executionInput,
  client: injectedClient,
}: OpenAiProviderOptions): AiProvider {
  const execution = parseAiExecutionOptions(executionInput);
  let client = injectedClient;
  const getClient = (): OpenAiClient => {
    client ??= defaultClient(apiKey);
    return client;
  };

  const identity = (task: AiTask): ProviderIdentity =>
    Object.freeze({
      provider: "openai" as const,
      model: task === "reconstruct" ? visionModel : architectModel,
    });

  const runStructured = async <TOutput>(
    traceId: string,
    requestForAttempt: (attempt: number) => ResponseCreateParamsNonStreaming,
    parseOutput: (output: unknown) => ParsedResult<TOutput>,
  ): Promise<TOutput> => {
    for (
      let attempt = 0;
      attempt <= execution.outputRepairAttempts;
      attempt += 1
    ) {
      let response: unknown;
      try {
        response = await getClient().responses.parse(requestForAttempt(attempt), {
          timeout: execution.timeoutMs,
          maxRetries: execution.maxRetries,
        });
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof z.ZodError) {
          continue;
        }
        throw mapOpenAiError(error, traceId);
      }
      if (hasRefusal(response)) throw new AiRefusalError(traceId);
      if (responseDisposition(response, traceId) === "repair") continue;
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
    validatedConfiguration(apiKey, visionModel, input.traceId);
    const format = createFormat(
      reconstructionWireSchema,
      "infrastructure_intent",
      input.traceId,
    );
    return runStructured<InfrastructureIntent>(
      input.traceId,
      (attempt) => ({
        model: visionModel,
        safety_identifier: input.safetyIdentifier,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: withRepairPrompt(
                  RECONSTRUCTION_PROMPT,
                  RECONSTRUCTION_REPAIR_PROMPT,
                  attempt,
                ),
              },
              {
                type: "input_image",
                image_url: input.imageDataUrl,
                detail: "high",
              },
            ],
          },
        ],
        text: { format },
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
    validatedConfiguration(apiKey, architectModel, input.traceId);
    const format = createFormat(
      protocol.outputSchema,
      protocol.name,
      input.traceId,
    );
    return runStructured<z.output<TOutputSchema>>(
      input.traceId,
      (attempt) => ({
        model: architectModel,
        safety_identifier: input.safetyIdentifier,
        input: [
          {
            role: "system",
            content: `${ARCHITECT_PROMPT}\n\n${protocol.systemPrompt}`,
          },
          {
            role: "user",
            content: withRepairPrompt(
              input.renderedInput,
              ARCHITECT_REPAIR_PROMPT,
              attempt,
            ),
          },
        ],
        text: { format },
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

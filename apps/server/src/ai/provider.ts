import type { InfrastructureIntent } from "@architect/contracts";
import { z } from "zod";

export const DEFAULT_AI_EXECUTION_OPTIONS = Object.freeze({
  timeoutMs: 60_000,
  maxRetries: 1,
  outputRepairAttempts: 1,
});

const aiExecutionOptionsSchema = z.strictObject({
  timeoutMs: z.number().finite().int().min(1_000).max(120_000),
  maxRetries: z.number().finite().int().min(0).max(2),
  outputRepairAttempts: z.number().finite().int().min(0).max(2),
});

const commonAiInputSchema = z.strictObject({
  traceId: z.string().trim().min(1).max(128),
  safetyIdentifier: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\x21-\x7e]+$/),
});

const reconstructionInputShapeSchema = commonAiInputSchema.extend({
  imageDataUrl: z.string().min(1),
});

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type AiTask = "reconstruct" | "architect";
export type AiProviderName = "openai" | "anthropic";

export type ProviderIdentity = Readonly<{
  provider: AiProviderName;
  model: string;
}>;

export type AiExecutionOptions = Readonly<{
  timeoutMs: number;
  maxRetries: number;
  outputRepairAttempts: number;
}>;

export type ReconstructionInput = Readonly<{
  traceId: string;
  safetyIdentifier: string;
  imageDataUrl: string;
}>;

export type ArchitectTurnInput<TInput> = Readonly<{
  traceId: string;
  safetyIdentifier: string;
  input: TInput;
}>;

export type ArchitectProtocol<TInput, TOutput> = Readonly<{
  name: string;
  systemPrompt: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  renderInput(input: TInput): string;
}>;

export type ParsedArchitectInput<TInput> = Readonly<{
  traceId: string;
  safetyIdentifier: string;
  input: TInput;
  renderedInput: string;
}>;

export interface AiProvider {
  identity(task: AiTask): ProviderIdentity;
  reconstruct(input: ReconstructionInput): Promise<InfrastructureIntent>;
  architect<TInput, TOutput>(
    input: ArchitectTurnInput<TInput>,
    protocol: ArchitectProtocol<TInput, TOutput>,
  ): Promise<TOutput>;
}

export type AiRunTerminalMetadata = Readonly<{
  traceId: string;
  task: AiTask;
  provider: AiProviderName;
  model: string;
  status: "succeeded" | "failed";
  errorCode?: AiSafeErrorCode;
}>;

export type AiRunRecorder = (
  metadata: AiRunTerminalMetadata,
) => Promise<void>;

export type AiSafeErrorCode =
  | "AI_TIMEOUT"
  | "AI_REFUSAL"
  | "AI_PROVIDER_ERROR"
  | "AI_PROVIDER_TRANSIENT"
  | "AI_OUTPUT_INVALID"
  | "AI_INPUT_INVALID"
  | "AI_CONFIGURATION_ERROR"
  | "AI_RECORDER_ERROR"
  | "AI_UNKNOWN_ERROR";

export class AiError extends Error {
  protected constructor(
    name: string,
    readonly code: Exclude<AiSafeErrorCode, "AI_UNKNOWN_ERROR">,
    message: string,
    readonly traceId: string,
    readonly fallbackEligible: boolean,
  ) {
    super(message);
    this.name = name;
  }
}

export class AiTimeoutError extends AiError {
  constructor(traceId: string) {
    super(
      "AiTimeoutError",
      "AI_TIMEOUT",
      "The AI provider request timed out.",
      traceId,
      true,
    );
  }
}

export class AiRefusalError extends AiError {
  constructor(traceId: string) {
    super(
      "AiRefusalError",
      "AI_REFUSAL",
      "The AI provider declined the request.",
      traceId,
      true,
    );
  }
}

export class AiProviderError extends AiError {
  constructor(
    traceId: string,
    code: "AI_PROVIDER_ERROR" | "AI_PROVIDER_TRANSIENT" =
      "AI_PROVIDER_ERROR",
    fallbackEligible = code === "AI_PROVIDER_TRANSIENT",
  ) {
    super(
      "AiProviderError",
      code,
      "The AI provider request failed.",
      traceId,
      code === "AI_PROVIDER_TRANSIENT" && fallbackEligible,
    );
  }
}

export class AiOutputError extends AiError {
  constructor(traceId: string) {
    super(
      "AiOutputError",
      "AI_OUTPUT_INVALID",
      "The AI provider returned invalid structured output.",
      traceId,
      true,
    );
  }
}

export class AiInputError extends AiError {
  constructor(traceId: string) {
    super(
      "AiInputError",
      "AI_INPUT_INVALID",
      "The AI request input was invalid.",
      traceId,
      false,
    );
  }
}

export class AiConfigurationError extends AiError {
  constructor(traceId = "configuration") {
    super(
      "AiConfigurationError",
      "AI_CONFIGURATION_ERROR",
      "The AI provider configuration was invalid.",
      traceId,
      false,
    );
  }
}

export class AiRecorderError extends AiError {
  constructor(traceId: string) {
    super(
      "AiRecorderError",
      "AI_RECORDER_ERROR",
      "The AI run could not be recorded.",
      traceId,
      false,
    );
  }
}

export function safeErrorCode(error: unknown): AiSafeErrorCode {
  return error instanceof AiError ? error.code : "AI_UNKNOWN_ERROR";
}

export function parseAiExecutionOptions(
  input: Partial<AiExecutionOptions> = {},
): AiExecutionOptions {
  const result = aiExecutionOptionsSchema.safeParse({
    ...DEFAULT_AI_EXECUTION_OPTIONS,
    ...input,
  });
  if (!result.success) throw new AiConfigurationError();
  return Object.freeze(result.data);
}

function isValidPngDataUrl(value: string): boolean {
  if (!value.startsWith(PNG_DATA_URL_PREFIX)) return false;
  const encoded = value.slice(PNG_DATA_URL_PREFIX.length);
  if (!canonicalBase64.test(encoded)) return false;
  const decoded = Buffer.from(encoded, "base64");
  return (
    decoded.length >= PNG_SIGNATURE.length &&
    decoded.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

export function parseReconstructionInput(input: unknown): ReconstructionInput {
  const result = reconstructionInputShapeSchema.safeParse(input);
  const traceId =
    input && typeof input === "object" && "traceId" in input
      && typeof input.traceId === "string"
      ? input.traceId
      : "unknown";
  if (!result.success || !isValidPngDataUrl(result.data.imageDataUrl)) {
    throw new AiInputError(traceId);
  }
  return Object.freeze(result.data);
}

export function parseArchitectInput<TInput, TOutput>(
  input: ArchitectTurnInput<TInput>,
  protocol: ArchitectProtocol<TInput, TOutput>,
): ParsedArchitectInput<TInput> {
  const common = commonAiInputSchema.safeParse({
    traceId: input.traceId,
    safetyIdentifier: input.safetyIdentifier,
  });
  if (!common.success) throw new AiInputError(input.traceId || "unknown");
  const parsedInput = protocol.inputSchema.safeParse(input.input);
  if (!parsedInput.success) throw new AiInputError(common.data.traceId);
  if (
    !/^[a-z][a-z0-9_]{0,63}$/.test(protocol.name)
    || protocol.systemPrompt.length < 1
    || protocol.systemPrompt.length > 16_000
  ) {
    throw new AiConfigurationError(common.data.traceId);
  }
  let renderedInput: string;
  try {
    renderedInput = protocol.renderInput(parsedInput.data);
  } catch {
    throw new AiConfigurationError(common.data.traceId);
  }
  if (renderedInput.length < 1 || renderedInput.length > 100_000) {
    throw new AiInputError(common.data.traceId);
  }
  return Object.freeze({
    ...common.data,
    input: parsedInput.data,
    renderedInput,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertStrictObjectSchema(schema: unknown): void {
  if (!isRecord(schema) || schema.type !== "object") {
    throw new AiConfigurationError();
  }
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value) || visited.has(value)) return;
    visited.add(value);
    if (value.type === "object" && value.additionalProperties !== false) {
      throw new AiConfigurationError();
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(schema);
}

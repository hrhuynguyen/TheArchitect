import {
  ReconstructionAnalysisSchema,
  RequirementsProfileSchema,
  type ReconstructionAnalysis,
  type RequirementsProfile,
} from "@architect/contracts";
import { compileIntent } from "@architect/infra";
import { z } from "zod";
import {
  AiRecorderError,
  type AiProvider,
  type AiRunTerminalMetadata,
} from "../ai/provider.js";
import { validateReconstructionPng } from "./png.js";

const pipelineInputSchema = z.strictObject({
  aiTraceId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  safetyIdentifier: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\x21-\x7e]+$/),
  imageDataUrl: z.string().min(1),
  mimeType: z.literal("image/png"),
  requirements: RequirementsProfileSchema,
});

export type ReconstructionPipelineInput = Readonly<{
  aiTraceId: string;
  safetyIdentifier: string;
  imageDataUrl: string;
  mimeType: "image/png";
  requirements: RequirementsProfile;
}>;

export type RecordedReconstructionProvider = Readonly<{
  provider: AiProvider;
  terminal(): AiRunTerminalMetadata | null;
}>;

type ReconstructionPipelineErrorCode =
  | "AI_UNAVAILABLE"
  | "RECONSTRUCTION_FAILED";

const PIPELINE_MESSAGES: Record<ReconstructionPipelineErrorCode, string> = {
  AI_UNAVAILABLE: "Architecture reconstruction is temporarily unavailable.",
  RECONSTRUCTION_FAILED: "Architecture reconstruction could not be completed.",
};

export class ReconstructionPipelineError extends Error {
  constructor(readonly code: ReconstructionPipelineErrorCode) {
    super(PIPELINE_MESSAGES[code]);
    this.name = "ReconstructionPipelineError";
  }
}

function assertSuccessfulTerminal(
  terminal: AiRunTerminalMetadata | null,
  traceId: string,
): asserts terminal is AiRunTerminalMetadata & { status: "succeeded" } {
  if (
    !terminal ||
    terminal.traceId !== traceId ||
    terminal.task !== "reconstruct" ||
    terminal.status !== "succeeded"
  ) throw new AiRecorderError(traceId);
}

export async function analyzeReconstruction(
  inputValue: ReconstructionPipelineInput,
  recordedProvider: RecordedReconstructionProvider,
): Promise<ReconstructionAnalysis> {
  const input = pipelineInputSchema.parse(inputValue);
  const png = validateReconstructionPng(input);

  let intent;
  try {
    intent = await recordedProvider.provider.reconstruct({
      traceId: input.aiTraceId,
      safetyIdentifier: input.safetyIdentifier,
      imageDataUrl: png.imageDataUrl,
    });
  } catch (error) {
    if (error instanceof AiRecorderError) throw error;
    throw new ReconstructionPipelineError("AI_UNAVAILABLE");
  }

  const terminal = recordedProvider.terminal();
  assertSuccessfulTerminal(terminal, input.aiTraceId);
  try {
    const compiled = compileIntent(intent, input.requirements);
    return ReconstructionAnalysisSchema.parse({
      provider: {
        provider: terminal.provider,
        model: terminal.model,
      },
      intent,
      diagnostics: compiled.diagnostics,
      stageDecision: compiled.stageDecision,
      deploymentPlan: compiled.deploymentPlan,
    });
  } catch {
    throw new ReconstructionPipelineError("RECONSTRUCTION_FAILED");
  }
}

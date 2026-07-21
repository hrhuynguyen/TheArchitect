import { z } from "zod";
import {
  architectureSchema,
  deploymentPlanSchema,
  diagnosticSchema,
  infrastructureIntentSchema,
  stageDecisionSchema,
} from "@architect/contracts/infrastructure";
import { RequirementsProfileSchema } from "@architect/contracts/requirements";

export const PNG_DATA_URL_PREFIX = "data:image/png;base64," as const;
export const MAX_PNG_BASE64_CHARS = 6_990_508 as const;
export const MAX_RECONSTRUCTION_DATA_URL_CHARS =
  PNG_DATA_URL_PREFIX.length + MAX_PNG_BASE64_CHARS;
export const ARCHITECTURE_MAP_KEY = "architecture" as const;
export const ARCHITECTURE_LAYOUT_MAP_KEY = "architecture-layout" as const;
export const ARCHITECTURE_CURRENT_KEY = "current" as const;

const identifierSchema = z.string().trim().min(1).max(200);
const traceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const reconstructionProviderSchema = z
  .object({
    provider: z.enum(["openai", "anthropic"]),
    model: z.string().trim().min(1).max(200),
  })
  .strict();
export const ReconstructionProviderSchema = reconstructionProviderSchema;
export type ReconstructionProvider = z.infer<
  typeof reconstructionProviderSchema
>;

const reconstructionRequestFields = {
  imageDataUrl: z
    .string()
    .min(PNG_DATA_URL_PREFIX.length + 1)
    .max(MAX_RECONSTRUCTION_DATA_URL_CHARS),
  mimeType: z.literal("image/png"),
  requirements: RequirementsProfileSchema,
} as const;

export const reconstructionRequestSchema = z
  .object({
    ...reconstructionRequestFields,
    sourceSnapshotVersion: z.number().int().nonnegative(),
  })
  .strict();
export const ReconstructionRequestSchema = reconstructionRequestSchema;
export type ReconstructionRequest = z.infer<
  typeof reconstructionRequestSchema
>;

export const debugReconstructionRequestSchema = z
  .object(reconstructionRequestFields)
  .strict();
export const DebugReconstructionRequestSchema =
  debugReconstructionRequestSchema;
export type DebugReconstructionRequest = z.infer<
  typeof debugReconstructionRequestSchema
>;

export const reconstructionAnalysisSchema = z
  .object({
    provider: reconstructionProviderSchema,
    intent: infrastructureIntentSchema,
    diagnostics: z.array(diagnosticSchema).max(2_000),
    stageDecision: stageDecisionSchema,
    deploymentPlan: deploymentPlanSchema,
  })
  .strict();
export const ReconstructionAnalysisSchema = reconstructionAnalysisSchema;
export type ReconstructionAnalysis = z.infer<
  typeof reconstructionAnalysisSchema
>;

export const reconstructionResultSchema = reconstructionAnalysisSchema
  .extend({
    traceId: traceIdSchema,
    architectureRevisionId: identifierSchema,
  })
  .strict();
export const ReconstructionResultSchema = reconstructionResultSchema;
export type ReconstructionResult = z.infer<typeof reconstructionResultSchema>;

export const reconstructionPublicErrorSchema = z
  .object({
    code: z.enum([
      "AI_UNAVAILABLE",
      "RECONSTRUCTION_INVALID",
      "RECONSTRUCTION_FAILED",
    ]),
    message: z.string().trim().min(1).max(240),
  })
  .strict();
export const ReconstructionPublicErrorSchema =
  reconstructionPublicErrorSchema;
export type ReconstructionPublicError = z.infer<
  typeof reconstructionPublicErrorSchema
>;

const reconstructionJobBaseSchema = z.object({
  jobId: identifierSchema,
  sourceSnapshotVersion: z.number().int().nonnegative(),
});
const inFlightJobSchema = (state: "claimed" | "running" | "publishing") =>
  reconstructionJobBaseSchema
    .extend({
      state: z.literal(state),
      result: z.null(),
      error: z.null(),
    })
    .strict();

export const reconstructionJobEnvelopeSchema = z.discriminatedUnion("state", [
  inFlightJobSchema("claimed"),
  inFlightJobSchema("running"),
  inFlightJobSchema("publishing"),
  reconstructionJobBaseSchema
    .extend({
      state: z.literal("succeeded"),
      result: reconstructionResultSchema,
      error: z.null(),
    })
    .strict(),
  reconstructionJobBaseSchema
    .extend({
      state: z.literal("failed"),
      result: z.null(),
      error: reconstructionPublicErrorSchema,
    })
    .strict(),
]);
export const ReconstructionJobEnvelopeSchema =
  reconstructionJobEnvelopeSchema;
export type ReconstructionJobEnvelope = z.infer<
  typeof reconstructionJobEnvelopeSchema
>;

export const architectureLayoutNodeSchema = z
  .object({
    resourceId: z.string().trim().min(1).max(120),
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

export const workingArchitectureSchema = z
  .object({
    version: z.literal("working-architecture/v1"),
    revisionId: identifierSchema,
    architecture: architectureSchema,
  })
  .strict();
export const WorkingArchitectureSchema = workingArchitectureSchema;
export type WorkingArchitecture = z.infer<typeof workingArchitectureSchema>;

export const architectureLayoutSchema = z
  .object({
    version: z.literal("architecture-layout/v1"),
    revisionId: identifierSchema,
    nodes: z.array(architectureLayoutNodeSchema).max(400),
  })
  .strict()
  .superRefine((layout, context) => {
    const resourceIds = new Set<string>();
    for (const [index, node] of layout.nodes.entries()) {
      if (resourceIds.has(node.resourceId)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "resourceId"],
          message: `Duplicate layout resource id: ${node.resourceId}`,
        });
      }
      resourceIds.add(node.resourceId);
    }
  });
export const ArchitectureLayoutSchema = architectureLayoutSchema;
export type ArchitectureLayout = z.infer<typeof architectureLayoutSchema>;

export const reconstructionYjsStateSchema = z
  .object({
    architecture: workingArchitectureSchema,
    layout: architectureLayoutSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.architecture.revisionId !== state.layout.revisionId) {
      context.addIssue({
        code: "custom",
        path: ["layout", "revisionId"],
        message: "Architecture and layout revision identifiers must match.",
      });
    }
  });
export const ReconstructionYjsStateSchema = reconstructionYjsStateSchema;
export type ReconstructionYjsState = z.infer<
  typeof reconstructionYjsStateSchema
>;

export const debugReconstructionResponseSchema = reconstructionAnalysisSchema
  .extend({ semanticGraph: architectureSchema })
  .strict();
export const DebugReconstructionResponseSchema =
  debugReconstructionResponseSchema;
export type DebugReconstructionResponse = z.infer<
  typeof debugReconstructionResponseSchema
>;

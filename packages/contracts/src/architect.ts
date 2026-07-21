import { z } from "zod";

import {
  architectureRelationshipKindSchema,
  awsResourceTypeSchema,
  infrastructureZoneSchema,
  resourcePropertiesSchema,
} from "@architect/contracts/infrastructure";
import { destructiveConfirmationSchema } from "@architect/contracts/operations";

const identifierSchema = z.string().trim().min(1).max(200);
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const rationaleSchema = z.string().trim().min(1).max(500);
const responseTextSchema = z.string().trim().min(1).max(8_000);
const timestampSchema = z.iso.datetime({ offset: true });

const proposedResourceSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    type: awsResourceTypeSchema,
    name: z.string().trim().min(1).max(120),
    zone: infrastructureZoneSchema.optional(),
    properties: resourcePropertiesSchema,
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

const proposedResourceChangesSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    zone: infrastructureZoneSchema.nullable().optional(),
    properties: resourcePropertiesSchema.optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "An update must change at least one resource field.",
  });

const proposedRelationshipSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    sourceId: z.string().trim().min(1).max(120),
    targetId: z.string().trim().min(1).max(120),
    kind: architectureRelationshipKindSchema,
    label: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const architectOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("add_resource"),
      resource: proposedResourceSchema,
      reason: rationaleSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("update_resource"),
      resourceId: z.string().trim().min(1).max(120),
      changes: proposedResourceChangesSchema,
      reason: rationaleSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("remove_resource"),
      resourceId: z.string().trim().min(1).max(120),
      reason: rationaleSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("add_relationship"),
      relationship: proposedRelationshipSchema,
      reason: rationaleSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("remove_relationship"),
      relationshipId: z.string().trim().min(1).max(200),
      reason: rationaleSchema,
    })
    .strict(),
]);
export const ArchitectOperationSchema = architectOperationSchema;
export type ArchitectOperation = z.infer<typeof architectOperationSchema>;

const architectOperationBatchSchema = z
  .array(architectOperationSchema)
  .min(1)
  .max(200);

export const architectProviderOutputSchema = z
  .object({
    kind: z.enum(["explanation", "proposal"]),
    responseText: responseTextSchema,
    operations: z.array(architectOperationSchema).max(200),
  })
  .strict()
  .superRefine((output, context) => {
    if (output.kind === "explanation" && output.operations.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Explanations cannot propose graph operations.",
      });
    }
    if (output.kind === "proposal" && output.operations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Proposals must contain at least one graph operation.",
      });
    }
  });
export const ArchitectProviderOutputSchema = architectProviderOutputSchema;
export type ArchitectProviderOutput = z.infer<
  typeof architectProviderOutputSchema
>;

export const architectTurnRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(4_000),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export const ArchitectTurnRequestSchema = architectTurnRequestSchema;
export type ArchitectTurnRequest = z.infer<typeof architectTurnRequestSchema>;

export const applyArchitectPatchRequestSchema = z
  .object({
    baseRevisionId: identifierSchema,
    idempotencyKey: idempotencyKeySchema,
    rationale: rationaleSchema,
    destructiveConfirmation: destructiveConfirmationSchema.optional(),
  })
  .strict();
export const ApplyArchitectPatchRequestSchema =
  applyArchitectPatchRequestSchema;
export type ApplyArchitectPatchRequest = z.infer<
  typeof applyArchitectPatchRequestSchema
>;

export const rejectArchitectPatchRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    rationale: rationaleSchema,
  })
  .strict();
export const RejectArchitectPatchRequestSchema =
  rejectArchitectPatchRequestSchema;
export type RejectArchitectPatchRequest = z.infer<
  typeof rejectArchitectPatchRequestSchema
>;

export const architectTurnErrorSchema = z
  .object({
    code: z.enum([
      "AI_UNAVAILABLE",
      "INVALID_AGENT_PATCH",
      "ARCHITECT_FAILED",
      "TURN_INTERRUPTED",
    ]),
    message: z.string().trim().min(1).max(240),
  })
  .strict();
export type ArchitectTurnError = z.infer<typeof architectTurnErrorSchema>;

const turnBaseFields = {
  id: identifierSchema,
  roomId: identifierSchema,
  baseRevisionId: identifierSchema,
  message: z.string().trim().min(1).max(4_000),
  actorType: z.enum(["participant", "owner"]),
  actorId: identifierSchema,
  idempotencyKey: idempotencyKeySchema,
  sourceSnapshotVersion: z.number().int().nonnegative(),
  sourceProtectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  traceId: identifierSchema,
  createdAt: timestampSchema,
} as const;

const unreviewedFields = {
  reviewedAt: z.null(),
  reviewedByParticipantId: z.null(),
  reviewRationale: z.null(),
} as const;

const architectTurnThinkingSchema = z
  .object({
    ...turnBaseFields,
    state: z.literal("thinking"),
    kind: z.null(),
    responseText: z.null(),
    operations: z.array(architectOperationSchema).max(0),
    appliedRevisionId: z.null(),
    error: z.null(),
    ...unreviewedFields,
  })
  .strict();

const architectTurnAnsweredSchema = z
  .object({
    ...turnBaseFields,
    state: z.literal("answered"),
    kind: z.literal("explanation"),
    responseText: responseTextSchema,
    operations: z.array(architectOperationSchema).max(0),
    appliedRevisionId: z.null(),
    error: z.null(),
    ...unreviewedFields,
  })
  .strict();

const proposalFields = {
  ...turnBaseFields,
  kind: z.literal("proposal"),
  responseText: responseTextSchema,
  operations: architectOperationBatchSchema,
  error: z.null(),
} as const;

const architectTurnProposalReadySchema = z
  .object({
    ...proposalFields,
    state: z.literal("proposal_ready"),
    appliedRevisionId: z.null(),
    ...unreviewedFields,
  })
  .strict();

const reviewedFields = {
  reviewedAt: timestampSchema,
  reviewedByParticipantId: identifierSchema,
  reviewRationale: rationaleSchema,
} as const;

const architectTurnAppliedSchema = z
  .object({
    ...proposalFields,
    state: z.literal("applied"),
    appliedRevisionId: identifierSchema,
    ...reviewedFields,
  })
  .strict();

const architectTurnRejectedSchema = z
  .object({
    ...proposalFields,
    state: z.literal("rejected"),
    appliedRevisionId: z.null(),
    ...reviewedFields,
  })
  .strict();

const architectTurnFailedSchema = z
  .object({
    ...turnBaseFields,
    state: z.literal("failed"),
    kind: z.null(),
    responseText: z.null(),
    operations: z.array(architectOperationSchema).max(0),
    appliedRevisionId: z.null(),
    error: architectTurnErrorSchema,
    ...unreviewedFields,
  })
  .strict();

export const architectTurnSchema = z.discriminatedUnion("state", [
  architectTurnThinkingSchema,
  architectTurnAnsweredSchema,
  architectTurnProposalReadySchema,
  architectTurnAppliedSchema,
  architectTurnRejectedSchema,
  architectTurnFailedSchema,
]);
export const ArchitectTurnSchema = architectTurnSchema;
export type ArchitectTurn = z.infer<typeof architectTurnSchema>;

export const architectTurnListSchema = z
  .object({ turns: z.array(architectTurnSchema).max(500) })
  .strict();
export const ArchitectTurnListSchema = architectTurnListSchema;
export type ArchitectTurnList = z.infer<typeof architectTurnListSchema>;

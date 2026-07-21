import { z } from "zod";

import {
  approvalStatusSchema,
  architectureRelationshipSchema,
  architectureResourceSchema,
  infrastructureZoneSchema,
  resourcePropertiesSchema,
} from "@architect/contracts/infrastructure";

export const destructiveConfirmationSchema = z
  .object({
    confirmed: z.literal(true),
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();
export const DestructiveConfirmationSchema = destructiveConfirmationSchema;
export type DestructiveConfirmation = z.infer<
  typeof destructiveConfirmationSchema
>;

const addResourceOperationSchema = z
  .object({
    type: z.literal("add_resource"),
    resource: architectureResourceSchema,
  })
  .strict();

const resourceChangesSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    zone: infrastructureZoneSchema.nullable().optional(),
    properties: resourcePropertiesSchema.optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "An update must change at least one resource field.",
  });

const updateResourceOperationSchema = z
  .object({
    type: z.literal("update_resource"),
    resourceId: z.string().trim().min(1).max(120),
    changes: resourceChangesSchema,
  })
  .strict();

const removeResourceOperationSchema = z
  .object({
    type: z.literal("remove_resource"),
    resourceId: z.string().trim().min(1).max(120),
    confirmation: destructiveConfirmationSchema,
  })
  .strict();

const addRelationshipOperationSchema = z
  .object({
    type: z.literal("add_relationship"),
    relationship: architectureRelationshipSchema,
  })
  .strict();

const removeRelationshipOperationSchema = z
  .object({
    type: z.literal("remove_relationship"),
    relationshipId: z.string().trim().min(1).max(200),
    confirmation: destructiveConfirmationSchema,
  })
  .strict();

const setResourceApprovalOperationSchema = z
  .object({
    type: z.literal("set_resource_approval"),
    resourceId: z.string().trim().min(1).max(120),
    approvalStatus: approvalStatusSchema.extract(["approved", "rejected"]),
  })
  .strict();

export const graphOperationSchema = z.discriminatedUnion("type", [
  addResourceOperationSchema,
  updateResourceOperationSchema,
  removeResourceOperationSchema,
  addRelationshipOperationSchema,
  removeRelationshipOperationSchema,
  setResourceApprovalOperationSchema,
]);
export const GraphOperationSchema = graphOperationSchema;
export type GraphOperation = z.infer<typeof graphOperationSchema>;

export const graphOperationBatchSchema = z
  .array(graphOperationSchema)
  .min(1)
  .max(200);
export const GraphOperationBatchSchema = graphOperationBatchSchema;
export type GraphOperationBatch = z.infer<typeof graphOperationBatchSchema>;

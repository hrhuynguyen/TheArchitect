import { z } from "zod";

import { RequirementsProfileSchema } from "@architect/contracts/requirements";

export const AWS_RESOURCE_TYPES = [
  "External",
  "EC2",
  "S3",
  "Lambda",
  "RDS",
  "DynamoDB",
  "VPC",
  "Subnet",
  "SecurityGroup",
  "InternetGateway",
  "NatGateway",
  "RouteTable",
  "APIGateway",
  "SNS",
  "SQS",
  "IAMRole",
  "CloudFront",
  "ELB",
  "MSK",
] as const;

export const awsResourceTypeSchema = z.enum(AWS_RESOURCE_TYPES);
export type AwsResourceType = z.infer<typeof awsResourceTypeSchema>;

export const infrastructureZoneSchema = z.enum([
  "edge",
  "public",
  "private",
  "data",
  "regional",
]);
export type InfrastructureZone = z.infer<typeof infrastructureZoneSchema>;

export const resourcePropertyValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);
export const resourcePropertiesSchema = z.record(
  z.string().min(1),
  resourcePropertyValueSchema,
);

const intentResourceFields = {
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  count: z.number().int().min(1).max(20).optional(),
  zone: infrastructureZoneSchema.optional(),
  properties: resourcePropertiesSchema,
} as const;

function intentResourceFor<TType extends AwsResourceType>(type: TType) {
  return z.object({ type: z.literal(type), ...intentResourceFields }).strict();
}

export const infrastructureIntentResourceSchema = z.discriminatedUnion("type", [
  intentResourceFor("External"),
  intentResourceFor("EC2"),
  intentResourceFor("S3"),
  intentResourceFor("Lambda"),
  intentResourceFor("RDS"),
  intentResourceFor("DynamoDB"),
  intentResourceFor("VPC"),
  intentResourceFor("Subnet"),
  intentResourceFor("SecurityGroup"),
  intentResourceFor("InternetGateway"),
  intentResourceFor("NatGateway"),
  intentResourceFor("RouteTable"),
  intentResourceFor("APIGateway"),
  intentResourceFor("SNS"),
  intentResourceFor("SQS"),
  intentResourceFor("IAMRole"),
  intentResourceFor("CloudFront"),
  intentResourceFor("ELB"),
  intentResourceFor("MSK"),
]);
export type InfrastructureIntentResource = z.infer<
  typeof infrastructureIntentResourceSchema
>;

export const architectureRelationshipKindSchema = z.enum([
  "connects",
  "routes",
  "contains",
  "hosts",
  "protects",
  "publishes",
  "subscribes",
  "invokes",
  "reads",
  "writes",
  "assumes",
  "gateway",
  "egress",
]);
export type ArchitectureRelationshipKind = z.infer<
  typeof architectureRelationshipKindSchema
>;

export const infrastructureIntentRelationshipSchema = z
  .object({
    id: z.string().trim().min(1).max(160).optional(),
    sourceId: z.string().trim().min(1).max(120),
    targetId: z.string().trim().min(1).max(120),
    kind: architectureRelationshipKindSchema,
    label: z.string().trim().min(1).max(120).optional(),
    direction: z.enum(["forward", "bidirectional"]).optional(),
  })
  .strict();
export type InfrastructureIntentRelationship = z.infer<
  typeof infrastructureIntentRelationshipSchema
>;

export const infrastructureIntentSchema = z
  .object({
    version: z.literal("infrastructure-intent/v1"),
    resources: z.array(infrastructureIntentResourceSchema).max(200),
    relationships: z.array(infrastructureIntentRelationshipSchema).max(500),
  })
  .strict();
export const InfrastructureIntentSchema = infrastructureIntentSchema;
export type InfrastructureIntent = z.infer<typeof infrastructureIntentSchema>;

export const resourceOriginSchema = z.enum([
  "explicit",
  "inferred-minimal",
  "stage-upgrade",
]);
export const ResourceOriginSchema = resourceOriginSchema;
export type ResourceOrigin = z.infer<typeof resourceOriginSchema>;

export const approvalStatusSchema = z.enum([
  "not-required",
  "pending",
  "approved",
  "rejected",
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

function validateApprovalOrigin(
  value: { origin: ResourceOrigin; approvalStatus: ApprovalStatus },
  context: z.RefinementCtx,
): void {
  if (value.origin === "stage-upgrade" && value.approvalStatus === "not-required") {
    context.addIssue({
      code: "custom",
      path: ["approvalStatus"],
      message: "Stage upgrades require an explicit approval decision.",
    });
  }
  if (value.origin !== "stage-upgrade" && value.approvalStatus !== "not-required") {
    context.addIssue({
      code: "custom",
      path: ["approvalStatus"],
      message: "Only stage upgrades can have an approval decision.",
    });
  }
}

export const architectureResourceSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    type: awsResourceTypeSchema,
    name: z.string().trim().min(1).max(120),
    properties: resourcePropertiesSchema,
    origin: resourceOriginSchema,
    reason: z.string().trim().min(1).max(500),
    confidence: z.number().min(0).max(1).optional(),
    approvalStatus: approvalStatusSchema,
  })
  .strict()
  .superRefine(validateApprovalOrigin);
export const ArchitectureResourceSchema = architectureResourceSchema;
export type ArchitectureResource = z.infer<typeof architectureResourceSchema>;

export const architectureRelationshipSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    sourceId: z.string().trim().min(1).max(120),
    targetId: z.string().trim().min(1).max(120),
    kind: architectureRelationshipKindSchema,
    label: z.string().trim().min(1).max(120).optional(),
    origin: resourceOriginSchema,
    reason: z.string().trim().min(1).max(500),
    approvalStatus: approvalStatusSchema,
  })
  .strict()
  .superRefine(validateApprovalOrigin);
export const ArchitectureRelationshipSchema = architectureRelationshipSchema;
export type ArchitectureRelationship = z.infer<
  typeof architectureRelationshipSchema
>;

export const architectureDecisionSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(500),
    rationale: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type ArchitectureDecision = z.infer<typeof architectureDecisionSchema>;

export const architectureSchema = z
  .object({
    version: z.literal("architecture/v1"),
    requirements: RequirementsProfileSchema,
    resources: z.array(architectureResourceSchema).max(400),
    relationships: z.array(architectureRelationshipSchema).max(1_000),
    decisions: z.array(architectureDecisionSchema).max(200).default([]),
    unresolvedQuestions: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
  })
  .strict()
  .superRefine((architecture, context) => {
    const resourceIds = new Set<string>();
    for (const [index, resource] of architecture.resources.entries()) {
      if (resourceIds.has(resource.id)) {
        context.addIssue({
          code: "custom",
          path: ["resources", index, "id"],
          message: `Duplicate resource id: ${resource.id}`,
        });
      }
      resourceIds.add(resource.id);
    }

    const relationshipIds = new Set<string>();
    for (const [index, relationship] of architecture.relationships.entries()) {
      if (relationshipIds.has(relationship.id)) {
        context.addIssue({
          code: "custom",
          path: ["relationships", index, "id"],
          message: `Duplicate relationship id: ${relationship.id}`,
        });
      }
      relationshipIds.add(relationship.id);

      if (!resourceIds.has(relationship.sourceId)) {
        context.addIssue({
          code: "custom",
          path: ["relationships", index, "sourceId"],
          message: `Relationship source does not exist: ${relationship.sourceId}`,
        });
      }
      if (!resourceIds.has(relationship.targetId)) {
        context.addIssue({
          code: "custom",
          path: ["relationships", index, "targetId"],
          message: `Relationship target does not exist: ${relationship.targetId}`,
        });
      }
    }
  });
export const ArchitectureSchema = architectureSchema;
export type Architecture = z.infer<typeof architectureSchema>;

export const workloadStageSchema = z.enum([
  "prototype",
  "mvp",
  "growth",
  "production",
]);
export type WorkloadStage = z.infer<typeof workloadStageSchema>;

export const stageUpgradeProposalSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(500),
    affects: z.array(z.string().trim().min(1).max(120)).max(200),
  })
  .strict();
export type StageUpgradeProposal = z.infer<typeof stageUpgradeProposalSchema>;

export const stageDecisionSchema = z
  .object({
    version: z.literal("stage-decision/v1"),
    stage: workloadStageSchema,
    confidence: z.enum(["low", "medium", "high"]),
    reasons: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    requiresApproval: z.boolean(),
    proposedUpgrades: z.array(stageUpgradeProposalSchema).max(20),
  })
  .strict()
  .superRefine((decision, context) => {
    const hasUpgrades = decision.proposedUpgrades.length > 0;
    if (decision.requiresApproval !== hasUpgrades) {
      context.addIssue({
        code: "custom",
        path: ["requiresApproval"],
        message: "requiresApproval must match the presence of proposed upgrades.",
      });
    }
    const proposalIds = new Set<string>();
    for (const [index, proposal] of decision.proposedUpgrades.entries()) {
      if (proposalIds.has(proposal.id)) {
        context.addIssue({
          code: "custom",
          path: ["proposedUpgrades", index, "id"],
          message: `Duplicate stage-upgrade proposal id: ${proposal.id}`,
        });
      }
      proposalIds.add(proposal.id);
    }
  });
export const StageDecisionSchema = stageDecisionSchema;
export type StageDecision = z.infer<typeof stageDecisionSchema>;

export const diagnosticSchema = z
  .object({
    level: z.enum(["error", "warning", "info"]),
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string().trim().min(1).max(1_000),
    path: z.string().trim().min(1).max(500).optional(),
    suggestion: z.string().trim().min(1).max(1_000).optional(),
    resourceId: z.string().trim().min(1).max(120).optional(),
    relationshipId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const DiagnosticSchema = diagnosticSchema;
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export const deploymentPlanSchema = z
  .object({
    version: z.literal("deployment-plan/v1"),
    stage: workloadStageSchema,
    requiresApproval: z.boolean(),
    approvalsSatisfied: z.boolean(),
    pendingApprovalResourceIds: z.array(z.string().trim().min(1).max(120)).max(400),
    architecture: architectureSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    const stageResources = plan.architecture.resources.filter(
      (resource) => resource.origin === "stage-upgrade",
    );
    const pendingStageIds = new Set(
      stageResources
        .filter((resource) => resource.approvalStatus === "pending")
        .map((resource) => resource.id),
    );
    const pendingIds = new Set<string>();
    for (const [index, id] of plan.pendingApprovalResourceIds.entries()) {
      if (pendingIds.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["pendingApprovalResourceIds", index],
          message: `Duplicate pending approval resource id: ${id}`,
        });
      }
      pendingIds.add(id);
      if (!pendingStageIds.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["pendingApprovalResourceIds", index],
          message: `Pending approval id does not reference a pending stage upgrade: ${id}`,
        });
      }
    }

    for (const id of pendingStageIds) {
      if (!pendingIds.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["pendingApprovalResourceIds"],
          message: `Pending stage upgrade is missing from the approval list: ${id}`,
        });
      }
    }

    if (plan.requiresApproval !== (stageResources.length > 0)) {
      context.addIssue({
        code: "custom",
        path: ["requiresApproval"],
        message: "requiresApproval must match the presence of stage-upgrade resources.",
      });
    }
    if (plan.approvalsSatisfied !== (pendingStageIds.size === 0)) {
      context.addIssue({
        code: "custom",
        path: ["approvalsSatisfied"],
        message: "approvalsSatisfied must be false while stage upgrades are pending.",
      });
    }
  });
export const DeploymentPlanSchema = deploymentPlanSchema;
export type DeploymentPlan = z.infer<typeof deploymentPlanSchema>;

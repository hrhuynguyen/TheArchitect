import {
  architectureSchema,
  deploymentPlanSchema,
  diagnosticSchema,
  infrastructureIntentSchema,
  stageDecisionSchema,
  type Architecture,
  type ArchitectureRelationship,
  type ArchitectureResource,
  type AwsResourceType,
  type Diagnostic,
  type InfrastructureIntent,
  type InfrastructureIntentRelationship,
  type InfrastructureIntentResource,
  type InfrastructureZone,
  type ResourceOrigin,
  type StageDecision,
  type StageUpgradeProposal,
} from "@architect/contracts/infrastructure";
import {
  requirementsProfileSchema,
  type RequirementsProfile,
} from "@architect/contracts/requirements";

import { RESOURCE_CATALOG } from "./catalog.js";
import { selectStage } from "./staging.js";

interface WorkingResource extends ArchitectureResource {
  sourceId: string;
  zone?: InfrastructureZone;
}

export interface CompileIntentResult {
  architecture: Architecture;
  stageDecision: StageDecision;
  deploymentPlan: ReturnType<typeof deploymentPlanSchema.parse>;
  diagnostics: Diagnostic[];
}

const NETWORK_ATTACHED_TYPES: ReadonlySet<AwsResourceType> = new Set([
  "EC2",
  "ELB",
  "RDS",
  "MSK",
  "Subnet",
  "SecurityGroup",
  "InternetGateway",
  "NatGateway",
  "RouteTable",
] as const);

const SECURITY_GROUP_TYPES: ReadonlySet<AwsResourceType> = new Set([
  "EC2",
  "ELB",
  "RDS",
  "MSK",
]);
const HOSTED_TYPES: ReadonlySet<AwsResourceType> = SECURITY_GROUP_TYPES;
const EXPLICIT_INGRESS_TYPES: ReadonlySet<AwsResourceType> = new Set([
  "ELB",
  "APIGateway",
  "CloudFront",
]);
const MAX_EXPLICIT_ARCHITECTURE_RESOURCES = 390;
const MAX_ARCHITECTURE_RELATIONSHIPS = 1_000;
const MAX_STAGE_PROPOSAL_AFFECTS = 200;

const DIAGNOSTIC_LEVEL_ORDER: Record<Diagnostic["level"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalProperties(properties: Record<string, string | number | boolean>): string {
  return JSON.stringify(canonicalizeProperties(properties));
}

function canonicalizeProperties(
  properties: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(properties).sort(([left], [right]) => compareText(left, right)),
  );
}

function compareIntentResources(
  left: InfrastructureIntentResource,
  right: InfrastructureIntentResource,
): number {
  return (
    compareText(left.id, right.id) ||
    compareText(left.type, right.type) ||
    compareText(left.name, right.name) ||
    compareText(left.zone ?? "", right.zone ?? "") ||
    (left.count ?? 1) - (right.count ?? 1) ||
    compareText(canonicalProperties(left.properties), canonicalProperties(right.properties))
  );
}

function relationshipKey(relationship: InfrastructureIntentRelationship): string {
  return [
    relationship.id ?? "",
    relationship.sourceId,
    relationship.targetId,
    relationship.kind,
    relationship.label ?? "",
    relationship.direction ?? "forward",
  ].join("\u0000");
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function generatedId(parts: string[]): string {
  const full = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "generated";
  return full.length <= 180 ? full : `${full.slice(0, 168)}-${stableHash(full)}`;
}

function boundStableValue(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const hash = stableHash(value);
  return `${value.slice(0, maximum - hash.length - 1)}-${hash}`;
}

function nameWithSuffix(name: string, suffix: string): string {
  if (name.length + suffix.length <= 120) return `${name}${suffix}`;
  return `${name.slice(0, 120 - suffix.length).trimEnd()}${suffix}`;
}

function reserveId(base: string, used: Set<string>, maximum: number): string {
  const boundedBase = boundStableValue(base, maximum);
  if (!used.has(boundedBase)) {
    used.add(boundedBase);
    return boundedBase;
  }
  let suffix = 2;
  let id = boundStableValue(`${base}-${suffix}`, maximum);
  while (used.has(id)) {
    suffix += 1;
    id = boundStableValue(`${base}-${suffix}`, maximum);
  }
  used.add(id);
  return id;
}

function originFor(resources: WorkingResource[]): ResourceOrigin {
  if (resources.some((resource) => resource.origin === "stage-upgrade")) {
    return "stage-upgrade";
  }
  return "inferred-minimal";
}

function zoneFor(resource: InfrastructureIntentResource): InfrastructureZone {
  if (resource.zone) return resource.zone;
  if (["External", "CloudFront", "APIGateway", "InternetGateway"].includes(resource.type)) {
    return "edge";
  }
  if (["ELB", "NatGateway"].includes(resource.type)) return "public";
  if (["RDS", "DynamoDB", "MSK"].includes(resource.type)) return "data";
  if (["EC2", "SecurityGroup", "RouteTable", "Subnet"].includes(resource.type)) {
    return "private";
  }
  return "regional";
}

function reconcileStageDecision(
  recommendation: StageDecision,
  architecture: Architecture,
): StageDecision {
  const pendingResources = architecture.resources.filter(
    (resource) =>
      resource.origin === "stage-upgrade" && resource.approvalStatus === "pending",
  );
  const pendingRelationships = architecture.relationships.filter(
    (relationship) =>
      relationship.origin === "stage-upgrade" &&
      relationship.approvalStatus === "pending",
  );
  const pendingResourceIds = new Set(pendingResources.map((resource) => resource.id));
  const assignedResourceIds = new Set<string>();
  const proposedUpgrades: StageUpgradeProposal[] = [];

  const addProposal = (
    id: string,
    title: string,
    summary: string,
    resourceIds: string[],
  ): void => {
    const affects = [...new Set(resourceIds)].sort(compareText);
    if (affects.length === 0) return;
    affects.forEach((resourceId) => assignedResourceIds.add(resourceId));
    const partCount = Math.ceil(affects.length / MAX_STAGE_PROPOSAL_AFFECTS);
    for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
      proposedUpgrades.push({
        id: partCount === 1 ? id : `${id}-part-${partIndex + 1}`,
        title,
        summary,
        affects: affects.slice(
          partIndex * MAX_STAGE_PROPOSAL_AFFECTS,
          (partIndex + 1) * MAX_STAGE_PROPOSAL_AFFECTS,
        ),
      });
    }
  };

  const hasPendingIngress = pendingResources.some((resource) => resource.type === "ELB");
  if (hasPendingIngress) {
    addProposal(
      "redundant-ingress",
      "Add redundant ingress",
      "Add reviewed load-balancer and subnet capacity for internet-facing traffic.",
      pendingResources
        .filter((resource) => resource.type === "ELB" || resource.type === "Subnet")
        .map((resource) => resource.id),
    );
  }

  addProposal(
    "redundant-compute",
    "Add redundant compute",
    "Add independent compute capacity for the selected workload stage.",
    pendingResources
      .filter((resource) => resource.type === "EC2")
      .map((resource) => resource.id),
  );

  addProposal(
    "multi-zone-networking",
    "Use multiple availability zones",
    "Add reviewed subnet capacity in another availability zone.",
    pendingResources
      .filter(
        (resource) =>
          resource.type === "Subnet" && !assignedResourceIds.has(resource.id),
      )
      .map((resource) => resource.id),
  );

  addProposal(
    "topology-upgrades",
    "Apply topology upgrades",
    "Apply the remaining graph-specific stage resources.",
    pendingResources
      .filter((resource) => !assignedResourceIds.has(resource.id))
      .map((resource) => resource.id),
  );

  const relationshipOnlyResourceIds = pendingRelationships.flatMap((relationship) =>
    [relationship.sourceId, relationship.targetId].filter(
      (resourceId) => !pendingResourceIds.has(resourceId),
    ),
  );
  addProposal(
    "topology-relationships",
    "Review topology relationships",
    "Apply graph-specific relationships between existing resources.",
    relationshipOnlyResourceIds,
  );

  proposedUpgrades.sort((left, right) => compareText(left.id, right.id));
  return stageDecisionSchema.parse({
    ...recommendation,
    requiresApproval: proposedUpgrades.length > 0,
    proposedUpgrades,
  });
}

function deriveVpcAvailabilityZones(architecture: Architecture): Architecture {
  const resourcesById = new Map(
    architecture.resources.map((resource) => [resource.id, resource]),
  );
  const resources = architecture.resources.map((resource) => {
    if (resource.type !== "VPC" || resource.origin !== "inferred-minimal") {
      return resource;
    }
    const availabilityZones = new Set<string>();
    for (const relationship of architecture.relationships) {
      if (
        relationship.kind !== "contains" ||
        relationship.sourceId !== resource.id ||
        relationship.approvalStatus === "rejected"
      ) {
        continue;
      }
      const target = resourcesById.get(relationship.targetId);
      if (target?.type !== "Subnet" || target.approvalStatus === "rejected") continue;
      const availabilityZone = target.properties.availabilityZone;
      availabilityZones.add(
        typeof availabilityZone === "string" ? availabilityZone : "primary",
      );
    }
    if (availabilityZones.size === 0) return resource;
    return {
      ...resource,
      properties: canonicalizeProperties({
        ...resource.properties,
        maxAvailabilityZones: availabilityZones.size,
      }),
    };
  });

  return architectureSchema.parse({ ...architecture, resources });
}

function compileCore(
  inputIntent: InfrastructureIntent,
  inputRequirements: RequirementsProfile,
): CompileIntentResult {
  const intent = infrastructureIntentSchema.parse(inputIntent);
  const requirements = requirementsProfileSchema.parse(inputRequirements);
  const diagnostics: Diagnostic[] = [];
  const usedResourceIds = new Set<string>();
  const explicitBySourceId = new Map<string, InfrastructureIntentResource>();
  const expandedBySourceId = new Map<string, WorkingResource[]>();
  const resources: WorkingResource[] = [];

  for (const intentResource of [...intent.resources].sort(compareIntentResources)) {
    if (explicitBySourceId.has(intentResource.id)) {
      diagnostics.push({
        level: "error",
        code: "DUPLICATE_RESOURCE_ID",
        message: `Resource id ${intentResource.id} is declared more than once.`,
        path: `resources.${intentResource.id}`,
        resourceId: intentResource.id,
        suggestion: "Give every intent resource a unique stable id.",
      });
      continue;
    }
    explicitBySourceId.set(intentResource.id, intentResource);

    const count = intentResource.count ?? 1;
    const expanded: WorkingResource[] = [];
    for (let index = 0; index < count; index += 1) {
      if (resources.length >= MAX_EXPLICIT_ARCHITECTURE_RESOURCES) {
        if (!diagnostics.some((item) => item.code === "ARCHITECTURE_RESOURCE_LIMIT")) {
          diagnostics.push({
            level: "error",
            code: "ARCHITECTURE_RESOURCE_LIMIT",
            message: `Expanded intent exceeds the ${MAX_EXPLICIT_ARCHITECTURE_RESOURCES} explicit-resource compilation limit.`,
            path: "resources",
            suggestion: "Reduce repeated resource counts or split the architecture into bounded revisions.",
          });
        }
        break;
      }
      const requestedId = count === 1 ? intentResource.id : `${intentResource.id}-${index + 1}`;
      const id = reserveId(requestedId, usedResourceIds, 120);
      if (id !== requestedId) {
        diagnostics.push({
          level: "warning",
          code: "EXPANDED_RESOURCE_ID_COLLISION",
          message: `Expanded resource id ${requestedId} collided and was renamed to ${id}.`,
          path: `resources.${intentResource.id}`,
          resourceId: id,
        });
      }
      const resource: WorkingResource = {
        id,
        type: intentResource.type,
        name:
          count === 1
            ? intentResource.name
            : nameWithSuffix(intentResource.name, ` ${index + 1}`),
        properties: { ...intentResource.properties },
        origin: "explicit",
        reason: "Explicitly reconstructed from the shared whiteboard.",
        confidence: 1,
        approvalStatus: "not-required",
        sourceId: intentResource.id,
        zone: zoneFor(intentResource),
      };
      resources.push(resource);
      expanded.push(resource);
    }
    expandedBySourceId.set(intentResource.id, expanded);
  }

  const sortedIntentRelationships = [...intent.relationships].sort((left, right) =>
    compareText(relationshipKey(left), relationshipKey(right)),
  );
  const validIntentRelationships: InfrastructureIntentRelationship[] = [];
  const seenIntentRelationshipIds = new Set<string>();
  for (const relationship of sortedIntentRelationships) {
    if (relationship.id && seenIntentRelationshipIds.has(relationship.id)) {
      diagnostics.push({
        level: "error",
        code: "DUPLICATE_RELATIONSHIP_ID",
        message: `Relationship id ${relationship.id} is declared more than once.`,
        path: `relationships.${relationship.id}`,
        relationshipId: relationship.id,
        suggestion: "Give every explicit relationship a unique stable id.",
      });
      continue;
    }
    if (relationship.id) seenIntentRelationshipIds.add(relationship.id);

    const sourceExists = explicitBySourceId.has(relationship.sourceId);
    const targetExists = explicitBySourceId.has(relationship.targetId);
    if (!sourceExists || !targetExists) {
      diagnostics.push({
        level: "error",
        code: "DANGLING_RELATIONSHIP",
        message: `Relationship ${relationship.id ?? `${relationship.sourceId} -> ${relationship.targetId}`} references a missing resource.`,
        path: relationship.id
          ? `relationships.${relationship.id}`
          : `relationships.${relationship.sourceId}.${relationship.targetId}`,
        relationshipId: relationship.id,
        suggestion: "Add the missing resource or remove this relationship.",
      });
      continue;
    }
    validIntentRelationships.push(relationship);
  }

  const directExternalComputeIds = new Set<string>();
  for (const relationship of validIntentRelationships) {
    const source = explicitBySourceId.get(relationship.sourceId);
    const target = explicitBySourceId.get(relationship.targetId);
    if (source?.type === "External" && target?.type === "EC2") {
      directExternalComputeIds.add(target.id);
    }
  }

  const addGeneratedResource = (
    input: Omit<WorkingResource, "id" | "sourceId"> & { requestedId: string },
  ): WorkingResource => {
    const id = reserveId(input.requestedId, usedResourceIds, 120);
    const resource: WorkingResource = {
      id,
      type: input.type,
      name: input.name,
      properties: input.properties,
      origin: input.origin,
      reason: input.reason,
      confidence: input.confidence,
      approvalStatus: input.approvalStatus,
      sourceId: id,
      zone: input.zone,
    };
    resources.push(resource);
    diagnostics.push({
      level: input.origin === "stage-upgrade" ? "warning" : "info",
      code:
        input.origin === "stage-upgrade"
          ? "STAGE_UPGRADE_PENDING"
          : "INFERRED_MINIMAL_RESOURCE",
      message: `${resource.name} was added as ${resource.origin}.`,
      path: `resources.${resource.id}`,
      resourceId: resource.id,
      suggestion: resource.reason,
    });
    return resource;
  };

  const hasType = (type: WorkingResource["type"]): boolean =>
    resources.some((resource) => resource.type === type);
  const resourcesOfType = (type: WorkingResource["type"]): WorkingResource[] =>
    resources.filter((resource) => resource.type === type).sort((left, right) =>
      compareText(left.id, right.id),
    );

  const hasNetworkAttachedResource = resources.some((resource) =>
    NETWORK_ATTACHED_TYPES.has(resource.type),
  );
  if (hasNetworkAttachedResource && !hasType("VPC")) {
    addGeneratedResource({
      requestedId: "inferred-vpc",
      type: "VPC",
      name: "Minimal VPC",
      properties: { maxAvailabilityZones: 1 },
      origin: "inferred-minimal",
      reason: "Network-attached AWS resources require a VPC boundary.",
      confidence: 1,
      approvalStatus: "not-required",
      zone: "regional",
    });
  }

  if (
    resources.some((resource) => SECURITY_GROUP_TYPES.has(resource.type)) &&
    !hasType("SecurityGroup")
  ) {
    addGeneratedResource({
      requestedId: "inferred-security-group",
      type: "SecurityGroup",
      name: "Minimal security group",
      properties: { allowAllOutbound: true },
      origin: "inferred-minimal",
      reason: "Network-attached compute and data services need a security boundary.",
      confidence: 1,
      approvalStatus: "not-required",
      zone: "private",
    });
  }

  const workloadNeedsSubnet = resources.some((resource) =>
    HOSTED_TYPES.has(resource.type),
  );
  if (workloadNeedsSubnet) {
    const existingSubnets = resourcesOfType("Subnet");
    const needsPublicSubnet =
      directExternalComputeIds.size > 0 || hasType("ELB");
    const needsPrivateSubnet =
      hasType("RDS") ||
      hasType("MSK") ||
      (hasType("EC2") && directExternalComputeIds.size === 0);
    const hasPublicSubnet = existingSubnets.some(
      (resource) =>
        resource.zone === "public" || resource.properties.subnetType === "public",
    );
    const hasPrivateSubnet = existingSubnets.some(
      (resource) =>
        resource.zone === "private" ||
        resource.zone === "data" ||
        resource.properties.subnetType === "private",
    );

    if (needsPublicSubnet && !hasPublicSubnet) {
      addGeneratedResource({
        requestedId: "inferred-subnet-public",
        type: "Subnet",
        name: "Minimal public subnet",
        properties: { subnetType: "public" },
        origin: "inferred-minimal",
        reason: "Internet-facing resources need a public network path.",
        confidence: 1,
        approvalStatus: "not-required",
        zone: "public",
      });
    }
    const publicSubnetCount = resourcesOfType("Subnet").filter(
      (resource) =>
        resource.zone === "public" || resource.properties.subnetType === "public",
    ).length;
    if (hasType("ELB") && publicSubnetCount < 2) {
      addGeneratedResource({
        requestedId: "inferred-subnet-public-secondary",
        type: "Subnet",
        name: "Minimal secondary public subnet",
        properties: {
          availabilityZone: "secondary",
          subnetType: "public",
        },
        origin: "inferred-minimal",
        reason: "Application load balancers require public subnets in at least two availability zones.",
        confidence: 1,
        approvalStatus: "not-required",
        zone: "public",
      });
    }
    if (needsPrivateSubnet && !hasPrivateSubnet) {
      addGeneratedResource({
        requestedId: "inferred-subnet-private",
        type: "Subnet",
        name: "Minimal private subnet",
        properties: { subnetType: "private" },
        origin: "inferred-minimal",
        reason: "Private workloads need a subnet that is not directly internet-facing.",
        confidence: 1,
        approvalStatus: "not-required",
        zone: "private",
      });
    }
  }

  const stageRecommendation = selectStage(requirements);
  const desiredComputeCount =
    stageRecommendation.stage === "production"
      ? 3
      : stageRecommendation.stage === "growth"
        ? 2
        : 1;
  const originalCompute = resourcesOfType("EC2").filter(
    (resource) => resource.origin === "explicit",
  );
  const primaryCompute = originalCompute[0];
  if (primaryCompute && originalCompute.length < desiredComputeCount) {
    for (
      let index = originalCompute.length + 1;
      index <= desiredComputeCount;
      index += 1
    ) {
      addGeneratedResource({
        requestedId: generatedId(["stage", primaryCompute.sourceId, "replica", String(index)]),
        type: "EC2",
        name: nameWithSuffix(primaryCompute.name, ` replica ${index}`),
        properties: { ...primaryCompute.properties },
        origin: "stage-upgrade",
        reason: `The ${stageRecommendation.stage} stage proposes redundant compute capacity.`,
        approvalStatus: "pending",
        zone: primaryCompute.zone,
      });
    }
  }

  const hasExplicitIngress = resources.some(
    (resource) =>
      resource.origin === "explicit" &&
      EXPLICIT_INGRESS_TYPES.has(resource.type),
  );
  let stagedIngress: WorkingResource | undefined;
  if (
    stageRecommendation.stage !== "prototype" &&
    stageRecommendation.stage !== "mvp" &&
    directExternalComputeIds.size > 0 &&
    !hasExplicitIngress
  ) {
    stagedIngress = addGeneratedResource({
      requestedId: "stage-elb",
      type: "ELB",
      name: "Recommended load balancer",
      properties: { scheme: "internet-facing" },
      origin: "stage-upgrade",
      reason: `The ${stageRecommendation.stage} stage proposes managed ingress before EC2.`,
      approvalStatus: "pending",
      zone: "public",
    });
  }

  const stagedPublicSubnets = resourcesOfType("Subnet").filter(
    (resource) =>
      resource.zone === "public" || resource.properties.subnetType === "public",
  );
  const needsStagedPublicSubnet = Boolean(stagedIngress) && stagedPublicSubnets.length < 2;
  const stagedComputeExists = resourcesOfType("EC2").some(
    (resource) => resource.origin === "stage-upgrade",
  );
  const computeUsesPublicSubnets = primaryCompute?.zone === "public";
  const compatibleComputeSubnetCount = resourcesOfType("Subnet").filter((resource) =>
    computeUsesPublicSubnets
      ? resource.zone === "public" || resource.properties.subnetType === "public"
      : resource.zone !== "public" && resource.properties.subnetType !== "public",
  ).length;
  const needsStagedComputeSubnet =
    stagedComputeExists && compatibleComputeSubnetCount < 2;
  const needsProductionSubnet =
    stageRecommendation.stage === "production" &&
    resourcesOfType("Subnet").length < 2;
  const vpcCandidates = resourcesOfType("VPC");
  const [onlyVpcCandidate] = vpcCandidates;
  const singleAzVpcCap =
    vpcCandidates.length === 1 &&
    onlyVpcCandidate?.origin === "explicit" &&
    typeof onlyVpcCandidate.properties.maxAvailabilityZones === "number" &&
    onlyVpcCandidate.properties.maxAvailabilityZones <= 1
      ? onlyVpcCandidate
      : undefined;
  if (
    hasType("VPC") &&
    (needsStagedPublicSubnet || needsStagedComputeSubnet || needsProductionSubnet)
  ) {
    if (singleAzVpcCap) {
      diagnostics.push({
        level: "error",
        code: "VPC_AVAILABILITY_ZONE_CAP",
        message: `${singleAzVpcCap.name} is explicitly capped at one availability zone, which blocks the ${stageRecommendation.stage} multi-zone topology.`,
        path: `resources.${singleAzVpcCap.id}.properties.maxAvailabilityZones`,
        resourceId: singleAzVpcCap.id,
        suggestion:
          "Increase maxAvailabilityZones to at least 2 or lower the workload availability requirements.",
      });
    } else {
      const publicUpgrade =
        needsStagedPublicSubnet ||
        (needsStagedComputeSubnet && computeUsesPublicSubnets) ||
        directExternalComputeIds.size > 0;
      addGeneratedResource({
        requestedId: "stage-subnet-secondary",
        type: "Subnet",
        name: "Recommended secondary subnet",
        properties: {
          availabilityZone: "secondary",
          subnetType: publicUpgrade ? "public" : "private",
        },
        origin: "stage-upgrade",
        reason: `The ${stageRecommendation.stage} stage proposes capacity in a second availability zone.`,
        approvalStatus: "pending",
        zone: publicUpgrade ? "public" : "private",
      });
    }
  }

  const relationships: ArchitectureRelationship[] = [];
  const usedRelationshipIds = new Set<string>();
  const seenSemanticRelationships = new Set<string>();
  let relationshipLimitReported = false;

  const addRelationship = (input: {
    requestedId?: string;
    source: WorkingResource;
    target: WorkingResource;
    kind: ArchitectureRelationship["kind"];
    label?: string;
    origin?: ResourceOrigin;
    reason: string;
    forceExpandedId?: boolean;
  }): void => {
    if (input.source.id === input.target.id) return;
    if (relationships.length >= MAX_ARCHITECTURE_RELATIONSHIPS) {
      if (!relationshipLimitReported) {
        diagnostics.push({
          level: "error",
          code: "ARCHITECTURE_RELATIONSHIP_LIMIT",
          message: `Expanded intent exceeds the ${MAX_ARCHITECTURE_RELATIONSHIPS} relationship compilation limit.`,
          path: "relationships",
          suggestion: "Reduce relationship fan-out or split the architecture into bounded revisions.",
        });
        relationshipLimitReported = true;
      }
      return;
    }
    const origin = input.origin ?? originFor([input.source, input.target]);
    const semanticKey = [
      input.source.id,
      input.target.id,
      input.kind,
      input.label ?? "",
    ].join("\u0000");
    if (seenSemanticRelationships.has(semanticKey)) return;
    seenSemanticRelationships.add(semanticKey);
    const baseId =
      input.requestedId && !input.forceExpandedId
        ? input.requestedId
        : generatedId([
            input.requestedId ?? "rel",
            input.source.id,
            input.kind,
            input.target.id,
          ]);
    const id = reserveId(baseId, usedRelationshipIds, 200);
    relationships.push({
      id,
      sourceId: input.source.id,
      targetId: input.target.id,
      kind: input.kind,
      ...(input.label ? { label: input.label } : {}),
      origin,
      reason: input.reason,
      approvalStatus: origin === "stage-upgrade" ? "pending" : "not-required",
    });
  };

  for (const relationship of validIntentRelationships) {
    const sources = expandedBySourceId.get(relationship.sourceId) ?? [];
    const targets = expandedBySourceId.get(relationship.targetId) ?? [];
    const expanded = sources.length * targets.length > 1;
    for (const source of sources) {
      for (const target of targets) {
        addRelationship({
          requestedId: relationship.id,
          source,
          target,
          kind: relationship.kind,
          label: relationship.label,
          origin: "explicit",
          reason: "Explicitly reconstructed from the shared whiteboard.",
          forceExpandedId: expanded,
        });
        if (relationship.direction === "bidirectional") {
          addRelationship({
            requestedId: relationship.id ? `${relationship.id}-reverse` : undefined,
            source: target,
            target: source,
            kind: relationship.kind,
            label: relationship.label,
            origin: "explicit",
            reason: "Explicit bidirectional relationship reconstructed from the whiteboard.",
            forceExpandedId: expanded,
          });
        }
      }
    }
  }

  const vpcs = resourcesOfType("VPC");
  const subnets = resourcesOfType("Subnet");
  const publicSubnets = subnets.filter(
    (resource) =>
      resource.zone === "public" || resource.properties.subnetType === "public",
  );
  const privateSubnets = subnets.filter(
    (resource) => !publicSubnets.some((candidate) => candidate.id === resource.id),
  );
  const securityGroups = resourcesOfType("SecurityGroup");
  const attachToVpc = (target: WorkingResource): void => {
    const hasExplicitAttachment = relationships.some(
      (relationship) =>
        relationship.origin === "explicit" &&
        relationship.kind === "contains" &&
        relationship.targetId === target.id &&
        vpcs.some((candidate) => candidate.id === relationship.sourceId),
    );
    if (hasExplicitAttachment || vpcs.length === 0) return;
    if (vpcs.length > 1) {
      diagnostics.push({
        level: "error",
        code: "AMBIGUOUS_VPC_ATTACHMENT",
        message: `${target.name} cannot be attached because multiple VPC candidates exist.`,
        resourceId: target.id,
        suggestion: "Add an explicit contains relationship from the intended VPC.",
      });
      return;
    }
    const [vpc] = vpcs;
    if (!vpc) return;
    addRelationship({
      source: vpc,
      target,
      kind: "contains",
      reason: `${target.name} requires an unambiguous VPC attachment.`,
    });
  };

  for (const subnet of subnets) attachToVpc(subnet);
  for (const securityGroup of securityGroups) attachToVpc(securityGroup);

  const placementOffsets = new Map<string, number>();
  for (const hosted of resources
    .filter((resource) => HOSTED_TYPES.has(resource.type))
    .sort((left, right) => compareText(left.id, right.id))) {
    const hasExplicitHosting = relationships.some(
      (relationship) =>
        relationship.origin === "explicit" &&
        relationship.kind === "hosts" &&
        relationship.targetId === hosted.id &&
        subnets.some((candidate) => candidate.id === relationship.sourceId),
    );
    if (!hasExplicitHosting) {
      const preferred = hosted.zone === "public" ? publicSubnets : privateSubnets;
      const candidates = preferred.length > 0 ? preferred : subnets;
      const placementKey = hosted.zone === "public" ? "public" : "private";
      const offset = placementOffsets.get(placementKey) ?? 0;
      const selectedSubnets =
        hosted.type === "ELB"
          ? candidates
          : candidates.length > 0
            ? [candidates[offset % candidates.length]!]
            : [];
      if (hosted.type !== "ELB" && candidates.length > 0) {
        placementOffsets.set(placementKey, offset + 1);
      }
      for (const subnet of selectedSubnets) {
        addRelationship({
          source: subnet,
          target: hosted,
          kind: "hosts",
          reason: "The workload requires placement in a compatible subnet.",
        });
      }
    }
    const hasExplicitProtection = relationships.some(
      (relationship) =>
        relationship.origin === "explicit" &&
        relationship.kind === "protects" &&
        relationship.targetId === hosted.id &&
        securityGroups.some(
          (candidate) => candidate.id === relationship.sourceId,
        ),
    );
    if (hasExplicitProtection) continue;
    if (securityGroups.length > 1) {
      diagnostics.push({
        level: "error",
        code: "AMBIGUOUS_SECURITY_GROUP_ATTACHMENT",
        message: `${hosted.name} cannot be protected because multiple security-group candidates exist.`,
        resourceId: hosted.id,
        suggestion: "Add an explicit protects relationship from the intended security group.",
      });
      continue;
    }
    const [securityGroup] = securityGroups;
    if (securityGroup) {
      addRelationship({
        source: securityGroup,
        target: hosted,
        kind: "protects",
        reason: "The security group protects the network-attached workload.",
      });
    }
  }

  if (stagedIngress) {
    for (const relationship of validIntentRelationships) {
      const sourceIntent = explicitBySourceId.get(relationship.sourceId);
      const targetIntent = explicitBySourceId.get(relationship.targetId);
      if (sourceIntent?.type !== "External" || targetIntent?.type !== "EC2") continue;
      for (const source of expandedBySourceId.get(sourceIntent.id) ?? []) {
        addRelationship({
          source,
          target: stagedIngress,
          kind: "routes",
          origin: "stage-upgrade",
          reason: "The proposed load balancer becomes the reviewed ingress path.",
        });
      }
    }
    for (const compute of resourcesOfType("EC2")) {
      addRelationship({
        source: stagedIngress,
        target: compute,
        kind: "routes",
        origin: "stage-upgrade",
        reason: "The proposed load balancer distributes traffic to compute capacity.",
      });
    }
  }

  const semanticResources = resources
    .map(({ sourceId: _sourceId, ...resource }) => ({
      ...resource,
      properties: canonicalizeProperties(resource.properties),
    }))
    .sort((left, right) => compareText(left.id, right.id));
  const semanticRelationships = relationships.sort((left, right) =>
    compareText(left.id, right.id),
  );

  const architecture = deriveVpcAvailabilityZones(architectureSchema.parse({
    version: "architecture/v1",
    requirements,
    resources: semanticResources,
    relationships: semanticRelationships,
    decisions: [],
    unresolvedQuestions: [],
  }));
  const stageDecision = reconcileStageDecision(stageRecommendation, architecture);

  for (const resource of architecture.resources) {
    const capability = RESOURCE_CATALOG[resource.type];
    if (capability.diagramOnly) {
      diagnostics.push({
        level: "info",
        code: "DIAGRAM_ONLY_RESOURCE",
        message: `${resource.type} ${resource.name} is preserved in the diagram and omitted from synthesis.`,
        resourceId: resource.id,
      });
    } else if (!capability.synthSupported) {
      diagnostics.push({
        level: "error",
        code: "UNSUPPORTED_SYNTH_RESOURCE",
        message: `${resource.type} is not supported by the v1 synthesis compiler.`,
        resourceId: resource.id,
        suggestion: "Replace it with a synth-supported resource or keep this revision diagram-only.",
      });
    }
  }

  const pendingApprovalResourceIds = architecture.resources
    .filter(
      (resource) =>
        resource.origin === "stage-upgrade" && resource.approvalStatus === "pending",
    )
    .map((resource) => resource.id)
    .sort();
  const pendingApprovalRelationshipIds = architecture.relationships
    .filter(
      (relationship) =>
        relationship.origin === "stage-upgrade" &&
        relationship.approvalStatus === "pending",
    )
    .map((relationship) => relationship.id)
    .sort();
  const deploymentPlan = deploymentPlanSchema.parse({
    version: "deployment-plan/v1",
    stage: stageDecision.stage,
    requiresApproval:
      architecture.resources.some((resource) => resource.origin === "stage-upgrade") ||
      architecture.relationships.some(
        (relationship) => relationship.origin === "stage-upgrade",
      ),
    approvalsSatisfied:
      pendingApprovalResourceIds.length === 0 &&
      pendingApprovalRelationshipIds.length === 0,
    pendingApprovalResourceIds,
    pendingApprovalRelationshipIds,
    architecture,
  });

  const stableDiagnostics = diagnostics
    .map((diagnostic) => diagnosticSchema.parse(diagnostic))
    .sort(
      (left, right) =>
        DIAGNOSTIC_LEVEL_ORDER[left.level] - DIAGNOSTIC_LEVEL_ORDER[right.level] ||
        compareText(left.code, right.code) ||
        compareText(left.resourceId ?? "", right.resourceId ?? "") ||
        compareText(left.relationshipId ?? "", right.relationshipId ?? "") ||
        compareText(left.path ?? "", right.path ?? ""),
    );

  return {
    architecture,
    stageDecision,
    deploymentPlan,
    diagnostics: stableDiagnostics,
  };
}

export function compileIntent(
  intent: InfrastructureIntent,
  requirements: RequirementsProfile,
): CompileIntentResult {
  return compileCore(intent, requirements);
}

export function buildDeploymentPlan(
  intent: InfrastructureIntent,
  requirements: RequirementsProfile,
): CompileIntentResult["deploymentPlan"] {
  return compileCore(intent, requirements).deploymentPlan;
}

export function materializeApprovedArchitecture(
  plan: CompileIntentResult["deploymentPlan"],
): Architecture {
  const validatedPlan = deploymentPlanSchema.parse(plan);
  const resources = validatedPlan.architecture.resources.filter(
    (resource) =>
      resource.approvalStatus !== "pending" && resource.approvalStatus !== "rejected",
  );
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const relationships = validatedPlan.architecture.relationships.filter(
    (relationship) =>
      relationship.approvalStatus !== "pending" &&
      relationship.approvalStatus !== "rejected" &&
      resourceIds.has(relationship.sourceId) &&
      resourceIds.has(relationship.targetId),
  );

  return deriveVpcAvailabilityZones(architectureSchema.parse({
    ...validatedPlan.architecture,
    resources,
    relationships,
  }));
}

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
const MAX_ARCHITECTURE_RESOURCES = 400;
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

function semanticAvailabilityZone(subnet: WorkingResource): string {
  const availabilityZone = subnet.properties.availabilityZone;
  return typeof availabilityZone === "string" && availabilityZone.length > 0
    ? availabilityZone
    : "primary";
}

function compareSemanticAvailabilityZone(left: string, right: string): number {
  if (left === "primary") return right === "primary" ? 0 : -1;
  if (right === "primary") return 1;
  return compareText(left, right);
}

function selectAdditionalSemanticAvailabilityZone(
  allSubnets: WorkingResource[],
  occupiedSubnets: WorkingResource[],
): string {
  const occupiedAvailabilityZones = new Set(
    occupiedSubnets.map(semanticAvailabilityZone),
  );
  const reusableAvailabilityZone = [
    ...new Set(allSubnets.map(semanticAvailabilityZone)),
  ]
    .sort(compareSemanticAvailabilityZone)
    .find(
      (availabilityZone) =>
        !occupiedAvailabilityZones.has(availabilityZone),
    );
  if (reusableAvailabilityZone) return reusableAvailabilityZone;

  let availabilityZone = "secondary";
  let suffix = 2;
  while (occupiedAvailabilityZones.has(availabilityZone)) {
    availabilityZone = `secondary-${suffix}`;
    suffix += 1;
  }
  return availabilityZone;
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
  let resourceLimitReported = false;
  const reportResourceLimit = (resourceId: string): void => {
    if (resourceLimitReported) return;
    diagnostics.push({
      level: "error",
      code: "ARCHITECTURE_RESOURCE_LIMIT",
      message: `Architecture reached the ${MAX_ARCHITECTURE_RESOURCES}-resource contract limit; ${resourceId} and dependent topology were skipped.`,
      path: "resources",
      resourceId,
      suggestion:
        "Reduce repeated resources or split the architecture into bounded revisions.",
    });
    resourceLimitReported = true;
  };

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
      if (resources.length >= MAX_ARCHITECTURE_RESOURCES) {
        reportResourceLimit(intentResource.id);
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
  ): WorkingResource | undefined => {
    if (resources.length >= MAX_ARCHITECTURE_RESOURCES) {
      reportResourceLimit(input.requestedId);
      return undefined;
    }
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

  const initialVpcCandidates = resourcesOfType("VPC");
  const [onlyInitialVpc] = initialVpcCandidates;
  const singleExplicitVpcCapacity =
    initialVpcCandidates.length === 1 &&
    onlyInitialVpc?.origin === "explicit" &&
    typeof onlyInitialVpc.properties.maxAvailabilityZones === "number"
      ? {
          maximum: onlyInitialVpc.properties.maxAvailabilityZones,
          resource: onlyInitialVpc,
        }
      : undefined;
  const requestedAvailabilityZones = new Map<string, number>();
  const recordRequestedAvailabilityZones = (
    vpcId: string,
    required: number,
  ): void => {
    requestedAvailabilityZones.set(
      vpcId,
      Math.max(required, requestedAvailabilityZones.get(vpcId) ?? 0),
    );
  };
  const permitsAvailabilityZones = (required: number): boolean => {
    if (!singleExplicitVpcCapacity) return true;
    if (required <= singleExplicitVpcCapacity.maximum) return true;
    recordRequestedAvailabilityZones(
      singleExplicitVpcCapacity.resource.id,
      required,
    );
    return false;
  };

  if (
    resources.some((resource) => SECURITY_GROUP_TYPES.has(resource.type)) &&
    !hasType("SecurityGroup") &&
    initialVpcCandidates.length <= 1
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
  const deferNetworkSubnetInference = initialVpcCandidates.length > 1;
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

    if (needsPublicSubnet && !hasPublicSubnet && !deferNetworkSubnetInference) {
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
    const publicAvailabilityZoneCount = new Set(
      resourcesOfType("Subnet")
        .filter(
          (resource) =>
            resource.zone === "public" ||
            resource.properties.subnetType === "public",
        )
        .map(semanticAvailabilityZone),
    ).size;
    if (
      hasType("ELB") &&
      publicAvailabilityZoneCount < 2 &&
      !deferNetworkSubnetInference &&
      permitsAvailabilityZones(2)
    ) {
      const allSubnets = resourcesOfType("Subnet");
      const publicSubnets = allSubnets.filter(
        (resource) =>
          resource.zone === "public" ||
          resource.properties.subnetType === "public",
      );
      addGeneratedResource({
        requestedId: "inferred-subnet-public-secondary",
        type: "Subnet",
        name: "Minimal secondary public subnet",
        properties: {
          availabilityZone: selectAdditionalSemanticAvailabilityZone(
            allSubnets,
            publicSubnets,
          ),
          subnetType: "public",
        },
        origin: "inferred-minimal",
        reason: "Application load balancers require public subnets in at least two availability zones.",
        confidence: 1,
        approvalStatus: "not-required",
        zone: "public",
      });
    }
    if (needsPrivateSubnet && !hasPrivateSubnet && !deferNetworkSubnetInference) {
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
  const computeReplicaPrimaryIds = new Map<string, string>();
  if (primaryCompute && originalCompute.length < desiredComputeCount) {
    for (
      let index = originalCompute.length + 1;
      index <= desiredComputeCount;
      index += 1
    ) {
      const replica = addGeneratedResource({
        requestedId: generatedId(["stage", primaryCompute.sourceId, "replica", String(index)]),
        type: "EC2",
        name: nameWithSuffix(primaryCompute.name, ` replica ${index}`),
        properties: { ...primaryCompute.properties },
        origin: "stage-upgrade",
        reason: `The ${stageRecommendation.stage} stage proposes redundant compute capacity.`,
        approvalStatus: "pending",
        zone: primaryCompute.zone,
      });
      if (!replica) break;
      computeReplicaPrimaryIds.set(replica.id, primaryCompute.id);
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
  const stagedPublicAvailabilityZoneCount = new Set(
    stagedPublicSubnets.map(semanticAvailabilityZone),
  ).size;
  const needsStagedPublicSubnet =
    Boolean(stagedIngress) && stagedPublicAvailabilityZoneCount < 2;
  const stagedComputeExists = resourcesOfType("EC2").some(
    (resource) => resource.origin === "stage-upgrade",
  );
  const computeUsesPublicSubnets = primaryCompute?.zone === "public";
  const compatibleComputeSubnets = resourcesOfType("Subnet").filter((resource) =>
    computeUsesPublicSubnets
      ? resource.zone === "public" || resource.properties.subnetType === "public"
      : resource.zone !== "public" && resource.properties.subnetType !== "public",
  );
  const compatibleComputeAvailabilityZoneCount = new Set(
    compatibleComputeSubnets.map(semanticAvailabilityZone),
  ).size;
  const needsStagedComputeSubnet =
    stagedComputeExists && compatibleComputeAvailabilityZoneCount < 2;
  const subnetAvailabilityZoneCount = new Set(
    resourcesOfType("Subnet").map(semanticAvailabilityZone),
  ).size;
  const needsProductionSubnet =
    stageRecommendation.stage === "production" &&
    subnetAvailabilityZoneCount < 2;
  if (
    hasType("VPC") &&
    initialVpcCandidates.length <= 1 &&
    (needsStagedPublicSubnet || needsStagedComputeSubnet || needsProductionSubnet)
  ) {
    if (permitsAvailabilityZones(2)) {
      const publicUpgrade =
        needsStagedPublicSubnet ||
        (needsStagedComputeSubnet && computeUsesPublicSubnets) ||
        directExternalComputeIds.size > 0;
      const allSubnets = resourcesOfType("Subnet");
      const occupiedSubnets = needsStagedPublicSubnet
        ? stagedPublicSubnets
        : needsStagedComputeSubnet
          ? compatibleComputeSubnets
          : allSubnets;
      addGeneratedResource({
        requestedId: "stage-subnet-secondary",
        type: "Subnet",
        name: "Recommended secondary subnet",
        properties: {
          availabilityZone: selectAdditionalSemanticAvailabilityZone(
            allSubnets,
            occupiedSubnets,
          ),
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

  const subnetsById = new Map(subnets.map((subnet) => [subnet.id, subnet]));
  const vpcIds = new Set(vpcs.map((vpc) => vpc.id));
  const resourceOwnerIds = new Map<string, Set<string>>();
  const containedSubnetIds = new Map<string, Set<string>>();
  for (const relationship of relationships) {
    if (
      relationship.kind !== "contains" ||
      relationship.approvalStatus === "rejected" ||
      !vpcIds.has(relationship.sourceId)
    ) {
      continue;
    }
    const owners =
      resourceOwnerIds.get(relationship.targetId) ?? new Set<string>();
    owners.add(relationship.sourceId);
    resourceOwnerIds.set(relationship.targetId, owners);
    if (!subnetsById.has(relationship.targetId)) continue;
    const contained =
      containedSubnetIds.get(relationship.sourceId) ?? new Set<string>();
    contained.add(relationship.targetId);
    containedSubnetIds.set(relationship.sourceId, contained);
  }

  const ownerIdsFor = (resourceIds: string[]): Set<string> => {
    const ownerIds = new Set<string>();
    for (const resourceId of resourceIds) {
      for (const ownerId of resourceOwnerIds.get(resourceId) ?? []) {
        ownerIds.add(ownerId);
      }
    }
    return ownerIds;
  };
  const commonOwnerIdsFor = (resourceIds: string[]): Set<string> => {
    let commonOwnerIds: Set<string> | undefined;
    for (const resourceId of resourceIds) {
      const owners = resourceOwnerIds.get(resourceId);
      if (!owners || owners.size === 0) continue;
      commonOwnerIds = commonOwnerIds
        ? new Set(
            [...commonOwnerIds].filter((ownerId) => owners.has(ownerId)),
          )
        : new Set(owners);
    }
    return commonOwnerIds ?? new Set<string>();
  };
  const intersectOwnerIds = (
    candidates: Set<string>,
    evidence: Set<string>,
  ): Set<string> =>
    new Set([...candidates].filter((candidate) => evidence.has(candidate)));
  const rawPlacementSubnetsFor = (hosted: WorkingResource): WorkingResource[] => {
    const preferred = hosted.zone === "public" ? publicSubnets : privateSubnets;
    return preferred.length > 0 ? preferred : subnets;
  };
  const ensureOwnerScopedElbSubnets = (ownerId: string): void => {
    const owner = vpcs.find((vpc) => vpc.id === ownerId);
    if (!owner) return;
    const explicitMaximum =
      owner.origin === "explicit" &&
      typeof owner.properties.maxAvailabilityZones === "number"
        ? owner.properties.maxAvailabilityZones
        : undefined;

    while (true) {
      const ownerSubnets = subnets.filter(
        (subnet) => resourceOwnerIds.get(subnet.id)?.has(ownerId) ?? false,
      );
      const ownerPublicSubnets = ownerSubnets.filter(
        (subnet) =>
          subnet.zone === "public" || subnet.properties.subnetType === "public",
      );
      const publicAvailabilityZones = new Set(
        ownerPublicSubnets.map(semanticAvailabilityZone),
      );
      if (publicAvailabilityZones.size >= 2) return;

      const ownerAvailabilityZones = new Set(
        ownerSubnets.map(semanticAvailabilityZone),
      );
      const reusableAvailabilityZoneExists = [...ownerAvailabilityZones].some(
        (availabilityZone) => !publicAvailabilityZones.has(availabilityZone),
      );
      if (
        !reusableAvailabilityZoneExists &&
        explicitMaximum !== undefined &&
        ownerAvailabilityZones.size >= explicitMaximum
      ) {
        return;
      }

      const availabilityZone = selectAdditionalSemanticAvailabilityZone(
        ownerSubnets,
        ownerPublicSubnets,
      );
      const subnet = addGeneratedResource({
        requestedId: generatedId([
          "inferred",
          "subnet",
          "public",
          ownerId,
          availabilityZone,
        ]),
        type: "Subnet",
        name: nameWithSuffix(owner.name, " public subnet"),
        properties: {
          availabilityZone,
          subnetType: "public",
        },
        origin: "inferred-minimal",
        reason: `${owner.name} needs public subnet coverage in another availability zone for its load balancer.`,
        confidence: 1,
        approvalStatus: "not-required",
        zone: "public",
      });
      if (!subnet) return;
      subnets.push(subnet);
      subnets.sort((left, right) => compareText(left.id, right.id));
      publicSubnets.push(subnet);
      publicSubnets.sort((left, right) => compareText(left.id, right.id));
      subnetsById.set(subnet.id, subnet);
      resourceOwnerIds.set(subnet.id, new Set([ownerId]));
      const contained = containedSubnetIds.get(ownerId) ?? new Set<string>();
      contained.add(subnet.id);
      containedSubnetIds.set(ownerId, contained);
      addRelationship({
        source: owner,
        target: subnet,
        kind: "contains",
        reason: `${subnet.name} is scoped to the resolved load-balancer VPC.`,
      });
    }
  };
  const ensureOwnerScopedWorkloadSubnet = (
    hosted: WorkingResource,
    ownerId: string,
  ): void => {
    const owner = vpcs.find((vpc) => vpc.id === ownerId);
    if (!owner) return;
    const publicPlacement = hosted.zone === "public";
    const ownerSubnets = subnets.filter(
      (subnet) => resourceOwnerIds.get(subnet.id)?.has(ownerId) ?? false,
    );
    const compatibleSubnets = ownerSubnets.filter((subnet) =>
      publicPlacement
        ? subnet.zone === "public" || subnet.properties.subnetType === "public"
        : subnet.zone !== "public" && subnet.properties.subnetType !== "public",
    );
    if (compatibleSubnets.length > 0) return;

    const subnetType = publicPlacement ? "public" : "private";
    const availabilityZone = selectAdditionalSemanticAvailabilityZone(
      ownerSubnets,
      [],
    );
    const subnet = addGeneratedResource({
      requestedId: generatedId([
        "inferred",
        "subnet",
        subnetType,
        ownerId,
        availabilityZone,
      ]),
      type: "Subnet",
      name: nameWithSuffix(owner.name, ` ${subnetType} subnet`),
      properties: { availabilityZone, subnetType },
      origin: "inferred-minimal",
      reason: `${hosted.name} needs a compatible subnet inside ${owner.name}.`,
      confidence: 1,
      approvalStatus: "not-required",
      zone: subnetType,
    });
    if (!subnet) return;
    subnets.push(subnet);
    subnets.sort((left, right) => compareText(left.id, right.id));
    (publicPlacement ? publicSubnets : privateSubnets).push(subnet);
    publicSubnets.sort((left, right) => compareText(left.id, right.id));
    privateSubnets.sort((left, right) => compareText(left.id, right.id));
    subnetsById.set(subnet.id, subnet);
    resourceOwnerIds.set(subnet.id, new Set([ownerId]));
    const contained = containedSubnetIds.get(ownerId) ?? new Set<string>();
    contained.add(subnet.id);
    containedSubnetIds.set(ownerId, contained);
    addRelationship({
      source: owner,
      target: subnet,
      kind: "contains",
      reason: `${subnet.name} is scoped to the resolved workload VPC.`,
    });
  };
  const ensureOwnerScopedComputeStageSubnet = (
    hosted: WorkingResource,
    ownerId: string,
  ): void => {
    if (
      hosted.type !== "EC2" ||
      hosted.id !== primaryCompute?.id ||
      desiredComputeCount <= 1
    ) {
      return;
    }
    const owner = vpcs.find((vpc) => vpc.id === ownerId);
    if (!owner) return;
    const publicPlacement = hosted.zone === "public";
    const ownerSubnets = subnets.filter(
      (subnet) => resourceOwnerIds.get(subnet.id)?.has(ownerId) ?? false,
    );
    const compatibleSubnets = ownerSubnets.filter((subnet) =>
      publicPlacement
        ? subnet.zone === "public" || subnet.properties.subnetType === "public"
        : subnet.zone !== "public" && subnet.properties.subnetType !== "public",
    );
    const compatibleAvailabilityZones = new Set(
      compatibleSubnets.map(semanticAvailabilityZone),
    );
    if (compatibleAvailabilityZones.size >= 2) return;

    recordRequestedAvailabilityZones(ownerId, 2);
    const ownerAvailabilityZones = new Set(
      ownerSubnets.map(semanticAvailabilityZone),
    );
    const reusableAvailabilityZoneExists = [...ownerAvailabilityZones].some(
      (availabilityZone) =>
        !compatibleAvailabilityZones.has(availabilityZone),
    );
    const explicitMaximum =
      owner.origin === "explicit" &&
      typeof owner.properties.maxAvailabilityZones === "number"
        ? owner.properties.maxAvailabilityZones
        : undefined;
    if (
      !reusableAvailabilityZoneExists &&
      explicitMaximum !== undefined &&
      ownerAvailabilityZones.size >= explicitMaximum
    ) {
      return;
    }

    const subnetType = publicPlacement ? "public" : "private";
    const availabilityZone = selectAdditionalSemanticAvailabilityZone(
      ownerSubnets,
      compatibleSubnets,
    );
    const subnet = addGeneratedResource({
      requestedId: generatedId([
        "stage",
        "subnet",
        "secondary",
        ownerId,
      ]),
      type: "Subnet",
      name: nameWithSuffix(owner.name, " secondary subnet"),
      properties: { availabilityZone, subnetType },
      origin: "stage-upgrade",
      reason: `The ${stageRecommendation.stage} stage proposes capacity in a second availability zone inside ${owner.name}.`,
      approvalStatus: "pending",
      zone: subnetType,
    });
    if (!subnet) return;
    subnets.push(subnet);
    subnets.sort((left, right) => compareText(left.id, right.id));
    (publicPlacement ? publicSubnets : privateSubnets).push(subnet);
    publicSubnets.sort((left, right) => compareText(left.id, right.id));
    privateSubnets.sort((left, right) => compareText(left.id, right.id));
    subnetsById.set(subnet.id, subnet);
    resourceOwnerIds.set(subnet.id, new Set([ownerId]));
    const contained = containedSubnetIds.get(ownerId) ?? new Set<string>();
    contained.add(subnet.id);
    containedSubnetIds.set(ownerId, contained);
    addRelationship({
      source: owner,
      target: subnet,
      kind: "contains",
      reason: `${subnet.name} is scoped to the resolved compute VPC.`,
    });
  };
  const ensureOwnerScopedSecurityGroup = (ownerId: string): void => {
    if (
      securityGroups.some(
        (securityGroup) =>
          resourceOwnerIds.get(securityGroup.id)?.has(ownerId) ?? false,
      )
    ) {
      return;
    }
    const owner = vpcs.find((vpc) => vpc.id === ownerId);
    if (!owner) return;
    const securityGroup = addGeneratedResource({
      requestedId: generatedId([
        "inferred",
        "security-group",
        ownerId,
      ]),
      type: "SecurityGroup",
      name: nameWithSuffix(owner.name, " security group"),
      properties: { allowAllOutbound: true },
      origin: "inferred-minimal",
      reason: `${owner.name} needs a security boundary for its network-attached workloads.`,
      confidence: 1,
      approvalStatus: "not-required",
      zone: "private",
    });
    if (!securityGroup) return;
    securityGroups.push(securityGroup);
    securityGroups.sort((left, right) => compareText(left.id, right.id));
    resourceOwnerIds.set(securityGroup.id, new Set([ownerId]));
    addRelationship({
      source: owner,
      target: securityGroup,
      kind: "contains",
      reason: `${securityGroup.name} is scoped to the resolved workload VPC.`,
    });
  };
  const hostedVpcOwnerIds = new Map<string, string>();
  const blockedHostedVpcIds = new Set<string>();
  for (const hosted of resources
    .filter((resource) => HOSTED_TYPES.has(resource.type))
    .sort(
      (left, right) =>
        Number(computeReplicaPrimaryIds.has(left.id)) -
          Number(computeReplicaPrimaryIds.has(right.id)) ||
        compareText(left.id, right.id),
    )) {
    const explicitHosting = relationships.filter(
      (relationship) =>
        relationship.origin === "explicit" &&
        relationship.kind === "hosts" &&
        relationship.targetId === hosted.id &&
        subnetsById.has(relationship.sourceId),
    );
    const explicitProtection = relationships.filter(
      (relationship) =>
        relationship.origin === "explicit" &&
        relationship.kind === "protects" &&
        relationship.targetId === hosted.id &&
        securityGroups.some(
          (securityGroup) => securityGroup.id === relationship.sourceId,
        ),
    );
    const strongOwnerEvidence: Set<string>[] = [];
    const addStrongOwnerEvidence = (ownerIds: Set<string>): void => {
      if (ownerIds.size > 0) strongOwnerEvidence.push(ownerIds);
    };
    addStrongOwnerEvidence(resourceOwnerIds.get(hosted.id) ?? new Set<string>());
    const replicaPrimaryOwnerId = hostedVpcOwnerIds.get(
      computeReplicaPrimaryIds.get(hosted.id) ?? "",
    );
    if (replicaPrimaryOwnerId) {
      addStrongOwnerEvidence(new Set([replicaPrimaryOwnerId]));
    }
    addStrongOwnerEvidence(
      ownerIdsFor(explicitHosting.map((relationship) => relationship.sourceId)),
    );
    addStrongOwnerEvidence(
      ownerIdsFor(
        explicitProtection.map((relationship) => relationship.sourceId),
      ),
    );
    if (
      explicitProtection.length === 0 &&
      securityGroups.length === 1 &&
      securityGroups[0]?.origin === "explicit"
    ) {
      addStrongOwnerEvidence(ownerIdsFor([securityGroups[0]!.id]));
    }
    const ownerEvidence = [...strongOwnerEvidence];
    if (ownerEvidence.length === 0 && explicitHosting.length === 0) {
      const compatibleSubnetOwners =
        commonOwnerIdsFor(
          rawPlacementSubnetsFor(hosted).map((subnet) => subnet.id),
        );
      if (compatibleSubnetOwners.size > 0) {
        ownerEvidence.push(compatibleSubnetOwners);
      }
    }

    let ownerCandidates = new Set(vpcIds);
    for (const evidence of ownerEvidence) {
      ownerCandidates = intersectOwnerIds(ownerCandidates, evidence);
    }
    if (ownerCandidates.size === 1) {
      const [ownerId] = ownerCandidates;
      if (ownerId) {
        hostedVpcOwnerIds.set(hosted.id, ownerId);
        if (hosted.type === "ELB" && explicitHosting.length === 0) {
          recordRequestedAvailabilityZones(ownerId, 2);
          ensureOwnerScopedElbSubnets(ownerId);
        } else if (explicitHosting.length === 0) {
          ensureOwnerScopedWorkloadSubnet(hosted, ownerId);
        }
        ensureOwnerScopedComputeStageSubnet(hosted, ownerId);
        if (explicitProtection.length === 0) {
          ensureOwnerScopedSecurityGroup(ownerId);
        }
      }
      continue;
    }
    if (vpcs.length === 0) continue;

    blockedHostedVpcIds.add(hosted.id);
    diagnostics.push({
      level: "error",
      code: "AMBIGUOUS_VPC_ATTACHMENT",
      message:
        ownerCandidates.size === 0
          ? `${hosted.name} has conflicting subnet and security-group VPC topology.`
          : `${hosted.name} cannot be placed because multiple VPC candidates remain.`,
      resourceId: hosted.id,
      suggestion:
        "Align explicit contains, hosts, and protects relationships to one VPC.",
    });
  }

  const explicitVpcCapacities = new Map<
    string,
    { maximum: number; resource: WorkingResource }
  >();
  const allowedSubnetIdsByVpc = new Map<string, Set<string>>();
  for (const vpc of vpcs) {
    const maximum = vpc.properties.maxAvailabilityZones;
    if (vpc.origin !== "explicit" || typeof maximum !== "number") continue;
    explicitVpcCapacities.set(vpc.id, { maximum, resource: vpc });
    const contained = [...(containedSubnetIds.get(vpc.id) ?? [])]
      .map((subnetId) => subnetsById.get(subnetId))
      .filter((subnet): subnet is WorkingResource => subnet !== undefined);
    const availabilityZones = [
      ...new Set(contained.map(semanticAvailabilityZone)),
    ].sort(compareSemanticAvailabilityZone);
    const requested = Math.max(
      availabilityZones.length,
      requestedAvailabilityZones.get(vpc.id) ?? 0,
    );
    if (requested > maximum) {
      diagnostics.push({
        level: "error",
        code: "VPC_AVAILABILITY_ZONE_CAP",
        message: `${vpc.name} allows ${maximum} availability zone${maximum === 1 ? "" : "s"}, but the accepted topology or workload requires ${requested}.`,
        path: `resources.${vpc.id}.properties.maxAvailabilityZones`,
        resourceId: vpc.id,
        suggestion:
          "Increase maxAvailabilityZones or reduce the topology and workload availability requirements.",
      });
    }
    const allowedAvailabilityZones = new Set(
      availabilityZones.slice(0, Math.max(0, Math.floor(maximum))),
    );
    allowedSubnetIdsByVpc.set(
      vpc.id,
      new Set(
        contained
          .filter((subnet) =>
            allowedAvailabilityZones.has(semanticAvailabilityZone(subnet)),
          )
          .map((subnet) => subnet.id),
      ),
    );
  }

  const isPlacementAllowedByVpcCap = (subnet: WorkingResource): boolean => {
    const owners = resourceOwnerIds.get(subnet.id);
    if (!owners || owners.size === 0) return true;
    return [...owners].every((ownerId) => {
      if (!explicitVpcCapacities.has(ownerId)) return true;
      return allowedSubnetIdsByVpc.get(ownerId)?.has(subnet.id) ?? false;
    });
  };
  const placementSubnets = subnets.filter(isPlacementAllowedByVpcCap);
  const placementPublicSubnets = publicSubnets.filter(isPlacementAllowedByVpcCap);
  const placementPrivateSubnets = privateSubnets.filter(isPlacementAllowedByVpcCap);

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
    const resolvedVpcOwnerId = hostedVpcOwnerIds.get(hosted.id);
    const isInResolvedVpc = (resource: WorkingResource): boolean =>
      !resolvedVpcOwnerId ||
      (resourceOwnerIds.get(resource.id)?.has(resolvedVpcOwnerId) ?? false);
    if (!hasExplicitHosting && !blockedHostedVpcIds.has(hosted.id)) {
      const preferred =
        hosted.zone === "public"
          ? placementPublicSubnets
          : placementPrivateSubnets;
      const comparePlacementSubnet = (
        left: WorkingResource,
        right: WorkingResource,
      ): number =>
        (hosted.origin === "stage-upgrade" ? -1 : 1) *
          (Number(left.origin === "stage-upgrade") -
            Number(right.origin === "stage-upgrade")) ||
        compareText(left.id, right.id);
      const preferredInVpc = preferred
        .filter(isInResolvedVpc)
        .sort(comparePlacementSubnet);
      const fallbackInVpc = placementSubnets
        .filter(isInResolvedVpc)
        .sort(comparePlacementSubnet);
      const compatibleCandidates =
        preferredInVpc.length > 0 ? preferredInVpc : fallbackInVpc;
      const candidates =
        hosted.origin === "stage-upgrade"
          ? compatibleCandidates
          : compatibleCandidates.filter(
              (candidate) => candidate.origin !== "stage-upgrade",
            );
      const placementKey = `${resolvedVpcOwnerId ?? "unscoped"}:${
        hosted.zone === "public" ? "public" : "private"
      }:${hosted.origin === "stage-upgrade" ? "staged" : "durable"}`;
      const offset = placementOffsets.get(placementKey) ?? 0;
      let selectedSubnets: WorkingResource[];
      if (hosted.type === "ELB") {
        const selectedAvailabilityZones = new Set<string>();
        selectedSubnets = candidates.filter((candidate) => {
          const availabilityZone = semanticAvailabilityZone(candidate);
          if (selectedAvailabilityZones.has(availabilityZone)) return false;
          selectedAvailabilityZones.add(availabilityZone);
          return true;
        });
      } else {
        selectedSubnets =
          candidates.length > 0
            ? [candidates[offset % candidates.length]!]
            : [];
      }
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
    if (blockedHostedVpcIds.has(hosted.id)) continue;
    const protectionCandidates = securityGroups.filter(isInResolvedVpc);
    if (protectionCandidates.length > 1) {
      diagnostics.push({
        level: "error",
        code: "AMBIGUOUS_SECURITY_GROUP_ATTACHMENT",
        message: `${hosted.name} cannot be protected because multiple security-group candidates exist.`,
        resourceId: hosted.id,
        suggestion: "Add an explicit protects relationship from the intended security group.",
      });
      continue;
    }
    const [securityGroup] = protectionCandidates;
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
    const stagedIngressOwnerId = hostedVpcOwnerIds.get(stagedIngress.id);
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
      if (
        !stagedIngressOwnerId ||
        hostedVpcOwnerIds.get(compute.id) !== stagedIngressOwnerId
      ) {
        continue;
      }
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

import { describe, expect, it } from "vitest";

import {
  AWS_RESOURCE_TYPES,
  architectureSchema,
  deploymentPlanSchema,
  diagnosticSchema,
  stageDecisionSchema,
  type InfrastructureIntent,
} from "@architect/contracts/infrastructure";
import {
  defaultRequirementsProfile,
  type RequirementsProfile,
} from "@architect/contracts/requirements";

import { RESOURCE_CATALOG } from "./catalog.js";
import {
  buildDeploymentPlan,
  compileIntent,
  materializeApprovedArchitecture,
} from "./compiler.js";

const baseRequirements = (
  overrides: Partial<RequirementsProfile> = {},
): RequirementsProfile => ({
  ...defaultRequirementsProfile(),
  ...overrides,
});

const criticalExternalRequirements = baseRequirements({
  criticality: "business_critical",
  traffic: "high",
  burstiness: "bursty",
  availability: "high_availability",
});

const ec2Intent: InfrastructureIntent = {
  version: "infrastructure-intent/v1",
  resources: [
    { id: "user", type: "External", name: "Customer", properties: {} },
    {
      id: "app",
      type: "EC2",
      name: "Application",
      zone: "public",
      properties: { instanceType: "t3.micro" },
    },
  ],
  relationships: [
    {
      id: "user-to-app",
      sourceId: "user",
      targetId: "app",
      kind: "routes",
    },
  ],
};

describe("compileIntent", () => {
  it("keeps explicit, minimally inferred, and approval-gated resources distinguishable", () => {
    const result = compileIntent(ec2Intent, criticalExternalRequirements);

    expect(
      result.architecture.resources.find((resource) => resource.id === "app")
        ?.origin,
    ).toBe("explicit");
    expect(
      result.architecture.resources.some(
        (resource) => resource.origin === "inferred-minimal",
      ),
    ).toBe(true);
    expect(
      result.architecture.resources.some(
        (resource) => resource.origin === "stage-upgrade",
      ),
    ).toBe(true);
    expect(
      result.architecture.resources
        .filter((resource) => resource.origin === "stage-upgrade")
        .every((resource) => resource.approvalStatus === "pending"),
    ).toBe(true);
    expect(
      result.architecture.relationships
        .filter((relationship) => relationship.origin === "stage-upgrade")
        .every((relationship) => relationship.approvalStatus === "pending"),
    ).toBe(true);

    expect(result.deploymentPlan).toMatchObject({
      stage: "growth",
      requiresApproval: true,
      approvalsSatisfied: false,
    });
    expect(result.deploymentPlan.pendingApprovalResourceIds).not.toHaveLength(0);
    expect(result.deploymentPlan.pendingApprovalRelationshipIds).toEqual(
      result.architecture.relationships
        .filter(
          (relationship) =>
            relationship.origin === "stage-upgrade" &&
            relationship.approvalStatus === "pending",
        )
        .map((relationship) => relationship.id)
        .sort(),
    );
    expect(result.deploymentPlan.pendingApprovalRelationshipIds).not.toHaveLength(0);
    expect(architectureSchema.parse(result.architecture)).toEqual(result.architecture);
    expect(deploymentPlanSchema.parse(result.deploymentPlan)).toEqual(
      result.deploymentPlan,
    );
  });

  it("reconciles the compiled stage decision with graph-specific upgrades", () => {
    const internalGrowth = baseRequirements({
      audience: "internal",
      expectedUsers: "global",
      asyncWorkload: true,
    });
    const internalEc2 = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "app", type: "EC2", name: "App", zone: "private", properties: {} },
        ],
        relationships: [],
      },
      internalGrowth,
    );
    const growthS3 = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "bucket", type: "S3", name: "Bucket", properties: {} },
        ],
        relationships: [],
      },
      baseRequirements({
        audience: "internal",
        criticality: "business_critical",
        traffic: "high",
        burstiness: "bursty",
      }),
    );

    expect(internalEc2.stageDecision.stage).toBe("growth");
    expect(internalEc2.stageDecision.requiresApproval).toBe(true);
    expect(internalEc2.stageDecision.requiresApproval).toBe(
      internalEc2.deploymentPlan.requiresApproval,
    );
    const affectedIds = new Set(
      internalEc2.stageDecision.proposedUpgrades.flatMap((proposal) => proposal.affects),
    );
    expect(
      internalEc2.deploymentPlan.pendingApprovalResourceIds.every((id) =>
        affectedIds.has(id),
      ),
    ).toBe(true);
    expect(
      [...affectedIds].every((id) =>
        internalEc2.architecture.resources.some((resource) => resource.id === id),
      ),
    ).toBe(true);

    expect(growthS3.stageDecision.stage).toBe("growth");
    expect(growthS3.stageDecision).toMatchObject({
      requiresApproval: false,
      proposedUpgrades: [],
    });
    expect(growthS3.deploymentPlan).toMatchObject({
      requiresApproval: false,
      approvalsSatisfied: true,
      pendingApprovalResourceIds: [],
      pendingApprovalRelationshipIds: [],
    });
  });

  it("preserves explicit and generated zones in the semantic architecture", () => {
    const result = compileIntent(ec2Intent, criticalExternalRequirements);

    expect(
      result.architecture.resources.find((resource) => resource.id === "app")?.zone,
    ).toBe("public");
    expect(
      result.architecture.resources.find((resource) => resource.id === "inferred-vpc")
        ?.zone,
    ).toBe("regional");
    expect(
      result.architecture.resources.find((resource) => resource.id === "stage-elb")?.zone,
    ).toBe("public");
  });

  it("uses stable IDs, sorting, and output regardless of input order", () => {
    const reversed: InfrastructureIntent = {
      ...ec2Intent,
      resources: [...ec2Intent.resources].reverse(),
      relationships: [...ec2Intent.relationships].reverse(),
    };

    const first = compileIntent(ec2Intent, criticalExternalRequirements);
    const second = compileIntent(reversed, criticalExternalRequirements);

    expect(second).toEqual(first);
    expect(first.architecture.resources.map((resource) => resource.id)).toEqual(
      [...first.architecture.resources.map((resource) => resource.id)].sort(),
    );
    expect(
      first.architecture.relationships.map((relationship) => relationship.id),
    ).toEqual(
      [...first.architecture.relationships.map((relationship) => relationship.id)].sort(),
    );
  });

  it("canonicalizes property key order in architecture and deployment output", () => {
    const intentWith = (
      properties: Record<string, string | number | boolean>,
    ): InfrastructureIntent => ({
      version: "infrastructure-intent/v1",
      resources: [
        { id: "function", type: "Lambda", name: "Function", properties },
      ],
      relationships: [],
    });
    const first = compileIntent(
      intentWith(Object.fromEntries([["zeta", true], ["alpha", "first"]])),
      baseRequirements(),
    );
    const second = compileIntent(
      intentWith(Object.fromEntries([["alpha", "first"], ["zeta", true]])),
      baseRequirements(),
    );

    expect(JSON.stringify(first.architecture)).toBe(JSON.stringify(second.architecture));
    expect(JSON.stringify(first.deploymentPlan)).toBe(JSON.stringify(second.deploymentPlan));
    expect(Object.keys(first.architecture.resources[0]?.properties ?? {})).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("marks generated topology relationships inferred when all nodes are explicit", () => {
    const result = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "vpc", type: "VPC", name: "VPC", zone: "regional", properties: {} },
          {
            id: "subnet",
            type: "Subnet",
            name: "Subnet",
            zone: "private",
            properties: { subnetType: "private" },
          },
          {
            id: "security",
            type: "SecurityGroup",
            name: "Security",
            zone: "private",
            properties: {},
          },
          { id: "app", type: "EC2", name: "App", zone: "private", properties: {} },
        ],
        relationships: [],
      },
      baseRequirements({ audience: "internal" }),
    );

    expect(result.architecture.relationships.length).toBeGreaterThan(0);
    expect(
      result.architecture.relationships.every(
        (relationship) =>
          relationship.origin === "inferred-minimal" &&
          relationship.approvalStatus === "not-required",
      ),
    ).toBe(true);
  });

  it("diagnoses duplicate resource and relationship IDs without returning an invalid graph", () => {
    const intent = {
      version: "infrastructure-intent/v1",
      resources: [
        { id: "worker", type: "SQS", name: "Queue", properties: {} },
        { id: "worker", type: "Lambda", name: "Worker", properties: {} },
        { id: "sink", type: "S3", name: "Sink", properties: {} },
      ],
      relationships: [
        {
          id: "duplicate-link",
          sourceId: "worker",
          targetId: "sink",
          kind: "writes",
        },
        {
          id: "duplicate-link",
          sourceId: "sink",
          targetId: "worker",
          kind: "reads",
        },
      ],
    } as const satisfies InfrastructureIntent;

    const result = compileIntent(intent, baseRequirements());

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_RESOURCE_ID", resourceId: "worker" }),
        expect.objectContaining({
          code: "DUPLICATE_RELATIONSHIP_ID",
          relationshipId: "duplicate-link",
        }),
      ]),
    );
    expect(
      result.architecture.resources.filter((resource) => resource.id === "worker"),
    ).toHaveLength(1);
    expect(
      result.architecture.relationships.filter(
        (relationship) => relationship.id === "duplicate-link",
      ),
    ).toHaveLength(1);
    expect(architectureSchema.safeParse(result.architecture).success).toBe(true);

    const reversed = compileIntent(
      {
        ...intent,
        resources: [...intent.resources].reverse(),
        relationships: [...intent.relationships].reverse(),
      },
      baseRequirements(),
    );
    expect(reversed).toEqual(result);
  });

  it("diagnoses and omits dangling relationships", () => {
    const result = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "api", type: "APIGateway", name: "API", properties: {} },
        ],
        relationships: [
          {
            id: "api-to-missing",
            sourceId: "api",
            targetId: "missing",
            kind: "invokes",
          },
        ],
      },
      baseRequirements(),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "DANGLING_RELATIONSHIP",
        relationshipId: "api-to-missing",
      }),
    );
    expect(result.architecture.relationships).toEqual([]);
  });

  it("blocks ambiguous VPC attachment instead of selecting the first candidate", () => {
    const result = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "vpc-a", type: "VPC", name: "VPC A", properties: {} },
          { id: "vpc-b", type: "VPC", name: "VPC B", properties: {} },
          {
            id: "subnet",
            type: "Subnet",
            name: "Subnet",
            zone: "private",
            properties: { subnetType: "private" },
          },
        ],
        relationships: [],
      },
      baseRequirements({ audience: "internal" }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "AMBIGUOUS_VPC_ATTACHMENT",
        resourceId: "subnet",
      }),
    );
    expect(
      result.architecture.relationships.some(
        (relationship) =>
          relationship.kind === "contains" && relationship.targetId === "subnet",
      ),
    ).toBe(false);
  });

  it("blocks ambiguous security-group protection instead of selecting the first candidate", () => {
    const result = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "vpc", type: "VPC", name: "VPC", properties: {} },
          {
            id: "subnet",
            type: "Subnet",
            name: "Subnet",
            zone: "private",
            properties: { subnetType: "private" },
          },
          { id: "sg-web", type: "SecurityGroup", name: "Web SG", properties: {} },
          { id: "sg-admin", type: "SecurityGroup", name: "Admin SG", properties: {} },
          { id: "app", type: "EC2", name: "App", zone: "private", properties: {} },
        ],
        relationships: [],
      },
      baseRequirements({ audience: "internal" }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "AMBIGUOUS_SECURITY_GROUP_ATTACHMENT",
        resourceId: "app",
      }),
    );
    expect(
      result.architecture.relationships.some(
        (relationship) =>
          relationship.kind === "protects" && relationship.targetId === "app",
      ),
    ).toBe(false);
  });

  it("preserves explicit contains, hosts, and protects attachments without extra inference", () => {
    const explicitIds = ["vpc-subnet", "vpc-sg", "subnet-app", "sg-app"];
    const result = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "vpc-a", type: "VPC", name: "VPC A", properties: {} },
          { id: "vpc-b", type: "VPC", name: "VPC B", properties: {} },
          {
            id: "subnet-a",
            type: "Subnet",
            name: "Subnet A",
            zone: "private",
            properties: { subnetType: "private" },
          },
          {
            id: "subnet-b",
            type: "Subnet",
            name: "Subnet B",
            zone: "private",
            properties: { subnetType: "private" },
          },
          { id: "sg-web", type: "SecurityGroup", name: "Web SG", properties: {} },
          { id: "sg-admin", type: "SecurityGroup", name: "Admin SG", properties: {} },
          { id: "app", type: "EC2", name: "App", zone: "private", properties: {} },
        ],
        relationships: [
          { id: "vpc-subnet", sourceId: "vpc-b", targetId: "subnet-b", kind: "contains" },
          { id: "vpc-sg", sourceId: "vpc-b", targetId: "sg-web", kind: "contains" },
          { id: "subnet-app", sourceId: "subnet-b", targetId: "app", kind: "hosts" },
          { id: "sg-app", sourceId: "sg-web", targetId: "app", kind: "protects" },
        ],
      },
      baseRequirements({ audience: "internal" }),
    );

    expect(
      result.architecture.relationships
        .filter((relationship) => explicitIds.includes(relationship.id))
        .every((relationship) => relationship.origin === "explicit"),
    ).toBe(true);
    expect(
      result.architecture.relationships.filter(
        (relationship) =>
          relationship.targetId === "app" &&
          (relationship.kind === "hosts" || relationship.kind === "protects"),
      ),
    ).toHaveLength(2);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.resourceId === "app" && diagnostic.code.startsWith("AMBIGUOUS_"),
      ),
    ).toBe(false);
  });

  it("blocks unsupported synth resources but keeps diagram-only actors nonblocking", () => {
    const result = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "producer", type: "External", name: "Producer", properties: {} },
          { id: "events", type: "MSK", name: "Events", properties: {} },
        ],
        relationships: [
          {
            sourceId: "producer",
            targetId: "events",
            kind: "publishes",
          },
        ],
      },
      baseRequirements(),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "UNSUPPORTED_SYNTH_RESOURCE",
        resourceId: "events",
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "info",
        code: "DIAGRAM_ONLY_RESOURCE",
        resourceId: "producer",
      }),
    );
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.level === "error" && diagnostic.resourceId === "producer",
      ),
    ).toBe(false);
  });

  it("emits a blocking diagnostic for every non-diagram unsupported catalog type", () => {
    const unsupportedTypes = Object.entries(RESOURCE_CATALOG)
      .filter(([, capability]) => !capability.diagramOnly && !capability.synthSupported)
      .map(([type]) => type)
      .sort();

    for (const type of unsupportedTypes) {
      const result = compileIntent(
        {
          version: "infrastructure-intent/v1",
          resources: [
            {
              id: type.toLowerCase(),
              type: type as InfrastructureIntent["resources"][number]["type"],
              name: type,
              properties: {},
            },
          ],
          relationships: [],
        },
        baseRequirements(),
      );

      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "error",
          code: "UNSUPPORTED_SYNTH_RESOURCE",
          resourceId: type.toLowerCase(),
        }),
      );
    }
  });

  it("compiles every catalog type into strict output or explicit diagnostics", () => {
    for (const type of AWS_RESOURCE_TYPES) {
      const result = compileIntent(
        {
          version: "infrastructure-intent/v1",
          resources: [
            { id: type.toLowerCase(), type, name: type, properties: {} },
          ],
          relationships: [],
        },
        baseRequirements(),
      );

      architectureSchema.parse(result.architecture);
      deploymentPlanSchema.parse(result.deploymentPlan);
      stageDecisionSchema.parse(result.stageDecision);
      result.diagnostics.forEach((diagnostic) => diagnosticSchema.parse(diagnostic));
      if (!RESOURCE_CATALOG[type].synthSupported && !RESOURCE_CATALOG[type].diagramOnly) {
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            level: "error",
            code: "UNSUPPORTED_SYNTH_RESOURCE",
            resourceId: type.toLowerCase(),
          }),
        );
      }
    }
  });

  it("expands resource counts and bidirectional links deterministically", () => {
    const result = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          {
            id: "worker",
            type: "Lambda",
            name: "Worker",
            count: 2,
            properties: {},
          },
          { id: "queue", type: "SQS", name: "Queue", properties: {} },
        ],
        relationships: [
          {
            id: "worker-queue",
            sourceId: "worker",
            targetId: "queue",
            kind: "connects",
            direction: "bidirectional",
          },
        ],
      },
      baseRequirements(),
    );

    expect(result.architecture.resources.map((resource) => resource.id)).toEqual([
      "queue",
      "worker-1",
      "worker-2",
    ]);
    expect(result.architecture.relationships).toHaveLength(4);
    expect(new Set(result.architecture.relationships.map((item) => item.id)).size).toBe(4);
  });

  it("infers two public subnet prerequisites for an explicit load balancer", () => {
    const result = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "ingress", type: "ELB", name: "Ingress", properties: {} },
        ],
        relationships: [],
      },
      baseRequirements(),
    );
    const publicSubnetIds = new Set(
      result.architecture.resources
        .filter(
          (resource) =>
            resource.type === "Subnet" && resource.properties.subnetType === "public",
        )
        .map((resource) => resource.id),
    );
    const hostedSubnetIds = new Set(
      result.architecture.relationships
        .filter(
          (relationship) =>
            relationship.kind === "hosts" && relationship.targetId === "ingress",
        )
        .map((relationship) => relationship.sourceId),
    );

    expect(publicSubnetIds.size).toBeGreaterThanOrEqual(2);
    expect(hostedSubnetIds).toEqual(publicSubnetIds);
    expect(
      [...publicSubnetIds].every(
        (id) =>
          result.architecture.resources.find((resource) => resource.id === id)?.origin ===
          "inferred-minimal",
      ),
    ).toBe(true);
  });

  it("caps schema-valid high-cardinality expansions with diagnostics instead of throwing", () => {
    const resources = Array.from({ length: 200 }, (_, index) => ({
      id: `function-${String(index).padStart(3, "0")}`,
      type: "Lambda" as const,
      name: `Function ${index}`,
      count: 20,
      properties: {},
    }));
    const resourceHeavy = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources,
        relationships: [],
      },
      baseRequirements(),
    );

    expect(resourceHeavy.architecture.resources.length).toBeLessThanOrEqual(400);
    expect(resourceHeavy.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "ARCHITECTURE_RESOURCE_LIMIT",
      }),
    );
    expect(architectureSchema.safeParse(resourceHeavy.architecture).success).toBe(true);

    const relationshipHeavy = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          {
            id: "source",
            type: "Lambda",
            name: "Source",
            count: 20,
            properties: {},
          },
          {
            id: "target",
            type: "SQS",
            name: "Target",
            count: 20,
            properties: {},
          },
        ],
        relationships: ["one", "two", "three"].map((label) => ({
          id: `fanout-${label}`,
          sourceId: "source",
          targetId: "target",
          kind: "connects" as const,
          label,
        })),
      },
      baseRequirements(),
    );

    expect(relationshipHeavy.architecture.relationships.length).toBeLessThanOrEqual(1_000);
    expect(relationshipHeavy.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "ARCHITECTURE_RELATIONSHIP_LIMIT",
      }),
    );
    expect(architectureSchema.safeParse(relationshipHeavy.architecture).success).toBe(true);
  });

  it("bounds generated IDs and names for maximum-length schema-valid intent fields", () => {
    const sourceId = "a".repeat(120);
    const sourceName = "Application ".repeat(11).slice(0, 120);
    const result = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          {
            id: sourceId,
            type: "EC2",
            name: sourceName,
            count: 2,
            zone: "public",
            properties: {},
          },
          { id: "user", type: "External", name: "User", properties: {} },
        ],
        relationships: [
          {
            sourceId: "user",
            targetId: sourceId,
            kind: "routes",
          },
        ],
      },
      criticalExternalRequirements,
    );

    expect(result.architecture.resources.every((resource) => resource.id.length <= 120)).toBe(
      true,
    );
    expect(result.architecture.resources.every((resource) => resource.name.length <= 120)).toBe(
      true,
    );
    expect(new Set(result.architecture.resources.map((resource) => resource.id)).size).toBe(
      result.architecture.resources.length,
    );
    expect(architectureSchema.safeParse(result.architecture).success).toBe(true);
  });

  it.each([
    ["growth", criticalExternalRequirements],
    [
      "production",
      baseRequirements({
        criticality: "mission_critical",
        availability: "continuous",
        recovery: "rapid",
      }),
    ],
  ] as const)("materially distributes %s ingress and compute across compatible subnets", (
    stage,
    requirements,
  ) => {
    const result = compileIntent(ec2Intent, requirements);
    const elb = result.architecture.resources.find(
      (resource) => resource.type === "ELB" && resource.origin === "stage-upgrade",
    );
    const secondarySubnet = result.architecture.resources.find(
      (resource) =>
        resource.type === "Subnet" && resource.id === "stage-subnet-secondary",
    );
    const computeIds = new Set(
      result.architecture.resources
        .filter((resource) => resource.type === "EC2")
        .map((resource) => resource.id),
    );
    const elbSubnetIds = new Set(
      result.architecture.relationships
        .filter(
          (relationship) =>
            relationship.kind === "hosts" && relationship.targetId === elb?.id,
        )
        .map((relationship) => relationship.sourceId),
    );
    const computeSubnetIds = new Set(
      result.architecture.relationships
        .filter(
          (relationship) =>
            relationship.kind === "hosts" && computeIds.has(relationship.targetId),
        )
        .map((relationship) => relationship.sourceId),
    );

    expect(result.stageDecision.stage).toBe(stage);
    expect(elb).toMatchObject({ approvalStatus: "pending" });
    expect(secondarySubnet?.reason).toMatch(new RegExp(stage, "i"));
    expect(elbSubnetIds.size).toBeGreaterThanOrEqual(2);
    expect(computeSubnetIds.size).toBeGreaterThanOrEqual(2);
    expect(
      [...elbSubnetIds].every((subnetId) => {
        const subnet = result.architecture.resources.find(
          (resource) => resource.id === subnetId,
        );
        return subnet?.type === "Subnet" && subnet.properties.subnetType === "public";
      }),
    ).toBe(true);
  });

  it("keeps internal growth multi-AZ facts coherent before and after approval", () => {
    const result = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "app", type: "EC2", name: "App", zone: "private", properties: {} },
        ],
        relationships: [],
      },
      baseRequirements({
        audience: "internal",
        expectedUsers: "global",
        asyncWorkload: true,
      }),
    );
    const computeIds = new Set(
      result.architecture.resources
        .filter((resource) => resource.type === "EC2")
        .map((resource) => resource.id),
    );
    const computeSubnetIds = new Set(
      result.architecture.relationships
        .filter(
          (relationship) =>
            relationship.kind === "hosts" && computeIds.has(relationship.targetId),
        )
        .map((relationship) => relationship.sourceId),
    );
    const proposedVpc = result.architecture.resources.find(
      (resource) => resource.id === "inferred-vpc",
    );

    expect(result.stageDecision.stage).toBe("growth");
    expect(computeSubnetIds.size).toBeGreaterThanOrEqual(2);
    expect(proposedVpc?.properties.maxAvailabilityZones).toBe(2);

    const beforeApproval = materializeApprovedArchitecture(result.deploymentPlan);
    expect(
      beforeApproval.resources.find((resource) => resource.id === "inferred-vpc")
        ?.properties.maxAvailabilityZones,
    ).toBe(1);

    const approvedPlan = structuredClone(result.deploymentPlan);
    approvedPlan.architecture.resources = approvedPlan.architecture.resources.map(
      (resource) =>
        resource.origin === "stage-upgrade"
          ? { ...resource, approvalStatus: "approved" as const }
          : resource,
    );
    approvedPlan.architecture.relationships = approvedPlan.architecture.relationships.map(
      (relationship) =>
        relationship.origin === "stage-upgrade"
          ? { ...relationship, approvalStatus: "approved" as const }
          : relationship,
    );
    approvedPlan.pendingApprovalResourceIds = [];
    approvedPlan.pendingApprovalRelationshipIds = [];
    approvedPlan.approvalsSatisfied = true;
    const afterApproval = materializeApprovedArchitecture(approvedPlan);

    expect(
      afterApproval.resources.find((resource) => resource.id === "inferred-vpc")
        ?.properties.maxAvailabilityZones,
    ).toBe(2);
    expect(
      new Set(
        afterApproval.relationships
          .filter(
            (relationship) =>
              relationship.kind === "hosts" && computeIds.has(relationship.targetId),
          )
          .map((relationship) => relationship.sourceId),
      ).size,
    ).toBeGreaterThanOrEqual(2);
  });

  it("snapshots representative prototype and production compilations", () => {
    const prototype = compileIntent(
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "function", type: "Lambda", name: "Function", properties: {} },
        ],
        relationships: [],
      },
      baseRequirements(),
    );
    const production = compileIntent(ec2Intent, baseRequirements({
      criticality: "mission_critical",
      availability: "continuous",
      recovery: "rapid",
    }));

    const summarize = (result: ReturnType<typeof compileIntent>) => ({
      stage: result.stageDecision.stage,
      resources: result.architecture.resources.map(
        (resource) => `${resource.origin}:${resource.id}:${resource.type}`,
      ),
      relationships: result.architecture.relationships.map(
        (relationship) =>
          `${relationship.origin}:${relationship.sourceId}:${relationship.kind}:${relationship.targetId}`,
      ),
      pending: result.deploymentPlan.pendingApprovalResourceIds,
      diagnostics: result.diagnostics.map(
        (diagnostic) => `${diagnostic.level}:${diagnostic.code}:${diagnostic.resourceId ?? ""}`,
      ),
    });

    expect(summarize(prototype)).toMatchInlineSnapshot(`
      {
        "diagnostics": [],
        "pending": [],
        "relationships": [],
        "resources": [
          "explicit:function:Lambda",
        ],
        "stage": "prototype",
      }
    `);
    expect(summarize(production)).toMatchSnapshot();
  });

  it("compiles all 6,480 requirement combinations across representative graph shapes", () => {
    const shapes: InfrastructureIntent[] = [
      ec2Intent,
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "function", type: "Lambda", name: "Function", properties: {} },
          { id: "bucket", type: "S3", name: "Bucket", properties: {} },
        ],
        relationships: [
          { sourceId: "function", targetId: "bucket", kind: "writes" },
        ],
      },
      {
        version: "infrastructure-intent/v1",
        resources: [
          { id: "vpc-a", type: "VPC", name: "VPC A", properties: {} },
          { id: "vpc-b", type: "VPC", name: "VPC B", properties: {} },
          { id: "sg-a", type: "SecurityGroup", name: "SG A", properties: {} },
          { id: "sg-b", type: "SecurityGroup", name: "SG B", properties: {} },
          { id: "database", type: "RDS", name: "Database", properties: {} },
        ],
        relationships: [],
      },
    ];
    const audiences = ["internal", "external"] as const;
    const criticalities = [
      "non_critical",
      "business_critical",
      "mission_critical",
    ] as const;
    const userBands = ["tiny", "small", "medium", "large", "global"] as const;
    const trafficBands = ["low", "moderate", "high", "extreme"] as const;
    const burstinessValues = ["steady", "bursty", "spiky"] as const;
    const asyncValues = [false, true] as const;
    const availabilityValues = [
      "best_effort",
      "high_availability",
      "continuous",
    ] as const;
    const recoveryValues = ["flexible", "standard", "rapid"] as const;
    let requirementCount = 0;
    let compilationCount = 0;

    for (const audience of audiences)
      for (const criticality of criticalities)
        for (const expectedUsers of userBands)
          for (const traffic of trafficBands)
            for (const burstiness of burstinessValues)
              for (const asyncWorkload of asyncValues)
                for (const availability of availabilityValues)
                  for (const recovery of recoveryValues) {
                    const requirements: RequirementsProfile = {
                      version: "requirements/v1",
                      audience,
                      criticality,
                      expectedUsers,
                      traffic,
                      burstiness,
                      asyncWorkload,
                      availability,
                      recovery,
                    };
                    requirementCount += 1;
                    for (const shape of shapes) {
                      const result = compileIntent(shape, requirements);
                      architectureSchema.parse(result.architecture);
                      deploymentPlanSchema.parse(result.deploymentPlan);
                      stageDecisionSchema.parse(result.stageDecision);
                      result.diagnostics.forEach((diagnostic) =>
                        diagnosticSchema.parse(diagnostic),
                      );
                      if (
                        result.stageDecision.requiresApproval !==
                        result.deploymentPlan.requiresApproval
                      ) {
                        throw new Error("Compiled stage and deployment approval facts diverged.");
                      }
                      compilationCount += 1;
                    }
                  }

    expect(requirementCount).toBe(6_480);
    expect(compilationCount).toBe(6_480 * shapes.length);
  }, 30_000);

  it("does not alias mutable intent or output objects", () => {
    const input = structuredClone(ec2Intent);
    const result = compileIntent(input, criticalExternalRequirements);
    const originalInput = structuredClone(input);
    const originalArchitecture = structuredClone(result.architecture);

    input.resources[1]!.properties.instanceType = "m7g.large";
    result.architecture.resources[0]!.properties.mutated = true;

    expect(originalInput.resources[1]?.properties.instanceType).toBe("t3.micro");
    expect(
      originalArchitecture.resources.find((resource) => resource.id === "app")
        ?.properties.instanceType,
    ).toBe("t3.micro");
    expect(input.resources[1]?.properties).not.toHaveProperty("mutated");
  });
});

describe("buildDeploymentPlan", () => {
  it("returns the same strict deployment plan exposed by compilation", () => {
    const plan = buildDeploymentPlan(ec2Intent, criticalExternalRequirements);
    const compiled = compileIntent(ec2Intent, criticalExternalRequirements);

    expect(plan).toEqual(compiled.deploymentPlan);
    expect(deploymentPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("keeps pending upgrades out of the approved deployment architecture", () => {
    const plan = buildDeploymentPlan(ec2Intent, criticalExternalRequirements);
    const approved = materializeApprovedArchitecture(plan);
    const pendingIds = new Set(plan.pendingApprovalResourceIds);

    expect(plan.pendingApprovalResourceIds.length).toBeGreaterThan(0);
    expect(
      approved.resources.some((resource) => pendingIds.has(resource.id)),
    ).toBe(false);
    expect(
      approved.relationships.some(
        (relationship) =>
          pendingIds.has(relationship.sourceId) || pendingIds.has(relationship.targetId),
      ),
    ).toBe(false);
    expect(architectureSchema.safeParse(approved).success).toBe(true);
  });

  it("keeps a pending topology edge between explicit resources out of deployment", () => {
    const architecture = architectureSchema.parse({
      version: "architecture/v1",
      requirements: baseRequirements(),
      resources: [
        {
          id: "client",
          type: "External",
          name: "Client",
          zone: "edge",
          properties: {},
          origin: "explicit",
          reason: "Drawn on the whiteboard.",
          approvalStatus: "not-required",
        },
        {
          id: "app",
          type: "EC2",
          name: "App",
          zone: "public",
          properties: {},
          origin: "explicit",
          reason: "Drawn on the whiteboard.",
          approvalStatus: "not-required",
        },
      ],
      relationships: [
        {
          id: "stage-route",
          sourceId: "client",
          targetId: "app",
          kind: "routes",
          origin: "stage-upgrade",
          reason: "Proposed ingress route.",
          approvalStatus: "pending",
        },
      ],
      decisions: [],
      unresolvedQuestions: [],
    });
    const plan = deploymentPlanSchema.parse({
      version: "deployment-plan/v1",
      stage: "growth",
      requiresApproval: true,
      approvalsSatisfied: false,
      pendingApprovalResourceIds: [],
      pendingApprovalRelationshipIds: ["stage-route"],
      architecture,
    });

    expect(materializeApprovedArchitecture(plan).relationships).toEqual([]);
  });
});

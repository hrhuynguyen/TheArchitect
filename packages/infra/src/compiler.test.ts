import { describe, expect, it } from "vitest";

import {
  architectureSchema,
  deploymentPlanSchema,
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
    expect(architectureSchema.parse(result.architecture)).toEqual(result.architecture);
    expect(deploymentPlanSchema.parse(result.deploymentPlan)).toEqual(
      result.deploymentPlan,
    );
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
});

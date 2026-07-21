import { describe, expect, it } from "vitest";

import {
  architectureSchema,
  architectureResourceSchema,
} from "@architect/contracts/architecture";
import {
  AWS_RESOURCE_TYPES,
  deploymentPlanSchema,
  diagnosticSchema,
  infrastructureIntentSchema,
  resourceOriginSchema,
  stageDecisionSchema,
} from "@architect/contracts/infrastructure";
import { defaultRequirementsProfile } from "@architect/contracts/requirements";

describe("infrastructure contracts", () => {
  it("accepts every allowlisted resource type in a strict discriminated intent", () => {
    const resources = AWS_RESOURCE_TYPES.map((type, index) => ({
      id: `resource-${index}`,
      type,
      name: type,
      properties: {},
    }));

    expect(
      infrastructureIntentSchema.parse({
        version: "infrastructure-intent/v1",
        resources,
        relationships: [],
      }).resources,
    ).toHaveLength(AWS_RESOURCE_TYPES.length);
  });

  it("rejects unknown fields at every public contract boundary", () => {
    expect(() =>
      infrastructureIntentSchema.parse({
        version: "infrastructure-intent/v1",
        resources: [
          {
            id: "app",
            type: "EC2",
            name: "Application",
            properties: {},
            surprise: true,
          },
        ],
        relationships: [],
      }),
    ).toThrow();

    expect(() =>
      diagnosticSchema.parse({
        level: "error",
        code: "EXAMPLE",
        message: "Example diagnostic.",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("bounds resource properties to deploy-safe primitive values", () => {
    expect(() =>
      infrastructureIntentSchema.parse({
        version: "infrastructure-intent/v1",
        resources: [
          {
            id: "bucket",
            type: "S3",
            name: "Uploads",
            properties: { nested: { public: false } },
          },
        ],
        relationships: [],
      }),
    ).toThrow();
  });

  it("rejects resource property keys longer than 120 characters", () => {
    expect(() =>
      infrastructureIntentSchema.parse({
        version: "infrastructure-intent/v1",
        resources: [
          {
            id: "bucket",
            type: "S3",
            name: "Uploads",
            properties: { ["k".repeat(121)]: "value" },
          },
        ],
        relationships: [],
      }),
    ).toThrow();
  });

  it("rejects resources with more than 100 properties", () => {
    expect(() =>
      infrastructureIntentSchema.parse({
        version: "infrastructure-intent/v1",
        resources: [
          {
            id: "bucket",
            type: "S3",
            name: "Uploads",
            properties: Object.fromEntries(
              Array.from({ length: 101 }, (_, index) => [`key-${index}`, index]),
            ),
          },
        ],
        relationships: [],
      }),
    ).toThrow();
  });

  it("rejects resource property strings longer than 4096 characters", () => {
    expect(() =>
      infrastructureIntentSchema.parse({
        version: "infrastructure-intent/v1",
        resources: [
          {
            id: "bucket",
            type: "S3",
            name: "Uploads",
            properties: { description: "x".repeat(4_097) },
          },
        ],
        relationships: [],
      }),
    ).toThrow();
  });

  it("models provenance and stage approvals explicitly", () => {
    expect(resourceOriginSchema.options).toEqual([
      "explicit",
      "inferred-minimal",
      "stage-upgrade",
    ]);

    const pending = architectureResourceSchema.parse({
      id: "stage-app-2",
      type: "EC2",
      name: "Application replica",
      properties: {},
      origin: "stage-upgrade",
      reason: "Growth workloads need redundant capacity.",
      confidence: 0.9,
      approvalStatus: "pending",
    });

    expect(pending.approvalStatus).toBe("pending");
  });

  it("preserves an optional strict semantic resource zone", () => {
    const resource = architectureResourceSchema.parse({
      id: "app",
      type: "EC2",
      name: "Application",
      zone: "private",
      properties: {},
      origin: "explicit",
      reason: "Drawn on the whiteboard.",
      approvalStatus: "not-required",
    });

    expect(resource.zone).toBe("private");
    expect(() =>
      architectureResourceSchema.parse({ ...resource, zone: "somewhere" }),
    ).toThrow();
  });

  it("rejects duplicate resources and dangling semantic relationships", () => {
    const resource = {
      id: "app",
      type: "Lambda" as const,
      name: "Application",
      properties: {},
      origin: "explicit" as const,
      reason: "Drawn on the whiteboard.",
      approvalStatus: "not-required" as const,
    };

    expect(
      architectureSchema.safeParse({
        version: "architecture/v1",
        requirements: defaultRequirementsProfile(),
        resources: [resource, resource],
        relationships: [],
        decisions: [],
        unresolvedQuestions: [],
      }).success,
    ).toBe(false);

    expect(
      architectureSchema.safeParse({
        version: "architecture/v1",
        requirements: defaultRequirementsProfile(),
        resources: [resource],
        relationships: [
          {
            id: "rel-app-missing",
            sourceId: "app",
            targetId: "missing",
            kind: "connects",
            origin: "explicit",
            reason: "Drawn on the whiteboard.",
            approvalStatus: "not-required",
          },
        ],
        decisions: [],
        unresolvedQuestions: [],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate architecture decision IDs", () => {
    expect(
      architectureSchema.safeParse({
        version: "architecture/v1",
        requirements: defaultRequirementsProfile(),
        resources: [],
        relationships: [],
        decisions: [
          { id: "decision", summary: "First", rationale: "First rationale." },
          { id: "decision", summary: "Second", rationale: "Second rationale." },
        ],
        unresolvedQuestions: [],
      }).success,
    ).toBe(false);
  });

  it("parses complete stage and deployment outputs", () => {
    const stageDecision = stageDecisionSchema.parse({
      version: "stage-decision/v1",
      stage: "growth",
      confidence: "high",
      reasons: ["Traffic requires redundant capacity."],
      requiresApproval: true,
      proposedUpgrades: [
        {
          id: "redundant-ingress",
          title: "Add redundant ingress",
          summary: "Put a load balancer in front of compute.",
          affects: ["app"],
        },
      ],
    });

    const architecture = architectureSchema.parse({
      version: "architecture/v1",
      requirements: defaultRequirementsProfile(),
      resources: [
        {
          id: "stage-elb",
          type: "ELB",
          name: "Recommended load balancer",
          properties: {},
          origin: "stage-upgrade",
          reason: "Growth requires redundant ingress.",
          approvalStatus: "pending",
        },
      ],
      relationships: [],
      decisions: [],
      unresolvedQuestions: [],
    });

    expect(
      deploymentPlanSchema.parse({
        version: "deployment-plan/v1",
        stage: stageDecision.stage,
        requiresApproval: true,
        approvalsSatisfied: false,
        pendingApprovalResourceIds: ["stage-elb"],
        pendingApprovalRelationshipIds: [],
        architecture,
      }),
    ).toMatchObject({ stage: "growth", approvalsSatisfied: false });
  });

  it("treats pending stage relationships as first-class approval facts", () => {
    const architecture = architectureSchema.parse({
      version: "architecture/v1",
      requirements: defaultRequirementsProfile(),
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
          name: "Application",
          zone: "public",
          properties: {},
          origin: "explicit",
          reason: "Drawn on the whiteboard.",
          approvalStatus: "not-required",
        },
      ],
      relationships: [
        {
          id: "stage-client-routes-app",
          sourceId: "client",
          targetId: "app",
          kind: "routes",
          origin: "stage-upgrade",
          reason: "Proposed route.",
          approvalStatus: "pending",
        },
      ],
      decisions: [],
      unresolvedQuestions: [],
    });

    expect(
      deploymentPlanSchema.parse({
        version: "deployment-plan/v1",
        stage: "growth",
        requiresApproval: true,
        approvalsSatisfied: false,
        pendingApprovalResourceIds: [],
        pendingApprovalRelationshipIds: ["stage-client-routes-app"],
        architecture,
      }),
    ).toMatchObject({
      requiresApproval: true,
      approvalsSatisfied: false,
      pendingApprovalRelationshipIds: ["stage-client-routes-app"],
    });

    expect(
      deploymentPlanSchema.safeParse({
        version: "deployment-plan/v1",
        stage: "growth",
        requiresApproval: true,
        approvalsSatisfied: true,
        pendingApprovalResourceIds: [],
        pendingApprovalRelationshipIds: [],
        architecture,
      }).success,
    ).toBe(false);
  });

  it("rejects contradictory stage and deployment approval facts", () => {
    expect(
      stageDecisionSchema.safeParse({
        version: "stage-decision/v1",
        stage: "growth",
        confidence: "high",
        reasons: ["Growth requires review."],
        requiresApproval: false,
        proposedUpgrades: [
          {
            id: "redundant-ingress",
            title: "Add redundant ingress",
            summary: "Put a load balancer in front of compute.",
            affects: ["app"],
          },
        ],
      }).success,
    ).toBe(false);

    const architecture = architectureSchema.parse({
      version: "architecture/v1",
      requirements: defaultRequirementsProfile(),
      resources: [
        {
          id: "app",
          type: "EC2",
          name: "Application",
          properties: {},
          origin: "explicit",
          reason: "Drawn on the whiteboard.",
          approvalStatus: "not-required",
        },
      ],
      relationships: [],
      decisions: [],
      unresolvedQuestions: [],
    });

    for (const invalid of [
      {
        pendingApprovalResourceIds: ["missing"],
        requiresApproval: true,
        approvalsSatisfied: false,
      },
      {
        pendingApprovalResourceIds: ["app"],
        requiresApproval: true,
        approvalsSatisfied: false,
      },
      {
        pendingApprovalResourceIds: ["app", "app"],
        requiresApproval: true,
        approvalsSatisfied: false,
      },
      {
        pendingApprovalResourceIds: ["app"],
        requiresApproval: true,
        approvalsSatisfied: true,
      },
    ]) {
      expect(
        deploymentPlanSchema.safeParse({
          version: "deployment-plan/v1",
          stage: "growth",
          architecture,
          pendingApprovalRelationshipIds: [],
          ...invalid,
        }).success,
      ).toBe(false);
    }
  });
});

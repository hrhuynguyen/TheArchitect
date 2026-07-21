import {
  defaultRequirementsProfile,
  type Architecture,
  type GraphOperation,
} from "@architect/contracts";
import { describe, expect, it } from "vitest";

import { applyOperations } from "./operations.js";

const baseArchitecture: Architecture = {
  version: "architecture/v1",
  requirements: defaultRequirementsProfile(),
  resources: [
    {
      id: "app",
      type: "EC2",
      name: "Application",
      zone: "private",
      properties: {},
      origin: "explicit",
      reason: "Explicit workload.",
      approvalStatus: "not-required",
    },
    {
      id: "stage-cache",
      type: "DynamoDB",
      name: "Recommended cache",
      zone: "data",
      properties: {},
      origin: "stage-upgrade",
      reason: "Growth needs shared state.",
      approvalStatus: "pending",
    },
  ],
  relationships: [
    {
      id: "stage-app-cache",
      sourceId: "app",
      targetId: "stage-cache",
      kind: "writes",
      origin: "stage-upgrade",
      reason: "The proposed cache stores application state.",
      approvalStatus: "pending",
    },
  ],
  decisions: [],
  unresolvedQuestions: [],
};

const confirmation = {
  confirmed: true as const,
  rationale: "This destructive edit was reviewed by the participant.",
};

function addQueue(id = "queue"): GraphOperation {
  return {
    type: "add_resource",
    resource: {
      id,
      type: "SQS",
      name: "Queue",
      properties: {},
      origin: "explicit",
      reason: "Added manually.",
      approvalStatus: "not-required",
    },
  };
}

describe("applyOperations", () => {
  it("rejects an operation batch atomically when one relationship dangles", () => {
    const original = structuredClone(baseArchitecture);
    const result = applyOperations(baseArchitecture, [
      addQueue(),
      {
        type: "add_relationship",
        relationship: {
          id: "dangling",
          sourceId: "queue",
          targetId: "missing",
          kind: "connects",
          origin: "explicit",
          reason: "Invalid edge.",
          approvalStatus: "not-required",
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.architecture).toEqual(original);
    expect(baseArchitecture).toEqual(original);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "OPERATION_DANGLING_RELATIONSHIP",
        relationshipId: "dangling",
      }),
    );
  });

  it("applies add, update, and confirmed cascading removal to a clone", () => {
    const original = structuredClone(baseArchitecture);
    const added = applyOperations(baseArchitecture, [
      addQueue(),
      {
        type: "update_resource",
        resourceId: "queue",
        changes: {
          name: "Ordered queue",
          zone: "regional",
          properties: { fifo: true },
        },
      },
      {
        type: "add_relationship",
        relationship: {
          id: "app-queue",
          sourceId: "app",
          targetId: "queue",
          kind: "writes",
          origin: "explicit",
          reason: "Added manually.",
          approvalStatus: "not-required",
        },
      },
    ]);

    expect(added.ok).toBe(true);
    expect(added.architecture.resources).toContainEqual(
      expect.objectContaining({
        id: "queue",
        name: "Ordered queue",
        zone: "regional",
        properties: { fifo: true },
      }),
    );
    expect(baseArchitecture).toEqual(original);

    const removed = applyOperations(added.architecture, [
      { type: "remove_resource", resourceId: "queue", confirmation },
    ]);
    expect(removed.ok).toBe(true);
    expect(
      removed.architecture.resources.some((resource) => resource.id === "queue"),
    ).toBe(false);
    expect(
      removed.architecture.relationships.some(
        (relationship) => relationship.id === "app-queue",
      ),
    ).toBe(false);
  });

  it("rejects duplicate IDs, missing targets, and non-manual additions", () => {
    const cases: GraphOperation[][] = [
      [addQueue("app")],
      [
        {
          type: "update_resource",
          resourceId: "missing",
          changes: { name: "Missing" },
        },
      ],
      [
        {
          type: "add_resource",
          resource: {
            id: "manual-stage",
            type: "S3",
            name: "Invalid manual stage",
            properties: {},
            origin: "stage-upgrade",
            reason: "Not allowed.",
            approvalStatus: "pending",
          },
        },
      ],
    ];

    for (const operations of cases) {
      const result = applyOperations(baseArchitecture, operations);
      expect(result.ok).toBe(false);
      expect(result.architecture).toEqual(baseArchitecture);
      expect(result.diagnostics).toHaveLength(1);
    }
  });

  it("requires pending stage upgrades and propagates approval decisions", () => {
    const approved = applyOperations(baseArchitecture, [
      {
        type: "set_resource_approval",
        resourceId: "stage-cache",
        approvalStatus: "approved",
      },
    ]);
    expect(approved.ok).toBe(true);
    expect(
      approved.architecture.resources.find(
        (resource) => resource.id === "stage-cache",
      )?.approvalStatus,
    ).toBe("approved");
    expect(approved.architecture.relationships[0]?.approvalStatus).toBe(
      "approved",
    );

    const rejected = applyOperations(baseArchitecture, [
      {
        type: "set_resource_approval",
        resourceId: "stage-cache",
        approvalStatus: "rejected",
      },
    ]);
    expect(rejected.ok).toBe(true);
    expect(rejected.architecture.relationships[0]?.approvalStatus).toBe(
      "rejected",
    );

    const repeated = applyOperations(approved.architecture, [
      {
        type: "set_resource_approval",
        resourceId: "stage-cache",
        approvalStatus: "rejected",
      },
    ]);
    expect(repeated.ok).toBe(false);
    expect(repeated.architecture).toEqual(approved.architecture);
    expect(repeated.diagnostics[0]?.code).toBe("OPERATION_APPROVAL_CONFLICT");
  });

  it("requires destructive confirmation at the runtime boundary", () => {
    const invalid = {
      type: "remove_resource",
      resourceId: "app",
    } as unknown as GraphOperation;
    const result = applyOperations(baseArchitecture, [invalid]);

    expect(result.ok).toBe(false);
    expect(result.architecture).toEqual(baseArchitecture);
    expect(result.diagnostics[0]?.code).toBe("OPERATION_INVALID");
  });
});

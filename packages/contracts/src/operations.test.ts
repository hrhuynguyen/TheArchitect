import { describe, expect, it } from "vitest";

import {
  GraphOperationBatchSchema,
  GraphOperationSchema,
} from "./operations.js";

const confirmation = {
  confirmed: true as const,
  rationale: "The obsolete component is intentionally removed.",
};

describe("GraphOperation contracts", () => {
  it("parses every strict graph operation variant", () => {
    const operations = [
      {
        type: "add_resource",
        resource: {
          id: "queue",
          type: "SQS",
          name: "Queue",
          properties: {},
          origin: "explicit",
          reason: "Added manually.",
          approvalStatus: "not-required",
        },
      },
      {
        type: "update_resource",
        resourceId: "queue",
        changes: { name: "Work queue", properties: { fifo: true } },
      },
      { type: "remove_resource", resourceId: "queue", confirmation },
      {
        type: "add_relationship",
        relationship: {
          id: "queue-to-worker",
          sourceId: "queue",
          targetId: "worker",
          kind: "connects",
          origin: "explicit",
          reason: "Added manually.",
          approvalStatus: "not-required",
        },
      },
      {
        type: "remove_relationship",
        relationshipId: "queue-to-worker",
        confirmation,
      },
      {
        type: "set_resource_approval",
        resourceId: "stage-worker",
        approvalStatus: "approved",
      },
    ];

    expect(GraphOperationBatchSchema.parse(operations)).toEqual(operations);
    for (const operation of operations) {
      expect(GraphOperationSchema.parse(operation)).toEqual(operation);
    }
  });

  it("requires explicit destructive confirmation and rejects loose payloads", () => {
    expect(
      GraphOperationSchema.safeParse({
        type: "remove_resource",
        resourceId: "queue",
      }).success,
    ).toBe(false);
    expect(
      GraphOperationSchema.safeParse({
        type: "update_resource",
        resourceId: "queue",
        changes: {},
      }).success,
    ).toBe(false);
    expect(
      GraphOperationSchema.safeParse({
        type: "set_resource_approval",
        resourceId: "stage-worker",
        approvalStatus: "pending",
      }).success,
    ).toBe(false);
    expect(
      GraphOperationSchema.safeParse({
        type: "remove_relationship",
        relationshipId: "edge",
        confirmation,
        ignored: true,
      }).success,
    ).toBe(false);
  });
});

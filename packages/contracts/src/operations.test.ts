import { describe, expect, it } from "vitest";

import {
  ArchitectureConflictResponseSchema,
  ArchitectureOperationRequestSchema,
  ArchitectureOperationResponseSchema,
  GraphOperationBatchSchema,
  GraphOperationSchema,
} from "./operations.js";
import { defaultRequirementsProfile } from "./requirements.js";

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

  it("parses strict operation request and atomic result envelopes", () => {
    const architecture = {
      version: "architecture/v1" as const,
      requirements: defaultRequirementsProfile(),
      resources: [],
      relationships: [],
      decisions: [],
      unresolvedQuestions: [],
    };
    const state = {
      architecture: {
        version: "working-architecture/v1" as const,
        revisionId: "revision-a",
        architecture,
      },
      layout: {
        version: "architecture-layout/v1" as const,
        revisionId: "revision-a",
        nodes: [],
      },
    };
    const request = {
      baseRevisionId: "revision-a",
      operations: [{
        type: "add_resource" as const,
        resource: {
          id: "queue",
          type: "SQS" as const,
          name: "Queue",
          properties: {},
          origin: "explicit" as const,
          reason: "Added manually.",
          approvalStatus: "not-required" as const,
        },
      }],
    };

    expect(ArchitectureOperationRequestSchema.parse(request)).toEqual(request);
    expect(ArchitectureOperationResponseSchema.parse({
      ok: true,
      state,
      diagnostics: [],
    })).toEqual({ ok: true, state, diagnostics: [] });
    expect(ArchitectureOperationResponseSchema.safeParse({
      ok: false,
      state,
      diagnostics: [],
    }).success).toBe(false);
    expect(ArchitectureOperationRequestSchema.safeParse({
      ...request,
      ignored: true,
    }).success).toBe(false);
    expect(ArchitectureOperationRequestSchema.safeParse({
      baseRevisionId: "revision-a",
      operations: [],
      layout: {
        ...state.layout,
        nodes: [{ resourceId: "queue", x: 20, y: 40 }],
      },
    }).success).toBe(true);
    expect(ArchitectureOperationRequestSchema.safeParse({
      baseRevisionId: "revision-a",
      operations: [],
      layout: {
        ...state.layout,
        nodes: [
          { resourceId: "queue", x: 20, y: 40 },
          { resourceId: "bucket", x: 80, y: 100 },
        ],
      },
    }).success).toBe(false);
    expect(ArchitectureOperationRequestSchema.safeParse({
      baseRevisionId: "revision-a",
      operations: [],
    }).success).toBe(false);
  });

  it("bounds public revision conflict responses", () => {
    expect(ArchitectureConflictResponseSchema.parse({
      code: "working_state_conflict",
      message: "Working architecture changed. Refresh and retry.",
      currentRevisionId: "revision-a",
    })).toMatchObject({ code: "working_state_conflict" });
    expect(ArchitectureConflictResponseSchema.safeParse({
      code: "database_secret",
      message: "internal",
      currentRevisionId: "revision-a",
    }).success).toBe(false);
    expect(ArchitectureConflictResponseSchema.safeParse({
      code: "stale_revision",
      message: "x".repeat(201),
      currentRevisionId: "revision-a",
    }).success).toBe(false);
  });
});

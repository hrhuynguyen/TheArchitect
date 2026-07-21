import { defaultRequirementsProfile } from "@architect/contracts";
import { describe, expect, it } from "vitest";

import {
  applyArchitectOperations,
  applyOperations,
  validateArchitectOperations,
} from "./operations.js";

const baseArchitecture = {
  version: "architecture/v1" as const,
  requirements: defaultRequirementsProfile(),
  resources: [{
    id: "worker",
    type: "Lambda" as const,
    name: "Order worker",
    properties: {},
    origin: "explicit" as const,
    reason: "Added by a participant.",
    approvalStatus: "not-required" as const,
  }],
  relationships: [],
  decisions: [],
  unresolvedQuestions: [],
};

const addQueue = {
  type: "add_resource" as const,
  resource: {
    id: "orders-queue",
    type: "SQS" as const,
    name: "Orders queue",
    zone: "regional" as const,
    properties: { fifo: true },
    confidence: 0.9,
  },
  reason: "Buffer order work across transient worker failures.",
};

describe("trusted architect operations", () => {
  it("validates an AI SQS addition with inferred provenance without mutating input", () => {
    const result = validateArchitectOperations(baseArchitecture, [addQueue]);

    expect(result).toMatchObject({
      ok: true,
      architecture: {
        resources: [
          { id: "worker", origin: "explicit" },
          {
            id: "orders-queue",
            origin: "inferred-minimal",
            approvalStatus: "not-required",
            reason: addQueue.reason,
            confidence: 0.9,
          },
        ],
      },
    });
    expect(baseArchitecture.resources).toHaveLength(1);
  });

  it("leaves public manual operation provenance policy unchanged", () => {
    const result = applyOperations(baseArchitecture, [{
      type: "add_resource",
      resource: {
        ...addQueue.resource,
        origin: "inferred-minimal",
        reason: addQueue.reason,
        approvalStatus: "not-required",
      },
    }]);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "OPERATION_RESOURCE_NOT_MANUAL" }],
    });
  });

  it("validates destructive intent but applies it only with human confirmation", () => {
    const removal = [{
      type: "remove_resource" as const,
      resourceId: "worker",
      reason: "The worker is no longer part of the requested design.",
    }];

    expect(validateArchitectOperations(baseArchitecture, removal)).toMatchObject({
      ok: true,
      architecture: { resources: [] },
    });
    expect(applyArchitectOperations(baseArchitecture, removal)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "ARCHITECT_DESTRUCTIVE_CONFIRMATION_REQUIRED" }],
    });
    expect(applyArchitectOperations(baseArchitecture, removal, {
      confirmed: true,
      rationale: "I reviewed and approve this removal.",
    })).toMatchObject({
      ok: true,
      architecture: { resources: [] },
    });
  });

  it("rejects semantically invalid architect relationships", () => {
    const result = validateArchitectOperations(baseArchitecture, [{
      type: "add_relationship",
      relationship: {
        id: "worker-to-missing",
        sourceId: "worker",
        targetId: "missing",
        kind: "publishes",
      },
      reason: "Route worker output to a missing target.",
    }]);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "OPERATION_DANGLING_RELATIONSHIP" }],
    });
  });
});

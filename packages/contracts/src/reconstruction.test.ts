import { describe, expect, it } from "vitest";
import { defaultRequirementsProfile } from "./requirements.js";
import {
  DebugReconstructionRequestSchema,
  ReconstructionJobEnvelopeSchema,
  ReconstructionRequestSchema,
  ReconstructionYjsStateSchema,
} from "./reconstruction.js";

const requirements = defaultRequirementsProfile();
const intent = {
  version: "infrastructure-intent/v1" as const,
  resources: [
    {
      id: "portal",
      type: "S3" as const,
      name: "Supplier portal",
      properties: {},
    },
  ],
  relationships: [],
};
const architecture = {
  version: "architecture/v1" as const,
  requirements,
  resources: [
    {
      id: "portal",
      type: "S3" as const,
      name: "Supplier portal",
      properties: {},
      origin: "explicit" as const,
      reason: "The source intent explicitly includes this resource.",
      approvalStatus: "not-required" as const,
    },
  ],
  relationships: [],
  decisions: [],
  unresolvedQuestions: [],
};
const stageDecision = {
  version: "stage-decision/v1" as const,
  stage: "prototype" as const,
  confidence: "high" as const,
  reasons: ["The workload profile fits a prototype."],
  requiresApproval: false,
  proposedUpgrades: [],
};
const deploymentPlan = {
  version: "deployment-plan/v1" as const,
  stage: "prototype" as const,
  requiresApproval: false,
  approvalsSatisfied: true,
  pendingApprovalResourceIds: [],
  pendingApprovalRelationshipIds: [],
  architecture,
};
const result = {
  traceId: "trace-a",
  provider: { provider: "openai" as const, model: "gpt-5.6" },
  intent,
  diagnostics: [],
  stageDecision,
  deploymentPlan,
  architectureRevisionId: "revision-a",
};

describe("reconstruction contracts", () => {
  it("accepts one strict succeeded job envelope", () => {
    const parsed = ReconstructionJobEnvelopeSchema.parse({
      jobId: "job-a",
      sourceSnapshotVersion: 7,
      state: "succeeded",
      result,
      error: null,
    });

    expect(parsed.result?.architectureRevisionId).toBe("revision-a");
  });

  it("rejects extra result fields and incomplete provider identity", () => {
    expect(
      ReconstructionJobEnvelopeSchema.safeParse({
        jobId: "job-a",
        sourceSnapshotVersion: 7,
        state: "succeeded",
        result: { ...result, rawProviderResponse: "must never cross" },
        error: null,
      }).success,
    ).toBe(false);
    expect(
      ReconstructionJobEnvelopeSchema.safeParse({
        jobId: "job-a",
        sourceSnapshotVersion: 7,
        state: "succeeded",
        result: {
          ...result,
          provider: { provider: "openai" },
        },
        error: null,
      }).success,
    ).toBe(false);
  });

  it("rejects terminal payloads on in-flight jobs", () => {
    expect(
      ReconstructionJobEnvelopeSchema.safeParse({
        jobId: "job-a",
        sourceSnapshotVersion: 7,
        state: "running",
        result,
        error: null,
      }).success,
    ).toBe(false);
    expect(
      ReconstructionJobEnvelopeSchema.safeParse({
        jobId: "job-a",
        sourceSnapshotVersion: 7,
        state: "failed",
        result: null,
        error: null,
      }).success,
    ).toBe(false);
  });

  it("keeps requests strict and source versions server-compatible", () => {
    const request = {
      imageDataUrl: "data:image/png;base64,AAAA",
      mimeType: "image/png",
      requirements,
      sourceSnapshotVersion: 7,
    };
    expect(ReconstructionRequestSchema.parse(request)).toEqual(request);
    expect(
      ReconstructionRequestSchema.safeParse({ ...request, unexpected: true })
        .success,
    ).toBe(false);
    expect(
      ReconstructionRequestSchema.safeParse({
        ...request,
        sourceSnapshotVersion: -1,
      }).success,
    ).toBe(false);
    expect(
      ReconstructionRequestSchema.safeParse({
        ...request,
        mimeType: "image/jpeg",
      }).success,
    ).toBe(false);
  });

  it("uses a smaller debug request without transition authority", () => {
    const request = {
      imageDataUrl: "data:image/png;base64,AAAA",
      mimeType: "image/png",
      requirements,
    };
    expect(DebugReconstructionRequestSchema.parse(request)).toEqual(request);
    expect(
      DebugReconstructionRequestSchema.safeParse({
        ...request,
        sourceSnapshotVersion: 7,
      }).success,
    ).toBe(false);
  });

  it("requires matching semantic and layout revision identifiers", () => {
    const state = {
      architecture: {
        version: "working-architecture/v1",
        revisionId: "revision-a",
        architecture,
      },
      layout: {
        version: "architecture-layout/v1",
        revisionId: "revision-b",
        nodes: [],
      },
    };
    expect(ReconstructionYjsStateSchema.safeParse(state).success).toBe(false);
    expect(
      ReconstructionYjsStateSchema.safeParse({
        ...state,
        layout: { ...state.layout, revisionId: "revision-a" },
      }).success,
    ).toBe(true);
  });
});

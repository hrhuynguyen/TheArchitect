import { describe, expect, it } from "vitest";

import {
  ApplyArchitectPatchRequestSchema,
  ArchitectApiErrorResponseSchema,
  ArchitectProviderOutputSchema,
  ArchitectTurnListSchema,
  ArchitectTurnRequestSchema,
  ArchitectTurnSchema,
  RejectArchitectPatchRequestSchema,
} from "./architect.js";

const baseTurn = {
  id: "turn-1",
  roomId: "room-1",
  baseRevisionId: "revision-1",
  message: "Should this design use a queue?",
  actorType: "participant" as const,
  actorId: "participant-1",
  idempotencyKey: "turn-request-1",
  sourceSnapshotVersion: 7,
  sourceProtectedDigest:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  traceId: "architect:turn-1",
  createdAt: "2026-07-21T12:00:00.000Z",
  reviewedAt: null,
  reviewedByParticipantId: null,
  reviewRationale: null,
};

const addQueueOperation = {
  type: "add_resource" as const,
  resource: {
    id: "orders-queue",
    type: "SQS" as const,
    name: "Orders queue",
    zone: "regional" as const,
    properties: { fifo: true },
  },
  reason: "Buffer order processing so transient worker failures do not lose work.",
};

describe("architect contracts", () => {
  it("enforces strict explain-or-propose provider output", () => {
    const explanation = {
      kind: "explanation" as const,
      responseText: "A queue decouples request handling from background work.",
      operations: [],
    };
    const proposal = {
      kind: "proposal" as const,
      responseText: "I can add an SQS queue for order work.",
      operations: [addQueueOperation],
    };

    expect(ArchitectProviderOutputSchema.parse(explanation)).toEqual(explanation);
    expect(ArchitectProviderOutputSchema.parse(proposal)).toEqual(proposal);
    expect("shape" in ArchitectProviderOutputSchema).toBe(true);
    expect(ArchitectProviderOutputSchema.safeParse({
      ...explanation,
      operations: [addQueueOperation],
    }).success).toBe(false);
    expect(ArchitectProviderOutputSchema.safeParse({
      ...proposal,
      operations: [],
    }).success).toBe(false);
    expect(ArchitectProviderOutputSchema.safeParse({
      ...proposal,
      operations: [{
        type: "set_resource_approval",
        resourceId: "orders-queue",
        approvalStatus: "approved",
      }],
    }).success).toBe(false);
  });

  it("keeps provider proposals free of human destructive confirmation", () => {
    const destructive = {
      kind: "proposal" as const,
      responseText: "I can remove the unused queue.",
      operations: [{
        type: "remove_resource" as const,
        resourceId: "unused-queue",
        reason: "No producer or consumer references this queue.",
      }],
    };

    expect(ArchitectProviderOutputSchema.parse(destructive)).toEqual(destructive);
    expect(ArchitectProviderOutputSchema.safeParse({
      ...destructive,
      operations: [{
        ...destructive.operations[0],
        confirmation: {
          confirmed: true,
          rationale: "The participant approved this removal.",
        },
      }],
    }).success).toBe(false);
  });

  it("parses every durable turn state with state-specific terminal fields", () => {
    const turns = [
      {
        ...baseTurn,
        state: "thinking" as const,
        kind: null,
        responseText: null,
        operations: [],
        appliedRevisionId: null,
        error: null,
      },
      {
        ...baseTurn,
        state: "answered" as const,
        kind: "explanation" as const,
        responseText: "A queue is useful when work can be asynchronous.",
        operations: [],
        appliedRevisionId: null,
        error: null,
      },
      {
        ...baseTurn,
        state: "proposal_ready" as const,
        kind: "proposal" as const,
        responseText: "I can add an order queue.",
        operations: [addQueueOperation],
        appliedRevisionId: null,
        error: null,
      },
      {
        ...baseTurn,
        state: "applied" as const,
        kind: "proposal" as const,
        responseText: "I can add an order queue.",
        operations: [addQueueOperation],
        appliedRevisionId: "revision-2",
        error: null,
        reviewedAt: "2026-07-21T12:01:00.000Z",
        reviewedByParticipantId: "participant-1",
        reviewRationale: "The queue improves failure isolation.",
      },
      {
        ...baseTurn,
        state: "rejected" as const,
        kind: "proposal" as const,
        responseText: "I can add an order queue.",
        operations: [addQueueOperation],
        appliedRevisionId: null,
        error: null,
        reviewedAt: "2026-07-21T12:01:00.000Z",
        reviewedByParticipantId: "participant-1",
        reviewRationale: "Keep the synchronous design for now.",
      },
      {
        ...baseTurn,
        state: "failed" as const,
        kind: null,
        responseText: null,
        operations: [],
        appliedRevisionId: null,
        error: {
          code: "TURN_INTERRUPTED" as const,
          message: "The architect turn was interrupted. Submit a new request to retry.",
        },
      },
    ];

    for (const turn of turns) expect(ArchitectTurnSchema.parse(turn)).toEqual(turn);
    expect(ArchitectTurnListSchema.parse({ turns })).toEqual({ turns });
    expect(ArchitectTurnSchema.safeParse({
      ...turns[0],
      sourceProtectedDigest: "not-a-sha256-digest",
    }).success).toBe(false);
  });

  it("bounds and strictly parses turn and review requests", () => {
    const turnRequest = {
      message: "Explain the current fault-tolerance tradeoffs.",
      idempotencyKey: "turn-request-1",
    };
    const applyRequest = {
      baseRevisionId: "revision-1",
      idempotencyKey: "apply-request-1",
      rationale: "The queue is an intentional reliability improvement.",
      destructiveConfirmation: {
        confirmed: true as const,
        rationale: "I reviewed and approve the proposed removals.",
      },
    };
    const rejectRequest = {
      idempotencyKey: "reject-request-1",
      rationale: "This change is outside the current delivery scope.",
    };

    expect(ArchitectTurnRequestSchema.parse(turnRequest)).toEqual(turnRequest);
    expect(ApplyArchitectPatchRequestSchema.parse(applyRequest)).toEqual(applyRequest);
    expect(RejectArchitectPatchRequestSchema.parse(rejectRequest)).toEqual(rejectRequest);
    expect(ArchitectTurnRequestSchema.safeParse({
      ...turnRequest,
      ignored: true,
    }).success).toBe(false);
    expect(ArchitectTurnRequestSchema.safeParse({
      ...turnRequest,
      message: "x".repeat(4_001),
    }).success).toBe(false);
    expect(ApplyArchitectPatchRequestSchema.safeParse({
      ...applyRequest,
      rationale: "x".repeat(501),
    }).success).toBe(false);
  });

  it("strictly bounds every public architect API error response", () => {
    const conflict = {
      code: "revision_conflict" as const,
      message: "Architecture revision is stale",
      currentRevisionId: "revision-2",
    };
    const unavailable = {
      code: "architect_unavailable" as const,
      message: "Architect unavailable",
    };

    expect(ArchitectApiErrorResponseSchema.parse(conflict)).toEqual(conflict);
    expect(ArchitectApiErrorResponseSchema.parse(unavailable)).toEqual(unavailable);
    expect(ArchitectApiErrorResponseSchema.safeParse({
      ...unavailable,
      stack: "raw-internal-stack",
    }).success).toBe(false);
    expect(ArchitectApiErrorResponseSchema.safeParse({
      ...unavailable,
      message: "x".repeat(241),
    }).success).toBe(false);
    expect(ArchitectApiErrorResponseSchema.safeParse({
      code: "unknown_error",
      message: "Unknown",
    }).success).toBe(false);
  });
});

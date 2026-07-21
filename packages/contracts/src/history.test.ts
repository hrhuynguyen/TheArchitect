import { describe, expect, it } from "vitest";

import { defaultRequirementsProfile } from "./requirements.js";
import {
  ArchitectureRevisionSchema,
  HistoryEventSchema,
  RevisionHistoryResponseSchema,
  SaveRevisionRequestSchema,
  SaveRevisionResponseSchema,
} from "./history.js";

const revision = {
  id: "revision-b",
  roomId: "room-a",
  version: 2,
  architecture: {
    version: "architecture/v1" as const,
    requirements: defaultRequirementsProfile(),
    resources: [],
    relationships: [],
    decisions: [],
    unresolvedQuestions: [],
  },
  layout: {
    version: "architecture-layout/v1" as const,
    revisionId: "revision-b",
    nodes: [],
  },
  requirements: defaultRequirementsProfile(),
  stage: "prototype" as const,
  authorType: "participant" as const,
  authorId: "participant-a",
  rationale: "Capture the accepted queue design.",
  createdAt: "2026-07-21T12:00:00.000Z",
};

const event = {
  id: "event-b",
  roomId: "room-a",
  kind: "architecture_revision_saved",
  status: "succeeded" as const,
  actorType: "participant" as const,
  actorId: "participant-a",
  title: "Architecture revision saved",
  summary: "Capture the accepted queue design.",
  details: {
    revisionId: "revision-b",
    baseRevisionId: "revision-a",
    version: 2,
  },
  traceId: "request-7",
  createdAt: "2026-07-21T12:00:00.000Z",
};

describe("architecture revision and history contracts", () => {
  it("parses immutable revision and event response records", () => {
    expect(ArchitectureRevisionSchema.parse(revision)).toEqual(revision);
    expect(HistoryEventSchema.parse(event)).toEqual(event);
    expect(RevisionHistoryResponseSchema.parse({
      revisions: [revision],
      events: [event],
    })).toEqual({ revisions: [revision], events: [event] });
  });

  it("requires a base revision and rationale for a save", () => {
    const request = {
      baseRevisionId: "revision-a",
      rationale: "Capture the accepted queue design.",
    };
    expect(SaveRevisionRequestSchema.parse(request)).toEqual(request);
    expect(SaveRevisionResponseSchema.parse({ revision, event })).toEqual({
      revision,
      event,
    });
    expect(SaveRevisionRequestSchema.safeParse({
      baseRevisionId: "revision-a",
      rationale: " ",
    }).success).toBe(false);
    expect(SaveRevisionRequestSchema.safeParse({
      ...request,
      ignored: true,
    }).success).toBe(false);
  });

  it("rejects a layout whose revision id differs from the immutable revision", () => {
    expect(ArchitectureRevisionSchema.safeParse({
      ...revision,
      layout: { ...revision.layout, revisionId: "revision-a" },
    }).success).toBe(false);
  });
});

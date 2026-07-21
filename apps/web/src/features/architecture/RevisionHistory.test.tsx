// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { defaultRequirementsProfile } from "@architect/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RevisionHistory } from "./RevisionHistory.js";

afterEach(cleanup);

const requirements = defaultRequirementsProfile();
const architecture = {
  version: "architecture/v1" as const,
  requirements,
  resources: [],
  relationships: [],
  decisions: [],
  unresolvedQuestions: [],
};
const revision = {
  id: "revision-b",
  roomId: "room-a",
  version: 2,
  architecture,
  layout: {
    version: "architecture-layout/v1" as const,
    revisionId: "revision-b",
    nodes: [],
  },
  requirements,
  stage: "prototype" as const,
  authorType: "participant" as const,
  authorId: "participant-ada",
  rationale: "Accepted the buffered worker design.",
  createdAt: "2026-07-21T12:00:00.000Z",
};
const event = {
  id: "event-b",
  roomId: "room-a",
  kind: "architecture_revision_saved",
  status: "succeeded" as const,
  actorType: "participant" as const,
  actorId: "participant-ada",
  title: "Architecture revision saved",
  summary: "Accepted the buffered worker design.",
  details: { revisionId: "revision-b" },
  traceId: "request-7",
  createdAt: "2026-07-21T12:00:00.000Z",
};

describe("RevisionHistory", () => {
  it("shows immutable versions, rationale, actors, and change events", () => {
    render(<RevisionHistory revisions={[revision]} events={[event]} />);

    expect(screen.getByRole("heading", { name: "Revision 2" })).toBeVisible();
    expect(screen.getByText("Accepted the buffered worker design.")).toBeVisible();
    expect(screen.getByText(/participant-ada/i)).toBeVisible();
    expect(screen.getByText("Architecture revision saved")).toBeVisible();
  });

  it("renders a useful empty state", () => {
    render(<RevisionHistory revisions={[]} events={[]} />);
    expect(screen.getByText("No saved revisions yet.")).toBeVisible();
  });
});

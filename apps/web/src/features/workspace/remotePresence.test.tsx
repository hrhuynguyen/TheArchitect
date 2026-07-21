// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { AwarenessProfile } from "@architect/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CursorOverlay } from "./CursorOverlay.js";
import { MemberStrip } from "./MemberStrip.js";

const profiles: AwarenessProfile[] = [
  {
    participantId: "participant-a",
    name: "Ada",
    color: "#10A37F",
    cursor: { x: 48, y: 64 },
    phase: "sketch",
    lastSeenAt: "2026-07-21T12:00:00.000Z",
  },
  {
    participantId: "participant-b",
    name: "Grace",
    color: "#2563EB",
    cursor: { x: 90, y: 30 },
    phase: "architect",
    lastSeenAt: "2026-07-21T12:00:00.000Z",
  },
];

afterEach(cleanup);

describe("trusted remote presence views", () => {
  it("renders member identity from the supplied server profiles", () => {
    render(<MemberStrip profiles={profiles} />);

    expect(screen.getByRole("list", { name: "Live collaborators" })).toBeVisible();
    expect(screen.getByText("Ada")).toBeVisible();
    expect(screen.getByText("Grace")).toBeVisible();
  });

  it("renders only another participant's active sketch cursor", () => {
    render(
      <CursorOverlay localParticipantId="participant-local" profiles={profiles} />,
    );

    expect(screen.getByText("Ada")).toBeVisible();
    expect(screen.queryByText("Grace")).not.toBeInTheDocument();
    expect(screen.getByTestId("cursor-participant-a")).toHaveStyle({
      left: "48px",
      top: "64px",
    });
  });

  it("does not draw the local participant's mirrored server cursor", () => {
    render(<CursorOverlay localParticipantId="participant-a" profiles={profiles} />);
    expect(screen.queryByTestId("cursor-participant-a")).not.toBeInTheDocument();
  });
});

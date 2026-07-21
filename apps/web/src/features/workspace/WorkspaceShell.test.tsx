// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PhaseRail } from "./PhaseRail";
import { WorkspaceShell } from "./WorkspaceShell";

afterEach(cleanup);

const room = {
  id: "room-ada",
  mode: "shared" as const,
  phase: "architect" as const,
  isOwner: false,
  participants: [
    { id: "participant-ada", name: "Ada", color: "#10A37F" },
    { id: "participant-grace", name: "Grace", color: "#D97706" },
  ],
};

describe("PhaseRail", () => {
  it("marks the current workspace phase with text and aria-current", () => {
    render(<PhaseRail phase="architect" roomId="room-ada" />);

    expect(screen.getByText("Architect").closest("a")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByText("Sketch")).toBeVisible();
    expect(screen.getByText("Deploy")).toBeVisible();
  });
});

describe("WorkspaceShell", () => {
  it("provides named content and context regions", () => {
    render(
      <WorkspaceShell room={room} contextPanel={<p>Two collaborators</p>}>
        <h1>Architecture canvas</h1>
      </WorkspaceShell>,
    );

    expect(screen.getByRole("main", { name: /workspace content/i })).toHaveTextContent(
      "Architecture canvas",
    );
    expect(screen.getByRole("complementary", { name: /workspace context/i })).toHaveTextContent(
      "Two collaborators",
    );
    expect(screen.getByRole("heading", { name: /2 collaborators/i })).toBeVisible();
    expect(screen.getByText(/^participant$/i)).toBeVisible();
  });
});

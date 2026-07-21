// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { defaultRequirementsProfile } from "@architect/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProvenanceBadge } from "./ProvenanceBadge.js";
import { UpgradeReviewPanel } from "./UpgradeReviewPanel.js";

afterEach(cleanup);

const architecture = {
  version: "architecture/v1" as const,
  requirements: defaultRequirementsProfile(),
  resources: [
    {
      id: "app",
      type: "Lambda" as const,
      name: "API handler",
      properties: {},
      origin: "explicit" as const,
      reason: "Drawn in the source sketch.",
      approvalStatus: "not-required" as const,
    },
    {
      id: "replica",
      type: "Lambda" as const,
      name: "Regional replica",
      properties: {},
      origin: "stage-upgrade" as const,
      reason: "Growth recovery goals require another regional worker.",
      approvalStatus: "pending" as const,
    },
  ],
  relationships: [{
    id: "replica-to-app",
    sourceId: "replica",
    targetId: "app",
    kind: "connects" as const,
    origin: "stage-upgrade" as const,
    reason: "The regional worker joins the application path.",
    approvalStatus: "pending" as const,
  }],
  decisions: [],
  unresolvedQuestions: [],
};

describe("UpgradeReviewPanel", () => {
  it("explains every pending upgrade and emits explicit accept or reject decisions", async () => {
    const onDecision = vi.fn();
    const user = userEvent.setup();
    render(
      <UpgradeReviewPanel
        architecture={architecture}
        disabled={false}
        onDecision={onDecision}
      />,
    );

    expect(screen.getByRole("heading", { name: "Regional replica" })).toBeVisible();
    expect(screen.getByText(/growth recovery goals/i)).toBeVisible();
    expect(screen.getByText(/affects api handler/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /accept regional replica/i }));
    await user.click(screen.getByRole("button", { name: /reject regional replica/i }));
    expect(onDecision).toHaveBeenNthCalledWith(1, "replica", "approved");
    expect(onDecision).toHaveBeenNthCalledWith(2, "replica", "rejected");
  });

  it("states when no stage upgrade is awaiting review", () => {
    render(
      <UpgradeReviewPanel
        architecture={{
          ...architecture,
          resources: architecture.resources.slice(0, 1),
          relationships: [],
        }}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText("No upgrades awaiting review.")).toBeVisible();
  });
});

describe("ProvenanceBadge", () => {
  it("communicates origin with text and exposes its reason", () => {
    render(
      <ProvenanceBadge
        origin="inferred-minimal"
        reason="Added to make the graph deployable."
      />,
    );
    expect(screen.getByText("Inferred")).toHaveAttribute(
      "title",
      "Added to make the graph deployable.",
    );
  });
});

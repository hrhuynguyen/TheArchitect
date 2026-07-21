// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { defaultRequirementsProfile } from "@architect/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugBench } from "./DebugBench.js";

const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const requirements = defaultRequirementsProfile();
const architecture = {
  version: "architecture/v1" as const,
  requirements,
  resources: [],
  relationships: [],
  decisions: [],
  unresolvedQuestions: [],
};
const result = {
  provider: { provider: "openai" as const, model: "gpt-5.6" },
  intent: { version: "infrastructure-intent/v1" as const, resources: [], relationships: [] },
  diagnostics: [],
  stageDecision: {
    version: "stage-decision/v1" as const,
    stage: "prototype" as const,
    confidence: "high" as const,
    reasons: ["Prototype fit."],
    requiresApproval: false,
    proposedUpgrades: [],
  },
  deploymentPlan: {
    version: "deployment-plan/v1" as const,
    stage: "prototype" as const,
    requiresApproval: false,
    approvalsSatisfied: true,
    pendingApprovalResourceIds: [],
    pendingApprovalRelationshipIds: [],
    architecture,
  },
  semanticGraph: architecture,
};

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DebugBench", () => {
  it("offers only room, PNG, and workload controls with no sensitive override surface", () => {
    const { container } = render(<DebugBench />);
    expect(screen.getByRole("textbox", { name: "Room ID" })).toBeVisible();
    expect(screen.getByLabelText("PNG sketch")).toHaveAttribute(
      "accept",
      expect.stringContaining("image/png"),
    );
    expect(screen.getByLabelText("Audience")).toBeVisible();
    expect(screen.getByLabelText("Criticality")).toBeVisible();
    expect(screen.getByLabelText("Expected users")).toBeVisible();
    expect(screen.getByLabelText("Traffic")).toBeVisible();
    expect(screen.getByLabelText("Burstiness")).toBeVisible();
    expect(screen.getByLabelText("Availability")).toBeVisible();
    expect(screen.getByLabelText("Recovery target")).toBeVisible();
    expect(screen.getByLabelText("Asynchronous workload")).toBeVisible();
    expect(screen.queryByLabelText(/api key|token|provider|model|prompt|data url/i))
      .not.toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("data:image/png;base64,");
  });

  it("rejects a non-PNG locally without calling the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<DebugBench />);
    await user.type(screen.getByRole("textbox", { name: "Room ID" }), "room-a");
    fireEvent.change(screen.getByLabelText("PNG sketch"), {
      target: {
        files: [new File(["jpeg"], "sketch.jpg", { type: "image/jpeg" })],
      },
    });
    await user.click(screen.getByRole("button", { name: "Analyze sketch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a PNG sketch.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("submits locally held PNG data and renders every validated safe output panel", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      response(result)
    ));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    const { container } = render(<DebugBench />);
    await user.type(screen.getByRole("textbox", { name: "Room ID" }), "room-a");
    await user.upload(
      screen.getByLabelText("PNG sketch"),
      new File([IMAGE_BYTES], "sketch.png", { type: "image/png" }),
    );
    await user.selectOptions(screen.getByLabelText("Traffic"), "high");
    await user.click(screen.getByRole("button", { name: "Analyze sketch" }));

    expect(await screen.findByRole("heading", { name: "Semantic graph" })).toBeVisible();
    for (const heading of [
      "Provider provenance",
      "Intent",
      "Diagnostics",
      "Stage decision",
      "Deployment plan",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeVisible();
    }
    expect(fetch).toHaveBeenCalledWith(
      "/api/debug/rooms/room-a/reconstruction",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    const request = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({
      mimeType: "image/png",
      requirements: { traffic: "high" },
    });
    expect(request.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(container.textContent).not.toContain(request.imageDataUrl);
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows pending state and normalizes malformed success output", async () => {
    let release!: () => void;
    const pending = new Promise<Response>((resolve) => {
      release = () => resolve(new Response(JSON.stringify({ ...result, extra: true })));
    });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    const user = userEvent.setup();
    render(<DebugBench />);
    await user.type(screen.getByRole("textbox", { name: "Room ID" }), "room-a");
    await user.upload(
      screen.getByLabelText("PNG sketch"),
      new File([IMAGE_BYTES], "sketch.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Analyze sketch" }));
    expect(screen.getByRole("status")).toHaveTextContent("Analyzing sketch");
    expect(screen.getByRole("button", { name: "Analyzing…" })).toBeDisabled();

    await act(async () => release());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The diagnostic response was invalid.",
    );
    expect(screen.queryByText(/extra/)).not.toBeInTheDocument();
  });
});

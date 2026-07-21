// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  defaultRequirementsProfile,
  type RequirementsProfile,
} from "@architect/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import { RequirementsPanel } from "./RequirementsPanel.js";

const remoteProfile: RequirementsProfile = {
  version: "requirements/v1",
  audience: "internal",
  criticality: "business_critical",
  expectedUsers: "large",
  traffic: "high",
  burstiness: "bursty",
  asyncWorkload: true,
  availability: "high_availability",
  recovery: "standard",
};

afterEach(cleanup);

describe("RequirementsPanel", () => {
  it("initializes one explicit current value only when the shared document is empty", () => {
    const doc = new Y.Doc();
    render(<RequirementsPanel doc={doc} />);

    const requirements = doc.getMap<unknown>("requirements");
    expect([...requirements.keys()]).toEqual(["current"]);
    expect(requirements.get("current")).toEqual(defaultRequirementsProfile());
    expect(screen.getByRole("group", { name: "Workload requirements" })).toBeVisible();
    expect(screen.getByLabelText("Who uses this system?")).toHaveValue("external");
    expect(screen.getByLabelText("Async background work")).not.toBeChecked();

    doc.destroy();
  });

  it("reads a remote initial value without clobbering it and observes later changes", () => {
    const doc = new Y.Doc();
    const requirements = doc.getMap<unknown>("requirements");
    requirements.set("current", remoteProfile);
    let writes = 0;
    requirements.observe(() => {
      writes += 1;
    });
    render(<RequirementsPanel doc={doc} />);

    expect(writes).toBe(0);
    expect(requirements.get("current")).toEqual(remoteProfile);
    expect(screen.getByLabelText("Who uses this system?")).toHaveValue("internal");
    expect(screen.getByLabelText("Async background work")).toBeChecked();

    act(() => {
      requirements.set("current", { ...remoteProfile, recovery: "rapid" });
    });
    expect(screen.getByLabelText("Recovery target")).toHaveValue("rapid");
    expect(writes).toBe(1);

    doc.destroy();
  });

  it("writes validated local control changes as one shared value", async () => {
    const doc = new Y.Doc();
    const user = userEvent.setup();
    render(<RequirementsPanel doc={doc} />);

    await user.selectOptions(screen.getByLabelText("Traffic volume"), "moderate");
    await user.click(screen.getByLabelText("Async background work"));

    expect(doc.getMap<unknown>("requirements").get("current")).toEqual({
      ...defaultRequirementsProfile(),
      traffic: "moderate",
      asyncWorkload: true,
    });

    doc.destroy();
  });

  it("freezes every workload control while reconstruction is in progress", async () => {
    const doc = new Y.Doc();
    const user = userEvent.setup();
    render(<RequirementsPanel disabled doc={doc} />);
    const before = doc.getMap<unknown>("requirements").get("current");

    expect(
      screen.getByRole("group", { name: "Workload requirements" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Traffic volume")).toBeDisabled();
    expect(screen.getByLabelText("Async background work")).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Traffic volume"), "moderate");
    await user.click(screen.getByLabelText("Async background work"));
    expect(doc.getMap<unknown>("requirements").get("current")).toEqual(before);

    doc.destroy();
  });

  it("retains the last valid controls and reports an invalid remote value safely", () => {
    const doc = new Y.Doc();
    const requirements = doc.getMap<unknown>("requirements");
    requirements.set("current", remoteProfile);
    render(<RequirementsPanel doc={doc} />);

    act(() => {
      requirements.set("current", {
        ...remoteProfile,
        audience: "everyone",
        message: "<img src=x onerror=alert(1)>",
      });
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Shared requirements are invalid. Your last valid values are still shown.",
    );
    expect(screen.getByLabelText("Who uses this system?")).toHaveValue("internal");
    expect(document.querySelector("img")).toBeNull();

    doc.destroy();
  });

  it("shows a connection failure and keeps every control keyboard reachable", async () => {
    const doc = new Y.Doc();
    const user = userEvent.setup();
    render(
      <RequirementsPanel
        connectionError="Shared canvas connection is unavailable."
        doc={doc}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Shared canvas connection is unavailable.",
    );
    await user.tab();
    expect(screen.getByLabelText("Who uses this system?")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("System criticality")).toHaveFocus();

    doc.destroy();
  });
});

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResourcePalette } from "./ResourcePalette.js";

afterEach(cleanup);

describe("ResourcePalette", () => {
  it("offers the allowlisted resource catalog and emits typed additions", async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<ResourcePalette onAdd={onAdd} />);

    expect(screen.getByRole("button", { name: "Add Amazon S3" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add AWS Lambda" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add Amazon SQS" }));
    expect(onAdd).toHaveBeenCalledWith("SQS");
  });

  it("disables additions while a graph request is in flight", () => {
    render(<ResourcePalette disabled onAdd={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Add Amazon S3" })).toBeDisabled();
  });
});

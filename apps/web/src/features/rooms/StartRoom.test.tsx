// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartRoom } from "./StartRoom";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const sharedRoom = {
  id: "room-ada",
  mode: "shared" as const,
  phase: "sketch" as const,
  isOwner: true,
  participants: [{ id: "participant-ada", name: "Ada", color: "#10A37F" }],
  joinPath: "/room/room-ada",
};

function roomApi() {
  return {
    create: vi.fn().mockResolvedValue(sharedRoom),
    join: vi.fn().mockResolvedValue(sharedRoom),
    get: vi.fn().mockResolvedValue(sharedRoom),
  };
}

describe("StartRoom", () => {
  it("creates a room only after a valid guest profile is entered", async () => {
    const api = roomApi();
    const onRoomReady = vi.fn();
    const user = userEvent.setup();

    render(<StartRoom api={api} onRoomReady={onRoomReady} />);

    expect(screen.getByRole("button", { name: /create shared room/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/display name/i), "Ada");
    await user.click(screen.getByRole("button", { name: /create shared room/i }));

    expect(api.create).toHaveBeenCalledWith(
      { name: "Ada", color: "#10A37F" },
      "shared",
    );
    expect(onRoomReady).toHaveBeenCalledWith("room-ada");
  });

  it("joins a room from a pasted shared path", async () => {
    const api = roomApi();
    const onRoomReady = vi.fn();
    const user = userEvent.setup();

    render(<StartRoom api={api} onRoomReady={onRoomReady} />);
    await user.type(screen.getByLabelText(/display name/i), "Grace");
    await user.click(screen.getByRole("button", { name: /^join room$/i }));
    await user.type(screen.getByLabelText(/room id or link/i), "https://example.test/room/room-ada");
    await user.click(screen.getByRole("button", { name: /join workspace/i }));

    expect(api.join).toHaveBeenCalledWith("room-ada", {
      name: "Grace",
      color: "#10A37F",
    });
    expect(onRoomReady).toHaveBeenCalledWith("room-ada");
  });

  it("creates a durable solo room through the same room API", async () => {
    const api = roomApi();
    const user = userEvent.setup();

    render(<StartRoom api={api} onRoomReady={vi.fn()} />);
    await user.type(screen.getByLabelText(/display name/i), "Lin");
    await user.click(screen.getByRole("button", { name: /work alone/i }));

    expect(api.create).toHaveBeenCalledWith(
      { name: "Lin", color: "#10A37F" },
      "solo",
    );
  });

  it("announces non-success responses without navigating", async () => {
    const api = roomApi();
    api.create.mockRejectedValueOnce(new Error("The room service is unavailable."));
    const onRoomReady = vi.fn();
    const user = userEvent.setup();

    render(<StartRoom api={api} onRoomReady={onRoomReady} />);
    await user.type(screen.getByLabelText(/display name/i), "Ada");
    await user.click(screen.getByRole("button", { name: /create shared room/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The room service is unavailable.",
    );
    expect(onRoomReady).not.toHaveBeenCalled();
  });
});

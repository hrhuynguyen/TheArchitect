// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getRoom = vi.hoisted(() => vi.fn());

vi.mock("../../../features/rooms/api", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../features/rooms/api")
  >();
  return {
    ...actual,
    roomApi: {
      create: vi.fn(),
      join: vi.fn(),
      get: getRoom,
    },
  };
});

vi.mock("../../../features/sketch/Whiteboard", () => ({
  Whiteboard: ({
    room,
    onPhaseChange,
  }: {
    room: typeof baseRoom;
    onPhaseChange?: (phase: "reconstructing" | "architect") => void;
  }) => (
    <section aria-label="Collaborative architecture sketch">
      <h1>Map the system together.</h1>
      <p>Live room {room.id}</p>
      <button onClick={() => onPhaseChange?.("reconstructing")} type="button">
        Confirm reconstructing
      </button>
      <button onClick={() => onPhaseChange?.("architect")} type="button">
        Complete reconstruction
      </button>
    </section>
  ),
}));

vi.mock("../../../features/architecture/GraphEditor", () => ({
  GraphEditor: ({ canReview, roomId }: { canReview: boolean; roomId: string }) => (
    <section aria-label="Connected architecture editor">
      Editing room {roomId}. {canReview ? "Review enabled" : "Review disabled"}.
    </section>
  ),
}));

import { RoomApiError } from "../../../features/rooms/api";
import RoomPage from "./page";

afterEach(() => {
  cleanup();
  getRoom.mockReset();
});

const baseRoom = {
  id: "room-ada",
  mode: "shared" as const,
  phase: "sketch" as const,
  isOwner: true,
  currentParticipantId: "participant-ada",
  participants: [{ id: "participant-ada", name: "Ada", color: "#10A37F" }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function renderRoomPage() {
  const params = Promise.resolve({ roomId: "room-ada" });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <Suspense fallback={<p>Resolving room…</p>}>
        <RoomPage params={params} />
      </Suspense>,
    );
  });
  return view;
}

describe("room route", () => {
  it("moves from loading to the ready room summary", async () => {
    const pending = deferred<typeof baseRoom>();
    getRoom.mockReturnValueOnce(pending.promise);
    await renderRoomPage();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Opening your workspace…",
    );
    await act(async () => pending.resolve(baseRoom));

    expect(
      await screen.findByRole("heading", { name: "Map the system together." }),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Collaborative architecture sketch" }),
    ).toBeVisible();
  });

  it("renders a room-not-found state for a 404", async () => {
    getRoom.mockRejectedValueOnce(
      new RoomApiError("Room not found", 404, "room_not_found"),
    );
    await renderRoomPage();

    expect(
      await screen.findByRole("heading", { name: "This workspace is no longer here." }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Start a room" })).toHaveAttribute(
      "href",
      "/start",
    );
  });

  it("keeps browser capture mounted until reconstruction becomes terminal", async () => {
    getRoom.mockResolvedValueOnce(baseRoom);
    const user = userEvent.setup();
    await renderRoomPage();

    await user.click(
      await screen.findByRole("button", { name: "Confirm reconstructing" }),
    );
    expect(
      screen.getByRole("region", { name: "Collaborative architecture sketch" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Complete reconstruction" }));
    expect(
      screen.getByRole("region", { name: "Connected architecture editor" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Collaborative architecture sketch" }),
    ).not.toBeInTheDocument();
  });

  it("states that a solo room cannot accept collaborators", async () => {
    getRoom.mockResolvedValueOnce({ ...baseRoom, mode: "solo" });
    await renderRoomPage();

    expect(
      await screen.findByText(
        "This durable workspace is private and cannot accept collaborators.",
      ),
    ).toBeVisible();
  });

  it("retries after a normalized network error", async () => {
    getRoom
      .mockRejectedValueOnce(
        new RoomApiError(
          "Unable to reach the room service. Check your connection and try again.",
          0,
          "room_network_error",
        ),
      )
      .mockResolvedValueOnce(baseRoom);
    const user = userEvent.setup();
    await renderRoomPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to reach the room service. Check your connection and try again.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { name: "Map the system together." }),
    ).toBeVisible();
    expect(getRoom).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      phase: "deploy" as const,
      kicker: "Deploy workspace ready",
      heading: "Move forward with the evidence in view.",
      description: "Deployment controls and evidence will stay visible here.",
      contentId: "deploy",
    },
  ])(
    "renders $phase summaries as $contentId content",
    async ({ phase, kicker, heading, description, contentId }) => {
      getRoom.mockResolvedValueOnce({ ...baseRoom, phase });
      await renderRoomPage();

      expect(await screen.findByText(kicker)).toBeVisible();
      expect(screen.getByRole("heading", { name: heading })).toBeVisible();
      expect(screen.getByText(description)).toBeVisible();
      expect(screen.getByText(kicker).closest("div")).toHaveAttribute("id", contentId);
      expect(screen.getByText("Deploy").closest("a"))
        .toHaveAttribute("aria-current", "step");
    },
  );

  it("restores browser reconstruction work while the rail shows architect", async () => {
    getRoom.mockResolvedValueOnce({ ...baseRoom, phase: "reconstructing" });
    await renderRoomPage();

    expect(
      await screen.findByRole("region", { name: "Collaborative architecture sketch" }),
    ).toBeVisible();
    expect(screen.getByText("Architect").closest("a")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("mounts the connected React Flow editor in the architect phase", async () => {
    getRoom.mockResolvedValueOnce({ ...baseRoom, phase: "architect" });
    await renderRoomPage();

    expect(
      await screen.findByRole("region", { name: "Connected architecture editor" }),
    ).toHaveTextContent("Editing room room-ada. Review enabled.");
    expect(
      screen.queryByRole("heading", { name: "Shape the system into a buildable plan." }),
    ).not.toBeInTheDocument();
  });

  it("disables Architect patch review without a current participant session", async () => {
    getRoom.mockResolvedValueOnce({
      ...baseRoom,
      phase: "architect",
      currentParticipantId: null,
    });
    await renderRoomPage();

    expect(
      await screen.findByRole("region", { name: "Connected architecture editor" }),
    ).toHaveTextContent("Review disabled");
  });

  it("suppresses a room result that resolves after unmount", async () => {
    const pending = deferred<typeof baseRoom>();
    getRoom.mockReturnValueOnce(pending.promise);
    const view = await renderRoomPage();
    await screen.findByRole("status");

    view.unmount();
    await act(async () => pending.resolve(baseRoom));

    expect(
      screen.queryByRole("heading", { name: "Map the system together." }),
    ).not.toBeInTheDocument();
  });
});

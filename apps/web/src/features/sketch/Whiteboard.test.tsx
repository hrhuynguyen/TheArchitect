// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { AwarenessProfile, RoomSummary } from "@architect/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bindingDestroy: vi.fn(),
  collabDestroy: vi.fn(),
  createRoomCollab: vi.fn(),
  createTLStore: vi.fn(),
  createTldrawBinding: vi.fn(),
  storeDispose: vi.fn(),
  usePresence: vi.fn(),
}));

vi.mock("tldraw", () => ({
  createTLStore: mocks.createTLStore,
  Tldraw: () => (
    <div data-testid="tldraw-editor" onPointerMove={(event) => event.stopPropagation()}>
      Drawing editor
    </div>
  ),
}));

vi.mock("../workspace/collab", () => ({
  createRoomCollab: mocks.createRoomCollab,
}));

vi.mock("../workspace/usePresence", () => ({
  usePresence: mocks.usePresence,
}));

vi.mock("./tldrawBinding", () => ({
  createTldrawBinding: mocks.createTldrawBinding,
}));

import { Whiteboard } from "./Whiteboard";

type EventListener = (data: never) => void;

function providerBoundary() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    provider: {
      synced: false,
      on(event: string, listener: EventListener) {
        const eventListeners = listeners.get(event) ?? new Set<EventListener>();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
      },
      off(event: string, listener: EventListener) {
        listeners.get(event)?.delete(listener);
      },
    },
    emit(event: string, data: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        listener(data as never);
      }
    },
  };
}

const room: RoomSummary = {
  id: "room-ada",
  mode: "shared",
  phase: "sketch",
  isOwner: true,
  currentParticipantId: "participant-ada",
  participants: [{ id: "participant-ada", name: "Ada", color: "#10A37F" }],
};

const trustedProfiles: AwarenessProfile[] = [
  {
    participantId: "participant-grace",
    name: "Grace",
    color: "#2563EB",
    cursor: { x: 10, y: 20 },
    phase: "sketch",
    lastSeenAt: "2026-07-21T12:00:00.000Z",
  },
];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createTLStore.mockReturnValue({ dispose: mocks.storeDispose });
  mocks.createTldrawBinding.mockReturnValue({ destroy: mocks.bindingDestroy });
  mocks.usePresence.mockReturnValue(trustedProfiles);
});

describe("Whiteboard", () => {
  it("waits for initial sync, then binds and renders trusted live presence", async () => {
    const boundary = providerBoundary();
    const doc = new Y.Doc();
    mocks.createRoomCollab.mockReturnValue({
      destroy: mocks.collabDestroy,
      doc,
      provider: boundary.provider,
    });
    const view = render(<Whiteboard room={room} />);

    expect(screen.getByRole("status")).toHaveTextContent("Connecting shared canvas…");
    expect(screen.queryByTestId("tldraw-editor")).not.toBeInTheDocument();

    act(() => boundary.emit("synced", { state: true }));
    expect(await screen.findByTestId("tldraw-editor")).toBeVisible();
    expect(screen.getAllByText("Grace")).toHaveLength(2);
    expect(mocks.createTldrawBinding).toHaveBeenCalledWith(
      expect.objectContaining({ doc, store: expect.anything() }),
    );

    view.unmount();
    expect(mocks.bindingDestroy).toHaveBeenCalledOnce();
    expect(mocks.storeDispose).toHaveBeenCalledOnce();
    expect(mocks.collabDestroy).toHaveBeenCalledOnce();
    doc.destroy();
  });

  it("publishes meaningful relative pointer motion through usePresence", async () => {
    vi.useFakeTimers();
    const boundary = providerBoundary();
    const doc = new Y.Doc();
    mocks.createRoomCollab.mockReturnValue({
      destroy: mocks.collabDestroy,
      doc,
      provider: boundary.provider,
    });
    render(<Whiteboard room={room} />);
    act(() => boundary.emit("synced", { state: true }));
    expect(screen.getByTestId("tldraw-editor")).toBeVisible();

    const whiteboard = screen.getByRole("region", {
      name: "Collaborative architecture sketch",
    });
    Object.defineProperty(whiteboard, "getBoundingClientRect", {
      value: () => ({ left: 20, top: 30 }),
    });
    const canvas = screen.getByTestId("tldraw-editor").parentElement!;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 40, top: 80 }),
    });
    act(() =>
      fireEvent.pointerMove(screen.getByTestId("tldraw-editor"), {
        clientX: 140,
        clientY: 230,
      }),
    );

    expect(mocks.usePresence).toHaveBeenLastCalledWith(
        expect.objectContaining({
          profile: expect.objectContaining({ cursor: { x: 100, y: 150 } }),
        }),
    );
    doc.destroy();
  });

  it("clears a queued cursor on pointer leave without a stale timer replay", () => {
    vi.useFakeTimers();
    const boundary = providerBoundary();
    const doc = new Y.Doc();
    mocks.createRoomCollab.mockReturnValue({
      destroy: mocks.collabDestroy,
      doc,
      provider: boundary.provider,
    });
    render(<Whiteboard room={room} />);
    act(() => boundary.emit("synced", { state: true }));

    const editor = screen.getByTestId("tldraw-editor");
    const canvas = editor.parentElement!;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 40, top: 80 }),
    });
    act(() => {
      fireEvent.pointerMove(editor, { clientX: 140, clientY: 230 });
      fireEvent.pointerMove(editor, { clientX: 180, clientY: 270 });
      fireEvent.pointerLeave(canvas);
    });
    expect(mocks.usePresence).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.not.objectContaining({ cursor: expect.anything() }),
      }),
    );

    act(() => vi.advanceTimersByTime(50));
    expect(mocks.usePresence).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.not.objectContaining({ cursor: expect.anything() }),
      }),
    );
    doc.destroy();
  });

  it("reports a disconnect safely after a successful sync", async () => {
    const boundary = providerBoundary();
    const doc = new Y.Doc();
    mocks.createRoomCollab.mockReturnValue({
      destroy: mocks.collabDestroy,
      doc,
      provider: boundary.provider,
    });
    render(<Whiteboard room={room} />);
    act(() => boundary.emit("synced", { state: true }));
    await screen.findByTestId("tldraw-editor");

    act(() => boundary.emit("status", { status: "disconnected" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Shared canvas connection is unavailable.",
    );
    expect(screen.getByTestId("tldraw-editor")).toBeVisible();
    doc.destroy();
  });

  it("shows a pre-sync disconnect and clears it after reconnecting and syncing", async () => {
    const boundary = providerBoundary();
    const doc = new Y.Doc();
    mocks.createRoomCollab.mockReturnValue({
      destroy: mocks.collabDestroy,
      doc,
      provider: boundary.provider,
    });
    render(<Whiteboard room={room} />);

    act(() => boundary.emit("status", { status: "disconnected" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Shared canvas connection is unavailable. Retrying…",
    );
    expect(screen.queryByTestId("tldraw-editor")).not.toBeInTheDocument();

    act(() => boundary.emit("status", { status: "connected" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connecting shared canvas…",
    );

    act(() => boundary.emit("synced", { state: true }));
    expect(await screen.findByTestId("tldraw-editor")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    doc.destroy();
  });

  it("keeps a synchronous drawing-data warning visible with the usable canvas", async () => {
    const boundary = providerBoundary();
    const doc = new Y.Doc();
    mocks.createRoomCollab.mockReturnValue({
      destroy: mocks.collabDestroy,
      doc,
      provider: boundary.provider,
    });
    mocks.createTldrawBinding.mockImplementationOnce(
      ({ onError }: { onError: () => void }) => {
        onError();
        return { destroy: mocks.bindingDestroy };
      },
    );
    render(<Whiteboard room={room} />);

    act(() => boundary.emit("synced", { state: true }));
    expect(await screen.findByTestId("tldraw-editor")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some shared drawing data could not be loaded.",
    );

    act(() => boundary.emit("status", { status: "connected" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some shared drawing data could not be loaded.",
    );
    doc.destroy();
  });

  it("keeps a fatal opening error nonempty after a connected event", () => {
    const boundary = providerBoundary();
    const doc = new Y.Doc();
    mocks.createRoomCollab.mockReturnValue({
      destroy: mocks.collabDestroy,
      doc,
      provider: boundary.provider,
    });
    mocks.createTldrawBinding.mockImplementationOnce(() => {
      throw new Error("binding failed");
    });
    render(<Whiteboard room={room} />);

    act(() => boundary.emit("synced", { state: true }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Shared canvas data could not be opened.",
    );
    expect(screen.queryByTestId("tldraw-editor")).not.toBeInTheDocument();

    act(() => boundary.emit("status", { status: "connected" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Shared canvas data could not be opened.",
    );
    expect(screen.getByRole("alert")).not.toBeEmptyDOMElement();
    doc.destroy();
  });

  it("uses the exact current participant ID when profiles are identical", () => {
    const boundary = providerBoundary();
    const doc = new Y.Doc();
    mocks.createRoomCollab.mockReturnValue({
      destroy: mocks.collabDestroy,
      doc,
      provider: boundary.provider,
    });
    render(
      <Whiteboard
        room={{
          ...room,
          isOwner: false,
          currentParticipantId: "participant-grace",
          participants: [
            { id: "participant-ada", name: "Ada", color: "#10A37F" },
            { id: "participant-grace", name: "Ada", color: "#10A37F" },
          ],
        }}
      />,
    );

    expect(mocks.usePresence).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          participantId: "participant-grace",
          name: "Ada",
        }),
      }),
    );
    doc.destroy();
  });

  it.each([
    ["missing", null],
    ["stale", "participant-missing"],
  ])(
    "keeps collaboration closed for a %s participant session",
    (_label, currentParticipantId) => {
      render(<Whiteboard room={{ ...room, currentParticipantId }} />);

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your room session is unavailable. Join the room again to collaborate.",
      );
      expect(mocks.createRoomCollab).not.toHaveBeenCalled();
      expect(mocks.usePresence).not.toHaveBeenCalled();
    },
  );
});

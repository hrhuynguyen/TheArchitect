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

  it("identifies the current participant from the persisted guest profile", () => {
    window.localStorage.setItem(
      "architect.guest-profile.v1",
      JSON.stringify({ name: "Grace", color: "#2563EB" }),
    );
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
          participants: [
            ...room.participants,
            { id: "participant-grace", name: "Grace", color: "#2563EB" },
          ],
        }}
      />,
    );

    expect(mocks.usePresence).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          participantId: "participant-grace",
          name: "Grace",
        }),
      }),
    );
    doc.destroy();
  });
});

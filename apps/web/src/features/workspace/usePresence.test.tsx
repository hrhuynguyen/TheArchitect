// @vitest-environment jsdom

import type { AwarenessIdentity } from "@architect/contracts";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { act, renderHook } from "@testing-library/react";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePresence } from "./usePresence.js";

type StatelessListener = (data: { payload: string }) => void;

function fakeProvider(roomId: string, awareness: Awareness) {
  const listeners = new Set<StatelessListener>();
  const provider = {
    awareness,
    configuration: { name: roomId },
    on(event: string, listener: StatelessListener) {
      if (event === "stateless") listeners.add(listener);
    },
    off(event: string, listener: StatelessListener) {
      if (event === "stateless") listeners.delete(listener);
    },
  } as unknown as HocuspocusProvider;
  return {
    emit(payload: string) {
      for (const listener of listeners) listener({ payload });
    },
    provider,
  };
}

const profile = {
  participantId: "participant-a",
  name: "Grace",
  color: "#ABCDEF",
  cursor: { x: 4, y: 8 },
  phase: "sketch" as const,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("usePresence", () => {
  it("publishes only transient motion and renders validated server snapshots", () => {
    vi.useFakeTimers();
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const awarenessTimerCount = vi.getTimerCount();
    const { emit, provider } = fakeProvider("room-a", awareness);
    const { result, unmount } = renderHook(() =>
      usePresence({ provider, heartbeatMs: 1_000, profile }),
    );

    expect(result.current).toEqual([]);
    expect(awareness.getLocalState()).toEqual({
      presence: { cursor: { x: 4, y: 8 }, phase: "sketch" },
    });

    const serverSnapshot = {
      type: "architect/presence",
      version: 1,
      roomId: "room-a",
      profiles: [
        {
          ...profile,
          lastSeenAt: "2026-07-21T12:00:00.000Z",
        },
      ],
    };
    act(() => emit(JSON.stringify(serverSnapshot)));
    expect(result.current).toEqual(serverSnapshot.profiles);

    act(() => {
      awareness.setLocalStateField("profile", {
        participantId: "participant-b",
        name: "Spoofed peer",
        color: "#000000",
        phase: "deploy",
        lastSeenAt: "2026-07-21T12:00:00.000Z",
      });
    });
    expect(result.current).toEqual(serverSnapshot.profiles);

    for (const malformed of [
      "not-json",
      JSON.stringify({ ...serverSnapshot, version: 2 }),
      JSON.stringify({ ...serverSnapshot, roomId: "room-b" }),
    ]) {
      act(() => emit(malformed));
      expect(result.current).toEqual(serverSnapshot.profiles);
    }

    act(() => vi.advanceTimersByTime(1_000));
    expect(awareness.getLocalState()).toMatchObject({
      presence: { cursor: { x: 4, y: 8 }, phase: "sketch" },
    });

    unmount();
    expect(awareness.getLocalState()).toBeNull();
    expect(vi.getTimerCount()).toBe(awarenessTimerCount);
    awareness.destroy();
    document.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps awareness alive while publishing a changing cursor", () => {
    vi.useFakeTimers();
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const { provider } = fakeProvider("room-a", awareness);
    const withoutCursor: AwarenessIdentity = {
      participantId: profile.participantId,
      name: profile.name,
      color: profile.color,
      phase: profile.phase,
    };
    const view = renderHook(
      ({ currentProfile }: { currentProfile: AwarenessIdentity }) =>
        usePresence({ provider, profile: currentProfile }),
      {
        initialProps: { currentProfile: withoutCursor },
      },
    );

    expect(awareness.getLocalState()).toEqual({
      presence: { phase: "sketch" },
    });
    view.rerender({ currentProfile: profile });
    expect(awareness.getLocalState()).toEqual({
      presence: { cursor: { x: 4, y: 8 }, phase: "sketch" },
    });

    view.unmount();
    awareness.destroy();
    document.destroy();
  });

  it.each([
    [{ ...profile, color: "not-a-color" }],
    [{ ...profile, unexpected: true }],
  ])("rejects an invalid awareness identity before installing effects", (invalidProfile) => {
    vi.useFakeTimers();
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const timerCount = vi.getTimerCount();
    const { provider } = fakeProvider("room-a", awareness);

    expect(() =>
      renderHook(() =>
        usePresence({ provider, profile: invalidProfile as typeof profile }),
      ),
    ).toThrow("Invalid awareness identity");
    expect(vi.getTimerCount()).toBe(timerCount);
    awareness.destroy();
    document.destroy();
  });

  it.each([0, Number.NaN, 60_001])(
    "rejects an invalid heartbeat interval %s before installing effects",
    (heartbeatMs) => {
      vi.useFakeTimers();
      const document = new Y.Doc();
      const awareness = new Awareness(document);
      const timerCount = vi.getTimerCount();
      const { provider } = fakeProvider("room-a", awareness);

      expect(() =>
        renderHook(() => usePresence({ provider, heartbeatMs, profile })),
      ).toThrow("Invalid presence heartbeat interval");
      expect(vi.getTimerCount()).toBe(timerCount);
      awareness.destroy();
      document.destroy();
    },
  );

  it.each([() => Number.NaN, () => Number.POSITIVE_INFINITY, () => 8.64e15 + 1])(
    "rejects an invalid presence clock before installing effects",
    (now) => {
      vi.useFakeTimers();
      const document = new Y.Doc();
      const awareness = new Awareness(document);
      const timerCount = vi.getTimerCount();
      const { provider } = fakeProvider("room-a", awareness);

      expect(() =>
        renderHook(() => usePresence({ provider, now, profile })),
      ).toThrow("Invalid presence clock");
      expect(vi.getTimerCount()).toBe(timerCount);
      awareness.destroy();
      document.destroy();
    },
  );
});

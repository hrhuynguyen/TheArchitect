// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePresence } from "./usePresence.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("usePresence", () => {
  it("publishes a validated profile, heartbeats, and removes it on cleanup", () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-07-21T12:00:00.000Z");
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const awarenessTimerCount = vi.getTimerCount();
    const { result, unmount } = renderHook(() =>
      usePresence({
        awareness,
        heartbeatMs: 1_000,
        now: () => now,
        profile: {
          participantId: "participant-a",
          name: "Grace",
          color: "#ABCDEF",
          cursor: { x: 4, y: 8 },
          phase: "sketch",
        },
      }),
    );

    expect(result.current).toEqual([
      {
        participantId: "participant-a",
        name: "Grace",
        color: "#ABCDEF",
        cursor: { x: 4, y: 8 },
        phase: "sketch",
        lastSeenAt: "2026-07-21T12:00:00.000Z",
      },
    ]);

    now += 1_000;
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current[0]?.lastSeenAt).toBe("2026-07-21T12:00:01.000Z");

    unmount();
    expect(awareness.getLocalState()).toBeNull();
    expect(vi.getTimerCount()).toBe(awarenessTimerCount);
    awareness.destroy();
    document.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

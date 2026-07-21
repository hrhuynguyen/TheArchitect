import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoundedCursorPublisher } from "./cursorPublisher.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createBoundedCursorPublisher", () => {
  it("publishes only meaningful movement at a bounded cadence", () => {
    vi.useFakeTimers();
    const onPublish = vi.fn();
    const publisher = createBoundedCursorPublisher({
      intervalMs: 50,
      onPublish,
    });

    publisher.move({ x: 10, y: 10 });
    publisher.move({ x: 11, y: 11 });
    publisher.move({ x: 24, y: 30 });
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish).toHaveBeenLastCalledWith({ x: 10, y: 10 });

    vi.advanceTimersByTime(49);
    expect(onPublish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onPublish).toHaveBeenLastCalledWith({ x: 24, y: 30 });

    publisher.move({ x: 24, y: 30 });
    vi.advanceTimersByTime(50);
    expect(onPublish).toHaveBeenCalledTimes(2);

    publisher.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a queued movement on destroy", () => {
    vi.useFakeTimers();
    const onPublish = vi.fn();
    const publisher = createBoundedCursorPublisher({ intervalMs: 50, onPublish });
    publisher.move({ x: 1, y: 1 });
    publisher.move({ x: 20, y: 20 });

    publisher.destroy();
    vi.runAllTimers();

    expect(onPublish).toHaveBeenCalledOnce();
  });
});

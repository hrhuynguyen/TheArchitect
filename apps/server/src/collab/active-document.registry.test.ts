import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import { createActiveDocumentRegistry } from "./active-document.registry.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("active document registry", () => {
  it("hands an overlapping durable mutation to the first live document without losing shared state", async () => {
    const fallback = new Y.Doc();
    fallback.getMap("drawing").set("shape-a", { type: "box" });
    fallback.getMap("requirements").set("current", { audience: "external" });
    const mutationStarted = deferred();
    const releaseMutation = deferred();
    const registry = createActiveDocumentRegistry({
      loadRoomDocument: vi.fn().mockResolvedValue(fallback),
    });

    const mutation = registry.withDocument("room-a", async (document) => {
      document.getMap("drawing").set("shape-b", { type: "queue" });
      document.getMap("requirements").set("current", { audience: "internal" });
      document.getMap("architect:server:votes:v1").set("ready", {
        tally: 1,
      });
      mutationStarted.resolve();
      await releaseMutation.promise;
    });
    await mutationStarted.promise;

    const live = new Y.Doc();
    live.getMap("drawing").set("shape-a", { type: "box" });
    const activation = registry.activate("room-a", live);
    expect(registry.active("room-a")).toBeNull();

    releaseMutation.resolve();
    await mutation;
    const deactivate = await activation;

    expect(live.getMap("drawing").toJSON()).toEqual({
      "shape-a": { type: "box" },
      "shape-b": { type: "queue" },
    });
    expect(live.getMap("requirements").get("current")).toEqual({
      audience: "internal",
    });
    expect(live.getMap("architect:server:votes:v1").get("ready")).toEqual({
      tally: 1,
    });
    expect(fallback.isDestroyed).toBe(true);
    expect(registry.active("room-a")).toBe(live);

    await deactivate();
    expect(registry.active("room-a")).toBeNull();
    await registry.destroy();
    live.destroy();
  });

  it("destroys an inactive fallback on success and error without destroying a live document", async () => {
    const loaded: Y.Doc[] = [];
    const registry = createActiveDocumentRegistry({
      async loadRoomDocument() {
        const document = new Y.Doc();
        loaded.push(document);
        return document;
      },
    });

    await registry.withDocument("room-success", async (document) => {
      document.getMap("meta").set("phase", "sketch");
    });
    await expect(
      registry.withDocument("room-error", async () => {
        throw new Error("mutation failed");
      }),
    ).rejects.toThrow("mutation failed");
    expect(loaded.map((document) => document.isDestroyed)).toEqual([true, true]);

    const live = new Y.Doc();
    const deactivate = await registry.activate("room-live", live);
    await expect(
      registry.withDocument("room-live", async (document) => {
        expect(document).toBe(live);
        throw new Error("live mutation failed");
      }),
    ).rejects.toThrow("live mutation failed");
    expect(live.isDestroyed).toBe(false);

    await deactivate();
    await deactivate();
    await registry.destroy();
    await registry.destroy();
    expect(live.isDestroyed).toBe(false);
    live.destroy();
  });

  it("hands outgoing live state to the next fallback document", async () => {
    let persisted: Uint8Array | undefined;
    const registry = createActiveDocumentRegistry({
      async loadRoomDocument() {
        return new Y.Doc();
      },
    });
    const live = new Y.Doc();
    live.getMap("drawing").set("shape-a", { type: "queue" });
    live.getMap("requirements").set("current", { traffic: "moderate" });
    const deactivate = await registry.activate("room-live", live);

    await deactivate();
    await registry.withDocument("room-live", async (fallback) => {
      expect(fallback.getMap("drawing").get("shape-a")).toEqual({
        type: "queue",
      });
      expect(fallback.getMap("requirements").get("current")).toEqual({
        traffic: "moderate",
      });
      fallback.getMap("architect:server:votes:v1").set("ready", {
        met: false,
        tally: 1,
      });
      persisted = Y.encodeStateAsUpdate(fallback);
    });

    const restored = new Y.Doc();
    Y.applyUpdate(restored, persisted!);
    expect(restored.getMap("drawing").get("shape-a")).toEqual({ type: "queue" });
    expect(restored.getMap("requirements").get("current")).toEqual({
      traffic: "moderate",
    });
    expect(restored.getMap("architect:server:votes:v1").get("ready")).toEqual({
      met: false,
      tally: 1,
    });

    await registry.destroy();
    restored.destroy();
    live.destroy();
  });

  it("keeps an initializing document private until activation succeeds", async () => {
    const registry = createActiveDocumentRegistry({
      async loadRoomDocument() {
        return new Y.Doc();
      },
    });
    const live = new Y.Doc();
    const releaseInitialization = deferred();
    let initializerCalled = false;

    const activation = registry.activate("room-live", live, async () => {
      initializerCalled = true;
      await releaseInitialization.promise;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(initializerCalled).toBe(true);
    expect(registry.active("room-live")).toBeNull();

    releaseInitialization.resolve();
    const deactivate = await activation;
    expect(registry.active("room-live")).toBe(live);

    await deactivate();
    await registry.destroy();
    live.destroy();
  });

  it("preserves a queued handoff when activation initialization fails", async () => {
    const registry = createActiveDocumentRegistry({
      async loadRoomDocument() {
        return new Y.Doc();
      },
    });
    await registry.withDocument("room-live", async (fallback) => {
      fallback.getMap("meta").set("phase", "reconstructing");
    });
    const rejected = new Y.Doc();

    await expect(
      registry.activate("room-live", rejected, async (document) => {
        expect(document.getMap("meta").get("phase")).toBe("reconstructing");
        throw new Error("membership revoked");
      }),
    ).rejects.toThrow("membership revoked");
    expect(registry.active("room-live")).toBeNull();

    const replacement = new Y.Doc();
    const deactivate = await registry.activate("room-live", replacement);
    expect(replacement.getMap("meta").get("phase")).toBe("reconstructing");

    await deactivate();
    await registry.destroy();
    rejected.destroy();
    replacement.destroy();
  });
});

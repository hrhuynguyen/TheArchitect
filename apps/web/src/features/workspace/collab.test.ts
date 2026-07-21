import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRoomCollab,
  resolveCollaborationUrl,
} from "./collab.js";

vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: vi.fn(
    class FakeHocuspocusProvider {
      destroy = vi.fn();
      constructor(readonly configuration: Record<string, unknown>) {}
    },
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveCollaborationUrl", () => {
  it("prefers the configured public WebSocket origin", () => {
    expect(
      resolveCollaborationUrl({
        configuredUrl: "wss://collab.example.com/socket",
        location: { host: "app.example.com", protocol: "https:" },
      }),
    ).toBe("wss://collab.example.com/socket");
  });

  it("derives a same-origin WebSocket URL without embedding credentials", () => {
    expect(
      resolveCollaborationUrl({
        configuredUrl: "",
        location: { host: "app.example.com", protocol: "https:" },
      }),
    ).toBe("wss://app.example.com");
  });

  it.each([
    "https://collab.example.com",
    "wss://user:secret@collab.example.com",
  ])("rejects an unsafe configured origin %s", (configuredUrl) => {
    expect(() =>
      resolveCollaborationUrl({
        configuredUrl,
        location: { host: "app.example.com", protocol: "https:" },
      }),
    ).toThrow("WebSocket URL");
  });
});

describe("createRoomCollab", () => {
  it("uses the exact room name in protocol data and does not put it or secrets in the URL", () => {
    const roomId = "room/a?token=not-a-url-secret";
    const collaboration = createRoomCollab({
      roomId,
      webSocketUrl: "wss://collab.example.com/socket",
    });
    const configuration = vi.mocked(HocuspocusProvider).mock.calls[0]![0];

    expect(collaboration.doc).toBeInstanceOf(Y.Doc);
    expect(configuration).toMatchObject({
      document: collaboration.doc,
      name: roomId,
      url: "wss://collab.example.com/socket",
    });
    expect(configuration).not.toHaveProperty("token");
  });

  it("destroys provider and document exactly once", () => {
    const collaboration = createRoomCollab({
      roomId: "room-a",
      webSocketUrl: "ws://localhost:3002",
    });
    const providerDestroy = vi.mocked(collaboration.provider.destroy);
    const documentDestroy = vi.spyOn(collaboration.doc, "destroy");

    collaboration.destroy();
    collaboration.destroy();

    expect(providerDestroy).toHaveBeenCalledOnce();
    expect(documentDestroy).toHaveBeenCalledOnce();
  });
});

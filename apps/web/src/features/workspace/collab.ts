"use client";

import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

type LocationLike = {
  host: string;
  protocol: string;
};

type ResolveCollaborationUrlOptions = {
  configuredUrl?: string;
  location?: LocationLike;
};

export function resolveCollaborationUrl(
  options: ResolveCollaborationUrlOptions = {},
): string {
  const configuredUrl =
    options.configuredUrl ?? process.env.NEXT_PUBLIC_WS_URL ?? "";
  if (configuredUrl.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(configuredUrl);
    } catch {
      throw new Error("Invalid public WebSocket URL");
    }
    if (
      (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("Invalid public WebSocket URL");
    }
    return parsed.toString().replace(/\/$/, "");
  }

  const browserLocation =
    options.location ??
    (typeof window === "undefined"
      ? undefined
      : { host: window.location.host, protocol: window.location.protocol });
  if (!browserLocation?.host) {
    throw new Error("A public WebSocket URL is required outside the browser");
  }
  if (
    browserLocation.protocol !== "http:" &&
    browserLocation.protocol !== "https:"
  ) {
    throw new Error("Unable to derive a public WebSocket URL");
  }
  const protocol = browserLocation.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${browserLocation.host}`;
}

type CreateRoomCollabOptions = {
  roomId: string;
  webSocketUrl?: string;
};

export function createRoomCollab({
  roomId,
  webSocketUrl,
}: CreateRoomCollabOptions) {
  if (!roomId) throw new Error("A room ID is required for collaboration");
  if (webSocketUrl !== undefined && !webSocketUrl.trim()) {
    throw new Error("Invalid public WebSocket URL");
  }
  const resolvedWebSocketUrl =
    webSocketUrl === undefined
      ? resolveCollaborationUrl()
      : resolveCollaborationUrl({ configuredUrl: webSocketUrl });
  const doc = new Y.Doc();
  let provider: HocuspocusProvider;
  try {
    provider = new HocuspocusProvider({
      document: doc,
      name: roomId,
      url: resolvedWebSocketUrl,
    });
  } catch (error) {
    doc.destroy();
    throw error;
  }
  let destroyed = false;

  return {
    doc,
    provider,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        provider.destroy();
      } finally {
        doc.destroy();
      }
    },
  };
}

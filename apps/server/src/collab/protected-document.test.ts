import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  READINESS_THRESHOLD,
  SERVER_VOTES_MAP_KEY,
} from "@architect/contracts";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { assertClientDocumentUpdateAllowed } from "./protected-document.js";

const canonicalVote = {
  tally: 1,
  total: 2,
  ratio: 0.5,
  met: false,
  threshold: READINESS_THRESHOLD,
  voterIds: ["participant-a"],
};

function clientBasedOn(server: Y.Doc) {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  return client;
}

describe("protected server document state", () => {
  it("rejects a mixed legitimate shape and forged vote update atomically", () => {
    const server = new Y.Doc();
    server.getMap(SERVER_VOTES_MAP_KEY).set("ready", canonicalVote);
    const before = Y.encodeStateVector(server);
    const client = clientBasedOn(server);
    client.transact(() => {
      client.getMap("drawing").set("shape-forged-batch", { type: "database" });
      client.getMap(SERVER_VOTES_MAP_KEY).set("ready", {
        ...canonicalVote,
        tally: 2,
        ratio: 1,
        met: true,
        voterIds: ["participant-a", "participant-b"],
      });
    });
    const update = Y.encodeStateAsUpdate(client, before);

    expect(() => assertClientDocumentUpdateAllowed(server, update)).toThrow(
      "Server-owned document state cannot be changed by clients",
    );
    expect(server.getMap("drawing").has("shape-forged-batch")).toBe(false);
    expect(server.getMap(SERVER_VOTES_MAP_KEY).get("ready")).toEqual(
      canonicalVote,
    );

    client.destroy();
    server.destroy();
  });

  it("accepts ordinary shared drawing updates without mutating during preflight", () => {
    const server = new Y.Doc();
    server.getMap(SERVER_VOTES_MAP_KEY).set("ready", canonicalVote);
    const before = Y.encodeStateVector(server);
    const client = clientBasedOn(server);
    client.getMap("drawing").set("shape-a", { type: "queue" });
    const update = Y.encodeStateAsUpdate(client, before);

    expect(() => assertClientDocumentUpdateAllowed(server, update)).not.toThrow();
    expect(server.getMap("drawing").has("shape-a")).toBe(false);
    expect(server.getMap(SERVER_VOTES_MAP_KEY).get("ready")).toEqual(
      canonicalVote,
    );

    client.destroy();
    server.destroy();
  });

  it("rejects a raw CRDT type substitution even when toJSON is identical", () => {
    const server = new Y.Doc();
    server.getMap(SERVER_VOTES_MAP_KEY).set("ready", canonicalVote);
    const before = Y.encodeStateVector(server);
    const client = clientBasedOn(server);
    const nested = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(canonicalVote)) {
      nested.set(key, value);
    }
    client.getMap(SERVER_VOTES_MAP_KEY).set("ready", nested);
    const update = Y.encodeStateAsUpdate(client, before);

    expect(client.getMap(SERVER_VOTES_MAP_KEY).toJSON()).toEqual(
      server.getMap(SERVER_VOTES_MAP_KEY).toJSON(),
    );
    expect(() => assertClientDocumentUpdateAllowed(server, update)).toThrow(
      "Server-owned document state cannot be changed by clients",
    );

    client.destroy();
    server.destroy();
  });

  it("rejects a client-authored durable phase without blocking other meta keys", () => {
    const server = new Y.Doc();
    server.getMap("meta").set("phase", "sketch");
    const before = Y.encodeStateVector(server);
    const client = clientBasedOn(server);
    client.getMap("meta").set("phase", "architect");
    const forgedPhase = Y.encodeStateAsUpdate(client, before);

    expect(() =>
      assertClientDocumentUpdateAllowed(server, forgedPhase),
    ).toThrow("Server-owned document state cannot be changed by clients");

    const ordinaryClient = clientBasedOn(server);
    ordinaryClient.getMap("meta").set("viewport", { x: 1, y: 2 });
    const ordinaryMeta = Y.encodeStateAsUpdate(
      ordinaryClient,
      Y.encodeStateVector(server),
    );
    expect(() =>
      assertClientDocumentUpdateAllowed(server, ordinaryMeta),
    ).not.toThrow();

    ordinaryClient.destroy();
    client.destroy();
    server.destroy();
  });

  it("rejects client overwrites of canonical architecture and layout", () => {
    const server = new Y.Doc();
    server.getMap(ARCHITECTURE_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
      revisionId: "revision-server",
      version: "working-architecture/v1",
    });
    server.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
      revisionId: "revision-server",
      version: "architecture-layout/v1",
      nodes: [],
    });
    const before = Y.encodeStateVector(server);
    const client = clientBasedOn(server);
    client.transact(() => {
      client.getMap(ARCHITECTURE_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
        revisionId: "revision-forged",
        version: "working-architecture/v1",
      });
      client.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
        revisionId: "revision-forged",
        version: "architecture-layout/v1",
        nodes: [{ resourceId: "forged", x: 0, y: 0 }],
      });
    });
    const forged = Y.encodeStateAsUpdate(client, before);

    expect(() => assertClientDocumentUpdateAllowed(server, forged)).toThrow(
      "Server-owned document state cannot be changed by clients",
    );

    client.destroy();
    server.destroy();
  });

  it("rejects requirement changes while reconstruction is in progress", () => {
    const server = new Y.Doc();
    server.getMap("meta").set("phase", "reconstructing");
    server.getMap("requirements").set("current", { traffic: "high" });
    const before = Y.encodeStateVector(server);
    const client = clientBasedOn(server);
    client.getMap("requirements").set("current", { traffic: "extreme" });
    const forged = Y.encodeStateAsUpdate(client, before);

    expect(() => assertClientDocumentUpdateAllowed(server, forged)).toThrow(
      "Server-owned document state cannot be changed by clients",
    );

    client.destroy();
    server.destroy();
  });

  it("allows shared requirement changes during the sketch phase", () => {
    const server = new Y.Doc();
    server.getMap("meta").set("phase", "sketch");
    server.getMap("requirements").set("current", { traffic: "high" });
    const before = Y.encodeStateVector(server);
    const client = clientBasedOn(server);
    client.getMap("requirements").set("current", { traffic: "extreme" });
    const ordinary = Y.encodeStateAsUpdate(client, before);

    expect(() => assertClientDocumentUpdateAllowed(server, ordinary)).not.toThrow();

    client.destroy();
    server.destroy();
  });
});

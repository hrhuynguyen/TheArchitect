import {
  SERVER_VOTES_MAP_KEY,
  defaultRequirementsProfile,
} from "@architect/contracts";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { createActiveDocumentRegistry } from "../collab/active-document.registry.js";
import { createReconstructionPublisher } from "./reconstruction.publisher.js";

const requirements = defaultRequirementsProfile();
const architecture = {
  version: "architecture/v1" as const,
  requirements,
  resources: [{
    id: "bucket",
    type: "S3" as const,
    name: "Uploads",
    properties: {},
    origin: "explicit" as const,
    reason: "The source explicitly includes an object store.",
    approvalStatus: "not-required" as const,
  }],
  relationships: [],
  decisions: [],
  unresolvedQuestions: [],
};
const layout = {
  version: "architecture-layout/v1" as const,
  revisionId: "revision-a",
  nodes: [{ resourceId: "bucket", x: 0, y: 0 }],
};

async function setup(options: { persistFailure?: Error; publishFailure?: Error } = {}) {
  const live = new Y.Doc();
  live.getMap("tldraw").set("shape-a", { type: "geo", text: "bucket" });
  live.getMap("requirements").set("current", requirements);
  live.getMap(SERVER_VOTES_MAP_KEY).set("ready", {
    met: true,
    voterIds: ["participant-a"],
  });
  live.getMap("meta").set("phase", "reconstructing");
  const original = Y.encodeStateAsUpdate(live);
  const events: string[] = [];
  const persisted: Uint8Array[] = [];
  const documents = createActiveDocumentRegistry({ async loadRoomDocument() { return new Y.Doc(); } });
  const deactivate = await documents.activate("room-a", live);
  const publisher = createReconstructionPublisher({
    documents,
    async persistRoomSnapshot(_roomId, document, reason) {
      events.push(`persist:${reason}`);
      if (options.persistFailure) throw options.persistFailure;
      persisted.push(Y.encodeStateAsUpdate(document));
      return persisted.length;
    },
    applyUpdate(document, update, origin) {
      if (options.publishFailure) throw options.publishFailure;
      events.push("publish");
      Y.applyUpdate(document, update, origin);
    },
  });
  return {
    documents,
    events,
    live,
    original,
    persisted,
    publisher,
    async stop() {
      await deactivate();
      await documents.destroy();
      live.destroy();
    },
  };
}

describe("reconstruction Yjs publisher", () => {
  it("persists a cloned architecture before publishing its delta", async () => {
    const test = await setup();
    try {
      await test.publisher.publishArchitecture({
        roomId: "room-a",
        revisionId: "revision-a",
        architecture,
        layout,
      });

      expect(test.events).toEqual(["persist:reconstruction_architecture", "publish"]);
      expect(test.live.getMap("tldraw").get("shape-a")).toEqual({
        type: "geo",
        text: "bucket",
      });
      expect(test.live.getMap("requirements").get("current")).toEqual(requirements);
      expect(test.live.getMap(SERVER_VOTES_MAP_KEY).has("ready")).toBe(true);
      expect(test.live.getMap("architecture").get("current")).toMatchObject({
        version: "working-architecture/v1",
        revisionId: "revision-a",
        architecture,
      });
      expect(test.live.getMap("architecture-layout").get("current")).toEqual(layout);
    } finally {
      await test.stop();
    }
  });

  it.each(["persist", "publish"] as const)(
    "leaves the live document unchanged when %s fails",
    async (failurePoint) => {
      const test = await setup(
        failurePoint === "persist"
          ? { persistFailure: new Error("snapshot unavailable") }
          : { publishFailure: new Error("publication unavailable") },
      );
      try {
        await expect(test.publisher.publishArchitecture({
          roomId: "room-a",
          revisionId: "revision-a",
          architecture,
          layout,
        })).rejects.toThrow();
        const expected = new Y.Doc();
        const actual = new Y.Doc();
        try {
          Y.applyUpdate(expected, test.original);
          Y.applyUpdate(actual, Y.encodeStateAsUpdate(test.live));
          expect(actual.toJSON()).toEqual(expected.toJSON());
        } finally {
          expected.destroy();
          actual.destroy();
        }
      } finally {
        await test.stop();
      }
    },
  );

  it("deletes only old readiness and mirrors sketch before durable cleanup", async () => {
    const test = await setup();
    try {
      test.live.getMap(SERVER_VOTES_MAP_KEY).set("deploy_aws", { met: false });
      await test.publisher.publishFailureCleanup({ roomId: "room-a" });
      expect(test.events).toEqual(["persist:reconstruction_failure_cleanup", "publish"]);
      expect(test.live.getMap(SERVER_VOTES_MAP_KEY).has("ready")).toBe(false);
      expect(test.live.getMap(SERVER_VOTES_MAP_KEY).get("deploy_aws")).toEqual({
        met: false,
      });
      expect(test.live.getMap("meta").get("phase")).toBe("sketch");
      expect(test.live.getMap("tldraw").get("shape-a")).toBeDefined();
      expect(test.live.getMap("requirements").get("current")).toEqual(requirements);
    } finally {
      await test.stop();
    }
  });

  it("mirrors architect phase through clone-persist-publish ordering", async () => {
    const test = await setup();
    try {
      await test.publisher.publishArchitectPhase({ roomId: "room-a" });
      expect(test.events).toEqual(["persist:reconstruction_phase_mirror", "publish"]);
      expect(test.live.getMap("meta").get("phase")).toBe("architect");
    } finally {
      await test.stop();
    }
  });
});

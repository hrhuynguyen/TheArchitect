import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  ReconstructionYjsStateSchema,
  defaultRequirementsProfile,
} from "@architect/contracts";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";

import { createActiveDocumentRegistry } from "../collab/active-document.registry.js";
import {
  ArchitectureServiceError,
  createRevisionService,
} from "./revision.service.js";

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
    reason: "The design explicitly includes object storage.",
    approvalStatus: "not-required" as const,
  }],
  relationships: [],
  decisions: [],
  unresolvedQuestions: [],
};
const initialState = {
  architecture: {
    version: "working-architecture/v1" as const,
    revisionId: "revision-a",
    architecture,
  },
  layout: {
    version: "architecture-layout/v1" as const,
    revisionId: "revision-a",
    nodes: [{ resourceId: "bucket", x: 0, y: 0 }],
  },
};
const addQueue = {
  type: "add_resource" as const,
  resource: {
    id: "queue",
    type: "SQS" as const,
    name: "Queue",
    properties: {},
    origin: "explicit" as const,
    reason: "Added manually.",
    approvalStatus: "not-required" as const,
  },
};

async function setup(options: {
  persistFailure?: Error;
  applyFailure?: Error;
  commitResult?: { kind: "stale"; currentRevisionId: string | null };
} = {}) {
  const live = new Y.Doc();
  live.getMap(ARCHITECTURE_MAP_KEY).set(
    ARCHITECTURE_CURRENT_KEY,
    initialState.architecture,
  );
  live.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(
    ARCHITECTURE_CURRENT_KEY,
    initialState.layout,
  );
  const original = Y.encodeStateAsUpdate(live);
  const documents = createActiveDocumentRegistry({
    async loadRoomDocument() { return new Y.Doc(); },
  });
  const deactivate = await documents.activate("room-a", live);
  const events: string[] = [];
  const persisted: Uint8Array[] = [];
  const revision = {
    id: "revision-b",
    roomId: "room-a",
    version: 2,
    architecture,
    layout: { ...initialState.layout, revisionId: "revision-b" },
    requirements,
    stage: "prototype" as const,
    authorType: "participant" as const,
    authorId: "participant-a",
    rationale: "Capture the accepted graph.",
    createdAt: "2026-07-21T12:00:00.000Z",
  };
  const event = {
    id: "event-b",
    roomId: "room-a",
    kind: "architecture_revision_saved",
    status: "succeeded" as const,
    actorType: "participant" as const,
    actorId: "participant-a",
    title: "Architecture revision saved",
    summary: "Capture the accepted graph.",
    details: {
      revisionId: "revision-b",
      baseRevisionId: "revision-a",
      version: 2,
    },
    traceId: "request-7",
    createdAt: "2026-07-21T12:00:00.000Z",
  };
  const repository = {
    commitRevision: vi.fn(async (input: any) => {
      events.push("commit");
      if (options.commitResult) return options.commitResult;
      const snapshot = new Y.Doc();
      try {
        Y.applyUpdate(snapshot, input.snapshotPayload);
        expect(ReconstructionYjsStateSchema.parse({
          architecture: snapshot
            .getMap(ARCHITECTURE_MAP_KEY)
            .get(ARCHITECTURE_CURRENT_KEY),
          layout: snapshot
            .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
            .get(ARCHITECTURE_CURRENT_KEY),
        })).toMatchObject({
          architecture: { revisionId: "revision-b" },
          layout: { revisionId: "revision-b" },
        });
      } finally {
        snapshot.destroy();
      }
      return { kind: "committed" as const, revision, event };
    }),
    listHistory: vi.fn(async () => ({ revisions: [revision], events: [event] })),
  };
  let id = 0;
  const service = createRevisionService({
    documents,
    repository,
    createId: () => ["revision-b", "event-b"][id++] ?? `id-${id}`,
    async persistRoomSnapshot(_roomId, candidate, reason) {
      events.push(`persist:${reason}`);
      if (options.persistFailure) throw options.persistFailure;
      persisted.push(Y.encodeStateAsUpdate(candidate));
      return persisted.length;
    },
    applyUpdate(document, update, origin) {
      if (options.applyFailure) throw options.applyFailure;
      events.push(`publish:${String(origin)}`);
      Y.applyUpdate(document, update, origin);
    },
  });
  return {
    documents,
    events,
    live,
    original,
    persisted,
    repository,
    service,
    async stop() {
      await deactivate();
      await documents.destroy();
      live.destroy();
    },
  };
}

function liveState(document: Y.Doc) {
  return ReconstructionYjsStateSchema.parse({
    architecture: document
      .getMap(ARCHITECTURE_MAP_KEY)
      .get(ARCHITECTURE_CURRENT_KEY),
    layout: document
      .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
      .get(ARCHITECTURE_CURRENT_KEY),
  });
}

describe("revision service", () => {
  it("applies an atomic batch and optional validated layout via persist-before-publish", async () => {
    const test = await setup();
    try {
      const result = await test.service.applyOperations({
        roomId: "room-a",
        request: {
          baseRevisionId: "revision-a",
          operations: [addQueue],
          layout: {
            version: "architecture-layout/v1",
            revisionId: "revision-a",
            nodes: [
              { resourceId: "bucket", x: 10, y: 20 },
              { resourceId: "queue", x: 30, y: 40 },
            ],
          },
        },
      });

      expect(result.ok).toBe(true);
      expect(result.state.architecture.architecture.resources).toHaveLength(2);
      expect(test.events).toEqual([
        "persist:architecture_operations",
        "publish:architect/server-operations",
      ]);
      expect(liveState(test.live)).toEqual(result.state);
    } finally {
      await test.stop();
    }
  });

  it("returns diagnostics without persisting any part of a failed batch", async () => {
    const test = await setup();
    try {
      const result = await test.service.applyOperations({
        roomId: "room-a",
        request: {
          baseRevisionId: "revision-a",
          operations: [addQueue, addQueue],
        },
      });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [{ code: "OPERATION_DUPLICATE_RESOURCE" }],
      });
      expect(test.events).toEqual([]);
      expect(liveState(test.live)).toEqual(initialState);
    } finally {
      await test.stop();
    }
  });

  it("rejects stale bases and dangling layout nodes without persistence", async () => {
    const test = await setup();
    try {
      await expect(test.service.applyOperations({
        roomId: "room-a",
        request: { baseRevisionId: "revision-old", operations: [addQueue] },
      })).rejects.toMatchObject({ code: "STALE_REVISION" });
      await expect(test.service.applyOperations({
        roomId: "room-a",
        request: {
          baseRevisionId: "revision-a",
          operations: [addQueue],
          layout: {
            version: "architecture-layout/v1",
            revisionId: "revision-a",
            nodes: [{ resourceId: "missing", x: 0, y: 0 }],
          },
        },
      })).rejects.toMatchObject({ code: "INVALID_LAYOUT" });
      expect(test.events).toEqual([]);
    } finally {
      await test.stop();
    }
  });

  it("leaves the live document unchanged when operation persistence fails", async () => {
    const test = await setup({ persistFailure: new Error("snapshot unavailable") });
    try {
      await expect(test.service.applyOperations({
        roomId: "room-a",
        request: { baseRevisionId: "revision-a", operations: [addQueue] },
      })).rejects.toThrow("snapshot unavailable");
      const actual = new Y.Doc();
      const expected = new Y.Doc();
      try {
        Y.applyUpdate(actual, Y.encodeStateAsUpdate(test.live));
        Y.applyUpdate(expected, test.original);
        expect(actual.toJSON()).toEqual(expected.toJSON());
      } finally {
        actual.destroy();
        expected.destroy();
      }
    } finally {
      await test.stop();
    }
  });

  it("commits the rebased snapshot before publishing a saved revision", async () => {
    const test = await setup();
    try {
      const result = await test.service.saveRevision({
        roomId: "room-a",
        participantId: "participant-a",
        traceId: "request-7",
        request: {
          baseRevisionId: "revision-a",
          rationale: "Capture the accepted graph.",
        },
      });

      expect(result).toMatchObject({ revision: { id: "revision-b" } });
      expect(test.events).toEqual([
        "commit",
        "publish:architect/server-revision",
      ]);
      expect(liveState(test.live)).toMatchObject({
        architecture: { revisionId: "revision-b" },
        layout: { revisionId: "revision-b" },
      });
    } finally {
      await test.stop();
    }
  });

  it("does not publish a revision on transaction conflict", async () => {
    const test = await setup({
      commitResult: { kind: "stale", currentRevisionId: "revision-newer" },
    });
    try {
      await expect(test.service.saveRevision({
        roomId: "room-a",
        participantId: "participant-a",
        traceId: "request-7",
        request: {
          baseRevisionId: "revision-a",
          rationale: "Capture the accepted graph.",
        },
      })).rejects.toEqual(new ArchitectureServiceError(
        "STALE_REVISION",
        "revision-newer",
      ));
      expect(test.events).toEqual(["commit"]);
      expect(liveState(test.live)).toEqual(initialState);
    } finally {
      await test.stop();
    }
  });

  it("keeps a durable rebased snapshot recoverable if live publication fails", async () => {
    const test = await setup({ applyFailure: new Error("live unavailable") });
    try {
      await expect(test.service.saveRevision({
        roomId: "room-a",
        participantId: "participant-a",
        traceId: "request-7",
        request: {
          baseRevisionId: "revision-a",
          rationale: "Capture the accepted graph.",
        },
      })).rejects.toThrow("live unavailable");
      expect(test.repository.commitRevision).toHaveBeenCalledOnce();
      expect(liveState(test.live)).toEqual(initialState);
    } finally {
      await test.stop();
    }
  });

  it("returns immutable revision and event history", async () => {
    const test = await setup();
    try {
      await expect(test.service.listHistory("room-a")).resolves.toMatchObject({
        revisions: [{ id: "revision-b" }],
        events: [{ id: "event-b" }],
      });
    } finally {
      await test.stop();
    }
  });
});

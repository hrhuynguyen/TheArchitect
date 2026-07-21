import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  ReconstructionYjsStateSchema,
  defaultRequirementsProfile,
  type Architecture,
  type ArchitectureLayout,
} from "@architect/contracts";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { participantCookieName } from "../auth/cookies.js";
import { signParticipant } from "../auth/participant.js";
import { createActiveDocumentRegistry } from "../collab/active-document.registry.js";
import { assertClientDocumentUpdateAllowed } from "../collab/protected-document.js";
import { createSnapshotService } from "../collab/snapshot.service.js";
import type { SnapshotDatabase } from "../collab/yjs.repository.js";
import { registerArchitectureRoutes } from "./architecture.routes.js";
import { createRevisionRepository } from "./revision.repository.js";
import { createRevisionService } from "./revision.service.js";

const integrationRequested =
  process.env.RUN_ARCHITECTURE_DATABASE_TESTS === "true";
const testDatabaseUrl = process.env.ARCHITECTURE_TEST_DATABASE_URL;

if (integrationRequested && !testDatabaseUrl) {
  throw new Error(
    "ARCHITECTURE_TEST_DATABASE_URL is required when RUN_ARCHITECTURE_DATABASE_TESTS=true",
  );
}

const databaseDescribe =
  integrationRequested && testDatabaseUrl ? describe : describe.skip;
const COOKIE_SECRET = "architecture-integration-cookie-secret-32-bytes";
const OWNER_PEPPER = "architecture-integration-owner-pepper-32-bytes";
const requirements = defaultRequirementsProfile();

function cookie(roomId: string, participantId: string) {
  return `${participantCookieName(roomId)}=${encodeURIComponent(signParticipant({
    roomId,
    participantId,
  }, COOKIE_SECRET))}`;
}

function cloneDocument(document: Y.Doc) {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(document));
  return clone;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function readState(document: Y.Doc) {
  return ReconstructionYjsStateSchema.parse({
    architecture: document
      .getMap(ARCHITECTURE_MAP_KEY)
      .get(ARCHITECTURE_CURRENT_KEY),
    layout: document
      .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
      .get(ARCHITECTURE_CURRENT_KEY),
  });
}

databaseDescribe("Prisma architecture editing boundaries", () => {
  let database: typeof import("../db/client.js").prisma;
  let createYjsRepository:
    typeof import("../collab/yjs.repository.js").createYjsRepository;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl!;
    [{ prisma: database }, { createYjsRepository }] = await Promise.all([
      import("../db/client.js"),
      import("../collab/yjs.repository.js"),
    ]);
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it("synchronizes two authenticated clients and recovers an immutable revision after restart", async () => {
    const baseRevisionId = randomUUID();
    const participantA = randomUUID();
    const participantB = randomUUID();
    const architecture: Architecture = {
      version: "architecture/v1",
      requirements,
      resources: [
        {
          id: "bucket",
          type: "S3",
          name: "Uploads",
          properties: {},
          origin: "explicit",
          reason: "The sketch explicitly includes object storage.",
          approvalStatus: "not-required",
        },
        {
          id: "replica",
          type: "Lambda",
          name: "Regional replica",
          properties: {},
          origin: "stage-upgrade",
          reason: "Recovery requirements recommend another regional worker.",
          approvalStatus: "pending",
        },
      ],
      relationships: [{
        id: "replica-to-bucket",
        sourceId: "replica",
        targetId: "bucket",
        kind: "writes",
        origin: "stage-upgrade",
        reason: "The regional worker writes replicated objects.",
        approvalStatus: "pending",
      }],
      decisions: [],
      unresolvedQuestions: [],
    };
    const layout: ArchitectureLayout = {
      version: "architecture-layout/v1",
      revisionId: baseRevisionId,
      nodes: [
        { resourceId: "bucket", x: 0, y: 0 },
        { resourceId: "replica", x: 260, y: 40 },
      ],
    };
    const room = await database.room.create({
      data: {
        mode: "shared",
        phase: "architect",
        ownerTokenHash: `architecture-integration-${randomUUID()}`,
        participants: {
          create: [
            { id: participantA, name: "Ada", color: "#10A37F" },
            { id: participantB, name: "Grace", color: "#D97706" },
          ],
        },
      },
    });
    await database.architectureRevision.create({
      data: {
        id: baseRevisionId,
        roomId: room.id,
        version: 1,
        architecture,
        layout,
        requirements,
        stage: "growth",
        authorType: "ai",
        authorId: "integration:fixture",
        rationale: "Initial reconstructed architecture.",
      },
    });
    await database.room.update({
      where: { id: room.id },
      data: { currentRevisionId: baseRevisionId },
    });

    const yjs = createYjsRepository(database as unknown as SnapshotDatabase);
    const initial = new Y.Doc();
    initial.getMap(ARCHITECTURE_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
      version: "working-architecture/v1",
      revisionId: baseRevisionId,
      architecture,
    });
    initial.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(
      ARCHITECTURE_CURRENT_KEY,
      layout,
    );
    await yjs.persistRoomSnapshot(
      room.id,
      initial,
      "architecture_fixture",
      { kind: "protected_state", expectedProtectedState: null },
    );
    initial.destroy();

    const live = await yjs.loadRoomDocument(room.id);
    const documents = createActiveDocumentRegistry({
      loadRoomDocument: yjs.loadRoomDocument,
    });
    const deactivate = await documents.activate(room.id, live);
    const clientA = cloneDocument(live);
    const clientB = cloneDocument(live);
    const relay = (update: Uint8Array, origin: unknown) => {
      if (origin === "integration-client-relay") return;
      Y.applyUpdate(clientA, update, "integration-client-relay");
      Y.applyUpdate(clientB, update, "integration-client-relay");
    };
    live.on("update", relay);
    const repository = createRevisionRepository({ database });
    const service = createRevisionService({
      documents,
      repository,
      persistRoomSnapshot: yjs.persistRoomSnapshot,
    });
    const app = Fastify({ logger: false });
    registerArchitectureRoutes(app, {
      database,
      service,
      getConfig: () => ({
        nodeEnv: "test",
        cookieSigningSecret: COOKIE_SECRET,
        ownerTokenPepper: OWNER_PEPPER,
      }),
    });

    try {
      const forged = cloneDocument(clientA);
      forged.getMap(ARCHITECTURE_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
        ...readState(forged).architecture,
        revisionId: "forged-client-revision",
      });
      const forgedUpdate = Y.encodeStateAsUpdate(
        forged,
        Y.encodeStateVector(live),
      );
      expect(() => assertClientDocumentUpdateAllowed(live, forgedUpdate)).toThrow(
        "Server-owned document state cannot be changed by clients",
      );
      expect(readState(live).architecture.revisionId).toBe(baseRevisionId);
      forged.destroy();

      const snapshotsBeforeInvalid = await database.yjsSnapshot.count({
        where: { roomId: room.id },
      });
      const invalid = await app.inject({
        method: "POST",
        url: `/api/rooms/${room.id}/operations`,
        headers: { cookie: cookie(room.id, participantA) },
        payload: {
          baseRevisionId,
          operations: [
            {
              type: "add_resource",
              resource: {
                id: "queue",
                type: "SQS",
                name: "Work queue",
                properties: {},
                origin: "explicit",
                reason: "Added manually.",
                approvalStatus: "not-required",
              },
            },
            {
              type: "add_relationship",
              relationship: {
                id: "queue-to-missing",
                sourceId: "queue",
                targetId: "missing",
                kind: "connects",
                origin: "explicit",
                reason: "Invalid dangling relationship.",
                approvalStatus: "not-required",
              },
            },
          ],
        },
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toMatchObject({
        ok: false,
        diagnostics: [{ code: "OPERATION_DANGLING_RELATIONSHIP" }],
      });
      expect(readState(clientA).architecture.architecture.resources)
        .toHaveLength(2);
      expect(readState(clientB).architecture.architecture.resources)
        .toHaveLength(2);
      expect(await database.yjsSnapshot.count({ where: { roomId: room.id } }))
        .toBe(snapshotsBeforeInvalid);

      const stale = await app.inject({
        method: "POST",
        url: `/api/rooms/${room.id}/operations`,
        headers: { cookie: cookie(room.id, participantB) },
        payload: {
          baseRevisionId: "stale-revision",
          operations: [{
            type: "update_resource",
            resourceId: "bucket",
            changes: { name: "Should not publish" },
          }],
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        code: "stale_revision",
        currentRevisionId: baseRevisionId,
      });

      const approved = await app.inject({
        method: "POST",
        url: `/api/rooms/${room.id}/operations`,
        headers: { cookie: cookie(room.id, participantA) },
        payload: {
          baseRevisionId,
          operations: [{
            type: "set_resource_approval",
            resourceId: "replica",
            approvalStatus: "approved",
          }],
        },
      });
      expect(approved.statusCode).toBe(200);
      for (const client of [clientA, clientB]) {
        expect(readState(client).architecture.architecture.resources)
          .toContainEqual(expect.objectContaining({
            id: "replica",
            approvalStatus: "approved",
          }));
      }

      const movedLayout = {
        ...readState(clientB).layout,
        nodes: [{ resourceId: "bucket", x: 40, y: 80 }],
      };
      const moved = await app.inject({
        method: "POST",
        url: `/api/rooms/${room.id}/operations`,
        headers: { cookie: cookie(room.id, participantB) },
        payload: {
          baseRevisionId,
          operations: [],
          layout: movedLayout,
        },
      });
      expect(moved.statusCode).toBe(200);
      const independentlyMoved = await app.inject({
        method: "POST",
        url: `/api/rooms/${room.id}/operations`,
        headers: { cookie: cookie(room.id, participantA) },
        payload: {
          baseRevisionId,
          operations: [],
          layout: {
            version: "architecture-layout/v1",
            revisionId: baseRevisionId,
            nodes: [{ resourceId: "replica", x: 520, y: 120 }],
          },
        },
      });
      expect(independentlyMoved.statusCode).toBe(200);
      for (const client of [clientA, clientB]) {
        expect(readState(client).layout.nodes).toContainEqual({
          resourceId: "bucket",
          x: 40,
          y: 80,
        });
        expect(readState(client).layout.nodes).toContainEqual({
          resourceId: "replica",
          x: 520,
          y: 120,
        });
        expect(readState(client).architecture.architecture.resources)
          .toContainEqual(expect.objectContaining({
            id: "bucket",
            name: "Uploads",
          }));
      }

      const sameRevisionPayloadCaptured = deferred();
      const releaseSameRevisionPayload = deferred();
      const sameRevisionAutosaves = createSnapshotService({
        persistRoomSnapshot: async (autosaveRoomId, document, reason) => {
          const staleCandidate = cloneDocument(document);
          sameRevisionPayloadCaptured.resolve();
          await releaseSameRevisionPayload.promise;
          try {
            return await yjs.persistRoomSnapshot(
              autosaveRoomId,
              staleCandidate,
              reason,
            );
          } finally {
            staleCandidate.destroy();
          }
        },
      });
      sameRevisionAutosaves.track(room.id, live);
      live.getMap("integration").set("dirty-before-operation", true);
      await sameRevisionAutosaves.changed(room.id, live);
      const staleSameRevisionAutosave = sameRevisionAutosaves.store(
        room.id,
        live,
      );
      await sameRevisionPayloadCaptured.promise;

      const renamed = await app.inject({
        method: "POST",
        url: `/api/rooms/${room.id}/operations`,
        headers: { cookie: cookie(room.id, participantA) },
        payload: {
          baseRevisionId,
          operations: [{
            type: "update_resource",
            resourceId: "bucket",
            changes: { name: "Uploads protected by CAS" },
          }],
        },
      });
      expect(renamed.statusCode).toBe(200);
      releaseSameRevisionPayload.resolve();
      await expect(staleSameRevisionAutosave).rejects.toThrow(
        "Snapshot protected state is stale",
      );
      for (const client of [clientA, clientB]) {
        expect(readState(client).architecture.architecture.resources)
          .toContainEqual(expect.objectContaining({
            id: "bucket",
            name: "Uploads protected by CAS",
          }));
      }

      const stalePayloadCaptured = deferred();
      const releaseStalePayload = deferred();
      const autosaves = createSnapshotService({
        persistRoomSnapshot: async (autosaveRoomId, document, reason) => {
          const staleCandidate = cloneDocument(document);
          stalePayloadCaptured.resolve();
          await releaseStalePayload.promise;
          try {
            return await yjs.persistRoomSnapshot(
              autosaveRoomId,
              staleCandidate,
              reason,
            );
          } finally {
            staleCandidate.destroy();
          }
        },
      });
      autosaves.track(room.id, live);
      live.getMap("integration").set("dirty-before-revision", true);
      await autosaves.changed(room.id, live);
      const staleAutosave = autosaves.store(room.id, live);
      await stalePayloadCaptured.promise;

      const saved = await app.inject({
        method: "POST",
        url: `/api/rooms/${room.id}/revisions`,
        headers: { cookie: cookie(room.id, participantA) },
        payload: {
          baseRevisionId,
          rationale: "Approved the regional worker and final graph layout.",
        },
      });
      expect(saved.statusCode).toBe(201);
      const savedBody = saved.json();
      expect(savedBody).toMatchObject({
        revision: {
          roomId: room.id,
          version: 2,
          authorType: "participant",
          authorId: participantA,
          rationale: "Approved the regional worker and final graph layout.",
        },
        event: {
          kind: "architecture_revision_saved",
          actorId: participantA,
        },
      });
      const newRevisionId = savedBody.revision.id as string;
      releaseStalePayload.resolve();
      await expect(staleAutosave).rejects.toThrow(
        "Snapshot architecture revision is stale",
      );
      for (const client of [clientA, clientB]) {
        expect(readState(client)).toMatchObject({
          architecture: { revisionId: newRevisionId },
          layout: { revisionId: newRevisionId },
        });
      }

      const [historyA, historyB] = await Promise.all([
        app.inject({
          method: "GET",
          url: `/api/rooms/${room.id}/revisions`,
          headers: { cookie: cookie(room.id, participantA) },
        }),
        app.inject({
          method: "GET",
          url: `/api/rooms/${room.id}/revisions`,
          headers: { cookie: cookie(room.id, participantB) },
        }),
      ]);
      expect(historyA.statusCode).toBe(200);
      expect(historyB.statusCode).toBe(200);
      expect(historyA.json()).toEqual(historyB.json());
      expect(historyA.json()).toMatchObject({
        revisions: [
          { id: newRevisionId, version: 2 },
          { id: baseRevisionId, version: 1 },
        ],
        events: [{ kind: "architecture_revision_saved" }],
      });

      const [baseRow, savedRow, durableRoom, latestSnapshot] = await Promise.all([
        database.architectureRevision.findUniqueOrThrow({
          where: { id: baseRevisionId },
        }),
        database.architectureRevision.findUniqueOrThrow({
          where: { id: newRevisionId },
        }),
        database.room.findUniqueOrThrow({ where: { id: room.id } }),
        database.yjsSnapshot.findFirstOrThrow({
          where: { roomId: room.id },
          orderBy: { version: "desc" },
        }),
      ]);
      expect(baseRow.architecture).toMatchObject({
        resources: [
          expect.objectContaining({ id: "bucket" }),
          expect.objectContaining({ id: "replica", approvalStatus: "pending" }),
        ],
      });
      expect(baseRow.layout).toMatchObject({ revisionId: baseRevisionId });
      expect((baseRow.layout as { nodes: unknown[] }).nodes).toContainEqual(
        expect.objectContaining({ resourceId: "bucket", x: 0, y: 0 }),
      );
      expect(savedRow.architecture).toMatchObject({
        resources: [
          expect.objectContaining({ id: "bucket" }),
          expect.objectContaining({ id: "replica", approvalStatus: "approved" }),
        ],
      });
      expect(savedRow.layout).toMatchObject({ revisionId: newRevisionId });
      expect((savedRow.layout as { nodes: unknown[] }).nodes).toContainEqual(
        expect.objectContaining({ resourceId: "bucket", x: 40, y: 80 }),
      );
      expect(durableRoom.currentRevisionId).toBe(newRevisionId);
      expect(latestSnapshot.reason).toBe("architecture_revision");

      const snapshotDocument = new Y.Doc();
      try {
        Y.applyUpdate(snapshotDocument, new Uint8Array(latestSnapshot.payload));
        expect(readState(snapshotDocument)).toEqual(readState(clientA));
      } finally {
        snapshotDocument.destroy();
      }

      live.off("update", relay);
      await deactivate();
      await documents.destroy();
      live.destroy();
      const restarted = await yjs.loadRoomDocument(room.id);
      try {
        expect(readState(restarted)).toEqual(readState(clientA));
      } finally {
        restarted.destroy();
      }
    } finally {
      live.off("update", relay);
      await app.close();
      await deactivate().catch(() => undefined);
      await documents.destroy().catch(() => undefined);
      clientA.destroy();
      clientB.destroy();
      live.destroy();
      await database.room.deleteMany({ where: { id: room.id } });
    }
  });

  it("serializes concurrent authoritative edits against the same durable protected base", async () => {
    const revisionId = randomUUID();
    const architecture: Architecture = {
      version: "architecture/v1",
      requirements,
      resources: [{
        id: "bucket",
        type: "S3",
        name: "Before",
        properties: {},
        origin: "explicit",
        reason: "Concurrent protected-state CAS fixture.",
        approvalStatus: "not-required",
      }],
      relationships: [],
      decisions: [],
      unresolvedQuestions: [],
    };
    const layout: ArchitectureLayout = {
      version: "architecture-layout/v1",
      revisionId,
      nodes: [{ resourceId: "bucket", x: 0, y: 0 }],
    };
    const room = await database.room.create({
      data: {
        mode: "shared",
        phase: "architect",
        ownerTokenHash: `architecture-cas-${randomUUID()}`,
        currentRevisionId: revisionId,
      },
    });
    const yjs = createYjsRepository(database as unknown as SnapshotDatabase);
    const initial = new Y.Doc();
    initial.getMap(ARCHITECTURE_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
      version: "working-architecture/v1",
      revisionId,
      architecture,
    });
    initial.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(
      ARCHITECTURE_CURRENT_KEY,
      layout,
    );
    const candidateA = cloneDocument(initial);
    const candidateB = cloneDocument(initial);
    const rename = (document: Y.Doc, name: string) => {
      const state = readState(document);
      document.getMap(ARCHITECTURE_MAP_KEY).set(ARCHITECTURE_CURRENT_KEY, {
        ...state.architecture,
        architecture: {
          ...state.architecture.architecture,
          resources: state.architecture.architecture.resources.map((resource) =>
            resource.id === "bucket" ? { ...resource, name } : resource
          ),
        },
      });
    };
    rename(candidateA, "Writer A");
    rename(candidateB, "Writer B");

    try {
      await yjs.persistRoomSnapshot(
        room.id,
        initial,
        "architecture_fixture",
        { kind: "protected_state", expectedProtectedState: null },
      );
      const fence = {
        kind: "protected_state" as const,
        expectedProtectedState: readState(initial),
      };
      const results = await Promise.allSettled([
        yjs.persistRoomSnapshot(
          room.id,
          candidateA,
          "architecture_operations",
          fence,
        ),
        yjs.persistRoomSnapshot(
          room.id,
          candidateB,
          "architecture_operations",
          fence,
        ),
      ]);

      expect(results.filter(({ status }) => status === "fulfilled"))
        .toHaveLength(1);
      expect(results.find(({ status }) => status === "rejected"))
        .toMatchObject({
          status: "rejected",
          reason: {
            name: "SnapshotProtectedStateLostError",
            message: "Snapshot protected state is stale",
          },
        });
      expect(await database.yjsSnapshot.count({ where: { roomId: room.id } }))
        .toBe(2);
      const restarted = await yjs.loadRoomDocument(room.id);
      try {
        expect(["Writer A", "Writer B"]).toContain(
          readState(restarted).architecture.architecture.resources[0]?.name,
        );
      } finally {
        restarted.destroy();
      }
    } finally {
      initial.destroy();
      candidateA.destroy();
      candidateB.destroy();
      await database.room.deleteMany({ where: { id: room.id } });
    }
  });
});

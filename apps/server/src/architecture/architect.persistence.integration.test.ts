import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  ReconstructionYjsStateSchema,
  defaultRequirementsProfile,
  type ArchitectProviderOutput,
  type Architecture,
  type ArchitectureLayout,
  type ReconstructionYjsState,
} from "@architect/contracts";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import * as Y from "yjs";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type AiProvider,
  type AiRunRecorder,
  type AiTask,
  type ArchitectProtocol,
  type ArchitectTurnInput,
  type ReconstructionInput,
} from "../ai/provider.js";
import { participantCookieName } from "../auth/cookies.js";
import { signParticipant } from "../auth/participant.js";
import { createActiveDocumentRegistry } from "../collab/active-document.registry.js";
import {
  createYjsRepository,
  type SnapshotDatabase,
} from "../collab/yjs.repository.js";
import { registerArchitectRoutes } from "./architect.routes.js";
import {
  createArchitectService,
  protectedStateDigest,
} from "./architect.service.js";
import {
  createArchitectProposalRepository,
  type ArchitectProposalRepository,
} from "./architectProposal.repository.js";
import { registerArchitectureRoutes } from "./architecture.routes.js";
import { createRevisionRepository } from "./revision.repository.js";
import { createRevisionService } from "./revision.service.js";

const integrationRequested =
  process.env.RUN_ARCHITECT_DATABASE_TESTS === "true";
const testDatabaseUrl = process.env.ARCHITECT_TEST_DATABASE_URL;

if (integrationRequested && !testDatabaseUrl) {
  throw new Error(
    "ARCHITECT_TEST_DATABASE_URL is required when RUN_ARCHITECT_DATABASE_TESTS=true",
  );
}

const databaseDescribe =
  integrationRequested && testDatabaseUrl ? describe : describe.skip;
const COOKIE_SECRET = "architect-integration-cookie-secret-32-bytes";
const OWNER_PEPPER = "architect-integration-owner-pepper-32-bytes";
const SAFETY_SECRET = "architect-integration-safety-secret-32-bytes";
const requirements = defaultRequirementsProfile();

type DatabaseClient = import("@prisma/client").PrismaClient;

type ProviderState = {
  calls: number;
};

class DeterministicArchitectProvider implements AiProvider {
  constructor(
    private readonly recorder: AiRunRecorder,
    private readonly state: ProviderState,
  ) {}

  identity(_task: AiTask) {
    return {
      provider: "openai" as const,
      model: "deterministic-architect-integration-v1",
    };
  }

  async reconstruct(_input: ReconstructionInput) {
    throw new Error("not used");
  }

  async architect<TInput, TOutputSchema extends z.ZodObject>(
    input: ArchitectTurnInput<TInput>,
    protocol: ArchitectProtocol<TInput, TOutputSchema>,
  ): Promise<z.output<TOutputSchema>> {
    this.state.calls += 1;
    const message = input.input !== null
        && typeof input.input === "object"
        && "message" in input.input
        && typeof input.input.message === "string"
      ? input.input.message
      : "";
    const output: ArchitectProviderOutput = /\b(?:sqs|queue)\b/i.test(message)
      ? {
          kind: "proposal",
          responseText: "I can add an SQS queue to buffer asynchronous work.",
          operations: [{
            type: "add_resource",
            resource: {
              id: "architect-orders-queue",
              type: "SQS",
              name: "Orders queue",
              zone: "regional",
              properties: {},
            },
            reason: "Buffer asynchronous work across transient failures.",
          }],
        }
      : {
          kind: "explanation",
          responseText:
            "The shared canvas currently contains durable object storage.",
          operations: [],
        };
    await this.recorder({
      traceId: input.traceId,
      task: "architect",
      provider: "openai",
      model: "deterministic-architect-integration-v1",
      status: "succeeded",
    });
    return protocol.outputSchema.parse(output);
  }
}

function participantCookie(roomId: string, participantId: string) {
  return `${participantCookieName(roomId)}=${encodeURIComponent(
    signParticipant({ roomId, participantId }, COOKIE_SECRET),
  )}`;
}

function cloneDocument(document: Y.Doc) {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(document));
  return clone;
}

function readState(document: Y.Doc): ReconstructionYjsState {
  return ReconstructionYjsStateSchema.parse({
    architecture: document
      .getMap(ARCHITECTURE_MAP_KEY)
      .get(ARCHITECTURE_CURRENT_KEY),
    layout: document
      .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
      .get(ARCHITECTURE_CURRENT_KEY),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

databaseDescribe("Prisma AI architect persistence boundaries", () => {
  let database: DatabaseClient;

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    database = new PrismaClient({ datasourceUrl: testDatabaseUrl! });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  async function fixture() {
    const baseRevisionId = randomUUID();
    const participantA = randomUUID();
    const participantB = randomUUID();
    const architecture: Architecture = {
      version: "architecture/v1",
      requirements,
      resources: [{
        id: "uploads",
        type: "S3",
        name: "Uploads",
        properties: {},
        origin: "explicit",
        reason: "The architecture explicitly requires durable object storage.",
        approvalStatus: "not-required",
      }],
      relationships: [],
      decisions: [],
      unresolvedQuestions: [],
    };
    const layout: ArchitectureLayout = {
      version: "architecture-layout/v1",
      revisionId: baseRevisionId,
      nodes: [{ resourceId: "uploads", x: 40, y: 80 }],
    };
    const room = await database.room.create({
      data: {
        mode: "shared",
        phase: "architect",
        ownerTokenHash: `architect-integration-${randomUUID()}`,
        participants: {
          create: [
            { id: participantA, name: "Ada", color: "#10A37F" },
            { id: participantB, name: "Grace", color: "#D97706" },
          ],
        },
      },
    });
    try {
      await database.architectureRevision.create({
        data: {
          id: baseRevisionId,
          roomId: room.id,
          version: 1,
          architecture,
          layout,
          requirements,
          stage: "prototype",
          authorType: "ai",
          authorId: "integration:fixture",
          rationale: "Initial deterministic architecture fixture.",
        },
      });
      await database.room.update({
        where: { id: room.id },
        data: { currentRevisionId: baseRevisionId },
      });

      const yjs = createYjsRepository(database as unknown as SnapshotDatabase);
      const initial = new Y.Doc();
      try {
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
          "architect_fixture",
          { kind: "protected_state", expectedProtectedState: null },
        );
      } finally {
        initial.destroy();
      }

      return {
        architecture,
        baseRevisionId,
        cookieA: participantCookie(room.id, participantA),
        cookieB: participantCookie(room.id, participantB),
        participantA,
        participantB,
        roomId: room.id,
        yjs,
        async stop() {
          await database.room.deleteMany({ where: { id: room.id } });
        },
      };
    } catch (error) {
      await database.room.deleteMany({ where: { id: room.id } });
      throw error;
    }
  }

  const architectServiceFor = (
    roomDocuments: ReturnType<typeof createActiveDocumentRegistry>,
    repository: ArchitectProposalRepository,
    providerState: ProviderState,
  ) => createArchitectService({
    documents: roomDocuments,
    repository,
    providerRuntime: {
      primaryIdentity: {
        provider: "openai",
        model: "deterministic-architect-integration-v1",
      },
      createProvider: (recorder) =>
        new DeterministicArchitectProvider(recorder, providerState),
    },
    latestSnapshotVersion: async (roomId) => {
      const snapshot = await database.yjsSnapshot.aggregate({
        where: { roomId },
        _max: { version: true },
      });
      if (snapshot._max.version === null) {
        throw new Error("Architect snapshot not found");
      }
      return snapshot._max.version;
    },
    recentHistory: async (roomId) => {
      const rows = await database.historyEvent.findMany({
        where: { roomId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          kind: true,
          status: true,
          title: true,
          summary: true,
          createdAt: true,
        },
      });
      return rows.map((row) => {
        if (
          row.status !== "pending" &&
          row.status !== "succeeded" &&
          row.status !== "failed"
        ) throw new Error("Invalid history status");
        return { ...row, status: row.status, createdAt: row.createdAt.toISOString() };
      });
    },
    safetySecret: SAFETY_SECRET,
  });

  async function runtime(
    test: Awaited<ReturnType<typeof fixture>>,
    providerState: ProviderState,
    repository = createArchitectProposalRepository({ database }),
  ) {
    const live = await test.yjs.loadRoomDocument(test.roomId);
    const documents = createActiveDocumentRegistry({
      loadRoomDocument: test.yjs.loadRoomDocument,
    });
    let deactivate: (() => Promise<void>) | undefined;
    let app: ReturnType<typeof Fastify> | undefined;
    try {
      deactivate = await documents.activate(test.roomId, live);
      const architectService = architectServiceFor(
        documents,
        repository,
        providerState,
      );
      const revisionService = createRevisionService({
        documents,
        repository: createRevisionRepository({ database }),
        persistRoomSnapshot: test.yjs.persistRoomSnapshot,
      });
      app = Fastify({ logger: false });
      registerArchitectRoutes(app, {
        database,
        service: architectService,
        getConfig: () => ({
          nodeEnv: "test",
          cookieSigningSecret: COOKIE_SECRET,
          ownerTokenPepper: OWNER_PEPPER,
        }),
      });
      registerArchitectureRoutes(app, {
        database,
        service: revisionService,
        getConfig: () => ({
          nodeEnv: "test",
          cookieSigningSecret: COOKIE_SECRET,
          ownerTokenPepper: OWNER_PEPPER,
        }),
      });
      return {
        app,
        architectService,
        documents,
        live,
        revisionService,
        async stop() {
          await app?.close();
          await deactivate?.();
          await documents.destroy();
          live.destroy();
        },
      };
    } catch (error) {
      await app?.close().catch(() => undefined);
      await deactivate?.().catch(() => undefined);
      await documents.destroy().catch(() => undefined);
      live.destroy();
      throw error;
    }
  }

  it("keeps explanation and SQS proposal graph-free, gives two clients the same durable turns, and applies exactly once across restart", async () => {
    const test = await fixture();
    const providerState = { calls: 0 };
    const first = await runtime(test, providerState);
    const clientA = cloneDocument(first.live);
    const clientB = cloneDocument(first.live);
    const relay = (update: Uint8Array, origin: unknown) => {
      if (origin === "architect-integration-client-relay") return;
      Y.applyUpdate(clientA, update, "architect-integration-client-relay");
      Y.applyUpdate(clientB, update, "architect-integration-client-relay");
    };
    first.live.on("update", relay);

    try {
      const initialState = readState(first.live);
      const explanation = await first.app.inject({
        method: "POST",
        url: `/api/rooms/${test.roomId}/architect/turns`,
        headers: { cookie: test.cookieA },
        payload: {
          message: "Explain the current architecture.",
          idempotencyKey: "explain-current-v1",
        },
      });
      expect(explanation.statusCode).toBe(201);
      expect(explanation.json()).toMatchObject({
        state: "answered",
        kind: "explanation",
        operations: [],
      });
      expect(readState(clientA)).toEqual(initialState);
      expect(readState(clientB)).toEqual(initialState);
      expect(await database.yjsSnapshot.count({ where: { roomId: test.roomId } }))
        .toBe(1);
      expect(await database.architectureRevision.count({ where: { roomId: test.roomId } }))
        .toBe(1);
      expect(await database.historyEvent.count({ where: { roomId: test.roomId } }))
        .toBe(0);

      const proposal = await first.app.inject({
        method: "POST",
        url: `/api/rooms/${test.roomId}/architect/turns`,
        headers: { cookie: test.cookieA },
        payload: {
          message: "Add an SQS queue for orders.",
          idempotencyKey: "propose-orders-queue-v1",
        },
      });
      expect(proposal.statusCode).toBe(201);
      const proposalBody = proposal.json();
      expect(proposalBody).toMatchObject({
        state: "proposal_ready",
        kind: "proposal",
        baseRevisionId: test.baseRevisionId,
        operations: [{
          type: "add_resource",
          resource: { id: "architect-orders-queue", type: "SQS" },
        }],
      });
      expect(readState(clientA)).toEqual(initialState);
      expect(readState(clientB)).toEqual(initialState);
      expect(await database.yjsSnapshot.count({ where: { roomId: test.roomId } }))
        .toBe(1);

      const [turnsA, turnsB] = await Promise.all([
        first.app.inject({
          method: "GET",
          url: `/api/rooms/${test.roomId}/architect/turns`,
          headers: { cookie: test.cookieA },
        }),
        first.app.inject({
          method: "GET",
          url: `/api/rooms/${test.roomId}/architect/turns`,
          headers: { cookie: test.cookieB },
        }),
      ]);
      expect(turnsA.statusCode).toBe(200);
      expect(turnsB.statusCode).toBe(200);
      expect(turnsA.json()).toEqual(turnsB.json());
      expect(turnsA.json().turns).toHaveLength(2);
      expect(turnsA.json().turns).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: proposalBody.id,
            state: "proposal_ready",
          }),
          expect.objectContaining({ state: "answered" }),
      ]));

      const applyPayload = {
        baseRevisionId: test.baseRevisionId,
        idempotencyKey: "apply-orders-queue-v1",
        rationale: "Add durable buffering for asynchronous order processing.",
      };
      const applied = await first.app.inject({
        method: "POST",
        url:
          `/api/rooms/${test.roomId}/architect/patches/${proposalBody.id}/apply`,
        headers: { cookie: test.cookieB },
        payload: applyPayload,
      });
      expect(applied.statusCode).toBe(200);
      const appliedBody = applied.json();
      expect(appliedBody).toMatchObject({
        id: proposalBody.id,
        state: "applied",
        reviewedByParticipantId: test.participantB,
      });
      expect(appliedBody.appliedRevisionId).not.toBe(test.baseRevisionId);
      for (const client of [clientA, clientB]) {
        expect(readState(client)).toMatchObject({
          architecture: {
            revisionId: appliedBody.appliedRevisionId,
            architecture: {
              resources: [
                expect.objectContaining({ id: "uploads" }),
                expect.objectContaining({
                  id: "architect-orders-queue",
                  type: "SQS",
                  origin: "inferred-minimal",
                  approvalStatus: "not-required",
                }),
              ],
            },
          },
          layout: { revisionId: appliedBody.appliedRevisionId },
        });
      }

      const [baseRevision, appliedRevision] = await Promise.all([
        database.architectureRevision.findUniqueOrThrow({
          where: { id: test.baseRevisionId },
        }),
        database.architectureRevision.findUniqueOrThrow({
          where: { id: appliedBody.appliedRevisionId },
        }),
      ]);
      expect(baseRevision.architecture).toEqual(test.architecture);
      expect(appliedRevision).toMatchObject({ version: 2, authorId: test.participantB });
      expect(appliedRevision.architecture).toMatchObject({
        resources: [
          expect.objectContaining({ id: "uploads" }),
          expect.objectContaining({ id: "architect-orders-queue" }),
        ],
      });
      expect(await database.architectureRevision.count({ where: { roomId: test.roomId } }))
        .toBe(2);
      expect(await database.historyEvent.count({ where: { roomId: test.roomId } }))
        .toBe(2);
      expect(await database.historyEvent.findMany({
        where: { roomId: test.roomId },
        select: { kind: true },
      })).toEqual(expect.arrayContaining([
        { kind: "architecture_revision_saved" },
        { kind: "architect_proposal_applied" },
      ]));
      expect(await database.yjsSnapshot.count({ where: { roomId: test.roomId } }))
        .toBe(2);
      expect(await database.aiRun.count({
        where: { roomId: test.roomId, task: "architect", status: "succeeded" },
      })).toBe(2);

      const duplicate = await first.app.inject({
        method: "POST",
        url:
          `/api/rooms/${test.roomId}/architect/patches/${proposalBody.id}/apply`,
        headers: { cookie: test.cookieB },
        payload: applyPayload,
      });
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json()).toEqual(appliedBody);
      expect(await database.architectureRevision.count({ where: { roomId: test.roomId } }))
        .toBe(2);
      expect(await database.historyEvent.count({ where: { roomId: test.roomId } }))
        .toBe(2);
      expect(await database.yjsSnapshot.count({ where: { roomId: test.roomId } }))
        .toBe(2);

      first.live.off("update", relay);
      await first.stop();
      const restarted = await runtime(test, providerState);
      try {
        expect(readState(restarted.live)).toEqual(readState(clientA));
        const [restartedA, restartedB] = await Promise.all([
          restarted.app.inject({
            method: "GET",
            url: `/api/rooms/${test.roomId}/architect/turns`,
            headers: { cookie: test.cookieA },
          }),
          restarted.app.inject({
            method: "GET",
            url: `/api/rooms/${test.roomId}/architect/turns`,
            headers: { cookie: test.cookieB },
          }),
        ]);
        expect(restartedA.json()).toEqual(restartedB.json());
        expect(restartedA.json().turns).toHaveLength(2);
        expect(restartedA.json().turns).toEqual(expect.arrayContaining([
            expect.objectContaining({
              id: proposalBody.id,
              state: "applied",
            }),
            expect.objectContaining({ state: "answered" }),
        ]));
        const duplicateAfterRestart = await restarted.app.inject({
          method: "POST",
          url:
            `/api/rooms/${test.roomId}/architect/patches/${proposalBody.id}/apply`,
          headers: { cookie: test.cookieB },
          payload: applyPayload,
        });
        expect(duplicateAfterRestart.statusCode).toBe(200);
        expect(duplicateAfterRestart.json()).toEqual(appliedBody);
        expect(await database.architectureRevision.count({ where: { roomId: test.roomId } }))
          .toBe(2);
        expect(await database.historyEvent.count({ where: { roomId: test.roomId } }))
          .toBe(2);
        expect(await database.yjsSnapshot.count({ where: { roomId: test.roomId } }))
          .toBe(2);
      } finally {
        await restarted.stop();
      }
      expect(providerState.calls).toBe(2);
    } finally {
      first.live.off("update", relay);
      await first.stop().catch(() => undefined);
      clientA.destroy();
      clientB.destroy();
      await test.stop();
    }
  });

  it("rolls back every proposal write when a manual operation wins the protected-state race", async () => {
    const test = await fixture();
    const providerState = { calls: 0 };
    const setup = await runtime(test, providerState);
    let manual: Awaited<ReturnType<typeof runtime>> | undefined;
    let applying: Awaited<ReturnType<typeof runtime>> | undefined;
    let applyPromise:
      | ReturnType<Awaited<ReturnType<typeof runtime>>["architectService"]["applyPatch"]>
      | undefined;
    const applyCaptured = deferred();
    const releaseApply = deferred();

    try {
      const proposal = await setup.app.inject({
        method: "POST",
        url: `/api/rooms/${test.roomId}/architect/turns`,
        headers: { cookie: test.cookieA },
        payload: {
          message: "Add an SQS queue.",
          idempotencyKey: "manual-wins-proposal-v1",
        },
      });
      const proposalId = proposal.json().id as string;
      await setup.stop();

      manual = await runtime(test, providerState);
      const actualRepository = createArchitectProposalRepository({ database });
      const delayedRepository = {
        ...actualRepository,
        async applyProposalRevision(
          input: Parameters<ArchitectProposalRepository["applyProposalRevision"]>[0],
        ) {
          applyCaptured.resolve();
          await releaseApply.promise;
          return actualRepository.applyProposalRevision(input);
        },
      };
      applying = await runtime(test, providerState, delayedRepository);

      applyPromise = applying.architectService.applyPatch({
        roomId: test.roomId,
        proposalId,
        participantId: test.participantB,
        traceId: "manual-wins-apply-race",
        request: {
          baseRevisionId: test.baseRevisionId,
          idempotencyKey: "manual-wins-review-v1",
          rationale: "This apply must lose after the working graph changes.",
        },
      });
      await applyCaptured.promise;

      await expect(manual.revisionService.applyOperations({
        roomId: test.roomId,
        request: {
          baseRevisionId: test.baseRevisionId,
          operations: [{
            type: "update_resource",
            resourceId: "uploads",
            changes: { name: "Uploads changed manually" },
          }],
        },
      })).resolves.toMatchObject({ ok: true });
      releaseApply.resolve();
      await expect(applyPromise).rejects.toMatchObject({
        code: "WORKING_STATE_CONFLICT",
        currentRevisionId: test.baseRevisionId,
      });

      expect(await database.architectureRevision.count({ where: { roomId: test.roomId } }))
        .toBe(1);
      expect(await database.historyEvent.count({ where: { roomId: test.roomId } }))
        .toBe(0);
      expect(await database.yjsSnapshot.count({ where: { roomId: test.roomId } }))
        .toBe(2);
      expect(await database.architectProposal.findUniqueOrThrow({
        where: { id: proposalId },
        select: { state: true, appliedRevisionId: true },
      })).toEqual({ state: "proposal_ready", appliedRevisionId: null });
      const restarted = await test.yjs.loadRoomDocument(test.roomId);
      try {
        expect(readState(restarted).architecture.architecture.resources)
          .toContainEqual(expect.objectContaining({
            id: "uploads",
            name: "Uploads changed manually",
          }));
        expect(readState(restarted).architecture.architecture.resources)
          .not.toContainEqual(expect.objectContaining({
            id: "architect-orders-queue",
          }));
      } finally {
        restarted.destroy();
      }
    } finally {
      releaseApply.resolve();
      await applyPromise?.catch(() => undefined);
      await setup.stop().catch(() => undefined);
      await manual?.stop().catch(() => undefined);
      await applying?.stop().catch(() => undefined);
      await test.stop();
    }
  });

  it("rolls back every paused manual write when proposal apply wins the revision race", async () => {
    const test = await fixture();
    const providerState = { calls: 0 };
    const setup = await runtime(test, providerState);
    let applying: Awaited<ReturnType<typeof runtime>> | undefined;
    let manualDocuments:
      | ReturnType<typeof createActiveDocumentRegistry>
      | undefined;
    let deactivateManual: (() => Promise<void>) | undefined;
    let manualLive: Y.Doc | undefined;
    let operationPromise:
      | ReturnType<ReturnType<typeof createRevisionService>["applyOperations"]>
      | undefined;
    const operationCaptured = deferred();
    const releaseOperation = deferred();

    try {
      const proposal = await setup.app.inject({
        method: "POST",
        url: `/api/rooms/${test.roomId}/architect/turns`,
        headers: { cookie: test.cookieA },
        payload: {
          message: "Add an SQS queue.",
          idempotencyKey: "apply-wins-proposal-v1",
        },
      });
      const proposalId = proposal.json().id as string;
      await setup.stop();

      manualLive = await test.yjs.loadRoomDocument(test.roomId);
      manualDocuments = createActiveDocumentRegistry({
        loadRoomDocument: test.yjs.loadRoomDocument,
      });
      deactivateManual = await manualDocuments.activate(
        test.roomId,
        manualLive,
      );
      const manualService = createRevisionService({
        documents: manualDocuments,
        repository: createRevisionRepository({ database }),
        persistRoomSnapshot: async (roomId, document, reason, fence) => {
          operationCaptured.resolve();
          await releaseOperation.promise;
          return test.yjs.persistRoomSnapshot(roomId, document, reason, fence);
        },
      });
      applying = await runtime(test, providerState);

      operationPromise = manualService.applyOperations({
        roomId: test.roomId,
        request: {
          baseRevisionId: test.baseRevisionId,
          operations: [{
            type: "update_resource",
            resourceId: "uploads",
            changes: { name: "Manual operation must not persist" },
          }],
        },
      });
      await operationCaptured.promise;

      const applied = await applying.architectService.applyPatch({
        roomId: test.roomId,
        proposalId,
        participantId: test.participantB,
        traceId: "apply-wins-revision-race",
        request: {
          baseRevisionId: test.baseRevisionId,
          idempotencyKey: "apply-wins-review-v1",
          rationale: "The proposal commits before the paused manual write.",
        },
      });
      expect(applied).toMatchObject({ state: "applied" });
      releaseOperation.resolve();
      await expect(operationPromise).rejects.toMatchObject({
        code: "STALE_REVISION",
        currentRevisionId: null,
      });

      expect(await database.architectureRevision.count({ where: { roomId: test.roomId } }))
        .toBe(2);
      expect(await database.historyEvent.count({ where: { roomId: test.roomId } }))
        .toBe(2);
      expect(await database.yjsSnapshot.count({ where: { roomId: test.roomId } }))
        .toBe(2);
      expect((await database.room.findUniqueOrThrow({
        where: { id: test.roomId },
      })).currentRevisionId).toBe(applied.appliedRevisionId);
      const restarted = await test.yjs.loadRoomDocument(test.roomId);
      try {
        const state = readState(restarted);
        expect(state.architecture.revisionId).toBe(applied.appliedRevisionId);
        expect(state.architecture.architecture.resources)
          .toContainEqual(expect.objectContaining({
            id: "uploads",
            name: "Uploads",
          }));
        expect(state.architecture.architecture.resources)
          .toContainEqual(expect.objectContaining({
            id: "architect-orders-queue",
          }));
      } finally {
        restarted.destroy();
      }

    } finally {
      releaseOperation.resolve();
      await operationPromise?.catch(() => undefined);
      await setup.stop().catch(() => undefined);
      await applying?.stop().catch(() => undefined);
      await deactivateManual?.().catch(() => undefined);
      await manualDocuments?.destroy().catch(() => undefined);
      manualLive?.destroy();
      await test.stop();
    }
  });

  it("interrupts stale thinking once and never replays its provider call", async () => {
    const test = await fixture();
    const providerState = { calls: 0 };
    const repository = createArchitectProposalRepository({ database });
    const running = await runtime(test, providerState, repository);

    try {
      const sourceState = readState(running.live);
      const traceId = `architect:${randomUUID()}`;
      const created = await repository.createThinking({
        id: randomUUID(),
        roomId: test.roomId,
        baseRevisionId: test.baseRevisionId,
        message: "Explain without replaying this interrupted turn.",
        actor: { type: "participant", id: test.participantA },
        idempotencyKey: "interrupted-turn-v1",
        sourceSnapshotVersion: 1,
        sourceProtectedDigest: protectedStateDigest(sourceState),
        sourceProtectedState: sourceState,
        traceId,
        primaryProvider: {
          provider: "openai",
          model: "deterministic-architect-integration-v1",
        },
      });
      expect(created.kind).toBe("created");
      await database.architectProposal.update({
        where: { id: created.turn.id },
        data: { updatedAt: new Date(Date.now() - 180_000) },
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const retry = await running.app.inject({
          method: "POST",
          url: `/api/rooms/${test.roomId}/architect/turns`,
          headers: { cookie: test.cookieA },
          payload: {
            message: "Explain without replaying this interrupted turn.",
            idempotencyKey: "interrupted-turn-v1",
          },
        });
        expect(retry.statusCode).toBe(201);
        expect(retry.json()).toMatchObject({
          id: created.turn.id,
          state: "failed",
          error: { code: "TURN_INTERRUPTED" },
        });
      }

      expect(providerState.calls).toBe(0);
      expect(await database.architectProposal.count({
        where: { roomId: test.roomId },
      })).toBe(1);
      expect(await database.aiRun.findUniqueOrThrow({
        where: { traceId },
        select: { status: true, errorCode: true },
      })).toEqual({ status: "failed", errorCode: "TURN_INTERRUPTED" });
      expect(await database.yjsSnapshot.count({ where: { roomId: test.roomId } }))
        .toBe(1);
      expect(readState(running.live)).toEqual(sourceState);
    } finally {
      await running.stop();
      await test.stop();
    }
  });
});

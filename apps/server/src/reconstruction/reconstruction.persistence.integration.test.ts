import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_MAP_KEY,
  SERVER_VOTES_MAP_KEY,
  defaultRequirementsProfile,
  evaluateVote,
  type InfrastructureIntent,
} from "@architect/contracts";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import * as Y from "yjs";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { participantCookieName } from "../auth/cookies.js";
import { signParticipant } from "../auth/participant.js";
import {
  AiProviderError,
  type AiProvider,
  type AiRunRecorder,
  type AiTask,
  type ArchitectProtocol,
  type ArchitectTurnInput,
  type ReconstructionInput,
} from "../ai/provider.js";
import { createActiveDocumentRegistry } from "../collab/active-document.registry.js";
import { createReconstructionPublisher } from "./reconstruction.publisher.js";
import { createReconstructionRepository } from "./reconstruction.repository.js";
import { registerReconstructionRoutes } from "./reconstruction.routes.js";
import { createReconstructionService } from "./reconstruction.service.js";

const integrationRequested = process.env.RUN_RECONSTRUCTION_DATABASE_TESTS === "true";
const testDatabaseUrl = process.env.RECONSTRUCTION_TEST_DATABASE_URL;

if (integrationRequested && !testDatabaseUrl) {
  throw new Error(
    "RECONSTRUCTION_TEST_DATABASE_URL is required when RUN_RECONSTRUCTION_DATABASE_TESTS=true",
  );
}

const databaseDescribe = integrationRequested && testDatabaseUrl ? describe : describe.skip;

const COOKIE_SECRET = "integration-cookie-secret-at-least-32-bytes";
const IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const requirements = defaultRequirementsProfile();
const supplierPortalIntent: InfrastructureIntent = {
  version: "infrastructure-intent/v1",
  resources: [
    { id: "portal", type: "Lambda", name: "Supplier portal", properties: {} },
    { id: "uploads", type: "S3", name: "Supplier uploads", properties: {} },
  ],
  relationships: [
    { sourceId: "portal", targetId: "uploads", kind: "writes" },
  ],
};

type ProviderState = {
  calls: number;
  fail?: boolean;
};

class DeterministicProvider implements AiProvider {
  constructor(
    private readonly recorder: AiRunRecorder,
    private readonly state: ProviderState,
  ) {}

  identity(_task: AiTask) {
    return { provider: "openai" as const, model: "deterministic-supplier-v1" };
  }

  async reconstruct(input: ReconstructionInput) {
    this.state.calls += 1;
    if (this.state.fail) {
      await this.recorder({
        traceId: input.traceId,
        task: "reconstruct",
        provider: "openai",
        model: "deterministic-supplier-v1",
        status: "failed",
        errorCode: "AI_PROVIDER_ERROR",
      });
      throw new AiProviderError(input.traceId);
    }
    await this.recorder({
      traceId: input.traceId,
      task: "reconstruct",
      provider: "openai",
      model: "deterministic-supplier-v1",
      status: "succeeded",
    });
    return supplierPortalIntent;
  }

  async architect<TInput, TOutputSchema extends z.ZodObject>(
    _input: ArchitectTurnInput<TInput>,
    _protocol: ArchitectProtocol<TInput, TOutputSchema>,
  ): Promise<z.output<TOutputSchema>> {
    throw new Error("not used");
  }
}

databaseDescribe("Prisma reconstruction boundaries", () => {
  let database: typeof import("../db/client.js").prisma;
  let createYjsRepository: typeof import("../collab/yjs.repository.js").createYjsRepository;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl!;
    ({ prisma: database } = await import("../db/client.js"));
    ({ createYjsRepository } = await import("../collab/yjs.repository.js"));
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it("allows one concurrent attempt claimant and preserves its input binding", async () => {
    const room = await database.room.create({
      data: { mode: "shared", phase: "reconstructing", ownerTokenHash: `reconstruction-${randomUUID()}` },
    });
    const job = await database.transitionJob.create({
      data: { roomId: room.id, sourceRevision: 7, kind: "ready", traceId: randomUUID() },
    });
    const repository = createReconstructionRepository({
      database,
      leaseOwner: "integration-worker",
      primaryProvider: { provider: "openai", model: "integration-model" },
    });

    try {
      const [first, second] = await Promise.all([
        repository.claimAttempt({ roomId: room.id, jobId: job.id, sourceSnapshotVersion: 7, participantId: "participant-a", inputDigest: "digest-a" }),
        repository.claimAttempt({ roomId: room.id, jobId: job.id, sourceSnapshotVersion: 7, participantId: "participant-b", inputDigest: "digest-b" }),
      ]);
      expect([first.kind, second.kind].sort()).toEqual(["claimed", "in_flight"]);
      const durable = await database.transitionJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(durable.attempt).toBe(1);
      expect(["participant-a", "participant-b"]).toContain(durable.attemptParticipantId);
      expect(await database.aiRun.count({ where: { roomId: room.id, status: "running" } })).toBe(1);
    } finally {
      await database.room.delete({ where: { id: room.id } });
    }
  });

  async function fixture() {
    const participantId = randomUUID();
    const room = await database.room.create({
      data: {
        mode: "shared",
        phase: "reconstructing",
        ownerTokenHash: `integration-${randomUUID()}`,
        participants: {
          create: {
            id: participantId,
            name: "Supplier architect",
            color: "#556B2F",
          },
        },
      },
    });
    const yjs = createYjsRepository(database);
    const source = new Y.Doc();
    source.getMap("tldraw").set("supplier-portal", {
      type: "geo",
      text: "Supplier portal to uploads",
    });
    source.getMap("requirements").set("current", requirements);
    source.getMap(SERVER_VOTES_MAP_KEY).set("ready", evaluateVote({
      activeParticipantIds: [participantId],
      voterIds: [participantId],
      threshold: 0.8,
    }));
    source.getMap("meta").set("phase", "reconstructing");
    const sourceSnapshotVersion = await yjs.persistRoomSnapshot(
      room.id,
      source,
      "supplier_portal_source",
    );
    source.destroy();
    const job = await database.transitionJob.create({
      data: {
        roomId: room.id,
        sourceRevision: sourceSnapshotVersion,
        kind: "ready",
        traceId: randomUUID(),
      },
    });
    const documents = createActiveDocumentRegistry({
      loadRoomDocument: yjs.loadRoomDocument,
    });
    const publisher = createReconstructionPublisher({
      documents,
      persistRoomSnapshot: yjs.persistRoomSnapshot,
    });
    const repository = createReconstructionRepository({
      database,
      leaseOwner: "integration-worker",
      primaryProvider: {
        provider: "openai",
        model: "deterministic-supplier-v1",
      },
    });
    const serviceFor = (
      providerState: ProviderState,
      selectedPublisher = publisher,
    ) => createReconstructionService({
      repository,
      publisher: selectedPublisher,
      sourceDatabase: database,
      createProvider: (recorder) => new DeterministicProvider(
        recorder,
        providerState,
      ),
      safetySecret: "integration-safety-secret-at-least-32-bytes",
    });
    const request = {
      imageDataUrl: IMAGE,
      mimeType: "image/png" as const,
      requirements,
      sourceSnapshotVersion,
    };
    const cookie = `${participantCookieName(room.id)}=${encodeURIComponent(
      signParticipant({ roomId: room.id, participantId }, COOKIE_SECRET),
    )}`;
    const appFor = (service: ReturnType<typeof serviceFor>, debug = false) => {
      const app = Fastify({ logger: false });
      registerReconstructionRoutes(app, {
        database,
        service,
        getConfig: () => ({
          nodeEnv: "test",
          cookieSigningSecret: COOKIE_SECRET,
          ownerTokenPepper: "integration-owner-pepper-at-least-32-bytes",
          enableDebugRoutes: debug,
        }),
      });
      return app;
    };
    return {
      appFor,
      cookie,
      documents,
      job,
      participantId,
      publisher,
      repository,
      request,
      room,
      serviceFor,
      sourceSnapshotVersion,
      yjs,
      async stop() {
        await documents.destroy();
        await database.room.delete({ where: { id: room.id } });
      },
    };
  }

  it("reconstructs a supplier portal once across concurrent API and restart requests", async () => {
    const test = await fixture();
    const provider = { calls: 0 };
    const service = test.serviceFor(provider);
    const app = test.appFor(service);
    try {
      const responses = await Promise.all([
        app.inject({
          method: "POST",
          url: `/api/rooms/${test.room.id}/reconstruction`,
          headers: { cookie: test.cookie },
          payload: test.request,
        }),
        app.inject({
          method: "POST",
          url: `/api/rooms/${test.room.id}/reconstruction`,
          headers: { cookie: test.cookie },
          payload: test.request,
        }),
      ]);
      expect(responses.every(({ statusCode }) => [200, 202].includes(statusCode)))
        .toBe(true);
      expect(new Set(responses.map((response) => response.json().jobId)))
        .toEqual(new Set([test.job.id]));
      const completed = await service.currentJob(test.room.id);
      expect(completed).toMatchObject({
        state: "succeeded",
        result: {
          provider: {
            provider: "openai",
            model: "deterministic-supplier-v1",
          },
          intent: supplierPortalIntent,
        },
      });
      expect(provider.calls).toBe(1);
      expect(await database.architectureRevision.count({ where: { roomId: test.room.id } }))
        .toBe(1);
      expect(await database.historyEvent.count({ where: { roomId: test.room.id } }))
        .toBe(1);
      expect(await database.aiRun.count({ where: { roomId: test.room.id } }))
        .toBe(1);

      await service.destroy();
      const restartedProvider = { calls: 0 };
      const restarted = test.serviceFor(restartedProvider);
      const restartedApp = test.appFor(restarted);
      try {
        const duplicate = await restartedApp.inject({
          method: "POST",
          url: `/api/rooms/${test.room.id}/reconstruction`,
          headers: { cookie: test.cookie },
          payload: test.request,
        });
        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json()).toMatchObject({
          jobId: test.job.id,
          state: "succeeded",
          result: {
            architectureRevisionId:
              completed?.result?.architectureRevisionId,
          },
        });
        expect(restartedProvider.calls).toBe(0);
      } finally {
        await restartedApp.close();
        await restarted.destroy();
      }

      const published = await test.yjs.loadRoomDocument(test.room.id);
      try {
        expect(published.getMap(ARCHITECTURE_MAP_KEY).get(ARCHITECTURE_CURRENT_KEY))
          .toMatchObject({
            revisionId: completed?.result?.architectureRevisionId,
          });
        expect(published.getMap("meta").get("phase")).toBe("architect");
      } finally {
        published.destroy();
      }
    } finally {
      await app.close();
      await test.stop();
    }
  });

  it("preserves the source sketch and requirements while an outage reopens voting", async () => {
    const test = await fixture();
    const sourceBefore = await database.yjsSnapshot.findUniqueOrThrow({
      where: {
        roomId_version: {
          roomId: test.room.id,
          version: test.sourceSnapshotVersion,
        },
      },
    });
    const service = test.serviceFor({ calls: 0, fail: true });
    try {
      await expect(service.reconstruct({
        roomId: test.room.id,
        participantId: test.participantId,
        request: test.request,
      })).resolves.toMatchObject({
        state: "failed",
        error: { code: "AI_UNAVAILABLE" },
      });
      const sourceAfter = await database.yjsSnapshot.findUniqueOrThrow({
        where: {
          roomId_version: {
            roomId: test.room.id,
            version: test.sourceSnapshotVersion,
          },
        },
      });
      expect(Buffer.from(sourceAfter.payload).equals(Buffer.from(sourceBefore.payload)))
        .toBe(true);
      expect(await database.architectureRevision.count({ where: { roomId: test.room.id } }))
        .toBe(0);
      expect(await database.historyEvent.count({ where: { roomId: test.room.id } }))
        .toBe(0);
      expect(await database.room.findUniqueOrThrow({ where: { id: test.room.id } }))
        .toMatchObject({ phase: "sketch" });
      expect(await database.transitionJob.findUniqueOrThrow({ where: { id: test.job.id } }))
        .toMatchObject({ state: "failed", cleanupCompletedAt: expect.any(Date) });

      const cleaned = await test.yjs.loadRoomDocument(test.room.id);
      try {
        expect(cleaned.getMap(SERVER_VOTES_MAP_KEY).has("ready")).toBe(false);
        expect(cleaned.getMap("requirements").get("current")).toEqual(requirements);
        expect(cleaned.getMap("tldraw").get("supplier-portal")).toEqual({
          type: "geo",
          text: "Supplier portal to uploads",
        });
        expect(cleaned.getMap("meta").get("phase")).toBe("sketch");
      } finally {
        cleaned.destroy();
      }
    } finally {
      await service.destroy();
      await test.stop();
    }
  });

  it("recovers publication and the phase mirror after restart without provider calls", async () => {
    const publishing = await fixture();
    const initialProvider = { calls: 0 };
    let failPublication = true;
    const interruptedPublisher = {
      ...publishing.publisher,
      async publishArchitecture(
        input: Parameters<typeof publishing.publisher.publishArchitecture>[0],
      ) {
        if (failPublication) {
          failPublication = false;
          throw new Error("simulated process interruption");
        }
        return publishing.publisher.publishArchitecture(input);
      },
    };
    const interrupted = publishing.serviceFor(initialProvider, interruptedPublisher);
    try {
      await expect(interrupted.reconstruct({
        roomId: publishing.room.id,
        participantId: publishing.participantId,
        request: publishing.request,
      })).resolves.toMatchObject({ state: "publishing" });
      expect(initialProvider.calls).toBe(1);
      await interrupted.destroy();
      await database.transitionJob.update({
        where: { id: publishing.job.id },
        data: { leaseExpiresAt: new Date(0) },
      });
      const restartProvider = { calls: 0 };
      const restarted = publishing.serviceFor(restartProvider);
      await restarted.recover();
      expect(restartProvider.calls).toBe(0);
      expect(await restarted.currentJob(publishing.room.id)).toMatchObject({
        state: "succeeded",
      });
      expect(await database.transitionJob.findUniqueOrThrow({ where: { id: publishing.job.id } }))
        .toMatchObject({ phasePublishedAt: expect.any(Date) });
      await restarted.destroy();
    } finally {
      await publishing.stop();
    }

    const phaseMirror = await fixture();
    const firstProvider = { calls: 0 };
    const interruptedPhasePublisher = {
      ...phaseMirror.publisher,
      async publishArchitectPhase() {
        throw new Error("simulated phase mirror interruption");
      },
    };
    const first = phaseMirror.serviceFor(firstProvider, interruptedPhasePublisher);
    try {
      await expect(first.reconstruct({
        roomId: phaseMirror.room.id,
        participantId: phaseMirror.participantId,
        request: phaseMirror.request,
      })).resolves.toMatchObject({ state: "succeeded" });
      expect(firstProvider.calls).toBe(1);
      await first.destroy();
      await database.transitionJob.update({
        where: { id: phaseMirror.job.id },
        data: { leaseExpiresAt: new Date(0) },
      });
      const restartProvider = { calls: 0 };
      const restarted = phaseMirror.serviceFor(restartProvider);
      await restarted.recover();
      expect(restartProvider.calls).toBe(0);
      expect(await database.transitionJob.findUniqueOrThrow({ where: { id: phaseMirror.job.id } }))
        .toMatchObject({ phasePublishedAt: expect.any(Date) });
      const latest = await phaseMirror.yjs.loadRoomDocument(phaseMirror.room.id);
      try {
        expect(latest.getMap("meta").get("phase")).toBe("architect");
      } finally {
        latest.destroy();
      }
      await restarted.destroy();
    } finally {
      await phaseMirror.stop();
    }
  });

  it("runs debug through Fastify with no Prisma or Yjs mutation", async () => {
    const test = await fixture();
    const provider = { calls: 0 };
    const service = test.serviceFor(provider);
    const app = test.appFor(service, true);
    const counts = async () => ({
      aiRuns: await database.aiRun.count({ where: { roomId: test.room.id } }),
      history: await database.historyEvent.count({ where: { roomId: test.room.id } }),
      jobs: await database.transitionJob.count({ where: { roomId: test.room.id } }),
      revisions: await database.architectureRevision.count({ where: { roomId: test.room.id } }),
      rooms: await database.room.count({ where: { id: test.room.id } }),
      snapshots: await database.yjsSnapshot.count({ where: { roomId: test.room.id } }),
    });
    try {
      const beforeCounts = await counts();
      const beforeSnapshots = await database.yjsSnapshot.findMany({
        where: { roomId: test.room.id },
        orderBy: { version: "asc" },
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/debug/rooms/${test.room.id}/reconstruction`,
        headers: { cookie: test.cookie },
        payload: {
          imageDataUrl: IMAGE,
          mimeType: "image/png",
          requirements,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        provider: {
          provider: "openai",
          model: "deterministic-supplier-v1",
        },
        intent: supplierPortalIntent,
        semanticGraph: { version: "architecture/v1" },
      });
      expect(provider.calls).toBe(1);
      expect(await counts()).toEqual(beforeCounts);
      const afterSnapshots = await database.yjsSnapshot.findMany({
        where: { roomId: test.room.id },
        orderBy: { version: "asc" },
      });
      expect(afterSnapshots.map(({ version, payload }) => ({
        version,
        payload: Buffer.from(payload).toString("base64"),
      }))).toEqual(beforeSnapshots.map(({ version, payload }) => ({
        version,
        payload: Buffer.from(payload).toString("base64"),
      })));
    } finally {
      await app.close();
      await service.destroy();
      await test.stop();
    }
  });
});

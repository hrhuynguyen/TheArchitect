import { buildApp } from "./app.js";
import { randomUUID } from "node:crypto";
import { createAwarenessRegistry } from "./collab/awareness.registry.js";
import { createActiveDocumentRegistry } from "./collab/active-document.registry.js";
import { createHocuspocusServer } from "./collab/hocuspocus.js";
import {
  createYjsRepository,
  type SnapshotDatabase,
} from "./collab/yjs.repository.js";
import { parseEnv } from "./config/env.js";
import { loadRootEnv } from "./config/load-env.js";
import { prisma } from "./db/client.js";
import { startServer } from "./lifecycle.js";
import {
  createRuntimeLoggerOptions,
  logPersistenceFailure,
  summarizePersistenceError,
} from "./logging.js";
import {
  createRoomService,
  prismaRoomRepository,
} from "./rooms/room.service.js";
import {
  createVoteService,
  type VoteDatabase,
} from "./rooms/vote.service.js";
import type { VoteParticipantDatabase } from "./rooms/vote.routes.js";
import { createReconstructionPublisher } from "./reconstruction/reconstruction.publisher.js";
import { createReconstructionRepository } from "./reconstruction/reconstruction.repository.js";
import { createReconstructionProviderRuntime } from "./reconstruction/reconstruction.runtime.js";
import { createReconstructionService } from "./reconstruction/reconstruction.service.js";
import type { ReconstructionRouteDatabase } from "./reconstruction/reconstruction.routes.js";
import { createRevisionRepository } from "./architecture/revision.repository.js";
import { createRevisionService } from "./architecture/revision.service.js";
import type { ArchitectureRouteDatabase } from "./architecture/architecture.routes.js";
import type { ArchitectRouteDatabase } from "./architecture/architect.routes.js";
import { createArchitectProposalRepository } from "./architecture/architectProposal.repository.js";
import { createArchitectProviderRuntime } from "./architecture/architect.runtime.js";
import { createArchitectService } from "./architecture/architect.service.js";

loadRootEnv();
const env = parseEnv(process.env);
const awarenessRegistry = createAwarenessRegistry();
const yjsRepository = createYjsRepository(prisma as unknown as SnapshotDatabase);
const documents = createActiveDocumentRegistry({
  loadRoomDocument: yjsRepository.loadRoomDocument,
});
const revisionRepository = createRevisionRepository({ database: prisma });
const revisionService = createRevisionService({
  documents,
  repository: revisionRepository,
  persistRoomSnapshot: yjsRepository.persistRoomSnapshot,
});
const architectProviders = createArchitectProviderRuntime(env);
const architectRepository = createArchitectProposalRepository({
  database: prisma,
});
const architectService = createArchitectService({
  documents,
  repository: architectRepository,
  providerRuntime: architectProviders,
  latestSnapshotVersion: async (roomId) => {
    const result = await prisma.yjsSnapshot.aggregate({
      where: { roomId },
      _max: { version: true },
    });
    if (result._max.version === null) {
      throw new Error("Architect snapshot not found");
    }
    return result._max.version;
  },
  recentHistory: async (roomId) => {
    const rows = await prisma.historyEvent.findMany({
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
        row.status !== "pending"
        && row.status !== "succeeded"
        && row.status !== "failed"
      ) {
        throw new Error("Invalid history status");
      }
      return {
        ...row,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      };
    });
  },
  safetySecret: env.COOKIE_SIGNING_SECRET,
});
let reportVotePersistenceFailure: (error: unknown) => void = () => undefined;
const voteService = createVoteService({
  awarenessRegistry,
  database: prisma as unknown as VoteDatabase,
  documents,
  onPostCommitPersistenceError(error) {
    reportVotePersistenceFailure(error);
  },
  persistRoomSnapshot: yjsRepository.persistRoomSnapshot,
});
const reconstructionProviders = createReconstructionProviderRuntime(env);
const reconstructionRepository = createReconstructionRepository({
  database: prisma,
  leaseOwner: `server-${randomUUID()}`,
  primaryProvider: reconstructionProviders.primaryIdentity,
});
const reconstructionPublisher = createReconstructionPublisher({
  documents,
  persistRoomSnapshot: yjsRepository.persistRoomSnapshot,
});
const reconstructionService = createReconstructionService({
  repository: reconstructionRepository,
  publisher: reconstructionPublisher,
  sourceDatabase: prisma,
  createProvider: reconstructionProviders.createProvider,
  safetySecret: env.COOKIE_SIGNING_SECRET,
});
await reconstructionService.recover();
const app = buildApp({
  architectConfig: {
    nodeEnv: env.NODE_ENV,
    cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
    ownerTokenPepper: env.OWNER_TOKEN_PEPPER,
  },
  architectDatabase: prisma as unknown as ArchitectRouteDatabase,
  architectService,
  architectureConfig: {
    nodeEnv: env.NODE_ENV,
    cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
    ownerTokenPepper: env.OWNER_TOKEN_PEPPER,
  },
  architectureDatabase: prisma as unknown as ArchitectureRouteDatabase,
  architectureService: revisionService,
  logger: createRuntimeLoggerOptions(),
  roomConfig: {
    nodeEnv: env.NODE_ENV,
    cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
  },
  roomService: createRoomService(prismaRoomRepository, {
    ownerTokenPepper: env.OWNER_TOKEN_PEPPER,
  }),
  reconstructionConfig: {
    nodeEnv: env.NODE_ENV,
    cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
    ownerTokenPepper: env.OWNER_TOKEN_PEPPER,
    enableDebugRoutes: env.ENABLE_DEBUG_ROUTES,
  },
  reconstructionDatabase: prisma as unknown as ReconstructionRouteDatabase,
  reconstructionService,
  voteDocuments: documents,
  voteParticipantDatabase: prisma as unknown as VoteParticipantDatabase,
  voteService,
});
reportVotePersistenceFailure = (error) => {
  app.log.error(
    { error: summarizePersistenceError(error) },
    "Vote phase snapshot persistence failed",
  );
};
const collaboration = createHocuspocusServer({
  awarenessRegistry,
  documents,
  env,
  onPersistenceError(failure) {
    logPersistenceFailure(app.log, failure);
  },
  prisma,
});

await startServer({
  app,
  collaboration,
  database: prisma,
  onShutdownError(error) {
    app.log.error(
      { error: summarizePersistenceError(error) },
      "Graceful shutdown failed",
    );
  },
  port: env.HTTP_PORT,
  wsPort: env.WS_PORT,
});

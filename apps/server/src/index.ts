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

loadRootEnv();
const env = parseEnv(process.env);
const awarenessRegistry = createAwarenessRegistry();
const yjsRepository = createYjsRepository(prisma as unknown as SnapshotDatabase);
const documents = createActiveDocumentRegistry({
  loadRoomDocument: yjsRepository.loadRoomDocument,
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

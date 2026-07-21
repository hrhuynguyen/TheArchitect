import { buildApp } from "./app.js";
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
const app = buildApp({
  logger: createRuntimeLoggerOptions(),
  roomConfig: {
    nodeEnv: env.NODE_ENV,
    cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
  },
  roomService: createRoomService(prismaRoomRepository, {
    ownerTokenPepper: env.OWNER_TOKEN_PEPPER,
  }),
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

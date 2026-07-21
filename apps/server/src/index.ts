import { buildApp } from "./app.js";
import { createAwarenessRegistry } from "./collab/awareness.registry.js";
import { createHocuspocusServer } from "./collab/hocuspocus.js";
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

loadRootEnv();
const env = parseEnv(process.env);
const app = buildApp({
  logger: createRuntimeLoggerOptions(),
  roomConfig: {
    nodeEnv: env.NODE_ENV,
    cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
  },
  roomService: createRoomService(prismaRoomRepository, {
    ownerTokenPepper: env.OWNER_TOKEN_PEPPER,
  }),
});
const awarenessRegistry = createAwarenessRegistry();
const collaboration = createHocuspocusServer({
  awarenessRegistry,
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

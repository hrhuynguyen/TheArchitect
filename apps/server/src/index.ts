import { buildApp } from "./app.js";
import { parseEnv } from "./config/env.js";
import { loadRootEnv } from "./config/load-env.js";
import { prisma } from "./db/client.js";
import { startServer } from "./lifecycle.js";
import {
  createRoomService,
  prismaRoomRepository,
} from "./rooms/room.service.js";

loadRootEnv();
const env = parseEnv(process.env);
const app = buildApp({
  roomConfig: {
    nodeEnv: env.NODE_ENV,
    cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
  },
  roomService: createRoomService(prismaRoomRepository, {
    ownerTokenPepper: env.OWNER_TOKEN_PEPPER,
  }),
});

await startServer({
  app,
  database: prisma,
  onShutdownError(error) {
    app.log.error(error, "Graceful shutdown failed");
  },
  port: env.HTTP_PORT,
});

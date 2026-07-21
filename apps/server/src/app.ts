import Fastify from "fastify";
import { parseEnv } from "./config/env.js";
import { databaseHealth } from "./db/health.js";
import {
  registerRoomRoutes,
  type RoomRouteConfig,
} from "./rooms/room.routes.js";
import {
  createRoomService,
  prismaRoomRepository,
  type RoomService,
} from "./rooms/room.service.js";

type BuildAppOptions = {
  databaseHealth?: typeof databaseHealth;
  roomConfig?: RoomRouteConfig;
  roomService?: RoomService;
};

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify();
  const checkDatabaseHealth = options.databaseHealth ?? databaseHealth;
  const runtimeConfig = () => {
    if (options.roomConfig) return options.roomConfig;
    const env = parseEnv(process.env);
    return {
      nodeEnv: env.NODE_ENV,
      cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
    };
  };
  const roomService =
    options.roomService ??
    createRoomService(prismaRoomRepository, {
      ownerTokenPepper: () => parseEnv(process.env).OWNER_TOKEN_PEPPER,
    });

  app.get("/api/health", async () => ({
    ok: true,
    service: "architect-server",
  }));

  app.get("/api/ready", async (_request, reply) => {
    try {
      return await checkDatabaseHealth();
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  registerRoomRoutes(app, { service: roomService, getConfig: runtimeConfig });

  return app;
}

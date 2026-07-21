import Fastify, { type FastifyServerOptions } from "fastify";
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
import { prisma } from "./db/client.js";
import {
  registerVoteRoutes,
  type VoteParticipantDatabase,
} from "./rooms/vote.routes.js";
import type { VoteService } from "./rooms/vote.service.js";
import type { ActiveDocumentRegistry } from "./collab/active-document.registry.js";

type BuildAppOptions = {
  databaseHealth?: typeof databaseHealth;
  logger?: FastifyServerOptions["logger"];
  roomConfig?: RoomRouteConfig;
  roomService?: RoomService;
  voteParticipantDatabase?: VoteParticipantDatabase;
  voteDocuments?: ActiveDocumentRegistry;
  voteService?: VoteService;
};

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false });
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
  if (options.voteService) {
    registerVoteRoutes(app, {
      database:
        options.voteParticipantDatabase ??
        (prisma as unknown as VoteParticipantDatabase),
      getConfig: runtimeConfig,
      service: options.voteService,
    });
    app.addHook("onClose", async () => {
      const failures: unknown[] = [];
      try {
        await options.voteService?.destroy();
      } catch (error) {
        failures.push(error);
      }
      try {
        await options.voteDocuments?.destroy();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Vote service shutdown failed");
      }
    });
  }

  return app;
}

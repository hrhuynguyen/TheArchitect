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
import {
  registerReconstructionRoutes,
  type ReconstructionRouteConfig,
  type ReconstructionRouteDatabase,
} from "./reconstruction/reconstruction.routes.js";
import type { ReconstructionService } from "./reconstruction/reconstruction.service.js";
import {
  registerArchitectureRoutes,
  type ArchitectureRouteConfig,
  type ArchitectureRouteDatabase,
} from "./architecture/architecture.routes.js";
import type { RevisionService } from "./architecture/revision.service.js";
import {
  registerArchitectRoutes,
  type ArchitectRouteConfig,
  type ArchitectRouteDatabase,
} from "./architecture/architect.routes.js";
import type { ArchitectService } from "./architecture/architect.service.js";

type BuildAppOptions = {
  architectConfig?: ArchitectRouteConfig;
  architectDatabase?: ArchitectRouteDatabase;
  architectService?: ArchitectService;
  architectureConfig?: ArchitectureRouteConfig;
  architectureDatabase?: ArchitectureRouteDatabase;
  architectureService?: RevisionService;
  databaseHealth?: typeof databaseHealth;
  logger?: FastifyServerOptions["logger"];
  roomConfig?: RoomRouteConfig;
  roomService?: RoomService;
  reconstructionConfig?: ReconstructionRouteConfig;
  reconstructionDatabase?: ReconstructionRouteDatabase;
  reconstructionService?: ReconstructionService;
  voteParticipantDatabase?: VoteParticipantDatabase;
  voteDocuments?: ActiveDocumentRegistry;
  voteService?: VoteService;
};

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    routerOptions: { maxParamLength: 256 },
  });
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
  if (options.architectService) {
    const architectConfig = () => {
      if (options.architectConfig) return options.architectConfig;
      const env = parseEnv(process.env);
      return {
        nodeEnv: env.NODE_ENV,
        cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
        ownerTokenPepper: env.OWNER_TOKEN_PEPPER,
      };
    };
    registerArchitectRoutes(app, {
      database:
        options.architectDatabase
        ?? (prisma as unknown as ArchitectRouteDatabase),
      getConfig: architectConfig,
      service: options.architectService,
    });
  }
  if (options.architectureService) {
    const architectureConfig = () => {
      if (options.architectureConfig) return options.architectureConfig;
      const env = parseEnv(process.env);
      return {
        nodeEnv: env.NODE_ENV,
        cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
        ownerTokenPepper: env.OWNER_TOKEN_PEPPER,
      };
    };
    registerArchitectureRoutes(app, {
      database:
        options.architectureDatabase ??
        (prisma as unknown as ArchitectureRouteDatabase),
      getConfig: architectureConfig,
      service: options.architectureService,
    });
  }
  if (options.reconstructionService) {
    const reconstructionConfig = () => {
      if (options.reconstructionConfig) return options.reconstructionConfig;
      const env = parseEnv(process.env);
      return {
        nodeEnv: env.NODE_ENV,
        cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
        ownerTokenPepper: env.OWNER_TOKEN_PEPPER,
        enableDebugRoutes: env.ENABLE_DEBUG_ROUTES,
      };
    };
    registerReconstructionRoutes(app, {
      database:
        options.reconstructionDatabase ??
        (prisma as unknown as ReconstructionRouteDatabase),
      getConfig: reconstructionConfig,
      service: options.reconstructionService,
    });
    app.addHook("onClose", async () => {
      await options.reconstructionService?.destroy();
    });
  }
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

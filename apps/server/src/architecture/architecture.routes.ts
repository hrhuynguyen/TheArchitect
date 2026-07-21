import {
  ArchitectureOperationRequestSchema,
  RevisionHistoryResponseSchema,
  SaveRevisionRequestSchema,
  SaveRevisionResponseSchema,
} from "@architect/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  ownerCookieName,
  parseCookies,
  participantCookieName,
} from "../auth/cookies.js";
import { verifyOwnerToken } from "../auth/ownerToken.js";
import { verifyParticipant } from "../auth/participant.js";
import {
  ArchitectureServiceError,
  type RevisionService,
} from "./revision.service.js";

export type ArchitectureRouteDatabase = Readonly<{
  participant: {
    findFirst(input: {
      where: { id: string; roomId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  room: {
    findUnique(input: {
      where: { id: string };
      select: { id: true; ownerTokenHash: true };
    }): Promise<{ id: string; ownerTokenHash: string } | null>;
  };
}>;

export type ArchitectureRouteConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  cookieSigningSecret: string;
  ownerTokenPepper: string;
}>;

type ArchitectureRouteOptions = Readonly<{
  database: ArchitectureRouteDatabase;
  service: Pick<
    RevisionService,
    "applyOperations" | "saveRevision" | "listHistory"
  >;
  getConfig(): ArchitectureRouteConfig;
}>;

type RoomAccess =
  | Readonly<{ kind: "participant"; principalId: string }>
  | Readonly<{ kind: "owner"; principalId: string }>;

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ code: "unauthorized", message: "Unauthorized" });
}

function invalid(reply: FastifyReply) {
  return reply.code(422).send({
    code: "invalid_architecture_request",
    message: "Invalid architecture request",
  });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    code: "architecture_unavailable",
    message: "Architecture unavailable",
  });
}

function participantClaims(
  request: FastifyRequest,
  roomId: string,
  signingSecret: string,
) {
  const raw = parseCookies(request.headers.cookie).get(
    participantCookieName(roomId),
  );
  if (!raw) return null;
  try {
    const claims = verifyParticipant(raw, signingSecret);
    return claims.roomId === roomId ? claims : null;
  } catch {
    return null;
  }
}

async function authorizeParticipant(
  request: FastifyRequest,
  roomId: string,
  options: ArchitectureRouteOptions,
): Promise<RoomAccess | null> {
  const claims = participantClaims(
    request,
    roomId,
    options.getConfig().cookieSigningSecret,
  );
  if (!claims) return null;
  const participant = await options.database.participant.findFirst({
    where: { id: claims.participantId, roomId },
    select: { id: true },
  });
  return participant
    ? { kind: "participant", principalId: participant.id }
    : null;
}

async function authorizeRoom(
  request: FastifyRequest,
  roomId: string,
  options: ArchitectureRouteOptions,
): Promise<RoomAccess | null> {
  const participant = await authorizeParticipant(request, roomId, options);
  if (participant) return participant;
  const room = await options.database.room.findUnique({
    where: { id: roomId },
    select: { id: true, ownerTokenHash: true },
  });
  if (!room) return null;
  const token = parseCookies(request.headers.cookie).get(ownerCookieName(roomId));
  if (!token) return null;
  const owner = await verifyOwnerToken(
    token,
    room.ownerTokenHash,
    options.getConfig().ownerTokenPepper,
  );
  return owner ? { kind: "owner", principalId: `owner:${room.id}` } : null;
}

function serviceError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof ArchitectureServiceError)) return unavailable(reply);
  if (error.code === "STALE_REVISION") {
    return reply.code(409).send({
      code: "stale_revision",
      message: "Architecture revision is stale",
      currentRevisionId: error.currentRevisionId,
    });
  }
  if (error.code === "WORKING_STATE_CONFLICT") {
    return reply.code(409).send({
      code: "working_state_conflict",
      message: "Working architecture changed. Refresh and retry.",
      currentRevisionId: error.currentRevisionId,
    });
  }
  if (error.code === "ARCHITECTURE_NOT_FOUND") {
    return reply.code(404).send({
      code: "architecture_not_found",
      message: "Architecture not found",
    });
  }
  return invalid(reply);
}

export function registerArchitectureRoutes(
  app: FastifyInstance,
  options: ArchitectureRouteOptions,
): void {
  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/operations",
    async (request, reply) => {
      const parsed = ArchitectureOperationRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply);
      try {
        const access = await authorizeParticipant(
          request,
          request.params.roomId,
          options,
        );
        if (!access) return unauthorized(reply);
        const result = await options.service.applyOperations({
          roomId: request.params.roomId,
          request: parsed.data,
        });
        return reply.code(result.ok ? 200 : 422).send(result);
      } catch (error) {
        return serviceError(error, reply);
      }
    },
  );

  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/revisions",
    async (request, reply) => {
      const parsed = SaveRevisionRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply);
      try {
        const access = await authorizeParticipant(
          request,
          request.params.roomId,
          options,
        );
        if (!access) return unauthorized(reply);
        const result = SaveRevisionResponseSchema.parse(
          await options.service.saveRevision({
            roomId: request.params.roomId,
            participantId: access.principalId,
            traceId: request.id,
            request: parsed.data,
          }),
        );
        return reply.code(201).send(result);
      } catch (error) {
        return serviceError(error, reply);
      }
    },
  );

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/revisions",
    async (request, reply) => {
      try {
        const access = await authorizeRoom(
          request,
          request.params.roomId,
          options,
        );
        if (!access) return unauthorized(reply);
        const result = RevisionHistoryResponseSchema.parse(
          await options.service.listHistory(request.params.roomId),
        );
        return reply.send(result);
      } catch (error) {
        return serviceError(error, reply);
      }
    },
  );
}

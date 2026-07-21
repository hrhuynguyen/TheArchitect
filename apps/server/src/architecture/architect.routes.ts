import {
  ApplyArchitectPatchRequestSchema,
  ArchitectApiErrorResponseSchema,
  ArchitectTurnListSchema,
  ArchitectTurnRequestSchema,
  ArchitectTurnSchema,
  RejectArchitectPatchRequestSchema,
} from "@architect/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ownerCookieName,
  parseCookies,
  participantCookieName,
} from "../auth/cookies.js";
import { verifyOwnerToken } from "../auth/ownerToken.js";
import { verifyParticipant } from "../auth/participant.js";
import {
  ArchitectServiceError,
  type ArchitectService,
} from "./architect.service.js";

export type ArchitectRouteDatabase = Readonly<{
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

export type ArchitectRouteConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  cookieSigningSecret: string;
  ownerTokenPepper: string;
}>;

type ArchitectRouteOptions = Readonly<{
  database: ArchitectRouteDatabase;
  service: Pick<
    ArchitectService,
    "runTurn" | "listTurns" | "applyPatch" | "rejectPatch"
  >;
  getConfig(): ArchitectRouteConfig;
}>;

type RoomAccess =
  | Readonly<{ kind: "participant"; principalId: string }>
  | Readonly<{ kind: "owner"; principalId: string }>;

const patchIdSchema = z.string().trim().min(1).max(200);

function errorResponse(
  reply: FastifyReply,
  status: 401 | 404 | 409 | 422 | 503,
  body: unknown,
) {
  return reply.code(status).send(ArchitectApiErrorResponseSchema.parse(body));
}

function unauthorized(reply: FastifyReply) {
  return errorResponse(reply, 401, {
    code: "unauthorized",
    message: "Unauthorized",
  });
}

function invalid(reply: FastifyReply) {
  return errorResponse(reply, 422, {
    code: "invalid_architect_request",
    message: "Invalid architect request",
  });
}

function unavailable(reply: FastifyReply) {
  return errorResponse(reply, 503, {
    code: "architect_unavailable",
    message: "Architect unavailable",
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
  options: ArchitectRouteOptions,
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
  options: ArchitectRouteOptions,
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
  if (!(error instanceof ArchitectServiceError)) return unavailable(reply);
  switch (error.code) {
    case "REVISION_CONFLICT":
      return errorResponse(reply, 409, {
        code: "revision_conflict",
        message: "Architecture revision is stale",
        currentRevisionId: error.currentRevisionId,
      });
    case "WORKING_STATE_CONFLICT":
      return errorResponse(reply, 409, {
        code: "working_state_conflict",
        message: "Working architecture changed. Refresh and retry.",
        currentRevisionId: error.currentRevisionId,
      });
    case "TERMINAL_CONFLICT":
      return errorResponse(reply, 409, {
        code: "terminal_conflict",
        message: "The architect proposal was already reviewed.",
      });
    case "IDEMPOTENCY_CONFLICT":
      return errorResponse(reply, 409, {
        code: "idempotency_conflict",
        message: "The idempotency key is already bound to another review.",
      });
    case "DESTRUCTIVE_CONFIRMATION_REQUIRED":
      return errorResponse(reply, 422, {
        code: "destructive_confirmation_required",
        message: "Review and confirm destructive operations before applying.",
      });
    case "INVALID_AGENT_PATCH":
      return errorResponse(reply, 422, {
        code: "invalid_agent_patch",
        message: "The architect proposal is invalid.",
      });
    case "ARCHITECT_TURN_NOT_FOUND":
      return errorResponse(reply, 404, {
        code: "architect_turn_not_found",
        message: "Architect turn not found",
      });
  }
  return unavailable(reply);
}

export function registerArchitectRoutes(
  app: FastifyInstance,
  options: ArchitectRouteOptions,
): void {
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/architect/turns",
    async (request, reply) => {
      try {
        const access = await authorizeRoom(
          request,
          request.params.roomId,
          options,
        );
        if (!access) return unauthorized(reply);
        return reply.send(ArchitectTurnListSchema.parse(
          await options.service.listTurns(request.params.roomId),
        ));
      } catch (error) {
        return serviceError(error, reply);
      }
    },
  );

  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/architect/turns",
    async (request, reply) => {
      const parsed = ArchitectTurnRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply);
      try {
        const access = await authorizeRoom(
          request,
          request.params.roomId,
          options,
        );
        if (!access) return unauthorized(reply);
        const turn = ArchitectTurnSchema.parse(await options.service.runTurn({
          roomId: request.params.roomId,
          actor: { type: access.kind, id: access.principalId },
          request: parsed.data,
        }));
        return reply.code(201).send(turn);
      } catch (error) {
        return serviceError(error, reply);
      }
    },
  );

  app.post<{ Params: { roomId: string; patchId: string } }>(
    "/api/rooms/:roomId/architect/patches/:patchId/apply",
    async (request, reply) => {
      const parsed = ApplyArchitectPatchRequestSchema.safeParse(request.body);
      const patchId = patchIdSchema.safeParse(request.params.patchId);
      if (!parsed.success || !patchId.success) return invalid(reply);
      try {
        const access = await authorizeParticipant(
          request,
          request.params.roomId,
          options,
        );
        if (!access) return unauthorized(reply);
        return reply.send(ArchitectTurnSchema.parse(
          await options.service.applyPatch({
            roomId: request.params.roomId,
            proposalId: patchId.data,
            participantId: access.principalId,
            traceId: request.id,
            request: parsed.data,
          }),
        ));
      } catch (error) {
        return serviceError(error, reply);
      }
    },
  );

  app.post<{ Params: { roomId: string; patchId: string } }>(
    "/api/rooms/:roomId/architect/patches/:patchId/reject",
    async (request, reply) => {
      const parsed = RejectArchitectPatchRequestSchema.safeParse(request.body);
      const patchId = patchIdSchema.safeParse(request.params.patchId);
      if (!parsed.success || !patchId.success) return invalid(reply);
      try {
        const access = await authorizeParticipant(
          request,
          request.params.roomId,
          options,
        );
        if (!access) return unauthorized(reply);
        return reply.send(ArchitectTurnSchema.parse(
          await options.service.rejectPatch({
            roomId: request.params.roomId,
            proposalId: patchId.data,
            participantId: access.principalId,
            request: parsed.data,
          }),
        ));
      } catch (error) {
        return serviceError(error, reply);
      }
    },
  );
}

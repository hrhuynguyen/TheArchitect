import {
  DebugReconstructionRequestSchema,
  DebugReconstructionResponseSchema,
  ReconstructionRequestSchema,
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
  ReconstructionRequestError,
  type ReconstructionService,
} from "./reconstruction.service.js";

export const RECONSTRUCTION_BODY_LIMIT = 7_100_000;

export type ReconstructionRouteDatabase = Readonly<{
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

export type ReconstructionRouteConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  cookieSigningSecret: string;
  ownerTokenPepper: string;
  enableDebugRoutes: boolean;
}>;

type ReconstructionRouteOptions = Readonly<{
  database: ReconstructionRouteDatabase;
  service: Pick<
    ReconstructionService,
    "reconstruct" | "currentJob" | "jobById" | "debugAnalyze"
  >;
  getConfig(): ReconstructionRouteConfig;
}>;

type RoomAccess =
  | Readonly<{ kind: "participant"; principalId: string }>
  | Readonly<{ kind: "owner"; principalId: string }>;

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ code: "unauthorized", message: "Unauthorized" });
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({
    code: "reconstruction_not_found",
    message: "Reconstruction not found",
  });
}

function invalid(reply: FastifyReply) {
  return reply.code(422).send({
    code: "invalid_reconstruction_request",
    message: "Invalid reconstruction request",
  });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    code: "reconstruction_unavailable",
    message: "Reconstruction unavailable",
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
  options: ReconstructionRouteOptions,
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
  options: ReconstructionRouteOptions,
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
  return owner
    ? { kind: "owner", principalId: `owner:${room.id}` }
    : null;
}

function isInFlight(state: string): boolean {
  return state === "claimed" || state === "running" || state === "publishing";
}

export function registerReconstructionRoutes(
  app: FastifyInstance,
  options: ReconstructionRouteOptions,
): void {
  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/reconstruction",
    { bodyLimit: RECONSTRUCTION_BODY_LIMIT },
    async (request, reply) => {
      const parsed = ReconstructionRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply);
      try {
        const access = await authorizeParticipant(
          request,
          request.params.roomId,
          options,
        );
        if (!access) return unauthorized(reply);
        const result = await options.service.reconstruct({
          roomId: request.params.roomId,
          participantId: access.principalId,
          request: parsed.data,
        });
        return reply.code(isInFlight(result.state) ? 202 : 200).send(result);
      } catch (error) {
        if (error instanceof ReconstructionRequestError) return invalid(reply);
        return unavailable(reply);
      }
    },
  );

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/reconstruction",
    async (request, reply) => {
      try {
        const access = await authorizeRoom(
          request,
          request.params.roomId,
          options,
        );
        if (!access) return unauthorized(reply);
        const result = await options.service.currentJob(request.params.roomId);
        return result ? reply.send(result) : notFound(reply);
      } catch {
        return unavailable(reply);
      }
    },
  );

  app.get<{ Params: { roomId: string; jobId: string } }>(
    "/api/rooms/:roomId/reconstruction/:jobId",
    async (request, reply) => {
      try {
        const access = await authorizeRoom(
          request,
          request.params.roomId,
          options,
        );
        if (!access) return unauthorized(reply);
        const result = await options.service.jobById(
          request.params.roomId,
          request.params.jobId,
        );
        return result ? reply.send(result) : notFound(reply);
      } catch {
        return unavailable(reply);
      }
    },
  );

  const config = options.getConfig();
  if (!config.enableDebugRoutes || config.nodeEnv === "production") return;
  app.post<{ Params: { roomId: string } }>(
    "/api/debug/rooms/:roomId/reconstruction",
    { bodyLimit: RECONSTRUCTION_BODY_LIMIT },
    async (request, reply) => {
      const parsed = DebugReconstructionRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply);
      try {
        const access = await authorizeRoom(
          request,
          request.params.roomId,
          options,
        );
        if (!access) return unauthorized(reply);
        const result = await options.service.debugAnalyze({
          roomId: request.params.roomId,
          principalId: access.principalId,
          request: parsed.data,
        });
        return reply.send(DebugReconstructionResponseSchema.parse(result));
      } catch (error) {
        if (error instanceof ReconstructionRequestError) return invalid(reply);
        return unavailable(reply);
      }
    },
  );
}

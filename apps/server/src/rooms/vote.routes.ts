import { VoteKindSchema } from "@architect/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseCookies, participantCookieName } from "../auth/cookies.js";
import { verifyParticipant } from "../auth/participant.js";
import { VoteClosedError, type VoteService } from "./vote.service.js";

type VoteParticipantDatabase = {
  participant: {
    findFirst(input: {
      where: { id: string; roomId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  room: {
    findUnique(input: {
      where: { id: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
};

export type VoteRouteConfig = {
  cookieSigningSecret: string;
};

type VoteRouteOptions = {
  database: VoteParticipantDatabase;
  getConfig(): VoteRouteConfig;
  service: Pick<VoteService, "castVote" | "removeVote">;
};

function invalid(reply: FastifyReply) {
  return reply.code(422).send({
    code: "invalid_vote_request",
    message: "Invalid vote request",
  });
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ code: "unauthorized", message: "Unauthorized" });
}

function roomNotFound(reply: FastifyReply) {
  return reply.code(404).send({ code: "room_not_found", message: "Room not found" });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    code: "vote_unavailable",
    message: "Vote unavailable",
  });
}

function emptyBody(body: unknown): boolean {
  return (
    body === undefined ||
    (typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).length === 0)
  );
}

async function authenticate(
  request: FastifyRequest<{ Params: { roomId: string } }>,
  reply: FastifyReply,
  options: VoteRouteOptions,
): Promise<string | null> {
  const roomId = request.params.roomId;
  const rawCookie = parseCookies(request.headers.cookie).get(
    participantCookieName(roomId),
  );
  if (!rawCookie) {
    unauthorized(reply);
    return null;
  }

  let claims;
  try {
    claims = verifyParticipant(
      rawCookie,
      options.getConfig().cookieSigningSecret,
    );
  } catch {
    unauthorized(reply);
    return null;
  }
  if (claims.roomId !== roomId) {
    unauthorized(reply);
    return null;
  }

  try {
    const participant = await options.database.participant.findFirst({
      where: { id: claims.participantId, roomId },
      select: { id: true },
    });
    if (participant) return participant.id;
    const room = await options.database.room.findUnique({
      where: { id: roomId },
      select: { id: true },
    });
    if (!room) roomNotFound(reply);
    else unauthorized(reply);
    return null;
  } catch {
    unavailable(reply);
    return null;
  }
}

export function registerVoteRoutes(
  app: FastifyInstance,
  options: VoteRouteOptions,
): void {
  const handle = async (
    action: "cast" | "remove",
    request: FastifyRequest<{
      Params: { roomId: string; kind?: string };
    }>,
    reply: FastifyReply,
  ) => {
    if (!emptyBody(request.body)) return invalid(reply);
    const kind = VoteKindSchema.safeParse(request.params.kind);
    if (!kind.success) return invalid(reply);
    const participantId = await authenticate(request, reply, options);
    if (!participantId) return reply;

    try {
      const response =
        action === "cast"
          ? await options.service.castVote(
              request.params.roomId,
              participantId,
              kind.data,
            )
          : await options.service.removeVote(
              request.params.roomId,
              participantId,
              kind.data,
            );
      return reply.send(response);
    } catch (error) {
      if (error instanceof VoteClosedError) {
        return reply.code(409).send({
          code: "vote_closed",
          message: "Readiness voting is closed",
        });
      }
      return unavailable(reply);
    }
  };

  app.post<{ Params: { roomId: string; kind: string } }>(
    "/api/rooms/:roomId/votes/:kind",
    (request, reply) => handle("cast", request, reply),
  );
  app.delete<{ Params: { roomId: string; kind: string } }>(
    "/api/rooms/:roomId/votes/:kind",
    (request, reply) => handle("remove", request, reply),
  );
}

export type { VoteParticipantDatabase };

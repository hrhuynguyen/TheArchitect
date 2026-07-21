import type {
  CreateRoomResponse,
  JoinRoomResponse,
  RoomSummary,
} from "@architect/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ownerCookieName,
  parseCookies,
  participantCookieName,
  roomCookieOptions,
  serializeRoomCookie,
} from "../auth/cookies.js";
import { signParticipant, verifyParticipant } from "../auth/participant.js";
import { PublicError } from "../observability/errors.js";
import {
  parseCreateRoomRequest,
  parseJoinRoomRequest,
} from "./room.schemas.js";
import type { RoomRecord, RoomService } from "./room.service.js";

export type RoomRouteConfig = {
  nodeEnv: "development" | "test" | "production";
  cookieSigningSecret: string;
};

type RegisterRoomRoutesOptions = {
  service: RoomService;
  getConfig(): RoomRouteConfig;
};

function roomSummary(
  room: RoomRecord,
  isOwner: boolean,
  currentParticipantId: string | null,
): RoomSummary {
  return {
    id: room.id,
    mode: room.mode,
    phase: room.phase,
    isOwner,
    currentParticipantId,
    participants: room.participants,
  };
}

function publicError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof PublicError)) throw error;
  return reply.code(error.statusCode).send({
    code: error.code,
    message: error.message,
  });
}

function returningParticipantId(
  cookie: string | undefined,
  roomId: string,
  signingSecret: string,
): string | undefined {
  if (!cookie) return undefined;

  try {
    const claims = verifyParticipant(cookie, signingSecret);
    return claims.roomId === roomId ? claims.participantId : undefined;
  } catch {
    return undefined;
  }
}

function verifiedRoomParticipantId(
  room: RoomRecord,
  cookie: string | undefined,
  signingSecret: string,
): string | null {
  const participantId = returningParticipantId(
    cookie,
    room.id,
    signingSecret,
  );
  return participantId &&
    room.participants.some((participant) => participant.id === participantId)
    ? participantId
    : null;
}

export function registerRoomRoutes(
  app: FastifyInstance,
  options: RegisterRoomRoutesOptions,
): void {
  app.post("/api/rooms", async (request, reply) => {
    const input = parseCreateRoomRequest(request.body);
    if (!input) {
      return reply.code(422).send({
        code: "invalid_room_request",
        message: "Invalid room request",
      });
    }

    const config = options.getConfig();
    const created = await options.service.create(input);
    const cookieOptions = roomCookieOptions(created.room.id, config.nodeEnv);
    const participantCookie = signParticipant(
      {
        roomId: created.room.id,
        participantId: created.participantId,
      },
      config.cookieSigningSecret,
    );
    reply.header("set-cookie", [
      serializeRoomCookie(
        ownerCookieName(created.room.id),
        created.ownerToken,
        cookieOptions,
      ),
      serializeRoomCookie(
        participantCookieName(created.room.id),
        participantCookie,
        cookieOptions,
      ),
    ]);

    const response: CreateRoomResponse = {
      ...roomSummary(created.room, true, created.participantId),
      joinPath: `/room/${created.room.id}`,
    };
    return reply.code(201).send(response);
  });

  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/join",
    async (request, reply) => {
      const input = parseJoinRoomRequest(request.body);
      if (!input) {
        return reply.code(422).send({
          code: "invalid_join_request",
          message: "Invalid join request",
        });
      }

      const roomId = request.params.roomId;
      const config = options.getConfig();
      const cookies = parseCookies(request.headers.cookie);
      const existingParticipantId = returningParticipantId(
        cookies.get(participantCookieName(roomId)),
        roomId,
        config.cookieSigningSecret,
      );

      try {
        const joined = await options.service.join(
          roomId,
          input,
          existingParticipantId,
        );
        const owner = await options.service.isOwner(
          joined.room,
          cookies.get(ownerCookieName(roomId)),
        );
        const participantCookie = signParticipant(
          { roomId, participantId: joined.participantId },
          config.cookieSigningSecret,
        );
        reply.header(
          "set-cookie",
          serializeRoomCookie(
            participantCookieName(roomId),
            participantCookie,
            roomCookieOptions(roomId, config.nodeEnv),
          ),
        );

        const response: JoinRoomResponse = roomSummary(
          joined.room,
          owner,
          joined.participantId,
        );
        return reply.send(response);
      } catch (error) {
        return publicError(reply, error);
      }
    },
  );

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId",
    async (request, reply) => {
      try {
        const room = await options.service.get(request.params.roomId);
        const cookies = parseCookies(request.headers.cookie);
        const owner = await options.service.isOwner(
          room,
          cookies.get(ownerCookieName(room.id)),
        );
        const config = options.getConfig();
        const currentParticipantId = verifiedRoomParticipantId(
          room,
          cookies.get(participantCookieName(room.id)),
          config.cookieSigningSecret,
        );
        return reply.send(roomSummary(room, owner, currentParticipantId));
      } catch (error) {
        return publicError(reply, error);
      }
    },
  );
}

import {
  CreateRoomResponseSchema,
  JoinRoomResponseSchema,
  RoomSummarySchema,
  type CreateRoomResponse,
  type ParticipantProfile,
  type RoomMode,
  type RoomSummary,
} from "@architect/contracts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ResponseSchema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false };
};

export interface RoomApi {
  create(profile: ParticipantProfile, mode: RoomMode): Promise<CreateRoomResponse>;
  join(roomId: string, profile: ParticipantProfile): Promise<RoomSummary>;
  get(roomId: string): Promise<RoomSummary>;
}

export class RoomApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "RoomApiError";
  }
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function request<T>(
  fetcher: Fetcher,
  path: string,
  schema: ResponseSchema<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetcher(path, {
    credentials: "include",
    ...init,
  });
  const body = await responseBody(response);

  if (!response.ok) {
    const publicError =
      body && typeof body === "object"
        ? (body as { code?: unknown; message?: unknown })
        : null;
    const message =
      typeof publicError?.message === "string"
        ? publicError.message
        : "The room service could not complete that request.";
    const code =
      typeof publicError?.code === "string" ? publicError.code : "room_request_failed";
    throw new RoomApiError(message, response.status, code);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new RoomApiError(
      "The room service returned an invalid response.",
      response.status,
      "invalid_room_response",
    );
  }
  return parsed.data;
}

export function createRoomApi(fetcher: Fetcher = globalThis.fetch): RoomApi {
  return {
    create(profile, mode) {
      return request(fetcher, "/api/rooms", CreateRoomResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...profile, mode }),
      });
    },

    join(roomId, profile) {
      return request(
        fetcher,
        `/api/rooms/${encodeURIComponent(roomId)}/join`,
        JoinRoomResponseSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(profile),
        },
      );
    },

    get(roomId) {
      return request(
        fetcher,
        `/api/rooms/${encodeURIComponent(roomId)}`,
        RoomSummarySchema,
      );
    },
  };
}

export const roomApi = createRoomApi();

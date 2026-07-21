import {
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  type CreateRoomRequest,
  type JoinRoomRequest,
} from "@architect/contracts";

export function parseCreateRoomRequest(
  payload: unknown,
): CreateRoomRequest | null {
  const result = CreateRoomRequestSchema.safeParse(payload);
  return result.success ? result.data : null;
}

export function parseJoinRoomRequest(payload: unknown): JoinRoomRequest | null {
  const result = JoinRoomRequestSchema.safeParse(payload);
  return result.success ? result.data : null;
}

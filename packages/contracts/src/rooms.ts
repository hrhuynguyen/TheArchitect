import { z } from "zod";

export const RoomModeSchema = z.enum(["shared", "solo"]);
export type RoomMode = z.infer<typeof RoomModeSchema>;

export const RoomPhaseSchema = z.enum([
  "sketch",
  "reconstructing",
  "architect",
  "deploy",
]);
export type RoomPhase = z.infer<typeof RoomPhaseSchema>;

export const ParticipantProfileSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
});
export type ParticipantProfile = z.infer<typeof ParticipantProfileSchema>;

export const ParticipantSummarySchema = ParticipantProfileSchema.extend({
  id: z.string().min(1),
});
export type ParticipantSummary = z.infer<typeof ParticipantSummarySchema>;

export const CreateRoomRequestSchema = ParticipantProfileSchema.extend({
  mode: RoomModeSchema,
});
export const CreateRoomRequest = CreateRoomRequestSchema;
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

export const JoinRoomRequestSchema = ParticipantProfileSchema;
export const JoinRoomRequest = JoinRoomRequestSchema;
export type JoinRoomRequest = z.infer<typeof JoinRoomRequestSchema>;

export const RoomSummarySchema = z.object({
  id: z.string().min(1),
  mode: RoomModeSchema,
  phase: RoomPhaseSchema,
  isOwner: z.boolean(),
  currentParticipantId: z.string().min(1).nullable(),
  participants: z.array(ParticipantSummarySchema),
});
export const RoomSummary = RoomSummarySchema;
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

export const CreateRoomResponseSchema = RoomSummarySchema.extend({
  joinPath: z.string().min(1),
});
export const CreateRoomResponse = CreateRoomResponseSchema;
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

export const JoinRoomResponseSchema = RoomSummarySchema;
export const JoinRoomResponse = JoinRoomResponseSchema;
export type JoinRoomResponse = z.infer<typeof JoinRoomResponseSchema>;

import { z } from "zod";
import {
  ParticipantProfileSchema,
  RoomPhaseSchema,
} from "@architect/contracts/rooms";

export const AwarenessCursorSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();
export type AwarenessCursor = z.infer<typeof AwarenessCursorSchema>;

export const AwarenessIdentitySchema = ParticipantProfileSchema.extend({
  participantId: z.string().min(1),
  cursor: AwarenessCursorSchema.optional(),
  phase: RoomPhaseSchema,
}).strict();
export type AwarenessIdentity = z.infer<typeof AwarenessIdentitySchema>;

export const AwarenessProfileSchema = AwarenessIdentitySchema.extend({
  lastSeenAt: z.iso.datetime(),
}).strict();
export type AwarenessProfile = z.infer<typeof AwarenessProfileSchema>;

export const ServerPresenceSnapshotSchema = z
  .object({
    type: z.literal("architect/presence"),
    version: z.literal(1),
    roomId: z.string().min(1),
    profiles: z.array(AwarenessProfileSchema),
  })
  .strict();
export type ServerPresenceSnapshot = z.infer<
  typeof ServerPresenceSnapshotSchema
>;

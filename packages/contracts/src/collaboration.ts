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

export const AwarenessProfileSchema = ParticipantProfileSchema.extend({
  participantId: z.string().min(1),
  cursor: AwarenessCursorSchema.optional(),
  phase: RoomPhaseSchema,
  lastSeenAt: z.iso.datetime(),
}).strict();
export type AwarenessProfile = z.infer<typeof AwarenessProfileSchema>;

export type AwarenessIdentity = Omit<AwarenessProfile, "lastSeenAt">;

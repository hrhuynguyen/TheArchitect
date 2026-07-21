import { z } from "zod";
import { RoomPhaseSchema } from "@architect/contracts/rooms";

export const READINESS_THRESHOLD = 0.8 as const;

export const VoteKindSchema = z.enum([
  "ready",
  "deploy_localstack",
  "deploy_aws",
]);
export type VoteKind = z.infer<typeof VoteKindSchema>;

export const VoteSnapshotSchema = z
  .object({
    tally: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1),
    met: z.boolean(),
    threshold: z.literal(READINESS_THRESHOLD),
    voterIds: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const uniqueVoters = new Set(snapshot.voterIds);
    const expectedRatio =
      snapshot.total === 0 ? 0 : snapshot.tally / snapshot.total;
    const expectedMet =
      snapshot.tally > 0 && expectedRatio >= snapshot.threshold;
    if (
      snapshot.tally > snapshot.total ||
      uniqueVoters.size !== snapshot.voterIds.length ||
      snapshot.voterIds.length !== snapshot.tally ||
      snapshot.ratio !== expectedRatio ||
      snapshot.met !== expectedMet
    ) {
      context.addIssue({
        code: "custom",
        message: "Inconsistent vote snapshot",
      });
    }
  });
export type VoteSnapshot = z.infer<typeof VoteSnapshotSchema>;

export type VoteInput = {
  activeParticipantIds: ReadonlyArray<string>;
  voterIds: ReadonlyArray<string>;
  threshold: number;
};

export function evaluateVote(input: VoteInput): VoteSnapshot {
  const parsedInput = z
    .object({
      activeParticipantIds: z.array(z.string().min(1)),
      voterIds: z.array(z.string().min(1)),
      threshold: z.literal(READINESS_THRESHOLD),
    })
    .strict()
    .parse(input);
  const activeParticipantIds = new Set(parsedInput.activeParticipantIds);
  const voterIds = [...new Set(parsedInput.voterIds)]
    .filter((participantId) => activeParticipantIds.has(participantId))
    .sort((left, right) => left.localeCompare(right));
  const tally = voterIds.length;
  const total = activeParticipantIds.size;
  const ratio = total === 0 ? 0 : tally / total;

  return VoteSnapshotSchema.parse({
    tally,
    total,
    ratio,
    met: tally > 0 && ratio >= parsedInput.threshold,
    threshold: parsedInput.threshold,
    voterIds,
  });
}

export const TransitionClaimSchema = z
  .object({
    claimed: z.boolean(),
    jobId: z.string().min(1),
    sourceSnapshotVersion: z.number().int().nonnegative(),
  })
  .strict();
export type TransitionClaim = z.infer<typeof TransitionClaimSchema>;

const VoteMutationBaseSchema = z.object({
  phase: RoomPhaseSchema,
  snapshot: VoteSnapshotSchema,
});

export const VoteMutationResponseSchema = z.discriminatedUnion("kind", [
  VoteMutationBaseSchema.extend({
    kind: z.literal("ready"),
    transition: TransitionClaimSchema.nullable(),
  })
    .strict()
    .superRefine((response, context) => {
      const transitionExpected = response.snapshot.met;
      if (
        Boolean(response.transition) !== transitionExpected ||
        response.phase !== (transitionExpected ? "reconstructing" : "sketch")
      ) {
        context.addIssue({
          code: "custom",
          message: "Inconsistent readiness transition response",
        });
      }
    }),
  VoteMutationBaseSchema.extend({
    kind: z.enum(["deploy_localstack", "deploy_aws"]),
    transition: z.null(),
  }).strict(),
]);
export type VoteMutationResponse = z.infer<
  typeof VoteMutationResponseSchema
>;

export const SERVER_VOTES_MAP_KEY = "architect:server:votes:v1" as const;

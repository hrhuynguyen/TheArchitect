import { z } from "zod";

import {
  architectureSchema,
  workloadStageSchema,
} from "@architect/contracts/infrastructure";
import { architectureLayoutSchema } from "@architect/contracts/reconstruction";
import { RequirementsProfileSchema } from "@architect/contracts/requirements";

const identifierSchema = z.string().trim().min(1).max(200);
const timestampSchema = z.iso.datetime({ offset: true });

export const historyActorTypeSchema = z.enum([
  "participant",
  "owner",
  "ai",
  "system",
]);
export type HistoryActorType = z.infer<typeof historyActorTypeSchema>;

export const architectureRevisionSchema = z
  .object({
    id: identifierSchema,
    roomId: identifierSchema,
    version: z.number().int().positive(),
    architecture: architectureSchema,
    layout: architectureLayoutSchema,
    requirements: RequirementsProfileSchema,
    stage: workloadStageSchema,
    authorType: historyActorTypeSchema,
    authorId: identifierSchema.nullable(),
    rationale: z.string().trim().min(1).max(1_000),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((revision, context) => {
    if (revision.layout.revisionId !== revision.id) {
      context.addIssue({
        code: "custom",
        path: ["layout", "revisionId"],
        message: "Immutable revision layout must reference its revision id.",
      });
    }
  });
export const ArchitectureRevisionSchema = architectureRevisionSchema;
export type ArchitectureRevision = z.infer<typeof architectureRevisionSchema>;

export const historyEventSchema = z
  .object({
    id: identifierSchema,
    roomId: identifierSchema,
    kind: z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_]*$/),
    status: z.enum(["pending", "succeeded", "failed"]),
    actorType: historyActorTypeSchema,
    actorId: identifierSchema.nullable(),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(1_000).nullable(),
    details: z.json().nullable(),
    traceId: z.string().trim().min(1).max(128).nullable(),
    createdAt: timestampSchema,
  })
  .strict();
export const HistoryEventSchema = historyEventSchema;
export type HistoryEvent = z.infer<typeof historyEventSchema>;

export const saveRevisionRequestSchema = z
  .object({
    baseRevisionId: identifierSchema,
    rationale: z.string().trim().min(1).max(1_000),
  })
  .strict();
export const SaveRevisionRequestSchema = saveRevisionRequestSchema;
export type SaveRevisionRequest = z.infer<typeof saveRevisionRequestSchema>;

export const saveRevisionResponseSchema = z
  .object({
    revision: architectureRevisionSchema,
    event: historyEventSchema,
  })
  .strict();
export const SaveRevisionResponseSchema = saveRevisionResponseSchema;
export type SaveRevisionResponse = z.infer<typeof saveRevisionResponseSchema>;

export const revisionHistoryResponseSchema = z
  .object({
    revisions: z.array(architectureRevisionSchema).max(2_000),
    events: z.array(historyEventSchema).max(10_000),
  })
  .strict();
export const RevisionHistoryResponseSchema = revisionHistoryResponseSchema;
export type RevisionHistoryResponse = z.infer<
  typeof revisionHistoryResponseSchema
>;

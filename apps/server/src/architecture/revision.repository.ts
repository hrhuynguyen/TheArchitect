import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  ArchitectureRevisionSchema,
  HistoryEventSchema,
  ReconstructionYjsStateSchema,
  RevisionHistoryResponseSchema,
  type Architecture,
  type ArchitectureLayout,
  type HistoryActorType,
  type ReconstructionYjsState,
  type RequirementsProfile,
} from "@architect/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";

const TRANSACTION_RETRIES = 3;

type RevisionDatabase = Pick<
  PrismaClient,
  "$transaction" | "architectureRevision" | "historyEvent"
>;

export type RevisionCommitInput = Readonly<{
  roomId: string;
  baseRevisionId: string;
  revisionId: string;
  eventId: string;
  architecture: Architecture;
  layout: ArchitectureLayout;
  requirements: RequirementsProfile;
  author: Readonly<{ type: HistoryActorType; id: string | null }>;
  rationale: string;
  traceId: string;
  snapshotPayload: Uint8Array;
  expectedProtectedState: ReconstructionYjsState;
}>;

export type RevisionCommitResult =
  | Readonly<{
      kind: "committed";
      revision: ReturnType<typeof ArchitectureRevisionSchema.parse>;
      event: ReturnType<typeof HistoryEventSchema.parse>;
    }>
  | Readonly<{ kind: "stale"; currentRevisionId: string | null }>
  | Readonly<{ kind: "working_conflict" }>
  | Readonly<{ kind: "not_found" }>;

function protectedStateFromSnapshot(
  snapshot: Readonly<{ payload: Uint8Array }> | null,
): ReconstructionYjsState | null {
  if (!snapshot) return null;
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, new Uint8Array(snapshot.payload));
    return ReconstructionYjsStateSchema.parse({
      architecture: document
        .getMap(ARCHITECTURE_MAP_KEY)
        .get(ARCHITECTURE_CURRENT_KEY),
      layout: document
        .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
        .get(ARCHITECTURE_CURRENT_KEY),
    });
  } finally {
    document.destroy();
  }
}

function isRetryable(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ((error as { code?: unknown }).code === "P2034" ||
        (error as { code?: unknown }).code === "P2002"),
  );
}

function publicRevision(row: Readonly<{
  id: string;
  roomId: string;
  version: number;
  architecture: Prisma.JsonValue;
  layout: Prisma.JsonValue;
  requirements: Prisma.JsonValue;
  stage: string;
  authorType: string;
  authorId: string | null;
  rationale: string;
  createdAt: Date;
}>) {
  return ArchitectureRevisionSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
}

function publicEvent(row: Readonly<{
  id: string;
  roomId: string;
  kind: string;
  status: string;
  actorType: string;
  actorId: string | null;
  title: string;
  summary: string | null;
  details: Prisma.JsonValue | null;
  traceId: string | null;
  createdAt: Date;
}>) {
  return HistoryEventSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
}

export function createRevisionRepository({
  database,
}: Readonly<{ database: RevisionDatabase }>) {
  const transaction = async <T>(
    operation: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < TRANSACTION_RETRIES; attempt += 1) {
      try {
        return await database.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === TRANSACTION_RETRIES - 1) {
          throw error;
        }
      }
    }
    throw lastError;
  };

  const commitRevision = async (
    input: RevisionCommitInput,
  ): Promise<RevisionCommitResult> => transaction(async (client) => {
    const room = await client.room.findUnique({
      where: { id: input.roomId },
      select: { id: true, phase: true, currentRevisionId: true },
    });
    if (!room || room.phase !== "architect") return { kind: "not_found" };
    if (room.currentRevisionId !== input.baseRevisionId) {
      return {
        kind: "stale",
        currentRevisionId: room.currentRevisionId,
      };
    }
    const latestSnapshot = await client.yjsSnapshot.findFirst({
      where: { roomId: input.roomId },
      orderBy: { version: "desc" },
      select: { payload: true },
    });
    if (!isDeepStrictEqual(
      protectedStateFromSnapshot(latestSnapshot),
      input.expectedProtectedState,
    )) {
      return { kind: "working_conflict" };
    }

    const baseRevision = await client.architectureRevision.findFirst({
      where: { id: input.baseRevisionId, roomId: input.roomId },
      select: { id: true, stage: true },
    });
    if (!baseRevision) return { kind: "not_found" };

    const revisionVersion =
      ((await client.architectureRevision.aggregate({
        where: { roomId: input.roomId },
        _max: { version: true },
      }))._max.version ?? 0) + 1;
    const snapshotVersion =
      ((await client.yjsSnapshot.aggregate({
        where: { roomId: input.roomId },
        _max: { version: true },
      }))._max.version ?? 0) + 1;

    const fenced = await client.room.updateMany({
      where: {
        id: input.roomId,
        phase: "architect",
        currentRevisionId: input.baseRevisionId,
      },
      data: { currentRevisionId: input.revisionId },
    });
    if (fenced.count !== 1) {
      return { kind: "stale", currentRevisionId: room.currentRevisionId };
    }

    const revision = await client.architectureRevision.create({
      data: {
        id: input.revisionId,
        roomId: input.roomId,
        version: revisionVersion,
        architecture: input.architecture as Prisma.InputJsonValue,
        layout: input.layout as Prisma.InputJsonValue,
        requirements: input.requirements as Prisma.InputJsonValue,
        stage: baseRevision.stage,
        authorType: input.author.type,
        authorId: input.author.id,
        rationale: input.rationale,
      },
    });
    const details = {
      revisionId: input.revisionId,
      baseRevisionId: input.baseRevisionId,
      version: revisionVersion,
    };
    const event = await client.historyEvent.create({
      data: {
        id: input.eventId,
        roomId: input.roomId,
        kind: "architecture_revision_saved",
        status: "succeeded",
        actorType: input.author.type,
        actorId: input.author.id,
        title: "Architecture revision saved",
        summary: input.rationale,
        details,
        traceId: input.traceId,
      },
    });
    await client.yjsSnapshot.create({
      data: {
        roomId: input.roomId,
        version: snapshotVersion,
        payload: Buffer.from(input.snapshotPayload),
        reason: "architecture_revision",
      },
    });

    return {
      kind: "committed",
      revision: publicRevision(revision),
      event: publicEvent(event),
    };
  });

  const listHistory = async (roomId: string) => {
    const [revisionRows, eventRows] = await Promise.all([
      database.architectureRevision.findMany({
        where: { roomId },
        orderBy: { version: "desc" },
        take: 2_000,
      }),
      database.historyEvent.findMany({
        where: { roomId },
        orderBy: { createdAt: "desc" },
        take: 10_000,
      }),
    ]);
    return RevisionHistoryResponseSchema.parse({
      revisions: revisionRows.map(publicRevision),
      events: eventRows.map(publicEvent),
    });
  };

  return Object.freeze({ commitRevision, listHistory });
}

export type RevisionRepository = ReturnType<typeof createRevisionRepository>;

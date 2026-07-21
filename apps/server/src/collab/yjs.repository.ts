import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  ReconstructionYjsStateSchema,
  type ReconstructionYjsState,
} from "@architect/contracts";
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";
import { prisma } from "../db/client.js";

export type SnapshotRecord = {
  roomId: string;
  version: number;
  payload: Uint8Array;
  reason: string;
};

type SnapshotWhere = { roomId: string };

type SnapshotModel = {
  findFirst(input: {
    where: SnapshotWhere;
    orderBy: { version: "desc" };
  }): Promise<SnapshotRecord | null>;
  aggregate(input: {
    where: SnapshotWhere;
    _max: { version: true };
  }): Promise<{ _max: { version: number | null } }>;
  create(input: { data: SnapshotRecord }): Promise<SnapshotRecord>;
};

type SnapshotTransaction = {
  room: {
    findUnique(input: {
      where: { id: string };
      select: { id: true; phase: true; currentRevisionId: true };
    }): Promise<{
      id: string;
      phase: "sketch" | "reconstructing" | "architect" | "deploy";
      currentRevisionId: string | null;
    } | null>;
  };
  yjsSnapshot: Pick<SnapshotModel, "findFirst" | "aggregate" | "create">;
  transitionJob: {
    findFirst(input: {
      where: {
        id?: string;
        roomId: string;
        state?: SnapshotLeaseFence["expectedState"];
        leaseToken?: string;
        leaseExpiresAt?: { gt: Date };
        architectureRevisionId?: { not: null };
      };
      select: { id: true; architectureRevisionId: true };
    }): Promise<{ id: string; architectureRevisionId: string | null } | null>;
  };
};

export type SnapshotDatabase = {
  yjsSnapshot: SnapshotModel;
  transitionJob: SnapshotTransaction["transitionJob"];
  $transaction<T>(
    callback: (transaction: SnapshotTransaction) => Promise<T>,
    options?: { isolationLevel: "Serializable" },
  ): Promise<T>;
};

export type YjsRepository = ReturnType<typeof createYjsRepository>;

export type SnapshotLeaseFence = Readonly<{
  jobId: string;
  token: string;
  expectedState: "publishing" | "failed" | "succeeded";
}>;

export type SnapshotProtectedStateFence = Readonly<{
  kind: "protected_state";
  expectedProtectedState: ReconstructionYjsState | null;
}>;

type SnapshotWriteFence = SnapshotLeaseFence | SnapshotProtectedStateFence;

export class SnapshotLeaseLostError extends Error {
  constructor() {
    super("Reconstruction snapshot lease was lost");
    this.name = "SnapshotLeaseLostError";
  }
}

export class SnapshotRevisionLostError extends Error {
  constructor() {
    super("Snapshot architecture revision is stale");
    this.name = "SnapshotRevisionLostError";
  }
}

export class SnapshotProtectedStateLostError extends Error {
  constructor() {
    super("Snapshot protected state is stale");
    this.name = "SnapshotProtectedStateLostError";
  }
}

const MAX_WRITE_ATTEMPTS = 8;

function retryableVersionRace(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "P2034";
}

function protectedState(document: Y.Doc): ReconstructionYjsState | null {
  const architecture = document
    .getMap(ARCHITECTURE_MAP_KEY)
    .get(ARCHITECTURE_CURRENT_KEY);
  const layout = document
    .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
    .get(ARCHITECTURE_CURRENT_KEY);
  if (architecture === undefined && layout === undefined) return null;
  const parsed = ReconstructionYjsStateSchema.safeParse({
    architecture,
    layout,
  });
  if (!parsed.success) throw new SnapshotRevisionLostError();
  return parsed.data;
}

function protectedStateFromSnapshot(
  snapshot: SnapshotRecord | null,
): ReconstructionYjsState | null {
  if (!snapshot) return null;
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, new Uint8Array(snapshot.payload));
    return protectedState(document);
  } finally {
    document.destroy();
  }
}

export function createYjsRepository(
  database: SnapshotDatabase,
  { now = () => new Date() }: Readonly<{ now?: () => Date }> = {},
) {
  return {
    async loadRoomDocument(roomId: string): Promise<Y.Doc> {
      const document = new Y.Doc();
      const latest = await database.yjsSnapshot.findFirst({
        where: { roomId },
        orderBy: { version: "desc" },
      });

      if (latest) {
        Y.applyUpdate(document, new Uint8Array(latest.payload));
      }

      return document;
    },

    async persistRoomSnapshot(
      roomId: string,
      document: Y.Doc,
      reason: string,
      fence?: SnapshotWriteFence,
    ): Promise<number> {
      const candidateProtectedState = protectedState(document);
      const candidateRevisionId =
        candidateProtectedState?.architecture.revisionId ?? null;
      const payload = Buffer.from(Y.encodeStateAsUpdate(document));

      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        try {
          return await database.$transaction(
            async (transaction) => {
              let activeLease: {
                id: string;
                architectureRevisionId: string | null;
              } | null = null;
              const leaseFence = fence && !("kind" in fence) ? fence : null;
              const protectedStateFence = fence && "kind" in fence
                ? fence
                : null;
              if (leaseFence) {
                activeLease = await transaction.transitionJob.findFirst({
                  where: {
                    id: leaseFence.jobId,
                    roomId,
                    state: leaseFence.expectedState,
                    leaseToken: leaseFence.token,
                    leaseExpiresAt: { gt: now() },
                  },
                  select: { id: true, architectureRevisionId: true },
                });
                if (!activeLease) throw new SnapshotLeaseLostError();
              }
              const room = await transaction.room.findUnique({
                where: { id: roomId },
                select: { id: true, phase: true, currentRevisionId: true },
              });
              if (!room) throw new SnapshotRevisionLostError();
              if (room.currentRevisionId !== null) {
                if (candidateRevisionId !== room.currentRevisionId) {
                  throw new SnapshotRevisionLostError();
                }
              } else if (candidateRevisionId !== null) {
                if (
                  leaseFence?.expectedState !== "publishing" ||
                  activeLease?.architectureRevisionId !== candidateRevisionId
                ) {
                  throw new SnapshotRevisionLostError();
                }
              } else if (room.phase === "reconstructing") {
                const publishingArchitecture =
                  await transaction.transitionJob.findFirst({
                    where: {
                      roomId,
                      state: "publishing",
                      architectureRevisionId: { not: null },
                    },
                    select: { id: true, architectureRevisionId: true },
                  });
                if (publishingArchitecture) {
                  throw new SnapshotRevisionLostError();
                }
              }
              const latestSnapshot =
                await transaction.yjsSnapshot.findFirst({
                  where: { roomId },
                  orderBy: { version: "desc" },
                });
              const latestProtectedState =
                protectedStateFromSnapshot(latestSnapshot);
              const expectedProtectedState = protectedStateFence
                ? protectedStateFence.expectedProtectedState
                : candidateProtectedState;
              const authorizedReconstructionArchitecture =
                room.currentRevisionId === null &&
                candidateRevisionId !== null &&
                leaseFence?.expectedState === "publishing" &&
                activeLease?.architectureRevisionId === candidateRevisionId;
              if (
                !authorizedReconstructionArchitecture &&
                !isDeepStrictEqual(
                  latestProtectedState,
                  expectedProtectedState,
                )
              ) {
                throw new SnapshotProtectedStateLostError();
              }
              const latest = await transaction.yjsSnapshot.aggregate({
                where: { roomId },
                _max: { version: true },
              });
              const version = (latest._max.version ?? 0) + 1;
              await transaction.yjsSnapshot.create({
                data: { roomId, version, payload, reason },
              });
              return version;
            },
            { isolationLevel: "Serializable" },
          );
        } catch (error) {
          if (!retryableVersionRace(error) || attempt === MAX_WRITE_ATTEMPTS) {
            throw error;
          }
        }
      }

      throw new Error("Snapshot persistence attempts exhausted");
    },
  };
}

const defaultRepository = createYjsRepository(
  prisma as unknown as SnapshotDatabase,
);

export const loadRoomDocument = defaultRepository.loadRoomDocument;
export const persistRoomSnapshot = defaultRepository.persistRoomSnapshot;

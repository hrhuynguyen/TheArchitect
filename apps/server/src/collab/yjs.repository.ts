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
  yjsSnapshot: Pick<SnapshotModel, "aggregate" | "create">;
  transitionJob: {
    findFirst(input: {
      where: {
        id: string;
        roomId: string;
        state: SnapshotLeaseFence["expectedState"];
        leaseToken: string;
        leaseExpiresAt: { gt: Date };
      };
      select: { id: true };
    }): Promise<{ id: string } | null>;
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

export class SnapshotLeaseLostError extends Error {
  constructor() {
    super("Reconstruction snapshot lease was lost");
    this.name = "SnapshotLeaseLostError";
  }
}

const MAX_WRITE_ATTEMPTS = 8;

function retryableVersionRace(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "P2034";
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
      fence?: SnapshotLeaseFence,
    ): Promise<number> {
      const payload = Buffer.from(Y.encodeStateAsUpdate(document));

      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        try {
          return await database.$transaction(
            async (transaction) => {
              if (fence) {
                const activeLease = await transaction.transitionJob.findFirst({
                  where: {
                    id: fence.jobId,
                    roomId,
                    state: fence.expectedState,
                    leaseToken: fence.token,
                    leaseExpiresAt: { gt: now() },
                  },
                  select: { id: true },
                });
                if (!activeLease) throw new SnapshotLeaseLostError();
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

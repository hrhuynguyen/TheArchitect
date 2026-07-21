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
};

export type SnapshotDatabase = {
  yjsSnapshot: SnapshotModel;
  $transaction<T>(
    callback: (transaction: SnapshotTransaction) => Promise<T>,
    options?: { isolationLevel: "Serializable" },
  ): Promise<T>;
};

export type YjsRepository = ReturnType<typeof createYjsRepository>;

const MAX_WRITE_ATTEMPTS = 8;

function retryableVersionRace(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "P2034";
}

export function createYjsRepository(database: SnapshotDatabase) {
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
    ): Promise<number> {
      const payload = Buffer.from(Y.encodeStateAsUpdate(document));

      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        try {
          return await database.$transaction(
            async (transaction) => {
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

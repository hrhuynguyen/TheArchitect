import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createActiveDocumentRegistry } from "../collab/active-document.registry.js";
import { createAwarenessRegistry } from "../collab/awareness.registry.js";
import type { VoteDatabase } from "./vote.service.js";

const integrationRequested = process.env.RUN_VOTE_DATABASE_TESTS === "true";
const testDatabaseUrl = process.env.VOTE_TEST_DATABASE_URL;

if (integrationRequested && !testDatabaseUrl) {
  throw new Error(
    "VOTE_TEST_DATABASE_URL is required when RUN_VOTE_DATABASE_TESTS=true",
  );
}

const databaseDescribe =
  integrationRequested && testDatabaseUrl ? describe : describe.skip;

type DatabaseClient = typeof import("../db/client.js").prisma;
type CreateVoteService = typeof import("./vote.service.js").createVoteService;

databaseDescribe("Prisma readiness transition concurrency", () => {
  let database: DatabaseClient;
  let createVoteService: CreateVoteService;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl!;
    [{ prisma: database }, { createVoteService }] = await Promise.all([
      import("../db/client.js"),
      import("./vote.service.js"),
    ]);
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it("resolves a real PostgreSQL unique race to one job and one claimed caller", async () => {
    const room = await database.room.create({
      data: {
        mode: "shared",
        ownerTokenHash: `vote-integration-${randomUUID()}`,
      },
    });
    const awarenessRegistry = createAwarenessRegistry();
    const documents = createActiveDocumentRegistry({
      async loadRoomDocument() {
        return new Y.Doc();
      },
    });
    const service = createVoteService({
      awarenessRegistry,
      database: database as unknown as VoteDatabase,
      documents,
      async persistRoomSnapshot() {
        return 1;
      },
    });

    try {
      const [first, second] = await Promise.all([
        service.claimTransition(room.id, 7, "ready"),
        service.claimTransition(room.id, 7, "ready"),
      ]);

      expect(new Set([first.jobId, second.jobId]).size).toBe(1);
      expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
      const durableJob = await database.transitionJob.findFirstOrThrow({
        where: { roomId: room.id, sourceRevision: 7, kind: "ready" },
        select: { sourceRevision: true },
      });
      expect(first.sourceSnapshotVersion).toBe(durableJob.sourceRevision);
      expect(second.sourceSnapshotVersion).toBe(durableJob.sourceRevision);
      expect(
        await database.transitionJob.count({
          where: { roomId: room.id, sourceRevision: 7, kind: "ready" },
        }),
      ).toBe(1);
      expect(
        await database.room.findUnique({
          where: { id: room.id },
          select: { phase: true },
        }),
      ).toEqual({ phase: "reconstructing" });
    } finally {
      await service.destroy();
      await documents.destroy();
      awarenessRegistry.destroy();
      await database.room.deleteMany({ where: { id: room.id } });
    }
  });
});

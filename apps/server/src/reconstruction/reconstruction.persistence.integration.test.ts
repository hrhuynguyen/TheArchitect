import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReconstructionRepository } from "./reconstruction.repository.js";

const integrationRequested = process.env.RUN_RECONSTRUCTION_DATABASE_TESTS === "true";
const testDatabaseUrl = process.env.RECONSTRUCTION_TEST_DATABASE_URL;

if (integrationRequested && !testDatabaseUrl) {
  throw new Error(
    "RECONSTRUCTION_TEST_DATABASE_URL is required when RUN_RECONSTRUCTION_DATABASE_TESTS=true",
  );
}

const databaseDescribe = integrationRequested && testDatabaseUrl ? describe : describe.skip;

databaseDescribe("Prisma reconstruction leases", () => {
  let database: typeof import("../db/client.js").prisma;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl!;
    ({ prisma: database } = await import("../db/client.js"));
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it("allows one concurrent attempt claimant and preserves its input binding", async () => {
    const room = await database.room.create({
      data: { mode: "shared", phase: "reconstructing", ownerTokenHash: `reconstruction-${randomUUID()}` },
    });
    const job = await database.transitionJob.create({
      data: { roomId: room.id, sourceRevision: 7, kind: "ready", traceId: randomUUID() },
    });
    const repository = createReconstructionRepository({
      database,
      leaseOwner: "integration-worker",
      primaryProvider: { provider: "openai", model: "integration-model" },
    });

    try {
      const [first, second] = await Promise.all([
        repository.claimAttempt({ roomId: room.id, jobId: job.id, sourceSnapshotVersion: 7, participantId: "participant-a", inputDigest: "digest-a" }),
        repository.claimAttempt({ roomId: room.id, jobId: job.id, sourceSnapshotVersion: 7, participantId: "participant-b", inputDigest: "digest-b" }),
      ]);
      expect([first.kind, second.kind].sort()).toEqual(["claimed", "in_flight"]);
      const durable = await database.transitionJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(durable.attempt).toBe(1);
      expect(["participant-a", "participant-b"]).toContain(durable.attemptParticipantId);
      expect(await database.aiRun.count({ where: { roomId: room.id, status: "running" } })).toBe(1);
    } finally {
      await database.room.delete({ where: { id: room.id } });
    }
  });
});

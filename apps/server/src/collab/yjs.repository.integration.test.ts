import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationRequested = process.env.RUN_YJS_DATABASE_TESTS === "true";
const testDatabaseUrl = process.env.YJS_TEST_DATABASE_URL;

if (integrationRequested && !testDatabaseUrl) {
  throw new Error(
    "YJS_TEST_DATABASE_URL is required when RUN_YJS_DATABASE_TESTS=true",
  );
}

const databaseDescribe =
  integrationRequested && testDatabaseUrl ? describe : describe.skip;

type DatabaseClient = typeof import("../db/client.js").prisma;
type PersistRoomSnapshot =
  typeof import("./yjs.repository.js").persistRoomSnapshot;
type LoadRoomDocument =
  typeof import("./yjs.repository.js").loadRoomDocument;

databaseDescribe("Prisma Yjs snapshot persistence", () => {
  let database: DatabaseClient;
  let loadRoomDocument: LoadRoomDocument;
  let persistRoomSnapshot: PersistRoomSnapshot;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl!;
    [{ prisma: database }, { loadRoomDocument, persistRoomSnapshot }] =
      await Promise.all([
        import("../db/client.js"),
        import("./yjs.repository.js"),
      ]);
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it("allocates unique monotonic versions for concurrent PostgreSQL writers", async () => {
    const room = await database.room.create({
      data: { mode: "shared", ownerTokenHash: "integration-test-hash" },
    });

    try {
      const versions = await Promise.all(
        Array.from({ length: 4 }, async (_, writer) => {
          const document = new Y.Doc();
          document.getMap("writers").set(String(writer), true);
          return persistRoomSnapshot(room.id, document, `writer-${writer}`);
        }),
      );

      expect(versions.sort((left, right) => left - right)).toEqual([1, 2, 3, 4]);
      const stored = await database.yjsSnapshot.findMany({
        where: { roomId: room.id },
        orderBy: { version: "asc" },
      });
      expect(stored.map(({ version }) => version)).toEqual([1, 2, 3, 4]);
      expect(stored.every(({ payload }) => payload.byteLength > 0)).toBe(true);

      await database.$disconnect();
      const restored = await loadRoomDocument(room.id);
      expect(restored.getMap("writers").size).toBe(1);
      restored.destroy();
    } finally {
      await database.room.deleteMany({ where: { id: room.id } });
    }
  });
});

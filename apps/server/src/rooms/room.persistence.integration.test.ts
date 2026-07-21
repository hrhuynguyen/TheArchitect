import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationRequested =
  process.env.RUN_ROOM_DATABASE_TESTS === "true";
const testDatabaseUrl = process.env.ROOM_TEST_DATABASE_URL;

if (integrationRequested && !testDatabaseUrl) {
  throw new Error(
    "ROOM_TEST_DATABASE_URL is required when RUN_ROOM_DATABASE_TESTS=true",
  );
}

const databaseDescribe =
  integrationRequested && testDatabaseUrl ? describe : describe.skip;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DatabaseClient = typeof import("../db/client.js").prisma;
type CreateRoomService = typeof import("./room.service.js").createRoomService;

databaseDescribe("Prisma room persistence", () => {
  let database: DatabaseClient;
  let service: ReturnType<CreateRoomService>;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl!;
    const [{ prisma }, { createRoomService, prismaRoomRepository }] =
      await Promise.all([
        import("../db/client.js"),
        import("./room.service.js"),
      ]);
    database = prisma;
    service = createRoomService(prismaRoomRepository, {
      ownerTokenPepper: "integration-pepper".repeat(2),
    });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it("persists a room and its creator atomically across reconnect", async () => {
    const marker = randomUUID();
    let roomId: string | undefined;

    try {
      const created = await service.create({
        name: `Creator ${marker}`,
        color: "#10A37F",
        mode: "shared",
      });
      roomId = created.room.id;
      expect(roomId).toMatch(uuidPattern);
      expect(created.participantId).toMatch(uuidPattern);

      await database.$disconnect();
      const persisted = await database.room.findUnique({
        where: { id: roomId },
        include: { participants: true },
      });

      expect(persisted).not.toBeNull();
      expect(persisted!.participants).toEqual([
        expect.objectContaining({
          id: created.participantId,
          name: `Creator ${marker}`,
          color: "#10A37F",
        }),
      ]);
      expect(persisted!.ownerTokenHash).not.toContain(created.ownerToken);
    } finally {
      if (roomId) {
        await database.room.deleteMany({ where: { id: roomId } });
      }
    }
  });

  it("persists concurrent shared-room joins without losing participants", async () => {
    const marker = randomUUID();
    let roomId: string | undefined;

    try {
      const created = await service.create({
        name: `Creator ${marker}`,
        color: "#10A37F",
        mode: "shared",
      });
      roomId = created.room.id;

      const joined = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          service.join(roomId!, {
            name: `Guest ${index} ${marker}`,
            color: `#00000${index}`,
          }),
        ),
      );
      expect(new Set(joined.map(({ participantId }) => participantId)).size).toBe(
        6,
      );

      await database.$disconnect();
      const persisted = await database.room.findUnique({
        where: { id: roomId },
        include: { participants: true },
      });

      expect(persisted).not.toBeNull();
      expect(persisted!.participants).toHaveLength(7);
      expect(
        new Set(persisted!.participants.map(({ id }) => id)).size,
      ).toBe(7);
      for (let index = 0; index < 6; index += 1) {
        expect(persisted!.participants).toContainEqual(
          expect.objectContaining({ name: `Guest ${index} ${marker}` }),
        );
      }
    } finally {
      if (roomId) {
        await database.room.deleteMany({ where: { id: roomId } });
      }
    }
  });
});

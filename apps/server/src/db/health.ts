import type { PrismaClient } from "@prisma/client";
import { prisma } from "./client.js";

type DatabaseHealthClient = Pick<PrismaClient, "$queryRaw">;

export async function databaseHealth(
  client: DatabaseHealthClient = prisma,
): Promise<{ ok: true }> {
  await client.$queryRaw`SELECT 1 AS value`;

  return { ok: true };
}

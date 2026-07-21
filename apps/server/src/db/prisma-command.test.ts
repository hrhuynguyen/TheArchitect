import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPrismaCommand } from "./prisma-command";

async function withSafeEnvFile(
  contents: string,
  run: (envFilePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "architect-prisma-env-"));
  const envFilePath = join(directory, ".env");

  try {
    await writeFile(envFilePath, contents);
    await run(envFilePath);
  } finally {
    await rm(directory, { recursive: true });
  }
}

describe("runPrismaCommand", () => {
  it("loads DATABASE_URL from an env file before spawning the command", async () => {
    await withSafeEnvFile(
      "DATABASE_URL=postgresql://safe-from-file/example\n",
      async (envFilePath) => {
        const environment = { ...process.env };
        delete environment.DATABASE_URL;

        await expect(
          runPrismaCommand(["validate"], {
            envFilePath,
            environment,
            stdio: "ignore",
          }),
        ).resolves.toBe(0);
      },
    );
  });

  it("preserves an exported DATABASE_URL over the env file", async () => {
    await withSafeEnvFile(
      "DATABASE_URL=mysql://safe-from-file/example\n",
      async (envFilePath) => {
        const environment = {
          ...process.env,
          DATABASE_URL: "postgresql://safe-from-process/example",
        };

        await expect(
          runPrismaCommand(["validate"], {
            envFilePath,
            environment,
            stdio: "ignore",
          }),
        ).resolves.toBe(0);
      },
    );
  });
});

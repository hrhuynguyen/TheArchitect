import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRootEnv, rootEnvPath } from "./load-env";

describe("loadRootEnv", () => {
  it("resolves the env file from the repository root", () => {
    expect(rootEnvPath).toBe(
      fileURLToPath(new URL("../../../../.env", import.meta.url)),
    );
  });

  it("loads root env values without returning parsed secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "architect-env-"));
    const envFilePath = join(directory, ".env");
    const targetEnv: NodeJS.ProcessEnv = {};

    try {
      await writeFile(envFilePath, "DATABASE_URL=postgresql://from-file\n");

      expect(loadRootEnv(targetEnv, envFilePath)).toBeUndefined();
      expect(targetEnv.DATABASE_URL).toBe("postgresql://from-file");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("preserves values already supplied by the process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "architect-env-"));
    const envFilePath = join(directory, ".env");
    const targetEnv: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgresql://from-process",
    };

    try {
      await writeFile(envFilePath, "DATABASE_URL=postgresql://from-file\n");

      loadRootEnv(targetEnv, envFilePath);

      expect(targetEnv.DATABASE_URL).toBe("postgresql://from-process");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("allows process-only configuration when the root env file is absent", () => {
    const targetEnv: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgresql://from-process",
    };

    expect(() => loadRootEnv(targetEnv, "/missing/architect/.env")).not.toThrow();
    expect(targetEnv.DATABASE_URL).toBe("postgresql://from-process");
  });
});

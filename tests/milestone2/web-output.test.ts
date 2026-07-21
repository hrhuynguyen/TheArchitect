import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Milestone 2 owned web output", () => {
  it("builds in an owned project and leaves the source checkout untouched", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "architect-output-test-"));
    const repositoryRoot = path.join(sandbox, "repository");
    const webRoot = path.join(repositoryRoot, "apps", "web");
    const sharedOutput = path.join(webRoot, ".next");
    const tempRoot = path.join(sandbox, "owned");
    const sentinel = path.join(sharedOutput, "sentinel.txt");
    const staleDuplicate = path.join(sharedOutput, "types", "routes.d 2.ts");
    const sourceNextEnv = path.join(webRoot, "next-env.d.ts");
    const sourceTsconfig = path.join(webRoot, "tsconfig.json");
    const nextEnvContents = "/// <reference types=\"next\" />\n";
    const tsconfigContents = '{"extends":"../../tsconfig.base.json"}\n';
    await mkdir(path.dirname(staleDuplicate), { recursive: true });
    await mkdir(path.join(webRoot, "src"), { recursive: true });
    await mkdir(path.join(repositoryRoot, "node_modules"), { recursive: true });
    await mkdir(tempRoot, { recursive: true });
    await writeFile(sentinel, "user-owned sentinel\n");
    await writeFile(staleDuplicate, "ignored stale output\n");
    await writeFile(sourceNextEnv, nextEnvContents);
    await writeFile(sourceTsconfig, tsconfigContents);
    await writeFile(path.join(webRoot, "next.config.ts"), "export default {};\n");
    await writeFile(path.join(webRoot, "package.json"), '{"private":true}\n');
    await writeFile(path.join(webRoot, "src", "page.tsx"), "export default 1;\n");
    await writeFile(path.join(repositoryRoot, "tsconfig.base.json"), "{}\n");
    try {
      const module = await import("./web-output.js").catch(() => null);

      expect(
        module,
        "Milestone 2 requires a unique, exactly-cleaned web project",
      ).not.toBeNull();
      const project = await module!.createOwnedWebProject({
        repositoryRoot,
        tempRoot,
      });
      expect(project.webRoot).not.toBe(webRoot);
      expect(project.outputPath).not.toBe(sharedOutput);
      expect(path.resolve(project.webRoot, project.distDir)).toBe(
        project.outputPath,
      );
      await expect(
        readFile(path.join(project.webRoot, "next-env.d.ts"), "utf8"),
      ).resolves.toBe(nextEnvContents);
      await expect(
        readFile(path.join(project.webRoot, "tsconfig.json"), "utf8"),
      ).resolves.toBe(tsconfigContents);
      await expect(
        readFile(path.join(project.webRoot, "src", "page.tsx"), "utf8"),
      ).resolves.toBe("export default 1;\n");
      await writeFile(path.join(project.outputPath, "BUILD_ID"), "owned build\n");

      await project.cleanup();
      await project.cleanup();

      await expect(stat(project.projectRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(sentinel, "utf8")).resolves.toBe(
        "user-owned sentinel\n",
      );
      await expect(readFile(staleDuplicate, "utf8")).resolves.toBe(
        "ignored stale output\n",
      );
      await expect(readFile(sourceNextEnv, "utf8")).resolves.toBe(
        nextEnvContents,
      );
      await expect(readFile(sourceTsconfig, "utf8")).resolves.toBe(
        tsconfigContents,
      );
    } finally {
      await rm(sandbox, { force: true, recursive: true });
    }
  });
});

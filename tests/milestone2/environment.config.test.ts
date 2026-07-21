import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadConfig(distDir: string | undefined) {
  vi.stubEnv("ARCHITECT_NEXT_DIST_DIR", distDir);
  vi.resetModules();
  return (await import("../../apps/web/next.config.js")).default;
}

describe("Milestone 2 Next output isolation", () => {
  it("preserves the normal Next output when the harness variable is unset", async () => {
    const config = await loadConfig(undefined);

    expect(config).not.toHaveProperty("distDir");
  });

  it("accepts only the exact harness-owned output name", async () => {
    const config = await loadConfig(".milestone2-next");

    expect(config.distDir).toBe(".milestone2-next");
  });

  it.each([
    ["parent traversal", ".."],
    ["workspace traversal", "../.."],
    ["an absolute path", path.join(os.tmpdir(), "architect-outside")],
    ["the shared Next output", ".next"],
    ["an arbitrary output name", "build-output"],
    ["an empty value", ""],
  ])("rejects %s before Next can build", async (_description, value) => {
    await expect(loadConfig(value)).rejects.toThrow(
      'ARCHITECT_NEXT_DIST_DIR must be ".milestone2-next" when set',
    );
  });
});

import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Milestone 2 Next output isolation", () => {
  it("selects the exact harness-owned distDir instead of shared .next", async () => {
    const webRoot = path.resolve(process.cwd(), "apps/web");
    const ownedOutput = path.join(os.tmpdir(), "architect-milestone2-next-owned");
    const distDir = path.relative(webRoot, ownedOutput);
    vi.stubEnv("ARCHITECT_NEXT_DIST_DIR", distDir);
    vi.resetModules();

    const config = (await import("../../apps/web/next.config.js")).default;

    expect(config.distDir).toBe(distDir);
    expect(path.resolve(webRoot, config.distDir!)).toBe(ownedOutput);
    expect(path.resolve(webRoot, config.distDir!)).not.toBe(
      path.join(webRoot, ".next"),
    );
  });
});

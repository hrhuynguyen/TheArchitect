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

describe("Milestone 2 server environment isolation", () => {
  it("owns deterministic AI configuration over caller provider settings", async () => {
    const { createMilestone2ServerEnv } = await import("./environment.js");

    const result = createMilestone2ServerEnv(
      {
        AI_PROVIDER: "openai",
        ANTHROPIC_API_KEY: "caller-anthropic-key",
        ANTHROPIC_MODEL: "caller-anthropic-model",
        OPENAI_API_KEY: "caller-openai-key",
      },
      {
        cookieSigningSecret: "test-cookie-secret",
        httpPort: 31_001,
        ownerTokenPepper: "test-owner-pepper",
        webUrl: "http://127.0.0.1:3100",
        wsPort: 31_002,
      },
    );

    expect(result).toMatchObject({
      AI_PROVIDER: "test",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "",
      COOKIE_SIGNING_SECRET: "test-cookie-secret",
      HTTP_PORT: "31001",
      NODE_ENV: "test",
      OPENAI_API_KEY: "",
      OWNER_TOKEN_PEPPER: "test-owner-pepper",
      PUBLIC_APP_URL: "http://127.0.0.1:3100",
      WS_PORT: "31002",
    });
  });
});

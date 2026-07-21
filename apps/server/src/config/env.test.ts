import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const validSecrets = {
  DATABASE_URL: "postgresql://architect:architect@localhost:5432/architect",
  COOKIE_SIGNING_SECRET: "cookie-signing-secret-at-least-32-characters",
  OWNER_TOKEN_PEPPER: "owner-token-pepper-at-least-32-characters",
};

describe("parseEnv", () => {
  it("rejects missing owner-token pepper", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgresql://db/test",
        COOKIE_SIGNING_SECRET: validSecrets.COOKIE_SIGNING_SECRET,
      }),
    ).toThrow("OWNER_TOKEN_PEPPER");
  });

  it("applies server defaults and coerces configured ports", () => {
    expect(
      parseEnv({
        ...validSecrets,
        HTTP_PORT: "4101",
        WS_PORT: "4102",
      }),
    ).toEqual({
      NODE_ENV: "development",
      HTTP_PORT: 4101,
      WS_PORT: 4102,
      PUBLIC_APP_URL: "http://localhost:3000",
      ...validSecrets,
      OPENAI_API_KEY: "",
      AI_PROVIDER: "openai",
      OPENAI_VISION_MODEL: "gpt-5.6",
      OPENAI_AGENT_MODEL: "gpt-5.6",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "",
      AI_PROVIDER_TIMEOUT_MS: 60_000,
      AI_PROVIDER_MAX_RETRIES: 1,
      AI_OUTPUT_REPAIR_ATTEMPTS: 1,
      ENABLE_DEBUG_ROUTES: false,
      LOCALSTACK_URL: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      AWS_ALLOWED_REGIONS: "us-east-1",
      AWS_STACK_PREFIX: "architect",
      AWS_DEPLOY_ROLE_ARN: "",
    });
  });

  it("rejects unsafe AWS stack prefixes", () => {
    expect(() =>
      parseEnv({
        ...validSecrets,
        AWS_STACK_PREFIX: "1-invalid",
      }),
    ).toThrow("AWS_STACK_PREFIX");
  });

  it.each([
    ["AI_PROVIDER_TIMEOUT_MS", "999"],
    ["AI_PROVIDER_TIMEOUT_MS", "120001"],
    ["AI_PROVIDER_MAX_RETRIES", "-1"],
    ["AI_PROVIDER_MAX_RETRIES", "3"],
    ["AI_OUTPUT_REPAIR_ATTEMPTS", "-1"],
    ["AI_OUTPUT_REPAIR_ATTEMPTS", "3"],
  ])("rejects an out-of-range %s setting", (key, value) => {
    expect(() =>
      parseEnv({
        ...validSecrets,
        [key]: value,
      }),
    ).toThrow(key);
  });

  it.each([
    ["false", false],
    ["true", true],
    [false, false],
    [true, true],
  ])("parses an explicit debug-routes value of %j", (input, expected) => {
    expect(
      parseEnv({
        ...validSecrets,
        ENABLE_DEBUG_ROUTES: input,
      } as unknown as NodeJS.ProcessEnv).ENABLE_DEBUG_ROUTES,
    ).toBe(expected);
  });

  it("rejects arbitrary debug-routes strings", () => {
    expect(() =>
      parseEnv({
        ...validSecrets,
        ENABLE_DEBUG_ROUTES: "anything",
      }),
    ).toThrow("ENABLE_DEBUG_ROUTES");
  });

  it("requires Anthropic key and model to be configured together", () => {
    for (const partial of [
      { ANTHROPIC_API_KEY: "configured-key", ANTHROPIC_MODEL: "" },
      { ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "configured-model" },
    ]) {
      expect(() => parseEnv({ ...validSecrets, ...partial })).toThrow(
        "ANTHROPIC_API_KEY",
      );
    }
  });
});

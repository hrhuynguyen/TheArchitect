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
});

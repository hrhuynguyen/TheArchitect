import { z } from "zod";

const serverEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HTTP_PORT: z.coerce.number().int().positive().default(3001),
  WS_PORT: z.coerce.number().int().positive().default(3002),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  COOKIE_SIGNING_SECRET: z.string().min(32),
  OWNER_TOKEN_PEPPER: z.string().min(32),
  OPENAI_API_KEY: z.string().default(""),
  AI_PROVIDER: z.enum(["openai", "test"]).default("openai"),
  OPENAI_VISION_MODEL: z.string().default("gpt-5.6"),
  OPENAI_AGENT_MODEL: z.string().default("gpt-5.6"),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default(""),
  ENABLE_DEBUG_ROUTES: z
    .union([
      z.boolean(),
      z.enum(["true", "false"]).transform((value) => value === "true"),
    ])
    .default(false),
  LOCALSTACK_URL: z.string().url().default("http://localhost:4566"),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ALLOWED_REGIONS: z.string().default("us-east-1"),
  AWS_STACK_PREFIX: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]+$/)
    .default("architect"),
  AWS_DEPLOY_ROLE_ARN: z.string().default(""),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseEnv(input: NodeJS.ProcessEnv): ServerEnv {
  return serverEnvSchema.parse(input);
}

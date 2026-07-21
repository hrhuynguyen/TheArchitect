import type { FastifyBaseLogger, FastifyServerOptions } from "fastify";
import type { SnapshotPersistenceFailure } from "./collab/snapshot.service.js";

const allowedErrorNames = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "PrismaClientInitializationError",
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
  "PrismaClientValidationError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const safeErrorCode = /^(?:P\d{4}|E[A-Z0-9_]{1,31})$/;

export type SafeErrorSummary = {
  name: string;
  code?: string;
};

export function summarizePersistenceError(error: unknown): SafeErrorSummary {
  let isError = false;
  try {
    isError = error instanceof Error;
  } catch {
    return { name: "UnknownError" };
  }
  if (!isError) return { name: "UnknownError" };

  let rawName: unknown;
  let rawCode: unknown;
  try {
    rawName = (error as Error).name;
    rawCode = (error as Error & { code?: unknown }).code;
  } catch {
    return { name: "Error" };
  }

  const name =
    typeof rawName === "string" && allowedErrorNames.has(rawName)
      ? rawName
      : "Error";
  return {
    name,
    ...(typeof rawCode === "string" && safeErrorCode.test(rawCode)
      ? { code: rawCode }
      : {}),
  };
}

type RuntimeLoggerOptions = NonNullable<
  Exclude<FastifyServerOptions["logger"], boolean>
>;

type LoggerStream = {
  write(message: string): void;
};

const runtimeRedactPaths = [
  "authorization",
  "cookie",
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "AI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ai.apiKey",
  "apiKey",
  "COOKIE_SIGNING_SECRET",
  "DATABASE_URL",
  "OWNER_TOKEN_PEPPER",
  "ownerToken",
  "participantToken",
  "secret",
  "token",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "aws.accessKeyId",
  "aws.secretAccessKey",
  "aws.sessionToken",
  "credentials.accessKeyId",
  "credentials.secretAccessKey",
  "credentials.sessionToken",
];

export function createRuntimeLoggerOptions(
  stream?: LoggerStream,
): RuntimeLoggerOptions {
  return {
    level: "info",
    redact: {
      paths: runtimeRedactPaths,
      censor: "[REDACTED]",
    },
    ...(stream ? { stream } : {}),
  };
}

export function logPersistenceFailure(
  logger: Pick<FastifyBaseLogger, "error">,
  { error, reason, revision, roomId }: SnapshotPersistenceFailure,
): void {
  logger.error(
    {
      roomId,
      reason,
      revision,
      error: summarizePersistenceError(error),
    },
    "Collaboration snapshot persistence failed",
  );
}

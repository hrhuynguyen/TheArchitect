import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import {
  createRuntimeLoggerOptions,
  logPersistenceFailure,
  summarizePersistenceError,
} from "./logging.js";

describe("persistence error logging", () => {
  it("summarizes an unknown error with only a normalized name and safe code", () => {
    const sentinel = "SENTINEL_SECRET_MUST_NOT_BE_LOGGED";
    const error = Object.assign(
      new Error(`database failed: ${sentinel}`, {
        cause: { authorization: sentinel },
      }),
      {
        arbitrary: sentinel,
        bytes: Buffer.from(sentinel),
        code: "P2002",
        name: "PrismaClientKnownRequestError",
      },
    );

    const summary = summarizePersistenceError(error);

    expect(summary).toEqual({
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    expect(summary).not.toHaveProperty("message");
    expect(summary).not.toHaveProperty("stack");
    expect(summary).not.toHaveProperty("cause");
    expect(summary).not.toHaveProperty("bytes");
    expect(JSON.stringify(summary)).not.toContain(sentinel);
  });

  it("normalizes arbitrary names and rejects non-token error codes", () => {
    const error = Object.assign(new Error("not logged"), {
      code: "secret/value with spaces",
      name: "SecretBearingCustomError",
    });

    expect(summarizePersistenceError(error)).toEqual({ name: "Error" });
    expect(summarizePersistenceError("raw secret")).toEqual({
      name: "UnknownError",
    });
  });

  it("does not inspect hostile unknown values", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter secret");
        },
        getPrototypeOf() {
          throw new Error("prototype secret");
        },
      },
    );

    expect(summarizePersistenceError(hostile)).toEqual({
      name: "UnknownError",
    });
  });

  it("logs only structured persistence context through a redacted runtime logger", async () => {
    const sentinel = "SENTINEL_SECRET_MUST_NOT_BE_LOGGED";
    const lines: string[] = [];
    const app = buildApp({
      logger: createRuntimeLoggerOptions({
        write: (line: string) => lines.push(line),
      }),
    });
    const error = Object.assign(
      new Error(`database failed with ${sentinel}`, {
        cause: { cookie: sentinel },
      }),
      {
        bytes: Buffer.from(sentinel),
        code: "P2002",
        token: sentinel,
      },
    );

    try {
      logPersistenceFailure(app.log, {
        roomId: "room-a",
        reason: "debounced_change",
        revision: 7,
        error,
      });
      app.log.info(
        {
          authorization: sentinel,
          cookie: sentinel,
          OPENAI_API_KEY: sentinel,
          ANTHROPIC_API_KEY: sentinel,
          COOKIE_SIGNING_SECRET: sentinel,
          DATABASE_URL: sentinel,
          OWNER_TOKEN_PEPPER: sentinel,
          AWS_SECRET_ACCESS_KEY: sentinel,
          AWS_SESSION_TOKEN: sentinel,
          req: { headers: { authorization: sentinel, cookie: sentinel } },
        },
        "redaction probe",
      );

      const records = lines.map((line) => JSON.parse(line));
      expect(records).toContainEqual(
        expect.objectContaining({
          roomId: "room-a",
          reason: "debounced_change",
          revision: 7,
          error: { name: "Error", code: "P2002" },
          msg: "Collaboration snapshot persistence failed",
        }),
      );
      expect(JSON.stringify(records)).not.toContain(sentinel);
      const failureRecord = records.find(
        ({ msg }) => msg === "Collaboration snapshot persistence failed",
      );
      expect(failureRecord).not.toHaveProperty("message");
      expect(failureRecord).not.toHaveProperty("stack");
      expect(failureRecord).not.toHaveProperty("cause");
      expect(failureRecord).not.toHaveProperty("bytes");
    } finally {
      await app.close();
    }
  });
});

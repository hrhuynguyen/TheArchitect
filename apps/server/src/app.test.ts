import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";

describe("server app", () => {
  it("enables a capturable Fastify logger only when configured", async () => {
    const lines: string[] = [];
    const app = buildApp({
      logger: {
        level: "info",
        stream: { write: (line: string) => lines.push(line) },
      },
    });

    try {
      app.log.info({ probe: "runtime" }, "logger probe");

      expect(lines.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({ probe: "runtime", msg: "logger probe" }),
      );
    } finally {
      await app.close();
    }
  });

  it("keeps the default test logger disabled", async () => {
    const app = buildApp();

    try {
      expect(app.log.info.name).toBe("noop");
    } finally {
      await app.close();
    }
  });

  it("reports service health", async () => {
    const databaseHealth = vi.fn().mockRejectedValue(new Error("offline"));
    const app = buildApp({ databaseHealth });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        service: "architect-server",
      });
      expect(databaseHealth).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("reports readiness when PostgreSQL is reachable", async () => {
    const databaseHealth = vi.fn().mockResolvedValue({ ok: true as const });
    const app = buildApp({ databaseHealth });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/ready",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(databaseHealth).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("reports unavailability when PostgreSQL cannot be reached", async () => {
    const databaseHealth = vi.fn().mockRejectedValue(new Error("offline"));
    const app = buildApp({ databaseHealth });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/ready",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false });
      expect(databaseHealth).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});

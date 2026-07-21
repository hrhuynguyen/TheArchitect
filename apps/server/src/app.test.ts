import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";

describe("server app", () => {
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

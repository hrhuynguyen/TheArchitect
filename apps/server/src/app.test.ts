import { describe, expect, it, vi } from "vitest";
import { participantCookieName } from "./auth/cookies.js";
import { signParticipant } from "./auth/participant.js";
import { buildApp } from "./app";

const reconstructionSecret =
  "app-reconstruction-cookie-secret-at-least-32-characters";

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

  it("registers reconstruction routes and closes their service", async () => {
    const envelope = {
      jobId: "job-a",
      sourceSnapshotVersion: 7,
      state: "running" as const,
      result: null,
      error: null,
    };
    const reconstructionService = {
      currentJob: vi.fn().mockResolvedValue(envelope),
      jobById: vi.fn().mockResolvedValue(envelope),
      reconstruct: vi.fn(),
      debugAnalyze: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const app = buildApp({
      reconstructionConfig: {
        nodeEnv: "test",
        cookieSigningSecret: reconstructionSecret,
        ownerTokenPepper:
          "app-reconstruction-owner-pepper-at-least-32-characters",
        enableDebugRoutes: false,
      },
      reconstructionDatabase: {
        participant: {
          async findFirst() { return { id: "participant-a" }; },
        },
        room: {
          async findUnique() { return null; },
        },
      },
      reconstructionService: reconstructionService as never,
    });

    const signed = signParticipant(
      { roomId: "room-a", participantId: "participant-a" },
      reconstructionSecret,
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/rooms/room-a/reconstruction",
      headers: {
        cookie: `${participantCookieName("room-a")}=${encodeURIComponent(signed)}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(envelope);

    await app.close();
    expect(reconstructionService.destroy).toHaveBeenCalledOnce();
  });
});

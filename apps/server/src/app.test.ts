import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

describe("server app", () => {
  it("reports service health", async () => {
    const app = buildApp();

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
    } finally {
      await app.close();
    }
  });
});

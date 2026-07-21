import Fastify from "fastify";
import { databaseHealth } from "./db/health.js";

type BuildAppOptions = {
  databaseHealth?: typeof databaseHealth;
};

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify();
  const checkDatabaseHealth = options.databaseHealth ?? databaseHealth;

  app.get("/api/health", async () => ({
    ok: true,
    service: "architect-server",
  }));

  app.get("/api/ready", async (_request, reply) => {
    try {
      return await checkDatabaseHealth();
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  return app;
}

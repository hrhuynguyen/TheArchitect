import Fastify from "fastify";

export function buildApp() {
  const app = Fastify();

  app.get("/api/health", async () => ({
    ok: true,
    service: "architect-server",
  }));

  return app;
}

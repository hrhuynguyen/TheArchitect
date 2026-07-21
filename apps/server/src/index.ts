import { buildApp } from "./app.js";
import { parseEnv } from "./config/env.js";
import { loadRootEnv } from "./config/load-env.js";
import { prisma } from "./db/client.js";
import { startServer } from "./lifecycle.js";

loadRootEnv();
const env = parseEnv(process.env);
const app = buildApp();

await startServer({
  app,
  database: prisma,
  onShutdownError(error) {
    app.log.error(error, "Graceful shutdown failed");
  },
  port: env.HTTP_PORT,
});

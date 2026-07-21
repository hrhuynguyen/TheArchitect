import { buildApp } from "./app.js";
import { parseEnv } from "./config/env.js";

const env = parseEnv(process.env);
const app = buildApp();

await app.listen({
  host: "0.0.0.0",
  port: env.HTTP_PORT,
});

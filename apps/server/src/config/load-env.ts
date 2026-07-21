import { config } from "dotenv";
import { fileURLToPath } from "node:url";

export const rootEnvPath = fileURLToPath(
  new URL("../../../../.env", import.meta.url),
);

export function loadRootEnv(
  targetEnv: NodeJS.ProcessEnv = process.env,
  envFilePath = rootEnvPath,
): void {
  config({
    override: false,
    path: envFilePath,
    processEnv: targetEnv as Record<string, string>,
    quiet: true,
  });
}

import { spawn, type StdioOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { loadRootEnv } from "../config/load-env.js";

const require = createRequire(import.meta.url);
const prismaPackagePath = require.resolve("prisma/package.json");
const prismaPackage = JSON.parse(readFileSync(prismaPackagePath, "utf8")) as {
  bin: { prisma: string };
};
const prismaCliPath = resolve(dirname(prismaPackagePath), prismaPackage.bin.prisma);

type RunPrismaCommandOptions = {
  envFilePath?: string;
  environment?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
};

export async function runPrismaCommand(
  args: string[],
  {
    envFilePath,
    environment = process.env,
    stdio = "inherit",
  }: RunPrismaCommandOptions = {},
): Promise<number> {
  loadRootEnv(environment, envFilePath);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCliPath, ...args], {
      env: environment,
      stdio,
    });

    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal !== null) {
        reject(new Error(`Prisma command terminated by ${signal}`));
        return;
      }

      resolve(exitCode ?? 1);
    });
  });
}

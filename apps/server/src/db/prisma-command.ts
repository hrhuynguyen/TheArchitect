import {
  spawn,
  type SpawnOptions,
  type StdioOptions,
} from "node:child_process";
import { constants } from "node:os";
import { loadRootEnv } from "../config/load-env.js";

type PrismaChild = {
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
};

type SpawnCommand = (
  executable: string,
  args: string[],
  options: SpawnOptions,
) => PrismaChild;

type SignalSource = {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

const spawnCommandFromPath: SpawnCommand = (executable, args, options) =>
  spawn(executable, args, options);

function exitStatusForSignal(signal: NodeJS.Signals): number {
  return 128 + constants.signals[signal];
}

type RunPrismaCommandOptions = {
  envFilePath?: string;
  environment?: NodeJS.ProcessEnv;
  signals?: SignalSource;
  spawnCommand?: SpawnCommand;
  stdio?: StdioOptions;
};

export async function runPrismaCommand(
  args: string[],
  {
    envFilePath,
    environment = process.env,
    signals = process,
    spawnCommand = spawnCommandFromPath,
    stdio = "inherit",
  }: RunPrismaCommandOptions = {},
): Promise<number> {
  const npmExecPath = environment.npm_execpath;
  if (!npmExecPath) {
    throw new Error(
      "Prisma CLI wrapper requires npm_execpath; run it through an npm script.",
    );
  }

  loadRootEnv(environment, envFilePath);

  return new Promise((resolve, reject) => {
    const child = spawnCommand(
      process.execPath,
      [
        npmExecPath,
        "exec",
        "--offline",
        "--yes=false",
        "--",
        "prisma",
        ...args,
      ],
      {
        env: environment,
        shell: false,
        stdio,
      },
    );
    let settled = false;

    const forwardSigint = () => {
      child.kill("SIGINT");
    };
    const forwardSigterm = () => {
      child.kill("SIGTERM");
    };
    const cleanup = () => {
      signals.removeListener("SIGINT", forwardSigint);
      signals.removeListener("SIGTERM", forwardSigterm);
    };
    const settle = (complete: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      complete();
    };

    signals.on("SIGINT", forwardSigint);
    signals.on("SIGTERM", forwardSigterm);

    child.once("error", (error) => {
      settle(() => reject(error));
    });
    child.once("exit", (exitCode, signal) => {
      if (signal !== null) {
        settle(() => resolve(exitStatusForSignal(signal)));
        return;
      }

      settle(() => resolve(exitCode ?? 1));
    });
  });
}

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(process.cwd());
const loopback = "127.0.0.1";

type OwnedProcess = {
  child: ChildProcess;
  label: string;
  output: string[];
};

export type Milestone2Environment = {
  databaseUrl: string;
  restartServer(): Promise<void>;
  stop(): Promise<void>;
  webUrl: string;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, loopback, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve a local test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function rememberOutput(target: string[], chunk: Buffer | string): void {
  target.push(String(chunk));
  if (target.length > 100) target.splice(0, target.length - 100);
}

function startOwnedProcess(
  label: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): OwnedProcess {
  const output: string[] = [];
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => rememberOutput(output, chunk));
  child.stderr?.on("data", (chunk) => rememberOutput(output, chunk));
  child.on("error", (error) => rememberOutput(output, error.message));
  return { child, label, output };
}

function hasExited(process: OwnedProcess): boolean {
  return process.child.exitCode !== null || process.child.signalCode !== null;
}

function processFailure(process: OwnedProcess): Error {
  const detail = process.output.join("").trim();
  return new Error(
    `${process.label} exited before becoming ready${detail ? `:\n${detail}` : ""}`,
  );
}

async function waitFor(
  description: string,
  probe: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${description}`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}

async function waitForHttp(
  process: OwnedProcess,
  url: string,
): Promise<void> {
  await waitFor(`${process.label} at ${url}`, async () => {
    if (hasExited(process)) throw processFailure(process);
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  });
}

async function stopOwnedProcess(process: OwnedProcess | undefined): Promise<void> {
  if (!process || hasExited(process)) return;
  const exited = once(process.child, "exit");
  process.child.kill("SIGTERM");
  const timedOut = delay(10_000).then(() => "timeout" as const);
  if ((await Promise.race([exited, timedOut])) === "timeout") {
    if (process.child.exitCode === null) {
      process.child.kill("SIGKILL");
      await exited;
    }
  }
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    cwd: repositoryRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

function postgresPort(input: string): number {
  const match = input.match(/127\.0\.0\.1:(\d+)$/m);
  if (!match) throw new Error(`Unexpected Docker port mapping: ${input}`);
  return Number(match[1]);
}

export async function startMilestone2Environment(): Promise<Milestone2Environment> {
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const containerName = `architect-milestone2-${suffix}`;
  const cookieSigningSecret = `milestone2-${randomUUID()}`;
  const ownerTokenPepper = `milestone2-${randomUUID()}`;
  const [httpPort, wsPort, webPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
  const httpUrl = `http://${loopback}:${httpPort}`;
  const webUrl = `http://${loopback}:${webPort}`;
  let containerStarted = false;
  let serverProcess: OwnedProcess | undefined;
  let webProcess: OwnedProcess | undefined;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const failures: unknown[] = [];
    for (const process of [webProcess, serverProcess]) {
      try {
        await stopOwnedProcess(process);
      } catch (error) {
        failures.push(error);
      }
    }
    if (containerStarted) {
      try {
        await docker(["rm", "--force", containerName]);
        containerStarted = false;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      stopped = false;
      throw new AggregateError(failures, "Milestone 2 cleanup failed");
    }
  };

  try {
    await docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--env",
      "POSTGRES_DB=architect_milestone2",
      "--env",
      "POSTGRES_PASSWORD=architect",
      "--env",
      "POSTGRES_USER=architect",
      "--publish",
      `${loopback}::5432`,
      "--health-cmd",
      "pg_isready -U architect -d architect_milestone2",
      "--health-interval",
      "500ms",
      "--health-timeout",
      "3s",
      "--health-retries",
      "60",
      "postgres:16-alpine",
    ]);
    containerStarted = true;
    await waitFor("ephemeral PostgreSQL health", async () => {
      const health = await docker([
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        containerName,
      ]);
      return health === "healthy";
    });
    const port = postgresPort(await docker(["port", containerName, "5432/tcp"]));
    const databaseUrl =
      `postgresql://architect:architect@${loopback}:${port}/` +
      "architect_milestone2?schema=public";
    const sharedEnv = { ...process.env, DATABASE_URL: databaseUrl };
    await execFileAsync(
      "npm",
      ["run", "db:migrate", "--workspace", "@architect/server"],
      {
        cwd: repositoryRoot,
        env: sharedEnv,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const serverEnv = {
      ...sharedEnv,
      COOKIE_SIGNING_SECRET: cookieSigningSecret,
      HTTP_PORT: String(httpPort),
      NODE_ENV: "test",
      OWNER_TOKEN_PEPPER: ownerTokenPepper,
      PUBLIC_APP_URL: webUrl,
      WS_PORT: String(wsPort),
    };
    const launchServer = async () => {
      serverProcess = startOwnedProcess(
        "Architect server",
        ["--import", "tsx", "apps/server/src/index.ts"],
        serverEnv,
      );
      await waitForHttp(serverProcess, `${httpUrl}/api/ready`);
    };
    await launchServer();

    const webEnv = {
      ...process.env,
      ARCHITECT_SERVER_URL: httpUrl,
      NEXT_PUBLIC_API_URL: httpUrl,
      NEXT_PUBLIC_WS_URL: `ws://${loopback}:${wsPort}`,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    };
    await execFileAsync(
      "npm",
      ["run", "build", "--workspace", "@architect/web"],
      {
        cwd: repositoryRoot,
        env: webEnv,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    webProcess = startOwnedProcess(
      "Architect web",
      [
        "node_modules/next/dist/bin/next",
        "start",
        "apps/web",
        "-p",
        String(webPort),
      ],
      webEnv,
    );
    await waitForHttp(webProcess, `${webUrl}/start`);

    return {
      databaseUrl,
      async restartServer() {
        await stopOwnedProcess(serverProcess);
        serverProcess = undefined;
        await launchServer();
      },
      stop,
      webUrl,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Milestone 2 startup and cleanup failed",
      );
    }
    throw error;
  }
}

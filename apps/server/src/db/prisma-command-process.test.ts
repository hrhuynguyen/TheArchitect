import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runPrismaCommand } from "./prisma-command";

function createProcessHarness(platform: NodeJS.Platform = "darwin") {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn((_signal: NodeJS.Signals) => true),
  });
  const signals = new EventEmitter();
  const spawnCommand = vi.fn(() => child);
  const environment = {
    ...process.env,
    DATABASE_URL: "postgresql://safe-process-harness/example",
  };

  const run = () =>
    runPrismaCommand(["validate"], {
      environment,
      envFilePath: "/missing/architect/.env",
      platform,
      signals,
      spawnCommand,
      stdio: "ignore",
    });

  return { child, environment, run, signals, spawnCommand };
}

describe("runPrismaCommand process lifecycle", () => {
  it.each([
    ["darwin", "prisma"],
    ["win32", "prisma.cmd"],
  ] as const)("selects the npm PATH executable on %s", async (platform, expected) => {
    const harness = createProcessHarness(platform);
    const command = harness.run();

    harness.child.emit("exit", 0, null);
    await command;

    expect(harness.spawnCommand).toHaveBeenCalledWith(
      expected,
      ["validate"],
      expect.objectContaining({
        env: harness.environment,
        shell: false,
        stdio: "ignore",
      }),
    );
  });

  it("preserves a nonzero child exit status", async () => {
    const harness = createProcessHarness();
    const command = harness.run();

    harness.child.emit("exit", 37, null);

    await expect(command).resolves.toBe(37);
    expect(harness.signals.listenerCount("SIGINT")).toBe(0);
    expect(harness.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "forwards parent %s to the active child",
    async (signal) => {
      const harness = createProcessHarness();
      const command = harness.run();

      harness.signals.emit(signal);
      harness.child.emit("exit", 0, null);
      await command;

      expect(harness.child.kill).toHaveBeenCalledWith(signal);
    },
  );

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "maps child %s termination to exit status %i and removes handlers",
    async (signal, expectedExitStatus) => {
      const harness = createProcessHarness();
      const command = harness.run();

      expect(harness.signals.listenerCount("SIGINT")).toBe(1);
      expect(harness.signals.listenerCount("SIGTERM")).toBe(1);
      harness.child.emit("exit", null, signal);

      await expect(command).resolves.toBe(expectedExitStatus);
      expect(harness.signals.listenerCount("SIGINT")).toBe(0);
      expect(harness.signals.listenerCount("SIGTERM")).toBe(0);
    },
  );
});

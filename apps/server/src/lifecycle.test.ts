import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startServer } from "./lifecycle";

function createDependencies() {
  return {
    app: {
      close: vi.fn().mockResolvedValue(undefined),
      listen: vi.fn().mockResolvedValue("http://127.0.0.1:3001"),
    },
    database: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
    },
    signals: new EventEmitter(),
  };
}

describe("startServer", () => {
  it("starts Fastify with the configured host and port", async () => {
    const dependencies = createDependencies();

    const lifecycle = await startServer({
      ...dependencies,
      host: "0.0.0.0",
      port: 4101,
    });

    expect(dependencies.app.listen).toHaveBeenCalledWith({
      host: "0.0.0.0",
      port: 4101,
    });

    await lifecycle.shutdown();
  });

  it("handles SIGINT and SIGTERM with one idempotent shutdown", async () => {
    const dependencies = createDependencies();
    const lifecycle = await startServer({
      ...dependencies,
      port: 3001,
    });

    dependencies.signals.emit("SIGINT");
    dependencies.signals.emit("SIGTERM");
    await lifecycle.shutdown();

    expect(dependencies.app.close).toHaveBeenCalledOnce();
    expect(dependencies.database.$disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects Prisma even when Fastify close fails", async () => {
    const dependencies = createDependencies();
    const closeError = new Error("close failed");
    dependencies.app.close.mockRejectedValue(closeError);
    const lifecycle = await startServer({
      ...dependencies,
      port: 3001,
    });

    await expect(lifecycle.shutdown()).rejects.toBe(closeError);
    expect(dependencies.database.$disconnect).toHaveBeenCalledOnce();
  });

  it("releases Fastify and Prisma after a startup failure", async () => {
    const dependencies = createDependencies();
    const startupError = new Error("listen failed");
    dependencies.app.listen.mockRejectedValue(startupError);

    await expect(
      startServer({
        ...dependencies,
        port: 3001,
      }),
    ).rejects.toBe(startupError);

    expect(dependencies.app.close).toHaveBeenCalledOnce();
    expect(dependencies.database.$disconnect).toHaveBeenCalledOnce();
    expect(dependencies.signals.listenerCount("SIGINT")).toBe(0);
    expect(dependencies.signals.listenerCount("SIGTERM")).toBe(0);
  });
});

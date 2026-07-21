type ServerApp = {
  close(): Promise<void>;
  listen(options: { host: string; port: number }): Promise<unknown>;
};

type DatabaseConnection = {
  $disconnect(): Promise<void>;
};

type ServerSignal = "SIGINT" | "SIGTERM";

type SignalSource = {
  once(signal: ServerSignal, listener: () => void): unknown;
  removeListener(signal: ServerSignal, listener: () => void): unknown;
};

type StartServerOptions = {
  app: ServerApp;
  database: DatabaseConnection;
  host?: string;
  onShutdownError?: (error: unknown) => void;
  port: number;
  signals?: SignalSource;
};

export type ServerLifecycle = {
  shutdown(): Promise<void>;
};

export async function startServer({
  app,
  database,
  host = "0.0.0.0",
  onShutdownError = console.error,
  port,
  signals = process,
}: StartServerOptions): Promise<ServerLifecycle> {
  let shutdownPromise: Promise<void> | undefined;

  const unregister = () => {
    signals.removeListener("SIGINT", handleSignal);
    signals.removeListener("SIGTERM", handleSignal);
  };

  const shutdown = (): Promise<void> => {
    unregister();
    shutdownPromise ??= (async () => {
      try {
        await app.close();
      } finally {
        await database.$disconnect();
      }
    })();

    return shutdownPromise;
  };

  const handleSignal = () => {
    void shutdown().catch(onShutdownError);
  };

  signals.once("SIGINT", handleSignal);
  signals.once("SIGTERM", handleSignal);

  try {
    await app.listen({ host, port });
  } catch (startupError) {
    try {
      await shutdown();
    } catch (shutdownError) {
      throw new AggregateError(
        [startupError, shutdownError],
        "Server startup and cleanup failed",
      );
    }

    throw startupError;
  }

  return { shutdown };
}

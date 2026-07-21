type ServerApp = {
  close(): Promise<void>;
  listen(options: { host: string; port: number }): Promise<unknown>;
};

type DatabaseConnection = {
  $disconnect(): Promise<void>;
};

type CollaborationServer = {
  destroy(): Promise<void>;
  listen(options: { host: string; port: number }): Promise<unknown>;
};

type ServerSignal = "SIGINT" | "SIGTERM";

type SignalSource = {
  once(signal: ServerSignal, listener: () => void): unknown;
  removeListener(signal: ServerSignal, listener: () => void): unknown;
};

type StartServerOptions = {
  app: ServerApp;
  collaboration: CollaborationServer;
  database: DatabaseConnection;
  host?: string;
  onShutdownError?: (error: unknown) => void;
  port: number;
  wsPort?: number;
  signals?: SignalSource;
};

export type ServerLifecycle = {
  shutdown(): Promise<void>;
};

export async function startServer({
  app,
  collaboration,
  database,
  host = "0.0.0.0",
  onShutdownError = console.error,
  port,
  wsPort = port + 1,
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
      const failures: unknown[] = [];
      try {
        await collaboration.destroy();
      } catch (error) {
        failures.push(error);
      }
      try {
        await app.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await database.$disconnect();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Server shutdown failed");
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
    await collaboration.listen({ host, port: wsPort });
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

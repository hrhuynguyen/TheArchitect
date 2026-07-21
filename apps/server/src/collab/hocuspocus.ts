import { Server, type onAwarenessUpdatePayload } from "@hocuspocus/server";
import type { IncomingHttpHeaders } from "node:http";
import * as Y from "yjs";
import { parseCookies, participantCookieName } from "../auth/cookies.js";
import { verifyParticipant } from "../auth/participant.js";
import type { AwarenessRegistry } from "./awareness.registry.js";
import { createSnapshotService } from "./snapshot.service.js";
import {
  createYjsRepository,
  type SnapshotDatabase,
} from "./yjs.repository.js";

type ParticipantDatabase = {
  participant: {
    findFirst(input: {
      where: { id: string; roomId: string };
      select: {
        id: true;
        name: true;
        color: true;
        room: { select: { phase: true } };
      };
    }): Promise<{
      id: string;
      name: string;
      color: string;
      room: { phase: "sketch" | "reconstructing" | "architect" | "deploy" };
    } | null>;
  };
};

type AuthenticateParticipantOptions = {
  cookieSigningSecret: string;
  database: ParticipantDatabase;
  documentName: string;
  requestHeaders: IncomingHttpHeaders;
};

function unauthorized(): never {
  throw new Error("Unauthorized");
}

export async function authenticateParticipant({
  cookieSigningSecret,
  database,
  documentName,
  requestHeaders,
}: AuthenticateParticipantOptions) {
  const rawCookie = requestHeaders.cookie;
  const cookieHeader = Array.isArray(rawCookie)
    ? rawCookie.join(";")
    : rawCookie;
  const cookie = parseCookies(cookieHeader).get(
    participantCookieName(documentName),
  );
  if (!cookie) return unauthorized();

  let claims;
  try {
    claims = verifyParticipant(cookie, cookieSigningSecret);
  } catch {
    return unauthorized();
  }
  if (claims.roomId !== documentName) return unauthorized();

  const participant = await database.participant.findFirst({
    where: { id: claims.participantId, roomId: documentName },
    select: {
      id: true,
      name: true,
      color: true,
      room: { select: { phase: true } },
    },
  });
  if (!participant) return unauthorized();

  return {
    roomId: documentName,
    participant: {
      participantId: participant.id,
      name: participant.name,
      color: participant.color,
      phase: participant.room.phase,
    },
  };
}

type CollaborationEnvironment = {
  COOKIE_SIGNING_SECRET: string;
  WS_PORT: number;
};

type CreateHocuspocusServerOptions = {
  awarenessRegistry: AwarenessRegistry;
  debounceMs?: number;
  env: CollaborationEnvironment;
  maxDebounceMs?: number;
  onPersistenceError?: (error: unknown) => void;
  prisma: unknown;
};

type AuthenticationContext = Awaited<ReturnType<typeof authenticateParticipant>>;

function awarenessProfile(state: unknown): Record<string, unknown> | undefined {
  if (!state || typeof state !== "object") return undefined;
  const profile = (state as { profile?: unknown }).profile;
  return profile && typeof profile === "object"
    ? (profile as Record<string, unknown>)
    : undefined;
}

function updateAwarenessRegistry(
  awarenessRegistry: AwarenessRegistry,
  data: Pick<
    onAwarenessUpdatePayload,
    "documentName" | "socketId" | "states"
  >,
): void {
  awarenessRegistry.heartbeat(data.documentName, data.socketId);
  for (const state of data.states) {
    const profile = awarenessProfile(state);
    if (typeof profile?.participantId !== "string") continue;
    awarenessRegistry.updateParticipant(
      data.documentName,
      profile.participantId,
      profile,
    );
  }
}

export function createHocuspocusServer({
  awarenessRegistry,
  debounceMs = 2_000,
  env,
  maxDebounceMs = 10_000,
  onPersistenceError = () => {
    console.error("Collaboration snapshot persistence failed");
  },
  prisma,
}: CreateHocuspocusServerOptions) {
  const database = prisma as ParticipantDatabase & SnapshotDatabase;
  const repository = createYjsRepository(database);
  const snapshots = createSnapshotService({
    persistRoomSnapshot: repository.persistRoomSnapshot,
  });
  let stopping = false;
  let destroyPromise: Promise<void> | undefined;
  let listenPromise:
    | Promise<{ port: number; webSocketUrl: string }>
    | undefined;
  const reportPersistenceError = (error: unknown) => {
    try {
      onPersistenceError(error);
    } catch {
      // Persistence remains dirty and retryable even if logging fails.
    }
  };

  const server = new Server({
    address: "0.0.0.0",
    debounce: debounceMs,
    maxDebounce: maxDebounceMs,
    port: env.WS_PORT,
    quiet: true,
    stopOnSignals: false,
    async onAuthenticate({ documentName, requestHeaders }) {
      if (stopping) throw new Error("Unauthorized");
      return authenticateParticipant({
        cookieSigningSecret: env.COOKIE_SIGNING_SECRET,
        database,
        documentName,
        requestHeaders,
      });
    },
    async connected({ context, documentName, socketId }) {
      const authenticated = context as AuthenticationContext;
      awarenessRegistry.connect(
        documentName,
        socketId,
        authenticated.participant,
      );
    },
    async onLoadDocument({ document, documentName }) {
      const restored = await repository.loadRoomDocument(documentName);
      Y.applyUpdate(document, Y.encodeStateAsUpdate(restored));
      restored.destroy();
    },
    async afterLoadDocument({ document, documentName }) {
      snapshots.track(documentName, document);
    },
    async beforeHandleMessage({ documentName, socketId }) {
      awarenessRegistry.heartbeat(documentName, socketId);
    },
    async onChange({ document, documentName }) {
      try {
        await snapshots.changed(documentName, document);
      } catch (error) {
        reportPersistenceError(error);
      }
    },
    async onStoreDocument({ document, documentName }) {
      try {
        await snapshots.store(documentName, document);
      } catch (error) {
        reportPersistenceError(error);
      }
    },
    async onAwarenessUpdate(data) {
      updateAwarenessRegistry(awarenessRegistry, data);
    },
    async onDisconnect({ documentName, socketId }) {
      awarenessRegistry.disconnect(documentName, socketId);
    },
    async afterUnloadDocument({ documentName }) {
      if (!stopping) snapshots.release(documentName);
    },
  });

  const listenWithErrorOwnership = async (
    host: string,
    port: number,
  ): Promise<void> => {
    server.configuration.address = host;
    server.configuration.port = port;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.httpServer.removeListener("error", onError);
        reject(error);
      };
      server.httpServer.once("error", onError);
      void server.listen(port).then(
        () => {
          server.httpServer.removeListener("error", onError);
          resolve();
        },
        (error) => {
          server.httpServer.removeListener("error", onError);
          reject(error);
        },
      );
    });
  };

  return {
    listen({ host, port }: { host: string; port: number }) {
      listenPromise ??= (async () => {
        await listenWithErrorOwnership(host, port);
        return {
          port: server.address.port,
          webSocketUrl: `ws://${host}:${server.address.port}`,
        };
      })();
      return listenPromise;
    },

    destroy(): Promise<void> {
      destroyPromise ??= (async () => {
        stopping = true;
        const failures: unknown[] = [];
        try {
          await server.destroy();
        } catch (error) {
          failures.push(error);
        }
        try {
          await snapshots.shutdown();
        } catch (error) {
          failures.push(error);
        } finally {
          awarenessRegistry.destroy();
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Collaboration server shutdown failed",
          );
        }
      })();
      return destroyPromise;
    },
  };
}

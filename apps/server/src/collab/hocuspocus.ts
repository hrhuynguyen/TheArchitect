import {
  MessageType,
  Server,
  type onAwarenessUpdatePayload,
} from "@hocuspocus/server";
import * as decoding from "lib0/decoding";
import type { IncomingHttpHeaders } from "node:http";
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";
import {
  messageYjsSyncStep1,
  messageYjsSyncStep2,
  messageYjsUpdate,
} from "y-protocols/sync";
import { parseCookies, participantCookieName } from "../auth/cookies.js";
import { verifyParticipant } from "../auth/participant.js";
import type { AwarenessRegistry } from "./awareness.registry.js";
import {
  createActiveDocumentRegistry,
  type ActiveDocumentRegistry,
} from "./active-document.registry.js";
import { assertClientDocumentUpdateAllowed } from "./protected-document.js";
import {
  createSnapshotService,
  type SnapshotPersistenceFailure,
} from "./snapshot.service.js";
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
  documents?: ActiveDocumentRegistry;
  env: CollaborationEnvironment;
  maxDebounceMs?: number;
  onPersistenceError?: (failure: SnapshotPersistenceFailure) => void;
  prisma: unknown;
};

type AuthenticationContext = Awaited<ReturnType<typeof authenticateParticipant>>;

function awarenessProfile(state: unknown): Record<string, unknown> | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate = state as { presence?: unknown; profile?: unknown };
  const profile = candidate.presence ?? candidate.profile;
  return profile && typeof profile === "object"
    ? (profile as Record<string, unknown>)
    : undefined;
}

function connectionOwner(
  document: onAwarenessUpdatePayload["document"],
  clientId: number,
): string | undefined {
  for (const { clients, connection } of document.connections.values()) {
    if (clients.has(clientId)) return connection.socketId;
  }
  return undefined;
}

function updateAwarenessRegistry(
  awarenessRegistry: AwarenessRegistry,
  owners: Map<number, string>,
  data: Pick<
    onAwarenessUpdatePayload,
    "added" | "document" | "documentName" | "removed" | "states" | "updated"
  >,
): void {
  const states = new Map(data.states.map((state) => [state.clientId, state]));
  for (const clientId of [...data.added, ...data.updated]) {
    const socketId = connectionOwner(data.document, clientId) ?? owners.get(clientId);
    if (!socketId) continue;
    owners.set(clientId, socketId);
    const state = states.get(clientId);
    const profile = awarenessProfile(state);
    if (!profile) continue;
    awarenessRegistry.updateClient(
      data.documentName,
      socketId,
      clientId,
      profile,
    );
  }
  for (const clientId of data.removed) {
    const socketId = owners.get(clientId);
    if (socketId) {
      awarenessRegistry.removeClient(data.documentName, socketId, clientId);
    }
    owners.delete(clientId);
  }
}

function inboundMessageType(update: Uint8Array): MessageType {
  const decoder = decoding.createDecoder(update);
  decoding.readVarString(decoder);
  return decoding.readVarUint(decoder) as MessageType;
}

function inboundSyncUpdate(update: Uint8Array): Uint8Array | undefined {
  const decoder = decoding.createDecoder(update);
  decoding.readVarString(decoder);
  const messageType = decoding.readVarUint(decoder) as MessageType;
  if (messageType !== MessageType.Sync && messageType !== MessageType.SyncReply) {
    return undefined;
  }
  const syncType = decoding.readVarUint(decoder);
  const payload = decoding.readVarUint8Array(decoder);
  if (decoding.hasContent(decoder)) {
    throw new Error("Malformed sync message");
  }
  if (syncType === messageYjsSyncStep1) return undefined;
  if (syncType === messageYjsSyncStep2 || syncType === messageYjsUpdate) {
    return payload;
  }
  throw new Error("Malformed sync message");
}

function inboundAwarenessEntries(update: Uint8Array): Array<{
  clientId: number;
  clock: number;
  state: unknown;
}> {
  const decoder = decoding.createDecoder(update);
  decoding.readVarString(decoder);
  if (decoding.readVarUint(decoder) !== MessageType.Awareness) return [];
  const awarenessDecoder = decoding.createDecoder(
    decoding.readVarUint8Array(decoder),
  );
  const count = decoding.readVarUint(awarenessDecoder);
  const entries: Array<{ clientId: number; clock: number; state: unknown }> = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({
      clientId: decoding.readVarUint(awarenessDecoder),
      clock: decoding.readVarUint(awarenessDecoder),
      state: JSON.parse(decoding.readVarString(awarenessDecoder)),
    });
  }
  return entries;
}

export function createHocuspocusServer({
  awarenessRegistry,
  debounceMs = 2_000,
  documents: providedDocuments,
  env,
  maxDebounceMs = 10_000,
  onPersistenceError = () => {
    console.error("Collaboration snapshot persistence failed");
  },
  prisma,
}: CreateHocuspocusServerOptions) {
  const database = prisma as ParticipantDatabase & SnapshotDatabase;
  const repository = createYjsRepository(database);
  const documents =
    providedDocuments ??
    createActiveDocumentRegistry({
      loadRoomDocument: repository.loadRoomDocument,
    });
  const ownsDocuments = providedDocuments === undefined;
  const snapshots = createSnapshotService({
    onPersistenceError,
    persistRoomSnapshot: repository.persistRoomSnapshot,
  });
  const awarenessOwners = new WeakMap<object, Map<number, string>>();
  const deactivateDocuments = new Map<string, () => Promise<void>>();
  const unsubscribeAwareness = awarenessRegistry.subscribe((roomId) => {
    const document = documents.active(roomId);
    if (document && "broadcastStateless" in document) {
      (document as onAwarenessUpdatePayload["document"]).broadcastStateless(
        JSON.stringify({
          type: "architect/presence",
          version: 1,
          roomId,
          profiles: awarenessRegistry.list(roomId),
        }),
      );
    }
  });
  let stopping = false;
  let destroyPromise: Promise<void> | undefined;
  let listenPromise:
    | Promise<{ port: number; webSocketUrl: string }>
    | undefined;
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
    async afterLoadDocument({ context, document, documentName }) {
      const authenticated = context as AuthenticationContext;
      const currentParticipant = await database.participant.findFirst({
        where: {
          id: authenticated.participant.participantId,
          roomId: documentName,
        },
        select: {
          id: true,
          name: true,
          color: true,
          room: { select: { phase: true } },
        },
      });
      if (!currentParticipant) throw new Error("Unauthorized");
      const deactivate = await documents.activate(documentName, document);
      deactivateDocuments.set(documentName, deactivate);
      document.getMap("meta").set("phase", currentParticipant.room.phase);
      snapshots.track(documentName, document);
    },
    async beforeHandleMessage({ document, documentName, socketId, update }) {
      awarenessRegistry.heartbeat(documentName, socketId);
      const documentUpdate = inboundSyncUpdate(update);
      if (documentUpdate) {
        assertClientDocumentUpdateAllowed(document, documentUpdate);
      }
      const messageType = inboundMessageType(update);
      if (
        messageType === MessageType.Stateless ||
        messageType === MessageType.BroadcastStateless
      ) {
        throw new Error("Client stateless messages are not allowed");
      }
      if (messageType === MessageType.Awareness) {
        const owners = awarenessOwners.get(document) ?? new Map<number, string>();
        awarenessOwners.set(document, owners);
        for (const { clientId, clock, state } of inboundAwarenessEntries(update)) {
          const owner = owners.get(clientId) ?? connectionOwner(document, clientId);
          if (owner && owner !== socketId) {
            const currentClock = document.awareness.meta.get(clientId)?.clock;
            const currentState = document.awareness.states.get(clientId);
            const harmlessEcho =
              currentClock !== undefined &&
              clock <= currentClock &&
              isDeepStrictEqual(state, currentState);
            if (!harmlessEcho) {
              throw new Error("Awareness client belongs to another connection");
            }
          }
        }
      }
    },
    async onChange({ document, documentName }) {
      try {
        await snapshots.changed(documentName, document);
      } catch {
        // The snapshot service reports the structured failure and retains dirtiness.
      }
    },
    async onStoreDocument({ document, documentName }) {
      try {
        await snapshots.store(documentName, document);
      } catch {
        // The snapshot service reports the structured failure and retains dirtiness.
      }
    },
    async onAwarenessUpdate(data) {
      const owners = awarenessOwners.get(data.document) ?? new Map<number, string>();
      awarenessOwners.set(data.document, owners);
      updateAwarenessRegistry(awarenessRegistry, owners, data);
    },
    async onDisconnect({ documentName, socketId }) {
      awarenessRegistry.disconnect(documentName, socketId);
    },
    async afterUnloadDocument({ documentName }) {
      const deactivate = deactivateDocuments.get(documentName);
      deactivateDocuments.delete(documentName);
      await deactivate?.();
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
        }
        try {
          unsubscribeAwareness();
        } catch (error) {
          failures.push(error);
        }
        try {
          await Promise.all(
            [...deactivateDocuments.values()].map((deactivate) => deactivate()),
          );
        } catch (error) {
          failures.push(error);
        }
        deactivateDocuments.clear();
        if (ownsDocuments) {
          try {
            await documents.destroy();
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          awarenessRegistry.destroy();
        } catch (error) {
          failures.push(error);
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

import * as Y from "yjs";

type ActiveDocumentRegistryOptions = {
  loadRoomDocument(roomId: string): Promise<Y.Doc>;
};

type RoomEntry = {
  active: Y.Doc | null;
  handoffUpdate?: Uint8Array;
  tail: Promise<void>;
};

export function createActiveDocumentRegistry({
  loadRoomDocument,
}: ActiveDocumentRegistryOptions) {
  const rooms = new Map<string, RoomEntry>();
  let stopping = false;
  let destroyPromise: Promise<void> | undefined;

  const entryFor = (roomId: string) => {
    let entry = rooms.get(roomId);
    if (!entry) {
      entry = { active: null, tail: Promise.resolve() };
      rooms.set(roomId, entry);
    }
    return entry;
  };

  const enqueue = <T>(
    roomId: string,
    operation: (entry: RoomEntry) => Promise<T>,
  ): Promise<T> => {
    if (stopping) return Promise.reject(new Error("Document registry stopped"));
    const entry = entryFor(roomId);
    const result = entry.tail.then(() => operation(entry));
    entry.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    active(roomId: string): Y.Doc | null {
      return rooms.get(roomId)?.active ?? null;
    },

    activate(roomId: string, document: Y.Doc) {
      return enqueue(roomId, async (entry) => {
        if (entry.active && entry.active !== document) {
          throw new Error("Room already has an active document");
        }
        if (entry.handoffUpdate) {
          Y.applyUpdate(document, entry.handoffUpdate, "architect/server-handoff");
          entry.handoffUpdate = undefined;
        }
        entry.active = document;
        let deactivated = false;
        return async () => {
          if (deactivated) return;
          deactivated = true;
          if (stopping) return;
          await enqueue(roomId, async (current) => {
            if (current.active === document) {
              current.handoffUpdate = Y.encodeStateAsUpdate(document);
              current.active = null;
            }
          });
        };
      });
    },

    withDocument<T>(
      roomId: string,
      operation: (document: Y.Doc) => Promise<T>,
    ): Promise<T> {
      return enqueue(roomId, async (entry) => {
        if (entry.active) return operation(entry.active);

        const fallback = await loadRoomDocument(roomId);
        if (entry.handoffUpdate) {
          Y.applyUpdate(fallback, entry.handoffUpdate, "architect/server-handoff");
        }
        let completed = false;
        try {
          const result = await operation(fallback);
          completed = true;
          entry.handoffUpdate = Y.encodeStateAsUpdate(fallback);
          return result;
        } finally {
          fallback.destroy();
          if (!completed && !entry.handoffUpdate) {
            entry.handoffUpdate = undefined;
          }
        }
      });
    },

    destroy(): Promise<void> {
      destroyPromise ??= (async () => {
        stopping = true;
        await Promise.all([...rooms.values()].map((entry) => entry.tail));
        rooms.clear();
      })();
      return destroyPromise;
    },
  };
}

export type ActiveDocumentRegistry = ReturnType<
  typeof createActiveDocumentRegistry
>;

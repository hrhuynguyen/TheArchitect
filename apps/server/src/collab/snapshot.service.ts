import * as Y from "yjs";

type PersistRoomSnapshot = (
  roomId: string,
  document: Y.Doc,
  reason: string,
) => Promise<number>;

export type SnapshotPersistenceFailure = {
  roomId: string;
  reason: "phase_transition" | "debounced_change" | "shutdown";
  revision: number;
  error: unknown;
};

type SnapshotServiceOptions = {
  onPersistenceError?: (failure: SnapshotPersistenceFailure) => void;
  persistRoomSnapshot: PersistRoomSnapshot;
};

type TrackedDocument = {
  document: Y.Doc;
  dirty: boolean;
  phase: unknown;
  revision: number;
  writeQueue: Promise<void>;
};

export function createSnapshotService({
  onPersistenceError = () => undefined,
  persistRoomSnapshot,
}: SnapshotServiceOptions) {
  const tracked = new Map<string, TrackedDocument>();
  let shuttingDown = false;

  const ensureTracked = (roomId: string, document: Y.Doc) => {
    const existing = tracked.get(roomId);
    if (existing?.document === document) return existing;
    const created: TrackedDocument = {
      document,
      dirty: existing?.dirty ?? false,
      phase: document.getMap("meta").get("phase"),
      revision: existing?.revision ?? 0,
      writeQueue: existing?.writeQueue ?? Promise.resolve(),
    };
    tracked.set(roomId, created);
    if (existing?.dirty) {
      Y.applyUpdate(document, Y.encodeStateAsUpdate(existing.document));
      created.phase = document.getMap("meta").get("phase");
    }
    return created;
  };

  const flush = (
    roomId: string,
    state: TrackedDocument,
    reason: SnapshotPersistenceFailure["reason"],
    force: boolean,
  ): Promise<void> => {
    const operation = state.writeQueue
      .catch(() => undefined)
      .then(async () => {
        if (!force && !state.dirty) return;
        const persistedRevision = state.revision;
        try {
          await persistRoomSnapshot(roomId, state.document, reason);
        } catch (error) {
          try {
            onPersistenceError({
              roomId,
              reason,
              revision: persistedRevision,
              error,
            });
          } catch {
            // A failed observer must not replace the persistence failure.
          }
          throw error;
        }
        if (state.revision === persistedRevision) state.dirty = false;
      });
    state.writeQueue = operation.catch(() => undefined);
    return operation;
  };

  return {
    track(roomId: string, document: Y.Doc) {
      if (!shuttingDown) ensureTracked(roomId, document);
    },

    changed(roomId: string, document: Y.Doc): Promise<void> {
      const state = ensureTracked(roomId, document);
      state.dirty = true;
      state.revision += 1;
      const phase = document.getMap("meta").get("phase");
      if (phase !== state.phase) {
        state.phase = phase;
        return flush(roomId, state, "phase_transition", true);
      }
      return Promise.resolve();
    },

    store(roomId: string, document: Y.Doc): Promise<void> {
      const state = ensureTracked(roomId, document);
      return flush(roomId, state, "debounced_change", false);
    },

    release(roomId: string) {
      if (!shuttingDown && !tracked.get(roomId)?.dirty) tracked.delete(roomId);
    },

    async shutdown(): Promise<void> {
      if (shuttingDown) {
        await Promise.all([...tracked.values()].map((state) => state.writeQueue));
        return;
      }
      shuttingDown = true;
      const results = await Promise.allSettled(
        [...tracked].map(([roomId, state]) =>
          flush(roomId, state, "shutdown", true),
        ),
      );
      tracked.clear();
      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Final snapshot persistence failed");
      }
    },
  };
}

export type SnapshotService = ReturnType<typeof createSnapshotService>;

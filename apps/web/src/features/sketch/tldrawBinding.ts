import type { TLRecord, TLStore } from "tldraw";
import * as Y from "yjs";

export const TLDRAW_RECORDS_KEY = "tldraw/records";

const LOCAL_TLDRAW_ORIGIN = Symbol("architect/tldraw-local");
const DOCUMENT_RECORD_TYPES = new Set([
  "asset",
  "binding",
  "document",
  "page",
  "shape",
  "user",
]);
const HYDRATION_ORDER: Record<string, number> = {
  document: 0,
  page: 1,
  user: 2,
  asset: 3,
  shape: 4,
  binding: 5,
};

type TldrawRecordIdentity = {
  id: string;
  typeName: string;
};

type CreateTldrawBindingOptions = {
  doc: Y.Doc;
  onError?: (message: string) => void;
  store: TLStore;
};

export function shouldSyncTldrawRecord(
  candidate: unknown,
): candidate is TldrawRecordIdentity {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const record = candidate as Partial<TldrawRecordIdentity>;
  return (
    typeof record.id === "string" &&
    typeof record.typeName === "string" &&
    record.id.startsWith(`${record.typeName}:`) &&
    DOCUMENT_RECORD_TYPES.has(record.typeName)
  );
}

function cloneRecord(record: TldrawRecordIdentity): TLRecord | null {
  try {
    return structuredClone(record) as TLRecord;
  } catch {
    return null;
  }
}

export function createTldrawBinding({
  doc,
  onError,
  store,
}: CreateTldrawBindingOptions) {
  const records = doc.getMap<unknown>(TLDRAW_RECORDS_KEY);
  let active = true;

  const reportInvalidRecord = () => {
    try {
      onError?.("Ignored an invalid shared drawing record.");
    } catch {
      // A reporting callback must never break collaboration.
    }
  };

  const validateSharedRecord = (key: string, input: unknown): TLRecord | null => {
    if (!shouldSyncTldrawRecord(input) || input.id !== key) {
      reportInvalidRecord();
      return null;
    }
    const cloned = cloneRecord(input);
    if (!cloned) {
      reportInvalidRecord();
      return null;
    }
    const existing = store.get(cloned.id) ?? null;
    try {
      return store.schema.validateRecord(
        store,
        cloned,
        existing ? "updateRecord" : "createRecord",
        existing,
      );
    } catch {
      reportInvalidRecord();
      return null;
    }
  };

  const applySharedChanges = (changedKeys: Iterable<string>) => {
    const puts: TLRecord[] = [];
    const removals: TLRecord["id"][] = [];
    for (const key of changedKeys) {
      if (!records.has(key)) {
        const existing = store.get(key as TLRecord["id"]);
        if (existing && shouldSyncTldrawRecord(existing)) removals.push(existing.id);
        continue;
      }
      const record = validateSharedRecord(key, records.get(key));
      if (record) puts.push(record);
    }
    puts.sort(
      (left, right) =>
        (HYDRATION_ORDER[left.typeName] ?? Number.MAX_SAFE_INTEGER) -
        (HYDRATION_ORDER[right.typeName] ?? Number.MAX_SAFE_INTEGER),
    );
    if (puts.length === 0 && removals.length === 0) return;

    store.mergeRemoteChanges(() => {
      if (puts.length > 0) store.put(puts);
      if (removals.length > 0) store.remove(removals);
    });
  };

  applySharedChanges(records.keys());

  // tldraw may restore required document/page records while hydrating a partial
  // remote document. Publish only missing document-scoped records; remote values
  // remain authoritative.
  doc.transact(() => {
    for (const record of store.allRecords()) {
      if (shouldSyncTldrawRecord(record) && !records.has(record.id)) {
        const cloned = cloneRecord(record);
        if (cloned) records.set(record.id, cloned);
      }
    }
  }, LOCAL_TLDRAW_ORIGIN);

  const observeRecords = (
    event: Y.YMapEvent<unknown>,
    transaction: Y.Transaction,
  ) => {
    if (!active || transaction.origin === LOCAL_TLDRAW_ORIGIN) return;
    applySharedChanges(event.keysChanged);
  };
  records.observe(observeRecords);

  const unlistenStore = store.listen(
    ({ changes }) => {
      if (!active) return;
      doc.transact(() => {
        for (const record of Object.values(changes.added)) {
          if (!shouldSyncTldrawRecord(record)) continue;
          const cloned = cloneRecord(record);
          if (cloned) records.set(record.id, cloned);
        }
        for (const [, record] of Object.values(changes.updated)) {
          if (!shouldSyncTldrawRecord(record)) continue;
          const cloned = cloneRecord(record);
          if (cloned) records.set(record.id, cloned);
        }
        for (const record of Object.values(changes.removed)) {
          if (shouldSyncTldrawRecord(record)) records.delete(record.id);
        }
      }, LOCAL_TLDRAW_ORIGIN);
    },
    { scope: "document", source: "user" },
  );

  return {
    records,
    write(input: unknown): boolean {
      if (!active || !shouldSyncTldrawRecord(input)) return false;
      const cloned = cloneRecord(input);
      if (!cloned) return false;
      doc.transact(() => records.set(cloned.id, cloned), LOCAL_TLDRAW_ORIGIN);
      return true;
    },
    destroy(): void {
      if (!active) return;
      active = false;
      records.unobserve(observeRecords);
      unlistenStore();
    },
  };
}

import { createTLStore, type TLRecord } from "tldraw";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import {
  createTldrawBinding,
  shouldSyncTldrawRecord,
  TLDRAW_RECORDS_KEY,
} from "./tldrawBinding.js";

function documentRecord(store: ReturnType<typeof createTLStore>, name = "Architecture") {
  return store.schema.types.document.create({
    id: "document:document",
    name,
  }) as TLRecord;
}

function pageRecord(store: ReturnType<typeof createTLStore>, name = "Page 1") {
  return store.schema.types.page.create({
    id: "page:page",
    index: "a1",
    meta: {},
    name,
  }) as TLRecord;
}

function userRecord(store: ReturnType<typeof createTLStore>, name = "Ada") {
  return store.schema.types.user.create({
    id: "user:ada",
    name,
  }) as TLRecord;
}

describe("tldraw Yjs binding", () => {
  it("recognizes every document and non-document record scope in tldraw 5.2.5", () => {
    expect(
      ["asset", "binding", "document", "page", "shape", "user"].map(
        (typeName) => shouldSyncTldrawRecord({ id: `${typeName}:one`, typeName }),
      ),
    ).toEqual([true, true, true, true, true, true]);
    expect(
      ["camera", "instance", "instance_page_state", "pointer", "instance_presence"].map(
        (typeName) => shouldSyncTldrawRecord({ id: `${typeName}:one`, typeName }),
      ),
    ).toEqual([false, false, false, false, false]);
    expect(shouldSyncTldrawRecord({ id: "plugin:one", typeName: "plugin" })).toBe(false);
  });

  it("copies local document add, update, and delete changes without session state", () => {
    const doc = new Y.Doc();
    const store = createTLStore();
    const binding = createTldrawBinding({ doc, store });
    const records = doc.getMap<unknown>(TLDRAW_RECORDS_KEY);
    const initial = userRecord(store);

    store.put([initial]);
    expect(records.get(initial.id)).toEqual(initial);

    const updated = { ...initial, name: "System map" } as TLRecord;
    store.put([updated]);
    expect(records.get(initial.id)).toEqual(updated);

    binding.write({ id: "camera:page:page", typeName: "camera" });
    binding.write({ id: "instance:instance", typeName: "instance" });
    binding.write({ id: "instance_page_state:page:page", typeName: "instance_page_state" });
    binding.write({ id: "pointer:pointer", typeName: "pointer" });
    binding.write({ id: "instance_presence:peer", typeName: "instance_presence" });
    expect([...records.keys()]).toEqual([initial.id]);

    store.remove([initial.id]);
    expect(records.has(initial.id)).toBe(false);

    binding.destroy();
    store.dispose();
    doc.destroy();
  });

  it("hydrates remote records before listening and ignores malformed values safely", () => {
    const doc = new Y.Doc();
    const sourceStore = createTLStore();
    const records = doc.getMap<unknown>(TLDRAW_RECORDS_KEY);
    const page = pageRecord(sourceStore);
    const document = documentRecord(sourceStore);
    records.set(page.id, page);
    records.set(document.id, document);
    records.set("shape:bad", { id: "shape:different", typeName: "shape" });
    const store = createTLStore();
    const onError = vi.fn();

    const binding = createTldrawBinding({ doc, onError, store });

    expect(store.get(document.id)).toEqual(document);
    expect(store.get(page.id)).toEqual(page);
    expect(store.get("shape:bad" as TLRecord["id"])).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("Ignored an invalid shared drawing record.");
    expect(records.get("shape:bad")).toEqual({
      id: "shape:different",
      typeName: "shape",
    });

    binding.destroy();
    sourceStore.dispose();
    store.dispose();
    doc.destroy();
  });

  it("applies remote add, update, and delete once without echoing them", () => {
    const doc = new Y.Doc();
    const sourceStore = createTLStore();
    const records = doc.getMap<unknown>(TLDRAW_RECORDS_KEY);
    const sharedDocument = documentRecord(sourceStore);
    const sharedPage = pageRecord(sourceStore);
    records.set(sharedDocument.id, sharedDocument);
    records.set(sharedPage.id, sharedPage);
    const store = createTLStore();
    const binding = createTldrawBinding({ doc, store });
    const page = userRecord(sourceStore);
    let mapEvents = 0;
    records.observe(() => {
      mapEvents += 1;
    });

    doc.transact(() => records.set(page.id, page), "remote-test");
    expect(store.get(page.id)).toEqual(page);
    expect(mapEvents).toBe(1);

    const updated = { ...page, name: "Remote participant" } as TLRecord;
    doc.transact(() => records.set(page.id, updated), "remote-test");
    expect(store.get(page.id)).toEqual(updated);
    expect(mapEvents).toBe(2);

    doc.transact(() => records.delete(page.id), "remote-test");
    expect(store.get(page.id)).toBeUndefined();
    expect(mapEvents).toBe(3);

    binding.destroy();
    sourceStore.dispose();
    store.dispose();
    doc.destroy();
  });

  it("destroys both listeners idempotently", () => {
    const doc = new Y.Doc();
    const sourceStore = createTLStore();
    const store = createTLStore();
    const binding = createTldrawBinding({ doc, store });
    const records = doc.getMap<unknown>(TLDRAW_RECORDS_KEY);

    binding.destroy();
    binding.destroy();
    store.put([documentRecord(store)]);
    expect(records.size).toBe(0);

    const page = pageRecord(sourceStore);
    records.set(page.id, page);
    expect(store.get(page.id)).toBeUndefined();

    sourceStore.dispose();
    store.dispose();
    doc.destroy();
  });
});

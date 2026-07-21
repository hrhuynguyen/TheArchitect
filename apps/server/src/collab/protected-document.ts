import {
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  SERVER_VOTES_MAP_KEY,
} from "@architect/contracts";
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";

function taggedValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    return {
      type: "Y.Map",
      entries: [...value.entries()]
        .map(([key, entry]) => [key, taggedValue(entry)] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    };
  }
  if (value instanceof Y.Array) {
    return { type: "Y.Array", values: value.toArray().map(taggedValue) };
  }
  if (value instanceof Y.Text) {
    return { type: "Y.Text", value: value.toString() };
  }
  return { type: "json", value };
}

function protectedStateFingerprint(document: Y.Doc) {
  const meta = document.getMap("meta");
  const entries = (mapName: string) => [...document.getMap(mapName).entries()]
    .map(([key, value]) => [key, taggedValue(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    architecture: entries(ARCHITECTURE_MAP_KEY),
    architectureLayout: entries(ARCHITECTURE_LAYOUT_MAP_KEY),
    phase: {
      present: meta.has("phase"),
      value: taggedValue(meta.get("phase")),
    },
    requirements:
      meta.get("phase") === "reconstructing" ? entries("requirements") : null,
    votes: entries(SERVER_VOTES_MAP_KEY),
  };
}

export function assertClientDocumentUpdateAllowed(
  document: Y.Doc,
  update: Uint8Array,
): void {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(candidate, update);
    const currentState = protectedStateFingerprint(document);
    const candidateState = protectedStateFingerprint(candidate);
    if (!isDeepStrictEqual(candidateState, currentState)) {
      throw new Error("Server-owned document state cannot be changed by clients");
    }
  } finally {
    candidate.destroy();
  }
}

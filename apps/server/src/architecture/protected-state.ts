import type { ReconstructionYjsState } from "@architect/contracts";
import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function protectedStateDigest(state: ReconstructionYjsState): string {
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

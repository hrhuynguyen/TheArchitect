import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_COLOR,
  loadGuestProfile,
  saveGuestProfile,
} from "./profile";

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe("guest profile storage", () => {
  it("round-trips a validated convenience profile", () => {
    const storage = memoryStorage();
    const profile = { name: "Ada", color: DEFAULT_PROFILE_COLOR };

    saveGuestProfile(profile, storage);

    expect(loadGuestProfile(storage)).toEqual(profile);
  });

  it("ignores corrupted or contract-invalid local storage", () => {
    expect(loadGuestProfile(memoryStorage("not-json"))).toBeNull();
    expect(
      loadGuestProfile(memoryStorage(JSON.stringify({ name: "", color: "sage" }))),
    ).toBeNull();
  });

  it("is safe when rendered without a browser storage object", () => {
    expect(loadGuestProfile(null)).toBeNull();
    expect(() =>
      saveGuestProfile({ name: "Ada", color: DEFAULT_PROFILE_COLOR }, null),
    ).not.toThrow();
  });
});

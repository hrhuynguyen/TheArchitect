import { describe, expect, it } from "vitest";
import {
  defaultRequirementsProfile,
  RequirementsProfileSchema,
} from "./requirements.js";

const expectedDefault = {
  version: "requirements/v1",
  audience: "external",
  criticality: "non_critical",
  expectedUsers: "tiny",
  traffic: "low",
  burstiness: "steady",
  asyncWorkload: false,
  availability: "best_effort",
  recovery: "flexible",
} as const;

describe("RequirementsProfileSchema", () => {
  it("creates the exact safe versioned default", () => {
    expect(defaultRequirementsProfile()).toEqual(expectedDefault);
  });

  it.each([
    { ...expectedDefault, version: "requirements/v2" },
    { ...expectedDefault, audience: "public" },
    { ...expectedDefault, unexpected: true },
  ])("rejects an unsupported or extended profile", (candidate) => {
    expect(RequirementsProfileSchema.safeParse(candidate).success).toBe(false);
  });

  it("returns independent frozen plain-object defaults", () => {
    const first = defaultRequirementsProfile();
    const second = defaultRequirementsProfile();

    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(() => {
      (first as { audience: string }).audience = "internal";
    }).toThrow();
    expect(second).toEqual(expectedDefault);
  });
});

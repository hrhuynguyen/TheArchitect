import { describe, expect, it } from "vitest";
import { AwarenessProfileSchema } from "./collaboration.js";

const profile = {
  participantId: "00000000-0000-4000-8000-000000000002",
  name: "Grace",
  color: "#ABCDEF",
  phase: "sketch",
  lastSeenAt: "2026-07-21T12:00:00.000Z",
};

describe("AwarenessProfileSchema", () => {
  it("accepts the exact transient profile with an optional finite cursor", () => {
    expect(AwarenessProfileSchema.parse(profile)).toEqual(profile);
    expect(
      AwarenessProfileSchema.parse({
        ...profile,
        cursor: { x: 12.5, y: -4 },
      }),
    ).toEqual({ ...profile, cursor: { x: 12.5, y: -4 } });
  });

  it.each([
    [{ ...profile, phase: "unknown" }],
    [{ ...profile, cursor: { x: Number.POSITIVE_INFINITY, y: 0 } }],
    [{ ...profile, lastSeenAt: "yesterday" }],
    [{ ...profile, secret: "must-not-enter-awareness" }],
  ])("rejects an invalid or additional awareness field", (input) => {
    expect(AwarenessProfileSchema.safeParse(input).success).toBe(false);
  });
});

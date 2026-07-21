import { describe, expect, it } from "vitest";

import {
  defaultRequirementsProfile,
  type RequirementsProfile,
} from "@architect/contracts/requirements";

import { selectStage } from "./staging.js";

const requirements = (
  overrides: Partial<RequirementsProfile> = {},
): RequirementsProfile => ({
  ...defaultRequirementsProfile(),
  ...overrides,
});

describe("selectStage", () => {
  it.each([
    ["prototype", requirements()],
    ["mvp", requirements({ traffic: "moderate" })],
    [
      "growth",
      requirements({
        criticality: "business_critical",
        traffic: "high",
        burstiness: "bursty",
        availability: "high_availability",
      }),
    ],
    [
      "production",
      requirements({
        criticality: "mission_critical",
        expectedUsers: "global",
        traffic: "extreme",
        burstiness: "spiky",
        availability: "continuous",
        recovery: "rapid",
      }),
    ],
  ] as const)("selects %s from deterministic requirement scoring", (stage, input) => {
    expect(selectStage(input).stage).toBe(stage);
  });

  it("proposes approval-gated redundant ingress for a bursty critical workload", () => {
    const result = selectStage(
      requirements({
        criticality: "business_critical",
        traffic: "high",
        burstiness: "bursty",
        availability: "high_availability",
      }),
    );

    expect(result).toMatchObject({
      stage: "growth",
      requiresApproval: true,
    });
    expect(result.proposedUpgrades).toContainEqual(
      expect.objectContaining({ id: "redundant-ingress" }),
    );
  });

  it("uses hard production floors for continuous availability and rapid mission recovery", () => {
    expect(
      selectStage(
        requirements({
          audience: "internal",
          criticality: "non_critical",
          availability: "continuous",
        }),
      ).stage,
    ).toBe("production");

    expect(
      selectStage(
        requirements({
          audience: "internal",
          criticality: "mission_critical",
          recovery: "rapid",
        }),
      ).stage,
    ).toBe("production");
  });

  it("returns stable, schema-valid output without mutating requirements", () => {
    const input = requirements({
      expectedUsers: "large",
      traffic: "high",
      asyncWorkload: true,
    });
    const before = structuredClone(input);

    expect(selectStage(input)).toEqual(selectStage(structuredClone(input)));
    expect(input).toEqual(before);
  });
});

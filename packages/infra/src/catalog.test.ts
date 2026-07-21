import { describe, expect, it } from "vitest";

import { AWS_RESOURCE_TYPES } from "@architect/contracts/infrastructure";
import { defaultRequirementsProfile } from "@architect/contracts/requirements";

import {
  RESOURCE_CATALOG,
  resourceCapabilitySchema,
} from "./catalog.js";
import { compileIntent } from "./compiler.js";

describe("RESOURCE_CATALOG", () => {
  it("defines a strict capability record for every allowlisted type", () => {
    expect(Object.keys(RESOURCE_CATALOG).sort()).toEqual(
      [...AWS_RESOURCE_TYPES].sort(),
    );

    for (const capability of Object.values(RESOURCE_CATALOG)) {
      expect(resourceCapabilitySchema.parse(capability)).toEqual(capability);
      expect(capability.diagramSupported).toBe(true);
    }
  });

  it("separates diagram-only actors and unsupported constructs from deployable resources", () => {
    expect(RESOURCE_CATALOG.External).toMatchObject({
      diagramOnly: true,
      synthSupported: false,
      localStackSupported: false,
      awsSupported: false,
    });
    expect(RESOURCE_CATALOG.MSK).toMatchObject({
      diagramOnly: false,
      synthSupported: false,
      localStackSupported: false,
      awsSupported: false,
    });
    expect(RESOURCE_CATALOG.CloudFront.synthSupported).toBe(false);
    expect(RESOURCE_CATALOG.RDS.synthSupported).toBe(false);
  });

  it("marks the v1 CDK subset consistently across synthesis targets", () => {
    for (const type of [
      "VPC",
      "Subnet",
      "SecurityGroup",
      "EC2",
      "ELB",
      "S3",
      "Lambda",
      "DynamoDB",
      "SNS",
      "SQS",
      "APIGateway",
      "IAMRole",
    ] as const) {
      expect(RESOURCE_CATALOG[type]).toMatchObject({
        diagramOnly: false,
        synthSupported: true,
        localStackSupported: true,
        awsSupported: true,
      });
    }
  });

  it("deep-freezes capability entries so mutation cannot change compiler gates", () => {
    const compileMsk = () =>
      compileIntent(
        {
          version: "infrastructure-intent/v1",
          resources: [{ id: "events", type: "MSK", name: "Events", properties: {} }],
          relationships: [],
        },
        defaultRequirementsProfile(),
      );

    expect(Object.isFrozen(RESOURCE_CATALOG)).toBe(true);
    expect(Object.values(RESOURCE_CATALOG).every(Object.isFrozen)).toBe(true);
    expect(() => {
      (RESOURCE_CATALOG.MSK as { synthSupported: boolean }).synthSupported = true;
    }).toThrow(TypeError);
    expect(compileMsk().diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "UNSUPPORTED_SYNTH_RESOURCE",
        resourceId: "events",
      }),
    );
  });
});

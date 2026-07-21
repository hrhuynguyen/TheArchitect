import { describe, expect, it } from "vitest";

import { AWS_RESOURCE_TYPES } from "@architect/contracts/infrastructure";

import {
  RESOURCE_CATALOG,
  resourceCapabilitySchema,
} from "./catalog.js";

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
});

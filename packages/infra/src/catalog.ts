import { z } from "zod";

import type { AwsResourceType } from "@architect/contracts/infrastructure";

export const resourceCapabilitySchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    category: z.enum([
      "actor",
      "compute",
      "storage",
      "database",
      "network",
      "integration",
      "security",
      "edge",
      "streaming",
    ]),
    diagramSupported: z.boolean(),
    diagramOnly: z.boolean(),
    synthSupported: z.boolean(),
    localStackSupported: z.boolean(),
    awsSupported: z.boolean(),
  })
  .strict();

export type ResourceCapability = z.infer<typeof resourceCapabilitySchema>;

function freezeCapability(capability: ResourceCapability): ResourceCapability {
  return Object.freeze(capability);
}

const deployable = (
  label: string,
  category: ResourceCapability["category"],
): ResourceCapability => freezeCapability({
  label,
  category,
  diagramSupported: true,
  diagramOnly: false,
  synthSupported: true,
  localStackSupported: true,
  awsSupported: true,
});

const unsupported = (
  label: string,
  category: ResourceCapability["category"],
): ResourceCapability => freezeCapability({
  label,
  category,
  diagramSupported: true,
  diagramOnly: false,
  synthSupported: false,
  localStackSupported: false,
  awsSupported: false,
});

export const RESOURCE_CATALOG = Object.freeze({
  External: freezeCapability({
    label: "External actor",
    category: "actor",
    diagramSupported: true,
    diagramOnly: true,
    synthSupported: false,
    localStackSupported: false,
    awsSupported: false,
  }),
  EC2: deployable("Amazon EC2", "compute"),
  S3: deployable("Amazon S3", "storage"),
  Lambda: deployable("AWS Lambda", "compute"),
  RDS: unsupported("Amazon RDS", "database"),
  DynamoDB: deployable("Amazon DynamoDB", "database"),
  VPC: deployable("Amazon VPC", "network"),
  Subnet: deployable("VPC subnet", "network"),
  SecurityGroup: deployable("VPC security group", "security"),
  InternetGateway: unsupported("Internet gateway", "network"),
  NatGateway: unsupported("NAT gateway", "network"),
  RouteTable: unsupported("Route table", "network"),
  APIGateway: deployable("Amazon API Gateway", "edge"),
  SNS: deployable("Amazon SNS", "integration"),
  SQS: deployable("Amazon SQS", "integration"),
  IAMRole: deployable("AWS IAM role", "security"),
  CloudFront: unsupported("Amazon CloudFront", "edge"),
  ELB: deployable("Elastic Load Balancing", "edge"),
  MSK: unsupported("Amazon MSK", "streaming"),
} satisfies Record<AwsResourceType, ResourceCapability>);

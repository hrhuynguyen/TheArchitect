import {
  AWS_RESOURCE_TYPES,
  type AwsResourceType,
} from "@architect/contracts";

export const RESOURCE_LABELS: Record<AwsResourceType, string> = {
  External: "External actor",
  EC2: "Amazon EC2",
  S3: "Amazon S3",
  Lambda: "AWS Lambda",
  RDS: "Amazon RDS",
  DynamoDB: "Amazon DynamoDB",
  VPC: "Amazon VPC",
  Subnet: "VPC subnet",
  SecurityGroup: "VPC security group",
  InternetGateway: "Internet gateway",
  NatGateway: "NAT gateway",
  RouteTable: "Route table",
  APIGateway: "Amazon API Gateway",
  SNS: "Amazon SNS",
  SQS: "Amazon SQS",
  IAMRole: "AWS IAM role",
  CloudFront: "Amazon CloudFront",
  ELB: "Elastic Load Balancing",
  MSK: "Amazon MSK",
};

export function ResourcePalette({
  disabled = false,
  onAdd,
}: Readonly<{
  disabled?: boolean;
  onAdd(resourceType: AwsResourceType): void;
}>) {
  return (
    <section className="resource-palette" aria-labelledby="resource-palette-title">
      <header>
        <p className="section-kicker">Node library</p>
        <h2 id="resource-palette-title">Add a resource</h2>
      </header>
      <div className="resource-palette__grid">
        {AWS_RESOURCE_TYPES.map((resourceType) => (
          <button
            aria-label={`Add ${RESOURCE_LABELS[resourceType]}`}
            disabled={disabled}
            key={resourceType}
            onClick={() => onAdd(resourceType)}
            title={RESOURCE_LABELS[resourceType]}
            type="button"
          >
            <strong>{resourceType}</strong>
            <span>{RESOURCE_LABELS[resourceType]}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

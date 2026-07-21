import {
  architectureRelationshipKindSchema,
  awsResourceTypeSchema,
  infrastructureIntentSchema,
  infrastructureZoneSchema,
  resourcePropertyValueSchema,
  type InfrastructureIntent,
} from "@architect/contracts";
import { z } from "zod";

type ResourcePropertyValue = z.infer<typeof resourcePropertyValueSchema>;

const forbiddenPropertyKeys = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const propertyEntrySchema = z.strictObject({
  key: z.string().trim().min(1).max(120),
  value: resourcePropertyValueSchema,
});

const propertyEntriesSchema = z
  .array(propertyEntrySchema)
  .max(100)
  .superRefine((entries, context) => {
    const keys = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (forbiddenPropertyKeys.has(entry.key)) {
        context.addIssue({
          code: "custom",
          path: [index, "key"],
          message: `Unsafe property key: ${entry.key}`,
        });
      }
      if (keys.has(entry.key)) {
        context.addIssue({
          code: "custom",
          path: [index, "key"],
          message: `Duplicate property key: ${entry.key}`,
        });
      }
      keys.add(entry.key);
    }
  });

const wireResourceSchema = z.strictObject({
  type: awsResourceTypeSchema,
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  count: z.number().finite().int().min(1).nullable(),
  zone: infrastructureZoneSchema.nullable(),
  properties: propertyEntriesSchema,
});

const wireRelationshipSchema = z.strictObject({
  id: z.string().trim().min(1).max(160).nullable(),
  sourceId: z.string().trim().min(1).max(120),
  targetId: z.string().trim().min(1).max(120),
  kind: architectureRelationshipKindSchema,
  label: z.string().trim().min(1).max(120).nullable(),
  direction: z.enum(["forward", "bidirectional"]).nullable(),
});

export const reconstructionWireSchema = z.strictObject({
  version: z.literal("infrastructure-intent/v1"),
  resources: z.array(wireResourceSchema).max(200),
  relationships: z.array(wireRelationshipSchema).max(500),
});

export type ReconstructionWireIntent = z.infer<
  typeof reconstructionWireSchema
>;

function compareKeys(
  left: { key: string },
  right: { key: string },
): number {
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

function normalizeProperties(
  entries: ReconstructionWireIntent["resources"][number]["properties"],
): Record<string, ResourcePropertyValue> {
  const properties: Record<string, ResourcePropertyValue> = Object.create(null);
  for (const entry of [...entries].sort(compareKeys)) {
    Object.defineProperty(properties, entry.key, {
      configurable: true,
      enumerable: true,
      value: entry.value,
      writable: true,
    });
  }
  return properties;
}

export function normalizeReconstructionWire(
  input: unknown,
): InfrastructureIntent {
  const wire = reconstructionWireSchema.parse(input);
  const normalized = {
    version: wire.version,
    resources: wire.resources.map((resource) => ({
      type: resource.type,
      id: resource.id,
      name: resource.name,
      ...(resource.count === null ? {} : { count: resource.count }),
      ...(resource.zone === null ? {} : { zone: resource.zone }),
      properties: normalizeProperties(resource.properties),
    })),
    relationships: wire.relationships.map((relationship) => ({
      ...(relationship.id === null ? {} : { id: relationship.id }),
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      kind: relationship.kind,
      ...(relationship.label === null ? {} : { label: relationship.label }),
      ...(relationship.direction === null
        ? {}
        : { direction: relationship.direction }),
    })),
  };
  return infrastructureIntentSchema.parse(normalized);
}

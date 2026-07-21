import { z } from "zod";
import { describe, expect, it } from "vitest";
import { assertStrictObjectSchema } from "./provider.js";
import {
  normalizeReconstructionWire,
  reconstructionWireSchema,
} from "./reconstruction-wire.js";

function propertyEntries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    key: `key-${String(index).padStart(3, "0")}`,
    value: index,
  }));
}

function wireIntent(
  properties: Array<{ key: string; value: string | number | boolean }> = [],
) {
  return {
    version: "infrastructure-intent/v1" as const,
    resources: [
      {
        type: "S3" as const,
        id: "bucket",
        name: "Uploads",
        count: null,
        zone: null,
        properties,
      },
    ],
    relationships: [],
  };
}

describe("strict reconstruction wire format", () => {
  it("normalizes dynamic property keys in deterministic sorted order", () => {
    const result = normalizeReconstructionWire(
      wireIntent([
        { key: "zeta", value: true },
        { key: "alpha", value: "first" },
        { key: "middle", value: 3 },
      ]),
    );

    expect(Object.keys(result.resources[0]!.properties)).toEqual([
      "alpha",
      "middle",
      "zeta",
    ]);
    expect(result.resources[0]!.properties).toEqual({
      alpha: "first",
      middle: 3,
      zeta: true,
    });
  });

  it("accepts exactly 100 property entries and rejects 101", () => {
    expect(reconstructionWireSchema.safeParse(wireIntent(propertyEntries(100))).success).toBe(
      true,
    );
    expect(reconstructionWireSchema.safeParse(wireIntent(propertyEntries(101))).success).toBe(
      false,
    );
  });

  it("rejects duplicate keys after normalization instead of overwriting", () => {
    const result = reconstructionWireSchema.safeParse(
      wireIntent([
        { key: "duplicate", value: "first" },
        { key: " duplicate ", value: "second" },
      ]),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Duplicate property key");
    }
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects prototype-sensitive property key %s",
    (key) => {
      const result = reconstructionWireSchema.safeParse(
        wireIntent([{ key, value: "blocked" }]),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "Unsafe property key",
        );
      }
    },
  );

  it("omits nullable optional fields and preserves strict relationships", () => {
    const result = normalizeReconstructionWire({
      ...wireIntent(),
      resources: [
        {
          ...wireIntent()["resources"][0],
          type: "Lambda" as const,
        },
        {
          type: "SQS" as const,
          id: "queue",
          name: "Queue",
          count: 2,
          zone: "regional" as const,
          properties: [],
        },
      ],
      relationships: [
        {
          id: null,
          sourceId: "bucket",
          targetId: "queue",
          kind: "publishes" as const,
          label: null,
          direction: null,
        },
      ],
    });

    expect(result.resources[0]).not.toHaveProperty("count");
    expect(result.resources[0]).not.toHaveProperty("zone");
    expect(result.resources[1]).toMatchObject({ count: 2, zone: "regional" });
    expect(result.relationships[0]).toEqual({
      sourceId: "bucket",
      targetId: "queue",
      kind: "publishes",
    });
  });

  it("rejects unknown fields on every wire object", () => {
    expect(
      reconstructionWireSchema.safeParse({
        ...wireIntent(),
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      reconstructionWireSchema.safeParse({
        ...wireIntent(),
        resources: [{ ...wireIntent().resources[0], unexpected: true }],
      }).success,
    ).toBe(false);
    expect(
      reconstructionWireSchema.safeParse({
        ...wireIntent(),
        resources: [
          {
            ...wireIntent().resources[0],
            properties: [{ key: "valid", value: true, unexpected: true }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("uses the shared application schema as final semantic authority", () => {
    const wireValidButApplicationInvalid = {
      ...wireIntent(),
      resources: [{ ...wireIntent().resources[0], count: 21 }],
    };
    expect(
      reconstructionWireSchema.safeParse(wireValidButApplicationInvalid).success,
    ).toBe(true);
    expect(() =>
      normalizeReconstructionWire(wireValidButApplicationInvalid),
    ).toThrow(z.ZodError);
  });

  it("emits a recursively closed root-object JSON schema", () => {
    const schema = z.toJSONSchema(reconstructionWireSchema, {
      target: "draft-7",
    });
    expect(() => assertStrictObjectSchema(schema)).not.toThrow();
  });
});

import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  AiConfigurationError,
  AiInputError,
  AiOutputError,
  AiProviderError,
  AiRecorderError,
  AiRefusalError,
  AiTimeoutError,
  assertStrictObjectSchema,
  parseAiExecutionOptions,
  parseArchitectInput,
  parseReconstructionInput,
  safeErrorCode,
  type ArchitectProtocol,
} from "./provider.js";

const VALID_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const INVALID_TRACE_SENTINEL = `RAW_TRACE_SECRET_${"x".repeat(200)}`;

describe("AI provider boundary", () => {
  it("accepts only finite bounded execution options", () => {
    expect(
      parseAiExecutionOptions({
        timeoutMs: 10_000,
        maxRetries: 1,
        outputRepairAttempts: 1,
      }),
    ).toEqual({
      timeoutMs: 10_000,
      maxRetries: 1,
      outputRepairAttempts: 1,
    });
    expect(parseAiExecutionOptions()).toEqual({
      timeoutMs: 60_000,
      maxRetries: 1,
      outputRepairAttempts: 1,
    });

    for (const input of [
      { timeoutMs: 999 },
      { timeoutMs: 120_001 },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { maxRetries: -1 },
      { maxRetries: 3 },
      { outputRepairAttempts: -1 },
      { outputRepairAttempts: 3 },
    ]) {
      expect(() => parseAiExecutionOptions(input)).toThrow(
        AiConfigurationError,
      );
    }
  });

  it("accepts an opaque safety identifier and structurally valid PNG data URL", () => {
    expect(
      parseReconstructionInput({
        traceId: "trace-1",
        safetyIdentifier: "opaque-room-user-hash",
        imageDataUrl: VALID_PNG,
      }),
    ).toEqual({
      traceId: "trace-1",
      safetyIdentifier: "opaque-room-user-hash",
      imageDataUrl: VALID_PNG,
    });
  });

  it.each([
    ["identifier longer than 64 characters", "x".repeat(65), VALID_PNG],
    ["empty identifier", "", VALID_PNG],
    ["non-PNG media type", "opaque", "data:image/jpeg;base64,/9j/"],
    ["invalid base64", "opaque", "data:image/png;base64,%%%%"],
    [
      "payload without a PNG signature",
      "opaque",
      `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`,
    ],
  ])("rejects invalid reconstruction input: %s", (_, safetyIdentifier, imageDataUrl) => {
    expect(() =>
      parseReconstructionInput({
        traceId: "trace-1",
        safetyIdentifier,
        imageDataUrl,
      }),
    ).toThrow(AiInputError);
  });

  it("replaces an invalid reconstruction trace ID in the public input error", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let error: unknown;
    try {
      parseReconstructionInput({
        traceId: INVALID_TRACE_SENTINEL,
        safetyIdentifier: "opaque",
        imageDataUrl: VALID_PNG,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AiInputError);
    expect(error).toMatchObject({ traceId: "invalid-trace-id" });
    expect(JSON.stringify(error)).not.toContain(INVALID_TRACE_SENTINEL);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("validates architect protocol input before rendering it", () => {
    const renderInput = vi.fn((input: { request: string }) => input.request);
    const outputSchema = z.strictObject({ response: z.string() });
    const protocol: ArchitectProtocol<
      { request: string },
      typeof outputSchema
    > = {
      name: "fixture_turn",
      systemPrompt: "Return a strict fixture turn.",
      inputSchema: z.strictObject({ request: z.string().min(1) }),
      outputSchema,
      renderInput,
    };

    expect(() =>
      parseArchitectInput(
        {
          traceId: "trace-2",
          safetyIdentifier: "opaque",
          input: { request: "" },
        },
        protocol,
      ),
    ).toThrow(AiInputError);
    expect(renderInput).not.toHaveBeenCalled();

    expect(
      parseArchitectInput(
        {
          traceId: "trace-2",
          safetyIdentifier: "opaque",
          input: { request: "explain" },
        },
        protocol,
      ),
    ).toEqual({
      traceId: "trace-2",
      safetyIdentifier: "opaque",
      input: { request: "explain" },
      renderedInput: "explain",
    });
    expect(renderInput).toHaveBeenCalledOnce();
  });

  it("replaces an invalid architect trace ID before rendering or erroring", () => {
    const renderInput = vi.fn((input: { request: string }) => input.request);
    const outputSchema = z.strictObject({ response: z.string() });
    const protocol: ArchitectProtocol<
      { request: string },
      typeof outputSchema
    > = {
      name: "fixture_turn",
      systemPrompt: "Return a strict fixture turn.",
      inputSchema: z.strictObject({ request: z.string() }),
      outputSchema,
      renderInput,
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let error: unknown;
    try {
      parseArchitectInput(
        {
          traceId: INVALID_TRACE_SENTINEL,
          safetyIdentifier: "opaque",
          input: { request: "explain" },
        },
        protocol,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AiInputError);
    expect(error).toMatchObject({ traceId: "invalid-trace-id" });
    expect(JSON.stringify(error)).not.toContain(INVALID_TRACE_SENTINEL);
    expect(renderInput).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("rejects every generated object schema that is not recursively closed", () => {
    expect(() =>
      assertStrictObjectSchema({
        type: "object",
        additionalProperties: false,
        properties: {
          nested: {
            type: "object",
            additionalProperties: false,
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { key: { type: "string" } },
              required: ["key"],
            },
          },
        },
        required: ["nested", "entries"],
      }),
    ).not.toThrow();

    expect(() =>
      assertStrictObjectSchema({
        type: "object",
        additionalProperties: false,
        properties: {
          nested: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
      }),
    ).toThrow(AiConfigurationError);
    expect(() => assertStrictObjectSchema({ type: "string" })).toThrow(
      AiConfigurationError,
    );
  });

  it("exposes only stable sanitized AI error state", () => {
    const sentinel = "RAW_PROVIDER_SECRET_MUST_NOT_ESCAPE";
    const errors = [
      new AiTimeoutError("trace-3"),
      new AiRefusalError("trace-3"),
      new AiProviderError("trace-3", "AI_PROVIDER_TRANSIENT", true),
      new AiOutputError("trace-3"),
      new AiInputError("trace-3"),
      new AiConfigurationError("trace-3"),
      new AiRecorderError("trace-3"),
    ];

    for (const error of errors) {
      expect(error.traceId).toBe("trace-3");
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("request");
      expect(error).not.toHaveProperty("response");
      expect(error.message).not.toContain(sentinel);
      expect(JSON.stringify(error)).not.toContain(sentinel);
      expect(Object.keys(error).sort()).toEqual(
        ["code", "fallbackEligible", "name", "traceId"].sort(),
      );
    }

    expect(errors.slice(0, 4).map((error) => error.fallbackEligible)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(errors.slice(4).every((error) => !error.fallbackEligible)).toBe(
      true,
    );
    expect(safeErrorCode(new Error(sentinel))).toBe("AI_UNKNOWN_ERROR");
    expect(safeErrorCode(errors[0])).toBe("AI_TIMEOUT");
  });
});

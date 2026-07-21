import OpenAI from "openai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  AiConfigurationError,
  AiOutputError,
  AiProviderError,
  AiRefusalError,
  AiTimeoutError,
  assertStrictObjectSchema,
  type ArchitectProtocol,
} from "./provider.js";
import { createOpenAiProvider } from "./openai.provider.js";

const VALID_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const RAW_SENTINEL = "RAW_PROVIDER_SECRET_MUST_NOT_ESCAPE";

const validWireIntent = {
  version: "infrastructure-intent/v1",
  resources: [
    {
      type: "S3",
      id: "bucket",
      name: "Uploads",
      count: null,
      zone: null,
      properties: [{ key: "versioned", value: true }],
    },
  ],
  relationships: [],
};

const reconstructionInput = {
  traceId: "trace-openai",
  safetyIdentifier: "opaque-safety-id",
  imageDataUrl: VALID_PNG,
};

function harness(
  responses: unknown[],
  execution = { timeoutMs: 10_000, maxRetries: 1, outputRepairAttempts: 1 },
) {
  const queue = [...responses];
  const parse = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const provider = createOpenAiProvider({
    apiKey: `test-key-${RAW_SENTINEL}`,
    visionModel: "gpt-5.6",
    architectModel: "gpt-5.6-architect",
    execution,
    client: { responses: { parse } },
  });
  return { parse, provider };
}

const fixtureProtocol: ArchitectProtocol<
  { request: string },
  { response: string; operations: Array<{ kind: "fixture" }> }
> = {
  name: "fixture_architect_turn",
  systemPrompt: "Return a strict fixture response.",
  inputSchema: z.strictObject({ request: z.string().min(1) }),
  outputSchema: z.strictObject({
    response: z.string(),
    operations: z.array(z.strictObject({ kind: z.literal("fixture") })),
  }),
  renderInput: ({ request }) => JSON.stringify({ request }),
};

describe("OpenAI provider", () => {
  it("sends PNG image input and parses a strict normalized InfrastructureIntent", async () => {
    const { parse, provider } = harness([
      { output_parsed: validWireIntent, output: [] },
    ]);

    await expect(provider.reconstruct(reconstructionInput)).resolves.toEqual({
      version: "infrastructure-intent/v1",
      resources: [
        {
          type: "S3",
          id: "bucket",
          name: "Uploads",
          properties: { versioned: true },
        },
      ],
      relationships: [],
    });

    expect(parse).toHaveBeenCalledOnce();
    const [request, options] = parse.mock.calls[0]!;
    expect(request).toEqual(
      expect.objectContaining({
        model: "gpt-5.6",
        safety_identifier: "opaque-safety-id",
        input: [
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "input_text" }),
              {
                type: "input_image",
                image_url: VALID_PNG,
                detail: "high",
              },
            ]),
          }),
        ],
        text: {
          format: expect.objectContaining({
            type: "json_schema",
            strict: true,
          }),
        },
      }),
    );
    expect(options).toEqual({ timeout: 10_000, maxRetries: 1 });
    expect(() =>
      assertStrictObjectSchema(
        (request as { text: { format: { schema: unknown } } }).text.format
          .schema,
      ),
    ).not.toThrow();
    expect(provider.identity("reconstruct")).toEqual({
      provider: "openai",
      model: "gpt-5.6",
    });
    expect(provider.identity("architect")).toEqual({
      provider: "openai",
      model: "gpt-5.6-architect",
    });
  });

  it("uses the injected strict protocol for architect turns", async () => {
    const output = {
      response: "Use a queue.",
      operations: [{ kind: "fixture" as const }],
    };
    const { parse, provider } = harness([
      { output_parsed: output, output: [] },
    ]);

    await expect(
      provider.architect(
        {
          traceId: "trace-architect",
          safetyIdentifier: "opaque-architect-id",
          input: { request: "improve resilience" },
        },
        fixtureProtocol,
      ),
    ).resolves.toEqual(output);

    const [request] = parse.mock.calls[0]!;
    expect(request).toEqual(
      expect.objectContaining({
        model: "gpt-5.6-architect",
        safety_identifier: "opaque-architect-id",
        input: expect.arrayContaining([
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({
            role: "user",
            content: JSON.stringify({ request: "improve resilience" }),
          }),
        ]),
        text: {
          format: expect.objectContaining({
            name: "fixture_architect_turn",
            strict: true,
          }),
        },
      }),
    );
  });

  it("validates architect input before rendering or calling OpenAI", async () => {
    const renderInput = vi.fn(fixtureProtocol.renderInput);
    const { parse, provider } = harness([]);

    await expect(
      provider.architect(
        {
          traceId: "trace-invalid",
          safetyIdentifier: "opaque",
          input: { request: "" },
        },
        { ...fixtureProtocol, renderInput },
      ),
    ).rejects.toMatchObject({
      code: "AI_INPUT_INVALID",
      fallbackEligible: false,
    });
    expect(renderInput).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it("maps structured refusal content without retaining refusal text", async () => {
    const { parse, provider } = harness([
      {
        output_parsed: null,
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: RAW_SENTINEL }],
          },
        ],
      },
    ]);

    const error = await provider.reconstruct(reconstructionInput).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AiRefusalError);
    expect(JSON.stringify(error)).not.toContain(RAW_SENTINEL);
    expect((error as Error).message).not.toContain(RAW_SENTINEL);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("repairs invalid structured output iteratively within the configured bound", async () => {
    const { parse, provider } = harness([
      { output_parsed: { version: "wrong" }, output: [] },
      { output_parsed: validWireIntent, output: [] },
    ]);

    await expect(provider.reconstruct(reconstructionInput)).resolves.toMatchObject({
      version: "infrastructure-intent/v1",
    });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        input: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "input_text",
                text: expect.stringContaining("previous output"),
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it("makes only the final exhausted output error fallback eligible", async () => {
    const { parse, provider } = harness([
      { output_parsed: null, output: [] },
      { output_parsed: { version: "wrong" }, output: [] },
    ]);

    const error = await provider.reconstruct(reconstructionInput).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AiOutputError);
    expect(error).toMatchObject({
      code: "AI_OUTPUT_INVALID",
      fallbackEligible: true,
    });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new OpenAI.APIConnectionTimeoutError({ message: RAW_SENTINEL }), AiTimeoutError],
    [new OpenAI.APIConnectionError({ message: RAW_SENTINEL }), AiProviderError],
    [
      OpenAI.APIError.generate(
        429,
        { error: { message: RAW_SENTINEL } },
        RAW_SENTINEL,
        new Headers(),
      ),
      AiProviderError,
    ],
  ])("maps allowlisted transient SDK failure %#", async (sdkError, expectedClass) => {
    const { parse, provider } = harness([sdkError]);
    const error = await provider.reconstruct(reconstructionInput).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(expectedClass);
    expect(error).toMatchObject({ fallbackEligible: true });
    expect(JSON.stringify(error)).not.toContain(RAW_SENTINEL);
    expect((error as Error).message).not.toContain(RAW_SENTINEL);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("sanitizes non-transient and unknown SDK throws without fallback eligibility", async () => {
    for (const sdkError of [
      OpenAI.APIError.generate(
        401,
        { error: { message: RAW_SENTINEL } },
        RAW_SENTINEL,
        new Headers(),
      ),
      new Error(RAW_SENTINEL),
    ]) {
      const { parse, provider } = harness([sdkError]);
      const error = await provider.reconstruct(reconstructionInput).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AiProviderError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_ERROR",
        fallbackEligible: false,
      });
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain(RAW_SENTINEL);
      expect((error as Error).message).not.toContain(RAW_SENTINEL);
      expect(parse).toHaveBeenCalledOnce();
    }
  });

  it("rejects invalid configuration before constructing or calling an SDK client", async () => {
    const { parse, provider } = harness([]);
    const invalid = createOpenAiProvider({
      apiKey: "",
      visionModel: "",
      architectModel: "",
      execution: {
        timeoutMs: 10_000,
        maxRetries: 1,
        outputRepairAttempts: 1,
      },
      client: { responses: { parse } },
    });

    await expect(invalid.reconstruct(reconstructionInput)).rejects.toBeInstanceOf(
      AiConfigurationError,
    );
    expect(parse).not.toHaveBeenCalled();
    expect(provider.identity("reconstruct").model).toBe("gpt-5.6");
  });

  it("does not log or copy request secrets into result and error surfaces", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { provider } = harness([
      { output_parsed: validWireIntent, output: [] },
    ]);

    try {
      const result = await provider.reconstruct(reconstructionInput);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(VALID_PNG);
      expect(serialized).not.toContain("opaque-safety-id");
      expect(serialized).not.toContain(RAW_SENTINEL);
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });
});

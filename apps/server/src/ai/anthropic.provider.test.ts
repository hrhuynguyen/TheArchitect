import Anthropic from "@anthropic-ai/sdk";
import { parseMessage } from "@anthropic-ai/sdk/lib/parser";
import type {
  Message,
  MessageCreateParamsNonStreaming,
  StopReason,
} from "@anthropic-ai/sdk/resources/messages/messages";
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
import { createAnthropicProvider } from "./anthropic.provider.js";

const VALID_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BASE64 = VALID_PNG.slice("data:image/png;base64,".length);
const RAW_SENTINEL = "RAW_ANTHROPIC_SECRET_MUST_NOT_ESCAPE";

const validWireIntent = {
  version: "infrastructure-intent/v1",
  resources: [
    {
      type: "SQS",
      id: "queue",
      name: "Work queue",
      count: null,
      zone: "regional",
      properties: [{ key: "encrypted", value: true }],
    },
  ],
  relationships: [],
};

const reconstructionInput = {
  traceId: "trace-anthropic",
  safetyIdentifier: "opaque-anthropic-id",
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
  const provider = createAnthropicProvider({
    apiKey: `test-key-${RAW_SENTINEL}`,
    model: "configured-anthropic-model",
    execution,
    client: { messages: { parse } },
  });
  return { parse, provider };
}

function rawAnthropicMessage(text: string, stopReason: StopReason): Message {
  return {
    id: "message-fixture",
    type: "message",
    role: "assistant",
    model: "configured-anthropic-model",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as Message;
}

function realParserHarness(messages: Message[]) {
  const queue = [...messages];
  const parse = vi.fn(async (request: MessageCreateParamsNonStreaming) => {
    const message = queue.shift();
    if (message === undefined) throw new Error("Missing message fixture.");
    return parseMessage(message, request, { logger: console });
  });
  const provider = createAnthropicProvider({
    apiKey: `test-key-${RAW_SENTINEL}`,
    model: "configured-anthropic-model",
    execution: { timeoutMs: 10_000, maxRetries: 1, outputRepairAttempts: 1 },
    client: { messages: { parse } },
  });
  return { parse, provider };
}

const fixtureOutputSchema = z.strictObject({
  response: z.string(),
  operations: z.array(z.strictObject({ kind: z.literal("fixture") })),
});

const fixtureProtocol: ArchitectProtocol<
  { request: string },
  typeof fixtureOutputSchema
> = {
  name: "fixture_architect_turn",
  systemPrompt: "Return a strict fixture response.",
  inputSchema: z.strictObject({ request: z.string().min(1) }),
  outputSchema: fixtureOutputSchema,
  renderInput: ({ request }) => JSON.stringify({ request }),
};

describe("Anthropic provider", () => {
  it("sends typed image input and parses a strict normalized InfrastructureIntent", async () => {
    const { parse, provider } = harness([
      { parsed_output: validWireIntent, stop_reason: "end_turn", content: [] },
    ]);

    await expect(provider.reconstruct(reconstructionInput)).resolves.toEqual({
      version: "infrastructure-intent/v1",
      resources: [
        {
          type: "SQS",
          id: "queue",
          name: "Work queue",
          zone: "regional",
          properties: { encrypted: true },
        },
      ],
      relationships: [],
    });

    expect(parse).toHaveBeenCalledOnce();
    const [request, options] = parse.mock.calls[0]!;
    expect(request).toEqual(
      expect.objectContaining({
        model: "configured-anthropic-model",
        max_tokens: 4_096,
        metadata: { user_id: "opaque-anthropic-id" },
        system: expect.any(String),
        messages: [
          {
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text" }),
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: PNG_BASE64,
                },
              },
            ]),
          },
        ],
        output_config: {
          format: expect.objectContaining({ type: "json_schema" }),
        },
      }),
    );
    expect(options).toEqual({ timeout: 10_000, maxRetries: 1 });
    expect(() =>
      assertStrictObjectSchema(
        (request as {
          output_config: { format: { schema: unknown } };
        }).output_config.format.schema,
      ),
    ).not.toThrow();
    expect(provider.identity("reconstruct")).toEqual({
      provider: "anthropic",
      model: "configured-anthropic-model",
    });
    expect(provider.identity("architect")).toEqual({
      provider: "anthropic",
      model: "configured-anthropic-model",
    });
  });

  it("uses the same injected strict protocol for architect turns", async () => {
    const output = {
      response: "Use a queue.",
      operations: [{ kind: "fixture" as const }],
    };
    const { parse, provider } = harness([
      { parsed_output: output, stop_reason: "end_turn", content: [] },
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
        model: "configured-anthropic-model",
        metadata: { user_id: "opaque-architect-id" },
        system: expect.stringContaining(fixtureProtocol.systemPrompt),
        messages: [
          {
            role: "user",
            content: JSON.stringify({ request: "improve resilience" }),
          },
        ],
        output_config: {
          format: expect.objectContaining({ type: "json_schema" }),
        },
      }),
    );
  });

  it("validates protocol input before rendering or calling Anthropic", async () => {
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

  it("maps the official refusal stop reason without retaining stop details", async () => {
    const { parse, provider } = harness([
      {
        parsed_output: null,
        stop_reason: "refusal",
        stop_details: { type: "refusal", explanation: RAW_SENTINEL },
        content: [],
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

  it("repairs wire-valid but application-invalid output within a bounded loop", async () => {
    const invalidCount = {
      ...validWireIntent,
      resources: [{ ...validWireIntent.resources[0], count: 21 }],
    };
    const { parse, provider } = harness([
      { parsed_output: invalidCount, stop_reason: "end_turn", content: [] },
      { parsed_output: validWireIntent, stop_reason: "end_turn", content: [] },
    ]);

    await expect(provider.reconstruct(reconstructionInput)).resolves.toMatchObject({
      version: "infrastructure-intent/v1",
    });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("previous output"),
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it("returns only the final exhausted output error as fallback eligible", async () => {
    const { parse, provider } = harness([
      { parsed_output: null, stop_reason: "end_turn", content: [] },
      { parsed_output: { version: "wrong" }, stop_reason: "end_turn", content: [] },
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

  it("keeps the SDK helper's structured-output parse failure inside repair", async () => {
    const { parse, provider } = harness([
      new Anthropic.AnthropicError(RAW_SENTINEL),
      { parsed_output: validWireIntent, stop_reason: "end_turn", content: [] },
    ]);

    await expect(provider.reconstruct(reconstructionInput)).resolves.toMatchObject({
      version: "infrastructure-intent/v1",
    });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("repairs malformed JSON thrown by the installed Messages parser", async () => {
    const { parse, provider } = realParserHarness([
      rawAnthropicMessage(`{"version":`, "end_turn"),
      rawAnthropicMessage(JSON.stringify(validWireIntent), "end_turn"),
    ]);

    await expect(provider.reconstruct(reconstructionInput)).resolves.toMatchObject({
      version: "infrastructure-intent/v1",
    });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("repairs max-token truncation before accepting parsed output", async () => {
    const { parse, provider } = realParserHarness([
      rawAnthropicMessage(JSON.stringify(validWireIntent), "max_tokens"),
      rawAnthropicMessage(JSON.stringify(validWireIntent), "end_turn"),
    ]);

    await expect(provider.reconstruct(reconstructionInput)).resolves.toMatchObject({
      version: "infrastructure-intent/v1",
    });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      new Anthropic.APIConnectionTimeoutError({ message: RAW_SENTINEL }),
      AiTimeoutError,
    ],
    [new Anthropic.APIConnectionError({ message: RAW_SENTINEL }), AiProviderError],
    [
      Anthropic.APIError.generate(
        408,
        { error: { type: "request_timeout", message: RAW_SENTINEL } },
        RAW_SENTINEL,
        new Headers(),
      ),
      AiProviderError,
    ],
    [
      Anthropic.APIError.generate(
        409,
        { error: { type: "conflict_error", message: RAW_SENTINEL } },
        RAW_SENTINEL,
        new Headers(),
      ),
      AiProviderError,
    ],
    [
      Anthropic.APIError.generate(
        429,
        { error: { type: "rate_limit_error", message: RAW_SENTINEL } },
        RAW_SENTINEL,
        new Headers(),
      ),
      AiProviderError,
    ],
    [
      Anthropic.APIError.generate(
        500,
        { error: { type: "api_error", message: RAW_SENTINEL } },
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

  it("sanitizes non-transient and unknown SDK throws without raw state", async () => {
    for (const sdkError of [
      Anthropic.APIError.generate(
        401,
        { error: { type: "authentication_error", message: RAW_SENTINEL } },
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

  it("rejects an unconfigured Anthropic model before the SDK call", async () => {
    const { parse } = harness([]);
    const provider = createAnthropicProvider({
      apiKey: "",
      model: "",
      execution: {
        timeoutMs: 10_000,
        maxRetries: 1,
        outputRepairAttempts: 1,
      },
      client: { messages: { parse } },
    });

    await expect(provider.reconstruct(reconstructionInput)).rejects.toBeInstanceOf(
      AiConfigurationError,
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it("does not log or copy image, identifier, key, prompt, or raw error data", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { provider } = harness([
      { parsed_output: validWireIntent, stop_reason: "end_turn", content: [] },
    ]);

    try {
      const result = await provider.reconstruct(reconstructionInput);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(VALID_PNG);
      expect(serialized).not.toContain("opaque-anthropic-id");
      expect(serialized).not.toContain(RAW_SENTINEL);
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });
});

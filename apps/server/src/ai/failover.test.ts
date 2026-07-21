import type { InfrastructureIntent } from "@architect/contracts";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createFailoverProvider } from "./failover.js";
import {
  AiConfigurationError,
  AiInputError,
  AiOutputError,
  AiProviderError,
  AiRecorderError,
  AiRefusalError,
  AiTimeoutError,
  type AiProvider,
  type AiRunRecorder,
  type AiTask,
  type ArchitectProtocol,
  type ArchitectTurnInput,
  type ProviderIdentity,
  type ReconstructionInput,
} from "./provider.js";

const IMAGE_SENTINEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const RAW_SENTINEL = "RAW_APPLICATION_SECRET_MUST_NOT_ESCAPE";
const INVALID_TRACE_SENTINEL = `RAW_TRACE_SECRET_${"x".repeat(200)}`;
const reconstructionInput: ReconstructionInput = {
  traceId: "trace-1",
  safetyIdentifier: `opaque-${RAW_SENTINEL}`,
  imageDataUrl: IMAGE_SENTINEL,
};

const primaryIntent: InfrastructureIntent = {
  version: "infrastructure-intent/v1",
  resources: [],
  relationships: [],
};
const fallbackIntent: InfrastructureIntent = {
  version: "infrastructure-intent/v1",
  resources: [
    {
      type: "SQS",
      id: "fallback-queue",
      name: "Fallback queue",
      properties: {},
    },
  ],
  relationships: [],
};

type ReconstructionHandler = (
  input: ReconstructionInput,
) => Promise<InfrastructureIntent>;

class StubProvider implements AiProvider {
  readonly reconstruct;
  readonly identity;
  architectCalls = 0;

  constructor(
    providerIdentity: ProviderIdentity,
    reconstructHandler: ReconstructionHandler,
    private readonly architectHandler: (
      input: ArchitectTurnInput<unknown>,
    ) => Promise<unknown> = async () => ({ response: "stub" }),
  ) {
    this.reconstruct = vi.fn(reconstructHandler);
    this.identity = vi.fn((_task: AiTask) => providerIdentity);
  }

  async architect<TInput, TOutputSchema extends z.ZodObject>(
    input: ArchitectTurnInput<TInput>,
    protocol: ArchitectProtocol<TInput, TOutputSchema>,
  ): Promise<z.output<TOutputSchema>> {
    this.architectCalls += 1;
    const output = await this.architectHandler(input);
    return protocol.outputSchema.parse(output);
  }
}

function resolving(
  identity: ProviderIdentity,
  value: InfrastructureIntent,
): StubProvider {
  return new StubProvider(identity, async () => value);
}

function rejecting(identity: ProviderIdentity, error: unknown): StubProvider {
  return new StubProvider(identity, async () => {
    throw error;
  });
}

const primaryIdentity: ProviderIdentity = {
  provider: "openai",
  model: "gpt-5.6",
};
const fallbackIdentity: ProviderIdentity = {
  provider: "anthropic",
  model: "configured-anthropic-model",
};

describe("AI provider failover", () => {
  it.each([
    [new AiTimeoutError("trace-1"), true],
    [new AiRefusalError("trace-1"), true],
    [new AiProviderError("trace-1", "AI_PROVIDER_TRANSIENT", true), true],
    [new AiOutputError("trace-1"), true],
    [new AiInputError("trace-1"), false],
    [new AiConfigurationError("trace-1"), false],
    [new AiProviderError("trace-1"), false],
    [new AiRecorderError("trace-1"), false],
    [new Error(RAW_SENTINEL), false],
  ])("falls back only for explicit eligibility %#", async (error, eligible) => {
    const primary = rejecting(primaryIdentity, error);
    const fallback = resolving(fallbackIdentity, fallbackIntent);
    const recordTerminal = vi.fn<AiRunRecorder>(async () => undefined);
    const provider = createFailoverProvider(primary, fallback, { recordTerminal });

    const result = provider.reconstruct(reconstructionInput);
    if (eligible) {
      await expect(result).resolves.toBe(fallbackIntent);
      expect(fallback.reconstruct).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toBe(error);
      expect(fallback.reconstruct).not.toHaveBeenCalled();
    }
    expect(primary.reconstruct).toHaveBeenCalledOnce();
    expect(recordTerminal).toHaveBeenCalledOnce();
  });

  it("calls fallback at most once and returns the fallback failure", async () => {
    const primaryError = new AiTimeoutError("trace-1");
    const fallbackError = new AiRefusalError("trace-1");
    const primary = rejecting(primaryIdentity, primaryError);
    const fallback = rejecting(fallbackIdentity, fallbackError);
    const recordTerminal = vi.fn<AiRunRecorder>(async () => undefined);
    const provider = createFailoverProvider(primary, fallback, { recordTerminal });

    await expect(provider.reconstruct(reconstructionInput)).rejects.toBe(
      fallbackError,
    );
    expect(primary.reconstruct).toHaveBeenCalledOnce();
    expect(fallback.reconstruct).toHaveBeenCalledOnce();
    expect(recordTerminal).toHaveBeenCalledOnce();
    expect(recordTerminal).toHaveBeenCalledWith({
      traceId: "trace-1",
      task: "reconstruct",
      provider: "anthropic",
      model: "configured-anthropic-model",
      status: "failed",
      errorCode: "AI_REFUSAL",
    });
  });

  it.each([
    {
      name: "primary success",
      primaryError: null,
      fallbackError: null,
      expectedProvider: "openai" as const,
      expectedModel: "gpt-5.6",
      expectedStatus: "succeeded" as const,
      expectedCode: undefined,
    },
    {
      name: "terminal primary failure",
      primaryError: new AiInputError("trace-1"),
      fallbackError: null,
      expectedProvider: "openai" as const,
      expectedModel: "gpt-5.6",
      expectedStatus: "failed" as const,
      expectedCode: "AI_INPUT_INVALID",
    },
    {
      name: "fallback success",
      primaryError: new AiTimeoutError("trace-1"),
      fallbackError: null,
      expectedProvider: "anthropic" as const,
      expectedModel: "configured-anthropic-model",
      expectedStatus: "succeeded" as const,
      expectedCode: undefined,
    },
    {
      name: "terminal fallback failure",
      primaryError: new AiTimeoutError("trace-1"),
      fallbackError: new AiProviderError("trace-1"),
      expectedProvider: "anthropic" as const,
      expectedModel: "configured-anthropic-model",
      expectedStatus: "failed" as const,
      expectedCode: "AI_PROVIDER_ERROR",
    },
  ])("records exactly one safe terminal record for $name", async (scenario) => {
    const primary = scenario.primaryError
      ? rejecting(primaryIdentity, scenario.primaryError)
      : resolving(primaryIdentity, primaryIntent);
    const fallback = scenario.fallbackError
      ? rejecting(fallbackIdentity, scenario.fallbackError)
      : resolving(fallbackIdentity, fallbackIntent);
    const recordTerminal = vi.fn<AiRunRecorder>(async () => undefined);
    const provider = createFailoverProvider(primary, fallback, { recordTerminal });

    await provider.reconstruct(reconstructionInput).catch(() => undefined);

    expect(recordTerminal).toHaveBeenCalledOnce();
    expect(recordTerminal).toHaveBeenCalledWith({
      traceId: "trace-1",
      task: "reconstruct",
      provider: scenario.expectedProvider,
      model: scenario.expectedModel,
      status: scenario.expectedStatus,
      ...(scenario.expectedCode === undefined
        ? {}
        : { errorCode: scenario.expectedCode }),
    });
    const serializedRecord = JSON.stringify(recordTerminal.mock.calls[0]?.[0]);
    expect(serializedRecord).not.toContain(IMAGE_SENTINEL);
    expect(serializedRecord).not.toContain(RAW_SENTINEL);
    expect(Object.keys(recordTerminal.mock.calls[0]?.[0] ?? {}).sort()).toEqual(
      [
        "traceId",
        "task",
        "provider",
        "model",
        "status",
        ...(scenario.expectedCode === undefined ? [] : ["errorCode"]),
      ].sort(),
    );
  });

  it("awaits the sole terminal recorder before resolving", async () => {
    let releaseRecorder: (() => void) | undefined;
    const recordTerminal = vi.fn<AiRunRecorder>(
      () =>
        new Promise<void>((resolve) => {
          releaseRecorder = resolve;
        }),
    );
    const primary = resolving(primaryIdentity, primaryIntent);
    const fallback = resolving(fallbackIdentity, fallbackIntent);
    const provider = createFailoverProvider(primary, fallback, { recordTerminal });
    let operationSettled = false;

    const operation = provider.reconstruct(reconstructionInput).finally(() => {
      operationSettled = true;
    });
    await vi.waitFor(() => expect(recordTerminal).toHaveBeenCalledOnce());
    expect(operationSettled).toBe(false);
    releaseRecorder?.();

    await expect(operation).resolves.toBe(primaryIntent);
    expect(operationSettled).toBe(true);
    expect(recordTerminal).toHaveBeenCalledOnce();
  });

  it("returns a sanitized ineligible recorder error without fallback", async () => {
    const recordTerminal = vi.fn<AiRunRecorder>(async () => {
      throw new Error(RAW_SENTINEL);
    });
    const primary = resolving(primaryIdentity, primaryIntent);
    const fallback = resolving(fallbackIdentity, fallbackIntent);
    const provider = createFailoverProvider(primary, fallback, { recordTerminal });

    const error = await provider.reconstruct(reconstructionInput).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AiRecorderError);
    expect(error).toMatchObject({
      code: "AI_RECORDER_ERROR",
      fallbackEligible: false,
    });
    expect(error).not.toHaveProperty("cause");
    expect((error as Error).message).not.toContain(RAW_SENTINEL);
    expect(JSON.stringify(error)).not.toContain(RAW_SENTINEL);
    expect(fallback.reconstruct).not.toHaveBeenCalled();
    expect(recordTerminal).toHaveBeenCalledOnce();
  });

  it("preserves an arbitrary application error while recording only a generic code", async () => {
    const applicationError = new Error(RAW_SENTINEL);
    const primary = rejecting(primaryIdentity, applicationError);
    const fallback = resolving(fallbackIdentity, fallbackIntent);
    const recordTerminal = vi.fn<AiRunRecorder>(async () => undefined);
    const provider = createFailoverProvider(primary, fallback, { recordTerminal });

    await expect(provider.reconstruct(reconstructionInput)).rejects.toBe(
      applicationError,
    );
    expect(fallback.reconstruct).not.toHaveBeenCalled();
    expect(recordTerminal).toHaveBeenCalledWith({
      traceId: "trace-1",
      task: "reconstruct",
      provider: "openai",
      model: "gpt-5.6",
      status: "failed",
      errorCode: "AI_UNKNOWN_ERROR",
    });
    expect(JSON.stringify(recordTerminal.mock.calls[0]?.[0])).not.toContain(
      RAW_SENTINEL,
    );
  });

  it("records a safe placeholder for an invalid reconstruction trace ID", async () => {
    const recordTerminal = vi.fn<AiRunRecorder>(async () => undefined);
    const primary = resolving(primaryIdentity, primaryIntent);
    const fallback = resolving(fallbackIdentity, fallbackIntent);
    const provider = createFailoverProvider(primary, fallback, { recordTerminal });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        provider.reconstruct({
          ...reconstructionInput,
          traceId: INVALID_TRACE_SENTINEL,
        }),
      ).resolves.toBe(primaryIntent);
      expect(recordTerminal).toHaveBeenCalledWith({
        traceId: "invalid-trace-id",
        task: "reconstruct",
        provider: "openai",
        model: "gpt-5.6",
        status: "succeeded",
      });
      expect(JSON.stringify(recordTerminal.mock.calls[0]?.[0])).not.toContain(
        INVALID_TRACE_SENTINEL,
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("records a safe placeholder for an invalid architect trace ID", async () => {
    const outputSchema = z.strictObject({ response: z.string() });
    const protocol: ArchitectProtocol<
      { request: string },
      typeof outputSchema
    > = {
      name: "fixture_turn",
      systemPrompt: "Return the fixture.",
      inputSchema: z.strictObject({ request: z.string() }),
      outputSchema,
      renderInput: ({ request }) => request,
    };
    const primary = new StubProvider(
      primaryIdentity,
      async () => primaryIntent,
      async () => ({ response: "primary architect response" }),
    );
    const fallback = resolving(fallbackIdentity, fallbackIntent);
    const recordTerminal = vi.fn<AiRunRecorder>(async () => undefined);
    const provider = createFailoverProvider(primary, fallback, { recordTerminal });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        provider.architect(
          {
            traceId: INVALID_TRACE_SENTINEL,
            safetyIdentifier: "opaque",
            input: { request: "explain" },
          },
          protocol,
        ),
      ).resolves.toEqual({ response: "primary architect response" });
      expect(recordTerminal).toHaveBeenCalledWith({
        traceId: "invalid-trace-id",
        task: "architect",
        provider: "openai",
        model: "gpt-5.6",
        status: "succeeded",
      });
      expect(JSON.stringify(recordTerminal.mock.calls[0]?.[0])).not.toContain(
        INVALID_TRACE_SENTINEL,
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("forwards generic architect protocols through the same bounded boundary", async () => {
    const outputSchema = z.strictObject({ response: z.string() });
    const protocol: ArchitectProtocol<
      { request: string },
      typeof outputSchema
    > = {
      name: "fixture_turn",
      systemPrompt: "Return the fixture.",
      inputSchema: z.strictObject({ request: z.string() }),
      outputSchema,
      renderInput: ({ request }) => request,
    };
    const primary = new StubProvider(
      primaryIdentity,
      async () => primaryIntent,
      async () => {
        throw new AiOutputError("trace-architect");
      },
    );
    const fallback = new StubProvider(
      fallbackIdentity,
      async () => fallbackIntent,
      async () => ({ response: "fallback architect response" }),
    );
    const recordTerminal = vi.fn<AiRunRecorder>(async () => undefined);
    const provider = createFailoverProvider(primary, fallback, { recordTerminal });

    await expect(
      provider.architect(
        {
          traceId: "trace-architect",
          safetyIdentifier: "opaque",
          input: { request: "explain" },
        },
        protocol,
      ),
    ).resolves.toEqual({ response: "fallback architect response" });
    expect(primary.architectCalls).toBe(1);
    expect(fallback.architectCalls).toBe(1);
    expect(recordTerminal).toHaveBeenCalledWith({
      traceId: "trace-architect",
      task: "architect",
      provider: "anthropic",
      model: "configured-anthropic-model",
      status: "succeeded",
    });
  });
});

import type { z } from "zod";
import {
  AiError,
  AiRecorderError,
  safeErrorCode,
  sanitizeTraceId,
  type AiProvider,
  type AiRunRecorder,
  type AiRunTerminalMetadata,
  type AiTask,
  type ArchitectProtocol,
  type ArchitectTurnInput,
  type ReconstructionInput,
} from "./provider.js";

export type FailoverProviderOptions = Readonly<{
  recordTerminal: AiRunRecorder;
}>;

type Settled<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: unknown }>;

export function createFailoverProvider(
  primary: AiProvider,
  fallback: AiProvider | null,
  { recordTerminal }: FailoverProviderOptions,
): AiProvider {
  const run = async <T>(
    task: AiTask,
    traceId: string,
    operation: (provider: AiProvider) => Promise<T>,
  ): Promise<T> => {
    let selected = primary;
    let settled: Settled<T>;

    try {
      settled = { ok: true, value: await operation(primary) };
    } catch (primaryError) {
      if (
        fallback !== null
        && primaryError instanceof AiError
        && primaryError.fallbackEligible
      ) {
        selected = fallback;
        try {
          settled = { ok: true, value: await operation(fallback) };
        } catch (fallbackError) {
          settled = { ok: false, error: fallbackError };
        }
      } else {
        settled = { ok: false, error: primaryError };
      }
    }

    const identity = selected.identity(task);
    const metadata: AiRunTerminalMetadata = Object.freeze(
      settled.ok
        ? {
            traceId,
            task,
            provider: identity.provider,
            model: identity.model,
            status: "succeeded",
          }
        : {
            traceId,
            task,
            provider: identity.provider,
            model: identity.model,
            status: "failed",
            errorCode: safeErrorCode(settled.error),
          },
    );

    try {
      await recordTerminal(metadata);
    } catch {
      throw new AiRecorderError(traceId);
    }

    if (!settled.ok) throw settled.error;
    return settled.value;
  };

  const reconstruct = (input: ReconstructionInput) =>
    run("reconstruct", sanitizeTraceId(input.traceId), (provider) =>
      provider.reconstruct(input),
    );

  const architect = <TInput, TOutputSchema extends z.ZodObject>(
    input: ArchitectTurnInput<TInput>,
    protocol: ArchitectProtocol<TInput, TOutputSchema>,
  ) =>
    run("architect", sanitizeTraceId(input.traceId), (provider) =>
      provider.architect(input, protocol),
    );

  return Object.freeze({
    identity: (task: AiTask) => primary.identity(task),
    reconstruct,
    architect,
  });
}

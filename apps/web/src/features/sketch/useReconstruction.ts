"use client";

import {
  ReconstructionJobEnvelopeSchema,
  TransitionClaimSchema,
  type ReconstructionJobEnvelope,
  type TransitionClaim,
} from "@architect/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Editor } from "tldraw";
import type * as Y from "yjs";
import { captureWhiteboard } from "./captureWhiteboard";
import { readRequirements } from "./RequirementsPanel";

const DEFAULT_POLL_DELAYS_MS = [250, 1_000, 3_000, 5_000] as const;
const DEFAULT_MAX_POLL_ATTEMPTS = 60;
const DEFAULT_MAX_NETWORK_RETRIES = 2;

type FetchBoundary = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type ReconstructionDependencies = Readonly<{
  capture?: typeof captureWhiteboard;
  fetch?: FetchBoundary;
  maxNetworkRetries?: number;
  maxPollAttempts?: number;
  onCaptureReleased?: (jobId: string) => void;
  pollDelaysMs?: readonly number[];
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

const EMPTY_DEPENDENCIES: ReconstructionDependencies = Object.freeze({});
const defaultFetch: FetchBoundary = (input, init) => globalThis.fetch(input, init);

export type ReconstructionUiState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "capturing"; jobId: string }>
  | Readonly<{ status: "submitting"; jobId: string }>
  | Readonly<{ status: "polling"; jobId: string }>
  | Readonly<{
      status: "succeeded";
      jobId: string;
      result: NonNullable<ReconstructionJobEnvelope["result"]>;
    }>
  | Readonly<{
      status: "failed";
      jobId: string;
      error: NonNullable<ReconstructionJobEnvelope["error"]>;
    }>
  | Readonly<{ status: "error"; jobId: string | null; message: string }>;

type UseReconstructionInput = Readonly<{
  doc: Y.Doc;
  getEditor(): Editor | null;
  onPhaseChange?: (phase: "sketch" | "architect") => void;
  roomId: string;
  dependencies?: ReconstructionDependencies;
}>;

class PublicHookError extends Error {}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function publicMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message ? message : null;
}

export function useReconstruction({
  doc,
  getEditor,
  onPhaseChange,
  roomId,
  dependencies = EMPTY_DEPENDENCIES,
}: UseReconstructionInput) {
  const capture = dependencies.capture ?? captureWhiteboard;
  const fetchBoundary = dependencies.fetch ?? defaultFetch;
  const onCaptureReleased = dependencies.onCaptureReleased;
  const maxNetworkRetries = Math.max(
    0,
    Math.floor(dependencies.maxNetworkRetries ?? DEFAULT_MAX_NETWORK_RETRIES),
  );
  const maxPollAttempts = Math.max(
    1,
    Math.floor(dependencies.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS),
  );
  const pollDelays = dependencies.pollDelaysMs?.length
    ? dependencies.pollDelaysMs
    : DEFAULT_POLL_DELAYS_MS;
  const sleep = dependencies.sleep ?? defaultSleep;
  const [state, setState] = useState<ReconstructionUiState>({ status: "idle" });
  const mountedRef = useRef(true);
  const activeRef = useRef<{
    jobId: string;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const lastClaimRef = useRef<TransitionClaim | null>(null);

  const updateState = useCallback((next: ReconstructionUiState) => {
    if (mountedRef.current) setState(next);
  }, []);

  const request = useCallback(async (
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ) => {
    for (let attempt = 0; attempt <= maxNetworkRetries; attempt += 1) {
      try {
        return await fetchBoundary(url, { ...init, signal });
      } catch (error) {
        if (isAbort(error) || signal.aborted) throw error;
        if (attempt === maxNetworkRetries) {
          throw new PublicHookError("Reconstruction could not be reached.");
        }
        const delay = pollDelays[Math.min(attempt, pollDelays.length - 1)] ?? 0;
        await sleep(delay, signal);
      }
    }
    throw new PublicHookError("Reconstruction could not be reached.");
  }, [fetchBoundary, maxNetworkRetries, pollDelays, sleep]);

  const parseResponse = useCallback(async (response: Response) => {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PublicHookError("Reconstruction returned an invalid response.");
    }
    if (!response.ok) {
      throw new PublicHookError(
        publicMessage(body) ?? "Reconstruction could not be completed.",
      );
    }
    const parsed = ReconstructionJobEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw new PublicHookError("Reconstruction returned an invalid response.");
    }
    return parsed.data;
  }, []);

  const acceptEnvelope = useCallback((
    result: ReconstructionJobEnvelope,
    expected: Pick<TransitionClaim, "jobId" | "sourceSnapshotVersion">,
  ): "terminal" | "in_flight" => {
    if (
      result.jobId !== expected.jobId ||
      result.sourceSnapshotVersion !== expected.sourceSnapshotVersion
    ) {
      throw new PublicHookError(
        "Reconstruction response did not match the active job.",
      );
    }
    if (result.state === "succeeded") {
      updateState({ status: "succeeded", jobId: result.jobId, result: result.result });
      onPhaseChange?.("architect");
      return "terminal";
    }
    if (result.state === "failed") {
      updateState({ status: "failed", jobId: result.jobId, error: result.error });
      onPhaseChange?.("sketch");
      return "terminal";
    }
    updateState({ status: "polling", jobId: result.jobId });
    return "in_flight";
  }, [onPhaseChange, updateState]);

  const poll = useCallback(async (
    expected: Pick<TransitionClaim, "jobId" | "sourceSnapshotVersion">,
    signal: AbortSignal,
  ) => {
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const delay = pollDelays[Math.min(attempt, pollDelays.length - 1)] ?? 0;
      await sleep(delay, signal);
      const response = await request(
        `/api/rooms/${roomId}/reconstruction/${encodeURIComponent(expected.jobId)}`,
        { credentials: "same-origin" },
        signal,
      );
      const result = await parseResponse(response);
      if (acceptEnvelope(result, expected) === "terminal") return;
    }
    throw new PublicHookError("Reconstruction is taking longer than expected.");
  }, [acceptEnvelope, maxPollAttempts, parseResponse, pollDelays, request, roomId, sleep]);

  const runBegin = useCallback(async (
    claim: TransitionClaim,
    signal: AbortSignal,
  ) => {
    updateState({ status: "capturing", jobId: claim.jobId });
    const editor = getEditor();
    const requirements = readRequirements(doc);
    if (!editor || !requirements) {
      throw new PublicHookError("Sketch capture is unavailable.");
    }
    let captured: Awaited<ReturnType<typeof captureWhiteboard>> | null =
      await capture(editor);
    try {
      updateState({ status: "submitting", jobId: claim.jobId });
      const response = await request(
        `/api/rooms/${roomId}/reconstruction`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            imageDataUrl: captured.imageDataUrl,
            mimeType: captured.mimeType,
            requirements,
            sourceSnapshotVersion: claim.sourceSnapshotVersion,
          }),
        },
        signal,
      );
      captured = null;
      onCaptureReleased?.(claim.jobId);
      const result = await parseResponse(response);
      if (acceptEnvelope(result, claim) === "in_flight") {
        await poll(claim, signal);
      }
    } finally {
      if (captured) onCaptureReleased?.(claim.jobId);
      captured = null;
    }
  }, [acceptEnvelope, capture, doc, getEditor, onCaptureReleased, parseResponse, poll, request, roomId, updateState]);

  const begin = useCallback((claimInput: TransitionClaim): Promise<void> => {
    const parsed = TransitionClaimSchema.parse(claimInput);
    lastClaimRef.current = parsed;
    if (activeRef.current?.jobId === parsed.jobId) {
      return activeRef.current.promise;
    }
    activeRef.current?.controller.abort();
    const controller = new AbortController();
    const promise = runBegin(parsed, controller.signal)
      .catch((error: unknown) => {
        if (isAbort(error) || controller.signal.aborted) return;
        updateState({
          status: "error",
          jobId: parsed.jobId,
          message: error instanceof PublicHookError
            ? error.message
            : "Reconstruction could not be completed.",
        });
      })
      .finally(() => {
        if (activeRef.current?.promise === promise) activeRef.current = null;
      });
    activeRef.current = { jobId: parsed.jobId, controller, promise };
    return promise;
  }, [runBegin, updateState]);

  const discover = useCallback((): Promise<void> => {
    if (activeRef.current) return activeRef.current.promise;
    const controller = new AbortController();
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const response = await request(
          `/api/rooms/${roomId}/reconstruction`,
          { credentials: "same-origin" },
          controller.signal,
        );
        const result = await parseResponse(response);
        const discoveredClaim: TransitionClaim = {
          claimed: false,
          jobId: result.jobId,
          sourceSnapshotVersion: result.sourceSnapshotVersion,
        };
        lastClaimRef.current = discoveredClaim;
        if (result.state === "claimed") {
          if (activeRef.current?.promise === promise) activeRef.current = null;
          await begin(discoveredClaim);
          return;
        }
        if (acceptEnvelope(result, discoveredClaim) === "in_flight") {
          if (activeRef.current?.promise === promise) {
            activeRef.current.jobId = discoveredClaim.jobId;
          }
          await poll(discoveredClaim, controller.signal);
        }
      } catch (error) {
        if (isAbort(error) || controller.signal.aborted) return;
        updateState({
          status: "error",
          jobId: null,
          message: error instanceof PublicHookError
            ? error.message
            : "Reconstruction could not be completed.",
        });
      }
    })().finally(() => {
      if (activeRef.current?.promise === promise) activeRef.current = null;
    });
    activeRef.current = { jobId: "discover", controller, promise };
    return promise;
  }, [acceptEnvelope, begin, parseResponse, poll, request, roomId, updateState]);

  const retry = useCallback(() => {
    const claim = lastClaimRef.current;
    return claim ? begin(claim) : discover();
  }, [begin, discover]);

  useEffect(() => () => {
    mountedRef.current = false;
    activeRef.current?.controller.abort();
    activeRef.current = null;
  }, []);

  return Object.freeze({ begin, discover, retry, state });
}

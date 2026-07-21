// @vitest-environment jsdom

import { defaultRequirementsProfile } from "@architect/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReconstruction } from "./useReconstruction.js";

const IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const requirements = defaultRequirementsProfile();
const claim = {
  claimed: true,
  jobId: "job-a",
  sourceSnapshotVersion: 7,
};
const running = {
  jobId: "job-a",
  sourceSnapshotVersion: 7,
  state: "running" as const,
  result: null,
  error: null,
};
const publishing = { ...running, state: "publishing" as const };
const failed = {
  jobId: "job-a",
  sourceSnapshotVersion: 7,
  state: "failed" as const,
  result: null,
  error: {
    code: "RECONSTRUCTION_INVALID" as const,
    message: "The sketch could not be converted into a valid architecture.",
  },
};
const architecture = {
  version: "architecture/v1" as const,
  requirements,
  resources: [],
  relationships: [],
  decisions: [],
  unresolvedQuestions: [],
};
const succeeded = {
  jobId: "job-a",
  sourceSnapshotVersion: 7,
  state: "succeeded" as const,
  result: {
    traceId: "transition-a",
    provider: { provider: "openai" as const, model: "gpt-5.6" },
    intent: { version: "infrastructure-intent/v1" as const, resources: [], relationships: [] },
    diagnostics: [],
    stageDecision: {
      version: "stage-decision/v1" as const,
      stage: "prototype" as const,
      confidence: "high" as const,
      reasons: ["Prototype fit."],
      requiresApproval: false,
      proposedUpgrades: [],
    },
    deploymentPlan: {
      version: "deployment-plan/v1" as const,
      stage: "prototype" as const,
      requiresApproval: false,
      approvalsSatisfied: true,
      pendingApprovalResourceIds: [],
      pendingApprovalRelationshipIds: [],
      architecture,
    },
    architectureRevisionId: "revision-a",
  },
  error: null,
};

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  }));
}

function setup(overrides: Record<string, unknown> = {}, strict = false) {
  const doc = new Y.Doc();
  doc.getMap("requirements").set("current", requirements);
  const capture = vi.fn(async () => ({
    imageDataUrl: IMAGE,
    mimeType: "image/png" as const,
    hasShapes: true,
  }));
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) =>
    response(failed));
  const onPhaseChange = vi.fn();
  const onCaptureReleased = vi.fn();
  const hook = renderHook(
    () => useReconstruction({
      doc,
      getEditor: () => ({}) as never,
      roomId: "room-a",
      onPhaseChange,
      dependencies: {
        capture,
        fetch,
        pollDelaysMs: [0],
        sleep: async () => undefined,
        onCaptureReleased,
        ...overrides,
      },
    }),
    strict ? { wrapper: StrictMode } : undefined,
  );
  return { capture, doc, fetch, hook, onCaptureReleased, onPhaseChange };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useReconstruction", () => {
  it("remains active after StrictMode replays its mount effect", async () => {
    const test = setup({}, true);

    await act(async () => { await test.hook.result.current.begin(claim); });

    expect(test.hook.result.current.state).toMatchObject({ status: "failed" });
    test.doc.destroy();
  });

  it("deduplicates double begin, captures once, and submits the exact claim version", async () => {
    const test = setup();
    await act(async () => {
      const first = test.hook.result.current.begin(claim);
      const second = test.hook.result.current.begin({ ...claim, claimed: false });
      await Promise.all([first, second]);
    });

    expect(test.capture).toHaveBeenCalledOnce();
    expect(test.fetch).toHaveBeenCalledOnce();
    const [url, init] = test.fetch.mock.calls[0]!;
    expect(url).toBe("/api/rooms/room-a/reconstruction");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(init?.body))).toEqual({
      imageDataUrl: IMAGE,
      mimeType: "image/png",
      requirements,
      sourceSnapshotVersion: 7,
    });
    expect(test.onCaptureReleased).toHaveBeenCalledWith("job-a");
    expect(test.hook.result.current.state).toMatchObject({ status: "failed" });
    test.doc.destroy();
  });

  it("polls a 202 response to terminal success and advances from durable output", async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => response(running, 202))
      .mockImplementationOnce(() => response(succeeded));
    const test = setup({ fetch });

    await act(async () => { await test.hook.result.current.begin(claim); });

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/rooms/room-a/reconstruction/job-a",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(test.hook.result.current.state).toMatchObject({ status: "succeeded" });
    expect(test.onPhaseChange).toHaveBeenCalledWith("architect");
    test.doc.destroy();
  });

  it("keeps cleanup-pending publication in-flight without reopening sketch", async () => {
    const fetch = vi.fn(async () => response(publishing, 202));
    const test = setup({ fetch, maxPollAttempts: 1 });

    await act(async () => { await test.hook.result.current.begin(claim); });

    expect(test.hook.result.current.state).toMatchObject({
      status: "error",
      message: "Reconstruction is taking longer than expected.",
    });
    expect(test.onPhaseChange).not.toHaveBeenCalled();
    test.doc.destroy();
  });

  it("discovers claimed work by capturing and running work by polling", async () => {
    const claimedEnvelope = { ...running, state: "claimed" as const };
    const claimedFetch = vi
      .fn()
      .mockImplementationOnce(() => response(claimedEnvelope))
      .mockImplementationOnce(() => response(failed));
    const claimedTest = setup({ fetch: claimedFetch });
    await act(async () => { await claimedTest.hook.result.current.discover(); });
    expect(claimedTest.capture).toHaveBeenCalledOnce();
    claimedTest.doc.destroy();

    const runningFetch = vi
      .fn()
      .mockImplementationOnce(() => response(running))
      .mockImplementationOnce(() => response(failed));
    const runningTest = setup({ fetch: runningFetch });
    await act(async () => { await runningTest.hook.result.current.discover(); });
    expect(runningTest.capture).not.toHaveBeenCalled();
    expect(runningFetch).toHaveBeenCalledTimes(2);
    runningTest.doc.destroy();
  });

  it("rejects a mismatched response job without granting phase authority", async () => {
    const test = setup({ fetch: vi.fn(async () => response({ ...failed, jobId: "job-b" })) });
    await act(async () => { await test.hook.result.current.begin(claim); });
    expect(test.hook.result.current.state).toMatchObject({
      status: "error",
      message: "Reconstruction response did not match the active job.",
    });
    expect(test.onPhaseChange).not.toHaveBeenCalled();
    test.doc.destroy();
  });

  it("bounds network retries and exposes a safe retry action", async () => {
    const fetch = vi.fn(async () => { throw new Error("raw network detail"); });
    const test = setup({ fetch, maxNetworkRetries: 2 });
    await act(async () => { await test.hook.result.current.begin(claim); });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(test.hook.result.current.state).toEqual({
      status: "error",
      jobId: "job-a",
      message: "Reconstruction could not be reached.",
    });
    test.doc.destroy();
  });

  it("captures again for an explicit retry after a terminal request error", async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => { throw new Error("offline"); })
      .mockImplementationOnce(() => response(failed));
    const test = setup({ fetch, maxNetworkRetries: 0 });
    await act(async () => { await test.hook.result.current.begin(claim); });
    await act(async () => { await test.hook.result.current.retry(); });
    expect(test.capture).toHaveBeenCalledTimes(2);
    expect(test.hook.result.current.state).toMatchObject({ status: "failed" });
    test.doc.destroy();
  });

  it("aborts in-flight work on unmount", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const test = setup({ fetch });
    act(() => { void test.hook.result.current.begin(claim); });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    test.hook.unmount();
    expect(signal?.aborted).toBe(true);
    test.doc.destroy();
  });
});

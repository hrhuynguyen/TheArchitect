// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  ArchitectTurnSchema,
  type ArchitectTurn,
} from "@architect/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARCHITECT_MAX_POLL_ATTEMPTS,
  ARCHITECT_POLL_INTERVAL_MS,
  ArchitectPanel,
} from "./ArchitectPanel.js";

afterEach(cleanup);

const baseTurn = {
  id: "turn-a",
  roomId: "room-a",
  baseRevisionId: "revision-a",
  message: "Add a queue.",
  actorType: "participant" as const,
  actorId: "participant-a",
  idempotencyKey: "turn-request-a",
  sourceSnapshotVersion: 7,
  sourceProtectedDigest:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  traceId: "architect:turn-a",
  createdAt: "2026-07-21T12:00:00.000Z",
  reviewedAt: null,
  reviewedByParticipantId: null,
  reviewRationale: null,
};

const explanation = ArchitectTurnSchema.parse({
  ...baseTurn,
  state: "answered",
  kind: "explanation",
  responseText: "The S3 bucket stores durable upload objects.",
  operations: [],
  appliedRevisionId: null,
  error: null,
});

const proposal = ArchitectTurnSchema.parse({
  ...baseTurn,
  state: "proposal_ready",
  kind: "proposal",
  responseText: "I can add an SQS queue for upload work.",
  operations: [{
    type: "add_resource",
    resource: {
      id: "upload-queue",
      type: "SQS",
      name: "Upload queue",
      properties: {},
    },
    reason: "Buffer uploads across transient worker failures.",
  }],
  appliedRevisionId: null,
  error: null,
});

const destructiveProposal = ArchitectTurnSchema.parse({
  ...proposal,
  id: "turn-remove",
  message: "Remove the bucket.",
  operations: [{
    type: "remove_resource",
    resourceId: "bucket",
    reason: "The bucket is no longer referenced.",
  }],
});

function reviewed(
  turn: ArchitectTurn,
  state: "applied" | "rejected",
  rationale: string,
) {
  if (turn.kind !== "proposal") throw new Error("proposal required");
  return ArchitectTurnSchema.parse({
    ...turn,
    state,
    appliedRevisionId: state === "applied" ? "revision-b" : null,
    reviewedAt: "2026-07-21T12:01:00.000Z",
    reviewedByParticipantId: "participant-a",
    reviewRationale: rationale,
  });
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function list(turns: readonly ArchitectTurn[]) {
  return response({ turns });
}

function renderPanel(
  fetchBoundary: (input: string, init?: RequestInit) => Promise<Response>,
  options: Readonly<{
    canReview?: boolean;
    createId?: () => string;
    setTimeout?: (callback: () => void, delay: number) => unknown;
    clearTimeout?: (timer: unknown) => void;
    maxPollAttempts?: number;
  }> = {},
) {
  return render(
    <ArchitectPanel
      baseRevisionId="revision-a"
      canReview={options.canReview ?? true}
      dependencies={{
        fetch: fetchBoundary,
        createId: options.createId ?? (() => "stable-client-key"),
        ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
        ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
        ...(options.maxPollAttempts
          ? { maxPollAttempts: options.maxPollAttempts }
          : {}),
      }}
      roomId="room-a"
    />,
  );
}

describe("ArchitectPanel", () => {
  it("renders a durable explanation without patch controls", async () => {
    const fetchBoundary = vi.fn(async () => list([explanation]));
    renderPanel(fetchBoundary);

    expect(await screen.findByText(String(explanation.responseText))).toBeVisible();
    expect(screen.queryByRole("button", { name: /review patch/i })).toBeNull();
    expect(fetchBoundary).toHaveBeenCalledWith(
      "/api/rooms/room-a/architect/turns",
      { credentials: "same-origin" },
    );
  });

  it("reviews and applies an SQS proposal against the observed Yjs revision", async () => {
    const applied = reviewed(proposal, "applied", "Queue upload processing.");
    let current: readonly ArchitectTurn[] = [proposal];
    const fetchBoundary = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) return list(current);
      if (url.endsWith("/apply")) {
        current = [applied];
        return response(applied);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    renderPanel(fetchBoundary);

    await user.click(await screen.findByRole("button", { name: "Review patch" }));
    expect(screen.getByRole("dialog", { name: "Review Architect patch" })).toBeVisible();
    expect(screen.getByText(/add SQS “Upload queue”/i)).toBeVisible();
    await user.type(
      screen.getByRole("textbox", { name: "Review rationale" }),
      "Queue upload processing.",
    );
    await user.click(screen.getByRole("button", { name: "Apply patch" }));

    await waitFor(() => expect(fetchBoundary).toHaveBeenCalledWith(
      "/api/rooms/room-a/architect/patches/turn-a/apply",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    ));
    const applyCall = fetchBoundary.mock.calls.find(([url]) =>
      String(url).endsWith("/apply"),
    );
    expect(JSON.parse(String(applyCall?.[1]?.body))).toEqual({
      baseRevisionId: "revision-a",
      idempotencyKey: "stable-client-key",
      rationale: "Queue upload processing.",
    });
    expect(await screen.findByText("Applied")).toBeVisible();
  });

  it("requires explicit destructive confirmation and rationale", async () => {
    const applied = reviewed(
      destructiveProposal,
      "applied",
      "Remove unused storage.",
    );
    const fetchBoundary = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method ? response(applied) : list([destructiveProposal]));
    const user = userEvent.setup();
    renderPanel(fetchBoundary);

    await user.click(await screen.findByRole("button", { name: "Review patch" }));
    await user.type(
      screen.getByRole("textbox", { name: "Review rationale" }),
      "Remove unused storage.",
    );
    expect(screen.getByRole("button", { name: "Apply patch" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", {
      name: "I confirm these destructive changes",
    }));
    expect(screen.getByRole("button", { name: "Apply patch" })).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Destructive confirmation rationale" }),
      "The migration is complete and the data is retained elsewhere.",
    );
    expect(screen.getByRole("button", { name: "Apply patch" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Apply patch" }));

    const applyCall = await waitFor(() => {
      const call = fetchBoundary.mock.calls.find(([url]) =>
        String(url).endsWith("/apply"),
      );
      expect(call).toBeDefined();
      return call;
    });
    expect(JSON.parse(String(applyCall?.[1]?.body))).toMatchObject({
      rationale: "Remove unused storage.",
      destructiveConfirmation: {
        confirmed: true,
        rationale: "The migration is complete and the data is retained elsewhere.",
      },
    });
  });

  it("rejects a proposal with a durable rationale", async () => {
    const rejected = reviewed(proposal, "rejected", "Keep this synchronous.");
    let current: readonly ArchitectTurn[] = [proposal];
    const fetchBoundary = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) return list(current);
      if (url.endsWith("/reject")) {
        current = [rejected];
        return response(rejected);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    renderPanel(fetchBoundary);

    await user.click(await screen.findByRole("button", { name: "Review patch" }));
    await user.type(
      screen.getByRole("textbox", { name: "Review rationale" }),
      "Keep this synchronous.",
    );
    await user.click(screen.getByRole("button", { name: "Reject patch" }));

    await waitFor(() => expect(fetchBoundary).toHaveBeenCalledWith(
      "/api/rooms/room-a/architect/patches/turn-a/reject",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    ));
    const rejectCall = fetchBoundary.mock.calls.find(([url]) =>
      String(url).endsWith("/reject"),
    );
    expect(JSON.parse(String(rejectCall?.[1]?.body))).toEqual({
      idempotencyKey: "stable-client-key",
      rationale: "Keep this synchronous.",
    });
    expect(await screen.findByText("Rejected")).toBeVisible();
  });

  it("suppresses duplicate turns and reuses the client key after an uncertain failure", async () => {
    let turnAttempt = 0;
    let rejectFirst!: (error: Error) => void;
    const firstAttempt = new Promise<Response>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const fetchBoundary = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return list([]);
      turnAttempt += 1;
      if (turnAttempt === 1) return firstAttempt;
      return response(explanation, 201);
    });
    const user = userEvent.setup();
    renderPanel(fetchBoundary);

    const input = await screen.findByRole("textbox", { name: "Ask the Architect" });
    await user.type(input, "Explain the storage layer.");
    const submit = screen.getByRole("button", { name: "Ask Architect" });
    await user.click(submit);
    await user.click(submit);
    expect(fetchBoundary.mock.calls.filter(([, init]) => init?.method === "POST"))
      .toHaveLength(1);
    rejectFirst(new Error("uncertain network failure"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Architect request could not be reached.",
    );
    await user.click(screen.getByRole("button", { name: "Retry request" }));

    await waitFor(() => expect(fetchBoundary.mock.calls.filter(([, init]) =>
      init?.method === "POST",
    )).toHaveLength(2));
    const bodies = fetchBoundary.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].idempotencyKey).toBe("stable-client-key");
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it.each(["apply", "reject"] as const)(
    "reuses a stable %s key after an uncertain review failure",
    async (action) => {
      let attempts = 0;
      const rationale = action === "apply" ? "Apply queue." : "Reject queue.";
      const terminal = reviewed(
        proposal,
        action === "apply" ? "applied" : "rejected",
        rationale,
      );
      const fetchBoundary = vi.fn(async (url: string, init?: RequestInit) => {
        if (!init?.method) return list([proposal]);
        if (!url.endsWith(`/${action}`)) throw new Error("unexpected endpoint");
        attempts += 1;
        if (attempts === 1) throw new Error("uncertain network failure");
        return response(terminal);
      });
      const user = userEvent.setup();
      renderPanel(fetchBoundary);

      await user.click(await screen.findByRole("button", { name: "Review patch" }));
      await user.type(
        screen.getByRole("textbox", { name: "Review rationale" }),
        rationale,
      );
      await user.click(screen.getByRole("button", {
        name: action === "apply" ? "Apply patch" : "Reject patch",
      }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Architect review could not be reached.",
      );
      expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
      await user.click(screen.getByRole("button", {
        name: action === "apply" ? "Retry apply" : "Retry reject",
      }));

      await waitFor(() => expect(attempts).toBe(2));
      const keys = fetchBoundary.mock.calls
        .filter(([url]) => String(url).endsWith(`/${action}`))
        .map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey);
      expect(keys).toEqual(["stable-client-key", "stable-client-key"]);
    },
  );

  it("discovers remote turns by bounded polling that outlives stale recovery", async () => {
    expect(ARCHITECT_POLL_INTERVAL_MS * ARCHITECT_MAX_POLL_ATTEMPTS)
      .toBeGreaterThan(120_000);
    const scheduled: Array<() => void> = [];
    const setTimeoutBoundary = vi.fn((callback: () => void) => {
      scheduled.push(callback);
      return callback;
    });
    const clearTimeoutBoundary = vi.fn();
    let lists = 0;
    const fetchBoundary = vi.fn(async () => {
      lists += 1;
      return list(lists === 1 ? [] : [proposal]);
    });
    renderPanel(fetchBoundary, {
      setTimeout: setTimeoutBoundary,
      clearTimeout: clearTimeoutBoundary,
      maxPollAttempts: 2,
    });

    await waitFor(() => expect(scheduled).toHaveLength(1));
    await act(async () => scheduled.shift()?.());
    expect(await screen.findByText(String(proposal.responseText))).toBeVisible();
    expect(scheduled).toHaveLength(0);
    expect(fetchBoundary).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Live turn updates paused.",
    );
    await userEvent.setup().click(
      screen.getByRole("button", { name: "Refresh Architect turns" }),
    );
    await waitFor(() => expect(fetchBoundary).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(scheduled).toHaveLength(1));

    cleanup();
    expect(clearTimeoutBoundary).toHaveBeenCalledOnce();
  });

  it("never overlaps polling requests", async () => {
    const scheduled: Array<() => void> = [];
    let resolveSecond!: (response: Response) => void;
    const second = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    let calls = 0;
    const fetchBoundary = vi.fn(async () => {
      calls += 1;
      return calls === 2 ? second : list([]);
    });
    renderPanel(fetchBoundary, {
      setTimeout: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      clearTimeout: vi.fn(),
      maxPollAttempts: 3,
    });

    await waitFor(() => expect(scheduled).toHaveLength(1));
    act(() => scheduled.shift()?.());
    expect(fetchBoundary).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveLength(0);
    resolveSecond(list([]));
    await waitFor(() => expect(scheduled).toHaveLength(1));
  });

  it("does not let a stale list response demote a locally applied proposal", async () => {
    const scheduled: Array<() => void> = [];
    let resolveStale!: (response: Response) => void;
    const staleList = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    const applied = reviewed(proposal, "applied", "Apply queue.");
    let listCalls = 0;
    const fetchBoundary = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) {
        listCalls += 1;
        return listCalls === 1 ? list([proposal]) : staleList;
      }
      if (url.endsWith("/apply")) return response(applied);
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    renderPanel(fetchBoundary, {
      setTimeout: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      clearTimeout: vi.fn(),
      maxPollAttempts: 3,
    });

    await waitFor(() => expect(scheduled).toHaveLength(1));
    act(() => scheduled.shift()?.());
    await waitFor(() => expect(listCalls).toBe(2));
    await user.click(screen.getByRole("button", { name: "Review patch" }));
    await user.type(
      screen.getByRole("textbox", { name: "Review rationale" }),
      "Apply queue.",
    );
    await user.click(screen.getByRole("button", { name: "Apply patch" }));
    expect(await screen.findByText("Applied")).toBeVisible();

    resolveStale(list([proposal]));
    await act(async () => undefined);
    expect(screen.getByText("Applied")).toBeVisible();
    expect(screen.queryByText("Awaiting review")).toBeNull();
  });

  it("trusts only the shared error schema and hides arbitrary server detail", async () => {
    const fetchBoundary = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method
        ? response({ code: "made_up", message: "RAW_SERVER_SECRET" }, 409)
        : list([]));
    const user = userEvent.setup();
    renderPanel(fetchBoundary);
    await user.type(
      await screen.findByRole("textbox", { name: "Ask the Architect" }),
      "Explain this system.",
    );
    await user.click(screen.getByRole("button", { name: "Ask Architect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Architect request failed.",
    );
    expect(screen.queryByText(/RAW_SERVER_SECRET/)).toBeNull();
  });

  it("does not expose proposal review controls without a participant session", async () => {
    const fetchBoundary = vi.fn(async () => list([proposal]));
    renderPanel(fetchBoundary, { canReview: false });

    expect(await screen.findByText(String(proposal.responseText))).toBeVisible();
    expect(screen.queryByRole("button", { name: "Review patch" })).toBeNull();
    expect(screen.getByText(/participant session is required/i)).toBeVisible();
  });
});

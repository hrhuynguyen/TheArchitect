"use client";

import {
  ApplyArchitectPatchRequestSchema,
  ArchitectApiErrorResponseSchema,
  ArchitectTurnListSchema,
  ArchitectTurnRequestSchema,
  ArchitectTurnSchema,
  RejectArchitectPatchRequestSchema,
  type ApplyArchitectPatchRequest,
  type ArchitectApiErrorResponse,
  type ArchitectTurn,
  type ArchitectTurnRequest,
  type RejectArchitectPatchRequest,
} from "@architect/contracts";
import { Button, StatusBadge } from "@architect/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PatchReviewDialog } from "./PatchReviewDialog";

export const ARCHITECT_POLL_INTERVAL_MS = 2_000;
export const ARCHITECT_MAX_POLL_ATTEMPTS = 76;

type FetchBoundary = (input: string, init?: RequestInit) => Promise<Response>;
type TimerBoundary = unknown;

type ArchitectPanelDependencies = Readonly<{
  fetch?: FetchBoundary;
  createId?: () => string;
  setTimeout?: (callback: () => void, delay: number) => TimerBoundary;
  clearTimeout?: (timer: TimerBoundary) => void;
  maxPollAttempts?: number;
}>;

type ArchitectPanelProps = Readonly<{
  baseRevisionId: string;
  canReview: boolean;
  dependencies?: ArchitectPanelDependencies;
  roomId: string;
}>;

type ReviewAction = "apply" | "reject";
type ReviewRetry =
  | Readonly<{
      action: "apply";
      proposalId: string;
      request: ApplyArchitectPatchRequest;
    }>
  | Readonly<{
      action: "reject";
      proposalId: string;
      request: RejectArchitectPatchRequest;
    }>;

const EMPTY_DEPENDENCIES: ArchitectPanelDependencies = Object.freeze({});
const defaultFetch: FetchBoundary = (input, init) => globalThis.fetch(input, init);
const defaultSetTimeout = (callback: () => void, delay: number): TimerBoundary =>
  globalThis.setTimeout(callback, delay);
const defaultClearTimeout = (timer: TimerBoundary): void =>
  globalThis.clearTimeout(
    timer as ReturnType<typeof globalThis.setTimeout>,
  );

class PublicArchitectError extends Error {
  constructor(
    message: string,
    readonly preserveRetry = true,
  ) {
    super(message);
  }
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PublicArchitectError(
      "Architect returned an invalid response.",
      response.ok || response.status >= 500,
    );
  }
}

function publicError(error: ArchitectApiErrorResponse): string {
  switch (error.code) {
    case "unauthorized":
      return "Your room session is no longer authorized.";
    case "invalid_architect_request":
      return "The Architect request is invalid.";
    case "architect_unavailable":
      return "Architect is temporarily unavailable.";
    case "revision_conflict":
      return error.currentRevisionId
        ? `Architecture changed. Current revision: ${error.currentRevisionId}.`
        : "Architecture changed. Refresh and review the patch again.";
    case "working_state_conflict":
      return error.currentRevisionId
        ? `The shared graph changed. Current revision: ${error.currentRevisionId}.`
        : "The shared graph changed. Refresh and review the patch again.";
    case "terminal_conflict":
      return "This proposal was already reviewed.";
    case "idempotency_conflict":
      return "This retry key belongs to another review.";
    case "destructive_confirmation_required":
      return "Confirm and explain the destructive changes before applying.";
    case "invalid_agent_patch":
      return "The proposed patch is invalid and was not applied.";
    case "architect_turn_not_found":
      return "This Architect proposal no longer exists.";
  }
}

async function checkedBody(response: Response, fallback: string) {
  const body = await jsonBody(response);
  if (!response.ok) {
    const parsed = ArchitectApiErrorResponseSchema.safeParse(body);
    throw new PublicArchitectError(
      parsed.success ? publicError(parsed.data) : fallback,
      response.status >= 500
        || (parsed.success && parsed.data.code === "architect_unavailable"),
    );
  }
  return body;
}

function isTerminalState(state: ArchitectTurn["state"]) {
  return state === "answered"
    || state === "applied"
    || state === "rejected"
    || state === "failed";
}

function mergeTurns(
  current: readonly ArchitectTurn[],
  incoming: readonly ArchitectTurn[],
) {
  const currentById = new Map(current.map((turn) => [turn.id, turn]));
  const merged = incoming.map((next) => {
    const prior = currentById.get(next.id);
    currentById.delete(next.id);
    if (!prior) return next;
    if (isTerminalState(prior.state) && prior.state !== next.state) {
      return prior;
    }
    if (prior.state === "proposal_ready" && next.state === "thinking") {
      return prior;
    }
    return next;
  });
  return [...merged, ...currentById.values()];
}

function stateLabel(state: ArchitectTurn["state"]) {
  switch (state) {
    case "thinking": return "Thinking";
    case "answered": return "Answered";
    case "proposal_ready": return "Awaiting review";
    case "applied": return "Applied";
    case "rejected": return "Rejected";
    case "failed": return "Failed";
  }
}

export function ArchitectPanel({
  baseRevisionId,
  canReview,
  dependencies = EMPTY_DEPENDENCIES,
  roomId,
}: ArchitectPanelProps) {
  const fetchBoundary = dependencies.fetch ?? defaultFetch;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());
  const setTimeoutBoundary = dependencies.setTimeout ?? defaultSetTimeout;
  const clearTimeoutBoundary = dependencies.clearTimeout ?? defaultClearTimeout;
  const maxPollAttempts = dependencies.maxPollAttempts
    ?? ARCHITECT_MAX_POLL_ATTEMPTS;
  const [turns, setTurns] = useState<readonly ArchitectTurn[]>([]);
  const [message, setMessage] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [turnBusy, setTurnBusy] = useState(false);
  const [turnRetry, setTurnRetry] = useState<ArchitectTurnRequest | null>(null);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState<ReviewAction | null>(null);
  const [reviewRetry, setReviewRetry] = useState<ReviewRetry | null>(null);
  const [pollEpoch, setPollEpoch] = useState(0);
  const [pollingExhausted, setPollingExhausted] = useState(false);
  const panelFocusTarget = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  const listInFlight = useRef<Readonly<{
    fetchBoundary: FetchBoundary;
    promise: Promise<void>;
    turnsUrl: string;
  }> | null>(null);

  const turnsUrl = `/api/rooms/${encodeURIComponent(roomId)}/architect/turns`;

  const refreshTurns = useCallback(async (showError: boolean) => {
    const pending = listInFlight.current;
    if (
      pending?.fetchBoundary === fetchBoundary
      && pending.turnsUrl === turnsUrl
    ) {
      return pending.promise;
    }

    let request!: NonNullable<typeof listInFlight.current>;
    const promise = (async () => {
      try {
        const response = await fetchBoundary(turnsUrl, {
          credentials: "same-origin",
        });
        const parsed = ArchitectTurnListSchema.safeParse(
          await checkedBody(response, "Architect turns could not be loaded."),
        );
        if (!parsed.success) {
          throw new PublicArchitectError(
            "Architect turns returned an invalid response.",
          );
        }
        if (!mounted.current || listInFlight.current !== request) return;
        setTurns((current) => mergeTurns(current, parsed.data.turns));
        if (showError) setRequestError(null);
      } catch (error) {
        if (
          showError
          && mounted.current
          && listInFlight.current === request
        ) {
          setRequestError(
            error instanceof PublicArchitectError
              ? error.message
              : "Architect turns could not be reached.",
          );
        }
      } finally {
        if (listInFlight.current === request) {
          listInFlight.current = null;
        }
      }
    })();
    request = { fetchBoundary, promise, turnsUrl };
    listInFlight.current = request;
    return promise;
  }, [fetchBoundary, turnsUrl]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let timer: TimerBoundary | null = null;
    let attempts = 0;
    setPollingExhausted(false);
    const poll = async () => {
      attempts += 1;
      await refreshTurns(attempts === 1);
      if (!active) return;
      if (attempts >= maxPollAttempts) {
        setPollingExhausted(true);
        return;
      }
      timer = setTimeoutBoundary(
        () => {
          timer = null;
          void poll();
        },
        ARCHITECT_POLL_INTERVAL_MS,
      );
    };
    void poll();
    return () => {
      active = false;
      mounted.current = false;
      if (timer !== null) clearTimeoutBoundary(timer);
    };
  }, [clearTimeoutBoundary, maxPollAttempts, pollEpoch, refreshTurns, setTimeoutBoundary]);

  const submitTurn = async () => {
    if (turnBusy) return;
    let request = turnRetry;
    if (!request) {
      const parsed = ArchitectTurnRequestSchema.safeParse({
        message: message.trim(),
        idempotencyKey: createId(),
      });
      if (!parsed.success) {
        setRequestError("Enter a valid Architect question.");
        return;
      }
      request = parsed.data;
      setTurnRetry(request);
    }
    setTurnBusy(true);
    setRequestError(null);
    try {
      const response = await fetchBoundary(turnsUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const parsed = ArchitectTurnSchema.safeParse(
        await checkedBody(response, "Architect request failed."),
      );
      if (!parsed.success) {
        throw new PublicArchitectError("Architect returned an invalid response.");
      }
      setTurns((current) => mergeTurns(current, [parsed.data]));
      setMessage("");
      setTurnRetry(null);
      if (pollingExhausted) setPollEpoch((value) => value + 1);
    } catch (error) {
      if (error instanceof PublicArchitectError && !error.preserveRetry) {
        setTurnRetry(null);
      }
      setRequestError(
        error instanceof PublicArchitectError
          ? error.message
          : "Architect request could not be reached.",
      );
    } finally {
      setTurnBusy(false);
    }
  };

  const selectedProposal = useMemo(() => {
    const turn = turns.find(({ id }) => id === selectedProposalId);
    return turn?.kind === "proposal" && turn.state === "proposal_ready"
      ? turn
      : null;
  }, [selectedProposalId, turns]);

  useEffect(() => {
    if (selectedProposalId !== null && selectedProposal === null) {
      setSelectedProposalId(null);
      setReviewRetry((current) =>
        current?.proposalId === selectedProposalId ? null : current);
    }
  }, [selectedProposal, selectedProposalId]);

  const review = async (
    action: ReviewAction,
    proposalId: string,
    input: Readonly<{
      rationale: string;
      destructiveConfirmation?: ApplyArchitectPatchRequest["destructiveConfirmation"];
    }>,
  ) => {
    if (reviewBusy || !canReview) return;
    let retry = reviewRetry?.proposalId === proposalId
        && reviewRetry.action === action
      ? reviewRetry
      : null;
    if (!retry) {
      const raw = action === "apply"
        ? {
            baseRevisionId,
            idempotencyKey: createId(),
            rationale: input.rationale,
            ...(input.destructiveConfirmation
              ? { destructiveConfirmation: input.destructiveConfirmation }
              : {}),
          }
        : {
            idempotencyKey: createId(),
            rationale: input.rationale,
          };
      const parsed = action === "apply"
        ? ApplyArchitectPatchRequestSchema.safeParse(raw)
        : RejectArchitectPatchRequestSchema.safeParse(raw);
      if (!parsed.success) {
        setRequestError("Enter a valid review rationale.");
        return;
      }
      retry = action === "apply"
        ? { action, proposalId, request: parsed.data as ApplyArchitectPatchRequest }
        : { action, proposalId, request: parsed.data as RejectArchitectPatchRequest };
      setReviewRetry(retry);
    }
    setReviewBusy(action);
    setRequestError(null);
    try {
      const response = await fetchBoundary(
        `/api/rooms/${encodeURIComponent(roomId)}/architect/patches/${encodeURIComponent(proposalId)}/${action}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(retry.request),
        },
      );
      const parsed = ArchitectTurnSchema.safeParse(
        await checkedBody(response, "Architect review failed."),
      );
      if (!parsed.success) {
        throw new PublicArchitectError("Architect returned an invalid response.");
      }
      setTurns((current) => mergeTurns(current, [parsed.data]));
      setReviewRetry(null);
      setSelectedProposalId(null);
      if (pollingExhausted) setPollEpoch((value) => value + 1);
    } catch (error) {
      if (error instanceof PublicArchitectError && !error.preserveRetry) {
        setReviewRetry(null);
      }
      setRequestError(
        error instanceof PublicArchitectError
          ? error.message
          : "Architect review could not be reached.",
      );
    } finally {
      setReviewBusy(null);
    }
  };

  return (
    <section
      aria-labelledby="architect-panel-title"
      className="architect-panel"
      ref={panelFocusTarget}
      tabIndex={-1}
    >
      <header>
        <p className="section-kicker">AI design partner</p>
        <h2 id="architect-panel-title">Ask the Architect</h2>
      </header>
      <form
        className="architect-panel__composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submitTurn();
        }}
      >
        <label>
          Ask the Architect
          <textarea
            disabled={turnBusy || turnRetry !== null}
            maxLength={4_000}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Explain a tradeoff or propose a graph change…"
            value={message}
          />
        </label>
        {turnRetry ? (
          <p className="architect-panel__retry-note">
            Retry will resend the exact prior request.
          </p>
        ) : null}
        <Button
          disabled={turnBusy || (!turnRetry && !message.trim())}
          isLoading={turnBusy}
          loadingLabel="Asking…"
          type="submit"
        >
          {turnRetry ? "Retry request" : "Ask Architect"}
        </Button>
      </form>
      {requestError ? (
        <p className="architect-panel__error" role="alert">{requestError}</p>
      ) : null}
      {pollingExhausted ? (
        <div className="architect-panel__polling">
          <p role="status">Live turn updates paused.</p>
          <Button
            onClick={() => setPollEpoch((value) => value + 1)}
            type="button"
            variant="quiet"
          >
            Refresh Architect turns
          </Button>
        </div>
      ) : null}
      <div className="architect-panel__turns" aria-live="polite">
        {turns.length === 0 ? (
          <p className="architecture-empty-copy">No Architect turns yet.</p>
        ) : turns.map((turn) => (
          <article className="architect-turn" key={turn.id}>
            <header>
              <span>{turn.actorType === "owner" ? "Owner" : "Participant"}</span>
              <StatusBadge
                tone={turn.state === "failed"
                  ? "warning"
                  : turn.state === "applied"
                    ? "success"
                    : "neutral"}
              >
                {stateLabel(turn.state)}
              </StatusBadge>
            </header>
            <p className="architect-turn__message">{turn.message}</p>
            {turn.responseText ? (
              <p className="architect-turn__response">{turn.responseText}</p>
            ) : null}
            {turn.state === "thinking" ? (
              <p role="status">Thinking about the shared graph…</p>
            ) : null}
            {turn.state === "failed" ? <p>{turn.error.message}</p> : null}
            {turn.state === "proposal_ready" && canReview ? (
              <Button
                onClick={() => {
                  setReviewRetry((current) =>
                    current?.proposalId === turn.id ? current : null);
                  setSelectedProposalId(turn.id);
                }}
                type="button"
                variant="secondary"
              >
                Review patch
              </Button>
            ) : null}
            {turn.state === "proposal_ready" && !canReview ? (
              <p>A participant session is required to review this patch.</p>
            ) : null}
          </article>
        ))}
      </div>
      {selectedProposal ? (
        <PatchReviewDialog
          busyAction={reviewBusy}
          error={requestError}
          fallbackFocusRef={panelFocusTarget}
          onApply={(input) => void review(
            "apply",
            selectedProposal.id,
            input,
          )}
          onClose={() => {
            if (reviewBusy === null) setSelectedProposalId(null);
          }}
          onReject={(rationale) => void review(
            "reject",
            selectedProposal.id,
            { rationale },
          )}
          retryAction={reviewRetry?.proposalId === selectedProposal.id
            ? reviewRetry.action
            : null}
          retryRequest={reviewRetry?.proposalId === selectedProposal.id
            ? reviewRetry.request
            : null}
          turn={selectedProposal}
        />
      ) : null}
    </section>
  );
}

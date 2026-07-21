"use client";

import {
  READINESS_THRESHOLD,
  RoomSummarySchema,
  SERVER_VOTES_MAP_KEY,
  VoteMutationResponseSchema,
  VoteSnapshotSchema,
  evaluateVote,
  type RoomPhase,
  type VoteSnapshot,
} from "@architect/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

type ReadinessVoteProps = {
  doc: Y.Doc;
  onPhaseChange?: (phase: RoomPhase) => void;
  participantId: string;
  phase: RoomPhase;
  roomId: string;
};

type VoteAction = "POST" | "DELETE";

class PublicVoteError extends Error {}

const EMPTY_SNAPSHOT = evaluateVote({
  activeParticipantIds: [],
  voterIds: [],
  threshold: READINESS_THRESHOLD,
});
const PHASE_CONFIRM_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

function publicMessage(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const message = (input as { message?: unknown }).message;
  return typeof message === "string" && message ? message : null;
}

export function ReadinessVote({
  doc,
  onPhaseChange,
  participantId,
  phase,
  roomId,
}: ReadinessVoteProps) {
  const initial = VoteSnapshotSchema.safeParse(
    doc.getMap(SERVER_VOTES_MAP_KEY).get("ready"),
  );
  const [snapshot, setSnapshot] = useState<VoteSnapshot>(
    initial.success ? initial.data : EMPTY_SNAPSHOT,
  );
  const [validationError, setValidationError] = useState<string | null>(
    initial.success ||
      doc.getMap(SERVER_VOTES_MAP_KEY).get("ready") === undefined
      ? null
      : "Shared readiness status is invalid. The last valid tally is still shown.",
  );
  const [requestError, setRequestError] = useState<string | null>(null);
  const [retryConfirmation, setRetryConfirmation] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmedPhase, setConfirmedPhase] = useState<RoomPhase>(phase);
  const activeRef = useRef(true);
  const pendingRef = useRef(false);
  const confirmingRef = useRef(false);
  const confirmationAttemptRef = useRef(0);
  const confirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastActionRef = useRef<VoteAction>("POST");

  useEffect(() => {
    setConfirmedPhase(phase);
  }, [phase]);

  const confirmDurablePhase: () => Promise<void> = useCallback(async () => {
    if (confirmingRef.current || !activeRef.current) return;
    if (confirmationTimerRef.current) {
      clearTimeout(confirmationTimerRef.current);
      confirmationTimerRef.current = null;
    }
    confirmingRef.current = true;
    try {
      const response = await fetch(`/api/rooms/${roomId}`, {
        credentials: "same-origin",
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(publicMessage(body) ?? "Unable to confirm room phase");
      const room = RoomSummarySchema.parse(body);
      if (!activeRef.current) return;
      setRequestError(null);
      setRetryConfirmation(false);
      confirmationAttemptRef.current = 0;
      setConfirmedPhase(room.phase);
      if (room.phase !== "sketch") onPhaseChange?.(room.phase);
    } catch {
      if (activeRef.current) {
        setRetryConfirmation(true);
        setRequestError("Consensus was reached, but room phase could not be confirmed.");
        const delay = PHASE_CONFIRM_RETRY_DELAYS_MS[confirmationAttemptRef.current];
        if (delay !== undefined) {
          confirmationAttemptRef.current += 1;
          confirmationTimerRef.current = setTimeout(() => {
            confirmationTimerRef.current = null;
            void confirmDurablePhase();
          }, delay);
        }
      }
    } finally {
      confirmingRef.current = false;
    }
  }, [onPhaseChange, roomId]);

  useEffect(() => {
    activeRef.current = true;
    const votes = doc.getMap(SERVER_VOTES_MAP_KEY);
    const initialSnapshot = VoteSnapshotSchema.safeParse(votes.get("ready"));
    if (initialSnapshot.success) {
      setValidationError(null);
      setSnapshot(initialSnapshot.data);
      if (initialSnapshot.data.met && phase === "sketch") {
        void confirmDurablePhase();
      }
    }
    const receive = (_event: Y.YMapEvent<unknown>, transaction: Y.Transaction) => {
      const parsed = VoteSnapshotSchema.safeParse(votes.get("ready"));
      if (!parsed.success) {
        setValidationError(
          "Shared readiness status is invalid. The last valid tally is still shown.",
        );
        return;
      }
      if (transaction.local) return;
      setValidationError(null);
      setSnapshot(parsed.data);
      if (parsed.data.met && phase === "sketch") {
        void confirmDurablePhase();
      }
    };

    votes.observe(receive);
    return () => {
      activeRef.current = false;
      if (confirmationTimerRef.current) {
        clearTimeout(confirmationTimerRef.current);
        confirmationTimerRef.current = null;
      }
      votes.unobserve(receive);
    };
  }, [confirmDurablePhase, doc, phase]);

  const submit = useCallback(
    async (action: VoteAction) => {
      if (pendingRef.current || confirmedPhase !== "sketch") return;
      pendingRef.current = true;
      lastActionRef.current = action;
      setPending(true);
      setRetryConfirmation(false);
      setRequestError(null);
      try {
        const response = await fetch(`/api/rooms/${roomId}/votes/ready`, {
          credentials: "same-origin",
          method: action,
        });
        const body: unknown = await response.json();
        if (!response.ok) {
          throw new PublicVoteError(
            publicMessage(body) ?? "Readiness vote could not be saved",
          );
        }
        const result = VoteMutationResponseSchema.parse(body);
        if (result.kind !== "ready") throw new Error("Invalid readiness response");
        if (!activeRef.current) return;
        setSnapshot(result.snapshot);
        setValidationError(null);
        setConfirmedPhase(result.phase);
        if (result.phase !== "sketch") onPhaseChange?.(result.phase);
      } catch (error) {
        if (activeRef.current) {
          setRequestError(
            error instanceof PublicVoteError
              ? error.message
              : "Readiness vote could not be saved",
          );
        }
      } finally {
        pendingRef.current = false;
        if (activeRef.current) setPending(false);
      }
    },
    [confirmedPhase, onPhaseChange, roomId],
  );

  const voted = snapshot.voterIds.includes(participantId);
  const tallyLabel = `${snapshot.tally} of ${snapshot.total} ready`;

  return (
    <section className="readiness-vote" aria-label="Team readiness">
      <div className="readiness-vote__heading">
        <p className="workspace-context__eyebrow">Consensus gate</p>
        <h2>Ready to reconstruct?</h2>
        <p>At least 80% of active collaborators must be ready.</p>
      </div>

      <div className="readiness-vote__progress">
        <div>
          <strong>{tallyLabel}</strong>
          <span>{Math.round(snapshot.ratio * 100)}%</span>
        </div>
        <progress
          aria-label="Readiness progress"
          aria-valuetext={tallyLabel}
          max={Math.max(snapshot.total, 1)}
          value={snapshot.tally}
        />
      </div>

      {validationError ? <p role="alert">{validationError}</p> : null}
      {requestError ? (
        <div className="readiness-vote__error">
          <p role="alert">{requestError}</p>
          <button
            disabled={pending || confirmedPhase !== "sketch"}
            onClick={() =>
              retryConfirmation
                ? void confirmDurablePhase()
                : void submit(lastActionRef.current)
            }
            type="button"
          >
            {retryConfirmation
              ? "Retry room phase confirmation"
              : "Retry readiness vote"}
          </button>
        </div>
      ) : null}
      {pending ? <p role="status">Submitting readiness…</p> : null}
      {confirmedPhase !== "sketch" ? (
        <p className="readiness-vote__success" role="status">
          Consensus reached. Reconstruction is starting.
        </p>
      ) : (
        <button
          className="readiness-vote__button"
          disabled={pending}
          onClick={() => void submit(voted ? "DELETE" : "POST")}
          type="button"
        >
          {voted ? "Withdraw readiness" : "I’m ready"}
        </button>
      )}
    </section>
  );
}

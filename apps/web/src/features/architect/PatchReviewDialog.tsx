"use client";

import type {
  ApplyArchitectPatchRequest,
  ArchitectTurn,
  DestructiveConfirmation,
} from "@architect/contracts";
import { Button } from "@architect/ui";
import { useState } from "react";

type ProposalTurn = Extract<ArchitectTurn, { kind: "proposal" }>;
type ReviewAction = "apply" | "reject";

function operationLabel(operation: ProposalTurn["operations"][number]) {
  switch (operation.type) {
    case "add_resource":
      return `Add ${operation.resource.type} “${operation.resource.name}”`;
    case "update_resource":
      return `Update resource “${operation.resourceId}”`;
    case "remove_resource":
      return `Remove resource “${operation.resourceId}”`;
    case "add_relationship":
      return `Add ${operation.relationship.kind} relationship`;
    case "remove_relationship":
      return `Remove relationship “${operation.relationshipId}”`;
  }
}

function isDestructive(turn: ProposalTurn) {
  return turn.operations.some((operation) =>
    operation.type === "remove_resource"
    || operation.type === "remove_relationship"
  );
}

export function PatchReviewDialog({
  busyAction,
  onApply,
  onClose,
  onReject,
  retryAction,
  turn,
}: Readonly<{
  busyAction: ReviewAction | null;
  onApply(input: Readonly<{
    rationale: string;
    destructiveConfirmation?: DestructiveConfirmation;
  }>): void;
  onClose(): void;
  onReject(rationale: string): void;
  retryAction: ReviewAction | null;
  turn: ProposalTurn;
}>) {
  const [rationale, setRationale] = useState("");
  const [destructiveConfirmed, setDestructiveConfirmed] = useState(false);
  const [destructiveRationale, setDestructiveRationale] = useState("");
  const destructive = isDestructive(turn);
  const lockedForRetry = retryAction !== null;
  const applyEnabled = rationale.trim().length > 0
    && (!destructive
      || (destructiveConfirmed && destructiveRationale.trim().length > 0));
  const destructiveConfirmation: ApplyArchitectPatchRequest["destructiveConfirmation"] =
    destructive && destructiveConfirmed && destructiveRationale.trim()
      ? {
          confirmed: true,
          rationale: destructiveRationale.trim(),
        }
      : undefined;

  return (
    <div className="architect-dialog-backdrop">
      <section
        aria-labelledby="architect-review-title"
        aria-modal="true"
        className="architect-dialog"
        role="dialog"
      >
        <header className="architect-dialog__header">
          <div>
            <p className="section-kicker">Human approval gate</p>
            <h2 id="architect-review-title">Review Architect patch</h2>
          </div>
          <Button
            disabled={busyAction !== null || retryAction !== null}
            onClick={onClose}
            type="button"
            variant="quiet"
          >
            Close
          </Button>
        </header>
        <p>{turn.responseText}</p>
        <ol className="architect-dialog__operations">
          {turn.operations.map((operation, index) => (
            <li key={`${operation.type}-${index}`}>
              <strong>{operationLabel(operation)}</strong>
              <span>{operation.reason}</span>
            </li>
          ))}
        </ol>
        <label>
          Review rationale
          <textarea
            disabled={busyAction !== null || lockedForRetry}
            maxLength={500}
            onChange={(event) => setRationale(event.target.value)}
            value={rationale}
          />
        </label>
        {destructive ? (
          <fieldset className="architect-dialog__destructive">
            <legend>Destructive change confirmation</legend>
            <label className="architect-dialog__check">
              <input
                checked={destructiveConfirmed}
                disabled={busyAction !== null || lockedForRetry}
                onChange={(event) => setDestructiveConfirmed(event.target.checked)}
                type="checkbox"
              />
              I confirm these destructive changes
            </label>
            <label>
              Destructive confirmation rationale
              <textarea
                disabled={busyAction !== null || lockedForRetry}
                maxLength={500}
                onChange={(event) => setDestructiveRationale(event.target.value)}
                value={destructiveRationale}
              />
            </label>
          </fieldset>
        ) : null}
        {lockedForRetry ? (
          <p className="architect-dialog__retry-note">
            Retry will resend the exact prior review request.
          </p>
        ) : null}
        <footer className="architect-dialog__actions">
          <Button
            disabled={
              !applyEnabled
              || busyAction !== null
              || retryAction === "reject"
            }
            isLoading={busyAction === "apply"}
            loadingLabel="Applying…"
            onClick={() => onApply({
              rationale: rationale.trim(),
              ...(destructiveConfirmation ? { destructiveConfirmation } : {}),
            })}
            type="button"
          >
            {retryAction === "apply" ? "Retry apply" : "Apply patch"}
          </Button>
          <Button
            disabled={
              !rationale.trim()
              || busyAction !== null
              || retryAction === "apply"
            }
            isLoading={busyAction === "reject"}
            loadingLabel="Rejecting…"
            onClick={() => onReject(rationale.trim())}
            type="button"
            variant="danger"
          >
            {retryAction === "reject" ? "Retry reject" : "Reject patch"}
          </Button>
        </footer>
      </section>
    </div>
  );
}

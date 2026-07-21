"use client";

import type {
  ApplyArchitectPatchRequest,
  ArchitectTurn,
  DestructiveConfirmation,
  RejectArchitectPatchRequest,
} from "@architect/contracts";
import { Button } from "@architect/ui";
import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

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
  error,
  fallbackFocusRef,
  onApply,
  onClose,
  onReject,
  retryAction,
  retryRequest,
  turn,
}: Readonly<{
  busyAction: ReviewAction | null;
  error: string | null;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onApply(input: Readonly<{
    rationale: string;
    destructiveConfirmation?: DestructiveConfirmation;
  }>): void;
  onClose(): void;
  onReject(rationale: string): void;
  retryAction: ReviewAction | null;
  retryRequest: ApplyArchitectPatchRequest | RejectArchitectPatchRequest | null;
  turn: ProposalTurn;
}>) {
  const retryDestructiveConfirmation = retryRequest
    && "baseRevisionId" in retryRequest
    ? retryRequest.destructiveConfirmation
    : undefined;
  const [rationale, setRationale] = useState(retryRequest?.rationale ?? "");
  const [destructiveConfirmed, setDestructiveConfirmed] = useState(
    retryDestructiveConfirmation?.confirmed ?? false,
  );
  const [destructiveRationale, setDestructiveRationale] = useState(
    retryDestructiveConfirmation?.rationale ?? "",
  );
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const rationaleRef = useRef<HTMLTextAreaElement>(null);
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

  useEffect(() => {
    const node = document.createElement("div");
    document.body.appendChild(node);
    setPortalNode(node);
    return () => node.remove();
  }, []);

  useEffect(() => {
    if (portalNode === null) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const background = Array.from(document.body.children)
      .filter((element) => element !== portalNode)
      .map((element) => ({
        ariaHidden: element.getAttribute("aria-hidden"),
        element,
        inert: element.hasAttribute("inert"),
      }));
    for (const { element } of background) {
      element.setAttribute("aria-hidden", "true");
      element.setAttribute("inert", "");
    }
    queueMicrotask(() => {
      if (rationaleRef.current?.isConnected) rationaleRef.current.focus();
    });
    return () => {
      for (const { ariaHidden, element, inert } of background) {
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
        if (!inert) element.removeAttribute("inert");
      }
      const focusTarget = previousFocus?.isConnected
        ? previousFocus
        : fallbackFocusRef.current;
      if (focusTarget?.isConnected) focusTarget.focus();
    };
  }, [fallbackFocusRef, portalNode]);

  if (portalNode === null) return null;

  return createPortal(
    <div className="architect-dialog-backdrop">
      <section
        aria-labelledby="architect-review-title"
        aria-modal="true"
        className="architect-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && busyAction === null) {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              "button:not([disabled]), textarea:not([disabled]), input:not([disabled])",
            ) ?? [],
          ).filter((element) => element.tabIndex !== -1);
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={dialogRef}
        role="dialog"
      >
        <header className="architect-dialog__header">
          <div>
            <p className="section-kicker">Human approval gate</p>
            <h2 id="architect-review-title">Review Architect patch</h2>
          </div>
          <Button
            disabled={busyAction !== null}
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
            ref={rationaleRef}
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
        {error ? (
          <p className="architect-panel__error" role="alert">{error}</p>
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
    </div>,
    portalNode,
  );
}

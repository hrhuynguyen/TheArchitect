import type { ApprovalStatus, Architecture } from "@architect/contracts";
import { Button } from "@architect/ui";

type UpgradeDecision = Extract<ApprovalStatus, "approved" | "rejected">;

export function UpgradeReviewPanel({
  architecture,
  disabled = false,
  onDecision,
}: Readonly<{
  architecture: Architecture;
  disabled?: boolean;
  onDecision(resourceId: string, decision: UpgradeDecision): void;
}>) {
  const pending = architecture.resources.filter(
    (resource) =>
      resource.origin === "stage-upgrade" &&
      resource.approvalStatus === "pending",
  );
  const resources = new Map(
    architecture.resources.map((resource) => [resource.id, resource]),
  );

  return (
    <section className="upgrade-review" aria-labelledby="upgrade-review-title">
      <header>
        <p className="section-kicker">Approval gate</p>
        <h2 id="upgrade-review-title">Stage upgrades</h2>
      </header>
      {pending.length === 0 ? (
        <p className="architecture-empty-copy">No upgrades awaiting review.</p>
      ) : (
        <ul className="upgrade-review__list">
          {pending.map((resource) => {
            const affected = new Set<string>();
            for (const relationship of architecture.relationships) {
              if (
                relationship.sourceId !== resource.id &&
                relationship.targetId !== resource.id
              ) continue;
              const otherId = relationship.sourceId === resource.id
                ? relationship.targetId
                : relationship.sourceId;
              const other = resources.get(otherId);
              if (other) affected.add(other.name);
            }
            return (
              <li key={resource.id}>
                <h3>{resource.name}</h3>
                <p>{resource.reason}</p>
                {affected.size > 0 ? (
                  <p className="upgrade-review__affects">
                    Affects {[...affected].join(", ")}
                  </p>
                ) : null}
                <div className="upgrade-review__actions">
                  <Button
                    disabled={disabled}
                    onClick={() => onDecision(resource.id, "approved")}
                    type="button"
                  >
                    Accept {resource.name}
                  </Button>
                  <Button
                    disabled={disabled}
                    onClick={() => onDecision(resource.id, "rejected")}
                    type="button"
                    variant="danger"
                  >
                    Reject {resource.name}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

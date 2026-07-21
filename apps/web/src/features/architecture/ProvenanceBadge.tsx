import type { ResourceOrigin } from "@architect/contracts";

const ORIGIN_LABELS: Record<ResourceOrigin, string> = {
  explicit: "Explicit",
  "inferred-minimal": "Inferred",
  "stage-upgrade": "Stage upgrade",
};

export function ProvenanceBadge({
  origin,
  reason,
}: Readonly<{ origin: ResourceOrigin; reason: string }>) {
  return (
    <span
      className={`provenance-badge provenance-badge--${origin}`}
      title={reason}
    >
      {ORIGIN_LABELS[origin]}
    </span>
  );
}

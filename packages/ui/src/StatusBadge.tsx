import type { ReactNode } from "react";

export type StatusBadgeProps = {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning";
};

export function StatusBadge({ children, tone = "neutral" }: StatusBadgeProps) {
  return <span className={`ui-status ui-status--${tone}`}>{children}</span>;
}

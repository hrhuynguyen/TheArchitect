import type { RoomSummary } from "@architect/contracts";
import { StatusBadge } from "@architect/ui";
import type { ReactNode } from "react";
import { PhaseRail } from "./PhaseRail";

export type WorkspaceShellProps = {
  room: RoomSummary;
  children: ReactNode;
  contextPanel?: ReactNode;
};

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function WorkspaceShell({ room, children, contextPanel }: WorkspaceShellProps) {
  const collaboratorLabel = `${room.participants.length} ${
    room.participants.length === 1 ? "collaborator" : "collaborators"
  }`;

  return (
    <div className="workspace-shell">
      <PhaseRail phase={room.phase} roomId={room.id} />

      <main className="workspace-content" aria-label="Workspace content">
        <header className="workspace-content__header">
          <div>
            <p className="workspace-content__eyebrow">Room {room.id.slice(0, 8)}</p>
            <p className="workspace-content__title">Guided workspace</p>
          </div>
          <div className="workspace-content__status">
            <StatusBadge tone={room.mode === "solo" ? "warning" : "success"}>
              {room.mode === "solo" ? "Solo" : collaboratorLabel}
            </StatusBadge>
            <StatusBadge>{room.isOwner ? "Owner" : "Participant"}</StatusBadge>
          </div>
        </header>
        <section className="workspace-content__surface">{children}</section>
      </main>

      <aside className="workspace-context" aria-label="Workspace context">
        <div className="workspace-context__section">
          <p className="workspace-context__eyebrow">In this room</p>
          <h2>{collaboratorLabel}</h2>
          <ul className="participant-list" aria-label="Room participants">
            {room.participants.map((participant) => (
              <li key={participant.id}>
                <span
                  className="participant-avatar"
                  style={{ backgroundColor: participant.color }}
                  aria-hidden="true"
                >
                  {initials(participant.name)}
                </span>
                <span>{participant.name}</span>
              </li>
            ))}
          </ul>
        </div>
        {contextPanel ? <div className="workspace-context__section">{contextPanel}</div> : null}
      </aside>
    </div>
  );
}

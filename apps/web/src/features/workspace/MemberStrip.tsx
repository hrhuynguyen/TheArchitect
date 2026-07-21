import type { AwarenessProfile } from "@architect/contracts";

type MemberStripProps = {
  profiles: AwarenessProfile[];
};

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function MemberStrip({ profiles }: MemberStripProps) {
  return (
    <div className="member-strip">
      <ul aria-label="Live collaborators" className="member-strip__list">
        {profiles.map((profile) => (
          <li key={profile.participantId}>
            <span
              aria-hidden="true"
              className="member-strip__avatar"
              style={{ backgroundColor: profile.color }}
            >
              {initials(profile.name)}
            </span>
            <span>{profile.name}</span>
          </li>
        ))}
      </ul>
      {profiles.length === 0 ? (
        <span className="member-strip__empty">Waiting for collaborators…</span>
      ) : null}
    </div>
  );
}

import type { AwarenessProfile } from "@architect/contracts";

type CursorOverlayProps = {
  localParticipantId: string;
  profiles: AwarenessProfile[];
};

export function CursorOverlay({
  localParticipantId,
  profiles,
}: CursorOverlayProps) {
  const visibleProfiles = profiles.filter(
    (profile) =>
      profile.participantId !== localParticipantId &&
      profile.phase === "sketch" &&
      profile.cursor,
  );

  return (
    <div aria-hidden="true" className="cursor-overlay">
      {visibleProfiles.map((profile) => (
        <div
          className="remote-cursor"
          data-testid={`cursor-${profile.participantId}`}
          key={profile.participantId}
          style={{
            color: profile.color,
            left: `${profile.cursor!.x}px`,
            top: `${profile.cursor!.y}px`,
          }}
        >
          <svg height="22" viewBox="0 0 20 24" width="20" aria-hidden="true">
            <path
              d="M2 1.7 17.2 13l-7.1 1.1-3.6 6.2L2 1.7Z"
              fill="currentColor"
              stroke="white"
              strokeLinejoin="round"
              strokeWidth="1.5"
            />
          </svg>
          <span style={{ backgroundColor: profile.color }}>{profile.name}</span>
        </div>
      ))}
    </div>
  );
}

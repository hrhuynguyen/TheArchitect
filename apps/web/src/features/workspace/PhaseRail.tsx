import type { RoomPhase } from "@architect/contracts";

type PhaseRailProps = {
  phase: RoomPhase;
  roomId: string;
};

const phases = [
  { id: "sketch", label: "Sketch", description: "Shape the intent" },
  { id: "architect", label: "Architect", description: "Make it buildable" },
  { id: "deploy", label: "Deploy", description: "Ship with evidence" },
] as const;

export function visibleWorkspacePhase(phase: RoomPhase) {
  return phase === "reconstructing" ? "architect" : phase;
}

export function PhaseRail({ phase, roomId }: PhaseRailProps) {
  const current = visibleWorkspacePhase(phase);

  return (
    <nav className="phase-rail" aria-label="Workspace phases">
      <a className="phase-rail__brand" href="/" aria-label="The Architect home">
        <span className="brand-mark" aria-hidden="true">A</span>
        <span>The Architect</span>
      </a>
      <ol className="phase-rail__steps">
        {phases.map((item, index) => {
          const content = (
            <>
              <span className="phase-rail__number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="phase-rail__copy">
                <span className="phase-rail__label">{item.label}</span>
                <span className="phase-rail__description">{item.description}</span>
              </span>
            </>
          );

          return (
            <li key={item.id}>
              {current === item.id ? (
                <a
                  className="phase-rail__link"
                  href={`/room/${encodeURIComponent(roomId)}#${item.id}`}
                  aria-current="step"
                >
                  {content}
                </a>
              ) : (
                <span className="phase-rail__link" aria-disabled="true">
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="phase-rail__note">Guided workspace</p>
    </nav>
  );
}

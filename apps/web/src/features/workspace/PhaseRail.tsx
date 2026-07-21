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

function visiblePhase(phase: RoomPhase) {
  return phase === "reconstructing" ? "architect" : phase;
}

export function PhaseRail({ phase, roomId }: PhaseRailProps) {
  const current = visiblePhase(phase);

  return (
    <nav className="phase-rail" aria-label="Workspace phases">
      <a className="phase-rail__brand" href="/" aria-label="The Architect home">
        <span className="brand-mark" aria-hidden="true">A</span>
        <span>The Architect</span>
      </a>
      <ol className="phase-rail__steps">
        {phases.map((item, index) => (
          <li key={item.id}>
            <a
              className="phase-rail__link"
              href={`/room/${encodeURIComponent(roomId)}#${item.id}`}
              aria-current={current === item.id ? "step" : undefined}
            >
              <span className="phase-rail__number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="phase-rail__copy">
                <span className="phase-rail__label">{item.label}</span>
                <span className="phase-rail__description">{item.description}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
      <p className="phase-rail__note">Guided workspace</p>
    </nav>
  );
}

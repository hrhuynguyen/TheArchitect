import type {
  ArchitectureRevision,
  HistoryEvent,
} from "@architect/contracts";

function actorLabel(type: string, id: string | null) {
  return id ? `${type} · ${id}` : type;
}

export function RevisionHistory({
  revisions,
  events,
}: Readonly<{
  revisions: readonly ArchitectureRevision[];
  events: readonly HistoryEvent[];
}>) {
  return (
    <section className="revision-history" aria-labelledby="revision-history-title">
      <header>
        <p className="section-kicker">Audit trail</p>
        <h2 id="revision-history-title">Revision history</h2>
      </header>
      {revisions.length === 0 ? (
        <p className="architecture-empty-copy">No saved revisions yet.</p>
      ) : (
        <ol className="revision-history__revisions">
          {revisions.map((revision) => (
            <li key={revision.id}>
              <h3>Revision {revision.version}</h3>
              <p>{revision.rationale}</p>
              <small>
                {actorLabel(revision.authorType, revision.authorId)} · {revision.stage}
              </small>
            </li>
          ))}
        </ol>
      )}
      {events.length > 0 ? (
        <ul className="revision-history__events" aria-label="Change events">
          {events.map((event) => (
            <li key={event.id}>
              <span>{event.title}</span>
              <small>{event.status}</small>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

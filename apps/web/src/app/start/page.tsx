import type { Metadata } from "next";
import { StartRoom } from "../../features/rooms/StartRoom";

export const metadata: Metadata = {
  title: "Start",
};

export default function StartPage() {
  return (
    <main className="start-page">
      <nav className="site-nav site-nav--compact" aria-label="Start navigation">
        <a className="site-brand" href="/" aria-label="The Architect home">
          <span className="brand-mark" aria-hidden="true">A</span>
          <span>The Architect</span>
        </a>
        <a className="text-link" href="/">Back to overview</a>
      </nav>
      <div className="start-page__layout">
        <section className="start-page__intro" aria-labelledby="start-intro-title">
          <p className="section-kicker">Guided workspace</p>
          <h2 id="start-intro-title">Start with the people, then the system.</h2>
          <p>
            Every room follows the same durable path from sketch to architecture to
            deployment. Invite collaborators now, or open a solo room and share later.
          </p>
          <ol className="start-page__phases" aria-label="Workspace phases">
            <li><span>01</span> Sketch the intent</li>
            <li><span>02</span> Architect the system</li>
            <li><span>03</span> Deploy with evidence</li>
          </ol>
        </section>
        <StartRoom />
      </div>
    </main>
  );
}

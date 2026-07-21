import { APP_NAME } from "@architect/contracts";

export default function Home() {
  return (
    <main className="landing">
      <nav className="site-nav" aria-label="Primary navigation">
        <a className="site-brand" href="/" aria-label={`${APP_NAME} home`}>
          <span className="brand-mark" aria-hidden="true">A</span>
          <span>{APP_NAME}</span>
        </a>
        <a className="nav-cta" href="/start">Open workspace</a>
      </nav>

      <section className="hero" aria-labelledby="hero-title">
        <p className="hero__eyebrow">From first line to live system</p>
        <h1 id="hero-title">
          Architecture starts as a conversation.
        </h1>
        <p className="hero__lede">
          Sketch the intent, shape it with an AI architect, and deploy with the
          decisions still attached.
        </p>
        <div className="hero__actions">
          <a className="button-link button-link--primary" href="/start">
            Start designing
          </a>
          <a className="button-link button-link--secondary" href="#workflow">
            See the workflow
          </a>
        </div>
        <p className="hero__note">No account required. Start with a guest profile.</p>
      </section>

      <section className="workflow" id="workflow" aria-labelledby="workflow-title">
        <div className="workflow__intro">
          <p className="section-kicker">One workspace, three deliberate phases</p>
          <h2 id="workflow-title">Keep the thread from idea to infrastructure.</h2>
        </div>
        <ol className="workflow__grid">
          <li>
            <span className="workflow__number">01</span>
            <h3>Sketch</h3>
            <p>Capture boundaries, dependencies, and requirements together.</p>
          </li>
          <li>
            <span className="workflow__number">02</span>
            <h3>Architect</h3>
            <p>Turn the shared intent into a reviewable, buildable system.</p>
          </li>
          <li>
            <span className="workflow__number">03</span>
            <h3>Deploy</h3>
            <p>Move forward with the rationale and evidence still in view.</p>
          </li>
        </ol>
      </section>

      <section className="landing-close" aria-labelledby="landing-close-title">
        <p className="section-kicker">A calmer way to build</p>
        <h2 id="landing-close-title">Bring the whole system into one room.</h2>
        <a className="button-link button-link--primary" href="/start">
          Create a workspace
        </a>
      </section>

      <footer className="site-footer">
        <span>{APP_NAME}</span>
        <span>Sketch · Architect · Deploy</span>
      </footer>
    </main>
  );
}

"use client";

import {
  DebugReconstructionRequestSchema,
  DebugReconstructionResponseSchema,
  RequirementsProfileSchema,
  defaultRequirementsProfile,
  type DebugReconstructionResponse,
  type RequirementsProfile,
} from "@architect/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";

type ResultPanelProps = Readonly<{
  heading: string;
  value: unknown;
}>;

function ResultPanel({ heading, value }: ResultPanelProps) {
  return (
    <section className="debug-result-card">
      <h2>{heading}</h2>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

function readPng(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (
        typeof reader.result === "string" &&
        reader.result.startsWith("data:image/png;base64,")
      ) resolve(reader.result);
      else reject(new Error("invalid PNG"));
    }, { once: true });
    reader.addEventListener("error", () => reject(new Error("unreadable PNG")), {
      once: true,
    });
    reader.readAsDataURL(file);
  });
}

const OPTIONS = Object.freeze({
  audience: ["internal", "external"],
  criticality: ["non_critical", "business_critical", "mission_critical"],
  expectedUsers: ["tiny", "small", "medium", "large", "global"],
  traffic: ["low", "moderate", "high", "extreme"],
  burstiness: ["steady", "bursty", "spiky"],
  availability: ["best_effort", "high_availability", "continuous"],
  recovery: ["flexible", "standard", "rapid"],
});

const LABELS = Object.freeze({
  audience: "Audience",
  criticality: "Criticality",
  expectedUsers: "Expected users",
  traffic: "Traffic",
  burstiness: "Burstiness",
  availability: "Availability",
  recovery: "Recovery target",
});

type SelectKey = keyof typeof OPTIONS;

export function DebugBench() {
  const [roomId, setRoomId] = useState("");
  const [requirements, setRequirements] = useState<RequirementsProfile>(() => ({
    ...defaultRequirementsProfile(),
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DebugReconstructionResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const updateSelect = (key: SelectKey, value: string) => {
    const next = RequirementsProfileSchema.safeParse({
      ...requirements,
      [key]: value,
    });
    if (next.success) setRequirements(next.data);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const normalizedRoomId = roomId.trim();
    const file = fileRef.current?.files?.[0];
    if (!normalizedRoomId) {
      setError("Enter a room ID.");
      return;
    }
    if (!file || file.type !== "image/png") {
      setError("Choose a PNG sketch.");
      return;
    }

    setPending(true);
    setError(null);
    setResult(null);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    let imageDataUrl = "";
    try {
      imageDataUrl = await readPng(file);
      const request = DebugReconstructionRequestSchema.parse({
        imageDataUrl,
        mimeType: "image/png",
        requirements,
      });
      const response = await fetch(
        `/api/debug/rooms/${encodeURIComponent(normalizedRoomId)}/reconstruction`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        },
      );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("invalid-response");
      }
      if (!response.ok) throw new Error("request-failed");
      const parsed = DebugReconstructionResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("invalid-response");
      if (activeRef.current) setResult(parsed.data);
    } catch (caught) {
      if (!activeRef.current || controller.signal.aborted) return;
      setError(
        caught instanceof Error && caught.message === "invalid-response"
          ? "The diagnostic response was invalid."
          : caught instanceof Error && caught.message === "invalid PNG"
            ? "Choose a PNG sketch."
            : "Diagnostic analysis could not be completed.",
      );
    } finally {
      imageDataUrl = "";
      if (activeRef.current) setPending(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  return (
    <main className="debug-page">
      <header className="debug-hero">
        <p className="section-kicker">Non-production diagnostic</p>
        <h1>Inspect reconstruction, without changing the room.</h1>
        <p>
          Run the same typed provider and compiler pipeline against a PNG. This
          bench creates no jobs, revisions, history, AI runs, votes, or Yjs updates.
        </p>
      </header>

      <div className="debug-layout">
        <form className="debug-form" noValidate onSubmit={(event) => void submit(event)}>
          <div className="debug-field">
            <label htmlFor="debug-room">Room ID</label>
            <input
              autoComplete="off"
              id="debug-room"
              onChange={(event) => setRoomId(event.target.value)}
              required
              value={roomId}
            />
          </div>
          <div className="debug-field">
            <label htmlFor="debug-file">PNG sketch</label>
            <input
              accept=".png,image/png"
              id="debug-file"
              ref={fileRef}
              required
              type="file"
            />
          </div>

          <fieldset className="debug-requirements">
            <legend>Workload profile</legend>
            {Object.entries(OPTIONS).map(([rawKey, options]) => {
              const key = rawKey as SelectKey;
              return (
                <div className="debug-field" key={key}>
                  <label htmlFor={`debug-${key}`}>{LABELS[key]}</label>
                  <select
                    id={`debug-${key}`}
                    onChange={(event) => updateSelect(key, event.target.value)}
                    value={requirements[key] as string}
                  >
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
            <label className="debug-check" htmlFor="debug-async">
              <input
                checked={requirements.asyncWorkload}
                id="debug-async"
                onChange={(event) => setRequirements({
                  ...requirements,
                  asyncWorkload: event.target.checked,
                })}
                type="checkbox"
              />
              Asynchronous workload
            </label>
          </fieldset>

          {error ? <p className="debug-error" role="alert">{error}</p> : null}
          {pending ? <p role="status">Analyzing sketch…</p> : null}
          <button className="ui-button ui-button--primary" disabled={pending} type="submit">
            {pending ? "Analyzing…" : "Analyze sketch"}
          </button>
        </form>

        <section className="debug-results" aria-label="Diagnostic results">
          {result ? (
            <>
              <section className="debug-result-card debug-result-card--provenance">
                <h2>Provider provenance</h2>
                <dl>
                  <div><dt>Provider</dt><dd>{result.provider.provider}</dd></div>
                  <div><dt>Model</dt><dd>{result.provider.model}</dd></div>
                </dl>
              </section>
              <ResultPanel heading="Intent" value={result.intent} />
              <ResultPanel heading="Diagnostics" value={result.diagnostics} />
              <ResultPanel heading="Stage decision" value={result.stageDecision} />
              <ResultPanel heading="Deployment plan" value={result.deploymentPlan} />
              <ResultPanel heading="Semantic graph" value={result.semanticGraph} />
            </>
          ) : (
            <div className="debug-results__empty">
              <span aria-hidden="true">{"{}"}</span>
              <h2>Validated output will appear here.</h2>
              <p>The selected image is never previewed or added to the page.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

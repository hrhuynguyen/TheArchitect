"use client";

import {
  defaultRequirementsProfile,
  RequirementsProfileSchema,
  type RequirementsProfile,
} from "@architect/contracts";
import { useEffect, useId, useState } from "react";
import * as Y from "yjs";

export const REQUIREMENTS_MAP_KEY = "requirements";
export const REQUIREMENTS_CURRENT_KEY = "current";

type RequirementsPanelProps = {
  connectionError?: string | null;
  disabled?: boolean;
  doc: Y.Doc;
};

type SelectField = {
  key: Exclude<keyof RequirementsProfile, "version" | "asyncWorkload">;
  label: string;
  options: ReadonlyArray<{ label: string; value: string }>;
};

const SELECT_FIELDS: ReadonlyArray<SelectField> = [
  {
    key: "audience",
    label: "Who uses this system?",
    options: [
      { label: "External customers", value: "external" },
      { label: "Internal team", value: "internal" },
    ],
  },
  {
    key: "criticality",
    label: "System criticality",
    options: [
      { label: "Non-critical", value: "non_critical" },
      { label: "Business-critical", value: "business_critical" },
      { label: "Mission-critical", value: "mission_critical" },
    ],
  },
  {
    key: "expectedUsers",
    label: "Expected users",
    options: [
      { label: "Tiny · under 100", value: "tiny" },
      { label: "Small · under 10K", value: "small" },
      { label: "Medium · under 100K", value: "medium" },
      { label: "Large · under 1M", value: "large" },
      { label: "Global · 1M+", value: "global" },
    ],
  },
  {
    key: "traffic",
    label: "Traffic volume",
    options: [
      { label: "Low", value: "low" },
      { label: "Moderate", value: "moderate" },
      { label: "High", value: "high" },
      { label: "Extreme", value: "extreme" },
    ],
  },
  {
    key: "burstiness",
    label: "Traffic pattern",
    options: [
      { label: "Steady", value: "steady" },
      { label: "Bursty", value: "bursty" },
      { label: "Spiky", value: "spiky" },
    ],
  },
  {
    key: "availability",
    label: "Availability target",
    options: [
      { label: "Best effort", value: "best_effort" },
      { label: "High availability", value: "high_availability" },
      { label: "Continuous", value: "continuous" },
    ],
  },
  {
    key: "recovery",
    label: "Recovery target",
    options: [
      { label: "Flexible", value: "flexible" },
      { label: "Standard", value: "standard" },
      { label: "Rapid", value: "rapid" },
    ],
  },
];

function immutableProfile(input: unknown): Readonly<RequirementsProfile> {
  return Object.freeze(RequirementsProfileSchema.parse(input));
}

export function readRequirements(
  doc: Y.Doc,
): Readonly<RequirementsProfile> | null {
  const input = doc
    .getMap<unknown>(REQUIREMENTS_MAP_KEY)
    .get(REQUIREMENTS_CURRENT_KEY);
  if (input === undefined) return null;
  const parsed = RequirementsProfileSchema.safeParse(input);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export function writeRequirements(
  doc: Y.Doc,
  input: RequirementsProfile,
): Readonly<RequirementsProfile> {
  const profile = immutableProfile(input);
  doc.transact(() => {
    doc
      .getMap<unknown>(REQUIREMENTS_MAP_KEY)
      .set(REQUIREMENTS_CURRENT_KEY, profile);
  }, "architect/requirements-local");
  return profile;
}

export function RequirementsPanel({
  connectionError = null,
  disabled = false,
  doc,
}: RequirementsPanelProps) {
  const idPrefix = useId();
  const [profile, setProfile] = useState<Readonly<RequirementsProfile>>(() =>
    readRequirements(doc) ?? defaultRequirementsProfile(),
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    const requirements = doc.getMap<unknown>(REQUIREMENTS_MAP_KEY);

    const receive = () => {
      const input = requirements.get(REQUIREMENTS_CURRENT_KEY);
      if (input === undefined) {
        try {
          setValidationError(null);
          setProfile(writeRequirements(doc, defaultRequirementsProfile()));
        } catch {
          setValidationError("Requirements could not be initialized.");
        }
        return;
      }
      const parsed = RequirementsProfileSchema.safeParse(input);
      if (!parsed.success) {
        setValidationError(
          "Shared requirements are invalid. Your last valid values are still shown.",
        );
        return;
      }
      setValidationError(null);
      setProfile(Object.freeze(parsed.data));
    };

    receive();
    requirements.observe(receive);
    return () => requirements.unobserve(receive);
  }, [doc]);

  const updateProfile = (patch: Partial<RequirementsProfile>) => {
    try {
      setValidationError(null);
      setProfile(writeRequirements(doc, { ...profile, ...patch }));
    } catch {
      setValidationError("That requirements change could not be saved.");
    }
  };

  return (
    <section className="requirements-panel" aria-label="System workload profile">
      <div className="requirements-panel__heading">
        <p className="workspace-context__eyebrow">Workload profile</p>
        <h2>Design for the load you expect.</h2>
        <p>These constraints stay shared with the drawing.</p>
      </div>

      {connectionError ? (
        <p className="requirements-panel__error" role="alert">
          {connectionError}
        </p>
      ) : null}
      {validationError ? (
        <p className="requirements-panel__error" role="alert">
          {validationError}
        </p>
      ) : null}

      <fieldset className="requirements-panel__fields" disabled={disabled}>
        <legend>Workload requirements</legend>
        {SELECT_FIELDS.map((field) => {
          const id = `${idPrefix}-${field.key}`;
          return (
            <label className="requirements-panel__field" htmlFor={id} key={field.key}>
              <span>{field.label}</span>
              <select
                id={id}
                onChange={(event) =>
                  updateProfile({ [field.key]: event.currentTarget.value })
                }
                value={profile[field.key]}
              >
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
        <label className="requirements-panel__check" htmlFor={`${idPrefix}-async`}>
          <input
            aria-label="Async background work"
            checked={profile.asyncWorkload}
            id={`${idPrefix}-async`}
            onChange={(event) =>
              updateProfile({ asyncWorkload: event.currentTarget.checked })
            }
            type="checkbox"
          />
          <span>
            <strong>Async background work</strong>
            <small>Queues, jobs, or deferred processing</small>
          </span>
        </label>
      </fieldset>
    </section>
  );
}

import { useId, type InputHTMLAttributes } from "react";

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  id?: string;
  label: string;
  hint?: string;
  error?: string;
};

export function Field({ id, label, hint, error, className, ...props }: FieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = hint || error ? `${inputId}-description` : undefined;

  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className={["ui-field__input", className].filter(Boolean).join(" ")}
        aria-describedby={descriptionId}
        aria-invalid={error ? true : undefined}
        {...props}
      />
      {error ? (
        <span className="ui-field__message ui-field__message--error" id={descriptionId}>
          {error}
        </span>
      ) : hint ? (
        <span className="ui-field__message" id={descriptionId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

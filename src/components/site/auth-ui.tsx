"use client";

import { type ReactNode, useId, useRef, useState } from "react";
import { Icon } from "./icons";
import { type Strength, type ValidatorKey, VALIDATORS, passwordStrength } from "./validate";

export type FieldSpec = {
  name: string;
  label: string;
  type?: "text" | "email" | "password";
  autoComplete: string;
  validate: ValidatorKey;
  hint?: string;
  maxLength?: number;
  strength?: boolean;
  autoFocus?: boolean;
  labelAction?: ReactNode;
};

export type Done = { redirect: string } | { message: ReactNode };

type Props = {
  url: string;
  fields: FieldSpec[];
  submitLabel: string;
  busyLabel: string;
  done: Done;
  extra?: Record<string, string>;
  below?: ReactNode;
};

const NETWORK_ERROR = "We could not reach the server. Check your connection and try again.";
const SERVER_ERROR = "Something went wrong on our side. Please try again in a moment.";

function ErrorLine({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="pub-bad mt-1.5 flex items-start gap-1.5 text-sm">
      <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 5.5v5.2M10 13.6v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

/** With `quiet` only the bars show: the field's error line already says what is wrong, so the hint would say it twice. */
function StrengthMeter({ strength, id, quiet }: { strength: Strength; id: string; quiet: boolean }) {
  const colors = ["bg-[#b91c1c]", "bg-[#b45309]", "bg-[#a16207]", "bg-[#15803d]", "bg-[#047857]"];
  return (
    <div id={id} className="mt-2">
      <div className="pub-meter flex gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={`h-1.5 flex-1 rounded-full ${strength.score >= n ? colors[strength.score] : "bg-border"}`} />
        ))}
      </div>
      {!quiet && (
        <p className="mt-1.5 text-xs text-muted">
          {strength.label && <strong className="font-semibold text-foreground">{strength.label}. </strong>}
          {strength.hint}
        </p>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

type FieldProps = {
  spec: FieldSpec;
  value: string;
  error: string;
  personal: string[];
  onChange: (v: string) => void;
  onBlur: () => void;
  inputRef: (el: HTMLInputElement | null) => void;
};

function Field({ spec, value, error, personal, onChange, onBlur, inputRef }: FieldProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const isPassword = spec.type === "password";
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const strengthId = `${id}-strength`;
  // Once something is typed, an error line (too short, too long) says all the meter's hint would, so the hint steps aside.
  const meterQuiet = Boolean(error && value);
  const describedBy = [spec.hint && !spec.strength ? hintId : "", spec.strength && !meterQuiet ? strengthId : "", error ? errId : ""].filter(Boolean).join(" ") || undefined;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {spec.label}
        </label>
        {spec.labelAction}
      </div>
      <div className="relative mt-1.5">
        <input
          id={id}
          ref={inputRef}
          name={spec.name}
          type={isPassword && shown ? "text" : (spec.type ?? "text")}
          autoComplete={spec.autoComplete}
          autoFocus={spec.autoFocus}
          required
          maxLength={spec.maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoCapitalize={spec.type === "email" || isPassword ? "none" : undefined}
          autoCorrect={spec.type === "email" || isPassword ? "off" : undefined}
          spellCheck={spec.type === "email" || isPassword ? false : undefined}
          inputMode={spec.type === "email" ? "email" : undefined}
          className={`pub-field ${isPassword ? "pr-12" : ""}`}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? "Hide password" : "Show password"}
            aria-pressed={shown}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-muted hover:text-foreground"
          >
            <Icon name={shown ? "eyeOff" : "eye"} />
          </button>
        )}
      </div>
      {spec.hint && !spec.strength && !error && (
        <p id={hintId} className="mt-1.5 text-xs text-muted">
          {spec.hint}
        </p>
      )}
      {spec.strength && <StrengthMeter id={strengthId} strength={passwordStrength(value, personal)} quiet={meterQuiet} />}
      {error && <ErrorLine id={errId}>{error}</ErrorLine>}
    </div>
  );
}

export const submitClass =
  "inline-flex w-full items-center justify-center gap-2 rounded-full bg-accent px-6 py-3 text-base font-semibold text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-70";

export function AuthForm({ url, fields, submitLabel, busyLabel, done, extra, below }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, ""])));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverError, setServerError] = useState("");
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const refs = useRef<Record<string, HTMLInputElement | null>>({});

  const errorFor = (f: FieldSpec) => (touched[f.name] ? VALIDATORS[f.validate](values[f.name] ?? "") : "");
  const personal = [(values.email ?? "").split("@")[0] ?? "", ...(values.name ?? "").split(/\s+/)].filter((s) => s.length >= 4);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const allTouched = Object.fromEntries(fields.map((f) => [f.name, true]));
    setTouched(allTouched);
    const firstBad = fields.find((f) => VALIDATORS[f.validate](values[f.name] ?? ""));
    if (firstBad) {
      setServerError("");
      refs.current[firstBad.name]?.focus();
      return;
    }
    setServerError("");
    setBusy(true);
    try {
      const body: Record<string, string> = { ...extra };
      for (const f of fields) body[f.name] = f.type === "password" ? values[f.name] : values[f.name].trim();
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) {
        if ("redirect" in done) {
          window.location.assign(done.redirect);
          return;
        }
        setFinished(true);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setServerError(typeof data.error === "string" && data.error ? data.error : SERVER_ERROR);
    } catch {
      setServerError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  if (finished && "message" in done) {
    return (
      <div role="status" className="rounded-xl border border-border bg-surface p-4 text-sm leading-relaxed">
        {done.message}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" aria-busy={busy}>
      {fields.map((f) => (
        <Field
          key={f.name}
          spec={f}
          value={values[f.name] ?? ""}
          error={errorFor(f)}
          personal={personal}
          onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))}
          // An empty field is not an error until submit: tabbing past it, or pressing a button, must not insert an error line that shifts the page.
          onBlur={() => setTouched((s) => ((values[f.name] ?? "").trim() ? { ...s, [f.name]: true } : s))}
          inputRef={(el) => {
            refs.current[f.name] = el;
          }}
        />
      ))}
      {serverError && (
        <div role="alert" className="pub-bad rounded-xl border border-current p-3 text-sm font-medium leading-relaxed">
          {serverError}
        </div>
      )}
      <button type="submit" disabled={busy} className={submitClass}>
        {busy && <Spinner />}
        {busy ? busyLabel : submitLabel}
      </button>
      {below}
    </form>
  );
}

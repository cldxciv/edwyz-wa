import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import { type TemplatePreview } from "./helpers";

export const WIZARD_STEPS = ["Audience", "Message", "Schedule", "Review"] as const;

function Check() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

/** Four numbered steps. Finished steps are buttons that go back; the current step is announced with aria-current. */
export function Stepper({ current, onGo, disabled }: { current: number; onGo: (step: number) => void; disabled?: boolean }) {
  return (
    <nav aria-label="Broadcast steps" className="mb-6">
      <ol className="flex items-center gap-2 text-sm">
        {WIZARD_STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < current;
          const active = n === current;
          const circle = (
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                done && "border-accent bg-accent text-on-accent",
                active && "border-accent bg-accent-soft text-accent-ink",
                !done && !active && "border-border-strong text-muted",
              )}
            >
              {done ? <Check /> : n}
            </span>
          );
          const text = (
            <span className={cn(active ? "font-semibold" : "sr-only text-muted sm:not-sr-only", done && "sm:text-foreground")}>{label}</span>
          );
          return (
            <li key={label} aria-current={active ? "step" : undefined} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden className={cn("h-px w-4 sm:w-8", done || active ? "bg-accent" : "bg-border-strong")} />}
              {done ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onGo(n)}
                  aria-label={`Step ${n}, ${label}, done. Go back to change it`}
                  className="inline-flex min-h-10 items-center gap-2 rounded-full pr-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-8"
                >
                  {circle}
                  {text}
                </button>
              ) : (
                <span className="inline-flex min-h-8 items-center gap-2">
                  {circle}
                  {text}
                  <span className="sr-only">{active ? "(current step)" : "(not yet)"}</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs text-muted sm:hidden">
        Step {current} of {WIZARD_STEPS.length}
      </p>
    </nav>
  );
}

/** A radio presented as a card. The native radio stays visible, so selection never depends on colour alone. */
export function ChoiceCard({ name, value, checked, onChange, title, description, children }: { name: string; value: string; checked: boolean; onChange: () => void; title: string; description: string; children?: ReactNode }) {
  return (
    <div className={cn("rounded-control border p-3", checked ? "border-accent bg-accent-soft" : "border-border-strong bg-raised")}>
      <label className="flex min-h-10 cursor-pointer items-start gap-3">
        <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="mt-1 h-4 w-4 shrink-0 accent-accent" />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-sm text-muted">{description}</span>
        </span>
      </label>
      {checked && children ? <div className="mt-3 pl-7">{children}</div> : null}
    </div>
  );
}

/** What the message will look like, drawn with theme tokens so it works in light and dark. */
export function TemplateBubble({ preview }: { preview: TemplatePreview }) {
  return (
    <figure role="group" aria-label="Message preview" className="rounded-card border border-border bg-surface-2 p-4">
      <div className="max-w-sm rounded-pop rounded-tl-none border border-border bg-raised p-3 text-sm shadow-raised">
        {preview.header && <p className="mb-1 font-semibold">{preview.header}</p>}
        <p className="whitespace-pre-wrap break-words">{preview.body || <span className="text-muted">This template has no message text.</span>}</p>
        {preview.footer && <p className="mt-2 text-xs text-muted">{preview.footer}</p>}
      </div>
      {preview.buttons.map((b, i) => (
        <div key={`${b}-${i}`} className="mt-1 max-w-sm rounded-pop border border-border bg-raised py-2 text-center text-sm font-medium text-accent-ink shadow-raised">
          {b}
        </div>
      ))}
    </figure>
  );
}

export function SummaryRow({ label, children, onChange, changeLabel }: { label: string; children: ReactNode; onChange?: () => void; changeLabel?: string }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr_auto] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
      {onChange && (
        <dd className="sm:text-right">
          <button type="button" onClick={onChange} className="min-h-8 rounded text-sm font-medium text-accent-ink underline-offset-2 hover:underline" aria-label={changeLabel ?? `Change ${label.toLowerCase()}`}>
            Change
          </button>
        </dd>
      )}
    </div>
  );
}

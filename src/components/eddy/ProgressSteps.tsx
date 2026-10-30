/**
 * Progress steps in an Eddy reply (docs/EDDY-SPEC.md 6.8, 12.1a decision 0): the guided setup (connect, first template,
 * first broadcast) and multi-step tasks show where the member is. An ordered list; the current step carries
 * aria-current="step", and each step's state is said in words (sr-only), never by colour or icon alone.
 */
import { cn } from "@/components/ui";
import { htmlLang, t, type EddyLang } from "@/lib/eddy/i18n";

export type StepState = "done" | "current" | "todo" | "failed";
export type ProgressStep = { id: string; label: string; state: StepState; detail?: string };

const MARK: Record<StepState, string> = {
  done: "border-good-line bg-good-soft text-good-fg",
  current: "border-accent bg-accent-soft text-accent-ink",
  todo: "border-border bg-surface text-muted",
  failed: "border-bad-line bg-bad-soft text-bad-fg",
};

function StepIcon({ state, index }: { state: StepState; index: number }) {
  if (state === "done") {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true" focusable="false">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true" focusable="false">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <span aria-hidden className="text-xs font-semibold tabular-nums">
      {index + 1}
    </span>
  );
}

export function ProgressSteps({ steps, lang, label, className }: { steps: readonly ProgressStep[]; lang: EddyLang; label?: string; className?: string }) {
  if (steps.length === 0) return null;
  return (
    <ol aria-label={label ?? t(lang, "a11y.steps")} lang={htmlLang(lang)} className={cn("flex flex-col gap-2", className)} data-eddy-steps>
      {steps.map((step, i) => (
        <li key={step.id} className="flex items-start gap-2.5" aria-current={step.state === "current" ? "step" : undefined} data-step-state={step.state}>
          <span className={cn("mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", MARK[step.state])}>
            <StepIcon state={step.state} index={i} />
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn("block", lang === "hi" ? "text-base leading-[1.6]" : "text-sm", step.state === "current" ? "font-semibold text-foreground" : step.state === "todo" ? "text-muted" : "text-foreground")}>
              {step.label}
              <span className="sr-only">
                {", "}
                {t(lang, `step.${step.state}`)}
              </span>
            </span>
            {step.detail && <span className="mt-0.5 block text-xs text-muted">{step.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

"use client";

import { ProgressBar, cn } from "@/components/ui";
import { WIZARD_STEPS, progressPercent, stepState, type StepId } from "./wizard";

/**
 * Progress through the brief wizard. On phones it shows one line ("Step 3 of 5: Angles") and a bar; from 640 px it
 * lists every step. Pass onSelect to let people go back to a finished step; steps in `locked` are shown but disabled.
 */
export function Stepper({ current, onSelect, locked = [], fixed = [] }: { current: number; onSelect?: (id: StepId) => void; locked?: StepId[]; fixed?: StepId[] }) {
  const total = WIZARD_STEPS.length;
  const now = WIZARD_STEPS[current];
  return (
    <nav aria-label="Brief progress" className="mb-6">
      <p className="mb-2 text-sm font-medium sm:hidden">
        Step {current + 1} of {total}: {now.label}
      </p>
      <ProgressBar className="sm:hidden" label={`Step ${current + 1} of ${total}`} value={progressPercent(current)} valueText={`Step ${current + 1} of ${total}: ${now.label}`} size="sm" />
      <ol className="hidden items-center gap-2 sm:flex">
        {WIZARD_STEPS.map((step, i) => {
          const state = stepState(i, current);
          const isLocked = locked.includes(step.id) || fixed.includes(step.id);
          const clickable = !!onSelect && !isLocked && state !== "current";
          const inner = (
            <>
              <span
                aria-hidden
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  state === "done" && "border-accent bg-accent text-on-accent",
                  state === "current" && "border-accent bg-accent-soft text-accent-ink",
                  state === "upcoming" && "border-border-strong bg-raised text-muted",
                )}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className={cn("text-sm", state === "current" ? "font-semibold" : "font-medium text-muted")}>
                {step.label}
                <span className="sr-only">{state === "done" ? " (done)" : state === "current" ? " (current step)" : isLocked ? " (not available yet)" : ""}</span>
              </span>
            </>
          );
          return (
            <li key={step.id} className="flex flex-1 items-center gap-2 last:flex-none">
              {clickable ? (
                <button type="button" onClick={() => onSelect(step.id)} className="flex min-h-10 items-center gap-2 rounded-full pr-2 hover:bg-surface-2">
                  {inner}
                </button>
              ) : (
                <span aria-current={state === "current" ? "step" : undefined} aria-disabled={isLocked || undefined} className={cn("flex min-h-10 items-center gap-2 pr-2", isLocked && state === "upcoming" && "opacity-70")}>
                  {inner}
                </span>
              )}
              {i < total - 1 && <span aria-hidden className={cn("h-px flex-1", state === "done" ? "bg-accent" : "bg-border-strong")} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

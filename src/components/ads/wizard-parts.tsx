import type { ReactNode } from "react";
import { Alert, ProgressBar, cn } from "@/components/ui";
import { CATEGORY_RULES, budgetRoom, capUsagePercent, categoryName, formatMinor } from "./helpers";

export const checkboxClass = "mt-0.5 size-4 shrink-0 accent-accent";
export const optionRowClass = "flex min-h-10 cursor-pointer items-start gap-2.5 rounded-control px-2 py-2 text-sm hover:bg-surface-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-ring";

/** The second acknowledgement Meta needs when the wording sounds like housing, jobs or credit but no special category was chosen. */
export function TermsAckBox({ checked, onChange, className }: { checked: boolean; onChange: (v: boolean) => void; className?: string }) {
  return (
    <label className={cn(optionRowClass, className)}>
      <input type="checkbox" className={checkboxClass} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>I have read Meta&apos;s rules and my ad is not about housing, jobs, credit or social issues.</span>
    </label>
  );
}

/** Where the person is in the wizard. Labels collapse to the current one on phones; the position is always readable as text. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <nav aria-label="Campaign steps" className="mb-6">
      <p className="mb-2 text-sm font-medium" aria-live="polite">
        Step {current} of {steps.length}: <span className="text-foreground">{steps[current - 1]}</span>
      </p>
      <ol className="flex gap-1.5 sm:gap-3">
        {steps.map((label, i) => {
          const n = i + 1;
          const done = n < current;
          const here = n === current;
          return (
            <li key={label} aria-current={here ? "step" : undefined} className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className={cn("h-1.5 rounded-full", done || here ? "bg-accent" : "bg-surface-2")} aria-hidden />
              <span className={cn("hidden truncate text-xs sm:block", here ? "font-semibold" : "text-muted")}>
                <span className="sr-only">{done ? "Done: " : here ? "Current: " : "Next: "}</span>
                {n}. {label}
              </span>
              <span className="sr-only sm:hidden">
                {done ? "Done: " : here ? "Current: " : "Next: "}
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Money summary that stays visible while choosing a budget: this campaign against the workspace daily limit and what other active campaigns already use. */
export function BudgetSummary({ budgetMinor, capMinor, currency, usedMinor = null }: { budgetMinor: number | null; capMinor: number | null; currency: string; usedMinor?: number | null }) {
  const usage = capUsagePercent(budgetMinor, capMinor);
  const room = budgetRoom(budgetMinor, capMinor, usedMinor);
  return (
    <section aria-label="Daily budget summary" className="rounded-card border border-border bg-surface p-4">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs font-medium text-muted">This campaign, per day</dt>
          <dd className="text-xl font-semibold tabular-nums [overflow-wrap:anywhere]" data-testid="wizard-budget">
            {budgetMinor === null ? "Not set" : formatMinor(budgetMinor, currency)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-medium text-muted">Your daily limit, all campaigns</dt>
          <dd className="text-xl font-semibold tabular-nums [overflow-wrap:anywhere]" data-testid="wizard-cap">
            {capMinor === null ? "Not set" : formatMinor(capMinor, currency)}
          </dd>
        </div>
        {room && usedMinor !== null && (
          <>
            <div className="min-w-0">
              <dt className="text-xs font-medium text-muted">Already used by active campaigns</dt>
              <dd className="text-lg font-semibold tabular-nums [overflow-wrap:anywhere]" data-testid="wizard-used">
                {formatMinor(usedMinor, currency)}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium text-muted">Left for this campaign</dt>
              <dd className="text-lg font-semibold tabular-nums [overflow-wrap:anywhere]" data-testid="wizard-left">
                {formatMinor(room.leftMinor, currency)}
              </dd>
            </div>
          </>
        )}
      </dl>
      {usage !== null && (
        <ProgressBar
          className="mt-3"
          label="Share of your daily limit this campaign would use"
          showLabel
          showValue
          value={usage}
          valueText={`${usage}% of your limit`}
          tone={usage >= 100 ? "bad" : usage >= 80 ? "warn" : "good"}
        />
      )}
      {capMinor !== null && usedMinor === null && <p className="mt-3 text-xs text-muted">Other active campaigns also count toward this limit.</p>}
    </section>
  );
}

/** What Meta's special ad categories mean, and what changes when one applies. */
export function CategoryGuidance({ category, suggested }: { category: string; suggested: string }) {
  const restricted = category !== "" && category !== "none";
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Meta asks you to say if your ad is about housing, jobs, credit, or social issues and politics. This keeps ads fair for everyone. If you are not sure, pick the one that fits. It is the safer choice.
      </p>
      {suggested !== "none" && (
        <Alert tone="warn" title={`Your business profile points to ${categoryName(suggested).toLowerCase()}`}>
          Meta requires you to declare it if your ad is about this.
        </Alert>
      )}
      {restricted && (
        <Alert tone="info" title={`${categoryName(category)} ads have extra rules`}>
          {CATEGORY_RULES}
        </Alert>
      )}
    </div>
  );
}

export function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm font-medium">{children}</dd>
    </div>
  );
}

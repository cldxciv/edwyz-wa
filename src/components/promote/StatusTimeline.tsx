"use client";

/**
 * StatusTimeline (docs/IG-PAGE-ADS-SPEC.md 3.9, 7.3; PRM-15b): where a campaign stands, from GET
 * /api/ads/campaigns/[id]/review-status through results-helpers.statusTimeline.
 *
 * - Three steps: "Getting ready", "Meta is reviewing", "Running", each with an icon and a "Done:", "Now:" or "Next:" word for
 *   screen readers (aria-current="step" on the one it is at).
 * - Then the one state it is in: "Not approved: {reason}" with [Fix the ad] and [Ask Meta to review again] (Opens Meta
 *   appeal_ad), the per-placement and special-category lines, "Approved with issues", "Paused by you", "Paused: your limit for
 *   today is used up", "Paused: this month's ads limit is used up", "Paused by a safety stop: {reason}", "Paused: all spending
 *   is stopped", "Paused: spending was stopped", a plain "Paused" until the spend summary says why, "Finished on Sun 1 Nov".
 * - More lines: "₹X is set aside for this ad while it's not approved." with [Pause and free ₹X] when pausing the campaign
 *   frees exactly that (several rejected ad sets add up into one line), "Meta isn't showing this on {position} any more", and
 *   a restricted account with Opens Meta account_quality.
 * Every line has an icon and its words, never colour alone. The region is polite, so a change after a sync is announced.
 * Opens Meta addresses come from the server (meta-screens.ts); without one the button renders nothing.
 */
import { useId } from "react";
import { Button, cn, type Tone } from "@/components/ui";
import { OpensMetaButton } from "./OpensMetaButton";
import { TIMELINE_TEXT, type TimelineButton, type TimelineLine, type TimelineView } from "./results-helpers";

export const STATUS_TIMELINE_TEST_ID = "status-timeline";

export type StatusTimelineProps = {
  view: TimelineView;
  /** [Fix the ad] and [Pause and free ₹X]. Opens Meta buttons are links and need no handler. */
  onAction?: (button: Exclude<TimelineButton, { kind: "opens_meta" }>) => void;
  /** Opens Meta addresses resolved on the server from the allowlist (appeal_ad, account_quality). */
  metaLinks?: Partial<Record<"appeal_ad" | "account_quality", string | null>>;
  /** The button whose request is running (`fix_ad` or `free-{adSetId}`). */
  busy?: string | null;
  className?: string;
};

const toneBox: Record<Tone, string> = {
  neutral: "border-border bg-surface text-foreground",
  good: "border-good-line bg-good-soft text-good-fg",
  warn: "border-warn-line bg-warn-soft text-warn-fg",
  bad: "border-bad-line bg-bad-soft text-bad-fg",
  info: "border-info-line bg-info-soft text-info-fg",
};

function ToneIcon({ tone }: { tone: Tone }) {
  if (tone === "good") {
    return (
      <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="m5 8.2 2 2 4-4.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (tone === "bad" || tone === "warn") {
    return (
      <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" focusable="false">
        <path d="M8 1.8 15 14H1L8 1.8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M8 6.2v3.6M8 11.6v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 7.2v4M8 4.8v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function StepIcon({ status }: { status: "done" | "current" | "todo" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
        status === "done" ? "border-good-line bg-good-soft text-good-fg" : status === "current" ? "border-accent bg-accent text-on-accent" : "border-border bg-surface text-muted",
      )}
    >
      {status === "done" ? "✓" : status === "current" ? "●" : "○"}
    </span>
  );
}

function LineBox({ line, onAction, metaLinks, busy, testId }: { line: TimelineLine; onAction?: StatusTimelineProps["onAction"]; metaLinks?: StatusTimelineProps["metaLinks"]; busy?: string | null; testId: string }) {
  return (
    <div className={cn("rounded-card border p-3", toneBox[line.tone])} data-testid={testId} data-state={line.key}>
      <div className="flex items-start gap-2">
        <ToneIcon tone={line.tone} />
        <p className="min-w-0 flex-1 text-sm font-medium break-words">{line.line}</p>
      </div>
      {line.buttons.length > 0 && (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          {line.buttons.map((b, i) => {
            if (b.kind === "opens_meta") {
              return <OpensMetaButton key={`${b.kind}-${i}`} href={metaLinks?.[b.screen] ?? null} screen={b.screen} label={b.label} data-testid={`timeline-opens-meta-${b.screen}`} />;
            }
            const id = b.kind === "fix_ad" ? "fix_ad" : `free-${b.adSetId ?? "campaign"}`;
            return (
              <Button
                key={`${b.kind}-${i}`}
                size="md"
                variant={b.kind === "fix_ad" ? "primary" : "secondary"}
                className="max-w-full whitespace-normal text-left"
                loading={busy === id}
                disabled={!onAction || (busy !== null && busy !== undefined)}
                onClick={() => onAction?.(b)}
                data-testid={b.kind === "fix_ad" ? "timeline-fix-ad" : "timeline-pause-free"}
              >
                {b.label}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function StatusTimeline({ view, onAction, metaLinks, busy, className }: StatusTimelineProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0 space-y-3", className)} data-testid={STATUS_TIMELINE_TEST_ID} data-state={view.state}>
      <h2 id={headingId} className="text-base font-semibold tracking-tight">
        {TIMELINE_TEXT.heading}
      </h2>
      <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-4">
        {view.steps.map((s) => (
          <li key={s.key} className="flex min-w-0 items-center gap-2 text-sm" aria-current={s.status === "current" ? "step" : undefined} data-testid={`timeline-step-${s.key}`} data-status={s.status}>
            <StepIcon status={s.status} />
            <span className={cn("min-w-0 break-words", s.status === "todo" ? "text-muted" : "font-medium")}>
              <span className="sr-only">{s.status === "done" ? TIMELINE_TEXT.done : s.status === "current" ? TIMELINE_TEXT.now : TIMELINE_TEXT.next}</span>
              {s.label}
            </span>
          </li>
        ))}
      </ol>
      <div aria-live="polite" className="space-y-2" data-testid="timeline-lines">
        {view.outcome && <LineBox line={view.outcome} onAction={onAction} metaLinks={metaLinks} busy={busy} testId="timeline-outcome" />}
        {view.lines.map((l) => (
          <LineBox key={l.key} line={l} onAction={onAction} metaLinks={metaLinks} busy={busy} testId={`timeline-line-${l.key}`} />
        ))}
      </div>
    </section>
  );
}

export default StatusTimeline;

"use client";

/**
 * FixChips (docs/IG-PAGE-ADS-SPEC.md 3.3, 6.2, 7.3): one-tap refusal fixes, only those that fit. Each applies its exact fix
 * and the review runs again:
 * - [Lower to ₹280 a day] and [Raise to ₹X] set the daily budget; [Run 3 days instead] sets the days (never below 2);
 * - [Try again] runs the review again; [Try again at 3:40 pm] waits until then (Meta's limit or its budget-change quota);
 * - [Spending limits] opens the owner's limits; an admin's [Ask {owner} to raise the limit] says what to ask for.
 * Labels come from the server, in Phase 0's and promote/copy's words.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { buttonVariants, cn } from "@/components/ui";
import type { PromoteLang } from "@/lib/promote/types";
import { fixAction, fixWaiting, PROMOTE_TEST_IDS, waitText, type FixAction, type FixDto } from "./flow-helpers";
import { usePromoteCopy } from "./usePromoteCopy";

export type FixChipsProps = {
  fixes: readonly FixDto[];
  /** Runs a fix: a draft change then a review, or a review alone. */
  onApply: (action: Extract<FixAction, { kind: "set" | "retry" }>, fix: FixDto) => void;
  isOwner: boolean;
  owner: string | null;
  tz: string;
  busy?: boolean;
  lang?: PromoteLang;
  className?: string;
};

const chipClass = cn(
  "inline-flex min-h-11 max-w-full items-center justify-center rounded-full px-4 py-2 text-left text-sm font-semibold transition-colors duration-(--dur-fast) disabled:cursor-not-allowed disabled:opacity-50",
  buttonVariants.secondary,
);

export function FixChips({ fixes, onApply, isOwner, owner, tz, busy = false, lang = "en", className }: FixChipsProps) {
  const t = usePromoteCopy(lang);
  const [now, setNow] = useState(() => Date.now());
  const [note, setNote] = useState<string | null>(null);
  const actions = fixes.map((f) => ({ fix: f, action: fixAction(f, { isOwner, owner, lang }) }));
  const waits = actions.filter((a) => a.action.kind === "wait").map((a) => (a.action as Extract<FixAction, { kind: "wait" }>).until.getTime());
  const nextWait = waits.filter((w) => w > now).sort((a, b) => a - b)[0];

  // A waiting chip turns on by itself at its time.
  useEffect(() => {
    if (nextWait === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextWait - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [nextWait]);

  if (!fixes.length) return null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div role="group" aria-label={t("review.fixes")} className="flex flex-wrap gap-2" data-testid={PROMOTE_TEST_IDS.fixChips}>
        {actions.map(({ fix, action }, i) => {
          const key = `${fix.kind}-${i}`;
          const common = { "data-testid": PROMOTE_TEST_IDS.fixChip, "data-fix-kind": fix.kind } as const;
          if (action.kind === "link") {
            return (
              <Link key={key} href={action.href} className={chipClass} {...common}>
                {fix.label}
              </Link>
            );
          }
          if (action.kind === "note") {
            return (
              <button key={key} type="button" className={chipClass} onClick={() => setNote(action.text)} {...common}>
                {fix.label}
              </button>
            );
          }
          const waiting = fixWaiting(action, now);
          return (
            <button
              key={key}
              type="button"
              className={chipClass}
              disabled={busy || waiting}
              aria-describedby={waiting ? `${key}-wait` : undefined}
              onClick={() => onApply(action.kind === "set" ? action : { kind: "retry" }, fix)}
              {...common}
            >
              {fix.label}
              {waiting && action.kind === "wait" && (
                <span id={`${key}-wait`} className="sr-only">
                  {waitText(action.until, tz, lang)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p role="status" aria-live="polite" className="text-sm text-muted">
        {note}
      </p>
    </div>
  );
}

export default FixChips;

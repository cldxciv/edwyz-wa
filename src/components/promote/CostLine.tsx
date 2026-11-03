"use client";

/**
 * CostLine (docs/IG-PAGE-ADS-SPEC.md 3.3, 3.7, 6.2, 7.3): presentCost's lines for the steppers' values.
 *
 *   "About ₹1,500 in total. At most ₹2,625, because Meta can spend up to 75% more on a busy day."
 *   "Up to ₹2,100 in October and ₹525 in November."
 *
 * The first values show at once; later changes settle 600 ms after the last one (creative-helpers createDebouncer), then
 * the region updates and is announced politely. While a change is settling the region is aria-busy. With versions the
 * daily total is split fairly and the cost uses the sum of the shares (3.8). `onView` hands the settled figures to the
 * LimitChip and the review card, so the page never computes them twice.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui";
import type { CostView } from "@/lib/promote/types";
import { COST_DEBOUNCE_MS, computeCost, costKey, costLineText, createDebouncer, type CostParams } from "./creative-helpers";

export const COST_LINE_TEST_ID = "cost-line";

export type CostLineProps = CostParams & {
  /** The settled figures (null while the values can't make a run). */
  onView?: (view: CostView | null) => void;
  /** Also say when next month's part is set aside (the review card shows it as a warning). */
  showMonthCross?: boolean;
  debounceMs?: number;
  className?: string;
};

type Shown = { key: string; params: CostParams };

export function CostLine({ onView, showMonthCross = false, debounceMs = COST_DEBOUNCE_MS, className, ...params }: CostLineProps) {
  const key = costKey(params);
  const [shown, setShown] = useState<Shown>(() => ({ key, params }));
  const [debouncer] = useState(() => createDebouncer<Shown>(debounceMs, setShown));
  const latest = useRef<Shown>({ key, params });

  useEffect(() => {
    latest.current = { key, params };
  });
  useEffect(() => () => debouncer.cancel(), [debouncer]);
  useEffect(() => {
    if (key === shown.key) debouncer.cancel();
    else debouncer.push(latest.current);
  }, [key, shown.key, debouncer]);

  const view = useMemo(() => computeCost(shown.params), [shown]);
  useEffect(() => {
    onView?.(view);
  }, [view, onView]);

  const text = view ? costLineText(view) : null;
  return (
    <div data-testid={COST_LINE_TEST_ID} aria-live="polite" aria-atomic="true" aria-busy={key !== shown.key || undefined} className={cn("flex min-w-0 flex-col gap-1", className)}>
      {text && (
        <>
          <p data-testid="cost-line-total" className="text-sm font-medium break-words">
            <span>{view?.lines.about}</span> <span data-testid="cost-line-at-most">{view?.lines.atMost}</span>
          </p>
          <p data-testid="cost-line-months" className="text-xs text-muted break-words">
            {text.byMonth}
          </p>
          {text.setAside && (
            <p data-testid="cost-line-set-aside" className="text-xs text-muted break-words">
              {text.setAside}
            </p>
          )}
          {showMonthCross && text.monthCross && (
            <p data-testid="cost-line-month-cross" className="text-xs text-muted break-words">
              {text.monthCross}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default CostLine;

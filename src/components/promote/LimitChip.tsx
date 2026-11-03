"use client";

/**
 * LimitChip (docs/IG-PAGE-ADS-SPEC.md 3.3, 3.7, 7.3): what is left of the limits after this run, from Phase 0's headroom
 * through presentCost: "₹1,475 left today · ₹17,900 left this month". Renders nothing without a daily limit (the readiness
 * row asks for one). The amount is the text, so colour is never the only signal. It wraps on narrow phones instead of
 * overflowing (large amounts at 360 px).
 */
import { cn } from "@/components/ui";
import type { PromoteLang } from "@/lib/promote/types";
import { limitChipText, limitChipTone, type LimitLeft } from "./creative-helpers";

export const LIMIT_CHIP_TEST_ID = "limit-chip";

export type LimitChipProps = LimitLeft & { lang?: PromoteLang; className?: string };

export function LimitChip({ leftTodayMinor, leftMonthMinor, currency, lang = "en", className }: LimitChipProps) {
  const left = { leftTodayMinor, leftMonthMinor, currency };
  const text = limitChipText(left, lang);
  if (!text) return null;
  const warn = limitChipTone(left) === "warn";
  return (
    <p
      data-testid={LIMIT_CHIP_TEST_ID}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium tabular-nums break-words",
        warn ? "border-warn-line bg-warn-soft text-warn-fg" : "border-border bg-surface text-muted",
        className,
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}

export default LimitChip;

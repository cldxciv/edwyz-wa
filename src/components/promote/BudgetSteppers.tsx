"use client";

/**
 * BudgetSteppers (docs/IG-PAGE-ADS-SPEC.md 3.3 step 3, 3.7, 3.1a, 7.3, 7.6, D31): "₹ per day" and "Days".
 *
 * - ₹ per day moves in steps of ₹10, or the Phase 0 FX step in another currency (cost.ts budgetStep). The floor is Meta's
 *   minimum when known, else one step.
 * - Days run from 2 (D31) to 30, or to 90 when More options is open (D6). A longer run chosen under More stays as it is
 *   when More closes: the field always shows the real number (the one the cost uses), which can then only go down.
 * - A long press repeats, faster the longer it is held (creative-helpers createRepeater); a quick tap or a keyboard press
 *   steps once. The repeat stops at the floor or the cap, and when the button is disabled.
 * - Both values are also editable number fields, committed on blur or Enter and kept inside the limits.
 * - Buttons carry full-sentence labels: "Increase daily budget to ₹310", "Decrease days to 6"; at an end the button is
 *   disabled and says why ("The shortest run is 2 days").
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { buttonVariants, cn, Input } from "@/components/ui";
import { formatMoney, promoteText } from "@/lib/promote/copy";
import type { FromInr } from "@/lib/promote/cost";
import type { PromoteLang } from "@/lib/promote/types";
import { currencyExponent } from "@/lib/spend/money";
import {
  clampDaily,
  clampDays,
  createRepeater,
  currencySymbol,
  dailyButton,
  dailyFloor,
  daysButton,
  daysInputValue,
  daysLimit,
  DAYS_MIN,
  majorInputValue,
  parseMajorInput,
  repeatMultiplier,
  stepDaily,
  stepDays,
  stepperStep,
  type DailyBounds,
  type Repeater,
} from "./creative-helpers";

export const BUDGET_TEST_IDS = {
  root: "budget-steppers",
  daily: "budget-daily-stepper",
  dailyInput: "budget-daily-input",
  dailyDecrease: "budget-daily-decrease",
  dailyIncrease: "budget-daily-increase",
  days: "budget-days-stepper",
  daysInput: "budget-days-input",
  daysDecrease: "budget-days-decrease",
  daysIncrease: "budget-days-increase",
} as const;

export type BudgetSteppersProps = {
  /** The daily total, in minor units of the ad account's currency. */
  dailyMinor: bigint;
  onDailyChange: (minor: bigint) => void;
  days: number;
  onDaysChange: (days: number) => void;
  /** The spending ad account's currency (3.1a). */
  currency: string;
  /** Phase 0's convertFromInr with a fresh rate: the step in other currencies. */
  fromInr?: FromInr | null;
  /** Meta's minimum daily budget for this kind of ad (C5), when known. */
  minDailyMinor?: bigint | null;
  maxDailyMinor?: bigint | null;
  /** More options is open: Days go up to 90. */
  moreDays?: boolean;
  disabled?: boolean;
  lang?: PromoteLang;
  className?: string;
};

/**
 * Holds a button to repeat: the first repeat after LONG_PRESS_DELAY_MS, then faster (createRepeater). `onStep` says whether
 * the value changed; a repeat that changes nothing stops the timer.
 */
function useRepeat(onStep: (repeats: number) => boolean): Repeater {
  const callback = useRef(onStep);
  useEffect(() => {
    callback.current = onStep;
  });
  const [repeater] = useState(() => createRepeater((repeats) => callback.current(repeats)));
  useEffect(() => () => repeater.stop(), [repeater]);
  return repeater;
}

const stepButtonClass = cn(
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg font-semibold select-none touch-manipulation transition-colors duration-(--dur-fast) disabled:cursor-not-allowed disabled:opacity-50",
  buttonVariants.secondary,
);

/** Steps once (`repeats` into a long press) and says whether the value changed. */
type StepFn = (repeats: number) => boolean;

type StepButtonProps = { label: string; disabled: boolean; onStep: StepFn; testId: string; children: ReactNode };

function StepButton({ label, disabled, onStep, testId, children }: StepButtonProps) {
  const repeat = useRepeat(onStep);
  // A disabled button may get no pointerup (some engines send no pointer events to disabled controls): stop here instead.
  useEffect(() => {
    if (disabled) repeat.stop();
  }, [disabled, repeat]);
  const end = () => repeat.stop();
  return (
    <button
      type="button"
      className={stepButtonClass}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
        if (e.button === 0 && !disabled) repeat.start();
      }}
      onPointerUp={end}
      onPointerLeave={end}
      onPointerCancel={end}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        // Enter and Space click with detail 0: they always step once.
        if (repeat.click(e.detail === 0)) onStep(0);
      }}
    >
      <span aria-hidden>{children}</span>
    </button>
  );
}

type FieldRowProps = {
  id: string;
  label: string;
  hint: string;
  error: string | null;
  value: string;
  inputMode: "numeric" | "decimal";
  disabled?: boolean;
  onText: (text: string) => void;
  onCommit: () => void;
  dec: { label: string; disabled: boolean; onStep: StepFn; testId: string };
  inc: { label: string; disabled: boolean; onStep: StepFn; testId: string };
  testId: string;
  inputTestId: string;
};

function FieldRow({ id, label, hint, error, value, inputMode, disabled, onText, onCommit, dec, inc, testId, inputTestId }: FieldRowProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <StepButton label={dec.label} disabled={!!disabled || dec.disabled} onStep={dec.onStep} testId={dec.testId}>
          −
        </StepButton>
        <Input
          id={id}
          type="text"
          inputMode={inputMode}
          autoComplete="off"
          value={value}
          disabled={disabled}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          aria-invalid={error ? true : undefined}
          data-testid={inputTestId}
          className="min-w-0 flex-1 text-center text-base tabular-nums"
          onChange={(e) => onText(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit();
            }
          }}
        />
        <StepButton label={inc.label} disabled={!!disabled || inc.disabled} onStep={inc.onStep} testId={inc.testId}>
          +
        </StepButton>
      </div>
      <p id={hintId} className="text-xs text-muted">
        {hint}
      </p>
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-bad-fg">
          {error}
        </p>
      )}
    </div>
  );
}

export function BudgetSteppers({
  dailyMinor,
  onDailyChange,
  days,
  onDaysChange,
  currency,
  fromInr,
  minDailyMinor,
  maxDailyMinor,
  moreDays = false,
  disabled,
  lang = "en",
  className,
}: BudgetSteppersProps) {
  const uid = useId();
  const step = useMemo(() => stepperStep(currency, fromInr), [currency, fromInr]);
  const bounds: DailyBounds = useMemo(() => ({ minMinor: minDailyMinor ?? null, maxMinor: maxDailyMinor ?? null }), [minDailyMinor, maxDailyMinor]);
  // A longer run chosen under More options stays as it is when More closes: shown as it is, it can go down but not up.
  const maxDays = daysLimit(days, moreDays);

  // The latest values, so a repeating press always steps from what is on screen now.
  const dailyRef = useRef(dailyMinor);
  const daysRef = useRef(days);
  useEffect(() => {
    dailyRef.current = dailyMinor;
    daysRef.current = days;
  }, [dailyMinor, days]);

  const [dailyText, setDailyText] = useState<string | null>(null);
  const [daysText, setDaysText] = useState<string | null>(null);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [daysError, setDaysError] = useState<string | null>(null);

  const setDaily = (next: bigint) => {
    dailyRef.current = next;
    onDailyChange(next);
  };
  const setDays = (next: number) => {
    daysRef.current = next;
    onDaysChange(next);
  };

  const dec = dailyButton(-1, dailyMinor, step, bounds, currency, lang);
  const inc = dailyButton(1, dailyMinor, step, bounds, currency, lang);
  const dDec = daysButton(-1, days, maxDays, lang);
  const dInc = daysButton(1, days, maxDays, lang);

  const stepDailyBy =
    (dir: 1 | -1): StepFn =>
    (repeats) => {
      setDailyText(null);
      setDailyError(null);
      const next = stepDaily(dailyRef.current, dir, step, bounds, repeatMultiplier(repeats));
      if (next === dailyRef.current) return false;
      setDaily(next);
      return true;
    };
  const stepDaysBy =
    (dir: 1 | -1): StepFn =>
    () => {
      setDaysText(null);
      setDaysError(null);
      const next = stepDays(daysRef.current, dir, maxDays);
      if (next === daysRef.current) return false;
      setDays(next);
      return true;
    };

  const commitDaily = () => {
    if (dailyText === null) return;
    const parsed = parseMajorInput(dailyText, currency);
    if (parsed === null) {
      setDailyError(promoteText("budget.type_amount", { example: majorInputValue(dailyMinor > 0n ? dailyMinor : step, currency) }, lang));
      return;
    }
    const next = clampDaily(parsed, step, bounds);
    // Below Meta's minimum: say so in Meta's words (4.10) after raising it to the minimum.
    setDailyError(parsed < next && bounds.minMinor ? promoteText("error.below_min", { amount: formatMoney(dailyFloor(step, bounds), currency) }, lang) : null);
    setDailyText(null);
    if (next !== dailyMinor) setDaily(next);
  };

  const commitDays = () => {
    if (daysText === null) return;
    const n = Number(daysText.trim());
    if (!daysText.trim() || !Number.isFinite(n)) {
      setDaysError(promoteText(moreDays ? "budget.days_hint_more" : "budget.days_hint_simple", {}, lang));
      return;
    }
    const next = clampDays(n, maxDays);
    setDaysError(n < DAYS_MIN ? promoteText("run.too_short", {}, lang) : null);
    setDaysText(null);
    if (next !== days) setDays(next);
  };

  return (
    <fieldset className={cn("grid min-w-0 gap-4 sm:grid-cols-2", className)} data-testid={BUDGET_TEST_IDS.root} disabled={disabled}>
      <legend className="sr-only">{promoteText("card.fact.budget", {}, lang)}</legend>
      <FieldRow
        id={`${uid}-daily`}
        label={promoteText("budget.per_day", { symbol: currencySymbol(currency) }, lang)}
        hint={promoteText("budget.daily_hint", { amount: formatMoney(step, currency) }, lang)}
        error={dailyError}
        value={dailyText ?? majorInputValue(dailyMinor, currency)}
        inputMode={currency.toUpperCase() !== "INR" && currencyExponent(currency) > 0 ? "decimal" : "numeric"}
        disabled={disabled}
        onText={setDailyText}
        onCommit={commitDaily}
        dec={{ label: dec.label, disabled: dec.disabled, onStep: stepDailyBy(-1), testId: BUDGET_TEST_IDS.dailyDecrease }}
        inc={{ label: inc.label, disabled: inc.disabled, onStep: stepDailyBy(1), testId: BUDGET_TEST_IDS.dailyIncrease }}
        testId={BUDGET_TEST_IDS.daily}
        inputTestId={BUDGET_TEST_IDS.dailyInput}
      />
      <FieldRow
        id={`${uid}-days`}
        label={promoteText("run.days_label", {}, lang)}
        hint={promoteText(moreDays ? "budget.days_hint_more" : "budget.days_hint_simple", {}, lang)}
        error={daysError}
        value={daysText ?? daysInputValue(days)}
        inputMode="numeric"
        disabled={disabled}
        onText={setDaysText}
        onCommit={commitDays}
        dec={{ label: dDec.label, disabled: dDec.disabled, onStep: stepDaysBy(-1), testId: BUDGET_TEST_IDS.daysDecrease }}
        inc={{ label: dInc.label, disabled: dInc.disabled, onStep: stepDaysBy(1), testId: BUDGET_TEST_IDS.daysIncrease }}
        testId={BUDGET_TEST_IDS.days}
        inputTestId={BUDGET_TEST_IDS.daysInput}
      />
    </fieldset>
  );
}

export default BudgetSteppers;

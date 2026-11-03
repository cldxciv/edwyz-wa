"use client";

/**
 * TypedConfirm (docs/IG-PAGE-ADS-SPEC.md D5, 6.1 rule 5, 7.3): a deliberate pause for large runs. Shown only when the card says
 * typedConfirmRequired (this month's worst case is at least 50% of what is left this month); the member types the amount on
 * the button ("₹2,625", "2625" or "2,625.00"). Start stays off until it matches, and the server checks the typed figure again.
 */
import { useId, useState } from "react";
import { cn, Input } from "@/components/ui";
import { formatMoney } from "@/lib/promote/copy";
import type { PromoteLang } from "@/lib/promote/types";
import { PROMOTE_TEST_IDS, typedOk } from "./flow-helpers";
import { usePromoteCopy } from "./usePromoteCopy";

export type TypedConfirmProps = {
  worstMinor: bigint;
  currency: string;
  value: string;
  onChange: (value: string) => void;
  lang?: PromoteLang;
  className?: string;
};

export function TypedConfirm({ worstMinor, currency, value, onChange, lang = "en", className }: TypedConfirmProps) {
  const t = usePromoteCopy(lang);
  const id = useId();
  const [touched, setTouched] = useState(false);
  const amount = formatMoney(worstMinor, currency);
  const wrong = touched && value.trim() !== "" && !typedOk(value, worstMinor, currency);
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 rounded-card border border-warn-line bg-warn-soft p-3", className)} data-testid={PROMOTE_TEST_IDS.typedConfirm}>
      <label htmlFor={id} className="text-sm font-medium text-warn-fg">
        {t("card.typed_confirm", { amount })}
      </label>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        aria-invalid={wrong ? true : undefined}
        aria-describedby={wrong ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTouched(true)}
      />
      {wrong && (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-bad-fg">
          {t("review.typed_wrong", { amount })}
        </p>
      )}
    </div>
  );
}

export default TypedConfirm;

"use client";

/**
 * Menu > My usage (docs/EDDY-SPEC.md 6.3, 5.10): "12 credits used today", with a meter against the member's daily Eddy cap,
 * and the workspace's AI credits this month (Eddy and the AI agent share that limit). Read from the status the panel already
 * has: no request, no model call. Tokens only; the meter turns amber and red near the cap (ProgressBar tone auto).
 */
import { useId } from "react";
import { Button, ProgressBar } from "@/components/ui";
import type { EddyLang, EddyStatusDTO } from "@/lib/eddy/contract";
import { tn } from "@/lib/eddy/copy/notices";
import { tp } from "@/lib/eddy/copy/panel";
import { htmlLang, t } from "@/lib/eddy/i18n";

const fmt = (n: number) => n.toLocaleString("en-IN");

export type UsageFigures = { today: string; meterLabel: string; meterValue: string; used: number; limit: number; month: string; note: string };

/** The usage lines and meter figures, or null before the status has loaded. */
export function usageFigures(lang: EddyLang, status: EddyStatusDTO | null): UsageFigures | null {
  if (!status) return null;
  const a = status.allowance;
  const used = Math.max(0, a.memberUsedToday);
  const limit = Math.max(0, a.memberLimitToday);
  return {
    today: tn(lang, "notices.usage.today", { used: fmt(used) }),
    meterLabel: tn(lang, "notices.usage.label"),
    meterValue: tn(lang, "notices.usage.of", { used: fmt(used), limit: fmt(limit) }),
    used,
    limit,
    month: a.limitMonth === null ? tp(lang, "panel.usage.month_open", { used: fmt(a.usedMonth) }) : tp(lang, "panel.usage.month", { used: fmt(a.usedMonth), limit: fmt(a.limitMonth) }),
    note: tp(lang, "panel.usage.note"),
  };
}

export function UsageMeter({ lang, status, onClose }: { lang: EddyLang; status: EddyStatusDTO | null; onClose?: () => void }) {
  const headingId = useId();
  const f = usageFigures(lang, status);
  return (
    <section aria-labelledby={headingId} lang={htmlLang(lang)} className="flex min-w-0 flex-col gap-3 p-2 text-sm" data-eddy-usage>
      <h3 id={headingId} className="font-semibold">
        {tp(lang, "panel.menu.usage")}
      </h3>
      {f ? (
        <>
          <p className="text-base font-semibold tabular-nums">{f.today}</p>
          {f.limit > 0 && <ProgressBar value={Math.min(f.used, f.limit)} max={f.limit} label={f.meterLabel} valueText={f.meterValue} showLabel showValue tone="auto" warnAt={80} dangerAt={95} size="sm" />}
          <p className="text-muted">{f.month}</p>
          <p className="text-xs text-muted">{f.note}</p>
        </>
      ) : (
        <p className="text-muted">{tp(lang, "panel.loading")}</p>
      )}
      {onClose && (
        <Button type="button" variant="ghost" size="sm" className="self-start pointer-coarse:min-h-11" onClick={onClose}>
          {t(lang, "btn.close")}
        </Button>
      )}
    </section>
  );
}

import Link from "next/link";
import { cn } from "@/components/ui";
import type { Kpi } from "@/lib/setup/dashboard-logic";
import { deltaLabel, describeSeries, formatCount, formatReplyTime } from "./helpers";
import { Sparkline } from "./Sparkline";

const TONE = { good: "text-emerald-800", bad: "text-red-700", neutral: "text-muted" } as const;

function valueText(kpi: Kpi): string {
  if (kpi.value === null) return "No data yet";
  return kpi.unit === "seconds" ? formatReplyTime(kpi.value) : formatCount(kpi.value);
}

/** One headline number with its trend. The whole tile is a link to the page that explains it. */
export function KpiTile({ kpi }: { kpi: Kpi }) {
  const delta = deltaLabel(kpi);
  const format = kpi.unit === "seconds" ? (n: number) => formatReplyTime(n) : formatCount;
  return (
    <Link href={kpi.href} className="flex min-h-36 flex-col rounded-2xl border border-border p-4 hover:bg-surface">
      <span className="text-sm text-muted">{kpi.label}</span>
      {kpi.unavailable ? (
        <span className="mt-2 text-sm text-muted">Not available right now. Reload to try again.</span>
      ) : (
        <>
          <span className={cn("mt-1 font-semibold tracking-tight", kpi.value === null ? "text-lg text-muted" : "text-3xl")}>{valueText(kpi)}</span>
          {delta && <span className={cn("mt-0.5 text-xs font-medium", TONE[delta.tone])}>{delta.text}</span>}
          <span className="mt-auto pt-3">{kpi.series && <Sparkline values={kpi.series} label={describeSeries(kpi.label, kpi.series, format)} />}</span>
          {kpi.note && <span className="mt-1 text-xs text-muted">{kpi.note}</span>}
        </>
      )}
    </Link>
  );
}

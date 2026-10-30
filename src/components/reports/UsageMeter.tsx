"use client";

import { Badge, Button, Card, ErrorState, ProgressBar, Skeleton } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import type { Usage, UsageLine } from "@/lib/reports/usage";
import { usageNote, usagePercent, usageSummary } from "./helpers";

function Line({ label, line }: { label: string; line: UsageLine }) {
  const pct = usagePercent(line.used, line.limit);
  const note = usageNote(pct);
  return (
    <li>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="flex items-center gap-2 tabular-nums text-muted">
          {note && <Badge tone={pct !== null && pct >= 90 ? "bad" : "warn"}>{note}</Badge>}
          {usageSummary(line.used, line.limit)}
        </span>
      </div>
      {pct !== null ? <ProgressBar label={`${label}: ${pct}% of your plan limit used`} value={pct} tone="auto" valueText={`${pct}%`} /> : <p className="text-xs text-muted">Your plan has no limit on this.</p>}
    </li>
  );
}

/** Contacts, seats and broadcast recipients this month against plan limits. Mount on the dashboard and billing page. */
export function UsageMeter() {
  const { data, error, loading, reload } = useApi<Usage>("/api/reports/usage");
  return (
    <Card title="Plan usage" description={data?.plan ? `What you have used on the ${data.plan.name} plan.` : "What you are using this month."} aria-busy={loading || undefined}>
      {loading ? (
        <div className="space-y-4" role="status">
          <span className="sr-only">Loading usage</span>
          {[0, 1, 2].map((i) => (
            <div key={i} aria-hidden>
              <Skeleton className="mb-2 h-4 w-1/3" />
              <Skeleton className="h-2.5 w-full" />
            </div>
          ))}
        </div>
      ) : error || !data ? (
        <ErrorState title="We could not load your usage" message="Check your connection and try again." action={<Button variant="secondary" size="sm" onClick={reload}>Try again</Button>} />
      ) : (
        <>
          <ul className="space-y-4">
            <Line label="Contacts" line={data.contacts} />
            <Line label="Team seats" line={data.seats} />
            <Line label="Broadcast messages this month" line={data.broadcastRecipients} />
          </ul>
          {!data.plan && <p className="mt-4 text-xs text-muted">You do not have a paid plan yet, so no limits are shown.</p>}
        </>
      )}
    </Card>
  );
}

"use client";

import Link from "next/link";
import { Badge, Button, Card, ErrorState, ProgressBar, Skeleton } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import type { Usage, UsageLine } from "@/lib/reports/usage";
import { usageNote, usagePercent, usageSummary } from "./helpers";

type Source = Usage["limitsFrom"];

const daysLeft = (billing: Usage["billing"] | undefined) => (billing?.state === "trialing" && billing.trialDaysLeft ? billing.trialDaysLeft : null);
const daysText = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;

/**
 * The note under the meter when no plan is chosen. It says so, with the trial days left, instead of "no limit", which read as
 * unlimited. A workspace that needs no plan (exempt) is told that instead.
 */
export function noPlanNote(billing: Usage["billing"] | undefined): string {
  if (billing?.state === "exempt") return "Your workspace does not need a plan, so these are not limited.";
  const days = daysLeft(billing);
  const trial = days ? `You are on the free trial, with ${daysText(days)} left. ` : "";
  return `${trial}You have not chosen a plan yet, so no plan limits apply.`;
}

/** The note under the meter while the free trial's own limits apply (the same limits a send is refused on). */
export function trialLimitsNote(billing: Usage["billing"] | undefined): string {
  const days = daysLeft(billing);
  return `${days ? `You are on the free trial, with ${daysText(days)} left. ` : "You are on the free trial. "}These are the trial's limits. Choose a plan to keep sending after the trial.`;
}

/** Where the limits come from. Older responses had no limitsFrom; then a named plan means plan limits. */
export const limitSource = (data: Pick<Usage, "plan"> & { limitsFrom?: Source }): Source => data.limitsFrom ?? (data.plan ? "plan" : null);

/** The words under a line that has no bar: why nothing limits it. */
export function noLimitText(source: Source): string {
  if (source === "trial") return "The free trial has no limit on this.";
  return source === "plan" ? "Your plan has no limit on this." : "No plan limit applies yet.";
}

function Line({ label, line, source, hint }: { label: string; line: UsageLine; source: Source; hint?: string }) {
  const pct = usagePercent(line.used, line.limit);
  const note = usageNote(pct);
  const limited = source === "trial" ? "free trial limit" : "plan limit";
  return (
    <li>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="flex items-center gap-2 tabular-nums text-muted">
          {note && <Badge tone={pct !== null && pct >= 90 ? "bad" : "warn"}>{note}</Badge>}
          {source === null ? `${line.used.toLocaleString()} used` : usageSummary(line.used, line.limit)}
        </span>
      </div>
      {pct !== null ? <ProgressBar label={`${label}: ${pct}% of your ${limited} used`} value={pct} tone="auto" valueText={`${pct}%`} /> : <p className="text-xs text-muted">{noLimitText(source)}</p>}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </li>
  );
}

function description(data: Usage | null | undefined): string {
  if (data?.plan && limitSource(data) === "plan") return `What you have used on the ${data.plan.name} plan.`;
  if (data && limitSource(data) === "trial") return "What you have used during your free trial.";
  return "What you are using this month.";
}

/**
 * Contacts, seats and broadcast messages this month against the limits that apply: the plan's, or the free trial's while it runs.
 * The counts are the ones enforcement uses, so open invites hold a seat. Mount on the dashboard and billing page.
 */
export function UsageMeter() {
  const { data, error, loading, reload } = useApi<Usage>("/api/reports/usage");
  const source = data ? limitSource(data) : null;
  return (
    <Card title="Plan usage" description={description(data)} aria-busy={loading || undefined}>
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
            <Line label="Contacts" line={data.contacts} source={source} />
            <Line label="Team seats" line={data.seats} source={source} hint="Open invites count as seats until they are accepted or expire." />
            <Line label="Broadcast messages this month" line={data.broadcastRecipients} source={source} hint="Messages sent this month, plus those still waiting in a broadcast that is sending, paused or scheduled." />
          </ul>
          {source !== "plan" && (
            <p className="mt-4 text-xs text-muted">
              {source === "trial" ? trialLimitsNote(data.billing) : noPlanNote(data.billing)}
              {data.billing?.state !== "exempt" && (
                <>
                  {" "}
                  {/* Billing, not "Choose a plan": until plans are published there is nothing to choose there yet. */}
                  <Link href="/app/billing" className="font-medium text-accent underline underline-offset-2">See billing</Link>
                </>
              )}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

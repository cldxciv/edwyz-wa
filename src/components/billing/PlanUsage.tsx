"use client";

import { Badge, Button, Card, ErrorState, ProgressBar, Skeleton } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { meterNote, meterSummary, meterTitle, type MeterLine } from "./helpers";

type Usage = { lines: MeterLine[]; alerts: MeterLine[]; plan?: { state: string; planName: string | null } };

function Line({ line, unplanned }: { line: MeterLine; unplanned: boolean }) {
  const note = meterNote(line.percent);
  const title = meterTitle(line);
  return (
    <li>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-medium">{title}</span>
        <span className="flex items-center gap-2 tabular-nums text-muted">
          {note && <Badge tone={line.percent !== null && line.percent >= 100 ? "bad" : "warn"}>{note}</Badge>}
          {meterSummary(line)}
        </span>
      </div>
      {line.percent !== null ? (
        <ProgressBar label={`${title}: ${line.percent}% of your plan limit used`} value={line.percent} tone="auto" warnAt={80} dangerAt={100} valueText={`${line.percent}%`} />
      ) : (
        <p className="text-xs text-muted">{unplanned ? "No plan limit applies yet." : "Your plan has no limit on this."}</p>
      )}
      {line.monthly && line.percent !== null && <p className="mt-1 text-xs text-muted">Restarts on the 1st of each month.</p>}
    </li>
  );
}

export const NO_PLAN_TEXT = "You do not have a paid plan yet, so no limits are shown.";

/** True for a workspace on a trial without plan limits: AI credits still have the platform ceiling, but nothing else is limited. */
const noPaidPlan = (data: Usage) => !!data.plan && data.plan.state !== "exempt" && !data.plan.planName && data.lines.every((l) => l.kind === "aiCredits" || l.limit === null);

/** Every plan limit with how much of it is used. AI credits always have a ceiling, even when the plan sets none. */
export function PlanUsage() {
  const { data, error, loading, reload } = useApi<Usage>("/api/billing/usage");
  return (
    <Card title="Plan usage" description="What you have used against each limit of your plan." aria-busy={loading || undefined}>
      {loading ? (
        <div className="space-y-4" role="status">
          <span className="sr-only">Loading usage</span>
          {[0, 1, 2, 3].map((i) => (
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
          <ul className="space-y-5">
            {data.lines.map((l) => (
              <Line key={l.kind} line={l} unplanned={noPaidPlan(data)} />
            ))}
          </ul>
          {noPaidPlan(data) && <p className="mt-4 text-xs text-muted">{NO_PLAN_TEXT}</p>}
        </>
      )}
    </Card>
  );
}

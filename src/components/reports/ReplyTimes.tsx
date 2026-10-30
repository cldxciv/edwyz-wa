"use client";

import { Card, DataTable, EmptyState, Stat, type Column } from "@/components/ui";
import type { ResponseTimes } from "@/lib/reports/response-times";
import { formatDuration } from "@/lib/reports/stats";

type Person = NonNullable<ResponseTimes["byAgent"]>[number];
type Team = NonNullable<ResponseTimes["byTeam"]>[number];

const wait = (seconds: number | null) => (seconds === null ? "No replies yet" : formatDuration(seconds));

const personColumns: Column<Person>[] = [
  { key: "name", header: "Team member", primary: true, accessor: (p) => p.name, sortable: true },
  { key: "replies", header: "Replies", align: "right", accessor: (p) => p.replies, sortable: true, cell: (p) => p.replies.toLocaleString() },
  { key: "typical", header: "Typical reply time", align: "right", accessor: (p) => p.medianSeconds, sortable: true, cell: (p) => wait(p.medianSeconds) },
  { key: "first", header: "Typical first reply", align: "right", accessor: (p) => p.firstMedianSeconds, sortable: true, cell: (p) => wait(p.firstMedianSeconds) },
];

const teamColumns: Column<Team>[] = [
  { key: "name", header: "Team", primary: true, accessor: (t) => t.name, sortable: true },
  { key: "replies", header: "Replies", align: "right", accessor: (t) => t.replies, sortable: true, cell: (t) => t.replies.toLocaleString() },
  { key: "typical", header: "Typical reply time", align: "right", accessor: (t) => t.medianSeconds, sortable: true, cell: (t) => wait(t.medianSeconds) },
  { key: "first", header: "Typical first reply", align: "right", accessor: (t) => t.firstMedianSeconds, sortable: true, cell: (t) => wait(t.firstMedianSeconds) },
];

/** How fast the team answers customers, overall and (for admins) by person and by team. */
export function ReplyTimes({ data }: { data: ResponseTimes | null | undefined }) {
  if (!data) return null;
  return (
    <section aria-label="Reply times" className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Typical reply time" value={wait(data.medianSeconds)} hint={data.replies ? `Across ${data.replies.toLocaleString()} customer messages${data.capped ? " (most recent)" : ""}` : "Appears after your first reply"} />
        <Stat label="Average reply time" value={wait(data.averageSeconds)} hint="Long waits pull this up more than the typical time" />
        <Stat label="9 in 10 replies within" value={wait(data.p90Seconds)} />
        <Stat label="Typical first reply" value={wait(data.firstMedianSeconds)} hint={data.firstReplies ? `Across ${data.firstReplies.toLocaleString()} new customers` : "Appears after a new customer gets a reply"} />
      </div>
      <p className="text-xs text-muted">A wait starts when a customer writes and ends when a team member answers. Automatic replies do not stop the clock.</p>
      {data.byAgent && data.byTeam && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card title="Reply times by team member" padded={false}>
            <DataTable
              className="max-sm:p-3"
              caption="Reply times by team member"
              columns={personColumns}
              rows={data.byAgent}
              rowKey={(p) => p.userId}
              empty={
                <div className="px-5 pb-5">
                  <EmptyState compact title="No replies yet" body="Reply times appear once your team answers customers from the inbox." />
                </div>
              }
            />
          </Card>
          <Card title="Reply times by team" padded={false}>
            <DataTable
              className="max-sm:p-3"
              caption="Reply times by team"
              columns={teamColumns}
              rows={data.byTeam}
              rowKey={(t) => t.teamId ?? "default"}
              empty={
                <div className="px-5 pb-5">
                  <EmptyState compact title="No replies yet" body="Reply times for each team appear once chats are answered." />
                </div>
              }
            />
          </Card>
        </div>
      )}
    </section>
  );
}

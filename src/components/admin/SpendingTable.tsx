"use client";

import { Badge, DataTable, EmptyState, type Column } from "@/components/ui";
import type { AdminSpendRowDTO } from "@/lib/spend/types";
import { cellText, emptySpending, metaLimitTone, moneyText, newWorkspaceLimitsInfo, spendStateInfo } from "./helpers";

const link = "font-medium text-accent-ink underline underline-offset-2";

/** "as of 14:05 UTC" for today, the date and time for older rows, "Not checked yet" for a workspace with no saved row. */
export function asOfLabel(asOf: string | null, nowIso: string): string {
  if (!asOf) return "Not checked yet";
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return "Not checked yet";
  const iso = d.toISOString();
  return iso.slice(0, 10) === nowIso.slice(0, 10) ? `as of ${iso.slice(11, 16)} UTC` : `as of ${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function columns(nowIso: string): Column<AdminSpendRowDTO>[] {
  return [
    {
      key: "workspace",
      header: "Workspace",
      primary: true,
      cell: (r) => (
        <div className="min-w-0">
          <a className={link} href={`/admin/tenants/${r.tenantId}`}>
            {r.name}
          </a>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            {r.demo && <Badge tone="info">Demo</Badge>}
            {r.noWhatsApp && <Badge>No WhatsApp</Badge>}
            {!r.demo && r.riskPct !== null && <span className="text-xs text-muted">Highest use {r.riskPct}%</span>}
          </span>
          <span className="block text-xs text-muted">{asOfLabel(r.asOf, nowIso)}</span>
        </div>
      ),
    },
    { key: "plan", header: "Plan", cell: (r) => r.plan ?? <span className="text-muted">No plan</span> },
    {
      key: "nwl",
      header: "New-workspace limits",
      cell: (r) => {
        const info = newWorkspaceLimitsInfo(r.newWorkspaceLimits);
        return <Badge tone={info.tone}>{info.label}</Badge>;
      },
    },
    { key: "adsToday", header: "Ads today (spent / set aside / limit)", cell: (r) => <span className="tabular-nums">{cellText(r.adsToday)}</span> },
    { key: "adsMonth", header: "Ads this month (spent / set aside / limit)", cell: (r) => <span className="tabular-nums">{cellText(r.adsMonth)}</span> },
    { key: "wa", header: "WhatsApp this month (spent / set aside / limit)", cell: (r) => <span className="tabular-nums">{cellText(r.whatsappMonth)}</span> },
    { key: "ai", header: "AI credits this month", cell: (r) => <span className="tabular-nums">{`${moneyText(r.aiMonth.used, "0 credits")} of ${moneyText(r.aiMonth.limit)}`}</span> },
    { key: "meta", header: "Meta limit", cell: (r) => <Badge tone={metaLimitTone(r.metaLimit.state)}>{r.metaLimit.label}</Badge> },
    { key: "breakers", header: "Safety stops open", align: "right", cell: (r) => (r.breakersOpen > 0 ? <Badge tone="bad">{r.breakersOpen}</Badge> : <span className="text-muted">0</span>) },
    { key: "requests", header: "Requests waiting", align: "right", cell: (r) => (r.requestsWaiting > 0 ? <Badge tone="warn">{r.requestsWaiting}</Badge> : <span className="text-muted">0</span>) },
    {
      key: "state",
      header: "State",
      cell: (r) => {
        const info = spendStateInfo(r.state);
        return (
          <Badge tone={info.tone} dot>
            {info.label}
          </Badge>
        );
      },
    },
  ];
}

/** /admin/spending: one row per workspace, in the order the server sorted them (risk first, demo last). */
export function SpendingTable({ rows, q, filter, nowIso }: { rows: AdminSpendRowDTO[]; q: string; filter: string; nowIso: string }) {
  const empty = emptySpending(q, filter);
  return (
    <DataTable
      columns={columns(nowIso)}
      rows={rows}
      rowKey={(r) => r.tenantId}
      caption="Spending across workspaces, highest use first"
      empty={<EmptyState compact title={empty.title} body={empty.body} />}
    />
  );
}

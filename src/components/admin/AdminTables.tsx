"use client";

import { Badge, DataTable, EmptyState, StatusPill, type Column } from "@/components/ui";
import type { TenantOverview } from "@/lib/admin/service";
import {
  auditActionLabel,
  billingLabel,
  billingTone,
  emptyTenants,
  inrText as inr,
  invoiceInfo,
  onboardingInfo,
  paymentEventLabel,
  paymentEventStatus,
  qualityInfo,
  tierLabel,
  when,
} from "./helpers";

const mono = "font-mono text-xs break-all";
const link = "font-medium text-accent-ink underline underline-offset-2";

function Details({ children, label = "Details" }: { children: React.ReactNode; label?: string }) {
  return (
    <details>
      <summary className="inline-flex min-h-8 cursor-pointer items-center text-xs font-medium text-accent-ink underline underline-offset-2">{label}</summary>
      <div className="mt-1 text-xs text-muted">{children}</div>
    </details>
  );
}

const empty = (title: string, body: string) => <EmptyState compact title={title} body={body} />;

/* Workspaces overview on the dashboard */

const overviewColumns: Column<TenantOverview>[] = [
  { key: "name", header: "Workspace", primary: true, cell: (t) => <a className={link} href={`/admin/tenants/${t.id}`}>{t.name}</a> },
  { key: "created", header: "Created", cell: (t) => <span className="whitespace-nowrap text-muted">{when(t.createdAt)}</span> },
  {
    key: "setup",
    header: "WhatsApp setup",
    cell: (t) => {
      const o = onboardingInfo(t.onboardingStatus);
      return <StatusPill status={t.onboardingStatus} label={o.label} tone={o.tone} />;
    },
  },
  { key: "numbers", header: "Numbers", align: "right", cell: (t) => t.phoneNumbers.length },
  {
    key: "quality",
    header: "Quality and sending limit",
    cell: (t) =>
      t.phoneNumbers.length === 0 ? (
        <span className="text-muted">-</span>
      ) : (
        <ul className="space-y-1">
          {t.phoneNumbers.map((p) => {
            const q = qualityInfo(p.qualityRating);
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={q.tone} dot>
                  {q.label}
                </Badge>
                <span className="text-xs text-muted">{tierLabel(p.messagingLimitTier)}</span>
              </li>
            );
          })}
        </ul>
      ),
  },
  {
    key: "log",
    header: "Recent setup activity",
    cell: (t) =>
      t.recentLogs.length === 0 ? (
        <span className="text-muted">None yet</span>
      ) : (
        <Details label={`${t.recentLogs.length} recent ${t.recentLogs.length === 1 ? "step" : "steps"}`}>
          <ul className="space-y-1">
            {t.recentLogs.map((l, i) => (
              <li key={i}>
                {l.step.replace(/_/g, " ")}: {l.status} ({when(l.at)})
              </li>
            ))}
          </ul>
        </Details>
      ),
  },
];

export function TenantOverviewTable({ tenants }: { tenants: TenantOverview[] }) {
  return <DataTable className="max-sm:p-3" caption="Workspaces and their WhatsApp setup" columns={overviewColumns} rows={tenants} rowKey={(t) => t.id} empty={empty("No workspaces yet", "Workspaces appear here once customers sign up.")} />;
}

/* Searchable workspace list */

export type TenantRow = {
  id: string;
  name: string;
  createdAt: string;
  status: string;
  billingExempt: boolean;
  billing: string;
  planName: string | null;
  members: number;
  onboardingStatus: string;
  /** Set when the owner asked for the workspace to be deleted and it has not been erased yet. */
  deleteBy?: string | null;
};

const listColumns: Column<TenantRow>[] = [
  {
    key: "name",
    header: "Workspace",
    primary: true,
    cell: (t) => (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a className={link} href={`/admin/tenants/${t.id}`}>
          {t.name}
        </a>
        {t.status === "suspended" && <StatusPill status="suspended" />}
        {t.billingExempt && <Badge tone="good">Complimentary</Badge>}
        {t.deleteBy && <Badge tone="bad">{`Deletion requested, due by ${when(t.deleteBy)}`}</Badge>}
      </span>
    ),
  },
  { key: "created", header: "Created", cell: (t) => <span className="whitespace-nowrap text-muted">{when(t.createdAt)}</span> },
  { key: "billing", header: "Billing", cell: (t) => <Badge tone={billingTone(t.billing)}>{billingLabel(t.billing)}</Badge> },
  { key: "plan", header: "Plan", accessor: (t) => t.planName ?? "" },
  { key: "members", header: "Members", align: "right", accessor: (t) => t.members },
  {
    key: "setup",
    header: "WhatsApp setup",
    cell: (t) => {
      const o = onboardingInfo(t.onboardingStatus);
      return <StatusPill status={t.onboardingStatus} label={o.label} tone={o.tone} />;
    },
  },
];

export function TenantListTable({ rows, q, filter }: { rows: TenantRow[]; q: string; filter: string }) {
  const e = emptyTenants(q, filter);
  return <DataTable className="max-sm:p-3" caption="Workspaces" columns={listColumns} rows={rows} rowKey={(t) => t.id} empty={empty(e.title, e.body)} />;
}

/* Audit log */

export type AuditRow = { id: string; at: string; action: string; tenantId: string | null; userId: string | null; target: string | null; meta: string };

const auditColumns: Column<AuditRow>[] = [
  { key: "at", header: "When", cell: (r) => <span className="whitespace-nowrap text-muted">{when(r.at)}</span> },
  { key: "action", header: "What happened", primary: true, cell: (r) => <span className="font-medium">{auditActionLabel(r.action)}</span> },
  { key: "tenant", header: "Workspace", cell: (r) => (r.tenantId ? <a className={`${link} ${mono}`} href={`/admin/tenants/${r.tenantId}`}>{r.tenantId}</a> : <span className="text-muted">-</span>) },
  { key: "user", header: "User", cell: (r) => (r.userId ? <span className={mono}>{r.userId}</span> : <span className="text-muted">-</span>) },
  {
    key: "details",
    header: "Details",
    cell: (r) => (
      <Details>
        <p>
          Action code: <span className="font-mono">{r.action}</span>
        </p>
        {r.target && (
          <p>
            Target: <span className={mono}>{r.target}</span>
          </p>
        )}
        {r.meta && <p className="break-words">{r.meta}</p>}
      </Details>
    ),
  },
];

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  return <DataTable className="max-sm:p-3" caption="Audit log" columns={auditColumns} rows={rows} rowKey={(r) => r.id} empty={empty("No entries match", "Try removing a filter or widening the date range.")} />;
}

/* Payments */

export type PaymentEventRow = { id: string; type: string; status: string; at: string; error: string | null };
export type PaymentInvoiceRow = { id: string; number: string; tenant: string; status: string; totalPaise: number; issuedAt: string; paidAt: string | null };

const eventColumns: Column<PaymentEventRow>[] = [
  { key: "type", header: "Event", primary: true, cell: (e) => <span className="font-medium">{paymentEventLabel(e.type)}</span> },
  {
    key: "status",
    header: "Result",
    cell: (e) => {
      const s = paymentEventStatus(e.status);
      return <StatusPill status={e.status} label={s.label} tone={s.tone} />;
    },
  },
  { key: "at", header: "Received", cell: (e) => <span className="whitespace-nowrap text-muted">{when(e.at)}</span> },
  {
    key: "error",
    header: "Problem",
    cell: (e) =>
      e.error ? (
        <Details label="Show problem">
          <span className="break-words">{e.error}</span>
          <span className="mt-1 block">
            Event code: <span className="font-mono">{e.type}</span>
          </span>
        </Details>
      ) : (
        <span className="text-muted">None</span>
      ),
  },
];

export function PaymentEventsTable({ rows }: { rows: PaymentEventRow[] }) {
  return <DataTable className="max-sm:p-3" caption="Razorpay payment events" columns={eventColumns} rows={rows} rowKey={(e) => e.id} empty={empty("No payment events yet", "Events from Razorpay show up here once someone subscribes.")} />;
}

const paymentInvoiceColumns: Column<PaymentInvoiceRow>[] = [
  { key: "number", header: "Invoice", primary: true, cell: (i) => <span className="font-mono">{i.number}</span> },
  { key: "tenant", header: "Workspace", accessor: (i) => i.tenant },
  {
    key: "status",
    header: "Status",
    cell: (i) => {
      const s = invoiceInfo(i.status);
      return <StatusPill status={i.status} label={s.label} tone={s.tone} />;
    },
  },
  { key: "total", header: "Total", align: "right", cell: (i) => <span className="tabular-nums">{inr(i.totalPaise)}</span> },
  { key: "issued", header: "Issued", cell: (i) => <span className="whitespace-nowrap text-muted">{when(i.issuedAt)}</span> },
  { key: "paid", header: "Paid", cell: (i) => <span className="whitespace-nowrap text-muted">{when(i.paidAt)}</span> },
];

export function PaymentInvoicesTable({ rows }: { rows: PaymentInvoiceRow[] }) {
  return <DataTable className="max-sm:p-3" caption="Invoices across all workspaces" columns={paymentInvoiceColumns} rows={rows} rowKey={(i) => i.id} empty={empty("No invoices yet", "Invoices are created when a workspace pays for a plan.")} />;
}

/* Workspace detail */

export type MemberRow = { id: string; name: string; email: string; role: string; disabled: boolean };
export type NumberRow = { id: string; displayPhone: string; verifiedName: string | null; qualityRating: string | null; messagingLimitTier: string | null };
export type TenantInvoiceRow = { id: string; number: string; status: string; totalPaise: number; issuedAt: string };

const memberColumns: Column<MemberRow>[] = [
  { key: "name", header: "Name", primary: true, cell: (m) => <span className="font-medium">{m.name}</span> },
  { key: "email", header: "Email", cell: (m) => <span className="break-all">{m.email}</span> },
  { key: "role", header: "Role", cell: (m) => <span className="capitalize">{m.role}</span> },
  { key: "status", header: "Sign-in", cell: (m) => <StatusPill status={m.disabled ? "disabled" : "active"} /> },
];

export function MembersTable({ rows }: { rows: MemberRow[] }) {
  return <DataTable className="max-sm:p-3" caption="Members of this workspace" columns={memberColumns} rows={rows} rowKey={(m) => m.id} empty={empty("No members", "This workspace has no members.")} />;
}

const numberColumns: Column<NumberRow>[] = [
  { key: "number", header: "Number", primary: true, cell: (n) => <span className="font-medium">{n.displayPhone}</span> },
  { key: "name", header: "Business name", accessor: (n) => n.verifiedName },
  {
    key: "quality",
    header: "Quality",
    cell: (n) => {
      const q = qualityInfo(n.qualityRating);
      return (
        <Badge tone={q.tone} dot>
          {q.label}
        </Badge>
      );
    },
  },
  { key: "tier", header: "Daily sending limit", cell: (n) => tierLabel(n.messagingLimitTier) },
];

export function NumbersTable({ rows }: { rows: NumberRow[] }) {
  return <DataTable className="max-sm:p-3" caption="Connected WhatsApp numbers" columns={numberColumns} rows={rows} rowKey={(n) => n.id} empty={empty("No numbers connected", "This workspace has not connected a WhatsApp number yet.")} />;
}

const tenantInvoiceColumns: Column<TenantInvoiceRow>[] = [
  { key: "number", header: "Invoice", primary: true, cell: (i) => <span className="font-mono">{i.number}</span> },
  {
    key: "status",
    header: "Status",
    cell: (i) => {
      const s = invoiceInfo(i.status);
      return <StatusPill status={i.status} label={s.label} tone={s.tone} />;
    },
  },
  { key: "total", header: "Total", align: "right", cell: (i) => <span className="tabular-nums">{inr(i.totalPaise)}</span> },
  { key: "issued", header: "Issued", cell: (i) => <span className="whitespace-nowrap text-muted">{when(i.issuedAt)}</span> },
];

export function TenantInvoicesTable({ rows }: { rows: TenantInvoiceRow[] }) {
  return <DataTable className="max-sm:p-3" caption="Invoices for this workspace" columns={tenantInvoiceColumns} rows={rows} rowKey={(i) => i.id} empty={empty("No invoices", "This workspace has not been invoiced yet.")} />;
}

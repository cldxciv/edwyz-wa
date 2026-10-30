import { requireAdminPage } from "@/lib/admin/page";
import { formatInr, getPlatformMetrics } from "@/lib/admin/queries";
import { listApprovedTemplatesByTenant, listTenantOverview, tenantIdsWithSendableToken } from "@/lib/admin/service";
import { audit } from "@/lib/auth/audit";
import { AdminShell, when } from "@/components/admin/AdminShell";
import { TenantOverviewTable } from "@/components/admin/AdminTables";
import { TestMessagePanel } from "@/components/admin/TestMessagePanel";
import { adminPageMetadata, attentionItems, billingLabel, humanize, qualityInfo, testMessageNumbers } from "@/components/admin/helpers";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert, Badge, buttonSizes, buttonVariants, Card, cn, EmptyState, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Overview");

const linkButton = cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.secondary, buttonSizes.sm);

export default async function AdminDashboard() {
  const admin = await requireAdminPage();
  await audit({ userId: admin.userId, action: "admin.view", meta: { page: "dashboard" } });
  const [m, tenants] = await Promise.all([getPlatformMetrics(), listTenantOverview()]);
  const tenantIds = tenants.map((t) => t.id);
  const [sendable, templates] = await Promise.all([tenantIdsWithSendableToken(tenantIds), listApprovedTemplatesByTenant(tenantIds)]);
  const numbers = testMessageNumbers(tenants, sendable, templates);
  const attention = attentionItems(m);
  const states = Object.entries(m.tenantsByState);
  const jobs: [string, number][] = [
    ["Waiting", m.jobs.queued ?? 0],
    ["Running", m.jobs.running ?? 0],
    ["Failed", m.jobs.failed ?? 0],
  ];

  return (
    <AdminShell email={admin.email} current="/admin">
      <PageHeader title="Platform overview" description="Live numbers straight from the database. Nothing here is cached." />

      <section aria-labelledby="attention-heading" className="mb-8">
        <h2 id="attention-heading" className="mb-3 text-lg font-semibold">
          Needs your attention
        </h2>
        {attention.length === 0 ? (
          <Alert tone="good" title="All clear">
            No failed jobs, no low-quality numbers and no failed payments right now.
          </Alert>
        ) : (
          <ul className="space-y-2">
            {attention.map((a) => (
              <li key={a.id}>
                <Alert
                  tone={a.tone}
                  title={a.title}
                  action={
                    a.href ? (
                      <a className={linkButton} href={a.href}>
                        {a.linkLabel}
                      </a>
                    ) : undefined
                  }
                >
                  {a.body}
                </Alert>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="revenue-heading">
        <h2 id="revenue-heading" className="mb-3 text-lg font-semibold">
          Workspaces and revenue
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Workspaces" value={m.totalTenants.toLocaleString()} />
          <Stat label="On a free trial" value={m.trialCount.toLocaleString()} />
          <Stat label="Active subscriptions" value={m.activeSubscriptions.toLocaleString()} hint={`${m.paidSubscriptions} paid through Razorpay, ${m.manualSubscriptions} assigned by hand`} />
          <Stat label="Monthly revenue (MRR)" value={formatInr(m.mrrPaise)} hint="Razorpay subscriptions only. Hand-assigned plans are left out." />
          <Stat label="New workspaces, 7 days" value={m.signups.tenants7.toLocaleString()} />
          <Stat label="New workspaces, 30 days" value={m.signups.tenants30.toLocaleString()} />
          <Stat label="New users, 7 days" value={m.signups.users7.toLocaleString()} />
          <Stat label="New users, 30 days" value={m.signups.users30.toLocaleString()} />
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card title="Workspaces by billing state">
          {states.length === 0 ? (
            <p className="text-sm text-muted">No workspaces yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {states.map(([k, v]) => (
                <li key={k} className="flex items-center justify-between gap-3 py-2">
                  <span>{billingLabel(k)}</span>
                  <span className="font-medium tabular-nums">{v}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Messages in the last 24 hours">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted">Received</dt>
              <dd className="text-xl font-semibold tabular-nums">{m.messages24h.inbound.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted">Sent</dt>
              <dd className="text-xl font-semibold tabular-nums">{m.messages24h.outbound.toLocaleString()}</dd>
            </div>
          </dl>
          <h3 className="mb-2 mt-5 text-sm font-semibold">Phone number quality</h3>
          {m.quality.length === 0 ? (
            <p className="text-sm text-muted">No connected numbers yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {m.quality.map((q) => {
                const info = qualityInfo(q.rating);
                return (
                  <li key={q.rating} className="flex items-center justify-between gap-3">
                    <Badge tone={info.tone} dot>
                      {info.label}
                    </Badge>
                    <span className="font-medium tabular-nums">{q.count}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title="Background jobs" description="Work the server does behind the scenes, like sending broadcasts and emails.">
          <dl className="grid grid-cols-3 gap-3 text-sm">
            {jobs.map(([label, n]) => (
              <div key={label}>
                <dt className="text-muted">{label}</dt>
                <dd className="text-xl font-semibold tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="Recent failed webhook events" description="Updates from WhatsApp that we could not process.">
          {m.failedEvents.length === 0 ? (
            <EmptyState compact title="Nothing has failed" body="Incoming WhatsApp events are being processed normally." />
          ) : (
            <ul className="space-y-2 text-sm">
              {m.failedEvents.map((e) => (
                <li key={e.id}>
                  <span className="block text-xs text-muted">{when(e.at)}</span>
                  <details>
                    <summary className="inline-flex min-h-8 cursor-pointer items-center text-sm font-medium text-accent-ink underline underline-offset-2">{humanize(e.error.split(/[:.]/)[0] || "Processing error")}</summary>
                    <p className="mt-1 break-words text-xs text-muted">{e.error}</p>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-8">
        <TestMessagePanel numbers={numbers} />
      </div>

      <section aria-labelledby="overview-heading" className="mt-10">
        <h2 id="overview-heading" className="mb-3 text-lg font-semibold">
          Newest workspaces
        </h2>
        <Card padded={false}>
          <TenantOverviewTable tenants={tenants.slice(0, 25)} />
        </Card>
        <p className="mt-3 text-sm">
          <a className="inline-flex min-h-10 items-center font-medium text-accent-ink underline underline-offset-2" href="/admin/tenants">
            Search and manage all workspaces
          </a>
        </p>
      </section>
    </AdminShell>
  );
}

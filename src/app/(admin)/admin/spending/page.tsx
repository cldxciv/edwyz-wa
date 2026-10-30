import { cookies } from "next/headers";
import { requireAdminPage } from "@/lib/admin/page";
import { isSpendingFilter, listSpending, SPENDING_FILTERS, spendingAlerts, stepUpFresh, stepUpIssuedAt, type SpendingFilter } from "@/lib/admin/spending";
import { ADMIN_COOKIE } from "@/lib/admin/stepup";
import { audit } from "@/lib/auth/audit";
import { AdminShell, Pager } from "@/components/admin/AdminShell";
import { adminPageMetadata, spendingFilterLabel } from "@/components/admin/helpers";
import { PlatformSpendSwitch } from "@/components/admin/PlatformSpendSwitch";
import { SpendingTable } from "@/components/admin/SpendingTable";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert, Button, buttonSizes, buttonVariants, cn, Field, Input, Select } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Spending");

const linkButton = cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.secondary, buttonSizes.md);

/** /admin/spending: "Spending across workspaces" (docs/SPEND-CONTROLS-SPEC.md 8.3). */
export default async function SpendingPage({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string; page?: string }> }) {
  const admin = await requireAdminPage();
  const sp = await searchParams;
  const filter: SpendingFilter = isSpendingFilter(sp.filter) ? sp.filter : "all";
  const q = (sp.q ?? "").slice(0, 100);
  const page = Math.max(1, Number(sp.page) || 1);
  await audit({ userId: admin.userId, action: "admin.view", meta: { page: "spending" } });
  const now = new Date();
  const list = await listSpending({ filter, q, page }, { now });
  const alerts = await spendingAlerts(list.all, { now });
  const fresh = stepUpFresh(stepUpIssuedAt((await cookies()).get(ADMIN_COOKIE)?.value, admin.userId, now.getTime()), now);
  const needs = alerts.filter((a) => a.tone === "bad" || a.tone === "warn" || a.tone === "info");
  const fine = alerts.filter((a) => a.tone === "good");
  const base = `/admin/spending?filter=${filter}&q=${encodeURIComponent(q)}`;
  const filtered = q !== "" || filter !== "all";

  return (
    <AdminShell email={admin.email} current="/admin/spending">
      <PageHeader
        title="Spending across workspaces"
        description="Every workspace's spending limits and use, from figures saved every 5 minutes. Amounts are in each workspace's own currency. Open a workspace to see live figures and to change its limits."
        actions={
          <a href="/admin/spending/settings" className={linkButton}>
            Spending settings
          </a>
        }
      />

      <div className="mb-6">
        <PlatformSpendSwitch freeze={list.platform.freeze} text={list.platform.text} progressText={list.platform.progressText} stepUpFresh={fresh} />
      </div>

      <section aria-labelledby="alerts-heading" className="mb-6">
        <h2 id="alerts-heading" className="mb-3 text-lg font-semibold">
          Alerts
        </h2>
        <div className="space-y-2">
          {needs.map((a) => (
            <Alert
              key={a.id}
              tone={a.tone}
              title={a.title}
              action={
                a.href ? (
                  <a className="inline-flex min-h-10 items-center text-sm font-medium text-accent-ink underline underline-offset-2" href={a.href}>
                    {a.linkLabel ?? "Open"}
                  </a>
                ) : undefined
              }
            >
              {a.body}
            </Alert>
          ))}
          {fine.length > 0 && (
            <ul className="grid gap-2 text-sm sm:grid-cols-2">
              {fine.map((a) => (
                <li key={a.id} className="rounded-control border border-good-line bg-good-soft px-3 py-2 text-good-fg">
                  <span className="font-medium">{a.title}:</span> {a.body}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <form role="search" aria-label="Find workspaces" className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_auto] sm:items-end">
        <Field label="Search workspaces" htmlFor="q">
          <Input id="q" name="q" type="search" defaultValue={q} placeholder="Name or web address" maxLength={100} />
        </Field>
        <Field label="Show" htmlFor="filter">
          <Select id="filter" name="filter" defaultValue={filter}>
            {SPENDING_FILTERS.map((f) => (
              <option key={f} value={f}>
                {`${spendingFilterLabel(f)} (${list.counts[f]})`}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-2">
          <Button type="submit">Show</Button>
          {filtered && (
            <a href="/admin/spending" className={cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.ghost, buttonSizes.md)}>
              Clear
            </a>
          )}
        </div>
      </form>
      <p className="mb-3 text-sm text-muted" role="status">
        {list.total.toLocaleString("en-IN")} {list.total === 1 ? "workspace" : "workspaces"}
        {filter !== "all" ? `. Showing: ${spendingFilterLabel(filter).toLowerCase()}` : ""}
        {q ? `. Search: "${q}"` : ""}. Highest use first; the demo workspace is listed last.
      </p>
      <SpendingTable rows={list.rows} q={q} filter={filter} nowIso={now.toISOString()} />
      <Pager base={base} page={list.page} total={list.total} size={list.pageSize} />
    </AdminShell>
  );
}

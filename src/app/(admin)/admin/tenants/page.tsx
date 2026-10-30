import { requireAdminPage } from "@/lib/admin/page";
import { audit } from "@/lib/auth/audit";
import { listTenants, PAGE_SIZE, TENANT_FILTERS, type TenantFilter } from "@/lib/admin/tenants";
import { AdminShell, Pager } from "@/components/admin/AdminShell";
import { TenantListTable } from "@/components/admin/AdminTables";
import { adminPageMetadata, tenantFilterLabel } from "@/components/admin/helpers";
import { PageHeader } from "@/components/app/PageHeader";
import { Button, buttonSizes, buttonVariants, Card, cn, Field, Input, Select } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Workspaces");

export default async function TenantsPage({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string; page?: string }> }) {
  const admin = await requireAdminPage();
  const sp = await searchParams;
  const filter = TENANT_FILTERS.includes(sp.filter as TenantFilter) ? (sp.filter as TenantFilter) : "all";
  const q = (sp.q ?? "").slice(0, 100);
  const page = Math.max(1, Number(sp.page) || 1);
  await audit({ userId: admin.userId, action: "admin.view", meta: { page: "tenants" } });
  const { total, items } = await listTenants({ filter, q, page });
  const base = `/admin/tenants?filter=${filter}&q=${encodeURIComponent(q)}`;
  const filtered = q !== "" || filter !== "all";

  const rows = items.map((t) => ({
    id: t.id,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
    status: t.status,
    billingExempt: t.billingExempt,
    billing: t.billing,
    planName: t.subscription?.plan.name ?? null,
    members: t._count.memberships,
    onboardingStatus: t.onboardingStatus,
    deleteBy: t.deletionRequest?.deleteBy ?? null,
  }));

  return (
    <AdminShell email={admin.email} current="/admin/tenants">
      <PageHeader title="Workspaces" description="Every customer workspace. Search by name or web address, or narrow the list with a filter. Open a workspace to manage it." />
      <form role="search" aria-label="Find workspaces" className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-end">
        <Field label="Search workspaces" htmlFor="q">
          <Input id="q" name="q" type="search" defaultValue={q} placeholder="Name or web address" maxLength={100} />
        </Field>
        <Field label="Show" htmlFor="filter">
          <Select id="filter" name="filter" defaultValue={filter}>
            {TENANT_FILTERS.map((f) => (
              <option key={f} value={f}>
                {tenantFilterLabel(f)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-2">
          <Button type="submit">Search</Button>
          {filtered && (
            <a href="/admin/tenants" className={cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.ghost, buttonSizes.md)}>
              Clear
            </a>
          )}
        </div>
      </form>
      <p className="mb-3 text-sm text-muted" role="status">
        {total.toLocaleString()} {total === 1 ? "workspace" : "workspaces"}
        {filtered ? " found" : ""}
        {filter !== "all" ? `. Showing: ${tenantFilterLabel(filter).toLowerCase()}` : ""}
        {q ? `. Search: "${q}"` : ""}
      </p>
      <Card padded={false}>
        <TenantListTable rows={rows} q={q} filter={filter} />
      </Card>
      <Pager base={base} page={page} total={total} size={PAGE_SIZE} />
    </AdminShell>
  );
}

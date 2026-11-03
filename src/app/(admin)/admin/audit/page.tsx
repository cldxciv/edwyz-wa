import { requireAdminPage } from "@/lib/admin/page";
import { parseAuditParams } from "@/lib/admin/auditParams";
import { AUDIT_PAGE_SIZE, listAudit } from "@/lib/admin/queries";
import { AdminShell, Pager } from "@/components/admin/AdminShell";
import { adminPageMetadata } from "@/components/admin/helpers";
import { AuditTable } from "@/components/admin/AdminTables";
import { PageHeader } from "@/components/app/PageHeader";
import { Button, buttonSizes, buttonVariants, Card, cn, Field, Input } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Audit log");

const FILTER_KEYS = ["tenantId", "userId", "action", "from", "to"] as const;

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requireAdminPage();
  const sp = await searchParams;
  const params = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string"));
  const filter = parseAuditParams(params);
  const { total, items } = await listAudit(filter);
  const base = `/admin/audit?${FILTER_KEYS.map((k) => `${k}=${encodeURIComponent(sp[k] ?? "")}`).join("&")}`;
  const filtered = FILTER_KEYS.some((k) => (sp[k] ?? "") !== "");

  return (
    <AdminShell email={admin.email} current="/admin/audit">
      <PageHeader title="Audit log" description="A record of important actions across the platform: who did what, and when. Secrets are never stored here." />
      <form role="search" aria-label="Filter the audit log" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Workspace ID" htmlFor="tenantId" hint="Open a workspace to find its ID in the address.">
          <Input id="tenantId" name="tenantId" defaultValue={sp.tenantId ?? ""} autoComplete="off" />
        </Field>
        <Field label="User ID" htmlFor="userId" hint="Or click a person in the list to see only their actions.">
          <Input id="userId" name="userId" defaultValue={sp.userId ?? ""} autoComplete="off" />
        </Field>
        <Field label="Action starts with" htmlFor="action" hint="For example admin. to see admin actions only.">
          <Input id="action" name="action" defaultValue={sp.action ?? ""} autoComplete="off" autoCapitalize="off" />
        </Field>
        <Field label="From date" htmlFor="from">
          <Input id="from" name="from" type="date" defaultValue={sp.from ?? ""} />
        </Field>
        <Field label="To date" htmlFor="to">
          <Input id="to" name="to" type="date" defaultValue={sp.to ?? ""} />
        </Field>
        <div className="flex items-end gap-2">
          <Button type="submit">Apply filters</Button>
          {filtered && (
            <a href="/admin/audit" className={cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.ghost, buttonSizes.md)}>
              Clear
            </a>
          )}
        </div>
      </form>
      <Card padded={false}>
        <AuditTable rows={items.map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), action: r.action, tenantId: r.tenantId, tenantName: r.tenantName, userId: r.userId, userEmail: r.userEmail, target: r.target, meta: r.meta }))} />
      </Card>
      <Pager base={base} page={filter.page} total={total} size={AUDIT_PAGE_SIZE} />
    </AdminShell>
  );
}

import { requireAdminPage } from "@/lib/admin/page";
import { listPlans } from "@/lib/admin/plans";
import { razorpayConfigured } from "@/lib/billing/razorpay";
import { formatInr } from "@/lib/admin/queries";
import { audit } from "@/lib/auth/audit";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminShell } from "@/components/admin/AdminShell";
import { adminPageMetadata } from "@/components/admin/helpers";
import { PlanForm } from "@/components/admin/PlanForm";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert, Card, EmptyState, StatusPill } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Plans");

const paiseToRupees = (p: number) => (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2));

export default async function PlansPage() {
  const admin = await requireAdminPage();
  await audit({ userId: admin.userId, action: "admin.view", meta: { page: "plans" } });
  const plans = await listPlans();

  return (
    <AdminShell email={admin.email} current="/admin/plans">
      <PageHeader title="Plans" description="The plans customers can buy. There are no built-in prices: enter them here, then publish a plan to Razorpay before anyone can subscribe." />
      {!razorpayConfigured() && (
        <div className="mb-6">
          <Alert tone="warn" title="Razorpay is not connected">
            You can create and edit plans now, but none can be published or bought until RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set on the server.
          </Alert>
        </div>
      )}
      {plans.length === 0 ? (
        <EmptyState title="No plans yet" body="Create your first plan below. Customers cannot subscribe until a plan is created and published." />
      ) : (
        <ul className="space-y-4">
          {plans.map((p) => {
            const endpoint = `/api/admin/plans/${p.id}`;
            const published = !!p.razorpayPlanId;
            return (
              <li key={p.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-semibold">{p.name}</h2>
                      <p className="text-sm">
                        {formatInr(p.pricePaise)} {p.intervalMonths === 1 ? "every month" : p.intervalMonths === 12 ? "every year" : `every ${p.intervalMonths} months`}, GST included
                      </p>
                      <p className="text-xs text-muted">
                        {p._count.subscriptions} {p._count.subscriptions === 1 ? "subscriber" : "subscribers"}. Plan code: <span className="font-mono">{p.code}</span>
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <StatusPill status={p.active ? "active" : "archived"} label={p.active ? "Available" : "Archived"} />
                      <StatusPill status={published ? "published" : "draft"} label={published ? "Published to Razorpay" : "Not published yet"} />
                    </div>
                  </div>
                  <details className="mt-3 border-t border-border pt-3">
                    <summary className="flex min-h-10 cursor-pointer items-center text-sm font-medium text-accent-ink underline underline-offset-2">Edit and manage this plan</summary>
                    <div className="mt-4 space-y-6">
                      <PlanForm
                        initial={{
                          id: p.id, code: p.code, name: p.name, description: p.description ?? "", priceRupees: paiseToRupees(p.pricePaise), intervalMonths: String(p.intervalMonths),
                          seatLimit: p.seatLimit?.toString() ?? "", contactLimit: p.contactLimit?.toString() ?? "", monthlyBroadcastLimit: p.monthlyBroadcastLimit?.toString() ?? "",
                          aiCreditsMonthly: p.aiCreditsMonthly?.toString() ?? "", adAccountLimit: p.adAccountLimit?.toString() ?? "", scheduledPostLimit: p.scheduledPostLimit?.toString() ?? "", connectedChannelLimit: p.connectedChannelLimit?.toString() ?? "",
                          features: JSON.stringify(p.features ?? {}), active: p.active, sortOrder: String(p.sortOrder), priceLocked: published, ceilings: p.ceilings,
                        }}
                      />
                      <div>
                        <h3 className="mb-2 text-sm font-semibold">Other actions</h3>
                        <div className="space-y-3">
                          {!published && <ActionForm endpoint={endpoint} label="Publish to Razorpay" body={{ action: "publish" }} needsReason={false} description="Creates this plan in Razorpay so customers can subscribe. After this, the price and interval are locked." />}
                          <ActionForm endpoint={endpoint} label="Duplicate as new plan" body={{ action: "duplicate" }} needsReason={false} description="Makes an unpublished copy you can change, for example to try a new price." />
                          {p.active ? (
                            <ActionForm endpoint={endpoint} label="Archive plan" body={{ action: "archive" }} needsReason={false} description="Hides the plan from new customers. Existing subscribers keep it." />
                          ) : (
                            <ActionForm endpoint={endpoint} label="Make plan available again" body={{ action: "unarchive" }} needsReason={false} description="Shows the plan to new customers again." />
                          )}
                          {p._count.subscriptions === 0 && (
                            <ActionForm endpoint={endpoint} label="Delete plan" danger body={{ action: "delete" }} confirmText={p.code} needsReason={false} description="Permanently removes this plan. It has no subscribers, so nobody loses access." />
                          )}
                        </div>
                      </div>
                    </div>
                  </details>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <h2 className="mb-3 mt-10 text-lg font-semibold">Create a plan</h2>
      <Alert tone="info" className="mb-3">
        New plans start as drafts. Publish one to Razorpay when you are happy with the price.
      </Alert>
      <Card>
        <PlanForm />
      </Card>
    </AdminShell>
  );
}

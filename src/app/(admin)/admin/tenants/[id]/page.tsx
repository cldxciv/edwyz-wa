import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/admin/page";
import { getTenantSpending } from "@/lib/admin/spending";
import { getTenantDetail } from "@/lib/admin/tenants";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { ActionForm, type ActionField } from "@/components/admin/ActionForm";
import { AdminShell, when } from "@/components/admin/AdminShell";
import { MembersTable, NumbersTable, TenantInvoicesTable } from "@/components/admin/AdminTables";
import { adminPageMetadata, auditActionLabel, billingLabel, billingTone, humanize, OFFBOARD_CHOICE_OPTIONS } from "@/components/admin/helpers";
import { TenantSpendCard } from "@/components/admin/TenantSpendCard";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert, Badge, Card, EmptyState, Stat, StatusPill } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Workspace");

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminPage();
  const { id } = await params;
  const detail = await getTenantDetail(id);
  if (!detail) notFound();
  await audit({ tenantId: id, userId: admin.userId, action: "admin.view", target: id, meta: { page: "tenant" } });
  const { tenant, invoices, usage, audits, onboarding, billing, deletionRequest } = detail;
  const plans = await prisma.plan.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, code: true } });
  const spending = await getTenantSpending(admin.userId, id);
  const endpoint = `/api/admin/tenants/${id}`;
  const suspended = tenant.status === "suspended";
  const sub = tenant.subscription;
  // Suspending or deleting asks what happens to Meta's spending limit where Edwyz manages it (5.8); "keep" is the default,
  // or the owner's own stored choice when every account has the same one.
  const ownerChoices = new Set((spending?.offboard ?? []).map((o) => o.selected));
  const metaLimitField: ActionField[] = spending && spending.offboard.length > 0
    ? [{ name: "metaLimitChoice", label: "Meta's spending limit", type: "select", options: OFFBOARD_CHOICE_OPTIONS, defaultValue: ownerChoices.size === 1 ? [...ownerChoices][0] : "keep", hint: "Applied before the Meta connections are removed, while Edwyz can still change it." }]
    : [];

  return (
    <AdminShell email={admin.email} current="/admin/tenants">
      <PageHeader
        title={tenant.name}
        breadcrumbs={[{ label: "Workspaces", href: "/admin/tenants" }, { label: tenant.name }]}
        description={`Created ${when(tenant.createdAt)}. Web address: ${tenant.slug}.`}
      />
      <div className="mb-6 flex flex-wrap gap-2">
        <Badge tone={billing ? billingTone(billing.state) : "neutral"} dot>
          Billing: {billing ? billingLabel(billing.state) : "unknown"}
        </Badge>
        {suspended && <StatusPill status="suspended" />}
        {tenant.deletedAt && <Badge tone="bad" dot>Deleted {when(tenant.deletedAt)}</Badge>}
        {tenant.billingExempt && <Badge tone="good" dot>Complimentary, no payment needed</Badge>}
        {tenant.trialEndsAt && <Badge tone="info" dot>Trial ends {when(tenant.trialEndsAt)}</Badge>}
      </div>
      {deletionRequest && !tenant.deletedAt && (
        <Alert tone="warn" title="The owner asked for this workspace to be deleted" className="mb-6">
          Requested {when(deletionRequest.requestedAt)}. The privacy policy promises deletion by {when(deletionRequest.deleteBy)}. Check the request, then erase the workspace below.
        </Alert>
      )}
      {suspended && (
        <Alert tone="bad" title="This workspace is suspended" className="mb-6">
          {tenant.suspendedReason ?? "No reason was recorded."}{" "}Sending and changes are blocked until you unsuspend it.
        </Alert>
      )}

      <section aria-label="Summary" className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Contacts" value={usage.contacts.toLocaleString()} />
        <Stat label="Conversations" value={usage.conversations.toLocaleString()} />
        <Stat label="Messages, last 30 days" value={usage.messages30d.toLocaleString()} />
        <Stat label="Broadcasts" value={usage.broadcasts.toLocaleString()} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card title="Subscription">
            {sub ? (
              <div className="space-y-1 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{sub.plan.name}</span>
                  <StatusPill status={sub.status} />
                  {sub.razorpaySubscriptionId ? <Badge>Paid through Razorpay</Badge> : <Badge tone="warn">Assigned by hand</Badge>}
                </p>
                <p className="text-muted">Current period ends {when(sub.currentPeriodEnd)}</p>
              </div>
            ) : (
              <EmptyState compact title="No subscription" body={tenant.billingExempt ? "This workspace is complimentary, so it does not need one." : "This workspace is on a free trial or has not subscribed yet."} />
            )}
          </Card>

          <Card title="Access and billing" description="Everyday actions. Each one asks for a reason and is saved in the audit log.">
            <div className="space-y-3">
              {suspended ? (
                <ActionForm endpoint={endpoint} label="Unsuspend workspace" body={{ action: "unsuspend" }} description="Lets this workspace send and make changes again." />
              ) : (
                <ActionForm endpoint={endpoint} label="Suspend workspace" danger body={{ action: "suspend" }} fields={metaLimitField} confirmText={tenant.name} description="Blocks sending and changes until you unsuspend it. Ads are paused and Meta connections are disconnected." />
              )}
              <ActionForm endpoint={endpoint} label="Extend free trial" body={{ action: "extend_trial" }} description="Gives this workspace more trial days." fields={[{ name: "days", label: "Days to add", type: "number", defaultValue: "7" }]} />
              <ActionForm
                endpoint={endpoint}
                label={tenant.billingExempt ? "Remove complimentary access" : "Make workspace complimentary"}
                body={{ action: "comp", exempt: !tenant.billingExempt }}
                description={tenant.billingExempt ? "The workspace will need to pay again." : "Skips the paywall, so this workspace never has to pay."}
              />
              <ActionForm
                endpoint={endpoint}
                label="Assign a plan by hand"
                body={{ action: "change_plan" }}
                description="Activates a plan without taking payment. No Razorpay subscription is created."
                fields={[
                  { name: "planId", label: "Plan", type: "select", options: plans.map((p) => ({ value: p.id, label: p.name })) },
                  { name: "months", label: "Months of access", type: "number", defaultValue: "12" },
                ]}
              />
            </div>
          </Card>
        </div>

        <Card title="Danger zone" description="These are hard to undo. Deleting can be reversed; erasing cannot." className="border-bad-line!">
          <div className="space-y-3">
            {tenant.deletedAt ? (
              <ActionForm endpoint={endpoint} label="Restore workspace" body={{ action: "restore" }} description="Brings this deleted workspace back with all its data." />
            ) : (
              <ActionForm endpoint={endpoint} label="Delete workspace" danger body={{ action: "soft_delete" }} fields={metaLimitField} confirmText={tenant.name} description="Suspends the workspace and marks it deleted. The data is kept, and you can restore it later." />
            )}
            <ActionForm
              endpoint={`${endpoint}/erase`}
              label="Erase all data permanently"
              danger
              body={{ action: "erase" }}
              confirmText={tenant.slug}
              description="Permanently deletes this workspace and everything in it: contacts, messages, leads, ad data and files. Meta connections are revoked. This cannot be undone. Invoices are kept, as tax law requires."
              fields={[
                {
                  name: "subscription",
                  label: "If there is still a Razorpay subscription",
                  type: "select",
                  options: [
                    { value: "refuse", label: "Stop, do not erase while a subscription is active" },
                    { value: "cancelled", label: "I have cancelled it in Razorpay, erase anyway" },
                  ],
                  defaultValue: "refuse",
                  hint: "Erasing does not cancel the subscription for you.",
                },
              ]}
            />
          </div>
        </Card>
      </div>

      {spending ? (
        <TenantSpendCard view={spending} endpoint={`/api/admin/spending/${id}`} />
      ) : null}

      <section aria-labelledby="members-heading" className="mt-8">
        <h2 id="members-heading" className="mb-3 text-lg font-semibold">
          Members
        </h2>
        <Card padded={false}>
          <MembersTable rows={tenant.memberships.map((m) => ({ id: m.id, name: m.user.name, email: m.user.email, role: m.role, disabled: !!m.user.disabledAt }))} />
        </Card>
      </section>

      <section aria-labelledby="numbers-heading" className="mt-8">
        <h2 id="numbers-heading" className="mb-3 text-lg font-semibold">
          Connected WhatsApp numbers
        </h2>
        <Card padded={false}>
          <NumbersTable rows={tenant.wabas.flatMap((w) => w.phoneNumbers).map((p) => ({ id: p.id, displayPhone: p.displayPhone, verifiedName: p.verifiedName, qualityRating: p.qualityRating, messagingLimitTier: p.messagingLimitTier }))} />
        </Card>
      </section>

      <section aria-labelledby="invoices-heading" className="mt-8">
        <h2 id="invoices-heading" className="mb-3 text-lg font-semibold">
          Invoices
        </h2>
        <Card padded={false}>
          <TenantInvoicesTable rows={invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, totalPaise: i.totalPaise, issuedAt: i.issuedAt.toISOString() }))} />
        </Card>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card title="WhatsApp setup log" description="The latest steps taken to connect this workspace.">
          {onboarding.length === 0 ? (
            <p className="text-sm text-muted">No entries yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {onboarding.map((o, i) => (
                <li key={i}>
                  {humanize(o.step)}: {o.status} <span className="text-muted">{when(o.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent audit entries">
          {audits.length === 0 ? (
            <p className="text-sm text-muted">No entries yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {audits.map((a) => (
                <li key={a.id}>
                  {auditActionLabel(a.action)} <span className="text-muted">{when(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <a className="mt-3 inline-flex min-h-10 items-center text-sm font-medium text-accent-ink underline underline-offset-2" href={`/admin/audit?tenantId=${id}`}>
            Open the full audit log for this workspace
          </a>
        </Card>
      </div>
    </AdminShell>
  );
}

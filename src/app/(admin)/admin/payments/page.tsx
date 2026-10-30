import { requireAdminPage } from "@/lib/admin/page";
import { listPayments } from "@/lib/admin/queries";
import { audit } from "@/lib/auth/audit";
import { AdminShell } from "@/components/admin/AdminShell";
import { adminPageMetadata } from "@/components/admin/helpers";
import { PaymentEventsTable, PaymentInvoicesTable } from "@/components/admin/AdminTables";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Payments");

export default async function PaymentsPage() {
  const admin = await requireAdminPage();
  await audit({ userId: admin.userId, action: "admin.view", meta: { page: "payments" } });
  const { events, invoices } = await listPayments();
  const needAttention = events.filter((e) => e.status === "error").length;

  return (
    <AdminShell email={admin.email} current="/admin/payments">
      <PageHeader title="Payments" description="The latest payment events from Razorpay and the latest invoices, across all workspaces." />
      <Card
        className="mb-8"
        title="Razorpay events"
        description={needAttention > 0 ? `${needAttention} of the latest ${events.length} events could not be handled. Open "Show problem" on those rows.` : "The 50 most recent events. Any that failed are flagged."}
        padded={false}
      >
        <PaymentEventsTable rows={events} />
      </Card>
      <Card title="Invoices" description="The 50 most recent invoices." padded={false}>
        <PaymentInvoicesTable rows={invoices} />
      </Card>
    </AdminShell>
  );
}

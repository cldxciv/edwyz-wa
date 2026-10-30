import { requireAdminPage } from "@/lib/admin/page";
import { getSpendSettings } from "@/lib/admin/spending";
import { audit } from "@/lib/auth/audit";
import { AdminShell } from "@/components/admin/AdminShell";
import { CeilingsForm } from "@/components/admin/CeilingsForm";
import { adminPageMetadata } from "@/components/admin/helpers";
import { PageHeader } from "@/components/app/PageHeader";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Spending settings");

/** /admin/spending/settings (docs/SPEND-CONTROLS-SPEC.md 8.3). */
export default async function SpendingSettingsPage() {
  const admin = await requireAdminPage();
  await audit({ userId: admin.userId, action: "admin.view", meta: { page: "spending-settings" } });
  const view = await getSpendSettings();
  return (
    <AdminShell email={admin.email} current="/admin/spending">
      <PageHeader
        title="Spending settings"
        description="Limits that apply to every workspace, the exchange rates used to read them in other currencies, and who sends owners their spending alerts. Each change asks for a reason and is saved in the audit log."
        breadcrumbs={[{ label: "Spending", href: "/admin/spending" }, { label: "Settings" }]}
      />
      <CeilingsForm view={view} />
    </AdminShell>
  );
}

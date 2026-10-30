import { requireAdminPage } from "@/lib/admin/page";
import { audit } from "@/lib/auth/audit";
import { getSettings } from "@/lib/platform-settings";
import { AdminShell } from "@/components/admin/AdminShell";
import { adminPageMetadata } from "@/components/admin/helpers";
import { SettingsForm } from "@/components/admin/SettingsForm";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Settings");

export default async function SettingsPage() {
  const admin = await requireAdminPage();
  await audit({ userId: admin.userId, action: "admin.view", meta: { page: "settings" } });
  const s = await getSettings();
  const pct = s.gstRateBps % 100 === 0 ? String(s.gstRateBps / 100) : (s.gstRateBps / 100).toFixed(2);

  return (
    <AdminShell email={admin.email} current="/admin/settings">
      <PageHeader title="Platform settings" description="These values apply to every workspace and to the invoices we issue." />
      {!s.sellerGstin && (
        <Alert tone="warn" title="Invoices are proforma until the seller GSTIN is set" className="mb-6">
          Until then they are labelled &quot;Proforma, not a tax invoice&quot;. Enter the GSTIN once Edwyz is GST registered.
        </Alert>
      )}
      <SettingsForm
        initial={{
          trialDays: s.trialDays, graceDays: s.graceDays, gstRatePercent: pct, invoicePrefix: s.invoicePrefix, sellerLegalName: s.sellerLegalName,
          sellerGstin: s.sellerGstin, sellerAddress: s.sellerAddress, sellerStateCode: s.sellerStateCode, supportEmail: s.supportEmail,
        }}
      />
    </AdminShell>
  );
}

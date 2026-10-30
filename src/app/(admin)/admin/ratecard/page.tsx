import { getRateCard } from "@/lib/admin/ratecard";
import { requireAdminPage } from "@/lib/admin/page";
import { audit } from "@/lib/auth/audit";
import { AdminShell } from "@/components/admin/AdminShell";
import { adminPageMetadata } from "@/components/admin/helpers";
import { RateCardEditor, type RateCardForm } from "@/components/admin/RateCardEditor";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = adminPageMetadata("Rate card");

export default async function RateCardPage() {
  const admin = await requireAdminPage();
  await audit({ userId: admin.userId, action: "admin.view", meta: { page: "ratecard" } });
  const card = await getRateCard();
  const initial: RateCardForm = card
    ? {
        currency: card.currency,
        note: card.note,
        rows: Object.entries(card.rates)
          .sort(([a], [b]) => (a === "*" ? 1 : b === "*" ? -1 : a.localeCompare(b)))
          .map(([country, r]) => ({ country, MARKETING: String(r.MARKETING ?? ""), UTILITY: String(r.UTILITY ?? ""), AUTHENTICATION: String(r.AUTHENTICATION ?? ""), SERVICE: String(r.SERVICE ?? "") })),
        scale: card.scale,
      }
    : { currency: "INR", note: "", rows: [] };

  return (
    <AdminShell email={admin.email} current="/admin/ratecard">
      <PageHeader title="WhatsApp rate card" description="The price list behind the cost estimate customers see before they send a broadcast. Customers pay Meta directly, so this is only an estimate." />
      {card ? (
        <Alert tone="info" title="Rate card is configured" className="mb-6">
          Last saved {card.updatedAt ? new Date(card.updatedAt).toLocaleString() : "at an unknown time"}. Countries without a row and no * row show as unpriced in estimates.
        </Alert>
      ) : (
        <Alert tone="warn" title="Unconfigured: estimates show no price" className="mb-6">
          No rate card is saved, so customers see &quot;Not available yet&quot; instead of a cost. Enter the prices from Meta&apos;s current WhatsApp pricing page below. Nothing is guessed or built in.
        </Alert>
      )}
      <RateCardEditor initial={initial} configured={!!card} />
    </AdminShell>
  );
}

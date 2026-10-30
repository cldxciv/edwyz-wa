"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, apiFetch, Button, Card, FormField, Input, toast } from "@/components/ui";

export type SettingsValues = {
  trialDays: number;
  graceDays: number;
  gstRatePercent: string;
  invoicePrefix: string;
  sellerLegalName: string;
  sellerGstin: string;
  sellerAddress: string;
  sellerStateCode: string;
  supportEmail: string;
};

export function SettingsForm({ initial }: { initial: SettingsValues }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries([...new FormData(e.currentTarget).entries()].map(([k, v]) => [k, String(v)]));
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch("/api/admin/settings", { method: "PUT", body });
      toast.success("Settings saved. New values apply from now on.");
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setFailure(message);
      toast.error(`We could not save the settings. ${message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card title="Trials and payments" description="How long new workspaces try the product, and how long we wait after a failed payment.">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Free trial length (days)" required hint="Starts when a workspace is created. Use 0 for no trial.">
            <Input name="trialDays" type="number" min={0} max={365} defaultValue={initial.trialDays} required />
          </FormField>
          <FormField label="Grace period after a failed payment (days)" required hint="Workspaces keep working during this time, then become read-only.">
            <Input name="graceDays" type="number" min={0} max={60} defaultValue={initial.graceDays} required />
          </FormField>
        </div>
      </Card>

      <Card title="Tax and invoices" description="Used on every invoice we issue.">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="GST rate (%)" required hint="For example 18.">
            <Input name="gstRatePercent" inputMode="decimal" defaultValue={initial.gstRatePercent} required />
          </FormField>
          <FormField label="Invoice number prefix" required hint="2 to 8 letters or numbers. The prefix starts every invoice number.">
            <Input name="invoicePrefix" defaultValue={initial.invoicePrefix} required />
          </FormField>
        </div>
      </Card>

      <Card title="Seller details" description="Who the invoice is from.">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Legal name" required>
            <Input name="sellerLegalName" defaultValue={initial.sellerLegalName} required autoComplete="organization" />
          </FormField>
          <FormField label="GST number (GSTIN)" optional hint="15 characters. Leave empty until Edwyz is GST registered. Invoices stay proforma until then.">
            <Input name="sellerGstin" defaultValue={initial.sellerGstin} maxLength={15} autoCapitalize="characters" />
          </FormField>
          <FormField label="Address" required className="sm:col-span-2">
            <Input name="sellerAddress" defaultValue={initial.sellerAddress} required autoComplete="street-address" />
          </FormField>
          <FormField label="GST state code" optional hint="Two digits from the GST state code list, like 29 for Karnataka.">
            <Input name="sellerStateCode" defaultValue={initial.sellerStateCode} maxLength={2} inputMode="numeric" />
          </FormField>
          <FormField label="Support email" required hint="Customers see this address when they need help.">
            <Input name="supportEmail" type="email" defaultValue={initial.supportEmail} required autoComplete="email" />
          </FormField>
        </div>
      </Card>

      {failure && <Alert tone="bad">{failure}</Alert>}
      <Button type="submit" loading={busy}>
        Save settings
      </Button>
    </form>
  );
}

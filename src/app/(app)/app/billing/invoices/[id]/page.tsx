import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/app/Icon";
import { InvoicePrintStyles } from "@/components/billing/PrintStyles";
import { InvoiceDocument } from "@/components/billing/InvoiceDocument";
import { PrintButton } from "@/components/billing/PrintButton";
import { getActor } from "@/lib/auth";
import { loadInvoiceView } from "@/lib/billing/invoice";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invoice" };

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const cookie = jar.getAll().map((c) => `${c.name}=${c.value}`).join("; ");
  const actor = await getActor(new Request("http://internal/", { headers: { cookie } })).catch(() => null);
  if (!actor) redirect("/login?next=/app/billing");
  if (!hasRole(actor, "admin")) notFound();

  const invoice = await prisma.invoice.findFirst({ where: { id: (await params).id, tenantId: actor.tenantId } });
  if (!invoice) notFound();
  const view = await loadInvoiceView(invoice);

  return (
    <div className="space-y-4">
      <InvoicePrintStyles />
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/app/billing" className="inline-flex min-h-10 items-center gap-1 rounded-control text-sm font-medium text-accent-ink underline-offset-2 hover:underline">
          <Icon name="chevron-right" className="h-3.5 w-3.5 rotate-180" />
          Back to billing
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <a href={`/api/billing/invoices/${invoice.id}/download`} download className="inline-flex min-h-10 items-center rounded-control border border-border bg-raised px-4 text-sm font-medium hover:bg-surface">
            Download as a file
          </a>
          <PrintButton />
        </div>
      </div>
      <InvoiceDocument view={view} />
    </div>
  );
}

import { formatMoney, type buildInvoiceView } from "@/lib/billing/invoice";
import { StatusPill } from "@/components/ui";
import { invoiceStatus } from "./helpers";

type View = ReturnType<typeof buildInvoiceView>;
const date = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "");

export function InvoiceDocument({ view }: { view: View }) {
  const { invoice: inv, seller, buyer, tax, proforma } = view;
  const rate = `${inv.gstRateBps / 100}%`;
  const half = `${inv.gstRateBps / 200}%`;
  return (
    <article aria-labelledby="invoice-title" className="mx-auto max-w-3xl rounded-card border border-border bg-raised p-5 shadow-raised sm:p-8 print:border-0 print:p-0 print:shadow-none">
      <h1 id="invoice-title" className="text-xl font-semibold">{view.title}</h1>
      <div className="mt-4 grid gap-6 text-sm sm:grid-cols-2">
        <div>
          <p className="font-semibold">{seller.name}</p>
          <p className="whitespace-pre-line text-muted">{seller.address}</p>
          {seller.gstin && <p className="text-muted">GSTIN: {seller.gstin}</p>}
        </div>
        <dl className="space-y-1 sm:text-right">
          <div>
            <dt className="inline text-muted">Invoice number: </dt>
            <dd className="inline font-mono">{inv.number}</dd>
          </div>
          <div>
            <dt className="inline text-muted">Date: </dt>
            <dd className="inline">{date(inv.issuedAt)}</dd>
          </div>
          <div>
            <dt className="inline text-muted">Status: </dt>
            <dd className="inline">
              <StatusPill status={inv.status} label={invoiceStatus(inv.status).label} tone={invoiceStatus(inv.status).tone} />
            </dd>
          </div>
        </dl>
      </div>
      <div className="mt-6 text-sm">
        <p className="font-semibold">Billed to</p>
        <p>{buyer.name ?? "Not provided"}</p>
        {buyer.address && <p className="text-muted">{buyer.address}</p>}
        {buyer.gstin && <p className="text-muted">GSTIN: {buyer.gstin}</p>}
      </div>
      <table className="mt-6 w-full text-sm">
        <caption className="sr-only">Invoice items and tax</caption>
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <th scope="col" className="py-2 font-medium">Description</th>
            <th scope="col" className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border">
            <td className="py-2">
              {inv.planName}
              {inv.periodStart && inv.periodEnd && (
                <span className="text-muted">
                  {" "}
                  ({date(inv.periodStart)} to {date(inv.periodEnd)})
                </span>
              )}
            </td>
            <td className="py-2 text-right">{formatMoney(inv.amountPaise, inv.currency)}</td>
          </tr>
          {tax.kind === "cgst_sgst" && (
            <>
              <tr>
                <td className="py-1 text-muted">CGST ({half})</td>
                <td className="py-1 text-right">{formatMoney(tax.cgstPaise, inv.currency)}</td>
              </tr>
              <tr>
                <td className="py-1 text-muted">SGST ({half})</td>
                <td className="py-1 text-right">{formatMoney(tax.sgstPaise, inv.currency)}</td>
              </tr>
            </>
          )}
          {tax.kind === "igst" && (
            <tr>
              <td className="py-1 text-muted">
                {proforma ? "Indicative GST" : "IGST"} ({rate})
              </td>
              <td className="py-1 text-right">{formatMoney(tax.igstPaise, inv.currency)}</td>
            </tr>
          )}
          <tr className="border-t border-border font-semibold">
            <td className="py-2">Total (inclusive of tax)</td>
            <td className="py-2 text-right">{formatMoney(inv.totalPaise, inv.currency)}</td>
          </tr>
        </tbody>
      </table>
      {proforma && <p className="mt-6 text-xs text-muted">This document is not a tax invoice. The seller has not added GST registration details yet.</p>}
    </article>
  );
}

import { escapeHtml as e } from "@/lib/email/templates";
import { formatMoney, type buildInvoiceView } from "./invoice";

type View = ReturnType<typeof buildInvoiceView>;

const date = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "");
const lines = (text: string) => e(text).replace(/\r?\n/g, "<br>");

const STYLE = `
body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5;margin:0;padding:24px;background:#fff}
main{max-width:760px;margin:0 auto}
h1{font-size:22px;margin:0 0 16px}
.grid{display:flex;flex-wrap:wrap;gap:24px;justify-content:space-between;font-size:14px}
.muted{color:#475569}
table{width:100%;border-collapse:collapse;margin-top:24px;font-size:14px}
th{text-align:left;color:#475569;font-weight:500;border-bottom:1px solid #cbd5e1;padding:8px 0}
td{padding:8px 0}
.r{text-align:right}
.total td{border-top:1px solid #cbd5e1;font-weight:700}
.note{margin-top:24px;font-size:12px;color:#475569}
@page{margin:14mm}
`;

/**
 * A self-contained invoice page: no scripts, no external assets, so it can be saved, emailed or printed anywhere.
 * Every dynamic value is escaped. Mirrors the in-app InvoiceDocument.
 */
export function renderInvoiceHtml(view: View): string {
  const { invoice: inv, seller, buyer, tax, proforma } = view;
  const rate = `${inv.gstRateBps / 100}%`;
  const half = `${inv.gstRateBps / 200}%`;
  const row = (label: string, paise: number) => `<tr><td class="muted">${e(label)}</td><td class="r">${e(formatMoney(paise, inv.currency))}</td></tr>`;
  const taxRows =
    tax.kind === "cgst_sgst"
      ? row(`CGST (${half})`, tax.cgstPaise) + row(`SGST (${half})`, tax.sgstPaise)
      : tax.kind === "igst"
        ? row(`${proforma ? "Indicative GST" : "IGST"} (${rate})`, tax.igstPaise)
        : "";
  const period = inv.periodStart && inv.periodEnd ? ` <span class="muted">(${e(date(inv.periodStart))} to ${e(date(inv.periodEnd))})</span>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(view.title)} ${e(inv.number)}</title><style>${STYLE}</style></head><body><main>
<h1>${e(view.title)}</h1>
<div class="grid">
<div><strong>${e(seller.name)}</strong><br><span class="muted">${lines(seller.address)}</span>${seller.gstin ? `<br><span class="muted">GSTIN: ${e(seller.gstin)}</span>` : ""}</div>
<div><span class="muted">Invoice number:</span> ${e(inv.number)}<br><span class="muted">Date:</span> ${e(date(inv.issuedAt))}<br><span class="muted">Status:</span> ${e(inv.status)}</div>
</div>
<p style="margin-top:24px;font-size:14px"><strong>Billed to</strong><br>${e(buyer.name ?? "Not provided")}${buyer.address ? `<br><span class="muted">${lines(buyer.address)}</span>` : ""}${buyer.gstin ? `<br><span class="muted">GSTIN: ${e(buyer.gstin)}</span>` : ""}</p>
<table><thead><tr><th>Description</th><th class="r">Amount</th></tr></thead><tbody>
<tr><td>${e(inv.planName)}${period}</td><td class="r">${e(formatMoney(inv.amountPaise, inv.currency))}</td></tr>
${taxRows}
<tr class="total"><td>Total (inclusive of tax)</td><td class="r">${e(formatMoney(inv.totalPaise, inv.currency))}</td></tr>
</tbody></table>
${proforma ? `<p class="note">This document is not a tax invoice. The seller has not added GST registration details yet.</p>` : ""}
</main></body></html>`;
}

export function invoiceFilename(number: string): string {
  return `invoice-${number.replace(/[^A-Za-z0-9-]+/g, "-")}.html`;
}

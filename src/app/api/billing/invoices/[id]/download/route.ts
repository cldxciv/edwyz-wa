import { getActor } from "@/lib/auth";
import { loadInvoiceView } from "@/lib/billing/invoice";
import { invoiceFilename, renderInvoiceHtml } from "@/lib/billing/invoice-html";
import { getInvoice } from "@/lib/billing/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Owners and admins download one of their own invoices as a standalone HTML file. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const invoice = await getInvoice(actor.tenantId, (await params).id);
    const html = renderInvoiceHtml(await loadInvoiceView(invoice));
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="${invoiceFilename(invoice.number)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

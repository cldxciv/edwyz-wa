import { getActor } from "@/lib/auth";
import { loadInvoiceView } from "@/lib/billing/invoice";
import { getInvoice } from "@/lib/billing/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const invoice = await getInvoice(actor.tenantId, (await params).id);
    return Response.json({ document: await loadInvoiceView(invoice) });
  } catch (e) {
    return errorResponse(e);
  }
}

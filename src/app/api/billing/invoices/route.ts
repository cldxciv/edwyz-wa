import { getActor } from "@/lib/auth";
import { listInvoices } from "@/lib/billing/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ invoices: await listInvoices(actor) });
  } catch (e) {
    return errorResponse(e);
  }
}

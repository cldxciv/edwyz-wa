import { getActor } from "@/lib/auth";
import { exportLeadsCsv } from "@/lib/leads/service";
import { errorResponse, requireRole } from "@/lib/tenancy";
import { filtersFrom } from "../filters";

export const dynamic = "force-dynamic";

/** GET (admin) -> text/csv with the same filters as the list. Cells starting with = + - @ are neutralised. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const csv = await exportLeadsCsv(actor.tenantId, filtersFrom(new URL(request.url).searchParams));
    return new Response(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="leads.csv"', "Cache-Control": "no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

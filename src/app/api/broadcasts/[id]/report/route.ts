import { getActor } from "@/lib/auth";
import { broadcastReportCsv } from "@/lib/broadcasts/report";
import { download } from "@/lib/reports/export";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Per-broadcast download: one row per person with status, failure code and reason. ?only=problems keeps just the people who did not get it. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const only = new URL(request.url).searchParams.get("only") === "problems" ? "problems" : "all";
    const { stream, filename } = await broadcastReportCsv(actor, (await params).id, only);
    return download(stream, filename, "text/csv; charset=utf-8");
  } catch (e) {
    return errorResponse(e);
  }
}

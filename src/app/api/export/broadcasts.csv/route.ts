import { broadcastsCsv, broadcastsJson, download, wantsJson } from "@/lib/reports/export";
import { adminActor } from "@/lib/reports/http";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET (owner or admin). Add ?format=json for a JSON array instead of a spreadsheet. */
export async function GET(request: Request) {
  try {
    const actor = await adminActor(request);
    if (wantsJson(request)) return download(broadcastsJson(actor), "broadcasts.json", "application/json; charset=utf-8");
    return download(broadcastsCsv(actor), "broadcasts.csv", "text/csv; charset=utf-8");
  } catch (e) {
    return errorResponse(e);
  }
}

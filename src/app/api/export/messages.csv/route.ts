import { download, messagesCsv, messagesJson, wantsJson } from "@/lib/reports/export";
import { adminActor } from "@/lib/reports/http";
import { parseRange } from "@/lib/reports/range";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET (owner or admin) with from, to and tz. Add ?format=json for a JSON array instead of a spreadsheet. */
export async function GET(request: Request) {
  try {
    const actor = await adminActor(request);
    const p = new URL(request.url).searchParams;
    const range = parseRange({ from: p.get("from"), to: p.get("to"), tz: p.get("tz") });
    if (wantsJson(request)) return download(messagesJson(actor, range), "messages.json", "application/json; charset=utf-8");
    return download(messagesCsv(actor, range), "messages.csv", "text/csv; charset=utf-8");
  } catch (e) {
    return errorResponse(e);
  }
}

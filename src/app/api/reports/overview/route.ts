import { getActor } from "@/lib/auth";
import { buildOverview } from "@/lib/reports/metrics";
import { parseRange } from "@/lib/reports/range";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const p = new URL(request.url).searchParams;
    const range = parseRange({ from: p.get("from"), to: p.get("to"), tz: p.get("tz") });
    const overview = await buildOverview(actor.tenantId, actor.role, range);
    return Response.json(overview, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

import { getActor } from "@/lib/auth";
import { parseIsoDate } from "@/lib/broadcasts/schedule";
import { listCalendar } from "@/lib/broadcasts/scheduling";
import { errorResponse } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const params = new URL(request.url).searchParams;
    const items = await listCalendar(actor, parseIsoDate(params.get("from"), "from"), parseIsoDate(params.get("to"), "to"));
    return Response.json({ items }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

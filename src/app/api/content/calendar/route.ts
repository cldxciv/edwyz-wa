import { getActor } from "@/lib/auth";
import { noStore } from "@/lib/content/http";
import { calendarRange } from "@/lib/content/service";
import { errorResponse } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const params = new URL(request.url).searchParams;
    return Response.json({ items: await calendarRange(actor, params.get("from"), params.get("to")) }, { headers: noStore });
  } catch (e) {
    return errorResponse(e);
  }
}

import { getActor } from "@/lib/auth";
import { estimateBroadcast } from "@/lib/broadcasts/service";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Audience size, cost by country from the admin rate card, value coverage and the daily-limit outlook. Prices are never invented. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    return Response.json(await estimateBroadcast(actor, (await params).id), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

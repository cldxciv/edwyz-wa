import { getActor } from "@/lib/auth";
import { broadcastFunnel } from "@/lib/broadcasts/overview";
import { errorResponse } from "@/lib/tenancy";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    return Response.json({ funnel: await broadcastFunnel(actor, (await params).id) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

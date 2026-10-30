import { getActor } from "@/lib/auth";
import { sessionStats } from "@/lib/chatbots/service";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { days, total, counts: { active, waiting, completed, handed_off, expired }, completionPercent, handoffPercent, expiredPercent }. Any member can read. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    return Response.json(await sessionStats(actor.tenantId, (await params).id), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

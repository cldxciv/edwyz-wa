import { getActor } from "@/lib/auth";
import { getCampaign } from "@/lib/ads/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ campaign: await getCampaign(actor.tenantId, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}

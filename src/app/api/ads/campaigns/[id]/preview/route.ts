import { getActor } from "@/lib/auth";
import { previewCampaign } from "@/lib/ads/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json(await previewCampaign(actor, (await params).id));
  } catch (e) {
    return errorResponse(e);
  }
}

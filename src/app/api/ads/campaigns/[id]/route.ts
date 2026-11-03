import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { getCampaignView, updateCampaignDraft } from "@/lib/ads/service";
import { readJsonObject } from "@/lib/contacts/http";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ campaign: await getCampaignView(actor.tenantId, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Edits a draft that is not on Meta yet. The body is the same as POST /api/ads/campaigns. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json(await updateCampaignDraft(actor, (await params).id, await readJsonObject(request)));
  } catch (e) {
    return errorResponse(e);
  }
}

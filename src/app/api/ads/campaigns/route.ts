import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { createCampaignDraft, listCampaigns, parseDraftInput } from "@/lib/ads/service";
import { readJsonObject } from "@/lib/contacts/http";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ campaigns: await listCampaigns(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const input = parseDraftInput(await readJsonObject(request));
    return Response.json(await createCampaignDraft(actor, input), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

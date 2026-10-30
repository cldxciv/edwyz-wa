import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { activateCampaign } from "@/lib/ads/service";
import { readJsonObject } from "@/lib/contacts/http";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    const campaign = await activateCampaign(actor, (await params).id, { confirm: body.confirm, confirmedTotalMinor: body.confirmedTotalMinor }, "activate");
    return Response.json({ campaign });
  } catch (e) {
    return errorResponse(e);
  }
}

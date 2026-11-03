import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { changeCampaignEnd } from "@/lib/ads/service";
import { readJsonObject } from "@/lib/contacts/http";
import { errorResponse, requireRole } from "@/lib/tenancy";

/**
 * POST { endsAt } (admin, ISO date). Moves the end date of a campaign that is on Meta. An earlier end always goes ahead; a
 * later one extends spending, so it is checked against the workspace's spending limits first.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    return Response.json({ campaign: await changeCampaignEnd(actor, (await params).id, { endsAt: body.endsAt }) });
  } catch (e) {
    return errorResponse(e);
  }
}

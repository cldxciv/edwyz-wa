import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { changeCampaignBudget } from "@/lib/ads/service";
import { readJsonObject } from "@/lib/contacts/http";
import { errorResponse, requireRole } from "@/lib/tenancy";

/**
 * POST { dailyBudgetMinor, adSetId? } (admin). Changes the daily budget of a campaign that is on Meta. A cut always goes
 * ahead; a raise is checked against the workspace's spending limits first and refused with the room that is left.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    return Response.json(await changeCampaignBudget(actor, (await params).id, { dailyBudgetMinor: body.dailyBudgetMinor, adSetId: body.adSetId }));
  } catch (e) {
    return errorResponse(e);
  }
}

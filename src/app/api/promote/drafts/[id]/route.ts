import { refuseCrossSite } from "@/lib/promote/geo";
import { pageLang } from "@/lib/promote/copy";
import { promoteRoute } from "@/lib/promote/route-guard";
import { discardPromotionDraft, getPromotionDraft, promoteErrorResponse, updatePromotionDraft } from "@/lib/promote/service";
import { spendJson } from "@/lib/spend/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const noStore = { "cache-control": "no-store" };

/**
 * GET /api/promote/drafts/[id] (get_promotion): the draft as the page and Eddy read it: { campaignId, updatedAt, status, surface,
 * editable, discardedAt, currency, draft, caption }. Team members (agents) may read; another site's page may not.
 */
export const GET = promoteRoute<Ctx>("read", async ({ actor }, request, { params }) => {
  refuseCrossSite(request);
  const { id } = await params;
  try {
    return spendJson(await getPromotionDraft(actor, id), { headers: noStore });
  } catch (e) {
    return promoteErrorResponse(e, request);
  }
});

/**
 * PATCH /api/promote/drafts/[id] (update_promotion_draft, undoable): { expectedUpdatedAt, set: {<draft path>: value},
 * categoryAnswer? }, draft paths only (promote/draft-paths.ts), all or nothing. 409 { code: "stale", error: "Someone else changed
 * this draft. Showing the latest.", latest } when the draft changed since expectedUpdatedAt; a save refused for any other reason
 * leaves expectedUpdatedAt valid. 400 { code: category_question } until the member answers it here (categoryAnswer, or
 * set.specialAdCategory); 400 { code: goal_not_offered | places_not_offered } for a goal or place the catalog doesn't offer.
 * { restore: true } brings back a draft discarded in the last 15 minutes (the undo of DELETE). Answers the draft and `before`
 * (Undo replays it).
 */
export const PATCH = promoteRoute<Ctx>("write", async ({ actor, access }, request, { params }) => {
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const lang = pageLang(body?.lang, access.pageLangs);
    return spendJson(await updatePromotionDraft(actor, id, body, { lang, access }), { headers: noStore });
  } catch (e) {
    return promoteErrorResponse(e, request);
  }
});

/**
 * DELETE /api/promote/drafts/[id] (discard_promotion_draft, undoable): a soft discard of a draft that is not on Meta yet, of any
 * surface, restorable for 15 minutes with PATCH { restore: true }. Answers { campaignId, discardedAt, restorableUntil }.
 */
export const DELETE = promoteRoute<Ctx>("write", async ({ actor }, request, { params }) => {
  const { id } = await params;
  try {
    return spendJson(await discardPromotionDraft(actor, id), { headers: noStore });
  } catch (e) {
    return promoteErrorResponse(e, request);
  }
});

import { pageLang } from "@/lib/promote/copy";
import { promoteRoute } from "@/lib/promote/route-guard";
import { createPromotionDraft, promoteErrorResponse } from "@/lib/promote/service";
import { spendJson } from "@/lib/spend/http";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * POST /api/promote/drafts (Eddy's create_promotion_draft, undoable; docs/IG-PAGE-ADS-SPEC.md 3.1, 4.8, D28, PRM-09).
 * Body: { goal?, days?, placements?: auto|instagram|facebook, nearShop?, source?: {kind, ref, caption, postKind, hasLink,
 * postTargetId}, pageAssetId?, igAssetId?, dailyMinor?, set?: {<draft path>: value}, form?, categoryAnswer?, lang? }. Every
 * other setting comes from the 3.1 smart defaults. 201 { campaignId, updatedAt, draft, chips, ... }. 409 { code:
 * no_spending_account | choose_page | connect_page, chips } when a draft can't be made yet, 409 { code: no_goals } when no goal
 * is open to this member; 400 { code: goal_not_offered, goals } or { code: places_not_offered } for a goal or chosen place the
 * catalog doesn't offer (PROMOTE_GOALS, D22); 400 { code: category_question, categories } when the text suggests a special ad
 * category: the member answers with { categoryAnswer: "none" | <category> } (a `set.specialAdCategory` in this body is not an
 * answer). Admins and owners, same origin; agents get 403; 404 while Promote is hidden. Nothing is sent to Meta.
 */
export const POST = promoteRoute("write", async ({ actor, access }, request) => {
  const body = (await request.json().catch(() => undefined)) as unknown;
  if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) throw new HttpError(400, "Send the draft as JSON.");
  try {
    const lang = pageLang((body as { lang?: unknown } | undefined)?.lang, access.pageLangs);
    const draft = await createPromotionDraft(actor, body, { surface: "promote", lang, access });
    return spendJson(draft, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return promoteErrorResponse(e, request);
  }
});

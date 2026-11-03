import { pageLang } from "@/lib/promote/copy";
import { promoteRoute } from "@/lib/promote/route-guard";
import { promoteErrorResponse, savePromotionPaused, startStatus } from "@/lib/promote/service";
import { spendJson } from "@/lib/spend/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/promote/drafts/[id]/save-paused (save_promotion_paused, a confirm card: X) { materialHash }. "Save without starting":
 * the media, the lead form and the PAUSED creates on Meta (resuming a launch that failed part-way), and no activation, so
 * nothing spends. 200 saved only once the campaign is paused on Meta. Admins and owners, same origin; agents get 403. 409 changed
 * when the card is out of date. Under SPEND_DRY_RUN Meta answers with fake ids.
 */
export const POST = promoteRoute<{ params: Promise<{ id: string }> }>("write", async ({ actor, access, dryRun }, request, { params }) => {
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const outcome = await savePromotionPaused(actor, id, body, { access, dryRun, lang: pageLang(body?.lang, access.pageLangs) });
    return spendJson(outcome, { status: startStatus(outcome), headers: { "cache-control": "no-store" } });
  } catch (e) {
    return promoteErrorResponse(e, request);
  }
});

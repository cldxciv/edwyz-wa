import { pageLang } from "@/lib/promote/copy";
import { promoteRoute } from "@/lib/promote/route-guard";
import { promoteErrorResponse, reviewPromotion } from "@/lib/promote/service";
import { spendJson } from "@/lib/spend/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/promote/drafts/[id]/review (review_promotion; docs/IG-PAGE-ADS-SPEC.md 6.5, D26). The Start card, the same one Eddy
 * shows: facts (every text, link and first message verbatim; a post's caption as untrusted text), warnings, the cost, readiness
 * failures, the policy pre-flight (with `policy.unanswered`, the special categories still to answer), preview references,
 * typedConfirmRequired and materialHash. It writes nothing except a startMode 'now' draft's dates, recomputed in the ad
 * account's zone (3.1a), which keeps the draft's updatedAt. A goal or chosen place the catalog doesn't offer blocks the card.
 * Admins and owners, same origin.
 */
export const POST = promoteRoute<{ params: Promise<{ id: string }> }>("write", async ({ actor, access }, request, { params }) => {
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as { lang?: unknown } | null;
    const card = await reviewPromotion(actor, id, { lang: pageLang(body?.lang, access.pageLangs), access });
    return spendJson({ card }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return promoteErrorResponse(e, request);
  }
});

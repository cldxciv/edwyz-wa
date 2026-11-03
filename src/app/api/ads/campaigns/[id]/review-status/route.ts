import { userPref } from "@/lib/eddy/settings";
import { pageLang } from "@/lib/promote/copy";
import { explainCampaignReview } from "@/lib/promote/review";
import { promoteRoute } from "@/lib/promote/route-guard";
import { isPromoteLang, type PromoteLang } from "@/lib/promote/types";
import type { Actor } from "@/lib/tenancy";

type Context = { params: Promise<{ id: string }> };

/** The member's Eddy language; Auto (or none saved) is English. */
async function eddyLang(actor: Actor): Promise<PromoteLang> {
  const pref = await userPref(actor.tenantId, actor.userId).catch(() => null);
  return isPromoteLang(pref?.language) ? pref.language : "en";
}

/**
 * GET ?for=page|card (docs/IG-PAGE-ADS-SPEC.md 3.9, 4.8 explain_ad_rejection, 4.10, PRM-08): why Meta did not approve the
 * campaign's ads, in plain words with fix kinds, the per-placement line, the special-category fix, appeal_ad as an Opens Meta
 * fix, account restrictions with account_quality, and [Pause and free ₹X] where every ad of an ad set is not approved.
 * Cards use the member's Eddy language; pages use English until PROMOTE_PAGE_LANGS allows more (D23). Admins and owners only,
 * and 404 while the feature is hidden (PROMOTE_ENABLED=off). Classified by the /api/ads/** entry of not-exposed.ts.
 */
export const GET = promoteRoute<Context>(
  "read",
  async ({ actor, access }, request, { params }) => {
    const { id } = await params;
    const card = new URL(request.url).searchParams.get("for") === "card";
    const member = await eddyLang(actor);
    const lang = card ? member : pageLang(member, access.pageLangs);
    const review = await explainCampaignReview(actor.tenantId, id, { lang });
    return Response.json({ review }, { headers: { "cache-control": "no-store" } });
  },
  { minRole: "admin" },
);

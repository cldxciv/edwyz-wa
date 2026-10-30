import { getActor } from "@/lib/auth";
import { numberLimits } from "@/lib/broadcasts/overview";
import { meterView } from "@/lib/broadcasts/limits";
import { scalingHint } from "@/lib/broadcasts/throttle";
import { normalizeTier, tierLabel, tierPeople } from "@/lib/messaging-limit";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Each connected number with the messaging limit of its business portfolio and how much of it the last 24 hours used. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const rows = await numberLimits(actor);
    const numbers = rows.map((n) => {
      const tier = normalizeTier(n.portfolioTier ?? n.messagingLimitTier);
      const people = tierPeople(tier);
      return {
        id: n.id,
        displayPhone: n.displayPhone,
        verifiedName: n.verifiedName,
        qualityRating: n.qualityRating,
        tier,
        tierLabel: tierLabel(tier),
        dailyLimit: people === null || people === Infinity ? null : people,
        unlimited: people === Infinity,
        sentLast24h: n.sentLast24h,
        meter: meterView(tier, n.sentLast24h).label,
        hint: scalingHint(tier),
      };
    });
    return Response.json({ numbers }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

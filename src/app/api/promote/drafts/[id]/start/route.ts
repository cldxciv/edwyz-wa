import { pageLang } from "@/lib/promote/copy";
import { promoteRoute } from "@/lib/promote/route-guard";
import { promoteErrorResponse, startPromotion, startStatus } from "@/lib/promote/service";
import { createLimiter } from "@/lib/ratelimit";
import { spendJson } from "@/lib/spend/http";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** 10 starts an hour per workspace (docs/IG-PAGE-ADS-SPEC.md 4.8). Every tap counts: each may reach Meta. */
const starts = createLimiter(10, 3_600_000, "promote-start");

const TOO_MANY = "That's a lot of starts in an hour. Wait a while, then try again.";

/**
 * POST /api/promote/drafts/[id]/start (start_promotion, a confirm card: S:ads, X) { confirmedTotalMinor, confirmedWorstCaseMinor,
 * materialHash, typedWorstCase? }. One tap (D4): a card that can't start is refused before anything is written; then the fix
 * copy's original paused, the media, the lead form, the PAUSED creates (resuming a launch that failed part-way), a read-back of
 * what was launched, and the guarded activation with the confirmed total. Admins and owners within the limits, same origin, only
 * while Start is open (train P3); agents get 403; 10 starts an hour per workspace. Answers { state, ... }: 200 started; 409
 * changed (with a new card; also when an edit landed before the launch, which leaves it PAUSED), typed_confirm, refused (Phase
 * 0's code, copy and fixes), awaiting_approval, demo, not_ready, media_not_ready; 202 unknown; 502 failed. Under SPEND_DRY_RUN
 * Meta answers with fake ids.
 */
export const POST = promoteRoute(
  "write",
  async ({ actor, access, dryRun }, request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    if (!(await starts.consumeShared(actor.tenantId))) throw new HttpError(429, TOO_MANY);
    try {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const outcome = await startPromotion(actor, id, body, { access, dryRun, lang: pageLang(body?.lang, access.pageLangs), via: "page" });
      return spendJson(outcome, { status: startStatus(outcome), headers: { "cache-control": "no-store" } });
    } catch (e) {
      return promoteErrorResponse(e, request);
    }
  },
  { start: true },
);

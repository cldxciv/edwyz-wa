import { readJsonObject } from "@/lib/contacts/http";
import { pickWinner, undoWinner } from "@/lib/promote/abtest";
import { promoteRoute } from "@/lib/promote/route-guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/promote/tests/[id]/winner {adSetId} (pick_winning_version; docs/IG-PAGE-ADS-SPEC.md 3.8, 4.8, PRM-12): [Keep B,
 * pause the others]. Same origin, admins and owners (agents get 403). A lowering: the other versions are paused through the
 * Spend Book's recordLowering, never refused and working while spending is stopped. The answer carries the undo, an activate
 * card, because turning a version back on spends again. Under SPEND_DRY_RUN=1 the ads client answers without calling Meta.
 */
export const POST = promoteRoute<Ctx>("write", async ({ actor }, request, { params }) => {
  const { id } = await params;
  const body = await readJsonObject(request);
  return Response.json(await pickWinner(actor, id, body.adSetId), { headers: { "cache-control": "no-store" } });
});

/**
 * DELETE /api/promote/tests/[id]/winner {confirm: true}: the undo card of [Keep B, pause the others]. Same origin, admins and
 * owners, and only while Start is open, because it turns the paused versions back on: each one through reserveAds
 * resume_adset, checked against the limits. All or nothing: a refusal leaves the kept version kept and says why.
 */
export const DELETE = promoteRoute<Ctx>(
  "write",
  async ({ actor }, request, { params }) => {
    const { id } = await params;
    const body = await readJsonObject(request);
    return Response.json(await undoWinner(actor, id, body.confirm), { headers: { "cache-control": "no-store" } });
  },
  { start: true },
);

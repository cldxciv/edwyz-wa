import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonObject } from "@/lib/contacts/http";
import { spendEnforceMode } from "@/lib/spend/flags";
import { spendErrorResponse, spendJson } from "@/lib/spend/http";
import { activityCsv, isActivityFilter, listActivity, observeRefusalsSince, undoLedgerRow, type ActivityFilter } from "@/lib/spend/summary";
import { HttpError } from "@/lib/tenancy";

/*
 * The spending activity table (docs/SPEND-CONTROLS-SPEC.md 8.1 ActivityTable, 9.1, 9.2; WP-16). Owners and admins only.
 *
 * GET  ?filter=all|ads|whatsapp|ai|assistants|safety&cursor=<seq>&limit=1-100: newest first, one row per decision, seq cursor.
 *      &format=csv: the same rows as a CSV file (at most 5,000), formula-safe.
 * POST { undo: <row id> }: undoes the change with its recipe, within 14 days. Undoing a raise is a lowering and always
 *      allowed (owner and admin); undoing a lowering is a raise, owner only, checked against the paywall and then reserveAds
 *      or the allowance rules, so it can be refused with the normal copy. The answer carries observe mode's would-refuse flag.
 */

export const dynamic = "force-dynamic";

function filterOf(value: string | null): ActivityFilter {
  if (value === null || value === "") return "all";
  if (!isActivityFilter(value)) throw new HttpError(400, "Choose ads, WhatsApp, AI, assistants or safety stops.");
  return value;
}

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const q = new URL(request.url).searchParams;
    const filter = filterOf(q.get("filter"));
    if (q.get("format") === "csv") {
      const csv = await activityCsv(actor, filter);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="spending-activity-${new Date().toISOString().slice(0, 10)}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new HttpError(400, "Show between 1 and 100 rows at a time.");
    const page = await listActivity(actor, { filter, cursor: q.get("cursor"), limit });
    return spendJson(page, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

export async function POST(request: Request) {
  const started = new Date();
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonObject(request);
    if (typeof body.undo !== "string" || !body.undo) throw new HttpError(400, "Choose a change to undo.");
    const result = await undoLedgerRow(actor, body.undo);
    const observe = await observeRefusalsSince(actor.tenantId, started);
    return spendJson({ ...result, enforce: spendEnforceMode(), wouldRefuse: observe.wouldRefuse, wouldRefuseReasons: observe.reasons });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

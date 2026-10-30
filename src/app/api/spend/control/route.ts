import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { assertTenantCanWrite } from "@/lib/billing";
import { readJsonObject } from "@/lib/contacts/http";
import { getControl } from "@/lib/spend/control";
import { spendEnforceMode } from "@/lib/spend/flags";
import { spendErrorResponse, spendJson } from "@/lib/spend/http";
import { controlPatchRaises, getControlSettings, observeRefusalsSince, parseControlPatch, updateControlSettings } from "@/lib/spend/summary";
import { HttpError } from "@/lib/tenancy";

/*
 * GET and PUT /api/spend/control: the owner's spending settings (docs/SPEND-CONTROLS-SPEC.md 8.1, 3.1, 5.8, 7.3; WP-16).
 * Owner only, both ways: an admin or a team member gets 403.
 *
 * PUT body (every field optional except version):
 *   { version, approverUserIds?: string[] (admins of the workspace), approvalTtlHours?: 1-48, timezone?: IANA zone (takes effect
 *     at the next local midnight), targetCostPerLeadMinor?: decimal string | null, breakersMayPauseHumanCampaigns?: boolean,
 *     digestEnabled?: boolean, spendingAdAccountAssetId?: string, offboardChoice?: "keep" | "restore" | "remove", reason? }
 * Changing the spending ad account while Meta's limit is on (or waiting for the owner) on the old one needs the old account's
 * offboarding choice first (409 otherwise); the choice is queued as spend.metacap.offboard and the new account gets a re-plan.
 * Choosing a spending ad account lets new ads start, so only that part checks the paywall (4.17). Ledgered as control.change.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    if (actor.role !== "owner") throw new HttpError(403, "Only the owner can change these settings.");
    return spendJson({ control: await getControlSettings(actor) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

export async function PUT(request: Request) {
  const started = new Date();
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonObject(request);
    const { patch, version } = parseControlPatch(body);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) || undefined : undefined;
    if (actor.role === "owner" && controlPatchRaises(patch, await getControl(actor.tenantId, { prune: false }))) await assertTenantCanWrite(actor.tenantId);
    const control = await updateControlSettings(actor, patch, version, { reason });
    const observe = await observeRefusalsSince(actor.tenantId, started);
    return spendJson({ control, enforce: spendEnforceMode(), wouldRefuse: observe.wouldRefuse, wouldRefuseReasons: observe.reasons });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonObject } from "@/lib/contacts/http";
import { parseLimitInput, spendErrorResponse, spendJson } from "@/lib/spend/http";
import { observeRefusalsSince, saveAllowance, spendSummary } from "@/lib/spend/summary";
import { spendEnforceMode } from "@/lib/spend/flags";
import type { Pot } from "@/lib/spend/types";
import { HttpError } from "@/lib/tenancy";

/*
 * PUT /api/spend/allowances (docs/SPEND-CONTROLS-SPEC.md 8.1, 2.3.8, 4.17; WP-16). Body:
 *   { pot: "ads" | "messaging" | "ai", dailyLimitMinor?, monthlyLimitMinor?, currency?, version, reason? }
 * Amounts are decimal strings of minor units; null or "" means "Not set"; a field left out stays as it is.
 *
 * - The per-field rule (setAllowances): the owner raises, sets a number where it was Not set, clears a number and changes the
 *   currency. An admin only lowers a number that exists: anything else is 403 "Only the owner can raise a limit. You can
 *   lower it." A team member gets 403. A stale version is 409 "Someone else changed these limits. Reload to see the latest."
 * - Paywall (4.17): this path is exempt in getActor; raising operations check it here (402 when locked). Lowering works in
 *   every workspace state, including locked and suspended.
 * - Every attempt, allowed or refused, is ledgered (allowance.change). A change to the ads monthly limit queues the
 *   Meta-limit re-plan. The answer carries the fresh summary, the enforce mode and observe mode's would-refuse flag.
 */

const POTS: readonly Pot[] = ["ads", "messaging", "ai"];

export async function PUT(request: Request) {
  const started = new Date();
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonObject(request);
    if (!POTS.includes(body.pot as Pot)) throw new HttpError(400, "Choose ads, WhatsApp or AI.");
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 0) throw new HttpError(400, "Reload the page and try again.");
    if (body.currency !== undefined && typeof body.currency !== "string") throw new HttpError(400, "Use a three-letter currency code such as INR.");
    const patch = {
      pot: body.pot as Pot,
      dailyLimitMinor: parseLimitInput(body.dailyLimitMinor, "daily limit"),
      monthlyLimitMinor: parseLimitInput(body.monthlyLimitMinor, "monthly limit"),
      ...(typeof body.currency === "string" ? { currency: body.currency.trim().toUpperCase() } : {}),
    };
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) || undefined : undefined;
    const saved = await saveAllowance(actor, patch, version, { reason });
    const observe = await observeRefusalsSince(actor.tenantId, started);
    return spendJson({
      saved,
      enforce: spendEnforceMode(),
      wouldRefuse: observe.wouldRefuse,
      wouldRefuseReasons: observe.reasons,
      summary: await spendSummary(actor),
    });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

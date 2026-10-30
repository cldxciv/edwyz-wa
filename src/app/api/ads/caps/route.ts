import { auditStrict } from "@/lib/ads/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { assertCapCurrencyChangeable, getCaps, parseCapsInput, setCaps } from "@/lib/ads/caps";
import { readJsonObject } from "@/lib/contacts/http";
import { spendErrorResponse } from "@/lib/spend/http";
import { requireRole } from "@/lib/tenancy";

/*
 * The CapPanel's API (docs/SPEND-CONTROLS-SPEC.md 4.8). The contract is unchanged: GET for admins and owners, PUT for owners
 * only, and the number keeps its OLD meaning, "the most your daily budgets may add up to" (C). PUT C stores the ads daily
 * limit as ceil175(C) (Meta can spend 75% more than a daily budget on a busy day); GET answers floor(4 x limit / 7), the largest
 * C whose worst case fits, so a value round-trips exactly. Phase 1 removes this route in favour of /api/spend/allowances.
 */

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ caps: await getCaps(actor.tenantId) });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "owner");
    const body = await readJsonObject(request);
    const requested = { maxDailyBudgetMinor: body.maxDailyBudgetMinor, currency: body.currency };
    const next = parseCapsInput(requested);
    await assertCapCurrencyChangeable(actor.tenantId, next.currency);
    const before = await getCaps(actor.tenantId);
    await auditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: "ads.caps.updated", meta: { from: before.maxDailyBudgetMinor, fromCurrency: before.currency, maxDailyBudgetMinor: next.max, currency: next.currency } });
    const caps = await setCaps(actor.tenantId, requested, { type: "user", userId: actor.userId, role: actor.role });
    return Response.json({ caps });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

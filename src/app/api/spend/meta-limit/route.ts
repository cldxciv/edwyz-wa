import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { assertTenantCanWrite } from "@/lib/billing";
import { readJsonObject } from "@/lib/contacts/http";
import { getControl } from "@/lib/spend/control";
import { spendErrorResponse, spendJson } from "@/lib/spend/http";
import { getMetaLimitDTO, metaLimitConsentScreen, turnOffMetaLimit, turnOnMetaLimit, useMyEdwyzLimit } from "@/lib/spend/metacap/consent";
import { isOffboardChoice, offboardChoicesFor, onSpendingAccountChange, saveOffboardChoices } from "@/lib/spend/metacap/offboard";
import { replanTenant } from "@/lib/spend/metacap/sync";
import type { SpendActor } from "@/lib/spend/types";
import { HttpError, requireRole } from "@/lib/tenancy";

/*
 * GET, POST and PUT /api/spend/meta-limit: the "Spending limit on Meta" card (docs/SPEND-CONTROLS-SPEC.md 5.1, 5.6, 5.8, 4.17).
 *
 * GET (every member): { metaLimit: MetaLimitDTO | null, consent (owner, when it can be turned on), offboard (owner and admin) }.
 * POST or PUT { action, ... } (same origin):
 * - "turn_on" { agreed | consent: true, textVersion: "meta-cap-v1" }: the owner only. A raise, so the paywall applies. An admin
 *   gets 403 ("Only the workspace owner can turn on Meta's spending limit. We've let them know.") and the owner a task.
 * - "turn_off" { choice: "keep" | "restore" | "remove" }: the owner only; works in every workspace state (handing control back).
 * - "use_my_limit": the owner lets Edwyz raise a lower limit set in Meta back to the plan. A raise: the paywall applies.
 * - "resync": the owner or an admin re-reads and re-plans now (never raises while the workspace is paused).
 * - "offboard_choice" { trigger: "close" | "account_change", choices: { [adAccountAssetId]: choice } or choice, newAdAccountAssetId? }:
 *   the owner's 5.8 choice before closing the workspace (stored; applied before the Meta revoke and before erasure) or before
 *   changing the spending ad account (applied now on the old account).
 * Lowering and withdrawing work when the workspace is locked or suspended; /api/spend/ is exempt from getActor's paywall and
 * only the raising actions above call assertTenantCanWrite.
 */

export const dynamic = "force-dynamic";

const who = (actor: { userId: string; role: "owner" | "admin" | "agent" }): SpendActor => ({ type: "user", userId: actor.userId, role: actor.role });

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const metaLimit = await getMetaLimitDTO(actor.tenantId, actor.role);
    const consent = actor.role === "owner" && metaLimit?.canTurnOn ? await metaLimitConsentScreen(actor.tenantId) : null;
    const offboard = actor.role === "agent" ? [] : await offboardChoicesFor(actor.tenantId);
    return spendJson({ metaLimit, consent, offboard }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

async function change(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonObject(request);
    const action = body.action;
    const me = { userId: actor.userId, role: actor.role };
    switch (action) {
      case "turn_on": {
        // An admin's request only marks it as waiting for the owner (403 below), which raises nothing.
        if (actor.role === "owner") await assertTenantCanWrite(actor.tenantId);
        const agreed = body.agreed === true || body.consent === true;
        const metaLimit = await turnOnMetaLimit(actor.tenantId, me, { adAccountAssetId: body.adAccountAssetId, agreed, textVersion: body.textVersion });
        return spendJson({ metaLimit });
      }
      case "turn_off": {
        const out = await turnOffMetaLimit(actor.tenantId, me, body.choice ?? "keep");
        return spendJson({ metaLimit: out.metaLimit, result: out.result, text: out.result.text });
      }
      case "use_my_limit": {
        if (actor.role !== "owner") throw new HttpError(403, "Only the workspace owner can raise Meta's spending limit.");
        await assertTenantCanWrite(actor.tenantId);
        const results = await useMyEdwyzLimit(actor.tenantId, me);
        return spendJson({ metaLimit: await getMetaLimitDTO(actor.tenantId, actor.role), results: results.map((r) => ({ status: r.status, reason: r.reason ?? null })) });
      }
      case "resync": {
        requireRole(actor, "admin");
        const control = await getControl(actor.tenantId, { prune: false });
        if (!control.spendingAdAccountAssetId) throw new HttpError(409, "Choose your spending ad account first.");
        const results = await replanTenant(actor.tenantId, control.spendingAdAccountAssetId, { actor: who(actor) });
        return spendJson({ metaLimit: await getMetaLimitDTO(actor.tenantId, actor.role), results: results.map((r) => ({ status: r.status, reason: r.reason ?? null })) });
      }
      case "offboard_choice": {
        if (actor.role !== "owner") throw new HttpError(403, "Only the workspace owner can choose what happens to Meta's spending limit.");
        if (body.trigger === "close") {
          const raw = body.choices && typeof body.choices === "object" && !Array.isArray(body.choices) ? (body.choices as Record<string, unknown>) : {};
          const choices = await saveOffboardChoices(actor.tenantId, raw, who(actor), "close");
          return spendJson({ choices, offboard: await offboardChoicesFor(actor.tenantId) });
        }
        if (body.trigger === "account_change") {
          if (!isOffboardChoice(body.choice)) throw new HttpError(400, "Choose to keep the limit, put back your old limit, or remove it.");
          const control = await getControl(actor.tenantId, { prune: false });
          const next = typeof body.newAdAccountAssetId === "string" ? body.newAdAccountAssetId : null;
          const result = await onSpendingAccountChange(actor.tenantId, control.spendingAdAccountAssetId, next, body.choice, who(actor));
          return spendJson({ result, text: result?.text ?? null });
        }
        throw new HttpError(400, "Say whether this is for closing the workspace or changing the spending ad account.");
      }
      default:
        throw new HttpError(400, "Unknown action.");
    }
  } catch (e) {
    return spendErrorResponse(e);
  }
}

export async function POST(request: Request) {
  return change(request);
}

export async function PUT(request: Request) {
  return change(request);
}

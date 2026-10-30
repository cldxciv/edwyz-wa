import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { assertTenantCanWrite } from "@/lib/billing";
import { readJsonObject } from "@/lib/contacts/http";
import { assistantSpendEnabled } from "@/lib/spend/flags";
import { parseLimitInput, spendErrorResponse, spendJson } from "@/lib/spend/http";
import {
  assertMayChangeMandate,
  assistantDTOs,
  ASSISTANTS_SUGGEST_ONLY_TEXT,
  classifyMandateChange,
  getMandate,
  normalizeMandatePatch,
  toMandateDTO,
  updateMandate,
  type MandatePatch,
} from "@/lib/spend/mandates";
import { HttpError } from "@/lib/tenancy";

/*
 * /api/spend/mandates (docs/SPEND-CONTROLS-SPEC.md 7.2, 8.1; 12.1a decision 5).
 *
 * GET  every role: { assistants: AssistantDTO[], assistantSpendEnabled, note } with each assistant's mandate (null when it has
 *      none: suggestions only), its learning summary and the level options. canRaise/canLower follow the viewer's role.
 * PUT  { assistantKey, enabled?, level?, allowedOps?, maxDailyMinor?, maxMonthlyMinor?, targetCostPerLeadMinor?, raiseStepPct?,
 *      approvalSharePct?, sandboxOnly?, version?, reason? }, same origin. The owner raises and lowers; an admin only lowers
 *      (403 "Only the owner can raise an assistant's level or limits. You can lower them."); team members get 403. Raising is a
 *      raising operation, so only it checks the paywall. Amounts are decimal strings of the smallest currency unit, or null
 *      for "no own ceiling". Every change is ledgered as mandate.change. While ASSISTANT_SPEND_ENABLED is false the saved
 *      level is kept but every assistant acts at Level 0 (effectiveLevel 0).
 */

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const enabled = assistantSpendEnabled();
    return spendJson({ assistants: await assistantDTOs(actor.tenantId, actor.role), assistantSpendEnabled: enabled, note: enabled ? null : ASSISTANTS_SUGGEST_ONLY_TEXT });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

function intOrUndefined(v: unknown, what: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new HttpError(400, `${what} must be a whole number.`);
  return v;
}

function boolOrUndefined(v: unknown, what: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new HttpError(400, `${what} must be true or false.`);
  return v;
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonObject(request);
    if (typeof body.assistantKey !== "string" || !body.assistantKey) throw new HttpError(400, "Choose an assistant.");
    const key = body.assistantKey;
    if (body.allowedOps !== undefined && !Array.isArray(body.allowedOps)) throw new HttpError(400, "Choose what the assistant may do from the list.");
    const raw: MandatePatch = {
      enabled: boolOrUndefined(body.enabled, "enabled"),
      level: intOrUndefined(body.level, "The level"),
      allowedOps: body.allowedOps as string[] | undefined,
      maxDailyMinor: parseLimitInput(body.maxDailyMinor, "daily amount"),
      maxMonthlyMinor: parseLimitInput(body.maxMonthlyMinor, "monthly amount"),
      targetCostPerLeadMinor: parseLimitInput(body.targetCostPerLeadMinor, "target cost per lead"),
      raiseStepPct: intOrUndefined(body.raiseStepPct, "The daily raise step"),
      approvalSharePct: intOrUndefined(body.approvalSharePct, "The approval share"),
      sandboxOnly: boolOrUndefined(body.sandboxOnly, "sandboxOnly"),
    };
    const patch = normalizeMandatePatch(key, Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as MandatePatch);
    const who = { type: "user" as const, userId: actor.userId, role: actor.role };
    const change = classifyMandateChange(await getMandate(actor.tenantId, key), patch);
    // Who may do it first (a 403 is the answer for a role that may not), then the paywall for raises only (4.17).
    assertMayChangeMandate(who, change);
    if (change.raises || change.ownerOnly) await assertTenantCanWrite(actor.tenantId);
    const version = body.version === undefined ? undefined : intOrUndefined(body.version, "version");
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) || undefined : undefined;
    const result = await updateMandate(actor.tenantId, key, patch, who, { expectedVersion: version, reason });
    const assistants = await assistantDTOs(actor.tenantId, actor.role);
    return spendJson({ mandate: toMandateDTO(result.mandate), assistant: assistants.find((a) => a.assistantKey === key) ?? null, changed: result.change.changed });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

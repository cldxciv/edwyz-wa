import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/auth/audit";
import { syncPlanToRazorpay } from "@/lib/billing";
import { AI_REPLIES_PER_HOUR_FEATURE, MAX_AI_REPLIES_PER_HOUR, withoutRepliesPerHour } from "@/lib/billing/ai-allowance";
import { prisma } from "@/lib/db";
import { clearCeiling, listCeilings, setCeiling, type CeilingRow } from "@/lib/spend/ceilings";
import { CRD, currencyExponent, isCurrencyCode, minorToMajorString, parseMajorInput } from "@/lib/spend/money";
import type { Pot, SpendActor } from "@/lib/spend/types";
import { HttpError } from "@/lib/tenancy";
import { int, optInt, requireConfirmation, str } from "./http";

// =====================================================================================================================
// Plan spending ceilings (docs/SPEND-CONTROLS-SPEC.md 8.3): ads per day and per month (one row per currency, INR first),
// WhatsApp per month and AI credits per day. Stored as SpendCeiling rows with scope `plan` (scopeId = Plan.id), so the Plan
// table is unchanged. The plan's monthly AI credits stay Plan.aiCreditsMonthly. Amounts are typed in the currency's main
// unit ("2000" for ₹2,000) and are worst-case figures: what Meta may spend at most, not the sum of daily budgets.
// =====================================================================================================================

const MESSAGING_CURRENCY = "INR";

/** What the plan form shows: text in the currency's main unit, "" for no ceiling. */
export type PlanCeilingValues = {
  ads: { currency: string; daily: string; monthly: string }[];
  whatsappMonthly: string;
  aiDaily: string;
};

export const EMPTY_PLAN_CEILINGS: PlanCeilingValues = { ads: [{ currency: "INR", daily: "", monthly: "" }], whatsappMonthly: "", aiDaily: "" };

/** One change to a plan ceiling row; an undefined period keeps what is stored, null clears it. */
export type PlanCeilingChange = { pot: Pot; currency: string; daily?: bigint | null; monthly?: bigint | null };

/** Minor units as the plan form shows them: "2000" for 200000 paise, "2000.50" when there are paise. */
export function majorText(minor: bigint | null, currency: string): string {
  if (minor === null) return "";
  const text = minorToMajorString(minor, currency);
  return currencyExponent(currency) > 0 ? text.replace(/\.0+$/, "") : text;
}

function ceilingAmount(body: Record<string, unknown>, key: string, label: string, currency: string): bigint | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && v.trim() === "")) return null;
  if (typeof v !== "string" && typeof v !== "number") throw new HttpError(400, `${label} is not valid.`);
  try {
    return parseMajorInput(String(v), currency);
  } catch (error) {
    throw new HttpError(400, `${label}: ${error instanceof Error ? error.message : "enter an amount using numbers only."}`);
  }
}

/** True when the plan form sent any ceiling field (older callers send none, and then nothing changes). */
export function hasCeilingFields(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((k) => k.startsWith("adsCeiling_") || k.startsWith("adsCeilingNew_") || k === "whatsappCeiling_INR_monthly" || k === "aiCeiling_daily");
}

/**
 * The ceiling fields of the plan form: adsCeiling_<CUR>_daily / _monthly per currency, adsCeilingNew_currency / _daily /
 * _monthly for a new currency row, whatsappCeiling_INR_monthly, aiCeiling_daily (credits). Throws 400 with a plain sentence.
 */
export function parsePlanCeilings(body: Record<string, unknown>): PlanCeilingChange[] {
  const out: PlanCeilingChange[] = [];
  const ads = new Map<string, PlanCeilingChange>();
  for (const key of Object.keys(body)) {
    const m = /^adsCeiling_([A-Z]{3})_(daily|monthly)$/.exec(key);
    if (!m) continue;
    const currency = m[1];
    if (!isCurrencyCode(currency) || currency === CRD) throw new HttpError(400, "Use a three-letter currency code such as INR.");
    const change = ads.get(currency) ?? { pot: "ads" as Pot, currency };
    change[m[2] as "daily" | "monthly"] = ceilingAmount(body, key, `Ads ceiling per ${m[2] === "daily" ? "day" : "month"} (${currency})`, currency);
    ads.set(currency, change);
  }
  const newCurrency = typeof body.adsCeilingNew_currency === "string" ? body.adsCeilingNew_currency.trim().toUpperCase() : "";
  if (newCurrency) {
    if (!isCurrencyCode(newCurrency) || newCurrency === CRD) throw new HttpError(400, "Use a three-letter currency code such as USD.");
    const daily = ceilingAmount(body, "adsCeilingNew_daily", `Ads ceiling per day (${newCurrency})`, newCurrency);
    const monthly = ceilingAmount(body, "adsCeilingNew_monthly", `Ads ceiling per month (${newCurrency})`, newCurrency);
    if ((daily ?? null) !== null || (monthly ?? null) !== null) ads.set(newCurrency, { pot: "ads", currency: newCurrency, daily: daily ?? null, monthly: monthly ?? null });
  }
  for (const c of ads.values()) {
    if (c.daily !== undefined && c.monthly !== undefined && c.daily !== null && c.monthly !== null && c.daily > c.monthly) throw new HttpError(400, `The ads ceiling per day can't be more than the ceiling per month (${c.currency}).`);
    out.push(c);
  }
  const wa = ceilingAmount(body, "whatsappCeiling_INR_monthly", "WhatsApp ceiling per month", MESSAGING_CURRENCY);
  if (wa !== undefined) out.push({ pot: "messaging", currency: MESSAGING_CURRENCY, monthly: wa });
  const ai = ceilingAmount(body, "aiCeiling_daily", "AI credits per day", CRD);
  if (ai !== undefined) out.push({ pot: "ai", currency: CRD, daily: ai });
  return out;
}

const PLAN_CEILING_REASON = "Changed on the plan form.";
const adminActor = (userId: string): SpendActor => ({ type: "platform_admin", userId });

/**
 * Writes the changed plan ceiling rows (one ledger row per change, on the platform ledger) and leaves unchanged rows alone.
 * A row whose two periods end up empty is removed.
 */
export async function savePlanCeilings(adminUserId: string, planId: string, changes: PlanCeilingChange[]): Promise<number> {
  if (changes.length === 0) return 0;
  const existing = await listCeilings({ scope: "plan", scopeId: planId });
  const actor = adminActor(adminUserId);
  let written = 0;
  for (const c of changes) {
    const row = existing.find((r) => r.pot === c.pot && r.currency === c.currency) ?? null;
    const daily = c.daily !== undefined ? c.daily : (row?.dailyMinor ?? null);
    const monthly = c.monthly !== undefined ? c.monthly : (row?.monthlyMinor ?? null);
    if (row && row.dailyMinor === daily && row.monthlyMinor === monthly) continue;
    if (!row && daily === null && monthly === null) continue;
    if (daily === null && monthly === null) await clearCeiling({ scope: "plan", scopeId: planId, pot: c.pot, currency: c.currency }, actor, PLAN_CEILING_REASON);
    else await setCeiling({ scope: "plan", scopeId: planId, pot: c.pot, currency: c.currency, dailyMinor: daily, monthlyMinor: monthly }, actor, PLAN_CEILING_REASON);
    written++;
  }
  if (written > 0) await audit({ userId: adminUserId, action: "admin.plan.ceilings", target: planId, meta: { changed: written } });
  return written;
}

/** The plan form's ceiling values for each plan (INR ads row always first, even when empty). */
export function planCeilingValuesOf(rows: CeilingRow[]): PlanCeilingValues {
  const ads = rows.filter((r) => r.pot === "ads").sort((a, b) => (a.currency === "INR" ? -1 : b.currency === "INR" ? 1 : a.currency.localeCompare(b.currency)));
  const list = ads.map((r) => ({ currency: r.currency, daily: majorText(r.dailyMinor, r.currency), monthly: majorText(r.monthlyMinor, r.currency) }));
  if (!list.some((r) => r.currency === "INR")) list.unshift({ currency: "INR", daily: "", monthly: "" });
  const wa = rows.find((r) => r.pot === "messaging" && r.currency === MESSAGING_CURRENCY) ?? null;
  const ai = rows.find((r) => r.pot === "ai" && r.currency === CRD) ?? null;
  return { ads: list, whatsappMonthly: majorText(wa?.monthlyMinor ?? null, MESSAGING_CURRENCY), aiDaily: majorText(ai?.dailyMinor ?? null, CRD) };
}

async function planCeilings(planIds: string[]): Promise<Map<string, PlanCeilingValues>> {
  const out = new Map<string, PlanCeilingValues>();
  if (planIds.length === 0) return out;
  try {
    const rows = await listCeilings({ scope: "plan" });
    for (const id of planIds) out.set(id, planCeilingValuesOf(rows.filter((r) => r.scopeId === id)));
  } catch (error) {
    console.error("[admin] plan ceilings could not be read:", error instanceof Error ? error.message : "unknown");
  }
  return out;
}

/** "499" or "499.50" rupees to paise. Rejects anything else, so no float maths touches money. */
export function rupeesToPaise(input: unknown): number {
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new HttpError(400, "Price must be an amount in rupees, for example 999 or 999.50.");
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
}

export type PlanInput = {
  code: string;
  name: string;
  description: string | null;
  pricePaise: number;
  intervalMonths: number;
  seatLimit: number | null;
  contactLimit: number | null;
  monthlyBroadcastLimit: number | null;
  aiCreditsMonthly: number | null;
  adAccountLimit: number | null;
  scheduledPostLimit: number | null;
  connectedChannelLimit: number | null;
  features: Prisma.InputJsonObject;
  active: boolean;
  sortOrder: number;
};

/**
 * The plan form's "AI replies an hour" field (owner decision 3), stored as Plan.features.aiRepliesPerHour. Sent empty, the key is
 * removed and the plan's code or name default applies (Starter 60, Growth 200, Agency 600, otherwise the platform value). Not sent
 * at all (an older caller), the features stay as given. A whole number from 1 to 100,000: 0 would switch the AI agent off for the
 * plan, and every module is on every plan (owner decision 6).
 */
export function applyRepliesPerHour(features: Prisma.InputJsonObject, body: Record<string, unknown>): Prisma.InputJsonObject {
  if (!(AI_REPLIES_PER_HOUR_FEATURE in body)) return features;
  const value = optInt(body, AI_REPLIES_PER_HOUR_FEATURE, "AI replies an hour", 1, MAX_AI_REPLIES_PER_HOUR);
  const rest = withoutRepliesPerHour(features) as Prisma.InputJsonObject;
  return value === null ? rest : { ...rest, [AI_REPLIES_PER_HOUR_FEATURE]: value };
}

export function parsePlanInput(body: Record<string, unknown>): PlanInput {
  const code = str(body, "code", "Code", 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(code)) throw new HttpError(400, "Code may use lowercase letters, digits, dash and underscore.");
  let features: Prisma.InputJsonObject = {};
  const rawFeatures = body.features;
  if (typeof rawFeatures === "string" && rawFeatures.trim()) {
    if (rawFeatures.length > 4000) throw new HttpError(400, "Features JSON is too long.");
    try {
      const parsed = JSON.parse(rawFeatures);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      features = parsed;
    } catch {
      throw new HttpError(400, "Features must be a JSON object, for example {\"automationTriggersMonthly\": 5000}.");
    }
  } else if (rawFeatures && typeof rawFeatures === "object" && !Array.isArray(rawFeatures)) {
    features = rawFeatures as Prisma.InputJsonObject;
  }
  features = applyRepliesPerHour(features, body);
  return {
    code,
    name: str(body, "name", "Name", 80),
    description: str(body, "description", "Description", 500, false) || null,
    pricePaise: rupeesToPaise(body.priceRupees),
    intervalMonths: int(body, "intervalMonths", "Interval (months)", 1, 12),
    seatLimit: optInt(body, "seatLimit", "Seat limit", 1, 100000),
    contactLimit: optInt(body, "contactLimit", "Contact limit", 1, 100000000),
    monthlyBroadcastLimit: optInt(body, "monthlyBroadcastLimit", "Monthly broadcast limit", 1, 100000000),
    aiCreditsMonthly: optInt(body, "aiCreditsMonthly", "Monthly AI credits", 1, 100000000),
    adAccountLimit: optInt(body, "adAccountLimit", "Ad account limit", 1, 10000),
    scheduledPostLimit: optInt(body, "scheduledPostLimit", "Monthly scheduled post limit", 1, 1000000),
    connectedChannelLimit: optInt(body, "connectedChannelLimit", "Connected channel limit", 1, 10000),
    features,
    active: body.active !== false,
    sortOrder: optInt(body, "sortOrder", "Sort order", -1000, 1000) ?? 0,
  };
}

/** A plan already published to Razorpay is immutable on price and interval, because Razorpay plans cannot be edited. */
export function assertPriceEditable(existing: { razorpayPlanId: string | null; pricePaise: number; intervalMonths: number }, next: { pricePaise: number; intervalMonths: number }) {
  if (existing.razorpayPlanId && (existing.pricePaise !== next.pricePaise || existing.intervalMonths !== next.intervalMonths)) {
    throw new HttpError(409, "This plan is published to Razorpay, so its price and interval cannot change. Use Duplicate as new plan.");
  }
}

const log = (adminUserId: string, action: string, planId: string, meta: Record<string, string | number | boolean | null> = {}) =>
  audit({ userId: adminUserId, action: `admin.plan.${action}`, target: planId, meta });

/** Every plan with its subscriber count and its spending ceilings as the plan form shows them. */
export async function listPlans() {
  const plans = await prisma.plan.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], include: { _count: { select: { subscriptions: true } } } });
  const ceilings = await planCeilings(plans.map((p) => p.id));
  return plans.map((p) => ({ ...p, ceilings: ceilings.get(p.id) ?? EMPTY_PLAN_CEILINGS }));
}

export async function createPlan(adminUserId: string, body: Record<string, unknown>) {
  const data = parsePlanInput(body);
  const ceilings = hasCeilingFields(body) ? parsePlanCeilings(body) : [];
  if (await prisma.plan.findUnique({ where: { code: data.code }, select: { id: true } })) throw new HttpError(409, "A plan with this code already exists.");
  const plan = await prisma.plan.create({ data });
  await log(adminUserId, "create", plan.id, { code: plan.code, pricePaise: plan.pricePaise });
  await savePlanCeilings(adminUserId, plan.id, ceilings);
  return { plan };
}

export async function updatePlan(adminUserId: string, id: string, body: Record<string, unknown>) {
  const existing = await prisma.plan.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, "Plan not found.");
  const data = parsePlanInput(body);
  const ceilings = hasCeilingFields(body) ? parsePlanCeilings(body) : [];
  assertPriceEditable(existing, data);
  if (data.code !== existing.code && (await prisma.plan.findUnique({ where: { code: data.code }, select: { id: true } }))) throw new HttpError(409, "A plan with this code already exists.");
  const plan = await prisma.plan.update({ where: { id }, data });
  await log(adminUserId, "update", id, { code: plan.code, pricePaise: plan.pricePaise });
  await savePlanCeilings(adminUserId, id, ceilings);
  return { plan };
}

/** Copies a plan's ceiling rows to another plan (Duplicate as new plan). Best effort: the copy itself already exists. */
async function copyPlanCeilings(adminUserId: string, fromPlanId: string, toPlanId: string): Promise<void> {
  try {
    const rows = await listCeilings({ scope: "plan", scopeId: fromPlanId });
    for (const r of rows) await setCeiling({ scope: "plan", scopeId: toPlanId, pot: r.pot, currency: r.currency, dailyMinor: r.dailyMinor, monthlyMinor: r.monthlyMinor }, adminActor(adminUserId), "Copied with the plan.");
  } catch (error) {
    console.error("[admin] plan ceilings were not copied:", error instanceof Error ? error.message : "unknown");
  }
}

/** Removes a deleted plan's ceiling rows. Best effort: rows of a deleted plan never match a workspace anyway. */
async function clearPlanCeilings(adminUserId: string, planId: string): Promise<void> {
  try {
    const rows = await listCeilings({ scope: "plan", scopeId: planId });
    for (const pot of new Set(rows.map((r) => r.pot))) await clearCeiling({ scope: "plan", scopeId: planId, pot }, adminActor(adminUserId), "The plan was deleted.");
  } catch (error) {
    console.error("[admin] plan ceilings were not removed:", error instanceof Error ? error.message : "unknown");
  }
}

export async function applyPlanAction(adminUserId: string, id: string, body: Record<string, unknown>) {
  const plan = await prisma.plan.findUnique({ where: { id }, include: { _count: { select: { subscriptions: true } } } });
  if (!plan) throw new HttpError(404, "Plan not found.");
  const action = str(body, "action", "Action", 30);
  switch (action) {
    case "publish": {
      const res = await syncPlanToRazorpay(id).catch(() => {
        throw new HttpError(502, "Could not publish to Razorpay. Check that billing is configured.");
      });
      await log(adminUserId, "publish", id, { code: plan.code });
      return { ok: true, razorpayPlanId: res.razorpayPlanId };
    }
    case "archive":
      await prisma.plan.update({ where: { id }, data: { active: false } });
      await log(adminUserId, "archive", id, { code: plan.code, subscriptions: plan._count.subscriptions });
      return { ok: true };
    case "unarchive":
      await prisma.plan.update({ where: { id }, data: { active: true } });
      await log(adminUserId, "unarchive", id, { code: plan.code });
      return { ok: true };
    case "delete":
      if (plan._count.subscriptions > 0) throw new HttpError(409, "This plan has subscriptions. Archive it instead.");
      requireConfirmation(plan.code, body.confirm);
      await prisma.plan.delete({ where: { id } });
      await clearPlanCeilings(adminUserId, id);
      await log(adminUserId, "delete", id, { code: plan.code });
      return { ok: true };
    case "duplicate": {
      let code = `${plan.code}-v2`;
      for (let n = 3; await prisma.plan.findUnique({ where: { code }, select: { id: true } }); n++) code = `${plan.code}-v${n}`;
      const copy = await prisma.plan.create({
        data: {
          code, name: `${plan.name} (copy)`, description: plan.description, pricePaise: plan.pricePaise, intervalMonths: plan.intervalMonths,
          seatLimit: plan.seatLimit, contactLimit: plan.contactLimit, monthlyBroadcastLimit: plan.monthlyBroadcastLimit,
          aiCreditsMonthly: plan.aiCreditsMonthly, adAccountLimit: plan.adAccountLimit, scheduledPostLimit: plan.scheduledPostLimit, connectedChannelLimit: plan.connectedChannelLimit,
          features: plan.features as Prisma.InputJsonObject, active: false, sortOrder: plan.sortOrder,
        },
      });
      await copyPlanCeilings(adminUserId, id, copy.id);
      await log(adminUserId, "duplicate", copy.id, { from: plan.code, code });
      return { ok: true, id: copy.id };
    }
    default:
      throw new HttpError(400, "Unknown action.");
  }
}

/**
 * The platform admin's spending pages (docs/SPEND-CONTROLS-SPEC.md 8.3, 4.4, 4.11, 4.16, 5.1, 5.8, 7.4; WP-18; Eddy 12.1a
 * decision 2).
 *
 * - listSpending(): /admin/spending, every workspace (including ones with no SpendControl row yet, no ad account and no
 *   WhatsApp number), built from the `spend:summary:<tenantId>` rows the 5-minute breakers task writes ("as of 14:05"). It
 *   never computes headroom for every workspace on a page load. The freeze, the new-workspace setting, open safety stops and
 *   requests waiting are read live (cheap reads), so a stop or a lifted limit shows at once. Rows sort by risk, (spent + set
 *   aside) / limit; the demo workspace is labelled "Demo" and kept out of the risk sort and the alerts. Amounts are in each
 *   workspace's own currency, with no exchange rate.
 * - spendingAlerts(): the alerts strip. Email is off (12.1a decision 2), so the strip IS the alert for worker health.
 * - getTenantSpending(): the live "Spending" card of /admin/tenants/[id], through src/lib/spend/summary.ts.
 * - applySpendAction(): the workspace actions of 8.3. Each needs a reason, is audited as admin.tenant.<action>, writes a
 *   ledger row with actorType platform_admin, and takes effect on the next reservation (every check reads the limits fresh).
 * - applyPlatformSwitch(): "Stop assistants everywhere" / "Stop all spending everywhere" and turning it back on: a reason,
 *   the typed confirmation and a TOTP step-up no older than 5 minutes. Up to 25 workspaces are paused inline, most money at
 *   risk first; the rest go to the spend.stop job. Nothing restarts when spending is turned back on.
 * - getSpendSettings() / updateSpendSettings(): /admin/spending/settings (new-workspace limits, platform ceilings, exchange
 *   rates, the notification sender, the default request expiry and Meta's change budget).
 *
 * Copy is plain and never says "minor units", "probation" or "commitment" (the UI says "new-workspace limits").
 */
import type { Prisma } from "@/generated/prisma/client";
import { defaultMonthlyCreditCeiling } from "@/lib/ai-agent/credits";
import { audit } from "@/lib/auth/audit";
import { readCookie } from "@/lib/auth/cookies";
import { prisma } from "@/lib/db";
import { normalizeTier } from "@/lib/messaging-limit";
import { defaultPotCurrency, getAllowance, setAllowances } from "@/lib/spend/allowances";
import { clearCeiling, listCeilings, PLATFORM_SCOPE_ID, setCeiling, type CeilingRow } from "@/lib/spend/ceilings";
import { applyLedgered, getControl, PLATFORM_LEDGER_TENANT, type SpendDb } from "@/lib/spend/control";
import { DEMO_WABA_PREFIX, isDemoAsset } from "@/lib/spend/demo";
import { FX_BASE, FX_MAX_AGE_DAYS, freshRate, isRateFresh, listFxRates, readFx, setFxRates, type FxTable } from "@/lib/spend/fx";
import { readSpendHealth } from "@/lib/spend/health";
import { jsonSafe } from "@/lib/spend/http";
import { isFreezeLevel, PLATFORM_RESUME_CONFIRM, PLATFORM_STEP_UP_MAX_AGE_MS, PLATFORM_STOP_CONFIRM, readPlatformFreeze, setPlatformFreeze, setWorkspaceFreeze, stricterFreeze } from "@/lib/spend/kill";
import { appendStandalone } from "@/lib/spend/ledger";
import { CRD, formatMinor, isCurrencyCode, parseMajorInput, toMoneyDTO, toMoneyDTOOrNull, type MoneyDTO } from "@/lib/spend/money";
import { computeProbation, setProbation, setWorkspaceVerified } from "@/lib/spend/probation";
import { ASSISTANTS, isAssistantKey } from "@/lib/spend/registry";
import {
  POTS,
  type AdminSpendRowDTO,
  type AdminSpendState,
  type AssistantDTO,
  type BreakerDTO,
  type CeilingScope,
  type FreezeDTO,
  type FreezeLevel,
  type LedgerRowDTO,
  type MetaLimitDTO,
  type MetaLimitState,
  type MetaOffboardChoice,
  type Pot,
  type ProbationDTO,
  type ProbationSetting,
  type SpendActor,
  type StopResultDTO,
  type TimezonesDTO,
} from "@/lib/spend/types";
import { HttpError, type Actor } from "@/lib/tenancy";
import { isPlatformAdminEmail } from "./auth";
import { requireReason, str } from "./http";
import { ADMIN_COOKIE, STEPUP_TTL_SECONDS, verifyStepUp } from "./stepup";

type Env = Record<string, string | undefined>;
export type AdminSpendOptions = { db?: SpendDb; now?: Date; env?: Env };

const DAY_MS = 86_400_000;
const SUMMARY_PREFIX = "spend:summary:";
const SUMMARY_CURSOR_KEY = "spend:summary:cursor";
const ORPHANS_KEY = "spend:ledger:orphans";
export const NOTIFY_KEY = "spend:notify";
export const DEFAULTS_KEY = "spend:defaults";

export const SPENDING_PAGE_SIZE = 25;
/** "Near a limit": (spent + set aside) is at least this share of a limit. */
export const NEAR_LIMIT_PCT = 80;
/** The notifier number is TIER_250; above this many owners a day, digests give way to alerts (7.4 capacity). */
export const NOTIFY_DAILY_OWNERS_WARN = 200;
/** Workspaces the platform switch pauses inline, most money at risk first (4.11). */
export const PLATFORM_INLINE_WORKSPACES = 25;
/** Meta allows 10 spending-limit changes a day on one ad account (5.4). */
export const META_CAP_CHANGES_PER_DAY = 10;

const platformActor = (userId: string): SpendActor => ({ type: "platform_admin", userId });

// =====================================================================================================================
// The list (8.3)
// =====================================================================================================================

export const SPENDING_FILTERS = ["all", "new_workspace", "stopped", "near_limit", "meta_attention", "safety_stop"] as const;
export type SpendingFilter = (typeof SPENDING_FILTERS)[number];

export function isSpendingFilter(value: unknown): value is SpendingFilter {
  return typeof value === "string" && (SPENDING_FILTERS as readonly string[]).includes(value);
}

/** Meta limit states that need someone to look (the "Meta limit needs attention" filter). */
export const META_ATTENTION_STATES: ReadonlySet<string> = new Set<MetaLimitState | "no_ad_account">([
  "pending_owner",
  "no_permission",
  "error",
  "loose",
  "currency_mismatch",
  "unavailable_prepaid",
  "deferred",
  "needs_monthly_limit",
]);

/** A row of the list: the cached summary (or the defaults), with the live freeze, setting and counts laid over it. */
export type AdminSpendingRow = AdminSpendRowDTO;

export type PlatformSwitchView = {
  freeze: FreezeLevel;
  reason: string | null;
  at: string | null;
  byEmail: string | null;
  /** "Spending is on for all workspaces" / "Stopped since 2026-10-29 14:05 UTC by admin@edwyz.com: <reason>". */
  text: string;
  /** While a stop is on: workspaces that still have ads running (the background stop works through them every minute). */
  stillRunning: number | null;
  progressText: string | null;
};

export type SpendingList = {
  rows: AdminSpendingRow[];
  total: number;
  page: number;
  pageSize: number;
  filter: SpendingFilter;
  q: string;
  /** How many workspaces each filter matches (for the filter labels). */
  counts: Record<SpendingFilter, number>;
  platform: PlatformSwitchView;
  /** Every row, before paging (for the alerts strip). Not sent to the browser. */
  all: AdminSpendingRow[];
};

type TenantLite = { id: string; name: string; slug: string; billingExempt: boolean; status: string };
type ControlLite = { tenantId: string; freeze: string; probation: string; verifiedAt: Date | null };

const utc = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

const zero = (currency: string): MoneyDTO => toMoneyDTO(0n, currency);
const cellOf = (currency: string, limit: bigint | null) => ({ spent: zero(currency), setAside: zero(currency), limit: toMoneyDTOOrNull(limit, currency) });

type DefaultsInput = {
  tenant: TenantLite;
  plan: { name: string; aiCreditsMonthly: number | null } | null;
  setting: ProbationSetting;
  verifiedAt: Date | null;
  paidInvoices: number;
  demo: boolean;
  adAccountCurrency: string | null;
  hasPhone: boolean;
  probationCeilings: Map<string, CeilingRow>;
};

/** A workspace with no cached summary yet, shown with the safe defaults (I11): nothing spent, the limits that would apply. */
export function defaultRow(x: DefaultsInput): AdminSpendRowDTO {
  const probation = computeProbation({ setting: x.setting, verifiedAt: x.verifiedAt, billingExempt: x.tenant.billingExempt, paidInvoices: x.paidInvoices });
  const on = probation.on;
  const ceiling = (pot: Pot, currency: string) => (on ? (x.probationCeilings.get(`${pot}:${currency}`) ?? null) : null);
  const adsCurrency = x.adAccountCurrency ?? FX_BASE;
  const adsCeiling = ceiling("ads", adsCurrency);
  const msgCeiling = ceiling("messaging", FX_BASE);
  const planCredits = BigInt(x.plan?.aiCreditsMonthly ?? defaultMonthlyCreditCeiling());
  const aiCeiling = ceiling("ai", CRD)?.monthlyMinor ?? null;
  const aiLimit = aiCeiling !== null && aiCeiling < planCredits ? aiCeiling : planCredits;
  const hasAds = x.adAccountCurrency !== null;
  return {
    tenantId: x.tenant.id,
    name: x.tenant.name,
    slug: x.tenant.slug,
    plan: x.plan?.name ?? null,
    demo: x.demo,
    newWorkspaceLimits: x.setting === "forced" ? "forced" : on ? "on" : "lifted",
    // An owner's daily ads limit is Not set until they set one, and then no ads can start (4.4): no daily figure applies.
    adsToday: hasAds ? cellOf(adsCurrency, null) : null,
    adsMonth: hasAds ? cellOf(adsCurrency, adsCeiling?.monthlyMinor ?? null) : null,
    whatsappMonth: cellOf(FX_BASE, msgCeiling?.monthlyMinor ?? null),
    aiMonth: { used: zero(CRD), limit: toMoneyDTO(aiLimit, CRD) },
    metaLimit: !hasAds ? { state: "no_ad_account", label: "No ad account" } : x.demo ? { state: "demo", label: "Demo" } : { state: "off", label: "Off" },
    breakersOpen: 0,
    requestsWaiting: 0,
    state: "on",
    riskPct: null,
    asOf: null,
    noAdAccount: !hasAds,
    noWhatsApp: !x.hasPhone,
  };
}

const isMoney = (v: unknown): v is MoneyDTO => !!v && typeof v === "object" && typeof (v as MoneyDTO).minor === "string" && typeof (v as MoneyDTO).currency === "string";
const isCell = (v: unknown) => !!v && typeof v === "object" && isMoney((v as { spent?: unknown }).spent) && isMoney((v as { setAside?: unknown }).setAside);

/**
 * A cached row read back from PlatformSetting, or null when it is not usable (another shape, another workspace). Fields
 * that are missing fall back to the defaults row, so an older cache never breaks the page.
 */
export function readCachedRow(value: unknown, fallback: AdminSpendRowDTO): AdminSpendRowDTO | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<AdminSpendRowDTO>;
  if (v.tenantId !== fallback.tenantId) return null;
  const meta = v.metaLimit && typeof v.metaLimit === "object" && typeof v.metaLimit.label === "string" ? v.metaLimit : fallback.metaLimit;
  const ai = v.aiMonth && isMoney(v.aiMonth.used) ? { used: v.aiMonth.used, limit: isMoney(v.aiMonth.limit) ? v.aiMonth.limit : null } : fallback.aiMonth;
  return {
    ...fallback,
    plan: typeof v.plan === "string" ? v.plan : fallback.plan,
    demo: v.demo === true || fallback.demo,
    newWorkspaceLimits: v.newWorkspaceLimits === "on" || v.newWorkspaceLimits === "lifted" || v.newWorkspaceLimits === "forced" ? v.newWorkspaceLimits : fallback.newWorkspaceLimits,
    adsToday: v.adsToday === null ? null : isCell(v.adsToday) ? v.adsToday! : fallback.adsToday,
    adsMonth: v.adsMonth === null ? null : isCell(v.adsMonth) ? v.adsMonth! : fallback.adsMonth,
    whatsappMonth: isCell(v.whatsappMonth) ? v.whatsappMonth! : fallback.whatsappMonth,
    aiMonth: ai,
    metaLimit: meta,
    breakersOpen: typeof v.breakersOpen === "number" ? v.breakersOpen : 0,
    requestsWaiting: typeof v.requestsWaiting === "number" ? v.requestsWaiting : 0,
    state: v.state === "on" || v.state === "assistants_stopped" || v.state === "stopped" ? v.state : "on",
    riskPct: typeof v.riskPct === "number" && Number.isFinite(v.riskPct) ? v.riskPct : null,
    asOf: typeof v.asOf === "string" ? v.asOf : null,
    noAdAccount: typeof v.noAdAccount === "boolean" ? v.noAdAccount : fallback.noAdAccount,
    noWhatsApp: typeof v.noWhatsApp === "boolean" ? v.noWhatsApp : fallback.noWhatsApp,
  };
}

export function stateOf(freeze: FreezeLevel): AdminSpendState {
  return freeze === "all" ? "stopped" : freeze === "assistants" ? "assistants_stopped" : "on";
}

export function matchesFilter(row: AdminSpendingRow, filter: SpendingFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "new_workspace":
      return row.newWorkspaceLimits !== "lifted";
    case "stopped":
      return row.state !== "on";
    case "near_limit":
      return !row.demo && row.riskPct !== null && row.riskPct >= NEAR_LIMIT_PCT;
    case "meta_attention":
      return !row.demo && META_ATTENTION_STATES.has(row.metaLimit.state);
    case "safety_stop":
      return row.breakersOpen > 0;
  }
}

/** Risk first ((spent + set aside) / limit, highest first); workspaces with no figure after; the demo workspace last. */
export function compareByRisk(a: AdminSpendingRow, b: AdminSpendingRow): number {
  if (a.demo !== b.demo) return a.demo ? 1 : -1;
  const ra = a.demo || a.riskPct === null ? -1 : a.riskPct;
  const rb = b.demo || b.riskPct === null ? -1 : b.riskPct;
  if (ra !== rb) return rb - ra;
  return a.name.localeCompare(b.name) || a.tenantId.localeCompare(b.tenantId);
}

const BREAKER_SPEND_KINDS = new Set([
  "pacing",
  "efficiency",
  "spend_jump",
  "cpm_ctr_anomaly",
  "account_spike",
  "daily_limit",
  "monthly_limit",
  "budget_change_quota",
  "sync_stale",
  "meta_cap_units",
  "meta_cap_unreachable",
  "meta_cap_stale_high",
  "external_edit",
  "wa_quality_yellow",
  "wa_quality_red",
  "wa_restricted",
  "waba_disabled",
]);

const countBy = (ids: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
};

/** Every workspace's row, filtered, sorted by risk and paged (8.3). Reads the summary cache, never live headroom. */
export async function listSpending(query: { filter?: SpendingFilter; q?: string; page?: number } = {}, opts: AdminSpendOptions = {}): Promise<SpendingList> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const filter = query.filter ?? "all";
  const q = (query.q ?? "").trim().toLowerCase().slice(0, 100);
  const page = Math.max(1, Math.floor(query.page ?? 1));

  const tenants = ((await db.tenant.findMany({ where: { deletedAt: null }, select: { id: true, name: true, slug: true, billingExempt: true, status: true }, take: 10_000 })) ?? []) as TenantLite[];
  const ids = tenants.map((t) => t.id);
  const [subs, plans, summaries, controls, breakers, approvals, platform] = await Promise.all([
    db.subscription.findMany({ select: { tenantId: true, planId: true }, take: 10_000 }) as Promise<{ tenantId: string; planId: string }[]>,
    db.plan.findMany({ select: { id: true, name: true, aiCreditsMonthly: true } }) as Promise<{ id: string; name: string; aiCreditsMonthly: number | null }[]>,
    db.platformSetting.findMany({ where: { key: { startsWith: SUMMARY_PREFIX } }, select: { key: true, value: true } }) as Promise<{ key: string; value: unknown }[]>,
    db.spendControl.findMany({ select: { tenantId: true, freeze: true, probation: true, verifiedAt: true }, take: 10_000 }) as Promise<ControlLite[]>,
    db.spendBreaker.findMany({ where: { state: "tripped" }, select: { tenantId: true, kind: true, autoClearAt: true }, take: 20_000 }) as Promise<{ tenantId: string; kind: string; autoClearAt: Date | null }[]>,
    db.spendApproval.findMany({ where: { status: "pending", expiresAt: { gt: now } }, select: { tenantId: true }, take: 20_000 }) as Promise<{ tenantId: string }[]>,
    readPlatformFreeze(db),
  ]);
  const planById = new Map((plans ?? []).map((p) => [p.id, p]));
  const planOf = new Map((subs ?? []).map((s) => [s.tenantId, planById.get(s.planId) ?? null]));
  const cache = new Map<string, unknown>();
  for (const s of summaries ?? []) if (s.key !== SUMMARY_CURSOR_KEY) cache.set(s.key.slice(SUMMARY_PREFIX.length), s.value);
  const controlOf = new Map((controls ?? []).map((c) => [c.tenantId, c]));
  const openBreakers = countBy((breakers ?? []).filter((b) => BREAKER_SPEND_KINDS.has(b.kind) && (!b.autoClearAt || new Date(b.autoClearAt).getTime() > now.getTime())).map((b) => b.tenantId));
  const waiting = countBy((approvals ?? []).map((a) => a.tenantId));

  // Workspaces the defaults row has to describe: no cache yet, or a cache that cannot say whether invoices lifted the limits.
  const needDefaults = ids.filter((id) => {
    const cached = cache.get(id) as { newWorkspaceLimits?: string } | undefined;
    return !cached || (cached.newWorkspaceLimits === "forced" && (controlOf.get(id)?.probation ?? "auto") === "auto");
  });
  const facts = await defaultsFacts(db, needDefaults);

  const rows: AdminSpendingRow[] = tenants.map((t) => {
    const control = controlOf.get(t.id);
    const setting = (["auto", "lifted", "forced"].includes(control?.probation ?? "") ? control!.probation : "auto") as ProbationSetting;
    const verifiedAt = control?.verifiedAt ? new Date(control.verifiedAt) : null;
    const plan = planOf.get(t.id) ?? null;
    const fallback = defaultRow({
      tenant: t,
      plan,
      setting,
      verifiedAt,
      paidInvoices: facts.paid.get(t.id) ?? 0,
      demo: facts.demo.has(t.id),
      adAccountCurrency: facts.adCurrency.get(t.id) ?? null,
      hasPhone: facts.phones.has(t.id),
      probationCeilings: facts.probation,
    });
    const cached = cache.has(t.id) ? readCachedRow(cache.get(t.id), fallback) : null;
    const row: AdminSpendingRow = cached ?? fallback;
    row.name = t.name;
    row.slug = t.slug;
    row.plan = plan?.name ?? row.plan;
    const ws = isFreezeLevel(control?.freeze) ? control!.freeze : "none";
    row.state = stateOf(stricterFreeze(ws as FreezeLevel, platform.freeze));
    if (setting === "forced") row.newWorkspaceLimits = "forced";
    else if (setting === "lifted" || verifiedAt || t.billingExempt) row.newWorkspaceLimits = "lifted";
    else if (row.newWorkspaceLimits === "forced") row.newWorkspaceLimits = fallback.newWorkspaceLimits;
    row.breakersOpen = openBreakers.get(t.id) ?? 0;
    row.requestsWaiting = waiting.get(t.id) ?? 0;
    if (row.demo) row.riskPct = null;
    return row;
  });

  const searched = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q)) : rows;
  const counts = Object.fromEntries(SPENDING_FILTERS.map((f) => [f, searched.filter((r) => matchesFilter(r, f)).length])) as Record<SpendingFilter, number>;
  const matched = searched.filter((r) => matchesFilter(r, filter)).sort(compareByRisk);
  const start = (page - 1) * SPENDING_PAGE_SIZE;
  return {
    rows: matched.slice(start, start + SPENDING_PAGE_SIZE),
    total: matched.length,
    page,
    pageSize: SPENDING_PAGE_SIZE,
    filter,
    q,
    counts,
    platform: await platformView(db, platform),
    all: rows,
  };
}

/** What the defaults row needs for workspaces with no cache: demo, ad account currency, a WhatsApp number, paid invoices. */
async function defaultsFacts(db: SpendDb, ids: string[]) {
  const out = { demo: new Set<string>(), adCurrency: new Map<string, string>(), phones: new Set<string>(), paid: new Map<string, number>(), probation: new Map<string, CeilingRow>() };
  const probationRows = await listCeilings({ scope: "probation", scopeId: PLATFORM_SCOPE_ID }, db).catch(() => [] as CeilingRow[]);
  for (const r of probationRows) out.probation.set(`${r.pot}:${r.currency}`, r);
  if (ids.length === 0) return out;
  const [assets, wabas, phones, invoices] = await Promise.all([
    db.metaAsset.findMany({ where: { tenantId: { in: ids }, type: "ad_account", status: "active" }, select: { tenantId: true, meta: true } }) as Promise<{ tenantId: string; meta: unknown }[]>,
    db.waba.findMany({ where: { tenantId: { in: ids }, wabaId: { startsWith: DEMO_WABA_PREFIX } }, select: { tenantId: true } }) as Promise<{ tenantId: string }[]>,
    db.phoneNumber.findMany({ where: { tenantId: { in: ids } }, select: { tenantId: true } }) as Promise<{ tenantId: string }[]>,
    db.invoice.findMany({ where: { tenantId: { in: ids }, status: "paid", paidAt: { not: null }, totalPaise: { gt: 0 } }, select: { tenantId: true } }) as Promise<{ tenantId: string }[]>,
  ]);
  for (const a of assets ?? []) {
    if (isDemoAsset(a)) out.demo.add(a.tenantId);
    const currency = a.meta && typeof a.meta === "object" ? (a.meta as { currency?: unknown }).currency : null;
    if (!out.adCurrency.has(a.tenantId)) out.adCurrency.set(a.tenantId, isCurrencyCode(currency) ? currency : FX_BASE);
  }
  for (const w of wabas ?? []) out.demo.add(w.tenantId);
  for (const p of phones ?? []) out.phones.add(p.tenantId);
  for (const [id, n] of countBy((invoices ?? []).map((i) => i.tenantId))) out.paid.set(id, n);
  return out;
}

async function emailOf(db: SpendDb, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const u = (await db.user.findUnique({ where: { id: userId }, select: { email: true } }).catch(() => null)) as { email?: string } | null;
  return u?.email ?? null;
}

/** The platform switch card: its state line, and while a stop is on, how many workspaces still have ads running. */
export async function platformView(db: SpendDb, platform?: Awaited<ReturnType<typeof readPlatformFreeze>>): Promise<PlatformSwitchView> {
  const pf = platform ?? (await readPlatformFreeze(db));
  const byEmail = await emailOf(db, pf.byUserId);
  if (pf.freeze === "none") return { freeze: "none", reason: null, at: pf.at?.toISOString() ?? null, byEmail, text: "Spending is on for all workspaces", stillRunning: null, progressText: null };
  const what = pf.freeze === "all" ? "Stopped" : "Assistants stopped";
  const text = `${what} since ${utc(pf.at) ?? "an unknown time"} by ${byEmail ?? "Edwyz support"}: ${pf.reason ?? "No reason recorded."}`;
  let stillRunning: number | null = null;
  try {
    const live = ((await db.adCampaign.findMany({
      where: { status: "active", metaCampaignId: { not: null }, ...(pf.freeze === "assistants" ? { origin: "assistant" } : {}) },
      select: { tenantId: true },
      take: 20_000,
    })) ?? []) as { tenantId: string }[];
    stillRunning = new Set(live.map((c) => c.tenantId)).size;
  } catch {
    stillRunning = null;
  }
  const progressText =
    stillRunning === null
      ? null
      : stillRunning === 0
        ? "Every workspace's ads are paused."
        : `Still pausing ads in ${stillRunning} ${stillRunning === 1 ? "workspace" : "workspaces"}. The background stop works through them every minute.`;
  return { freeze: pf.freeze, reason: pf.reason, at: pf.at?.toISOString() ?? null, byEmail, text, stillRunning, progressText };
}

// =====================================================================================================================
// The alerts strip (8.3, 4.4, 4.16, 5.1, 7.4)
// =====================================================================================================================

export type SpendAlert = { id: string; tone: "good" | "warn" | "bad" | "info"; title: string; body: string; href?: string; linkLabel?: string };

export const DEFAULT_NOTIFY_TEMPLATES = { approval: "spend_approval_v1", alert: "spend_alert_v1", digest: "spend_daily_v1", optin: "spend_optin_v1" } as const;
type TemplateRole = keyof typeof DEFAULT_NOTIFY_TEMPLATES;

export type NotifySettings = {
  tenantId: string;
  /** The PhoneNumber row id of the sending number (what sendTemplateMessage takes). */
  phoneNumberId: string;
  language: string;
  templates: Record<TemplateRole, string>;
  /** The number as owners see it ("+1 711-268-5789"). */
  senderDisplay: string | null;
  updatedAt: string | null;
  byUserId: string | null;
};

export function parseNotifySettings(value: unknown): NotifySettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.tenantId !== "string" || !v.tenantId) return null;
  const t = (v.templates && typeof v.templates === "object" ? v.templates : {}) as Record<string, unknown>;
  const templates = Object.fromEntries((Object.keys(DEFAULT_NOTIFY_TEMPLATES) as TemplateRole[]).map((k) => [k, typeof t[k] === "string" && t[k] ? String(t[k]) : DEFAULT_NOTIFY_TEMPLATES[k]])) as Record<TemplateRole, string>;
  return {
    tenantId: v.tenantId,
    phoneNumberId: typeof v.phoneNumberId === "string" ? v.phoneNumberId : "",
    language: typeof v.language === "string" && v.language ? v.language : "en",
    templates,
    senderDisplay: typeof v.senderDisplay === "string" ? v.senderDisplay : typeof v.phoneDisplay === "string" ? v.phoneDisplay : null,
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
    byUserId: typeof v.byUserId === "string" ? v.byUserId : null,
  };
}

async function readSetting(db: SpendDb, key: string): Promise<unknown> {
  const row = (await db.platformSetting.findUnique({ where: { key } }).catch(() => null)) as { value?: unknown } | null;
  return row?.value ?? null;
}

const TIER_OWNERS: Record<string, string> = {
  TIER_50: "50 a day",
  TIER_250: "250 a day",
  TIER_1K: "1,000 a day",
  TIER_2K: "2,000 a day",
  TIER_10K: "10,000 a day",
  TIER_100K: "100,000 a day",
  TIER_UNLIMITED: "no daily limit",
};

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

/** Notification sender health, and whether the notifier workspace is exempt, active and staffed by platform admins only. */
async function notifierAlerts(db: SpendDb, now: Date, env: Env): Promise<SpendAlert[]> {
  const settings = parseNotifySettings(await readSetting(db, NOTIFY_KEY));
  if (!settings) {
    return [{ id: "notifier", tone: "warn", title: "No notification sender is set up", body: "Owners get spending alerts and requests in the app only. Choose the sender in Spending settings.", href: "/admin/spending/settings", linkLabel: "Open spending settings" }];
  }
  const out: SpendAlert[] = [];
  const [tenant, phone, templates, members, sent] = await Promise.all([
    db.tenant.findUnique({ where: { id: settings.tenantId }, select: { name: true, billingExempt: true, status: true, deletedAt: true } }) as Promise<{ name: string; billingExempt: boolean; status: string; deletedAt: Date | null } | null>,
    settings.phoneNumberId ? (db.phoneNumber.findFirst({ where: { id: settings.phoneNumberId, tenantId: settings.tenantId }, select: { messagingLimitTier: true, qualityRating: true, displayPhone: true } }) as Promise<{ messagingLimitTier: string | null; qualityRating: string | null; displayPhone: string } | null>) : Promise.resolve(null),
    db.template.findMany({ where: { tenantId: settings.tenantId, name: { in: Object.values(settings.templates) } }, select: { name: true, language: true, status: true } }) as Promise<{ name: string; language: string; status: string }[]>,
    db.membership.findMany({ where: { tenantId: settings.tenantId }, select: { userId: true } }) as Promise<{ userId: string }[]>,
    db.message.findMany({ where: { tenantId: settings.tenantId, origin: "system_notify", direction: "outbound", createdAt: { gte: new Date(now.getTime() - DAY_MS) } }, select: { conversationId: true }, take: 10_000 }) as Promise<{ conversationId: string }[]>,
  ]);
  const wanted = Object.values(settings.templates);
  const approved = wanted.filter((name) => (templates ?? []).some((t) => t.name === name && t.status === "approved" && (t.language === settings.language || t.language.startsWith(`${settings.language}_`)))).length;
  const tier = normalizeTier(phone?.messagingLimitTier ?? null);
  const owners = new Set((sent ?? []).map((m) => m.conversationId)).size;
  const quality = (phone?.qualityRating ?? "").toUpperCase();
  const problems = [approved < wanted.length, !phone, owners >= NOTIFY_DAILY_OWNERS_WARN, quality === "RED" || quality === "LOW"];
  const body = [
    `Templates approved: ${approved} of ${wanted.length}.`,
    phone ? `Tier: ${tier ? (TIER_OWNERS[tier] ?? tier) : "not known yet"}.` : "The sending number was not found in that workspace.",
    `Owners notified in the last 24 hours: ${owners.toLocaleString("en-IN")} of ${NOTIFY_DAILY_OWNERS_WARN}.`,
    owners >= NOTIFY_DAILY_OWNERS_WARN ? "Above 200, daily summaries are skipped so alerts and requests still go out." : "",
    quality === "RED" || quality === "LOW" ? "The sending number's quality is low: WhatsApp may limit it." : "",
  ].filter(Boolean);
  out.push({ id: "notifier", tone: problems.some(Boolean) ? "warn" : "good", title: "Notification sender", body: body.join(" ") });

  const issues: string[] = [];
  if (!tenant || tenant.deletedAt) issues.push("The notifier workspace no longer exists.");
  else {
    if (!tenant.billingExempt) issues.push(`${tenant.name} is not complimentary, so an unpaid bill would silence every owner's alerts. Make it complimentary on its workspace page.`);
    if (tenant.status !== "active") issues.push(`${tenant.name} is suspended, so no alerts can go out. Unsuspend it.`);
  }
  const userIds = (members ?? []).map((m) => m.userId);
  const users = userIds.length ? (((await db.user.findMany({ where: { id: { in: userIds } }, select: { email: true } })) ?? []) as { email: string }[]) : [];
  const outsiders = users.filter((u) => !isPlatformAdminEmail(u.email, env.PLATFORM_ADMIN_EMAILS)).map((u) => u.email);
  if (outsiders.length) issues.push(`${plural(outsiders.length, "member is", "members are")} not a platform admin: ${outsiders.slice(0, 5).join(", ")}${outsiders.length > 5 ? " and more" : ""}. Its inbox holds every owner's number; remove them.`);
  if (issues.length) out.push({ id: "notifier_workspace", tone: "bad", title: "The notifier workspace needs fixing", body: issues.join(" "), href: `/admin/tenants/${settings.tenantId}`, linkLabel: "Open the notifier workspace" });
  return out;
}

const POT_WORDS: Record<Pot, { limits: string; effect: string }> = {
  ads: { limits: "ads", effect: "can't start ads" },
  messaging: { limits: "WhatsApp", effect: "can't send broadcasts" },
  ai: { limits: "AI", effect: "can't use more AI" },
};

/**
 * Missing exchange rates or ceiling rows (4.4): a source with rows for a pot but none usable in a workspace's currency is
 * UNKNOWN, which refuses raises for assistants, and for people on new-workspace limits. Counted per currency and pot.
 */
export function missingLimitAlerts(rows: AdminSpendingRow[], ceilings: CeilingRow[], fx: FxTable, planOf: Map<string, string | null>, now: Date): SpendAlert[] {
  const usable = (source: CeilingRow[], currency: string) => source.length === 0 || source.some((r) => r.currency === currency) || (source.some((r) => r.currency === FX_BASE) && freshRate(fx, currency, now) !== null);
  const affected = new Map<string, { pot: Pot; currency: string; tenants: Set<string>; newOnly: boolean }>();
  for (const row of rows) {
    if (row.demo) continue;
    const pots: { pot: Pot; currency: string | null }[] = [
      { pot: "ads", currency: row.adsMonth?.spent.currency ?? null },
      { pot: "messaging", currency: row.whatsappMonth?.spent.currency ?? null },
    ];
    for (const { pot, currency } of pots) {
      if (!currency || currency === FX_BASE || currency === CRD) continue;
      const of = (scope: CeilingScope, scopeId: string) => ceilings.filter((c) => c.scope === scope && c.scopeId === scopeId && c.pot === pot);
      const planId = planOf.get(row.tenantId) ?? null;
      const platformOk = usable(of("platform", PLATFORM_SCOPE_ID), currency);
      const planOk = !planId || usable(of("plan", planId), currency);
      const probationOk = row.newWorkspaceLimits === "lifted" || usable(of("probation", PLATFORM_SCOPE_ID), currency);
      if (platformOk && planOk && probationOk) continue;
      const key = `${pot}:${currency}`;
      const entry = affected.get(key) ?? { pot, currency, tenants: new Set<string>(), newOnly: true };
      entry.tenants.add(row.tenantId);
      if (!platformOk || !planOk) entry.newOnly = false;
      affected.set(key, entry);
    }
  }
  const out: SpendAlert[] = [];
  for (const e of affected.values()) {
    const n = e.tenants.size;
    const who = e.newOnly ? `No ${e.currency} ${POT_WORDS[e.pot].limits} limits for new workspaces` : `No ${e.currency} ${POT_WORDS[e.pot].limits} ceiling`;
    const effect = e.newOnly ? `${plural(n, "workspace", "workspaces")} ${POT_WORDS[e.pot].effect}.` : `Assistants can't raise spending in ${plural(n, "workspace", "workspaces")}, and new workspaces ${POT_WORDS[e.pot].effect}.`;
    const rate = fx.rates[e.currency];
    const rateNote = rate && !isRateFresh(rate.updatedAt, now) ? ` The ${e.currency} exchange rate is out of date (updated ${utc(rate.updatedAt) ?? "at an unknown time"}).` : rate ? "" : ` There is no ${e.currency} exchange rate.`;
    out.push({ id: `missing:${e.pot}:${e.currency}`, tone: "warn", title: `${who}: ${effect}`, body: `Add a ${e.currency} row or a fresh exchange rate in Spending settings.${rateNote}`, href: "/admin/spending/settings", linkLabel: "Open spending settings" });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const normAct = (id: string) => String(id).replace(/^act_/, "");

/** Ad accounts connected to more than one workspace, and which one manages Meta's limit (5.1, decision 2.3.14). */
async function sharedAccountAlerts(db: SpendDb, demoTenants: Set<string>, names: Map<string, string>): Promise<SpendAlert[]> {
  const assets = ((await db.metaAsset.findMany({ where: { type: "ad_account" }, select: { tenantId: true, externalId: true, name: true, meta: true }, take: 20_000 })) ?? []) as { tenantId: string; externalId: string; name: string | null; meta: unknown }[];
  const byAccount = new Map<string, { name: string | null; tenants: Set<string> }>();
  for (const a of assets) {
    if (isDemoAsset(a) || demoTenants.has(a.tenantId) || !names.has(a.tenantId)) continue;
    const key = normAct(a.externalId);
    const entry = byAccount.get(key) ?? { name: a.name, tenants: new Set<string>() };
    entry.tenants.add(a.tenantId);
    byAccount.set(key, entry);
  }
  const shared = [...byAccount.entries()].filter(([, e]) => e.tenants.size > 1);
  if (shared.length === 0) return [];
  const managed = ((await db.metaSpendLimit.findMany({ where: { mode: "managed" }, select: { tenantId: true, accountExternalId: true }, take: 20_000 })) ?? []) as { tenantId: string; accountExternalId: string }[];
  const managerOf = new Map(managed.map((m) => [normAct(m.accountExternalId), m.tenantId]));
  const lines = shared.slice(0, 10).map(([id, e]) => {
    const list = [...e.tenants].map((t) => names.get(t) ?? t);
    const manager = managerOf.get(id);
    const who = manager ? `${names.get(manager) ?? "Another workspace"} manages Meta's limit.` : "No workspace manages Meta's limit on it.";
    return `act_${id}${e.name ? ` (${e.name})` : ""} is connected to ${list.length} workspaces: ${list.join(", ")}. ${who}`;
  });
  return [
    {
      id: "shared_accounts",
      tone: "info",
      title: `${plural(shared.length, "ad account is", "ad accounts are")} connected to more than one workspace`,
      body: `${lines.join(" ")}${shared.length > 10 ? ` And ${shared.length - 10} more.` : ""} The first workspace to turn on Meta's limit manages it.`,
    },
  ];
}

/** Everything on the alerts strip, most urgent first. The demo workspace is left out of every count. */
export async function spendingAlerts(rows: AdminSpendingRow[], opts: AdminSpendOptions = {}): Promise<SpendAlert[]> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const demo = new Set(rows.filter((r) => r.demo).map((r) => r.tenantId));
  const names = new Map(rows.map((r) => [r.tenantId, r.name]));
  const out: SpendAlert[] = [];
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      console.error("[admin] a spending alert could not be read:", error instanceof Error ? error.message : "unknown");
      return fallback;
    }
  };

  // Worker health (4.16): email is off, so this strip is where it is seen.
  const health = await readSpendHealth({ db, now });
  out.push(
    health.alert
      ? { id: "worker", tone: health.alert.severity === "danger" ? "bad" : "warn", title: "Background work", body: health.alert.text }
      : { id: "worker", tone: "good", title: "Background work", body: "The background worker is running." },
  );

  out.push(...(await safe(() => notifierAlerts(db, now, env), [] as SpendAlert[])));

  const week = new Date(now.getTime() - 7 * DAY_MS);
  const bypass = await safe(async () => (await db.auditLog.count({ where: { action: "spend.tripwire.bypass", createdAt: { gte: week } } })) as number, 0);
  out.push({
    id: "tripwire",
    tone: bypass > 0 ? "warn" : "good",
    title: "Meta calls that skipped the spending checks",
    body: bypass > 0 ? `${plural(bypass, "call", "calls")} in the last 7 days. Each one is a place in the code that must go through the spending checks before the checks are made strict.` : "None in the last 7 days.",
  });

  const orphans = (await safe(() => readSetting(db, ORPHANS_KEY), null)) as { count?: unknown; checkedAt?: unknown } | null;
  const orphanCount = typeof orphans?.count === "number" ? orphans.count : 0;
  out.push({
    id: "orphans",
    tone: orphanCount > 0 ? "warn" : "good",
    title: "Spending records with no result",
    body: orphanCount > 0 ? `${plural(orphanCount, "change was", "changes were")} started more than an hour ago with no result recorded (checked ${utc(typeof orphans?.checkedAt === "string" ? orphans.checkedAt : null) ?? "recently"}). The nightly check lists them; the reconciler settles most by itself.` : `None${typeof orphans?.checkedAt === "string" ? ` (checked ${utc(orphans.checkedAt)})` : ""}.`,
  });

  const metaErrors = await safe(async () => {
    const limits = ((await db.metaSpendLimit.findMany({ where: { mode: { in: ["error", "no_permission"] } }, select: { tenantId: true }, take: 5_000 })) ?? []) as { tenantId: string }[];
    const open = ((await db.spendBreaker.findMany({ where: { state: "tripped", kind: { in: ["meta_cap_units", "meta_cap_unreachable", "meta_cap_stale_high"] } }, select: { tenantId: true }, take: 5_000 })) ?? []) as { tenantId: string }[];
    return new Set([...limits, ...open].map((r) => r.tenantId).filter((t) => !demo.has(t))).size;
  }, 0);
  out.push({
    id: "meta_errors",
    tone: metaErrors > 0 ? "warn" : "good",
    title: "Meta limit errors",
    body: metaErrors > 0 ? `${plural(metaErrors, "workspace has", "workspaces have")} a Meta spending limit Edwyz can't read or change. Use the "Meta limit needs attention" filter.` : "None.",
  });

  out.push(
    ...(await safe(async () => {
      const ceilings = await listCeilings({}, db);
      const fx = await readFx(db);
      const subs = ((await db.subscription.findMany({ select: { tenantId: true, planId: true }, take: 10_000 })) ?? []) as { tenantId: string; planId: string }[];
      return missingLimitAlerts(rows, ceilings, fx, new Map(subs.map((s) => [s.tenantId, s.planId])), now);
    }, [] as SpendAlert[])),
  );

  out.push(...(await safe(() => sharedAccountAlerts(db, demo, names), [] as SpendAlert[])));
  const rank = { bad: 0, warn: 1, info: 2, good: 3 } as const;
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

// =====================================================================================================================
// The tenant "Spending" card (8.3)
// =====================================================================================================================

export type CeilingView = {
  id: string;
  scope: CeilingScope;
  pot: Pot;
  currency: string;
  daily: MoneyDTO | null;
  monthly: MoneyDTO | null;
  expiresAt: string | null;
  reason: string | null;
  updatedAt: string | null;
};

export function toCeilingView(r: CeilingRow): CeilingView {
  return {
    id: r.id,
    scope: r.scope,
    pot: r.pot,
    currency: r.currency,
    daily: toMoneyDTOOrNull(r.dailyMinor, r.currency),
    monthly: toMoneyDTOOrNull(r.monthlyMinor, r.currency),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    reason: r.reason,
    updatedAt: r.updatedAt?.toISOString() ?? null,
  };
}

export type TenantPotView = {
  pot: Pot;
  title: string;
  currency: string;
  status: string;
  today: { spent: MoneyDTO; setAside: MoneyDTO; limit: MoneyDTO | null };
  month: { spent: MoneyDTO; setAside: MoneyDTO; limit: MoneyDTO | null };
  ownerDaily: MoneyDTO | null;
  ownerMonthly: MoneyDTO | null;
  ceilingDaily: MoneyDTO | null;
  ceilingMonthly: MoneyDTO | null;
  ceilingSource: string | null;
  ceilingUnknown: boolean;
  binding: string;
  planCapMonthly: MoneyDTO | null;
  notes: string[];
};

export type OffboardOption = { adAccountAssetId: string; accountName: string | null; accountExternalId: string; currentCap: MoneyDTO | null; previousCap: MoneyDTO | null; selected: MetaOffboardChoice };

export type TenantSpendingView = {
  tenantId: string;
  name: string;
  status: string;
  deleted: boolean;
  demo: boolean;
  generatedAt: string;
  /** Null when the live figures could not be read; liveError says so. */
  pots: TenantPotView[] | null;
  liveError: string | null;
  freeze: FreezeDTO | null;
  probation: ProbationDTO | null;
  probationSetting: ProbationSetting;
  verifiedAt: string | null;
  timezones: TimezonesDTO | null;
  metaLimit: MetaLimitDTO | null;
  breakers: BreakerDTO[];
  assistants: AssistantDTO[];
  assistantSpendEnabled: boolean;
  approvalsWaiting: number;
  adAccounts: { assetId: string; name: string | null; externalId: string; currency: string | null; sandbox: boolean; demo: boolean; spending: boolean }[];
  overrides: CeilingView[];
  offboard: OffboardOption[];
  ledger: LedgerRowDTO[];
};

const LIVE_ERROR = "Live figures could not be read right now. The list on the Spending page shows the last saved figures.";

/**
 * The live figures come from the owner's own spending summary, written to the owner ("Your workspace is new", "until you set a
 * limit"). On the admin's workspace page "you" is the admin, so the known owner phrases are said about the workspace and its owner.
 */
const ADMIN_VOICE: [RegExp, string][] = [
  [/\bYour workspace is new\b/g, "This workspace is new"],
  [/after your first two payments, or ask support\./g, "after its first two payments, or when you mark it verified."],
  [/after your first two payments/g, "after its first two payments"],
  [/\buntil you set\b/g, "until the owner sets"],
  [/\bUntil you do\b/g, "Until the owner does"],
  [/^Choose which ad account Edwyz can spend from\./g, "The owner chooses which ad account Edwyz can spend from."],
  [/You can set your ads limits now; they apply as soon as you connect one\./g, "The owner can set ads limits now; they apply as soon as an ad account is connected."],
  [/\bYour plan\b/g, "The plan"],
  [/\byour plan\b/g, "the plan"],
  [/\bYour team\b/g, "The team"],
];

export function adminVoice(text: string): string {
  return ADMIN_VOICE.reduce((t, [re, to]) => t.replace(re, to), text);
}

/** Live figures for one workspace, as its owner's Spending limits page computes them (summary.ts), plus the admin extras. */
export async function getTenantSpending(adminUserId: string, tenantId: string, opts: AdminSpendOptions = {}): Promise<TenantSpendingView | null> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const tenant = (await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, status: true, deletedAt: true } })) as { id: string; name: string; status: string; deletedAt: Date | null } | null;
  if (!tenant) return null;
  // The admin reads the page as an admin of that workspace would: read-only, nothing is approved or changed by reading.
  const viewer: Actor = { userId: adminUserId, tenantId, role: "admin" };
  const { spendSummary, listActivity } = await import("@/lib/spend/summary");
  let summary: Awaited<ReturnType<typeof spendSummary>> | null = null;
  try {
    summary = await spendSummary(viewer, { db, now, env: opts.env });
  } catch (error) {
    console.error("[admin] live spending figures failed:", error instanceof Error ? error.message : "unknown");
  }
  const ledger = await listActivity(viewer, { limit: 20 }, { db, now })
    .then((p) => p.rows)
    .catch(() => [] as LedgerRowDTO[]);
  const control = await getControl(tenantId, { db, prune: false });
  const overrides = (await listCeilings({ scope: "tenant", scopeId: tenantId }, db)).map(toCeilingView);
  const offboard = await import("@/lib/spend/metacap/offboard")
    .then((m) => m.offboardChoicesFor(tenantId, { db: db as never }))
    .then((list) => list.map((o) => ({ adAccountAssetId: o.adAccountAssetId, accountName: o.accountName, accountExternalId: o.accountExternalId, currentCap: o.currentCap, previousCap: o.previousCap, selected: o.selected })))
    .catch(() => [] as OffboardOption[]);
  const pots = summary
    ? POTS.map((p) => {
        const v = summary!.pots[p];
        return {
          pot: p,
          title: v.title,
          currency: v.currency,
          status: v.status,
          today: { spent: v.today.spent, setAside: p === "ads" ? v.today.committed : v.today.held, limit: v.limits.effectiveDaily },
          month: { spent: v.month.spent, setAside: p === "ads" ? v.month.committed : v.month.held, limit: v.limits.effectiveMonthly },
          ownerDaily: v.limits.daily,
          ownerMonthly: v.limits.monthly,
          ceilingDaily: v.limits.ceiling.daily,
          ceilingMonthly: v.limits.ceiling.monthly,
          ceilingSource: v.limits.ceiling.source,
          ceilingUnknown: v.limits.ceiling.unknown,
          binding: v.limits.binding,
          planCapMonthly: v.limits.planCapMonthly,
          notes: v.notes.map(adminVoice),
        };
      })
    : null;
  const accounts = summary?.spendingAccount.accounts ?? [];
  return jsonSafe({
    tenantId,
    name: tenant.name,
    status: tenant.status,
    deleted: !!tenant.deletedAt,
    demo: summary?.demo ?? false,
    generatedAt: now.toISOString(),
    pots,
    liveError: summary ? null : LIVE_ERROR,
    freeze: summary?.freeze ?? null,
    probation: summary?.probation ? { ...summary.probation, why: adminVoice(summary.probation.why) } : null,
    probationSetting: control.probation,
    verifiedAt: control.verifiedAt?.toISOString() ?? null,
    timezones: summary?.timezones ?? null,
    metaLimit: summary?.metaLimit ?? null,
    breakers: summary?.breakers ?? [],
    assistants: summary?.assistants ?? [],
    assistantSpendEnabled: summary?.assistantSpendEnabled ?? false,
    approvalsWaiting: summary?.approvalsWaiting ?? 0,
    adAccounts: accounts.map((a) => ({ assetId: a.assetId, name: a.name, externalId: a.externalId, currency: a.currency, sandbox: a.sandbox, demo: a.demo, spending: a.assetId === control.spendingAdAccountAssetId })),
    overrides,
    offboard,
    ledger,
  }) as TenantSpendingView;
}

// =====================================================================================================================
// Workspace actions (8.3): each needs a reason, is audited as admin.tenant.<action> and ledgered as platform_admin
// =====================================================================================================================

export const TENANT_SPEND_ACTIONS = [
  "set_spend_ceiling",
  "clear_spend_ceiling",
  "lower_spend_limits",
  "lower_assistant_level",
  "meta_limit_offboard",
  "lift_probation",
  "set_probation",
  "verify_workspace",
  "freeze_spending",
  "unfreeze_spending",
  "clear_breaker",
  "mark_test_ad_account",
  "end_learning",
  "resync_meta_limit",
] as const;
export type TenantSpendAction = (typeof TENANT_SPEND_ACTIONS)[number];

export function isTenantSpendAction(value: unknown): value is TenantSpendAction {
  return typeof value === "string" && (TENANT_SPEND_ACTIONS as readonly string[]).includes(value);
}

export const PLATFORM_SWITCH_ACTIONS = ["stop_assistants", "stop_all", "resume"] as const;
export type PlatformSwitchAction = (typeof PLATFORM_SWITCH_ACTIONS)[number];
export const SETTINGS_SECTIONS = ["ceiling", "fx", "notifier", "defaults"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Every audit action these pages write, so AUDIT_LABELS can be checked against it. */
export const ADMIN_SPEND_AUDIT_ACTIONS: readonly string[] = [
  ...TENANT_SPEND_ACTIONS.map((a) => `admin.tenant.${a}`),
  ...PLATFORM_SWITCH_ACTIONS.map((a) => `admin.spend.${a}`),
  ...SETTINGS_SECTIONS.map((s) => `admin.spend.${s}`),
  "admin.spend.clear_ceiling",
  "admin.plan.ceilings",
  "admin.api.list_spending",
  "admin.api.view_tenant_spending",
  "admin.api.spending_settings",
];

type Meta = Record<string, string | number | boolean | null>;
const logTenant = (adminUserId: string, tenantId: string, action: string, meta: Meta) => audit({ tenantId, userId: adminUserId, action: `admin.tenant.${action}`, target: tenantId, meta });

const POT_LABEL: Record<Pot, string> = { ads: "ads", messaging: "WhatsApp", ai: "AI" };

function potField(body: Record<string, unknown>): Pot {
  const pot = body.pot;
  if (typeof pot !== "string" || !(POTS as readonly string[]).includes(pot)) throw new HttpError(400, "Choose ads, WhatsApp or AI.");
  return pot as Pot;
}

/** An amount typed in the currency's main unit ("2000", "2,000.50"); empty means Not set. undefined when the field is absent. */
export function amountField(body: Record<string, unknown>, key: string, label: string, currency: string): bigint | null | undefined {
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

/** "2026-11-30" becomes the end of that day (UTC). The override ends then. */
export function endDateField(body: Record<string, unknown>, now: Date): Date | null {
  const raw = body.endDate ?? body.expiresAt;
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new HttpError(400, "Enter the end date as YYYY-MM-DD.");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) throw new HttpError(400, "Enter the end date as YYYY-MM-DD.");
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== raw.trim()) throw new HttpError(400, "Enter a real date.");
  const at = new Date(day.getTime() + DAY_MS);
  if (at.getTime() <= now.getTime()) throw new HttpError(400, "Choose an end date in the future.");
  return at;
}

const yes = (v: unknown, fallback: boolean) => (v === true || v === "true" || v === "yes" || v === "on" ? true : v === false || v === "false" || v === "no" || v === "off" ? false : fallback);

export type SpendActionResult = { ok: true; text: string; changed: boolean } & Record<string, unknown>;

/** One workspace action of 8.3. The caller is a platform admin who passed handleAdmin (allowlist, step-up, same origin). */
export async function applySpendAction(adminUserId: string, tenantId: string, body: Record<string, unknown>, opts: AdminSpendOptions = {}): Promise<SpendActionResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const tenant = (await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, status: true, deletedAt: true } })) as { id: string; name: string; status: string; deletedAt: Date | null } | null;
  if (!tenant) throw new HttpError(404, "Workspace not found.");
  const action = str(body, "action", "Action", 40);
  if (!isTenantSpendAction(action)) throw new HttpError(400, "Unknown action.");
  const reason = requireReason(body);
  const actor = platformActor(adminUserId);
  const done = async (text: string, changed: boolean, meta: Meta = {}, extra: Record<string, unknown> = {}): Promise<SpendActionResult> => {
    await logTenant(adminUserId, tenantId, action, { reason, changed, ...meta });
    return { ok: true, text, changed, ...extra };
  };

  switch (action) {
    case "set_spend_ceiling": {
      const pot = potField(body);
      const currency = pot === "ai" ? CRD : typeof body.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase() : await defaultPotCurrency(tenantId, pot, db);
      if (!isCurrencyCode(currency)) throw new HttpError(400, "Use a three-letter currency code such as INR.");
      const daily = amountField(body, "daily", "Daily ceiling", currency) ?? null;
      const monthly = amountField(body, "monthly", "Monthly ceiling", currency) ?? null;
      if (daily === null && monthly === null) throw new HttpError(400, "Enter a daily or a monthly ceiling. To remove the override, use Remove override.");
      if (daily !== null && monthly !== null && daily > monthly) throw new HttpError(400, "The daily ceiling can't be more than the monthly ceiling.");
      const expiresAt = endDateField(body, now);
      const row = await setCeiling({ scope: "tenant", scopeId: tenantId, pot, currency, dailyMinor: daily, monthlyMinor: monthly, expiresAt }, actor, reason, { db, now });
      const show = (v: bigint | null) => (v === null ? "no ceiling" : formatMinor(v, currency));
      return done(
        `Override saved for ${POT_LABEL[pot]}: ${show(row.dailyMinor)} a day, ${show(row.monthlyMinor)} a month${expiresAt ? `, until ${expiresAt.toISOString().slice(0, 10)}` : ""}. It applies from the next spending check.`,
        true,
        { pot, currency, dailyMinor: daily?.toString() ?? null, monthlyMinor: monthly?.toString() ?? null, expiresAt: expiresAt?.toISOString() ?? null },
      );
    }
    case "clear_spend_ceiling": {
      const pot = potField(body);
      const currency = typeof body.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase() : undefined;
      const { deleted } = await clearCeiling({ scope: "tenant", scopeId: tenantId, pot, currency }, actor, reason, { db });
      if (deleted === 0) throw new HttpError(409, `This workspace has no override for ${POT_LABEL[pot]}.`);
      return done(`Override for ${POT_LABEL[pot]} removed. The plan, platform and new-workspace limits apply again.`, true, { pot, deleted });
    }
    case "lower_spend_limits": {
      const pot = potField(body);
      const current = await getAllowance(tenantId, pot, db);
      const currency = current?.currency ?? (await defaultPotCurrency(tenantId, pot, db));
      const daily = amountField(body, "daily", "Daily limit", currency);
      const monthly = amountField(body, "monthly", "Monthly limit", currency);
      const patch: { pot: Pot; dailyLimitMinor?: bigint; monthlyLimitMinor?: bigint } = { pot };
      for (const [field, value, from, label] of [
        ["daily", daily, current?.dailyLimitMinor ?? null, "daily"],
        ["monthly", monthly, current?.monthlyLimitMinor ?? null, "monthly"],
      ] as const) {
        if (value === undefined || value === null) continue;
        if (from === null) throw new HttpError(409, `The owner's ${label} ${POT_LABEL[pot]} limit is Not set, so there is nothing to lower. Set an override ceiling instead.`);
        if (value > from) throw new HttpError(409, `That is above the owner's ${label} limit of ${formatMinor(from, currency)}. Only the owner can raise it. To allow more, set an override ceiling.`);
        if (field === "daily") patch.dailyLimitMinor = value;
        else patch.monthlyLimitMinor = value;
      }
      if (patch.dailyLimitMinor === undefined && patch.monthlyLimitMinor === undefined) throw new HttpError(400, "Enter a lower daily or monthly limit.");
      const res = await setAllowances(tenantId, patch, actor, current?.version ?? 0, { reason, db });
      const a = res.allowance;
      return done(
        `Lowered the owner's ${POT_LABEL[pot]} limits to ${a?.dailyLimitMinor !== null && a?.dailyLimitMinor !== undefined ? formatMinor(a.dailyLimitMinor, currency) : "Not set"} a day and ${a?.monthlyLimitMinor !== null && a?.monthlyLimitMinor !== undefined ? formatMinor(a.monthlyLimitMinor, currency) : "Not set"} a month. The owner can raise them again; set an override ceiling to make the cut stick.`,
        res.change.changed,
        { pot },
      );
    }
    case "lower_assistant_level": {
      const key = str(body, "assistantKey", "Assistant", 40);
      if (!isAssistantKey(key)) throw new HttpError(400, "Choose an assistant from the list.");
      const { getMandate, lowerMandate } = await import("@/lib/spend/mandates");
      const before = await getMandate(tenantId, key, { db });
      const currency = before.currency ?? (await defaultPotCurrency(tenantId, ASSISTANTS.find((x) => x.key === key)!.pots[0], db));
      const patch: { level?: number; maxDailyMinor?: bigint; maxMonthlyMinor?: bigint } = {};
      const level = body.level === undefined || body.level === "" ? undefined : Number(body.level);
      if (level !== undefined) {
        if (!Number.isInteger(level) || level < 0 || level > 2) throw new HttpError(400, "Choose level 0, 1 or 2.");
        if (level > before.level) throw new HttpError(403, "Edwyz support can only lower an assistant's level or limits.");
        patch.level = level;
      }
      const maxDaily = amountField(body, "maxDaily", "Most it can spend a day", currency);
      const maxMonthly = amountField(body, "maxMonthly", "Most it can spend a month", currency);
      if (maxDaily) patch.maxDailyMinor = maxDaily;
      if (maxMonthly) patch.maxMonthlyMinor = maxMonthly;
      if (Object.keys(patch).length === 0) throw new HttpError(400, "Choose a lower level or enter a lower limit.");
      const res = await lowerMandate(tenantId, key, patch, actor, reason, { db, now });
      const label = ASSISTANTS.find((x) => x.key === key)!.label;
      return done(res.change.changed ? `${label} lowered to level ${res.mandate.level}. Only the owner can raise it again.` : `${label} was already at or below that.`, res.change.changed, { assistantKey: key, level: res.mandate.level });
    }
    case "meta_limit_offboard": {
      const { isOffboardChoice, offboardAccount, offboardTenant } = await import("@/lib/spend/metacap/offboard");
      const choice = body.choice ?? "keep";
      if (!isOffboardChoice(choice)) throw new HttpError(400, "Choose to keep the limit, put back the old limit, or remove it.");
      const trigger = tenant.deletedAt ? "soft_delete" : tenant.status === "suspended" ? "suspend" : "turn_off";
      const assetId = typeof body.adAccountAssetId === "string" && body.adAccountAssetId && body.adAccountAssetId !== "all" ? body.adAccountAssetId : null;
      const io = { db: db as never, now, env: opts.env, reason };
      let results;
      if (assetId) results = [await offboardAccount(tenantId, assetId, choice, trigger, actor, io)];
      else {
        const rows = ((await db.metaSpendLimit.findMany({ where: { tenantId }, select: { adAccountAssetId: true } })) ?? []) as { adAccountAssetId: string }[];
        results = await offboardTenant(tenantId, trigger, { ...io, actor, choices: Object.fromEntries(rows.map((r) => [r.adAccountAssetId, choice])) });
      }
      if (results.length === 0) return done("Edwyz does not manage Meta's spending limit on any ad account of this workspace, so nothing changed.", false, { choice });
      return done(results.map((r) => r.text).join(" "), true, { choice, accounts: results.length }, { results: results.map((r) => ({ adAccountAssetId: r.adAccountAssetId, applied: r.applied, text: r.text })) });
    }
    case "lift_probation": {
      const before = await getControl(tenantId, { db, prune: false });
      await setProbation(tenantId, "lifted", actor, reason, { db });
      return done("New-workspace limits lifted. The plan and platform ceilings still apply.", before.probation !== "lifted");
    }
    case "set_probation": {
      const setting = body.setting === "auto" ? "auto" : body.setting === undefined || body.setting === "" || body.setting === "forced" ? "forced" : null;
      if (!setting) throw new HttpError(400, "Choose forced or automatic.");
      const before = await getControl(tenantId, { db, prune: false });
      await setProbation(tenantId, setting, actor, reason, { db });
      return done(setting === "forced" ? "New-workspace limits are on for this workspace until you lift them." : "New-workspace limits are back to automatic: they lift after 2 paid invoices or when the workspace is verified.", before.probation !== setting, { setting });
    }
    case "verify_workspace": {
      const verified = yes(body.verified, true);
      const before = await getControl(tenantId, { db, prune: false });
      await setWorkspaceVerified(tenantId, verified, actor, reason, { db, now });
      return done(verified ? "Workspace marked verified. Automatic new-workspace limits no longer apply." : "Verification removed. Automatic new-workspace limits apply again until 2 invoices are paid.", Boolean(before.verifiedAt) !== verified, { verified });
    }
    case "freeze_spending": {
      const level = body.level === "assistants" ? "assistants" : body.level === undefined || body.level === "" || body.level === "all" ? "all" : null;
      if (!level) throw new HttpError(400, "Choose to stop assistants or stop all spending.");
      const { stopInline } = await import("@/lib/spend/tasks/adsguard");
      const r = await setWorkspaceFreeze(tenantId, level, actor, reason, { db, now, inline: stopInline });
      return done(r.text, r.changed, { level, paused: r.paused, total: r.total }, { stop: stopResult(r) });
    }
    case "unfreeze_spending": {
      const r = await setWorkspaceFreeze(tenantId, "none", actor, reason, { db, now });
      return done(r.changed ? "Spending is back on for this workspace. Anything that was paused stays paused until the owner resumes it." : r.text, r.changed);
    }
    case "clear_breaker": {
      const breakerId = str(body, "breakerId", "Safety stop", 60);
      const open = (await db.spendBreaker.findFirst({ where: { id: breakerId, tenantId, state: "tripped" }, select: { id: true, kind: true } })) as { id: string; kind: string } | null;
      if (!open) throw new HttpError(404, "That safety stop is not open in this workspace.");
      const { clearBreaker } = await import("@/lib/spend/breakers/state");
      const r = await clearBreaker({ id: open.id }, { db, now, actor, reason });
      return done("Safety stop cleared. Anything it paused stays paused until the owner resumes it.", r.cleared, { kind: open.kind });
    }
    case "mark_test_ad_account": {
      const assetId = str(body, "adAccountAssetId", "Ad account", 60);
      const sandbox = yes(body.sandbox, true);
      const asset = (await db.metaAsset.findFirst({ where: { id: assetId, tenantId, type: "ad_account" }, select: { id: true, name: true, externalId: true, sandbox: true } })) as { id: string; name: string | null; externalId: string; sandbox: boolean } | null;
      if (!asset) throw new HttpError(404, "That ad account is not connected to this workspace.");
      if (asset.sandbox === sandbox) return done(sandbox ? "This ad account is already marked as a test ad account." : "This ad account is already a normal ad account.", false, { sandbox });
      if (sandbox) {
        // A test account is left out of real totals, so only an account with nothing running may become one.
        const running = await db.adCampaign.count({ where: { tenantId, adAccountAssetId: assetId, status: "active" } });
        const open = await db.spendCommitment.count({ where: { tenantId, adAccountAssetId: assetId, status: { in: ["reserved", "live", "unconfirmed"] } } });
        if (running + open > 0) throw new HttpError(409, "This ad account has ads running. Only an empty Meta test ad account can be marked as a test account.");
      }
      await applyLedgered(db, async (tx) => {
        await tx.metaAsset.update({ where: { id: assetId }, data: { sandbox } });
        return {
          result: null,
          row: {
            tenantId,
            pot: "ads",
            action: "ads.account.sandbox",
            actor,
            reason,
            reasonCodes: [sandbox ? "sandbox_on" : "sandbox_off"],
            targetType: "ad_account",
            targetId: assetId,
            metaObjectId: asset.externalId,
            before: { sandbox: asset.sandbox },
            after: { sandbox },
            undo: { action: "set_sandbox", adAccountAssetId: assetId, sandbox: asset.sandbox },
            sandbox,
          },
        };
      });
      return done(sandbox ? `${asset.name ?? asset.externalId} is now a test ad account: Meta's limit is not used on it and its figures are left out of real totals.` : `${asset.name ?? asset.externalId} is a normal ad account again.`, true, { sandbox });
    }
    case "end_learning": {
      const key = str(body, "assistantKey", "Assistant", 40);
      if (!isAssistantKey(key)) throw new HttpError(400, "Choose an assistant from the list.");
      const { endShadowEarly } = await import("@/lib/spend/shadow");
      await endShadowEarly(tenantId, key, actor, reason, { db, now, env: opts.env });
      return done(`${ASSISTANTS.find((x) => x.key === key)!.label} has finished learning. It now works at the level the owner chose.`, true, { assistantKey: key });
    }
    case "resync_meta_limit": {
      const control = await getControl(tenantId, { db, prune: false });
      const assetId = typeof body.adAccountAssetId === "string" && body.adAccountAssetId ? body.adAccountAssetId : control.spendingAdAccountAssetId;
      if (!assetId) throw new HttpError(409, "This workspace has no spending ad account yet.");
      const { replanTenant } = await import("@/lib/spend/metacap/sync");
      const results = await replanTenant(tenantId, assetId, { db: db as never, now, env: opts.env, actor });
      await appendStandalone(
        { tenantId, pot: "ads", action: "meta.spend_cap.resync", phase: "info", actor, reason, reasonCodes: ["admin_resync"], targetType: "ad_account", targetId: assetId, after: { results: results.map((r) => r.status) } },
        { db: db as never },
      );
      const statuses = results.map((r) => String(r.status));
      return done(statuses.length ? `Meta's limit was read again and re-planned (${statuses.join(", ")}). Any change uses Meta's normal daily change budget.` : "Edwyz does not manage Meta's limit on this ad account, so there was nothing to re-plan.", statuses.length > 0, { results: statuses.join(",").slice(0, 200) });
    }
  }
}

function stopResult(r: StopResultDTO): StopResultDTO {
  return { level: r.level, paused: r.paused, total: r.total, pending: r.pending, failed: r.failed, text: r.text };
}

// =====================================================================================================================
// The platform switch (8.3, 4.11)
// =====================================================================================================================

/** When the step-up cookie was issued (its expiry minus its lifetime), or null when it is missing or not valid. */
export function stepUpIssuedAt(value: string | null | undefined, userId: string, nowMs: number = Date.now()): Date | null {
  if (!value || !verifyStepUp(value, userId, nowMs)) return null;
  const exp = Number(value.split(".")[1]);
  return Number.isFinite(exp) ? new Date((exp - STEPUP_TTL_SECONDS) * 1000) : null;
}

export function stepUpIssuedAtFromRequest(request: Request, userId: string, nowMs: number = Date.now()): Date | null {
  try {
    return stepUpIssuedAt(readCookie(request, ADMIN_COOKIE), userId, nowMs);
  } catch {
    return null;
  }
}

/** True when the step-up is recent enough for the platform switch (the page hides the code field then). */
export function stepUpFresh(issuedAt: Date | null, now: Date = new Date()): boolean {
  return !!issuedAt && now.getTime() - issuedAt.getTime() <= PLATFORM_STEP_UP_MAX_AGE_MS && issuedAt.getTime() <= now.getTime() + 60_000;
}

export function isPlatformSwitchAction(value: unknown): value is PlatformSwitchAction {
  return typeof value === "string" && (PLATFORM_SWITCH_ACTIONS as readonly string[]).includes(value);
}

export const PLATFORM_SWITCH_LEVEL: Record<PlatformSwitchAction, FreezeLevel> = { stop_assistants: "assistants", stop_all: "all", resume: "none" };
export { PLATFORM_RESUME_CONFIRM, PLATFORM_STOP_CONFIRM };

export type PlatformSwitchResult = { ok: true; changed: boolean; level: FreezeLevel; text: string; stop: StopResultDTO; platform: PlatformSwitchView; freshStepUp: boolean };

/**
 * The platform-wide switch. A code typed in the dialog is checked here and counts as a fresh step-up; without one the
 * step-up cookie must be no older than 5 minutes. kill.ts checks the typed confirmation, the reason and the step-up age.
 */
export async function applyPlatformSwitch(adminUserId: string, body: Record<string, unknown>, request: Request, opts: AdminSpendOptions = {}): Promise<PlatformSwitchResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const action = body.action;
  if (!isPlatformSwitchAction(action)) throw new HttpError(400, "Choose to stop assistants everywhere, stop all spending everywhere, or turn spending back on.");
  const reason = requireReason(body);
  const confirm = typeof body.confirm === "string" ? body.confirm : "";
  let stepUpAt = stepUpIssuedAtFromRequest(request, adminUserId, now.getTime());
  let freshStepUp = false;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (code) {
    const { verifyStepUpCode } = await import("./security");
    await verifyStepUpCode(adminUserId, { code }, now.getTime());
    stepUpAt = now;
    freshStepUp = true;
  }
  const level = PLATFORM_SWITCH_LEVEL[action];
  const { stopInline } = await import("@/lib/spend/tasks/adsguard");
  const r = await setPlatformFreeze(level, platformActor(adminUserId), reason, { confirm, stepUpAt, inline: stopInline, db, now });
  const platform = await platformView(db);
  await audit({ userId: adminUserId, action: `admin.spend.${action}`, target: "platform", meta: { reason, changed: r.changed, paused: r.paused, total: r.total } });
  let text: string;
  if (!r.changed) text = level === "none" ? "Spending is already on for all workspaces." : level === "all" ? "Spending is already stopped everywhere." : "Assistants are already stopped everywhere.";
  else if (level === "none") text = "Spending is back on for all workspaces. Nothing restarts by itself: paused ads and broadcasts stay paused until each owner resumes them.";
  else {
    const paused = r.total === 0 ? "No ads were running in the first workspaces." : `Paused ${r.paused} of ${r.total} ${r.total === 1 ? "campaign" : "campaigns"} in the ${PLATFORM_INLINE_WORKSPACES} workspaces with the most at risk.`;
    text = `${level === "all" ? "All spending is stopped everywhere." : "Assistants are stopped everywhere."} ${paused} ${platform.progressText ?? "The rest are being paused in the background."}`;
  }
  return { ok: true, changed: r.changed, level, text, stop: stopResult(r), platform, freshStepUp };
}

// =====================================================================================================================
// Spending settings (8.3)
// =====================================================================================================================

export type SpendDefaults = {
  /** The request expiry new workspaces start with (1-48 hours). */
  approvalTtlHours: number;
  /** Routine Meta limit changes a day; the rest of Meta's 10 are kept for emergencies. */
  metaCapRoutinePerDay: number;
  metaCapEmergencyReserve: number;
  metaCapRaisesPerDay: number;
  shadowDays: number;
  updatedAt: string | null;
  byUserId: string | null;
};

export const SPEND_DEFAULTS: SpendDefaults = { approvalTtlHours: 12, metaCapRoutinePerDay: 6, metaCapEmergencyReserve: 4, metaCapRaisesPerDay: 2, shadowDays: 14, updatedAt: null, byUserId: null };

export function parseSpendDefaults(value: unknown): SpendDefaults {
  const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const int = (k: keyof SpendDefaults, min: number, max: number) => {
    const n = Number(v[k]);
    return Number.isInteger(n) && n >= min && n <= max ? n : (SPEND_DEFAULTS[k] as number);
  };
  const routine = int("metaCapRoutinePerDay", 1, META_CAP_CHANGES_PER_DAY);
  const reserve = Math.min(int("metaCapEmergencyReserve", 0, META_CAP_CHANGES_PER_DAY - 1), META_CAP_CHANGES_PER_DAY - routine);
  return {
    approvalTtlHours: int("approvalTtlHours", 1, 48),
    metaCapRoutinePerDay: routine,
    metaCapEmergencyReserve: reserve,
    metaCapRaisesPerDay: Math.min(int("metaCapRaisesPerDay", 0, META_CAP_CHANGES_PER_DAY), routine),
    shadowDays: int("shadowDays", 1, 60),
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
    byUserId: typeof v.byUserId === "string" ? v.byUserId : null,
  };
}

export async function readSpendDefaults(db: SpendDb = prisma): Promise<SpendDefaults> {
  return parseSpendDefaults(await readSetting(db, DEFAULTS_KEY));
}

export type CeilingCell = { pot: Pot; currency: string; daily: MoneyDTO | null; monthly: MoneyDTO | null; dailyText: string; monthlyText: string; set: boolean; note: string | null; updatedAt: string | null; reason: string | null };

export type SpendSettingsView = {
  newWorkspace: CeilingCell[];
  platform: CeilingCell[];
  fx: { maxAgeDays: number; rates: { currency: string; rate: string; updatedAt: string | null; fresh: boolean; status: string }[] };
  notifier: {
    settings: NotifySettings | null;
    workspaceName: string | null;
    /** Numbers in complimentary, active workspaces (the only ones the sender may be). */
    candidates: { phoneId: string; tenantId: string; label: string }[];
  };
  defaults: SpendDefaults;
};

/** Ads limits can be in these currencies before an ad account exists (8.1 currency select). */
const ADS_CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED"];

/** The rows a ceiling table shows: INR first, then every other currency in use or with a rate; missing rows read "Not set". */
export function ceilingCells(rows: CeilingRow[], scope: "probation" | "platform", fx: FxTable, now: Date): CeilingCell[] {
  const out: CeilingCell[] = [];
  for (const pot of POTS) {
    const mine = rows.filter((r) => r.scope === scope && r.pot === pot);
    const currencies = pot === "ai" ? [CRD] : pot === "messaging" ? [FX_BASE, ...mine.map((r) => r.currency)] : [...ADS_CURRENCIES, ...Object.keys(fx.rates), ...mine.map((r) => r.currency)];
    const inr = mine.find((r) => r.currency === FX_BASE) ?? null;
    for (const currency of [...new Set(currencies)].sort((a, b) => (a === FX_BASE ? -1 : b === FX_BASE ? 1 : a.localeCompare(b)))) {
      const row = mine.find((r) => r.currency === currency) ?? null;
      const rate = currency !== FX_BASE && currency !== CRD ? freshRate(fx, currency, now) : null;
      const note = row
        ? null
        : currency === FX_BASE || currency === CRD
          ? scope === "platform"
            ? "No platform ceiling."
            : "No limit for new workspaces."
          : inr && rate
            ? `Uses the INR row at ${rate.rate} INR for 1 ${currency}.`
            : inr
              ? `No ${currency} row and no fresh exchange rate: workspaces in ${currency} can't raise spending.`
              : null;
      out.push({
        pot,
        currency,
        daily: toMoneyDTOOrNull(row?.dailyMinor ?? null, currency),
        monthly: toMoneyDTOOrNull(row?.monthlyMinor ?? null, currency),
        dailyText: row?.dailyMinor !== null && row?.dailyMinor !== undefined ? formatMinor(row.dailyMinor, currency) : "Not set",
        monthlyText: row?.monthlyMinor !== null && row?.monthlyMinor !== undefined ? formatMinor(row.monthlyMinor, currency) : "Not set",
        set: !!row,
        note,
        updatedAt: row?.updatedAt?.toISOString() ?? null,
        reason: row?.reason ?? null,
      });
    }
  }
  return out;
}

export async function getSpendSettings(opts: AdminSpendOptions = {}): Promise<SpendSettingsView> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const [ceilings, fx, notifyRaw, defaults] = await Promise.all([listCeilings({}, db), readFx(db), readSetting(db, NOTIFY_KEY), readSpendDefaults(db)]);
  const settings = parseNotifySettings(notifyRaw);
  const exempt = ((await db.tenant.findMany({ where: { billingExempt: true, status: "active", deletedAt: null }, select: { id: true, name: true }, take: 200 })) ?? []) as { id: string; name: string }[];
  const phones = exempt.length
    ? (((await db.phoneNumber.findMany({ where: { tenantId: { in: exempt.map((t) => t.id) } }, select: { id: true, tenantId: true, displayPhone: true, verifiedName: true }, take: 500 })) ?? []) as { id: string; tenantId: string; displayPhone: string; verifiedName: string | null }[])
    : [];
  const nameOf = new Map(exempt.map((t) => [t.id, t.name]));
  const notifierTenant = settings ? ((await db.tenant.findUnique({ where: { id: settings.tenantId }, select: { name: true } })) as { name?: string } | null) : null;
  return jsonSafe({
    newWorkspace: ceilingCells(ceilings, "probation", fx, now),
    platform: ceilingCells(ceilings, "platform", fx, now),
    fx: {
      maxAgeDays: FX_MAX_AGE_DAYS,
      rates: listFxRates(fx, now).map((r) => ({ currency: r.currency, rate: r.rate, updatedAt: r.updatedAt?.toISOString() ?? null, fresh: r.fresh, status: r.fresh ? "In use" : "Out of date" })),
    },
    notifier: {
      settings,
      workspaceName: notifierTenant?.name ?? null,
      candidates: phones.map((p) => ({ phoneId: p.id, tenantId: p.tenantId, label: `${p.displayPhone}${p.verifiedName ? ` (${p.verifiedName})` : ""} - ${nameOf.get(p.tenantId) ?? "Workspace"}` })),
    },
    defaults,
  }) as SpendSettingsView;
}

const intIn = (body: Record<string, unknown>, key: string, label: string, min: number, max: number): number => {
  const raw = body[key];
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
  return n;
};

/** PUT /api/admin/spending/settings: one section at a time, each with a reason. */
export async function updateSpendSettings(adminUserId: string, body: Record<string, unknown>, opts: AdminSpendOptions = {}): Promise<{ ok: true; text: string; settings: SpendSettingsView }> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const section = body.section;
  if (typeof section !== "string" || !(SETTINGS_SECTIONS as readonly string[]).includes(section)) throw new HttpError(400, "Choose which settings to change.");
  const reason = requireReason(body);
  const actor = platformActor(adminUserId);
  let text = "Saved.";
  let auditAction = `admin.spend.${section}`;
  let meta: Meta = { reason };

  switch (section as SettingsSection) {
    case "ceiling": {
      const scope = body.scope === "platform" ? "platform" : body.scope === "probation" ? "probation" : null;
      if (!scope) throw new HttpError(400, "Choose new-workspace limits or platform ceilings.");
      const pot = potField(body);
      const currency = pot === "ai" ? CRD : String(body.currency ?? "").trim().toUpperCase();
      if (!isCurrencyCode(currency) || (pot !== "ai" && currency === CRD)) throw new HttpError(400, "Use a three-letter currency code such as INR.");
      const daily = amountField(body, "daily", "Daily limit", currency) ?? null;
      const monthly = amountField(body, "monthly", "Monthly limit", currency) ?? null;
      if (daily !== null && monthly !== null && daily > monthly) throw new HttpError(400, "The daily limit can't be more than the monthly limit.");
      const what = scope === "probation" ? "new-workspace" : "platform";
      if (daily === null && monthly === null) {
        const { deleted } = await clearCeiling({ scope, pot, currency }, actor, reason, { db });
        text = deleted ? `The ${what} ${POT_LABEL[pot]} row for ${currency} is now Not set.` : `The ${what} ${POT_LABEL[pot]} row for ${currency} was already Not set.`;
        auditAction = "admin.spend.clear_ceiling";
      } else {
        await setCeiling({ scope, pot, currency, dailyMinor: daily, monthlyMinor: monthly }, actor, reason, { db, now });
        const show = (v: bigint | null) => (v === null ? "Not set" : formatMinor(v, currency));
        text = `Saved the ${what} ${POT_LABEL[pot]} limits in ${currency}: ${show(daily)} a day, ${show(monthly)} a month.`;
      }
      meta = { reason, scope, pot, currency, dailyMinor: daily?.toString() ?? null, monthlyMinor: monthly?.toString() ?? null };
      break;
    }
    case "fx": {
      const currency = String(body.currency ?? "").trim().toUpperCase();
      const raw = body.rate;
      const rate = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "") ? null : String(raw).trim();
      await setFxRates({ [currency]: rate }, actor, reason, { db, now });
      text = rate === null ? `Removed the ${currency} exchange rate. Limits in ${currency} now need their own rows.` : `Saved 1 ${currency} = ${rate} INR, dated today. It is used for ${FX_MAX_AGE_DAYS} days.`;
      meta = { reason, currency, rate };
      break;
    }
    case "notifier": {
      const phoneId = str(body, "phoneNumberId", "Sending number", 60);
      const phone = (await db.phoneNumber.findFirst({ where: { id: phoneId }, select: { id: true, tenantId: true, displayPhone: true } })) as { id: string; tenantId: string; displayPhone: string } | null;
      if (!phone) throw new HttpError(404, "That number was not found.");
      const tenant = (await db.tenant.findUnique({ where: { id: phone.tenantId }, select: { id: true, name: true, billingExempt: true, status: true, deletedAt: true } })) as { id: string; name: string; billingExempt: boolean; status: string; deletedAt: Date | null } | null;
      if (!tenant || tenant.deletedAt) throw new HttpError(404, "That number's workspace was not found.");
      if (!tenant.billingExempt || tenant.status !== "active") {
        throw new HttpError(409, `${tenant.name} must be complimentary and active before it can send owners' alerts, so a bill or a suspension can never silence them. Make it complimentary on its workspace page first.`);
      }
      // Its inbox will hold every owner's number, alert text and approval links: only platform admins may be members.
      const members = ((await db.membership.findMany({ where: { tenantId: tenant.id }, select: { userId: true } })) ?? []) as { userId: string }[];
      const memberIds = members.map((m) => m.userId);
      const users = memberIds.length ? (((await db.user.findMany({ where: { id: { in: memberIds } }, select: { email: true } })) ?? []) as { email: string | null }[]) : [];
      const outsiders = users.filter((u) => !isPlatformAdminEmail(u.email ?? null, (opts.env ?? process.env).PLATFORM_ADMIN_EMAILS)).length + Math.max(0, memberIds.length - users.length);
      if (outsiders > 0) {
        throw new HttpError(409, `${tenant.name} has ${outsiders === 1 ? "1 member who is" : `${outsiders} members who are`} not a platform admin. Its inbox would hold every owner's number and alerts, so remove them first, or choose the Edwyz notifier workspace.`);
      }
      const language = typeof body.language === "string" && /^[a-z]{2}(_[A-Z]{2})?$/.test(body.language.trim()) ? body.language.trim() : "en";
      const templates = { ...DEFAULT_NOTIFY_TEMPLATES } as Record<TemplateRole, string>;
      for (const k of Object.keys(DEFAULT_NOTIFY_TEMPLATES) as TemplateRole[]) {
        const v = body[`template_${k}`];
        if (typeof v === "string" && v.trim()) {
          if (!/^[a-z0-9_]{1,512}$/.test(v.trim())) throw new HttpError(400, "Template names use lowercase letters, numbers and underscores.");
          templates[k] = v.trim();
        }
      }
      const before = parseNotifySettings(await readSetting(db, NOTIFY_KEY));
      const value = { tenantId: tenant.id, phoneNumberId: phone.id, language, templates, senderDisplay: phone.displayPhone, updatedAt: now.toISOString(), byUserId: adminUserId };
      await applyLedgered(db, async (tx) => {
        await tx.platformSetting.upsert({ where: { key: NOTIFY_KEY }, create: { key: NOTIFY_KEY, value: value as Prisma.InputJsonValue }, update: { value: value as Prisma.InputJsonValue } });
        return {
          result: null,
          row: {
            tenantId: PLATFORM_LEDGER_TENANT,
            pot: "none",
            action: "notify.sender.change",
            actor,
            reason,
            targetType: "platform",
            targetId: NOTIFY_KEY,
            before: before ? { tenantId: before.tenantId, phoneNumberId: before.phoneNumberId, language: before.language, templates: before.templates } : null,
            after: { tenantId: tenant.id, phoneNumberId: phone.id, language, templates },
          },
        };
      });
      text = `Owners' alerts now come from ${phone.displayPhone} in ${tenant.name}.`;
      meta = { reason, tenantId: tenant.id };
      break;
    }
    case "defaults": {
      const approvalTtlHours = intIn(body, "approvalTtlHours", "Default request expiry (hours)", 1, 48);
      const routine = intIn(body, "metaCapRoutinePerDay", "Routine Meta limit changes a day", 1, META_CAP_CHANGES_PER_DAY);
      const reserve = intIn(body, "metaCapEmergencyReserve", "Changes kept for emergencies", 0, META_CAP_CHANGES_PER_DAY - 1);
      if (routine + reserve > META_CAP_CHANGES_PER_DAY) throw new HttpError(400, `Meta allows ${META_CAP_CHANGES_PER_DAY} limit changes a day. Routine changes plus the emergency reserve can't be more than that.`);
      const raises = body.metaCapRaisesPerDay === undefined || body.metaCapRaisesPerDay === "" ? Math.min(SPEND_DEFAULTS.metaCapRaisesPerDay, routine) : intIn(body, "metaCapRaisesPerDay", "Raises a day", 0, routine);
      const before = await readSpendDefaults(db);
      const value = { ...before, approvalTtlHours, metaCapRoutinePerDay: routine, metaCapEmergencyReserve: reserve, metaCapRaisesPerDay: raises, updatedAt: now.toISOString(), byUserId: adminUserId };
      await applyLedgered(db, async (tx) => {
        await tx.platformSetting.upsert({ where: { key: DEFAULTS_KEY }, create: { key: DEFAULTS_KEY, value: value as Prisma.InputJsonValue }, update: { value: value as Prisma.InputJsonValue } });
        return {
          result: null,
          row: {
            tenantId: PLATFORM_LEDGER_TENANT,
            pot: "none",
            action: "settings.defaults.change",
            actor,
            reason,
            targetType: "platform",
            targetId: DEFAULTS_KEY,
            before: { approvalTtlHours: before.approvalTtlHours, metaCapRoutinePerDay: before.metaCapRoutinePerDay, metaCapEmergencyReserve: before.metaCapEmergencyReserve, metaCapRaisesPerDay: before.metaCapRaisesPerDay },
            after: { approvalTtlHours, metaCapRoutinePerDay: routine, metaCapEmergencyReserve: reserve, metaCapRaisesPerDay: raises },
            undo: { action: "set_spend_defaults", approvalTtlHours: before.approvalTtlHours, metaCapRoutinePerDay: before.metaCapRoutinePerDay, metaCapEmergencyReserve: before.metaCapEmergencyReserve },
          },
        };
      });
      text = `Saved: requests expire after ${approvalTtlHours} hours by default; ${routine} routine Meta limit changes a day, ${reserve} kept for emergencies.`;
      meta = { reason, approvalTtlHours, routine, reserve, raises };
      break;
    }
  }
  await audit({ userId: adminUserId, action: auditAction, target: "platform", meta });
  return { ok: true, text, settings: await getSpendSettings({ db, now }) };
}

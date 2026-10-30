/**
 * The Spending limits page and its owner controls (docs/SPEND-CONTROLS-SPEC.md 8.1, 8.2, 8.4, 4.17, 9.1, 9.2, 2.3.13; WP-16).
 *
 * - spendSummary(actor): the per-role DTO behind GET /api/spend/summary. Every member gets it in every workspace state (no
 *   Meta connection, no WhatsApp number, the demo workspace "Sample data", locked, suspended); a missing SpendControl row is
 *   created with safe defaults (I11). Amounts are decimal strings of minor units plus formatted text (3.1). Team members get
 *   the totals, limits, Meta state, assistants and the new-workspace note, never ledger rows or the approvals list.
 * - spendBanners(actor): the single AppShell banner in the 8.2 priority order (a lighter read for every page).
 * - getControlSettings / updateControlSettings: the owner's settings (approvers, request expiry, time zone from the next local
 *   midnight, target cost per lead, "safety stops may pause campaigns my team made", the spending ad account after the old
 *   account's 5.8 choice, the daily summary). Ledgered as control.change.
 * - listActivity / activityCsv / undoLedgerRow: the activity table (admin and owner), its CSV, and Undo within 14 days (9.2):
 *   undoing a raise is a lowering and always allowed; undoing a lowering is a raise and goes through reserveAds (the ads
 *   service) or the allowance rules, so it can be refused with the normal copy.
 *
 * Copy is computed here and shown verbatim by the UI. It never says "minor units", the Meta field name, "allowance pot",
 * "commitment" or "probation" (the UI says "new-workspace limits"), and never invents a number: a limit with no value is
 * "Not set".
 */
import type { Prisma } from "@/generated/prisma/client";
import { getBillingStatus, assertTenantCanWrite } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { enqueue as enqueueJob } from "@/lib/queue";
import { HttpError, type Actor } from "@/lib/tenancy";
import { getAllowance, previewAllowanceChange, setAllowances, type AllowancePatch, type ResolvedLimits } from "./allowances";
import { hashApprovalToken, isApprovalTokenShape } from "./approval-token";
import { adsHeadroomDetail, headroom, type AdsHeadroomDetail } from "./book";
import { listBreakers, type BreakerRow } from "./breakers/state";
import { isMetaLimitManaged, loadAdAccounts, toMetaLimitRow, type AdAccountInfo } from "./commitments";
import { applyLedgered, getControl, type SpendControlState, type SpendDb } from "./control";
import { containsBannedWord, formatCopyDate, spendCopy } from "./copy";
import { isDemoWorkspace } from "./demo";
import { SpendBlockedError } from "./errors";
import { assistantSpendEnabled, spendCapMode, spendEnforceMode } from "./flags";
import { setWorkspaceFreeze, spendState } from "./kill";
import { appendStandalone, toLedgerRecord, type LedgerDb } from "./ledger";
import { CRD, currencyExponent, formatMinor, isCurrencyCode, parseMinorString, percentOf, toMoneyDTO, toMoneyDTOOrNull, type MoneyDTO } from "./money";
import { DEFAULT_TIMEZONE, isValidTimeZone, nextLocalMidnight, resolveTimeZone } from "./periods";
import { ASSISTANTS, isLoweringOp } from "./registry";
import { maxDailyBudgetWithin } from "./worstcase";
import {
  SPEND_QUEUES,
  type AdAccountDTO,
  type ApprovalDTO,
  type AssistantDTO,
  type AssistantLevelOptionDTO,
  type AutonomyLevel,
  type BreakerDTO,
  type ControlSettingsDTO,
  type FreezeDTO,
  type FreezeLevel,
  type FreezeState,
  type Headroom,
  type LedgerActorDTO,
  type LedgerPageDTO,
  type LedgerPot,
  type LedgerRecord,
  type LedgerRowDTO,
  type MandateDTO,
  type MetaLimitDTO,
  type MetaLimitState,
  type MetaOffboardChoice,
  type MetaSpendLimitMode,
  type NotifyChannelDTO,
  type NotifySettingsDTO,
  type PausedByStopDTO,
  type Pot,
  type PotDTO,
  type PotPeriodDTO,
  type PotStatus,
  type ProbationDTO,
  type ShadowSummaryDTO,
  type SpendActor,
  type SpendApprovalStatus,
  type SpendBannerDTO,
  type SpendCapabilities,
  type SpendRole,
  type SpendSummaryDTO,
  type SpendingAccountDTO,
  type TimezonesDTO,
  type WorkspaceSpendState,
} from "./types";

type Env = Record<string, string | undefined>;
export type SummaryOptions = { db?: SpendDb; now?: Date; env?: Env };

// =====================================================================================================================
// Local view types. The DTOs in types.ts are the stable contract; the page needs a few more fields, added here.
// =====================================================================================================================

/** A pot card: the DTO plus its help paragraphs (8.1), in order. */
export type PotView = PotDTO & { help: string[] };

/** A campaign a stop paused, with what the guarded [Resume] needs (decision 2.3.13). */
export type PausedByStopRow = PausedByStopDTO & { dailyBudget: MoneyDTO | null; confirmTotalMinor: number };

/** A banner, plus the localStorage key that remembers a dismissal (only the new-workspace banner is dismissible). */
export type SpendBannerView = SpendBannerDTO & { dismissKey?: string };

export type PendingTimezone = { timezone: string; effectiveAt: string; text: string };

export type SpendSummaryView = SpendSummaryDTO & {
  pots: { ads: PotView; messaging: PotView; ai: PotView };
  pausedByStop: PausedByStopRow[];
  banners: SpendBannerView[];
  banner: SpendBannerView | null;
  /** The 8.1 role note: null for the owner. */
  roleNote: string | null;
  workspaceName: string;
  pendingTimezone: PendingTimezone | null;
  /** Owner only: admins who can be named approvers. */
  admins: { userId: string; name: string }[];
  /** The 8.1 "Stopped" or "Spending is on" line, also used by the banner. */
  stopNote: string | null;
};

export type BannerOnlyView = { banner: SpendBannerView | null; banners: SpendBannerView[] };

// =====================================================================================================================
// Copy (8.1, 8.2, 8.4). Static UI labels live in the components; everything that depends on data is written here.
// =====================================================================================================================

export const POT_TITLES: Record<Pot, string> = { ads: "Ads on Facebook and Instagram", messaging: "WhatsApp messages", ai: "AI usage" };
export const ROLE_NOTES: Record<SpendRole, string | null> = {
  owner: null,
  admin: "You can lower limits or stop spending. Only the owner can raise a limit.",
  agent: "Only the owner can change spending limits. Ask them if you need more.",
};
/** The CapPanel's currency list (8.1: "A currency select (default INR) sits next to the inputs, with the CapPanel's list"). */
export const ADS_CURRENCY_OPTIONS: readonly string[] = ["INR", "USD", "EUR", "GBP", "AED"];
export const DEFAULT_NOTIFY_SENDER = "+1 711-268-5789";
/** 12.1a decision 2: no SMTP, so alerts come in the app and on WhatsApp, and the page says so. */
export const EMAIL_FALLBACK_TEXT = "Email alerts are off for now, so alerts come here in the app and on WhatsApp.";
export const ASSISTANTS_SUGGEST_ONLY = "Assistants only make suggestions for now.";
export const UNDO_WINDOW_MS = 14 * 86_400_000;
export const NEW_WORKSPACE_BANNER_DAYS = 7;
const PENDING_TZ_KEY = (tenantId: string) => `spend:tz-pending:${tenantId}`;
/** Written by the quality poll (src/lib/spend/messaging/quality.ts WABA_CURRENCY_KEY); read directly to keep this module light. */
const WABA_CURRENCY_KEY = (tenantId: string) => `spend:waba-currency:${tenantId}`;
const NOTIFY_SETTINGS_KEY = "spend:notify";

/** The three level texts of 8.1, as the Assistants card shows them. */
export const LEVEL_TEXTS: readonly AssistantLevelOptionDTO[] = [
  { level: 0, label: "Suggest only", description: "It suggests changes. Nothing happens until someone approves." },
  { level: 1, label: "Small changes", description: "It can pause ads, lower budgets and stop broadcasts at any time, and raise a budget by up to 20% a day within your limits." },
  { level: 2, label: "Autopilot", description: "It can start campaigns within your limits. Anything over a quarter of your monthly limit needs your approval." },
];

export const BREAKER_LABELS: Readonly<Record<string, string>> = {
  pacing: "Safety stop: spending too fast",
  efficiency: "Safety stop: cost per lead too high",
  spend_jump: "Safety stop: sudden jump in spending",
  cpm_ctr_anomaly: "Safety stop: unusual ad results",
  account_spike: "Safety stop: the ad account is spending unusually fast",
  daily_limit: "Safety stop: today's ads limit is used up",
  monthly_limit: "Safety stop: this month's ads limit is used up",
  budget_change_quota: "Safety stop: too many budget changes this hour",
  sync_stale: "Safety stop: figures from Meta are late",
  meta_cap_units: "Safety stop: Meta's limit needs a check",
  meta_cap_unreachable: "Safety stop: we can't reach the ad account",
  meta_cap_stale_high: "Safety stop: Meta's limit couldn't be lowered today",
  external_edit: "Safety stop: changed in Meta Ads Manager",
  wa_quality_yellow: "Safety stop: WhatsApp quality is medium",
  wa_quality_red: "Safety stop: WhatsApp quality is low",
  wa_restricted: "Safety stop: WhatsApp account restricted",
  waba_disabled: "Safety stop: WhatsApp account turned off by Meta",
};

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(v as number | string));
const date = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const max0 = (x: bigint): bigint => (x < 0n ? 0n : x);
const money = (minor: bigint, currency: string) => formatMinor(minor, currency);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const isOwner = (role: SpendRole) => role === "owner";
const isManager = (role: SpendRole) => role === "owner" || role === "admin";

/** "28 Oct, 14:05" in the given zone. */
export function formatStamp(at: Date, timezone: string): string {
  const day = formatCopyDate(at, timezone) ?? "";
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: resolveTimeZone(timezone) }).format(at);
  return `${day}, ${time}`;
}

/** Whole major units, rounded down: "A ₹2,000 daily limit allows ads with up to ₹1,142 a day in total budget." */
function wholeMajorDown(minor: bigint, currency: string): bigint {
  const scale = 10n ** BigInt(currencyExponent(currency));
  return (minor / scale) * scale;
}

/** The 1.75x sentence for a daily ads limit. */
export function budgetWithinSentence(dailyLimitMinor: bigint, currency: string): string {
  const within = wholeMajorDown(maxDailyBudgetWithin(dailyLimitMinor), currency);
  return `A ${money(dailyLimitMinor, currency)} daily limit allows ads with up to ${money(within, currency)} a day in total budget.`;
}

const PROPER_NOUNS = new Set(["Meta", "WhatsApp", "Edwyz", "Facebook", "Instagram", "AI", "Eddy"]);
/** "Cost per lead is ₹62..." -> "Why: cost per lead is ₹62..."; proper nouns keep their capital. */
export function whyText(reason: string): string {
  const text = reason.trim().replace(/\.$/, "");
  if (!text) return "";
  if (/^why:/i.test(text)) return text;
  const first = text.split(/\s/)[0];
  const lower = /^[A-Z][a-z]+$/.test(first) && !PROPER_NOUNS.has(first) ? text[0].toLowerCase() + text.slice(1) : text;
  return `Why: ${lower}`;
}

// =====================================================================================================================
// Capabilities (the 8.1 role table)
// =====================================================================================================================

/**
 * What the caller may do on the page. canUndoRaises: undo a raise (a lowering, owner and admin). canUndoLowerings: undo a
 * lowering (a raise, owner only, through the checks).
 */
export function capabilitiesFor(role: SpendRole, isApprover: boolean): SpendCapabilities {
  const owner = isOwner(role);
  const manager = isManager(role);
  return {
    role,
    canSeeActivity: manager,
    canExportActivity: manager,
    canLowerLimits: manager,
    canRaiseLimits: owner,
    canStopSpending: manager,
    canResumeSpending: owner,
    canChooseSpendingAccount: owner,
    canManageMetaLimit: owner,
    canRaiseAssistants: owner,
    canLowerAssistants: manager,
    canApproveRaises: owner || (role === "admin" && isApprover),
    canDecide: manager,
    canEditControlSettings: owner,
    canSetOwnAlertsNumber: owner || (role === "admin" && isApprover),
    canUndoRaises: manager,
    canUndoLowerings: owner,
  };
}

// =====================================================================================================================
// Small readers
// =====================================================================================================================

async function userNames(db: SpendDb, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => typeof v === "string" && v.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = ((await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } })) ?? []) as { id: string; name: string | null }[];
  return new Map(rows.map((r) => [r.id, (r.name ?? "").trim() || "A team member"]));
}

async function readSetting(db: SpendDb, key: string): Promise<unknown> {
  const row = (await db.platformSetting.findUnique({ where: { key } })) as { value?: unknown } | null;
  return row?.value ?? null;
}

async function workspaceStateOf(tenantId: string): Promise<WorkspaceSpendState> {
  try {
    const status = await getBillingStatus(tenantId);
    return status.state === "suspended" ? "suspended" : status.state === "locked" ? "locked" : "active";
  } catch {
    return "active";
  }
}

/** Runs a part of the page that may fail on its own without blanking the page (8.4). */
async function safely<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.error(`[spend] summary: ${what} not loaded: ${error instanceof Error ? error.message : "unknown"}`);
    return fallback;
  }
}

// =====================================================================================================================
// Freeze (8.1 KillSwitch)
// =====================================================================================================================

export const PLATFORM_FREEZE_TEXT =
  "Edwyz has paused spending for all workspaces while we check something. Your ads are paused. We'll tell you here and on WhatsApp when it's back.";
export const PLATFORM_ASSISTANTS_TEXT = "Edwyz has paused assistants for all workspaces while we check something. We'll tell you here and on WhatsApp when it's back.";

/** The status strip line of 8.1. */
export function freezeText(freeze: FreezeState, byName: string | null, timezone: string): string {
  if (freeze.platform === "all") return PLATFORM_FREEZE_TEXT;
  if (freeze.workspace === "none" && freeze.platform === "assistants") return PLATFORM_ASSISTANTS_TEXT;
  if (freeze.workspace === "none") return "Spending is on";
  const since = freeze.frozenAt ? ` since ${formatStamp(freeze.frozenAt, timezone)}` : "";
  const by = byName ? ` (stopped by ${byName})` : "";
  if (freeze.workspace === "all") return `All spending is stopped${since}${by}. Ads are paused and automatic messages are on hold.`;
  return `Assistants are stopped${since}${by}. Your team can still spend within your limits.`;
}

function freezeByName(freeze: FreezeState, names: Map<string, string>): string | null {
  if (freeze.frozenByKind === "platform_admin") return "Edwyz support";
  if (freeze.frozenByKind === "breaker") return "a safety stop";
  if (freeze.frozenByUserId) return names.get(freeze.frozenByUserId) ?? "a team member";
  return null;
}

function toFreezeDTO(freeze: FreezeState, names: Map<string, string>, timezone: string): FreezeDTO {
  const byName = freezeByName(freeze, names);
  return {
    workspace: freeze.workspace,
    platform: freeze.platform,
    effective: freeze.effective,
    since: iso(freeze.frozenAt),
    byKind: freeze.frozenByKind,
    byName,
    reason: freeze.reason,
    text: freezeText(freeze, byName, timezone),
  };
}

// =====================================================================================================================
// Time zones (3.1, 8.1)
// =====================================================================================================================

export function timezonesText(workspace: string, ads: string | null): string {
  if (!ads) return `Days and months follow ${workspace} time.`;
  if (ads === workspace) return `Days and months follow ${workspace} time, the same as your ad account.`;
  return `Ads days follow ${ads} (your ad account). WhatsApp and AI days follow ${workspace}.`;
}

function toTimezonesDTO(workspace: string, ads: string | null): TimezonesDTO {
  return { workspace, ads, differs: !!ads && ads !== workspace, text: timezonesText(workspace, ads) };
}

/** A time zone change waiting for the next local midnight (3.1). */
async function readPendingTimezone(db: SpendDb, tenantId: string): Promise<{ timezone: string; effectiveAt: Date } | null> {
  const v = (await readSetting(db, PENDING_TZ_KEY(tenantId))) as { timezone?: unknown; effectiveAt?: unknown } | null;
  if (!v || typeof v !== "object" || !isValidTimeZone(v.timezone)) return null;
  const at = date(v.effectiveAt);
  return at && !Number.isNaN(at.getTime()) ? { timezone: v.timezone as string, effectiveAt: at } : null;
}

/**
 * Applies a time zone change once its midnight has passed (read on every visit of the page and its routes). Counter keys
 * already written stay as they are, so no day is counted twice or skipped. Never throws.
 */
export async function applyDueTimezone(tenantId: string, opts: SummaryOptions = {}): Promise<boolean> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  try {
    const pending = await readPendingTimezone(db, tenantId);
    if (!pending || pending.effectiveAt.getTime() > now.getTime()) return false;
    const control = await getControl(tenantId, { db, prune: false });
    if (control.timezone !== pending.timezone) {
      await applyLedgered(db, async (tx) => {
        await tx.spendControl.update({ where: { tenantId }, data: { timezone: pending.timezone, version: { increment: 1 } } });
        return {
          result: null,
          row: {
            tenantId,
            pot: "none",
            action: "control.change",
            actor: { type: "system", job: "spend.timezone" },
            reason: `Days and months now follow ${pending.timezone} time.`,
            reasonCodes: ["timezone_applied"],
            targetType: "workspace",
            targetId: tenantId,
            before: { timezone: control.timezone },
            after: { timezone: pending.timezone },
            idempotencyKey: `tz:${tenantId}:${pending.effectiveAt.toISOString()}`,
          },
        };
      });
    }
    await db.platformSetting.deleteMany({ where: { key: PENDING_TZ_KEY(tenantId) } });
    return true;
  } catch (error) {
    console.error(`[spend] time zone change not applied: ${error instanceof Error ? error.message : "unknown"}`);
    return false;
  }
}

function pendingTimezoneView(p: { timezone: string; effectiveAt: Date } | null, current: string): PendingTimezone | null {
  if (!p || p.timezone === current) return null;
  return {
    timezone: p.timezone,
    effectiveAt: p.effectiveAt.toISOString(),
    text: `From ${formatStamp(p.effectiveAt, current)}, WhatsApp and AI days will follow ${p.timezone} time.`,
  };
}

// =====================================================================================================================
// Pots (8.1)
// =====================================================================================================================

function periodView(f: { spent: bigint; committed: bigint; held: bigint; left: bigint | null }, limit: bigint | null, currency: string): PotPeriodDTO {
  return {
    spent: toMoneyDTO(f.spent, currency),
    committed: toMoneyDTO(f.committed, currency),
    held: toMoneyDTO(f.held, currency),
    left: toMoneyDTOOrNull(f.left, currency),
    usedPct: percentOf(f.spent + f.committed + f.held, limit),
  };
}

function statusOf(pot: Pot, limits: ResolvedLimits, h: Headroom, connected: boolean): PotStatus {
  if (!limits.currencyMatches) return "currency_mismatch";
  if (pot === "ads" ? limits.daily === null : limits.monthly === null && limits.daily === null) return "not_set";
  if (!connected && pot !== "ai") return "not_connected";
  if (h.month.left === 0n || h.today.left === 0n) return "limit_reached";
  const pct = Math.max(percentOf(h.month.spent + h.month.committed + h.month.held, limits.monthly) ?? 0, percentOf(h.today.spent + h.today.committed + h.today.held, limits.daily) ?? 0);
  return pct >= 80 ? "near_limit" : "ok";
}

/** "Your limit is ₹50,000, but ₹20,000 applies until the new-workspace period ends." */
function newWorkspaceBindingNote(limits: ResolvedLimits): string | null {
  if (!limits.probation.on || !limits.allowance || !limits.currencyMatches) return null;
  const cur = limits.currency;
  const owner = limits.owner.monthly;
  const eff = limits.monthly;
  if (owner !== null && eff !== null && owner > eff && limits.monthlyBinding === "probation") return `Your limit is ${money(owner, cur)}, but ${money(eff, cur)} applies until the new-workspace period ends.`;
  const od = limits.owner.daily;
  const ed = limits.daily;
  if (od !== null && ed !== null && od > ed && limits.dailyBinding === "probation") return `Your daily limit is ${money(od, cur)}, but ${money(ed, cur)} applies until the new-workspace period ends.`;
  return null;
}

function limitsView(limits: ResolvedLimits, version: number) {
  const a = limits.allowance;
  const ownCur = a?.currency ?? limits.currency;
  const cur = limits.currency;
  return {
    daily: a ? toMoneyDTOOrNull(a.dailyLimitMinor, ownCur) : null,
    monthly: a ? toMoneyDTOOrNull(a.monthlyLimitMinor, ownCur) : null,
    effectiveDaily: toMoneyDTOOrNull(limits.daily, cur),
    effectiveMonthly: toMoneyDTOOrNull(limits.monthly, cur),
    ceiling: {
      daily: toMoneyDTOOrNull(limits.ceiling.daily, cur),
      monthly: toMoneyDTOOrNull(limits.ceiling.monthly, cur),
      source: limits.ceiling.source,
      expiresAt: iso(limits.ceiling.expiresAt),
      unknown: limits.unknownCeiling,
    },
    binding: limits.binding,
    migratedFromCap: a && a.migratedFromCapMinor !== null ? toMoneyDTO(a.migratedFromCapMinor, ownCur) : null,
    planCapMonthly: limits.pot === "ai" && limits.planCapMonthly !== undefined ? toMoneyDTOOrNull(limits.planCapMonthly ?? null, CRD) : null,
    version,
  };
}

function editView(role: SpendRole, limits: ResolvedLimits, currencyOptions: string[], canChangeCurrency: boolean) {
  const a = limits.allowance;
  const ownCur = a?.currency ?? limits.currency;
  const hasNumber = !!a && (a.dailyLimitMinor !== null || a.monthlyLimitMinor !== null);
  if (role === "owner") return { editable: true, maxDaily: null, maxMonthly: null, canChangeCurrency, currencyOptions };
  if (role === "admin" && hasNumber) {
    return { editable: true, maxDaily: toMoneyDTOOrNull(a!.dailyLimitMinor, ownCur), maxMonthly: toMoneyDTOOrNull(a!.monthlyLimitMinor, ownCur), canChangeCurrency: false, currencyOptions: [ownCur] };
  }
  return { editable: false, maxDaily: null, maxMonthly: null, canChangeCurrency: false, currencyOptions: [ownCur] };
}

const ADS_HELP_SET_ASIDE =
  "Set aside is the most your running ads could still spend. Meta can spend up to 75% more than a daily budget on a busy day, and up to 7 days of budget in a week, so we plan for that.";
const ADS_HELP_CREDITS = "Limits count what your ads spend, even when Meta pays part of it with a credit.";
export const MESSAGING_HELP = "Estimated cost of messages Meta charges you for. Broadcasts and automatic messages that would go over are held before they start. Messages your team types always go out.";
export const AI_HELP = "AI credits used by the AI agent, reply suggestions, Creative Studio and Eddy. When they run out, AI replies hand the chat to your team.";
export const SAMPLE_DATA_NOTE = "Sample data. This is a demo workspace, so nothing can be spent.";
export const NO_AD_ACCOUNT_NOTE = "No ad account connected yet. You can set your ads limits now; they apply as soon as you connect one.";
export const CHOOSE_ACCOUNT_NOTE = "Choose which ad account Edwyz can spend from. Until you do, new ads can't start.";
export const ASK_OWNER_ACCOUNT_NOTE = "Ask the owner to choose a spending ad account.";
export const ADS_NOT_SET_NOTE = "Not set. Ads can't start until you set a daily limit.";
export const MESSAGING_NOT_SET_NOTE = "Not set. Your team and automations send as usual; assistants can't send until you set a limit.";
export const NO_WHATSAPP_NOTE = "Connect WhatsApp to use this. You can set a limit now.";
export const MANAGED_EXTERNAL_NOTE = "Includes ads you run yourself in Meta Ads Manager on this ad account, because Meta's limit covers the whole account.";

function adAccountDTO(a: AdAccountInfo): AdAccountDTO {
  return { assetId: a.assetId, externalId: a.externalId, name: a.name, currency: a.currency, timezone: a.timezone, sandbox: a.sandbox, demo: a.demo };
}

/** The spending ad account: chosen, or the single active one; several unchosen means new ads can't start. */
function spendingAccountView(control: SpendControlState, accounts: AdAccountInfo[]): SpendingAccountDTO & { effective: AdAccountInfo | null } {
  const active = accounts.filter((a) => a.active);
  const chosen = control.spendingAdAccountAssetId ? (accounts.find((a) => a.assetId === control.spendingAdAccountAssetId) ?? null) : null;
  const effective = chosen ?? (active.length === 1 ? active[0] : null);
  return { chosen: chosen ? adAccountDTO(chosen) : null, accounts: accounts.map(adAccountDTO), needsChoice: !chosen && active.length > 1, effective };
}

function adsPot(detail: AdsHeadroomDetail, role: SpendRole, demo: boolean, account: ReturnType<typeof spendingAccountView>): PotView {
  const { headroom: h, limits, figures } = detail;
  const cur = limits.currency;
  const connected = detail.state.accounts.some((a) => a.active);
  const notes: string[] = [];
  if (demo) notes.push(SAMPLE_DATA_NOTE);
  if (!connected) notes.push(NO_AD_ACCOUNT_NOTE);
  if (account.needsChoice) {
    notes.push(CHOOSE_ACCOUNT_NOTE);
    if (role !== "owner") notes.push(ASK_OWNER_ACCOUNT_NOTE);
  }
  if (!limits.currencyMatches && limits.allowance) {
    notes.push(`Your ads limits are in ${limits.allowance.currency}, but this ad account uses ${cur}. Enter your limits again in ${cur}.`);
  }
  if (limits.currencyMatches && (limits.allowance?.dailyLimitMinor ?? null) === null) notes.push(ADS_NOT_SET_NOTE);
  const a = limits.allowance;
  if (a && a.migratedFromCapMinor !== null && a.dailyLimitMinor !== null) {
    const c = money(a.migratedFromCapMinor, a.currency);
    notes.push(`Your old daily cap of ${c} is now a daily limit of ${money(a.dailyLimitMinor, a.currency)}, the most Meta can spend on ${c} of daily budget.`);
  }
  if (figures.external.counted) {
    notes.push(MANAGED_EXTERNAL_NOTE);
    notes.push(`Other ads on this account (estimate): ${money(figures.external.spentMonth, cur)} this month.`);
  } else if (figures.external.spentMonth > 0n) {
    notes.push(`Other ads on this account (estimate, not counted in your limit): ${money(figures.external.spentMonth, cur)} this month.`);
  }
  const names = new Map(detail.state.accounts.map((x) => [x.assetId, x.name ?? x.externalId]));
  for (const o of figures.otherCurrency) {
    notes.push(`Also running on ${names.get(o.adAccountAssetId) ?? "another ad account"} (${o.currency}): up to ${money(o.couldAddThisMonth, o.currency)} more this month, not counted in your ${cur} limit.`);
  }
  if (figures.stale) notes.push("Meta hasn't sent fresh figures for over an hour, so today's figures assume the most your running ads could spend.");
  const binding = newWorkspaceBindingNote(limits);
  if (binding) notes.push(binding);
  const help = [limits.daily !== null ? `${ADS_HELP_SET_ASIDE} ${budgetWithinSentence(limits.daily, cur)}` : ADS_HELP_SET_ASIDE, ADS_HELP_CREDITS];
  const options = [...new Set([...ADS_CURRENCY_OPTIONS, ...(account.effective?.currency ? [account.effective.currency] : []), ...(a ? [a.currency] : [])])];
  const canChangeCurrency = !connected || !limits.currencyMatches;
  return {
    pot: "ads",
    title: POT_TITLES.ads,
    currency: cur,
    status: statusOf("ads", limits, h, connected),
    limits: limitsView(limits, a?.version ?? 0),
    month: periodView(h.month, limits.monthly, cur),
    today: periodView(h.today, limits.daily, cur),
    edit: editView(role, limits, options, canChangeCurrency),
    external:
      figures.external.counted || figures.external.spentMonth > 0n
        ? { counted: figures.external.counted, spentMonth: toMoneyDTO(figures.external.spentMonth, cur), riskMonth: toMoneyDTO(figures.external.riskMonth, cur), estimated: true }
        : null,
    otherCurrency: figures.otherCurrency.map((o) => ({ accountName: names.get(o.adAccountAssetId) ?? "Another ad account", currency: o.currency, couldAddThisMonth: toMoneyDTO(o.couldAddThisMonth, o.currency) })),
    stale: figures.stale,
    connected,
    sampleData: demo,
    notes,
    help,
  };
}

function counterPot(pot: "messaging" | "ai", h: Headroom, role: SpendRole, demo: boolean, connected: boolean, wabaCurrency: string | null): PotView {
  const limits = h.limits as ResolvedLimits;
  const cur = limits.currency;
  const notes: string[] = [];
  if (demo) notes.push(SAMPLE_DATA_NOTE);
  if (pot === "messaging") {
    if (!connected) notes.push(NO_WHATSAPP_NOTE);
    if (wabaCurrency && wabaCurrency !== cur) notes.push(`Meta bills your WhatsApp account in ${wabaCurrency}. These figures are estimates in ${cur} from Edwyz's price list.`);
    if (!limits.allowance || limits.allowance.monthlyLimitMinor === null) notes.push(MESSAGING_NOT_SET_NOTE);
  } else {
    if (limits.planCapMonthly !== undefined && limits.planCapMonthly !== null) notes.push(`Your plan allows up to ${formatMinor(limits.planCapMonthly, CRD)} a month.`);
    if (!limits.allowance || limits.allowance.monthlyLimitMinor === null) notes.push("Not set. Your plan's monthly credits apply; assistants can't use AI until you set a limit.");
  }
  if (!limits.currencyMatches && limits.allowance) notes.push(`Your WhatsApp limits are in ${limits.allowance.currency}, but prices are in ${cur}. Enter your limits again in ${cur}.`);
  const binding = newWorkspaceBindingNote(limits);
  if (binding) notes.push(binding);
  const options = pot === "ai" ? [CRD] : [...new Set([cur, ...(limits.allowance ? [limits.allowance.currency] : [])])];
  return {
    pot,
    title: POT_TITLES[pot],
    currency: cur,
    status: statusOf(pot, limits, h, connected),
    limits: limitsView(limits, limits.allowance?.version ?? 0),
    month: periodView(h.month, limits.monthly, cur),
    today: periodView(h.today, limits.daily, cur),
    edit: editView(role, limits, options, pot === "messaging" && !limits.currencyMatches),
    external: null,
    otherCurrency: [],
    stale: false,
    connected: pot === "ai" ? true : connected,
    sampleData: demo,
    notes,
    help: [pot === "messaging" ? MESSAGING_HELP : AI_HELP],
  };
}

// =====================================================================================================================
// New-workspace limits (8.1 note; 12.1a decision 3)
// =====================================================================================================================

function probationCeiling(limits: ResolvedLimits): { daily: bigint | null; monthly: bigint | null; unknown: boolean } | null {
  const src = limits.ceilingDetail?.sources?.find((s) => s.source === "probation");
  return src ? { daily: src.daily, monthly: src.monthly, unknown: src.unknown } : null;
}

function toProbationDTO(ads: ResolvedLimits, messaging: ResolvedLimits, ai: ResolvedLimits): ProbationDTO {
  const p = ads.probation;
  const ceilings = ([ads, messaging, ai] as ResolvedLimits[]).map((l) => {
    const c = probationCeiling(l);
    return { pot: l.pot, daily: c ? toMoneyDTOOrNull(c.daily, l.currency) : null, monthly: c ? toMoneyDTOOrNull(c.monthly, l.currency) : null };
  });
  let note: string | null = null;
  if (p.on) {
    const c = probationCeiling(ads);
    if (c && !c.unknown && c.daily !== null && c.monthly !== null) {
      note = `Your workspace is new, so ads can spend up to ${money(c.daily, ads.currency)} a day and ${money(c.monthly, ads.currency)} a month for now. This goes up after your first two payments, or ask support. ${budgetWithinSentence(c.daily, ads.currency)}`;
    } else {
      note = "Your workspace is new, so lower limits apply for now. They go up after your first two payments, or ask support.";
    }
    const m = probationCeiling(messaging);
    const i = probationCeiling(ai);
    const parts: string[] = [];
    if (m && !m.unknown && (m.daily !== null || m.monthly !== null)) {
      const d = m.daily !== null ? `${money(m.daily, messaging.currency)} a day` : null;
      const mo = m.monthly !== null ? `${money(m.monthly, messaging.currency)} a month` : null;
      parts.push(`WhatsApp messages up to ${[d, mo].filter(Boolean).join(" and ")}`);
    }
    if (i && !i.unknown && i.monthly !== null) parts.push(`AI up to ${formatMinor(i.monthly, CRD)} a month`);
    if (parts.length) note += ` For now the same applies to ${parts.join(", and ")}.`;
  }
  return { on: p.on, setting: p.setting, why: p.why, paidInvoices: p.paidInvoices, verifiedAt: iso(p.verifiedAt), ceilings, note };
}

// =====================================================================================================================
// Meta's spending limit (8.1 MetaLimitCard, 5.1-5.8)
// =====================================================================================================================

export const META_LIMIT_TEXT: Record<MetaLimitState, string> = {
  managed: "Managed by Edwyz.",
  ready: "Ready. Meta's limit will be switched on after our final check.",
  off: "Off. Turn on Meta's limit for extra safety.",
  pending_owner: "Waiting for the owner to turn this on.",
  withdrawn: "Off. Turn on Meta's limit for extra safety.",
  unavailable_prepaid: "Not available: this ad account uses prepaid funds. Your Edwyz limits still apply.",
  no_permission: "You need to be an admin of this ad account in Meta to turn this on.",
  currency_mismatch: "Not used: this ad account's currency is different from your ads limits. Your Edwyz limits still apply.",
  other_workspace: "Another Edwyz workspace already manages Meta's spending limit on this ad account. Your Edwyz limits still apply here.",
  sandbox: "Test account: Meta's limit isn't used.",
  demo: "Demo account: Meta's limit isn't used.",
  error: "Meta's limit couldn't be updated just now. Your Edwyz limits still apply, and we'll try again.",
  deferred: "Meta's limit will update later today. Your Edwyz limits still apply now.",
  loose: "Meta's limit is a little above your limit because some charges are still pending.",
  needs_monthly_limit: "Set a monthly ads limit first.",
  kept_while_paused: "Meta's limit is kept at last month's level while your workspace is paused.",
};

export type MetaLimitInput = {
  account: AdAccountInfo;
  row: Record<string, unknown> | null;
  role: SpendRole;
  workspaceState: WorkspaceSpendState;
  monthlyLimitMinor: bigint | null;
  now: Date;
  env?: Env;
};

/** Every state of the card, with its line verbatim from 8.1. Pure. */
export function metaLimitView(input: MetaLimitInput): MetaLimitDTO {
  const { account, row, role, now } = input;
  const env = input.env ?? process.env;
  const mode = (row ? String(row.mode ?? "off") : "off") as MetaSpendLimitMode;
  const currency = account.currency ?? (row?.currency as string | null) ?? null;
  const cur = currency ?? "INR";
  const lastCap = big(row?.lastReadCapMinor);
  const lastSpent = big(row?.lastReadAmountSpentMinor);
  const room = lastCap !== null && lastCap > 0n && lastSpent !== null ? max0(lastCap - lastSpent) : null;
  const deferredUntil = date(row?.deferredUntil);
  const loose = big(row?.loosenessMinor);
  const previous = big(row?.customerCapAtConsentMinor);
  const managedLike = mode === "managed";
  const verified = row ? isMetaLimitManaged(toMetaLimitRow({ ...row, adAccountAssetId: account.assetId }), env) : false;

  let state: MetaLimitState;
  if (account.demo) state = "demo";
  else if (account.sandbox || mode === "sandbox") state = "sandbox";
  else if (mode === "managed") {
    if (input.workspaceState !== "active") state = "kept_while_paused";
    else if (input.monthlyLimitMinor === null) state = "needs_monthly_limit";
    else if (spendCapMode(env) !== "enforce" || !verified) state = "ready";
    else if (deferredUntil && deferredUntil.getTime() > now.getTime() && big(row?.pendingTargetMinor) !== null) state = "deferred";
    else if (loose !== null && loose > 0n) state = "loose";
    else state = "managed";
  } else if (mode === "pending_owner" || mode === "withdrawn" || mode === "unavailable_prepaid" || mode === "no_permission" || mode === "currency_mismatch" || mode === "other_workspace" || mode === "error") state = mode;
  else state = "off";

  let text = META_LIMIT_TEXT[state];
  if (state === "managed" && room !== null) text = `Managed by Edwyz. Meta will stop this account after ${money(room, cur)} more this month.`;
  const owner = role === "owner";
  const blocked: MetaLimitState[] = ["demo", "sandbox", "unavailable_prepaid", "other_workspace", "currency_mismatch"];
  const canTurnOn = owner && !blocked.includes(state) && (state === "off" || state === "withdrawn" || state === "pending_owner" || state === "error" || state === "no_permission");
  const canTurnOff = owner && managedLike && !account.demo && !account.sandbox;
  const choices: MetaOffboardChoice[] = previous !== null && previous > 0n ? ["keep", "restore", "remove"] : ["keep", "remove"];
  let action: MetaLimitDTO["action"] = null;
  if (state === "no_permission") action = { kind: "connect_again", label: "Connect again with an admin account" };
  else if (state === "needs_monthly_limit" && owner) action = { kind: "set_monthly_limit", label: "Set a monthly limit" };
  else if (canTurnOn) action = { kind: "turn_on", label: "Turn on Meta's limit" };
  return {
    adAccountAssetId: account.assetId,
    accountName: account.name,
    accountExternalId: account.externalId,
    currency,
    mode,
    state,
    managed: verified,
    text,
    cap: lastCap !== null && lastCap > 0n ? toMoneyDTO(lastCap, cur) : null,
    amountSpent: lastSpent !== null ? toMoneyDTO(lastSpent, cur) : null,
    roomLeft: room !== null ? toMoneyDTO(room, cur) : null,
    target: toMoneyDTOOrNull(big(row?.targetCapMinor), cur),
    looseBy: loose !== null && loose > 0n ? toMoneyDTO(loose, cur) : null,
    previousCap: previous !== null && previous > 0n ? toMoneyDTO(previous, cur) : null,
    deferredUntil: iso(deferredUntil),
    lastReadAt: iso(date(row?.lastReadAt)),
    canTurnOn,
    canTurnOff,
    offboardChoices: canTurnOff ? choices : [],
    action,
  };
}

// =====================================================================================================================
// Assistants (8.1 AssistantsCard, 7.5)
// =====================================================================================================================

type MandateRow = Record<string, unknown>;
type ShadowRow = { assistantKey: string; actionKind: string; wouldDecision: string; forecastMonthMinor: unknown; currency: string | null };

function toMandateDTO(row: MandateRow, now: Date, env: Env): MandateDTO {
  const level = ([0, 1, 2].includes(Number(row.level)) ? Number(row.level) : 0) as AutonomyLevel;
  const until = date(row.shadowUntil);
  const learning = !!until && until.getTime() > now.getTime();
  const enabled = row.enabled === true;
  const currency = (row.currency as string | null) ?? null;
  const cur = currency ?? "INR";
  return {
    assistantKey: String(row.assistantKey),
    enabled,
    level,
    effectiveLevel: (assistantSpendEnabled(env) && enabled && !learning ? level : 0) as AutonomyLevel,
    allowedOps: Array.isArray(row.allowedOps) ? (row.allowedOps as string[]) : [],
    maxDaily: toMoneyDTOOrNull(big(row.maxDailyMinor), cur),
    maxMonthly: toMoneyDTOOrNull(big(row.maxMonthlyMinor), cur),
    currency,
    targetCostPerLead: toMoneyDTOOrNull(big(row.targetCostPerLeadMinor), cur),
    raiseStepPct: Number(row.raiseStepPct ?? 20),
    approvalSharePct: Number(row.approvalSharePct ?? 25),
    shadowStartedAt: iso(date(row.shadowStartedAt)),
    shadowUntil: iso(until),
    sandboxOnly: row.sandboxOnly === true,
    version: Number(row.version ?? 1),
    updatedAt: iso(date(row.updatedAt)),
  };
}

/** "Learning: suggests only until 11 Nov. So far it would have made 12 changes (9 cuts, 3 raises worth up to ₹4,200)." */
export function shadowSummary(until: Date | null, records: ShadowRow[], now: Date, timezone: string, currency: string): ShadowSummaryDTO {
  const learning = !!until && until.getTime() > now.getTime();
  const cuts = records.filter((r) => isLoweringOp(r.actionKind)).length;
  const raisesRows = records.filter((r) => !isLoweringOp(r.actionKind));
  const worth = raisesRows.reduce((s, r) => s + (big(r.forecastMonthMinor) ?? 0n), 0n);
  const n = records.length;
  let text: string | null = null;
  if (learning && until) {
    const day = formatCopyDate(until, timezone);
    if (n === 0) text = `Learning: suggests only until ${day}. So far it would have made no changes.`;
    else {
      const detail = [cuts ? plural(cuts, "cut", "cuts") : null, raisesRows.length ? `${plural(raisesRows.length, "raise", "raises")}${worth > 0n ? ` worth up to ${money(worth, currency)}` : ""}` : null].filter(Boolean).join(", ");
      text = `Learning: suggests only until ${day}. So far it would have made ${plural(n, "change", "changes")} (${detail}).`;
    }
  }
  return {
    learning,
    until: iso(until),
    text,
    wouldHaveMade: n,
    cuts,
    raises: raisesRows.length,
    raisesWorthUpTo: worth > 0n ? toMoneyDTO(worth, currency) : null,
    wouldExceedAllowance: records.filter((r) => r.wouldDecision === "refuse").length,
    agreedPct: null,
  };
}

async function loadAssistants(db: SpendDb, tenantId: string, role: SpendRole, now: Date, env: Env, timezone: string, adsCurrency: string): Promise<AssistantDTO[]> {
  const mandates = ((await db.assistantMandate.findMany({ where: { tenantId } })) ?? []) as MandateRow[];
  const records = ((await db.assistantShadowRecord.findMany({
    where: { tenantId },
    select: { assistantKey: true, actionKind: true, wouldDecision: true, forecastMonthMinor: true, currency: true },
    take: 5_000,
  })) ?? []) as ShadowRow[];
  return ASSISTANTS.map((def) => {
    const row = mandates.find((m) => m.assistantKey === def.key) ?? null;
    const mandate = row ? toMandateDTO(row, now, env) : null;
    const own = records.filter((r) => r.assistantKey === def.key);
    return {
      assistantKey: def.key,
      label: def.label,
      pots: [...def.pots],
      phase: def.phase,
      mandate,
      shadow: shadowSummary(date(row?.shadowUntil), own, now, timezone, mandate?.currency ?? adsCurrency),
      levelOptions: LEVEL_TEXTS.map((o) => ({ ...o })),
      canRaise: role === "owner",
      canLower: isManager(role),
    };
  });
}

// =====================================================================================================================
// Approvals (8.1 ApprovalsCard, 7.3, 7.4)
// =====================================================================================================================

export type ApprovalContext = { role: SpendRole | null; userId: string | null; approverUserIds: string[]; now: Date; names: Map<string, string> };

/** "Declined automatically in 11 hours" / "Declined automatically (no answer in 12 hours)." */
export function approvalExpiryText(status: SpendApprovalStatus, createdAt: Date, expiresAt: Date, now: Date): string {
  const ttlHours = Math.max(1, Math.round((expiresAt.getTime() - createdAt.getTime()) / 3_600_000));
  if (status === "expired" || (status === "pending" && expiresAt.getTime() <= now.getTime())) return `Declined automatically (no answer in ${plural(ttlHours, "hour", "hours")}).`;
  if (status !== "pending") return "";
  const ms = expiresAt.getTime() - now.getTime();
  if (ms < 3_600_000) return `Declined automatically in ${plural(Math.max(1, Math.ceil(ms / 60_000)), "minute", "minutes")}`;
  return `Declined automatically in ${plural(Math.ceil(ms / 3_600_000), "hour", "hours")}`;
}

/** An approval row as the card, the banner and the one-tap page show it. */
export function toApprovalDTO(row: Record<string, unknown>, ctx: ApprovalContext): ApprovalDTO {
  const createdAt = date(row.createdAt) ?? ctx.now;
  const expiresAt = date(row.expiresAt) ?? ctx.now;
  let status = String(row.status ?? "pending") as SpendApprovalStatus;
  if (status === "pending" && expiresAt.getTime() <= ctx.now.getTime()) status = "expired";
  const currency = (row.currency as string | null) ?? "INR";
  const fMonth = big(row.forecastMonthMinor);
  const fToday = big(row.forecastTodayMinor);
  const direction = row.direction === "lower" ? "lower" : "raise";
  const forecastText =
    direction === "lower"
      ? null
      : fMonth !== null && fMonth > 0n
        ? `Could add up to ${money(fMonth, currency)} this month (worst case)`
        : fToday !== null && fToday > 0n
          ? `Could add up to ${money(fToday, currency)} today (worst case)`
          : null;
  const role = ctx.role;
  const isApprover = !!ctx.userId && ctx.approverUserIds.includes(ctx.userId);
  const open = status === "pending";
  const decidedBy = (row.decidedByUserId as string | null) ?? null;
  return {
    id: String(row.id),
    assistantKey: String(row.assistantKey ?? ""),
    assistantLabel: ASSISTANTS.find((a) => a.key === row.assistantKey)?.label ?? "Assistant",
    pot: (["ads", "messaging", "ai"].includes(String(row.pot)) ? row.pot : "ads") as Pot,
    actionKind: String(row.actionKind ?? ""),
    direction,
    summary: String(row.summary ?? ""),
    reason: whyText(String(row.reason ?? "")),
    forecastToday: toMoneyDTOOrNull(fToday, currency),
    forecastMonth: toMoneyDTOOrNull(fMonth, currency),
    forecastText,
    status,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    expiryText: approvalExpiryText(status, createdAt, expiresAt, ctx.now),
    decidedAt: iso(date(row.decidedAt)),
    decidedByName: decidedBy ? (ctx.names.get(decidedBy) ?? "A team member") : null,
    decidedVia: (row.decidedVia as ApprovalDTO["decidedVia"]) ?? null,
    failureReason: (row.failureReason as string | null) ?? null,
    canApprove: open && (role === "owner" || (direction === "raise" ? role === "admin" && isApprover : role === "admin")),
    canDecline: open && isManager(role ?? "agent"),
  };
}

async function loadApprovals(db: SpendDb, tenantId: string, ctx: Omit<ApprovalContext, "names">): Promise<{ list: ApprovalDTO[]; waiting: number }> {
  const rows = ((await db.spendApproval.findMany({ where: { tenantId, status: "pending" }, orderBy: { createdAt: "desc" }, take: 50 })) ?? []) as Record<string, unknown>[];
  const open = rows.filter((r) => (date(r.expiresAt)?.getTime() ?? 0) > ctx.now.getTime());
  const names = await userNames(db, open.map((r) => r.decidedByUserId as string | null));
  return { list: open.slice(0, 20).map((r) => toApprovalDTO(r, { ...ctx, names })), waiting: open.length };
}

export type TokenApproval = { approval: ApprovalDTO; tenantId: string; workspaceName: string } | null;

/**
 * The approval behind a one-tap link (/s/<token>), as the signed-in person (or nobody) may act on it. Only the token's hash
 * is looked up; a malformed token is never read from the database.
 */
export async function loadApprovalByToken(token: string, viewer: Actor | null, opts: SummaryOptions = {}): Promise<TokenApproval> {
  if (!isApprovalTokenShape(token)) return null;
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const row = (await db.spendApproval.findUnique({ where: { tokenHash: hashApprovalToken(token) } })) as Record<string, unknown> | null;
  if (!row) return null;
  const tenantId = String(row.tenantId);
  const sameWorkspace = viewer?.tenantId === tenantId;
  const control = await getControl(tenantId, { db });
  const names = await userNames(db, [row.decidedByUserId as string | null]);
  const tenant = (await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })) as { name?: string } | null;
  const approval = toApprovalDTO(row, {
    role: sameWorkspace ? (viewer!.role as SpendRole) : null,
    userId: sameWorkspace ? viewer!.userId : null,
    approverUserIds: control.approverUserIds,
    now,
    names,
  });
  // Declining only lowers risk, so the token alone is enough for it (7.4).
  if (approval.status === "pending") approval.canDecline = true;
  return { approval, tenantId, workspaceName: tenant?.name ?? "your workspace" };
}

// =====================================================================================================================
// Breakers, paused-by-stop list, notifications
// =====================================================================================================================

async function loadBreakers(db: SpendDb, tenantId: string, role: SpendRole, isApprover: boolean, now: Date): Promise<BreakerDTO[]> {
  const rows = await listBreakers(tenantId, { db, now });
  const campaignIds = rows.filter((r) => r.scopeType === "campaign").map((r) => r.scopeId);
  const campaigns = campaignIds.length ? (((await db.adCampaign.findMany({ where: { tenantId, id: { in: campaignIds } }, select: { id: true, name: true } })) ?? []) as { id: string; name: string }[]) : [];
  const names = new Map(campaigns.map((c) => [c.id, c.name]));
  return rows.map((r: BreakerRow) => ({
    id: r.id,
    kind: r.kind,
    label: BREAKER_LABELS[r.kind] ?? "Safety stop",
    scopeType: r.scopeType,
    scopeId: r.scopeId,
    scopeName: names.get(r.scopeId) ?? null,
    state: r.state,
    effect: r.effect,
    reason: r.reason,
    trippedAt: r.trippedAt.toISOString(),
    clearedAt: iso(r.clearedAt),
    autoClearAt: iso(r.autoClearAt),
    canClear: role === "owner" || (role === "admin" && isApprover),
    clearIsRaise: r.effect === "pause_scope" || r.effect === "block_raises",
  }));
}

const STOP_PAUSE_ACTIONS = ["ads.campaign.pause", "ads.adset.pause"];
const RESUME_ACTIONS = ["ads.campaign.activate", "ads.adset.resume"];

/** Campaigns a stop paused that are still paused (decision 2.3.13): listed for the guarded [Resume], never restarted by itself. */
async function loadPausedByStop(db: SpendDb, tenantId: string, canResume: boolean, now: Date, currency: string): Promise<PausedByStopRow[]> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const pauses = (((await db.spendLedger.findMany({
    where: { tenantId, phase: "applied", action: { in: STOP_PAUSE_ACTIONS }, createdAt: { gte: since } },
    orderBy: { seq: "desc" },
    take: 300,
  })) ?? []) as Record<string, unknown>[])
    .map((r) => toLedgerRecord(r))
    .filter((r) => r.reasonCodes.includes("stop") && r.targetId);
  if (pauses.length === 0) return [];
  const latest = new Map<string, LedgerRecord>();
  for (const p of pauses) if (!latest.has(p.targetId!)) latest.set(p.targetId!, p);
  const ids = [...latest.keys()];
  const campaigns = ((await db.adCampaign.findMany({ where: { tenantId, id: { in: ids }, status: "paused" } })) ?? []) as Record<string, unknown>[];
  if (campaigns.length === 0) return [];
  const resumed = (((await db.spendLedger.findMany({ where: { tenantId, phase: "applied", action: { in: RESUME_ACTIONS }, targetId: { in: ids }, createdAt: { gte: since } }, take: 300 })) ?? []) as Record<string, unknown>[]).map((r) =>
    toLedgerRecord(r),
  );
  const sets = ((await db.adSet.findMany({ where: { tenantId, campaignId: { in: campaigns.map((c) => String(c.id)) } } })) ?? []) as Record<string, unknown>[];
  const accounts = ((await db.metaAsset.findMany({ where: { tenantId, type: "ad_account" }, select: { id: true, name: true } })) ?? []) as { id: string; name: string | null }[];
  const out: PausedByStopRow[] = [];
  for (const c of campaigns) {
    const id = String(c.id);
    const pause = latest.get(id)!;
    if (resumed.some((r) => r.targetId === id && r.seq > pause.seq)) continue;
    const own = sets.filter((s) => s.campaignId === id);
    const campaignDaily = Number(c.dailyBudgetMinor ?? 0);
    let daily = 0;
    let lifetime = 0;
    for (const s of own) {
      const sd = s.dailyBudgetMinor === null || s.dailyBudgetMinor === undefined ? null : Number(s.dailyBudgetMinor);
      const sl = s.lifetimeBudgetMinor === null || s.lifetimeBudgetMinor === undefined ? null : Number(s.lifetimeBudgetMinor);
      if (sd === null && sl !== null) lifetime += sl;
      else daily += sd ?? campaignDaily;
    }
    if (own.length === 0) daily = campaignDaily;
    const cur = String(c.currency ?? currency);
    out.push({
      campaignId: id,
      name: String(c.name ?? "Campaign"),
      adAccountName: accounts.find((a) => a.id === c.adAccountAssetId)?.name ?? null,
      pausedAt: pause.createdAt.toISOString(),
      canResume,
      dailyBudget: daily > 0 ? toMoneyDTO(BigInt(daily), cur) : null,
      confirmTotalMinor: daily + lifetime,
    });
  }
  return out.slice(0, 50);
}

async function loadNotify(db: SpendDb, tenantId: string, userId: string, control: SpendControlState): Promise<NotifySettingsDTO> {
  const settings = (await readSetting(db, NOTIFY_SETTINGS_KEY)) as { senderDisplay?: unknown; phoneDisplay?: unknown } | null;
  const sender = typeof settings?.senderDisplay === "string" ? settings.senderDisplay : typeof settings?.phoneDisplay === "string" ? settings.phoneDisplay : DEFAULT_NOTIFY_SENDER;
  const row = (await db.ownerNotifyChannel.findFirst({ where: { tenantId, userId } })) as Record<string, unknown> | null;
  const own: NotifyChannelDTO | null = row
    ? {
        id: String(row.id),
        userId,
        phone: String(row.phoneE164 ?? ""),
        status: row.optOutAt ? "opted_out" : row.verifiedAt ? "verified" : "pending",
        optInAt: iso(date(row.optInAt)),
        verifiedAt: iso(date(row.verifiedAt)),
        optOutAt: iso(date(row.optOutAt)),
        lastSentAt: iso(date(row.lastSentAt)),
        senderDisplay: sender,
      }
    : null;
  return { own, emailFallback: "off", emailFallbackText: EMAIL_FALLBACK_TEXT, digestEnabled: control.digestEnabled };
}

/** The stored digest for the "Yesterday" strip (9.3; written by the notifier as an in-app notice). */
async function loadYesterday(db: SpendDb, tenantId: string, now: Date): Promise<string | null> {
  const rows = ((await db.notice.findMany({ where: { tenantId, source: "spend", kind: "digest", createdAt: { gte: new Date(now.getTime() - 36 * 3_600_000) } }, take: 5 })) ?? []) as {
    payload?: unknown;
    createdAt?: Date;
  }[];
  const latest = rows.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
  const body = latest?.payload && typeof latest.payload === "object" ? (latest.payload as { body?: unknown }).body : null;
  return typeof body === "string" && body.trim() ? body.trim() : null;
}

// =====================================================================================================================
// Banners (8.2), highest priority first
// =====================================================================================================================

export type BannerInput = {
  tenantId: string;
  role: SpendRole;
  freeze: Pick<FreezeState, "workspace" | "platform">;
  /** Which pots are used up ("Ads are paused: this month's ads limit is used up."). */
  limitReached: { adsMonth: boolean; adsToday: boolean; messaging: boolean; ai: boolean };
  approvals: { waiting: number; canDecide: boolean };
  metaState: MetaLimitState | null;
  newWorkspace: boolean;
  needsAccountChoice: boolean;
};

const LINK = "/app/settings/spending";

/** Every banner that applies, in the 8.2 order. The AppShell shows the first one that is not dismissed. Pure. */
export function buildBanners(input: BannerInput): SpendBannerView[] {
  const out: SpendBannerView[] = [];
  const owner = input.role === "owner";
  const manager = isManager(input.role);
  // 1. Platform freeze.
  if (input.freeze.platform === "all") out.push({ kind: "platform_frozen", text: PLATFORM_FREEZE_TEXT, link: LINK, dismissible: false, tone: "danger" });
  else if (input.freeze.platform === "assistants") out.push({ kind: "platform_frozen", text: PLATFORM_ASSISTANTS_TEXT, link: LINK, dismissible: false, tone: "warning" });
  // 2. Workspace stopped.
  if (input.freeze.workspace === "all") {
    out.push({ kind: "workspace_stopped", text: `All spending is stopped. Ads are paused and automatic messages are on hold. ${owner ? "You can turn it back on in Settings > Spending limits." : "Only the owner can turn spending back on."}`, link: LINK, dismissible: false, tone: "danger" });
  } else if (input.freeze.workspace === "assistants") {
    out.push({ kind: "workspace_stopped", text: "Assistants are stopped. Your team can still spend within your limits.", link: LINK, dismissible: false, tone: "warning" });
  }
  // 3. A limit is used up.
  const l = input.limitReached;
  if (l.adsMonth) out.push({ kind: "limit_reached", text: "Ads are paused: this month's ads limit is used up.", link: LINK, dismissible: false, tone: "warning" });
  else if (l.adsToday) out.push({ kind: "limit_reached", text: "Ads are paused: today's ads limit is used up.", link: LINK, dismissible: false, tone: "warning" });
  if (l.messaging) out.push({ kind: "limit_reached", text: "Automatic WhatsApp messages are on hold: this month's WhatsApp limit is used up.", link: LINK, dismissible: false, tone: "warning" });
  if (l.ai) out.push({ kind: "limit_reached", text: "AI replies are off: this month's AI limit is used up. Your team can still reply.", link: LINK, dismissible: false, tone: "warning" });
  // 4. Requests waiting (approvers only).
  if (input.approvals.canDecide && input.approvals.waiting > 0) {
    const n = input.approvals.waiting;
    out.push({ kind: "approvals_waiting", text: `${n} spending ${n === 1 ? "request is" : "requests are"} waiting`, link: `${LINK}#approvals`, dismissible: false, tone: "info" });
  }
  // 5. Meta's limit needs attention.
  if (manager && input.metaState && ["no_permission", "error", "needs_monthly_limit"].includes(input.metaState)) {
    out.push({ kind: "meta_limit_attention", text: `Meta's spending limit needs attention: ${META_LIMIT_TEXT[input.metaState]}`, link: `${LINK}#meta-limit`, dismissible: false, tone: "warning" });
  }
  // 6. New-workspace limits (first 7 days, dismissible).
  if (input.newWorkspace) {
    out.push({
      kind: "new_workspace",
      text: "Your workspace is new, so lower spending limits apply for now. They go up after your first two payments.",
      link: LINK,
      dismissible: true,
      tone: "info",
      dismissKey: `wa-spend-new-workspace:${input.tenantId}`,
    });
  }
  // 7. Choose a spending ad account (owners only).
  if (owner && input.needsAccountChoice) out.push({ kind: "choose_spending_account", text: CHOOSE_ACCOUNT_NOTE, link: `${LINK}#ads`, dismissible: false, tone: "warning" });
  // 8. Meta's limit waiting for the owner (owners only).
  if (owner && input.metaState === "pending_owner") {
    out.push({ kind: "meta_limit_waiting_owner", text: "An admin asked to turn on Meta's spending limit for your ad account. Review it in Settings > Spending limits.", link: `${LINK}#meta-limit`, dismissible: false, tone: "info" });
  }
  return out;
}

async function isNewWorkspace(db: SpendDb, tenantId: string, probationOn: boolean, now: Date): Promise<boolean> {
  if (!probationOn) return false;
  const t = (await db.tenant.findUnique({ where: { id: tenantId }, select: { createdAt: true } })) as { createdAt?: Date } | null;
  const created = date(t?.createdAt);
  return !!created && now.getTime() - created.getTime() < NEW_WORKSPACE_BANNER_DAYS * 86_400_000;
}

// =====================================================================================================================
// The summary (GET /api/spend/summary)
// =====================================================================================================================

const roleOf = (actor: Actor): SpendRole => (actor.role === "owner" || actor.role === "admin" ? actor.role : "agent");

/** The whole Spending limits page for the caller's role. */
export async function spendSummary(actor: Actor, opts: SummaryOptions = {}): Promise<SpendSummaryView> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const tenantId = actor.tenantId;
  const role = roleOf(actor);
  await applyDueTimezone(tenantId, { db, now });
  const control = await getControl(tenantId, { db });
  const isApprover = control.approverUserIds.includes(actor.userId);
  const capabilities = capabilitiesFor(role, isApprover);
  const [workspaceState, demo] = await Promise.all([workspaceStateOf(tenantId), safely("demo", () => isDemoWorkspace(tenantId, db), false)]);
  const tenant = (await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })) as { name?: string } | null;

  const detail = await adsHeadroomDetail(tenantId, { db, now, env, fresh: true });
  const [messaging, ai] = await Promise.all([headroom(tenantId, "messaging", { db, now, env }), headroom(tenantId, "ai", { db, now, env })]);
  const accounts = detail.state.accounts;
  const account = spendingAccountView(control, accounts);
  const phones = await safely("phones", async () => (await db.phoneNumber.count({ where: { tenantId } })) as number, 0);
  const wabaCurrency = await safely(
    "waba currency",
    async () => {
      const v = (await readSetting(db, WABA_CURRENCY_KEY(tenantId))) as { wabas?: Record<string, { currency?: string | null }> } | null;
      const list = Object.values(v?.wabas ?? {})
        .map((w) => w?.currency)
        .filter((c): c is string => isCurrencyCode(c));
      return list[0] ?? null;
    },
    null as string | null,
  );

  const pots = {
    ads: adsPot(detail, role, demo, account),
    messaging: counterPot("messaging", messaging, role, demo, phones > 0, wabaCurrency),
    ai: counterPot("ai", ai, role, demo, true, null),
  };
  const names = await userNames(db, [control.frozenByUserId, ...control.approverUserIds]);
  const freeze = toFreezeDTO(detail.headroom.freeze, names, control.timezone);
  const probation = toProbationDTO(detail.limits, messaging.limits as ResolvedLimits, ai.limits as ResolvedLimits);
  const timezones = toTimezonesDTO(control.timezone, account.effective?.timezone ?? null);
  const metaRow = account.effective
    ? await safely("meta limit", async () => (await db.metaSpendLimit.findUnique({ where: { adAccountAssetId: account.effective!.assetId } })) as Record<string, unknown> | null, null)
    : null;
  const metaLimit = account.effective ? metaLimitView({ account: account.effective, row: metaRow, role, workspaceState, monthlyLimitMinor: detail.limits.monthly, now, env }) : null;
  const assistants = await safely("assistants", () => loadAssistants(db, tenantId, role, now, env, control.timezone, detail.limits.currency), [] as AssistantDTO[]);
  const breakers = await safely("breakers", () => loadBreakers(db, tenantId, role, isApprover, now), [] as BreakerDTO[]);
  const approvals = await safely("approvals", () => loadApprovals(db, tenantId, { role, userId: actor.userId, approverUserIds: control.approverUserIds, now }), { list: [] as ApprovalDTO[], waiting: 0 });
  const pausedByStop =
    detail.headroom.freeze.effective === "all" || !isManager(role)
      ? []
      : await safely("paused by stop", () => loadPausedByStop(db, tenantId, role === "owner" || isApprover, now, detail.limits.currency), [] as PausedByStopRow[]);
  const pendingTz = await safely("pending time zone", () => readPendingTimezone(db, tenantId), null);
  const newWorkspace = await safely("new workspace", () => isNewWorkspace(db, tenantId, probation.on, now), false);
  const banners = buildBanners({
    tenantId,
    role,
    freeze: detail.headroom.freeze,
    limitReached: {
      adsMonth: breakers.some((b) => b.kind === "monthly_limit") || (pots.ads.status === "limit_reached" && pots.ads.month.left?.minor === "0"),
      adsToday: breakers.some((b) => b.kind === "daily_limit") || (pots.ads.status === "limit_reached" && pots.ads.today.left?.minor === "0"),
      messaging: pots.messaging.month.left?.minor === "0",
      ai: pots.ai.month.left?.minor === "0",
    },
    approvals: { waiting: approvals.waiting, canDecide: approvals.list.some((a) => a.canApprove || a.canDecline) },
    metaState: metaLimit?.state ?? null,
    newWorkspace,
    needsAccountChoice: account.needsChoice,
  });

  const common = {
    tenantId,
    generatedAt: now.toISOString(),
    capabilities,
    enforce: spendEnforceMode(env),
    workspaceState,
    demo,
    freeze,
    probation,
    timezones,
    pots,
    spendingAccount: { chosen: account.chosen, accounts: account.accounts, needsChoice: account.needsChoice },
    metaLimit,
    assistants,
    assistantSpendEnabled: assistantSpendEnabled(env),
    breakers,
    approvalsWaiting: approvals.waiting,
    pausedByStop,
    banner: banners[0] ?? null,
    banners,
    roleNote: ROLE_NOTES[role],
    workspaceName: tenant?.name ?? "Your workspace",
    pendingTimezone: pendingTimezoneView(pendingTz, control.timezone),
    admins: [] as { userId: string; name: string }[],
    stopNote: freeze.effective === "none" ? null : role === "owner" ? null : "Only the owner can turn spending back on.",
  };
  if (role === "agent") return { ...common, role: "agent" };
  const controlSettings = controlSettingsDTO(control, names, detail.limits.currency);
  const notify = await safely("notifications", () => loadNotify(db, tenantId, actor.userId, control), { own: null, emailFallback: "off" as const, emailFallbackText: EMAIL_FALLBACK_TEXT, digestEnabled: control.digestEnabled });
  const yesterday = await safely("yesterday", () => loadYesterday(db, tenantId, now), null);
  if (role === "admin") return { ...common, role: "admin", approvals: approvals.list, controlSettings, notify, yesterday };
  const admins = await safely("admins", () => listAdmins(db, tenantId), []);
  return { ...common, role: "owner", approvals: approvals.list, controlSettings, notify, yesterday, admins };
}

/** Only what the AppShell banner needs: no ads maths (ads limits reached show through their safety stops). */
export async function spendBanners(actor: Actor, opts: SummaryOptions = {}): Promise<BannerOnlyView> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const tenantId = actor.tenantId;
  const role = roleOf(actor);
  const control = await getControl(tenantId, { db });
  const freeze = await spendState(tenantId, { db });
  const breakers = await safely("breakers", () => listBreakers(tenantId, { db, now }), [] as BreakerRow[]);
  const [messaging, ai] = await Promise.all([
    safely("messaging", () => headroom(tenantId, "messaging", { db, now, env }), null as Headroom | null),
    safely("ai", () => headroom(tenantId, "ai", { db, now, env }), null as Headroom | null),
  ]);
  const isApprover = control.approverUserIds.includes(actor.userId);
  const approvals = isManager(role)
    ? await safely("approvals", () => loadApprovals(db, tenantId, { role, userId: actor.userId, approverUserIds: control.approverUserIds, now }), { list: [] as ApprovalDTO[], waiting: 0 })
    : { list: [] as ApprovalDTO[], waiting: 0 };
  const accounts = await safely("accounts", () => loadAdAccounts(tenantId, control, db), [] as AdAccountInfo[]);
  const account = spendingAccountView(control, accounts);
  let metaState: MetaLimitState | null = null;
  if (account.effective && isManager(role)) {
    const row = await safely("meta limit", async () => (await db.metaSpendLimit.findUnique({ where: { adAccountAssetId: account.effective!.assetId } })) as Record<string, unknown> | null, null);
    const monthly = (await safely("ads limits", () => getAllowance(tenantId, "ads", db), null))?.monthlyLimitMinor ?? null;
    metaState = metaLimitView({ account: account.effective, row, role, workspaceState: "active", monthlyLimitMinor: monthly, now, env }).state;
  }
  const probationOn = messaging ? messaging.probation : false;
  const banners = buildBanners({
    tenantId,
    role,
    freeze,
    limitReached: {
      adsMonth: breakers.some((b) => b.kind === "monthly_limit"),
      adsToday: breakers.some((b) => b.kind === "daily_limit"),
      messaging: messaging?.month.left === 0n,
      ai: ai?.month.left === 0n,
    },
    approvals: { waiting: approvals.waiting, canDecide: isApprover || role === "owner" || approvals.list.some((a) => a.canApprove || a.canDecline) },
    metaState,
    newWorkspace: await safely("new workspace", () => isNewWorkspace(db, tenantId, probationOn, now), false),
    needsAccountChoice: account.needsChoice,
  });
  return { banner: banners[0] ?? null, banners };
}

// =====================================================================================================================
// Control settings (GET/PUT /api/spend/control), owner only
// =====================================================================================================================

async function listAdmins(db: SpendDb, tenantId: string): Promise<{ userId: string; name: string }[]> {
  const members = ((await db.membership.findMany({ where: { tenantId, role: "admin" }, select: { userId: true } })) ?? []) as { userId: string }[];
  const names = await userNames(db, members.map((m) => m.userId));
  return members.map((m) => ({ userId: m.userId, name: names.get(m.userId) ?? "A team member" }));
}

function controlSettingsDTO(control: SpendControlState, names: Map<string, string>, currency: string): ControlSettingsDTO {
  return {
    approverUserIds: control.approverUserIds,
    approvers: control.approverUserIds.map((id) => ({ userId: id, name: names.get(id) ?? "A team member" })),
    approvalTtlHours: control.approvalTtlHours,
    timezone: control.timezone,
    targetCostPerLead: toMoneyDTOOrNull(control.targetCostPerLeadMinor, currency),
    breakersMayPauseHumanCampaigns: control.breakersMayPauseHumanCampaigns,
    digestEnabled: control.digestEnabled,
    version: control.version,
  };
}

export type ControlSettingsView = ControlSettingsDTO & {
  admins: { userId: string; name: string }[];
  pendingTimezone: PendingTimezone | null;
  spendingAccount: SpendingAccountDTO;
  currency: string;
};

const OWNER_ONLY_SETTINGS = "Only the owner can change these settings.";

function requireOwner(actor: Actor): void {
  if (actor.role !== "owner") throw new HttpError(403, OWNER_ONLY_SETTINGS);
}

export async function getControlSettings(actor: Actor, opts: SummaryOptions = {}): Promise<ControlSettingsView> {
  requireOwner(actor);
  const db = opts.db ?? prisma;
  await applyDueTimezone(actor.tenantId, opts);
  const control = await getControl(actor.tenantId, { db });
  const names = await userNames(db, control.approverUserIds);
  const accounts = await loadAdAccounts(actor.tenantId, control, db);
  const account = spendingAccountView(control, accounts);
  const currency = account.effective?.currency ?? (await getAllowance(actor.tenantId, "ads", db))?.currency ?? "INR";
  return {
    ...controlSettingsDTO(control, names, currency),
    admins: await listAdmins(db, actor.tenantId),
    pendingTimezone: pendingTimezoneView(await readPendingTimezone(db, actor.tenantId), control.timezone),
    spendingAccount: { chosen: account.chosen, accounts: account.accounts, needsChoice: account.needsChoice },
    currency,
  };
}

export type ControlPatch = {
  approverUserIds?: string[];
  approvalTtlHours?: number;
  timezone?: string;
  targetCostPerLeadMinor?: bigint | null;
  breakersMayPauseHumanCampaigns?: boolean;
  digestEnabled?: boolean;
  spendingAdAccountAssetId?: string;
  offboardChoice?: MetaOffboardChoice;
};

const OFFBOARD_CHOICES: readonly MetaOffboardChoice[] = ["keep", "restore", "remove"];

/** Reads the PUT body. Throws HttpError(400) with a plain sentence for anything that can't be used. */
export function parseControlPatch(body: Record<string, unknown>): { patch: ControlPatch; version: number } {
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 0) throw new HttpError(400, "Reload the page and try again.");
  const patch: ControlPatch = {};
  if (body.approverUserIds !== undefined) {
    if (!Array.isArray(body.approverUserIds) || body.approverUserIds.length > 50 || !body.approverUserIds.every((v) => typeof v === "string" && v.length > 0 && v.length <= 64)) {
      throw new HttpError(400, "Choose approvers from the admins of this workspace.");
    }
    patch.approverUserIds = [...new Set(body.approverUserIds as string[])];
  }
  if (body.approvalTtlHours !== undefined) {
    const h = Number(body.approvalTtlHours);
    if (!Number.isInteger(h) || h < 1 || h > 48) throw new HttpError(400, "Choose between 1 and 48 hours.");
    patch.approvalTtlHours = h;
  }
  if (body.timezone !== undefined) {
    if (!isValidTimeZone(body.timezone)) throw new HttpError(400, "Choose a time zone from the list, like Asia/Kolkata.");
    patch.timezone = body.timezone as string;
  }
  if (body.targetCostPerLeadMinor !== undefined) {
    const v = body.targetCostPerLeadMinor;
    if (v === null || v === "") patch.targetCostPerLeadMinor = null;
    else {
      let minor: bigint;
      try {
        minor = typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : parseMinorString(String(v));
      } catch {
        throw new HttpError(400, "Enter the target cost per lead as a whole amount, or leave it empty.");
      }
      if (minor <= 0n) throw new HttpError(400, "Enter a target cost per lead above zero, or leave it empty.");
      patch.targetCostPerLeadMinor = minor;
    }
  }
  for (const key of ["breakersMayPauseHumanCampaigns", "digestEnabled"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") throw new HttpError(400, "Turn this setting on or off.");
    patch[key] = body[key] as boolean;
  }
  if (body.spendingAdAccountAssetId !== undefined) {
    if (typeof body.spendingAdAccountAssetId !== "string" || !body.spendingAdAccountAssetId) throw new HttpError(400, "Choose an ad account from the list.");
    patch.spendingAdAccountAssetId = body.spendingAdAccountAssetId;
  }
  if (body.offboardChoice !== undefined) {
    if (!OFFBOARD_CHOICES.includes(body.offboardChoice as MetaOffboardChoice)) throw new HttpError(400, "Choose what to do with Meta's limit on the old ad account.");
    patch.offboardChoice = body.offboardChoice as MetaOffboardChoice;
  }
  return { patch, version };
}

/** True when the patch turns something on that can let spending start (only that part is paywalled, 4.17). */
export function controlPatchRaises(patch: ControlPatch, current: Pick<SpendControlState, "spendingAdAccountAssetId">): boolean {
  return patch.spendingAdAccountAssetId !== undefined && patch.spendingAdAccountAssetId !== current.spendingAdAccountAssetId;
}

export type UpdateControlOptions = SummaryOptions & { enqueue?: (queue: string, payload: unknown) => Promise<unknown>; reason?: string };

const SETTING_LABEL: Record<string, string> = {
  approverUserIds: "who can approve spending",
  approvalTtlHours: "when requests expire",
  timezone: "the time zone",
  targetCostPerLeadMinor: "the target cost per lead",
  breakersMayPauseHumanCampaigns: "whether safety stops may pause your team's campaigns",
  digestEnabled: "the daily summary",
  spendingAdAccountAssetId: "the spending ad account",
};

async function enqueueSafely(opts: UpdateControlOptions, queue: string, payload: unknown): Promise<void> {
  try {
    await (opts.enqueue ?? enqueueJob)(queue, payload);
  } catch (error) {
    console.error(`[spend] could not enqueue ${queue}: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

/** PUT /api/spend/control: the owner's settings, with an optimistic version (409 spend.version). Ledgered as control.change. */
export async function updateControlSettings(actor: Actor, patch: ControlPatch, version: number, opts: UpdateControlOptions = {}): Promise<ControlSettingsView> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const tenantId = actor.tenantId;
  const who: SpendActor = { type: "user", userId: actor.userId, role: actor.role };
  if (actor.role !== "owner") {
    await appendStandalone({ tenantId, pot: "none", action: "control.change", phase: "refused", actor: who, reason: OWNER_ONLY_SETTINGS, reasonCodes: ["not_allowed"], targetType: "workspace", targetId: tenantId, after: Object.keys(patch) }, { db: db as unknown as LedgerDb });
    throw new HttpError(403, OWNER_ONLY_SETTINGS);
  }
  let offboard: { assetId: string; choice: MetaOffboardChoice } | null = null;
  let newAccount: string | null = null;
  let tzChange: { timezone: string; effectiveAt: Date } | null = null;
  let tzClear = false;
  try {
    await applyLedgered(db, async (tx) => {
      const control = await getControl(tenantId, { db: tx });
      if (control.version !== version) throw new SpendBlockedError("spend.version");
      const data: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const set = (key: keyof SpendControlState, value: unknown) => {
        const prev = control[key];
        const same = Array.isArray(prev) && Array.isArray(value) ? prev.length === value.length && prev.every((v, i) => v === (value as unknown[])[i]) : prev === value;
        if (same) return;
        data[key] = value;
        before[key] = prev;
        after[key] = value;
      };
      if (patch.approverUserIds !== undefined) {
        const admins = ((await tx.membership.findMany({ where: { tenantId, userId: { in: patch.approverUserIds }, role: "admin" }, select: { userId: true } })) ?? []) as { userId: string }[];
        const ok = new Set(admins.map((a) => a.userId));
        if (patch.approverUserIds.some((id) => !ok.has(id))) throw new HttpError(400, "Choose approvers from the admins of this workspace.");
        set("approverUserIds", patch.approverUserIds);
      }
      if (patch.approvalTtlHours !== undefined) set("approvalTtlHours", patch.approvalTtlHours);
      if (patch.targetCostPerLeadMinor !== undefined) set("targetCostPerLeadMinor", patch.targetCostPerLeadMinor);
      if (patch.breakersMayPauseHumanCampaigns !== undefined) set("breakersMayPauseHumanCampaigns", patch.breakersMayPauseHumanCampaigns);
      if (patch.digestEnabled !== undefined) set("digestEnabled", patch.digestEnabled);
      if (patch.timezone !== undefined) {
        // 3.1: a new zone takes effect at the next local midnight; until then the old one stays.
        if (patch.timezone === control.timezone) tzClear = true;
        else {
          tzChange = { timezone: patch.timezone, effectiveAt: nextLocalMidnight(now, control.timezone) };
          before.timezone = control.timezone;
          after.pendingTimezone = patch.timezone;
          after.effectiveAt = tzChange.effectiveAt.toISOString();
        }
      }
      if (patch.spendingAdAccountAssetId !== undefined && patch.spendingAdAccountAssetId !== control.spendingAdAccountAssetId) {
        const asset = (await tx.metaAsset.findFirst({ where: { id: patch.spendingAdAccountAssetId, tenantId, type: "ad_account", status: "active" }, select: { id: true } })) as { id: string } | null;
        if (!asset) throw new HttpError(400, "Choose an ad account from the list.");
        const old = control.spendingAdAccountAssetId;
        if (old) {
          const row = (await tx.metaSpendLimit.findUnique({ where: { adAccountAssetId: old } })) as { mode?: string } | null;
          if (row && (row.mode === "managed" || row.mode === "pending_owner")) {
            if (!patch.offboardChoice) {
              throw new HttpError(409, "Choose what happens to Meta's spending limit on your current ad account first: keep it, put back your old limit, or remove it.");
            }
            offboard = { assetId: old, choice: patch.offboardChoice };
          }
        }
        set("spendingAdAccountAssetId", patch.spendingAdAccountAssetId);
        newAccount = patch.spendingAdAccountAssetId;
      }
      if (Object.keys(data).length === 0 && !tzChange && !tzClear) return { result: null, row: null };
      if (Object.keys(data).length > 0) await tx.spendControl.update({ where: { tenantId }, data: { ...(data as Prisma.SpendControlUpdateInput), version: { increment: 1 } } });
      if (tzChange) {
        const tz = tzChange as { timezone: string; effectiveAt: Date };
        const value = { timezone: tz.timezone, effectiveAt: tz.effectiveAt.toISOString(), byUserId: actor.userId };
        await tx.platformSetting.upsert({ where: { key: PENDING_TZ_KEY(tenantId) }, create: { key: PENDING_TZ_KEY(tenantId), value }, update: { value } });
      } else if (tzClear) await tx.platformSetting.deleteMany({ where: { key: PENDING_TZ_KEY(tenantId) } });
      const changed = [...Object.keys(data), ...(tzChange ? ["timezone"] : [])];
      if (changed.length === 0) return { result: null, row: null };
      const undoFields = Object.fromEntries(Object.entries(before).filter(([k]) => k !== "spendingAdAccountAssetId" && k !== "timezone"));
      return {
        result: null,
        row: {
          tenantId,
          pot: "none",
          action: "control.change",
          actor: who,
          reason: (opts.reason ?? "").trim() || `Changed ${changed.map((k) => SETTING_LABEL[k] ?? k).join(", ")}.`,
          reasonCodes: changed.map((k) => `control_${k}`),
          targetType: "workspace",
          targetId: tenantId,
          before,
          after,
          undo: Object.keys(undoFields).length ? { action: "set_control", fields: undoFields } : null,
        },
      };
    });
  } catch (error) {
    if (error instanceof HttpError) {
      await appendStandalone(
        { tenantId, pot: "none", action: "control.change", phase: "refused", actor: who, reason: error.message, reasonCodes: [(error as { code?: string }).code ?? `http_${error.status}`], targetType: "workspace", targetId: tenantId },
        { db: db as unknown as LedgerDb },
      );
    }
    throw error;
  }
  const off = offboard as { assetId: string; choice: MetaOffboardChoice } | null;
  if (off) {
    await enqueueSafely(opts, SPEND_QUEUES.metacapOffboard, { tenantId, adAccountAssetId: off.assetId, choice: off.choice, trigger: "account_change", actor: who, reason: "The owner chose another spending ad account." });
  }
  const next = newAccount as string | null;
  if (next) await enqueueSafely(opts, SPEND_QUEUES.metacapReplan, { tenantId, adAccountAssetId: next, reason: "spending_account_changed" });
  return getControlSettings(actor, { db, now, env: opts.env });
}

// =====================================================================================================================
// Allowances (PUT /api/spend/allowances)
// =====================================================================================================================

export type AllowanceSaveResult = { correlationId: string | null; changed: boolean; direction: string; replanQueued: boolean };

/**
 * One pot's limits through setAllowances (the per-field rule, the version check and the ledger row). Raising operations
 * (a raise, Not set to a number, a number to Not set, a currency change) check the paywall first, and only for someone
 * who may raise at all, so an admin gets the 403 copy, not a 402 (4.17). Lowering works in every workspace state. A change
 * to the ads monthly limit queues the Meta-limit re-plan.
 */
export async function saveAllowance(actor: Actor, patch: AllowancePatch, version: number, opts: UpdateControlOptions = {}): Promise<AllowanceSaveResult> {
  const db = opts.db ?? prisma;
  const who: SpendActor = { type: "user", userId: actor.userId, role: actor.role };
  const preview = await previewAllowanceChange(actor.tenantId, patch, db);
  if (preview.raises && actor.role === "owner") await assertTenantCanWrite(actor.tenantId);
  const result = await setAllowances(actor.tenantId, patch, who, version, { reason: opts.reason, db: opts.db });
  const monthlyMoved = result.change.fields.some((f) => f.field === "monthly" && f.kind !== "same") || result.change.currencyChanged;
  let replanQueued = false;
  if (patch.pot === "ads" && result.change.changed && monthlyMoved) {
    const control = await getControl(actor.tenantId, { db, prune: false });
    await enqueueSafely(opts, SPEND_QUEUES.metacapReplan, { tenantId: actor.tenantId, ...(control.spendingAdAccountAssetId ? { adAccountAssetId: control.spendingAdAccountAssetId } : {}), reason: "ads_monthly_limit_changed", correlationId: result.correlationId ?? undefined });
    replanQueued = true;
  }
  return { correlationId: result.correlationId, changed: result.change.changed, direction: result.change.direction, replanQueued };
}

// =====================================================================================================================
// Observe mode (I12): the would-refuse flag every mutation returns
// =====================================================================================================================

/** Observe-mode refusals the book wrote for this workspace since `since` (the request start). */
export async function observeRefusalsSince(tenantId: string, since: Date, db: SpendDb = prisma): Promise<{ wouldRefuse: boolean; reasons: string[] }> {
  try {
    const rows = ((await db.spendLedger.findMany({ where: { tenantId, phase: "refused", observe: true, createdAt: { gte: since } }, take: 20 })) ?? []) as { reason?: string }[];
    return { wouldRefuse: rows.length > 0, reasons: [...new Set(rows.map((r) => String(r.reason ?? "")).filter(Boolean))] };
  } catch {
    return { wouldRefuse: false, reasons: [] };
  }
}

// =====================================================================================================================
// Activity (GET/POST /api/spend/ledger): admin and owner
// =====================================================================================================================

export const ACTIVITY_FILTERS = ["all", "ads", "whatsapp", "ai", "assistants", "safety"] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];
export const ACTIVITY_PAGE_MAX = 100;

export function isActivityFilter(v: unknown): v is ActivityFilter {
  return typeof v === "string" && (ACTIVITY_FILTERS as readonly string[]).includes(v);
}

function filterWhere(tenantId: string, filter: ActivityFilter): Prisma.SpendLedgerWhereInput {
  switch (filter) {
    case "ads":
      return { tenantId, pot: "ads" };
    case "whatsapp":
      return { tenantId, pot: "messaging" };
    case "ai":
      return { tenantId, pot: "ai" };
    case "assistants":
      return { tenantId, actorType: "assistant" };
    case "safety":
      return { tenantId, OR: [{ actorType: "breaker" }, { action: { in: ["breaker.trip", "breaker.clear"] } }] };
    default:
      return { tenantId };
  }
}

const ACTIVITY_DENIED = "Only owners and admins can see spending activity.";

function requireManager(actor: Actor): void {
  if (actor.role !== "owner" && actor.role !== "admin") throw new HttpError(403, ACTIVITY_DENIED);
}

function parseCursor(cursor: string | null | undefined): bigint | null {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  if (!/^\d{1,19}$/.test(cursor)) throw new HttpError(400, "Reload the page and try again.");
  const seq = BigInt(cursor);
  if (seq > 9_223_372_036_854_775_807n) throw new HttpError(400, "Reload the page and try again.");
  return seq;
}

type UndoKind = { supported: boolean; isRaise: boolean; ownerOnly: boolean };

/** How an undo recipe changes spending, read from the row alone (no database). */
export function classifyUndo(row: Pick<LedgerRecord, "action" | "undo" | "reasonCodes" | "before" | "after">): UndoKind {
  const recipe = row.undo && typeof row.undo === "object" ? (row.undo as { action?: unknown }) : null;
  const action = typeof recipe?.action === "string" ? recipe.action : null;
  const no: UndoKind = { supported: false, isRaise: false, ownerOnly: false };
  switch (action) {
    case "set_allowance": {
      // Undo moves each field from `after` back to `before`. It is a pure lowering only when every moved field goes from one
      // number to a smaller one in the same currency; Not set to a number, a number to Not set, a raise or a currency change
      // is owner only (decision 2.3.8).
      const b = (row.before ?? {}) as Record<string, unknown>;
      const a = (row.after ?? {}) as Record<string, unknown>;
      const num = (v: unknown): bigint | null => (v === null || v === undefined || v === "" ? null : /^\d+$/.test(String(v)) ? BigInt(String(v)) : null);
      let lowering = String(b.currency ?? "") === String(a.currency ?? "");
      let moved = false;
      for (const f of ["dailyLimitMinor", "monthlyLimitMinor"]) {
        const from = num(a[f]);
        const to = num(b[f]);
        if (from === to) continue;
        moved = true;
        if (from === null || to === null || to > from) lowering = false;
      }
      const raise = !(lowering && moved);
      return { supported: true, isRaise: raise, ownerOnly: raise };
    }
    case "set_freeze": {
      const level = (recipe as { level?: unknown }).level;
      const prev = (row.before as { freeze?: unknown } | null)?.freeze;
      const rank = (l: unknown) => (l === "all" ? 2 : l === "assistants" ? 1 : 0);
      const after = row.reasonCodes.find((c) => c.startsWith("freeze_"))?.slice(7) ?? null;
      const raising = rank(level ?? prev) < rank(after);
      return { supported: true, isRaise: raising, ownerOnly: raising };
    }
    case "pause_campaign":
    case "pause_adset":
    case "pause_ad":
      return { supported: true, isRaise: false, ownerOnly: false };
    case "set_adset_budget":
      // Written for a budget raise: undoing it lowers the budget again.
      return { supported: true, isRaise: false, ownerOnly: false };
    case "resume_campaign":
    case "resume_ad":
      return { supported: true, isRaise: true, ownerOnly: true };
    case "set_control":
      return { supported: true, isRaise: false, ownerOnly: true };
    default:
      return no;
  }
}

function actorLabel(r: LedgerRecord, names: Map<string, string>): LedgerActorDTO {
  const viaEddy = r.reasonCodes.includes("via_eddy");
  switch (r.actorType) {
    case "user": {
      const name = (r.actorId && names.get(r.actorId)) || "A team member";
      return { type: "user", id: r.actorId, label: viaEddy ? `${name} (with Eddy)` : name, viaEddy };
    }
    case "assistant":
      return { type: "assistant", id: r.assistantKey, label: ASSISTANTS.find((a) => a.key === r.assistantKey)?.label ?? "Assistant", viaEddy: false };
    case "breaker":
      return { type: "breaker", id: r.actorId, label: "Safety stop", viaEddy: false };
    case "platform_admin":
      return { type: "platform_admin", id: null, label: "Edwyz support", viaEddy: false };
    case "api":
      return { type: "api", id: r.actorId, label: "API key", viaEddy: false };
    case "external":
      return { type: "external", id: r.actorId, label: "Changed in Meta Ads Manager", viaEddy: false };
    default:
      return { type: "system", id: r.actorId, label: "Edwyz", viaEddy: false };
  }
}

const POT_WORD: Record<string, string> = { ads: "ads", messaging: "WhatsApp", ai: "AI" };

function moneyOrNotSet(v: unknown, currency: string): string {
  const b = typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : typeof v === "number" || typeof v === "bigint" ? BigInt(v) : null;
  return b === null ? "Not set" : formatMinor(b, currency);
}

/** The "What" column ("Raised daily budget ₹800 -> ₹1,000"). */
export function activitySummary(r: LedgerRecord, names: { campaigns: Map<string, string> }): string {
  const cur = r.currency ?? "INR";
  const before = (r.before ?? null) as Record<string, unknown> | Record<string, unknown>[] | null;
  const after = (r.after ?? null) as Record<string, unknown> | Record<string, unknown>[] | null;
  const campaign = r.targetId ? names.campaigns.get(r.targetId) : undefined;
  const named = campaign ? ` '${campaign}'` : "";
  switch (r.action) {
    case "ads.adset.budget_raise":
    case "ads.adset.budget_cut": {
      const b = Array.isArray(before) ? before[0]?.dailyBudgetMinor : (before as Record<string, unknown> | null)?.dailyBudgetMinor;
      const a = Array.isArray(after) ? after[0]?.dailyBudgetMinor : ((after as Record<string, unknown> | null)?.toMinor ?? r.amountMinor);
      const verb = r.action.endsWith("raise") ? "Raised" : "Lowered";
      return b !== undefined && b !== null ? `${verb} daily budget ${moneyOrNotSet(b, cur)} -> ${moneyOrNotSet(a, cur)}` : `${verb} daily budget to ${moneyOrNotSet(a, cur)}`;
    }
    case "ads.campaign.activate":
      return `Turned on${named || " a campaign"}`;
    case "ads.campaign.pause":
      return `Paused${named || " a campaign"}`;
    case "ads.campaign.archive":
      return `Archived${named || " a campaign"}`;
    case "ads.adset.pause":
      return campaign ? `Paused an ad set of '${campaign}'` : "Paused an ad set";
    case "ads.adset.resume":
      return "Turned an ad set back on";
    case "ads.ad.pause":
      return "Paused an ad";
    case "ads.ad.resume":
      return "Turned an ad back on";
    case "allowance.change": {
      const b = (before ?? {}) as Record<string, unknown>;
      const a = (after ?? {}) as Record<string, unknown>;
      const word = POT_WORD[r.pot] ?? "";
      const parts: string[] = [];
      const bc = String(b.currency ?? cur);
      const ac = String(a.currency ?? cur);
      for (const [field, label] of [["monthlyLimitMinor", "monthly"], ["dailyLimitMinor", "daily"]] as const) {
        if (!(field in a)) continue;
        if (String(b[field] ?? "") === String(a[field] ?? "") && bc === ac) continue;
        parts.push(`${word} ${label} limit ${moneyOrNotSet(b[field], bc)} -> ${moneyOrNotSet(a[field], ac)}`.trim());
      }
      return parts.length ? parts.map((p, i) => (i === 0 ? p[0].toUpperCase() + p.slice(1) : p)).join("; ") : `Tried to change the ${word} limits`;
    }
    case "kill.workspace": {
      const level = r.reasonCodes.find((c) => c.startsWith("freeze_"))?.slice(7);
      return level === "all" ? "Stopped all spending" : level === "assistants" ? "Stopped assistants" : "Turned spending back on";
    }
    case "kill.platform":
      return "Edwyz paused spending for every workspace";
    case "control.change":
      return "Changed spending settings";
    case "approval.create":
      return "Asked for approval";
    case "approval.approve":
      return "Approved a request";
    case "approval.decline":
      return "Declined a request";
    case "approval.expire":
      return "A request expired (declined automatically)";
    case "approval.supersede":
      return "A request was withdrawn";
    case "approval.apply":
      return "Applied an approved request";
    case "breaker.trip":
      return "A safety stop turned on";
    case "breaker.clear":
      return "A safety stop was cleared";
    case "mandate.change":
      return "Changed an assistant's settings";
    case "messaging.bulk_hold":
      return r.amountMinor !== null ? `Set aside ${formatMinor(r.amountMinor, cur)} for a broadcast` : "Set money aside for a broadcast";
    case "messaging.bulk_release":
      return "Gave back money set aside for a broadcast";
    case "messaging.settlement":
      return "Counted WhatsApp message costs";
    case "messaging.blocked":
      return "Held automatic WhatsApp messages";
    case "ai.settlement":
      return "Counted AI credits";
    case "meta.spend_cap.write":
      return "Updated Meta's spending limit";
    case "meta.spend_cap.observe":
      return "Checked Meta's spending limit";
    case "consent.meta_cap":
      return "Changed Meta's spending limit setting";
    case "consent.owner_whatsapp":
      return "Changed WhatsApp alerts";
    case "ledger.undo":
      return "Undid a change";
    case "ads.external_change":
      return "A change was made in Meta Ads Manager";
    default:
      return "Spending change";
  }
}

export type ActivityPage = LedgerPageDTO & { timezone: string };

const CLOSING: readonly string[] = ["applied", "failed", "unconfirmed", "refused", "reconciled"];

/**
 * One decision as the table shows it: the request's details (what, why, forecast, undo recipe) with its outcome's phase, id
 * and time. Outcome rows written by settleAds carry no recipe, so the request row is the source of those fields.
 */
function mergeDecision(outcome: LedgerRecord, request: LedgerRecord | undefined): LedgerRecord {
  if (!request || request.id === outcome.id) return outcome;
  return {
    ...request,
    id: outcome.id,
    seq: outcome.seq,
    phase: outcome.phase,
    createdAt: outcome.createdAt,
    reasonCodes: [...new Set([...request.reasonCodes, ...outcome.reasonCodes])],
    observe: request.observe || outcome.observe,
  };
}

function toRowDTO(r: LedgerRecord, role: SpendRole, now: Date, undone: Set<string>, people: Map<string, string>, campaigns: Map<string, string>): LedgerRowDTO {
  const cur = r.currency ?? "INR";
  const kind = classifyUndo(r);
  const until = new Date(r.createdAt.getTime() + UNDO_WINDOW_MS);
  const roleAllows = kind.ownerOnly || kind.isRaise ? role === "owner" : isManager(role);
  const available = kind.supported && r.phase === "applied" && until.getTime() > now.getTime() && !undone.has(r.correlationId) && roleAllows && !r.observe;
  return {
    id: r.id,
    seq: r.seq.toString(),
    createdAt: r.createdAt.toISOString(),
    pot: r.pot as LedgerPot,
    action: r.action,
    phase: r.phase,
    actor: actorLabel(r, people),
    assistantKey: r.assistantKey,
    autonomyLevel: r.autonomyLevel,
    targetType: r.targetType,
    targetId: r.targetId,
    metaObjectId: r.metaObjectId,
    summary: activitySummary(r, { campaigns }),
    amount: toMoneyDTOOrNull(r.amountMinor, cur),
    forecastToday: r.forecastTodayMinor !== null && r.forecastTodayMinor > 0n ? toMoneyDTO(r.forecastTodayMinor, cur) : null,
    forecastMonth: r.forecastMonthMinor !== null && r.forecastMonthMinor > 0n ? toMoneyDTO(r.forecastMonthMinor, cur) : null,
    reason: r.reason,
    reasonCodes: r.reasonCodes,
    approvalId: r.approvalId,
    correlationId: r.correlationId,
    observe: r.observe,
    sandbox: r.sandbox,
    undo: { available, isRaise: kind.isRaise, until: kind.supported && r.phase === "applied" ? until.toISOString() : null },
  };
}

/** Collapses request and outcome rows into one row per decision (a request still waiting for its outcome stays shown). */
async function decisionsOf(db: SpendDb, tenantId: string, page: LedgerRecord[]): Promise<LedgerRecord[]> {
  const correlations = [...new Set(page.map((r) => r.correlationId))];
  const related = correlations.length
    ? (((await db.spendLedger.findMany({ where: { tenantId, correlationId: { in: correlations } } })) ?? []) as Record<string, unknown>[]).map((r) => toLedgerRecord(r))
    : [];
  const requestOf = new Map(related.filter((r) => r.phase === "requested").map((r) => [r.correlationId, r]));
  const closed = new Set(related.filter((r) => CLOSING.includes(r.phase)).map((r) => r.correlationId));
  const out: LedgerRecord[] = [];
  for (const r of page) {
    if (r.phase === "requested") {
      if (!closed.has(r.correlationId)) out.push(r);
      continue;
    }
    out.push(CLOSING.includes(r.phase) ? mergeDecision(r, requestOf.get(r.correlationId)) : r);
  }
  return out;
}

async function describeRows(db: SpendDb, tenantId: string, rows: LedgerRecord[], role: SpendRole, now: Date): Promise<LedgerRowDTO[]> {
  const ids = [...new Set(rows.map((r) => r.correlationId))];
  const undoRows = ids.length
    ? (((await db.spendLedger.findMany({ where: { tenantId, action: "ledger.undo", phase: "info", targetId: { in: ids } }, select: { targetId: true } })) ?? []) as { targetId: string | null }[])
    : [];
  const undone = new Set(undoRows.map((u) => u.targetId).filter((v): v is string => !!v));
  const people = await userNames(db, rows.filter((r) => r.actorType === "user").map((r) => r.actorId));
  const campaignIds = [...new Set(rows.filter((r) => r.targetType === "campaign" || r.action.startsWith("ads.campaign") || r.action === "ads.adset.pause").map((r) => r.targetId).filter((v): v is string => !!v))];
  const campaigns = campaignIds.length ? (((await db.adCampaign.findMany({ where: { tenantId, id: { in: campaignIds } }, select: { id: true, name: true } })) ?? []) as { id: string; name: string }[]) : [];
  const campaignNames = new Map(campaigns.map((c) => [c.id, c.name]));
  return rows.map((r) => toRowDTO(r, role, now, undone, people, campaignNames));
}

/** One page of the activity table, newest first, by seq cursor (at most 100 rows). */
export async function listActivity(actor: Actor, q: { filter?: ActivityFilter; cursor?: string | null; limit?: number } = {}, opts: SummaryOptions = {}): Promise<ActivityPage> {
  requireManager(actor);
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const limit = Math.min(ACTIVITY_PAGE_MAX, Math.max(1, Math.floor(q.limit ?? 50)));
  const cursor = parseCursor(q.cursor);
  const where: Prisma.SpendLedgerWhereInput = { ...filterWhere(actor.tenantId, q.filter ?? "all") };
  if (cursor !== null) where.seq = { lt: cursor };
  const raw = ((await db.spendLedger.findMany({ where, orderBy: { seq: "desc" }, take: limit + 1 })) ?? []) as Record<string, unknown>[];
  const records = raw.map((r) => toLedgerRecord(r));
  const page = records.slice(0, limit);
  const control = await getControl(actor.tenantId, { db, prune: false });
  return {
    rows: await describeRows(db, actor.tenantId, await decisionsOf(db, actor.tenantId, page), roleOf(actor), now),
    nextCursor: records.length > limit ? page[page.length - 1].seq.toString() : null,
    timezone: control.timezone,
  };
}

const RESULT_WORD: Record<string, string> = {
  requested: "Asked",
  applied: "Done",
  failed: "Failed",
  unconfirmed: "Not confirmed yet",
  refused: "Refused",
  shadow: "Suggestion only",
  reconciled: "Checked with Meta",
  info: "Note",
};

/** The CSV export of the activity table (at most 5,000 rows), formula-safe. */
export async function activityCsv(actor: Actor, filter: ActivityFilter = "all", opts: SummaryOptions = {}): Promise<string> {
  requireManager(actor);
  const { csvRow, BOM } = await import("@/lib/reports/csv");
  const lines = [csvRow(["When", "Who", "What", "Could add today (worst case)", "Could add this month (worst case)", "Why", "Result"])];
  let cursor: string | null = null;
  let tz = DEFAULT_TIMEZONE;
  for (let i = 0; i < 50; i++) {
    const page: ActivityPage = await listActivity(actor, { filter, cursor, limit: 100 }, opts);
    tz = page.timezone;
    for (const r of page.rows) {
      const result = r.observe && r.phase === "refused" ? "Would have been refused" : RESULT_WORD[r.phase] ?? r.phase;
      lines.push(csvRow([formatStamp(new Date(r.createdAt), tz), r.actor.label, r.summary, r.forecastToday?.formatted ?? "", r.forecastMonth?.formatted ?? "", r.reason, result]));
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return BOM + lines.join("");
}

// =====================================================================================================================
// Undo (9.2)
// =====================================================================================================================

export type UndoResult = { text: string; isRaise: boolean; correlationId: string | null };

const UNDO_TOO_OLD = "Changes can be undone for 14 days. This one is older.";
const UNDO_DONE = "This change was already undone.";
const UNDO_NONE = "This change can't be undone from here.";
const UNDO_OWNER = "Only the owner can undo this, because undoing it raises spending. You can lower spending yourself.";

/** Undoes one activity row with its recipe. Lowering always works; a raise goes through reserveAds or the allowance rules. */
/** The daily budget an ad set runs at now: its open commitment's, else its row's. Null when neither is known. */
async function currentAdSetBudget(tenantId: string, metaAdSetId: string, db: SpendDb): Promise<number | null> {
  const c = (await db.spendCommitment.findFirst({ where: { tenantId, metaObjectId: metaAdSetId, status: { in: ["reserved", "live", "unconfirmed"] } }, select: { dailyBudgetMinor: true } })) as { dailyBudgetMinor?: unknown } | null;
  if (c?.dailyBudgetMinor !== null && c?.dailyBudgetMinor !== undefined) return Number(c.dailyBudgetMinor);
  const set = (await db.adSet.findFirst({ where: { tenantId, metaAdSetId }, select: { dailyBudgetMinor: true } })) as { dailyBudgetMinor?: unknown } | null;
  return set?.dailyBudgetMinor !== null && set?.dailyBudgetMinor !== undefined ? Number(set.dailyBudgetMinor) : null;
}

export async function undoLedgerRow(actor: Actor, rowId: string, opts: UpdateControlOptions = {}): Promise<UndoResult> {
  requireManager(actor);
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const tenantId = actor.tenantId;
  if (typeof rowId !== "string" || !rowId || rowId.length > 64) throw new HttpError(400, "Choose a change to undo.");
  const raw = (await db.spendLedger.findFirst({ where: { id: rowId, tenantId } })) as Record<string, unknown> | null;
  if (!raw) throw new HttpError(404, "That change was not found.");
  const picked = toLedgerRecord(raw);
  // The decision: its applied outcome, with the request's recipe and details.
  const related = (((await db.spendLedger.findMany({ where: { tenantId, correlationId: picked.correlationId } })) ?? []) as Record<string, unknown>[]).map((r) => toLedgerRecord(r));
  const outcome = picked.phase === "requested" ? related.find((r) => CLOSING.includes(r.phase)) : picked;
  const row = outcome ? mergeDecision(outcome, related.find((r) => r.phase === "requested")) : picked;
  const kind = classifyUndo(row);
  if (!kind.supported || row.phase !== "applied" || row.observe) throw new HttpError(409, UNDO_NONE);
  if (row.createdAt.getTime() + UNDO_WINDOW_MS <= now.getTime()) throw new HttpError(409, UNDO_TOO_OLD);
  const already = await db.spendLedger.findFirst({ where: { tenantId, action: "ledger.undo", phase: "info", targetId: row.correlationId } });
  if (already) throw new HttpError(409, UNDO_DONE);
  const who: SpendActor = { type: "user", userId: actor.userId, role: actor.role };
  if ((kind.isRaise || kind.ownerOnly) && actor.role !== "owner") {
    await appendStandalone({ tenantId, pot: row.pot, action: "ledger.undo", phase: "refused", actor: who, reason: UNDO_OWNER, reasonCodes: ["not_allowed"], targetType: "ledger", targetId: row.correlationId }, { db: db as unknown as LedgerDb });
    throw new HttpError(403, UNDO_OWNER);
  }
  const recipe = row.undo as Record<string, unknown>;
  const reason = `Undid: ${activitySummary(row, { campaigns: new Map() })}.`;
  let text = "Done. The change was undone.";
  switch (recipe.action) {
    case "set_allowance": {
      const pot = recipe.pot as Pot;
      const current = await getAllowance(tenantId, pot, db);
      const toBig = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(String(v)));
      const patch: AllowancePatch = { pot, dailyLimitMinor: toBig(recipe.dailyLimitMinor), monthlyLimitMinor: toBig(recipe.monthlyLimitMinor) };
      if (typeof recipe.currency === "string" && current && recipe.currency !== current.currency) patch.currency = recipe.currency;
      await saveAllowance(actor, patch, current?.version ?? 0, { ...opts, reason });
      text = "Done. The limit is back to what it was.";
      break;
    }
    case "set_freeze": {
      const level = recipe.level as FreezeLevel;
      const current = (await spendState(tenantId, { fresh: true, db })).workspace;
      const rank = (l: FreezeLevel) => (l === "all" ? 2 : l === "assistants" ? 1 : 0);
      if (rank(level) < rank(current)) await assertTenantCanWrite(tenantId);
      const { stopInline } = await import("./tasks/adsguard");
      const res = await setWorkspaceFreeze(tenantId, level, who, reason, { db: opts.db, inline: stopInline, enqueue: opts.enqueue });
      text = res.text;
      break;
    }
    case "pause_campaign": {
      const { pauseCampaign } = await import("@/lib/ads/service");
      await pauseCampaign(actor, String(recipe.campaignId), { spendActor: who, reason });
      text = "Done. The campaign is paused.";
      break;
    }
    case "pause_adset": {
      const { pauseAdSet } = await import("@/lib/ads/actions");
      await pauseAdSet(tenantId, String(recipe.metaAdSetId), who, { reason });
      text = "Done. The ad set is paused.";
      break;
    }
    case "pause_ad": {
      const { pauseAd } = await import("@/lib/ads/actions");
      await pauseAd(tenantId, String(recipe.metaAdId), who, { reason });
      text = "Done. The ad is paused.";
      break;
    }
    case "set_adset_budget": {
      // The recipe restores the budget from before a raise, but the budget may have been cut since (a safety stop, the
      // owner): restoring it then is a raise. Decided against what runs now, never the stored row alone.
      const target = Number(recipe.dailyBudgetMinor);
      const current = await currentAdSetBudget(tenantId, String(recipe.metaAdSetId), db);
      if (current === null || target > current) {
        if (actor.role !== "owner") {
          await appendStandalone({ tenantId, pot: row.pot, action: "ledger.undo", phase: "refused", actor: who, reason: UNDO_OWNER, reasonCodes: ["not_allowed", "raises_budget"], targetType: "ledger", targetId: row.correlationId }, { db: db as unknown as LedgerDb });
          throw new HttpError(403, UNDO_OWNER);
        }
        await assertTenantCanWrite(tenantId);
      }
      const { setAdSetBudget } = await import("@/lib/ads/actions");
      await setAdSetBudget(tenantId, String(recipe.metaAdSetId), target, who, { reason });
      text = "Done. The daily budget is back to what it was.";
      break;
    }
    case "resume_campaign": {
      await assertTenantCanWrite(tenantId);
      const c = (await db.adCampaign.findFirst({ where: { tenantId, metaCampaignId: String(recipe.metaObjectId) }, select: { id: true } })) as { id: string } | null;
      if (!c) throw new HttpError(404, "That campaign was not found.");
      const { activateCampaign, getCampaign } = await import("@/lib/ads/service");
      const full = await getCampaign(tenantId, c.id);
      await activateCampaign(actor, c.id, { confirm: true, confirmedTotalMinor: full.confirmTotalMinor }, "resume", { spendActor: who });
      text = "Done. The campaign is back on, within your limits.";
      break;
    }
    case "resume_ad": {
      await assertTenantCanWrite(tenantId);
      const { resumeAd } = await import("@/lib/ads/actions");
      const metaAdId = String(recipe.metaObjectId ?? recipe.metaAdId);
      await resumeAd(tenantId, metaAdId, { action: "resume_ad", metaAdId, previousStatus: "active" }, who, { reason });
      text = "Done. The ad is back on, within your limits.";
      break;
    }
    case "set_control": {
      const fields = (recipe.fields ?? {}) as Record<string, unknown>;
      const control = await getControl(tenantId, { db, prune: false });
      const body: Record<string, unknown> = { ...fields, version: control.version };
      if (fields.targetCostPerLeadMinor !== undefined && fields.targetCostPerLeadMinor !== null) body.targetCostPerLeadMinor = String(fields.targetCostPerLeadMinor);
      const { patch } = parseControlPatch(body);
      await updateControlSettings(actor, patch, control.version, { ...opts, reason });
      text = "Done. The settings are back to what they were.";
      break;
    }
    default:
      throw new HttpError(409, UNDO_NONE);
  }
  const mark = await appendStandalone(
    { tenantId, pot: row.pot, action: "ledger.undo", phase: "info", actor: who, reason, reasonCodes: [kind.isRaise ? "undo_raise" : "undo_lowering"], targetType: "ledger", targetId: row.correlationId, idempotencyKey: `undo:${row.correlationId}` },
    { db: db as unknown as LedgerDb },
  );
  return { text, isRaise: kind.isRaise, correlationId: mark?.record.correlationId ?? null };
}

// =====================================================================================================================
// Self-check used by the copy tests: every static sentence above is free of banned words.
// =====================================================================================================================

export function staticCopy(): string[] {
  const all = [
    ...Object.values(POT_TITLES),
    ...Object.values(ROLE_NOTES).filter((v): v is string => !!v),
    EMAIL_FALLBACK_TEXT,
    ASSISTANTS_SUGGEST_ONLY,
    ...LEVEL_TEXTS.flatMap((o) => [o.label, o.description]),
    ...Object.values(BREAKER_LABELS),
    ...Object.values(META_LIMIT_TEXT),
    PLATFORM_FREEZE_TEXT,
    PLATFORM_ASSISTANTS_TEXT,
    ADS_HELP_SET_ASIDE,
    ADS_HELP_CREDITS,
    MESSAGING_HELP,
    AI_HELP,
    SAMPLE_DATA_NOTE,
    NO_AD_ACCOUNT_NOTE,
    CHOOSE_ACCOUNT_NOTE,
    ASK_OWNER_ACCOUNT_NOTE,
    ADS_NOT_SET_NOTE,
    MESSAGING_NOT_SET_NOTE,
    NO_WHATSAPP_NOTE,
    MANAGED_EXTERNAL_NOTE,
    OWNER_ONLY_SETTINGS,
    ACTIVITY_DENIED,
    UNDO_TOO_OLD,
    UNDO_DONE,
    UNDO_NONE,
    UNDO_OWNER,
    spendCopy("spend.only_owner_raise"),
  ];
  return all;
}

/** The sentences of a view that contain a banned word (empty when the copy is clean). */
export function bannedCopyIn(texts: string[]): string[] {
  return texts.filter((s) => containsBannedWord(s) !== null);
}

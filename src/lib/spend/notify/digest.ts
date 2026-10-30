/**
 * The daily spending summary (docs/SPEND-CONTROLS-SPEC.md 9.3; the spend.digest task runs it every 15 minutes).
 *
 * - Selection: workspaces with SpendControl.digestEnabled whose local time (SpendControl.timezone) is 09:00 or later, once
 *   per local date through claimOnce('spend-digest:<tenantId>:<localDate>'), in cursor batches of 50 like runUsageAlerts.
 *   The demo workspace never gets one, and quiet workspaces (no spend, no leads, no actions and nothing waiting in the last
 *   7 days) are skipped, which protects the notifier's TIER_250 budget.
 * - Content, for yesterday: ads spent (the counted scope: the whole account when Meta's limit is managed, else Edwyz's own
 *   ads) in the AD ACCOUNT's time zone, and month to date against the limit; new leads and cost per lead; WhatsApp spent
 *   (estimate) and AI credits in the WORKSPACE's time zone; assistant actions (and how many lowered); the learning-period
 *   "would have done" count; safety stops tripped and open; requests waiting; and what is left this month per pot.
 * - Delivery: through the notifier (WhatsApp spend_daily_v1 to verified owner and approver channels; email is off; in-app
 *   always, stored as the "Yesterday" strip). The in-app text leaves empty lines out; the template keeps its fixed slots, so
 *   a workspace with no ad account reads "no ads connected" in them.
 */
import { prisma } from "@/lib/db";
import { claimOnce, readState, releaseClaim, writeState } from "@/lib/lifecycle/state";
import { describeError } from "@/lib/safe-error";
import { headroom } from "../book";
import { isMetaLimitManaged, loadAdAccounts, toMetaLimitRow, type AdAccountInfo } from "../commitments";
import { getControl, type SpendDb } from "../control";
import { isDemoWorkspace } from "../demo";
import { formatMinor } from "../money";
import { addDays, dayKey, dayKeyToDate, localParts, resolveTimeZone, startOfLocalDay } from "../periods";
import type { Headroom, NotifyResult, SpendNotice } from "../types";
import { notifySpend } from "./index";
import { NO_ADS_CONNECTED } from "./templates";

type Db = SpendDb;
type Env = Record<string, string | undefined>;
const dbOf = (db?: Db): Db => db ?? (prisma as unknown as Db);

export const DIGEST_HOUR = 9;
export const DIGEST_BATCH = 50;
/** Batches per 15-minute pass, so a large platform is not left for later passes all day. */
export const DIGEST_BATCHES_PER_PASS = 4;
export const DIGEST_CURSOR_KEY = "spend:digest:cursor";
export const QUIET_DAYS = 7;
const CLAIM_PREFIX = "spend-digest:";
const CLAIM_KEEP_MS = 3 * 24 * 3_600_000;
const LOWERING_ACTION = /(\.pause|budget_cut|\.archive|cut_budget|end_earlier|release|cancel)/;

export const claimKey = (tenantId: string, localDate: string) => `${CLAIM_PREFIX}${tenantId}:${localDate}`;
export const digestDedupeKey = (tenantId: string, day: string) => `spend-digest:${tenantId}:${day}`;

export type DigestFigures = {
  tenantId: string;
  workspaceName: string;
  /** Yesterday in the workspace's time zone (YYYY-MM-DD) and as "28 Oct". */
  day: string;
  dayLabel: string;
  timezone: string;
  /** Null when no ad account is connected: the summary has no ads lines (partial workspace). */
  ads: { currency: string; timezone: string; day: string; spentYesterday: bigint; monthSpent: bigint; monthLimit: bigint | null; monthLeft: bigint | null } | null;
  leads: number;
  messaging: { currency: string; spentYesterday: bigint; monthLeft: bigint | null; connected: boolean };
  ai: { usedYesterday: bigint; monthLeft: bigint | null };
  assistantActions: { applied: number; lowering: number };
  shadow: number;
  breakers: { tripped: number; open: number };
  approvalsWaiting: number;
};

// =====================================================================================================================
// Pure formatting
// =====================================================================================================================

/** "28 Oct" for a day key. */
export function dayLabelOf(day: string): string {
  const d = dayKeyToDate(day);
  return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" }).format(d);
}

/** Cost per lead, or null with no leads. */
export function costPerLead(f: Pick<DigestFigures, "ads" | "leads">): bigint | null {
  if (!f.ads || f.leads <= 0) return null;
  return f.ads.spentYesterday / BigInt(f.leads);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const money = (minor: bigint, currency: string) => formatMinor(minor, currency);
const credits = (n: bigint) => `${n.toString()} ${n === 1n ? "credit" : "credits"}`;

function changesText(a: DigestFigures["assistantActions"]): string {
  if (a.applied === 0) return "none";
  return a.lowering > 0 ? `${a.applied} (${a.lowering} lowering)` : String(a.applied);
}

/**
 * The in-app "Yesterday" strip (and the email body, when email exists): one short sentence per figure, with every empty
 * line left out rather than shown as zero. Pure.
 */
export function digestLines(f: DigestFigures): string[] {
  const out: string[] = [];
  if (f.ads) {
    const month = f.ads.monthLimit !== null ? `${money(f.ads.monthSpent, f.ads.currency)} of ${money(f.ads.monthLimit, f.ads.currency)} this month` : `${money(f.ads.monthSpent, f.ads.currency)} this month`;
    out.push(`Ads spent ${money(f.ads.spentYesterday, f.ads.currency)} (${month}).`);
    const cpl = costPerLead(f);
    out.push(f.leads > 0 && cpl !== null ? `${plural(f.leads, "new lead", "new leads")}, ${money(cpl, f.ads.currency)} per lead.` : "No leads yet.");
  } else if (f.leads > 0) {
    out.push(`${plural(f.leads, "new lead", "new leads")}.`);
  }
  if (f.messaging.spentYesterday > 0n) out.push(`WhatsApp messages about ${money(f.messaging.spentYesterday, f.messaging.currency)}.`);
  if (f.ai.usedYesterday > 0n) out.push(`AI: ${credits(f.ai.usedYesterday)} used.`);
  if (f.assistantActions.applied > 0) out.push(`Automatic changes: ${changesText(f.assistantActions)}.`);
  if (f.shadow > 0) out.push(`While learning, assistants would have made ${plural(f.shadow, "change", "changes")}.`);
  if (f.breakers.tripped > 0 || f.breakers.open > 0) out.push(`Safety stops: ${f.breakers.tripped} tripped, ${f.breakers.open} still on.`);
  if (f.approvalsWaiting > 0) out.push(`Requests waiting for you: ${f.approvalsWaiting}.`);
  const left: string[] = [];
  if (f.ads && f.ads.monthLeft !== null) left.push(`ads ${money(f.ads.monthLeft, f.ads.currency)}`);
  if (f.messaging.monthLeft !== null && f.messaging.connected) left.push(`WhatsApp ${money(f.messaging.monthLeft, f.messaging.currency)}`);
  if (f.ai.monthLeft !== null) left.push(`AI ${credits(f.ai.monthLeft)}`);
  if (left.length) out.push(`Left this month: ${left.join(", ")}.`);
  if (f.ads && f.ads.timezone !== f.timezone) out.push(`Ads figures follow the ad account's time zone (${f.ads.timezone}); the rest follow ${f.timezone}.`);
  return out;
}

/** The nine fixed values of spend_daily_v1, in order. "no ads connected" fills the ads slots of a partial workspace. Pure. */
export function digestSlots(f: DigestFigures): string[] {
  const cpl = costPerLead(f);
  return [
    f.workspaceName,
    f.dayLabel,
    f.ads ? money(f.ads.spentYesterday, f.ads.currency) : NO_ADS_CONNECTED,
    f.ads ? String(f.leads) : NO_ADS_CONNECTED,
    f.ads ? (cpl !== null ? money(cpl, f.ads.currency) : "no leads yet") : NO_ADS_CONNECTED,
    f.messaging.connected ? money(f.messaging.spentYesterday, f.messaging.currency) : "none (no WhatsApp number)",
    changesText(f.assistantActions),
    String(f.approvalsWaiting),
    f.ads ? (f.ads.monthLeft !== null ? money(f.ads.monthLeft, f.ads.currency) : "Not set") : NO_ADS_CONNECTED,
  ];
}

/** The notice the notifier delivers (WhatsApp slots in params s1..s9, the strip text as the body). Pure. */
export function digestNotice(f: DigestFigures): SpendNotice {
  const slots = digestSlots(f);
  return {
    tenantId: f.tenantId,
    kind: "digest",
    severity: "fyi",
    audience: "admins",
    dedupeKey: digestDedupeKey(f.tenantId, f.day),
    title: `Daily summary for ${f.dayLabel}`,
    body: digestLines(f).join(" ") || "Nothing was spent yesterday.",
    link: "/app/settings/spending",
    params: Object.fromEntries(slots.map((s, i) => [`s${i + 1}`, s])),
  };
}

// =====================================================================================================================
// Reading the figures
// =====================================================================================================================

export type DigestSources = {
  figures(tenantId: string, now: Date): Promise<DigestFigures>;
  /** No spend, no leads, no actions and nothing waiting in the last 7 days. */
  quiet(tenantId: string, now: Date): Promise<boolean>;
  isDemo(tenantId: string): Promise<boolean>;
};

const big = (v: unknown): bigint => (typeof v === "bigint" ? v : typeof v === "number" ? BigInt(Math.trunc(v)) : typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : 0n);

/** The workspace's local window [start, end) for a day key. */
const windowOf = (day: string, timeZone: string) => ({ gte: startOfLocalDay(day, timeZone), lt: startOfLocalDay(addDays(day, 1), timeZone) });

function spendingAccount(accounts: AdAccountInfo[], chosen: string | null): AdAccountInfo | null {
  const live = accounts.filter((a) => !a.demo);
  if (chosen) return live.find((a) => a.assetId === chosen) ?? null;
  return live.length === 1 ? live[0] : null;
}

/** Ads spent on one account day: the whole account when Meta's limit is managed there, else Edwyz's own ads. */
async function adsSpentOn(db: Db, tenantId: string, account: AdAccountInfo, day: string, env: Env): Promise<{ spent: bigint; results: number }> {
  const date = dayKeyToDate(day);
  const rows = ((await db.spendDaily.findMany({ where: { tenantId, pot: "ads", day: date }, select: { scopeType: true, scopeId: true, origin: true, amountMinor: true, results: true } })) ?? []) as {
    scopeType: string;
    scopeId: string;
    origin: string;
    amountMinor: bigint | number;
    results: number | null;
  }[];
  const platform = rows.filter((r) => r.origin === "platform" && (r.scopeType === "adset" || r.scopeType === "campaign"));
  const results = platform.reduce((n, r) => n + (r.results ?? 0), 0);
  const limitRow = (await db.metaSpendLimit.findUnique({ where: { adAccountAssetId: account.assetId } })) as Record<string, unknown> | null;
  const managed = limitRow ? isMetaLimitManaged(toMetaLimitRow(limitRow), env) : false;
  const all = rows.find((r) => r.scopeType === "account" && r.scopeId === account.assetId && r.origin === "all");
  if (managed && all) return { spent: big(all.amountMinor), results };
  return { spent: platform.reduce((s, r) => s + big(r.amountMinor), 0n), results };
}

async function counterOn(db: Db, tenantId: string, pot: "messaging" | "ai", day: string): Promise<{ spent: bigint; currency: string | null }> {
  const row = (await db.spendCounter.findFirst({ where: { tenantId, pot, periodKind: "day", periodKey: day } })) as { spentMinor?: unknown; reservedMinor?: unknown; currency?: string } | null;
  return { spent: big(row?.spentMinor) + big(row?.reservedMinor), currency: row?.currency ?? null };
}

/** The production sources: the book's headroom for the month, the stored daily figures for yesterday. */
export function defaultDigestSources(opts: { db?: Db; env?: Env } = {}): DigestSources {
  const db = dbOf(opts.db);
  const env = opts.env ?? process.env;
  return {
    isDemo: (tenantId) => isDemoWorkspace(tenantId, db),
    async quiet(tenantId, now) {
      const control = await getControl(tenantId, { db, prune: false });
      const tz = resolveTimeZone(control.timezone);
      const since = new Date(now.getTime() - QUIET_DAYS * 24 * 3_600_000);
      const fromDay = addDays(dayKey(now, tz), -QUIET_DAYS);
      const [ads, counters, leads, actions, shadow, approvals, breakers] = await Promise.all([
        db.spendDaily.count({ where: { tenantId, pot: "ads", day: { gte: dayKeyToDate(fromDay) }, amountMinor: { gt: 0n } } }),
        db.spendCounter.count({ where: { tenantId, periodKind: "day", periodKey: { gte: fromDay }, spentMinor: { gt: 0n } } }),
        db.lead.count({ where: { tenantId, createdAt: { gte: since } } }),
        db.spendLedger.count({ where: { tenantId, actorType: "assistant", phase: "applied", createdAt: { gte: since } } }),
        db.assistantShadowRecord.count({ where: { tenantId, createdAt: { gte: since } } }),
        db.spendApproval.count({ where: { tenantId, status: "pending", expiresAt: { gt: now } } }),
        db.spendBreaker.count({ where: { tenantId, OR: [{ state: "tripped" }, { trippedAt: { gte: since } }] } }),
      ]);
      return ads + counters + leads + actions + shadow + approvals + breakers === 0;
    },
    async figures(tenantId, now) {
      const control = await getControl(tenantId, { db, prune: false });
      const timezone = resolveTimeZone(control.timezone);
      const day = addDays(dayKey(now, timezone), -1);
      const window = windowOf(day, timezone);
      const tenant = (await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })) as { name?: string } | null;
      const account = spendingAccount(await loadAdAccounts(tenantId, control, db), control.spendingAdAccountAssetId);
      const [hm, ha] = await Promise.all([headroom(tenantId, "messaging", { db, now, env }), headroom(tenantId, "ai", { db, now, env })]);
      let ads: DigestFigures["ads"] = null;
      let results = 0;
      if (account) {
        const adsTz = resolveTimeZone(account.timezone);
        const adsDay = addDays(dayKey(now, adsTz), -1);
        const spent = await adsSpentOn(db, tenantId, account, adsDay, env);
        results = spent.results;
        const h: Headroom = await headroom(tenantId, "ads", { db, now, env });
        ads = { currency: account.currency ?? h.currency, timezone: adsTz, day: adsDay, spentYesterday: spent.spent, monthSpent: h.month.spent, monthLimit: h.limits.monthly, monthLeft: h.month.left };
      }
      const [messaging, ai, leadRows, applied, shadow, tripped, open, approvalsWaiting, phones] = await Promise.all([
        counterOn(db, tenantId, "messaging", day),
        counterOn(db, tenantId, "ai", day),
        db.lead.count({ where: { tenantId, createdAt: window } }),
        db.spendLedger.findMany({ where: { tenantId, actorType: "assistant", phase: "applied", createdAt: window }, select: { action: true }, take: 1_000 }) as Promise<{ action: string }[]>,
        db.assistantShadowRecord.count({ where: { tenantId, createdAt: window } }),
        db.spendBreaker.count({ where: { tenantId, trippedAt: window } }),
        db.spendBreaker.count({ where: { tenantId, state: "tripped" } }),
        db.spendApproval.count({ where: { tenantId, status: "pending", expiresAt: { gt: now } } }),
        db.phoneNumber.count({ where: { tenantId } }),
      ]);
      return {
        tenantId,
        workspaceName: tenant?.name ?? "your workspace",
        day,
        dayLabel: dayLabelOf(day),
        timezone,
        ads,
        // Lead-form leads are Lead rows AND campaign results, so the larger of the two is shown, never their sum.
        leads: Math.max(leadRows, results),
        messaging: { currency: messaging.currency ?? hm.currency, spentYesterday: messaging.spent, monthLeft: hm.month.left, connected: phones > 0 },
        ai: { usedYesterday: ai.spent, monthLeft: ha.month.left },
        assistantActions: { applied: applied.length, lowering: applied.filter((r) => LOWERING_ACTION.test(r.action)).length },
        shadow,
        breakers: { tripped, open },
        approvalsWaiting,
      };
    },
  };
}

// =====================================================================================================================
// The pass
// =====================================================================================================================

export type DigestPassResult = { considered: number; sent: number; skipped: Record<"disabled" | "early" | "demo" | "claimed" | "quiet" | "failed", number> };

export type DigestPassOptions = {
  db?: Db;
  now?: Date;
  env?: Env;
  sources?: DigestSources;
  notify?: (notice: SpendNotice) => Promise<NotifyResult>;
  batches?: number;
};

/** Is it 09:00 or later in the zone? */
export function digestDue(now: Date, timeZone: string): boolean {
  return localParts(now, resolveTimeZone(timeZone)).hour >= DIGEST_HOUR;
}

/** One digest for one workspace whose claim this pass holds. Releases the claim when it fails, so the next pass retries. */
async function digestOne(tenantId: string, localDate: string, now: Date, sources: DigestSources, notify: (n: SpendNotice) => Promise<NotifyResult>): Promise<"sent" | "quiet" | "failed"> {
  try {
    if (await sources.quiet(tenantId, now)) return "quiet";
    const figures = await sources.figures(tenantId, now);
    const result = await notify(digestNotice(figures));
    if (result.delivered.length === 0 && !result.deduplicated) {
      await releaseClaim(claimKey(tenantId, localDate));
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error(`[spend] daily summary failed for one workspace: ${describeError(error)}`);
    await releaseClaim(claimKey(tenantId, localDate));
    return "failed";
  }
}

/** spend.digest (every 15 minutes). Never throws. */
export async function runDigestPass(opts: DigestPassOptions = {}): Promise<DigestPassResult> {
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  const sources = opts.sources ?? defaultDigestSources({ db, env: opts.env });
  const notify = opts.notify ?? notifySpend;
  const out: DigestPassResult = { considered: 0, sent: 0, skipped: { disabled: 0, early: 0, demo: 0, claimed: 0, quiet: 0, failed: 0 } };
  try {
    await db.platformSetting.deleteMany({ where: { key: { startsWith: CLAIM_PREFIX }, updatedAt: { lt: new Date(now.getTime() - CLAIM_KEEP_MS) } } });
  } catch {
    // Old claims are only clutter; the next pass tries again.
  }
  const batches = Math.max(1, opts.batches ?? DIGEST_BATCHES_PER_PASS);
  let wrapped = false;
  for (let b = 0; b < batches; b++) {
    let cursor: string | undefined;
    try {
      cursor = (await readState<{ after?: string }>(DIGEST_CURSOR_KEY))?.after;
    } catch {
      cursor = undefined;
    }
    const rows = ((await db.spendControl.findMany({
      where: { digestEnabled: true, ...(cursor ? { tenantId: { gt: cursor } } : {}) },
      orderBy: { tenantId: "asc" },
      take: DIGEST_BATCH,
      select: { tenantId: true, timezone: true },
    })) ?? []) as { tenantId: string; timezone: string }[];
    await writeState(DIGEST_CURSOR_KEY, rows.length < DIGEST_BATCH ? {} : { after: rows[rows.length - 1].tenantId }).catch(() => undefined);
    if (rows.length === 0) {
      if (!cursor || wrapped) break;
      wrapped = true;
      continue;
    }
    const tenants = ((await db.tenant.findMany({ where: { id: { in: rows.map((r) => r.tenantId) }, status: "active", deletedAt: null }, select: { id: true } })) ?? []) as { id: string }[];
    const active = new Set(tenants.map((t) => t.id));
    for (const row of rows) {
      out.considered++;
      if (!active.has(row.tenantId)) {
        out.skipped.disabled++;
        continue;
      }
      const tz = resolveTimeZone(row.timezone);
      if (!digestDue(now, tz)) {
        out.skipped.early++;
        continue;
      }
      if (await sources.isDemo(row.tenantId).catch(() => false)) {
        out.skipped.demo++;
        continue;
      }
      const localDate = dayKey(now, tz);
      if (!(await claimOnce(claimKey(row.tenantId, localDate)))) {
        out.skipped.claimed++;
        continue;
      }
      const result = await digestOne(row.tenantId, localDate, now, sources, notify);
      if (result === "sent") out.sent++;
      else out.skipped[result]++;
    }
    if (rows.length < DIGEST_BATCH) break;
  }
  return out;
}

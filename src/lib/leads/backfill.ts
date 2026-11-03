/**
 * Lead backfill (docs/IG-PAGE-ADS-SPEC.md 3.11, 4.1, 4.2 L5, 4.9, 11.2 risk 16, PRM-10). promote.leads.backfill runs it every 30
 * minutes (src/lib/promote/tasks/backfill.ts), so a lead whose webhook Meta never delivered still reaches the Leads hub.
 *
 * - Which forms: every form an ad of Edwyz's uses (Ad.creative.leadFormId, the form's own id or its Meta id) while the ad's
 *   campaign runs, or ran in the last 7 days. A campaign runs while it is active, launched and not past its end. Once it stops
 *   (paused or archived here, stopped by a limit, paused in Ads Manager) the time it was last seen running counts: each run stamps
 *   the lead-form campaigns it sees running, at most once an hour, in the workspace's backfill state. So a campaign paused months
 *   ago is never read again, whatever later writes to its row (review checks, spend sync). An active campaign whose end date passed
 *   counts for 7 days after that date. Both rules are in the ad query, which pages through the matching ads newest first. Ads that never reached
 *   Meta (dry-run and simulated ids) and forms without a real Meta id are skipped. A form an ad names by its Meta id but that has no
 *   LeadForm row yet (the old wizard registers none; the first webhook lead makes it) is registered under the ad's Page, so a form
 *   whose webhook never arrives is still read.
 * - Order: forms that were read fine last time and the others (never read, or failing) take turns, each oldest try first, so
 *   neither kind holds the other back. Every try is recorded, failed ones too. A form that failed twice or more in a row waits 1
 *   hour, then 2, 4 and at most 6 hours before its next try.
 * - What: L5, the form's leads created in the last 26 hours, with the Page token. `platform` and `is_organic` are asked for through
 *   the capability probe of 4.1 (leads/ingest.ts withLeadPlatform: #100 falls back and is remembered for 7 days).
 * - At most 500 leads are read per run, 100 per request, and a run takes no new form or page after 10 seconds, so it never holds
 *   the worker's pass. Leads the workspace already has are skipped with one lookup per page; the others go through the same
 *   storeLead as the webhook, whose unique key (tenantId, leadgenId) keeps one Lead and one sequence run when both race.
 * - Pacing (4.9): priority 1, the Page's throttle scope. A cooldown skips the form without a call; usage headers and rate-limit
 *   errors are noted like every promote call.
 * - A form read in full (or up to the cap) gets LeadForm.lastBackfillAt. A permission error (Lead Access Manager does not allow
 *   Edwyz) is recorded for the readiness row (leadAccessState, read by promote/prereqs.ts), and the next successful read clears it.
 *
 * Lead reads live in leads/ (4.1): this file and ingest.ts. Every request is a GET, so the spend tripwire classes it not_spend.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { GraphError, graphFetchAs } from "@/lib/graph";
import type { AssetAccess } from "@/lib/meta-connect";
import { isThrottleError, pageScope, parseUsageHeaders, PRIORITY, PromoteThrottledError, throttle as defaultThrottle, type Throttle, type ThrottleUsage } from "@/lib/promote/throttle";
import { describeError } from "@/lib/safe-error";
import type { GraphLead, LeadPage } from "./ingest";

// Lead storage (./ingest), Page access, the workspace state and the field lists are loaded on the first form to read, so a run
// with no live form (the common case, and the worker's tests) loads none of them.
const ingestModule = () => import("./ingest");

/** How far back each read goes: 26 hours, so a run that is a few hours late still overlaps the last one. */
export const BACKFILL_WINDOW_MS = 26 * 3_600_000;
/** Leads read from Meta per run at most, all forms together. */
export const MAX_BACKFILL_LEADS = 500;
/** A form is read while one of its ads runs, and for this long after the ad last ran. */
export const ACTIVE_AD_WINDOW_MS = 7 * 86_400_000;
/** Leads asked for per request (Meta's page size). */
export const LEADS_PAGE_LIMIT = 100;
/** A run takes no new form or page after this long (the worker's pass allows 15 s for all its tasks). */
export const BACKFILL_BUDGET_MS = 10_000;
/** Forms read per run at most. */
export const MAX_BACKFILL_FORMS = 100;
/** Ads read per query when looking for the forms (newest first). */
export const ADS_PAGE = 1_000;
/** Ads looked at per run at most, to find the forms. */
export const MAX_ADS_SCANNED = 10_000;
/** LeadForm rows looked up per run at most. */
const MAX_FORM_ROWS = 2_000;
/** Forms an ad names by Meta id that are registered per run at most. */
const MAX_REGISTERED = 50;
/** A campaign seen running is stamped again once its stamp is this old, so its 7 days after stopping are counted to the hour. */
export const RAN_STAMP_EVERY_MS = 3_600_000;
/** After its second failure in a row a form waits this long before the next try, doubling with each failure, up to the max. */
export const RETRY_WAIT_MS = 3_600_000;
export const MAX_RETRY_WAIT_MS = 6 * 3_600_000;
/** A refused lead read keeps the readiness row "missing" this long; then it is unknown (never blocks) until the next read says. */
export const LEAD_ACCESS_MISSING_MS = 24 * 3_600_000;

const LEAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR = /^[A-Za-z0-9_=-]{1,512}$/;
/** A real Meta id. Dry-run and simulated launches store ids such as "dryrun_ad_…" or "dryrun_leadform_…", which Meta never saw. */
const META_ID = /^\d{1,30}$/;
const FAKE_ID_PREFIX = "dryrun";

export type LeadBackfillResult = { forms: number; leads: number; failed: number };

export type BackfillDeps = {
  now: () => number;
  /** The Page's decrypted access (getAssetAccess). */
  access: (tenantId: string, assetId: string) => Promise<AssetAccess>;
  throttle: Throttle;
  /** Whether the workspace may run background work now (a suspended, deleted or locked one is skipped). */
  mayRun: (tenantId: string) => Promise<boolean>;
  budgetMs: number;
  maxLeads: number;
};

const defaultDeps = (): BackfillDeps => ({
  now: Date.now,
  access: async (tenantId, assetId) => (await import("@/lib/meta-connect")).getAssetAccess(tenantId, assetId),
  throttle: defaultThrottle,
  mayRun: async (tenantId) => (await import("@/lib/tenant-state")).tenantMayRunBackground(tenantId),
  budgetMs: BACKFILL_BUDGET_MS,
  maxLeads: MAX_BACKFILL_LEADS,
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const iso = (ms: number) => new Date(ms).toISOString();

// =====================================================================================================================
// Which campaigns ran
// =====================================================================================================================

type CampaignState = { status: string; launchedAt: Date | null; endsAt: Date | null };

/** True while the campaign's ads can deliver: launched, active, and not past its end date. */
export function campaignRunning(c: CampaignState | null | undefined, now: number): boolean {
  if (!c?.launchedAt || c.status !== "active") return false;
  return !c.endsAt || c.endsAt.getTime() > now;
}

/**
 * True when the campaign's ads ran at some point in the 7 days before `now`: it is active and did not end more than 7 days ago, or
 * it was last seen running (`lastSeenRunning`, the backfill's own stamp) less than 7 days ago. Its row's updatedAt is never used:
 * review checks and spend syncs write to a paused campaign too.
 */
export function campaignRanWithin(c: CampaignState | null | undefined, lastSeenRunning: number | null, now: number): boolean {
  if (!c?.launchedAt) return false;
  const since = now - ACTIVE_AD_WINDOW_MS;
  if (c.status === "active" && (!c.endsAt || c.endsAt.getTime() >= since)) return true;
  return lastSeenRunning !== null && lastSeenRunning >= since;
}

/** The form an ad sends people to: Ad.creative.leadFormId, the LeadForm id or the Meta form id. */
export function formRefOf(creative: unknown): string | null {
  const ref = isObject(creative) ? creative.leadFormId : null;
  return typeof ref === "string" && LEAD_ID.test(ref.trim()) ? ref.trim() : null;
}

/** The Page's Meta id an ad of the old wizard runs from (Ad.creative.pageId), when it is one. */
function pageIdOf(creative: unknown): string | null {
  const id = isObject(creative) ? creative.pageId : null;
  const s = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
  return META_ID.test(s) ? s : null;
}

/** How long a form waits after `failures` failed tries in a row: nothing after one, then 1, 2, 4 and at most 6 hours. */
export function retryWaitMs(failures: number): number {
  return failures < 2 ? 0 : Math.min(MAX_RETRY_WAIT_MS, RETRY_WAIT_MS * 2 ** (failures - 2));
}

// =====================================================================================================================
// The backfill's state per workspace: when each campaign was last seen running, and each form's last try
// =====================================================================================================================

const STATE_PREFIX = "leads:backfill:";

/** PlatformSetting key of a workspace's backfill state: {v, ran: {campaignId: ISO}, tried: {formId: {at: ISO, failures}}}. */
export const backfillStateKey = (tenantId: string) => `${STATE_PREFIX}${tenantId}`;

type FormTry = { at: number; failures: number };
type TenantState = { ran: Map<string, number>; tried: Map<string, FormTry>; changed: boolean; stored: boolean };
/** `loaded` false: the stored state could not be read, so none is written this run (it would drop what is stored). */
type StateBook = { tenants: Map<string, TenantState>; loaded: boolean };

const blankState = (): TenantState => ({ ran: new Map(), tried: new Map(), changed: false, stored: false });

const msOf = (v: unknown): number | null => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

function parseState(value: unknown): TenantState {
  const s: TenantState = { ...blankState(), stored: true };
  if (!isObject(value)) return s;
  for (const [id, at] of Object.entries(isObject(value.ran) ? value.ran : {})) {
    const ms = msOf(at);
    if (ms !== null) s.ran.set(id, ms);
  }
  for (const [id, t] of Object.entries(isObject(value.tried) ? value.tried : {})) {
    const at = isObject(t) ? msOf(t.at) : null;
    if (at === null || !isObject(t)) continue;
    const failures = typeof t.failures === "number" && Number.isFinite(t.failures) ? Math.min(100, Math.max(0, Math.floor(t.failures))) : 0;
    s.tried.set(id, { at, failures });
  }
  return s;
}

async function readStates(): Promise<StateBook> {
  try {
    const rows = (await prisma.platformSetting.findMany({ where: { key: { startsWith: STATE_PREFIX } }, select: { key: true, value: true } })) ?? [];
    const tenants = new Map<string, TenantState>();
    for (const r of rows) tenants.set(r.key.slice(STATE_PREFIX.length), parseState(r.value));
    return { tenants, loaded: true };
  } catch (e) {
    console.error("[leads] backfill could not read its state; this run keeps none:", describeError(e));
    return { tenants: new Map(), loaded: false };
  }
}

function stateOf(book: StateBook, tenantId: string): TenantState {
  let s = book.tenants.get(tenantId);
  if (!s) {
    s = blankState();
    book.tenants.set(tenantId, s);
  }
  return s;
}

/** Records a try of a form: a good read clears its failures, a failure adds one, a skip (cooldown) keeps them. */
function noteTry(book: StateBook, form: BackfillForm, status: FormOutcome["status"], now: number): void {
  const s = stateOf(book, form.tenantId);
  const before = s.tried.get(form.id)?.failures ?? 0;
  s.tried.set(form.id, { at: now, failures: status === "read" ? 0 : status === "failed" ? Math.min(100, before + 1) : before });
  s.changed = true;
}

/**
 * Writes each workspace's state that changed, one row per workspace. Stamps older than 7 days and tries of forms that are no longer
 * read are dropped; an empty state deletes the row. A failed write is logged and the next run writes again.
 */
async function saveStates(book: StateBook, live: Map<string, Set<string>>, now: number): Promise<void> {
  if (!book.loaded) return;
  const since = now - ACTIVE_AD_WINDOW_MS;
  for (const [tenantId, s] of book.tenants) {
    for (const [id, at] of [...s.ran]) {
      if (at < since) {
        s.ran.delete(id);
        s.changed = true;
      }
    }
    const forms = live.get(tenantId);
    for (const id of [...s.tried.keys()]) {
      if (!forms?.has(id)) {
        s.tried.delete(id);
        s.changed = true;
      }
    }
    if (!s.changed) continue;
    const key = backfillStateKey(tenantId);
    try {
      if (s.ran.size === 0 && s.tried.size === 0) {
        if (s.stored) await prisma.platformSetting.deleteMany({ where: { key } });
        continue;
      }
      const value = {
        v: 1,
        ran: Object.fromEntries([...s.ran].map(([id, at]) => [id, iso(at)])),
        tried: Object.fromEntries([...s.tried].map(([id, t]) => [id, { at: iso(t.at), failures: t.failures }])),
      } as Prisma.InputJsonObject;
      await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    } catch (e) {
      console.error("[leads] backfill could not save a workspace's state:", describeError(e));
    }
  }
}

// =====================================================================================================================
// Which forms
// =====================================================================================================================

export type BackfillForm = { id: string; tenantId: string; pageAssetId: string; metaFormId: string; lastBackfillAt: Date | null };

/** tenantId -> form ref (LeadForm id or Meta form id) -> the Page's Meta id from the ad, when it names one. */
type Refs = Map<string, Map<string, string | null>>;
type ScannedAd = { id: string; tenantId: string; creative: unknown; adSet: { campaign: CampaignState & { id: string } } | null };

/**
 * The forms of the ads whose campaign runs or ran in the last 7 days, read newest ad first, page by page. Stamps every running
 * campaign in the book (at most once an hour).
 */
async function liveFormRefs(book: StateBook, now: number): Promise<Refs> {
  const since = now - ACTIVE_AD_WINDOW_MS;
  const stamped = new Set<string>();
  for (const s of book.tenants.values()) for (const [id, at] of s.ran) if (at >= since) stamped.add(id);
  const campaign: Prisma.AdCampaignWhereInput = {
    launchedAt: { not: null },
    OR: [{ status: "active", OR: [{ endsAt: null }, { endsAt: { gte: new Date(since) } }] }, ...(stamped.size ? [{ id: { in: [...stamped] } }] : [])],
  };
  const refs: Refs = new Map();
  let scanned = 0;
  let cursor: string | null = null;
  while (scanned < MAX_ADS_SCANNED) {
    const take = Math.min(ADS_PAGE, MAX_ADS_SCANNED - scanned);
    const ads: ScannedAd[] = (await prisma.ad.findMany({
      where: { metaAdId: { not: null }, NOT: { metaAdId: { startsWith: FAKE_ID_PREFIX } }, adSet: { campaign }, ...(cursor ? { id: { lt: cursor } } : {}) },
      select: { id: true, tenantId: true, creative: true, adSet: { select: { campaign: { select: { id: true, status: true, launchedAt: true, endsAt: true } } } } },
      orderBy: { id: "desc" },
      take,
    })) ?? [];
    scanned += ads.length;
    for (const ad of ads) {
      const c = ad.adSet?.campaign;
      const ref = formRefOf(ad.creative);
      // Only campaigns with a lead form are stamped: the others are never read.
      if (!c || !ref) continue;
      const state = stateOf(book, ad.tenantId);
      if (campaignRunning(c, now)) {
        const last = state.ran.get(c.id);
        if (last === undefined || now - last >= RAN_STAMP_EVERY_MS) {
          state.ran.set(c.id, now);
          state.changed = true;
        }
      }
      if (!campaignRanWithin(c, state.ran.get(c.id) ?? null, now)) continue;
      const set = refs.get(ad.tenantId) ?? new Map<string, string | null>();
      if (!set.get(ref)) set.set(ref, pageIdOf(ad.creative));
      refs.set(ad.tenantId, set);
    }
    if (ads.length < take) break;
    cursor = ads[ads.length - 1].id;
  }
  return refs;
}

const FORM_SELECT = { id: true, tenantId: true, pageAssetId: true, metaFormId: true, lastBackfillAt: true } as const;

/**
 * The LeadForm rows of the refs, plus a row for each Meta form id an ad names that has none yet: registered (origin
 * 'registered', as the first webhook lead would) under the workspace's own active Page the ad runs from. A ref with no such Page
 * is left alone. Forms without a real Meta id (dry-run launches) are dropped.
 */
async function formsFor(refs: Refs): Promise<BackfillForm[]> {
  const rows: BackfillForm[] =
    (await prisma.leadForm.findMany({
      where: { OR: [...refs].map(([tenantId, set]) => ({ tenantId, OR: [{ id: { in: [...set.keys()] } }, { metaFormId: { in: [...set.keys()] } }] })) },
      select: FORM_SELECT,
      take: MAX_FORM_ROWS,
    })) ?? [];
  const known = new Set(rows.flatMap((r) => [`${r.tenantId}:${r.id}`, `${r.tenantId}:${r.metaFormId}`]));
  const unregistered: Unregistered[] = [];
  for (const [tenantId, set] of refs) {
    for (const [ref, pageId] of set) if (pageId && META_ID.test(ref) && !known.has(`${tenantId}:${ref}`)) unregistered.push({ tenantId, metaFormId: ref, pageId });
  }
  if (unregistered.length > 0) rows.push(...(await registerForms(unregistered.slice(0, MAX_REGISTERED))));
  return rows.filter((f) => META_ID.test(f.metaFormId));
}

type Unregistered = { tenantId: string; metaFormId: string; pageId: string };

async function registerForms(list: Unregistered[]): Promise<BackfillForm[]> {
  const byTenant = new Map<string, Set<string>>();
  for (const r of list) byTenant.set(r.tenantId, (byTenant.get(r.tenantId) ?? new Set<string>()).add(r.pageId));
  let pages: { id: string; tenantId: string; externalId: string }[];
  try {
    pages =
      (await prisma.metaAsset.findMany({
        where: { type: "page", status: "active", OR: [...byTenant].map(([tenantId, ids]) => ({ tenantId, externalId: { in: [...ids] } })) },
        select: { id: true, tenantId: true, externalId: true },
      })) ?? [];
  } catch (e) {
    console.error("[leads] backfill could not look up the Pages of unregistered forms:", describeError(e));
    return [];
  }
  const out: BackfillForm[] = [];
  for (const r of list) {
    const page = pages.find((p) => p.tenantId === r.tenantId && p.externalId === r.pageId);
    if (!page) continue;
    try {
      out.push(
        await prisma.leadForm.upsert({
          where: { tenantId_metaFormId: { tenantId: r.tenantId, metaFormId: r.metaFormId } },
          create: { tenantId: r.tenantId, pageAssetId: page.id, metaFormId: r.metaFormId },
          update: {},
          select: FORM_SELECT,
        }),
      );
    } catch (e) {
      console.error("[leads] backfill could not register a form:", describeError(e));
    }
  }
  return out;
}

/**
 * The reading order: forms read fine last time ("good") and the others (never read, or failing) take turns, others first, each
 * oldest try first (never tried before tried). A form still waiting after repeated failures (retryWaitMs) is left out.
 */
function readingOrder(forms: BackfillForm[], book: StateBook, now: number): BackfillForm[] {
  const good: { form: BackfillForm; at: number }[] = [];
  const others: { form: BackfillForm; at: number }[] = [];
  for (const form of forms) {
    const t = book.tenants.get(form.tenantId)?.tried.get(form.id);
    if (t && now - t.at < retryWaitMs(t.failures)) continue;
    if (form.lastBackfillAt && (!t || t.failures === 0)) good.push({ form, at: Math.max(t?.at ?? 0, form.lastBackfillAt.getTime()) });
    else others.push({ form, at: t?.at ?? -1 });
  }
  const oldestFirst = (a: { at: number }, b: { at: number }) => a.at - b.at;
  good.sort(oldestFirst);
  others.sort(oldestFirst);
  const out: BackfillForm[] = [];
  for (let i = 0; i < Math.max(good.length, others.length); i++) {
    if (i < others.length) out.push(others[i].form);
    if (i < good.length) out.push(good[i].form);
  }
  return out.slice(0, MAX_BACKFILL_FORMS);
}

type Plan = { forms: BackfillForm[]; book: StateBook; live: Map<string, Set<string>> };

async function planBackfill(now: number): Promise<Plan> {
  const book = await readStates();
  const refs = await liveFormRefs(book, now);
  const live = new Map<string, Set<string>>();
  if (refs.size === 0) return { forms: [], book, live };
  const forms = await formsFor(refs);
  for (const f of forms) live.set(f.tenantId, (live.get(f.tenantId) ?? new Set<string>()).add(f.id));
  return { forms: readingOrder(forms, book, now), book, live };
}

/** The forms to read now, in reading order (see readingOrder). Read-only: the stamps it makes are kept by backfillLeads only. */
export async function formsToBackfill(now: number): Promise<BackfillForm[]> {
  return (await planBackfill(now)).forms;
}

// =====================================================================================================================
// Lead Access Manager (the readiness row "Lead Access Manager allows Edwyz", 3.2)
// =====================================================================================================================

export type LeadAccessState = "ok" | "missing" | "unknown";

/** PlatformSetting key of what the last lead read of a workspace's Page said about Lead Access Manager. */
export const leadAccessKey = (tenantId: string, pageAssetId: string) => `leads:lead-access:${tenantId}:${pageAssetId}`;

/** Meta refused the lead read for lack of permission: Lead Access Manager does not allow Edwyz (or the person who connected). */
export function isLeadAccessError(e: unknown): boolean {
  if (!(e instanceof GraphError)) return false;
  return e.code === 10 || (typeof e.code === "number" && e.code >= 200 && e.code < 300) || e.status === 403;
}

/**
 * For the readiness row: "missing" for 24 hours after a lead read was refused, "ok" after one worked, "unknown" before either and
 * once a refusal is older than 24 hours. A stale refusal must not block Start for good: the owner may have fixed it, and only a
 * later read can tell, so after 24 hours Meta decides at Start again.
 */
export async function leadAccessState(tenantId: string, pageAssetId: string, now: number = Date.now()): Promise<LeadAccessState> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: leadAccessKey(tenantId, pageAssetId) } });
    const value = isObject(row?.value) ? row.value : null;
    if (value?.state === "ok") return "ok";
    if (value?.state !== "missing") return "unknown";
    const at = msOf(value.at);
    return at !== null && now - at < LEAD_ACCESS_MISSING_MS ? "missing" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Writes "ok" only when it changes, so a healthy Page costs one read per run; a repeated refusal refreshes its time once an hour. */
async function recordLeadAccess(tenantId: string, pageAssetId: string, state: "ok" | "missing", now: number): Promise<void> {
  const key = leadAccessKey(tenantId, pageAssetId);
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key } });
    const before = isObject(row?.value) ? row.value : null;
    if (before?.state === state) {
      const at = msOf(before.at);
      if (state === "ok" || (at !== null && now - at < RAN_STAMP_EVERY_MS)) return;
    }
    const value = { state, at: iso(now) } as Prisma.InputJsonObject;
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  } catch {
    // The next run records it.
  }
}

// =====================================================================================================================
// The run
// =====================================================================================================================

type Paged<T> = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };
type Ctx = { deps: BackfillDeps; started: number; now: number };
type FormOutcome = { status: "read" | "skipped" | "failed"; read: number; stored: number };

const overBudget = (ctx: Ctx) => ctx.deps.now() - ctx.started > ctx.deps.budgetMs;

/** Reads the leads of every live form (see the header). Never throws for one form: a failed form is counted and the run goes on. */
export async function backfillLeads(overrides: Partial<BackfillDeps> = {}): Promise<LeadBackfillResult> {
  const deps: BackfillDeps = { ...defaultDeps(), ...overrides };
  const started = deps.now();
  const ctx: Ctx = { deps, started, now: started };
  const result: LeadBackfillResult = { forms: 0, leads: 0, failed: 0 };
  const plan = await planBackfill(started);
  const mayRun = new Map<string, boolean>();
  let read = 0;
  try {
    for (const form of plan.forms) {
      if (read >= deps.maxLeads || overBudget(ctx)) break;
      if (!mayRun.has(form.tenantId)) mayRun.set(form.tenantId, await deps.mayRun(form.tenantId).catch(() => false));
      if (!mayRun.get(form.tenantId)) continue;
      let outcome: FormOutcome;
      try {
        outcome = await backfillForm(form, deps.maxLeads - read, ctx);
      } catch (e) {
        console.error("[leads] backfill could not read a form:", describeError(e));
        outcome = { status: "failed", read: 0, stored: 0 };
      }
      noteTry(plan.book, form, outcome.status, started);
      read += outcome.read;
      result.leads += outcome.stored;
      if (outcome.status === "read") result.forms++;
      else if (outcome.status === "failed") result.failed++;
    }
  } finally {
    await saveStates(plan.book, plan.live, started);
  }
  return result;
}

async function backfillForm(form: BackfillForm, left: number, ctx: Ctx): Promise<FormOutcome> {
  const { deps, now } = ctx;
  let access: AssetAccess;
  try {
    access = await deps.access(form.tenantId, form.pageAssetId);
  } catch (e) {
    console.error("[leads] backfill skipped a form, its Page is not usable:", describeError(e));
    return { status: "failed", read: 0, stored: 0 };
  }
  if (access.type !== "page" || !access.externalId) return { status: "failed", read: 0, stored: 0 };
  const scope = pageScope(access.externalId);
  try {
    await deps.throttle.check(scope, PRIORITY.leads);
  } catch (e) {
    if (e instanceof PromoteThrottledError) return { status: "skipped", read: 0, stored: 0 };
    throw e;
  }
  const page: LeadPage = { assetId: form.pageAssetId, pageMetaId: access.externalId, token: access.token };
  const [{ withLeadPlatform }, { leadFieldList }] = await Promise.all([ingestModule(), import("@/lib/promote/meta")]);
  const filtering = JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor((now - BACKFILL_WINDOW_MS) / 1000) }]);
  let read = 0;
  let stored = 0;
  let lost = 0;
  let after: string | null = null;
  let withPlatform: boolean | null = null;
  try {
    do {
      const limit = Math.min(LEADS_PAGE_LIMIT, left - read);
      if (limit <= 0 || (read > 0 && overBudget(ctx))) break;
      const cursor: string | null = after;
      const readPage = (fields: boolean): Promise<Paged<GraphLead> | null> =>
        leadsPage(deps.throttle, scope, page.token, form.metaFormId, { fields: leadFieldList(fields), filtering, limit: String(limit), ...(cursor ? { after: cursor } : {}) });
      let res: Paged<GraphLead> | null;
      if (withPlatform === null) {
        const probed: { result: Paged<GraphLead> | null; withPlatform: boolean } = await withLeadPlatform(readPage, now);
        res = probed.result;
        withPlatform = probed.withPlatform;
      } else {
        res = await readPage(withPlatform);
      }
      const rows = (Array.isArray(res?.data) ? res.data : []).slice(0, limit);
      read += rows.length;
      const done = await storeRows(form, page, rows, now);
      stored += done.stored;
      lost += done.failed;
      const next: string | undefined = res?.paging?.next ? res.paging.cursors?.after : undefined;
      after = typeof next === "string" && CURSOR.test(next) ? next : null;
    } while (after);
  } catch (e) {
    await noteReadFailure(form, scope, e, ctx);
    return { status: "failed", read, stored };
  }
  try {
    await prisma.leadForm.updateMany({ where: { id: form.id, tenantId: form.tenantId }, data: { lastBackfillAt: new Date(now) } });
  } catch (e) {
    console.error("[leads] backfill could not mark a form as read:", describeError(e));
  }
  await recordLeadAccess(form.tenantId, form.pageAssetId, "ok", now);
  return { status: lost > 0 ? "failed" : "read", read, stored };
}

/** L5, one page. Meta's usage headers are noted for the Page's scope, success or not. */
async function leadsPage(throttle: Throttle, scope: string, token: string, metaFormId: string, query: Record<string, string>): Promise<Paged<GraphLead> | null> {
  const seen: { usage: ThrottleUsage | null } = { usage: null };
  try {
    return await graphFetchAs<Paged<GraphLead>>(token, { path: `${metaFormId}/leads`, query }, { onHeaders: (h) => void (seen.usage = parseUsageHeaders(h)) });
  } finally {
    await throttle.noteUsage(scope, seen.usage);
  }
}

async function noteReadFailure(form: BackfillForm, scope: string, e: unknown, ctx: Ctx): Promise<void> {
  if (e instanceof GraphError && isThrottleError(e.code, e.subcode)) {
    await ctx.deps.throttle.noteError(scope, { code: e.code, subcode: e.subcode });
  } else if (isLeadAccessError(e)) {
    await recordLeadAccess(form.tenantId, form.pageAssetId, "missing", ctx.now);
  }
  console.error("[leads] backfill could not read a form's leads:", describeError(e));
}

/** Stores the leads the workspace does not have yet. A lead that cannot be stored is counted and the others go on. */
async function storeRows(form: BackfillForm, page: LeadPage, rows: GraphLead[], now: number): Promise<{ stored: number; failed: number }> {
  const fresh = rows.filter((r): r is GraphLead & { id: string } => typeof r?.id === "string" && LEAD_ID.test(r.id));
  if (fresh.length === 0) return { stored: 0, failed: 0 };
  const known = await prisma.lead.findMany({ where: { tenantId: form.tenantId, leadgenId: { in: fresh.map((r) => r.id) } }, select: { leadgenId: true } });
  const have = new Set((known ?? []).map((k) => k.leadgenId));
  const { storeLead } = await ingestModule();
  let stored = 0;
  let failed = 0;
  for (const raw of fresh) {
    if (have.has(raw.id)) continue;
    have.add(raw.id);
    try {
      if (await storeLead(form.tenantId, page, raw, { leadgenId: raw.id, formId: form.metaFormId }, new Date(now))) stored++;
    } catch (e) {
      failed++;
      console.error("[leads] backfill could not store a lead:", describeError(e));
    }
  }
  return { stored, failed };
}

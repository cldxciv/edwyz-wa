/**
 * Pacing for Instagram and Facebook Page ads calls to Meta (docs/IG-PAGE-ADS-SPEC.md 4.9, PRM-03).
 *
 * - Cooldowns. When Meta answers with a rate-limit code (17, 32, 80000 to 80014, or 613, including its subcodes 1487632,
 *   5044001 and 4841018), the ad account (or Page) gets a cooldown in PlatformSetting `promote:throttle:<scope>` as
 *   `{until, code}`. Every promote call reads it first and waits it out instead of calling.
 * - Usage. Meta reports how much of the allowance is used in X-Business-Use-Case-Usage, X-Ad-Account-Usage and
 *   X-FB-Ads-Insights-Throttle. Above 75%, only priorities 1 (lead reads and backfill) and 2 (review sync) run; sources,
 *   previews, reach and search (3), audience uploads (4) and breakdowns (5) are held until usage drops or the hold ends. The busy
 *   state is kept in memory and in the same PlatformSetting row (`busy`), so the web server and the worker hold the same work.
 * - Phase 0's own spend reads and every lowering go through Phase 0's clients and are never held here.
 *
 * Fails open: if the setting cannot be read or written, the call goes ahead (pacing is politeness, not a safety check; the
 * spend tripwire is). Nothing here logs a token, an id beyond the scope, or a header value.
 */
import { log } from "@/lib/log";
import { HttpError } from "@/lib/tenancy";

// ---------------------------------------------------------------------------------------------------------------------
// Priorities and codes
// ---------------------------------------------------------------------------------------------------------------------

export type ThrottlePriority = 1 | 2 | 3 | 4 | 5;

/** 4.9: who runs first when Meta's allowance runs low. */
export const PRIORITY = {
  /** Lead reads and backfill. */
  leads: 1,
  /** Review status sync. */
  review: 2,
  /** Sources, previews, reach, search and every call made for a person on the page. */
  interactive: 3,
  /** Audience uploads. */
  audiences: 4,
  /** Results breakdowns. */
  breakdowns: 5,
} as const satisfies Record<string, ThrottlePriority>;

/** Above this usage (percent), only priorities 1 and 2 run. */
export const BUSY_PCT = 75;
/** The highest priority still allowed while busy. */
export const BUSY_MAX_PRIORITY: ThrottlePriority = 2;

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Meta's rate-limit codes: user (17), Page (32), business use case (80000 to 80014) and the ads API (613). */
export const THROTTLE_CODES: ReadonlySet<number> = new Set([17, 32, 613, ...range(80000, 80014)]);
/** 613 subcodes that also set the cooldown: budget changes per hour, and two ads-management rate limits. */
export const THROTTLE_613_SUBCODES: readonly number[] = [1487632, 5044001, 4841018];

const MINUTE = 60_000;
/** Cooldown when Meta gives no time: 5 minutes. */
export const DEFAULT_COOLDOWN_MS = 5 * MINUTE;
/** 613/1487632 counts budget changes per hour, so it waits an hour. */
export const HOURLY_COOLDOWN_MS = 60 * MINUTE;
/** No cooldown or hold lasts longer than a day, whatever a header says. */
export const MAX_COOLDOWN_MS = 24 * 60 * MINUTE;
/** How long a busy reading holds priorities 3 to 5 when Meta gives no time; the next priority 1 or 2 call refreshes it. */
export const BUSY_HOLD_MS = 5 * MINUTE;
/** Usage read from headers counts for this long in memory. */
export const USAGE_TTL_MS = 5 * MINUTE;
/** Headers longer than this are ignored (Meta's are well under 1 KB). */
const MAX_HEADER_LENGTH = 8 * 1024;
const MAX_MEMORY_SCOPES = 1000;

export function isThrottleError(code: number | null | undefined, subcode?: number | null): boolean {
  if (typeof code !== "number") return false;
  if (THROTTLE_CODES.has(code)) return true;
  return typeof subcode === "number" && THROTTLE_613_SUBCODES.includes(subcode);
}

// ---------------------------------------------------------------------------------------------------------------------
// Usage headers
// ---------------------------------------------------------------------------------------------------------------------

export const USAGE_HEADERS = ["x-business-use-case-usage", "x-ad-account-usage", "x-fb-ads-insights-throttle"] as const;
export type UsageHeader = (typeof USAGE_HEADERS)[number];

export type ThrottleUsage = {
  /** The highest usage percentage in any header, 0 to 100. */
  pct: number;
  /** How long Meta says until calls work again (ms), when it says so and it is more than zero. */
  regainMs: number | null;
  /** Meta's access tier, when a header names it ("development_access", "standard_access"). */
  tier: string | null;
  /** The headers that were read. */
  sources: UsageHeader[];
};

type HeaderSource = Headers | Readonly<Record<string, string | string[] | undefined>> | null | undefined;

function headerValue(headers: HeaderSource, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() !== name) continue;
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  }
  return null;
}

const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const clampPct = (n: number) => Math.min(100, Math.max(0, n));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const tierOf = (v: unknown): string | null => (typeof v === "string" && /^[a-z_]{1,40}$/.test(v) ? v : null);

function parseJsonHeader(raw: string | null): unknown {
  if (!raw || raw.length > MAX_HEADER_LENGTH) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Reads Meta's usage headers. Returns null when none is present or readable. Bad JSON, odd shapes and huge values are ignored
 * rather than trusted: a percentage is clamped to 0..100 and a wait to at most a day.
 */
export function parseUsageHeaders(headers: HeaderSource): ThrottleUsage | null {
  const pcts: number[] = [];
  const regains: number[] = [];
  const sources: UsageHeader[] = [];
  let tier: string | null = null;
  const take = (entry: Record<string, unknown>, pctKeys: string[]) => {
    for (const k of pctKeys) {
      const n = finite(entry[k]);
      if (n !== null) pcts.push(clampPct(n));
    }
    tier ??= tierOf(entry.ads_api_access_tier);
  };

  // {"<business id>": [{type, call_count, total_cputime, total_time, estimated_time_to_regain_access (minutes), ...}]}
  const buc = parseJsonHeader(headerValue(headers, "x-business-use-case-usage"));
  if (isObject(buc)) {
    let read = false;
    for (const list of Object.values(buc).slice(0, 50)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list.slice(0, 50)) {
        if (!isObject(entry)) continue;
        read = true;
        take(entry, ["call_count", "total_cputime", "total_time"]);
        const minutes = finite(entry.estimated_time_to_regain_access);
        if (minutes !== null && minutes > 0) regains.push(minutes * MINUTE);
      }
    }
    if (read) sources.push("x-business-use-case-usage");
  }

  // {"acc_id_util_pct": 9.67, "reset_time_duration": 0 (seconds), "ads_api_access_tier": "standard_access"}
  const acc = parseJsonHeader(headerValue(headers, "x-ad-account-usage"));
  if (isObject(acc)) {
    sources.push("x-ad-account-usage");
    take(acc, ["acc_id_util_pct"]);
    const seconds = finite(acc.reset_time_duration);
    if (seconds !== null && seconds > 0) regains.push(seconds * 1000);
  }

  // {"app_id_util_pct": 100, "acc_id_util_pct": 10, "ads_api_access_tier": "standard_access"}
  const insights = parseJsonHeader(headerValue(headers, "x-fb-ads-insights-throttle"));
  if (isObject(insights)) {
    sources.push("x-fb-ads-insights-throttle");
    take(insights, ["app_id_util_pct", "acc_id_util_pct"]);
  }

  if (sources.length === 0) return null;
  const regain = regains.length ? Math.min(MAX_COOLDOWN_MS, Math.max(...regains)) : null;
  return { pct: pcts.length ? Math.max(...pcts) : 0, regainMs: regain, tier, sources };
}

/** How long a rate-limit error keeps the scope cooling down. */
export function cooldownMsFor(code: number, subcode: number | null | undefined, usage: ThrottleUsage | null): number {
  if (usage?.regainMs) return Math.min(MAX_COOLDOWN_MS, usage.regainMs);
  if (code === 613 && subcode === 1487632) return HOURLY_COOLDOWN_MS;
  return DEFAULT_COOLDOWN_MS;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scopes and the stored record
// ---------------------------------------------------------------------------------------------------------------------

const SCOPE = /^(act|page|ig)_[A-Za-z0-9]{1,40}$/;

/** The scope of an ad account's calls: "act_<id>". */
export function adAccountScope(externalId: string): string {
  const id = String(externalId ?? "").trim().replace(/^act_/, "");
  return `act_${id}`;
}

/** The scope of a Page's (or its Instagram account's) calls: "page_<id>". */
export function pageScope(pageId: string): string {
  return `page_${String(pageId ?? "").trim()}`;
}

/** The scope of an Instagram account's own edges (media, stories): "ig_<id>". */
export function instagramScope(igUserId: string): string {
  return `ig_${String(igUserId ?? "").trim()}`;
}

/** PlatformSetting key of a scope's record. */
export function throttleKey(scope: string): string {
  if (!SCOPE.test(scope)) throw new Error("Unknown throttle scope.");
  return `promote:throttle:${scope}`;
}

export type Cooldown = { until: Date; code: number; subcode: number | null };

/** The stored record: a cooldown `{until, code}` (4.9) and, while usage is above 75%, `busy`. */
export type ThrottleRecord = {
  until?: string;
  code?: number;
  subcode?: number;
  busy?: { pct: number; until: string };
};

/** Key-value access to PlatformSetting (injectable for tests). */
export type SettingStore = {
  get(key: string): Promise<unknown>;
  set(key: string, value: Record<string, unknown>): Promise<void>;
};

/** The PlatformSetting table. The database client is loaded on first use, so importing this module needs no database. */
export const platformSettingStore: SettingStore = {
  async get(key) {
    const { prisma } = await import("@/lib/db");
    const row = await prisma.platformSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  },
  async set(key, value) {
    const { prisma } = await import("@/lib/db");
    const json = value as unknown as import("@/generated/prisma/client").Prisma.InputJsonValue;
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
  },
};

const isoDate = (v: unknown): Date | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Reads a stored record, dropping anything malformed. */
export function readRecord(raw: unknown): ThrottleRecord {
  if (!isObject(raw)) return {};
  const out: ThrottleRecord = {};
  if (isoDate(raw.until) && typeof raw.code === "number") {
    out.until = String(raw.until);
    out.code = raw.code;
    if (typeof raw.subcode === "number") out.subcode = raw.subcode;
  }
  if (isObject(raw.busy) && isoDate(raw.busy.until) && finite(raw.busy.pct) !== null) out.busy = { pct: clampPct(Number(raw.busy.pct)), until: String(raw.busy.until) };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------------------------------------------------

/** Meta asked us to slow down (cooldown), or usage is high and this call can wait (busy). Nothing was sent. */
export class PromoteThrottledError extends HttpError {
  readonly code = "promote.meta_busy" as const;
  readonly reason: "cooldown" | "busy";
  readonly until: Date;
  readonly metaCode: number | null;
  readonly scope: string;
  constructor(input: { reason: "cooldown" | "busy"; until: Date; metaCode?: number | null; scope: string; now?: number }) {
    const minutes = Math.max(1, Math.ceil((input.until.getTime() - (input.now ?? Date.now())) / MINUTE));
    super(503, `Meta is busy right now. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`);
    this.name = "PromoteThrottledError";
    this.reason = input.reason;
    this.until = input.until;
    this.metaCode = input.metaCode ?? null;
    this.scope = input.scope;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The throttle
// ---------------------------------------------------------------------------------------------------------------------

export type ThrottleDeps = { store?: SettingStore; now?: () => number };

type Memory = { pct: number; at: number; persistedBusyUntil: number | null };

export function createThrottle(deps: ThrottleDeps = {}) {
  const store = deps.store ?? platformSettingStore;
  const now = deps.now ?? Date.now;
  const memory = new Map<string, Memory>();

  async function load(scope: string): Promise<ThrottleRecord> {
    try {
      return readRecord(await store.get(throttleKey(scope)));
    } catch {
      log.warn("promote.throttle.read_failed", { scope });
      return {};
    }
  }

  async function save(scope: string, record: ThrottleRecord): Promise<void> {
    try {
      await store.set(throttleKey(scope), record as Record<string, unknown>);
    } catch {
      log.warn("promote.throttle.write_failed", { scope });
    }
  }

  function remember(scope: string, m: Memory): void {
    memory.delete(scope);
    memory.set(scope, m);
    if (memory.size > MAX_MEMORY_SCOPES) memory.delete(memory.keys().next().value as string);
  }

  /** The cooldown in force for a scope, or null. */
  async function cooldown(scope: string): Promise<Cooldown | null> {
    const rec = await load(scope);
    const until = isoDate(rec.until);
    if (!until || until.getTime() <= now() || typeof rec.code !== "number") return null;
    return { until, code: rec.code, subcode: rec.subcode ?? null };
  }

  /**
   * Before every promote call: throws PromoteThrottledError while the scope cools down, and, for priorities 3 to 5, while usage
   * is above 75%.
   */
  async function check(scope: string, priority: ThrottlePriority): Promise<void> {
    const t = now();
    const rec = await load(scope);
    const until = isoDate(rec.until);
    if (until && until.getTime() > t) throw new PromoteThrottledError({ reason: "cooldown", until, metaCode: rec.code ?? null, scope, now: t });
    if (priority <= BUSY_MAX_PRIORITY) return;
    const mem = memory.get(scope);
    if (mem && t - mem.at < USAGE_TTL_MS && mem.pct > BUSY_PCT) {
      throw new PromoteThrottledError({ reason: "busy", until: new Date(Math.max(mem.at + BUSY_HOLD_MS, mem.persistedBusyUntil ?? 0)), scope, now: t });
    }
    const busyUntil = isoDate(rec.busy?.until);
    const freshLow = mem && t - mem.at < USAGE_TTL_MS && mem.pct <= BUSY_PCT;
    if (busyUntil && busyUntil.getTime() > t && (rec.busy?.pct ?? 0) > BUSY_PCT && !freshLow) {
      throw new PromoteThrottledError({ reason: "busy", until: busyUntil, scope, now: t });
    }
  }

  /** After every response: remembers the usage and shares a busy reading (or its end) through the stored record. */
  async function noteUsage(scope: string, usage: ThrottleUsage | null): Promise<void> {
    if (!usage) return;
    const t = now();
    const prev = memory.get(scope);
    const m: Memory = { pct: usage.pct, at: t, persistedBusyUntil: prev?.persistedBusyUntil ?? null };
    if (usage.pct > BUSY_PCT) {
      const until = t + Math.min(MAX_COOLDOWN_MS, Math.max(BUSY_HOLD_MS, usage.regainMs ?? 0));
      // Write when the shared hold is missing or about to lapse; most calls only touch memory.
      if (m.persistedBusyUntil === null || m.persistedBusyUntil - t < BUSY_HOLD_MS / 2) {
        const rec = await load(scope);
        await save(scope, { ...rec, busy: { pct: usage.pct, until: new Date(until).toISOString() } });
        m.persistedBusyUntil = until;
      }
    } else if (m.persistedBusyUntil !== null) {
      const rest = { ...(await load(scope)) };
      delete rest.busy;
      await save(scope, rest);
      m.persistedBusyUntil = null;
    }
    remember(scope, m);
  }

  async function noteHeaders(scope: string, headers: HeaderSource): Promise<ThrottleUsage | null> {
    const usage = parseUsageHeaders(headers);
    await noteUsage(scope, usage);
    return usage;
  }

  /** After a Meta error: a rate-limit code starts (or extends) the cooldown. Returns it, or null for any other error. */
  async function noteError(scope: string, error: { code?: number | null; subcode?: number | null }, usage: ThrottleUsage | null = null): Promise<Cooldown | null> {
    if (!isThrottleError(error.code, error.subcode)) return null;
    const code = error.code as number;
    const t = now();
    const ms = cooldownMsFor(code, error.subcode, usage);
    const rec = await load(scope);
    const current = isoDate(rec.until)?.getTime() ?? 0;
    const until = Math.max(current, t + ms);
    const next: ThrottleRecord = { ...rec, until: new Date(until).toISOString(), code };
    if (typeof error.subcode === "number") next.subcode = error.subcode;
    else delete next.subcode;
    await save(scope, next);
    log.info("promote.throttle.cooldown", { scope, code, subcode: error.subcode ?? null, minutes: Math.ceil((until - t) / MINUTE) });
    return { until: new Date(until), code, subcode: typeof error.subcode === "number" ? error.subcode : null };
  }

  /** The latest usage read for a scope, while it is fresh. */
  function usage(scope: string): { pct: number; at: Date } | null {
    const m = memory.get(scope);
    return m && now() - m.at < USAGE_TTL_MS ? { pct: m.pct, at: new Date(m.at) } : null;
  }

  return { check, cooldown, noteHeaders, noteUsage, noteError, usage, reset: () => memory.clear() };
}

export type Throttle = ReturnType<typeof createThrottle>;

/** The process-wide throttle on PlatformSetting. */
export const throttle: Throttle = createThrottle();

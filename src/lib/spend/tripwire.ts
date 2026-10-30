/**
 * The transport tripwire (docs/SPEND-CONTROLS-SPEC.md 4.7). src/lib/graph/index.ts calls tripwire() first in run(), before any
 * network I/O, for every Graph request. It catches any code path that skips the Spend Book (layer 3 of 4.2).
 *
 * - The request is classified (classify.ts). `not_spend` passes untouched.
 * - `ads_raise_or_unknown`, `ads_create`, `meta_cap` and `msg_send` need a minted permit in the async context (permit.ts
 *   permitStore) that matches: the tenant (graphFetch) or the ad account and objects (graphFetchAs), the path, uses below
 *   maxUses, an unexpired expiresAt, budgets at or below the permitted maximum, an end no later than the permitted end, and
 *   for creates status PAUSED (ad creatives are exempt: they have no delivery status, erratum 12.1b).
 * - `ads_lowering` (pause, archive) is never blocked. Without a permit it is let through and audited as
 *   `spend.tripwire.unledgered_lowering`.
 * - Mode SPEND_TRIPWIRE: `report` (the default, train 1) lets the request through and audits `spend.tripwire.bypass`, so today's
 *   behaviour is kept until every call site carries a permit; `enforce` throws SpendGuardBypassError (500, code spend_bypass)
 *   before any network I/O.
 *
 * Audit rows and log lines carry the path PATTERN only ("act_{id}/campaigns"), the class and a reason code: never a token, an
 * id, a query or a body. The audit write is fire-and-forget and can never fail or delay the request.
 *
 * Bypass rule B8: this file is one of the five that may import permit.ts.
 */
import { log } from "@/lib/log";
import {
  budgetFieldKind,
  classify,
  isEndField,
  LOWERING_STATUSES,
  metaCapFields,
  normalizePath,
  parseDecimalParam,
  parseMinorParam,
  parseTimeParam,
  type GraphCall,
  type GraphClassification,
} from "./classify";
import { SpendGuardBypassError } from "./errors";
import { spendTripwireMode } from "./flags";
import { currentPermit, isMintedPermit, permitUses, usePermit } from "./permit";
import type { GraphSpendClass, SpendPermit, TripwireMode } from "./types";

/** How the Graph call is authenticated: the tenant's stored token (graphFetch), a token the caller holds (graphFetchAs), the app. */
export type TripwireVia = { via: "tenant"; tenantId: string } | { via: "token" } | { via: "app" };

export type TripwireReason =
  | "no_permit"
  | "not_minted"
  | "expired"
  | "used_up"
  | "wrong_permit_type"
  | "wrong_tenant"
  | "wrong_account"
  | "wrong_path"
  | "wrong_object"
  | "not_paused"
  | "status_not_permitted"
  | "budget_over_permit"
  | "end_over_permit"
  | "field_not_permitted"
  | "cap_over_permit"
  | "cap_action_not_permitted"
  | "not_coverable";

export type CoverResult = { ok: true } | { ok: false; reason: TripwireReason };

export type TripwireOutcome =
  | { action: "pass"; class: "not_spend" }
  | { action: "permitted"; class: GraphSpendClass }
  | { action: "lowering_unledgered"; class: "ads_lowering"; reason: TripwireReason }
  | { action: "reported"; class: GraphSpendClass; reason: TripwireReason };

export type TripwireAuditEvent = {
  action: "spend.tripwire.bypass" | "spend.tripwire.unledgered_lowering";
  tenantId: string | null;
  /** The path pattern, never the path itself. */
  target: string;
  meta: { class: GraphSpendClass; reason: TripwireReason; mode: TripwireMode; method: string; via: TripwireVia["via"]; blocked: boolean };
};
export type TripwireAuditSink = (event: TripwireAuditEvent) => void | Promise<void>;

/** Writes the AuditLog row. Loaded lazily so this module stays free of the database client until a row is written. */
const defaultSink: TripwireAuditSink = async (event) => {
  const { audit } = await import("@/lib/auth/audit");
  await audit({ tenantId: event.tenantId, action: event.action, target: event.target, meta: event.meta });
};

let sink: TripwireAuditSink = defaultSink;

/** Test and ops hook: replaces where tripwire events are written. null restores the AuditLog writer. */
export function setTripwireAuditSink(next: TripwireAuditSink | null): void {
  sink = next ?? defaultSink;
}

const samePath = (a: string, b: string): boolean => a === b;
const pathOf = (segments: readonly string[]): string => segments.join("/");
const normalizedPermitPaths = (permit: SpendPermit): string[] => permit.paths.map((p) => pathOf(normalizePath(p).segments));
const accountKey = (id: string | null | undefined): string => String(id ?? "").replace(/^act_/, "");
const upper = (v: unknown): string | null => (typeof v === "string" ? v.trim().toUpperCase() : v === undefined || v === null ? null : String(v).toUpperCase());

function checkCommon(c: GraphClassification, permit: SpendPermit, ctx: TripwireVia, now: Date): CoverResult {
  if (permit.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (permitUses(permit) >= permit.maxUses) return { ok: false, reason: "used_up" };
  if (ctx.via === "tenant" && permit.tenantId !== ctx.tenantId) return { ok: false, reason: "wrong_tenant" };
  const path = pathOf(c.segments);
  if (!normalizedPermitPaths(permit).some((p) => samePath(p, path))) return { ok: false, reason: "wrong_path" };
  return { ok: true };
}

/** Each spend field of a POST <id> against an ads (raise) permit's object entry. */
function coverWithAdsPermit(c: GraphClassification, object: { maxDailyMinor?: bigint; maxLifetimeMinor?: bigint; status?: "ACTIVE"; endsAt?: Date }): CoverResult {
  for (const key of c.spendKeys) {
    const value = c.params[key];
    if (key === "status" || key === "configured_status") {
      const status = upper(value);
      if (status !== null && LOWERING_STATUSES.includes(status)) continue;
      if (status === "ACTIVE" && object.status === "ACTIVE") continue;
      return { ok: false, reason: "status_not_permitted" };
    }
    const budget = budgetFieldKind(key);
    if (budget) {
      const max = budget === "daily" ? object.maxDailyMinor : object.maxLifetimeMinor;
      const asked = parseMinorParam(value);
      if (max === undefined || asked === null || asked > max) return { ok: false, reason: "budget_over_permit" };
      continue;
    }
    if (isEndField(key)) {
      const asked = parseTimeParam(value);
      if (!object.endsAt || asked === null || asked.getTime() > object.endsAt.getTime()) return { ok: false, reason: "end_over_permit" };
      continue;
    }
    return { ok: false, reason: "field_not_permitted" };
  }
  return { ok: true };
}

/**
 * A lowering permit (recordLowering) covers stopping, and the cut or earlier end its kind names, up to the value it was minted
 * for: the book decided the direction, and a value above that bound would be a raise in disguise.
 */
function coverWithLoweringPermit(c: GraphClassification, permit: { kind: string; maxBudgetMinor?: bigint; endsAt?: Date }): CoverResult {
  for (const key of c.spendKeys) {
    if (key === "status" || key === "configured_status") {
      const status = upper(c.params[key]);
      if (status !== null && LOWERING_STATUSES.includes(status)) continue;
      return { ok: false, reason: "status_not_permitted" };
    }
    if (budgetFieldKind(key) && permit.kind === "cut_budget") {
      const asked = parseMinorParam(c.params[key]);
      if (asked === null) return { ok: false, reason: "field_not_permitted" };
      if (typeof permit.maxBudgetMinor !== "bigint" || asked > permit.maxBudgetMinor) return { ok: false, reason: "budget_over_permit" };
      continue;
    }
    if (isEndField(key) && permit.kind === "end_earlier") {
      const asked = parseTimeParam(c.params[key]);
      if (asked === null) return { ok: false, reason: "field_not_permitted" };
      if (!(permit.endsAt instanceof Date) || asked.getTime() > permit.endsAt.getTime()) return { ok: false, reason: "end_over_permit" };
      continue;
    }
    return { ok: false, reason: "field_not_permitted" };
  }
  return { ok: true };
}

/**
 * Pure check of a permit against a classified request. It does not count a use; tripwire() does that only when this passes.
 * A permit that is not one mintPermit() returned is refused, whatever its shape.
 */
export function permitCovers(c: GraphClassification, permit: unknown, ctx: TripwireVia, now: Date = new Date()): CoverResult {
  if (permit === undefined || permit === null) return { ok: false, reason: "no_permit" };
  if (!isMintedPermit(permit)) return { ok: false, reason: "not_minted" };
  switch (c.class) {
    case "not_spend":
      return { ok: true };
    case "msg_send": {
      if (permit.type !== "msg") return { ok: false, reason: "wrong_permit_type" };
      const common = checkCommon(c, permit, ctx, now);
      if (!common.ok) return common;
      if (permit.phoneNumberId !== c.objectId) return { ok: false, reason: "wrong_object" };
      return { ok: true };
    }
    case "ads_create": {
      if (permit.type !== "create") return { ok: false, reason: "wrong_permit_type" };
      const common = checkCommon(c, permit, ctx, now);
      if (!common.ok) return common;
      if (accountKey(permit.adAccountExternalId) !== accountKey(c.account)) return { ok: false, reason: "wrong_account" };
      // Campaigns, ad sets and ads are created PAUSED and turned on only through reserveAds. Creatives have no delivery status.
      if (c.createKind !== "adcreatives") {
        if (upper(c.params.status) !== "PAUSED") return { ok: false, reason: "not_paused" };
        for (const k of ["configured_status", "status_option"]) if (k in c.params && upper(c.params[k]) !== "PAUSED") return { ok: false, reason: "not_paused" };
      }
      return { ok: true };
    }
    case "meta_cap": {
      if (permit.type !== "meta_cap") return { ok: false, reason: "wrong_permit_type" };
      const common = checkCommon(c, permit, ctx, now);
      if (!common.ok) return common;
      if (accountKey(permit.accountExternalId) !== accountKey(c.account)) return { ok: false, reason: "wrong_account" };
      const cap = metaCapFields(c);
      if (cap.others.length > 0) return { ok: false, reason: "field_not_permitted" };
      if (cap.action !== null) {
        // Only removing the limit, with a permit minted for exactly that. `reset` (zeroing the customer's counter) is never allowed.
        if (cap.action !== "delete" || permit.kind !== "delete") return { ok: false, reason: "cap_action_not_permitted" };
      }
      if (cap.hasCap) {
        if (permit.kind !== "write") return { ok: false, reason: "cap_action_not_permitted" };
        const asked = parseDecimalParam(cap.cap);
        if (asked === null) return { ok: false, reason: "cap_over_permit" };
        // Meta's write unit is still being verified (runbook V1): the value written is never more than the permitted cap read as
        // minor units, which holds whichever unit Meta uses (a major-unit write is the stricter of the two).
        if (permit.capMinor !== undefined && asked.units > permit.capMinor * 10n ** BigInt(asked.scale)) return { ok: false, reason: "cap_over_permit" };
      }
      return { ok: true };
    }
    case "ads_lowering":
    case "ads_raise_or_unknown": {
      if (!c.objectId || c.segments.length !== 1 || c.account) return { ok: false, reason: "not_coverable" };
      if (permit.type === "ads") {
        const common = checkCommon(c, permit, ctx, now);
        if (!common.ok) return common;
        const object = permit.objects[c.objectId];
        if (!object) return { ok: false, reason: "wrong_object" };
        return coverWithAdsPermit(c, object);
      }
      if (permit.type === "lowering") {
        const common = checkCommon(c, permit, ctx, now);
        if (!common.ok) return common;
        if (!permit.metaObjectIds.includes(c.objectId)) return { ok: false, reason: "wrong_object" };
        return coverWithLoweringPermit(c, permit);
      }
      return { ok: false, reason: "wrong_permit_type" };
    }
  }
}

function report(event: TripwireAuditEvent): void {
  log.warn(event.action, { pattern: event.target, ...event.meta });
  try {
    const pending = sink(event);
    if (pending && typeof (pending as Promise<void>).catch === "function") (pending as Promise<void>).catch(() => log.error("spend.tripwire.audit_failed", { action: event.action }));
  } catch {
    log.error("spend.tripwire.audit_failed", { action: event.action });
  }
}

export type TripwireOptions = {
  mode?: TripwireMode;
  now?: Date;
  /** The permit to check; the one in the async context when omitted. */
  permit?: unknown;
};

/**
 * The check run() makes before any network I/O. Returns what happened, or throws SpendGuardBypassError in enforce mode. A use
 * of the permit is counted only when it covers the request (once per request: retries inside run() do not count again).
 */
export function tripwire(call: GraphCall, ctx: TripwireVia, opts: TripwireOptions = {}): TripwireOutcome {
  const c = classify(call);
  if (c.class === "not_spend") return { action: "pass", class: "not_spend" };
  const mode = opts.mode ?? spendTripwireMode();
  const now = opts.now ?? new Date();
  const permit = "permit" in opts ? opts.permit : currentPermit();
  let check = permitCovers(c, permit, ctx, now);
  if (check.ok) {
    const used = usePermit(permit, now);
    if (used.ok) return { action: "permitted", class: c.class };
    check = { ok: false, reason: used.reason };
  }
  const tenantId = ctx.via === "tenant" ? ctx.tenantId : isMintedPermit(permit) ? permit.tenantId : null;
  const meta = { class: c.class, reason: check.reason, mode, method: c.method, via: ctx.via };
  if (c.class === "ads_lowering") {
    // A stop is never blocked (I2). Without a matching permit it is only recorded.
    report({ action: "spend.tripwire.unledgered_lowering", tenantId, target: c.pattern, meta: { ...meta, blocked: false } });
    return { action: "lowering_unledgered", class: "ads_lowering", reason: check.reason };
  }
  report({ action: "spend.tripwire.bypass", tenantId, target: c.pattern, meta: { ...meta, blocked: mode === "enforce" } });
  if (mode === "enforce") throw new SpendGuardBypassError(check.reason);
  return { action: "reported", class: c.class, reason: check.reason };
}

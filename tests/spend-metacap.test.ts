import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";
import { createFakeMeta, type FakeMeta } from "./helpers/fake-meta";

/*
 * Wall (a), Meta's spending limit (docs/SPEND-CONTROLS-SPEC.md 5, 4.17, 8.4, 12.1a decision 5) against fake Meta: the
 * target, the change budget, unit and semantics detection, the failure modes, outside changes, rollover, observe mode,
 * owner-only consent with the text hash, one manager per real ad account, start values, locked workspaces, offboarding, and
 * the Spend Book's fresh read before its lock. Every Graph call goes through the real transport with the tripwire in
 * enforce mode, so each write must carry the right permit.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  active: true,
  canWrite: vi.fn(async (_tenantId: string) => undefined as void),
  actor: { userId: "u_owner", tenantId: "t1", role: "owner" as "owner" | "admin" | "agent" },
  unreachable: false,
  fetchImpl: null as null | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>),
  jobs: [] as unknown[][],
}));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => h.active }));
vi.mock("@/lib/queue", () => ({
  enqueue: async (...args: unknown[]) => {
    h.jobs.push(args);
    return {};
  },
}));
vi.mock("@/lib/meta-connect", () => ({
  getAssetAccess: async (_tenantId: string, assetId: string) => {
    if (h.unreachable) {
      const { HttpError } = await import("@/lib/tenancy");
      throw new HttpError(409, "The Meta connection for this asset has expired or been disconnected. Reconnect it in Settings.");
    }
    return { assetId, type: "ad_account", externalId: assetId === "acc2" ? "act_222" : "act_111", name: "Shop ads", token: "tok-ads" };
  },
}));
vi.mock("@/lib/auth", () => ({ getActor: async () => h.actor }));
vi.mock("@/lib/billing", async (orig) => ({ ...(await orig<typeof import("@/lib/billing")>()), assertTenantCanWrite: (tenantId: string) => h.canWrite(tenantId) }));

import { defaultMetaCapPreRead, reserveAds, resetBookForTests, setMetaCapPreRead } from "@/lib/spend/book";
import { heldSpendLocks } from "@/lib/spend/lock";
import { resetSpendStateCache } from "@/lib/spend/kill";
import { setTripwireAuditSink } from "@/lib/spend/tripwire";
import { analyseReadBack, capValueString, classifyCapError, CONNECT_AGAIN_LABEL, METACAP_LOCK_SQL, NO_PERMISSION_COPY, parseCounter, parseFloorMinor } from "@/lib/spend/metacap/client";
import {
  ADMIN_PENDING_COPY,
  getMetaLimitDTO,
  META_CAP_CONSENT,
  META_CAP_TEXT_VERSION,
  metaCapConsentSha256,
  metaCapConsentText,
  notePendingOwnerAfterConnect,
  OTHER_WORKSPACE_COPY,
  turnOffMetaLimit,
  turnOnMetaLimit,
  useMyEdwyzLimit,
} from "@/lib/spend/metacap/consent";
import { offboardAccount, offboardChoicesFor, offboardTenant, onSpendingAccountChange, saveOffboardChoices } from "@/lib/spend/metacap/offboard";
import {
  budgetAllows,
  budgetFreesAt,
  changeBudget,
  monthStartAtConsent,
  planMetaCap,
  spentThisMonth,
  targetCapMinor,
  thresholdMinor,
  toMetaCapRow,
  translateCustomerCapAfterReset,
  type CapWriteRecord,
  type PlanInput,
} from "@/lib/spend/metacap/plan";
import { ensureFreshRead, p0Stop, readDue, runMetacapPass, syncMetaCap } from "@/lib/spend/metacap/sync";
import { queues as metacapQueues, periodic as metacapPeriodic } from "@/lib/spend/tasks/metacap";
import type { SpendNotice } from "@/lib/spend/types";
import { GET as metaLimitGET, POST as metaLimitPOST, PUT as metaLimitPUT } from "@/app/api/spend/meta-limit/route";

// Wednesday 28 Oct 2026, 12:00 in Asia/Kolkata.
const NOW = new Date("2026-10-28T06:30:00Z");
const T = "t1";
const INR = (rupees: number) => BigInt(Math.round(rupees * 100));
const CAP = { SPEND_CAP_MODE: "enforce", SPEND_ENFORCE: "enforce" } as Record<string, string>;
const OBSERVE = { SPEND_CAP_MODE: "observe", SPEND_ENFORCE: "enforce" } as Record<string, string>;
const owner = { userId: "u_owner", role: "owner" as const };
const admin = { userId: "u_admin", role: "admin" as const };

let meta: FakeMeta;
let notices: SpendNotice[];

const rows = (name: string) => h.db.rows(name);
const limitRow = (id = "acc1") => rows("metaSpendLimit").find((r) => r.adAccountAssetId === id) as Row;
const ledger = (action?: string, phase?: string) => rows("spendLedger").filter((r) => (!action || r.action === action) && (!phase || r.phase === phase));
const posts = () => meta.calls.filter((c) => c.method === "POST");
const capPosts = () => posts().filter((c) => "spend_cap" in c.params || "spend_cap_action" in c.params);
const io = (over: Record<string, unknown> = {}) => ({ env: CAP, notify: async (n: SpendNotice) => void notices.push(n), access: async (_t: string, a: string) => ({ token: "tok-ads", externalId: a === "acc2" ? "act_222" : "act_111" }), ...over });

function at(d: Date) {
  vi.setSystemTime(d);
  meta.setNow(d);
}

function seedWorkspace(o: { tenantId?: string; assetId?: string; external?: string; monthly?: bigint | null; daily?: bigint | null; currency?: string; demo?: boolean; sandbox?: boolean; meta?: Record<string, unknown> } = {}) {
  const tenantId = o.tenantId ?? T;
  const assetId = o.assetId ?? "acc1";
  if (!rows("tenant").some((t) => t.id === tenantId)) h.db.seed("tenant", [{ id: tenantId, name: "Shop", slug: tenantId, status: "active", deletedAt: null, billingExempt: false }]);
  h.db.seed("metaAsset", [
    { id: assetId, tenantId, connectionId: "mc1", type: "ad_account", externalId: o.external ?? "act_111", name: "Shop ads", status: "active", meta: { currency: o.currency ?? "INR", timezone: "Asia/Kolkata", ...(o.demo ? { demo: true } : {}), ...(o.meta ?? {}) }, sandbox: o.sandbox ?? false, createdAt: new Date("2026-01-01") },
  ]);
  h.db.seed("spendControl", [{ tenantId, probation: "lifted", spendingAdAccountAssetId: assetId, timezone: "Asia/Kolkata" }]);
  h.db.seed("spendAllowance", [{ id: `sa_${tenantId}`, tenantId, pot: "ads", currency: "INR", dailyLimitMinor: o.daily === undefined ? INR(2_000) : o.daily, monthlyLimitMinor: o.monthly === undefined ? INR(30_000) : o.monthly }]);
}

/** The account's month-to-date from the fast sync. */
function seedMtd(rupees: number, day = "2026-10-28", assetId = "acc1", tenantId = T) {
  h.db.seed("spendDaily", [{ tenantId, pot: "ads", scopeType: "account", scopeId: assetId, day: new Date(`${day}T00:00:00Z`), currency: "INR", amountMinor: INR(rupees), origin: "all", source: "fast_sync", syncedAt: NOW }]);
}

/** A managed row: A = ₹50,000, month start ₹40,000, so S = ₹10,000 and with M = ₹30,000, T = ₹70,000. */
function seedManaged(over: Row = {}) {
  h.db.seed("metaSpendLimit", [
    {
      adAccountAssetId: "acc1",
      tenantId: T,
      accountExternalId: "act_111",
      mode: "managed",
      unitMode: "major_write",
      semantics: "cumulative",
      currency: "INR",
      timezone: "Asia/Kolkata",
      monthKey: "2026-10",
      monthStartAmountSpentMinor: INR(40_000),
      lastError: null,
      ...over,
    },
  ]);
}

/** The pending write is due now (its debounce has passed). */
const due = { pendingTargetMinor: INR(1), deferredUntil: new Date(NOW.getTime() - 1_000) };
/** Edwyz already manages the limit at T = ₹70,000 and it was verified. */
const verified = { managedCapMinor: INR(70_000), targetCapMinor: INR(70_000), lastReadCapMinor: INR(70_000), lastReadAmountSpentMinor: INR(50_000), lastReadAt: new Date(NOW.getTime() - 20 * 60_000), lastWriteAt: new Date(NOW.getTime() - 3 * 3_600_000) };

function seedWrites(n: number, raise = false, ago = 60 * 60_000) {
  for (let i = 0; i < n; i++) {
    h.db.seed("spendLedger", [{ id: `w${i}`, tenantId: T, pot: "ads", action: "meta.spend_cap.write", phase: "requested", actorType: "system", targetType: "ad_account", targetId: "acc1", reason: "earlier", correlationId: `old${i}`, snapshot: { raise }, createdAt: new Date(NOW.getTime() - ago - i * 1_000) }]);
  }
}

beforeEach(() => {
  h.db.reset();
  h.active = true;
  h.unreachable = false;
  h.jobs = [];
  h.actor = { userId: "u_owner", tenantId: T, role: "owner" };
  h.canWrite.mockReset();
  h.canWrite.mockResolvedValue(undefined);
  notices = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  meta = createFakeMeta({ now: NOW, accountId: "act_111", amountSpentMinor: INR(50_000) });
  h.fetchImpl = meta.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => h.fetchImpl!(input, init));
  process.env.SPEND_TRIPWIRE = "enforce";
  delete process.env.SPEND_CAP_MODE;
  setTripwireAuditSink(() => undefined);
  resetSpendStateCache();
  resetBookForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.SPEND_TRIPWIRE;
  delete process.env.SPEND_CAP_MODE;
  setTripwireAuditSink(null);
});

// =====================================================================================================================
describe("the plan (5.3, 5.4), pure", () => {
  const baseRow = (over: Partial<ReturnType<typeof toMetaCapRow>> = {}) =>
    ({ ...toMetaCapRow({ adAccountAssetId: "acc1", tenantId: T, accountExternalId: "act_111", mode: "managed", unitMode: "major_write", semantics: "cumulative", currency: "INR", monthKey: "2026-10", monthStartAmountSpentMinor: INR(40_000), lastReadCapMinor: INR(70_000), lastReadAmountSpentMinor: INR(50_000), lastReadAt: NOW, lastWriteAt: new Date("2026-10-20") }), ...over });
  const input = (over: Partial<PlanInput> = {}): PlanInput => ({
    now: NOW,
    row: baseRow(),
    monthlyLimitMinor: INR(30_000),
    dailyLimitMinor: INR(2_000),
    accountMonthToDateMinor: INR(10_000),
    roomNeededMinor: 0n,
    writes: [],
    workspaceActive: true,
    thresholdFloorMinor: INR(100),
    monthStartAt: new Date("2026-10-31T18:30:00Z") > NOW ? new Date("2026-09-30T18:30:00Z") : NOW,
    request: null,
    ...over,
  });

  it("targets A + (M - S) under cumulative semantics and R under resets_on_write", () => {
    expect(targetCapMinor({ semantics: "cumulative", amountSpentMinor: INR(50_000), monthlyMinor: INR(30_000), spentMinor: INR(10_000), customerCapMinor: null })).toBe(INR(70_000));
    expect(targetCapMinor({ semantics: "unverified", amountSpentMinor: INR(50_000), monthlyMinor: INR(30_000), spentMinor: INR(10_000), customerCapMinor: null })).toBe(INR(70_000));
    expect(targetCapMinor({ semantics: "resets_on_write", amountSpentMinor: INR(2_000), monthlyMinor: INR(30_000), spentMinor: INR(10_000), customerCapMinor: null })).toBe(INR(20_000));
    // A customer's own lower cap wins; R never goes below zero.
    expect(targetCapMinor({ semantics: "cumulative", amountSpentMinor: INR(50_000), monthlyMinor: INR(30_000), spentMinor: INR(10_000), customerCapMinor: INR(60_000) })).toBe(INR(60_000));
    expect(targetCapMinor({ semantics: "cumulative", amountSpentMinor: INR(50_000), monthlyMinor: INR(30_000), spentMinor: INR(35_000), customerCapMinor: null })).toBe(INR(50_000));
  });

  it("S is the larger of insights and Meta's counter; under resets_on_write S = spentAtLastWrite + A", () => {
    expect(spentThisMonth({ semantics: "cumulative", amountSpentMinor: INR(50_000), monthStartAmountSpentMinor: INR(40_000), spentAtLastWriteMinor: null, accountMonthToDateMinor: INR(9_000) })).toBe(INR(10_000));
    expect(spentThisMonth({ semantics: "cumulative", amountSpentMinor: INR(50_000), monthStartAmountSpentMinor: INR(40_000), spentAtLastWriteMinor: null, accountMonthToDateMinor: INR(12_000) })).toBe(INR(12_000));
    expect(spentThisMonth({ semantics: "resets_on_write", amountSpentMinor: INR(2_000), monthStartAmountSpentMinor: null, spentAtLastWriteMinor: INR(10_000), accountMonthToDateMinor: INR(11_000) })).toBe(INR(12_000));
    // Mid-month consent before the first fast sync: unknown, so the first write waits.
    expect(spentThisMonth({ semantics: "cumulative", amountSpentMinor: INR(50_000), monthStartAmountSpentMinor: null, spentAtLastWriteMinor: null, accountMonthToDateMinor: null })).toBeNull();
    expect(planMetaCap(input({ row: baseRow({ monthStartAmountSpentMinor: null }), accountMonthToDateMinor: null })).action).toBe("none");
  });

  it("start values at mid-month consent: A - month-to-date, floored at 0; a customer cap is translated at a reset", () => {
    expect(monthStartAtConsent(INR(50_000), INR(10_000))).toBe(INR(40_000));
    expect(monthStartAtConsent(INR(5_000), INR(10_000))).toBe(0n);
    expect(monthStartAtConsent(INR(5_000), null)).toBeNull();
    expect(translateCustomerCapAfterReset(INR(60_000), INR(50_000))).toBe(INR(10_000));
    expect(translateCustomerCapAfterReset(null, INR(50_000))).toBeNull();
  });

  it("the threshold is max(2% of M, half the daily limit, the INR 100 floor), and a change within it is not written", () => {
    expect(thresholdMinor({ monthlyMinor: INR(30_000), dailyMinor: INR(2_000), floorMinor: INR(100) })).toBe(INR(1_000));
    expect(thresholdMinor({ monthlyMinor: INR(100_000), dailyMinor: INR(1_000), floorMinor: INR(100) })).toBe(INR(2_000));
    expect(thresholdMinor({ monthlyMinor: INR(1_000), dailyMinor: INR(100), floorMinor: INR(100) })).toBe(INR(100));
    expect(planMetaCap(input({ row: baseRow({ lastReadCapMinor: INR(70_900) }) }))).toMatchObject({ action: "none", reason: "in_range" });
    expect(planMetaCap(input({ row: baseRow({ lastReadCapMinor: INR(69_100) }) }))).toMatchObject({ action: "none", reason: "in_range" });
    expect(planMetaCap(input({ row: baseRow({ lastReadCapMinor: INR(71_500), pendingTargetMinor: INR(70_000), deferredUntil: new Date(NOW.getTime() - 1) }) }))).toMatchObject({ action: "write", priority: "P1_lower", target: INR(70_000) });
  });

  it("change budget: routine stops at 6 writes in 24 h, emergency at 10, at most 2 routine raises; failed attempts count too", () => {
    const writes = (n: number, raise = false): CapWriteRecord[] => Array.from({ length: n }, (_, i) => ({ at: new Date(NOW.getTime() - (i + 1) * 60_000), raise }));
    expect(budgetAllows(changeBudget(writes(5), NOW), "routine")).toBe(true);
    expect(budgetAllows(changeBudget(writes(6), NOW), "routine")).toBe(false);
    expect(budgetAllows(changeBudget(writes(9), NOW), "emergency")).toBe(true);
    expect(budgetAllows(changeBudget(writes(10), NOW), "emergency")).toBe(false);
    expect(budgetAllows(changeBudget(writes(1, true), NOW), "routine_raise")).toBe(true);
    expect(budgetAllows(changeBudget(writes(2, true), NOW), "routine_raise")).toBe(false);
    // Rolling 24 h: a write 25 hours ago no longer counts.
    expect(changeBudget([{ at: new Date(NOW.getTime() - 25 * 3_600_000), raise: false }], NOW).used).toBe(0);
    const freesAt = budgetFreesAt(writes(6), "routine", NOW)!;
    expect(freesAt.getTime()).toBe(NOW.getTime() - 6 * 60_000 + 24 * 3_600_000 + 1);
    // Planned writes: routine P2 deferred at 6, P0 still written at 9.
    const rollover = input({ row: baseRow({ lastReadCapMinor: INR(60_000), lastWriteAt: new Date("2026-09-20") }), monthStartAt: new Date("2026-09-30T18:30:00Z") });
    expect(planMetaCap({ ...rollover, writes: writes(6) })).toMatchObject({ action: "defer", reason: "budget", priority: "P2_rollover" });
    expect(planMetaCap({ ...rollover, writes: writes(5) })).toMatchObject({ action: "write", priority: "P2_rollover", writeClass: "routine" });
    expect(planMetaCap(input({ writes: writes(9), request: { kind: "p0_stop" } }))).toMatchObject({ action: "write", priority: "P0_stop", writeClass: "emergency", target: INR(50_001) });
    expect(planMetaCap(input({ writes: writes(10), request: { kind: "p0_stop" } }))).toMatchObject({ action: "defer", reason: "budget" });
    // A P3 raise is a routine raise: refused after 2 raises in 24 h.
    const raise = input({ row: baseRow({ lastReadCapMinor: INR(60_000), lastWriteAt: new Date("2026-10-25"), pendingTargetMinor: INR(70_000), deferredUntil: new Date(NOW.getTime() - 1) }), monthStartAt: new Date("2026-09-30T18:30:00Z") });
    expect(planMetaCap(raise)).toMatchObject({ action: "write", priority: "P3_raise", writeClass: "routine_raise" });
    expect(planMetaCap({ ...raise, writes: writes(2, true) })).toMatchObject({ action: "defer", reason: "budget", priority: "P3_raise" });
  });

  it("debounce: P1 waits 2 minutes, P3 10 minutes; P0 and P2 have none", () => {
    expect(planMetaCap(input({ row: baseRow({ lastReadCapMinor: INR(80_000) }) }))).toMatchObject({ action: "defer", reason: "debounce", until: new Date(NOW.getTime() + 2 * 60_000) });
    const raise = input({ row: baseRow({ lastReadCapMinor: INR(60_000), lastWriteAt: new Date("2026-10-25") }), monthStartAt: new Date("2026-09-30T18:30:00Z") });
    expect(planMetaCap(raise)).toMatchObject({ action: "defer", reason: "debounce", until: new Date(NOW.getTime() + 10 * 60_000) });
    expect(planMetaCap(input({ request: { kind: "p0_stop" } })).action).toBe("write");
  });

  it("emergency P1 when Meta allows more than is left: C - A > R + threshold", () => {
    const d = planMetaCap(input({ row: baseRow({ lastReadCapMinor: INR(80_000), pendingTargetMinor: INR(70_000), deferredUntil: new Date(NOW.getTime() - 1) }) }));
    expect(d).toMatchObject({ action: "write", priority: "P1_lower", writeClass: "emergency" });
    // Routine when a customer cap keeps T below A + R and Meta's room is still within R + threshold.
    const r = planMetaCap(input({ row: baseRow({ lastReadCapMinor: INR(66_000), customerCapMinor: INR(64_000), pendingTargetMinor: INR(64_000), deferredUntil: new Date(NOW.getTime() - 1) }) }));
    expect(r).toMatchObject({ action: "write", priority: "P1_lower", writeClass: "routine", target: INR(64_000) });
  });

  it("locked or suspended workspaces never raise and defer P2; lowering still runs (4.17)", () => {
    const rollover = input({ row: baseRow({ lastReadCapMinor: INR(60_000), lastWriteAt: new Date("2026-09-20") }), monthStartAt: new Date("2026-09-30T18:30:00Z"), workspaceActive: false });
    expect(planMetaCap(rollover)).toMatchObject({ action: "defer", reason: "paused", priority: "P2_rollover", raise: true });
    expect(planMetaCap({ ...rollover, row: baseRow({ lastReadCapMinor: INR(60_000) }), monthStartAt: new Date("2026-09-30T18:30:00Z") })).toMatchObject({ action: "defer", reason: "paused" });
    const lower = planMetaCap(input({ workspaceActive: false, row: baseRow({ lastReadCapMinor: INR(80_000), pendingTargetMinor: INR(70_000), deferredUntil: new Date(NOW.getTime() - 1) }) }));
    expect(lower).toMatchObject({ action: "write", priority: "P1_lower" });
    expect(planMetaCap(input({ workspaceActive: false, request: { kind: "p0_stop" } }))).toMatchObject({ action: "write", priority: "P0_stop" });
  });

  it("while loose, raises stop once R ≤ 15% of M", () => {
    // S = max(26,000, 10,000): R = 4,000 (13% of M), so T = 54,000 is above the ₹52,000 cap: a raise, refused while loose.
    const loose = input({ row: baseRow({ lastReadCapMinor: INR(52_000), loosenessMinor: INR(500), lastWriteAt: new Date("2026-10-25") }), accountMonthToDateMinor: INR(26_000), monthStartAt: new Date("2026-09-30T18:30:00Z") });
    expect(planMetaCap(loose)).toMatchObject({ action: "none", reason: "loose" });
    expect(planMetaCap({ ...loose, row: { ...loose.row, loosenessMinor: null } })).toMatchObject({ action: "defer", priority: "P3_raise" });
  });
});

// =====================================================================================================================
describe("reading, writing and verifying against fake Meta (5.2, 5.5)", () => {
  it("writes T = A + (M - S) after the 2-minute debounce, in major units with the exponent, under the account lock, and verifies it", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged();
    const first = await syncMetaCap(T, "acc1", io());
    expect(first).toMatchObject({ status: "deferred", reason: "debounce" });
    expect(capPosts()).toHaveLength(0);
    expect(limitRow().pendingTargetMinor).toBe(INR(70_000));
    at(new Date(NOW.getTime() + 2 * 60_000 + 1_000));
    const second = await syncMetaCap(T, "acc1", io());
    expect(second.status).toBe("written");
    expect(capPosts()).toHaveLength(1);
    expect(capPosts()[0].params.spend_cap).toBe("70000.00");
    expect(meta.account().spendCapMinor).toBe(INR(70_000));
    expect(limitRow()).toMatchObject({ managedCapMinor: INR(70_000), unitMode: "major_write", semantics: "cumulative", lastError: null, pendingTargetMinor: null });
    const requested = ledger("meta.spend_cap.write", "requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ before: { cap: "0", amount_spent: "5000000" }, after: { cap: "7000000" }, undo: { action: "remove_meta_cap", adAccountAssetId: "acc1" } });
    expect(ledger("meta.spend_cap.write", "applied")).toHaveLength(1);
    expect(h.db.raw.some((r) => r.sql === METACAP_LOCK_SQL && r.values[0] === "acc1")).toBe(true);
  });

  it("under resets_on_write the read-back sees amount_spent drop to 0 and R is written at once (S = spentAtLastWrite + A)", async () => {
    meta.setSemantics("resets_on_write");
    seedWorkspace();
    seedMtd(10_000);
    seedManaged({ semantics: "unverified", unitMode: "unverified", ...due });
    const r = await syncMetaCap(T, "acc1", io());
    expect(r).toMatchObject({ status: "written", reason: "resets_on_write" });
    expect(capPosts().map((c) => c.params.spend_cap)).toEqual(["70000.00", "20000.00"]);
    expect(meta.account().spendCapMinor).toBe(INR(20_000));
    expect(limitRow()).toMatchObject({ semantics: "resets_on_write", unitMode: "major_write", spentAtLastWriteMinor: INR(10_000), managedCapMinor: INR(20_000) });
    expect(ledger("meta.spend_cap.write", "applied")[0].reasonCodes).toContain("resets_on_write");
  });

  it("reads use no change budget: repeated reads with the cap in range make no POST and no requested row", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(verified);
    meta.account().spendCapMinor = INR(70_000);
    for (let i = 0; i < 5; i++) {
      at(new Date(NOW.getTime() + i * 15 * 60_000));
      await syncMetaCap(T, "acc1", io());
    }
    expect(meta.calls.filter((c) => c.method === "GET").length).toBe(5);
    expect(posts()).toHaveLength(0);
    expect(ledger("meta.spend_cap.write")).toHaveLength(0);
  });

  it("a routine write is deferred once 6 writes were requested in 24 h, with the card's 'later today' state", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged({ ...verified, managedCapMinor: INR(60_000), lastReadCapMinor: INR(60_000), lastWriteAt: new Date("2026-09-20"), monthKey: "2026-10" });
    meta.account().spendCapMinor = INR(60_000);
    seedWrites(6, false, 5 * 3_600_000);
    // A rollover-class write (the last write was last month): routine, so it waits for the budget.
    const r = await syncMetaCap(T, "acc1", io());
    expect(r).toMatchObject({ status: "deferred", reason: "budget" });
    expect(capPosts()).toHaveLength(0);
    expect(limitRow().deferredUntil).toBeInstanceOf(Date);
    expect(h.jobs.some(([q]) => q === "spend.metacap.replan")).toBe(true);
    const dto = await getMetaLimitDTO(T, "owner", io());
    expect(dto).toMatchObject({ state: "deferred", text: "Meta's limit will update later today. Your Edwyz limits still apply now." });
  });

  it("P0 stop still goes out with 9 writes used: A + 1 major unit, emergency class", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(verified);
    meta.account().spendCapMinor = INR(70_000);
    seedWrites(9);
    const r = await p0Stop(T, "acc1", "kill", io());
    expect(r.status).toBe("written");
    expect(capPosts()[0].params.spend_cap).toBe("50001.00");
    expect(meta.account().spendCapMinor).toBe(INR(50_001));
    expect(ledger("meta.spend_cap.write", "requested").find((x) => x.correlationId !== "old0" && String(x.id).startsWith("sl"))?.reasonCodes).toEqual(expect.arrayContaining(["P0_stop", "emergency"]));
    // At 10 the emergency budget is used up too.
    seedWrites(1, false, 2 * 3_600_000);
    meta.calls.length = 0;
    const blocked = await p0Stop(T, "acc1", "kill", io());
    expect(blocked).toMatchObject({ status: "deferred", reason: "budget" });
    expect(capPosts()).toHaveLength(0);
  });

  it("unit mismatch /100 (Meta reads minor units): mode error, meta_cap_units, platform admins told, ONE corrective write in minor units", async () => {
    meta.setWriteUnit("minor");
    meta.setFloorRule("none");
    seedWorkspace();
    seedMtd(10_000);
    seedManaged({ unitMode: "unverified", ...due });
    await syncMetaCap(T, "acc1", io());
    expect(capPosts().map((c) => c.params.spend_cap)).toEqual(["70000.00", "7000000"]);
    expect(meta.account().spendCapMinor).toBe(INR(70_000));
    expect(limitRow()).toMatchObject({ mode: "error", unitMode: "minor_write", lastError: "unit_mismatch:div100" });
    expect(rows("spendBreaker").find((b) => b.kind === "meta_cap_units")).toMatchObject({ state: "tripped", scopeType: "ad_account", scopeId: "acc1", effect: "block_raises" });
    expect(notices.some((n) => n.audience === "platform_admins" && n.dedupeKey === "metacap:units:acc1")).toBe(true);
    // Mode error: no further writes.
    meta.calls.length = 0;
    await syncMetaCap(T, "acc1", io());
    expect(capPosts()).toHaveLength(0);
  });

  it("unit mismatch x100: detected, and the corrective write sends a hundredth", async () => {
    meta.setFloorRule("none");
    h.fetchImpl = async (input, init) => {
      const res = await meta.fetch(input, init);
      if (res.ok && (init?.method ?? "GET") === "POST" && String(init?.body ?? "").includes("spend_cap")) meta.account().spendCapMinor *= 100n;
      return res;
    };
    seedWorkspace();
    seedMtd(10_000);
    seedManaged({ unitMode: "unverified", ...due });
    await syncMetaCap(T, "acc1", io());
    expect(capPosts().map((c) => c.params.spend_cap)).toEqual(["70000.00", "700.00"]);
    expect(meta.account().spendCapMinor).toBe(INR(70_000));
    expect(limitRow()).toMatchObject({ mode: "error", lastError: "unit_mismatch:x100" });
    expect(rows("spendBreaker").some((b) => b.kind === "meta_cap_units")).toBe(true);
  });

  it("the read-back analysis and the value strings follow 5.5 (i)-(iv) and the currency exponent", () => {
    const before = { amountSpentMinor: INR(50_000) };
    expect(analyseReadBack({ expectedMinor: INR(70_000), isDelete: false, before, after: { capMinor: INR(70_000) + 1n, amountSpentMinor: INR(50_000) }, currency: "INR" })).toEqual({ match: "exact", resetDetected: false });
    expect(analyseReadBack({ expectedMinor: INR(70_000), isDelete: false, before, after: { capMinor: INR(7_000_000), amountSpentMinor: INR(50_000) }, currency: "INR" }).match).toBe("x100");
    expect(analyseReadBack({ expectedMinor: INR(70_000), isDelete: false, before, after: { capMinor: INR(700), amountSpentMinor: INR(50_000) }, currency: "INR" }).match).toBe("div100");
    expect(analyseReadBack({ expectedMinor: INR(70_000), isDelete: false, before, after: { capMinor: INR(70_000), amountSpentMinor: 0n }, currency: "INR" }).resetDetected).toBe(true);
    expect(capValueString(INR(20_000), "INR")).toBe("20000.00");
    expect(capValueString(20_000n, "JPY")).toBe("20000");
    expect(capValueString(20_000n, "KWD")).toBe("20.000");
    expect(parseCounter("7000000")).toBe(7_000_000n);
    expect(() => parseCounter("abc")).toThrow();
  });

  it("the floor error ('must be at least ₹X') writes X when X ≤ T + 10% of M and records the looseness", async () => {
    expect(parseFloorMinor("The spending limit must be at least ₹1,234.56.", "INR")).toBe(123_456n);
    expect(parseFloorMinor("Must be at least INR 2,000", "INR")).toBe(200_000n);
    expect(parseFloorMinor("Invalid parameter", "INR")).toBeNull();
    meta.setFloorRule("spent_1_1x");
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(verified);
    meta.account().spendCapMinor = INR(70_000);
    // P0 stop at A + ₹1 = ₹50,001; Meta wants at least 1.1 x ₹50,000 = ₹55,000 ≤ ₹50,001 + ₹3,000? No: then it is kept loose.
    const kept = await p0Stop(T, "acc1", "kill", io());
    expect(kept.status).toBe("failed");
    expect(limitRow().loosenessMinor).toBe(INR(70_000) - INR(50_001));
    expect(meta.account().spendCapMinor).toBe(INR(70_000));
    expect((await getMetaLimitDTO(T, "owner", io()))!.state).toBe("loose");
    // With a larger monthly limit (10% = ₹10,000) the floor is accepted and written.
    rows("spendAllowance")[0].monthlyLimitMinor = INR(100_000);
    meta.calls.length = 0;
    const written = await p0Stop(T, "acc1", "kill", io());
    expect(written.status).toBe("written");
    expect(capPosts().map((c) => c.params.spend_cap)).toEqual(["50001.00", "55000.00"]);
    expect(meta.account().spendCapMinor).toBe(INR(55_000));
    expect(limitRow().loosenessMinor).toBe(INR(55_000) - INR(50_001));
    expect(ledger("meta.spend_cap.write", "failed").some((r) => (r.reasonCodes as string[]).includes("floor"))).toBe(true);
  });

  it("17/1885172 sets writesBlockedUntil to the account's next midnight and opens meta_cap_stale_high for a blocked lowering", async () => {
    meta = createFakeMeta({ now: NOW, accountId: "act_111", amountSpentMinor: INR(50_000), capChangesPerDay: 0 });
    h.fetchImpl = meta.fetch;
    seedWorkspace();
    seedMtd(10_000);
    seedManaged({ ...verified, lastReadCapMinor: INR(90_000), managedCapMinor: INR(90_000), ...due });
    meta.account().spendCapMinor = INR(90_000);
    const r = await syncMetaCap(T, "acc1", io());
    expect(r.status).toBe("failed");
    expect(limitRow().writesBlockedUntil).toEqual(new Date("2026-10-28T18:30:00Z"));
    expect(rows("spendBreaker").find((b) => b.kind === "meta_cap_stale_high")).toMatchObject({ state: "tripped", effect: "block_raises", scopeId: "acc1" });
    expect(notices.some((n) => n.audience === "owner" && n.title.includes("after midnight"))).toBe(true);
    expect(ledger("meta.spend_cap.write", "failed")[0].reasonCodes).toContain("meta_17_1885172");
    // No retry before midnight.
    meta.calls.length = 0;
    await syncMetaCap(T, "acc1", io());
    expect(capPosts()).toHaveLength(0);
  });

  it("a permission error gives no_permission with the in-app 'Connect again with an admin account' action", async () => {
    meta.setPermissionError(200, "cap");
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(due);
    await syncMetaCap(T, "acc1", io());
    expect(limitRow()).toMatchObject({ mode: "no_permission", lastError: NO_PERMISSION_COPY });
    const dto = await getMetaLimitDTO(T, "owner", io());
    expect(dto).toMatchObject({ state: "no_permission", text: NO_PERMISSION_COPY, action: { kind: "connect_again", label: CONNECT_AGAIN_LABEL } });
    expect(dto!.text).not.toMatch(/Ads Manager/);
    expect(classifyCapError(Object.assign(new (await import("@/lib/graph")).GraphError("x", 400, 294)), "INR").kind).toBe("permission");
  });

  it("prepaid accounts are unavailable_prepaid, currency mismatches stop writes, account_status ≠ 1 skips writes", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(due);
    meta.setPrepaid(true);
    await syncMetaCap(T, "acc1", io());
    expect(limitRow().mode).toBe("unavailable_prepaid");
    expect(capPosts()).toHaveLength(0);
    expect((await getMetaLimitDTO(T, "owner", io()))!.text).toBe("Not available: this ad account uses prepaid funds. Your Edwyz limits still apply.");

    h.db.reset();
    meta = createFakeMeta({ now: NOW, accountId: "act_111", currency: "USD", amountSpentMinor: 5_000n });
    h.fetchImpl = meta.fetch;
    seedWorkspace({ currency: "USD" });
    seedManaged({ currency: null, ...due });
    await syncMetaCap(T, "acc1", io());
    expect(limitRow().mode).toBe("currency_mismatch");
    expect(capPosts()).toHaveLength(0);

    h.db.reset();
    meta = createFakeMeta({ now: NOW, accountId: "act_111", amountSpentMinor: INR(50_000) });
    h.fetchImpl = meta.fetch;
    meta.account().accountStatus = 2;
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(due);
    const r = await syncMetaCap(T, "acc1", io());
    expect(r).toMatchObject({ status: "planned", reason: "account_status" });
    expect(capPosts()).toHaveLength(0);
  });

  it("an ambiguous write (5xx) is never retried blindly: read back, unconfirmed, re-checked after 60 s, then settled", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(due);
    meta.failNext({ method: "POST", kind: "status", status: 500, apply: false });
    const r = await syncMetaCap(T, "acc1", io());
    expect(r.write?.outcome).toBe("unconfirmed");
    expect(capPosts()).toHaveLength(1);
    expect(ledger("meta.spend_cap.write", "unconfirmed")).toHaveLength(1);
    const recheck = h.jobs.find(([q, p]) => q === "spend.metacap.replan" && (p as { reason?: string }).reason === "ambiguous_write_recheck");
    expect((recheck?.[2] as { runAt: Date }).runAt).toEqual(new Date(NOW.getTime() + 60_000));
    // Within the 60 s nothing else is written.
    await syncMetaCap(T, "acc1", io());
    expect(capPosts()).toHaveLength(1);
    // After 60 s: settled as not applied, then planned afresh.
    at(new Date(NOW.getTime() + 61_000));
    await syncMetaCap(T, "acc1", io());
    expect(ledger("meta.spend_cap.write", "reconciled")[0].reasonCodes).toContain("not_applied");
  });

  it("an ambiguous write that Meta did apply is settled at once from the read-back", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(due);
    meta.failNext({ method: "POST", kind: "status", status: 502, apply: true });
    const r = await syncMetaCap(T, "acc1", io());
    expect(r.write?.outcome).toBe("applied");
    expect(capPosts()).toHaveLength(1);
    expect(meta.account().spendCapMinor).toBe(INR(70_000));
  });

  it("observe mode (12.1a decision 5) writes an info row with what it would set and never POSTs", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(due);
    const r = await syncMetaCap(T, "acc1", io({ env: OBSERVE }));
    expect(r.status).toBe("observed");
    expect(posts()).toHaveLength(0);
    expect(ledger("meta.spend_cap.observe", "info")[0]).toMatchObject({ observe: true, after: { cap: "7000000" } });
    expect((await getMetaLimitDTO(T, "owner", io({ env: OBSERVE })))!.text).toBe("Ready. Meta's limit will be switched on after our final check.");
    // SPEND_CAP_MODE=off does nothing at all, not even a read.
    meta.calls.length = 0;
    expect(await syncMetaCap(T, "acc1", io({ env: { SPEND_CAP_MODE: "off" } }))).toMatchObject({ status: "skipped" });
    expect(meta.calls).toHaveLength(0);
  });

  it("a sandbox account is mode sandbox, never read or written, with one info row", async () => {
    seedWorkspace({ sandbox: true });
    seedManaged(due);
    await syncMetaCap(T, "acc1", io());
    await syncMetaCap(T, "acc1", io());
    expect(meta.calls).toHaveLength(0);
    expect(limitRow().mode).toBe("sandbox");
    expect(ledger("meta.spend_cap.observe", "info").filter((r) => (r.reasonCodes as string[]).includes("sandbox"))).toHaveLength(1);
  });

  it("a 409 from getAssetAccess opens meta_cap_unreachable while commitments are live, and retries every 30 minutes", async () => {
    seedWorkspace();
    seedManaged(verified);
    h.db.seed("spendCommitment", [{ id: "cm1", tenantId: T, adAccountAssetId: "acc1", campaignId: "c1", metaObjectId: "m_s", objectLevel: "adset", origin: "human", currency: "INR", timezone: "Asia/Kolkata", dailyBudgetMinor: INR(1_000), status: "live" }]);
    const fail = async () => {
      const { HttpError } = await import("@/lib/tenancy");
      throw new HttpError(409, "expired");
    };
    const r = await syncMetaCap(T, "acc1", io({ access: fail }));
    expect(r.status).toBe("unreachable");
    expect(rows("spendBreaker").find((b) => b.kind === "meta_cap_unreachable")).toMatchObject({ state: "tripped", effect: "block_raises" });
    expect(notices.some((n) => n.title === "Connect Meta again")).toBe(true);
    const state = (rows("platformSetting").find((s) => s.key === "spend:metacap:t1:acc1")!.value ?? {}) as Record<string, string>;
    const row = toMetaCapRow(limitRow());
    expect(readDue(row, true, state, new Date(NOW.getTime() + 10 * 60_000), "2026-10")).toBe(false);
    expect(readDue(row, true, state, new Date(NOW.getTime() + 31 * 60_000), "2026-10")).toBe(true);
    // Reachable again: the breaker clears on the next good read.
    meta.account().spendCapMinor = INR(70_000);
    await syncMetaCap(T, "acc1", io());
    expect(rows("spendBreaker").find((b) => b.kind === "meta_cap_unreachable")!.state).toBe("cleared");
  });

  it("the read cadence: 15 minutes with activity, 6 hours without; a due deferred write and a new month are due at once", () => {
    const row = toMetaCapRow({ adAccountAssetId: "acc1", tenantId: T, mode: "managed", lastReadAt: new Date(NOW.getTime() - 16 * 60_000), monthKey: "2026-10" });
    expect(readDue(row, true, {}, NOW, "2026-10")).toBe(true);
    expect(readDue(row, false, {}, NOW, "2026-10")).toBe(false);
    expect(readDue({ ...row, lastReadAt: new Date(NOW.getTime() - 7 * 3_600_000) }, false, {}, NOW, "2026-10")).toBe(true);
    expect(readDue(row, false, {}, NOW, "2026-11")).toBe(true);
    expect(readDue({ ...row, lastReadAt: NOW, pendingTargetMinor: 1n, deferredUntil: new Date(NOW.getTime() - 1) }, false, {}, NOW, "2026-10")).toBe(true);
  });

  it("a lower amount_spent without an Edwyz write is used only when two reads agree (read_drift)", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(verified);
    meta.account().spendCapMinor = INR(70_000);
    meta.account().amountSpentMinor = INR(49_000);
    await syncMetaCap(T, "acc1", io());
    expect(limitRow().lastReadAmountSpentMinor).toBe(INR(50_000));
    expect(ledger("meta.spend_cap.read_drift", "info")).toHaveLength(1);
    await syncMetaCap(T, "acc1", io());
    expect(limitRow().lastReadAmountSpentMinor).toBe(INR(49_000));
    expect(ledger("meta.spend_cap.read_drift", "info")).toHaveLength(2);
  });
});

// =====================================================================================================================
describe("changes made outside Edwyz (5.6)", () => {
  it("adopts a lower cap, never raises it back, and tells the owner", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(verified);
    meta.account().spendCapMinor = INR(60_000);
    await syncMetaCap(T, "acc1", io());
    expect(capPosts()).toHaveLength(0);
    expect(limitRow()).toMatchObject({ managedCapMinor: INR(60_000), customerCapAtConsentMinor: INR(60_000) });
    expect(notices.find((n) => n.dedupeKey.startsWith("metacap:lower"))!.body).toBe("We noticed a lower Meta spending limit on Shop ads. We'll keep it.");
    expect(ledger("meta.spend_cap.external_change", "reconciled")[0]).toMatchObject({ actorType: "external" });
    // Later reads keep it (no raise back to ₹70,000).
    at(new Date(NOW.getTime() + 30 * 60_000));
    await syncMetaCap(T, "acc1", io());
    at(new Date(NOW.getTime() + 60 * 60_000));
    await syncMetaCap(T, "acc1", io());
    expect(capPosts()).toHaveLength(0);
    expect(meta.account().spendCapMinor).toBe(INR(60_000));
  });

  it("'Use my Edwyz limit' is the owner's raise: the customer cap is cleared and the plan raises back", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged({ ...verified, managedCapMinor: INR(60_000), lastReadCapMinor: INR(60_000), customerCapAtConsentMinor: INR(60_000) });
    meta.account().spendCapMinor = INR(60_000);
    await expect(useMyEdwyzLimit(T, admin, io())).rejects.toMatchObject({ status: 403 });
    const out = await useMyEdwyzLimit(T, owner, io());
    expect(limitRow().customerCapAtConsentMinor).toBeNull();
    expect(out[0]).toMatchObject({ status: "deferred", reason: "debounce" });
    expect(limitRow().pendingTargetMinor).toBe(INR(70_000));
  });

  it("restores a cap raised outside Edwyz (P0 restore, emergency) and tells the owner", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(verified);
    meta.account().spendCapMinor = INR(90_000);
    await syncMetaCap(T, "acc1", io());
    expect(capPosts()).toHaveLength(1);
    expect(meta.account().spendCapMinor).toBe(INR(70_000));
    expect(ledger("meta.spend_cap.write", "requested")[0].reasonCodes).toEqual(expect.arrayContaining(["P0_restore", "emergency"]));
    expect(notices.find((n) => n.dedupeKey.startsWith("metacap:raised"))!.body).toBe("Meta's spending limit on Shop ads was raised outside Edwyz, so we set it back to match your monthly ads limit.");
  });

  it("restores a removed cap (C = 0)", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(verified);
    meta.account().spendCapMinor = 0n;
    await syncMetaCap(T, "acc1", io());
    expect(meta.account().spendCapMinor).toBe(INR(70_000));
  });

  it("near the wall the owner is told once a day: 'Meta will stop all ads on <account> after ₹X more this month.'", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged({ ...verified, managedCapMinor: INR(52_000), lastReadCapMinor: INR(52_000), customerCapAtConsentMinor: INR(52_000) });
    meta.account().spendCapMinor = INR(52_000);
    await syncMetaCap(T, "acc1", io());
    await syncMetaCap(T, "acc1", io());
    const near = notices.filter((n) => n.dedupeKey.startsWith("metacap:nearwall"));
    expect(near[0].body).toBe("Meta will stop all ads on Shop ads after ₹2,000 more this month.");
    expect(new Set(near.map((n) => n.dedupeKey)).size).toBe(1);
  });
});

// =====================================================================================================================
describe("rollover (P2) and locked workspaces (4.17)", () => {
  // Sunday 1 Nov 2026, 00:30 in Asia/Kolkata.
  const NOV1 = new Date("2026-10-31T19:00:00Z");

  function seedLastMonth() {
    seedWorkspace();
    seedManaged({ ...verified, monthKey: "2026-10", managedCapMinor: INR(60_000), lastReadCapMinor: INR(60_000), lastWriteAt: new Date("2026-10-20T06:00:00Z"), lastReadAt: new Date("2026-10-31T18:00:00Z") });
    meta.account().spendCapMinor = INR(60_000);
    h.db.seed("spendDaily", [{ tenantId: T, pot: "ads", scopeType: "account", scopeId: "acc1", day: new Date("2026-11-01T00:00:00Z"), currency: "INR", amountMinor: 0n, origin: "all", source: "fast_sync", syncedAt: NOV1 }]);
  }

  it("the first read of a new account month sets the month's start values and uses exactly one write: A + M", async () => {
    seedLastMonth();
    at(NOV1);
    const r = await syncMetaCap(T, "acc1", io());
    expect(r).toMatchObject({ status: "written" });
    expect(r.decision).toMatchObject({ priority: "P2_rollover", writeClass: "routine" });
    expect(capPosts()).toHaveLength(1);
    expect(meta.account().spendCapMinor).toBe(INR(80_000));
    expect(limitRow()).toMatchObject({ monthKey: "2026-11", monthStartAmountSpentMinor: INR(50_000) });
    // The next reads change nothing.
    at(new Date(NOV1.getTime() + 15 * 60_000));
    await syncMetaCap(T, "acc1", io());
    expect(capPosts()).toHaveLength(1);
  });

  it("a locked or suspended workspace keeps last month's level: P2 is deferred, never a raise, and the card says so", async () => {
    seedLastMonth();
    at(NOV1);
    h.active = false;
    const r = await syncMetaCap(T, "acc1", io());
    expect(r).toMatchObject({ status: "deferred", reason: "paused" });
    expect(capPosts()).toHaveLength(0);
    expect((await getMetaLimitDTO(T, "owner", io()))!.text).toBe("Meta's limit is kept at last month's level while your workspace is paused.");
    // Back to active: the deferred P2 goes out.
    h.active = true;
    await syncMetaCap(T, "acc1", io());
    expect(capPosts()).toHaveLength(1);
  });

  it("while spending is stopped (freeze all) a P0 stop is never raised back; it is once spending is back on", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(verified);
    meta.account().spendCapMinor = INR(70_000);
    rows("spendControl")[0].freeze = "all";
    await p0Stop(T, "acc1", "kill", io());
    expect(meta.account().spendCapMinor).toBe(INR(50_001));
    for (const min of [15, 30, 60]) {
      at(new Date(NOW.getTime() + min * 60_000));
      await syncMetaCap(T, "acc1", io());
    }
    expect(capPosts()).toHaveLength(1);
    expect(meta.account().spendCapMinor).toBe(INR(50_001));
    rows("spendControl")[0].freeze = "none";
    resetSpendStateCache();
    at(new Date(NOW.getTime() + 75 * 60_000));
    await syncMetaCap(T, "acc1", io());
    at(new Date(NOW.getTime() + 90 * 60_000));
    await syncMetaCap(T, "acc1", io());
    expect(capPosts()).toHaveLength(2);
    expect(meta.account().spendCapMinor).toBe(INR(70_000));
  });

  it("the immediate resets_on_write rewrite still respects Meta's change budget", async () => {
    meta.setSemantics("resets_on_write");
    seedWorkspace();
    seedMtd(10_000);
    seedManaged({ semantics: "unverified", unitMode: "unverified", ...due });
    seedWrites(9);
    const r = await syncMetaCap(T, "acc1", io());
    expect(r).toMatchObject({ status: "deferred", reason: "budget" });
    expect(capPosts()).toHaveLength(1);
    expect(limitRow().pendingTargetMinor).toBe(INR(20_000));
  });

  it("meta_cap_stale_high clears once Meta's limit is back within the plan", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(verified);
    meta.account().spendCapMinor = INR(70_000);
    h.db.seed("spendBreaker", [{ id: "sb_x", tenantId: T, kind: "meta_cap_stale_high", scopeType: "ad_account", scopeId: "acc1", state: "tripped", effect: "block_raises", reason: "x", trippedAt: NOW }]);
    await syncMetaCap(T, "acc1", io());
    expect(rows("spendBreaker")[0].state).toBe("cleared");
  });

  it("a paused workspace still gets a P0 stop and lowering", async () => {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged(verified);
    meta.account().spendCapMinor = INR(70_000);
    h.active = false;
    expect((await p0Stop(T, "acc1", "kill", io())).status).toBe("written");
    expect(meta.account().spendCapMinor).toBe(INR(50_001));
  });
});

// =====================================================================================================================
describe("consent (5.1): owner only, append-only with the text hash, one manager per real ad account", () => {
  it("the consent text is the exact 5.1 copy and its SHA-256 is stored with the consent", async () => {
    expect(META_CAP_TEXT_VERSION).toBe("meta-cap-v1");
    expect(META_CAP_CONSENT.title).toBe("Let Edwyz manage the spending limit on this ad account");
    expect(META_CAP_CONSENT.checkbox).toBe("I'm the owner of this workspace and I agree.");
    expect(META_CAP_CONSENT.button).toBe("Turn on Meta's limit");
    const text = [META_CAP_CONSENT.title, ...META_CAP_CONSENT.body, META_CAP_CONSENT.checkbox].join("\n");
    expect(metaCapConsentText()).toBe(text);
    expect(metaCapConsentSha256()).toBe(createHash("sha256").update(text).digest("hex"));
    seedWorkspace();
    seedMtd(10_000);
    await turnOnMetaLimit(T, owner, { agreed: true, textVersion: "meta-cap-v1" }, io());
    expect(rows("spendConsent")[0]).toMatchObject({ tenantId: T, userId: "u_owner", kind: "meta_spend_cap", subjectId: "acc1", granted: true, textVersion: "meta-cap-v1", textSha256: metaCapConsentSha256() });
    // Append-only: no update or delete.
    await expect(h.db.model("spendConsent").update({ where: { id: rows("spendConsent")[0].id }, data: { granted: false } })).rejects.toMatchObject({ sqlState: "42501" });
    await expect(h.db.model("spendConsent").deleteMany({ where: { tenantId: T } })).rejects.toMatchObject({ sqlState: "42501" });
    // Turning it off adds a row; it never edits the first.
    await turnOffMetaLimit(T, owner, "keep", io());
    expect(rows("spendConsent").map((r) => r.granted)).toEqual([true, false]);
  });

  it("an admin gets 403, the row becomes pending_owner (not holding the slot) and the owner gets a task", async () => {
    seedWorkspace();
    await expect(turnOnMetaLimit(T, admin, { agreed: true, textVersion: "meta-cap-v1" }, io())).rejects.toMatchObject({ status: 403, message: ADMIN_PENDING_COPY });
    expect(limitRow()).toMatchObject({ mode: "pending_owner", accountExternalId: "act_111" });
    expect(rows("spendConsent")).toHaveLength(0);
    expect(notices.find((n) => n.dedupeKey === "metacap:pending_owner:acc1")).toMatchObject({ audience: "owner", severity: "action_needed", link: "/app/settings/spending" });
    expect((await getMetaLimitDTO(T, "admin", io()))!.text).toBe("Waiting for the owner to turn this on.");
    // A pending_owner row of another workspace never blocks a real owner's consent (12.1c R3).
    seedWorkspace({ tenantId: "t2", assetId: "acc9", external: "act_111" });
    await turnOnMetaLimit("t2", owner, { agreed: true, textVersion: "meta-cap-v1" }, io());
    expect(limitRow("acc9").mode).toBe("managed");
  });

  it("the owner needs the ticked box and the current text version", async () => {
    seedWorkspace();
    await expect(turnOnMetaLimit(T, owner, { agreed: false, textVersion: "meta-cap-v1" }, io())).rejects.toMatchObject({ status: 400 });
    await expect(turnOnMetaLimit(T, owner, { agreed: true, textVersion: "meta-cap-v0" }, io())).rejects.toMatchObject({ status: 400 });
    expect(rows("spendConsent")).toHaveLength(0);
  });

  it("only the spending ad account is offered", async () => {
    seedWorkspace();
    await expect(turnOnMetaLimit(T, owner, { adAccountAssetId: "acc2", agreed: true, textVersion: "meta-cap-v1" }, io())).rejects.toMatchObject({ status: 409 });
    rows("spendControl")[0].spendingAdAccountAssetId = null;
    await expect(turnOnMetaLimit(T, owner, { agreed: true, textVersion: "meta-cap-v1" }, io())).rejects.toMatchObject({ status: 409 });
  });

  it("mid-month consent stores A - month-to-date as the month's start, the customer's own cap, and queues the first plan", async () => {
    seedWorkspace();
    seedMtd(10_000);
    meta.account().spendCapMinor = INR(65_000);
    const dto = await turnOnMetaLimit(T, owner, { agreed: true, textVersion: "meta-cap-v1" }, io());
    expect(limitRow()).toMatchObject({ mode: "managed", monthKey: "2026-10", monthStartAmountSpentMinor: INR(40_000), customerCapAtConsentMinor: INR(65_000), customerAmountSpentAtConsentMinor: INR(50_000), lastReadCapMinor: INR(65_000) });
    expect(h.jobs.some(([q, p]) => q === "spend.metacap.replan" && (p as { reason: string }).reason === "consent")).toBe(true);
    expect(dto.previousCap?.formatted).toBe("₹65,000");
    expect(ledger("consent.meta_cap", "info")[0].snapshot).toMatchObject({ textSha256: metaCapConsentSha256() });
  });

  it("without the fast sync's month-to-date the start value waits for it, and the first write waits too", async () => {
    seedWorkspace();
    await turnOnMetaLimit(T, owner, { agreed: true, textVersion: "meta-cap-v1" }, io());
    expect(limitRow().monthStartAmountSpentMinor).toBeNull();
    Object.assign(limitRow(), due);
    expect(await syncMetaCap(T, "acc1", io())).toMatchObject({ status: "planned", reason: "waiting_for_sync" });
    expect(capPosts()).toHaveLength(0);
    seedMtd(10_000);
    await syncMetaCap(T, "acc1", io());
    expect(limitRow().monthStartAmountSpentMinor).toBe(INR(40_000));
  });

  it("a second workspace on the same accountExternalId gets other_workspace", async () => {
    seedWorkspace();
    seedWorkspace({ tenantId: "t2", assetId: "acc9", external: "act_111" });
    await turnOnMetaLimit("t2", owner, { agreed: true, textVersion: "meta-cap-v1" }, io());
    expect(limitRow("acc9").mode).toBe("managed");
    const dto = await turnOnMetaLimit(T, owner, { agreed: true, textVersion: "meta-cap-v1" }, io());
    expect(limitRow().mode).toBe("other_workspace");
    expect(dto.text).toBe(OTHER_WORKSPACE_COPY);
    expect(h.jobs.filter(([q, p]) => q === "spend.metacap.replan" && (p as { tenantId: string }).tenantId === T)).toHaveLength(0);
  });

  it("a demo workspace can't turn it on, and its card says Meta's limit isn't used", async () => {
    seedWorkspace({ demo: true });
    await expect(turnOnMetaLimit(T, owner, { agreed: true, textVersion: "meta-cap-v1" }, io())).rejects.toMatchObject({ code: "spend.demo" });
    expect(await getMetaLimitDTO(T, "owner", io())).toMatchObject({ state: "demo", text: "Demo account: Meta's limit isn't used.", canTurnOn: false });
  });

  it("an admin who connects leaves Meta's limit waiting for the owner", async () => {
    seedWorkspace();
    await notePendingOwnerAfterConnect({ userId: "u_admin", tenantId: T, role: "admin" }, io());
    expect(limitRow().mode).toBe("pending_owner");
    await notePendingOwnerAfterConnect({ userId: "u_owner", tenantId: T, role: "owner" }, io());
    expect(rows("metaSpendLimit")).toHaveLength(1);
  });

  it("the card's states and copy (8.1)", async () => {
    seedWorkspace();
    expect(await getMetaLimitDTO(T, "owner", io())).toMatchObject({ state: "off", text: "Off. Turn on Meta's limit for extra safety.", canTurnOn: true, action: { kind: "turn_on", label: "Turn on Meta's limit" } });
    expect(await getMetaLimitDTO(T, "admin", io())).toMatchObject({ state: "off", canTurnOn: false, action: null });
    seedMtd(10_000);
    seedManaged(verified);
    const managed = await getMetaLimitDTO(T, "owner", io());
    expect(managed).toMatchObject({ state: "managed", managed: true, text: "Managed by Edwyz. Meta will stop this account after ₹20,000 more this month.", canTurnOff: true, offboardChoices: ["keep", "remove"] });
    rows("spendAllowance")[0].monthlyLimitMinor = null;
    expect(await getMetaLimitDTO(T, "owner", io())).toMatchObject({ state: "needs_monthly_limit", text: "Set a monthly ads limit first.", action: { kind: "set_monthly_limit" } });
  });
});

// =====================================================================================================================
describe("turning it off and offboarding (5.8): keep, put back, remove; on close, suspend, account change", () => {
  function managedWithOldCap() {
    seedWorkspace();
    seedMtd(10_000);
    seedManaged({ ...verified, customerCapAtConsentMinor: INR(100_000) });
    meta.account().spendCapMinor = INR(70_000);
  }

  it("turn off with keep makes no write and frees the account; only the owner can", async () => {
    managedWithOldCap();
    await expect(turnOffMetaLimit(T, admin, "keep", io())).rejects.toMatchObject({ status: 403 });
    const out = await turnOffMetaLimit(T, owner, "keep", io());
    expect(out.result).toMatchObject({ applied: "kept", text: "Kept the current limit on Meta (₹70,000)." });
    expect(capPosts()).toHaveLength(0);
    expect(limitRow().mode).toBe("withdrawn");
    expect(ledger("meta.spend_cap.offboard", "info")[0].reasonCodes).toEqual(["turn_off", "keep"]);
  });

  it("put back my old limit writes the cap from before consent; remove sends spend_cap_action=delete", async () => {
    managedWithOldCap();
    const restored = await offboardAccount(T, "acc1", "restore", "turn_off", { type: "user", ...owner }, io());
    expect(restored).toMatchObject({ applied: "restored" });
    expect(capPosts()[0].params.spend_cap).toBe("100000.00");
    expect(meta.account().spendCapMinor).toBe(INR(100_000));
    h.db.reset();
    meta.calls.length = 0;
    managedWithOldCap();
    const removed = await offboardAccount(T, "acc1", "remove", "turn_off", { type: "user", ...owner }, io());
    expect(removed.applied).toBe("removed");
    expect(capPosts()[0].params).toEqual({ spend_cap_action: "delete" });
    expect(meta.account().spendCapMinor).toBe(0n);
    expect(limitRow().mode).toBe("withdrawn");
  });

  it("the choice is emergency class when the routine budget is used up", async () => {
    managedWithOldCap();
    seedWrites(6);
    await offboardAccount(T, "acc1", "remove", "turn_off", { type: "user", ...owner }, io());
    expect(ledger("meta.spend_cap.write", "requested").find((r) => (r.reasonCodes as string[]).includes("offboard"))!.reasonCodes).toContain("emergency");
  });

  it("closing the workspace applies the stored choice (default keep) on erasure, before the Meta revoke", async () => {
    managedWithOldCap();
    await saveOffboardChoices(T, { acc1: "remove", nope: "keep" }, { type: "user", ...owner }, "close", io());
    expect(await offboardChoicesFor(T, io())).toEqual([expect.objectContaining({ adAccountAssetId: "acc1", selected: "remove", choices: [expect.objectContaining({ choice: "keep", label: "Keep the current limit on Meta" }), expect.objectContaining({ choice: "restore", label: "Put back my old limit (₹1,00,000)" }), expect.objectContaining({ choice: "remove", label: "Remove the limit" })] })]);
    const results = await offboardTenant(T, "erase", io());
    expect(results).toEqual([expect.objectContaining({ applied: "removed", trigger: "erase" })]);
    expect(meta.account().spendCapMinor).toBe(0n);
    await expect(saveOffboardChoices(T, { acc1: "burn" }, { type: "user", ...owner }, "close", io())).rejects.toMatchObject({ status: 400 });
  });

  it("a suspend with keep keeps managing (lowering only), with restore it puts the old limit back and stops", async () => {
    managedWithOldCap();
    const kept = await offboardAccount(T, "acc1", "keep", "suspend", { type: "platform_admin", userId: "pa1" }, io());
    expect(kept.applied).toBe("kept");
    expect(limitRow().mode).toBe("managed");
    const restored = await offboardAccount(T, "acc1", "restore", "suspend", { type: "platform_admin", userId: "pa1" }, io());
    expect(restored.applied).toBe("restored");
    expect(limitRow().mode).toBe("withdrawn");
  });

  it("changing the spending ad account applies the choice to the old account; the new one needs its own consent", async () => {
    managedWithOldCap();
    const out = await onSpendingAccountChange(T, "acc1", "acc2", "restore", { type: "user", ...owner }, io());
    expect(out).toMatchObject({ applied: "restored", trigger: "account_change" });
    expect(limitRow().mode).toBe("withdrawn");
    expect(await onSpendingAccountChange(T, "acc1", "acc1", "keep", { type: "user", ...owner }, io())).toBeNull();
  });

  it("when the token is gone, the owner is told in Edwyz that Meta's limit stays", async () => {
    managedWithOldCap();
    const fail = async () => {
      const { HttpError } = await import("@/lib/tenancy");
      throw new HttpError(409, "expired");
    };
    const out = await offboardAccount(T, "acc1", "remove", "disconnect", { type: "user", ...owner }, io({ access: fail }));
    expect(out).toMatchObject({ applied: "not_applied", text: "Meta's spending limit on Shop ads stays at ₹70,000. You can change it in Meta Ads Manager if you need to." });
    expect(notices.some((n) => n.title === "Meta's spending limit stays")).toBe(true);
    expect(limitRow().mode).toBe("withdrawn");
  });

  it("the close request stores the owner's choices (default keep) and the close dialog shows the three choices", async () => {
    managedWithOldCap();
    const { requestWorkspaceDeletion } = await import("@/lib/lifecycle/export-deletion");
    const errors = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const req = await requestWorkspaceDeletion({ userId: "u_owner", tenantId: T, role: "owner" }, "Shop", NOW, { acc1: "restore" });
    errors.mockRestore();
    expect(req.metaLimit).toEqual({ acc1: "restore" });
    expect(ledger("meta.spend_cap.offboard_choice", "info")[0].reasonCodes).toEqual(["close", "restore"]);
    // Nothing is written to Meta at request time; erasure applies it before the revoke.
    expect(capPosts()).toHaveLength(0);
    await offboardTenant(T, "erase", io());
    expect(meta.account().spendCapMinor).toBe(INR(100_000));

    const { closeChoices, MetaLimitChoices } = await import("@/components/billing/CloseWorkspace");
    const accounts = [{ adAccountAssetId: "acc1", accountName: "Shop ads", accountExternalId: "act_111", selected: "keep" as const, choices: [{ choice: "keep" as const, label: "Keep the current limit on Meta" }, { choice: "restore" as const, label: "Put back my old limit (₹1,00,000)" }, { choice: "remove" as const, label: "Remove the limit" }] }];
    expect(closeChoices(accounts, {})).toEqual({ acc1: "keep" });
    expect(closeChoices(accounts, { acc1: "remove" })).toEqual({ acc1: "remove" });
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(createElement(MetaLimitChoices, { accounts, picked: {}, onPick: () => undefined }));
    expect(html).toContain("<legend");
    expect(html).toContain("Keep the current limit on Meta");
    expect(html).toContain("Put back my old limit (₹1,00,000)");
    expect(html).toContain("Remove the limit");
    expect(html).toMatch(/checked="" value="keep"/);
    expect(renderToStaticMarkup(createElement(MetaLimitChoices, { accounts: [], picked: {}, onPick: () => undefined }))).toBe("");
  });

  it("the offboard queue applies a choice; a garbage payload is ignored", async () => {
    managedWithOldCap();
    await metacapQueues["spend.metacap.offboard"]({ tenantId: T, adAccountAssetId: "acc1", choice: "keep", trigger: "account_change", actor: { type: "user", userId: "u_owner", role: "owner" }, reason: "x" }, {} as never);
    expect(limitRow().mode).toBe("withdrawn");
    await expect(metacapQueues["spend.metacap.offboard"]({ nonsense: true }, {} as never)).resolves.toBeUndefined();
    await expect(metacapQueues["spend.metacap.p0"]({}, {} as never)).resolves.toBeUndefined();
  });

  it("a soft-deleted workspace is offboarded by the scheduled pass with its stored choice", async () => {
    managedWithOldCap();
    rows("tenant")[0].deletedAt = new Date("2026-10-27");
    const r = await runMetacapPass(io());
    expect(r.offboarded).toBe(1);
    expect(limitRow().mode).toBe("withdrawn");
    expect(capPosts()).toHaveLength(0);
  });
});

// =====================================================================================================================
describe("the Spend Book's fresh read happens before its lock (4.6 step 8, I10)", () => {
  it("reserveAds reads Meta's limit with no spend lock held (a spy on fetch sees no lock), then decides from the stored read", async () => {
    process.env.SPEND_CAP_MODE = "enforce";
    seedWorkspace({ daily: INR(100_000), monthly: INR(1_000_000) });
    seedMtd(10_000);
    seedManaged({ ...verified, lastReadAt: new Date(NOW.getTime() - 30 * 60_000) });
    meta.account().spendCapMinor = INR(70_000);
    h.db.seed("adCampaign", [{ id: "c1", tenantId: T, adAccountAssetId: "acc1", metaCampaignId: "m_c1", name: "Diwali", template: "lead_generation", objective: "OUTCOME_LEADS", status: "paused", dailyBudgetMinor: 100_000, currency: "INR", origin: "human", sandbox: false }]);
    h.db.seed("adSet", [{ id: "c1s", tenantId: T, campaignId: "c1", metaAdSetId: "m_c1s", name: "Set", status: "paused", targeting: {}, dailyBudgetMinor: 100_000 }]);
    const seen: number[] = [];
    h.fetchImpl = async (input, init) => {
      seen.push(heldSpendLocks().length);
      return meta.fetch(input, init);
    };
    setMetaCapPreRead(undefined);
    expect(defaultMetaCapPreRead).toBeTypeOf("function");
    const permit = await reserveAds(T, { kind: "activate", campaignId: "c1", sets: [{ adSetId: "c1s", metaAdSetId: "m_c1s" }] }, { type: "user", userId: "u_owner", role: "owner" }, { idempotencyKey: "k1", reason: "Launch", env: CAP });
    expect(permit).toBeTruthy();
    expect(seen).toEqual([0]);
    expect(meta.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET act_111"]);
    expect(limitRow().lastReadAt).toEqual(NOW);
    // A fresh read is not read again.
    await ensureFreshRead(T, "acc1", 15 * 60_000, io());
    expect(meta.calls).toHaveLength(1);
  });

  it("ensureFreshRead never throws and does nothing for unmanaged, demo or sandbox accounts", async () => {
    process.env.SPEND_CAP_MODE = "enforce";
    seedWorkspace({ demo: true });
    seedManaged({ ...verified, lastReadAt: new Date(NOW.getTime() - 60 * 60_000) });
    await expect(ensureFreshRead(T, "acc1", 15 * 60_000, io())).resolves.toBeUndefined();
    expect(meta.calls).toHaveLength(0);
    h.fetchImpl = async () => new Response(JSON.stringify({ error: { message: "(#100) Unsupported get request", code: 100 } }), { status: 400 });
    rows("metaAsset")[0].meta = { currency: "INR", timezone: "Asia/Kolkata" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(ensureFreshRead(T, "acc1", 15 * 60_000, io())).resolves.toBeUndefined();
    errors.mockRestore();
  });
});

// =====================================================================================================================
describe("worker tasks and the API route", () => {
  it("registers the three metacap queues and the 5-minute pass", () => {
    expect(Object.keys(metacapQueues).sort()).toEqual(["spend.metacap.offboard", "spend.metacap.p0", "spend.metacap.replan"]);
    expect(metacapPeriodic).toEqual([expect.objectContaining({ name: "spend.metacap.pass", everyMs: 5 * 60_000 })]);
  });

  const req = (method: string, body?: unknown) =>
    new Request("https://wa.edwyz.com/api/spend/meta-limit", { method, headers: { "content-type": "application/json", origin: "https://wa.edwyz.com" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("GET gives every member the card; the owner also gets the consent screen", async () => {
    process.env.SITE_URL = "https://wa.edwyz.com";
    seedWorkspace({ meta: { metaCapMinor: "6500000" } });
    const res = await metaLimitGET(req("GET"));
    const body = (await res.json()) as { metaLimit: { state: string }; consent: { existingCap: string } | null };
    expect(body.metaLimit.state).toBe("off");
    expect(body.consent?.existingCap).toBe("This account already has a Meta limit of ₹65,000.");
    h.actor = { userId: "u_agent", tenantId: T, role: "agent" };
    const agent = (await (await metaLimitGET(req("GET"))).json()) as { consent: unknown; offboard: unknown[] };
    expect(agent.consent).toBeNull();
    expect(agent.offboard).toEqual([]);
  });

  it("turning it on is a raise (402 when locked); an admin gets 403 with the owner copy; turning off works when locked", async () => {
    process.env.SITE_URL = "https://wa.edwyz.com";
    seedWorkspace();
    seedMtd(10_000);
    const { HttpError } = await import("@/lib/tenancy");
    h.canWrite.mockRejectedValue(new HttpError(402, "Your subscription is inactive."));
    expect((await metaLimitPOST(req("POST", { action: "turn_on", agreed: true, textVersion: "meta-cap-v1" }))).status).toBe(402);
    expect(rows("spendConsent")).toHaveLength(0);
    h.actor = { userId: "u_admin", tenantId: T, role: "admin" };
    const res = await metaLimitPOST(req("POST", { action: "turn_on", consent: true, textVersion: "meta-cap-v1" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(ADMIN_PENDING_COPY);
    h.actor = { userId: "u_owner", tenantId: T, role: "owner" };
    h.canWrite.mockResolvedValue(undefined);
    // PUT with the card's body shape works too.
    const on = await metaLimitPUT(req("PUT", { adAccountAssetId: "acc1", action: "turn_on", consent: true, textVersion: "meta-cap-v1" }));
    expect(on.status).toBe(200);
    h.canWrite.mockRejectedValue(new HttpError(402, "locked"));
    const off = await metaLimitPOST(req("POST", { action: "turn_off", choice: "keep" }));
    expect(off.status).toBe(200);
    expect(((await off.json()) as { result: { applied: string } }).result.applied).toBe("kept");
    expect(h.canWrite).toHaveBeenCalledTimes(2);
  });

  it("refuses an unknown action, a cross-site request, and a team member's offboarding choice", async () => {
    process.env.SITE_URL = "https://wa.edwyz.com";
    seedWorkspace();
    expect((await metaLimitPOST(req("POST", { action: "explode" }))).status).toBe(400);
    const cross = new Request("https://wa.edwyz.com/api/spend/meta-limit", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ action: "turn_off" }) });
    expect((await metaLimitPOST(cross)).status).toBe(403);
    h.actor = { userId: "u_agent", tenantId: T, role: "agent" };
    expect((await metaLimitPOST(req("POST", { action: "offboard_choice", trigger: "close", choices: { acc1: "keep" } }))).status).toBe(403);
  });
});

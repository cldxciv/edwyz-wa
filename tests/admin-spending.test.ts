import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * The platform admin's spending pages (docs/SPEND-CONTROLS-SPEC.md 8.3, 4.4, 4.11, 4.16, 5.8, 7.4; WP-18) through the real
 * admin routes (handleAdmin with the real step-up cookie), the real spend modules (ceilings, allowances, kill switch,
 * probation, FX, ledger, mandates, breakers, summary) on the in-memory spend database. Stand-ins: the signed-in user lookup,
 * billing state, the job queue, the inline ads stop, the Meta limit re-plan and the TOTP check.
 */

process.env.SESSION_SECRET = "s".repeat(40);
process.env.SITE_URL = "https://wa.test";
process.env.PLATFORM_ADMIN_EMAILS = "boss@edwyz.com";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  jobs: [] as { queue: string; payload: unknown }[],
  inline: vi.fn(async (_job: unknown, _budget: number) => ({ paused: 3, total: 4, failed: 0 })),
  replan: vi.fn(async (_t: string, _a: string | undefined, _o: unknown) => [{ status: "planned" }]),
  verifyCode: vi.fn(async (_u: string, _i: unknown, _n?: number) => {}),
}));
vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/auth", () => ({ getActor: vi.fn(async () => ({ userId: "u_admin", tenantId: "t_admin", role: "owner" })) }));
vi.mock("@/lib/billing", () => ({ getBillingStatus: vi.fn(async () => ({ state: "active", canWrite: true })), assertTenantCanWrite: vi.fn(async () => {}), syncPlanToRazorpay: vi.fn() }));
vi.mock("@/lib/queue", () => ({
  enqueue: vi.fn(async (queue: string, payload: unknown) => {
    h.jobs.push({ queue, payload });
    return { id: `job_${h.jobs.length}` };
  }),
}));
vi.mock("@/lib/spend/tasks/adsguard", () => ({ stopInline: h.inline }));
vi.mock("@/lib/spend/metacap/sync", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/spend/metacap/sync")>()), replanTenant: h.replan }));
vi.mock("@/lib/admin/security", () => ({ verifyStepUpCode: h.verifyCode, resetAttemptLimiter: () => {} }));
// Owner notifications (WP-15, src/lib/spend/notify) run for real here: with no 'spend:notify' sender seeded they stay in
// the app, so no WhatsApp send is attempted. (The earlier stand-in only covered a period when that module did not parse.)

import { GET as listRoute } from "@/app/api/admin/spending/route";
import { GET as tenantGet, POST as tenantPost } from "@/app/api/admin/spending/[tenantId]/route";
import { POST as platformPost } from "@/app/api/admin/spending/platform/route";
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/admin/spending/settings/route";
import { parsePlanCeilings, planCeilingValuesOf, savePlanCeilings, updatePlan } from "@/lib/admin/plans";
import {
  ADMIN_SPEND_AUDIT_ACTIONS,
  adminVoice,
  amountField,
  ceilingCells,
  compareByRisk,
  defaultRow,
  endDateField,
  listSpending,
  matchesFilter,
  missingLimitAlerts,
  parseSpendDefaults,
  readCachedRow,
  spendingAlerts,
  stepUpFresh,
  stepUpIssuedAt,
  TENANT_SPEND_ACTIONS,
  type SpendingFilter,
} from "@/lib/admin/spending";
import { ADMIN_COOKIE, signStepUp } from "@/lib/admin/stepup";
import { effectiveLimits } from "@/lib/spend/allowances";
import { listCeilings } from "@/lib/spend/ceilings";
import { resetBookForTests } from "@/lib/spend/book";
import { parseFxTable } from "@/lib/spend/fx";
import { freezeRefusal, PLATFORM_FREEZE_KEY, resetSpendStateCache, spendState } from "@/lib/spend/kill";
import { formatMinor } from "@/lib/spend/money";
import type { AdminSpendRowDTO } from "@/lib/spend/types";

const NOW = new Date("2026-10-28T06:30:00Z");
const DAY = 86_400_000;
const ORIGIN = "https://wa.test";
const ADMIN_ID = "u_admin";

const rows = (name: string) => h.db.rows(name);
const ledger = (tenantId?: string) => rows("spendLedger").filter((r) => tenantId === undefined || r.tenantId === tenantId);
const audits = () => rows("auditLog").map((r) => String(r.action));
const cookieFor = (issuedMs: number = Date.now()) => `${ADMIN_COOKIE}=${signStepUp(ADMIN_ID, issuedMs)}`;

function req(path: string, method = "GET", body?: unknown, opts: { cookie?: string | null; origin?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: opts.origin ?? ORIGIN };
  const cookie = opts.cookie === undefined ? cookieFor() : opts.cookie;
  if (cookie) headers.cookie = cookie;
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const ctx = (tenantId: string) => ({ params: Promise.resolve({ tenantId }) });
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Row });
const act = async (tenantId: string, body: Row, cookie?: string | null) => json(await tenantPost(req(`/api/admin/spending/${tenantId}`, "POST", body, { cookie }), ctx(tenantId)));

const money = (minor: bigint | number, currency = "INR") => ({ minor: String(minor), currency, formatted: formatMinor(BigInt(minor), currency) });

function cacheRow(tenantId: string, name: string, o: Partial<AdminSpendRowDTO> = {}): AdminSpendRowDTO {
  return {
    tenantId,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    plan: null,
    demo: false,
    newWorkspaceLimits: "on",
    adsToday: { spent: money(10_000), setAside: money(20_000), limit: money(200_000) },
    adsMonth: { spent: money(100_000), setAside: money(50_000), limit: money(2_000_000) },
    whatsappMonth: { spent: money(1_000), setAside: money(0), limit: money(500_000) },
    aiMonth: { used: money(20, "CRD"), limit: money(500, "CRD") },
    metaLimit: { state: "off", label: "Off" },
    breakersOpen: 0,
    requestsWaiting: 0,
    state: "on",
    riskPct: 15,
    asOf: "2026-10-28T06:25:00.000Z",
    noAdAccount: false,
    noWhatsApp: false,
    ...o,
  };
}

function seedAdmin() {
  h.db.seed("user", [{ id: ADMIN_ID, email: "boss@edwyz.com", name: "Boss", emailVerifiedAt: new Date("2026-01-01"), disabledAt: null, totpEnabledAt: new Date("2026-01-01") }]);
}

function seedProbationRows() {
  h.db.seed("spendCeiling", [
    { id: "sc1", scope: "probation", scopeId: "*", pot: "ads", currency: "INR", dailyMinor: 200_000n, monthlyMinor: 2_000_000n, reason: "seed" },
    { id: "sc2", scope: "probation", scopeId: "*", pot: "messaging", currency: "INR", dailyMinor: 50_000n, monthlyMinor: 500_000n, reason: "seed" },
    { id: "sc3", scope: "probation", scopeId: "*", pot: "ai", currency: "CRD", dailyMinor: null, monthlyMinor: 500n, reason: "seed" },
  ]);
}

/** Four live workspaces and a deleted one: a normal cached one, one with nothing at all yet, the demo, and a stopped one near its limit. */
function seedWorld() {
  seedAdmin();
  seedProbationRows();
  h.db.seed("tenant", [
    { id: "t1", name: "Acme", slug: "acme", status: "active", billingExempt: false, deletedAt: null, trialEndsAt: null, createdAt: new Date("2026-09-01") },
    { id: "t2", name: "Beta", slug: "beta", status: "active", billingExempt: false, deletedAt: null, trialEndsAt: null, createdAt: new Date("2026-10-27") },
    { id: "t3", name: "Demo shop", slug: "demo-shop", status: "active", billingExempt: true, deletedAt: null, trialEndsAt: null, createdAt: new Date("2026-01-01") },
    { id: "t4", name: "Delta", slug: "delta", status: "active", billingExempt: false, deletedAt: null, trialEndsAt: null, createdAt: new Date("2026-08-01") },
    { id: "t5", name: "Gone", slug: "gone", status: "suspended", billingExempt: false, deletedAt: new Date("2026-10-01"), trialEndsAt: null, createdAt: new Date("2026-01-01") },
  ]);
  h.db.seed("plan", [{ id: "p_pro", code: "pro", name: "Pro", aiCreditsMonthly: 300 }]);
  h.db.seed("subscription", [
    { id: "s1", tenantId: "t1", planId: "p_pro", status: "active" },
    { id: "s2", tenantId: "t2", planId: "p_pro", status: "active" },
  ]);
  h.db.seed("spendControl", [
    { tenantId: "t1", probation: "auto", timezone: "Asia/Kolkata", spendingAdAccountAssetId: "acc1" },
    { tenantId: "t3", probation: "lifted", timezone: "Asia/Kolkata" },
    { tenantId: "t4", probation: "auto", freeze: "all", frozenByKind: "owner", frozenReason: "Holiday", frozenAt: new Date("2026-10-28T05:00:00Z"), timezone: "Asia/Kolkata" },
  ]);
  h.db.seed("metaAsset", [
    { id: "acc1", tenantId: "t1", connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Acme ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: false, createdAt: new Date("2026-01-01") },
    { id: "acc3", tenantId: "t3", connectionId: "mc3", type: "ad_account", externalId: "act_333", name: "Demo ads", status: "active", meta: { currency: "INR", demo: true }, sandbox: false, createdAt: new Date("2026-01-01") },
  ]);
  h.db.seed("phoneNumber", [{ id: "pn1", tenantId: "t1", wabaRefId: "w1", phoneNumberId: "PN1", displayPhone: "+15550001", status: "connected" }]);
  h.db.seed("platformSetting", [
    { key: "spend:summary:t1", value: cacheRow("t1", "Acme", { plan: "Pro", riskPct: 50 }), updatedAt: NOW },
    { key: "spend:summary:t3", value: cacheRow("t3", "Demo shop", { demo: true, riskPct: null, metaLimit: { state: "demo", label: "Demo" } }), updatedAt: NOW },
    { key: "spend:summary:t4", value: cacheRow("t4", "Delta", { riskPct: 92, metaLimit: { state: "pending_owner", label: "Waiting for owner" } }), updatedAt: NOW },
    { key: "spend:summary:cursor", value: { after: "t4" }, updatedAt: NOW },
  ]);
  h.db.seed("spendBreaker", [{ id: "sb_open", tenantId: "t4", kind: "pacing", scopeType: "campaign", scopeId: "c4", state: "tripped", effect: "pause_scope", reason: "Spending too fast", trippedAt: new Date("2026-10-28T05:00:00Z") }]);
  h.db.seed("spendApproval", [{ id: "ap1", tenantId: "t4", assistantKey: "ads_optimizer", pot: "ads", actionKind: "raise_budget", direction: "raise", intent: {}, fingerprint: "f", summary: "s", reason: "r", status: "pending", tokenHash: "x", expiresAt: new Date("2026-10-28T18:00:00Z"), correlationId: "c" }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.db.reset();
  h.jobs = [];
  h.inline.mockClear();
  h.replan.mockClear();
  h.verifyCode.mockClear();
  delete process.env.ASSISTANT_SPEND_ENABLED;
  delete process.env.SPEND_CAP_MODE;
  resetSpendStateCache();
  resetBookForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

// =====================================================================================================================
describe("/admin/spending: every workspace, every column and filter of 8.3", () => {
  it("lists every live workspace, including one with no SpendControl row, no saved figures, no ad account and no WhatsApp", async () => {
    seedWorld();
    const list = await listSpending({}, { now: NOW });
    expect(list.total).toBe(4);
    expect(list.all.map((r) => r.tenantId).sort()).toEqual(["t1", "t2", "t3", "t4"]);
    const beta = list.all.find((r) => r.tenantId === "t2")!;
    // Shown with the safe defaults (I11): nothing spent, the new-workspace limits, "Not checked yet".
    expect(beta).toMatchObject({ name: "Beta", plan: "Pro", newWorkspaceLimits: "on", state: "on", asOf: null, noAdAccount: true, noWhatsApp: true, adsToday: null, adsMonth: null, riskPct: null });
    expect(beta.metaLimit).toEqual({ state: "no_ad_account", label: "No ad account" });
    expect(beta.whatsappMonth).toEqual({ spent: money(0), setAside: money(0), limit: money(500_000) });
    // AI: the smaller of the plan's 300 credits and the new-workspace 500.
    expect(beta.aiMonth).toEqual({ used: money(0, "CRD"), limit: money(300, "CRD") });
    // No row was created by listing (the list never computes headroom).
    expect(rows("spendControl").some((r) => r.tenantId === "t2")).toBe(false);
  });

  it("shows every column of the saved row, with the as-of time, in each workspace's own currency", async () => {
    seedWorld();
    const acme = (await listSpending({}, { now: NOW })).all.find((r) => r.tenantId === "t1")!;
    for (const key of ["plan", "newWorkspaceLimits", "adsToday", "adsMonth", "whatsappMonth", "aiMonth", "metaLimit", "breakersOpen", "requestsWaiting", "state", "asOf"]) expect(acme).toHaveProperty(key);
    expect(acme.adsMonth).toEqual({ spent: money(100_000), setAside: money(50_000), limit: money(2_000_000) });
    expect(acme.asOf).toBe("2026-10-28T06:25:00.000Z");
    expect(acme.plan).toBe("Pro");
  });

  it("lays the live freeze, open safety stops and requests waiting over the saved row", async () => {
    seedWorld();
    const delta = (await listSpending({}, { now: NOW })).all.find((r) => r.tenantId === "t4")!;
    expect(delta).toMatchObject({ state: "stopped", breakersOpen: 1, requestsWaiting: 1 });
  });

  it("sorts by risk, highest first, and puts the demo workspace last and out of the risk sort", async () => {
    seedWorld();
    const list = await listSpending({}, { now: NOW });
    expect(list.rows.map((r) => r.tenantId)).toEqual(["t4", "t1", "t2", "t3"]);
    expect(list.rows.at(-1)).toMatchObject({ demo: true, riskPct: null });
  });

  it("filters: new-workspace limits, stopped, near a limit (80% or more), Meta limit needs attention, safety stop open", async () => {
    seedWorld();
    const ids = async (filter: SpendingFilter) => (await listSpending({ filter }, { now: NOW })).rows.map((r) => r.tenantId).sort();
    expect(await ids("new_workspace")).toEqual(["t1", "t2", "t4"]);
    expect(await ids("stopped")).toEqual(["t4"]);
    expect(await ids("near_limit")).toEqual(["t4"]);
    expect(await ids("meta_attention")).toEqual(["t4"]);
    expect(await ids("safety_stop")).toEqual(["t4"]);
    const counts = (await listSpending({}, { now: NOW })).counts;
    expect(counts).toMatchObject({ all: 4, new_workspace: 3, stopped: 1, near_limit: 1, meta_attention: 1, safety_stop: 1 });
  });

  it("never counts the demo workspace as near a limit or as needing Meta attention, even with saved figures that say so", async () => {
    const demo = cacheRow("d", "Demo", { demo: true, riskPct: 99, metaLimit: { state: "error", label: "Out of date" } });
    expect(matchesFilter(demo, "near_limit")).toBe(false);
    expect(matchesFilter(demo, "meta_attention")).toBe(false);
    expect(compareByRisk(demo, cacheRow("a", "A", { riskPct: 1 }))).toBeGreaterThan(0);
  });

  it("searches by name or web address and pages 25 at a time", async () => {
    seedAdmin();
    h.db.seed("tenant", Array.from({ length: 30 }, (_, i) => ({ id: `w${String(i).padStart(2, "0")}`, name: `Shop ${i}`, slug: `shop-${i}`, status: "active", billingExempt: false, deletedAt: null })));
    expect((await listSpending({ page: 1 }, { now: NOW })).rows).toHaveLength(25);
    const p2 = await listSpending({ page: 2 }, { now: NOW });
    expect([p2.rows.length, p2.total, p2.page]).toEqual([5, 30, 2]);
    expect((await listSpending({ q: "shop-1" }, { now: NOW })).total).toBe(11); // shop-1 and shop-10..19
  });

  it("shows a lifted or forced setting at once, without waiting for the saved row", async () => {
    seedWorld();
    rows("spendControl").find((r) => r.tenantId === "t1")!.probation = "lifted";
    rows("spendControl").find((r) => r.tenantId === "t4")!.probation = "forced";
    const all = (await listSpending({}, { now: NOW })).all;
    expect(all.find((r) => r.tenantId === "t1")!.newWorkspaceLimits).toBe("lifted");
    expect(all.find((r) => r.tenantId === "t4")!.newWorkspaceLimits).toBe("forced");
  });

  it("reads a damaged or foreign saved row as the defaults, never as someone else's figures", () => {
    const fallback = cacheRow("t1", "Acme", { asOf: null });
    expect(readCachedRow({ tenantId: "t9" }, fallback)).toBeNull();
    expect(readCachedRow("nope", fallback)).toBeNull();
    const partial = readCachedRow({ tenantId: "t1", riskPct: "lots", state: "weird", adsMonth: { spent: 5 } }, fallback)!;
    expect(partial.riskPct).toBeNull();
    expect(partial.state).toBe("on");
    expect(partial.adsMonth).toEqual(fallback.adsMonth);
  });

  it("the defaults row follows the new-workspace rule: 2 paid invoices, verification or complimentary billing lift it", () => {
    const probation = new Map([["messaging:INR", { id: "x", scope: "probation", scopeId: "*", pot: "messaging", currency: "INR", dailyMinor: 50_000n, monthlyMinor: 500_000n } as never]]);
    const base = { tenant: { id: "t", name: "T", slug: "t", billingExempt: false, status: "active" }, plan: null, setting: "auto" as const, verifiedAt: null, paidInvoices: 0, demo: false, adAccountCurrency: null, hasPhone: false, probationCeilings: probation };
    expect(defaultRow(base).newWorkspaceLimits).toBe("on");
    expect(defaultRow({ ...base, paidInvoices: 2 }).newWorkspaceLimits).toBe("lifted");
    expect(defaultRow({ ...base, verifiedAt: new Date() }).newWorkspaceLimits).toBe("lifted");
    expect(defaultRow({ ...base, tenant: { ...base.tenant, billingExempt: true } }).whatsappMonth?.limit).toBeNull();
    expect(defaultRow({ ...base, setting: "forced", paidInvoices: 5 }).newWorkspaceLimits).toBe("forced");
  });

  it("GET /api/admin/spending answers the page's data, never the unpaged list, and is audited", async () => {
    seedWorld();
    const res = await json(await listRoute(req("/api/admin/spending?filter=stopped")));
    expect(res.status).toBe(200);
    expect((res.body.rows as Row[]).map((r) => r.tenantId)).toEqual(["t4"]);
    expect(res.body).not.toHaveProperty("all");
    expect(res.body).toHaveProperty("alerts");
    expect((res.body.platform as Row).text).toBe("Spending is on for all workspaces");
    expect(audits()).toContain("admin.api.list_spending");
  });

  it("is a 404 without the step-up cookie, and for a stranger", async () => {
    seedWorld();
    expect((await listRoute(req("/api/admin/spending", "GET", undefined, { cookie: null }))).status).toBe(404);
    expect((await tenantGet(req("/api/admin/spending/t1", "GET", undefined, { cookie: null }), ctx("t1"))).status).toBe(404);
    rows("user")[0].email = "evil@example.com";
    expect((await listRoute(req("/api/admin/spending"))).status).toBe(404);
  });
});

// =====================================================================================================================
describe("the alerts strip (8.3, 4.4, 4.16, 5.1, 7.4)", () => {
  const alertsOf = async () => spendingAlerts((await listSpending({}, { now: NOW })).all, { now: NOW, env: { PLATFORM_ADMIN_EMAILS: "boss@edwyz.com" } });

  it("shows worker health from spend.health: email is off, so the strip is the alert", async () => {
    seedWorld();
    let a = await alertsOf();
    expect(a.find((x) => x.id === "worker")).toMatchObject({ tone: "bad", body: "Background work is not running. Breakers and syncs are paused; Meta's limits still apply." });
    h.db.seed("platformSetting", [{ key: "worker:heartbeat", value: {}, updatedAt: new Date(NOW.getTime() - 60_000) }]);
    a = await alertsOf();
    expect(a.find((x) => x.id === "worker")!.body).toBe("Background worker isn't running. The 1-minute fallback is running.");
  });

  it("counts tripwire bypass rows and orphan ledger rows", async () => {
    seedWorld();
    h.db.seed("auditLog", [
      { id: "a1", action: "spend.tripwire.bypass", createdAt: new Date(NOW.getTime() - DAY) },
      { id: "a2", action: "spend.tripwire.bypass", createdAt: new Date(NOW.getTime() - 2 * DAY) },
      { id: "a3", action: "spend.tripwire.bypass", createdAt: new Date(NOW.getTime() - 9 * DAY) },
    ]);
    h.db.seed("platformSetting", [{ key: "spend:ledger:orphans", value: { count: 3, checkedAt: "2026-10-28T02:00:00Z", items: [] }, updatedAt: NOW }]);
    const a = await alertsOf();
    expect(a.find((x) => x.id === "tripwire")).toMatchObject({ tone: "warn", body: expect.stringContaining("2 calls in the last 7 days") });
    expect(a.find((x) => x.id === "orphans")).toMatchObject({ tone: "warn", body: expect.stringContaining("3 changes were started more than an hour ago") });
  });

  it("counts Meta limit errors per workspace and leaves the demo workspace out", async () => {
    seedWorld();
    h.db.seed("metaSpendLimit", [
      { adAccountAssetId: "acc1", tenantId: "t1", accountExternalId: "act_111", mode: "error" },
      { adAccountAssetId: "acc3", tenantId: "t3", accountExternalId: "act_333", mode: "no_permission" },
    ]);
    h.db.seed("spendBreaker", [{ id: "sb_m", tenantId: "t3", kind: "meta_cap_unreachable", scopeType: "ad_account", scopeId: "acc3", state: "tripped", effect: "block_raises", reason: "r" }]);
    const meta = (await alertsOf()).find((x) => x.id === "meta_errors")!;
    expect(meta.body).toContain("1 workspace has");
  });

  it("says when no notification sender is set up, and checks templates, tier and owners notified against 200", async () => {
    seedWorld();
    expect((await alertsOf()).find((x) => x.id === "notifier")).toMatchObject({ tone: "warn", title: "No notification sender is set up" });
    h.db.seed("tenant", [{ id: "tn", name: "Edwyz alerts", slug: "edwyz-alerts", status: "active", billingExempt: true, deletedAt: null }]);
    h.db.seed("phoneNumber", [{ id: "pn_n", tenantId: "tn", wabaRefId: "wn", phoneNumberId: "PNN", displayPhone: "+1 711-268-5789", messagingLimitTier: "TIER_250", qualityRating: "GREEN" }]);
    h.db.seed("template", ["spend_approval_v1", "spend_alert_v1", "spend_daily_v1"].map((name, i) => ({ id: `tp${i}`, tenantId: "tn", wabaRefId: "wn", name, language: "en", status: "approved" })));
    h.db.seed("template", [{ id: "tp9", tenantId: "tn", wabaRefId: "wn", name: "spend_optin_v1", language: "en", status: "pending" }]);
    h.db.seed("membership", [{ id: "m1", tenantId: "tn", userId: ADMIN_ID, role: "owner" }]);
    h.db.seed("message", Array.from({ length: 5 }, (_, i) => ({ id: `msg${i}`, tenantId: "tn", conversationId: `cv${i % 3}`, origin: "system_notify", direction: "outbound", createdAt: new Date(NOW.getTime() - 3_600_000) })));
    h.db.seed("platformSetting", [{ key: "spend:notify", value: { tenantId: "tn", phoneNumberId: "pn_n", language: "en", templates: {} }, updatedAt: NOW }]);
    const a = await alertsOf();
    const n = a.find((x) => x.id === "notifier")!;
    expect(n.tone).toBe("warn");
    expect(n.body).toContain("Templates approved: 3 of 4.");
    expect(n.body).toContain("Tier: 250 a day.");
    expect(n.body).toContain("Owners notified in the last 24 hours: 3 of 200.");
    expect(a.find((x) => x.id === "notifier_workspace")).toBeUndefined();
  });

  it("raises a red alert when the notifier workspace is not complimentary or has members who are not platform admins", async () => {
    seedWorld();
    h.db.seed("tenant", [{ id: "tn", name: "Edwyz alerts", slug: "edwyz-alerts", status: "active", billingExempt: false, deletedAt: null }]);
    h.db.seed("user", [{ id: "u_x", email: "helper@example.com", name: "Helper" }]);
    h.db.seed("membership", [
      { id: "m1", tenantId: "tn", userId: ADMIN_ID, role: "owner" },
      { id: "m2", tenantId: "tn", userId: "u_x", role: "agent" },
    ]);
    h.db.seed("platformSetting", [{ key: "spend:notify", value: { tenantId: "tn", phoneNumberId: "pn_n" }, updatedAt: NOW }]);
    const bad = (await alertsOf()).find((x) => x.id === "notifier_workspace")!;
    expect(bad.tone).toBe("bad");
    expect(bad.body).toContain("is not complimentary");
    expect(bad.body).toContain("helper@example.com");
    expect(bad.body).not.toContain("boss@edwyz.com");
  });

  it("names ad accounts connected to several workspaces and which one manages Meta's limit", async () => {
    seedWorld();
    h.db.seed("metaAsset", [{ id: "acc4", tenantId: "t4", connectionId: "mc4", type: "ad_account", externalId: "111", name: "Acme ads", status: "active", meta: {}, sandbox: false }]);
    h.db.seed("metaSpendLimit", [{ adAccountAssetId: "acc1", tenantId: "t1", accountExternalId: "act_111", mode: "managed" }]);
    const shared = (await alertsOf()).find((x) => x.id === "shared_accounts")!;
    expect(shared.body).toContain("act_111 (Acme ads) is connected to 2 workspaces: Acme, Delta. Acme manages Meta's limit.");
  });

  it("counts the workspaces waiting on a missing exchange rate or ceiling row, per currency and pot (4.4)", () => {
    const usd = cacheRow("u1", "US shop", { adsMonth: { spent: money(0, "USD"), setAside: money(0, "USD"), limit: null }, newWorkspaceLimits: "on" });
    const usd2 = cacheRow("u2", "US shop 2", { adsMonth: { spent: money(0, "USD"), setAside: money(0, "USD"), limit: null }, newWorkspaceLimits: "on" });
    const lifted = cacheRow("u3", "US old", { adsMonth: { spent: money(0, "USD"), setAside: money(0, "USD"), limit: null }, newWorkspaceLimits: "lifted" });
    const demo = cacheRow("u4", "US demo", { demo: true, adsMonth: { spent: money(0, "USD"), setAside: money(0, "USD"), limit: null } });
    const ceilings = [{ id: "c", scope: "probation", scopeId: "*", pot: "ads", currency: "INR", dailyMinor: 200_000n, monthlyMinor: 2_000_000n, reason: null, setByUserId: null, expiresAt: null, createdAt: null, updatedAt: null } as const];
    const stale = parseFxTable({ rates: { USD: "84.10" }, rateUpdatedAt: { USD: new Date(NOW.getTime() - 36 * DAY).toISOString() } });
    const out = missingLimitAlerts([usd, usd2, lifted, demo], [...ceilings], stale, new Map(), NOW);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("No USD ads limits for new workspaces: 2 workspaces can't start ads.");
    expect(out[0].body).toContain("The USD exchange rate is out of date");
    const fresh = parseFxTable({ rates: { USD: "84.10" }, rateUpdatedAt: { USD: NOW.toISOString() } });
    expect(missingLimitAlerts([usd, usd2], [...ceilings], fresh, new Map(), NOW)).toEqual([]);
  });

  it("puts the most urgent alerts first", async () => {
    seedWorld();
    const tones = (await alertsOf()).map((a) => a.tone);
    const rank = { bad: 0, warn: 1, info: 2, good: 3 } as Record<string, number>;
    expect([...tones].sort((x, y) => rank[x] - rank[y])).toEqual(tones);
  });
});

// =====================================================================================================================
describe("workspace actions: a reason, an admin.tenant.* audit row, a platform_admin ledger row, effective at once", () => {
  it("refuses every action without a reason", async () => {
    seedWorld();
    for (const action of TENANT_SPEND_ACTIONS) {
      const res = await act("t1", { action });
      expect(res.status, action).toBe(400);
      expect(res.body.error).toBe("Reason is required.");
    }
    expect(ledger("t1")).toHaveLength(0);
  });

  it("is a 404 without the step-up, and refuses a request from another site", async () => {
    seedWorld();
    expect((await act("t1", { action: "lift_probation", reason: "x" }, null)).status).toBe(404);
    expect((await tenantPost(req("/api/admin/spending/t1", "POST", { action: "lift_probation", reason: "x" }, { origin: "https://evil.example" }), ctx("t1"))).status).toBe(403);
    expect(rows("spendControl").find((r) => r.tenantId === "t1")!.probation).toBe("auto");
  });

  it("set_spend_ceiling overrides the ceiling, is ledgered as the platform admin, and the next check reads it", async () => {
    seedWorld();
    const before = await effectiveLimits("t1", "messaging", "INR", undefined, { now: NOW });
    expect(before.monthly).toBe(500_000n);
    const res = await act("t1", { action: "set_spend_ceiling", pot: "messaging", currency: "INR", daily: "", monthly: "300", reason: "Spam complaints" });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("Override saved for WhatsApp: no ceiling a day, ₹300 a month. It applies from the next spending check.");
    const after = await effectiveLimits("t1", "messaging", "INR", undefined, { now: NOW });
    expect([after.monthly, after.binding]).toEqual([30_000n, "tenant"]);
    const row = ledger("t1").find((r) => r.action === "ceiling.change" && r.phase === "applied")!;
    expect(row).toMatchObject({ actorType: "platform_admin", actorId: ADMIN_ID, reason: "Spam complaints" });
    expect(audits()).toContain("admin.tenant.set_spend_ceiling");
  });

  it("the AI override is the credit top-up: it lifts the AI limit above the plan's monthly credits", async () => {
    seedWorld();
    rows("spendControl").find((r) => r.tenantId === "t1")!.probation = "lifted";
    expect((await effectiveLimits("t1", "ai", "CRD", undefined, { now: NOW })).monthly).toBe(300n);
    const res = await act("t1", { action: "set_spend_ceiling", pot: "ai", monthly: "2000", reason: "Top-up bought by bank transfer" });
    expect(res.status).toBe(200);
    const ai = await effectiveLimits("t1", "ai", "CRD", undefined, { now: NOW });
    expect([ai.monthly, ai.binding, ai.planCapMonthly]).toEqual([2_000n, "tenant", 2_000n]);
  });

  it("an override ends at the end of its end date; a past date, a bad date and an empty override are refused", async () => {
    seedWorld();
    const res = await act("t1", { action: "set_spend_ceiling", pot: "ads", currency: "INR", daily: "1000", monthly: "10000", endDate: "2026-11-30", reason: "Trial of a bigger budget" });
    expect(res.status).toBe(200);
    expect(rows("spendCeiling").find((r) => r.scope === "tenant")!.expiresAt).toEqual(new Date("2026-12-01T00:00:00Z"));
    expect((await act("t1", { action: "set_spend_ceiling", pot: "ads", daily: "1", endDate: "2026-10-01", reason: "x" })).body.error).toBe("Choose an end date in the future.");
    expect((await act("t1", { action: "set_spend_ceiling", pot: "ads", daily: "1", endDate: "2026-02-30", reason: "x" })).body.error).toBe("Enter a real date.");
    expect((await act("t1", { action: "set_spend_ceiling", pot: "ads", reason: "x" })).body.error).toBe("Enter a daily or a monthly ceiling. To remove the override, use Remove override.");
    expect((await act("t1", { action: "set_spend_ceiling", pot: "ads", daily: "20", monthly: "10", reason: "x" })).status).toBe(400);
  });

  it("clear_spend_ceiling removes the override, and says when there is none", async () => {
    seedWorld();
    await act("t1", { action: "set_spend_ceiling", pot: "ads", currency: "INR", daily: "1000", reason: "x" });
    const res = await act("t1", { action: "clear_spend_ceiling", pot: "ads", reason: "Back to normal" });
    expect(res.status).toBe(200);
    expect(rows("spendCeiling").filter((r) => r.scope === "tenant")).toHaveLength(0);
    expect((await act("t1", { action: "clear_spend_ceiling", pot: "ads", reason: "again" })).status).toBe(409);
    expect(audits().filter((a) => a === "admin.tenant.clear_spend_ceiling")).toHaveLength(1);
  });

  it("lower_spend_limits lowers the owner's limit, never raises it or sets a Not set one", async () => {
    seedWorld();
    h.db.seed("spendAllowance", [{ id: "sa1", tenantId: "t1", pot: "ads", currency: "INR", dailyLimitMinor: 100_000n, monthlyLimitMinor: null, version: 2 }]);
    const res = await act("t1", { action: "lower_spend_limits", pot: "ads", daily: "500", reason: "Abuse" });
    expect(res.status).toBe(200);
    expect(res.body.text).toContain("set an override ceiling to make the cut stick");
    expect(rows("spendAllowance")[0].dailyLimitMinor).toBe(50_000n);
    expect(ledger("t1").find((r) => r.action === "allowance.change" && r.phase === "applied")).toMatchObject({ actorType: "platform_admin" });
    expect((await act("t1", { action: "lower_spend_limits", pot: "ads", daily: "900", reason: "x" })).body.error).toContain("Only the owner can raise it");
    expect((await act("t1", { action: "lower_spend_limits", pot: "ads", monthly: "900", reason: "x" })).body.error).toContain("Not set, so there is nothing to lower");
    expect((await effectiveLimits("t1", "ads", "INR", undefined, { now: NOW })).owner.daily).toBe(50_000n);
  });

  it("lower_assistant_level only lowers: a raise is refused and nothing changes", async () => {
    seedWorld();
    h.db.seed("assistantMandate", [{ id: "am1", tenantId: "t1", assistantKey: "ads_optimizer", enabled: true, level: 1, allowedOps: ["pause"], currency: "INR", maxDailyMinor: 100_000n, version: 1 }]);
    expect((await act("t1", { action: "lower_assistant_level", assistantKey: "ads_optimizer", level: "2", reason: "x" })).status).toBe(403);
    expect(rows("assistantMandate")[0].level).toBe(1);
    expect((await act("t1", { action: "lower_assistant_level", assistantKey: "ads_optimizer", maxDaily: "2000", reason: "x" })).status).toBe(403);
    const res = await act("t1", { action: "lower_assistant_level", assistantKey: "ads_optimizer", level: "0", maxDaily: "500", reason: "Bug being checked" });
    expect(res.status).toBe(200);
    expect(rows("assistantMandate")[0]).toMatchObject({ level: 0, maxDailyMinor: 50_000n });
    expect(ledger("t1").find((r) => r.action === "mandate.change" && r.phase === "applied")).toMatchObject({ actorType: "platform_admin", reason: "Bug being checked" });
    expect((await act("t1", { action: "lower_assistant_level", assistantKey: "nobody", level: "0", reason: "x" })).status).toBe(400);
  });

  it("lift_probation, set_probation (forced) and verify_workspace change the new-workspace limits at once", async () => {
    seedWorld();
    expect((await effectiveLimits("t1", "ads", "INR", undefined, { now: NOW })).probation.on).toBe(true);
    expect((await act("t1", { action: "lift_probation", reason: "Known customer" })).status).toBe(200);
    expect((await effectiveLimits("t1", "ads", "INR", undefined, { now: NOW })).probation.on).toBe(false);
    expect((await act("t1", { action: "set_probation", setting: "forced", reason: "Chargeback" })).status).toBe(200);
    expect((await effectiveLimits("t1", "ads", "INR", undefined, { now: NOW })).probation.on).toBe(true);
    expect((await act("t1", { action: "set_probation", setting: "auto", reason: "Resolved" })).status).toBe(200);
    expect((await act("t1", { action: "verify_workspace", verified: "true", reason: "KYC done" })).status).toBe(200);
    expect(rows("spendControl").find((r) => r.tenantId === "t1")!.verifiedAt).toBeInstanceOf(Date);
    expect((await effectiveLimits("t1", "ads", "INR", undefined, { now: NOW })).probation.on).toBe(false);
    const changes = ledger("t1").filter((r) => r.action === "probation.change" && r.phase === "applied");
    expect(changes.map((r) => r.actorType)).toEqual(["platform_admin", "platform_admin", "platform_admin", "platform_admin"]);
    expect(audits()).toEqual(expect.arrayContaining(["admin.tenant.lift_probation", "admin.tenant.set_probation", "admin.tenant.verify_workspace"]));
  });

  it("freeze_spending stops the workspace (inline pause first), an assistant raise is refused, and unfreeze turns it back on", async () => {
    seedWorld();
    const res = await act("t1", { action: "freeze_spending", level: "all", reason: "Fraud check" });
    expect(res.status).toBe(200);
    expect((res.body.stop as Row).text).toBe("Paused 3 of 4; the rest will follow within a minute.");
    expect(h.inline).toHaveBeenCalledOnce();
    expect(h.jobs.map((j) => j.queue)).toContain("spend.stop");
    const state = await spendState("t1", { fresh: true });
    expect(freezeRefusal(state, { type: "assistant", assistantKey: "ads_optimizer" })).toBe("spend.frozen");
    expect(ledger("t1").find((r) => r.action === "kill.workspace" && r.phase === "applied")).toMatchObject({ actorType: "platform_admin" });
    const off = await act("t1", { action: "unfreeze_spending", reason: "Checked" });
    expect(off.body.text).toContain("stays paused until the owner resumes it");
    expect((await spendState("t1", { fresh: true })).effective).toBe("none");
  });

  it("clear_breaker clears the state only, for this workspace's open safety stops", async () => {
    seedWorld();
    expect((await act("t1", { action: "clear_breaker", breakerId: "sb_open", reason: "x" })).status).toBe(404); // belongs to t4
    const res = await act("t4", { action: "clear_breaker", breakerId: "sb_open", reason: "False alarm" });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("Safety stop cleared. Anything it paused stays paused until the owner resumes it.");
    expect(rows("spendBreaker")[0]).toMatchObject({ state: "cleared", clearedByUserId: ADMIN_ID });
    expect(ledger("t4").find((r) => r.action === "breaker.clear")).toMatchObject({ actorType: "platform_admin", reason: "False alarm" });
    expect(h.jobs).toHaveLength(0); // nothing is resumed
  });

  it("mark_test_ad_account flags an empty account, and refuses one with ads running", async () => {
    seedWorld();
    h.db.seed("adCampaign", [{ id: "c1", tenantId: "t1", adAccountAssetId: "acc1", status: "active", metaCampaignId: "m1" }]);
    expect((await act("t1", { action: "mark_test_ad_account", adAccountAssetId: "acc1", sandbox: "true", reason: "Sandbox" })).status).toBe(409);
    rows("adCampaign")[0].status = "paused";
    const res = await act("t1", { action: "mark_test_ad_account", adAccountAssetId: "acc1", sandbox: "true", reason: "Meta sandbox account" });
    expect(res.status).toBe(200);
    expect(rows("metaAsset").find((r) => r.id === "acc1")!.sandbox).toBe(true);
    expect(ledger("t1").find((r) => r.action === "ads.account.sandbox" && r.phase === "applied")).toMatchObject({ actorType: "platform_admin" });
    expect((await act("t1", { action: "mark_test_ad_account", adAccountAssetId: "acc1", sandbox: "false", reason: "Real" })).status).toBe(200);
    expect(rows("metaAsset").find((r) => r.id === "acc1")!.sandbox).toBe(false);
    expect((await act("t1", { action: "mark_test_ad_account", adAccountAssetId: "acc3", reason: "x" })).status).toBe(404);
  });

  it("end_learning works only for a verified workspace or test account, and only once assistants may spend", async () => {
    seedWorld();
    h.db.seed("assistantMandate", [{ id: "am1", tenantId: "t1", assistantKey: "ads_optimizer", enabled: true, level: 1, allowedOps: ["pause"], shadowStartedAt: NOW, shadowUntil: new Date(NOW.getTime() + 10 * DAY), version: 1 }]);
    expect((await act("t1", { action: "end_learning", assistantKey: "ads_optimizer", reason: "x" })).body.error).toBe("Assistants only make suggestions for now, so their learning period can't end early.");
    process.env.ASSISTANT_SPEND_ENABLED = "true";
    expect((await act("t1", { action: "end_learning", assistantKey: "ads_optimizer", reason: "x" })).body.error).toBe("Learning can end early only for a test ad account or a verified workspace.");
    rows("spendControl").find((r) => r.tenantId === "t1")!.verifiedAt = new Date("2026-10-01");
    const res = await act("t1", { action: "end_learning", assistantKey: "ads_optimizer", reason: "Internal test workspace" });
    expect(res.status).toBe(200);
    expect(rows("assistantMandate")[0].shadowUntil).toEqual(NOW);
    expect(ledger("t1").find((r) => r.action === "mandate.change" && (r.reasonCodes as string[]).includes("end_learning"))).toMatchObject({ actorType: "platform_admin" });
  });

  it("resync_meta_limit re-plans Meta's limit as the platform admin and records it", async () => {
    seedWorld();
    const res = await act("t1", { action: "resync_meta_limit", reason: "Owner says Meta shows another value" });
    expect(res.status).toBe(200);
    expect(h.replan).toHaveBeenCalledWith("t1", "acc1", expect.objectContaining({ actor: { type: "platform_admin", userId: ADMIN_ID } }));
    expect(ledger("t1").find((r) => r.action === "meta.spend_cap.resync")).toMatchObject({ phase: "info", actorType: "platform_admin" });
    expect((await act("t2", { action: "resync_meta_limit", reason: "x" })).status).toBe(409);
  });

  it("meta_limit_offboard applies a 5.8 choice to every managed account, ledgered as the platform admin", async () => {
    seedWorld();
    h.db.seed("metaSpendLimit", [{ adAccountAssetId: "acc1", tenantId: "t1", accountExternalId: "act_111", mode: "managed", currency: "INR", managedCapMinor: 2_000_000n, lastWriteAt: new Date("2026-10-20"), customerCapAtConsentMinor: null }]);
    const res = await act("t1", { action: "meta_limit_offboard", choice: "keep", reason: "Closing account" });
    expect(res.status).toBe(200);
    expect(rows("metaSpendLimit")[0].mode).toBe("withdrawn");
    const row = ledger("t1").find((r) => r.action === "meta.spend_cap.offboard")!;
    expect(row).toMatchObject({ actorType: "platform_admin" });
    expect(row.reasonCodes).toEqual(expect.arrayContaining(["turn_off", "keep"]));
    expect((await act("t1", { action: "meta_limit_offboard", choice: "explode", reason: "x" })).status).toBe(400);
  });

  it("GET /api/admin/spending/[tenantId] gives the live card: pots, overrides, Meta limit, safety stops and the last ledger rows", async () => {
    seedWorld();
    await act("t1", { action: "set_spend_ceiling", pot: "ads", currency: "INR", daily: "1000", reason: "x" });
    const res = await json(await tenantGet(req("/api/admin/spending/t1"), ctx("t1")));
    expect(res.status).toBe(200);
    const v = res.body;
    expect((v.pots as Row[]).map((p) => p.pot)).toEqual(["ads", "messaging", "ai"]);
    expect((v.overrides as Row[])[0]).toMatchObject({ pot: "ads", currency: "INR", daily: money(100_000) });
    expect(v.liveError).toBeNull();
    expect((v.ledger as Row[]).length).toBeGreaterThan(0);
    expect((v.ledger as Row[]).length).toBeLessThanOrEqual(20);
    expect((v.adAccounts as Row[])[0]).toMatchObject({ assetId: "acc1", spending: true, sandbox: false });
    expect(audits()).toContain("admin.api.view_tenant_spending");
    expect((await tenantGet(req("/api/admin/spending/nope"), ctx("nope"))).status).toBe(404);
  });
});

// =====================================================================================================================
describe("the platform switch (4.11, 8.3)", () => {
  const stop = async (body: Row, cookie?: string | null) => json(await platformPost(req("/api/admin/spending/platform", "POST", body, { cookie })));

  it("needs the typed STOP SPENDING, a reason and a step-up within 5 minutes", async () => {
    seedWorld();
    expect((await stop({ action: "stop_all", confirm: "STOP SPENDING" })).body.error).toBe("Reason is required.");
    expect((await stop({ action: "stop_all", reason: "Meta outage", confirm: "stop spending" })).body.error).toBe("Type STOP SPENDING to confirm.");
    const old = cookieFor(Date.now() - 6 * 60_000);
    const stale = await stop({ action: "stop_all", reason: "Meta outage", confirm: "STOP SPENDING" }, old);
    expect(stale.status).toBe(403);
    expect(stale.body.error).toBe("Confirm it's you again with your authenticator code, then try within 5 minutes.");
    expect(h.db.rows("platformSetting").find((r) => r.key === PLATFORM_FREEZE_KEY)).toBeUndefined();
    expect((await stop({ action: "explode", reason: "x", confirm: "STOP SPENDING" })).status).toBe(400);
  });

  it("a code typed in the dialog counts as a fresh step-up and refreshes the cookie", async () => {
    seedWorld();
    const old = cookieFor(Date.now() - 20 * 60_000);
    const res = await platformPost(req("/api/admin/spending/platform", "POST", { action: "stop_assistants", reason: "Bug in the optimizer", confirm: "STOP SPENDING", code: "123456" }, { cookie: old }));
    expect(res.status).toBe(200);
    expect(h.verifyCode).toHaveBeenCalledWith(ADMIN_ID, { code: "123456" }, NOW.getTime());
    expect(res.headers.get("set-cookie")).toContain(`${ADMIN_COOKIE}=`);
  });

  it("stops everything, pauses up to 25 workspaces inline, ledgers and audits it, and an assistant raise is refused within 5 s", async () => {
    seedWorld();
    await spendState("t1"); // warm this process's 5-second cache
    const res = await stop({ action: "stop_all", reason: "Meta outage", confirm: "STOP SPENDING" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, level: "all" });
    expect(res.body.text).toContain("All spending is stopped everywhere. Paused 3 of 4 campaigns in the 25 workspaces with the most at risk.");
    expect((h.inline.mock.calls[0][0] as Row).tenantId).toBe("*");
    expect(h.jobs.find((j) => j.queue === "spend.stop")!.payload).toMatchObject({ tenantId: "*", level: "all" });
    const assistant = { type: "assistant", assistantKey: "ads_optimizer" } as const;
    expect(freezeRefusal(await spendState("t1"), assistant)).toBe("spend.platform_frozen");
    expect(freezeRefusal(await spendState("t2", { fresh: true }), { type: "user", userId: "u", role: "owner" })).toBe("spend.platform_frozen");
    expect(ledger("*").find((r) => r.action === "kill.platform" && r.phase === "applied")).toMatchObject({ actorType: "platform_admin", reason: "Meta outage" });
    expect(audits()).toContain("admin.spend.stop_all");
    const page = await json(await listRoute(req("/api/admin/spending")));
    expect((page.body.platform as Row).text).toBe("Stopped since 2026-10-28 06:30 UTC by boss@edwyz.com: Meta outage");
    expect((page.body.rows as Row[]).every((r) => r.state === "stopped")).toBe(true);
  });

  it("a stop written by another process reaches a cached reader within 5 seconds", async () => {
    seedWorld();
    const t0 = NOW.getTime();
    await spendState("t1", { now: t0 });
    h.db.seed("platformSetting", [{ key: PLATFORM_FREEZE_KEY, value: { freeze: "all", reason: "other process", byUserId: ADMIN_ID, at: NOW.toISOString(), version: 1 }, updatedAt: NOW }]);
    const assistant = { type: "assistant", assistantKey: "ads_optimizer" } as const;
    expect(freezeRefusal(await spendState("t1", { now: t0 + 4_999 }), assistant)).toBeNull();
    expect(freezeRefusal(await spendState("t1", { now: t0 + 5_000 }), assistant)).toBe("spend.platform_frozen");
  });

  it("turning it back on needs START SPENDING and a reason, and restarts nothing", async () => {
    seedWorld();
    await stop({ action: "stop_all", reason: "Meta outage", confirm: "STOP SPENDING" });
    h.inline.mockClear();
    h.jobs = [];
    expect((await stop({ action: "resume", reason: "Fixed", confirm: "STOP SPENDING" })).body.error).toBe("Type START SPENDING to confirm.");
    const res = await stop({ action: "resume", reason: "Meta is back", confirm: "START SPENDING" });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("Spending is back on for all workspaces. Nothing restarts by itself: paused ads and broadcasts stay paused until each owner resumes them.");
    expect(h.inline).not.toHaveBeenCalled();
    expect(h.jobs).toHaveLength(0);
    expect((await spendState("t1", { fresh: true })).platform).toBe("none");
    expect(audits()).toContain("admin.spend.resume");
  });

  it("reads the step-up's age from the cookie", () => {
    const issued = NOW.getTime() - 4 * 60_000;
    const at = stepUpIssuedAt(signStepUp(ADMIN_ID, issued), ADMIN_ID, NOW.getTime())!;
    expect(Math.abs(at.getTime() - issued)).toBeLessThan(1_000);
    expect(stepUpFresh(at, NOW)).toBe(true);
    expect(stepUpFresh(new Date(NOW.getTime() - 5 * 60_000 - 1_000), NOW)).toBe(false);
    expect(stepUpIssuedAt(signStepUp("someone-else", issued), ADMIN_ID, NOW.getTime())).toBeNull();
    expect(stepUpIssuedAt(null, ADMIN_ID)).toBeNull();
  });
});

// =====================================================================================================================
describe("/admin/spending/settings (8.3)", () => {
  const put = async (body: Row) => json(await settingsPut(req("/api/admin/spending/settings", "PUT", body)));
  const cell = (cells: Row[], pot: string, currency: string) => cells.find((c) => c.pot === pot && c.currency === currency)!;

  it("shows the seeded INR rows for all three pots and Not set for other currencies", async () => {
    seedWorld();
    const res = await json(await settingsGet(req("/api/admin/spending/settings")));
    expect(res.status).toBe(200);
    const nw = res.body.newWorkspace as Row[];
    expect(cell(nw, "ads", "INR")).toMatchObject({ dailyText: "₹2,000", monthlyText: "₹20,000", set: true });
    expect(cell(nw, "messaging", "INR")).toMatchObject({ dailyText: "₹500", monthlyText: "₹5,000" });
    expect(cell(nw, "ai", "CRD")).toMatchObject({ dailyText: "Not set", monthlyText: "500 credits" });
    expect(cell(nw, "ads", "USD")).toMatchObject({ dailyText: "Not set", monthlyText: "Not set", set: false });
    expect(nw[0]).toMatchObject({ pot: "ads", currency: "INR" });
    expect(audits()).toContain("admin.api.spending_settings");
  });

  it("changes a new-workspace row, ledgers it on the platform ledger, and a row with both fields empty becomes Not set", async () => {
    seedWorld();
    const res = await put({ section: "ceiling", scope: "probation", pot: "messaging", currency: "INR", daily: "600", monthly: "6,000", reason: "More room for broadcasts" });
    expect(res.status).toBe(200);
    expect(rows("spendCeiling").find((r) => r.id === "sc2")).toMatchObject({ dailyMinor: 60_000n, monthlyMinor: 600_000n });
    expect(ledger("*").find((r) => r.action === "ceiling.change" && r.phase === "applied")).toMatchObject({ actorType: "platform_admin" });
    const cleared = await put({ section: "ceiling", scope: "platform", pot: "ads", currency: "USD", daily: "", monthly: "", reason: "None" });
    expect(cleared.body.text).toBe("The platform ads row for USD was already Not set.");
    await put({ section: "ceiling", scope: "platform", pot: "ads", currency: "USD", daily: "50", monthly: "", reason: "US cap" });
    const removed = await put({ section: "ceiling", scope: "platform", pot: "ads", currency: "USD", daily: "", monthly: "", reason: "Remove" });
    expect(removed.body.text).toBe("The platform ads row for USD is now Not set.");
    expect(cell((removed.body.settings as Row).platform as Row[], "ads", "USD")).toMatchObject({ set: false, dailyText: "Not set", monthlyText: "Not set" });
    expect(rows("spendCeiling").some((r) => r.scope === "platform" && r.currency === "USD")).toBe(false);
    expect(audits()).toEqual(expect.arrayContaining(["admin.spend.ceiling", "admin.spend.clear_ceiling"]));
  });

  it("a 36-day-old exchange rate shows Out of date and is not used; a fresh one is", async () => {
    seedWorld();
    h.db.seed("tenant", [{ id: "tu", name: "US shop", slug: "us", status: "active", billingExempt: false, deletedAt: null }]);
    const old = new Date(NOW.getTime() - 36 * DAY).toISOString();
    h.db.seed("platformSetting", [{ key: "spend:fx", value: { base: "INR", rates: { USD: "84.10" }, rateUpdatedAt: { USD: old }, updatedAt: old }, updatedAt: NOW }]);
    const view = (await json(await settingsGet(req("/api/admin/spending/settings")))).body;
    expect(((view.fx as Row).rates as Row[])[0]).toMatchObject({ currency: "USD", status: "Out of date", fresh: false });
    const stale = await effectiveLimits("tu", "ads", "USD", undefined, { now: NOW });
    expect([stale.unknownCeiling, stale.monthly]).toEqual([true, null]);
    const res = await put({ section: "fx", currency: "USD", rate: "84.10", reason: "Monthly update" });
    expect(res.status).toBe(200);
    expect(((res.body.settings as Row).fx as Row).rates).toEqual([expect.objectContaining({ currency: "USD", status: "In use", fresh: true })]);
    const fresh = await effectiveLimits("tu", "ads", "USD", undefined, { now: NOW });
    // ₹20,000 at 84.10 INR per USD, rounded down: $237.81.
    expect([fresh.unknownCeiling, fresh.monthly]).toEqual([false, 23_781n]);
    expect(ledger("*").find((r) => r.action === "fx.change")).toMatchObject({ actorType: "platform_admin" });
  });

  it("refuses a notification sender in a workspace that is not complimentary and active, and saves one that is", async () => {
    seedWorld();
    h.db.seed("tenant", [
      { id: "tp", name: "Paying shop", slug: "paying", status: "active", billingExempt: false, deletedAt: null },
      { id: "tn", name: "Edwyz alerts", slug: "edwyz-alerts", status: "active", billingExempt: true, deletedAt: null },
    ]);
    h.db.seed("phoneNumber", [
      { id: "pn_p", tenantId: "tp", wabaRefId: "wp", phoneNumberId: "PNP", displayPhone: "+91 90000 00000" },
      { id: "pn_n", tenantId: "tn", wabaRefId: "wn", phoneNumberId: "PNN", displayPhone: "+1 711-268-5789" },
    ]);
    const refused = await put({ section: "notifier", phoneNumberId: "pn_p", reason: "x" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("must be complimentary and active");
    const view = (await json(await settingsGet(req("/api/admin/spending/settings")))).body;
    expect(((view.notifier as Row).candidates as Row[]).map((c) => c.phoneId)).toEqual(["pn_n"]);
    // A complimentary workspace with a customer as a member is refused: its inbox would hold every owner's alerts.
    h.db.seed("user", [{ id: "u_cust", email: "owner@customer.example", name: "Customer" }]);
    h.db.seed("membership", [
      { id: "mn1", tenantId: "tn", userId: ADMIN_ID, role: "owner" },
      { id: "mn2", tenantId: "tn", userId: "u_cust", role: "admin" },
    ]);
    const outsiders = await put({ section: "notifier", phoneNumberId: "pn_n", language: "en", reason: "Platform sender" });
    expect(outsiders.status).toBe(409);
    expect(outsiders.body.error).toBe("Edwyz alerts has 1 member who is not a platform admin. Its inbox would hold every owner's number and alerts, so remove them first, or choose the Edwyz notifier workspace.");
    expect(rows("platformSetting").find((r) => r.key === "spend:notify")).toBeUndefined();
    rows("membership").splice(rows("membership").findIndex((m) => m.id === "mn2"), 1);
    const ok = await put({ section: "notifier", phoneNumberId: "pn_n", language: "en", reason: "Platform sender" });
    expect(ok.status).toBe(200);
    const stored = rows("platformSetting").find((r) => r.key === "spend:notify")!.value as Row;
    expect(stored).toMatchObject({ tenantId: "tn", phoneNumberId: "pn_n", senderDisplay: "+1 711-268-5789", templates: { approval: "spend_approval_v1", alert: "spend_alert_v1", digest: "spend_daily_v1", optin: "spend_optin_v1" } });
    expect(ledger("*").find((r) => r.action === "notify.sender.change" && r.phase === "applied")).toBeTruthy();
    rows("tenant").find((r) => r.id === "tn")!.status = "suspended";
    expect((await put({ section: "notifier", phoneNumberId: "pn_n", reason: "x" })).status).toBe(409);
  });

  it("the defaults: request expiry and Meta's change budget, which can never use more than Meta's 10 a day", async () => {
    seedWorld();
    expect((await put({ section: "defaults", approvalTtlHours: "12", metaCapRoutinePerDay: "7", metaCapEmergencyReserve: "4", reason: "x" })).status).toBe(400);
    expect((await put({ section: "defaults", approvalTtlHours: "49", metaCapRoutinePerDay: "6", metaCapEmergencyReserve: "4", reason: "x" })).status).toBe(400);
    const ok = await put({ section: "defaults", approvalTtlHours: "8", metaCapRoutinePerDay: "5", metaCapEmergencyReserve: "5", metaCapRaisesPerDay: "1", reason: "Tighter" });
    expect(ok.status).toBe(200);
    expect(((ok.body.settings as Row).defaults as Row)).toMatchObject({ approvalTtlHours: 8, metaCapRoutinePerDay: 5, metaCapEmergencyReserve: 5, metaCapRaisesPerDay: 1 });
    expect(parseSpendDefaults({ metaCapRoutinePerDay: 9, metaCapEmergencyReserve: 9 })).toMatchObject({ metaCapRoutinePerDay: 9, metaCapEmergencyReserve: 1 });
    expect(parseSpendDefaults(null)).toMatchObject({ approvalTtlHours: 12, metaCapRoutinePerDay: 6, metaCapEmergencyReserve: 4, metaCapRaisesPerDay: 2 });
  });

  it("every change needs a reason and a known section", async () => {
    seedWorld();
    expect((await put({ section: "ceiling", scope: "probation", pot: "ads", currency: "INR", daily: "1" })).body.error).toBe("Reason is required.");
    expect((await put({ section: "weather", reason: "x" })).status).toBe(400);
    expect((await settingsPut(req("/api/admin/spending/settings", "PUT", { section: "fx", currency: "USD", rate: "1", reason: "x" }, { cookie: null }))).status).toBe(404);
  });

  it("lists INR first, then other currencies, with the rate the INR row is read at", () => {
    const fx = parseFxTable({ rates: { USD: "84.10", SGD: "62.00" }, rateUpdatedAt: { USD: NOW.toISOString(), SGD: NOW.toISOString() } });
    const cells = ceilingCells([{ id: "r", scope: "probation", scopeId: "*", pot: "ads", currency: "INR", dailyMinor: 200_000n, monthlyMinor: 2_000_000n, reason: null, setByUserId: null, expiresAt: null, createdAt: null, updatedAt: null }], "probation", fx, NOW);
    const ads = cells.filter((c) => c.pot === "ads").map((c) => c.currency);
    expect(ads[0]).toBe("INR");
    expect(ads).toEqual(expect.arrayContaining(["USD", "SGD", "EUR"]));
    expect(cells.find((c) => c.currency === "USD")!.note).toBe("Uses the INR row at 84.10 INR for 1 USD.");
  });
});

// =====================================================================================================================
describe("plan ceilings are SpendCeiling rows with scope plan; the Plan table is unchanged", () => {
  it("reads the form fields: ads per day and month per currency (INR first), WhatsApp per month, AI credits per day", () => {
    const changes = parsePlanCeilings({ adsCeiling_INR_daily: "2,000", adsCeiling_INR_monthly: "20000", adsCeilingNew_currency: "USD", adsCeilingNew_daily: "25", adsCeilingNew_monthly: "", whatsappCeiling_INR_monthly: "5000", aiCeiling_daily: "40" });
    expect(changes).toEqual([
      { pot: "ads", currency: "INR", daily: 200_000n, monthly: 2_000_000n },
      { pot: "ads", currency: "USD", daily: 2_500n, monthly: null },
      { pot: "messaging", currency: "INR", monthly: 500_000n },
      { pot: "ai", currency: "CRD", daily: 40n },
    ]);
    expect(() => parsePlanCeilings({ adsCeiling_INR_daily: "abc" })).toThrow(/numbers only/);
    expect(() => parsePlanCeilings({ adsCeiling_INR_daily: "30000", adsCeiling_INR_monthly: "100" })).toThrow(/can't be more/);
    expect(() => parsePlanCeilings({ aiCeiling_daily: "1.5" })).toThrow();
  });

  it("updatePlan stores them as plan rows, changes only what changed, and the Plan row gets no ceiling columns", async () => {
    seedAdmin();
    h.db.seed("plan", [{ id: "p1", code: "pro", name: "Pro", pricePaise: 99_900, intervalMonths: 1, razorpayPlanId: null, features: {} }]);
    const body = { code: "pro", name: "Pro", priceRupees: "999", intervalMonths: "1", features: "{}", adsCeiling_INR_daily: "3000", adsCeiling_INR_monthly: "30000", whatsappCeiling_INR_monthly: "8000", aiCeiling_daily: "60" };
    await updatePlan(ADMIN_ID, "p1", body);
    const stored = await listCeilings({ scope: "plan", scopeId: "p1" });
    expect(stored.map((r) => [r.pot, r.currency, r.dailyMinor, r.monthlyMinor])).toEqual(
      expect.arrayContaining([
        ["ads", "INR", 300_000n, 3_000_000n],
        ["messaging", "INR", null, 800_000n],
        ["ai", "CRD", 60n, null],
      ]),
    );
    expect(Object.keys(rows("plan")[0])).not.toEqual(expect.arrayContaining(["adsCeiling_INR_daily"]));
    const ledgered = ledger("*").filter((r) => r.action === "ceiling.change" && r.phase === "applied").length;
    expect(ledgered).toBe(3);
    await updatePlan(ADMIN_ID, "p1", body); // nothing changed: no new ledger rows
    expect(ledger("*").filter((r) => r.action === "ceiling.change" && r.phase === "applied")).toHaveLength(3);
    await updatePlan(ADMIN_ID, "p1", { ...body, aiCeiling_daily: "" });
    expect((await listCeilings({ scope: "plan", scopeId: "p1" })).some((r) => r.pot === "ai")).toBe(false);
    expect(audits()).toContain("admin.plan.ceilings");
  });

  it("an older client that sends no ceiling fields changes no ceiling", async () => {
    seedAdmin();
    h.db.seed("plan", [{ id: "p1", code: "pro", name: "Pro", pricePaise: 99_900, intervalMonths: 1, razorpayPlanId: null, features: {} }]);
    h.db.seed("spendCeiling", [{ id: "pc", scope: "plan", scopeId: "p1", pot: "ads", currency: "INR", dailyMinor: 1n, monthlyMinor: 2n }]);
    await updatePlan(ADMIN_ID, "p1", { code: "pro", name: "Pro 2", priceRupees: "999", intervalMonths: "1", features: "{}" });
    expect(rows("spendCeiling")).toHaveLength(1);
    expect(await savePlanCeilings(ADMIN_ID, "p1", [])).toBe(0);
  });

  it("Duplicate copies the plan's ceilings to the copy, and Delete removes them", async () => {
    seedAdmin();
    h.db.seed("plan", [{ id: "p1", code: "pro", name: "Pro", pricePaise: 99_900, intervalMonths: 1, razorpayPlanId: null, features: {}, _count: { subscriptions: 0 } }]);
    h.db.seed("spendCeiling", [{ id: "pc", scope: "plan", scopeId: "p1", pot: "ads", currency: "INR", dailyMinor: 300_000n, monthlyMinor: 3_000_000n }]);
    const plan = h.db.prisma.plan as unknown as Row;
    const create = plan.create as (a: Row) => Promise<Row>;
    plan.create = async ({ data }: Row) => create({ data: { id: "p2", ...(data as Row) } }).then(() => ({ id: "p2", ...(data as Row) }));
    // The base fake has no delete; the plan row itself is not what this test is about.
    plan.delete = async ({ where }: Row) => {
      const i = rows("plan").findIndex((r) => r.id === (where as Row).id);
      return rows("plan").splice(i, 1)[0];
    };
    try {
      const { applyPlanAction } = await import("@/lib/admin/plans");
      await applyPlanAction(ADMIN_ID, "p1", { action: "duplicate" });
      expect((await listCeilings({ scope: "plan", scopeId: "p2" })).map((r) => [r.pot, r.currency, r.dailyMinor, r.monthlyMinor])).toEqual([["ads", "INR", 300_000n, 3_000_000n]]);
      await applyPlanAction(ADMIN_ID, "p1", { action: "delete", confirm: "pro" });
      expect(await listCeilings({ scope: "plan", scopeId: "p1" })).toEqual([]);
      expect(await listCeilings({ scope: "plan", scopeId: "p2" })).toHaveLength(1);
    } finally {
      plan.create = create;
      delete plan.delete;
    }
  });

  it("shows the stored rows back on the form, INR first even when empty", () => {
    const v = planCeilingValuesOf([{ id: "a", scope: "plan", scopeId: "p", pot: "ads", currency: "USD", dailyMinor: 2_550n, monthlyMinor: null, reason: null, setByUserId: null, expiresAt: null, createdAt: null, updatedAt: null }]);
    expect(v.ads).toEqual([
      { currency: "INR", daily: "", monthly: "" },
      { currency: "USD", daily: "25.50", monthly: "" },
    ]);
  });
});

// =====================================================================================================================
describe("small parsers", () => {
  it("amounts are typed in the main unit; empty means Not set; nonsense is refused", () => {
    expect(amountField({ v: "2,000.50" }, "v", "Daily", "INR")).toBe(200_050n);
    expect(amountField({ v: "" }, "v", "Daily", "INR")).toBeNull();
    expect(amountField({}, "v", "Daily", "INR")).toBeUndefined();
    expect(amountField({ v: "1500" }, "v", "Daily", "JPY")).toBe(1_500n);
    expect(() => amountField({ v: "1.5" }, "v", "Daily", "JPY")).toThrow(/whole amount/);
    expect(() => amountField({ v: { a: 1 } }, "v", "Daily", "INR")).toThrow(/not valid/);
  });

  it("an end date is the end of that day in UTC", () => {
    expect(endDateField({ endDate: "2026-11-30" }, NOW)).toEqual(new Date("2026-12-01T00:00:00Z"));
    expect(endDateField({}, NOW)).toBeNull();
    expect(() => endDateField({ endDate: "30/11/2026" }, NOW)).toThrow(/YYYY-MM-DD/);
  });

  it("names every audit action these pages write", () => {
    expect(ADMIN_SPEND_AUDIT_ACTIONS).toEqual(expect.arrayContaining(TENANT_SPEND_ACTIONS.map((a) => `admin.tenant.${a}`)));
    expect(ADMIN_SPEND_AUDIT_ACTIONS).toEqual(expect.arrayContaining(["admin.spend.stop_all", "admin.spend.stop_assistants", "admin.spend.resume", "admin.spend.fx", "admin.spend.notifier", "admin.spend.defaults", "admin.plan.ceilings"]));
  });
});

describe("adminVoice (QA 2026-10-30: the admin's workspace page spoke to the owner)", () => {
  it("says the owner's notes about the workspace and its owner", () => {
    expect(adminVoice("Your workspace is new, so lower limits apply for now. They go up after your first two payments, or ask support.")).toBe(
      "This workspace is new, so lower limits apply for now. They go up after its first two payments, or when you mark it verified.",
    );
    expect(adminVoice("Not set. Ads can't start until you set a daily limit.")).toBe("Not set. Ads can't start until the owner sets a daily limit.");
    expect(adminVoice("Not set. Your team and automations send as usual; assistants can't send until you set a limit.")).toBe(
      "Not set. The team and automations send as usual; assistants can't send until the owner sets a limit.",
    );
    expect(adminVoice("Not set. Your plan's monthly credits apply; assistants can't use AI until you set a limit.")).toBe(
      "Not set. The plan's monthly credits apply; assistants can't use AI until the owner sets a limit.",
    );
    expect(adminVoice("Choose which ad account Edwyz can spend from. Until you do, new ads can't start.")).toBe(
      "The owner chooses which ad account Edwyz can spend from. Until the owner does, new ads can't start.",
    );
  });

  it("leaves other text alone, including words that only start like a phrase", () => {
    expect(adminVoice("Ask the owner to choose a spending ad account.")).toBe("Ask the owner to choose a spending ad account.");
    expect(adminVoice("Your planned budget")).toBe("Your planned budget");
  });
});

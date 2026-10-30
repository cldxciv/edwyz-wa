import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * The workspace spend API (docs/SPEND-CONTROLS-SPEC.md 8.1, 8.4, 4.17, 9.1, 9.2; WP-16) through the real routes, the real
 * getActor (signed tokens, with the /api/spend/ paywall exemption), the real allowance rules, kill switch, ledger and Spend
 * Book on the in-memory spend database. Stand-ins: billing state, the job queue, and the ads service for undo of ads changes.
 */

process.env.SESSION_SECRET = "s".repeat(40);
process.env.EMAIL_VERIFICATION_REQUIRED = "false";
process.env.SITE_URL = "https://wa.test";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  billing: "active" as "active" | "locked" | "suspended",
  jobs: [] as { queue: string; payload: Record<string, unknown> }[],
  activate: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/billing", async () => {
  const { HttpError } = await import("@/lib/tenancy");
  return {
    getBillingStatus: vi.fn(async () => ({ state: h.billing, canWrite: h.billing === "active" })),
    assertTenantCanWrite: vi.fn(async () => {
      if (h.billing === "locked") throw new HttpError(402, "Your subscription is inactive. Your data is read-only until you subscribe at /app/billing.");
      if (h.billing === "suspended") throw new HttpError(403, "This workspace has been suspended.");
    }),
  };
});
vi.mock("@/lib/queue", () => ({
  enqueue: vi.fn(async (queue: string, payload: Record<string, unknown>) => {
    h.jobs.push({ queue, payload });
    return { id: `job_${h.jobs.length}` };
  }),
}));
vi.mock("@/lib/spend/tasks/adsguard", () => ({ stopInline: vi.fn(async () => ({ paused: 0, total: 0, failed: 0 })) }));
vi.mock("@/lib/ads/service", () => ({
  activateCampaign: vi.fn(async (...args: unknown[]) => (h.activate ? h.activate(...args) : { id: "c1" })),
  getCampaign: vi.fn(async () => ({ id: "c1", confirmTotalMinor: 150_000 })),
  pauseCampaign: vi.fn(async () => ({ id: "c1" })),
}));
vi.mock("@/lib/ads/actions", () => ({ pauseAdSet: vi.fn(async () => ({})), pauseAd: vi.fn(async () => ({})), setAdSetBudget: vi.fn(async () => ({})), resumeAd: vi.fn(async () => ({})) }));

import { PUT as putAllowances } from "@/app/api/spend/allowances/route";
import { GET as getControlRoute, PUT as putControl } from "@/app/api/spend/control/route";
import { GET as getLedger, POST as postLedger } from "@/app/api/spend/ledger/route";
import { GET as getSummary } from "@/app/api/spend/summary/route";
import { activateCampaign } from "@/lib/ads/service";
import { signAccessToken } from "@/lib/auth/tokens";
import { resetBookForTests } from "@/lib/spend/book";
import { SpendBlockedError } from "@/lib/spend/errors";
import { resetSpendStateCache } from "@/lib/spend/kill";
import { appendStandalone } from "@/lib/spend/ledger";
import { NO_AD_ACCOUNT_NOTE, NO_WHATSAPP_NOTE, SAMPLE_DATA_NOTE, buildBanners, classifyUndo, loadApprovalByToken } from "@/lib/spend/summary";
import { hashApprovalToken } from "@/lib/spend/approval-token";
import { SPEND_QUEUES } from "@/lib/spend/types";

const T = "t1";
const NOW = new Date("2026-10-28T06:30:00Z");
const ORIGIN = "https://wa.test";
type Who = { userId: string; tenantId: string; role: "owner" | "admin" | "agent" };
const OWNER: Who = { userId: "u_owner", tenantId: T, role: "owner" };
const ADMIN: Who = { userId: "u_admin", tenantId: T, role: "admin" };
const ADMIN2: Who = { userId: "u_admin2", tenantId: T, role: "admin" };
const AGENT: Who = { userId: "u_agent", tenantId: T, role: "agent" };

const rows = (name: string) => h.db.rows(name);
const ledger = () => rows("spendLedger");
const allowance = (pot: string) => rows("spendAllowance").find((r) => r.tenantId === T && r.pot === pot);

function req(who: Who | null, path: string, method = "GET", body?: unknown, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who) headers.authorization = `Bearer ${signAccessToken({ sub: who.userId, tid: who.tenantId, role: who.role })}`;
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Row });
const summaryAs = async (who: Who | null, q = "") => json(await getSummary(req(who, `/api/spend/summary${q}`)));
const putLimits = async (who: Who, body: Row, origin: string | null = ORIGIN) => json(await putAllowances(req(who, "/api/spend/allowances", "PUT", body, origin)));
const putCtl = async (who: Who, body: Row) => json(await putControl(req(who, "/api/spend/control", "PUT", body)));
const ledgerAs = async (who: Who, q = "") => getLedger(req(who, `/api/spend/ledger${q}`));
const undo = async (who: Who, id: string) => json(await postLedger(req(who, "/api/spend/ledger", "POST", { undo: id })));

function seedBase(opts: { control?: boolean; adAccount?: boolean; phone?: boolean; demo?: boolean } = {}) {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false, trialEndsAt: null, createdAt: new Date("2026-10-25T00:00:00Z") }]);
  h.db.seed("user", [
    { id: OWNER.userId, name: "Priya", email: "priya@example.com" },
    { id: ADMIN.userId, name: "Ravi", email: "ravi@example.com" },
    { id: ADMIN2.userId, name: "Meena", email: "meena@example.com" },
    { id: AGENT.userId, name: "Asha", email: "asha@example.com" },
  ]);
  h.db.seed("membership", [OWNER, ADMIN, ADMIN2, AGENT].map((m) => ({ id: `m_${m.userId}`, ...m })));
  // The three rows 0009 seeds (12.1a decision 3).
  h.db.seed("spendCeiling", [
    { id: "sc1", scope: "probation", scopeId: "*", pot: "ads", currency: "INR", dailyMinor: 200_000n, monthlyMinor: 2_000_000n, reason: "seed" },
    { id: "sc2", scope: "probation", scopeId: "*", pot: "messaging", currency: "INR", dailyMinor: 50_000n, monthlyMinor: 500_000n, reason: "seed" },
    { id: "sc3", scope: "probation", scopeId: "*", pot: "ai", currency: "CRD", dailyMinor: null, monthlyMinor: 500n, reason: "seed" },
  ]);
  if (opts.adAccount !== false) {
    h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Edwyz Store", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata", ...(opts.demo ? { demo: true } : {}) }, sandbox: false, createdAt: new Date("2026-01-01") }]);
  }
  if (opts.phone) h.db.seed("phoneNumber", [{ id: "pn1", tenantId: T, wabaRefId: "w1", phoneNumberId: "PN1", displayPhone: "+15550001", status: "connected" }]);
  if (opts.control !== false) h.db.seed("spendControl", [{ tenantId: T, probation: "auto", spendingAdAccountAssetId: opts.adAccount === false ? null : "acc1", timezone: "Asia/Kolkata", approverUserIds: [ADMIN.userId] }]);
}

beforeAll(() => {
  // getActor reads the membership by its compound key with the user and workspace: give the base fake that lookup.
  const membership = h.db.prisma.membership as unknown as Row;
  membership.findUnique = async ({ where }: Row) => {
    const key = (where as Row).tenantId_userId as Row;
    const m = rows("membership").find((r) => r.tenantId === key.tenantId && r.userId === key.userId);
    return m ? { ...m, user: { disabledAt: null, emailVerifiedAt: new Date("2026-01-01") }, tenant: { deletedAt: null } } : null;
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.db.reset();
  h.billing = "active";
  h.jobs = [];
  h.activate = null;
  delete process.env.SPEND_ENFORCE;
  resetSpendStateCache();
  resetBookForTests();
  vi.mocked(activateCampaign).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

// =====================================================================================================================
describe("GET /api/spend/summary: every role, every workspace state", () => {
  it("answers the owner, an admin and a team member with their own shape, never ledger rows for a team member", async () => {
    seedBase({ phone: true });
    h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: 200_000n, monthlyLimitMinor: 2_000_000n, version: 3 }]);
    const owner = await summaryAs(OWNER);
    const admin = await summaryAs(ADMIN);
    const agent = await summaryAs(AGENT);
    expect([owner.status, admin.status, agent.status]).toEqual([200, 200, 200]);
    const o = owner.body.summary as Row;
    const a = admin.body.summary as Row;
    const m = agent.body.summary as Row;
    expect(o.role).toBe("owner");
    expect(o).toHaveProperty("controlSettings");
    expect(o).toHaveProperty("approvals");
    expect((o.admins as Row[]).map((x) => x.name).sort()).toEqual(["Meena", "Ravi"]);
    expect(a.role).toBe("admin");
    expect(a).toHaveProperty("approvals");
    expect(a.roleNote).toBe("You can lower limits or stop spending. Only the owner can raise a limit.");
    expect(m.role).toBe("agent");
    for (const key of ["approvals", "controlSettings", "notify", "yesterday"]) expect(m).not.toHaveProperty(key);
    expect(m.roleNote).toBe("Only the owner can change spending limits. Ask them if you need more.");
    expect((m.capabilities as Row).canSeeActivity).toBe(false);
    expect((o.capabilities as Row).canRaiseLimits).toBe(true);
    expect((a.capabilities as Row).canRaiseLimits).toBe(false);
    expect((a.capabilities as Row).canApproveRaises).toBe(true); // named as an approver
  });

  it("sends amounts as decimal strings of minor units plus formatted text, and 'Not set' as null", async () => {
    seedBase({ phone: true });
    h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: 175_000n, monthlyLimitMinor: 2_000_000n, version: 1 }]);
    const s = (await summaryAs(OWNER)).body.summary as Row;
    const ads = (s.pots as Row).ads as Row;
    expect((ads.limits as Row).daily).toEqual({ minor: "175000", currency: "INR", formatted: "₹1,750" });
    expect((ads.month as Row).spent).toEqual({ minor: "0", currency: "INR", formatted: "₹0" });
    const messaging = (s.pots as Row).messaging as Row;
    expect((messaging.limits as Row).daily).toBeNull();
    expect((messaging.limits as Row).monthly).toBeNull();
    expect(messaging.notes).toContain("Not set. Your team and automations send as usual; assistants can't send until you set a limit.");
    expect((s.probation as Row).note).toContain("A ₹2,000 daily limit allows ads with up to ₹1,142 a day in total budget.");
    expect((s.timezones as Row).text).toBe("Days and months follow Asia/Kolkata time, the same as your ad account.");
  });

  it("creates the missing SpendControl row with its safe defaults on the first read (I11)", async () => {
    seedBase({ control: false });
    expect(rows("spendControl")).toHaveLength(0);
    const res = await summaryAs(AGENT);
    expect(res.status).toBe(200);
    expect(rows("spendControl")).toHaveLength(1);
    expect(rows("spendControl")[0]).toMatchObject({ tenantId: T, freeze: "none", probation: "auto", spendingAdAccountAssetId: "acc1" });
  });

  it("works with no Meta connection: no Meta card, limits can be set ahead in a chosen currency", async () => {
    seedBase({ adAccount: false });
    const s = (await summaryAs(OWNER)).body.summary as Row;
    const ads = (s.pots as Row).ads as Row;
    expect(s.metaLimit).toBeNull();
    expect(ads.connected).toBe(false);
    expect(ads.notes).toContain(NO_AD_ACCOUNT_NOTE);
    expect(ads.notes).toContain("Not set. Ads can't start until you set a daily limit.");
    expect((ads.edit as Row).canChangeCurrency).toBe(true);
    expect((ads.edit as Row).currencyOptions).toEqual(expect.arrayContaining(["INR", "USD", "EUR", "GBP", "AED"]));
    expect((s.timezones as Row).text).toBe("Days and months follow Asia/Kolkata time.");
  });

  it("works with no WhatsApp number", async () => {
    seedBase({ phone: false });
    const s = (await summaryAs(ADMIN)).body.summary as Row;
    expect(((s.pots as Row).messaging as Row).notes).toContain(NO_WHATSAPP_NOTE);
    expect(((s.pots as Row).messaging as Row).connected).toBe(false);
  });

  it("labels the demo workspace 'Sample data' and keeps Meta's limit out of it", async () => {
    seedBase({ demo: true });
    const s = (await summaryAs(OWNER)).body.summary as Row;
    expect(s.demo).toBe(true);
    expect(((s.pots as Row).ads as Row).sampleData).toBe(true);
    expect(((s.pots as Row).ads as Row).notes).toContain(SAMPLE_DATA_NOTE);
    expect((s.metaLimit as Row).state).toBe("demo");
    expect((s.metaLimit as Row).text).toBe("Demo account: Meta's limit isn't used.");
  });

  it.each(["locked", "suspended"] as const)("still answers in a %s workspace, and says so", async (state) => {
    seedBase();
    h.billing = state;
    for (const who of [OWNER, ADMIN, AGENT]) {
      const res = await summaryAs(who);
      expect(res.status).toBe(200);
      expect((res.body.summary as Row).workspaceState).toBe(state);
    }
  });

  it("refuses a signed-out request with 401", async () => {
    seedBase();
    expect((await summaryAs(null)).status).toBe(401);
  });

  it("?view=banner answers only the banners, highest priority first", async () => {
    seedBase();
    h.db.rows("spendControl")[0].freeze = "all";
    h.db.rows("spendControl")[0].frozenAt = NOW;
    const res = await summaryAs(AGENT, "?view=banner");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("summary");
    const kinds = (res.body.banners as Row[]).map((b) => b.kind);
    expect(kinds[0]).toBe("workspace_stopped");
    expect(kinds).toContain("new_workspace");
    expect((res.body.banner as Row).text).toContain("Only the owner can turn spending back on.");
  });
});

// =====================================================================================================================
describe("PUT /api/spend/allowances: the per-field rule", () => {
  beforeEach(() => {
    seedBase();
    h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: 200_000n, monthlyLimitMinor: 2_000_000n, version: 3 }]);
  });

  it("lets an admin lower a limit, ledgers it and answers with the fresh summary", async () => {
    const res = await putLimits(ADMIN, { pot: "ads", dailyLimitMinor: "150000", version: 3 });
    expect(res.status).toBe(200);
    expect(allowance("ads")).toMatchObject({ dailyLimitMinor: 150_000n, version: 4 });
    expect(ledger().filter((r) => r.action === "allowance.change").map((r) => r.phase)).toEqual(["requested", "applied"]);
    expect((((res.body.summary as Row).pots as Row).ads as Row).limits).toMatchObject({ daily: { minor: "150000", formatted: "₹1,500" }, version: 4 });
    expect(res.body).toMatchObject({ enforce: "observe", wouldRefuse: false });
  });

  it("refuses an admin's raise with 403 and the 4.13 copy, and ledgers the refusal", async () => {
    const res = await putLimits(ADMIN, { pot: "ads", dailyLimitMinor: "250000", version: 3 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Only the owner can raise a limit. You can lower it.", code: "spend.only_owner_raise" });
    expect(allowance("ads")?.dailyLimitMinor).toBe(200_000n);
    expect(ledger().find((r) => r.phase === "refused")).toMatchObject({ action: "allowance.change", actorType: "user", actorId: ADMIN.userId });
  });

  it("refuses an admin turning Not set into a number (decision 2.3.8)", async () => {
    const res = await putLimits(ADMIN, { pot: "messaging", monthlyLimitMinor: "100000", version: 0 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the owner can raise a limit. You can lower it.");
    expect(allowance("messaging")).toBeUndefined();
  });

  it("refuses a team member with 403", async () => {
    const res = await putLimits(AGENT, { pot: "ads", dailyLimitMinor: "100000", version: 3 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the owner can change spending limits. Ask them if you need more.");
  });

  it("answers a stale version with 409 and the copy", async () => {
    const res = await putLimits(OWNER, { pot: "ads", dailyLimitMinor: "100000", version: 2 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "Someone else changed these limits. Reload to see the latest.", code: "spend.version" });
  });

  it("lets the owner raise, and queues the Meta-limit re-plan when the ads monthly limit changes", async () => {
    const res = await putLimits(OWNER, { pot: "ads", monthlyLimitMinor: "3000000", version: 3 });
    expect(res.status).toBe(200);
    expect(allowance("ads")?.monthlyLimitMinor).toBe(3_000_000n);
    expect(h.jobs).toEqual([{ queue: SPEND_QUEUES.metacapReplan, payload: expect.objectContaining({ tenantId: T, adAccountAssetId: "acc1", reason: "ads_monthly_limit_changed" }) }]);
    // A daily-only change does not re-plan.
    h.jobs = [];
    await putLimits(OWNER, { pot: "ads", dailyLimitMinor: "100000", version: 4 });
    expect(h.jobs).toEqual([]);
  });

  it("lowers in a locked or suspended workspace; only raising gets the paywall (4.17)", async () => {
    h.billing = "locked";
    expect((await putLimits(ADMIN, { pot: "ads", dailyLimitMinor: "100000", version: 3 })).status).toBe(200);
    const raise = await putLimits(OWNER, { pot: "ads", dailyLimitMinor: "190000", version: 4 });
    expect(raise.status).toBe(402);
    expect(allowance("ads")?.dailyLimitMinor).toBe(100_000n);
    // An admin's raise is a 403 (the copy), not a 402, even when locked.
    expect((await putLimits(ADMIN, { pot: "ads", dailyLimitMinor: "190000", version: 4 })).status).toBe(403);
    h.billing = "suspended";
    expect((await putLimits(OWNER, { pot: "ads", dailyLimitMinor: "90000", version: 4 })).status).toBe(200);
  });

  it("is same-origin only, and refuses bad input with a plain sentence", async () => {
    expect((await putLimits(OWNER, { pot: "ads", dailyLimitMinor: "100000", version: 3 }, "https://evil.example")).status).toBe(403);
    const bad = await putLimits(OWNER, { pot: "ads", dailyLimitMinor: "12.5", version: 3 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Enter the daily limit as a whole number, or leave it empty for Not set.");
    expect((await putLimits(OWNER, { pot: "rent", version: 3 })).status).toBe(400);
  });
});

// =====================================================================================================================
describe("GET and PUT /api/spend/control: owner only", () => {
  beforeEach(() => seedBase());

  it("refuses admins and team members, and ledgers a refused change", async () => {
    expect((await json(await getControlRoute(req(ADMIN, "/api/spend/control")))).status).toBe(403);
    const res = await putCtl(AGENT, { version: 1, digestEnabled: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the owner can change these settings.");
    expect(ledger().find((r) => r.action === "control.change")).toMatchObject({ phase: "refused", actorId: AGENT.userId });
  });

  it("saves approvers (admins only) and the request expiry (1-48 hours), ledgered with an undo recipe", async () => {
    const res = await putCtl(OWNER, { version: 1, approverUserIds: [ADMIN2.userId], approvalTtlHours: 6 });
    expect(res.status).toBe(200);
    expect(res.body.control).toMatchObject({ approverUserIds: [ADMIN2.userId], approvalTtlHours: 6, approvers: [{ userId: ADMIN2.userId, name: "Meena" }] });
    const applied = ledger().find((r) => r.action === "control.change" && r.phase === "applied")!;
    expect(applied.undo).toMatchObject({ action: "set_control", fields: { approverUserIds: [ADMIN.userId], approvalTtlHours: 12 } });
    expect((await putCtl(OWNER, { version: 2, approverUserIds: [AGENT.userId] })).status).toBe(400);
    expect((await putCtl(OWNER, { version: 2, approvalTtlHours: 49 })).body.error).toBe("Choose between 1 and 48 hours.");
    expect((await putCtl(OWNER, { version: 1, digestEnabled: false })).status).toBe(409);
  });

  it("starts a new time zone at the next local midnight, not now", async () => {
    const res = await putCtl(OWNER, { version: 1, timezone: "Europe/London" });
    expect(res.status).toBe(200);
    expect(rows("spendControl")[0].timezone).toBe("Asia/Kolkata");
    expect(res.body.control).toMatchObject({ timezone: "Asia/Kolkata", pendingTimezone: { timezone: "Europe/London", effectiveAt: "2026-10-28T18:30:00.000Z" } });
    vi.setSystemTime(new Date("2026-10-28T18:31:00Z"));
    const s = (await summaryAs(OWNER)).body.summary as Row;
    expect(rows("spendControl")[0].timezone).toBe("Europe/London");
    expect(s.pendingTimezone).toBeNull();
    expect((s.timezones as Row).text).toBe("Ads days follow Asia/Kolkata (your ad account). WhatsApp and AI days follow Europe/London.");
  });

  it("changes the spending ad account only after the old account's Meta-limit choice, and re-plans", async () => {
    h.db.seed("metaAsset", [{ id: "acc2", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_222", name: "Shop US", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: false }]);
    h.db.seed("metaSpendLimit", [{ adAccountAssetId: "acc1", tenantId: T, accountExternalId: "act_111", mode: "managed" }]);
    const ask = await putCtl(OWNER, { version: 1, spendingAdAccountAssetId: "acc2" });
    expect(ask.status).toBe(409);
    expect(ask.body.error).toMatch(/^Choose what happens to Meta's spending limit/);
    const ok = await putCtl(OWNER, { version: 1, spendingAdAccountAssetId: "acc2", offboardChoice: "keep" });
    expect(ok.status).toBe(200);
    expect(rows("spendControl")[0].spendingAdAccountAssetId).toBe("acc2");
    expect(h.jobs.map((j) => j.queue)).toEqual([SPEND_QUEUES.metacapOffboard, SPEND_QUEUES.metacapReplan]);
    expect(h.jobs[0].payload).toMatchObject({ adAccountAssetId: "acc1", choice: "keep", trigger: "account_change" });
  });

  it("only the spending account change is paywalled in a locked workspace", async () => {
    h.billing = "locked";
    expect((await putCtl(OWNER, { version: 1, digestEnabled: false })).status).toBe(200);
    h.db.seed("metaAsset", [{ id: "acc2", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_222", name: "Shop US", status: "active", meta: {}, sandbox: false }]);
    expect((await putCtl(OWNER, { version: 2, spendingAdAccountAssetId: "acc2" })).status).toBe(402);
  });
});

// =====================================================================================================================
function seedLedger(n: number) {
  for (let i = 0; i < n; i++) {
    const pot = i % 2 === 0 ? "ads" : "messaging";
    h.db.seed("spendLedger", [
      { id: `l${i}a`, tenantId: T, pot, action: "allowance.change", phase: "requested", actorType: "user", actorId: OWNER.userId, reason: `Change ${i}`, reasonCodes: ["allowance_lower"], currency: "INR", before: { currency: "INR", dailyLimitMinor: "200000" }, after: { currency: "INR", dailyLimitMinor: "100000" }, undo: { action: "set_allowance", pot, currency: "INR", dailyLimitMinor: "200000", monthlyLimitMinor: null }, correlationId: `c${i}`, createdAt: new Date(NOW.getTime() - (n - i) * 60_000) },
      { id: `l${i}b`, tenantId: T, pot, action: "allowance.change", phase: "applied", actorType: "user", actorId: OWNER.userId, reason: `Change ${i}`, reasonCodes: ["allowance_lower"], currency: "INR", before: { currency: "INR", dailyLimitMinor: "200000" }, after: { currency: "INR", dailyLimitMinor: "100000" }, undo: { action: "set_allowance", pot, currency: "INR", dailyLimitMinor: "200000", monthlyLimitMinor: null }, correlationId: `c${i}`, createdAt: new Date(NOW.getTime() - (n - i) * 60_000 + 1) },
    ]);
  }
}

describe("GET /api/spend/ledger: admins and the owner, seq cursor, CSV", () => {
  beforeEach(() => seedBase());

  it("refuses a team member", async () => {
    const res = await ledgerAs(AGENT);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Row).error).toBe("Only owners and admins can see spending activity.");
  });

  it("pages newest first by seq cursor, one row per decision", async () => {
    seedLedger(3);
    const first = (await (await ledgerAs(ADMIN, "?limit=2")).json()) as Row;
    expect((first.rows as Row[]).map((r) => r.id)).toEqual(["l2b"]);
    expect(first.nextCursor).toBeTruthy();
    const second = (await (await ledgerAs(ADMIN, `?limit=2&cursor=${first.nextCursor}`)).json()) as Row;
    expect((second.rows as Row[]).map((r) => r.id)).toEqual(["l1b"]);
    const all = (await (await ledgerAs(OWNER, "?limit=100")).json()) as Row;
    expect((all.rows as Row[]).map((r) => r.id)).toEqual(["l2b", "l1b", "l0b"]);
    const row = (all.rows as Row[])[0];
    expect(row).toMatchObject({ phase: "applied", actor: { type: "user", label: "Priya" }, summary: "Ads daily limit ₹2,000 -> ₹1,000", reason: "Change 2" });
    expect((await ledgerAs(OWNER, "?cursor=abc")).status).toBe(400);
  });

  it("filters by area", async () => {
    seedLedger(4);
    const res = (await (await ledgerAs(ADMIN, "?filter=whatsapp")).json()) as Row;
    expect((res.rows as Row[]).every((r) => r.pot === "messaging")).toBe(true);
    expect((res.rows as Row[])).toHaveLength(2);
    expect((await ledgerAs(ADMIN, "?filter=rent")).status).toBe(400);
  });

  it("exports CSV with a header row, formula-safe cells", async () => {
    seedLedger(1);
    h.db.seed("spendLedger", [{ id: "lx", tenantId: T, pot: "none", action: "control.change", phase: "info", actorType: "user", actorId: OWNER.userId, reason: "=HYPERLINK(1)", reasonCodes: [], correlationId: "cx", createdAt: NOW }]);
    const res = await ledgerAs(OWNER, "?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text).toContain("When,Who,What,Could add today (worst case),Could add this month (worst case),Why,Result");
    expect(text).toContain("'=HYPERLINK(1)");
    expect(text).not.toMatch(/minor units|probation/i);
  });
});

// =====================================================================================================================
describe("POST /api/spend/ledger: undo within 14 days", () => {
  beforeEach(() => {
    seedBase();
    h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: 200_000n, monthlyLimitMinor: 2_000_000n, version: 1 }]);
  });

  it("lets an admin undo the owner's raise (a lowering), once", async () => {
    expect((await putLimits(OWNER, { pot: "ads", dailyLimitMinor: "250000", version: 1 })).status).toBe(200);
    const page = (await (await ledgerAs(ADMIN)).json()) as Row;
    const row = (page.rows as Row[]).find((r) => r.action === "allowance.change")!;
    expect(row.undo).toMatchObject({ available: true, isRaise: false });
    const res = await undo(ADMIN, String(row.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isRaise: false, enforce: "observe", wouldRefuse: false });
    expect(allowance("ads")?.dailyLimitMinor).toBe(200_000n);
    expect(ledger().some((r) => r.action === "ledger.undo" && r.phase === "info")).toBe(true);
    const again = await undo(ADMIN, String(row.id));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("This change was already undone.");
  });

  it("an undo that raises is owner only, goes through the allowance rules and the paywall", async () => {
    expect((await putLimits(ADMIN, { pot: "ads", dailyLimitMinor: "150000", version: 1 })).status).toBe(200);
    const page = (await (await ledgerAs(ADMIN)).json()) as Row;
    const row = (page.rows as Row[]).find((r) => r.action === "allowance.change")!;
    expect(row.undo).toMatchObject({ available: false, isRaise: true });
    const refused = await undo(ADMIN, String(row.id));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Only the owner can undo this, because undoing it raises spending. You can lower spending yourself.");
    h.billing = "locked";
    expect((await undo(OWNER, String(row.id))).status).toBe(402);
    h.billing = "active";
    const ok = await undo(OWNER, String(row.id));
    expect(ok.status).toBe(200);
    expect(ok.body.isRaise).toBe(true);
    expect(allowance("ads")?.dailyLimitMinor).toBe(200_000n);
  });

  it("undoing a stop's pause resumes through the ads service (reserveAds), and a refusal comes back with its copy", async () => {
    h.db.seed("adCampaign", [{ id: "c1", tenantId: T, adAccountAssetId: "acc1", metaCampaignId: "m_c1", name: "Diwali leads", status: "paused", dailyBudgetMinor: 150_000, currency: "INR" }]);
    const pause = { tenantId: T, pot: "ads", action: "ads.campaign.pause", actorType: "user", actorId: ADMIN.userId, reason: "Stopped all spending.", reasonCodes: ["stop"], targetType: "campaign", targetId: "c1", metaObjectId: "m_c1", undo: { action: "resume_campaign", metaObjectId: "m_c1" }, correlationId: "cp" };
    h.db.seed("spendLedger", [
      { id: "p1", phase: "requested", createdAt: new Date(NOW.getTime() - 60_000), ...pause },
      { id: "p2", phase: "applied", createdAt: new Date(NOW.getTime() - 59_000), ...pause },
    ]);
    const rowsSeen = ((await (await ledgerAs(OWNER)).json()) as Row).rows as Row[];
    expect(rowsSeen[0]).toMatchObject({ id: "p2", summary: "Paused 'Diwali leads'", undo: { available: true, isRaise: true } });
    expect((await undo(ADMIN, "p2")).status).toBe(403);
    h.activate = async () => {
      throw new SpendBlockedError("spend.daily_limit", { left: { minor: 85_000n, currency: "INR" }, needs: { minor: 140_000n, currency: "INR" } });
    };
    const refused = await undo(OWNER, "p2");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      "This would go over your ads limit for today. Left today: ₹850. This could spend up to ₹1,400 today, because Meta can spend up to 75% over a daily budget. Lower the daily budget or raise your limit.",
    );
    expect(vi.mocked(activateCampaign).mock.calls[0]).toEqual([expect.objectContaining({ tenantId: T, role: "owner" }), "c1", { confirm: true, confirmedTotalMinor: 150_000 }, "resume", expect.anything()]);
    h.activate = null;
    expect((await undo(OWNER, "p2")).status).toBe(200);
  });

  it("returns observe mode's would-refuse flag when the book let a raise through in observe mode", async () => {
    h.db.seed("adCampaign", [{ id: "c1", tenantId: T, adAccountAssetId: "acc1", metaCampaignId: "m_c1", name: "Diwali leads", status: "paused", dailyBudgetMinor: 150_000, currency: "INR" }]);
    const pause = { tenantId: T, pot: "ads", action: "ads.campaign.pause", actorType: "user", actorId: OWNER.userId, reason: "Paused.", reasonCodes: [], targetType: "campaign", targetId: "c1", undo: { action: "resume_campaign", metaObjectId: "m_c1" }, correlationId: "cq" };
    h.db.seed("spendLedger", [{ id: "q1", phase: "applied", createdAt: new Date(NOW.getTime() - 1000), ...pause }]);
    h.activate = async () => {
      await appendStandalone({ tenantId: T, pot: "ads", action: "ads.campaign.activate", phase: "refused", observe: true, actor: { type: "user", userId: OWNER.userId, role: "owner" }, reason: "This would go over your ads limit for today." });
      return { id: "c1" };
    };
    const res = await undo(OWNER, "q1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ wouldRefuse: true, wouldRefuseReasons: ["This would go over your ads limit for today."] });
  });

  it("undoing a budget raise after the budget was cut below the recipe is a raise: owner only, and through the paywall", async () => {
    const raise = { tenantId: T, pot: "ads", action: "ads.adset.budget_raise", actorType: "user", actorId: ADMIN.userId, reason: "Raised.", reasonCodes: [], targetType: "adset", targetId: "c1", metaObjectId: "m_s1", undo: { action: "set_adset_budget", metaAdSetId: "m_s1", dailyBudgetMinor: "80000" }, correlationId: "cb" };
    h.db.seed("spendLedger", [{ id: "b1", phase: "applied", createdAt: new Date(NOW.getTime() - 60_000), ...raise }]);
    // Since the raise to ₹1,000 a safety stop cut it to ₹300: restoring ₹800 raises it.
    h.db.seed("adSet", [{ id: "s1", tenantId: T, campaignId: "c1", metaAdSetId: "m_s1", dailyBudgetMinor: 100_000 }]);
    h.db.seed("spendCommitment", [{ id: "cm1", tenantId: T, metaObjectId: "m_s1", objectLevel: "adset", status: "live", dailyBudgetMinor: 30_000n, currency: "INR" }]);
    const { setAdSetBudget } = await import("@/lib/ads/actions");
    const refused = await undo(ADMIN, "b1");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Only the owner can undo this, because undoing it raises spending. You can lower spending yourself.");
    h.billing = "locked";
    expect((await undo(OWNER, "b1")).status).toBe(402);
    h.billing = "active";
    expect(vi.mocked(setAdSetBudget)).not.toHaveBeenCalled();
    expect((await undo(OWNER, "b1")).status).toBe(200);
    expect(vi.mocked(setAdSetBudget).mock.calls.at(-1)?.slice(1, 3)).toEqual(["m_s1", 80_000]);
    // Still a lowering when the budget is above the recipe: an admin may undo it.
    h.db.seed("spendLedger", [{ id: "b2", phase: "applied", createdAt: new Date(NOW.getTime() - 30_000), ...raise, correlationId: "cb2" }]);
    rows("spendCommitment")[0].dailyBudgetMinor = 100_000n;
    expect((await undo(ADMIN, "b2")).status).toBe(200);
  });

  it("refuses an undo older than 14 days, and rows without a recipe", async () => {
    const base = { tenantId: T, pot: "ads", action: "allowance.change", actorType: "user", actorId: OWNER.userId, reason: "Old", reasonCodes: ["allowance_raise"], before: { currency: "INR", dailyLimitMinor: "100000" }, after: { currency: "INR", dailyLimitMinor: "200000" }, undo: { action: "set_allowance", pot: "ads", currency: "INR", dailyLimitMinor: "100000", monthlyLimitMinor: "2000000" } };
    h.db.seed("spendLedger", [{ id: "old", phase: "applied", correlationId: "co", createdAt: new Date(NOW.getTime() - 15 * 86_400_000), ...base }]);
    h.db.seed("spendLedger", [{ id: "info", tenantId: T, pot: "none", action: "notify.alert", phase: "info", actorType: "system", reason: "Sent", reasonCodes: [], correlationId: "ci", createdAt: NOW }]);
    expect((await undo(OWNER, "old")).body.error).toBe("Changes can be undone for 14 days. This one is older.");
    expect((await undo(OWNER, "info")).status).toBe(409);
    expect((await undo(OWNER, "nope")).status).toBe(404);
  });
});

// =====================================================================================================================
describe("pure rules", () => {
  it("classifies undo recipes: undoing a raise lowers, undoing a lowering or Not set raises", () => {
    const row = (before: Row, after: Row) => ({ action: "allowance.change", undo: { action: "set_allowance" }, reasonCodes: [], before, after });
    expect(classifyUndo(row({ currency: "INR", dailyLimitMinor: "100" }, { currency: "INR", dailyLimitMinor: "200" }))).toMatchObject({ isRaise: false });
    expect(classifyUndo(row({ currency: "INR", dailyLimitMinor: "200" }, { currency: "INR", dailyLimitMinor: "100" }))).toMatchObject({ isRaise: true });
    expect(classifyUndo(row({ currency: "INR", dailyLimitMinor: null }, { currency: "INR", dailyLimitMinor: "100" }))).toMatchObject({ isRaise: true });
    expect(classifyUndo({ action: "x", undo: { action: "resume_campaign" }, reasonCodes: [], before: null, after: null })).toMatchObject({ supported: true, isRaise: true });
    expect(classifyUndo({ action: "x", undo: { action: "pause_campaign" }, reasonCodes: [], before: null, after: null })).toMatchObject({ supported: true, isRaise: false });
    expect(classifyUndo({ action: "x", undo: { action: "restore_end" }, reasonCodes: [], before: null, after: null }).supported).toBe(false);
    expect(classifyUndo({ action: "kill.workspace", undo: { action: "set_freeze", level: "none" }, reasonCodes: ["freeze_all"], before: { freeze: "none" }, after: null })).toMatchObject({ isRaise: true, ownerOnly: true });
    expect(classifyUndo({ action: "kill.workspace", undo: { action: "set_freeze", level: "all" }, reasonCodes: ["freeze_none"], before: { freeze: "all" }, after: null })).toMatchObject({ isRaise: false });
  });

  it("orders banners as 8.2 says, with owner-only items for owners", () => {
    const base = { tenantId: T, freeze: { workspace: "none" as const, platform: "none" as const }, limitReached: { adsMonth: false, adsToday: false, messaging: false, ai: false }, approvals: { waiting: 0, canDecide: false }, metaState: null, newWorkspace: false, needsAccountChoice: false };
    expect(buildBanners({ ...base, role: "owner" })).toEqual([]);
    const all = buildBanners({
      ...base,
      role: "owner",
      freeze: { workspace: "all", platform: "all" },
      limitReached: { adsMonth: true, adsToday: false, messaging: false, ai: false },
      approvals: { waiting: 2, canDecide: true },
      metaState: "pending_owner",
      newWorkspace: true,
      needsAccountChoice: true,
    });
    expect(all.map((b) => b.kind)).toEqual(["platform_frozen", "workspace_stopped", "limit_reached", "approvals_waiting", "new_workspace", "choose_spending_account", "meta_limit_waiting_owner"]);
    expect(all.find((b) => b.kind === "approvals_waiting")?.text).toBe("2 spending requests are waiting");
    expect(all.find((b) => b.kind === "limit_reached")?.text).toBe("Ads are paused: this month's ads limit is used up.");
    const agent = buildBanners({ ...base, role: "agent", metaState: "pending_owner", needsAccountChoice: true, approvals: { waiting: 2, canDecide: false } });
    expect(agent).toEqual([]);
    expect(buildBanners({ ...base, role: "admin", metaState: "no_permission" }).map((b) => b.kind)).toEqual(["meta_limit_attention"]);
  });
});

// =====================================================================================================================
describe("the one-tap link's loader (7.4)", () => {
  const TOKEN = "A".repeat(43);
  beforeEach(() => {
    seedBase();
    h.db.seed("spendApproval", [
      {
        id: "sp1",
        tenantId: T,
        assistantKey: "ads_optimizer",
        pot: "ads",
        actionKind: "raise_budget",
        direction: "raise",
        intent: {},
        fingerprint: "fp",
        summary: "Raise the daily budget of 'Diwali leads - Delhi' from ₹800 to ₹1,000",
        reason: "Cost per lead is ₹62, well below your ₹100 target",
        forecastMonthMinor: 455_000n,
        currency: "INR",
        status: "pending",
        tokenHash: hashApprovalToken(TOKEN),
        createdAt: new Date(NOW.getTime() - 3_600_000),
        expiresAt: new Date(NOW.getTime() + 11 * 3_600_000),
        correlationId: "c1",
      },
    ]);
  });

  it("finds the request by the token's hash only; a malformed token never reaches the database", async () => {
    expect(await loadApprovalByToken("not a token", null)).toBeNull();
    expect(await loadApprovalByToken("B".repeat(43), null)).toBeNull();
    const anon = await loadApprovalByToken(TOKEN, null);
    expect(anon).toMatchObject({ tenantId: T, workspaceName: "Shop" });
    expect(anon!.approval).toMatchObject({ forecastText: "Could add up to ₹4,550 this month (worst case)", reason: "Why: cost per lead is ₹62, well below your ₹100 target", expiryText: "Declined automatically in 11 hours", canApprove: false, canDecline: true });
  });

  it("approving needs a signed-in approver of this workspace", async () => {
    expect((await loadApprovalByToken(TOKEN, OWNER))!.approval.canApprove).toBe(true);
    expect((await loadApprovalByToken(TOKEN, ADMIN))!.approval.canApprove).toBe(true); // named as an approver
    expect((await loadApprovalByToken(TOKEN, ADMIN2))!.approval.canApprove).toBe(false);
    expect((await loadApprovalByToken(TOKEN, AGENT))!.approval.canApprove).toBe(false);
    expect((await loadApprovalByToken(TOKEN, { userId: OWNER.userId, tenantId: "other", role: "owner" }))!.approval.canApprove).toBe(false);
  });

  it("a request past its time reads 'Declined automatically' with nothing to tap", async () => {
    vi.setSystemTime(new Date(NOW.getTime() + 12 * 3_600_000));
    const out = await loadApprovalByToken(TOKEN, OWNER);
    expect(out!.approval).toMatchObject({ status: "expired", expiryText: "Declined automatically (no answer in 12 hours).", canApprove: false, canDecline: false });
  });
});

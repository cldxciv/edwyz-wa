import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "projects-secret-projects-secret-123456";
process.env.SITE_URL = "https://wa.edwyz.com";
process.env.EMAIL_VERIFICATION_REQUIRED = "true";

type Fn = ReturnType<typeof vi.fn>;
const db = vi.hoisted(() => ({
  membership: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  user: { findUnique: vi.fn() },
  phoneNumber: { groupBy: vi.fn() },
  conversation: { groupBy: vi.fn(), count: vi.fn() },
  lead: { groupBy: vi.fn() },
  spendControl: { findMany: vi.fn() },
  spendDaily: { groupBy: vi.fn() },
  metaAsset: { findMany: vi.fn() },
  platformSetting: { findUnique: vi.fn() },
}));
const visibility = vi.hoisted(() => ({ viewerRules: vi.fn(), rulesToWhere: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/teams/visibility", () => visibility);

import { GET as overviewGet } from "@/app/api/projects/overview/route";
import { signAccessToken } from "@/lib/auth/tokens";
import { accountTimeZone, AGENT_SCOPE_CONCURRENCY, loadProjectsOverview, MAX_AD_ACCOUNTS, noAdSpend, orderProjects } from "@/lib/projects/overview";
import { billingFactsOf } from "@/lib/projects/billing";
import { PROJECT_COPY, projectBilling } from "@/lib/projects/rules";
import { LEADS_WINDOW_DAYS, MAX_PROJECTS_LISTED, MAX_UNPAID_PROJECTS, SPEND_TRACKED_WITHIN_HOURS } from "@/lib/projects/types";

const NOW = new Date("2026-10-31T06:00:00Z");
const ME = "u1";

type TenantRow = Record<string, unknown> & { id: string; name: string };
const tenant = (id: string, name: string, over: Record<string, unknown> = {}): TenantRow => ({
  id,
  name,
  status: "active",
  suspendedReason: null,
  billingExempt: false,
  trialEndsAt: new Date("2026-11-07T00:00:00Z"),
  subscription: null,
  ...over,
});
const paid = (planName = "Growth", over: Record<string, unknown> = {}) => ({
  subscription: { status: "active", currentPeriodEnd: new Date("2026-11-20T00:00:00Z"), pastDueSince: null, cancelAtPeriodEnd: false, planId: "p1", razorpaySubscriptionId: "sub_1", plan: { name: planName }, ...over },
});
const member = (role: "owner" | "admin" | "agent", t: TenantRow) => ({ role, tenant: t });

type Daily = { tenantId: string; pot: string; scopeType: string; scopeId: string; origin: string; currency: string; day: string; amountMinor: bigint; syncedAt: Date };
let daily: Daily[] = [];
type Account = { id: string; tenantId: string; meta?: unknown; type?: string; status?: string };
let accounts: Account[] = [];

/** A SpendDaily ad account row (origin all) synced ten minutes before `at`. */
const accountRow = (tenantId: string, scopeId: string, day: string, amountMinor: bigint, over: Partial<Daily> = {}, at = NOW): Daily => ({
  tenantId,
  pot: "ads",
  scopeType: "account",
  scopeId,
  origin: "all",
  currency: "INR",
  day,
  amountMinor,
  syncedAt: new Date(at.getTime() - 10 * 60_000),
  ...over,
});

type SpendWhere = {
  tenantId: { in: string[] };
  pot: string;
  scopeType: string;
  origin: string;
  scopeId?: { in: string[] };
  day?: { gte?: Date; lt?: Date };
  syncedAt?: { gte: Date };
};
const SPEND_WHERE_KEYS = new Set(["tenantId", "pot", "scopeType", "origin", "scopeId", "day", "syncedAt"]);

/** Evaluates the where clause and grouping the overview sends, so the test checks its shape, not a canned answer. */
function spendGroupBy(args: { by: (keyof Daily)[]; where: SpendWhere }) {
  const w = args.where;
  for (const key of Object.keys(w)) if (!SPEND_WHERE_KEYS.has(key)) throw new Error(`unexpected where key ${key}`);
  const groups = new Map<string, Record<string, unknown> & { _sum: { amountMinor: bigint }; _max: { syncedAt: Date | null } }>();
  for (const r of daily) {
    const day = new Date(`${r.day}T00:00:00Z`);
    if (!w.tenantId.in.includes(r.tenantId) || r.pot !== w.pot || r.scopeType !== w.scopeType || r.origin !== w.origin) continue;
    if (w.scopeId && !w.scopeId.in.includes(r.scopeId)) continue;
    if ((w.day?.gte && day < w.day.gte) || (w.day?.lt && day >= w.day.lt)) continue;
    if (w.syncedAt && r.syncedAt < w.syncedAt.gte) continue;
    const key = args.by.map((k) => String(r[k])).join("|");
    const g = groups.get(key) ?? { ...Object.fromEntries(args.by.map((k) => [k, r[k]])), _sum: { amountMinor: 0n }, _max: { syncedAt: null } };
    g._sum.amountMinor += r.amountMinor;
    if (!g._max.syncedAt || r.syncedAt > g._max.syncedAt) g._max.syncedAt = r.syncedAt;
    groups.set(key, g);
  }
  return Promise.resolve([...groups.values()]);
}

/** The ad accounts the overview asks for: connected (active) ad_account assets of the listed workspaces. */
function assetFindMany(args: { where: { tenantId: { in: string[] }; type: string; status: string }; take: number; select: Record<string, boolean> }) {
  const w = args.where;
  const rows = accounts.filter((a) => w.tenantId.in.includes(a.tenantId) && (a.type ?? "ad_account") === w.type && (a.status ?? "active") === w.status);
  return Promise.resolve(rows.slice(0, args.take).map((a) => ({ id: a.id, tenantId: a.tenantId, meta: a.meta ?? {} })));
}

function seed(rows: ReturnType<typeof member>[]) {
  (db.membership.findMany as Fn).mockResolvedValue(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  daily = [];
  accounts = [];
  (db.user.findUnique as Fn).mockResolvedValue({ emailVerifiedAt: new Date("2026-10-01T00:00:00Z") });
  (db.platformSetting.findUnique as Fn).mockResolvedValue({ value: { graceDays: 3, trialDays: 7 } });
  (db.membership.findFirst as Fn).mockResolvedValue(null);
  (db.membership.count as Fn).mockResolvedValue(0);
  (db.phoneNumber.groupBy as Fn).mockResolvedValue([]);
  (db.conversation.groupBy as Fn).mockResolvedValue([]);
  (db.conversation.count as Fn).mockResolvedValue(0);
  (db.lead.groupBy as Fn).mockResolvedValue([]);
  (db.spendControl.findMany as Fn).mockResolvedValue([]);
  (db.spendDaily.groupBy as Fn).mockImplementation(spendGroupBy);
  (db.metaAsset.findMany as Fn).mockImplementation(assetFindMany);
  visibility.viewerRules.mockResolvedValue({ onlyAssigned: true, teamIds: null, includeUnteamed: true, maskPhone: false });
  visibility.rulesToWhere.mockImplementation((viewer: { userId: string }) => ({ assignedToId: viewer.userId }));
});

describe("loadProjectsOverview: which workspaces", () => {
  it("lists only live memberships of this person, bounded, the current one first then by name", async () => {
    seed([member("owner", tenant("t1", "Zed Foods")), member("admin", tenant("t2", "acme")), member("agent", tenant("t3", "Mehta Motors"))]);
    const o = await loadProjectsOverview({ userId: ME, tenantId: "t3" }, { now: NOW });
    const call = (db.membership.findMany as Fn).mock.calls[0][0];
    expect(call.where).toEqual({ userId: ME, tenant: { deletedAt: null } });
    expect(call.take).toBe(MAX_PROJECTS_LISTED + 1);
    expect(o.projects.map((p) => [p.name, p.role, p.current])).toEqual([
      ["Mehta Motors", "agent", true],
      ["acme", "admin", false],
      ["Zed Foods", "owner", false],
    ]);
    expect(o).toMatchObject({ currentId: "t3", total: 3, truncated: false, leadsWindowDays: LEADS_WINDOW_DAYS, generatedAt: NOW.toISOString() });
    expect(db.membership.count).not.toHaveBeenCalled();
  });

  it("always shows the current workspace when the person has more than the list holds", async () => {
    const many = Array.from({ length: MAX_PROJECTS_LISTED + 1 }, (_, i) => member("admin", tenant(`t${i}`, `Shop ${String(i).padStart(3, "0")}`)));
    seed(many);
    (db.membership.findFirst as Fn).mockResolvedValue(member("owner", tenant("tx", "Current Co")));
    (db.membership.count as Fn).mockResolvedValue(150);
    const o = await loadProjectsOverview({ userId: ME, tenantId: "tx" }, { now: NOW });
    expect((db.membership.findFirst as Fn).mock.calls[0][0].where).toEqual({ userId: ME, tenant: { deletedAt: null }, tenantId: "tx" });
    expect(o.projects).toHaveLength(MAX_PROJECTS_LISTED);
    expect(o.projects[0]).toMatchObject({ id: "tx", current: true });
    expect(o).toMatchObject({ total: 150, truncated: true });
  });

  it("orderProjects keeps the current project first and sorts the rest by name, ignoring case", () => {
    const list = [{ name: "beta", current: false }, { name: "Alpha", current: false }, { name: "Zulu", current: true }];
    expect(orderProjects(list).map((p) => p.name)).toEqual(["Zulu", "Alpha", "beta"]);
  });
});

describe("loadProjectsOverview: figures", () => {
  it("costs a fixed number of grouped queries per figure, whatever the number of projects or ad accounts (owners and admins)", async () => {
    seed(Array.from({ length: 30 }, (_, i) => member(i % 2 ? "owner" : "admin", tenant(`t${i}`, `Shop ${i}`))));
    accounts = Array.from({ length: 30 }, (_, i) => [{ id: `a${i}`, tenantId: `t${i}` }, { id: `b${i}`, tenantId: `t${i}` }]).flat();
    await loadProjectsOverview({ userId: ME, tenantId: "t0" }, { now: NOW });
    expect(db.phoneNumber.groupBy).toHaveBeenCalledTimes(1);
    expect(db.conversation.groupBy).toHaveBeenCalledTimes(1);
    expect(db.conversation.count).not.toHaveBeenCalled();
    expect(db.lead.groupBy).toHaveBeenCalledTimes(1);
    expect(db.spendControl.findMany).toHaveBeenCalledTimes(1);
    expect(db.metaAsset.findMany).toHaveBeenCalledTimes(1);
    // One freshness query and one sum for the month every account is in.
    expect(db.spendDaily.groupBy).toHaveBeenCalledTimes(2);
    const ids = Array.from({ length: 30 }, (_, i) => `t${i}`);
    for (const fn of [db.phoneNumber.groupBy, db.lead.groupBy, db.spendDaily.groupBy, db.spendControl.findMany, db.metaAsset.findMany]) {
      for (const call of (fn as Fn).mock.calls) expect((call[0].where.tenantId.in as string[]).slice().sort()).toEqual([...ids].sort());
    }
    expect((db.metaAsset.findMany as Fn).mock.calls[0][0]).toMatchObject({ where: { type: "ad_account", status: "active" }, take: MAX_AD_ACCOUNTS });
  });

  it("does not read spend rows at all when no listed project has an ad account", async () => {
    seed([member("owner", tenant("t1", "A")), member("admin", tenant("t2", "B"))]);
    const o = await loadProjectsOverview({ userId: ME, tenantId: "t1" }, { now: NOW });
    expect(db.spendDaily.groupBy).not.toHaveBeenCalled();
    expect(o.projects.map((p) => p.adSpendMonth)).toEqual([noAdSpend(), noAdSpend()]);
  });

  it("counts unread chats like the inbox: unread, not blocked; agents only inside their visibility rules", async () => {
    seed([member("owner", tenant("t1", "Own")), member("agent", tenant("t2", "Helping")), member("agent", tenant("t3", "Broken"))]);
    (db.conversation.groupBy as Fn).mockResolvedValue([{ tenantId: "t1", _count: { _all: 7 } }]);
    (db.conversation.count as Fn).mockImplementation(async ({ where }: { where: { tenantId: string } }) => {
      if (where.tenantId === "t3") throw new Error("db down");
      return 2;
    });
    const o = await loadProjectsOverview({ userId: ME, tenantId: "t1" }, { now: NOW });
    const grouped = (db.conversation.groupBy as Fn).mock.calls[0][0];
    expect(grouped.where).toEqual({ tenantId: { in: ["t1"] }, unreadCount: { gt: 0 }, status: { not: "blocked" } });
    const agentCall = (db.conversation.count as Fn).mock.calls.find((c) => c[0].where.tenantId === "t2")![0];
    expect(agentCall.where).toEqual({ tenantId: "t2", unreadCount: { gt: 0 }, status: { not: "blocked" }, assignedToId: ME });
    expect(visibility.viewerRules).toHaveBeenCalledWith({ userId: ME, tenantId: "t2", role: "agent" });
    const by = Object.fromEntries(o.projects.map((p) => [p.id, p.unreadConversations]));
    expect(by).toEqual({ t1: 7, t2: 2, t3: null });
  });

  it("reads agent visibility a few workspaces at a time", async () => {
    seed(Array.from({ length: 12 }, (_, i) => member("agent", tenant(`a${i}`, `Client ${i}`))));
    let running = 0;
    let peak = 0;
    visibility.viewerRules.mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
      return { onlyAssigned: false, teamIds: null, includeUnteamed: true, maskPhone: false };
    });
    visibility.rulesToWhere.mockReturnValue(null);
    const o = await loadProjectsOverview({ userId: ME, tenantId: "a0" }, { now: NOW });
    expect(peak).toBeLessThanOrEqual(AGENT_SCOPE_CONCURRENCY);
    expect(db.conversation.count).toHaveBeenCalledTimes(12);
    expect(o.projects.every((p) => p.unreadConversations === 0)).toBe(true);
  });

  it("says whether WhatsApp is connected, preferring a connected number to show", async () => {
    seed([member("owner", tenant("t1", "A")), member("owner", tenant("t2", "B")), member("owner", tenant("t3", "C"))]);
    (db.phoneNumber.groupBy as Fn).mockResolvedValue([
      { tenantId: "t1", status: "pending", _count: { _all: 1 }, _min: { displayPhone: "+91 1" } },
      { tenantId: "t1", status: "connected", _count: { _all: 2 }, _min: { displayPhone: "+91 2" } },
      { tenantId: "t2", status: "pending", _count: { _all: 1 }, _min: { displayPhone: "+91 3" } },
    ]);
    const o = await loadProjectsOverview({ userId: ME, tenantId: "t1" }, { now: NOW });
    const by = Object.fromEntries(o.projects.map((p) => [p.id, p.whatsapp]));
    expect(by.t1).toEqual({ state: "connected", numbers: 3, display: "+91 2" });
    expect(by.t2).toEqual({ state: "setup", numbers: 1, display: "+91 3" });
    expect(by.t3).toEqual({ state: "none", numbers: 0, display: null });
  });

  it(`counts leads from the last ${LEADS_WINDOW_DAYS} days`, async () => {
    seed([member("agent", tenant("t1", "A")), member("owner", tenant("t2", "B"))]);
    (db.lead.groupBy as Fn).mockResolvedValue([{ tenantId: "t1", _count: { _all: 4 } }]);
    const o = await loadProjectsOverview({ userId: ME, tenantId: "t1" }, { now: NOW });
    expect((db.lead.groupBy as Fn).mock.calls[0][0].where.createdAt).toEqual({ gte: new Date(NOW.getTime() - LEADS_WINDOW_DAYS * 86_400_000) });
    expect(Object.fromEntries(o.projects.map((p) => [p.id, p.newLeads]))).toEqual({ t1: 4, t2: 0 });
  });

  it("sums this month's ad spend per currency from the ad account rows Meta reports, never adding currencies together", async () => {
    seed([member("owner", tenant("t1", "A")), member("owner", tenant("t2", "B")), member("owner", tenant("t3", "C"))]);
    accounts = [
      { id: "inr1", tenantId: "t1" },
      { id: "usd1", tenantId: "t1" },
      { id: "acc2", tenantId: "t2" },
    ];
    daily = [
      accountRow("t1", "inr1", "2026-10-01", 50_000n),
      accountRow("t1", "inr1", "2026-10-30", 70_000n),
      accountRow("t1", "usd1", "2026-10-15", 4_000n, { currency: "USD" }),
      // Not counted: last month, the per-campaign rows (already inside the account row), the outside-spend estimate.
      accountRow("t1", "inr1", "2026-09-30", 999_999n),
      accountRow("t1", "cmp1", "2026-10-10", 30_000n, { scopeType: "campaign", origin: "platform" }),
      accountRow("t1", "inr1", "2026-10-10", 20_000n, { origin: "external" }),
      // Tracked and spent nothing this month: the sync writes today's row at 0.
      accountRow("t2", "acc2", "2026-10-31", 0n),
    ];
    const o = await loadProjectsOverview({ userId: ME, tenantId: "t1" }, { now: NOW });
    const by = Object.fromEntries(o.projects.map((p) => [p.id, p.adSpendMonth]));
    expect(by.t1).toEqual({
      amounts: [
        { minor: "120000", currency: "INR", formatted: "₹1,200" },
        { minor: "4000", currency: "USD", formatted: "$40" },
      ],
      accounts: 2,
      tracked: 2,
    });
    expect(by.t2).toEqual({ amounts: [], accounts: 1, tracked: 1 });
    expect(by.t3).toEqual({ amounts: [], accounts: 0, tracked: 0 });
  });

  it("tells nothing spent apart from not tracked: ads outside Edwyz, and a total that froze mid-month, are not tracked", async () => {
    seed([member("owner", tenant("t1", "Ads elsewhere")), member("owner", tenant("t2", "Ads stopped")), member("owner", tenant("t3", "Mixed")), member("owner", tenant("t4", "Gone"))]);
    const stale = new Date(NOW.getTime() - (SPEND_TRACKED_WITHIN_HOURS * 60 + 1) * 60_000);
    accounts = [
      // Connected, but Edwyz never read it (no Edwyz ad, no limit set here): spend.sync.fast wrote nothing.
      { id: "out1", tenantId: "t1" },
      // Read until its Edwyz ads stopped on the 12th: rows exist, but they froze then.
      { id: "old2", tenantId: "t2" },
      { id: "live3", tenantId: "t3" },
      { id: "old3", tenantId: "t3" },
      // Disconnected: not one of the project's ad accounts any more.
      { id: "gone4", tenantId: "t4", status: "inactive" },
    ];
    daily = [
      accountRow("t2", "old2", "2026-10-11", 80_000n, { syncedAt: new Date("2026-10-12T09:00:00Z") }),
      accountRow("t2", "old2", "2026-10-12", 10_000n, { syncedAt: new Date("2026-10-12T09:00:00Z") }),
      accountRow("t3", "live3", "2026-10-20", 30_000n),
      accountRow("t3", "old3", "2026-10-20", 99_000n, { syncedAt: stale }),
      accountRow("t4", "gone4", "2026-10-20", 5_000n),
    ];
    const o = await loadProjectsOverview({ userId: ME, tenantId: "t1" }, { now: NOW });
    const by = Object.fromEntries(o.projects.map((p) => [p.id, p.adSpendMonth]));
    expect(by.t1).toEqual({ amounts: [], accounts: 1, tracked: 0 });
    expect(by.t2).toEqual({ amounts: [], accounts: 1, tracked: 0 });
    expect(by.t3).toEqual({ amounts: [{ minor: "30000", currency: "INR", formatted: "₹300" }], accounts: 2, tracked: 1 });
    expect(by.t4).toEqual({ amounts: [], accounts: 0, tracked: 0 });
    const fresh = (db.spendDaily.groupBy as Fn).mock.calls.map((c) => c[0]).find((a) => a.where.syncedAt);
    expect(fresh.where.syncedAt).toEqual({ gte: new Date(NOW.getTime() - SPEND_TRACKED_WITHIN_HOURS * 3_600_000) });
    expect(fresh.where.scopeId.in.slice().sort()).toEqual(["live3", "old2", "old3", "out1"]);
  });

  it("uses each ad account's own time zone for 'this month', as the sync keys its rows, else the workspace's", async () => {
    const midnight = new Date("2026-11-01T03:00:00Z"); // 1 Nov in Kolkata, still 31 Oct in Los Angeles
    seed([member("owner", tenant("in", "India Co")), member("owner", tenant("us", "US Co"))]);
    (db.spendControl.findMany as Fn).mockResolvedValue([{ tenantId: "us", timezone: "America/Los_Angeles" }, { tenantId: "in", timezone: "not/a-zone" }]);
    accounts = [
      // No zone of its own: the workspace's (a broken one means Asia/Kolkata), so November.
      { id: "inA", tenantId: "in", meta: { currency: "INR" } },
      // Same workspace, an account in Los Angeles time: still October for its rows.
      { id: "laA", tenantId: "in", meta: { currency: "USD", timezone: "America/Los_Angeles" } },
      // A US workspace whose account has no zone: the workspace's Los Angeles time.
      { id: "usA", tenantId: "us", meta: {} },
      // An account in Kolkata time inside the US workspace: November.
      { id: "usK", tenantId: "us", meta: { timezone: "Asia/Kolkata" } },
    ];
    daily = [
      accountRow("in", "inA", "2026-10-31", 10_000n, {}, midnight),
      accountRow("in", "inA", "2026-11-01", 20_000n, {}, midnight),
      accountRow("in", "laA", "2026-10-01", 1_000n, { currency: "USD" }, midnight),
      accountRow("in", "laA", "2026-10-31", 5_000n, { currency: "USD" }, midnight),
      accountRow("us", "usA", "2026-10-31", 5_000n, { currency: "USD" }, midnight),
      // Its month just turned and the sync has not written 1 Nov yet: last month's rows are recent, so it is tracked, at 0.
      accountRow("us", "usK", "2026-10-31", 7_000n, {}, midnight),
    ];
    const o = await loadProjectsOverview({ userId: ME, tenantId: "in" }, { now: midnight });
    // The freshness query, then one sum per distinct month.
    expect(db.spendDaily.groupBy).toHaveBeenCalledTimes(3);
    const by = Object.fromEntries(o.projects.map((p) => [p.id, p.adSpendMonth]));
    expect(by.in).toEqual({ amounts: [{ minor: "20000", currency: "INR", formatted: "₹200" }, { minor: "6000", currency: "USD", formatted: "$60" }], accounts: 2, tracked: 2 });
    expect(by.us).toEqual({ amounts: [{ minor: "5000", currency: "USD", formatted: "$50" }], accounts: 2, tracked: 2 });
  });

  it("works out an ad account's zone the way spend.sync.fast does", () => {
    expect(accountTimeZone({ timezone: "America/Los_Angeles" }, "Asia/Dubai")).toBe("America/Los_Angeles");
    expect(accountTimeZone({}, "Asia/Dubai")).toBe("Asia/Dubai");
    expect(accountTimeZone(null, null)).toBe("Asia/Kolkata");
    // A zone the account names but the runtime does not know: the safe default, as the sync resolves it.
    expect(accountTimeZone({ timezone: "Mars/Base" }, "Asia/Dubai")).toBe("Asia/Kolkata");
    expect(accountTimeZone({ timezone: 5 }, "Europe/London")).toBe("Europe/London");
  });

  it("shows Not available for a figure whose query failed, and keeps the rest of the page", async () => {
    seed([member("owner", tenant("t1", "A"))]);
    accounts = [{ id: "a1", tenantId: "t1" }];
    (db.lead.groupBy as Fn).mockRejectedValue(new Error("timeout"));
    (db.spendDaily.groupBy as Fn).mockRejectedValue(new Error("timeout"));
    (db.phoneNumber.groupBy as Fn).mockRejectedValue(new Error("timeout"));
    (db.conversation.groupBy as Fn).mockRejectedValue(new Error("timeout"));
    const o = await loadProjectsOverview({ userId: ME, tenantId: "t1" }, { now: NOW });
    expect(o.projects[0]).toMatchObject({ id: "t1", newLeads: null, adSpendMonth: null, whatsapp: null, unreadConversations: null });
    expect(o.projects[0].billing.state).toBe("trialing");
  });
});

describe("loadProjectsOverview: plan and New project", () => {
  it("gives each card its plan state and the date that matters", async () => {
    seed([
      member("owner", tenant("t1", "Trial Co")),
      member("admin", tenant("t2", "Paid Co", paid("Growth"))),
      member("agent", tenant("t3", "Old Co", { trialEndsAt: new Date("2026-10-01T00:00:00Z") })),
      member("owner", tenant("t4", "Comped", { billingExempt: true })),
    ]);
    const o = await loadProjectsOverview({ userId: ME, tenantId: "t1" }, { now: NOW });
    const by = Object.fromEntries(o.projects.map((p) => [p.id, p.billing]));
    expect(by.t1).toMatchObject({ state: "trialing", endKind: "trial_ends", endsAt: "2026-11-07T00:00:00.000Z", daysLeftInTrial: 7 });
    expect(by.t2).toMatchObject({ state: "active", planName: "Growth", endKind: "renews", endsAt: "2026-11-20T00:00:00.000Z" });
    expect(by.t3).toMatchObject({ state: "locked", endKind: "ended", endsAt: "2026-10-01T00:00:00.000Z" });
    expect(by.t4).toMatchObject({ state: "exempt", endsAt: null });
  });

  it("reads plans exactly as the paywall does: a plan set up by hand ends at its date and does not renew", () => {
    const manual = paid("Agency", { razorpaySubscriptionId: null }) as unknown as { subscription: Record<string, unknown> };
    const live = billingFactsOf(tenant("t1", "A", manual) as never, 3, NOW);
    expect(live).toMatchObject({ state: "active", planName: "Agency", subscription: { manual: true } });
    expect(projectBilling(live)).toMatchObject({ endKind: "ends", endsAt: "2026-11-20T00:00:00.000Z" });
    const after = billingFactsOf(tenant("t1", "A", manual) as never, 3, new Date("2026-11-21T00:00:00Z"));
    expect(after.state).toBe("locked");
    expect(projectBilling(after)).toMatchObject({ endKind: "ended", endsAt: "2026-11-20T00:00:00.000Z" });
    const suspended = billingFactsOf(tenant("t1", "A", { status: "suspended", suspendedReason: "Abuse", billingExempt: true }) as never, 3, NOW);
    expect(suspended.state).toBe("suspended");
  });

  it("tells the page up front when New project would be refused", async () => {
    seed([member("owner", tenant("t1", "A"))]);
    let o = await loadProjectsOverview({ userId: ME, tenantId: "t1" }, { now: NOW });
    expect(o.newProject).toEqual({ allowed: true, reason: null });

    (db.user.findUnique as Fn).mockResolvedValue({ emailVerifiedAt: null });
    o = await loadProjectsOverview({ userId: ME, tenantId: "t1" }, { now: NOW });
    expect(o.newProject).toEqual({ allowed: false, reason: PROJECT_COPY.verify });

    (db.user.findUnique as Fn).mockResolvedValue({ emailVerifiedAt: new Date() });
    seed(Array.from({ length: MAX_UNPAID_PROJECTS }, (_, i) => member("owner", tenant(`t${i}`, `Trial ${i}`))));
    o = await loadProjectsOverview({ userId: ME, tenantId: "t0" }, { now: NOW });
    expect(o.newProject).toEqual({ allowed: false, reason: PROJECT_COPY.unpaidCap });

    // Trials in workspaces the person only helps with are not theirs to pay for.
    seed(Array.from({ length: MAX_UNPAID_PROJECTS }, (_, i) => member("admin", tenant(`t${i}`, `Client ${i}`))));
    o = await loadProjectsOverview({ userId: ME, tenantId: "t0" }, { now: NOW });
    expect(o.newProject.allowed).toBe(true);
  });
});

describe("GET /api/projects/overview", () => {
  const req = (cookie?: string) => new Request("https://wa.edwyz.com/api/projects/overview", { headers: cookie ? { cookie } : {} });
  const signedIn = (tid = "t1") => `wa_access=${signAccessToken({ sub: ME, tid, role: "agent" })}`;

  it("needs a signed-in member", async () => {
    expect((await overviewGet(req())).status).toBe(401);
  });

  it("is refused when the session's workspace was deleted", async () => {
    (db.membership.findUnique as Fn).mockResolvedValue({ userId: ME, tenantId: "t1", role: "agent", user: { disabledAt: null, emailVerifiedAt: new Date() }, tenant: { deletedAt: new Date() } });
    expect((await overviewGet(req(signedIn()))).status).toBe(401);
  });

  it("answers the overview for any role, uncached", async () => {
    (db.membership.findUnique as Fn).mockResolvedValue({ userId: ME, tenantId: "t1", role: "agent", user: { disabledAt: null, emailVerifiedAt: new Date() }, tenant: { deletedAt: null } });
    seed([member("agent", tenant("t1", "Helping"))]);
    const res = await overviewGet(req(signedIn()));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({ id: "t1", name: "Helping", role: "agent", current: true });
    expect(body.currentId).toBe("t1");
  });
});

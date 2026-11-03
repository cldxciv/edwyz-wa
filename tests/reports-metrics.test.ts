import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  dailyMetric: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() },
  conversation: { count: vi.fn() },
  broadcastRecipient: { count: vi.fn(), groupBy: vi.fn() },
  broadcast: { findMany: vi.fn() },
  message: { groupBy: vi.fn() },
  membership: { findMany: vi.fn(), count: vi.fn() },
  invite: { count: vi.fn() },
  contact: { count: vi.fn() },
  plan: { findUnique: vi.fn() },
}));
const billing = vi.hoisted(() => ({ getBillingStatus: vi.fn() }));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => billing);
// The meter reads limits and counts through src/lib/billing/limits.ts (the code enforcement uses), which reads the status here.
vi.mock("@/lib/billing/status", () => billing);
vi.mock("@/lib/auth", () => auth);

import { GET as overviewRoute } from "@/app/api/reports/overview/route";
import { GET as usageRoute } from "@/app/api/reports/usage/route";
import { broadcastRow, buildOverview, foldMessageRows } from "@/lib/reports/metrics";
import { parseRange } from "@/lib/reports/range";
import { runSnapshots } from "@/lib/reports/snapshot";
import { getUsage } from "@/lib/reports/usage";
import { broadcastQuotaWhere } from "@/lib/billing/limits";
import { worker } from "@/lib/reports/worker";

const sql = (call: unknown[]) => (call[0] as string[]).join("?");

beforeEach(() => {
  vi.resetAllMocks();
});

describe("foldMessageRows", () => {
  it("splits direction and status into per-day columns", () => {
    const rows = foldMessageRows(["2026-03-01", "2026-03-02"], [
      { day: "2026-03-01", direction: "inbound", status: "received", c: 5n },
      { day: "2026-03-01", direction: "outbound", status: "read", c: 2n },
      { day: "2026-03-01", direction: "outbound", status: "delivered", c: 3n },
      { day: "2026-03-01", direction: "outbound", status: "failed", c: 1n },
      { day: "2026-03-09", direction: "inbound", status: "received", c: 9n },
    ]);
    expect(rows.get("2026-03-01")).toEqual({ day: "2026-03-01", inbound: 5, outbound: 6, sent: 5, delivered: 5, read: 2, failed: 1 });
    expect(rows.get("2026-03-02")!.outbound).toBe(0);
    expect(rows.has("2026-03-09")).toBe(false);
  });
  it("broadcast rates use sent as the denominator", () => {
    const row = broadcastRow({ id: "b", name: "n", status: "completed", createdAt: new Date() }, { sent: 2, delivered: 5, read: 3, failed: 1 });
    expect(row).toMatchObject({ sent: 10, delivered: 8, read: 3, failed: 1, deliveryRate: 80, readRate: 30 });
    expect(broadcastRow({ id: "b", name: "n", status: "draft", createdAt: new Date() }, {}).deliveryRate).toBeNull();
  });
});

describe("buildOverview", () => {
  const range = parseRange({ from: "2026-03-01", to: "2026-03-03", tz: "Asia/Kolkata" });
  function mockRaw() {
    db.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      const text = sql(args);
      if (text.includes('FROM "Message"') && text.includes("GROUP BY 1, 2, 3")) return [{ day: "2026-03-02", direction: "inbound", status: "received", c: 4n }];
      if (text.includes('FROM "Conversation"')) return [{ day: "2026-03-02", c: 2n }];
      if (text.includes("EXTRACT(EPOCH")) return [{ secs: 60 }, { secs: 120 }, { secs: 600 }];
      return [];
    });
    db.message.groupBy.mockResolvedValue([]);
    db.broadcast.findMany.mockResolvedValue([]);
  }

  it("agents get conversation metrics only and every raw query carries the tenant id", async () => {
    mockRaw();
    const o = await buildOverview("t1", "agent", range);
    expect(o.admin).toBeNull();
    expect(o.messagesPerDay[1].inbound).toBe(4);
    expect(o.conversationsOpenedPerDay[1].count).toBe(2);
    expect(o.firstResponse).toMatchObject({ conversations: 3, medianSeconds: 120 });
    expect(o.resolution.available).toBe(false);
    for (const call of db.$queryRaw.mock.calls) expect(call.slice(1)).toContain("t1");
    expect(db.message.groupBy).not.toHaveBeenCalled();
  });
  it("admins get agents, broadcasts, opt-ins and failure codes, all tenant scoped", async () => {
    mockRaw();
    db.message.groupBy.mockResolvedValueOnce([{ sentByUserId: "u1", _count: { _all: 7 } }]).mockResolvedValueOnce([{ errorCode: "131026", _count: { _all: 3 } }]);
    db.membership.findMany.mockResolvedValue([{ userId: "u1", user: { name: "Asha" } }]);
    const o = await buildOverview("t1", "owner", range);
    expect(o.admin!.agents).toEqual([{ userId: "u1", name: "Asha", messages: 7 }]);
    expect(o.admin!.failureCodes).toEqual([{ code: "131026", count: 3, hint: null }]);
    expect(o.admin!.optInsPerDay).toHaveLength(3);
    expect(db.message.groupBy.mock.calls[0][0].where.tenantId).toBe("t1");
    expect(db.message.groupBy.mock.calls[1][0].where.tenantId).toBe("t1");
    expect(db.broadcast.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
    expect(db.membership.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
  });
  it("uses finalised snapshots for old UTC days and live data otherwise", async () => {
    mockRaw();
    const snap = { _done: 1, _final: 1, messages_in: 10, messages_out: 8, sent: 7, delivered: 6, read: 5, failed: 1, conversations_opened: 3 };
    db.dailyMetric.findMany.mockResolvedValue(Object.entries(snap).map(([key, value]) => ({ day: "2026-01-02", key, value })));
    const utc = parseRange({ from: "2026-01-02", to: "2026-01-03", tz: "UTC" });
    const o = await buildOverview("t1", "agent", utc, new Date("2026-03-01T00:00:00Z"));
    expect(o.messagesSource).toBe("mixed");
    expect(o.messagesPerDay[0]).toMatchObject({ inbound: 10, outbound: 8, read: 5 });
    expect(o.conversationsOpenedPerDay[0].count).toBe(3);
    expect(db.dailyMetric.findMany.mock.calls[0][0].where.scope).toBe("tenant:t1");
  });
  it("skips snapshots for non-UTC time zones", async () => {
    mockRaw();
    await buildOverview("t1", "agent", range, new Date("2026-06-01T00:00:00Z"));
    expect(db.dailyMetric.findMany).not.toHaveBeenCalled();
  });
  it("sends the current zone name to AT TIME ZONE when the browser reported an old one", async () => {
    mockRaw();
    const legacy = parseRange({ from: "2026-03-01", to: "2026-03-03", tz: "Asia/Calcutta" });
    const o = await buildOverview("t1", "owner", legacy, new Date("2026-06-01T00:00:00Z"));
    expect(o.range.tz).toBe("Asia/Kolkata");
    const zoneArgs = db.$queryRaw.mock.calls.filter((call) => sql(call).includes("AT TIME ZONE")).map((call) => call.slice(1));
    expect(zoneArgs.length).toBeGreaterThan(0);
    for (const args of zoneArgs) {
      expect(args).toContain("Asia/Kolkata");
      expect(args).not.toContain("Asia/Calcutta");
    }
  });
});

describe("overview route", () => {
  it("validates parameters and returns data for the caller's tenant", async () => {
    auth.getActor.mockResolvedValue({ userId: "u", tenantId: "t9", role: "agent" });
    expect((await overviewRoute(new Request("http://x/api/reports/overview?from=bad&to=2026-01-01"))).status).toBe(400);
    expect((await overviewRoute(new Request("http://x/api/reports/overview?from=2026-01-01&to=2026-01-02&tz=Nope"))).status).toBe(400);
    db.$queryRaw.mockResolvedValue([]);
    db.dailyMetric.findMany.mockResolvedValue([]);
    const res = await overviewRoute(new Request("http://x/api/reports/overview?from=2026-01-01&to=2026-01-02&tz=UTC"));
    expect(res.status).toBe(200);
    expect((await res.json()).admin).toBeNull();
    for (const call of db.$queryRaw.mock.calls) expect(call.slice(1)).toContain("t9");
  });
  it("accepts an old zone name such as Asia/Calcutta and reports under its current name", async () => {
    auth.getActor.mockResolvedValue({ userId: "u", tenantId: "t9", role: "agent" });
    db.$queryRaw.mockResolvedValue([]);
    db.dailyMetric.findMany.mockResolvedValue([]);
    const res = await overviewRoute(new Request("http://x/api/reports/overview?from=2026-10-22&to=2026-10-28&tz=Asia%2FCalcutta"));
    expect(res.status).toBe(200);
    expect((await res.json()).range.tz).toBe("Asia/Kolkata");
    for (const call of db.$queryRaw.mock.calls) expect(call.slice(1)).not.toContain("Asia/Calcutta");
  });
});

describe("runSnapshots", () => {
  function fakeStore() {
    const store = new Map<string, number>();
    const key = (w: { scope: string; day: string; key: string }) => `${w.scope}|${w.day}|${w.key}`;
    db.dailyMetric.upsert.mockImplementation(async ({ where, create, update }: any) => {
      const k = key(where.scope_day_key);
      store.set(k, store.has(k) ? update.value : create.value);
    });
    db.dailyMetric.findFirst.mockImplementation(async ({ where }: any) => (store.has(key(where)) ? { id: "x" } : null));
    db.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      const text = sql(args);
      const values = args.slice(1) as unknown[];
      if (text.includes('FROM "Tenant"')) {
        const [day, marker, limit] = values as [string, string, number];
        return ["ta", "tb", "tc"].filter((id) => !store.has(`tenant:${id}|${day}|${marker}`)).slice(0, limit).map((id) => ({ id }));
      }
      if (text.includes('FROM "Message"')) return [{ messages_in: 3n, messages_out: 2n, sent: 2n, delivered: 1n, read: 0n, failed: 0n }];
      if (text.includes("sum(value)")) {
        const day = values[0] as string;
        const total = [...store].filter(([k]) => k.startsWith("tenant:") && k.split("|")[1] === day && k.split("|")[2] === "messages_in").reduce((a, [, v]) => a + v, 0);
        return [{ key: "messages_in", total: BigInt(total) }];
      }
      if (text.includes("count(*) AS c")) return [{ c: 3n }];
      return [];
    });
    db.conversation.count.mockResolvedValue(1);
    db.broadcastRecipient.count.mockResolvedValue(4);
    return store;
  }
  const now = new Date("2026-03-10T01:00:00Z");

  it("snapshots yesterday per tenant, rolls up the platform and is idempotent", async () => {
    const store = fakeStore();
    const first = await runSnapshots(now);
    expect(first.yesterday).toBe(3);
    expect(store.get("tenant:ta|2026-03-09|messages_in")).toBe(3);
    expect(store.get("tenant:ta|2026-03-09|broadcast_recipients_sent")).toBe(4);
    expect(store.get("tenant:ta|2026-03-09|_done")).toBe(1);
    expect(store.get("platform|2026-03-09|messages_in")).toBe(9);
    expect(store.get("platform|2026-03-09|tenants_counted")).toBe(3);
    const snapshot = new Map(store);
    const second = await runSnapshots(now);
    expect(second.yesterday).toBe(0);
    expect(new Map(store)).toEqual(snapshot);
  });
  it("is bounded per run and resumes where it stopped", async () => {
    const store = fakeStore();
    const run = await runSnapshots(now, 2);
    expect(run.yesterday).toBe(2);
    expect(store.has("platform|2026-03-09|messages_in")).toBe(false);
    const next = await runSnapshots(now, 2);
    expect(next.yesterday).toBe(1);
    expect(store.get("platform|2026-03-09|tenants_counted")).toBe(3);
  });
  it("registers an hourly periodic task", () => {
    expect(worker.periodic).toHaveLength(1);
    expect(worker.periodic[0].everyMs).toBe(3_600_000);
  });
});

describe("usage", () => {
  const status = (over: Record<string, unknown> = {}) => ({ state: "active", planId: null, daysLeftInTrial: null, ...over });
  beforeEach(() => {
    db.invite.count.mockResolvedValue(0);
  });

  it("shows usage without limits when there is no plan", async () => {
    billing.getBillingStatus.mockResolvedValue(status({ state: "locked" }));
    db.contact.count.mockResolvedValue(12);
    db.membership.count.mockResolvedValue(2);
    db.broadcastRecipient.count.mockResolvedValue(40);
    const u = await getUsage("t1", new Date("2026-03-15T00:00:00Z"));
    expect(u.plan).toBeNull();
    expect(u.limitsFrom).toBeNull();
    expect(u.contacts).toEqual({ used: 12, limit: null });
    expect(u.periodStart).toBe("2026-03-01T00:00:00.000Z");
    expect(db.contact.count.mock.calls[0][0].where.tenantId).toBe("t1");
    expect(db.broadcastRecipient.count.mock.calls[0][0].where.OR[0].sentAt.gte.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
  it("reports plan limits", async () => {
    billing.getBillingStatus.mockResolvedValue(status({ planId: "p1" }));
    db.plan.findUnique.mockResolvedValue({ name: "Growth", seatLimit: 5, contactLimit: 1000, monthlyBroadcastLimit: null });
    db.contact.count.mockResolvedValue(1);
    db.membership.count.mockResolvedValue(1);
    db.broadcastRecipient.count.mockResolvedValue(1);
    const u = await getUsage("t1");
    expect(u.plan).toEqual({ name: "Growth" });
    expect(u.limitsFrom).toBe("plan");
    expect(u.seats.limit).toBe(5);
    expect(u.broadcastRecipients.limit).toBeNull();
  });
  it("counts the way enforcement does: seats include open invites, broadcasts use the shared quota rule", async () => {
    billing.getBillingStatus.mockResolvedValue(status({ planId: "p1" }));
    db.plan.findUnique.mockResolvedValue({ name: "Growth", seatLimit: 3, contactLimit: null, monthlyBroadcastLimit: 100 });
    db.contact.count.mockResolvedValue(0);
    db.membership.count.mockResolvedValue(2);
    db.invite.count.mockResolvedValue(1);
    db.broadcastRecipient.count.mockResolvedValue(7);
    const now = new Date("2026-03-15T00:00:00Z");
    const u = await getUsage("t1", now);
    expect(u.seats).toEqual({ used: 3, limit: 3 });
    expect(u.broadcastRecipients).toEqual({ used: 7, limit: 100 });
    expect(db.broadcastRecipient.count.mock.calls[0][0].where).toEqual(broadcastQuotaWhere("t1", now));
    expect(db.invite.count.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", acceptedAt: null });
  });
  it("shows the free trial's limits while they apply, like enforcement", async () => {
    billing.getBillingStatus.mockResolvedValue(status({ state: "trialing", daysLeftInTrial: 4 }));
    db.plan.findUnique.mockResolvedValue({ name: "Free trial", seatLimit: 2, contactLimit: 100, monthlyBroadcastLimit: 50 });
    db.contact.count.mockResolvedValue(10);
    db.membership.count.mockResolvedValue(1);
    db.broadcastRecipient.count.mockResolvedValue(0);
    const u = await getUsage("t1");
    expect(u.plan).toBeNull();
    expect(u.limitsFrom).toBe("trial");
    expect(u.contacts).toEqual({ used: 10, limit: 100 });
    expect(u.billing).toEqual({ state: "trialing", trialDaysLeft: 4 });
    expect(db.plan.findUnique.mock.calls[0][0].where).toEqual({ code: "trial" });
  });
  it("a complimentary workspace has no limits even with a plan on file", async () => {
    billing.getBillingStatus.mockResolvedValue(status({ state: "exempt", planId: "p1" }));
    db.contact.count.mockResolvedValue(1);
    db.membership.count.mockResolvedValue(1);
    db.broadcastRecipient.count.mockResolvedValue(0);
    const u = await getUsage("t1");
    expect(u).toMatchObject({ plan: null, limitsFrom: null, contacts: { limit: null } });
    expect(db.plan.findUnique).not.toHaveBeenCalled();
  });
  it("route is tenant scoped", async () => {
    auth.getActor.mockResolvedValue({ userId: "u", tenantId: "t7", role: "agent" });
    billing.getBillingStatus.mockResolvedValue(status());
    db.contact.count.mockResolvedValue(0);
    db.membership.count.mockResolvedValue(0);
    db.broadcastRecipient.count.mockResolvedValue(0);
    const res = await usageRoute(new Request("http://x/api/reports/usage"));
    expect(res.status).toBe(200);
    expect(billing.getBillingStatus).toHaveBeenCalledWith("t7");
  });
});

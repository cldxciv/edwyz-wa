import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  template: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  contact: { count: vi.fn() },
  broadcast: { count: vi.fn() },
  membership: { count: vi.fn(), findMany: vi.fn() },
  invite: { count: vi.fn() },
  routingConfig: { findUnique: vi.fn() },
  chatbot: { count: vi.fn() },
  aiAgent: { count: vi.fn() },
  metaConnection: { count: vi.fn(), findMany: vi.fn() },
  message: { findFirst: vi.fn(), count: vi.fn() },
  platformSetting: { findUnique: vi.fn(), upsert: vi.fn() },
  auditLog: { create: vi.fn() },
  conversation: { count: vi.fn(), findMany: vi.fn(), fields: { lastInboundAt: { ref: "lastInboundAt" } } },
}));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
const billing = vi.hoisted(() => ({ getBillingStatus: vi.fn() }));
const reports = vi.hoisted(() => ({ messagesAndConversations: vi.fn(), firstResponseSeconds: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/billing", () => billing);
vi.mock("@/lib/reports/metrics", () => reports);

import { GET as dashboardRoute } from "@/app/api/setup/dashboard/route";
import { POST as dismissRoute } from "@/app/api/setup/dismiss/route";
import { GET as setupRoute } from "@/app/api/setup/route";
import { buildDashboard } from "@/lib/setup/dashboard";
import { HttpError } from "@/lib/tenancy";
import { dismissedKey, setDismissed } from "@/lib/setup/dismissed";
import { gatherFacts } from "@/lib/setup/facts";

const origin = "https://wa.edwyz.com";
const owner = { userId: "u1", tenantId: "t1", role: "owner" as const };
const agent = { userId: "u2", tenantId: "t1", role: "agent" as const };
const now = new Date("2026-10-27T10:00:00Z");

const get = (url = "https://wa.edwyz.com/api/setup") => new Request(url);
const post = (body: unknown, headers: Record<string, string> = { origin }) =>
  new Request("https://wa.edwyz.com/api/setup/dismiss", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

function seedBlankTenant() {
  db.tenant.findUnique.mockResolvedValue({ onboardingStatus: "not_started", name: "Acme" });
  db.template.groupBy.mockResolvedValue([]);
  db.contact.count.mockResolvedValue(0);
  db.broadcast.count.mockResolvedValue(0);
  db.membership.count.mockResolvedValue(1);
  db.invite.count.mockResolvedValue(0);
  db.routingConfig.findUnique.mockResolvedValue(null);
  db.chatbot.count.mockResolvedValue(0);
  db.aiAgent.count.mockResolvedValue(0);
  db.metaConnection.count.mockResolvedValue(0);
  db.message.findFirst.mockResolvedValue(null);
  db.platformSetting.findUnique.mockResolvedValue(null);
  billing.getBillingStatus.mockResolvedValue({ state: "trialing", daysLeftInTrial: 7, planName: null });
}

beforeEach(() => {
  vi.resetAllMocks();
  db.conversation.fields = { lastInboundAt: { ref: "lastInboundAt" } };
  auth.getActor.mockResolvedValue(owner);
  seedBlankTenant();
});

describe("gatherFacts", () => {
  it("filters every query by tenant", async () => {
    await gatherFacts("t1", now);
    const scoped: [string, { mock: { calls: unknown[][] } }][] = [
      ["contact.count", db.contact.count],
      ["broadcast.count", db.broadcast.count],
      ["membership.count", db.membership.count],
      ["invite.count", db.invite.count],
      ["chatbot.count", db.chatbot.count],
      ["aiAgent.count", db.aiAgent.count],
      ["metaConnection.count", db.metaConnection.count],
      ["template.groupBy", db.template.groupBy],
    ];
    for (const [name, fn] of scoped) {
      expect(fn.mock.calls.length, name).toBeGreaterThan(0);
      for (const call of fn.mock.calls) expect(JSON.stringify(call[0]), name).toContain('"tenantId":"t1"');
    }
    expect(db.routingConfig.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1" } }));
    expect(billing.getBillingStatus).toHaveBeenCalledWith("t1");
  });

  it("turns template groups and live status into facts", async () => {
    db.tenant.findUnique.mockResolvedValue({ onboardingStatus: "live" });
    db.template.groupBy.mockResolvedValue([
      { status: "approved", _count: { _all: 2 } },
      { status: "rejected", _count: { _all: 1 } },
    ]);
    db.message.findFirst.mockResolvedValue({ id: "m1" });
    const facts = await gatherFacts("t1", now);
    expect(facts).toMatchObject({ onboardingLive: true, approvedTemplates: 2, pendingTemplates: 0, rejectedTemplates: 1, sentTemplateMessages: 1 });
  });

  it("skips the sent-message lookup when a broadcast already started or the number is not live", async () => {
    await gatherFacts("t1", now);
    expect(db.message.findFirst).not.toHaveBeenCalled();
    db.tenant.findUnique.mockResolvedValue({ onboardingStatus: "live" });
    db.broadcast.count.mockResolvedValue(2);
    await gatherFacts("t1", now);
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });
});

describe("GET /api/setup", () => {
  it("returns steps and a summary to any member, flagging whether they can dismiss", async () => {
    auth.getActor.mockResolvedValue(agent);
    const res = await setupRoute(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.steps).toHaveLength(9);
    expect(body.summary).toMatchObject({ percent: 0, remaining: 4, nextStepId: "connect" });
    expect(body.canDismiss).toBe(false);
    auth.getActor.mockResolvedValue(owner);
    expect((await (await setupRoute(get())).json()).canDismiss).toBe(true);
  });

  it("applies the stored dismissals", async () => {
    db.platformSetting.findUnique.mockResolvedValue({ value: ["template"] });
    const body = await (await setupRoute(get())).json();
    expect(db.platformSetting.findUnique).toHaveBeenCalledWith({ where: { key: "setup:t1:dismissed" } });
    expect(body.steps.find((s: { id: string }) => s.id === "template").dismissed).toBe(true);
  });

  it("returns 401 when not signed in", async () => {
    auth.getActor.mockRejectedValue(new HttpError(401, "Not signed in."));
    expect((await setupRoute(get())).status).toBe(401);
  });
});

describe("POST /api/setup/dismiss", () => {
  it("stores the dismissal under the tenant's key and audits it", async () => {
    const res = await dismissRoute(post({ stepId: "invite", dismissed: true }));
    expect(res.status).toBe(200);
    expect(db.platformSetting.upsert).toHaveBeenCalledWith({
      where: { key: "setup:t1:dismissed" },
      create: { key: "setup:t1:dismissed", value: ["invite"] },
      update: { value: ["invite"] },
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "setup.step.dismissed", target: "invite", tenantId: "t1" }) });
  });

  it("is limited to owners and admins", async () => {
    auth.getActor.mockResolvedValue(agent);
    expect((await dismissRoute(post({ stepId: "invite", dismissed: true }))).status).toBe(403);
    expect(db.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests", async () => {
    expect((await dismissRoute(post({ stepId: "invite", dismissed: true }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await dismissRoute(post({ stepId: "invite", dismissed: true }, {}))).status).toBe(403);
    expect(db.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    expect((await dismissRoute(post({ stepId: "nope", dismissed: true }))).status).toBe(400);
    expect((await dismissRoute(post({ stepId: "invite", dismissed: "yes" }))).status).toBe(400);
    expect((await dismissRoute(post("not json"))).status).toBe(400);
    expect((await dismissRoute(post({ stepId: "invite", dismissed: true, pad: "x".repeat(2000) }))).status).toBe(413);
  });

  it("can bring a step back and keeps the others", async () => {
    db.platformSetting.findUnique.mockResolvedValue({ value: ["invite", "plan"] });
    expect(await setDismissed("t1", "invite", false)).toEqual(["plan"]);
    expect(await setDismissed("t1", "routing", true)).toEqual(["invite", "routing", "plan"]);
    expect(dismissedKey("t9")).toBe("setup:t9:dismissed");
  });
});

function seedDashboard() {
  const days = Array.from({ length: 14 }, (_, i) => `2026-10-${String(14 + i).padStart(2, "0")}`);
  reports.messagesAndConversations.mockResolvedValue({
    messagesPerDay: days.map((day, i) => ({ day, inbound: i < 7 ? 1 : 2, outbound: i < 7 ? 1 : 3, sent: 0, delivered: 0, read: 0, failed: 0 })),
    conversationsOpenedPerDay: days.map((day, i) => ({ day, count: i < 7 ? 1 : 2 })),
    source: "live",
  });
  reports.firstResponseSeconds.mockResolvedValue({ conversations: 3, medianSeconds: 120, p90Seconds: 300, capped: false });
  db.user.findUnique.mockResolvedValue({ name: "Asha Rao" });
  db.tenant.findUnique.mockResolvedValue({ name: "Acme Stores", onboardingStatus: "live" });
  db.conversation.count.mockResolvedValue(3);
  db.conversation.findMany.mockResolvedValue([
    { id: "c1", assignedToId: null, lastInboundAt: new Date(now.getTime() - 3 * 3600_000), contact: { name: null, phone: "919876543210" } },
  ]);
  db.membership.findMany.mockResolvedValue([]);
  db.message.count.mockResolvedValue(2);
  db.template.count.mockResolvedValue(1);
  db.template.findMany.mockResolvedValue([{ name: "diwali_offer" }]);
  db.metaConnection.findMany.mockResolvedValue([{ status: "active", tokenExpiresAt: new Date(now.getTime() + 2 * 86_400_000) }]);
}

describe("buildDashboard", () => {
  it("builds the four tiles with sparklines and week-on-week change for an admin", async () => {
    seedDashboard();
    const d = await buildDashboard(owner, { tz: "UTC", now });
    expect(d).toMatchObject({ firstName: "Asha", workspaceName: "Acme Stores", connected: true, role: "owner", userId: "u1", quiet: false });
    const [messages, conversations, response, open] = d.kpis;
    expect(messages).toMatchObject({ id: "messages", value: 35, deltaPct: 150, betterWhen: "up" });
    expect(messages.series).toHaveLength(7);
    expect(conversations).toMatchObject({ id: "conversations", value: 14, deltaPct: 100 });
    expect(response).toMatchObject({ id: "response", value: 120, deltaPct: 0, betterWhen: "down", unavailable: false });
    expect(response.series).toEqual(Array(7).fill(120));
    expect(open).toMatchObject({ id: "open", value: 3, series: null });
    expect(d.days).toHaveLength(7);
    expect(d.days[6].day).toBe("2026-10-27");
  });

  it("asks the report functions for the right windows, scoped to the tenant", async () => {
    seedDashboard();
    await buildDashboard(owner, { tz: "UTC", now });
    const [tenantId, range] = reports.messagesAndConversations.mock.calls[0];
    expect(tenantId).toBe("t1");
    expect(range).toMatchObject({ from: "2026-10-14", to: "2026-10-27" });
    expect(reports.firstResponseSeconds).toHaveBeenCalledTimes(9);
  });

  it("builds the needs-attention list for admins only", async () => {
    seedDashboard();
    const admin = await buildDashboard(owner, { tz: "UTC", now });
    expect(admin.attention.map((a) => a.id)).toEqual(["waiting", "unassigned", "failed", "templates", "token"]);
    expect(admin.queue.items[0]).toMatchObject({ name: "Contact ending 3210", waitingSeconds: 3 * 3600, assignedTo: null });

    seedDashboard();
    const forAgent = await buildDashboard(agent, { tz: "UTC", now });
    expect(forAgent.attention).toEqual([]);
    expect(db.message.count).toHaveBeenCalledTimes(1);
  });

  it("limits an agent's queue to their own chats", async () => {
    seedDashboard();
    await buildDashboard(agent, { tz: "UTC", now });
    const where = db.conversation.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: "t1", assignedToId: "u2", status: "open" });
  });

  it("scopes every conversation query to the tenant", async () => {
    seedDashboard();
    await buildDashboard(owner, { tz: "UTC", now });
    for (const call of [...db.conversation.count.mock.calls, ...db.conversation.findMany.mock.calls]) expect(call[0].where.tenantId).toBe("t1");
  });

  it("keeps working when a report query fails", async () => {
    seedDashboard();
    reports.messagesAndConversations.mockRejectedValue(new Error("sql"));
    reports.firstResponseSeconds.mockRejectedValue(new Error("sql"));
    const d = await buildDashboard(owner, { tz: "UTC", now });
    expect(d.kpis.find((k) => k.id === "messages")?.unavailable).toBe(true);
    expect(d.kpis.find((k) => k.id === "response")?.unavailable).toBe(true);
    expect(d.kpis.find((k) => k.id === "open")?.value).toBe(3);
    expect(d.days).toEqual([]);
  });

  it("reports a quiet workspace so the UI can show its empty state", async () => {
    seedDashboard();
    reports.messagesAndConversations.mockResolvedValue({
      messagesPerDay: Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${14 + i}`, inbound: 0, outbound: 0, sent: 0, delivered: 0, read: 0, failed: 0 })),
      conversationsOpenedPerDay: Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${14 + i}`, count: 0 })),
      source: "live",
    });
    reports.firstResponseSeconds.mockResolvedValue({ conversations: 0, medianSeconds: null, p90Seconds: null, capped: false });
    db.conversation.count.mockResolvedValue(0);
    db.conversation.findMany.mockResolvedValue([]);
    const d = await buildDashboard(owner, { tz: "UTC", now });
    expect(d.quiet).toBe(true);
    expect(d.kpis.find((k) => k.id === "response")).toMatchObject({ value: null, deltaPct: null, note: "No replies sent this week yet" });
  });

  it("falls back to UTC for an unknown time zone", async () => {
    seedDashboard();
    expect((await buildDashboard(owner, { tz: "Mars/Olympus", now })).tz).toBe("UTC");
  });

  it("maps an old browser zone name to the current one so the KPIs and chart still load", async () => {
    seedDashboard();
    const d = await buildDashboard(owner, { tz: "Asia/Calcutta", now });
    expect(d.tz).toBe("Asia/Kolkata");
    expect(d.days.length).toBeGreaterThan(0);
    expect(d.kpis.find((k) => k.id === "messages")?.unavailable).toBe(false);
    // Every range handed to the metrics layer (and so to SQL) carries the current name.
    for (const call of reports.messagesAndConversations.mock.calls) expect(call[1].tz).toBe("Asia/Kolkata");
    for (const call of reports.firstResponseSeconds.mock.calls) expect(call[1].tz).toBe("Asia/Kolkata");
  });
});

describe("GET /api/setup/dashboard", () => {
  it("returns the dashboard for the signed-in member", async () => {
    seedDashboard();
    const res = await dashboardRoute(get("https://wa.edwyz.com/api/setup/dashboard?tz=Asia/Kolkata"));
    expect(res.status).toBe(200);
    expect((await res.json()).tz).toBe("Asia/Kolkata");
  });
  it("accepts the old name Chrome on Windows reports for India", async () => {
    seedDashboard();
    const res = await dashboardRoute(get("https://wa.edwyz.com/api/setup/dashboard?tz=Asia%2FCalcutta"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tz).toBe("Asia/Kolkata");
    expect(body.days.length).toBeGreaterThan(0);
  });
});

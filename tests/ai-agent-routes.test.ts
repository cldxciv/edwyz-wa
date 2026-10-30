import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn(), aggregate: vi.fn(), findUnique: vi.fn() });
  return { aiAgent: model(), aiKnowledgeSource: model(), usageLedger: model(), auditLog: model(), phoneNumber: model(), plan: model() };
});
const auth = vi.hoisted(() => ({ role: "admin" as "agent" | "admin" | "owner" }));
// The AI test goes through the AI gateway (SPEND-CONTROLS-SPEC 4.10), which runs for real over tests/helpers/fake-ai-gateway.ts.
vi.mock("@/lib/db", async () => ({ prisma: Object.assign(db, { spendCounter: (await import("./helpers/fake-ai-gateway")).fakeAi.spendCounter }) }));
vi.mock("@/lib/spend/kill", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("kill", await orig()));
vi.mock("@/lib/spend/control", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("control", await orig()));
vi.mock("@/lib/spend/allowances", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("allowances", await orig()));
vi.mock("@/lib/spend/counters", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("counters", await orig()));
vi.mock("@/lib/spend/reservations", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("reservations", await orig()));
vi.mock("@/lib/spend/ledger", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("ledger", await orig()));
vi.mock("@/lib/spend/notify", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("notify", await orig()));
vi.mock("@/lib/lifecycle/state", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("lifecycle", await orig()));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: auth.role }) }));
vi.mock("@/lib/routing", () => ({ assignConversation: vi.fn(), getSettings: vi.fn(), isWithinWorkingHours: vi.fn() }));
vi.mock("@/lib/inbox/service", () => ({ sendText: vi.fn() }));
vi.mock("@/lib/byo-mcp", () => ({ listAllowedTools: vi.fn(async () => []), callTool: vi.fn() }));
vi.mock("@/lib/billing/status", () => ({ getBillingStatus: vi.fn(async () => ({ state: "active", planId: "p1" })) }));

import { GET as list, POST as create } from "@/app/api/ai-agent/agents/route";
import { DELETE as remove, PATCH as patch } from "@/app/api/ai-agent/agents/[id]/route";
import { GET as listSources, POST as addSource } from "@/app/api/ai-agent/agents/[id]/sources/route";
import { DELETE as removeSource } from "@/app/api/ai-agent/agents/[id]/sources/[sourceId]/route";
import { POST as testRoute } from "@/app/api/ai-agent/agents/[id]/test/route";
import { GET as usageRoute } from "@/app/api/ai-agent/usage/route";
import { fakeAi } from "./helpers/fake-ai-gateway";

const ORIGIN = "https://wa.edwyz.com";
const call = (path: string, body?: unknown, method = "POST", origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: "a1" }) };
const row = (extra: Record<string, unknown> = {}) => ({
  id: "a1", tenantId: "t1", name: "Bot", enabled: false, phoneNumberId: null, instructions: "Help", tone: null, language: "auto", activation: "always",
  handoffKeywords: [], maxRepliesPerConversation: 10, model: null, createdAt: new Date(), updatedAt: new Date(), ...extra,
});

beforeEach(async () => {
  vi.clearAllMocks();
  await fakeAi.reset();
  auth.role = "admin";
  db.aiAgent.count.mockResolvedValue(0);
  db.aiAgent.findFirst.mockResolvedValue(row());
  db.aiAgent.findMany.mockResolvedValue([row()]);
  db.aiAgent.create.mockImplementation(async ({ data }) => row(data));
  db.aiAgent.updateMany.mockResolvedValue({ count: 1 });
  db.aiAgent.deleteMany.mockResolvedValue({ count: 1 });
  db.aiKnowledgeSource.count.mockResolvedValue(0);
  db.aiKnowledgeSource.findMany.mockResolvedValue([]);
  db.aiKnowledgeSource.deleteMany.mockResolvedValue({ count: 1 });
  db.aiKnowledgeSource.create.mockImplementation(async ({ data }) => ({ id: "s1", createdAt: new Date(), ...data }));
});

describe("agents api", () => {
  it("lists for any member", async () => {
    auth.role = "agent";
    const res = await list(new Request(`${ORIGIN}/api/ai-agent/agents`));
    expect((await res.json()).agents).toHaveLength(1);
    expect(db.aiAgent.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });

  it("creates for admins, encodes minutes into activation, disabled by default", async () => {
    const res = await create(call("/api/ai-agent/agents", { name: "Bot", instructions: "Help", activation: "no_human_reply_minutes", noHumanReplyMinutes: 20 }));
    expect(res.status).toBe(201);
    const data = db.aiAgent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenantId: "t1", enabled: false, activation: "no_human_reply_minutes:20" });
    expect((await res.json()).agent).toMatchObject({ activation: "no_human_reply_minutes", noHumanReplyMinutes: 20 });
  });

  it("blocks agents, bad origins and bad input", async () => {
    auth.role = "agent";
    expect((await create(call("/api/ai-agent/agents", { name: "B", instructions: "x" }))).status).toBe(403);
    auth.role = "admin";
    expect((await create(call("/api/ai-agent/agents", { name: "B", instructions: "x" }, "POST", "https://evil.test"))).status).toBeGreaterThanOrEqual(400);
    expect((await create(call("/api/ai-agent/agents", { name: "B" }))).status).toBe(400);
    expect((await create(call("/api/ai-agent/agents", { name: "B", instructions: "x", maxRepliesPerConversation: 0 }))).status).toBe(400);
    expect((await create(call("/api/ai-agent/agents", { name: "B", instructions: "x", model: "gpt-4" }))).status).toBe(400);
    expect((await create(call("/api/ai-agent/agents", { name: "B", instructions: "x", model: "claude-opus-4-1" }))).status).toBe(400);
    expect(db.aiAgent.create).not.toHaveBeenCalled();
  });

  it("rejects a phone number from another workspace", async () => {
    db.phoneNumber.findFirst.mockResolvedValue(null);
    expect((await create(call("/api/ai-agent/agents", { name: "B", instructions: "x", phoneNumberId: "other" }))).status).toBe(400);
    expect(db.phoneNumber.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" });
  });

  it("updates and deletes scoped to the tenant", async () => {
    expect((await patch(call("/api/ai-agent/agents/a1", { enabled: true, handoffKeywords: ["Refund"] }, "PATCH"), ctx)).status).toBe(200);
    expect(db.aiAgent.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "a1", tenantId: "t1" }, data: { enabled: true, handoffKeywords: ["refund"] } });
    expect((await remove(call("/api/ai-agent/agents/a1", undefined, "DELETE"), ctx)).status).toBe(200);
    expect(db.aiAgent.deleteMany.mock.calls[0][0].where).toEqual({ id: "a1", tenantId: "t1" });
  });

  it("404s on another tenant's agent", async () => {
    db.aiAgent.findFirst.mockResolvedValue(null);
    expect((await patch(call("/api/ai-agent/agents/a1", { name: "x" }, "PATCH"), ctx)).status).toBe(404);
  });
});

describe("sources api", () => {
  it("adds a text source and never returns content", async () => {
    const res = await addSource(call("/api/ai-agent/agents/a1/sources", { kind: "text", title: "Hours", content: "Open 9 to 5" }), ctx);
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain("Open 9 to 5");
    expect(db.aiKnowledgeSource.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", agentId: "a1", kind: "text" });
  });

  it("refuses an unsafe url without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await addSource(call("/api/ai-agent/agents/a1/sources", { kind: "url", url: "http://169.254.169.254/latest" }), ctx);
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.aiKnowledgeSource.create).not.toHaveBeenCalled();
  });

  it("lists without content and deletes by tenant", async () => {
    db.aiKnowledgeSource.findMany.mockResolvedValue([{ id: "s1", kind: "text", title: "T", content: "secret body", sourceUrl: null, status: "ready", createdAt: new Date() }]);
    const body = await (await listSources(new Request(`${ORIGIN}/x`), ctx)).json();
    expect(body.sources[0]).toMatchObject({ id: "s1", chars: 11 });
    expect(JSON.stringify(body)).not.toContain("secret body");
    const res = await removeSource(call("/x", undefined, "DELETE"), { params: Promise.resolve({ id: "a1", sourceId: "s1" }) });
    expect(res.status).toBe(200);
    expect(db.aiKnowledgeSource.deleteMany.mock.calls[0][0].where).toEqual({ id: "s1", agentId: "a1", tenantId: "t1" });
  });

  it("only admins can add or delete", async () => {
    auth.role = "agent";
    expect((await addSource(call("/x", { kind: "text", content: "a" }), ctx)).status).toBe(403);
    expect((await removeSource(call("/x", undefined, "DELETE"), { params: Promise.resolve({ id: "a1", sourceId: "s1" }) })).status).toBe(403);
  });
});

describe("test and usage", () => {
  it("runs the generator without sending and meters one credit", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    db.aiKnowledgeSource.findMany.mockResolvedValue([{ id: "s1", title: "Hours", content: "We open at 9 on weekdays." }]);
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    db.usageLedger.create.mockResolvedValue({});
    db.plan.findUnique.mockResolvedValue({ aiCreditsMonthly: null });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "We open at 9." }] }) })));
    const res = await testRoute(call("/x", { message: "when do you open?" }), ctx);
    expect(await res.json()).toEqual({ text: "We open at 9.", handoff: false, sources: ["Hours"] });
    expect(db.usageLedger.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", meter: "ai_credits", amount: 1, refType: "ai_test", refId: "a1" });
    // One credit held and charged on the shared AI counter, nothing left held.
    expect(fakeAi.counter("t1", "month")).toEqual({ spent: 1n, reserved: 0n, used: 1n });
  });

  it("the AI test is something a person asked for: it keeps working while spending is stopped, and says so when the limit is used up", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    db.usageLedger.create.mockResolvedValue({});
    db.plan.findUnique.mockResolvedValue({ aiCreditsMonthly: 5 });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "We open at 9." }] }) })));
    fakeAi.freeze("all");
    expect((await testRoute(call("/x", { message: "when do you open?" }), ctx)).status).toBe(200);
    fakeAi.freeze("none");
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 5 } });
    await fakeAi.reset();
    const res = await testRoute(call("/x", { message: "when do you open?" }), ctx);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/^This month's AI limit is used up\./);
  });

  it("test requires a message and the admin role", async () => {
    expect((await testRoute(call("/x", { message: "" }), ctx)).status).toBe(400);
    auth.role = "agent";
    expect((await testRoute(call("/x", { message: "hi" }), ctx)).status).toBe(403);
  });

  it("reports usage against the plan limit", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 40 } });
    db.usageLedger.count.mockResolvedValue(40);
    db.plan.findUnique.mockResolvedValue({ aiCreditsMonthly: 100 });
    const body = await (await usageRoute(new Request(`${ORIGIN}/api/ai-agent/usage`))).json();
    expect(body).toEqual({ used: 40, limit: 100, remaining: 60, replies: 40, aiConfigured: true });
  });

  it("applies the platform default ceiling when the plan sets no AI credit limit", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 40 } });
    db.usageLedger.count.mockResolvedValue(40);
    db.plan.findUnique.mockResolvedValue({ aiCreditsMonthly: null });
    const body = await (await usageRoute(new Request(`${ORIGIN}/api/ai-agent/usage`))).json();
    // The platform default is 1,500 credits a month (EDDY-SPEC 12.1a decision 2; it was 200 before Eddy).
    expect(body).toEqual({ used: 40, limit: 1500, remaining: 1460, replies: 40, aiConfigured: true });
  });

  it("says AI is off when the server has no key, so the page does not show a budget that can never be used", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      db.usageLedger.count.mockResolvedValue(0);
      db.plan.findUnique.mockResolvedValue({ aiCreditsMonthly: null });
      const body = await (await usageRoute(new Request(`${ORIGIN}/api/ai-agent/usage`))).json();
      expect(body).toMatchObject({ used: 0, limit: 1500, aiConfigured: false });
    } finally {
      if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
    }
  });
});

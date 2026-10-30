import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() });
  const activity = () => ({ findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) });
  return { automationRule: model(), phoneNumber: model(), apiKey: model(), webhookEndpoint: model(), ruleExecution: activity(), automationRun: activity() };
});
const auth = vi.hoisted(() => ({ role: "admin" as "agent" | "admin" | "owner" }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: auth.role }) }));

import { GET as listRulesRoute, POST as createRuleRoute } from "@/app/api/automation/route";
import { DELETE as deleteRuleRoute } from "@/app/api/automation/[id]/route";
import { POST as testRoute } from "@/app/api/automation/test/route";
import { POST as createKeyRoute } from "@/app/api/integrations/api-keys/route";
import { POST as createHookRoute } from "@/app/api/integrations/webhooks/route";
import { worker } from "@/lib/integrations/worker";

const ORIGIN = "https://wa.edwyz.com";
const call = (path: string, body: unknown, origin: string | null = ORIGIN, method = "POST") =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: "r1" }) };
const validRule = { type: "keyword", name: "Prices", keywords: ["price"], replyText: "See our price list." };

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = "admin";
  db.automationRule.count.mockResolvedValue(0);
  db.automationRule.create.mockImplementation(async ({ data }) => ({ id: "r1", ...data }));
});

describe("automation routes", () => {
  it("agents can read but not create or delete", async () => {
    auth.role = "agent";
    db.automationRule.findMany.mockResolvedValue([]);
    expect((await listRulesRoute(new Request(`${ORIGIN}/api/automation`))).status).toBe(200);
    expect((await createRuleRoute(call("/api/automation", validRule))).status).toBe(403);
    expect((await deleteRuleRoute(call("/api/automation/r1", undefined, ORIGIN, "DELETE"), ctx)).status).toBe(403);
    expect(db.automationRule.create).not.toHaveBeenCalled();
  });
  it("admins create rules scoped to their tenant", async () => {
    const res = await createRuleRoute(call("/api/automation", validRule));
    expect(res.status).toBe(201);
    expect(db.automationRule.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", type: "keyword", keywords: ["price"] });
  });
  it("blocks cross-origin and origin-less writes", async () => {
    expect((await createRuleRoute(call("/api/automation", validRule, "https://evil.example"))).status).toBe(403);
    expect((await createRuleRoute(call("/api/automation", validRule, null))).status).toBe(403);
    expect((await createKeyRoute(call("/api/integrations/api-keys", { name: "k", scopes: ["messages:write"] }, "https://evil.example"))).status).toBe(403);
  });
  it("validates rules", async () => {
    expect((await createRuleRoute(call("/api/automation", { ...validRule, keywords: [] }))).status).toBe(400);
    expect((await createRuleRoute(call("/api/automation", { type: "away", name: "a", replyText: "x" }))).status).toBe(400);
    expect((await createRuleRoute(call("/api/automation", { ...validRule, replyText: "x".repeat(1025) }))).status).toBe(400);
    expect((await createRuleRoute(call("/api/automation", { ...validRule, type: "bogus" }))).status).toBe(400);
    expect((await createRuleRoute(call("/api/automation", { type: "away", name: "a", replyText: "x", schedule: { timezone: "Nope/Zone", days: [1], start: "09:00", end: "17:00" } }))).status).toBe(400);
  });
  it("delete is tenant scoped and 404s for foreign rules", async () => {
    db.automationRule.deleteMany.mockResolvedValue({ count: 0 });
    expect((await deleteRuleRoute(call("/api/automation/r1", undefined, ORIGIN, "DELETE"), ctx)).status).toBe(404);
    expect(db.automationRule.deleteMany).toHaveBeenCalledWith({ where: { id: "r1", tenantId: "t1" } });
  });
  it("the test box picks the rule that would answer and ignores disabled ones", async () => {
    db.automationRule.findMany.mockResolvedValue([
      { id: "a", type: "keyword", name: "Off", enabled: false, keywords: ["price"], matchMode: "contains", replyText: "off", schedule: null, cooldownMinutes: 5, phoneNumberId: null, createdAt: new Date() },
      { id: "b", type: "keyword", name: "Prices", enabled: true, keywords: ["price"], matchMode: "contains", replyText: "Price list", schedule: null, cooldownMinutes: 5, phoneNumberId: null, createdAt: new Date() },
    ]);
    const body = await (await testRoute(call("/api/automation/test", { text: "what is the price?" }))).json();
    expect(body.rule).toMatchObject({ id: "b", name: "Prices" });
    const none = await (await testRoute(call("/api/automation/test", { text: "hello" }))).json();
    expect(none.rule).toBeNull();
  });
});

describe("integration management routes", () => {
  it("agents cannot create keys or endpoints", async () => {
    auth.role = "agent";
    expect((await createKeyRoute(call("/api/integrations/api-keys", { name: "k", scopes: ["messages:write"] }))).status).toBe(403);
    expect((await createHookRoute(call("/api/integrations/webhooks", { url: "https://example.com/h", events: ["message.received"] }))).status).toBe(403);
  });
  it("refuses a private webhook URL before storing anything", async () => {
    const res = await createHookRoute(call("/api/integrations/webhooks", { url: "https://127.0.0.1/h", events: ["message.received"] }));
    expect(res.status).toBe(400);
    expect(db.webhookEndpoint.create).not.toHaveBeenCalled();
  });
});

describe("worker registration", () => {
  it("consumes the outbound-webhook queue", () => {
    expect(Object.keys(worker.queues)).toEqual(["outbound-webhook"]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The AI agent's hourly reply cap comes from the workspace's plan (owner decision 3): Starter 60, Growth 200, Agency 600, the
 * plan's own value first; AI_MAX_REPLIES_PER_HOUR only when no plan value can be found. When the cap holds a message back, the
 * admins get one notice for the hour. Same mocks as tests/ai-agent.test.ts (the AI gateway runs over the fake).
 */

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn(), aggregate: vi.fn(), findUnique: vi.fn() });
  return { aiAgent: model(), aiKnowledgeSource: model(), conversation: model(), contact: model(), message: model(), usageLedger: model(), auditLog: model(), phoneNumber: model(), plan: model(), platformSetting: { findUnique: vi.fn() } };
});
vi.mock("@/lib/db", async () => ({ prisma: Object.assign(db, { spendCounter: (await import("./helpers/fake-ai-gateway")).fakeAi.spendCounter }) }));
vi.mock("@/lib/spend/kill", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("kill", await orig()));
vi.mock("@/lib/spend/control", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("control", await orig()));
vi.mock("@/lib/spend/allowances", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("allowances", await orig()));
vi.mock("@/lib/spend/counters", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("counters", await orig()));
vi.mock("@/lib/spend/reservations", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("reservations", await orig()));
vi.mock("@/lib/spend/ledger", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("ledger", await orig()));
vi.mock("@/lib/spend/notify", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("notify", await orig()));
vi.mock("@/lib/lifecycle/state", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("lifecycle", await orig()));
const inbox = vi.hoisted(() => ({ sendText: vi.fn() }));
vi.mock("@/lib/inbox/service", () => inbox);
const routing = vi.hoisted(() => ({ assignConversation: vi.fn(), getSettings: vi.fn(), isWithinWorkingHours: vi.fn() }));
vi.mock("@/lib/routing", () => routing);
const mcp = vi.hoisted(() => ({ listAllowedTools: vi.fn(), callTool: vi.fn() }));
vi.mock("@/lib/byo-mcp", () => mcp);
const usage = vi.hoisted(() => ({ recordUsage: vi.fn(), usedThisMonth: vi.fn() }));
vi.mock("@/lib/usage", async (orig) => ({ ...(await orig<typeof import("@/lib/usage")>()), ...usage }));
const billing = vi.hoisted(() => ({ getBillingStatus: vi.fn() }));
vi.mock("@/lib/billing/status", () => billing);
const tenantState = vi.hoisted(() => ({ tenantMayRunBackground: vi.fn() }));
vi.mock("@/lib/tenant-state", () => tenantState);
vi.mock("@/lib/integrations/emitters", () => ({ emitStatusChanged: vi.fn(async () => undefined) }));
const hourly = vi.hoisted(() => ({ noteHourlyCapHit: vi.fn(async () => undefined) }));
vi.mock("@/lib/billing/ai-hourly", async (orig) => ({ ...(await orig<typeof import("@/lib/billing/ai-hourly")>()), noteHourlyCapHit: hourly.noteHourlyCapHit }));

import { handleInboundForAiAgent, hourlyReplyUse, maxRepliesPerHour, repliesPerHourFor, resetAiReservations } from "@/lib/ai-agent";
import { registerAiAgentSeams, resetAiAgentSeams } from "@/lib/ai-agent/seams";
import { resetAiHourlyCache } from "@/lib/billing/ai-hourly";
import { fakeAi } from "./helpers/fake-ai-gateway";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const textReply = (text: string) => ({ ok: true, json: async () => ({ content: [{ type: "text", text }] }) });

const now = new Date();
const input = { tenantId: "t1", phoneNumberId: "p1", conversationId: "c1", contactId: "k1", text: "Where is my order?", receivedAt: now };
const agent = { id: "a1", tenantId: "t1", enabled: true, phoneNumberId: null, instructions: "Help", tone: null, language: "auto", activation: "always", handoffKeywords: [], maxRepliesPerConversation: 5, model: null, createdAt: new Date() };
/** The workspace's hourly count has no chat (refId); the per-chat count of the last day does. */
const repliesThisHour = (n: number) => db.usageLedger.count.mockImplementation(async ({ where }: { where: { refId?: unknown } }) => (where.refId ? 0 : n));
const onPlan = (plan: { code: string; name: string; features?: unknown }) => {
  billing.getBillingStatus.mockResolvedValue({ state: "active", planId: "p1" });
  db.plan.findUnique.mockResolvedValue({ features: {}, ...plan });
};

beforeEach(async () => {
  vi.clearAllMocks();
  await fakeAi.reset();
  db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  resetAiAgentSeams();
  resetAiReservations();
  resetAiHourlyCache();
  process.env.ANTHROPIC_API_KEY = "test-key";
  for (const name of ["AI_DEFAULT_MONTHLY_CREDITS", "AI_ALLOWED_MODELS", "AI_MODEL", "AI_MAX_REPLIES_PER_HOUR"]) delete process.env[name];
  tenantState.tenantMayRunBackground.mockResolvedValue(true);
  billing.getBillingStatus.mockResolvedValue(undefined);
  db.plan.findUnique.mockResolvedValue(null);
  db.platformSetting.findUnique.mockResolvedValue(null);
  db.conversation.findFirst.mockResolvedValue({ status: "open", tags: [], lastInboundAt: now, contactId: "k1" });
  db.conversation.updateMany.mockResolvedValue({ count: 1 });
  db.contact.findFirst.mockResolvedValue({ name: "Asha", optedOutAt: null });
  db.aiAgent.findMany.mockResolvedValue([agent]);
  db.aiKnowledgeSource.findMany.mockResolvedValue([]);
  db.message.findFirst.mockResolvedValue({ direction: "inbound", createdAt: now });
  db.message.findMany.mockResolvedValue([{ direction: "inbound", body: input.text, type: "text" }]);
  db.usageLedger.findFirst.mockResolvedValue(null);
  repliesThisHour(0);
  usage.usedThisMonth.mockResolvedValue(0);
  mcp.listAllowedTools.mockResolvedValue([]);
  routing.getSettings.mockResolvedValue({ timezone: "UTC", workingHours: null });
  inbox.sendText.mockResolvedValue({ id: "m1" });
  registerAiAgentSeams({ getMonthlyCreditLimit: async () => null });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(textReply("It ships tomorrow."));
});

describe("the hourly cap comes from the plan", () => {
  it("Growth: 200 replies an hour, even with AI_MAX_REPLIES_PER_HOUR set lower", async () => {
    process.env.AI_MAX_REPLIES_PER_HOUR = "3";
    onPlan({ code: "growth", name: "Growth" });
    repliesThisHour(199);
    expect(await handleInboundForAiAgent(input)).toBe(true);
    expect(inbox.sendText).toHaveBeenCalledTimes(1);
    resetAiReservations();
    repliesThisHour(200);
    expect(await handleInboundForAiAgent({ ...input, conversationId: "c2" })).toBe(false);
    expect(inbox.sendText).toHaveBeenCalledTimes(1);
  });

  it("Starter: 60; Agency: 600", async () => {
    onPlan({ code: "starter", name: "Starter" });
    repliesThisHour(60);
    expect(await handleInboundForAiAgent(input)).toBe(false);
    resetAiHourlyCache();
    resetAiReservations();
    onPlan({ code: "agency", name: "Agency" });
    repliesThisHour(599);
    expect(await handleInboundForAiAgent({ ...input, conversationId: "c3" })).toBe(true);
  });

  it("the plan's own value wins over its code", async () => {
    onPlan({ code: "growth", name: "Growth", features: { aiRepliesPerHour: 10 } });
    repliesThisHour(10);
    expect(await handleInboundForAiAgent(input)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AI_MAX_REPLIES_PER_HOUR applies only when no plan value can be found", async () => {
    process.env.AI_MAX_REPLIES_PER_HOUR = "3";
    onPlan({ code: "pro", name: "Pro" });
    expect(await repliesPerHourFor("t1")).toEqual({ limit: 3, source: "fallback", planName: "Pro" });
    expect(maxRepliesPerHour()).toBe(3);
    repliesThisHour(3);
    expect(await handleInboundForAiAgent(input)).toBe(false);
  });

  it("a trial gets 60", async () => {
    billing.getBillingStatus.mockResolvedValue({ state: "trialing", planId: null });
    expect(await repliesPerHourFor("t1")).toMatchObject({ limit: 60, source: "trial" });
  });

  it("raises the hour's notice with what was used and the limit, and the message waits for the team", async () => {
    onPlan({ code: "starter", name: "Starter" });
    repliesThisHour(60);
    expect(await handleInboundForAiAgent(input)).toBe(false);
    expect(hourly.noteHourlyCapHit).toHaveBeenCalledWith("t1", { used: 60, limit: 60 });
    // No hand-off: the chat stays with the team, unanswered by the AI, until the hour frees up.
    expect(routing.assignConversation).not.toHaveBeenCalled();
    expect(inbox.sendText).not.toHaveBeenCalled();
  });

  it("no notice while there is room", async () => {
    onPlan({ code: "starter", name: "Starter" });
    repliesThisHour(10);
    expect(await handleInboundForAiAgent(input)).toBe(true);
    expect(hourly.noteHourlyCapHit).not.toHaveBeenCalled();
  });

  it("the AI agent screen's numbers: the same count and allowance as the admission", async () => {
    onPlan({ code: "growth", name: "Growth" });
    repliesThisHour(42);
    expect(await hourlyReplyUse("t1")).toEqual({ used: 42, limit: 200, source: "plan_default" });
    const where = db.usageLedger.count.mock.calls.at(-1)![0].where;
    expect(where).toMatchObject({ tenantId: "t1", meter: "ai_credits", refType: "ai_reply" });
    expect(Date.now() - where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(3_600_000 - 1000);
  });
});

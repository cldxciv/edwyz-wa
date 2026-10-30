import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), count: vi.fn(), aggregate: vi.fn(), findUnique: vi.fn() });
  return { aiAgent: model(), aiKnowledgeSource: model(), conversation: model(), contact: model(), message: model(), usageLedger: model(), chatbotSession: model(), platformSetting: { findUnique: vi.fn() } };
});
// Replies go through the AI gateway (SPEND-CONTROLS-SPEC 4.10), which runs for real over tests/helpers/fake-ai-gateway.ts.
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
vi.mock("@/lib/routing", () => ({ assignConversation: vi.fn(), getSettings: vi.fn().mockResolvedValue({ timezone: "UTC", workingHours: null }), isWithinWorkingHours: vi.fn() }));
vi.mock("@/lib/byo-mcp", () => ({ listAllowedTools: vi.fn().mockResolvedValue([]), callTool: vi.fn() }));
vi.mock("@/lib/usage", async (orig) => ({ ...(await orig<typeof import("@/lib/usage")>()), recordUsage: vi.fn(), usedThisMonth: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/billing/status", () => ({ getBillingStatus: vi.fn() }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: vi.fn().mockResolvedValue(true) }));

import { handleInboundForAiAgent } from "@/lib/ai-agent";
import { registerAiAgentSeams } from "@/lib/ai-agent/seams";
import { fakeAi } from "./helpers/fake-ai-gateway";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("one bot or AI agent per chat", () => {
  const now = new Date();
  const input = { tenantId: "t1", phoneNumberId: "p1", conversationId: "c1", contactId: "k1", text: "What are your opening hours?", receivedAt: now };
  const agent = { id: "a1", tenantId: "t1", enabled: true, phoneNumberId: null, instructions: "Help", tone: null, language: "auto", activation: "always", handoffKeywords: [], maxRepliesPerConversation: 5, model: null, createdAt: new Date() };

  beforeEach(async () => {
    vi.clearAllMocks();
    await fakeAi.reset();
    process.env.ANTHROPIC_API_KEY = "test-key";
    registerAiAgentSeams({ getMonthlyCreditLimit: async () => null });
    db.platformSetting.findUnique.mockResolvedValue(null);
    db.conversation.findFirst.mockResolvedValue({ status: "open", tags: [], lastInboundAt: now, contactId: "k1" });
    db.contact.findFirst.mockResolvedValue({ name: "Asha", optedOutAt: null });
    db.aiAgent.findMany.mockResolvedValue([agent]);
    db.aiKnowledgeSource.findMany.mockResolvedValue([{ id: "s1", title: "Hours", content: "We are open 9 to 5." }]);
    db.message.findFirst.mockResolvedValue({ direction: "inbound", createdAt: now });
    db.message.findMany.mockResolvedValue([{ direction: "inbound", body: input.text, type: "text" }]);
    db.usageLedger.count.mockResolvedValue(0);
    db.usageLedger.findFirst.mockResolvedValue(null);
    db.chatbotSession.count.mockResolvedValue(0);
    inbox.sendText.mockResolvedValue({ id: "m1" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: "text", text: "We are open 9 to 5." }] }) });
  });

  it("answers when no chatbot is running", async () => {
    expect(await handleInboundForAiAgent(input)).toBe(true);
    expect(inbox.sendText).toHaveBeenCalledTimes(1);
    expect(db.chatbotSession.count.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", status: { in: ["waiting", "active"] }, OR: [{ conversationId: "c1" }, { contactId: "k1" }] });
  });

  it("stays quiet while a chatbot is waiting for an answer or sleeping in the same chat", async () => {
    db.chatbotSession.count.mockResolvedValue(1);
    expect(await handleInboundForAiAgent(input)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inbox.sendText).not.toHaveBeenCalled();
  });

  it("an unreadable session table never takes the AI agent down", async () => {
    db.chatbotSession.count.mockRejectedValue(new Error("db blip"));
    expect(await handleInboundForAiAgent(input)).toBe(true);
  });
});

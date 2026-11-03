import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() });
  return { conversation: model(), message: model(), aiAgent: model(), template: model(), lead: model(), platformSetting: { findUnique: vi.fn() }, usageLedger: { aggregate: vi.fn() } };
});
// Suggestions hold their credit through the AI gateway (SPEND-CONTROLS-SPEC 4.10), which runs for real over
// tests/helpers/fake-ai-gateway.ts. Credits already used this month reach its counter through usageLedger.aggregate (I12).
vi.mock("@/lib/db", async () => ({ prisma: Object.assign(db, { spendCounter: (await import("./helpers/fake-ai-gateway")).fakeAi.spendCounter }) }));
vi.mock("@/lib/spend/kill", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("kill", await orig()));
vi.mock("@/lib/spend/control", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("control", await orig()));
vi.mock("@/lib/spend/allowances", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("allowances", await orig()));
vi.mock("@/lib/spend/counters", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("counters", await orig()));
vi.mock("@/lib/spend/reservations", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("reservations", await orig()));
vi.mock("@/lib/spend/ledger", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("ledger", await orig()));
vi.mock("@/lib/spend/notify", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("notify", await orig()));
vi.mock("@/lib/lifecycle/state", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("lifecycle", await orig()));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: "agent" }) }));
const ai = vi.hoisted(() => ({ retrieveChunks: vi.fn(), generateReply: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/ai-agent", () => ({ retrieveChunks: ai.retrieveChunks }));
vi.mock("@/lib/ai-agent/seams", () => ({ getSeams: () => ({ getMonthlyCreditLimit: ai.limit }) }));
const tenantState = vi.hoisted(() => ({ ok: vi.fn() }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: tenantState.ok }));
vi.mock("@/lib/byo-mcp", () => ({ listAllowedTools: vi.fn(), callTool: vi.fn() }));
vi.mock("@/lib/ai-agent/generate", async (orig) => ({ ...(await orig<typeof import("@/lib/ai-agent/generate")>()), generateReply: ai.generateReply }));
const usage = vi.hoisted(() => ({ recordUsage: vi.fn(), usedThisMonth: vi.fn() }));
vi.mock("@/lib/usage", async (orig) => ({ ...(await orig<typeof import("@/lib/usage")>()), ...usage }));
const inbox = vi.hoisted(() => ({ sendText: vi.fn(), sendMedia: vi.fn(), sendTemplateMessage: vi.fn() }));
vi.mock("@/lib/inbox/service", async (orig) => ({ ...(await orig<typeof import("@/lib/inbox/service")>()), ...inbox }));
const guard = vi.hoisted(() => ({ assertCanActOnConversation: vi.fn() }));
vi.mock("@/lib/inbox/status", async (orig) => ({ ...(await orig<typeof import("@/lib/inbox/status")>()), ...guard }));
const media = vi.hoisted(() => ({ mediaExists: vi.fn(), mediaPublicUrl: vi.fn(), saveUpload: vi.fn() }));
vi.mock("@/lib/content/media", async (orig) => ({ ...(await orig<typeof import("@/lib/content/media")>()), ...media }));
const upload = vi.hoisted(() => ({ uploadAttachmentToMeta: vi.fn() }));
vi.mock("@/lib/inbox/upload", () => upload);

import { POST as attach } from "@/app/api/inbox/conversations/[id]/attachments/route";
import { GET as contextRoute } from "@/app/api/inbox/conversations/[id]/context/route";
import { POST as messagesRoute } from "@/app/api/inbox/conversations/[id]/messages/route";
import { POST as suggestRoute } from "@/app/api/inbox/conversations/[id]/suggest/route";
import { summarizeLeadFields } from "@/lib/inbox/context";
import { parseDrafts, pickPromptText, pickSuggestAgent, resetSuggestLimits, suggestInstructions } from "@/lib/inbox/suggest";
import { fakeAi } from "./helpers/fake-ai-gateway";

/** Credits this workspace already used this month, as the gateway reads them when it starts the month's AI counter. */
const usedCredits = (amount: number) => db.usageLedger.aggregate.mockResolvedValue({ _sum: { amount } });
/** recordUsage's detail when the gateway settles a hold: the counters already moved (generateReply is mocked, so no tokens). */
const SETTLED = { inputTokens: null, outputTokens: null, model: null, counted: true };

const ORIGIN = "https://wa.edwyz.com";
const ctx = { params: Promise.resolve({ id: "c1" }) };
const post = (path: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(async () => {
  vi.clearAllMocks();
  await fakeAi.reset();
  usedCredits(0);
  guard.assertCanActOnConversation.mockResolvedValue(undefined);
  resetSuggestLimits();
  process.env.ANTHROPIC_API_KEY = "test-key";
  ai.limit.mockResolvedValue(null);
  tenantState.ok.mockResolvedValue(true);
  ai.retrieveChunks.mockResolvedValue([]);
  usage.usedThisMonth.mockResolvedValue(0);
  db.conversation.findFirst.mockResolvedValue({ id: "c1", phoneNumberId: "p1", contact: { name: "Asha" } });
  db.aiAgent.findMany.mockResolvedValue([]);
  db.message.findMany.mockResolvedValue([{ direction: "inbound", body: "Do you ship to Pune?", type: "text" }]);
  ai.generateReply.mockResolvedValue({ text: '["Yes, we ship to Pune.","Yes! Delivery takes 3 days."]', handoff: false, toolCalls: 0 });
});

describe("suggest helpers", () => {
  it("parses a JSON array, a fenced one, and falls back to paragraphs", () => {
    expect(parseDrafts('["a","b","a"," "]')).toEqual(["a", "b"]);
    expect(parseDrafts('```json\n["one","two","three","four"]\n```')).toEqual(["one", "two", "three"]);
    expect(parseDrafts("1. First idea\n\n2. Second idea")).toEqual(["First idea", "Second idea"]);
    expect(parseDrafts("[broken")).toEqual([]);
    expect(parseDrafts("")).toEqual([]);
    expect(parseDrafts(JSON.stringify(["x".repeat(900)]))[0]).toHaveLength(600);
  });
  it("answers the customer's last message, otherwise drafts a follow-up", () => {
    expect(pickPromptText([{ direction: "outbound", body: "hello" }, { direction: "inbound", body: " price? " }])).toBe("price?");
    expect(pickPromptText([{ direction: "inbound", body: "price?" }, { direction: "outbound", body: "100" }])).toMatch(/follow-up/);
    expect(pickPromptText([{ direction: "inbound", body: null, type: "image" }])).toMatch(/follow-up/);
  });
  it("prefers an enabled agent bound to the number", () => {
    const agents = [
      { id: "a", enabled: true, phoneNumberId: null },
      { id: "b", enabled: true, phoneNumberId: "p1" },
      { id: "c", enabled: false, phoneNumberId: "p1" },
      { id: "d", enabled: true, phoneNumberId: "p2" },
    ];
    expect(pickSuggestAgent(agents, "p1")?.id).toBe("b");
    expect(pickSuggestAgent(agents.slice(2, 3), "p1")?.id).toBe("c");
    expect(pickSuggestAgent([agents[3]], "p1")).toBeNull();
    expect(pickSuggestAgent([], "p1")).toBeNull();
  });
  it("keeps the business instructions and adds the drafting rules", () => {
    const text = suggestInstructions("Sell shoes.");
    expect(text).toContain("Sell shoes.");
    expect(text).toContain("JSON array");
    expect(text).toContain("Nothing you write is sent automatically");
  });
});

describe("POST suggest", () => {
  it("returns 503 without a key and spends nothing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await suggestRoute(post("/x"), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("AI is not configured.");
    expect(usage.recordUsage).not.toHaveBeenCalled();
    expect(ai.generateReply).not.toHaveBeenCalled();
  });

  it("rejects a cross-site request", async () => {
    const res = await suggestRoute(new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: "https://evil.example" } }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns drafts, scopes every read to the tenant and records one credit", async () => {
    const res = await suggestRoute(post("/x"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ drafts: ["Yes, we ship to Pune.", "Yes! Delivery takes 3 days."], handoff: false, grounded: false, agentName: null });
    expect(db.conversation.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1" });
    expect(db.message.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", conversationId: "c1" });
    expect(db.aiAgent.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
    expect(usage.recordUsage).toHaveBeenCalledWith("t1", "ai_credits", 1, { type: "inbox_suggest", id: "c1" }, SETTLED);
    expect(fakeAi.counter("t1", "month")).toEqual({ spent: 1n, reserved: 0n, used: 1n });
    expect(inbox.sendText).not.toHaveBeenCalled();
  });

  it("holds the credit for the model rounds as inbox_suggest, asked for by the member", async () => {
    await suggestRoute(post("/x"), ctx);
    expect(ai.generateReply.mock.calls[0][0].meter).toMatchObject({ feature: "inbox_suggest", actor: { type: "user", userId: "u1", role: "agent" } });
  });

  it("keeps working while spending is stopped, because a person asked (decision 2.3.11)", async () => {
    fakeAi.freeze("all", "all");
    expect((await suggestRoute(post("/x"), ctx)).status).toBe(200);
  });

  it("grounds the prompt in the agent's knowledge", async () => {
    db.aiAgent.findMany.mockResolvedValue([{ id: "ag1", name: "Support", enabled: true, phoneNumberId: null, instructions: "Sell shoes.", tone: "warm", language: "auto", model: null }]);
    ai.retrieveChunks.mockResolvedValue([{ sourceId: "s", title: "Shipping", text: "We ship to Pune in 3 days." }]);
    const res = await suggestRoute(post("/x"), ctx);
    expect(await res.json()).toMatchObject({ grounded: true, agentName: "Support" });
    expect(ai.retrieveChunks).toHaveBeenCalledWith("t1", "ag1", "Do you ship to Pune?");
    const input = ai.generateReply.mock.calls[0][0];
    expect(input.chunks).toHaveLength(1);
    expect(input.agent.instructions).toContain("Sell shoes.");
    expect(input.history.at(-1)).toEqual({ role: "user", text: "Do you ship to Pune?" });
    expect(input.tools).toBeUndefined();
  });

  it("reports a handoff with no drafts instead of failing", async () => {
    ai.generateReply.mockResolvedValue({ text: "", handoff: true, toolCalls: 0 });
    const body = await (await suggestRoute(post("/x"), ctx)).json();
    expect(body).toMatchObject({ drafts: [], handoff: true });
  });

  it("is rate limited to 10 per minute per user", async () => {
    for (let i = 0; i < 10; i++) expect((await suggestRoute(post("/x"), ctx)).status).toBe(200);
    const res = await suggestRoute(post("/x"), ctx);
    expect(res.status).toBe(429);
    expect(ai.generateReply).toHaveBeenCalledTimes(10);
  });

  it("stops when the plan's credits are used up", async () => {
    ai.limit.mockResolvedValue(100);
    usedCredits(100);
    const res = await suggestRoute(post("/x"), ctx);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/^This month's AI limit is used up\./);
    expect(ai.generateReply).not.toHaveBeenCalled();
  });

  it("parallel suggestions cannot all pass the same credit check", async () => {
    ai.limit.mockResolvedValue(2);
    usedCredits(0);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    ai.generateReply.mockImplementation(async () => {
      await gate;
      return { text: '["Hi"]', handoff: false, toolCalls: 0 };
    });
    const all = Promise.all(Array.from({ length: 4 }, () => suggestRoute(post("/x"), ctx)));
    await vi.waitFor(() => expect(ai.generateReply).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    open();
    const statuses = (await all).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 402, 402]);
    expect(ai.generateReply).toHaveBeenCalledTimes(2);
  });

  it("applies the platform ceiling when the plan sets no credit limit (P3-11)", async () => {
    delete process.env.AI_DEFAULT_MONTHLY_CREDITS;
    ai.limit.mockResolvedValue(null);
    // The platform ceiling is 1,500 credits a month (EDDY-SPEC 12.1a decision 2; it was 200 before Eddy). The gateway reads
    // past usage once, when it starts the month's counter, so each case below starts from a fresh counter.
    usedCredits(1500);
    expect((await suggestRoute(post("/x"), ctx)).status).toBe(402);
    expect(ai.generateReply).not.toHaveBeenCalled();
    await fakeAi.reset();
    usedCredits(1499);
    expect((await suggestRoute(post("/x"), ctx)).status).toBe(200);
    await fakeAi.reset();
    process.env.AI_DEFAULT_MONTHLY_CREDITS = "5";
    usedCredits(5);
    expect((await suggestRoute(post("/x"), ctx)).status).toBe(402);
    delete process.env.AI_DEFAULT_MONTHLY_CREDITS;
  });

  it("denies suggestions for a workspace that is locked or suspended (P3-11)", async () => {
    tenantState.ok.mockResolvedValue(false);
    expect((await suggestRoute(post("/x"), ctx)).status).toBe(403);
    expect(ai.generateReply).not.toHaveBeenCalled();
    expect(usage.recordUsage).not.toHaveBeenCalled();
  });

  it("404s for another tenant's conversation and 409s on an empty thread", async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    expect((await suggestRoute(post("/x"), ctx)).status).toBe(404);
    db.conversation.findFirst.mockResolvedValue({ id: "c1", phoneNumberId: "p1", contact: { name: null } });
    db.message.findMany.mockResolvedValue([]);
    expect((await suggestRoute(post("/x"), ctx)).status).toBe(409);
  });

  it("does not charge when the model call fails", async () => {
    ai.generateReply.mockRejectedValue(Object.assign(new Error("down"), { status: 502 }));
    await suggestRoute(post("/x"), ctx);
    expect(usage.recordUsage).not.toHaveBeenCalled();
    // The hold goes back: nothing stays reserved on the AI counter.
    await vi.waitFor(() => expect(fakeAi.openHolds("t1")).toBe(0));
    expect(fakeAi.counter("t1", "month")).toEqual({ spent: 0n, reserved: 0n, used: 0n });
  });
});

describe("context", () => {
  it("shortens lead answers to labelled scalars", () => {
    expect(summarizeLeadFields({ full_name: "Asha Rao", city: " Pune ", empty: "", nested: { a: 1 }, budget: 5000 })).toEqual([
      { label: "full name", value: "Asha Rao" },
      { label: "city", value: "Pune" },
      { label: "budget", value: "5000" },
    ]);
    expect(summarizeLeadFields(null)).toEqual([]);
    expect(summarizeLeadFields(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v"])))).toHaveLength(8);
  });

  it("reads lead, counts and other chats with the tenant on every query", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1", contactId: "ct1", contact: { createdAt: new Date("2026-01-01") } });
    db.lead.findFirst.mockResolvedValue({ id: "l1", status: "new", createdAt: new Date(), fields: { city: "Pune" }, adMetaId: "ad1", campaignMetaId: null, consentAt: null, assignedToId: null, leadForm: { name: "Spring" } });
    db.message.count.mockResolvedValueOnce(12).mockResolvedValueOnce(5);
    db.conversation.findMany.mockResolvedValue([{ id: "c2", status: "open", lastMessageAt: new Date(), unreadCount: 0, phoneNumber: { displayPhone: "+91 99999" } }]);
    const res = await contextRoute(new Request(`${ORIGIN}/x`), ctx);
    const body = await res.json();
    expect(body.lead).toMatchObject({ id: "l1", formName: "Spring", fields: [{ label: "city", value: "Pune" }] });
    expect(body.stats).toMatchObject({ messages: 12, received: 5 });
    expect(body.otherChats).toEqual([expect.objectContaining({ id: "c2", number: "+91 99999" })]);
    expect(db.lead.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", contactId: "ct1" });
    expect(db.conversation.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", contactId: "ct1", id: { not: "c1" } });
  });

  it("returns null lead when the contact has none and 404 for unknown conversations", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1", contactId: "ct1", contact: { createdAt: new Date() } });
    db.lead.findFirst.mockResolvedValue(null);
    db.message.count.mockResolvedValue(0);
    db.conversation.findMany.mockResolvedValue([]);
    expect((await (await contextRoute(new Request(`${ORIGIN}/x`), ctx)).json()).lead).toBeNull();
    db.conversation.findFirst.mockResolvedValue(null);
    expect((await contextRoute(new Request(`${ORIGIN}/x`), ctx)).status).toBe(404);
  });
});

describe("messages route additions", () => {
  const key = `${"a".repeat(32)}.jpg`;

  it("sends an uploaded attachment through a signed link built on the server", async () => {
    media.mediaExists.mockResolvedValue(true);
    media.mediaPublicUrl.mockReturnValue("https://wa.edwyz.com/api/content/media-public/t1/signed");
    inbox.sendMedia.mockResolvedValue({ id: "m1" });
    const res = await messagesRoute(post("/x", { type: "image", mediaKey: key, caption: "Look" }), ctx);
    expect(res.status).toBe(201);
    expect(media.mediaExists).toHaveBeenCalledWith("t1", key);
    expect(inbox.sendMedia).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", mediaType: "image", media: "https://wa.edwyz.com/api/content/media-public/t1/signed", mime: "image/jpeg", caption: "Look" }));
  });

  it("rejects bad keys, kind mismatches and missing files", async () => {
    media.mediaExists.mockResolvedValue(true);
    expect((await messagesRoute(post("/x", { type: "image", mediaKey: "../../etc/passwd" }), ctx)).status).toBe(400);
    expect((await messagesRoute(post("/x", { type: "video", mediaKey: key }), ctx)).status).toBe(400);
    media.mediaExists.mockResolvedValue(false);
    expect((await messagesRoute(post("/x", { type: "image", mediaKey: key }), ctx)).status).toBe(400);
    expect(inbox.sendMedia).not.toHaveBeenCalled();
  });

  describe("template", () => {
    const template = (extra: Record<string, unknown> = {}) => ({
      id: "tp1", tenantId: "t1", name: "order_update", language: "en", category: "UTILITY", status: "approved",
      components: [{ type: "BODY", text: "Hi {{1}}, order {{2}} is ready." }], ...extra,
    });
    const convo = (extra: Record<string, unknown> = {}) => ({ id: "c1", phoneNumberId: "p1", contactId: "ct1", contact: { optIn: true, optedOutAt: null, ...extra } });

    beforeEach(() => {
      db.conversation.findFirst.mockResolvedValue(convo());
      db.template.findFirst.mockResolvedValue(template());
      inbox.sendTemplateMessage.mockResolvedValue({ id: "m9", body: "[template] order_update" });
      db.message.updateMany.mockResolvedValue({ count: 1 });
    });

    it("sends with body parameters and stores the rendered text", async () => {
      const res = await messagesRoute(post("/x", { type: "template", templateId: "tp1", variables: ["Asha", "A-12"] }), ctx);
      expect(res.status).toBe(201);
      expect(db.template.findFirst.mock.calls[0][0].where).toEqual({ id: "tp1", tenantId: "t1" });
      expect(inbox.sendTemplateMessage).toHaveBeenCalledWith({
        tenantId: "t1", phoneNumberId: "p1", contactId: "ct1", templateName: "order_update", language: "en",
        components: [{ type: "body", parameters: [{ type: "text", text: "Asha" }, { type: "text", text: "A-12" }] }],
        conversationId: "c1", userId: "u1", origin: "human",
      });
      expect(db.message.updateMany).toHaveBeenCalledWith({ where: { id: "m9", tenantId: "t1" }, data: { body: "Hi Asha, order A-12 is ready." } });
      expect((await res.json()).message.body).toBe("Hi Asha, order A-12 is ready.");
    });

    it("sends an order update (utility) to a contact who opted out: an opt-out stops marketing only", async () => {
      db.conversation.findFirst.mockResolvedValue(convo({ optIn: false, optedOutAt: new Date() }));
      const res = await messagesRoute(post("/x", { type: "template", templateId: "tp1", variables: ["Asha", "A-12"] }), ctx);
      expect(res.status).toBe(201);
      expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
    });

    it("refuses marketing to opted-out contacts, unapproved templates and marketing without opt-in", async () => {
      db.conversation.findFirst.mockResolvedValue(convo({ optedOutAt: new Date() }));
      db.template.findFirst.mockResolvedValue(template({ category: "MARKETING" }));
      expect((await messagesRoute(post("/x", { type: "template", templateId: "tp1", variables: ["a", "b"] }), ctx)).status).toBe(422);
      db.conversation.findFirst.mockResolvedValue(convo());
      db.template.findFirst.mockResolvedValue(template({ status: "pending" }));
      expect((await messagesRoute(post("/x", { type: "template", templateId: "tp1", variables: ["a", "b"] }), ctx)).status).toBe(409);
      db.template.findFirst.mockResolvedValue(template({ category: "MARKETING" }));
      db.conversation.findFirst.mockResolvedValue(convo({ optIn: false }));
      expect((await messagesRoute(post("/x", { type: "template", templateId: "tp1", variables: ["a", "b"] }), ctx)).status).toBe(422);
      expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it("validates the variables and unknown templates", async () => {
      expect((await messagesRoute(post("/x", { type: "template", templateId: "tp1", variables: ["only one"] }), ctx)).status).toBe(400);
      expect((await messagesRoute(post("/x", { type: "template", templateId: "tp1", variables: ["a", ""] }), ctx)).status).toBe(400);
      db.template.findFirst.mockResolvedValue(null);
      expect((await messagesRoute(post("/x", { type: "template", templateId: "nope", variables: [] }), ctx)).status).toBe(404);
      db.template.findFirst.mockResolvedValue(template({ components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "x" }] }));
      expect((await messagesRoute(post("/x", { type: "template", templateId: "tp1", variables: [] }), ctx)).status).toBe(422);
    });

    it("refuses a template of another WhatsApp Business Account than the chat's number before anything is queued", async () => {
      db.conversation.findFirst.mockResolvedValue({ ...convo(), phoneNumber: { wabaRefId: "waba_a" } });
      db.template.findFirst.mockResolvedValue(template({ wabaRefId: "waba_b" }));
      const res = await messagesRoute(post("/x", { type: "template", templateId: "tp1", variables: ["Asha", "A-12"] }), ctx);
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/different WhatsApp business account/);
      expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
      expect(db.conversation.findFirst.mock.calls[0][0].select.phoneNumber).toEqual({ select: { wabaRefId: true } });
      db.template.findFirst.mockResolvedValue(template({ wabaRefId: "waba_a" }));
      expect((await messagesRoute(post("/x", { type: "template", templateId: "tp1", variables: ["Asha", "A-12"] }), ctx)).status).toBe(201);
      expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
    });

    it("does not leak across tenants when the conversation is not theirs", async () => {
      db.conversation.findFirst.mockResolvedValue(null);
      expect((await messagesRoute(post("/x", { type: "template", templateId: "tp1", variables: ["a", "b"] }), ctx)).status).toBe(404);
      expect(db.conversation.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1" });
    });
  });
});

describe("chats assigned to a teammate", () => {
  it("refuses messages and suggestions from an agent before anything is sent or spent", async () => {
    const { HttpError } = await import("@/lib/tenancy");
    guard.assertCanActOnConversation.mockRejectedValue(new HttpError(403, "This conversation is assigned to someone else."));
    expect((await messagesRoute(post("/x", { type: "text", body: "hi" }), ctx)).status).toBe(403);
    expect(inbox.sendText).not.toHaveBeenCalled();
    expect((await suggestRoute(post("/x"), ctx)).status).toBe(403);
    expect(ai.generateReply).not.toHaveBeenCalled();
  });
});

describe("attachments route", () => {
  const photo = () => new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "content-type": "image/png", "content-length": "5" }, body: "bytes" });

  it("uploads a photo to WhatsApp for the caller's tenant after checking the conversation, never to the media library", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1" });
    upload.uploadAttachmentToMeta.mockResolvedValue({ mediaId: "55", kind: "image", mime: "image/png", bytes: 5, filename: "file" });
    const res = await attach(photo(), ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ mediaId: "55", kind: "image" });
    expect(db.conversation.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1" });
    expect(upload.uploadAttachmentToMeta).toHaveBeenCalledWith("t1", "c1", expect.any(Request));
    expect(media.saveUpload).not.toHaveBeenCalled();
  });

  it("404s for foreign conversations and rejects cross-site posts", async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    expect((await attach(photo(), ctx)).status).toBe(404);
    expect(upload.uploadAttachmentToMeta).not.toHaveBeenCalled();
    expect((await attach(new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: "https://evil.example" }, body: "b" }), ctx)).status).toBe(403);
  });
});

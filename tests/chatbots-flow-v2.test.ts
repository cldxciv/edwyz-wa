import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() });
  return { chatbot: model(), chatbotSession: model(), contact: model(), team: model(), phoneNumber: model() };
});
vi.mock("@/lib/db", () => ({ prisma: db }));

import { DEFAULT_BOT_SETTINGS, parseSettings, validateFlow } from "@/lib/chatbots/flow";
import { createChatbot, FlowInvalidError, listSessions, publishChatbot, sessionStats, updateChatbot } from "@/lib/chatbots/service";

const n = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, position: { x: 0, y: 0 }, data });
const flowOf = (nodes: unknown[], edges: unknown[] = [], extra: Record<string, unknown> = {}) => ({ version: 1, start: (nodes[0] as { id: string }).id, nodes, edges, ...extra });
const errors = (f: unknown) => validateFlow(f).errors.map((e) => e.message);

describe("node fields", () => {
  it("keeps header and footer of buttons and lists within the WhatsApp limits", () => {
    const buttons = n("a", "send_buttons", { text: "Pick", header: "H".repeat(60), footer: "F".repeat(60), buttons: [{ id: "x", title: "One" }] });
    expect(validateFlow(flowOf([buttons])).flow?.nodes[0].data).toMatchObject({ header: "H".repeat(60), footer: "F".repeat(60) });
    expect(errors(flowOf([n("a", "send_buttons", { text: "Pick", header: "H".repeat(61), buttons: [{ id: "x", title: "One" }] })])).join()).toMatch(/Header must be text of at most 60/);
    expect(errors(flowOf([n("a", "send_list", { text: "Pick", buttonLabel: "Open", footer: "F".repeat(61), rows: [{ id: "x", title: "One" }] })])).join()).toMatch(/Footer must be text of at most 60/);
  });

  it("accepts template header, media and button values, and rejects insecure header links", () => {
    const ok = validateFlow(flowOf([n("t", "send_template", { templateId: "tp", variables: { "1": "{{name}}" }, headerVariable: "Hi", headerMediaUrl: "https://cdn.example.com/a.png", buttonVariable: "{{order}}" })]));
    expect(ok.ok).toBe(true);
    expect(ok.flow?.nodes[0].data).toMatchObject({ headerVariable: "Hi", headerMediaUrl: "https://cdn.example.com/a.png", buttonVariable: "{{order}}" });
    expect(validateFlow(flowOf([n("t", "send_template", { templateId: "tp", variables: {}, headerMediaUrl: "{{photo}}" })])).ok).toBe(true);
    expect(errors(flowOf([n("t", "send_template", { templateId: "tp", variables: {}, headerMediaUrl: "http://x.example.com/a.png" })])).join()).toMatch(/https/);
  });

  it("a template step can have an error connection", () => {
    const f = flowOf([n("t", "send_template", { templateId: "tp", variables: {} }), n("e", "end", {})], [{ id: "e1", from: "t", to: "e", label: "error" }]);
    expect(validateFlow(f).ok).toBe(true);
    expect(errors(flowOf([n("t", "send_template", { templateId: "tp", variables: {} }), n("e", "end", {})], [{ id: "e1", from: "t", to: "e", label: "nope" }])).join()).toMatch(/not valid for a send_template/);
  });

  it("assign needs a teammate or a team; handoff takes a team, teammate and note switch", () => {
    expect(validateFlow(flowOf([n("a", "assign", { userId: "round_robin" })])).ok).toBe(true);
    expect(validateFlow(flowOf([n("a", "assign", { userId: "", teamId: "team1" })])).flow?.nodes[0].data).toEqual({ userId: "", teamId: "team1" });
    expect(errors(flowOf([n("a", "assign", { userId: "" })])).join()).toMatch(/teammate or a team/);
    expect(validateFlow(flowOf([n("h", "handoff", { message: "Bye", teamId: "t1", userId: "u1", note: false })])).flow?.nodes[0].data).toEqual({ message: "Bye", teamId: "t1", userId: "u1", note: false });
    expect(validateFlow(flowOf([n("h", "handoff", {})])).flow?.nodes[0].data).toEqual({});
  });
});

describe("bot settings", () => {
  it("fills in defaults", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_BOT_SETTINGS);
    expect(parseSettings({}).escalation).toEqual({ enabled: true, useAi: false, keywords: [] });
    expect(DEFAULT_BOT_SETTINGS).toMatchObject({ priority: 100, keywordMatch: "contains", skipAssignedChats: true, stopOnHumanReply: true, interactive: true });
  });

  it("is lenient when reading and strict when reporting", () => {
    const bad = { priority: 0, keywordMatch: "fuzzy", skipAssignedChats: "yes", escalation: { enabled: "no", keywords: "refund" } };
    expect(parseSettings(bad)).toMatchObject({ priority: 100, keywordMatch: "contains", skipAssignedChats: true });
    const problems: string[] = [];
    parseSettings(bad, (m) => problems.push(m));
    expect(problems.join(" | ")).toMatch(/Priority must be a whole number from 1 to 999/);
    expect(problems.join(" | ")).toMatch(/Keyword matching/);
    expect(problems.join(" | ")).toMatch(/Skip assigned chats must be on or off/);
    expect(problems.join(" | ")).toMatch(/Smart escalation must be on or off/);
    expect(problems.join(" | ")).toMatch(/Escalation words/);
  });

  it("is kept in the validated flow and its mistakes block publishing", () => {
    const good = validateFlow(flowOf([n("a", "send_text", { text: "x" })], [], { settings: { priority: 7, escalation: { keywords: [" refund ", ""], teamId: "team1" } } }));
    expect(good.flow?.settings).toMatchObject({ priority: 7, escalation: { keywords: ["refund"], teamId: "team1", enabled: true } });
    expect(validateFlow(flowOf([n("a", "send_text", { text: "x" })])).flow).not.toHaveProperty("settings");
    expect(errors(flowOf([n("a", "send_text", { text: "x" })], [], { settings: { priority: 5000 } })).join()).toMatch(/Priority/);
  });
});

describe("saving and publishing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.chatbot.count.mockResolvedValue(0);
    db.chatbot.updateMany.mockResolvedValue({ count: 1 });
  });
  const stored = (flow: unknown, extra: Record<string, unknown> = {}) => ({ id: "b1", tenantId: "t1", name: "Bot", status: "draft", triggerType: "any_message", triggerKeywords: [], flow, publishedFlow: null, version: 1, ...extra });

  it("drafts keep their settings and refuse nonsense", async () => {
    db.chatbot.create.mockImplementation(async ({ data }) => ({ id: "n", ...data }));
    const created = await createChatbot("t1", "u1", { name: "Bot", flow: flowOf([n("a", "send_text", { text: "x" })], [], { settings: { priority: 3 } }) });
    expect(created.flow).toMatchObject({ settings: { priority: 3, skipAssignedChats: true } });
    await expect(createChatbot("t1", "u1", { name: "Bot", flow: flowOf([n("a", "send_text", { text: "x" })], [], { settings: { priority: 0 } }) })).rejects.toMatchObject({ status: 400 });
  });

  it("updating can change the number the bot is tied to, but only to one of the workspace", async () => {
    db.chatbot.findFirst.mockResolvedValue(stored(flowOf([n("a", "send_text", { text: "x" })])));
    db.phoneNumber.findFirst.mockResolvedValue(null);
    await expect(updateChatbot("t1", "b1", { phoneNumberId: "foreign" })).rejects.toMatchObject({ status: 400 });
    expect(db.phoneNumber.findFirst.mock.calls[0][0].where).toEqual({ id: "foreign", tenantId: "t1" });
  });

  it("publishing stops when a team used in the flow no longer exists", async () => {
    const flow = flowOf([n("h", "handoff", { teamId: "gone" })], [], { settings: { escalation: { teamId: "alive" } } });
    db.chatbot.findFirst.mockResolvedValue(stored(flow));
    db.team.findMany.mockResolvedValue([{ id: "alive" }]);
    await expect(publishChatbot("t1", "b1")).rejects.toBeInstanceOf(FlowInvalidError);
    expect(db.team.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", id: { in: expect.arrayContaining(["gone", "alive"]) } });
    expect(db.chatbot.updateMany).not.toHaveBeenCalled();
  });

  it("publishes when every team exists, and skips the check when no team is used", async () => {
    const flow = flowOf([n("h", "handoff", { teamId: "alive" })]);
    db.chatbot.findFirst.mockResolvedValue(stored(flow));
    db.team.findMany.mockResolvedValue([{ id: "alive" }]);
    await publishChatbot("t1", "b1");
    expect(db.chatbot.updateMany).toHaveBeenCalled();
    db.team.findMany.mockClear();
    db.chatbot.findFirst.mockResolvedValue(stored(flowOf([n("a", "send_text", { text: "x" })])));
    await publishChatbot("t1", "b1");
    expect(db.team.findMany).not.toHaveBeenCalled();
  });
});

describe("conversation list and numbers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.chatbot.findFirst.mockResolvedValue({ id: "b1", tenantId: "t1" });
  });

  it("sessions carry the customer's name and phone, looked up inside the workspace", async () => {
    db.chatbotSession.findMany.mockResolvedValue([
      { id: "s1", contactId: "k1", status: "completed" },
      { id: "s2", contactId: "k2", status: "waiting" },
      { id: "s3", contactId: "k1", status: "expired" },
    ]);
    db.contact.findMany.mockResolvedValue([{ id: "k1", name: "Asha", phone: "+911" }]);
    const page = await listSessions("t1", "b1", { limit: 2 });
    expect(db.contact.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", id: { in: ["k1", "k2"] } });
    expect(page.items.map((i) => i.contact)).toEqual([{ name: "Asha", phone: "+911" }, null]);
    expect(page.nextCursor).toBe("s2");
  });

  it("statistics count the last 30 days by outcome, scoped to the workspace and the bot", async () => {
    db.chatbotSession.groupBy.mockResolvedValue([
      { status: "completed", _count: { _all: 6 } },
      { status: "handed_off", _count: { _all: 3 } },
      { status: "expired", _count: { _all: 1 } },
    ]);
    const stats = await sessionStats("t1", "b1");
    expect(stats).toMatchObject({ days: 30, total: 10, completionPercent: 60, handoffPercent: 30, expiredPercent: 10 });
    expect(stats.counts).toEqual({ active: 0, waiting: 0, completed: 6, handed_off: 3, expired: 1 });
    expect(db.chatbotSession.groupBy.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", chatbotId: "b1" });
  });

  it("statistics with no sessions are all zero", async () => {
    db.chatbotSession.groupBy.mockResolvedValue([]);
    expect(await sessionStats("t1", "b1")).toMatchObject({ total: 0, completionPercent: 0, handoffPercent: 0 });
  });

  it("statistics of another workspace's bot are refused", async () => {
    db.chatbot.findFirst.mockResolvedValue(null);
    await expect(sessionStats("t2", "b1")).rejects.toMatchObject({ status: 404 });
  });
});

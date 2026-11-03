import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const store = vi.hoisted(() => ({ sessions: [] as Row[], chatbots: [] as Row[], contacts: [] as Row[], conversations: [] as Row[], messages: [] as Row[], clock: 0 }));

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("in" in cond) return cond.in.includes(value);
      if ("lte" in cond) return value != null && value <= cond.lte;
      if ("lt" in cond) return value != null && value < cond.lt;
      if ("gt" in cond) return value != null && value > cond.gt;
      if ("not" in cond) return value !== cond.not;
    }
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    return value === cond;
  });

const model = (rows: () => Row[], defaults: () => Row = () => ({})) => ({
  findFirst: vi.fn(async ({ where }: Row) => {
    const r = rows().find((x) => matches(x, where));
    return r ? { ...r } : null;
  }),
  findMany: vi.fn(async ({ where, take }: Row = {}) => rows().filter((r) => matches(r, where)).slice(0, take ?? 1000).map((r) => ({ ...r }))),
  count: vi.fn(async ({ where }: Row = {}) => rows().filter((r) => matches(r, where)).length),
  create: vi.fn(async ({ data }: Row) => {
    const row = { id: `${rows().length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...defaults(), ...data };
    rows().push(row);
    return row;
  }),
  updateMany: vi.fn(async ({ where, data }: Row) => {
    const hit = rows().filter((r) => matches(r, where));
    hit.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }));
    return { count: hit.length };
  }),
});

const db = vi.hoisted(() => ({}) as Record<string, any>);
vi.mock("@/lib/db", () => ({ prisma: db }));
const inbox = vi.hoisted(() => ({ sendText: vi.fn(), sendTemplateMessage: vi.fn() }));
vi.mock("@/lib/inbox/service", () => inbox);
const interactive = vi.hoisted(() => ({ sendInteractive: vi.fn() }));
vi.mock("@/lib/inbox/interactive", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/inbox/interactive")>()), sendInteractive: interactive.sendInteractive }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/billing", () => ({ getBillingStatus: async () => ({ canWrite: true }) }));
vi.mock("@/lib/chatbots/http", () => ({ callWebhook: vi.fn() }));
const ai = vi.hoisted(() => ({ classify: vi.fn() }));
vi.mock("@/lib/chatbots/escalation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/chatbots/escalation")>()), classifyWithAi: ai.classify }));

import { handleInboundForChatbots, startChatbot } from "@/lib/chatbots";
import { stopBotsOnHumanReply } from "@/lib/chatbots/human-reply";
import { endChatbotSessionsForContact } from "@/lib/chatbots/opt-out";
import { registerChatbotSeams, resetChatbotSeams } from "@/lib/chatbots/seams";
import { resumeDelayedSessions } from "@/lib/chatbots/worker";

const T = "t1";
const node = (id: string, type: string, data: Row = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (from: string, to: string, label?: string) => ({ id: `${from}-${to}-${label ?? ""}`, from, to, ...(label ? { label } : {}) });
const flow = (nodes: Row[], edges: Row[], settings?: Row) => ({ version: 1, start: nodes[0].id, nodes, edges, ...(settings ? { settings } : {}) });

function addBot(f: Row, extra: Row = {}) {
  const bot = { id: `bot${store.chatbots.length + 1}`, tenantId: T, phoneNumberId: null, status: "published", triggerType: "keyword", triggerKeywords: ["hi"], publishedFlow: f, flow: f, createdAt: new Date(store.clock++), ...extra };
  store.chatbots.push(bot);
  return bot;
}

const inbound = (text: string, extra: Row = {}) => ({ tenantId: T, phoneNumberId: "pn1", conversationId: "c1", contactId: "k1", text, receivedAt: new Date(), ...extra });
const sent = () => inbox.sendText.mock.calls.map((c) => c[0].body as string);
const session = () => store.sessions[store.sessions.length - 1];

beforeEach(() => {
  vi.clearAllMocks();
  resetChatbotSeams();
  store.sessions = [];
  store.chatbots = [];
  store.messages = [];
  store.clock = 0;
  store.contacts = [{ id: "k1", tenantId: T, phone: "+911111111111", name: "Asha", attributes: {}, tags: [], optedOutAt: null }];
  store.conversations = [
    { id: "c1", tenantId: T, phoneNumberId: "pn1", contactId: "k1", status: "open", phoneNumber: { wabaRefId: "w1" }, lastInboundAt: new Date() },
    { id: "c2", tenantId: T, phoneNumberId: "pn2", contactId: "k1", status: "open", phoneNumber: { wabaRefId: "w1" }, lastInboundAt: new Date() },
  ];
  Object.assign(db, {
    chatbotSession: model(() => store.sessions, () => ({ variables: {}, waitingNodeId: null, wakeAt: null, endedAt: null, startedAt: new Date(Date.now() + store.clock++) })),
    chatbot: model(() => store.chatbots),
    contact: model(() => store.contacts),
    conversation: model(() => store.conversations),
    message: model(() => store.messages),
    template: model(() => []),
    usageLedger: model(() => []),
    note: { create: vi.fn() },
    membership: model(() => [{ id: "m1", tenantId: T, userId: "u9" }]),
    tenant: { findUnique: vi.fn(async () => ({ status: "active", deletedAt: null })) },
  });
  interactive.sendInteractive.mockResolvedValue({});
  inbox.sendText.mockResolvedValue({});
  ai.classify.mockResolvedValue(null);
});

const askBot = (settings?: Row, ask: Row = {}) =>
  addBot(flow([node("q", "ask", { text: "What is your issue?", variable: "issue", validate: "text", maxRetries: 1, ...ask }), node("t", "send_text", { text: "Thanks" })], [edge("q", "t")], settings));

describe("a teammate reply stops the bot at once", () => {
  it("ends the live session of the chat the moment a teammate writes", async () => {
    askBot();
    await handleInboundForChatbots(inbound("hi"));
    expect(session().status).toBe("waiting");
    expect(await stopBotsOnHumanReply(T, "c1")).toBe(1);
    expect(session().status).toBe("handed_off");
    expect(session().waitingNodeId).toBeNull();
  });

  it("leaves bots alone that are set not to step aside, and other chats", async () => {
    askBot({ stopOnHumanReply: false });
    await handleInboundForChatbots(inbound("hi"));
    expect(await stopBotsOnHumanReply(T, "c1")).toBe(0);
    expect(session().status).toBe("waiting");
    expect(await stopBotsOnHumanReply(T, "c2")).toBe(0);
  });

  it("ends a delayed session too, so nothing is sent when its wait is over", async () => {
    addBot(flow([node("a", "send_text", { text: "First" }), node("d", "delay", { minutes: 1 }), node("b", "send_text", { text: "Second" })], [edge("a", "d"), edge("d", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    await stopBotsOnHumanReply(T, "c1");
    session().wakeAt = new Date(Date.now() - 1000);
    expect(await resumeDelayedSessions()).toBe(0);
    expect(sent()).toEqual(["First"]);
  });

  it("a run that is still working does not bring the ended session back", async () => {
    addBot(flow([node("a", "send_text", { text: "First" }), node("q", "ask", { text: "Q?", variable: "x", validate: "text", maxRetries: 1 })], [edge("a", "q")]));
    inbox.sendText.mockImplementationOnce(async () => {
      await stopBotsOnHumanReply(T, "c1");
      return {};
    });
    await handleInboundForChatbots(inbound("hi"));
    expect(session().status).toBe("handed_off");
  });

  it("never throws when the database is unavailable", async () => {
    db.chatbotSession.findMany.mockRejectedValueOnce(new Error("db blip"));
    expect(await stopBotsOnHumanReply(T, "c1")).toBe(0);
  });
});

describe("opt-out stops running bots", () => {
  it("a tapped button titled Cancel is an answer, not a STOP", async () => {
    addBot(
      flow(
        [node("m", "send_buttons", { text: "Choose", buttons: [{ id: "b1", title: "Cancel" }, { id: "b2", title: "Keep" }] }), node("c", "send_text", { text: "Cancelled for you" })],
        [edge("m", "c", "b1")],
      ),
    );
    await handleInboundForChatbots(inbound("hi"));
    expect(await handleInboundForChatbots(inbound("Cancel", { replyId: "b1" }))).toBe(true);
    expect(sent()).toEqual(["Cancelled for you"]);
    expect(session().status).toBe("completed");
  });

  it("a typed STOP still ends the session", async () => {
    askBot();
    await handleInboundForChatbots(inbound("hi"));
    expect(await handleInboundForChatbots(inbound("STOP"))).toBe(false);
    expect(session().status).toBe("completed");
  });

  it("endChatbotSessionsForContact ends sessions in every chat of the contact", async () => {
    askBot();
    await handleInboundForChatbots(inbound("hi"));
    store.sessions.push({ id: "other", tenantId: T, contactId: "k1", conversationId: "c2", status: "waiting", chatbotId: "bot1", updatedAt: new Date(), startedAt: new Date() });
    store.sessions.push({ id: "someone-else", tenantId: T, contactId: "k9", conversationId: "c9", status: "waiting", chatbotId: "bot1", updatedAt: new Date(), startedAt: new Date() });
    expect(await endChatbotSessionsForContact(T, "k1")).toBe(2);
    expect(store.sessions.find((s) => s.id === "someone-else")?.status).toBe("waiting");
  });

  it("a delay that ends after the contact sent STOP sends nothing", async () => {
    addBot(flow([node("a", "send_text", { text: "First" }), node("d", "delay", { minutes: 1 }), node("b", "send_text", { text: "Second" })], [edge("a", "d"), edge("d", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    // STOP arrives after the session started (the processor normally ends it too; this is the engine's own check).
    store.contacts[0].optedOutAt = new Date(session().startedAt.getTime() + 1);
    session().wakeAt = new Date(Date.now() - 1000);
    await resumeDelayedSessions();
    expect(sent()).toEqual(["First"]);
    expect(session().status).toBe("completed");
  });

  it("a waiting session of a contact who opted out is closed instead of answered", async () => {
    askBot();
    await handleInboundForChatbots(inbound("hi"));
    store.contacts[0].optedOutAt = new Date(session().startedAt.getTime() + 1);
    expect(await handleInboundForChatbots(inbound("my printer is broken"))).toBe(false);
    expect(sent()).toEqual(["What is your issue?"]);
    expect(session().status).toBe("completed");
  });

  it("a contact who opted out before the bot started still gets its answers: an opt-out stops marketing only", async () => {
    store.contacts[0].optedOutAt = new Date(0);
    askBot();
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(true);
    expect(sent()).toEqual(["What is your issue?"]);
    expect(session().status).toBe("waiting");
  });
});

describe("one bot per contact", () => {
  it("a manual start is refused while a bot talks to the same contact on another number", async () => {
    askBot();
    addBot(flow([node("a", "send_text", { text: "Hello" })], []), { id: "second", triggerType: "manual" });
    await handleInboundForChatbots(inbound("hi", { conversationId: "c2", phoneNumberId: "pn2" }));
    expect(session().status).toBe("waiting");
    await expect(startChatbot({ tenantId: T }, "second", "c1", { source: "manual" })).rejects.toMatchObject({ status: 409 });
    expect(sent()).toEqual(["What is your issue?"]);
  });

  it("starts when the other session is old enough to have timed out", async () => {
    askBot();
    addBot(flow([node("a", "send_text", { text: "Hello" })], []), { id: "second", triggerType: "manual" });
    await handleInboundForChatbots(inbound("hi", { conversationId: "c2", phoneNumberId: "pn2" }));
    session().updatedAt = new Date(Date.now() - 25 * 3_600_000);
    await expect(startChatbot({ tenantId: T }, "second", "c1", { source: "manual" })).resolves.toMatchObject({ status: "completed" });
  });

  it("two inbound messages racing: the later one gives way and sends nothing", async () => {
    askBot();
    db.chatbotSession.findMany.mockResolvedValueOnce([{ id: "0", startedAt: new Date(0) }]);
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(false);
    expect(sent()).toEqual([]);
    expect(session().status).toBe("expired");
  });

  it("a manual start racing a newer start gives way; an older one is ended", async () => {
    addBot(flow([node("a", "send_text", { text: "Hello" })], []), { triggerType: "manual" });
    db.chatbotSession.findMany.mockResolvedValueOnce([{ id: "zz", startedAt: new Date(Date.now() + 60_000) }]);
    await expect(startChatbot({ tenantId: T }, "bot1", "c1", { source: "manual" })).rejects.toMatchObject({ status: 409 });
    expect(sent()).toEqual([]);

    store.sessions.push({ id: "old", tenantId: T, contactId: "k1", conversationId: "c1", chatbotId: "bot1", status: "waiting", updatedAt: new Date(), startedAt: new Date(0) });
    db.chatbotSession.findMany.mockResolvedValueOnce([{ id: "old", startedAt: new Date(0) }]);
    await startChatbot({ tenantId: T }, "bot1", "c1", { source: "manual" });
    expect(store.sessions.find((s) => s.id === "old")?.status).toBe("expired");
    expect(sent()).toEqual(["Hello"]);
  });
});

describe("smart escalation on free-text questions", () => {
  const escalated = () => session().status === "handed_off";

  it("hands over when the customer shows frustration in a free-text answer", async () => {
    askBot();
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("this is useless, you do not understand"));
    expect(escalated()).toBe(true);
    expect(session().variables.escalation_reason).toBe("frustration");
  });

  it("hands over when a customer shouts", async () => {
    askBot();
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("WHY IS NOBODY ANSWERING ME"));
    expect(escalated()).toBe(true);
  });

  it("an ordinary answer that merely contains a job title is not escalated", async () => {
    askBot();
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("Support Manager"));
    expect(escalated()).toBe(false);
    expect(session().variables.issue).toBe("Support Manager");
  });

  it("asks AI about a sentence typed as a free-text answer when no keyword matched, but not about a short answer", async () => {
    askBot({ escalation: { enabled: true, useAi: true, keywords: [] } });
    await handleInboundForChatbots(inbound("hi"));
    ai.classify.mockResolvedValueOnce({ kind: "frustration", source: "ai" });
    await handleInboundForChatbots(inbound("I have asked three times already and nothing happened"));
    expect(ai.classify).toHaveBeenCalledTimes(1);
    expect(escalated()).toBe(true);

    store.sessions = [];
    ai.classify.mockClear();
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("printer"));
    expect(ai.classify).not.toHaveBeenCalled();
  });

  it("does not ask AI when the answer is a plain valid value", async () => {
    askBot({ escalation: { enabled: true, useAi: true, keywords: [] } }, { validate: "email" });
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("asha@example.com"));
    expect(ai.classify).not.toHaveBeenCalled();
    expect(session().status).toBe("completed");
  });
});

describe("hand-over to a team queue", () => {
  it("leaves the chat in the team queue and asks routing not to pick anyone", async () => {
    const seams = { assign: vi.fn(), assignTeam: vi.fn(), setStatus: vi.fn(), handoff: vi.fn() };
    registerChatbotSeams(seams);
    addBot(flow([node("h", "handoff", { teamId: "team1", userId: "team_queue" })], []));
    await handleInboundForChatbots(inbound("hi"));
    expect(seams.assignTeam).toHaveBeenCalledWith(T, "c1", "team1", null);
    expect(seams.assign).not.toHaveBeenCalled();
    expect(seams.handoff).toHaveBeenCalledWith(T, "c1", { queueOnly: true });
  });

  it("a team without a teammate chosen still shares chats in turn", async () => {
    const seams = { assign: vi.fn(), assignTeam: vi.fn(), setStatus: vi.fn(), handoff: vi.fn() };
    registerChatbotSeams(seams);
    addBot(flow([node("h", "handoff", { teamId: "team1" })], []));
    await handleInboundForChatbots(inbound("hi"));
    expect(seams.assignTeam).toHaveBeenCalledWith(T, "c1", "team1", "round_robin");
    expect(seams.handoff).toHaveBeenCalledWith(T, "c1", { queueOnly: false });
  });
});

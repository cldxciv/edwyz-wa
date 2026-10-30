import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const store = vi.hoisted(() => ({
  sessions: [] as Row[],
  chatbots: [] as Row[],
  contacts: [] as Row[],
  conversations: [] as Row[],
  messages: [] as Row[],
  templates: [] as Row[],
  ledger: [] as Row[],
  teams: [] as Row[],
  teamMembers: [] as Row[],
  clock: 0,
}));

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("in" in cond) return cond.in.includes(value);
      if ("lte" in cond) return value != null && value <= cond.lte;
      if ("lt" in cond) return value != null && value < cond.lt;
      if ("gt" in cond) return value != null && value > cond.gt;
      if ("gte" in cond) return value != null && value >= cond.gte;
      if ("not" in cond) return value !== undefined && value !== cond.not;
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
    const row = { id: `${rows().length + 1}`, createdAt: new Date(), updatedAt: new Date(store.clock++), ...defaults(), ...data };
    rows().push(row);
    return row;
  }),
  updateMany: vi.fn(async ({ where, data }: Row) => {
    const hit = rows().filter((r) => matches(r, where));
    hit.forEach((r) => Object.assign(r, data, { updatedAt: new Date(Date.now() + store.clock++) }));
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
const routing = vi.hoisted(() => ({ onConversationAssigned: vi.fn(), assignConversation: vi.fn() }));
vi.mock("@/lib/routing", () => routing);
vi.mock("@/lib/integrations/emitters", () => ({ emitStatusChanged: vi.fn() }));

import { handleInboundForChatbots, startChatbot } from "@/lib/chatbots";
import { endBotsOnBlock, stopBotsOnHumanReply } from "@/lib/chatbots/human-reply";
import { registerChatbotSeams, resetChatbotSeams } from "@/lib/chatbots/seams";
import { resumeDelayedSessions } from "@/lib/chatbots/worker";
import { HttpError } from "@/lib/tenancy";

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
const chat = () => store.conversations[0];
const seams = () => ({ assign: vi.fn(), assignTeam: vi.fn(), setStatus: vi.fn(), handoff: vi.fn() });

const sleepingBot = () => addBot(flow([node("a", "send_text", { text: "First" }), node("d", "delay", { minutes: 10 }), node("b", "send_text", { text: "Second" })], [edge("a", "d"), edge("d", "b")]));
const wake = () => {
  session().wakeAt = new Date(Date.now() - 1000);
  return resumeDelayedSessions(new Date());
};

beforeEach(() => {
  vi.clearAllMocks();
  resetChatbotSeams();
  Object.assign(store, { sessions: [], chatbots: [], messages: [], templates: [], ledger: [], clock: 0 });
  store.teams = [{ id: "team1", tenantId: T, name: "Sales" }];
  store.teamMembers = [{ id: "tm1", tenantId: T, teamId: "team1", userId: "u9" }];
  store.contacts = [{ id: "k1", tenantId: T, phone: "+911111111111", name: "Asha", attributes: {}, tags: [], optedOutAt: null, optIn: true }];
  store.conversations = [{ id: "c1", tenantId: T, phoneNumberId: "pn1", contactId: "k1", status: "open", phoneNumber: { wabaRefId: "w1" }, tags: [], assignedToId: null, assignedAt: null, lastInboundAt: new Date() }];
  Object.assign(db, {
    chatbotSession: model(() => store.sessions, () => ({ variables: {}, waitingNodeId: null, wakeAt: null, endedAt: null, startedAt: new Date(Date.now() - 5000) })),
    chatbot: model(() => store.chatbots),
    contact: model(() => store.contacts),
    conversation: model(() => store.conversations),
    message: model(() => store.messages),
    template: model(() => store.templates),
    usageLedger: model(() => store.ledger),
    note: model(() => []),
    team: model(() => store.teams),
    teamMember: model(() => store.teamMembers),
    membership: model(() => [{ id: "m1", tenantId: T, userId: "u9" }]),
    agentAvailability: { upsert: vi.fn(async () => ({})) },
    tenant: { findUnique: vi.fn(async () => ({ status: "active", deletedAt: null })) },
  });
  inbox.sendText.mockResolvedValue({});
  inbox.sendTemplateMessage.mockResolvedValue({ id: "msg1" });
  interactive.sendInteractive.mockResolvedValue({});
});

describe("a bot sleeping in a delay still owns the chat", () => {
  it("reports the customer's message as handled so routing, holiday mode and classic rules stay out", async () => {
    sleepingBot();
    await handleInboundForChatbots(inbound("hi"));
    expect(session()).toMatchObject({ status: "active" });
    expect(await handleInboundForChatbots(inbound("anyone there?"))).toBe(true);
    expect(sent()).toEqual(["First"]);
  });

  it("ends the bot instead when a teammate was assigned the chat in the meantime", async () => {
    sleepingBot();
    await handleInboundForChatbots(inbound("hi"));
    Object.assign(chat(), { assignedToId: "u9", assignedAt: new Date(Date.now() + 1000) });
    expect(await handleInboundForChatbots(inbound("hello?"))).toBe(false);
    expect(session().status).toBe("handed_off");
  });

  it("does not continue after the delay when a person was assigned meanwhile", async () => {
    sleepingBot();
    await handleInboundForChatbots(inbound("hi"));
    Object.assign(chat(), { assignedToId: "u9", assignedAt: new Date(Date.now() + 1000) });
    await wake();
    expect(sent()).toEqual(["First"]);
    expect(session().status).toBe("handed_off");
  });

  it("keeps going when the assignment was made by the bot's own assign step", async () => {
    registerChatbotSeams({
      ...seams(),
      assign: async () => {
        Object.assign(chat(), { assignedToId: "u9", assignedAt: new Date(Date.now() + 1000) });
      },
    });
    addBot(flow([node("x", "assign", { userId: "u9" }), node("d", "delay", { minutes: 10 }), node("b", "send_text", { text: "Still here" })], [edge("x", "d"), edge("d", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    await wake();
    expect(sent()).toEqual(["Still here"]);
  });

  it("respects a bot set not to step aside", async () => {
    addBot(flow([node("a", "send_text", { text: "First" }), node("d", "delay", { minutes: 10 }), node("b", "send_text", { text: "Second" })], [edge("a", "d"), edge("d", "b")], { stopOnHumanReply: false }));
    await handleInboundForChatbots(inbound("hi"));
    Object.assign(chat(), { assignedToId: "u9", assignedAt: new Date(Date.now() + 1000) });
    await wake();
    expect(sent()).toEqual(["First", "Second"]);
  });

  it("a crashed run (running, not sleeping, silent for a long time) does not swallow messages for a day", async () => {
    sleepingBot();
    await handleInboundForChatbots(inbound("hi"));
    Object.assign(session(), { wakeAt: null, updatedAt: new Date(Date.now() - 20 * 60_000) });
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(true);
    expect(store.sessions[0].status).toBe("expired");
    expect(store.sessions).toHaveLength(2);
  });
});

describe("blocked chats", () => {
  it("ends a waiting session instead of answering when the chat was blocked", async () => {
    addBot(flow([node("q", "ask", { text: "Name?", variable: "n", validate: "text", maxRetries: 1 }), node("t", "send_text", { text: "Thanks" })], [edge("q", "t")]));
    await handleInboundForChatbots(inbound("hi"));
    chat().status = "blocked";
    expect(await handleInboundForChatbots(inbound("Asha"))).toBe(false);
    expect(session().status).toBe("expired");
    expect(sent()).toEqual(["Name?"]);
  });

  it("a delayed session of a blocked chat ends and sends nothing", async () => {
    sleepingBot();
    await handleInboundForChatbots(inbound("hi"));
    chat().status = "blocked";
    await wake();
    expect(sent()).toEqual(["First"]);
    expect(session().status).toBe("expired");
  });

  it("a hand-over never reopens a blocked chat", async () => {
    const s = seams();
    registerChatbotSeams(s);
    addBot(flow([node("h", "handoff", { note: false })], []));
    await handleInboundForChatbots(inbound("hi"));
    s.setStatus.mockClear();
    s.handoff.mockClear();
    store.sessions = [];
    chat().status = "blocked";
    await handleInboundForChatbots(inbound("hi"));
    expect(s.setStatus).not.toHaveBeenCalled();
    expect(s.handoff).not.toHaveBeenCalled();
  });

  it("blocking a chat ends its live sessions at once", async () => {
    sleepingBot();
    await handleInboundForChatbots(inbound("hi"));
    expect(await endBotsOnBlock(T, ["c1"])).toBe(1);
    expect(session().status).toBe("expired");
    expect(await endBotsOnBlock(T, [])).toBe(0);
  });

  it("a run that is working when the chat gets blocked stops before its next message", async () => {
    addBot(flow([node("a", "send_text", { text: "First" }), node("b", "send_text", { text: "Second" })], [edge("a", "b")]));
    inbox.sendText.mockImplementationOnce(async () => {
      chat().status = "blocked";
      return {};
    });
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()).toEqual(["First"]);
    expect(session().status).toBe("expired");
  });
});

describe("a teammate reply stops a run that is already working", () => {
  it("sends no further message, not even a menu or a template", async () => {
    store.templates = [{ id: "tp1", tenantId: T, wabaRefId: "w1", name: "promo", language: "en", status: "approved", category: "UTILITY", components: [{ type: "BODY", text: "Hi" }] }];
    addBot(
      flow(
        [node("a", "send_text", { text: "First" }), node("m", "send_buttons", { text: "Pick", buttons: [{ id: "x", title: "X" }] }), node("t", "send_template", { templateId: "tp1", variables: {} }), node("z", "send_text", { text: "Last" })],
        [edge("a", "m"), edge("m", "t"), edge("t", "z")],
      ),
    );
    inbox.sendText.mockImplementationOnce(async () => {
      await stopBotsOnHumanReply(T, "c1");
      return {};
    });
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()).toEqual(["First"]);
    expect(interactive.sendInteractive).not.toHaveBeenCalled();
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(session().status).toBe("handed_off");
  });

  it("an escalation cut off by a teammate does not hand the chat over again", async () => {
    const s = seams();
    registerChatbotSeams(s);
    addBot(flow([node("q", "ask", { text: "Why?", variable: "why", validate: "text", maxRetries: 1 }), node("t", "send_text", { text: "Thanks" })], [edge("q", "t")], { escalation: { enabled: true } }));
    await handleInboundForChatbots(inbound("hi"));
    inbox.sendText.mockClear();
    inbox.sendText.mockImplementationOnce(async () => {
      await stopBotsOnHumanReply(T, "c1");
      return {};
    });
    await handleInboundForChatbots(inbound("Let me talk to a real person now"));
    expect(session().status).toBe("handed_off");
    expect(s.handoff).not.toHaveBeenCalled();
  });
});

describe("template node and WhatsApp accounts", () => {
  const tpl = (extra: Row = {}) => ({ id: "tp1", tenantId: T, wabaRefId: "w1", name: "promo", language: "en", status: "approved", category: "UTILITY", components: [{ type: "BODY", text: "Hi" }], ...extra });
  const bot = () => addBot(flow([node("a", "send_template", { templateId: "tp1", variables: {} }), node("ok", "send_text", { text: "after" }), node("bad", "send_text", { text: "failed:{{template_error}}" })], [edge("a", "ok"), edge("a", "bad", "error")]));

  it("sends a template of the same WhatsApp account as the chat's number", async () => {
    store.templates = [tpl()];
    bot();
    await handleInboundForChatbots(inbound("hi"));
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual(["after"]);
  });

  it("takes the error edge for a template that belongs to another account", async () => {
    store.templates = [tpl({ wabaRefId: "w2" })];
    bot();
    await handleInboundForChatbots(inbound("hi"));
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(sent()).toEqual(["failed:template_unavailable"]);
  });

  it("takes the error edge when the send itself is refused", async () => {
    store.templates = [tpl()];
    inbox.sendTemplateMessage.mockRejectedValueOnce(new HttpError(422, "This contact has not opted in."));
    bot();
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()).toEqual(["failed:template_rejected"]);
  });
});

describe("one bot or AI agent at a time, in both directions", () => {
  const aiReplied = (ago = 60_000) => store.ledger.push({ tenantId: T, meter: "ai_credits", refType: "ai_reply", refId: "c1", createdAt: new Date(Date.now() - ago) });
  const hello = () => addBot(flow([node("a", "send_text", { text: "Bot here" })], []));

  it("a bot does not start in a chat where the AI agent has been replying", async () => {
    hello();
    aiReplied();
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(false);
    expect(sent()).toEqual([]);
  });

  it("starts again once the AI agent has been paused or quiet for a day", async () => {
    hello();
    aiReplied();
    chat().tags = ["ai:stopped"];
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(true);
    chat().tags = [];
    store.sessions = [];
    store.ledger = [];
    aiReplied(25 * 60 * 60_000);
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(true);
  });

  it("a rule or the API cannot start a bot beside a talking AI agent, but a teammate can and that pauses the agent", async () => {
    const b = hello();
    aiReplied();
    await expect(startChatbot({ tenantId: T }, b.id, "c1", { source: "rule" })).rejects.toMatchObject({ status: 409 });
    expect(sent()).toEqual([]);
    await startChatbot({ tenantId: T }, b.id, "c1", { source: "manual" });
    expect(chat().tags).toContain("ai:stopped");
    expect(sent()).toEqual(["Bot here"]);
  });
});

describe("assignments made by bot steps", () => {
  it("run the same follow-up as an assignment in the inbox (contact owner, availability)", async () => {
    addBot(flow([node("x", "assign", { userId: "u9" }), node("e", "end")], [edge("x", "e")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(chat()).toMatchObject({ assignedToId: "u9" });
    expect(chat().assignedAt).toBeInstanceOf(Date);
    expect(routing.onConversationAssigned).toHaveBeenCalledWith(T, "c1", "u9");
    expect(db.agentAvailability.upsert).toHaveBeenCalled();
  });

  it("a team assignment to a named teammate does too", async () => {
    addBot(flow([node("x", "assign", { teamId: "team1", userId: "u9" }), node("e", "end")], [edge("x", "e")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(chat()).toMatchObject({ assignedToId: "u9", teamId: "team1" });
    expect(routing.onConversationAssigned).toHaveBeenCalledWith(T, "c1", "u9");
  });
});

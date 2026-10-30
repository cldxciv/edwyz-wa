import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const store = vi.hoisted(() => ({
  sessions: [] as Row[],
  chatbots: [] as Row[],
  contacts: [] as Row[],
  conversations: [] as Row[],
  messages: [] as Row[],
  templates: [] as Row[],
  notes: [] as Row[],
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
const ai = vi.hoisted(() => ({ classify: vi.fn() }));
vi.mock("@/lib/chatbots/escalation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/chatbots/escalation")>()), classifyWithAi: ai.classify }));

import { getConversationBotState, handleInboundForChatbots, startChatbot, stopConversationBot } from "@/lib/chatbots";
import { wakeSession } from "@/lib/chatbots/engine";
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
const seams = () => ({ assign: vi.fn(), assignTeam: vi.fn(), setStatus: vi.fn(), handoff: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  resetChatbotSeams();
  store.sessions = [];
  store.chatbots = [];
  store.messages = [];
  store.templates = [];
  store.notes = [];
  store.teams = [{ id: "team1", tenantId: T, name: "Sales" }];
  store.teamMembers = [{ id: "tm1", tenantId: T, teamId: "team1", userId: "u9" }];
  store.clock = 0;
  store.contacts = [{ id: "k1", tenantId: T, phone: "+911111111111", name: "Asha", attributes: { plan: "pro" }, tags: [], optedOutAt: null, optIn: true }];
  store.conversations = [{ id: "c1", tenantId: T, phoneNumberId: "pn1", contactId: "k1", status: "open", phoneNumber: { wabaRefId: "w1" }, tags: [], assignedToId: null, lastInboundAt: new Date() }];
  Object.assign(db, {
    chatbotSession: model(() => store.sessions, () => ({ variables: {}, waitingNodeId: null, wakeAt: null, endedAt: null, startedAt: new Date(Date.now() - 1000) })),
    chatbot: model(() => store.chatbots),
    contact: model(() => store.contacts),
    conversation: model(() => store.conversations),
    message: model(() => store.messages),
    template: model(() => store.templates),
    usageLedger: model(() => []),
    note: model(() => store.notes),
    team: model(() => store.teams),
    teamMember: model(() => store.teamMembers),
    membership: model(() => [{ id: "m1", tenantId: T, userId: "u9" }]),
    agentAvailability: { upsert: vi.fn(async () => ({})) },
    tenant: { findUnique: vi.fn(async () => ({ status: "active", deletedAt: null })) },
  });
  inbox.sendText.mockResolvedValue({});
  inbox.sendTemplateMessage.mockResolvedValue({ id: "msg1" });
  interactive.sendInteractive.mockResolvedValue({});
  ai.classify.mockResolvedValue(null);
});

describe("template node", () => {
  const tpl = (extra: Row = {}) => ({ id: "tp1", tenantId: T, wabaRefId: "w1", name: "promo", language: "en", status: "approved", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}, order {{2}}" }], ...extra });
  const run = (data: Row, edges: Row[] = []) => addBot(flow([node("a", "send_template", { templateId: "tp1", variables: {}, ...data }), node("ok", "send_text", { text: "after" }), node("bad", "send_text", { text: "failed:{{template_error}}" })], [edge("a", "ok"), ...edges]));

  it("fills body gaps from saved answers and contact fields and writes the rendered text into the inbox", async () => {
    store.templates = [tpl()];
    run({ variables: { "1": "{{contact.name}}", "2": "{{plan}}" } });
    await handleInboundForChatbots(inbound("hi"));
    const call = inbox.sendTemplateMessage.mock.calls[0][0];
    expect(call.components).toEqual([{ type: "body", parameters: [{ type: "text", text: "Asha" }, { type: "text", text: "pro" }] }]);
    expect(db.message.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "msg1", tenantId: T }, data: { body: "Hi Asha, order pro" } });
    expect(sent()).toEqual(["after"]);
  });

  it("adds a media header link and a URL button value", async () => {
    store.templates = [
      tpl({ components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hello" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Hi" }, { type: "URL", text: "Track", url: "https://x.example.com/{{1}}" }] }] }),
    ];
    store.contacts[0].attributes = { photo: "https://cdn.example.com/p.png", order: "A12" };
    run({ headerMediaUrl: "{{photo}}", buttonVariable: "{{order}}" });
    await handleInboundForChatbots(inbound("hi"));
    expect(inbox.sendTemplateMessage.mock.calls[0][0].components).toEqual([
      { type: "header", parameters: [{ type: "image", image: { link: "https://cdn.example.com/p.png" } }] },
      { type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: "A12" }] },
    ]);
  });

  it("fills a text header gap", async () => {
    store.templates = [tpl({ components: [{ type: "HEADER", format: "TEXT", text: "Order {{1}}" }, { type: "BODY", text: "Hello" }] })];
    run({ headerVariable: "#{{plan}}" });
    await handleInboundForChatbots(inbound("hi"));
    expect(inbox.sendTemplateMessage.mock.calls[0][0].components[0]).toEqual({ type: "header", parameters: [{ type: "text", text: "#pro" }] });
  });

  it.each([
    ["a header link is missing", { components: [{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "Hello" }] }, {}, "missing_header_media"],
    ["a header link resolves to an insecure address", { components: [{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "Hello" }] }, { headerMediaUrl: "{{photo}}" }, "missing_header_media"],
    ["a body gap is not filled", {}, { variables: { "1": "a" } }, "missing_variables"],
    ["a button value is missing", { components: [{ type: "BODY", text: "Hello" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://x.example.com/{{1}}" }] }] }, {}, "missing_button_value"],
    ["a marketing template goes to a contact without opt-in", { category: "MARKETING", components: [{ type: "BODY", text: "Hello" }] }, {}, "no_opt_in"],
    ["the template is not approved", { status: "pending" }, { variables: { "1": "a", "2": "b" } }, "template_unavailable"],
  ])("follows the error path and sends nothing when %s", async (_name, templateExtra, data, code) => {
    store.templates = [tpl(templateExtra as Row)];
    if (code === "no_opt_in") store.contacts[0].optIn = false;
    store.contacts[0].attributes = { photo: "http://insecure.example.com/v.mp4" };
    run(data as Row, [edge("a", "bad", "error")]);
    await handleInboundForChatbots(inbound("hi"));
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(sent()).toEqual([`failed:${code}`]);
  });

  it("without an error connection the flow still carries on, and an opted-out contact gets nothing", async () => {
    store.templates = [tpl()];
    run({ variables: { "1": "a", "2": "b" } });
    store.contacts[0].optedOutAt = new Date();
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(false);
    store.contacts[0].optedOutAt = null;
    store.templates = [];
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()).toEqual(["after"]);
    expect(session().variables.template_error).toBe("template_unavailable");
  });

  it("a marketing template goes to a contact who opted in", async () => {
    store.templates = [tpl({ category: "MARKETING" })];
    run({ variables: { "1": "a", "2": "b" } });
    await handleInboundForChatbots(inbound("hi"));
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});

describe("assign, status and hand-over with teams", () => {
  it("assigns to a team and lets the seam pick a teammate", async () => {
    const s = seams();
    registerChatbotSeams(s);
    addBot(flow([node("a", "assign", { userId: "round_robin", teamId: "team1" }), node("b", "assign", { userId: "", teamId: "team1" })], [edge("a", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(s.assignTeam).toHaveBeenNthCalledWith(1, T, "c1", "team1", "round_robin");
    expect(s.assignTeam).toHaveBeenNthCalledWith(2, T, "c1", "team1", null);
    expect(s.assign).not.toHaveBeenCalled();
  });

  it("a failing assignment never stops the chat", async () => {
    registerChatbotSeams({ ...seams(), assignTeam: vi.fn().mockRejectedValue(new Error("gone")) });
    addBot(flow([node("a", "assign", { userId: "", teamId: "gone" }), node("b", "send_text", { text: "still here" })], [edge("a", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()).toEqual(["still here"]);
  });

  it("the default team seam puts the chat in the team and picks a member, or a named member of the team only", async () => {
    addBot(flow([node("a", "assign", { userId: "u9", teamId: "team1" })], []));
    await handleInboundForChatbots(inbound("hi"));
    expect(store.conversations[0]).toMatchObject({ teamId: "team1", assignedToId: "u9" });

    store.conversations[0].assignedToId = null;
    store.conversations[0].teamId = null;
    store.sessions = [];
    store.chatbots = [];
    addBot(flow([node("a", "assign", { userId: "stranger", teamId: "team1" }), node("b", "send_text", { text: "after" })], [edge("a", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(store.conversations[0].assignedToId).toBeNull();
    expect(store.conversations[0].teamId).toBe("team1");
    expect(sent()).toEqual(["after"]);
  });

  it("the default team seam rejects teams of other workspaces", async () => {
    store.teams = [{ id: "other", tenantId: "t2", name: "Other" }];
    addBot(flow([node("a", "assign", { userId: "", teamId: "other" }), node("b", "send_text", { text: "after" })], [edge("a", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(store.conversations[0].teamId).toBeUndefined();
  });

  it("hand-over goes to the chosen team and teammate, leaves a note of what the bot learned and pauses the AI agent", async () => {
    const s = seams();
    registerChatbotSeams(s);
    addBot(
      flow(
        [node("q", "ask", { text: "Name?", variable: "name", validate: "text", maxRetries: 1 }), node("h", "handoff", { message: "Bye", teamId: "team1", userId: "u9" })],
        [edge("q", "h")],
      ),
    );
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("Ravi"));
    expect(s.assignTeam).toHaveBeenCalledWith(T, "c1", "team1", "u9");
    expect(s.setStatus).toHaveBeenCalledWith(T, "c1", "open");
    expect(s.handoff).toHaveBeenCalledWith(T, "c1", { queueOnly: false });
    expect(store.notes).toHaveLength(1);
    expect(store.notes[0]).toMatchObject({ tenantId: T, conversationId: "c1", authorId: "chatbot" });
    expect(store.notes[0].body).toContain("name: Ravi");
    expect(store.notes[0].body).not.toContain("__");
    expect(store.conversations[0].tags).toContain("ai:stopped");
    expect(session().status).toBe("handed_off");
  });

  it("the note can be switched off", async () => {
    registerChatbotSeams(seams());
    addBot(flow([node("h", "handoff", { note: false })], []));
    await handleInboundForChatbots(inbound("hi"));
    expect(store.notes).toHaveLength(0);
    expect(session().status).toBe("handed_off");
  });
});

describe("triggers, priority and conflicts", () => {
  const say = (text: string) => flow([node("a", "send_text", { text })], []);

  it("a lower priority number wins over creation order and trigger type", async () => {
    addBot(say("early"));
    addBot(say("urgent"), { publishedFlow: flow([node("a", "send_text", { text: "urgent" })], [], { priority: 5 }) });
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()).toEqual(["urgent"]);
  });

  it("an any-message bot with a better priority beats a keyword bot", async () => {
    addBot(say("keyword"));
    addBot(say("catch-all"), { triggerType: "any_message", triggerKeywords: [], publishedFlow: flow([node("a", "send_text", { text: "catch-all" })], [], { priority: 1 }) });
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()).toEqual(["catch-all"]);
  });

  it("at the same priority a bot tied to the number comes before one for all numbers", async () => {
    addBot(say("all numbers"));
    addBot(say("this number"), { phoneNumberId: "pn1" });
    addBot(say("other number"), { phoneNumberId: "pn2" });
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()).toEqual(["this number"]);
  });

  it("exact keyword matching needs the whole message", async () => {
    addBot(flow([node("a", "send_text", { text: "menu!" })], [], { keywordMatch: "exact" }), { triggerKeywords: ["menu"] });
    expect(await handleInboundForChatbots(inbound("show me the menu please"))).toBe(false);
    expect(await handleInboundForChatbots(inbound("Menu"))).toBe(true);
    expect(sent()).toEqual(["menu!"]);
  });

  it("never starts on a chat a teammate owns, unless the bot says it may", async () => {
    store.conversations[0].assignedToId = "u9";
    addBot(say("blocked"));
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(false);
    addBot(flow([node("a", "send_text", { text: "allowed" })], [], { skipAssignedChats: false }));
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(true);
    expect(sent()).toEqual(["allowed"]);
  });

  it("falls through to the next bot when the best one skips assigned chats", async () => {
    store.conversations[0].assignedToId = "u9";
    addBot(flow([node("a", "send_text", { text: "polite" })], [], { priority: 1 }));
    addBot(flow([node("a", "send_text", { text: "always" })], [], { priority: 50, skipAssignedChats: false }));
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()).toEqual(["always"]);
  });

  it("one contact never has two bots: a live session in another chat blocks a new start", async () => {
    addBot(say("hello"));
    store.sessions = [{ id: "other", tenantId: T, contactId: "k1", conversationId: "c-other", chatbotId: "x", status: "waiting", updatedAt: new Date() }];
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(false);
    store.sessions[0].updatedAt = new Date(Date.now() - 25 * 3_600_000);
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(true);
  });
});

describe("a teammate's reply stops the bot", () => {
  const waitingBot = (settings?: Row) =>
    addBot(flow([node("q", "ask", { text: "Name?", variable: "name", validate: "text", maxRetries: 1 }), node("e", "send_text", { text: "thanks {{name}}" })], [edge("q", "e")], settings));
  const humanReplies = () => store.messages.push({ tenantId: T, conversationId: "c1", direction: "outbound", sentByUserId: "u9", createdAt: new Date(Date.now() + 5) });

  it("ends the session as handed over and lets the message through to the others", async () => {
    waitingBot();
    await handleInboundForChatbots(inbound("hi"));
    humanReplies();
    expect(await handleInboundForChatbots(inbound("Ravi"))).toBe(false);
    expect(session().status).toBe("handed_off");
    expect(sent()).toEqual(["Name?"]);
  });

  it("bot replies do not count as a teammate", async () => {
    waitingBot();
    await handleInboundForChatbots(inbound("hi"));
    store.messages.push({ tenantId: T, conversationId: "c1", direction: "outbound", sentByUserId: null, createdAt: new Date(Date.now() + 5) });
    expect(await handleInboundForChatbots(inbound("Ravi"))).toBe(true);
    expect(sent()).toEqual(["Name?", "thanks Ravi"]);
  });

  it("a teammate's message before the bot started does not count", async () => {
    store.messages.push({ tenantId: T, conversationId: "c1", direction: "outbound", sentByUserId: "u9", createdAt: new Date(Date.now() - 60_000) });
    waitingBot();
    await handleInboundForChatbots(inbound("hi"));
    expect(await handleInboundForChatbots(inbound("Ravi"))).toBe(true);
  });

  it("the setting can be switched off", async () => {
    waitingBot({ stopOnHumanReply: false });
    await handleInboundForChatbots(inbound("hi"));
    humanReplies();
    expect(await handleInboundForChatbots(inbound("Ravi"))).toBe(true);
    expect(sent()).toEqual(["Name?", "thanks Ravi"]);
  });

  it("a sleeping bot does not wake up after a teammate replied", async () => {
    addBot(flow([node("a", "send_text", { text: "before" }), node("d", "delay", { minutes: 10 }), node("b", "send_text", { text: "after" })], [edge("a", "d"), edge("d", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    humanReplies();
    expect(await resumeDelayedSessions(new Date(Date.now() + 11 * 60_000))).toBe(1);
    expect(sent()).toEqual(["before"]);
    expect(session().status).toBe("handed_off");
  });

  it("wakeSession leaves a bot that has no reason to stop alone", async () => {
    const bot = addBot(flow([node("a", "send_text", { text: "x" }), node("d", "delay", { minutes: 1 }), node("b", "send_text", { text: "later" })], [edge("a", "d"), edge("d", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    const woken = await wakeSession(session() as never, bot.publishedFlow as never);
    expect(woken).toBe(true);
    expect(sent()).toEqual(["x", "later"]);
  });
});

describe("smart escalation", () => {
  const menu = (settings?: Row) =>
    flow(
      [node("a", "send_buttons", { text: "Pick", buttons: [{ id: "sales", title: "Talk to an agent" }, { id: "help", title: "Help" }] }), node("s", "send_text", { text: "Sales it is" }), node("h", "send_text", { text: "Help it is" })],
      [edge("a", "s", "sales"), edge("a", "h", "help")],
      settings,
    );

  it("a clear request for a person hands the chat over with a message, a team and a note", async () => {
    const s = seams();
    registerChatbotSeams(s);
    addBot(menu({ escalation: { teamId: "team1", message: "One moment {{contact.name}}" } }));
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("I want to talk to a human"));
    expect(sent()).toEqual(["One moment Asha"]);
    expect(s.assignTeam).toHaveBeenCalledWith(T, "c1", "team1", "round_robin");
    expect(s.handoff).toHaveBeenCalled();
    expect(store.notes[0].body).toContain("asked to talk to a person");
    expect(session()).toMatchObject({ status: "handed_off" });
    expect(session().variables.escalation_reason).toBe("human_request");
  });

  it("uses a standard message when none is set, and the teammate chosen in the settings", async () => {
    const s = seams();
    registerChatbotSeams(s);
    addBot(menu({ escalation: { userId: "u9" } }));
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("agent"));
    expect(sent()[0]).toMatch(/connecting you with a member of our team/);
    expect(s.assign).toHaveBeenCalledWith(T, "c1", "u9");
  });

  it("works in other languages", async () => {
    registerChatbotSeams(seams());
    addBot(menu());
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("quiero hablar con una persona"));
    expect(session().status).toBe("handed_off");
  });

  it("a tap on an offered button is never escalated, even when its title says 'agent'", async () => {
    registerChatbotSeams(seams());
    addBot(menu());
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("Talk to an agent", { replyId: "sales" }));
    expect(sent()).toEqual(["Sales it is"]);
    expect(session().status).toBe("completed");
  });

  it("frustration only counts when the reply did not fit the question", async () => {
    registerChatbotSeams(seams());
    addBot(menu());
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("this is useless, you do not understand"));
    expect(session().status).toBe("handed_off");
    expect(session().variables.escalation_reason).toBe("frustration");
  });

  it("a free-text answer to a question is not escalated for a stray word, but is for a clear request", async () => {
    registerChatbotSeams(seams());
    addBot(flow([node("q", "ask", { text: "What is your job?", variable: "job", validate: "text", maxRetries: 1 }), node("e", "send_text", { text: "ok {{job}}" })], [edge("q", "e")]));
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("insurance agent"));
    expect(sent()).toEqual(["What is your job?", "ok insurance agent"]);
    store.sessions = [];
    inbox.sendText.mockClear();
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("let me speak to a real person"));
    expect(session().status).toBe("handed_off");
  });

  it("an answer that is one of the allowed choices is kept", async () => {
    registerChatbotSeams(seams());
    addBot(flow([node("q", "ask", { text: "Who?", variable: "who", validate: "choice", choices: ["Customer care", "Sales"], maxRetries: 1 }), node("e", "send_text", { text: "to {{who}}" })], [edge("q", "e")]));
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("Customer care"));
    expect(sent().at(-1)).toBe("to Customer care");
  });

  it("can be switched off, and extra words from the settings count", async () => {
    registerChatbotSeams(seams());
    addBot(menu({ escalation: { enabled: false } }));
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("I want a human"));
    expect(session().status).toBe("waiting");

    store.sessions = [];
    store.chatbots = [];
    addBot(menu({ escalation: { keywords: ["refund"] } }));
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("I need a refund"));
    expect(session().status).toBe("handed_off");
  });

  it("asks AI only for replies that fit nothing, only when the bot allows it", async () => {
    registerChatbotSeams(seams());
    ai.classify.mockResolvedValue({ kind: "frustration", source: "ai" });
    addBot(menu());
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("hmm what"));
    expect(ai.classify).not.toHaveBeenCalled();
    expect(session().status).toBe("waiting");

    store.sessions = [];
    store.chatbots = [];
    addBot(menu({ escalation: { useAi: true } }));
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("Help", { replyId: "help" }));
    expect(ai.classify).not.toHaveBeenCalled();
    store.sessions = [];
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("hmm what"));
    expect(ai.classify).toHaveBeenCalledWith(T, "hmm what");
    expect(session()).toMatchObject({ status: "handed_off" });
    expect(session().variables.escalation_source).toBe("ai");
  });

  it("a failed hand-over message still hands the chat over", async () => {
    registerChatbotSeams(seams());
    addBot(menu());
    await handleInboundForChatbots(inbound("hi"));
    inbox.sendText.mockRejectedValue(new Error("window"));
    await handleInboundForChatbots(inbound("human please"));
    expect(session().status).toBe("handed_off");
  });
});

describe("lists for questions", () => {
  it("shows up to 10 short answers as a list and longer ones as numbered text", async () => {
    const choices = Array.from({ length: 5 }, (_, i) => `Choice ${i + 1}`);
    addBot(flow([node("q", "ask", { text: "Pick", variable: "c", validate: "choice", choices, maxRetries: 1 })], []));
    await handleInboundForChatbots(inbound("hi"));
    expect(interactive.sendInteractive.mock.calls[0][0].interactive).toMatchObject({ type: "list", action: { button: "Choose", sections: [{ rows: [{ id: "c1", title: "Choice 1" }, expect.anything(), expect.anything(), expect.anything(), { id: "c5", title: "Choice 5" }] }] } });

    store.sessions = [];
    store.chatbots = [];
    const long = ["A very long answer that exceeds the row title limit", "Another"];
    addBot(flow([node("q", "ask", { text: "Pick", variable: "c", validate: "choice", choices: long, maxRetries: 1 })], []));
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()[0]).toContain("1. A very long answer");
  });
});

describe("starting a bot by hand, from a rule or the API", () => {
  const manual = (settings?: Row) => addBot(flow([node("a", "send_text", { text: "manual hello" })], [], settings), { id: "m", triggerType: "manual", triggerKeywords: [] });

  it("a teammate can start a bot on a chat that is assigned to someone", async () => {
    manual();
    store.conversations[0].assignedToId = "u9";
    const result = await startChatbot({ tenantId: T }, "m", "c1", { source: "manual" });
    expect(result).toMatchObject({ status: "completed" });
    expect(sent()).toEqual(["manual hello"]);
  });

  it("a rule or API start respects the 'skip chats a teammate owns' setting", async () => {
    manual();
    store.conversations[0].assignedToId = "u9";
    await expect(startChatbot({ tenantId: T }, "m", "c1", { source: "rule" })).rejects.toMatchObject({ status: 409 });
    await expect(startChatbot({ tenantId: T }, "m", "c1")).rejects.toMatchObject({ status: 409 });
    store.chatbots = [];
    manual({ skipAssignedChats: false });
    await expect(startChatbot({ tenantId: T }, "m", "c1", { source: "rule" })).resolves.toMatchObject({ sessionId: expect.any(String) });
  });

  it("refuses bots of another number, opted-out contacts, blocked chats and closed windows", async () => {
    addBot(flow([node("a", "send_text", { text: "hi" })], []), { id: "other", phoneNumberId: "pn2" });
    await expect(startChatbot({ tenantId: T }, "other", "c1", { source: "manual" })).rejects.toMatchObject({ status: 409 });

    manual();
    store.conversations[0].status = "blocked";
    await expect(startChatbot({ tenantId: T }, "m", "c1", { source: "manual" })).rejects.toMatchObject({ status: 409 });
    store.conversations[0].status = "open";

    store.conversations[0].lastInboundAt = new Date(Date.now() - 30 * 3_600_000);
    await expect(startChatbot({ tenantId: T }, "m", "c1", { source: "manual" })).rejects.toThrow(/24-hour/);
    store.conversations[0].lastInboundAt = new Date();
    await expect(startChatbot({ tenantId: T }, "m", "c1", { source: "manual" })).resolves.toBeTruthy();
  });

  it("a bot that opens with a template may start outside the window", async () => {
    store.templates = [{ id: "tp1", tenantId: T, wabaRefId: "w1", name: "promo", language: "en", status: "approved", category: "UTILITY", components: [{ type: "BODY", text: "Hi" }] }];
    addBot(flow([node("a", "send_template", { templateId: "tp1", variables: {} })], []), { id: "t", triggerType: "manual", triggerKeywords: [] });
    store.conversations[0].lastInboundAt = null;
    await startChatbot({ tenantId: T }, "t", "c1", { source: "manual" });
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("is scoped to the workspace", async () => {
    manual();
    await expect(startChatbot({ tenantId: "t2" }, "m", "c1", { source: "manual" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("conversation bot state", () => {
  it("returns the latest session with the bot's name and the bots that can be started", async () => {
    addBot(flow([node("a", "send_text", { text: "x" })], []), { id: "b1", name: "Welcome" });
    addBot(flow([node("a", "send_text", { text: "x" })], []), { id: "b2", name: "Other number", phoneNumberId: "pn2" });
    store.sessions = [{ id: "s1", tenantId: T, chatbotId: "b1", conversationId: "c1", status: "waiting", startedAt: new Date(), updatedAt: new Date(), endedAt: null }];
    const state = await getConversationBotState(T, "c1");
    expect(state.session).toMatchObject({ id: "s1", chatbotName: "Welcome", status: "waiting" });
    expect(state.available.map((b) => b.id)).toEqual(["b1"]);
    await expect(getConversationBotState("t2", "c1")).rejects.toMatchObject({ status: 404 });
  });

  it("stops a live session as handed over, and reports when none was running", async () => {
    store.sessions = [{ id: "s1", tenantId: T, chatbotId: "b1", conversationId: "c1", status: "waiting", updatedAt: new Date() }];
    expect(await stopConversationBot(T, "c1")).toBe(true);
    expect(store.sessions[0].status).toBe("handed_off");
    expect(await stopConversationBot(T, "c1")).toBe(false);
    expect(await stopConversationBot("t2", "c1")).toBe(false);
  });
});

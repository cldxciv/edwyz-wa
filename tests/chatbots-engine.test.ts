import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const store = vi.hoisted(() => ({ sessions: [] as Row[], chatbots: [] as Row[], contacts: [] as Row[], conversations: [] as Row[], messages: [] as Row[], templates: [] as Row[], audits: [] as Row[], clock: 0 }));

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("in" in cond) return cond.in.includes(value);
      if ("lte" in cond) return value != null && value <= cond.lte;
      if ("lt" in cond) return value != null && value < cond.lt;
      if ("not" in cond) return value !== cond.not;
    }
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    return value === cond;
  });

const model = (rows: () => Row[], defaults: () => Row = () => ({})) => ({
  findFirst: vi.fn(async ({ where }: Row) => { const r = rows().find((x) => matches(x, where)); return r ? { ...r } : null; }),
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
// Buttons and lists go out as real WhatsApp interactive messages. The builders stay real, only the queueing is replaced.
const interactive = vi.hoisted(() => ({ sendInteractive: vi.fn() }));
vi.mock("@/lib/inbox/interactive", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/inbox/interactive")>()), sendInteractive: interactive.sendInteractive }));
const tenant = vi.hoisted(() => ({ blocked: new Set<string>(), unreadable: false }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async (id: string) => !tenant.blocked.has(id) }));
// backgroundGate confirms a "no" with a fresh read of the workspace; `tenant.unreadable` makes that read fail (an unconfirmed no).
vi.mock("@/lib/billing", () => ({ getBillingStatus: async () => ({ canWrite: true }) }));
const http = vi.hoisted(() => ({ callWebhook: vi.fn() }));
vi.mock("@/lib/chatbots/http", () => http);

import { handleInboundForChatbots, startChatbot } from "@/lib/chatbots";
import { MAX_BOT_MESSAGES_PER_MINUTE, MAX_STEPS_PER_RUN } from "@/lib/chatbots/engine";
import { registerChatbotSeams, resetChatbotSeams } from "@/lib/chatbots/seams";
import { expireStaleSessions, resumeDelayedSessions } from "@/lib/chatbots/worker";

const T = "t1";
const node = (id: string, type: string, data: Row = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (from: string, to: string, label?: string) => ({ id: `${from}-${to}-${label ?? ""}`, from, to, ...(label ? { label } : {}) });
const flow = (nodes: Row[], edges: Row[], start = nodes[0].id) => ({ version: 1, start, nodes, edges });

function addBot(f: Row, extra: Row = {}) {
  const bot = { id: `bot${store.chatbots.length + 1}`, tenantId: T, phoneNumberId: null, status: "published", triggerType: "keyword", triggerKeywords: ["hi"], publishedFlow: f, flow: f, createdAt: new Date(store.clock++), ...extra };
  store.chatbots.push(bot);
  return bot;
}

const inbound = (text: string, extra: Row = {}) => ({ tenantId: T, phoneNumberId: "pn1", conversationId: "c1", contactId: "k1", text, receivedAt: new Date(), ...extra });
const sent = () => inbox.sendText.mock.calls.map((c) => c[0].body as string);
const session = () => store.sessions[store.sessions.length - 1];
const menus = () => interactive.sendInteractive.mock.calls.map((c) => c[0].interactive);

beforeEach(() => {
  vi.clearAllMocks();
  tenant.blocked = new Set();
  tenant.unreadable = false;
  resetChatbotSeams();
  store.sessions = [];
  store.chatbots = [];
  store.messages = [];
  store.templates = [];
  store.audits = [];
  store.clock = 0;
  store.contacts = [{ id: "k1", tenantId: T, phone: "+911111111111", name: "Asha", attributes: { plan: "pro" }, tags: [], optedOutAt: null }];
  store.conversations = [{ id: "c1", tenantId: T, phoneNumberId: "pn1", contactId: "k1", status: "open", phoneNumber: { wabaRefId: "w1" } }];
  Object.assign(db, {
    chatbotSession: model(() => store.sessions, () => ({ variables: {}, waitingNodeId: null, wakeAt: null, endedAt: null })),
    chatbot: model(() => store.chatbots),
    contact: model(() => store.contacts),
    conversation: model(() => store.conversations),
    message: model(() => store.messages),
    template: model(() => store.templates),
    auditLog: model(() => store.audits),
    usageLedger: model(() => []),
    membership: model(() => [{ id: "m1", tenantId: T, userId: "u9" }]),
    tenant: {
      findUnique: vi.fn(async ({ where }: Row) => {
        if (tenant.unreadable) throw new Error("db blip");
        return { status: tenant.blocked.has(where.id) ? "suspended" : "active", deletedAt: null };
      }),
    },
  });
  interactive.sendInteractive.mockResolvedValue({});
  inbox.sendText.mockResolvedValue({});
  inbox.sendTemplateMessage.mockResolvedValue({});
  http.callWebhook.mockResolvedValue({ ok: true, status: 200, data: { price: 42 } });
});

describe("triggers", () => {
  it("starts a keyword bot, sends text with interpolation and completes", async () => {
    addBot(flow([node("a", "send_text", { text: "Hello {{contact.name}}, plan {{plan}}" }), node("b", "end")], [edge("a", "b")]));
    expect(await handleInboundForChatbots(inbound("Hi there"))).toBe(true);
    expect(sent()).toEqual(["Hello Asha, plan pro"]);
    expect(session().status).toBe("completed");
  });

  it("does nothing when no trigger matches, for blocked conversations and for STOP; an opted-out contact is still answered", async () => {
    addBot(flow([node("a", "send_text", { text: "x" })], []));
    expect(await handleInboundForChatbots(inbound("pricing"))).toBe(false);
    store.conversations[0].status = "blocked";
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(false);
    store.conversations[0].status = "open";
    expect(await handleInboundForChatbots(inbound("stop"))).toBe(false);
    expect(inbox.sendText).not.toHaveBeenCalled();
    // Owner default 1: an opt-out stops marketing only, so a bot still answers a message the customer sent.
    store.contacts[0].optedOutAt = new Date(0);
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(true);
    expect(sent()).toEqual(["x"]);
  });

  it("prefers keyword over first_message over any_message, and honours phone number scope and tenant", async () => {
    addBot(flow([node("a", "send_text", { text: "any" })], []), { triggerType: "any_message", triggerKeywords: [] });
    addBot(flow([node("a", "send_text", { text: "first" })], []), { triggerType: "first_message", triggerKeywords: [] });
    addBot(flow([node("a", "send_text", { text: "kw" })], []));
    addBot(flow([node("a", "send_text", { text: "other tenant" })], []), { tenantId: "t2" });
    addBot(flow([node("a", "send_text", { text: "other number" })], []), { phoneNumberId: "pn2" });
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()).toEqual(["kw"]);
    store.sessions = [];
    inbox.sendText.mockClear();
    store.messages = [{ tenantId: T, conversationId: "c1", direction: "inbound" }];
    await handleInboundForChatbots(inbound("something"));
    expect(sent()).toEqual(["first"]);
    store.sessions = [];
    inbox.sendText.mockClear();
    store.messages = [1, 2, 3].map(() => ({ tenantId: T, conversationId: "c1", direction: "inbound" }));
    await handleInboundForChatbots(inbound("something"));
    expect(sent()).toEqual(["any"]);
  });

  it("ignores manual, draft and archived bots", async () => {
    const f = flow([node("a", "send_text", { text: "x" })], []);
    addBot(f, { triggerType: "manual" });
    addBot(f, { status: "draft" });
    addBot(f, { status: "archived" });
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(false);
  });

  it("returns false instead of throwing when the database fails", async () => {
    db.chatbotSession.findFirst.mockRejectedValueOnce(new Error("boom"));
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(false);
  });
});

describe("ask and resume", () => {
  const askFlow = flow(
    [
      node("a", "ask", { text: "Your age?", variable: "age", validate: "number", retryText: "Numbers only", maxRetries: 1 }),
      node("c", "condition", { variable: "age", operator: "gt", value: "17" }),
      node("y", "send_text", { text: "Adult {{age}}" }),
      node("n", "send_text", { text: "Minor" }),
    ],
    [edge("a", "c"), edge("c", "y", "yes"), edge("c", "n", "no")],
  );

  it("waits, validates, retries once, then stores the value and branches", async () => {
    addBot(askFlow);
    await handleInboundForChatbots(inbound("hi"));
    expect(session().status).toBe("waiting");
    expect(session().waitingNodeId).toBe("a");

    expect(await handleInboundForChatbots(inbound("abc"))).toBe(true);
    expect(sent()).toEqual(["Your age?", "Numbers only"]);
    expect(session().status).toBe("waiting");

    expect(await handleInboundForChatbots(inbound("25"))).toBe(true);
    expect(sent()[2]).toBe("Adult 25");
    expect(session().status).toBe("completed");
    expect(session().variables.age).toBe("25");
  });

  it("ends the session after retries are exhausted when there is no invalid edge", async () => {
    addBot(askFlow);
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("x"));
    await handleInboundForChatbots(inbound("y"));
    expect(session().status).toBe("completed");
    expect(sent()).toHaveLength(2);
  });

  it("follows the invalid edge when retries run out", async () => {
    const f = flow([node("a", "ask", { text: "Email?", variable: "e", validate: "email", maxRetries: 0 }), node("b", "send_text", { text: "Skipping" })], [edge("a", "b", "invalid")]);
    addBot(f);
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("not an email"));
    expect(sent()).toEqual(["Email?", "Skipping"]);
  });

  it("expires a waiting session older than 24 hours and starts fresh", async () => {
    addBot(askFlow);
    await handleInboundForChatbots(inbound("hi"));
    const first = session();
    const later = new Date(first.updatedAt.getTime() + 25 * 3600_000);
    await handleInboundForChatbots(inbound("hi", { receivedAt: later }));
    expect(first.status).toBe("expired");
    expect(store.sessions).toHaveLength(2);
    expect(session().status).toBe("waiting");
  });

  it("does not run a session twice when claimed concurrently", async () => {
    addBot(askFlow);
    await handleInboundForChatbots(inbound("hi"));
    const results = await Promise.all([handleInboundForChatbots(inbound("30")), handleInboundForChatbots(inbound("30"))]);
    expect(results).toEqual([true, true]);
    expect(sent().filter((s) => s === "Adult 30")).toHaveLength(1);
  });

  it("expires the session when the bot was unpublished", async () => {
    const bot = addBot(askFlow);
    await handleInboundForChatbots(inbound("hi"));
    bot.status = "draft";
    expect(await handleInboundForChatbots(inbound("25"))).toBe(false);
    expect(session().status).toBe("expired");
  });

  it("STOP ends a waiting session and is not consumed", async () => {
    addBot(askFlow);
    await handleInboundForChatbots(inbound("hi"));
    expect(await handleInboundForChatbots(inbound("STOP"))).toBe(false);
    expect(session().status).toBe("completed");
  });

  it("a tap on a template button labelled Cancel is an answer, not a STOP: the session goes on", async () => {
    addBot(askFlow);
    await handleInboundForChatbots(inbound("hi"));
    expect(await handleInboundForChatbots(inbound("Cancel", { messageType: "button" }))).toBe(true);
    expect(session().status).toBe("waiting");
    expect(sent()).toContain("Numbers only");
  });

  it("choice ask accepts a number or title", async () => {
    addBot(flow([node("a", "ask", { text: "Colour?", variable: "c", validate: "choice", choices: ["Red", "Blue"], maxRetries: 1 }), node("b", "send_text", { text: "Got {{c}}" })], [edge("a", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(menus()[0]).toMatchObject({ type: "button", body: { text: "Colour?" }, action: { buttons: [{ reply: { id: "c1", title: "Red" } }, { reply: { id: "c2", title: "Blue" } }] } });
    await handleInboundForChatbots(inbound("Blue", { replyId: "c2" }));
    expect(sent()[0]).toBe("Got Blue");
  });
});

describe("buttons and lists", () => {
  const f = flow(
    [
      node("a", "send_buttons", { text: "Pick", buttons: [{ id: "s", title: "Sales" }, { id: "h", title: "Help" }] }),
      node("s", "send_text", { text: "Sales it is" }),
      node("h", "send_text", { text: "Help it is" }),
      node("d", "send_text", { text: "Default" }),
    ],
    [edge("a", "s", "s"), edge("a", "h", "h"), edge("a", "d", "default")],
  );
  it("routes by title, by id and by number, and stores the choice", async () => {
    addBot(f);
    await handleInboundForChatbots(inbound("hi"));
    expect(menus()[0]).toMatchObject({ type: "button", body: { text: "Pick" }, action: { buttons: [{ reply: { id: "s", title: "Sales" } }, { reply: { id: "h", title: "Help" } }] } });
    expect(sent()).toEqual([]);
    await handleInboundForChatbots(inbound("help"));
    expect(sent()[0]).toBe("Help it is");
    expect(session().variables.last_choice).toBe("h");
  });
  it("routes a tapped button by its id, whatever the visible title says", async () => {
    addBot(f);
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("Sales (renamed)", { replyId: "s" }));
    expect(sent().at(-1)).toBe("Sales it is");
    expect(session().variables.last_choice).toBe("s");
  });
  it("sends numbered text when interactive messages are switched off or the options break a WhatsApp limit", async () => {
    addBot({ ...f, settings: { interactive: false } });
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()[0]).toBe("Pick\n\n1. Sales\n2. Help");
    expect(interactive.sendInteractive).not.toHaveBeenCalled();
    store.sessions = [];
    store.chatbots = [];
    const twins = flow([node("a", "send_buttons", { text: "Pick", buttons: [{ id: "x", title: "Same" }, { id: "y", title: "Same" }] })], []);
    addBot(twins);
    await handleInboundForChatbots(inbound("hi"));
    expect(sent().at(-1)).toBe("Pick\n\n1. Same\n2. Same");
  });
  it("adds the header and footer to the WhatsApp message", async () => {
    addBot(flow([node("a", "send_buttons", { text: "Pick", header: "Menu", footer: "Reply any time", buttons: [{ id: "x", title: "One" }] })], []));
    await handleInboundForChatbots(inbound("hi"));
    expect(menus()[0]).toMatchObject({ header: { type: "text", text: "Menu" }, footer: { text: "Reply any time" } });
  });
  it("re-prompts twice then takes the default edge", async () => {
    addBot(f);
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("??"));
    await handleInboundForChatbots(inbound("??"));
    expect(session().status).toBe("waiting");
    expect(menus()).toHaveLength(3);
    await handleInboundForChatbots(inbound("??"));
    expect(sent().at(-1)).toBe("Default");
    expect(session().status).toBe("completed");
  });
  it("uses the bot's own fallback message when the reply is not an option", async () => {
    addBot({ ...f, settings: { fallbackText: "Tap one of the buttons, please." } });
    await handleInboundForChatbots(inbound("hi"));
    await handleInboundForChatbots(inbound("??"));
    expect(menus()[1].body.text).toBe("Tap one of the buttons, please.");
  });
  it("routes list rows", async () => {
    addBot(flow([node("a", "send_list", { text: "Menu", buttonLabel: "Open", rows: [{ id: "r1", title: "One" }] }), node("b", "send_text", { text: "Row one" })], [edge("a", "b", "r1")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(menus()[0]).toMatchObject({ type: "list", action: { button: "Open", sections: [{ rows: [{ id: "r1", title: "One" }] }] } });
    await handleInboundForChatbots(inbound("One", { replyId: "r1" }));
    expect(sent().at(-1)).toBe("Row one");
  });
});

describe("action nodes", () => {
  it("sets attributes, tags and removes tags, scoped to the tenant", async () => {
    store.contacts[0].tags = ["old", "keep"];
    addBot(
      flow(
        [node("a", "set_attribute", { attribute: "city", value: "{{contact.name}}-town" }), node("b", "add_tag", { tag: "lead" }), node("c", "remove_tag", { tag: "old" }), node("d", "end")],
        [edge("a", "b"), edge("b", "c"), edge("c", "d")],
      ),
    );
    await handleInboundForChatbots(inbound("hi"));
    expect(store.contacts[0].attributes).toEqual({ plan: "pro", city: "Asha-town" });
    expect(store.contacts[0].tags).toEqual(["keep", "lead"]);
    expect(db.contact.updateMany.mock.calls.every((c: any[]) => c[0].where.tenantId === T)).toBe(true);
  });

  it("calls the webhook, saves the response and uses the error edge on failure", async () => {
    const f = flow(
      [node("w", "webhook", { url: "https://api.example.com/p", method: "POST", bodyTemplate: '{"n":"{{contact.name}}"}', saveAs: "resp" }), node("ok", "send_text", { text: "Price {{resp.price}}" }), node("bad", "send_text", { text: "Failed" })],
      [edge("w", "ok"), edge("w", "bad", "error")],
    );
    addBot(f);
    await handleInboundForChatbots(inbound("hi"));
    expect(http.callWebhook).toHaveBeenCalledWith({ url: "https://api.example.com/p", method: "POST", body: '{"n":"Asha"}' });
    expect(sent()).toEqual(["Price 42"]);

    store.sessions = [];
    inbox.sendText.mockClear();
    http.callWebhook.mockResolvedValue({ ok: false, status: 500, data: null });
    await handleInboundForChatbots(inbound("hi"));
    expect(sent()).toEqual(["Failed"]);
    expect(session().variables.webhook_status).toBe(500);
  });

  it("uses the seams for assign, set_status and handoff", async () => {
    const seams = { assign: vi.fn(), setStatus: vi.fn(), handoff: vi.fn() };
    registerChatbotSeams(seams);
    addBot(flow([node("a", "assign", { userId: "round_robin" }), node("b", "set_status", { status: "pending" }), node("c", "handoff", { message: "A person will help" })], [edge("a", "b"), edge("b", "c")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(seams.assign).toHaveBeenCalledWith(T, "c1", "round_robin");
    expect(seams.setStatus).toHaveBeenCalledWith(T, "c1", "pending");
    expect(seams.setStatus).toHaveBeenCalledWith(T, "c1", "open");
    expect(seams.handoff).toHaveBeenCalledWith(T, "c1", { queueOnly: false });
    expect(sent()).toEqual(["A person will help"]);
    expect(session().status).toBe("handed_off");
  });

  it("default assign seam rejects non-members without failing the run", async () => {
    addBot(flow([node("a", "assign", { userId: "stranger" }), node("b", "send_text", { text: "after" })], [edge("a", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(store.conversations[0].assignedToId).toBeUndefined();
    expect(sent()).toEqual(["after"]);
  });

  it("default assign seam assigns members; default status seam stamps statusChangedAt", async () => {
    addBot(flow([node("a", "assign", { userId: "u9" }), node("b", "set_status", { status: "solved" })], [edge("a", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(store.conversations[0]).toMatchObject({ assignedToId: "u9", status: "solved" });
    expect(store.conversations[0].statusChangedAt).toBeInstanceOf(Date);
  });

  it("sends approved templates with numbered parameters and skips unapproved ones", async () => {
    store.templates = [{ id: "tp1", tenantId: T, wabaRefId: "w1", name: "promo", language: "en", status: "approved" }];
    addBot(flow([node("a", "send_template", { templateId: "tp1", variables: { "1": "{{contact.name}}" } }), node("b", "send_template", { templateId: "missing", variables: {} })], [edge("a", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(inbox.sendTemplateMessage.mock.calls[0][0]).toMatchObject({
      tenantId: T,
      phoneNumberId: "pn1",
      contactId: "k1",
      templateName: "promo",
      components: [{ type: "body", parameters: [{ type: "text", text: "Asha" }] }],
    });
  });

  it("ends the session as expired when the 24h window is closed", async () => {
    inbox.sendText.mockRejectedValue(Object.assign(new Error("closed"), { status: 409 }));
    addBot(flow([node("a", "send_text", { text: "x" })], []));
    await handleInboundForChatbots(inbound("hi"));
    expect(session().status).toBe("expired");
  });
});

describe("guards", () => {
  it("stops a loop at the step limit", async () => {
    addBot(flow([node("a", "set_attribute", { attribute: "x", value: "1" }), node("b", "set_attribute", { attribute: "y", value: "2" })], [edge("a", "b"), edge("b", "a")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(session().status).toBe("expired");
    expect(db.contact.updateMany.mock.calls.length).toBeLessThanOrEqual(MAX_STEPS_PER_RUN);
  });

  it("caps bot messages per minute", async () => {
    addBot(flow([node("a", "send_text", { text: "spam" }), node("b", "send_text", { text: "spam" })], [edge("a", "b"), edge("b", "a")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(inbox.sendText).toHaveBeenCalledTimes(MAX_BOT_MESSAGES_PER_MINUTE);
    expect(session().status).toBe("expired");
  });
});

describe("delay and worker", () => {
  const delayFlow = flow([node("a", "send_text", { text: "before" }), node("d", "delay", { minutes: 10 }), node("b", "send_text", { text: "after" })], [edge("a", "d"), edge("d", "b")]);

  it("sleeps with wakeAt, ignores inbound meanwhile, and the worker resumes it once", async () => {
    addBot(delayFlow);
    await handleInboundForChatbots(inbound("hi"));
    const s = session();
    expect(s.status).toBe("active");
    expect(s.currentNodeId).toBe("b");
    expect(s.wakeAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    // The sleeping bot still owns the chat, so the message counts as handled (routing, holiday mode and classic rules stay quiet).
    expect(await handleInboundForChatbots(inbound("hi again"))).toBe(true);
    expect(sent()).toEqual(["before"]);

    expect(await resumeDelayedSessions(new Date())).toBe(0);
    const resumed = await resumeDelayedSessions(new Date(Date.now() + 11 * 60_000));
    expect(resumed).toBe(1);
    expect(sent()).toEqual(["before", "after"]);
    expect(s.status).toBe("completed");
    expect(await resumeDelayedSessions(new Date(Date.now() + 12 * 60_000))).toBe(0);
  });

  it("expires delayed sessions whose chatbot was unpublished", async () => {
    const bot = addBot(delayFlow);
    await handleInboundForChatbots(inbound("hi"));
    bot.status = "draft";
    await resumeDelayedSessions(new Date(Date.now() + 11 * 60_000));
    expect(session().status).toBe("expired");
    expect(sent()).toEqual(["before"]);
  });

  describe("workspace suspended, deleted or billing-locked", () => {
    const sleeping = async () => {
      addBot(delayFlow);
      await handleInboundForChatbots(inbound("hi"));
      return session();
    };
    it("does not wake the session or send, and pushes its wake time 15 minutes on instead of dropping it", async () => {
      const s = await sleeping();
      const later = new Date(Date.now() + 11 * 60_000);
      tenant.blocked.add(T);
      expect(await resumeDelayedSessions(later)).toBe(0);
      expect(sent()).toEqual(["before"]);
      expect(s.status).toBe("active");
      expect(s.currentNodeId).toBe("b");
      expect(s.wakeAt.getTime()).toBe(later.getTime() + 15 * 60_000);
    });
    it("resumes the very same session once the workspace is allowed again", async () => {
      const s = await sleeping();
      tenant.blocked.add(T);
      await resumeDelayedSessions(new Date(Date.now() + 11 * 60_000));
      tenant.blocked.clear();
      expect(await resumeDelayedSessions(new Date(Date.now() + 30 * 60_000))).toBe(1);
      expect(sent()).toEqual(["before", "after"]);
      expect(s.status).toBe("completed");
    });
    it("keeps pushing while blocked and ends a session older than 7 days as expired", async () => {
      const s = await sleeping();
      tenant.blocked.add(T);
      await resumeDelayedSessions(new Date(Date.now() + 11 * 60_000));
      expect(s.status).toBe("active");
      s.startedAt = new Date(Date.now() - 8 * 86_400_000);
      await resumeDelayedSessions(new Date(Date.now() + 60 * 60_000));
      expect(s.status).toBe("expired");
      expect(sent()).toEqual(["before"]);
    });
    it("a blocked workspace's due session does not hold back another workspace's session in the same batch", async () => {
      await sleeping();
      store.sessions.push({ ...session(), id: "other", tenantId: "t2", chatbotId: "bot2", wakeAt: new Date(Date.now() + 10 * 60_000 + 1) });
      addBot(delayFlow, { id: "bot2", tenantId: "t2", triggerKeywords: ["zzz"] });
      tenant.blocked.add(T);
      expect(await resumeDelayedSessions(new Date(Date.now() + 11 * 60_000))).toBe(1);
      expect(store.sessions.find((x) => x.id === "other")?.status).not.toBe("active");
    });
    it("wakeSession itself refuses to claim or send for a blocked workspace", async () => {
      const { wakeSession, parseFlow } = await import("@/lib/chatbots/engine");
      const s = await sleeping();
      const before = s.wakeAt;
      tenant.blocked.add(T);
      expect(await wakeSession({ ...s } as Parameters<typeof wakeSession>[0], parseFlow(delayFlow)!)).toBe(false);
      expect(s.wakeAt).toBe(before);
      expect(sent()).toEqual(["before"]);
    });
  });

  describe("inbound handling in a blocked workspace (no reply is created, so nothing stale waits in the send queue)", () => {
    const askBot = () => addBot(flow([node("a", "ask", { text: "Your name?", variable: "n", validate: "text", maxRetries: 1 }), node("b", "send_text", { text: "Thanks {{n}}" })], [edge("a", "b")]));
    it("a new inbound message starts no bot and sends nothing; the session is ended as expired", async () => {
      addBot(flow([node("a", "send_text", { text: "welcome" })], []));
      tenant.blocked.add(T);
      await handleInboundForChatbots(inbound("hi"));
      expect(inbox.sendText).not.toHaveBeenCalled();
      expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
      expect(session().status).toBe("expired");
    });
    it("a reply to a waiting session is not answered and the session is not claimed (it stays waiting and expires normally)", async () => {
      askBot();
      await handleInboundForChatbots(inbound("hi"));
      const s = session();
      expect(s.status).toBe("waiting");
      const before = s.updatedAt;
      tenant.blocked.add(T);
      await handleInboundForChatbots(inbound("Asha"));
      expect(sent()).toEqual(["Your name?"]);
      expect(s.status).toBe("waiting");
      expect(s.updatedAt).toBe(before);
    });
    it("works again as soon as the workspace is allowed", async () => {
      askBot();
      await handleInboundForChatbots(inbound("hi"));
      tenant.blocked.add(T);
      await handleInboundForChatbots(inbound("Asha"));
      tenant.blocked.clear();
      await handleInboundForChatbots(inbound("Asha"));
      expect(sent()).toEqual(["Your name?", "Thanks Asha"]);
    });
    it("a state that cannot be confirmed (the workspace read fails) does not silence the bot", async () => {
      addBot(flow([node("a", "send_text", { text: "welcome" })], []));
      tenant.blocked.add(T);
      tenant.unreadable = true;
      await handleInboundForChatbots(inbound("hi"));
      expect(sent()).toEqual(["welcome"]);
    });
    it("a manual start for a blocked workspace sends nothing either", async () => {
      addBot(flow([node("a", "send_text", { text: "manual hello" })], []), { id: "m", triggerType: "manual", triggerKeywords: [] });
      tenant.blocked.add(T);
      await startChatbot({ tenantId: T }, "m", "c1");
      expect(inbox.sendText).not.toHaveBeenCalled();
    });
  });

  it("expires stale waiting sessions only", async () => {
    store.sessions = [
      { id: "s1", tenantId: T, status: "waiting", updatedAt: new Date(Date.now() - 25 * 3600_000) },
      { id: "s2", tenantId: T, status: "waiting", updatedAt: new Date(Date.now() - 1 * 3600_000) },
      { id: "s3", tenantId: T, status: "active", wakeAt: new Date(), updatedAt: new Date(Date.now() - 48 * 3600_000) },
    ];
    expect(await expireStaleSessions()).toBe(1);
    expect(store.sessions.map((s) => s.status)).toEqual(["expired", "waiting", "active"]);
  });
});

describe("startChatbot", () => {
  const f = flow([node("a", "send_text", { text: "manual hello" })], []);
  it("starts a published manual bot and replaces a live session", async () => {
    addBot(f, { id: "m", triggerType: "manual", triggerKeywords: [] });
    store.sessions = [{ id: "old", tenantId: T, conversationId: "c1", status: "waiting", updatedAt: new Date() }];
    const result = await startChatbot({ tenantId: T }, "m", "c1");
    expect(store.sessions[0].status).toBe("expired");
    expect(sent()).toEqual(["manual hello"]);
    expect(result.sessionId).toBeTruthy();
  });
  it("a teammate starting a bot while the AI agent talks pauses the agent, and dates the pause", async () => {
    addBot(f, { id: "m", triggerType: "manual", triggerKeywords: [] });
    store.conversations[0].tags = ["vip"];
    store.conversations[0].lastInboundAt = new Date();
    db.usageLedger.findFirst.mockResolvedValueOnce({ id: "reply1" });
    await startChatbot({ tenantId: T }, "m", "c1", { source: "manual" });
    expect(store.conversations[0].tags).toEqual(["vip", "ai:stopped"]);
    expect(store.audits).toEqual([expect.objectContaining({ tenantId: T, action: "ai_agent.paused", target: "c1" })]);
    expect(sent()).toEqual(["manual hello"]);
  });

  it("starts for a contact who opted out: a bot's replies are not marketing (owner default 1)", async () => {
    addBot(f, { id: "m", triggerType: "manual", triggerKeywords: [] });
    store.contacts[0].optedOutAt = new Date(0);
    store.conversations[0].contact = { optedOutAt: new Date(0) };
    await startChatbot({ tenantId: T }, "m", "c1", { source: "manual" });
    expect(sent()).toEqual(["manual hello"]);
  });

  it("rejects drafts, unknown bots, and other tenants", async () => {
    addBot(f, { id: "d", status: "draft" });
    await expect(startChatbot({ tenantId: T }, "d", "c1")).rejects.toMatchObject({ status: 409 });
    await expect(startChatbot({ tenantId: T }, "nope", "c1")).rejects.toMatchObject({ status: 404 });
    addBot(f, { id: "x" });
    await expect(startChatbot({ tenantId: "t2" }, "x", "c1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("republishing and waits (P5)", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  const later = (h: number) => new Date(Date.now() + h * 3_600_000);
  const waitFlow = (onReply?: string, then: Row = node("b", "send_text", { text: "after" })) =>
    flow([node("a", "send_text", { text: "before" }), node("d", "delay", { minutes: 60, ...(onReply ? { onReply } : {}) }), then], [edge("a", "d"), edge("d", then.id)]);
  let notes: Row[] = [];
  let seams: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    notes = [];
    db.note = model(() => notes);
    seams = { assign: vi.fn(), assignTeam: vi.fn(), setStatus: vi.fn(), handoff: vi.fn() };
    registerChatbotSeams(seams as never);
  });

  it("a customer waiting at a step that was removed on republish is not left unanswered: the message goes on", async () => {
    const bot = addBot(flow([node("a", "ask", { text: "Your age?", variable: "age", validate: "number", maxRetries: 1 }), node("b", "end")], [edge("a", "b")]));
    await handleInboundForChatbots(inbound("hi"));
    expect(session().status).toBe("waiting");
    bot.publishedFlow = flow([node("z", "send_text", { text: "New welcome" })], []);
    expect(await handleInboundForChatbots(inbound("42"))).toBe(false);
    expect(session().status).toBe("completed");
    expect(sent()).toEqual(["Your age?"]);
  });

  it("by default the sleeping bot keeps the customer's message, as before", async () => {
    addBot(waitFlow());
    await handleInboundForChatbots(inbound("hi"));
    expect(session().variables.__sleepingAt).toBe("d");
    expect(await handleInboundForChatbots(inbound("hello?"))).toBe(true);
    expect(session().status).toBe("active");
    expect(sent()).toEqual(["before"]);
  });

  it("'Stop waiting' goes on to the next step as soon as the customer writes", async () => {
    addBot(waitFlow("continue", node("b", "send_text", { text: "You said: {{last_reply}}" })));
    await handleInboundForChatbots(inbound("hi"));
    expect(await handleInboundForChatbots(inbound("I am back"))).toBe(true);
    expect(sent()).toEqual(["before", "You said: I am back"]);
    expect(session().status).toBe("completed");
    expect(session().variables.__sleepingAt).toBeUndefined();
    // The worker then finds nothing left to wake.
    expect(await resumeDelayedSessions(later(2))).toBe(0);
  });

  it("'Let routing and rules handle it' passes the message on while the bot keeps waiting", async () => {
    addBot(waitFlow("pass"));
    await handleInboundForChatbots(inbound("hi"));
    expect(await handleInboundForChatbots(inbound("Any update?"))).toBe(false);
    expect(session().status).toBe("active");
    expect(session().wakeAt).toBeTruthy();
    expect(await resumeDelayedSessions(later(2))).toBe(1);
    expect(sent()).toEqual(["before", "after"]);
  });

  it("hands the chat to the team, with a note, when the 24-hour window closed during the wait", async () => {
    addBot(waitFlow());
    await handleInboundForChatbots(inbound("hi"));
    const s = session();
    // The customer wrote 22 hours before the bot fell asleep (window open then), and 25 hours before now (closed now).
    s.updatedAt = hoursAgo(3);
    store.conversations[0].lastInboundAt = hoursAgo(25);
    expect(await resumeDelayedSessions(later(2))).toBe(1);
    expect(sent()).toEqual(["before"]);
    expect(s.status).toBe("handed_off");
    expect(seams.setStatus).toHaveBeenCalledWith(T, "c1", "open");
    expect(seams.handoff).toHaveBeenCalledWith(T, "c1", { queueOnly: false });
    expect(notes[0].body).toMatch(/24-hour window closed while the chatbot was waiting/);
    expect(store.conversations[0].tags).toContain("ai:stopped");
    // The hand-over dates the AI agent's pause, which lasts one episode of the chat.
    expect(store.audits).toEqual([expect.objectContaining({ tenantId: T, action: "ai_agent.paused", target: "c1" })]);
  });

  describe("after a wait that outlived the 24-hour window, only a free message hands over", () => {
    const closedWake = async (then: Row[], edges: Row[]) => {
      addBot(flow([node("a", "send_text", { text: "before" }), node("d", "delay", { minutes: 1440 }), ...then], [edge("a", "d"), ...edges]));
      await handleInboundForChatbots(inbound("hi"));
      // The window was open when the session started (the customer wrote 23 hours before that) and has closed by the wake.
      session().startedAt = hoursAgo(2);
      store.conversations[0].lastInboundAt = hoursAgo(25);
      return resumeDelayedSessions(later(25));
    };
    const template = () => {
      store.templates = [{ id: "tp1", tenantId: T, wabaRefId: "w1", status: "approved", name: "follow_up", language: "en", category: "UTILITY", components: [{ type: "BODY", text: "Hello again" }] }];
      return node("t", "send_template", { templateId: "tp1", variables: {} });
    };

    it("'Wait 1 day, then mark the chat solved' solves the chat as before", async () => {
      expect(await closedWake([node("s", "set_status", { status: "solved" })], [edge("d", "s")])).toBe(1);
      expect(seams.setStatus).toHaveBeenCalledWith(T, "c1", "solved");
      expect(seams.setStatus).not.toHaveBeenCalledWith(T, "c1", "open");
      expect(seams.handoff).not.toHaveBeenCalled();
      expect(session().status).toBe("completed");
      expect(notes).toEqual([]);
    });

    it("'Wait 1 day, add a tag, send a template' tags the contact and sends the template", async () => {
      await closedWake([node("g", "add_tag", { tag: "follow-up" }), template()], [edge("d", "g"), edge("g", "t")]);
      expect(store.contacts[0].tags).toEqual(["follow-up"]);
      expect(inbox.sendTemplateMessage).toHaveBeenCalledWith(expect.objectContaining({ templateName: "follow_up" }));
      expect(seams.handoff).not.toHaveBeenCalled();
      expect(session().status).toBe("completed");
    });

    it("runs the silent steps, then hands over at the first free message, also one after a template", async () => {
      await closedWake([node("g", "add_tag", { tag: "follow-up" }), node("b", "send_text", { text: "Still there?" })], [edge("d", "g"), edge("g", "b")]);
      expect(store.contacts[0].tags).toEqual(["follow-up"]);
      expect(sent()).toEqual(["before"]);
      expect(session().status).toBe("handed_off");
      expect(notes[0].body).toMatch(/24-hour window closed/);

      // A template opens no window, so a question after it would be refused too.
      store.sessions = [];
      store.chatbots = [];
      notes.length = 0;
      await closedWake([template(), node("q", "ask", { text: "Shall we book?", variable: "ok", validate: "text" })], [edge("d", "t"), edge("t", "q")]);
      expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
      expect(sent()).toEqual(["before", "before"]);
      expect(session().status).toBe("handed_off");
      expect(notes).toHaveLength(1);
    });

    it("a hand-over step still hands over, without its message, and its note says why", async () => {
      await closedWake([node("h", "handoff", { message: "A teammate will reply." })], [edge("d", "h")]);
      expect(sent()).toEqual(["before"]);
      expect(seams.handoff).toHaveBeenCalledTimes(1);
      expect(session().status).toBe("handed_off");
      expect(notes[0].body).toMatch(/Its message was not sent because the 24-hour window had closed/);
    });

    it("judges the window from when the session started, so a second wait after the first still hands over", async () => {
      addBot(flow([node("a", "send_text", { text: "before" }), node("d", "delay", { minutes: 1440 }), node("d2", "delay", { minutes: 30 }), node("b", "send_text", { text: "after" })], [edge("a", "d"), edge("d", "d2"), edge("d2", "b")]));
      await handleInboundForChatbots(inbound("hi"));
      const s = session();
      s.startedAt = hoursAgo(25);
      store.conversations[0].lastInboundAt = hoursAgo(26);
      // The second wait began after the window had closed; the session started inside it.
      s.wakeAt = later(0);
      s.currentNodeId = "b";
      s.variables = { __sleepingAt: "d2" };
      s.updatedAt = hoursAgo(0.5);
      await resumeDelayedSessions(later(1));
      expect(sent()).toEqual(["before"]);
      expect(s.status).toBe("handed_off");
    });
  });

  it("goes on as usual when the next step is a template, or when the window was already closed when the wait began", async () => {
    store.templates = [{ id: "tp1", tenantId: T, wabaRefId: "w1", status: "approved", name: "follow_up", language: "en", category: "UTILITY", components: [{ type: "BODY", text: "Hello again" }] }];
    addBot(waitFlow(undefined, node("t", "send_template", { templateId: "tp1", variables: {} })));
    await handleInboundForChatbots(inbound("hi"));
    session().updatedAt = hoursAgo(3);
    store.conversations[0].lastInboundAt = hoursAgo(25);
    await resumeDelayedSessions(later(2));
    expect(inbox.sendTemplateMessage).toHaveBeenCalledWith(expect.objectContaining({ templateName: "follow_up" }));
    expect(seams.handoff).not.toHaveBeenCalled();

    // A bot a rule started on a customer whose window was long closed: nothing to hand over, it runs its steps as before.
    store.sessions = [];
    store.chatbots = [];
    inbox.sendText.mockClear();
    addBot(waitFlow());
    await handleInboundForChatbots(inbound("hi"));
    session().updatedAt = hoursAgo(3);
    store.conversations[0].lastInboundAt = hoursAgo(40);
    await resumeDelayedSessions(later(2));
    expect(seams.handoff).not.toHaveBeenCalled();
    expect(sent()).toEqual(["before", "after"]);
  });
});

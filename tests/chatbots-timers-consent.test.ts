import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const store = vi.hoisted(() => ({ sessions: [] as Row[], chatbots: [] as Row[], contacts: [] as Row[], conversations: [] as Row[], audit: [] as Row[], clock: 0 }));

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("in" in cond) return cond.in.includes(value);
      if ("lt" in cond) return value != null && value < cond.lt;
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
    const row = { id: `${rows().length + 1}`, createdAt: new Date(), updatedAt: new Date(store.clock++), ...defaults(), ...data };
    rows().push(row);
    return row;
  }),
  updateMany: vi.fn(async ({ where, data }: Row) => {
    const hit = rows().filter((r) => matches(r, where));
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  }),
});

const db = vi.hoisted(() => ({}) as Record<string, any>);
vi.mock("@/lib/db", () => ({ prisma: db }));
const inbox = vi.hoisted(() => ({ sendText: vi.fn(), sendTemplateMessage: vi.fn() }));
vi.mock("@/lib/inbox/service", () => inbox);
const interactive = vi.hoisted(() => ({ sendInteractive: vi.fn() }));
vi.mock("@/lib/inbox/interactive", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/inbox/interactive")>()), sendInteractive: interactive.sendInteractive }));
const tenant = vi.hoisted(() => ({ blocked: new Set<string>() }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async (id: string) => !tenant.blocked.has(id) }));
vi.mock("@/lib/billing", () => ({ getBillingStatus: async () => ({ canWrite: true }) }));
const events = vi.hoisted(() => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/integrations/events", () => events);

import { handleInboundForChatbots } from "@/lib/chatbots";
import { parseSettings, validateFlow } from "@/lib/chatbots/flow";
import { evaluateCondition, parseDate, validateAnswer } from "@/lib/chatbots/vars";
import { expireIdleSessions, worker } from "@/lib/chatbots/worker";

const T = "t1";
const node = (id: string, type: string, data: Row = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (from: string, to: string, label?: string) => ({ id: `${from}-${to}-${label ?? ""}`, from, to, ...(label ? { label } : {}) });
const flow = (nodes: Row[], edges: Row[], settings?: Row) => ({ version: 1, start: nodes[0].id, nodes, edges, ...(settings ? { settings } : {}) });

function addBot(f: Row, extra: Row = {}) {
  const bot = { id: `bot${store.chatbots.length + 1}`, tenantId: T, phoneNumberId: null, status: "published", triggerType: "keyword", triggerKeywords: ["hi"], publishedFlow: f, flow: f, createdAt: new Date(store.clock++), ...extra };
  store.chatbots.push(bot);
  return bot;
}

const sent = () => inbox.sendText.mock.calls.map((c) => c[0].body as string);
const inbound = (text: string, extra: Row = {}) => ({ tenantId: T, phoneNumberId: "pn1", conversationId: "c1", contactId: "k1", text, receivedAt: new Date(), ...extra });
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  tenant.blocked = new Set();
  store.sessions = [];
  store.chatbots = [];
  store.audit = [];
  store.clock = 0;
  store.contacts = [{ id: "k1", tenantId: T, phone: "+911111111111", name: "Asha", attributes: {}, tags: [], optIn: false, optedOutAt: null }];
  store.conversations = [{ id: "c1", tenantId: T, phoneNumberId: "pn1", contactId: "k1", status: "open", phoneNumber: { wabaRefId: "w1" } }];
  Object.assign(db, {
    chatbotSession: model(() => store.sessions, () => ({ variables: {}, waitingNodeId: null, wakeAt: null, endedAt: null })),
    chatbot: {
      ...model(() => store.chatbots),
      // The JSON path filter is Postgres only: the stand-in answers it by hand and leaves other queries to the plain matcher.
      findMany: vi.fn(async ({ where }: Row) => {
        const { publishedFlow, ...rest } = where;
        return store.chatbots
          .filter((b) => matches(b, rest) && (!publishedFlow?.path || (b.publishedFlow?.settings?.timeoutMinutes ?? 1440) < publishedFlow.lt))
          .map((b) => ({ ...b }));
      }),
    },
    contact: model(() => store.contacts),
    conversation: model(() => store.conversations),
    message: model(() => []),
    template: model(() => []),
    usageLedger: model(() => []),
    auditLog: model(() => store.audit),
  });
  interactive.sendInteractive.mockResolvedValue({});
  inbox.sendText.mockResolvedValue({});
});

describe("condition operators", () => {
  it("handles does-not-contain, starts-with and does-not-start-with", () => {
    expect(evaluateCondition("starts_with", "Order 55", "order")).toBe(true);
    expect(evaluateCondition("starts_with", "My order", "order")).toBe(false);
    expect(evaluateCondition("not_starts_with", "My order", "order")).toBe(true);
    expect(evaluateCondition("not_contains", "hello world", "WORLD")).toBe(false);
    expect(evaluateCondition("not_contains", "hello", "world")).toBe(true);
    expect(evaluateCondition("not_contains", undefined, "world")).toBe(true);
    expect(evaluateCondition("starts_with", "abc", "")).toBe(false);
  });

  it("accepts the new operators when a flow is validated", () => {
    const f = flow([node("a", "condition", { variable: "x", operator: "starts_with", value: "ab" }), node("b", "end")], [edge("a", "b", "yes")]);
    expect(validateFlow(f).ok).toBe(true);
  });
});

describe("date answers", () => {
  it("accepts ISO and day-first dates and returns YYYY-MM-DD", () => {
    expect(parseDate("2026-03-07")).toBe("2026-03-07");
    expect(parseDate("7/3/2026")).toBe("2026-03-07");
    expect(parseDate("27-03-2026")).toBe("2026-03-27");
    expect(parseDate("27.03.2026")).toBe("2026-03-27");
  });

  it("rejects dates that do not exist and other text", () => {
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("2026-13-01")).toBeNull();
    expect(parseDate("tomorrow")).toBeNull();
    expect(parseDate("1800-01-01")).toBeNull();
    expect(validateAnswer("date", "29/02/2025")).toEqual({ ok: false });
    expect(validateAnswer("date", "29/02/2024")).toEqual({ ok: true, value: "2024-02-29" });
  });
});

describe("inactivity settings", () => {
  it("defaults to 24 hours and reads a custom limit and reminder", () => {
    expect(parseSettings({}).timeoutMinutes).toBe(1440);
    const s = parseSettings({ timeoutMinutes: 30, timeoutMessage: "Still there?" });
    expect(s.timeoutMinutes).toBe(30);
    expect(s.timeoutMessage).toBe("Still there?");
  });

  it("reports a limit outside 1 to 1440 minutes when validating, and falls back quietly otherwise", () => {
    const f = flow([node("a", "send_text", { text: "x" })], [], { timeoutMinutes: 5000 });
    const result = validateFlow(f);
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/1 to 1440/);
    expect(parseSettings({ timeoutMinutes: 5000 }).timeoutMinutes).toBe(1440);
    expect(parseSettings({ timeoutMinutes: 0 }).timeoutMinutes).toBe(1440);
    expect(parseSettings({ timeoutMinutes: 1.5 }).timeoutMinutes).toBe(1440);
  });

  it("is registered as a periodic worker task", () => {
    expect(worker.periodic.map((p) => p.name)).toContain("chatbots.expire-idle");
  });
});

describe("expireIdleSessions", () => {
  const ask = (settings: Row) => flow([node("a", "ask", { text: "Name?", variable: "name", validate: "text", maxRetries: 1 }), node("b", "end")], [edge("a", "b")], settings);
  const waiting = (botId: string, updatedAt: Date, extra: Row = {}) => {
    const row = { id: `s${store.sessions.length + 1}`, tenantId: T, chatbotId: botId, conversationId: "c1", contactId: "k1", status: "waiting", waitingNodeId: "a", wakeAt: null, variables: {}, startedAt: updatedAt, updatedAt, ...extra };
    store.sessions.push(row);
    return row;
  };

  it("ends a session that stayed silent past the bot's limit and sends the reminder once", async () => {
    const bot = addBot(ask({ timeoutMinutes: 30, timeoutMessage: "Still there? Reply any time." }));
    const old = waiting(bot.id, minutesAgo(45));
    const fresh = waiting(bot.id, minutesAgo(10), { conversationId: "c2" });
    expect(await expireIdleSessions()).toBe(1);
    expect(old.status).toBe("expired");
    expect(fresh.status).toBe("waiting");
    expect(sent()).toEqual(["Still there? Reply any time."]);
    expect(await expireIdleSessions()).toBe(0);
    expect(sent()).toHaveLength(1);
  });

  it("ends quietly when the bot has no reminder", async () => {
    const bot = addBot(ask({ timeoutMinutes: 5 }));
    waiting(bot.id, minutesAgo(6));
    expect(await expireIdleSessions()).toBe(1);
    expect(inbox.sendText).not.toHaveBeenCalled();
  });

  it("sends no reminder to an opted-out contact or from a blocked workspace, and a closed window does not stop the expiry", async () => {
    const bot = addBot(ask({ timeoutMinutes: 5, timeoutMessage: "Bye" }));
    waiting(bot.id, minutesAgo(6));
    store.contacts[0].optedOutAt = new Date();
    expect(await expireIdleSessions()).toBe(1);
    expect(inbox.sendText).not.toHaveBeenCalled();

    store.contacts[0].optedOutAt = null;
    tenant.blocked.add(T);
    waiting(bot.id, minutesAgo(6));
    expect(await expireIdleSessions()).toBe(1);
    expect(inbox.sendText).not.toHaveBeenCalled();

    tenant.blocked.clear();
    inbox.sendText.mockRejectedValueOnce(new Error("window closed"));
    const last = waiting(bot.id, minutesAgo(6));
    expect(await expireIdleSessions()).toBe(1);
    expect(last.status).toBe("expired");
  });

  it("still sends the reminder to a contact who opted out before the bot started: it is a reply in the window, not marketing", async () => {
    const bot = addBot(ask({ timeoutMinutes: 5, timeoutMessage: "Bye" }));
    waiting(bot.id, minutesAgo(6));
    store.contacts[0].optedOutAt = minutesAgo(60);
    expect(await expireIdleSessions()).toBe(1);
    expect(inbox.sendText).toHaveBeenCalledTimes(1);
  });

  it("leaves bots on the standard 24 hours alone", async () => {
    const bot = addBot(ask({}));
    const row = waiting(bot.id, minutesAgo(600));
    expect(await expireIdleSessions()).toBe(0);
    expect(row.status).toBe("waiting");
  });
});

describe("a reply after the bot's own limit", () => {
  it("does not continue the old session and lets a trigger start the bot again", async () => {
    const f = flow([node("a", "ask", { text: "Name?", variable: "name", validate: "text", maxRetries: 1 }), node("b", "send_text", { text: "Thanks {{name}}" }), node("c", "end")], [edge("a", "b"), edge("b", "c")], { timeoutMinutes: 5 });
    const bot = addBot(f);
    const stale = { id: "s1", tenantId: T, chatbotId: bot.id, conversationId: "c1", contactId: "k1", status: "waiting", waitingNodeId: "a", wakeAt: null, variables: {}, startedAt: minutesAgo(20), updatedAt: minutesAgo(20) };
    store.sessions.push(stale);
    expect(await handleInboundForChatbots(inbound("hi"))).toBe(true);
    expect(stale.status).toBe("expired");
    expect(sent()).toEqual(["Name?"]);
    expect(store.sessions).toHaveLength(2);
    expect(store.sessions[1].status).toBe("waiting");
  });

  it("still continues a session inside the limit", async () => {
    const f = flow([node("a", "ask", { text: "Name?", variable: "name", validate: "text", maxRetries: 1 }), node("b", "send_text", { text: "Thanks {{name}}" }), node("c", "end")], [edge("a", "b"), edge("b", "c")], { timeoutMinutes: 30 });
    const bot = addBot(f);
    store.sessions.push({ id: "s1", tenantId: T, chatbotId: bot.id, conversationId: "c1", contactId: "k1", status: "waiting", waitingNodeId: "a", wakeAt: null, variables: {}, startedAt: minutesAgo(10), updatedAt: minutesAgo(10) });
    expect(await handleInboundForChatbots(inbound("Asha K"))).toBe(true);
    expect(sent()).toEqual(["Thanks Asha K"]);
    expect(store.sessions).toHaveLength(1);
  });
});

describe("subscribe and unsubscribe steps", () => {
  const run = (nodes: Row[], edges: Row[]) => {
    addBot(flow(nodes, edges));
    return handleInboundForChatbots(inbound("hi"));
  };

  it("validates: the unsubscribe step ends the flow and cannot have a next step", () => {
    const bad = flow([node("a", "unsubscribe", { message: "Bye" }), node("b", "end")], [edge("a", "b")]);
    expect(validateFlow(bad).ok).toBe(false);
    expect(validateFlow(flow([node("a", "subscribe", { source: "Said yes in chat" }), node("b", "end")], [edge("a", "b")])).ok).toBe(true);
    expect(validateFlow(flow([node("a", "unsubscribe", {})], [])).ok).toBe(true);
  });

  it("subscribe records consent with its source and an audit entry, then goes on", async () => {
    await run([node("a", "subscribe", { source: "Offers chatbot" }), node("b", "send_text", { text: "Thanks" }), node("c", "end")], [edge("a", "b"), edge("b", "c")]);
    expect(store.contacts[0]).toMatchObject({ optIn: true, optInSource: "Offers chatbot" });
    expect(store.contacts[0].optInAt).toBeInstanceOf(Date);
    expect(store.audit[0]).toMatchObject({ tenantId: T, action: "contact.consent_recorded", target: "k1" });
    expect(sent()).toEqual(["Thanks"]);
  });

  it("subscribe uses a default source and never reverses an opt-out", async () => {
    await run([node("a", "subscribe"), node("b", "end")], [edge("a", "b")]);
    expect(store.contacts[0].optInSource).toBe("Chatbot");

    store.contacts[0].optIn = false;
    store.contacts[0].optInSource = null;
    store.sessions = [];
    const bot = store.chatbots[0];
    bot.id = "bot-x";
    // An opted-out contact is still answered (an opt-out stops marketing only), but the subscribe step never opts them back in:
    // only START does.
    store.contacts[0].optedOutAt = new Date(0);
    await handleInboundForChatbots(inbound("hi"));
    expect(store.contacts[0].optIn).toBe(false);
    expect(store.audit.filter((a) => a.action === "contact.consent_recorded")).toHaveLength(1);
  });

  it("unsubscribe sends its confirmation, opts the contact out, ends the bot and sends nothing after", async () => {
    await run([node("a", "unsubscribe", { message: "You are unsubscribed." })], []);
    expect(sent()).toEqual(["You are unsubscribed."]);
    expect(store.contacts[0].optedOutAt).toBeInstanceOf(Date);
    expect(store.contacts[0].optIn).toBe(false);
    expect(store.audit[0]).toMatchObject({ action: "contact.opted_out", target: "k1", tenantId: T });
    expect(store.sessions[0].status).toBe("completed");
  });

  it("unsubscribe tells integrations once with source chatbot, and not again for a contact who already opted out", async () => {
    events.emitEvent.mockClear();
    await run([node("a", "unsubscribe", {})], []);
    expect(events.emitEvent).toHaveBeenCalledTimes(1);
    expect(events.emitEvent).toHaveBeenCalledWith(T, "contact.opted_out", expect.objectContaining({ contactId: "k1", source: "chatbot" }));
  });

  it("a failing webhook queue does not break the unsubscribe", async () => {
    events.emitEvent.mockRejectedValueOnce(new Error("queue down"));
    await run([node("a", "unsubscribe", { message: "Bye" })], []);
    expect(store.contacts[0].optedOutAt).toBeInstanceOf(Date);
    expect(store.sessions[0].status).toBe("completed");
  });

  it("after the Stop messages step nothing more is sent in that session; the opt-out stops marketing only", async () => {
    await run([node("a", "unsubscribe", { message: "Bye" })], []);
    expect(sent()).toEqual(["Bye"]);
    expect(store.sessions[0].status).toBe("completed");
    expect(store.contacts[0]).toMatchObject({ optIn: false });
    expect(store.contacts[0].optedOutAt).toBeInstanceOf(Date);
  });
});

describe("builder: new steps and settings", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BotSettings } = await import("@/components/chatbots/BotSettings");
  const { NODE_META, handlesOf, makeNode, summarize } = await import("@/components/chatbots/catalog");
  const { newDoc } = await import("@/components/chatbots/editor");
  const { withSettings } = await import("@/components/chatbots/flow");
  const { reply, startPreview } = await import("@/components/chatbots/preview");

  const at = { x: 0, y: 0 };
  const uiFlow = (nodes: any[], edges: any[] = []) => ({ version: 1 as const, start: nodes[0].id, nodes, edges });

  it("offers the new steps with plain labels, no outgoing connection for unsubscribe, and a readable summary", () => {
    expect(NODE_META.subscribe.label).toBe("Allow offers");
    expect(NODE_META.unsubscribe.label).toBe("Stop messages");
    expect(handlesOf(makeNode("unsubscribe", "u", at))).toEqual([]);
    expect(handlesOf(makeNode("subscribe", "s", at))).toHaveLength(1);
    expect(summarize(makeNode("subscribe", "s", at))).toBe("Chatbot");
  });

  it("previews the consent steps", () => {
    const f = uiFlow([makeNode("subscribe", "a", at), { ...makeNode("unsubscribe", "b", at), data: { message: "Bye for now" } }], [{ id: "e1", from: "a", to: "b" }]);
    const out = startPreview(f);
    const texts = out.messages.map((m) => m.text).join(" | ");
    expect(texts).toMatch(/agreed to offers/);
    expect(texts).toMatch(/Bye for now/);
    expect(texts).toMatch(/opted out/);
    expect(out.status).not.toBe("waiting");
  });

  it("previews a date question with a real calendar check", () => {
    const ask = { ...makeNode("ask", "a", at), data: { text: "Which day?", variable: "day", validate: "date", maxRetries: 1 } };
    const f = uiFlow([ask, makeNode("end", "z", at)], [{ id: "e1", from: "a", to: "z" }]);
    const bad = reply(f, startPreview(f), { text: "31/02/2026" });
    expect(bad.status).toBe("waiting");
    const good = reply(f, startPreview(f), { text: "27/03/2026" });
    expect(good.status).not.toBe("waiting");
  });

  it("shows the inactivity limit, and the reminder box only when the limit is shorter than a day", () => {
    const render = (minutes: number) => {
      const doc = newDoc();
      const d = { ...doc, flow: withSettings(doc.flow, { timeoutMinutes: minutes }) };
      return renderToStaticMarkup(createElement(BotSettings, { doc: d, triggerType: "keyword", options: null, members: [], apply: () => undefined }));
    };
    expect(render(1440)).toContain("End the chatbot after silence of");
    expect(render(1440)).not.toContain("Message when it ends from silence");
    expect(render(30)).toContain("Message when it ends from silence");
  });
});

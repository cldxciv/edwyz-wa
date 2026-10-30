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
const svc = vi.hoisted(() => ({ sendText: vi.fn() }));
// The real central gate: only sendText is stubbed.
vi.mock("@/lib/inbox/service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/inbox/service")>()), sendText: svc.sendText }));
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queue", () => ({ enqueue }));
const interactive = vi.hoisted(() => ({ sendInteractive: vi.fn() }));
vi.mock("@/lib/inbox/interactive", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/inbox/interactive")>()), sendInteractive: interactive.sendInteractive }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/billing", () => ({ getBillingStatus: async () => ({ canWrite: true }), assertWithinLimit: async () => undefined, assertTenantCanWrite: async () => undefined }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: async () => undefined }));
vi.mock("@/lib/chatbots/human-reply", () => ({ stopBotsOnHumanReply: async () => undefined }));
vi.mock("@/lib/chatbots/http", () => ({ callWebhook: vi.fn() }));

import { handleInboundForChatbots } from "@/lib/chatbots";
import { resetChatbotSeams } from "@/lib/chatbots/seams";

/*
 * Chatbot "send template" node through the real central gate (sendTemplateMessage). The node pre-checks the category with an exact
 * "MARKETING" comparison; a template stored as "marketing" slips past that check, so only the gate can refuse the contact who has
 * not opted in. Nothing may be queued (the bot carries on with its next node, as for any template error).
 */
const T = "t1";
const node = (id: string, type: string, data: Row = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (from: string, to: string, label?: string) => ({ id: `${from}-${to}-${label ?? ""}`, from, to, ...(label ? { label } : {}) });
const flow = (nodes: Row[], edges: Row[]) => ({ version: 1, start: nodes[0].id, nodes, edges });
const inbound = (text: string) => ({ tenantId: T, phoneNumberId: "pn1", conversationId: "c1", contactId: "k1", text, receivedAt: new Date() });
const tpl = (category: string) => ({ id: "tp1", tenantId: T, wabaRefId: "w1", name: "promo", language: "en", status: "approved", category, components: [{ type: "BODY", text: "Hello" }] });

function addBot() {
  const f = flow([node("a", "send_template", { templateId: "tp1", variables: {} }), node("ok", "send_text", { text: "after" }), node("bad", "send_text", { text: "failed" })], [edge("a", "ok")]);
  store.chatbots.push({ id: "bot1", tenantId: T, phoneNumberId: null, status: "published", triggerType: "keyword", triggerKeywords: ["hi"], publishedFlow: f, flow: f, createdAt: new Date(store.clock++) });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChatbotSeams();
  store.sessions = [];
  store.chatbots = [];
  store.messages = [];
  store.templates = [];
  store.notes = [];
  store.teams = [];
  store.teamMembers = [];
  store.clock = 0;
  store.contacts = [{ id: "k1", tenantId: T, phone: "+911111111111", name: "Asha", attributes: {}, tags: [], optedOutAt: null, optIn: false }];
  store.conversations = [{ id: "c1", tenantId: T, phoneNumberId: "pn1", contactId: "k1", status: "open", phoneNumber: { wabaRefId: "w1" }, tags: [], assignedToId: null, lastInboundAt: new Date() }];
  Object.assign(db, {
    chatbotSession: model(() => store.sessions, () => ({ variables: {}, waitingNodeId: null, wakeAt: null, endedAt: null, startedAt: new Date(Date.now() - 1000) })),
    chatbot: model(() => store.chatbots),
    contact: model(() => store.contacts),
    conversation: { ...model(() => store.conversations), upsert: vi.fn() },
    message: model(() => store.messages),
    template: model(() => store.templates),
    phoneNumber: model(() => [{ id: "pn1", tenantId: T, wabaRefId: "w1" }]),
    usageLedger: model(() => []),
    note: model(() => store.notes),
    team: model(() => store.teams),
    teamMember: model(() => store.teamMembers),
    membership: model(() => []),
    agentAvailability: { upsert: vi.fn(async () => ({})) },
    tenant: { findUnique: vi.fn(async () => ({ status: "active", deletedAt: null })) },
  });
  svc.sendText.mockResolvedValue({});
  interactive.sendInteractive.mockResolvedValue({});
});

describe("path: chatbot send-template node", () => {
  it("a template stored as lower-case marketing is refused by the gate for a contact who has not opted in", async () => {
    store.templates = [tpl("marketing")];
    addBot();
    await handleInboundForChatbots(inbound("hi"));
    expect(db.message.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("the same template goes out once the contact has opted in", async () => {
    store.templates = [tpl("marketing")];
    store.contacts[0].optIn = true;
    (db.conversation as Record<string, any>).upsert.mockResolvedValue({ id: "c1", lastInboundAt: null });
    db.message.create.mockImplementation(async ({ data }: Row) => ({ id: "m1", ...data }));
    addBot();
    await handleInboundForChatbots(inbound("hi"));
    expect(enqueue).toHaveBeenCalledWith("send", expect.objectContaining({ template: expect.objectContaining({ name: "promo" }) }));
  });
});

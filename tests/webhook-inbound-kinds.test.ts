import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() });
  return { webhookEvent: model(), phoneNumber: model(), contact: model(), conversation: model(), message: model(), auditLog: model(), note: model() };
});
const mods = vi.hoisted(() => ({
  automations: vi.fn(),
  chatbots: vi.fn(),
  ai: vi.fn(),
  assign: vi.fn(),
  reopen: vi.fn(),
  leadsStopped: vi.fn(),
  leadsReplied: vi.fn(),
  emit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/inbox/service", () => ({ sendText: vi.fn() }));
vi.mock("@/lib/inbox/settings", () => ({ getInboxSettings: vi.fn() }));
vi.mock("@/lib/inbox/status", () => ({ reopenOnInbound: mods.reopen }));
vi.mock("@/lib/automation/engine", () => ({ runAutomationsForInbound: mods.automations }));
vi.mock("@/lib/chatbots", () => ({ handleInboundForChatbots: mods.chatbots }));
vi.mock("@/lib/ai-agent", () => ({ handleInboundForAiAgent: mods.ai }));
vi.mock("@/lib/routing", () => ({ assignConversation: mods.assign }));
vi.mock("@/lib/leads", () => ({ onContactOptedOut: mods.leadsStopped, onInboundFromContact: mods.leadsReplied }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: mods.emit }));
vi.mock("@/lib/conversions/referral", () => ({ captureReferral: vi.fn(), parseReferral: () => null }));
vi.mock("@/lib/wiring", () => ({ wireModules: vi.fn() }));

import { NOT_CUSTOMER_MESSAGE_TYPES } from "@/lib/webhooks/payload";
import { inboundKind, processWebhookEvent } from "@/lib/webhooks/processor";

const TS = 1_760_000_000;
const AT = new Date(TS * 1000);
const OLD_PHONE = "+919876543210";
const NEW_WA_ID = "919812345678";
/** The stored contact the sender resolves to (found by phone, nothing to update). */
const CONTACT = { id: "c1", phone: OLD_PHONE, bsuid: null, username: null, waId: "919876543210", name: "Asha", optedOutAt: null };

function receive(message: Record<string, unknown>) {
  const payload = {
    entry: [
      {
        id: "waba1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "meta_phone_1" },
              contacts: [{ wa_id: "919876543210", profile: { name: "Asha" } }],
              messages: [{ from: "919876543210", id: "wamid.in", timestamp: String(TS), ...message }],
            },
          },
        ],
      },
    ],
  };
  db.webhookEvent.findUnique.mockResolvedValue({ id: "e1", payload, processedAt: null });
  return processWebhookEvent("e1");
}

const conversationWrites = () => db.conversation.updateMany.mock.calls.map((c) => c[0]);
const stored = () => db.message.create.mock.calls[0][0].data;

/** Nothing that a customer message sets off: no unread, no timestamps, no reopen, routing, lead stop, bots, AI or rules. */
function expectQuiet() {
  expect(db.conversation.updateMany).not.toHaveBeenCalled();
  expect(mods.reopen).not.toHaveBeenCalled();
  expect(mods.assign).not.toHaveBeenCalled();
  expect(mods.leadsReplied).not.toHaveBeenCalled();
  expect(mods.chatbots).not.toHaveBeenCalled();
  expect(mods.ai).not.toHaveBeenCalled();
  expect(mods.automations).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  db.phoneNumber.findUnique.mockResolvedValue({ id: "ph_row", tenantId: "t1" });
  db.message.findUnique.mockResolvedValue(null);
  db.message.findFirst.mockResolvedValue(null);
  db.contact.findFirst.mockImplementation(async ({ where }: { where: { phone?: string } }) => (where.phone === OLD_PHONE ? CONTACT : null));
  db.conversation.upsert.mockResolvedValue({ id: "cv1", status: "open", assignedToId: null });
  db.conversation.updateMany.mockResolvedValue({ count: 1 });
  db.message.create.mockResolvedValue({ id: "m1" });
  db.contact.updateMany.mockResolvedValue({ count: 1 });
  mods.reopen.mockResolvedValue(false);
  mods.chatbots.mockResolvedValue(false);
  mods.ai.mockResolvedValue(false);
  mods.assign.mockResolvedValue(undefined);
  mods.leadsReplied.mockResolvedValue(undefined);
  mods.automations.mockResolvedValue({ replied: false });
  mods.emit.mockResolvedValue(undefined);
});

describe("inboundKind", () => {
  it("sorts reactions and system notices away from customer messages", () => {
    expect(inboundKind("reaction")).toBe("reaction");
    expect(inboundKind("system")).toBe("notice");
    for (const type of ["text", "image", "order", "contacts", "unsupported", "interactive"]) expect(inboundKind(type)).toBe("message");
  });

  it("uses the same list that bots, the AI agent and rules leave out of their message counts", () => {
    expect([...NOT_CUSTOMER_MESSAGE_TYPES].sort()).toEqual(["reaction", "system"]);
    for (const type of NOT_CUSTOMER_MESSAGE_TYPES) expect(inboundKind(type)).not.toBe("message");
  });
});

describe("customer messages", () => {
  it("the newest one sets both timestamps to its own time, with the unread count raised on its own", async () => {
    await receive({ type: "text", text: { body: "hello" } });
    // One write under the lastInboundAt guard: an older message handled late changes neither timestamp. lastMessageAt equals
    // lastInboundAt even when an auto-reply was stored in between, so the chat reads as "the customer is waiting".
    expect(conversationWrites()).toEqual([
      { where: { id: "cv1", tenantId: "t1", OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: AT } }] }, data: { lastInboundAt: AT, lastMessageAt: AT } },
      { where: { id: "cv1", tenantId: "t1" }, data: { unreadCount: { increment: 1 } } },
    ]);
    expect(mods.assign).toHaveBeenCalledWith("t1", "cv1");
    expect(mods.automations).toHaveBeenCalledWith(expect.objectContaining({ text: "hello", messageType: "text" }));
  });

  it("a message handled after an auto-reply leaves the chat waiting, and an older one handled late changes nothing", async () => {
    // The chat row, with updateMany applying the lastInboundAt guard the way the database does.
    const row = { lastInboundAt: new Date(AT.getTime() - 60_000) as Date | null, lastMessageAt: new Date(AT.getTime() + 1500), unreadCount: 0 };
    type Write = { where: { OR?: [unknown, { lastInboundAt: { lt: Date } }] }; data: Record<string, unknown> };
    db.conversation.updateMany.mockImplementation(async ({ where, data }: Write) => {
      if (where.OR && row.lastInboundAt && !(row.lastInboundAt < where.OR[1].lastInboundAt.lt)) return { count: 0 };
      if (data.lastInboundAt) row.lastInboundAt = data.lastInboundAt as Date;
      if (data.lastMessageAt) row.lastMessageAt = data.lastMessageAt as Date;
      if (data.unreadCount) row.unreadCount += 1;
      return { count: 1 };
    });
    // "price?" was sent a second before the welcome reply to "hi" went out, but arrives after it.
    await receive({ type: "text", text: { body: "price?" } });
    expect(row.lastInboundAt).toEqual(AT);
    expect(row.lastMessageAt).toEqual(AT);
    // A retry of an earlier message: neither the 24-hour window nor the list order goes back.
    await receive({ id: "wamid.older", timestamp: String(TS - 30), type: "text", text: { body: "hi" } });
    expect(row.lastInboundAt).toEqual(AT);
    expect(row.lastMessageAt).toEqual(AT);
  });

  it("a new chat starts at the message's own time, so it reads as waiting for the business", async () => {
    await receive({ type: "text", text: { body: "hi, is this open?" } });
    expect(db.conversation.upsert).toHaveBeenCalledWith({
      where: { phoneNumberId_contactId: { phoneNumberId: "ph_row", contactId: "c1" } },
      create: { tenantId: "t1", phoneNumberId: "ph_row", contactId: "c1", lastMessageAt: AT },
      update: {},
    });
  });

  it("in a blocked chat are stored quietly: no unread count and no jump to the top of the list", async () => {
    db.conversation.upsert.mockResolvedValue({ id: "cv1", status: "blocked", assignedToId: null });
    await receive({ type: "text", text: { body: "spam again" } });
    expect(stored()).toMatchObject({ body: "spam again", direction: "inbound" });
    expect(conversationWrites()).toEqual([{ where: { id: "cv1", tenantId: "t1", OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: AT } }] }, data: { lastInboundAt: AT } }]);
  });

  it("an unsupported message reaches the team but never starts a rule", async () => {
    await receive({ type: "unsupported", errors: [{ code: 131051 }] });
    expect(stored()).toMatchObject({ type: "unsupported", body: "[unsupported]" });
    expect(conversationWrites()).toContainEqual({ where: { id: "cv1", tenantId: "t1" }, data: { unreadCount: { increment: 1 } } });
    expect(mods.assign).toHaveBeenCalled();
    expect(mods.automations).not.toHaveBeenCalled();
  });

  it("an order keeps its items in the chat and in message.received", async () => {
    await receive({ type: "order", order: { catalog_id: "cat1", product_items: [{ product_retailer_id: "SKU-1", quantity: 2, item_price: 499, currency: "INR" }] } });
    expect(stored().body).toBe("[order] 2 items, total 998 INR\n2 x SKU-1 at 499 INR");
    const [, event, payload] = mods.emit.mock.calls.find((c) => c[1] === "message.received")!;
    expect(event).toBe("message.received");
    expect(payload.message).toMatchObject({
      type: "order",
      text: stored().body,
      order: { catalogId: "cat1", total: 998, currency: "INR", items: [{ productRetailerId: "SKU-1", quantity: 2, itemPrice: 499, currency: "INR" }] },
    });
    expect(mods.automations).toHaveBeenCalledWith(expect.objectContaining({ text: "", messageType: "order" }));
  });

  it("a shared contact card keeps the name and number", async () => {
    await receive({ type: "contacts", contacts: [{ name: { formatted_name: "Ravi Kumar" }, phones: [{ phone: "+91 99999 11111", wa_id: "919999911111", type: "CELL" }] }] });
    expect(stored().body).toBe("[contacts] Ravi Kumar: +91 99999 11111");
    const payload = mods.emit.mock.calls.find((c) => c[1] === "message.received")![2];
    expect(payload.message.contacts).toEqual([{ name: "Ravi Kumar", phones: [{ phone: "+91 99999 11111", waId: "919999911111", type: "CELL" }] }]);
  });
});

describe("reactions", () => {
  it("are stored with the message they are on and set nothing else off", async () => {
    db.message.findFirst.mockResolvedValue({ body: "Your order is on its way" });
    await receive({ type: "reaction", reaction: { message_id: "wamid.out1", emoji: "\u{1F44D}" } });
    expect(db.message.findFirst).toHaveBeenCalledWith({ where: { tenantId: "t1", wamid: "wamid.out1" }, select: { body: true } });
    expect(stored()).toMatchObject({ type: "reaction", body: "[reaction] \u{1F44D} to \"Your order is on its way\"", status: "received" });
    expectQuiet();
    const payload = mods.emit.mock.calls.find((c) => c[1] === "message.received")![2];
    expect(payload.message.reaction).toEqual({ emoji: "\u{1F44D}", messageId: "wamid.out1" });
  });

  it("an emoji outside working hours or after a quiet spell gets no away or welcome reply", async () => {
    await receive({ type: "reaction", reaction: { message_id: "wamid.unknown", emoji: "❤️" } });
    expect(stored().body).toBe("[reaction] ❤️");
    expect(mods.automations).not.toHaveBeenCalled();
  });

  it("a removed reaction says so and shortens a long quote", async () => {
    db.message.findFirst.mockResolvedValue({ body: `Thanks for your order. ${"a".repeat(100)}` });
    await receive({ type: "reaction", reaction: { message_id: "wamid.out1" } });
    const body = stored().body as string;
    expect(body.startsWith("[reaction removed] from \"Thanks for your order.")).toBe(true);
    expect(body.endsWith("...\"")).toBe(true);
    expect(body.length).toBeLessThan(100);
  });

  it("a failed look-up of the reacted message still stores the reaction", async () => {
    db.message.findFirst.mockRejectedValue(new Error("db down"));
    await receive({ type: "reaction", reaction: { message_id: "wamid.out1", emoji: "\u{1F44D}" } });
    expect(stored().body).toBe("[reaction] \u{1F44D}");
  });
});

describe("system notices", () => {
  const changedNumber = (system: Record<string, unknown> = {}) => receive({ type: "system", system: { body: "Asha changed from 919876543210 to 919812345678", wa_id: NEW_WA_ID, type: "user_changed_number", ...system } });

  it("a changed number moves the contact to the new number and leaves a note without any number in it", async () => {
    await changedNumber();
    expect(stored()).toMatchObject({ type: "system", body: "[number changed]" });
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { phone: `+${NEW_WA_ID}`, waId: NEW_WA_ID } });
    const note = db.note.create.mock.calls[0][0].data;
    expect(note).toMatchObject({ tenantId: "t1", conversationId: "cv1", authorId: "system" });
    expect(note.body).toContain("now has the new number");
    expect(note.body).not.toMatch(/\d{6}/);
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: { tenantId: "t1", action: "contact.number_changed", target: "c1", meta: { linked: true } } });
    expectQuiet();
  });

  it("reads the older new_wa_id field and the customer_changed_number type too", async () => {
    await receive({ type: "system", system: { type: "customer_changed_number", new_wa_id: NEW_WA_ID } });
    expect(db.contact.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { phone: `+${NEW_WA_ID}`, waId: NEW_WA_ID } }));
  });

  it("never combines two contacts when the new number already belongs to another one", async () => {
    db.contact.findFirst.mockImplementation(async ({ where }: { where: { phone?: string } }) => (where.phone === OLD_PHONE ? CONTACT : where.phone === `+${NEW_WA_ID}` ? { id: "c2" } : null));
    await changedNumber();
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(db.note.create.mock.calls[0][0].data.body).toContain("not combined");
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ meta: { linked: false } }) }));
  });

  it("treats a number taken at the same moment (unique clash) the same way", async () => {
    db.contact.updateMany.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    await changedNumber();
    expect(db.note.create.mock.calls[0][0].data.body).toContain("not combined");
  });

  it("a failure while moving the contact never fails the webhook", async () => {
    db.contact.updateMany.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(changedNumber()).resolves.toMatchObject({ handled: 1 });
    spy.mockRestore();
    expect(db.note.create).not.toHaveBeenCalled();
  });

  it("a security code change is only stored", async () => {
    await receive({ type: "system", system: { type: "customer_identity_changed", identity: "abc" } });
    expect(stored()).toMatchObject({ type: "system", body: "[security code changed]" });
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(db.note.create).not.toHaveBeenCalled();
    expectQuiet();
  });
});

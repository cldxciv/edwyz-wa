import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const store = vi.hoisted(() => ({ contacts: [] as Record<string, any>[], conversations: [] as Record<string, any>[] }));

const db = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  });
  const tables = {
    webhookEvent: model(),
    phoneNumber: model(),
    waba: model(),
    contact: model(),
    conversation: model(),
    message: model(),
    note: model(),
    template: model(),
    broadcastRecipient: model(),
    auditLog: model(),
    chatbotSession: model(),
    ruleExecution: model(),
    automationRun: model(),
    conversationMark: model(),
    lead: model(),
    conversionEvent: model(),
    abandonedCart: model(),
    $transaction: undefined as unknown as (fn: (tx: unknown) => unknown) => unknown,
  };
  tables.$transaction = (fn) => fn(tables);
  return tables;
});
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/automation/engine", () => ({ runAutomationsForInbound: vi.fn().mockResolvedValue({ replied: false }) }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));

import { emitEvent } from "@/lib/integrations/events";
import { mergeAttributes, mergeConsent, resolveInboundContact } from "@/lib/contacts/resolve";
import { handleStatus, processWebhookEvent } from "@/lib/webhooks/processor";

const BSUID = "IN.13491208655302741918";
const PHONE = "+919876543210";

const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([k, v]) => (v && typeof v === "object" && !(v instanceof Date) ? true : row[k] === v));

function seed(contacts: Row[]) {
  store.contacts = contacts.map((c) => ({ tenantId: "t1", name: null, phone: null, bsuid: null, username: null, waId: null, tags: [], attributes: {}, optIn: false, optInAt: null, optInSource: null, optedOutAt: null, ownerUserId: null, leadStage: null, ...c }));
  db.contact.findFirst.mockImplementation(async ({ where }: { where: Row }) => store.contacts.find((c) => matches(c, where)) ?? null);
  db.contact.create.mockImplementation(async ({ data }: { data: Row }) => {
    const row = { id: `new${store.contacts.length}`, tags: [], attributes: {}, optIn: false, optedOutAt: null, ...data };
    store.contacts.push(row);
    return row;
  });
  db.contact.update.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
    const row = store.contacts.find((c) => c.id === where.id) as Row;
    Object.assign(row, data);
    return row;
  });
  db.contact.deleteMany.mockImplementation(async ({ where }: { where: Row }) => {
    store.contacts = store.contacts.filter((c) => c.id !== where.id);
    return { count: 1 };
  });
}

function payload(value: Record<string, unknown>) {
  return { object: "whatsapp_business_account", entry: [{ id: "waba1", changes: [{ field: "messages", value }] }] };
}
const load = (p: unknown) => db.webhookEvent.findUnique.mockResolvedValue({ id: "e1", payload: p, processedAt: null });
const metadata = { phone_number_id: "meta_phone_1" };

beforeEach(() => {
  vi.clearAllMocks();
  store.conversations = [];
  db.phoneNumber.findUnique.mockResolvedValue({ id: "ph_row", tenantId: "t1" });
  db.message.findUnique.mockResolvedValue(null);
  db.message.create.mockResolvedValue({ id: "m1" });
  db.conversation.upsert.mockResolvedValue({ id: "cv1", assignedToId: null });
  db.conversation.findMany.mockResolvedValue([]);
  db.conversation.findFirst.mockResolvedValue(null);
  for (const m of [db.broadcastRecipient, db.lead, db.conversionEvent, db.abandonedCart, db.chatbotSession, db.ruleExecution, db.automationRun, db.note, db.message, db.conversation]) {
    m.updateMany.mockResolvedValue({ count: 0 });
    m.deleteMany.mockResolvedValue({ count: 0 });
  }
  db.broadcastRecipient.findMany.mockResolvedValue([]);
  db.conversationMark.findMany.mockResolvedValue([]);
  seed([]);
});

describe("an inbound message from a person with a WhatsApp username and no phone number", () => {
  const usernameOnly = (extra: Record<string, unknown> = {}) =>
    payload({
      metadata,
      contacts: [{ user_id: BSUID, profile: { name: "Asha", username: "@asha.bakes" } }],
      messages: [{ from_user_id: BSUID, id: "wamid.u1", timestamp: "1760000000", type: "text", text: { body: "hello" }, ...extra }],
    });

  it("is stored, not dropped: the contact is created by BSUID with a null phone and the username", async () => {
    load(usernameOnly());
    await processWebhookEvent("e1");

    expect(db.contact.findFirst).toHaveBeenCalledWith({ where: { tenantId: "t1", bsuid: BSUID } });
    expect(db.contact.create).toHaveBeenCalledWith({ data: { tenantId: "t1", phone: null, bsuid: BSUID, username: "asha.bakes", waId: null, name: "Asha" } });
    expect(db.conversation.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { phoneNumberId_contactId: { phoneNumberId: "ph_row", contactId: "new0" } } }));
    expect(db.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: "t1", conversationId: "cv1", wamid: "wamid.u1", direction: "inbound", body: "hello" }) }));
  });

  it("puts bsuid, username and a null phone on the message.received event", async () => {
    load(usernameOnly());
    await processWebhookEvent("e1");
    const call = vi.mocked(emitEvent).mock.calls.find((c) => c[1] === "message.received");
    expect(call?.[2]).toMatchObject({ contact: { phone: null, bsuid: BSUID, username: "asha.bakes", waId: null, name: "Asha" } });
  });

  it("re-links the same person on their next message by BSUID instead of creating a second contact", async () => {
    load(usernameOnly());
    await processWebhookEvent("e1");
    load(usernameOnly({ id: "wamid.u2" }));
    await processWebhookEvent("e1");
    expect(db.contact.create).toHaveBeenCalledTimes(1);
    expect(store.contacts).toHaveLength(1);
  });

  it("accepts the BSUID under other documented field names (user_id on the message, bsuid in contacts)", async () => {
    load(payload({ metadata, contacts: [{ bsuid: BSUID, profile: { name: "Asha" } }], messages: [{ user_id: BSUID, id: "wamid.u3", timestamp: "1760000000", type: "text", text: { body: "hi" } }] }));
    await processWebhookEvent("e1");
    expect(db.contact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ bsuid: BSUID, phone: null }) });
    expect(db.message.create).toHaveBeenCalled();
  });

  it("still drops a message that names nobody at all, without failing the batch", async () => {
    load(payload({ metadata, messages: [{ id: "wamid.none", timestamp: "1760000000", type: "text", text: { body: "?" } }] }));
    await expect(processWebhookEvent("e1")).resolves.toMatchObject({ handled: 1 });
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(db.message.create).not.toHaveBeenCalled();
  });

  it("honours STOP from a BSUID-only contact", async () => {
    load(usernameOnly({ text: { body: "STOP" } }));
    await processWebhookEvent("e1");
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "new0", tenantId: "t1" }, data: { optedOutAt: expect.any(Date), optIn: false } });
    const call = vi.mocked(emitEvent).mock.calls.find((c) => c[1] === "contact.opted_out");
    expect(call?.[2]).toMatchObject({ contact: { phone: null, bsuid: BSUID }, phone: null });
  });
});

describe("a phone number arrives for someone first known by BSUID", () => {
  it("adds the phone and wa_id to the same contact when no other contact has that phone", async () => {
    seed([{ id: "cb", bsuid: BSUID, username: "asha", name: "Asha" }]);
    const contact = await resolveInboundContact("t1", { phone: PHONE, bsuid: BSUID, username: null, waId: "919876543210", name: null });
    expect(contact?.id).toBe("cb");
    expect(db.contact.update).toHaveBeenCalledWith({ where: { id: "cb" }, data: { waId: "919876543210", phone: PHONE } });
    expect(db.contact.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps the first-seen phone when a different one shows up later", async () => {
    seed([{ id: "cb", bsuid: BSUID, phone: PHONE, waId: "919876543210" }]);
    await resolveInboundContact("t1", { phone: "+14155550100", bsuid: BSUID, username: null, waId: "14155550100", name: null });
    const patch = db.contact.update.mock.calls[0]?.[0]?.data ?? {};
    expect(patch.phone).toBeUndefined();
    expect(patch.waId).toBeUndefined();
  });

  it("merges a BSUID-only contact into the phone contact in one transaction, moving everything it owns", async () => {
    seed([
      { id: "cp", phone: PHONE, name: "Asha Rao", tags: ["vip"], attributes: { city: "Pune", plan: "pro" }, optIn: true, optInAt: new Date("2026-01-01"), optInSource: "form", ownerUserId: "u9" },
      { id: "cb", bsuid: BSUID, username: "asha", name: "asha b", tags: ["new", "vip"], attributes: { city: "Delhi", note: "x" } },
    ]);
    db.conversation.findMany.mockResolvedValue([{ id: "cvB", phoneNumberId: "ph1", tags: [], unreadCount: 2, lastMessageAt: new Date(), status: "open" }]);
    db.conversation.findFirst.mockResolvedValue(null);
    db.broadcastRecipient.findMany.mockResolvedValue([{ broadcastId: "b1" }]);
    const txSpy = vi.spyOn(db, "$transaction");

    const merged = await resolveInboundContact("t1", { phone: PHONE, bsuid: BSUID, username: "asha", waId: "919876543210", name: "Asha" });

    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(merged?.id).toBe("cp");
    expect(store.contacts.map((c) => c.id)).toEqual(["cp"]);
    expect(merged).toMatchObject({
      phone: PHONE,
      bsuid: BSUID,
      username: "asha",
      waId: "919876543210",
      name: "Asha",
      ownerUserId: "u9",
      optIn: true,
    });
    expect([...(merged?.tags ?? [])].sort()).toEqual(["new", "vip"]);
    expect(merged?.attributes).toMatchObject({ city: "Pune", plan: "pro", note: "x" });
    // The conversation that only the BSUID contact had now belongs to the phone contact.
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "cvB", tenantId: "t1" }, data: { contactId: "cp" } });
    // Broadcast rows the phone contact already has are dropped, the rest move over.
    expect(db.broadcastRecipient.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", contactId: "cb", broadcastId: { in: ["b1"] } } });
    expect(db.broadcastRecipient.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", contactId: "cb" }, data: { contactId: "cp" } });
    for (const model of [db.lead, db.conversionEvent, db.abandonedCart, db.chatbotSession, db.ruleExecution]) {
      expect(model.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", contactId: "cb" }, data: { contactId: "cp" } });
    }
    // The BSUID contact is removed before its BSUID is written to the survivor, so the unique key never collides.
    const order = [db.contact.deleteMany.mock.invocationCallOrder[0], db.contact.update.mock.invocationCallOrder[0]];
    expect(order[0]).toBeLessThan(order[1]);
  });

  it("folds two chats on the same business number into one: messages, notes and counters move to the phone contact's chat", async () => {
    seed([
      { id: "cp", phone: PHONE },
      { id: "cb", bsuid: BSUID },
    ]);
    const older = new Date("2026-01-01");
    const newer = new Date("2026-02-01");
    db.conversation.findMany.mockResolvedValue([{ id: "cvB", phoneNumberId: "ph1", tags: ["a"], unreadCount: 2, lastMessageAt: newer, lastInboundAt: newer, status: "open", assignedToId: null, firstAgentReplyAt: null, lastAgentReplyAt: null, referral: null, teamId: null }]);
    db.conversation.findFirst.mockResolvedValue({ id: "cvP", phoneNumberId: "ph1", tags: ["b"], unreadCount: 1, lastMessageAt: older, lastInboundAt: older, status: "solved", assignedToId: "u2", firstAgentReplyAt: null, lastAgentReplyAt: null, referral: null, teamId: null });
    db.conversationMark.findMany.mockResolvedValueOnce([{ userId: "u1", kind: "favorite" }]).mockResolvedValueOnce([{ id: "mk1", userId: "u1", kind: "favorite" }, { id: "mk2", userId: "u1", kind: "unread" }]);

    await resolveInboundContact("t1", { phone: PHONE, bsuid: BSUID, username: null, waId: "919876543210", name: null });

    expect(db.message.updateMany).toHaveBeenCalledWith({ where: { conversationId: "cvB", tenantId: "t1" }, data: { conversationId: "cvP" } });
    expect(db.note.updateMany).toHaveBeenCalledWith({ where: { conversationId: "cvB", tenantId: "t1" }, data: { conversationId: "cvP" } });
    expect(db.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "cvP", tenantId: "t1" },
      data: expect.objectContaining({ tags: ["b", "a"], unreadCount: 3, lastMessageAt: newer, lastInboundAt: newer, assignedToId: "u2", status: "open" }),
    });
    expect(db.conversation.deleteMany).toHaveBeenCalledWith({ where: { id: "cvB", tenantId: "t1" } });
    expect(db.conversationMark.deleteMany).toHaveBeenCalledWith({ where: { id: "mk1" } });
    expect(db.conversationMark.updateMany).toHaveBeenCalledWith({ where: { id: "mk2" }, data: { conversationId: "cvP" } });
  });

  it("remembers the previous BSUID when a phone contact is re-linked to a new one", async () => {
    seed([{ id: "cp", phone: PHONE, bsuid: "IN.OLD111", attributes: { city: "Pune" } }]);
    await resolveInboundContact("t1", { phone: PHONE, bsuid: BSUID, username: null, waId: null, name: null });
    const patch = db.contact.update.mock.calls[0][0].data;
    expect(patch.bsuid).toBe(BSUID);
    expect(patch.attributes).toEqual({ city: "Pune", previous_bsuids: ["IN.OLD111"] });
  });

  it("retries once when two messages race to create the same contact", async () => {
    seed([]);
    db.contact.create
      .mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }))
      .mockImplementationOnce(async ({ data }: { data: Row }) => ({ id: "late", ...data }));
    db.contact.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "winner", bsuid: BSUID, phone: null });
    const contact = await resolveInboundContact("t1", { phone: null, bsuid: BSUID, username: null, waId: null, name: null });
    expect(contact?.id).toBe("winner");
  });

  it("refuses to invent a contact when the payload had no identifier", async () => {
    expect(await resolveInboundContact("t1", { phone: null, bsuid: null, username: null, waId: null, name: "x" })).toBeNull();
  });
});

describe("merging consent and attributes", () => {
  it("keeps a STOP that is newer than the other record's opt-in, and an opt-in that is newer than the STOP", () => {
    const stopped = { optIn: false, optInAt: null, optInSource: null, optedOutAt: new Date("2026-03-01") };
    const optedIn = { optIn: true, optInAt: new Date("2026-02-01"), optInSource: "form", optedOutAt: null };
    expect(mergeConsent(stopped, optedIn)).toMatchObject({ optIn: false, optedOutAt: new Date("2026-03-01") });
    const later = { ...optedIn, optInAt: new Date("2026-04-01") };
    expect(mergeConsent(stopped, later)).toMatchObject({ optIn: true, optedOutAt: null, optInSource: "form" });
  });

  it("lets existing attribute values win and fills the gaps from the other record", () => {
    expect(mergeAttributes({ a: 1 }, { a: 2, b: 3 })).toEqual({ a: 1, b: 3 });
    expect(mergeAttributes(null, { b: 3 })).toEqual({ b: 3 });
  });
});

describe("delivery statuses that name the recipient by BSUID", () => {
  const status = (extra: Record<string, unknown> = {}) => ({ id: "wamid.out1", status: "delivered", timestamp: "1760000000", ...extra });

  beforeEach(() => {
    db.message.updateMany.mockResolvedValue({ count: 1 });
    db.broadcastRecipient.updateMany.mockResolvedValue({ count: 0 });
  });

  it("learns the BSUID for a phone-only contact from recipient_user_id", async () => {
    seed([{ id: "cp", phone: PHONE }]);
    db.message.findFirst.mockResolvedValue({ id: "m9", status: "sent", statusTimeline: [], conversationId: "cv1", direction: "outbound", conversation: { contact: { id: "cp", phone: PHONE, bsuid: null, username: null, name: null } } });
    await handleStatus("t1", status({ recipient_id: "919876543210", recipient_user_id: BSUID }));
    expect(db.contact.update).toHaveBeenCalledWith({ where: { id: "cp" }, data: { waId: "919876543210", bsuid: BSUID } });
  });

  it("learns the phone for a BSUID-only contact when the status carries recipient_id", async () => {
    seed([{ id: "cb", bsuid: BSUID }]);
    db.message.findFirst.mockResolvedValue({ id: "m9", status: "sent", statusTimeline: [], conversationId: "cv1", direction: "outbound", conversation: { contact: { id: "cb", phone: null, bsuid: BSUID, username: null, name: null } } });
    await handleStatus("t1", status({ recipient_id: "919876543210", recipient_user_id: BSUID }));
    expect(db.contact.update).toHaveBeenCalledWith({ where: { id: "cb" }, data: { waId: "919876543210", phone: PHONE } });
  });

  it("does nothing extra when the contact already has both identifiers", async () => {
    seed([{ id: "cp", phone: PHONE, bsuid: BSUID }]);
    db.message.findFirst.mockResolvedValue({ id: "m9", status: "sent", statusTimeline: [], conversationId: "cv1", direction: "outbound", conversation: { contact: { id: "cp", phone: PHONE, bsuid: BSUID, username: null, name: null } } });
    await handleStatus("t1", status({ recipient_id: "919876543210", recipient_user_id: BSUID }));
    expect(db.contact.update).not.toHaveBeenCalled();
  });

  it("carries bsuid on the message.status event even when the status has no phone", async () => {
    seed([{ id: "cb", bsuid: BSUID }]);
    db.message.findFirst.mockResolvedValue({ id: "m9", status: "sent", statusTimeline: [], conversationId: "cv1", direction: "outbound", conversation: { contact: { id: "cb", phone: null, bsuid: BSUID, waId: null, username: "asha", name: null } } });
    await handleStatus("t1", status({ recipient_user_id: BSUID }));
    const call = vi.mocked(emitEvent).mock.calls.find((c) => c[1] === "message.status");
    expect(call?.[2]).toMatchObject({ contact: { id: "cb", phone: null, bsuid: BSUID, username: "asha" } });
  });
});

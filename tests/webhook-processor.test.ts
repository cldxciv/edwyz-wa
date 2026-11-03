import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  });
  return {
    webhookEvent: model(),
    phoneNumber: model(),
    waba: model(),
    contact: model(),
    conversation: model(),
    message: model(),
    template: model(),
    broadcastRecipient: model(),
    auditLog: model(),
    platformSetting: model(),
  };
});
const signals = vi.hoisted(() => ({ applyAccountUpdate: vi.fn(async () => ({ handled: null })), applyTemplateQuality: vi.fn(async () => undefined) }));
const reestimate = vi.hoisted(() => vi.fn(async () => ({ reestimated: 1, paused: 0 })));
const pauseForTemplate = vi.hoisted(() => vi.fn(async () => 1));
const ownerReply = vi.hoisted(() => vi.fn(async () => ({ handled: true, action: "declined" })));
const ownerKeyword = vi.hoisted(() => vi.fn(async () => ({ changed: 1 })));
const graphFetch = vi.hoisted(() => vi.fn());
const automations = vi.hoisted(() => vi.fn().mockResolvedValue({ replied: false }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/automation/engine", () => ({ runAutomationsForInbound: automations }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/spend/messaging/quality", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/spend/messaging/quality")>()), ...signals }));
vi.mock("@/lib/broadcasts/process", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/broadcasts/process")>()), reestimateBroadcastHolds: reestimate }));
vi.mock("@/lib/broadcasts/blocked", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/broadcasts/blocked")>()), pauseBroadcastsForTemplate: pauseForTemplate }));
vi.mock("@/lib/spend/notify/inbound", () => ({ handleOwnerReply: ownerReply, handleOwnerKeyword: ownerKeyword }));
vi.mock("@/lib/graph", () => ({ graphFetch }));

import { emitEvent } from "@/lib/integrations/events";
import { mapMetaStatus } from "@/lib/templates/status";
import { describeMessage } from "@/lib/webhooks/payload";
import { ownerReplyPayload, processWebhookEvent, resetNotifierCache } from "@/lib/webhooks/processor";

const PHONE = { id: "ph_row", tenantId: "t1" };

function messagesPayload(value: Record<string, unknown>, wabaId = "waba1") {
  return { object: "whatsapp_business_account", entry: [{ id: wabaId, changes: [{ field: "messages", value }] }] };
}
const inboundValue = (msg: Record<string, unknown>, phoneId = "meta_phone_1") => ({
  metadata: { phone_number_id: phoneId },
  contacts: [{ wa_id: "919876543210", profile: { name: "Asha" } }],
  messages: [{ from: "919876543210", id: "wamid.1", timestamp: "1760000000", type: "text", text: { body: "hello" }, ...msg }],
});

function loadEvent(payload: unknown) {
  db.webhookEvent.findUnique.mockResolvedValue({ id: "e1", payload, processedAt: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.phoneNumber.findUnique.mockResolvedValue(PHONE);
  db.message.findUnique.mockResolvedValue(null);
  db.contact.findFirst.mockResolvedValue(null);
  db.contact.create.mockResolvedValue({ id: "c1" });
  db.conversation.upsert.mockResolvedValue({ id: "cv1" });
  db.message.create.mockResolvedValue({ id: "m1" });
});

describe("routing by phone_number_id", () => {
  it("looks the tenant up from the metadata phone_number_id and scopes all writes to it", async () => {
    loadEvent(messagesPayload(inboundValue({})));
    await processWebhookEvent("e1");

    expect(db.phoneNumber.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { phoneNumberId: "meta_phone_1" } }));
    expect(db.contact.findFirst).toHaveBeenCalledWith({ where: { tenantId: "t1", phone: "+919876543210" } });
    expect(db.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: "t1", phone: "+919876543210", name: "Asha", waId: "919876543210", bsuid: null }),
    });
    expect(db.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phoneNumberId_contactId: { phoneNumberId: "ph_row", contactId: "c1" } } }),
    );
    expect(db.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId: "t1", conversationId: "cv1", wamid: "wamid.1", direction: "inbound", body: "hello" }) }),
    );
    expect(db.conversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cv1", tenantId: "t1" }, data: expect.objectContaining({ unreadCount: { increment: 1 } }) }),
    );
    expect(db.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId: "t1", phoneNumberId: "meta_phone_1", processedAt: expect.any(Date) }) }),
    );
  });

  it("marks an event for an unknown number processed with a note and creates no tenant data", async () => {
    db.phoneNumber.findUnique.mockResolvedValue(null);
    loadEvent(messagesPayload(inboundValue({}, "unknown")));
    const result = await processWebhookEvent("e1");

    expect(result.notes[0]).toContain("unknown phone_number_id");
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(db.message.create).not.toHaveBeenCalled();
    expect(db.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.any(Date), error: expect.stringContaining("unknown") }) }),
    );
  });

  it("skips events that were already processed", async () => {
    db.webhookEvent.findUnique.mockResolvedValue({ id: "e1", payload: {}, processedAt: new Date() });
    await processWebhookEvent("e1");
    expect(db.webhookEvent.update).not.toHaveBeenCalled();
  });
});

describe("inbound message idempotency", () => {
  it("does nothing when the wamid already exists", async () => {
    db.message.findUnique.mockResolvedValue({ id: "existing" });
    loadEvent(messagesPayload(inboundValue({})));
    await processWebhookEvent("e1");
    expect(db.message.create).not.toHaveBeenCalled();
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("does not increment unread when a concurrent insert hits the unique constraint", async () => {
    db.message.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    loadEvent(messagesPayload(inboundValue({})));
    await processWebhookEvent("e1");
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
  });
});

describe("message types", () => {
  it("stores readable bodies and media references", () => {
    expect(describeMessage({ type: "image", image: { id: "mid1", mime_type: "image/jpeg", caption: "look" } })).toEqual({
      type: "image",
      body: "[image] look",
      mediaId: "mid1",
      mediaMime: "image/jpeg",
    });
    expect(describeMessage({ type: "document", document: { id: "d1", filename: "a.pdf", mime_type: "application/pdf" } }).body).toBe("[document: a.pdf]");
    expect(describeMessage({ type: "location", location: { latitude: 1, longitude: 2, name: "Shop" } }).body).toBe("[location] 1,2 Shop");
    expect(describeMessage({ type: "button", button: { text: "Yes" } }).body).toBe("Yes");
    expect(describeMessage({ type: "interactive", interactive: { type: "list_reply", list_reply: { title: "Option A" } } }).body).toBe("Option A");
    expect(describeMessage({ type: "audio", audio: { id: "a1", mime_type: "audio/ogg" } }).body).toBe("[audio]");
    expect(describeMessage({ type: "video", video: { id: "v1" } }).body).toBe("[video]");
  });

  it("writes a catalog order out item by item, with the total when every price is in one currency", () => {
    const parsed = describeMessage({
      type: "order",
      order: {
        catalog_id: "cat1",
        text: "Gift wrap please",
        product_items: [
          { product_retailer_id: "SKU-1", quantity: "2", item_price: "499.5", currency: "inr" },
          { product_retailer_id: "SKU-2", quantity: 1, item_price: 100, currency: "INR" },
        ],
      },
    });
    expect(parsed.body).toBe("[order] 3 items, total 1099 INR\n2 x SKU-1 at 499.50 INR\n1 x SKU-2 at 100 INR\nNote: Gift wrap please");
    expect(parsed.order).toEqual({
      catalogId: "cat1",
      text: "Gift wrap please",
      total: 1099,
      currency: "INR",
      items: [
        { productRetailerId: "SKU-1", quantity: 2, itemPrice: 499.5, currency: "INR" },
        { productRetailerId: "SKU-2", quantity: 1, itemPrice: 100, currency: "INR" },
      ],
    });
  });

  it("leaves the total out when prices are missing or in two currencies, and caps a long order", () => {
    expect(describeMessage({ type: "order", order: { product_items: [{ product_retailer_id: "A", quantity: 1 }] } }).body).toBe("[order] 1 item\n1 x A");
    const mixed = describeMessage({ type: "order", order: { product_items: [{ product_retailer_id: "A", quantity: 1, item_price: 1, currency: "INR" }, { product_retailer_id: "B", quantity: 1, item_price: 1, currency: "USD" }] } });
    expect(mixed.order).toMatchObject({ total: null, currency: null });
    expect(mixed.body.split("\n")[0]).toBe("[order] 2 items");
    const items = Array.from({ length: 32 }, (_, i) => ({ product_retailer_id: `S${i}`, quantity: 1, item_price: 1, currency: "INR" }));
    const long = describeMessage({ type: "order", order: { product_items: items } }).body.split("\n");
    expect(long).toHaveLength(32);
    expect(long.at(-1)).toBe("and 2 more products");
    expect(describeMessage({ type: "order", order: {} }).body).toBe("[order] 0 items");
  });

  it("keeps the names and numbers of shared contact cards", () => {
    expect(describeMessage({ type: "contacts", contacts: [{ name: { first_name: "Ravi", last_name: "Kumar" }, phones: [{ wa_id: "919999911111" }] }] })).toEqual({
      type: "contacts",
      body: "[contacts] Ravi Kumar: +919999911111",
      contacts: [{ name: "Ravi Kumar", phones: [{ phone: "+919999911111", waId: "919999911111", type: null }] }],
    });
    const two = describeMessage({ type: "contacts", contacts: [{ name: { formatted_name: "Asha" }, phones: [{ phone: "+91 1" }, { phone: "+91 2" }] }, { phones: [] }] });
    expect(two.body).toBe("[contacts] 2 contacts\nAsha: +91 1, +91 2\nNo name");
    expect(describeMessage({ type: "contacts" }).body).toBe("[contacts]");
  });

  it("marks reactions and removed reactions with the message they are on", () => {
    expect(describeMessage({ type: "reaction", reaction: { message_id: "wamid.out", emoji: "\u{1F44D}" } })).toEqual({ type: "reaction", body: "[reaction] \u{1F44D}", reaction: { emoji: "\u{1F44D}", messageId: "wamid.out" } });
    expect(describeMessage({ type: "reaction", reaction: { message_id: "wamid.out" } })).toEqual({ type: "reaction", body: "[reaction removed]", reaction: { emoji: "", messageId: "wamid.out" } });
  });

  it("reads WhatsApp system notices without copying Meta's text, which carries names and numbers", () => {
    const changed = describeMessage({ type: "system", system: { body: "Asha changed from 919876543210 to 919812345678", wa_id: "919812345678", type: "user_changed_number" } });
    expect(changed).toEqual({ type: "system", body: "[number changed]", system: { event: "number_changed", newWaId: "919812345678" } });
    expect(describeMessage({ type: "system", system: { type: "user_changed_number" } }).system).toEqual({ event: "number_changed", newWaId: null });
    expect(describeMessage({ type: "system", system: { type: "user_identity_changed", identity: "x" } })).toEqual({ type: "system", body: "[security code changed]", system: { event: "identity_changed", newWaId: null } });
    expect(describeMessage({ type: "system", system: { type: "something_new", body: "Private text" } }).body).toBe("[system notice]");
  });

  it("stores media id and mime on the message row", async () => {
    loadEvent(messagesPayload(inboundValue({ type: "image", text: undefined, image: { id: "mid1", mime_type: "image/png" } })));
    await processWebhookEvent("e1");
    expect(db.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "image", mediaUrl: "meta-media:mid1", mediaMime: "image/png" }) }),
    );
  });
});

describe("STOP handling", () => {
  it.each(["STOP", " stop ", "Unsubscribe", "end"])("opts the contact out on %j", async (body) => {
    loadEvent(messagesPayload(inboundValue({ text: { body } })));
    await processWebhookEvent("e1");
    expect(db.contact.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", tenantId: "t1" },
      data: { optedOutAt: expect.any(Date), optIn: false },
    });
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: "t1", action: "contact.opted_out" }) }));
  });

  it.each(["STOP.", "Stop all", "cancel", "Quit", "opt out", "Opt-Out", "OPTOUT", "  End!  "])("also honours %j (normalised)", async (body) => {
    loadEvent(messagesPayload(inboundValue({ text: { body } })));
    await processWebhookEvent("e1");
    expect(db.contact.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each(["cancel my order", "stop please", "STOP sending me messages", "end of the month sale?", "quit smoking tips"])(
    "%j is an ordinary message: only a whole-message STOP word counts (owner default 1)",
    async (body) => {
      loadEvent(messagesPayload(inboundValue({ text: { body } })));
      await processWebhookEvent("e1");
      expect(db.contact.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ optedOutAt: expect.any(Date) }) }));
    },
  );

  it("honours a tap on the template's marketing opt-out button (Stop promotions), but not the same words typed as a sentence", async () => {
    loadEvent(messagesPayload(inboundValue({ type: "button", text: undefined, button: { text: "Stop promotions", payload: "Stop promotions" } })));
    await processWebhookEvent("e1");
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { optedOutAt: expect.any(Date), optIn: false } });
    db.contact.updateMany.mockClear();
    loadEvent(messagesPayload(inboundValue({ text: { body: "stop promotions please, but keep my order updates" } })));
    await processWebhookEvent("e1");
    expect(db.contact.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ optedOutAt: expect.any(Date) }) }));
  });

  it("honours the workspace's own STOP words from Inbox settings, read only for a short message", async () => {
    db.platformSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (where.key === "inbox:settings:t1" ? { value: { stopWords: ["band karo"] } } : null));
    loadEvent(messagesPayload(inboundValue({ text: { body: "Band karo!" } })));
    await processWebhookEvent("e1");
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { optedOutAt: expect.any(Date), optIn: false } });
    db.contact.updateMany.mockClear();
    db.platformSetting.findUnique.mockClear();
    loadEvent(messagesPayload(inboundValue({ text: { body: "please band karo all the messages you send to me every day" } })));
    await processWebhookEvent("e1");
    expect(db.contact.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ optedOutAt: expect.any(Date) }) }));
    expect(db.platformSetting.findUnique.mock.calls.filter((c: unknown[]) => (c[0] as { where: { key: string } }).where.key.startsWith("inbox:settings:"))).toEqual([]);
  });

  it("honours an opt-out written as a button reply or interactive reply", async () => {
    loadEvent(messagesPayload(inboundValue({ type: "button", text: undefined, button: { text: "Stop" } })));
    await processWebhookEvent("e1");
    expect(db.contact.updateMany).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    loadEvent(messagesPayload(inboundValue({ type: "interactive", text: undefined, interactive: { type: "button_reply", button_reply: { title: "Unsubscribe" } } })));
    await processWebhookEvent("e1");
    expect(db.contact.updateMany).toHaveBeenCalledTimes(1);
  });

  it("ignores messages that merely contain the word", async () => {
    loadEvent(messagesPayload(inboundValue({ text: { body: "please do not stop" } })));
    await processWebhookEvent("e1");
    expect(db.contact.updateMany).not.toHaveBeenCalled();
  });
});

describe("statuses", () => {
  const statusValue = (status: string, extra: Record<string, unknown> = {}) => ({
    metadata: { phone_number_id: "meta_phone_1" },
    statuses: [{ id: "wamid.out", status, timestamp: "1760000100", recipient_id: "919876543210", ...extra }],
  });

  it("advances status, appends to the timeline and updates broadcast recipients", async () => {
    db.message.findFirst.mockResolvedValue({ id: "m1", status: "sent", statusTimeline: [{ status: "sent", at: "x" }] });
    loadEvent(messagesPayload(statusValue("delivered")));
    await processWebhookEvent("e1");

    expect(db.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { wamid: "wamid.out", tenantId: "t1" } }));
    const call = db.message.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "m1", tenantId: "t1" });
    expect(call.data.status).toBe("delivered");
    expect(call.data.statusTimeline).toHaveLength(2);
    expect(db.broadcastRecipient.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "t1", wamid: "wamid.out", status: { in: ["pending", "queued", "sent"] } },
        data: expect.objectContaining({ status: "delivered", deliveredAt: expect.any(Date) }),
      }),
    );
  });

  it("does not move a read message back to delivered but still records the timeline", async () => {
    db.message.findFirst.mockResolvedValue({ id: "m1", status: "read", statusTimeline: [] });
    loadEvent(messagesPayload(statusValue("delivered")));
    await processWebhookEvent("e1");
    const data = db.message.updateMany.mock.calls[0][0].data;
    expect(data.status).toBeUndefined();
    expect(data.statusTimeline).toHaveLength(1);
  });

  it("stores the error code on failed", async () => {
    db.message.findFirst.mockResolvedValue({ id: "m1", status: "sent", statusTimeline: [] });
    loadEvent(messagesPayload(statusValue("failed", { errors: [{ code: 131047, title: "Re-engagement" }] })));
    await processWebhookEvent("e1");
    const data = db.message.updateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "failed", errorCode: "131047" });
    expect(data.statusTimeline[0]).toMatchObject({ status: "failed", errorCode: "131047" });
    expect(db.broadcastRecipient.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "131047" }) }),
    );
  });
});

describe("account level events", () => {
  const accountEvent = (field: string, value: Record<string, unknown>) => ({ entry: [{ id: "waba1", changes: [{ field, value }] }] });

  it("updates template status by metaTemplateId, with the rejection reason", async () => {
    db.waba.findUnique.mockResolvedValue({ id: "waba_row", tenantId: "t1" });
    db.template.updateMany.mockResolvedValue({ count: 1 });
    loadEvent(accountEvent("message_template_status_update", { event: "REJECTED", message_template_id: 99, message_template_name: "promo", message_template_language: "en", reason: "INVALID_FORMAT" }));
    await processWebhookEvent("e1");
    expect(db.waba.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { wabaId: "waba1" } }));
    expect(db.template.updateMany).toHaveBeenCalledTimes(1);
    expect(db.template.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", wabaRefId: "waba_row", metaTemplateId: "99" },
      data: { status: "rejected", rejectionReason: "INVALID_FORMAT" },
    });
  });

  it("falls back to name and language when the meta id is unknown", async () => {
    db.waba.findUnique.mockResolvedValue({ id: "waba_row", tenantId: "t1" });
    db.template.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    loadEvent(accountEvent("message_template_status_update", { event: "APPROVED", message_template_id: 99, message_template_name: "promo", message_template_language: "en", reason: "NONE" }));
    await processWebhookEvent("e1");
    expect(db.template.updateMany).toHaveBeenLastCalledWith({
      where: { tenantId: "t1", wabaRefId: "waba_row", name: "promo", language: "en" },
      data: { status: "approved", rejectionReason: null },
    });
  });

  it("updates phone quality and messaging tier", async () => {
    loadEvent(accountEvent("phone_number_quality_update", { phone_number_id: "meta_phone_1", display_phone_number: "919876543210", quality_rating: "YELLOW", current_limit: "TIER_10K" }));
    await processWebhookEvent("e1");
    expect(db.phoneNumber.updateMany).toHaveBeenCalledWith({
      where: { id: "ph_row", tenantId: "t1" },
      data: { qualityRating: "YELLOW", messagingLimitTier: "TIER_10K" },
    });
  });

  it("records other account events in the audit log", async () => {
    db.waba.findUnique.mockResolvedValue({ id: "waba_row", tenantId: "t1" });
    loadEvent(accountEvent("account_update", { event: "VERIFIED_ACCOUNT" }));
    await processWebhookEvent("e1");
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: { tenantId: "t1", action: "webhook.account_update", target: "waba1", meta: { event: "VERIFIED_ACCOUNT", wabaId: "waba1", summary: "account_update: event=VERIFIED_ACCOUNT" } },
    });
  });

  it("never stores the raw account_update or coexistence payload in the audit log", async () => {
    db.waba.findUnique.mockResolvedValue({ id: "waba_row", tenantId: "t1" });
    const value = {
      event: "ACCOUNT_VIOLATION",
      violation_info: { violation_type: "SPAM", note: "secret-free-text" },
      violation_type: "SPAM",
      messages: [{ from: "919876543210", text: { body: "my card is 4111 1111 1111 1111" } }],
      contacts: [{ wa_id: "919876543210", profile: { name: "Private Person" } }],
      message_echoes: [{ to: "919876543210", text: { body: "echoed content" } }],
      ban_state: "X".repeat(500),
    };
    loadEvent(accountEvent("account_update", value));
    await processWebhookEvent("e1");
    const call = db.auditLog.create.mock.calls.at(-1)![0] as { data: { meta: Record<string, unknown> } };
    const stored = JSON.stringify(call.data.meta);
    for (const leaked of ["919876543210", "4111", "Private Person", "echoed content", "secret-free-text", "messages", "contacts"]) expect(stored).not.toContain(leaked);
    expect(call.data.meta).toMatchObject({ event: "ACCOUNT_VIOLATION", wabaId: "waba1" });
    expect(String(call.data.meta.summary)).toContain("violation_type=SPAM");
    expect(stored.length).toBeLessThan(400);
  });

  it.each(["smb_message_echoes", "history", "smb_app_state_sync"])("keeps %s message content out of the audit log", async (field) => {
    db.waba.findUnique.mockResolvedValue({ id: "waba_row", tenantId: "t1" });
    loadEvent(accountEvent(field, { message_echoes: [{ text: { body: "hello private" } }], history: [{ threads: [{ messages: [{ text: { body: "old private" } }] }] }] }));
    await processWebhookEvent("e1");
    const stored = JSON.stringify(db.auditLog.create.mock.calls.at(-1)![0]);
    expect(stored).not.toContain("private");
    expect(stored).toContain(`webhook.${field}`);
  });

  it("does not write tenant data for an unknown waba", async () => {
    db.waba.findUnique.mockResolvedValue(null);
    loadEvent(accountEvent("account_update", { event: "X" }));
    await processWebhookEvent("e1");
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("hosted signup PARTNER_ADDED", () => {
  it("records waba and owner business ids without tenant data and marks the event processed", async () => {
    db.waba.findUnique.mockResolvedValue(null);
    loadEvent({ entry: [{ id: "waba9", changes: [{ field: "account_update", value: { event: "PARTNER_ADDED", waba_info: { waba_id: "waba9", owner_business_id: "biz1" } } }] }] });
    const result = await processWebhookEvent("e1");
    expect(result.notes).toEqual([]);
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: { tenantId: null, action: "webhook.account_update.PARTNER_ADDED", target: "waba9", meta: { wabaId: "waba9", ownerBusinessId: "biz1" } },
    });
    expect(db.webhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.any(Date), error: null }) }));
  });
});

// ===== Spend controls: WhatsApp signals (docs/SPEND-CONTROLS-SPEC.md 4.9, 6.3, 7.4) =====

describe("template status events (6.3)", () => {
  const event = (value: Record<string, unknown>) => ({ entry: [{ id: "waba1", changes: [{ field: "message_template_status_update", value }] }] });
  beforeEach(() => {
    db.waba.findUnique.mockResolvedValue({ id: "waba_row", tenantId: "t1" });
    db.template.updateMany.mockResolvedValue({ count: 1 });
  });

  it("FLAGGED is its own status now, and only marketing broadcasts using it pause", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tp1", category: "MARKETING", name: "promo", metaTemplateId: "99" });
    loadEvent(event({ event: "FLAGGED", message_template_id: 99, message_template_name: "promo", message_template_language: "en" }));
    await processWebhookEvent("e1");
    expect(db.template.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", wabaRefId: "waba_row", metaTemplateId: "99" }, data: { status: "flagged", rejectionReason: null } });
    expect(pauseForTemplate).toHaveBeenCalledWith("t1", "tp1", "template_quality");

    vi.clearAllMocks();
    db.waba.findUnique.mockResolvedValue({ id: "waba_row", tenantId: "t1" });
    db.template.updateMany.mockResolvedValue({ count: 1 });
    db.template.findFirst.mockResolvedValue({ id: "tp2", category: "UTILITY", name: "notice", metaTemplateId: "98" });
    loadEvent(event({ event: "FLAGGED", message_template_id: 98 }));
    await processWebhookEvent("e1");
    expect(pauseForTemplate).not.toHaveBeenCalled();
  });

  it("before migration 0011 a flagged template is stored as paused, the stricter state", async () => {
    db.template.updateMany.mockRejectedValueOnce(new Error('invalid input value for enum "TemplateStatus": "flagged"')).mockResolvedValue({ count: 1 });
    db.template.findFirst.mockResolvedValue({ id: "tp1", category: "MARKETING", name: "promo", metaTemplateId: "99" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    loadEvent(event({ event: "FLAGGED", message_template_id: 99 }));
    await processWebhookEvent("e1");
    warn.mockRestore();
    expect(db.template.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { status: "paused", rejectionReason: null } }));
    expect(pauseForTemplate).toHaveBeenCalledWith("t1", "tp1", "template_paused");
  });

  it.each(["PAUSED", "DISABLED"])("%s blocks the template for everyone and pauses its broadcasts", async (name) => {
    db.template.findFirst.mockResolvedValue({ id: "tp1", category: "UTILITY", name: "notice", metaTemplateId: "99" });
    loadEvent(event({ event: name, message_template_id: 99 }));
    await processWebhookEvent("e1");
    expect(db.template.updateMany.mock.calls[0][0].data.status).toBe(name.toLowerCase());
    expect(pauseForTemplate).toHaveBeenCalledWith("t1", "tp1", "template_paused");
  });

  it.each(["DELETED", "PENDING_DELETION", "ARCHIVED"])("%s in WhatsApp Manager disables the template and pauses its broadcasts", async (name) => {
    db.template.findFirst.mockResolvedValue({ id: "tp1", category: "MARKETING", name: "promo", metaTemplateId: "99" });
    loadEvent(event({ event: name, message_template_id: 99, message_template_name: "promo", message_template_language: "en" }));
    const result = await processWebhookEvent("e1");
    expect(result.notes).toEqual([]);
    expect(db.template.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", wabaRefId: "waba_row", metaTemplateId: "99" }, data: { status: "disabled", rejectionReason: null } });
    expect(pauseForTemplate).toHaveBeenCalledWith("t1", "tp1", "template_paused");
  });

  it("IN_APPEAL puts a rejected template back under review", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tp1", category: "UTILITY", name: "notice", metaTemplateId: "99" });
    loadEvent(event({ event: "IN_APPEAL", message_template_id: 99 }));
    await processWebhookEvent("e1");
    expect(db.template.updateMany.mock.calls[0][0].data).toEqual({ status: "pending", rejectionReason: null });
    expect(pauseForTemplate).not.toHaveBeenCalled();
  });

  it("LIMIT_EXCEEDED marks the template rejected, as a sync does, and pauses its broadcasts", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tp1", category: "MARKETING", name: "promo", metaTemplateId: "99" });
    loadEvent(event({ event: "LIMIT_EXCEEDED", message_template_id: 99 }));
    const result = await processWebhookEvent("e1");
    expect(result.notes).toEqual([]);
    expect(db.template.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", wabaRefId: "waba_row", metaTemplateId: "99" }, data: { status: "rejected", rejectionReason: null } });
    expect(pauseForTemplate).toHaveBeenCalledWith("t1", "tp1", "template_paused");
  });

  // Every event that is also a template status must land where the next "Update from Meta" puts it, or the status flips back and forth.
  it.each(["APPROVED", "PENDING", "IN_APPEAL", "REJECTED", "PAUSED", "DISABLED", "FLAGGED", "PENDING_DELETION", "DELETED", "ARCHIVED", "LIMIT_EXCEEDED"])(
    "%s is stored as the same status a sync stores",
    async (name) => {
      db.template.findFirst.mockResolvedValue({ id: "tp1", category: "UTILITY", name: "notice", metaTemplateId: "99" });
      loadEvent(event({ event: name, message_template_id: 99 }));
      await processWebhookEvent("e1");
      expect(db.template.updateMany.mock.calls[0][0].data.status).toBe(mapMetaStatus(name));
    },
  );

  it("LOCKED only stops edits: the template stays sendable and its broadcasts keep going", async () => {
    loadEvent(event({ event: "LOCKED", message_template_id: 99 }));
    const result = await processWebhookEvent("e1");
    expect(result.notes).toEqual([]);
    expect(db.template.updateMany).not.toHaveBeenCalled();
    expect(pauseForTemplate).not.toHaveBeenCalled();
  });

  it("UNARCHIVED reads the restored status back from Meta and never resumes broadcasts by itself", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tp1", category: "UTILITY", name: "notice", metaTemplateId: "99" });
    graphFetch.mockResolvedValue({ status: "APPROVED", category: "UTILITY" });
    loadEvent(event({ event: "UNARCHIVED", message_template_id: 99 }));
    const result = await processWebhookEvent("e1");
    expect(result.notes).toEqual([]);
    expect(graphFetch).toHaveBeenCalledWith({ tenantId: "t1", path: "99", query: { fields: "status,category" } });
    expect(db.template.updateMany).toHaveBeenCalledTimes(1);
    expect(db.template.updateMany).toHaveBeenCalledWith({ where: { id: "tp1", tenantId: "t1" }, data: { status: "approved", category: "UTILITY" } });
    expect(emitEvent).toHaveBeenCalledWith("t1", "template.status", expect.objectContaining({ templateId: "tp1", status: "approved" }));
    expect(pauseForTemplate).not.toHaveBeenCalled();
  });

  it("UNARCHIVED leaves the template disabled when Meta cannot be reached", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tp1", category: "UTILITY", name: "notice", metaTemplateId: "99" });
    graphFetch.mockRejectedValueOnce(new Error("meta down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    loadEvent(event({ event: "UNARCHIVED", message_template_id: 99 }));
    await processWebhookEvent("e1");
    warn.mockRestore();
    expect(db.template.updateMany).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalledWith("t1", "template.status", expect.anything());
  });

  it("an event with no status of its own is recorded as unhandled and changes nothing", async () => {
    loadEvent(event({ event: "SOMETHING_NEW", message_template_id: 99 }));
    const result = await processWebhookEvent("e1");
    expect(result.notes).toEqual(["unhandled template event SOMETHING_NEW"]);
    expect(db.template.updateMany).not.toHaveBeenCalled();
  });

  it.each(["REINSTATED", "UNPAUSE"])("%s puts the template back to approved and re-reads it from Meta", async (name) => {
    db.template.findFirst.mockResolvedValue({ id: "tp1", category: "MARKETING", name: "promo", metaTemplateId: "99" });
    graphFetch.mockResolvedValue({ status: "APPROVED", category: "UTILITY" });
    loadEvent(event({ event: name, message_template_id: 99 }));
    await processWebhookEvent("e1");
    expect(db.template.updateMany.mock.calls[0][0].data.status).toBe("approved");
    expect(graphFetch).toHaveBeenCalledWith({ tenantId: "t1", path: "99", query: { fields: "status,category" } });
    expect(db.template.updateMany).toHaveBeenLastCalledWith({ where: { id: "tp1", tenantId: "t1" }, data: { status: "approved", category: "UTILITY" } });
    expect(pauseForTemplate).not.toHaveBeenCalled();
  });
});

describe("template quality and category events (6.3)", () => {
  const change = (field: string, value: Record<string, unknown>) => ({ entry: [{ id: "waba1", changes: [{ field, value }] }] });
  beforeEach(() => {
    db.waba.findUnique.mockResolvedValue({ id: "waba_row", tenantId: "t1" });
    db.template.findFirst.mockResolvedValue({ id: "tp1", category: "UTILITY", name: "notice", metaTemplateId: "99" });
    db.template.updateMany.mockResolvedValue({ count: 1 });
  });

  it("quality YELLOW and GREEN reach the assistants' template stop; RED also pauses broadcasts", async () => {
    loadEvent(change("message_template_quality_update", { message_template_id: 99, new_quality_score: "YELLOW", previous_quality_score: "GREEN" }));
    await processWebhookEvent("e1");
    expect(signals.applyTemplateQuality).toHaveBeenCalledWith("t1", { id: "tp1", name: "notice" }, "YELLOW");
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "template.quality_warning" }) }));
    loadEvent(change("message_template_quality_update", { message_template_id: 99, new_quality_score: "GREEN" }));
    await processWebhookEvent("e1");
    expect(signals.applyTemplateQuality).toHaveBeenLastCalledWith("t1", { id: "tp1", name: "notice" }, "GREEN");
    loadEvent(change("message_template_quality_update", { message_template_id: 99, new_quality_score: "RED" }));
    await processWebhookEvent("e1");
    expect(pauseForTemplate).toHaveBeenCalledWith("t1", "tp1", "template_quality");
  });

  it("template_category_update stores the new category and re-estimates running broadcasts", async () => {
    loadEvent(change("template_category_update", { message_template_id: 99, message_template_name: "notice", message_template_language: "en", previous_category: "UTILITY", new_category: "MARKETING" }));
    const result = await processWebhookEvent("e1");
    expect(result.notes).toEqual([]);
    expect(db.template.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", wabaRefId: "waba_row", metaTemplateId: "99" }, data: { category: "MARKETING" } });
    expect(reestimate).toHaveBeenCalledWith("t1", "tp1");
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: "t1", action: "template.category_changed", target: "tp1", meta: expect.objectContaining({ from: "UTILITY", to: "MARKETING" }) }),
    });
  });

  it("a notice of a coming category change is only recorded", async () => {
    loadEvent(change("template_category_update", { message_template_id: 99, previous_category: "UTILITY", correct_category: "MARKETING" }));
    await processWebhookEvent("e1");
    expect(db.template.updateMany).not.toHaveBeenCalled();
    expect(reestimate).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ meta: expect.objectContaining({ upcoming: "MARKETING", to: null }) }) });
  });

  it("account_update events reach the safety stops, after the audit row", async () => {
    const value = { event: "ACCOUNT_RESTRICTION", restriction_info: [{ restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: 1793836800 }] };
    loadEvent(change("account_update", value));
    await processWebhookEvent("e1");
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "webhook.account_update" }) }));
    expect(signals.applyAccountUpdate).toHaveBeenCalledWith({ id: "waba_row", tenantId: "t1", wabaId: "waba1" }, value);
    signals.applyAccountUpdate.mockClear();
    db.waba.findFirst.mockResolvedValue({ businessId: null });
    loadEvent(change("business_capability_update", { max_daily_conversation_per_phone: 1000 }));
    await processWebhookEvent("e1");
    expect(signals.applyAccountUpdate).not.toHaveBeenCalled();
  });

  it("the quality webhook stores Meta's older names as GREEN, YELLOW or RED and ignores UNKNOWN", async () => {
    loadEvent(change("phone_number_quality_update", { phone_number_id: "meta_phone_1", quality_rating: "MEDIUM" }));
    await processWebhookEvent("e1");
    expect(db.phoneNumber.updateMany).toHaveBeenCalledWith({ where: { id: "ph_row", tenantId: "t1" }, data: { qualityRating: "YELLOW" } });
    loadEvent(change("phone_number_quality_update", { phone_number_id: "meta_phone_1", quality_rating: "UNKNOWN" }));
    await processWebhookEvent("e1");
    expect(db.phoneNumber.updateMany).toHaveBeenLastCalledWith({ where: { id: "ph_row", tenantId: "t1" }, data: {} });
  });
});

describe("delivery pricing (4.9 actual cost)", () => {
  const status = (extra: Record<string, unknown>) => ({
    metadata: { phone_number_id: "meta_phone_1" },
    statuses: [{ id: "wamid.out", status: "delivered", timestamp: "1760000100", recipient_id: "919876543210", ...extra }],
  });

  it("is stored on the Message from the first status that carries it", async () => {
    db.message.findFirst.mockResolvedValue({ id: "m1", status: "sent", statusTimeline: [], direction: "outbound" });
    loadEvent(messagesPayload(status({ pricing: { billable: true, pricing_model: "PMP", category: "marketing", type: "regular" } })));
    await processWebhookEvent("e1");
    expect(db.message.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", tenantId: "t1", billable: null },
      data: { billable: true, pricingType: "regular", pricingCategory: "MARKETING" },
    });
  });

  it("a status without pricing writes none", async () => {
    db.message.findFirst.mockResolvedValue({ id: "m1", status: "sent", statusTimeline: [], direction: "outbound" });
    loadEvent(messagesPayload(status({})));
    await processWebhookEvent("e1");
    for (const [args] of db.message.updateMany.mock.calls) expect(args.data).not.toHaveProperty("billable");
  });
});

describe("owner quick replies to spending notices (7.4)", () => {
  const tap = (payload: string) => inboundValue({ type: "button", text: undefined, button: { text: "Decline", payload } });
  beforeEach(() => resetNotifierCache());

  it("button.payload is kept on the parsed message", () => {
    expect(describeMessage({ type: "button", button: { text: "Decline", payload: "spdec:ap1:0123456789abcdef" } })).toEqual({ type: "button", body: "Decline", buttonPayload: "spdec:ap1:0123456789abcdef" });
    expect(ownerReplyPayload({ type: "button", buttonPayload: "spopt:ch1:abc" })).toBe("spopt:ch1:abc");
    expect(ownerReplyPayload({ type: "interactive", replyId: "spdec:ap1:abc" })).toBe("spdec:ap1:abc");
    expect(ownerReplyPayload({ type: "button", buttonPayload: "order:123" })).toBeNull();
  });

  it("routes spdec and spopt to the owner-reply handler only in the notifier workspace, and nothing else runs for it", async () => {
    db.platformSetting.findUnique.mockResolvedValue({ key: "spend:notify", value: { tenantId: "t1" } });
    loadEvent(messagesPayload(tap("spdec:ap1:0123456789abcdef")));
    await processWebhookEvent("e1");
    expect(ownerReply).toHaveBeenCalledWith({ tenantId: "t1", waId: "919876543210", payload: "spdec:ap1:0123456789abcdef", messageId: "wamid.1" });
    expect(automations).not.toHaveBeenCalled();
    expect(db.platformSetting.findUnique).toHaveBeenCalledWith({ where: { key: "spend:notify" } });
  });

  it("in any other workspace the same payload is an ordinary button tap", async () => {
    db.platformSetting.findUnique.mockResolvedValue({ key: "spend:notify", value: { tenantId: "notifier" } });
    loadEvent(messagesPayload(tap("spdec:ap1:0123456789abcdef")));
    await processWebhookEvent("e1");
    expect(ownerReply).not.toHaveBeenCalled();
    expect(automations).toHaveBeenCalled();
  });

  it("STOP and START in the notifier workspace also update the owner's alert channels (7.4 item 5); elsewhere they do not", async () => {
    ownerKeyword.mockClear();
    db.platformSetting.findUnique.mockResolvedValue({ key: "spend:notify", value: { tenantId: "t1" } });
    loadEvent(messagesPayload(inboundValue({ text: { body: "STOP" } })));
    await processWebhookEvent("e1");
    expect(ownerKeyword).toHaveBeenCalledWith({ tenantId: "t1", waId: "919876543210", keyword: "stop" });
    expect(ownerReply).not.toHaveBeenCalled();
    resetNotifierCache();
    ownerKeyword.mockClear();
    db.platformSetting.findUnique.mockResolvedValue({ key: "spend:notify", value: { tenantId: "notifier" } });
    loadEvent(messagesPayload(inboundValue({ text: { body: "STOP" } })));
    await processWebhookEvent("e1");
    expect(ownerKeyword).not.toHaveBeenCalled();
  });

  it("with no notifier set up nothing is routed, and ordinary messages never look it up", async () => {
    db.platformSetting.findUnique.mockResolvedValue(null);
    loadEvent(messagesPayload(tap("spopt:ch1:0123456789abcdef")));
    await processWebhookEvent("e1");
    expect(ownerReply).not.toHaveBeenCalled();
    resetNotifierCache();
    db.platformSetting.findUnique.mockClear();
    loadEvent(messagesPayload(inboundValue({})));
    await processWebhookEvent("e1");
    // A short message may read the workspace's own STOP words (inbox settings), but never the notifier setting.
    const keys: string[] = db.platformSetting.findUnique.mock.calls.map((c: unknown[]) => (c[0] as { where: { key: string } }).where.key);
    expect(keys.filter((k) => k === "spend:notify")).toEqual([]);
    expect(keys.every((k) => k.startsWith("inbox:settings:"))).toBe(true);
  });
});

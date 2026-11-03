import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  broadcastRecipient: { groupBy: vi.fn() },
  contact: { findFirst: vi.fn() },
  webhookEndpoint: { findMany: vi.fn() },
  webhookDelivery: { create: vi.fn() },
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queue);

import { emitBroadcastCompleted, emitLeadCreated, emitStatusChanged, leadFieldsAsText } from "@/lib/integrations/emitters";
import { DELIVERY_QUEUE, emitEvent, WEBHOOK_EVENTS } from "@/lib/integrations/events";
import { eventDoc, leafPaths } from "@/lib/integrations/payloads";

const lastEnvelope = () => db.webhookDelivery.create.mock.calls.at(-1)?.[0].data.payload as { id: string; event: string; createdAt: string; data: Record<string, unknown> };
const documented = (event: string) => {
  const names = eventDoc(event)!.fields.map((f) => f.name);
  return new Set(names.filter((n) => !names.some((o) => o.startsWith(`${n}.`))));
};
const leaves = (value: unknown) => leafPaths(value).map((p) => (p.startsWith("fields.") ? "fields" : p));

beforeEach(() => {
  vi.clearAllMocks();
  db.webhookEndpoint.findMany.mockResolvedValue([{ id: "e1" }]);
  db.webhookDelivery.create.mockResolvedValue({ id: "d1" });
});

describe("emitEvent", () => {
  it("queues one delivery per enabled endpoint subscribed to the event, for this workspace only", async () => {
    db.webhookEndpoint.findMany.mockResolvedValue([{ id: "e1" }, { id: "e2" }]);
    await emitEvent("t1", "lead.created", { a: 1 });
    expect(db.webhookEndpoint.findMany).toHaveBeenCalledWith({ where: { tenantId: "t1", enabled: true, events: { has: "lead.created" } }, select: { id: true } });
    expect(db.webhookDelivery.create).toHaveBeenCalledTimes(2);
    expect(queue.enqueue).toHaveBeenCalledWith(DELIVERY_QUEUE, expect.objectContaining({ tenantId: "t1" }), expect.any(Object));
  });

  it("never throws and never logs the payload when recording fails", async () => {
    db.webhookEndpoint.findMany.mockRejectedValue(new Error("db down: secret-body"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(emitEvent("t1", "message.received", { text: "private" })).resolves.toBeUndefined();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("private");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-body");
    spy.mockRestore();
  });

  it("can subscribe to every documented event", () => {
    expect(WEBHOOK_EVENTS).toHaveLength(7);
  });
});

describe("conversation.status_changed", () => {
  it("is emitted with the previous and new status and who changed it", async () => {
    await emitStatusChanged("t1", { conversationId: "cv1", contactId: "c1", from: "open", to: "solved", changedBy: "u1", source: "user" });
    const env = lastEnvelope();
    expect(env.event).toBe("conversation.status_changed");
    expect(env.data).toMatchObject({ conversationId: "cv1", contactId: "c1", from: "open", to: "solved", changedBy: "u1", source: "user" });
    expect(new Set(leaves(env.data))).toEqual(documented("conversation.status_changed"));
  });

  it("marks automation and customer-reply changes as system, with no user", async () => {
    await emitStatusChanged("t1", { conversationId: "cv1", contactId: null, from: "solved", to: "open", source: "system" });
    expect(lastEnvelope().data).toMatchObject({ changedBy: null, source: "system", contactId: null });
  });

  it("stays silent when the status did not change", async () => {
    await emitStatusChanged("t1", { conversationId: "cv1", contactId: "c1", from: "open", to: "open", source: "user" });
    expect(db.webhookDelivery.create).not.toHaveBeenCalled();
  });
});

describe("broadcast.completed", () => {
  it("sums recipient statuses into totals, scoped to the workspace and broadcast", async () => {
    db.broadcastRecipient.groupBy.mockResolvedValue([
      { status: "delivered", _count: { _all: 6 } },
      { status: "read", _count: { _all: 3 } },
      { status: "sent", _count: { _all: 1 } },
      { status: "failed", _count: { _all: 2 } },
      { status: "skipped", _count: { _all: 1 } },
    ]);
    await emitBroadcastCompleted("t1", { id: "b1", name: "Offer", templateId: "tp1" }, new Date("2026-10-27T10:00:00Z"));
    expect(db.broadcastRecipient.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", broadcastId: "b1" } }));
    const env = lastEnvelope();
    expect(env.event).toBe("broadcast.completed");
    expect(env.data).toMatchObject({ broadcastId: "b1", name: "Offer", templateId: "tp1", completedAt: "2026-10-27T10:00:00.000Z", totals: { total: 13, sent: 10, delivered: 9, read: 3, failed: 2, skipped: 1 } });
    expect(new Set(leaves(env.data))).toEqual(documented("broadcast.completed"));
  });

  it("still emits with zero totals when the counts cannot be read", async () => {
    db.broadcastRecipient.groupBy.mockRejectedValue(new Error("boom"));
    await emitBroadcastCompleted("t1", { id: "b1" }, new Date());
    expect(lastEnvelope().data).toMatchObject({ name: null, templateId: null, totals: { total: 0 } });
  });
});

describe("lead.created", () => {
  const lead = { id: "l1", status: "new", fields: { full_name: "Asha", phone_number: "+91 98765 43210", n: 5, nested: { a: 1 } }, campaignMetaId: "camp1", adMetaId: "ad1", createdAt: new Date("2026-10-27T09:00:00Z"), contactId: "c1", leadForm: { metaFormId: "form1" } };

  it("carries the form answers as text and the matched contact, found within the workspace", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1", phone: "+919876543210", bsuid: null, waId: "919876543210", username: null, name: "Asha" });
    await emitLeadCreated("t1", lead);
    expect(db.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: "t1" } }));
    const env = lastEnvelope();
    expect(env.event).toBe("lead.created");
    expect(env.data).toMatchObject({ leadId: "l1", formId: "form1", campaignId: "camp1", adId: "ad1", source: "meta_lead_form", fields: { full_name: "Asha", n: "5", nested: "" }, contact: { id: "c1", bsuid: null } });
    expect(new Set(leaves(env.data))).toEqual(documented("lead.created"));
  });

  it("emits with a null contact when the lead has none", async () => {
    await emitLeadCreated("t1", { ...lead, contactId: null }, "form9");
    expect(db.contact.findFirst).not.toHaveBeenCalled();
    expect(lastEnvelope().data).toMatchObject({ contact: null, formId: "form9" });
  });

  it("says a click-to-WhatsApp lead came from the ad (source ctwa, no form), read from its ctwa: leadgen id", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1", phone: "+919876543210", bsuid: null, waId: "919876543210", username: null, name: "Asha" });
    const chat = { id: "l2", status: "new", leadgenId: "ctwa:AR-click-1", fields: { source: "click_to_whatsapp", ad_headline: "Free check-up" }, campaignMetaId: null, adMetaId: "ad-77", createdAt: new Date("2026-10-30T10:00:00Z"), contactId: "c1", leadFormId: null };
    await emitLeadCreated("t1", chat, "form-ignored");
    expect(lastEnvelope().data).toMatchObject({ leadId: "l2", source: "ctwa", formId: null, adId: "ad-77", fields: { source: "click_to_whatsapp", ad_headline: "Free check-up" } });
    expect(new Set(leaves(lastEnvelope().data))).toEqual(documented("lead.created"));
    // A Meta lead id (digits) is a form lead.
    await emitLeadCreated("t1", { ...lead, leadgenId: "1234567890" });
    expect(lastEnvelope().data).toMatchObject({ source: "meta_lead_form", formId: "form1" });
  });

  it("limits what form answers can add to the payload", () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, "x".repeat(900)]));
    const out = leadFieldsAsText(many);
    expect(Object.keys(out)).toHaveLength(100);
    expect(Object.values(out).every((v) => v.length <= 500)).toBe(true);
    expect(leadFieldsAsText(null)).toEqual({});
    expect(leadFieldsAsText([1, 2])).toEqual({});
  });
});

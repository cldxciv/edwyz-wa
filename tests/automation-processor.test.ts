import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() });
  return { webhookEvent: model(), phoneNumber: model(), waba: model(), contact: model(), conversation: model(), message: model(), template: model(), broadcastRecipient: model(), auditLog: model() };
});
const run = vi.hoisted(() => vi.fn());
const emit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/automation/engine", () => ({ runAutomationsForInbound: run }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: emit }));

import { processWebhookEvent } from "@/lib/webhooks/processor";

const payload = (text: string) => ({
  entry: [
    {
      id: "waba1",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "meta1" },
            contacts: [{ wa_id: "919876543210", profile: { name: "Asha" } }],
            messages: [{ from: "919876543210", id: "wamid.1", timestamp: "1760000000", type: "text", text: { body: text } }],
          },
        },
      ],
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  db.phoneNumber.findUnique.mockResolvedValue({ id: "ph_row", tenantId: "t1" });
  db.message.findUnique.mockResolvedValue(null);
  db.contact.findFirst.mockResolvedValue({ id: "c1", name: "Asha", phone: "+919876543210", waId: "919876543210" });
  db.conversation.upsert.mockResolvedValue({ id: "cv1" });
  db.message.create.mockResolvedValue({ id: "m1" });
  run.mockResolvedValue({ replied: false });
  emit.mockResolvedValue(undefined);
});

const load = (p: unknown) => db.webhookEvent.findUnique.mockResolvedValue({ id: "e1", payload: p, processedAt: null });

describe("automation hook in the processor", () => {
  it("runs automations after an inbound message is stored, then emits message.received", async () => {
    load(payload("hello"));
    await processWebhookEvent("e1");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", phoneNumberId: "ph_row", conversationId: "cv1", contactId: "c1", text: "hello" }));
    expect(emit).toHaveBeenCalledWith("t1", "message.received", expect.objectContaining({ conversationId: "cv1" }));
  });

  it("a failing automation never fails webhook processing", async () => {
    run.mockRejectedValue(new Error("rule engine exploded with private text"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    load(payload("hello"));
    await expect(processWebhookEvent("e1")).resolves.toMatchObject({ handled: 1 });
    expect(db.webhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.any(Date) }) }));
    expect(JSON.stringify(spy.mock.calls)).not.toContain("private text");
    spy.mockRestore();
  });

  it("does not run automations for a STOP message and emits contact.opted_out", async () => {
    load(payload("STOP"));
    await processWebhookEvent("e1");
    expect(run).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("t1", "contact.opted_out", expect.objectContaining({ contactId: "c1" }));
  });

  it("does not run automations for a redelivered message", async () => {
    db.message.findUnique.mockResolvedValue({ id: "existing" });
    load(payload("hello"));
    await processWebhookEvent("e1");
    expect(run).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits message.status for outbound messages only", async () => {
    const statusPayload = { entry: [{ id: "waba1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "meta1" }, statuses: [{ id: "wamid.out", status: "delivered", timestamp: "1760000100" }] } }] }] };
    db.message.findFirst.mockResolvedValue({ id: "m9", status: "sent", statusTimeline: [], conversationId: "cv1", direction: "outbound" });
    load(statusPayload);
    await processWebhookEvent("e1");
    expect(emit).toHaveBeenCalledWith("t1", "message.status", expect.objectContaining({ messageId: "m9", status: "delivered", wamid: "wamid.out" }));

    emit.mockClear();
    db.webhookEvent.findUnique.mockResolvedValue({ id: "e2", payload: statusPayload, processedAt: null });
    db.message.findFirst.mockResolvedValue({ id: "m9", status: "received", statusTimeline: [], conversationId: "cv1", direction: "inbound" });
    await processWebhookEvent("e2");
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits template.status", async () => {
    db.waba.findUnique.mockResolvedValue({ id: "w", tenantId: "t1" });
    db.template.updateMany.mockResolvedValue({ count: 1 });
    load({ entry: [{ id: "waba1", changes: [{ field: "message_template_status_update", value: { event: "REJECTED", message_template_id: 5, message_template_name: "promo", message_template_language: "en", reason: "INVALID_FORMAT" } }] }] });
    await processWebhookEvent("e1");
    expect(emit).toHaveBeenCalledWith("t1", "template.status", expect.objectContaining({ name: "promo", language: "en", status: "rejected", reason: "INVALID_FORMAT", templateId: null, category: null }));
  });
});

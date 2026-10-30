import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() });
  return {
    webhookEvent: model(), phoneNumber: model(), waba: model(), contact: model(), conversation: model(),
    message: model(), template: model(), broadcastRecipient: model(), auditLog: model(),
  };
});
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/automation/engine", () => ({ runAutomationsForInbound: vi.fn().mockResolvedValue({ replied: false }) }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));

import { Prisma } from "@/generated/prisma/client";
import { processWebhookEvent } from "@/lib/webhooks/processor";

const message = (extra: Record<string, unknown> = {}) => ({
  from: "919876543210", id: "wamid.ad1", timestamp: "1760000000", type: "text", text: { body: "Hi, I saw your ad" }, ...extra,
});
const payload = (msg: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "meta_phone_1" }, contacts: [{ wa_id: "919876543210", profile: { name: "Asha" } }], messages: [msg] } }] }],
});
const referralCalls = () => db.conversation.updateMany.mock.calls.map((c) => c[0]).filter((a) => a?.data && "referral" in a.data);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  db.phoneNumber.findUnique.mockResolvedValue({ id: "ph_row", tenantId: "t1" });
  db.message.findUnique.mockResolvedValue(null);
  db.contact.findFirst.mockResolvedValue(null);
  db.contact.create.mockResolvedValue({ id: "c1" });
  db.conversation.upsert.mockResolvedValue({ id: "cv1" });
  db.message.create.mockResolvedValue({ id: "m1" });
  db.conversation.updateMany.mockResolvedValue({ count: 1 });
});

describe("the real webhook processor stores the click-to-WhatsApp referral", () => {
  it("writes the cleaned referral once, only where none is stored (SQL NULL), for this workspace's conversation", async () => {
    const referral = { source_url: "https://fb.me/ad", source_id: "ad-77", source_type: "ad", headline: "Free check-up", ctwa_clid: "AR-click-123", junk: "<script>" };
    db.webhookEvent.findUnique.mockResolvedValue({ id: "e1", payload: payload(message({ referral })), processedAt: null });
    await processWebhookEvent("e1");
    const calls = referralCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toEqual({ id: "cv1", tenantId: "t1", referral: { equals: Prisma.DbNull } });
    expect(calls[0].data.referral).toMatchObject({ ctwaClid: "AR-click-123", sourceId: "ad-77", sourceType: "ad" });
    expect(JSON.stringify(calls[0].data.referral)).not.toContain("script");
  });

  it("a message without a referral never touches the stored one", async () => {
    db.webhookEvent.findUnique.mockResolvedValue({ id: "e1", payload: payload(message()), processedAt: null });
    await processWebhookEvent("e1");
    expect(referralCalls()).toHaveLength(0);
  });

  it("a failing referral write does not lose the message", async () => {
    db.conversation.updateMany.mockImplementation(async (a: { data: Record<string, unknown> }) => {
      if ("referral" in a.data) throw new Error("db down");
      return { count: 1 };
    });
    db.webhookEvent.findUnique.mockResolvedValue({ id: "e1", payload: payload(message({ referral: { ctwa_clid: "x", source_id: "ad-1" } })), processedAt: null });
    await processWebhookEvent("e1");
    expect(db.message.create).toHaveBeenCalled();
    expect(db.webhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.any(Date) }) }));
  });
});

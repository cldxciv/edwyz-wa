import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  message: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  template: { findFirst: vi.fn() },
  contact: { findFirst: vi.fn() },
  phoneNumber: { findFirst: vi.fn() },
  conversation: { upsert: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
}));
const graphFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/onboarding/token-health", () => ({ isAuthFailure: () => false, markWhatsAppAuthRejected: vi.fn(), noteWhatsAppTokenWorks: vi.fn() }));
vi.mock("@/lib/graph", () => {
  class GraphError extends Error {
    retryable = false;
    ambiguous = false;
    code?: number;
    status = 400;
  }
  return { GraphError, graphFetch };
});
vi.mock("@/lib/automation/v2/emit", () => ({ emitTagChanges: vi.fn() }));
vi.mock("@/lib/chatbots/human-reply", () => ({ stopBotsOnHumanReply: vi.fn() }));
vi.mock("@/lib/routing", () => ({ onConversationAssigned: vi.fn() }));
// The spend send gate (docs/SPEND-CONTROLS-SPEC.md 4.9) is covered by spend-messaging.test.ts and inbox-send.test.ts; here it lets the send through.
vi.mock("@/lib/spend/messaging/gate", () => ({ messagingGate: async () => ({ action: "send", overLimit: false, spend: {}, run: (fn: () => unknown) => fn() }), finishSend: async () => undefined }));

import { addressFields, buildSendBody, processSendJob } from "@/lib/inbox/send";
import { sendTemplateMessage } from "@/lib/inbox/service";

const BSUID = "US.13491208655302741918";
const textRow = { type: "text", body: "Hi", mediaUrl: null, mediaMime: null };

describe("addressing the Cloud API body", () => {
  it("uses `to` with the digits of a phone number and `recipient` for a BSUID", () => {
    expect(addressFields("+919876543210")).toEqual({ to: "919876543210" });
    expect(addressFields({ phone: "+919876543210" })).toEqual({ to: "919876543210" });
    expect(addressFields({ bsuid: BSUID })).toEqual({ recipient: BSUID });
  });

  it("builds a text body for a phone and for a BSUID without a `to`", () => {
    expect(buildSendBody({ phone: "+919876543210" }, textRow, {})).toMatchObject({ messaging_product: "whatsapp", to: "919876543210", type: "text" });
    const body = buildSendBody({ bsuid: BSUID }, textRow, {}) as Record<string, unknown>;
    expect(body.recipient).toBe(BSUID);
    expect(body).not.toHaveProperty("to");
  });

  it("builds a template body for a BSUID recipient", () => {
    const body = buildSendBody({ bsuid: BSUID }, { type: "template", body: "[template] promo", mediaUrl: null, mediaMime: null }, { template: { name: "promo", language: "en", components: [] } });
    expect(body).toMatchObject({ recipient: BSUID, type: "template", template: { name: "promo", language: { code: "en" } } });
  });
});

describe("the send job", () => {
  const job = { messageId: "m1", tenantId: "t1", template: { name: "otp", language: "en", components: [] } };
  const queued = (type: string, contact: Record<string, unknown>) => ({
    id: "m1",
    type,
    body: type === "text" ? "Hello" : "[template] otp",
    mediaUrl: null,
    mediaMime: null,
    status: "queued",
    wamid: null,
    statusTimeline: [],
    conversationId: "cv1",
    conversation: { contact: { id: "c1", phone: null, bsuid: null, username: null, name: null, ...contact }, phoneNumber: { phoneNumberId: "meta_ph" } },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    graphFetch.mockResolvedValue({ messages: [{ id: "wamid.OUT" }] });
  });

  it("sends to the phone when the contact has one, even if it also has a BSUID", async () => {
    db.message.findFirst.mockResolvedValue(queued("text", { phone: "+919876543210", bsuid: BSUID }));
    await processSendJob(job);
    const body = graphFetch.mock.calls[0][0].body;
    expect(body.to).toBe("919876543210");
    expect(body).not.toHaveProperty("recipient");
  });

  it("sends to the BSUID when the contact has no phone", async () => {
    db.message.findFirst.mockResolvedValue(queued("text", { bsuid: BSUID }));
    await processSendJob(job);
    expect(graphFetch).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", path: "meta_ph/messages", body: expect.objectContaining({ recipient: BSUID }) }));
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "sent", wamid: "wamid.OUT" }) }));
  });

  it("fails a message to a contact with no phone and no BSUID instead of sending to nobody", async () => {
    db.message.findFirst.mockResolvedValue(queued("text", {}));
    await processSendJob(job);
    expect(graphFetch).not.toHaveBeenCalled();
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "no_recipient" }) }));
  });

  it("does not send a login-code template to a BSUID-only contact, but lets other templates through", async () => {
    db.message.findFirst.mockResolvedValue(queued("template", { bsuid: BSUID }));
    db.template.findFirst.mockResolvedValue({ category: "AUTHENTICATION" });
    await processSendJob(job);
    expect(graphFetch).not.toHaveBeenCalled();
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "bsuid_auth_template" }) }));

    vi.clearAllMocks();
    graphFetch.mockResolvedValue({ messages: [{ id: "wamid.OUT" }] });
    db.message.findFirst.mockResolvedValue(queued("template", { bsuid: BSUID }));
    db.template.findFirst.mockResolvedValue({ category: "UTILITY" });
    await processSendJob(job);
    expect(graphFetch.mock.calls[0][0].body).toMatchObject({ recipient: BSUID, type: "template" });
  });

  it("does not look the template up at all for a contact that has a phone", async () => {
    db.message.findFirst.mockResolvedValue(queued("template", { phone: "+919876543210", bsuid: BSUID }));
    await processSendJob(job);
    expect(db.template.findFirst).not.toHaveBeenCalled();
    expect(graphFetch.mock.calls[0][0].body.to).toBe("919876543210");
  });
});

describe("sendTemplateMessage refuses a login-code template for a contact without a phone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
    db.conversation.upsert.mockResolvedValue({ id: "cv1" });
    db.message.create.mockResolvedValue({ id: "m1", type: "template", status: "queued" });
  });
  const send = () => sendTemplateMessage({ tenantId: "t1", origin: "unknown", phoneNumberId: "ph1", contactId: "c1", templateName: "otp", language: "en" });

  it("422s for AUTHENTICATION", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1", optIn: true, optedOutAt: null, phone: null, bsuid: BSUID });
    db.template.findFirst.mockResolvedValue({ category: "AUTHENTICATION" });
    await expect(send()).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/phone number/) });
    expect(db.message.create).not.toHaveBeenCalled();
  });

  it("allows a utility template to a BSUID-only contact", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1", optIn: false, optedOutAt: null, phone: null, bsuid: BSUID });
    db.template.findFirst.mockResolvedValue({ category: "UTILITY" });
    await expect(send()).resolves.toMatchObject({ type: "template" });
  });

  it("422s when the contact has nobody to send to", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1", optIn: true, optedOutAt: null, phone: null, bsuid: null });
    db.template.findFirst.mockResolvedValue({ category: "UTILITY" });
    await expect(send()).rejects.toMatchObject({ status: 422 });
  });
});

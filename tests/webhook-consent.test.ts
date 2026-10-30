import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() });
  return { webhookEvent: model(), phoneNumber: model(), contact: model(), conversation: model(), message: model(), auditLog: model() };
});
const mods = vi.hoisted(() => ({
  sendText: vi.fn(),
  getInboxSettings: vi.fn(),
  automations: vi.fn(),
  chatbots: vi.fn(),
  ai: vi.fn(),
  assign: vi.fn(),
  leadsStopped: vi.fn(),
  leadsReplied: vi.fn(),
  emit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/inbox/service", () => ({ sendText: mods.sendText }));
vi.mock("@/lib/inbox/settings", () => ({ getInboxSettings: mods.getInboxSettings }));
vi.mock("@/lib/automation/engine", () => ({ runAutomationsForInbound: mods.automations }));
vi.mock("@/lib/chatbots", () => ({ handleInboundForChatbots: mods.chatbots }));
vi.mock("@/lib/ai-agent", () => ({ handleInboundForAiAgent: mods.ai }));
vi.mock("@/lib/routing", () => ({ assignConversation: mods.assign }));
vi.mock("@/lib/leads", () => ({ onContactOptedOut: mods.leadsStopped, onInboundFromContact: mods.leadsReplied }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: mods.emit }));
vi.mock("@/lib/conversions/referral", () => ({ captureReferral: vi.fn(), parseReferral: () => null }));
vi.mock("@/lib/wiring", () => ({ wireModules: vi.fn() }));

import { isStartMessage } from "@/lib/webhooks/payload";
import { processWebhookEvent } from "@/lib/webhooks/processor";

const REPLIES = { agentSignature: false, optOutReply: "You are unsubscribed. Reply START to subscribe again.", optInReply: "Welcome back." };

function inbound(body: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "meta_phone_1" },
              contacts: [{ wa_id: "919876543210", profile: { name: "Asha" } }],
              messages: [{ from: "919876543210", id: `wamid.${body}`, timestamp: "1760000000", type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

/** The contact the inbound message resolves to: found by phone, with the identity columns a stored contact has. */
function mockContact(row: Record<string, unknown>) {
  const full = { phone: "+919876543210", bsuid: null, username: null, waId: "919876543210", name: "Asha", ...row };
  db.contact.findFirst.mockResolvedValue(full);
  db.contact.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...full, ...data }));
}

async function receive(body: string, contact: Record<string, unknown> = {}) {
  db.webhookEvent.findUnique.mockResolvedValue({ id: "e1", payload: inbound(body), processedAt: null });
  mockContact({ id: "c1", optedOutAt: null, ...contact });
  await processWebhookEvent("e1");
}

beforeEach(() => {
  vi.clearAllMocks();
  db.phoneNumber.findUnique.mockResolvedValue({ id: "ph_row", tenantId: "t1" });
  db.message.findUnique.mockResolvedValue(null);
  db.conversation.upsert.mockResolvedValue({ id: "cv1", assignedToId: null });
  db.message.create.mockResolvedValue({ id: "m1" });
  mods.getInboxSettings.mockResolvedValue(REPLIES);
  mods.sendText.mockResolvedValue({ id: "out1" });
  mods.chatbots.mockResolvedValue(false);
  mods.ai.mockResolvedValue(false);
  mods.leadsStopped.mockResolvedValue(undefined);
  mods.leadsReplied.mockResolvedValue(undefined);
  mods.automations.mockResolvedValue({ replied: false });
  mods.assign.mockResolvedValue(undefined);
});

describe("retry safety", () => {
  it("applies STOP before the inbound row is stored, so a crash after the row cannot lose the opt-out", async () => {
    const order: string[] = [];
    db.contact.updateMany.mockImplementation(async () => order.push("opt-out"));
    db.message.create.mockImplementation(async () => order.push("message"));
    await receive("STOP");
    expect(order).toEqual(["opt-out", "message"]);
  });

  it("applies START before the inbound row is stored too", async () => {
    const order: string[] = [];
    db.contact.updateMany.mockImplementation(async () => order.push("opt-in"));
    db.message.create.mockImplementation(async () => order.push("message"));
    await receive("START", { optedOutAt: new Date() });
    expect(order).toEqual(["opt-in", "message"]);
  });

  it("does nothing for a message that was already stored (a retry after success)", async () => {
    db.message.findUnique.mockResolvedValue({ id: "m1" });
    await receive("STOP");
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(db.message.create).not.toHaveBeenCalled();
  });
});

describe("STOP confirmation", () => {
  it("opts the contact out and confirms once, in the same chat", async () => {
    await receive("STOP");
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { optedOutAt: expect.any(Date), optIn: false } });
    expect(mods.getInboxSettings).toHaveBeenCalledWith("t1");
    expect(mods.sendText).toHaveBeenCalledTimes(1);
    expect(mods.sendText).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", body: REPLIES.optOutReply, origin: "consent" });
  });

  it("does not confirm again when the contact had already opted out", async () => {
    await receive("stop", { optedOutAt: new Date() });
    expect(db.contact.updateMany).toHaveBeenCalledTimes(1);
    expect(mods.sendText).not.toHaveBeenCalled();
  });

  it("sends nothing when the workspace cleared the confirmation text", async () => {
    mods.getInboxSettings.mockResolvedValue({ ...REPLIES, optOutReply: "" });
    await receive("STOP");
    expect(db.contact.updateMany).toHaveBeenCalledTimes(1);
    expect(mods.sendText).not.toHaveBeenCalled();
  });

  it("still honours the opt-out when the confirmation cannot be queued", async () => {
    mods.sendText.mockRejectedValue(new Error("queue down"));
    await receive("STOP");
    expect(db.contact.updateMany).toHaveBeenCalledTimes(1);
    expect(db.webhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.any(Date) }) }));
  });

  it("runs no bot, AI agent or automation for a STOP message", async () => {
    await receive("STOP");
    expect(mods.chatbots).not.toHaveBeenCalled();
    expect(mods.ai).not.toHaveBeenCalled();
    expect(mods.automations).not.toHaveBeenCalled();
  });
});

describe("START resubscribe", () => {
  it.each(["START", " start ", "Unstop", "Subscribe!", "opt in"])("resubscribes an opted-out contact who sends %j", async (body) => {
    await receive(body, { optedOutAt: new Date("2026-10-01T00:00:00Z") });
    expect(db.contact.updateMany).toHaveBeenCalledTimes(1);
    expect(db.contact.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", tenantId: "t1" },
      data: { optedOutAt: null, optIn: true, optInSource: "whatsapp_start", optInAt: expect.any(Date) },
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: { tenantId: "t1", action: "contact.opted_in", target: "c1", meta: { via: "start_keyword" } } });
    expect(mods.sendText).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", body: REPLIES.optInReply, origin: "consent" });
  });

  it("treats START from a contact who never opted out as an ordinary message", async () => {
    await receive("START");
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(mods.sendText).not.toHaveBeenCalled();
    expect(mods.chatbots).toHaveBeenCalled();
    expect(mods.automations).toHaveBeenCalled();
  });

  it("does not resubscribe on a sentence that merely contains the word", async () => {
    await receive("please start the order", { optedOutAt: new Date() });
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(mods.sendText).not.toHaveBeenCalled();
  });

  it("runs no bot, AI agent or automation for the START message, and stops lead sequences from restarting", async () => {
    await receive("START", { optedOutAt: new Date() });
    expect(mods.chatbots).not.toHaveBeenCalled();
    expect(mods.ai).not.toHaveBeenCalled();
    expect(mods.automations).not.toHaveBeenCalled();
    expect(mods.leadsStopped).not.toHaveBeenCalled();
  });

  it("only changes the contact of the number's own workspace", async () => {
    await receive("START", { optedOutAt: new Date() });
    expect(db.phoneNumber.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { phoneNumberId: "meta_phone_1" } }));
    for (const call of db.contact.updateMany.mock.calls) expect(call[0].where.tenantId).toBe("t1");
  });
});

describe("isStartMessage", () => {
  it("accepts the resubscribe words after normalisation and nothing longer", () => {
    for (const ok of ["start", "START", " Start. ", "unstop", "subscribe", "resubscribe", "opt-in", "OPTIN"]) expect(isStartMessage(ok)).toBe(true);
    for (const no of ["", "stop", "start now", "please start", "starting", "restart"]) expect(isStartMessage(no)).toBe(false);
  });
});

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
  endSessions: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/inbox/service", () => ({ sendText: mods.sendText }));
vi.mock("@/lib/inbox/settings", () => ({ getInboxSettings: mods.getInboxSettings }));
vi.mock("@/lib/automation/engine", () => ({ runAutomationsForInbound: mods.automations }));
vi.mock("@/lib/chatbots", () => ({ handleInboundForChatbots: mods.chatbots }));
vi.mock("@/lib/chatbots/opt-out", () => ({ endChatbotSessionsForContact: mods.endSessions }));
vi.mock("@/lib/ai-agent", () => ({ handleInboundForAiAgent: mods.ai }));
vi.mock("@/lib/routing", () => ({ assignConversation: mods.assign }));
vi.mock("@/lib/leads", () => ({ onContactOptedOut: vi.fn().mockResolvedValue(undefined), onInboundFromContact: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/conversions/referral", () => ({ captureReferral: vi.fn(), parseReferral: () => null }));
vi.mock("@/lib/wiring", () => ({ wireModules: vi.fn() }));

import { processWebhookEvent } from "@/lib/webhooks/processor";

const REPLIES = { agentSignature: false, optOutReply: "You are unsubscribed.", optInReply: "Welcome back." };

type Msg = Record<string, unknown>;
function payload(message: Msg) {
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
              messages: [{ from: "919876543210", id: `wamid.${JSON.stringify(message).length}${Math.random()}`, timestamp: "1760000000", ...message }],
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

async function receive(message: Msg, contact: Record<string, unknown> = {}) {
  db.webhookEvent.findUnique.mockResolvedValue({ id: "e1", payload: payload(message), processedAt: null });
  mockContact({ id: "c1", optedOutAt: null, ...contact });
  await processWebhookEvent("e1");
}

const typed = (body: string) => ({ type: "text", text: { body } });
const tapped = (kind: "button_reply" | "list_reply", id: string, title: string) => ({ type: "interactive", interactive: { type: kind, [kind]: { id, title } } });

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
  mods.automations.mockResolvedValue({ replied: false });
  mods.endSessions.mockResolvedValue(0);
  mods.assign.mockResolvedValue(undefined);
});

describe("STOP ends the contact's chatbot sessions", () => {
  it("a typed STOP opts out and ends every running bot of the contact", async () => {
    await receive(typed("STOP"));
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { optedOutAt: expect.any(Date), optIn: false } });
    expect(mods.endSessions).toHaveBeenCalledWith("t1", "c1");
    expect(mods.chatbots).not.toHaveBeenCalled();
  });

  it("an ordinary message ends nothing", async () => {
    await receive(typed("hello"));
    expect(mods.endSessions).not.toHaveBeenCalled();
  });
});

describe("tapped replies are never read as STOP", () => {
  it.each([
    ["button_reply", "Cancel"],
    ["button_reply", "End"],
    ["list_reply", "Stop shipping updates"],
    ["list_reply", "Quit"],
  ] as const)("a %s titled %j goes to the chatbot with its id", async (kind, title) => {
    await receive(tapped(kind, "row1", title));
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(mods.endSessions).not.toHaveBeenCalled();
    expect(mods.sendText).not.toHaveBeenCalled();
    expect(mods.chatbots).toHaveBeenCalledWith(expect.objectContaining({ text: title, replyId: "row1" }));
  });

  it("a tapped reply titled Start does not resubscribe an opted-out contact", async () => {
    await receive(tapped("button_reply", "go", "Start"), { optedOutAt: new Date("2026-10-01T00:00:00Z") });
    expect(db.contact.updateMany).not.toHaveBeenCalled();
  });

  it("a quick-reply button from a template still counts as the customer's own words", async () => {
    await receive({ type: "button", button: { text: "Stop", payload: "stop" } });
    expect(db.contact.updateMany).toHaveBeenCalledTimes(1);
    expect(mods.endSessions).toHaveBeenCalledWith("t1", "c1");
  });
});

describe("interactive messages that are not a tapped button or row", () => {
  const flowReply = { type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { name: "flow", response_json: "{}" } } };

  it("carry no words: bots, the AI agent and rules get an empty text, not the placeholder", async () => {
    await receive(flowReply);
    expect(mods.chatbots).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
    expect(mods.chatbots.mock.calls[0][0].replyId).toBeUndefined();
    expect(mods.ai).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
    expect(mods.automations).toHaveBeenCalledWith(expect.objectContaining({ text: "", messageType: "interactive" }));
    expect(db.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "interactive", body: "[interactive]" }) });
  });

  it("a tapped row without a title still carries its id as the words", async () => {
    await receive({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "row9" } } });
    expect(mods.chatbots).toHaveBeenCalledWith(expect.objectContaining({ text: "row9", replyId: "row9" }));
  });
});

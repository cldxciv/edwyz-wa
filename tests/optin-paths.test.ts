import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Opt-in gating for the remaining template paths, each driven through the REAL central gate (sendTemplateMessage in
 * src/lib/inbox/service.ts), never a mock of it: lead sequences, abandoned-cart reminders, approval resend and the inbox template
 * sender. In every case the caller's own pre-check is made to pass (its snapshot of the contact says "opted in", or it compares the
 * category differently), while the database says the contact has not opted in: only the central gate can refuse, and nothing may be
 * queued. Chatbots have their own file (optin-chatbots.test.ts) because that engine needs a larger harness.
 */

const db = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn(), count: vi.fn() });
  return {
    conversation: model(),
    message: model(),
    phoneNumber: model(),
    contact: model(),
    template: model(),
    lead: model(),
    leadSequenceRun: model(),
    abandonedCart: model(),
    shopifyStore: model(),
  };
});
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => ({ enqueue }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: async () => undefined }));
vi.mock("@/lib/chatbots/human-reply", () => ({ stopBotsOnHumanReply: async () => undefined }));
vi.mock("@/lib/chatbots", () => ({ startChatbot: async () => undefined }));
vi.mock("@/lib/leads/assignment", () => ({ assignLeadToConversation: async () => undefined }));
vi.mock("@/lib/commerce/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commerce/settings")>()),
  getSettings: async () => ({ enabled: true, templateId: "tp1", phoneNumberId: "ph1", cartGapsMin: [60, 1440], checkoutGapsMin: [30, 720] }),
}));
vi.mock("@/lib/approvals/index", () => ({ reissueApproval: async () => ({ id: "ap1", url: "https://wa.example.test/approve/x" }) }));

import { resendApproval } from "@/lib/approvals/resend";
import { processCart } from "@/lib/commerce/reminders";
import { sendConversationTemplate } from "@/lib/inbox/template-send";
import { processRun } from "@/lib/leads/runner";

const T = "t1";
const template = (category: string) => ({ id: "tp1", tenantId: T, name: "promo", language: "en", status: "approved", category, components: [{ type: "BODY", text: "Hello" }] });
const notOptedIn = { id: "c1", tenantId: T, phone: "+919876543210", bsuid: null, name: "Asha", optIn: false, optedOutAt: null };
const optedInSnapshot = { ...notOptedIn, optIn: true };

function gateDb(category = "MARKETING") {
  db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
  db.template.findFirst.mockResolvedValue(template(category));
  db.conversation.upsert.mockResolvedValue({ id: "cv1", lastInboundAt: null });
  db.message.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "m1", ...data }));
}
const nothingQueued = () => {
  expect(db.message.create).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of Object.values(db)) for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset();
  gateDb();
});

describe("path: lead sequences", () => {
  const run = (steps: object[]) => ({ id: "run1", tenantId: T, leadId: "l1", stepIndex: 0, createdAt: new Date(), sequence: { enabled: true, steps } });
  const step = { delayMinutes: 0, templateId: "tp1", stopOnReply: false };

  it("a marketing step to a contact who has not opted in is refused by the gate and queues nothing", async () => {
    db.leadSequenceRun.updateMany.mockResolvedValue({ count: 1 });
    db.leadSequenceRun.findUnique.mockResolvedValue(run([step, { ...step, delayMinutes: 5 }]));
    db.lead.findFirst.mockResolvedValue({ id: "l1", tenantId: T, contactId: "c1", status: "new", fields: {} });
    // First read (the runner's snapshot) says opted in; the gate's own read says not.
    db.contact.findFirst.mockResolvedValueOnce(optedInSnapshot).mockResolvedValue(notOptedIn);
    db.conversation.findFirst.mockResolvedValue({ phoneNumberId: "ph1" });
    await expect(processRun("run1")).rejects.toMatchObject({ status: 422 });
    expect(db.contact.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: T } }));
    nothingQueued();
  });

  it("a contact who sent STOP gets no step at all", async () => {
    db.leadSequenceRun.updateMany.mockResolvedValue({ count: 1 });
    db.leadSequenceRun.findUnique.mockResolvedValue(run([step]));
    db.lead.findFirst.mockResolvedValue({ id: "l1", tenantId: T, contactId: "c1", status: "new", fields: {} });
    db.contact.findFirst.mockResolvedValue({ ...notOptedIn, optIn: true, optedOutAt: new Date() });
    await processRun("run1");
    nothingQueued();
  });
});

describe("path: abandoned-cart reminders", () => {
  const cart = { id: "ac1", tenantId: T, storeId: "s1", phone: "+919876543210", items: {}, totalMinor: 49900, currency: "INR", checkoutUrl: "https://shop.example.test/c/1", stage: "cart", remindersSent: 0, nextReminderAt: new Date(), createdAt: new Date() };

  it("a reminder to a contact whose opt-in disappeared after the cart check is refused by the gate", async () => {
    db.shopifyStore.findFirst.mockResolvedValue({ id: "s1" });
    db.conversation.findFirst.mockResolvedValue(null);
    db.abandonedCart.updateMany.mockResolvedValue({ count: 1 });
    db.contact.findFirst.mockResolvedValueOnce(optedInSnapshot).mockResolvedValue(notOptedIn);
    expect(await processCart(cart as never, new Date())).toBe("failed");
    expect(db.contact.findFirst).toHaveBeenCalledTimes(2);
    nothingQueued();
  });

  it("closes the cart as opted_out for a contact without opt-in, before the gate", async () => {
    db.shopifyStore.findFirst.mockResolvedValue({ id: "s1" });
    db.contact.findFirst.mockResolvedValue(notOptedIn);
    db.abandonedCart.updateMany.mockResolvedValue({ count: 1 });
    expect(await processCart(cart as never, new Date())).toBe("opted_out");
    nothingQueued();
  });
});

describe("path: approval resend by template", () => {
  const actor = { tenantId: T, userId: "u1", role: "admin" } as never;

  it("is refused by the gate when the contact has not opted in", async () => {
    // resendApproval checks optIn on its own snapshot first; the gate re-reads the contact.
    db.contact.findFirst.mockResolvedValueOnce({ id: "c1", optIn: true, optedOutAt: null }).mockResolvedValue(notOptedIn);
    await expect(resendApproval(actor, "ap1", { phone: "+919876543210", mode: "template", templateId: "tp1" })).rejects.toMatchObject({ status: 422 });
    nothingQueued();
  });
});

describe("path: inbox template sender", () => {
  const actor = { tenantId: T, userId: "u1" };
  const conversation = { id: "cv1", phoneNumberId: "ph1", contactId: "c1", contact: { optIn: false, optedOutAt: null } };

  it("is refused by the gate for a template whose category the caller does not recognise as marketing", async () => {
    // The sender compares the category exactly ("MARKETING"); the gate is case-insensitive.
    db.conversation.findFirst.mockResolvedValue(conversation);
    db.template.findFirst.mockResolvedValue(template("marketing"));
    db.contact.findFirst.mockResolvedValue(notOptedIn);
    await expect(sendConversationTemplate(actor, "cv1", { templateId: "tp1", variables: [] })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/not opted in/) });
    nothingQueued();
  });

  it("is refused when the gate cannot find the template at all (it fails closed)", async () => {
    db.conversation.findFirst.mockResolvedValue(conversation);
    db.template.findFirst.mockResolvedValueOnce(template("UTILITY")).mockResolvedValue(null);
    db.contact.findFirst.mockResolvedValue(notOptedIn);
    await expect(sendConversationTemplate(actor, "cv1", { templateId: "tp1", variables: [] })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/synced template list/) });
    nothingQueued();
  });
});

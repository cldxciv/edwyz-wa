import { beforeEach, describe, expect, it, vi } from "vitest";

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
  return { conversation: model(), message: model(), phoneNumber: model(), contact: model(), membership: model(), note: model(), quickReply: model(), template: model(), conversationMark: { ...model(), deleteMany: vi.fn() } };
});
const enqueue = vi.hoisted(() => vi.fn());
const graphFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => ({ enqueue }));
// processSendJob gates on the workspace state; its blocked behaviour is covered in tenant-gating-send.test.ts.
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/graph", () => {
  class GraphError extends Error {
    constructor(message: string, public status: number, public code?: number, public subcode?: number, public retryable = false, public ambiguous = false) {
      super(message);
    }
  }
  return { GraphError, graphFetch };
});
// The spend gate is covered by spend-messaging.test.ts and inbox-send.test.ts; here it lets every send through.
const gate = vi.hoisted(() => ({ messagingGate: vi.fn(), finishSend: vi.fn(async () => undefined), releaseMessageSpend: vi.fn(async () => true) }));
vi.mock("@/lib/spend/messaging/gate", () => ({ messagingGate: gate.messagingGate, finishSend: gate.finishSend, releaseMessageSpend: gate.releaseMessageSpend }));

import { GraphError } from "@/lib/graph";
import { isWithinServiceWindow, SERVICE_WINDOW_MS } from "@/lib/inbox/window";
import { processSendJob } from "@/lib/inbox/send";
import { addNote, getConversation, markRead, sendMedia, sendTemplateMessage, sendText, setStatus } from "@/lib/inbox/service";
import { HttpError } from "@/lib/tenancy";

const NOW = new Date("2026-10-26T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("isWithinServiceWindow", () => {
  it("is true at exactly 24 hours and false one millisecond later", () => {
    expect(isWithinServiceWindow(ago(SERVICE_WINDOW_MS), NOW)).toBe(true);
    expect(isWithinServiceWindow(ago(SERVICE_WINDOW_MS + 1), NOW)).toBe(false);
  });
  it("is false with no inbound message and true for a recent one", () => {
    expect(isWithinServiceWindow(null, NOW)).toBe(false);
    expect(isWithinServiceWindow(undefined, NOW)).toBe(false);
    expect(isWithinServiceWindow(ago(60_000), NOW)).toBe(true);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  db.message.create.mockImplementation(async ({ data }) => ({ id: "m1", ...data }));
  gate.messagingGate.mockImplementation(async () => ({ action: "send", origin: "unknown", category: "SERVICE", overLimit: false, observed: false, spend: { mode: "none" }, run: (fn: () => Promise<unknown>) => fn() }));
});

/** What every send job carries for the spend gate (docs/SPEND-CONTROLS-SPEC.md 4.9). */
const FREE_FORM = { origin: "unknown", category: "SERVICE", wabaRefId: null };

describe("sendText / sendMedia", () => {
  it("rejects with 409 outside the 24-hour window and queues nothing", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date(Date.now() - SERVICE_WINDOW_MS - 60_000) });
    const err = await sendText({ tenantId: "t1", origin: "unknown", conversationId: "cv1", userId: "u1", body: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/24-hour/);
    expect(db.message.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();

    const media = await sendMedia({ tenantId: "t1", origin: "unknown", conversationId: "cv1", mediaType: "image", media: "mid" }).catch((e) => e);
    expect(media.status).toBe(409);
  });

  it("rejects when the customer never wrote in", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: null });
    await expect(sendText({ tenantId: "t1", origin: "unknown", conversationId: "cv1", body: "hi" })).rejects.toMatchObject({ status: 409 });
  });

  it("inside the window creates a queued message and a send job", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date(Date.now() - 1000) });
    const message = await sendText({ tenantId: "t1", origin: "unknown", conversationId: "cv1", userId: "u1", body: " hello " });
    expect(db.conversation.findFirst).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1" } });
    expect(message).toMatchObject({ tenantId: "t1", direction: "outbound", status: "queued", body: "hello", sentByUserId: "u1" });
    expect(enqueue).toHaveBeenCalledWith("send", { messageId: "m1", tenantId: "t1", ...FREE_FORM });
    expect((message.statusTimeline as { source?: string }[])[0]).not.toHaveProperty("source");
  });

  it("keeps an optional source marker on the first timeline entry only (used by the admin test panel)", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date(Date.now() - 1000) });
    const message = await sendText({ tenantId: "t1", origin: "unknown", conversationId: "cv1", userId: "u1", body: "hi", source: "admin_test" });
    const timeline = message.statusTimeline as { status: string; at: string; source?: string }[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ status: "queued", source: "admin_test" });
    expect(enqueue).toHaveBeenCalledWith("send", { messageId: "m1", tenantId: "t1", ...FREE_FORM });
  });
});

describe("sendTemplateMessage", () => {
  const send = (overrides: Record<string, unknown> = {}) =>
    sendTemplateMessage({ tenantId: "t1", origin: "unknown", phoneNumberId: "ph1", contactId: "c1", templateName: "promo", language: "en", ...overrides });
  const arrange = (contact: Record<string, unknown>, template: Record<string, unknown> | null) => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
    db.contact.findFirst.mockResolvedValue({ id: "c1", phone: "+919876543210", bsuid: null, ...contact });
    db.template.findFirst.mockResolvedValue(template);
    db.conversation.upsert.mockResolvedValue({ id: "cv1", lastInboundAt: null });
  };

  it("is allowed outside the window and carries the template in the job", async () => {
    arrange({ optIn: true }, { category: "MARKETING" });
    const components = [{ type: "body", parameters: [{ type: "text", text: "Asha" }] }];
    const message = await send({ components });
    expect(message).toMatchObject({ type: "template", templateName: "promo", status: "queued" });
    expect(db.phoneNumber.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ph1", tenantId: "t1" } }));
    expect(db.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: "t1" } }));
    expect(db.template.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", name: "promo", language: "en", wabaRefId: "w1" } }));
    expect(enqueue).toHaveBeenCalledWith("send", { messageId: "m1", tenantId: "t1", template: { name: "promo", language: "en", components }, origin: "unknown", category: "MARKETING", wabaRefId: "w1" });
  });

  it("404s for a contact that belongs to another tenant", async () => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
    db.contact.findFirst.mockResolvedValue(null);
    await expect(send({ contactId: "other", templateName: "p" })).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a marketing template for a contact without opt-in, in the function itself", async () => {
    arrange({ optIn: false }, { category: "MARKETING" });
    await expect(send()).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/not opted in/) });
    expect(db.message.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a marketing template for a contact who opted out, even one with an old opt-in", async () => {
    arrange({ optIn: true, optedOutAt: new Date() }, { category: "MARKETING" });
    await expect(send()).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/opted out of marketing/) });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("an opt-out stops marketing only: utility and login-code templates still go (owner default 1)", async () => {
    arrange({ optIn: false, optedOutAt: new Date() }, { category: "UTILITY" });
    await expect(send()).resolves.toMatchObject({ type: "template" });
    arrange({ optIn: false, optedOutAt: new Date() }, { category: "AUTHENTICATION" });
    await expect(send()).resolves.toMatchObject({ type: "template" });
  });

  it("refuses a template it has no row for to a contact who opted out: an unknown template counts as marketing", async () => {
    arrange({ optIn: true, optedOutAt: new Date() }, null);
    await expect(send()).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/opted out of marketing/) });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("lets utility templates go to a contact without opt-in", async () => {
    arrange({ optIn: false }, { category: "UTILITY" });
    await expect(send()).resolves.toMatchObject({ type: "template" });
  });

  // Changed from "applies only the opt-out rule when the workspace has no row": the central gate now fails closed, because a
  // template it cannot classify might be marketing and a new caller must not be able to bypass opt-in with an unknown name.
  it("treats a template the workspace has no row for as marketing: refused without opt-in", async () => {
    arrange({ optIn: false }, null);
    await expect(send()).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/not in your synced template list/) });
    expect(db.message.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("allows an unknown template for a contact who opted in", async () => {
    arrange({ optIn: true }, null);
    await expect(send()).resolves.toMatchObject({ type: "template" });
  });

  it("uses the category of the same template under another WhatsApp account of the workspace, instead of failing open", async () => {
    arrange({ optIn: false }, null);
    db.template.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ category: "MARKETING" });
    await expect(send()).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/not opted in/) });
    expect(db.template.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { tenantId: "t1", name: "promo", language: "en" } }));
  });

  it("an unknown template is still refused for a contact who opted out", async () => {
    arrange({ optIn: true, optedOutAt: new Date() }, null);
    await expect(send()).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/opted out/) });
  });
});

describe("agent signature, stickers and read marks", () => {
  it("passes the signature in the job and keeps it out of the stored text", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date(Date.now() - 1000) });
    const message = await sendText({ tenantId: "t1", origin: "unknown", conversationId: "cv1", userId: "u1", body: "hi", signature: "Priya" });
    expect(message.body).toBe("hi");
    expect(enqueue).toHaveBeenCalledWith("send", { messageId: "m1", tenantId: "t1", signature: "Priya", ...FREE_FORM });
  });

  it("sends audio and stickers without a caption", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date(Date.now() - 1000) });
    const sticker = await sendMedia({ tenantId: "t1", origin: "unknown", conversationId: "cv1", mediaType: "sticker", media: "meta-media:9", caption: "ignored" });
    expect(sticker).toMatchObject({ type: "sticker", body: null, mediaUrl: "meta-media:9" });
    const audio = await sendMedia({ tenantId: "t1", origin: "unknown", conversationId: "cv1", mediaType: "audio", media: "meta-media:8", caption: "ignored" });
    expect(audio.body).toBeNull();
  });

  it("clears the caller's own unread flag and mention notice when reading", async () => {
    db.conversation.updateMany.mockResolvedValue({ count: 1 });
    await markRead("t1", "cv1", "u9");
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1" }, data: { unreadCount: 0 } });
    expect(db.conversationMark.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", userId: "u9", conversationId: "cv1", kind: { in: ["unread", "mention"] } } });
    db.conversationMark.deleteMany.mockClear();
    await markRead("t1", "cv1");
    expect(db.conversationMark.deleteMany).not.toHaveBeenCalled();
  });

  it("marks the chat for a teammate mentioned in a note, never the author", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1" });
    db.note.create.mockResolvedValue({ id: "n1" });
    db.membership.findMany.mockResolvedValue([
      { userId: "u1", role: "admin", user: { name: "Priya Shah" } },
      { userId: "u2", role: "admin", user: { name: "Rahul Mehta" } },
    ]);
    await addNote("t1", "cv1", "u1", "Please check @Rahul Mehta and @Priya Shah");
    expect(db.conversationMark.upsert).toHaveBeenCalledTimes(1);
    expect(db.conversationMark.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { tenantId: "t1", conversationId: "cv1", userId: "u2", kind: "mention" } }));
    expect(db.membership.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1" } }));
  });

  it("still saves the note when recording mentions fails", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1" });
    db.note.create.mockResolvedValue({ id: "n1" });
    db.membership.findMany.mockRejectedValue(new Error("db down"));
    await expect(addNote("t1", "cv1", "u1", "hello @Rahul")).resolves.toMatchObject({ id: "n1" });
  });
});

describe("origin and category stamps (spend controls 4.9)", () => {
  it("stamps the caller's origin on the Message and the job, and SERVICE for free-form", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date(Date.now() - 1000) });
    const message = await sendText({ tenantId: "t1", conversationId: "cv1", body: "hi", origin: "automation" });
    expect(db.message.create.mock.calls[0][0].data).toMatchObject({ origin: "automation", pricingCategory: "SERVICE" });
    expect(message).toMatchObject({ origin: "automation", pricingCategory: "SERVICE" });
    expect(enqueue).toHaveBeenCalledWith("send", { messageId: "m1", tenantId: "t1", origin: "automation", category: "SERVICE", wabaRefId: null });
  });
  it("an unstamped caller gets origin unknown, which the gate treats as automated", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date(Date.now() - 1000) });
    await sendMedia({ tenantId: "t1", origin: "unknown", conversationId: "cv1", mediaType: "image", media: "meta-media:1" });
    expect(db.message.create.mock.calls[0][0].data).toMatchObject({ origin: "unknown", pricingCategory: "SERVICE" });
  });
  it("prices a template at its category under the number's WABA; an unknown template is MARKETING; a bulk send's hold rides along", async () => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
    db.contact.findFirst.mockResolvedValue({ id: "c1", phone: "+919876543210", bsuid: null, optIn: true });
    db.conversation.upsert.mockResolvedValue({ id: "cv1" });
    db.template.findFirst.mockResolvedValue({ category: "utility" });
    await sendTemplateMessage({ tenantId: "t1", phoneNumberId: "ph1", contactId: "c1", templateName: "order", language: "en", origin: "commerce" });
    expect(enqueue).toHaveBeenLastCalledWith("send", expect.objectContaining({ origin: "commerce", category: "UTILITY", wabaRefId: "w1" }));
    expect(db.message.create.mock.calls.at(-1)![0].data).toMatchObject({ origin: "commerce", pricingCategory: "UTILITY" });
    db.template.findFirst.mockResolvedValue(null);
    await sendTemplateMessage({ tenantId: "t1", phoneNumberId: "ph1", contactId: "c1", templateName: "gone", language: "en", origin: "broadcast", reservationId: "sr_1" });
    expect(enqueue).toHaveBeenLastCalledWith("send", expect.objectContaining({ origin: "broadcast", category: "MARKETING", reservationId: "sr_1" }));
  });
  it("a template synced only under another WABA of the workspace still decides consent, but the send is priced as MARKETING", async () => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
    db.contact.findFirst.mockResolvedValue({ id: "c1", phone: "+919876543210", bsuid: null, optIn: false });
    db.conversation.upsert.mockResolvedValue({ id: "cv1" });
    db.template.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ category: "UTILITY" });
    await sendTemplateMessage({ tenantId: "t1", phoneNumberId: "ph1", contactId: "c1", templateName: "order", language: "en", origin: "commerce" });
    expect(enqueue).toHaveBeenLastCalledWith("send", expect.objectContaining({ origin: "commerce", category: "MARKETING", wabaRefId: "w1" }));
    expect(db.message.create.mock.calls.at(-1)![0].data).toMatchObject({ pricingCategory: "MARKETING" });
  });
});

describe("processSendJob gives back an earlier attempt's reservation when the message ends unsent", () => {
  const reserved = { spendState: "reserved", spendDay: new Date("2026-10-26T00:00:00Z"), estCostMinor: 100n, reservationId: null };
  const row = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    tenantId: "t1",
    conversationId: "cv1",
    type: "template",
    status: "queued",
    wamid: null,
    statusTimeline: [],
    body: null,
    mediaUrl: null,
    mediaMime: null,
    ...reserved,
    conversation: { contact: { id: "c1", phone: "+919876543210", optedOutAt: null }, phoneNumber: { phoneNumberId: "pn1" } },
    ...over,
  });
  const job = { messageId: "m1", tenantId: "t1", template: { name: "promo", language: "en", components: [] } };

  it.each([
    ["opted_out", { conversation: { contact: { id: "c1", phone: "+919876543210", optedOutAt: new Date() }, phoneNumber: { phoneNumberId: "pn1" } } }],
    ["no_recipient", { conversation: { contact: { id: "c1", phone: null, bsuid: null }, phoneNumber: { phoneNumberId: "pn1" } } }],
  ])("%s", async (code, over) => {
    db.message.findFirst.mockResolvedValue(row(over));
    await processSendJob(job);
    expect(gate.releaseMessageSpend).toHaveBeenCalledWith("t1", { id: "m1", ...reserved });
    expect(gate.messagingGate).not.toHaveBeenCalled();
    expect(graphFetch).not.toHaveBeenCalled();
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: code, spendState: "released" }) }));
  });

  it("a message that never reserved is failed without a release", async () => {
    db.message.findFirst.mockResolvedValue(row({ spendState: null, spendDay: null, estCostMinor: null, conversation: { contact: { id: "c1", phone: "+919876543210", optedOutAt: new Date() }, phoneNumber: { phoneNumberId: "pn1" } } }));
    await processSendJob(job);
    expect(gate.releaseMessageSpend).not.toHaveBeenCalled();
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "opted_out" }) }));
  });
});

describe("tenant isolation", () => {
  it("returns 404 for a conversation id from another tenant", async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    db.conversation.updateMany.mockResolvedValue({ count: 0 });
    await expect(getConversation("t1", "foreign")).rejects.toMatchObject({ status: 404 });
    expect(db.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "foreign", tenantId: "t1" } }));
    await expect(markRead("t1", "foreign")).rejects.toMatchObject({ status: 404 });
    await expect(setStatus("t1", "foreign", "open")).rejects.toMatchObject({ status: 404 });
    await expect(sendText({ tenantId: "t1", origin: "unknown", conversationId: "foreign", body: "x" })).rejects.toMatchObject({ status: 404 });
    expect(db.message.findMany).not.toHaveBeenCalled();
  });

  it("filters message pages by tenant", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: null });
    db.message.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const result = await getConversation("t1", "cv1", { limit: 2 });
    expect(db.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", conversationId: "cv1" } }));
    expect(result.messages).toHaveLength(2);
    expect(result.nextCursor).toBe("b");
    expect(result.windowOpen).toBe(false);
  });
});

describe("processSendJob", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    status: "queued",
    wamid: null,
    type: "text",
    body: "hello",
    mediaUrl: null,
    mediaMime: null,
    statusTimeline: [],
    conversation: { contact: { phone: "+919876543210" }, phoneNumber: { phoneNumberId: "meta_phone_1" } },
    ...over,
  });

  it("posts to the phone number's messages edge and stores the wamid", async () => {
    db.message.findFirst.mockResolvedValue(row());
    graphFetch.mockResolvedValue({ messages: [{ id: "wamid.new" }] });
    await processSendJob({ messageId: "m1", tenantId: "t1" });
    expect(gate.messagingGate).toHaveBeenCalledWith("t1", { messageId: "m1", tenantId: "t1" }, expect.objectContaining({ id: "m1" }));
    expect(graphFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        path: "meta_phone_1/messages",
        method: "POST",
        body: expect.objectContaining({ to: "919876543210", type: "text", text: { body: "hello", preview_url: false } }),
      }),
    );
    expect(db.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m1", tenantId: "t1" }, data: expect.objectContaining({ status: "sent", wamid: "wamid.new" }) }),
    );
  });

  it("marks the message failed with the error code on a permanent Graph error", async () => {
    db.message.findFirst.mockResolvedValue(row());
    graphFetch.mockRejectedValue(new GraphError("bad", 400, 131047));
    await processSendJob({ messageId: "m1", tenantId: "t1" });
    expect(db.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "131047" }) }),
    );
  });

  it("marks the message failed as send_unconfirmed (never resends) after an ambiguous failure", async () => {
    db.message.findFirst.mockResolvedValue(row());
    graphFetch.mockRejectedValue(new GraphError("net", 0, undefined, undefined, false, true));
    await processSendJob({ messageId: "m1", tenantId: "t1" });
    expect(graphFetch).toHaveBeenCalledTimes(1);
    expect(db.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorCode: "send_unconfirmed" }) }),
    );
  });

  it("rethrows retryable errors so the queue backs off", async () => {
    db.message.findFirst.mockResolvedValue(row());
    graphFetch.mockRejectedValue(new GraphError("rate", 429, 4, undefined, true));
    await expect(processSendJob({ messageId: "m1", tenantId: "t1" })).rejects.toThrow("rate");
    expect(db.message.updateMany).not.toHaveBeenCalled();
  });

  it("sends template jobs with the stored components and skips messages already sent", async () => {
    db.message.findFirst.mockResolvedValue(row({ type: "template", body: "[template] promo" }));
    graphFetch.mockResolvedValue({ messages: [{ id: "w" }] });
    await processSendJob({ messageId: "m1", tenantId: "t1", template: { name: "promo", language: "en", components: [] } });
    expect(graphFetch.mock.calls[0][0].body).toMatchObject({ type: "template", template: { name: "promo", language: { code: "en" } } });

    graphFetch.mockClear();
    db.message.findFirst.mockResolvedValue(row({ status: "sent", wamid: "w" }));
    await processSendJob({ messageId: "m1", tenantId: "t1" });
    expect(graphFetch).not.toHaveBeenCalled();
  });
});

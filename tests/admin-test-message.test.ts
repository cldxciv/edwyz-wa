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
  return { phoneNumber: model(), accessToken: model(), tenant: model(), contact: model(), conversation: model(), message: model(), template: model(), conversationMark: model() };
});
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
const enqueue = vi.hoisted(() => vi.fn(async () => {}));
const mayRun = vi.hoisted(() => vi.fn(async () => true));
const requireAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/queue", () => ({ enqueue }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: mayRun }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn(async () => {}), getBillingStatus: vi.fn() }));
vi.mock("@/lib/chatbots/human-reply", () => ({ stopBotsOnHumanReply: vi.fn(async () => 0) }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitTagChanges: vi.fn(), emitAutomationEvent: vi.fn() }));
vi.mock("@/lib/admin/auth", () => ({ requirePlatformAdmin: requireAdmin }));

import { GET } from "@/app/api/admin/test-message/[id]/route";
import { getTestMessageStatus, HELD_MESSAGE, NO_CHAT_MESSAGE, NO_TOKEN_MESSAGE, NOT_INLINE_MESSAGE, sendTestMessage, WINDOW_MESSAGE } from "@/lib/admin/service";
import { testFailureBody } from "@/components/admin/helpers";
import { assertWithinLimit } from "@/lib/billing";
import { HttpError } from "@/lib/tenancy";

const ADMIN = "admin-1";
const PHONE = { id: "p1", tenantId: "t1", phoneNumberId: "meta_phone_1", wabaRefId: "w1" };
const TO = "919876543210";
const text = { phoneNumberRef: "p1", to: TO, mode: "text" as const, text: "hello" };
const results = () => auditMock.mock.calls.map((c) => (c as unknown as [{ action: string; meta: { result: string } }])[0]).map((e) => `${e.action}:${e.meta.result}`);
const nothingCreated = () => {
  expect(db.contact.create).not.toHaveBeenCalled();
  expect(db.conversation.create).not.toHaveBeenCalled();
  expect(db.conversation.upsert).not.toHaveBeenCalled();
  expect(db.message.create).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  mayRun.mockResolvedValue(true);
  db.phoneNumber.findUnique.mockResolvedValue(PHONE);
  db.accessToken.findMany.mockResolvedValue([{ tenantId: "t1" }]);
  db.message.create.mockImplementation(async ({ data }) => ({ id: "m1", ...data }));
  db.conversation.updateMany.mockResolvedValue({ count: 1 });
});

describe("sendTestMessage pre-flight", () => {
  it("404s for an unknown number", async () => {
    db.phoneNumber.findUnique.mockResolvedValue(null);
    await expect(sendTestMessage(ADMIN, text)).rejects.toMatchObject({ status: 404 });
    nothingCreated();
  });

  it("the demo workspace without a token is refused with the plain message and records nothing", async () => {
    db.accessToken.findMany.mockResolvedValue([]);
    const err = await sendTestMessage(ADMIN, text).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 409, message: NO_TOKEN_MESSAGE });
    expect(db.accessToken.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: { in: ["t1"] } }) }));
    expect(db.contact.findFirst).not.toHaveBeenCalled();
    nothingCreated();
    expect(results()).toEqual(["admin.test_message:refused"]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", userId: ADMIN, target: "p1", meta: expect.objectContaining({ to: "********3210", mode: "text", reason: NO_TOKEN_MESSAGE }) }));
  });

  it("a suspended or read-only workspace is refused before any row", async () => {
    mayRun.mockResolvedValue(false);
    await expect(sendTestMessage(ADMIN, text)).rejects.toMatchObject({ status: 409, message: HELD_MESSAGE });
    nothingCreated();
  });

  it("plain text to someone who never wrote in says to message the business number first, creating nothing", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    await expect(sendTestMessage(ADMIN, text)).rejects.toMatchObject({ status: 409, message: NO_CHAT_MESSAGE });
    expect(NO_CHAT_MESSAGE).toMatch(/from that phone to the business number first/);
    expect(db.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", phone: "+919876543210" } }));
    nothingCreated();
    expect(results()).toEqual(["admin.test_message:refused"]);
  });

  it("plain text is also refused when the chat exists but the window has closed, and says how to reopen it", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1" });
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date(Date.now() - 25 * 3_600_000) });
    await expect(sendTestMessage(ADMIN, text)).rejects.toMatchObject({ status: 409, message: WINDOW_MESSAGE });
    expect(WINDOW_MESSAGE).toMatch(/message the business number again/);
    nothingCreated();
  });

  it("audits a refusal raised while the contact is being created, such as the contacts plan limit", async () => {
    vi.mocked(assertWithinLimit).mockRejectedValueOnce(new HttpError(402, "Contact limit reached."));
    db.template.findFirst.mockResolvedValue({ name: "hello_world", language: "en_US", status: "approved", components: [{ type: "BODY", text: "Hi" }] });
    db.contact.findFirst.mockResolvedValue(null);
    await expect(sendTestMessage(ADMIN, { phoneNumberRef: "p1", to: TO, mode: "template", text: "", templateId: "tpl1" })).rejects.toMatchObject({ status: 402, message: "Contact limit reached." });
    nothingCreated();
    expect(db.contact.deleteMany).not.toHaveBeenCalled();
    expect(db.conversation.deleteMany).not.toHaveBeenCalled();
    expect(results()).toEqual(["admin.test_message:refused"]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reason: "Contact limit reached." }) }));
  });
});

describe("sendTestMessage through the inbox outbound path", () => {
  it("plain text inside the window reuses the webhook's contact (+digits) and queues a marked Message row sent by the admin", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1", optIn: false, optInSource: null, optInAt: null, optedOutAt: null });
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", tenantId: "t1", lastInboundAt: new Date(Date.now() - 60_000) });
    const result = await sendTestMessage(ADMIN, text);
    expect(result).toEqual({ ok: true, messageId: "m1", conversationId: "cv1", status: "queued" });
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(db.conversation.upsert).not.toHaveBeenCalled();
    expect(db.message.create).toHaveBeenCalledTimes(1);
    const data = db.message.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenantId: "t1", conversationId: "cv1", direction: "outbound", status: "queued", type: "text", body: "hello", sentByUserId: ADMIN });
    expect(data.statusTimeline[0]).toMatchObject({ status: "queued", source: "admin_test" });
    expect(enqueue).toHaveBeenCalledWith("send", { messageId: "m1", tenantId: "t1", origin: "admin_test", category: "SERVICE", wabaRefId: null });
    expect(results()).toEqual(["admin.test_message:queued"]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ messageId: "m1", conversationId: "cv1", result: "queued" }) }));
  });

  const approved = { name: "hello_world", language: "en_US", status: "approved", components: [{ type: "BODY", text: "Hello from the test." }] };
  const template = { phoneNumberRef: "p1", to: TO, mode: "template" as const, text: "", templateId: "tpl1" };

  it("an approved template by id creates contact and chat, then queues the template with its language code and no components", async () => {
    db.template.findFirst.mockResolvedValueOnce(approved).mockResolvedValueOnce({ category: "UTILITY" });
    db.contact.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ id: "c2", optIn: false, optedOutAt: null, phone: "+919876543210", bsuid: null });
    db.contact.create.mockResolvedValue({ id: "c2", optIn: false, optInSource: null, optInAt: null, optedOutAt: null });
    db.conversation.create.mockResolvedValue({ id: "cv2" });
    db.conversation.findFirst.mockResolvedValue({ id: "cv2", tenantId: "t1", lastInboundAt: null });
    db.phoneNumber.findFirst.mockResolvedValue({ id: "p1", wabaRefId: "w1" });

    const result = await sendTestMessage(ADMIN, template);
    expect(result).toEqual({ ok: true, messageId: "m1", conversationId: "cv2", status: "queued" });
    // Scoped to the number's WhatsApp Business Account, which is what the picker shows.
    expect(db.template.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { id: "tpl1", tenantId: "t1", wabaRefId: "w1" } }));
    expect(db.contact.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: "t1", phone: "+919876543210" }) }));
    expect(db.conversation.create).toHaveBeenCalledWith(expect.objectContaining({ data: { tenantId: "t1", phoneNumberId: "p1", contactId: "c2" } }));
    expect(db.conversation.upsert).not.toHaveBeenCalled();
    const data = db.message.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ type: "template", templateName: "hello_world", sentByUserId: ADMIN, conversationId: "cv2" });
    expect(data.statusTimeline[0]).toMatchObject({ status: "queued", source: "admin_test" });
    expect(enqueue).toHaveBeenCalledWith("send", { messageId: "m1", tenantId: "t1", template: { name: "hello_world", language: "en_US", components: [] }, origin: "admin_test", category: "UTILITY", wabaRefId: "w1" });
    expect(db.conversation.deleteMany).not.toHaveBeenCalled();
    expect(db.contact.deleteMany).not.toHaveBeenCalled();
  });

  it("a template that is not approved is refused before any row", async () => {
    db.template.findFirst.mockResolvedValue({ ...approved, status: "pending" });
    await expect(sendTestMessage(ADMIN, template)).rejects.toMatchObject({ status: 409, message: /approved/ });
    nothingCreated();
    db.template.findFirst.mockResolvedValue(null);
    await expect(sendTestMessage(ADMIN, template)).rejects.toMatchObject({ status: 404 });
    nothingCreated();
  });

  it("a template with fill-in values is refused, since the panel sends no components", async () => {
    db.template.findFirst.mockResolvedValue({ ...approved, components: [{ type: "BODY", text: "Hi {{1}}" }] });
    await expect(sendTestMessage(ADMIN, template)).rejects.toMatchObject({ status: 409, message: /needs values/ });
    nothingCreated();
  });

  it("a template with a media header is refused with the Broadcasts pointer, not the inbox one", async () => {
    db.template.findFirst.mockResolvedValue({ ...approved, components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi" }] });
    const err = await sendTestMessage(ADMIN, template).catch((e) => e);
    expect(err).toMatchObject({ status: 409, message: `${NOT_INLINE_MESSAGE} Has a media header. Send it from Broadcasts.` });
    expect(err.message).not.toMatch(/inbox/);
    nothingCreated();
  });

  it("removes the contact and chat it created when the consent rule refuses the send", async () => {
    db.template.findFirst.mockResolvedValueOnce(approved).mockResolvedValueOnce({ category: "MARKETING" });
    db.contact.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ id: "c2", optIn: false, optedOutAt: null, phone: "+919876543210", bsuid: null });
    db.contact.create.mockResolvedValue({ id: "c2", optIn: false, optInSource: null, optInAt: null, optedOutAt: null });
    db.conversation.create.mockResolvedValue({ id: "cv2" });
    db.phoneNumber.findFirst.mockResolvedValue({ id: "p1", wabaRefId: "w1" });
    await expect(sendTestMessage(ADMIN, template)).rejects.toMatchObject({ status: 422, message: /not opted in/ });
    expect(db.message.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.conversation.deleteMany).toHaveBeenCalledWith({ where: { id: "cv2", tenantId: "t1" } });
    expect(db.contact.deleteMany).toHaveBeenCalledWith({ where: { id: "c2", tenantId: "t1" } });
    expect(results()).toEqual(["admin.test_message:refused"]);
  });

  it("keeps a chat the inbound webhook created in the same instant: the create loses on the unique key and the refusal deletes nothing", async () => {
    db.template.findFirst.mockResolvedValueOnce(approved).mockResolvedValueOnce({ category: "MARKETING" });
    // The contact exists (an earlier inbound on another number); no chat on this number at pre-flight time.
    db.contact.findFirst.mockResolvedValue({ id: "c1", optIn: false, optInSource: null, optInAt: null, optedOutAt: null, phone: "+919876543210", bsuid: null });
    db.conversation.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "cv-inbound", tenantId: "t1", lastInboundAt: new Date() });
    db.conversation.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    db.phoneNumber.findFirst.mockResolvedValue({ id: "p1", wabaRefId: "w1" });
    await expect(sendTestMessage(ADMIN, template)).rejects.toMatchObject({ status: 422 });
    expect(db.conversation.create).toHaveBeenCalledTimes(1);
    expect(db.conversation.deleteMany).not.toHaveBeenCalled();
    expect(db.contact.deleteMany).not.toHaveBeenCalled();
    expect(db.conversation.upsert).not.toHaveBeenCalled();
  });
});

describe("getTestMessageStatus", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    conversationId: "cv1",
    status: "sent",
    statusTimeline: [{ status: "queued", at: "2026-10-28T02:00:00.000Z", source: "admin_test" }, { status: "sent", at: "2026-10-28T02:00:02.000Z" }],
    errorCode: null,
    wamid: "wamid.1",
    ...over,
  });

  it("looks the message up by id and the admin who sent it, never by a client-supplied tenant", async () => {
    db.message.findFirst.mockResolvedValue(row());
    const out = await getTestMessageStatus(ADMIN, "m1");
    expect(db.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "m1", direction: "outbound", sentByUserId: ADMIN } }));
    expect(out).toMatchObject({ id: "m1", conversationId: "cv1", status: "sent", wamid: "wamid.1", errorCode: null, hint: null, inboxHref: "/app/inbox?c=cv1" });
    expect(out).not.toHaveProperty("body");
    expect(out.statusTimeline).toHaveLength(2);
  });

  it("404s for an unknown id and for an outbound message that was not an admin test", async () => {
    db.message.findFirst.mockResolvedValue(null);
    await expect(getTestMessageStatus(ADMIN, "nope")).rejects.toMatchObject({ status: 404 });
    db.message.findFirst.mockResolvedValue(row({ statusTimeline: [{ status: "queued", at: "x" }] }));
    await expect(getTestMessageStatus(ADMIN, "m1")).rejects.toMatchObject({ status: 404 });
  });

  it("explains a failure in plain words and says when the worker has not picked it up", async () => {
    db.message.findFirst.mockResolvedValue(row({ status: "failed", errorCode: "131047", wamid: null }));
    const failed = await getTestMessageStatus(ADMIN, "m1");
    expect(failed.hint).toMatch(/24-hour window/);
    db.message.findFirst.mockResolvedValue(row({ status: "failed", errorCode: "131058", wamid: null }));
    expect((await getTestMessageStatus(ADMIN, "m1")).hint).toMatch(/does not document/);
    // An unknown code is named, so the admin has something to send to support (the same sentence the panel builds).
    db.message.findFirst.mockResolvedValue(row({ status: "failed", errorCode: "999999", wamid: null }));
    expect((await getTestMessageStatus(ADMIN, "m1")).hint).toBe(testFailureBody("999999"));
    expect((await getTestMessageStatus(ADMIN, "m1")).hint).toMatch(/error code 999999/);
    db.message.findFirst.mockResolvedValue(row({ status: "queued", wamid: null, statusTimeline: [{ status: "queued", at: "x", source: "admin_test" }] }));
    expect((await getTestMessageStatus(ADMIN, "m1")).hint).toMatch(/background worker/);
  });
});

describe("GET /api/admin/test-message/[id]", () => {
  const call = (id: string) => GET(new Request(`https://wa.edwyz.com/api/admin/test-message/${id}`), { params: Promise.resolve({ id }) });

  it("answers 404 to anyone who is not a verified platform admin, without touching the database", async () => {
    requireAdmin.mockRejectedValue(new HttpError(404, "Not found."));
    const res = await call("m1");
    expect(res.status).toBe(404);
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });

  it("returns the status for the admin's own test send, with no-store headers", async () => {
    requireAdmin.mockResolvedValue({ actor: { userId: ADMIN, tenantId: "t0", role: "owner" }, email: "boss@x.com" });
    db.message.findFirst.mockResolvedValue({ id: "m1", conversationId: "cv1", status: "delivered", statusTimeline: [{ status: "queued", at: "x", source: "admin_test" }], errorCode: null, wamid: "w" });
    const res = await call("m1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toMatchObject({ status: "delivered", hint: null });
    expect(db.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sentByUserId: ADMIN }) }));
  });

  it("rejects an id that is not a row id without a lookup", async () => {
    requireAdmin.mockResolvedValue({ actor: { userId: ADMIN, tenantId: "t0", role: "owner" }, email: "boss@x.com" });
    expect((await call("bad%20id")).status).toBe(404);
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });
});

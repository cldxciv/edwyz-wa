import { beforeEach, describe, expect, it, vi } from "vitest";

const actor = vi.hoisted(() => ({ current: { userId: "u1", tenantId: "t1", role: "agent" as "agent" | "admin" } }));
const marks = vi.hoisted(() => ({ setMark: vi.fn(), listMentions: vi.fn(), flagsFor: vi.fn() }));
const filters = vi.hoisted(() => ({ createSavedFilter: vi.fn(), listSavedFilters: vi.fn(), deleteSavedFilter: vi.fn() }));
const settings = vi.hoisted(() => ({ getInboxSettings: vi.fn(), updateInboxSettings: vi.fn(), signatureForUser: vi.fn() }));
const exporter = vi.hoisted(() => ({ buildChatExport: vi.fn() }));
const newChat = vi.hoisted(() => ({ startChat: vi.fn() }));
const upload = vi.hoisted(() => ({ uploadAttachmentToMeta: vi.fn() }));
const visibility = vi.hoisted(() => ({ assertConversationVisible: vi.fn(), shouldMaskFor: vi.fn(), viewerRules: vi.fn(), rulesToWhere: vi.fn(() => null), inboxScopeWhere: vi.fn(), searchAllowed: vi.fn(), maskContact: vi.fn((c: unknown) => c) }));
const service = vi.hoisted(() => ({ listConversations: vi.fn(), sendText: vi.fn(), sendMedia: vi.fn(), markRead: vi.fn() }));
const content = vi.hoisted(() => ({ saveUpload: vi.fn() }));
const audit = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn() },
  phoneNumber: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => actor.current }));
vi.mock("@/lib/auth/audit", () => ({ audit }));
vi.mock("@/lib/inbox/marks", async (orig) => ({ ...(await orig<typeof import("@/lib/inbox/marks")>()), ...marks }));
vi.mock("@/lib/inbox/filters", async (orig) => ({ ...(await orig<typeof import("@/lib/inbox/filters")>()), ...filters }));
vi.mock("@/lib/inbox/settings", async (orig) => ({ ...(await orig<typeof import("@/lib/inbox/settings")>()), ...settings }));
vi.mock("@/lib/inbox/export", async (orig) => ({ ...(await orig<typeof import("@/lib/inbox/export")>()), ...exporter }));
vi.mock("@/lib/inbox/new-chat", () => newChat);
vi.mock("@/lib/inbox/upload", () => upload);
vi.mock("@/lib/teams/visibility", () => visibility);
vi.mock("@/lib/inbox/service", async (orig) => ({ ...(await orig<typeof import("@/lib/inbox/service")>()), ...service }));
vi.mock("@/lib/inbox/status", async (orig) => ({ ...(await orig<typeof import("@/lib/inbox/status")>()), assertCanActOnConversation: async () => undefined }));
vi.mock("@/lib/inbox/stream", () => ({ countUnreadConversations: async () => 3 }));
vi.mock("@/lib/content/media", async (orig) => ({ ...(await orig<typeof import("@/lib/content/media")>()), saveUpload: content.saveUpload, mediaExists: vi.fn(), mediaPublicUrl: vi.fn() }));

import { POST as attach } from "@/app/api/inbox/conversations/[id]/attachments/route";
import { GET as exportRoute } from "@/app/api/inbox/conversations/[id]/export/route";
import { PUT as marksRoute } from "@/app/api/inbox/conversations/[id]/marks/route";
import { POST as messagesRoute } from "@/app/api/inbox/conversations/[id]/messages/route";
import { POST as readRoute } from "@/app/api/inbox/conversations/[id]/read/route";
import { GET as listRoute, POST as newChatRoute } from "@/app/api/inbox/conversations/route";
import { DELETE as deleteFilter } from "@/app/api/inbox/filters/[id]/route";
import { GET as listFilters, POST as createFilter } from "@/app/api/inbox/filters/route";
import { GET as mentionsRoute } from "@/app/api/inbox/mentions/route";
import { GET as numbersRoute } from "@/app/api/inbox/numbers/route";
import { GET as getSettings, PUT as putSettings } from "@/app/api/inbox/settings/route";
import { templatesForWaba, wabaOf } from "@/components/inbox/ux";

const ORIGIN = "https://wa.edwyz.com";
const ctx = { params: Promise.resolve({ id: "cv1" }) };
const send = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/x`, { method, headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (path = "/x") => new Request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN } });

beforeEach(() => {
  vi.clearAllMocks();
  actor.current = { userId: "u1", tenantId: "t1", role: "agent" };
  visibility.viewerRules.mockResolvedValue({ maskPhone: false });
  visibility.inboxScopeWhere.mockResolvedValue({});
  visibility.searchAllowed.mockReturnValue(true);
  visibility.shouldMaskFor.mockResolvedValue(false);
  visibility.assertConversationVisible.mockResolvedValue(undefined);
  service.listConversations.mockResolvedValue({ items: [], nextCursor: null });
  settings.signatureForUser.mockResolvedValue(undefined);
});

describe("GET /api/inbox/conversations", () => {
  it("passes the view and the signed-in agent so favourites, flags and labels are the caller's own", async () => {
    const res = await listRoute(get("/x?view=favorite&q=invoice&tag=vip"));
    expect(res.status).toBe(200);
    expect(service.listConversations).toHaveBeenCalledWith("t1", expect.objectContaining({ view: "favorite", viewerId: "u1", search: "invoice", tag: "vip" }));
    expect((await res.json()).unreadConversations).toBe(3);
  });
});

describe("POST /api/inbox/conversations (new chat)", () => {
  it("starts a chat for the caller and returns 201", async () => {
    newChat.startChat.mockResolvedValue({ conversation: { id: "cv9", contactId: "c9" }, message: { id: "m1" } });
    const res = await newChatRoute(send("POST", { phone: "+919876543210", templateId: "tp1", variables: ["Asha"] }));
    expect(res.status).toBe(201);
    expect(newChat.startChat).toHaveBeenCalledWith(actor.current, { phone: "+919876543210", templateId: "tp1", variables: ["Asha"] });
    expect((await res.json()).conversation.id).toBe("cv9");
  });

  it("rejects cross-site posts and passes service refusals through", async () => {
    expect((await newChatRoute(send("POST", {}, { origin: "https://evil.example" }))).status).toBe(403);
    expect(newChat.startChat).not.toHaveBeenCalled();
    newChat.startChat.mockRejectedValue(Object.assign(new Error("x"), { name: "HttpError", status: 422 }));
    const { HttpError } = await import("@/lib/tenancy");
    newChat.startChat.mockRejectedValue(new HttpError(422, "This contact has opted out of messages."));
    const res = await newChatRoute(send("POST", { phone: "+919876543210", templateId: "tp1" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/opted out/);
  });
});

describe("PUT marks", () => {
  it("sets the caller's own favourite and unread markers", async () => {
    const res = await marksRoute(send("PUT", { favorite: true, unread: false }), ctx);
    expect(res.status).toBe(200);
    expect(visibility.assertConversationVisible).toHaveBeenCalledWith(actor.current, "cv1");
    expect(marks.setMark).toHaveBeenCalledWith("t1", "u1", "cv1", "favorite", true);
    expect(marks.setMark).toHaveBeenCalledWith("t1", "u1", "cv1", "unread", false);
  });

  it("validates the body and the origin, and writes nothing for a chat the caller cannot see", async () => {
    expect((await marksRoute(send("PUT", {}), ctx)).status).toBe(400);
    expect((await marksRoute(send("PUT", { favorite: "yes" }), ctx)).status).toBe(400);
    expect((await marksRoute(send("PUT", { favorite: true }, { origin: "https://evil.example" }), ctx)).status).toBe(403);
    const { HttpError } = await import("@/lib/tenancy");
    visibility.assertConversationVisible.mockRejectedValue(new HttpError(404, "Conversation not found."));
    expect((await marksRoute(send("PUT", { favorite: true }), ctx)).status).toBe(404);
    expect(marks.setMark).not.toHaveBeenCalled();
  });
});

describe("read", () => {
  it("passes the caller so their unread flag and mention notice are cleared", async () => {
    await readRoute(send("POST", {}), ctx);
    expect(service.markRead).toHaveBeenCalledWith("t1", "cv1", "u1");
  });
});

describe("export", () => {
  const file = { fileName: "chat-asha-2026-10-27.txt", contentType: "text/plain; charset=utf-8", body: "hello\n", count: 2 };

  it("returns the chat as a private download and audits it without content", async () => {
    exporter.buildChatExport.mockResolvedValue(file);
    const res = await exportRoute(get("/x?format=txt"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="chat-asha-2026-10-27.txt"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("hello\n");
    expect(exporter.buildChatExport).toHaveBeenCalledWith("t1", "cv1", { format: "txt", includeNotes: false, masked: false });
    expect(audit).toHaveBeenCalledWith({ tenantId: "t1", userId: "u1", action: "inbox.chat.exported", target: "cv1", meta: { format: "txt", items: 2, notes: false } });
  });

  it("includes notes only on request, masks numbers for masked agents, and refuses unknown formats", async () => {
    exporter.buildChatExport.mockResolvedValue(file);
    visibility.shouldMaskFor.mockResolvedValue(true);
    await exportRoute(get("/x?format=json&notes=1"), ctx);
    expect(exporter.buildChatExport).toHaveBeenCalledWith("t1", "cv1", { format: "json", includeNotes: true, masked: true });
    expect((await exportRoute(get("/x?format=pdf"), ctx)).status).toBe(400);
  });

  it("does not export a chat the caller cannot see", async () => {
    const { HttpError } = await import("@/lib/tenancy");
    visibility.assertConversationVisible.mockRejectedValue(new HttpError(404, "Conversation not found."));
    expect((await exportRoute(get("/x"), ctx)).status).toBe(404);
    expect(exporter.buildChatExport).not.toHaveBeenCalled();
  });
});

describe("saved views", () => {
  it("lists, creates and deletes through the service with the caller", async () => {
    filters.listSavedFilters.mockResolvedValue([{ id: "f1" }]);
    expect((await (await listFilters(get())).json()).filters).toEqual([{ id: "f1" }]);
    expect(filters.listSavedFilters).toHaveBeenCalledWith("t1", "u1");
    filters.createSavedFilter.mockResolvedValue({ id: "f2", name: "VIP" });
    const created = await createFilter(send("POST", { name: "VIP", query: { tab: "all" } }));
    expect(created.status).toBe(201);
    expect(filters.createSavedFilter).toHaveBeenCalledWith(actor.current, { name: "VIP", query: { tab: "all" } });
    expect((await deleteFilter(send("DELETE"), { params: Promise.resolve({ id: "f2" }) })).status).toBe(200);
    expect(filters.deleteSavedFilter).toHaveBeenCalledWith(actor.current, "f2");
    expect((await createFilter(send("POST", {}, { origin: "https://evil.example" }))).status).toBe(403);
  });
});

describe("inbox settings", () => {
  it("lets any member read them", async () => {
    settings.getInboxSettings.mockResolvedValue({ agentSignature: true, optOutReply: "a", optInReply: "b" });
    expect((await (await getSettings(get())).json()).settings.agentSignature).toBe(true);
    expect(settings.getInboxSettings).toHaveBeenCalledWith("t1");
  });

  it("lets only admins change them, validates the body, and audits the field names", async () => {
    expect((await putSettings(send("PUT", { agentSignature: true }))).status).toBe(403);
    expect(settings.updateInboxSettings).not.toHaveBeenCalled();
    actor.current = { userId: "u1", tenantId: "t1", role: "admin" };
    settings.updateInboxSettings.mockResolvedValue({ agentSignature: true, optOutReply: "a", optInReply: "b" });
    const res = await putSettings(send("PUT", { agentSignature: true }));
    expect(res.status).toBe(200);
    expect(settings.updateInboxSettings).toHaveBeenCalledWith("t1", { agentSignature: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "inbox.settings.updated", meta: { fields: "agentSignature" } }));
    expect((await putSettings(send("PUT", { agentSignature: "yes" }))).status).toBe(400);
    expect((await putSettings(send("PUT", {}))).status).toBe(400);
  });
});

describe("mentions and numbers", () => {
  it("lists only the caller's own mentions", async () => {
    marks.listMentions.mockResolvedValue([{ conversationId: "cv1" }]);
    const res = await mentionsRoute(get());
    expect((await res.json()).mentions).toEqual([{ conversationId: "cv1" }]);
    expect(marks.listMentions).toHaveBeenCalledWith(actor.current);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("lists the workspace's connected numbers", async () => {
    db.phoneNumber.findMany.mockResolvedValue([{ id: "ph1", displayPhone: "+91 11", verifiedName: "Shop" }]);
    expect((await (await numbersRoute(get())).json()).numbers).toHaveLength(1);
    expect(db.phoneNumber.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", status: "connected" } }));
  });

  it("says which WhatsApp Business Account each number belongs to, so the new-chat dialog can offer only its templates", async () => {
    db.phoneNumber.findMany.mockResolvedValue([{ id: "ph1", displayPhone: "+91 11", verifiedName: "Shop", wabaRefId: "w1" }]);
    const { numbers } = await (await numbersRoute(get())).json();
    expect(db.phoneNumber.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ wabaRefId: true }) }));
    expect(wabaOf(numbers[0])).toBe("w1");
    const templates = [{ id: "a", wabaRefId: "w1" }, { id: "b", wabaRefId: "w2" }];
    expect(templatesForWaba(templates, wabaOf(numbers[0]))?.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("attachments route", () => {
  const upload2 = (type: string, extra: Record<string, string> = {}) => new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "content-type": type, ...extra }, body: "bytes" });

  beforeEach(() => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1" });
    content.saveUpload.mockResolvedValue({ key: "k.png", kind: "image", bytes: 5 });
    upload.uploadAttachmentToMeta.mockResolvedValue({ mediaId: "99", kind: "document", mime: "application/pdf", bytes: 5, filename: "a.pdf" });
  });

  it("sends JPEG, PNG and MP4 straight to WhatsApp too, never into the media library and its 500-file limit", async () => {
    upload.uploadAttachmentToMeta.mockResolvedValueOnce({ mediaId: "77", kind: "image", mime: "image/png", bytes: 5, filename: "a.png" });
    const res = await attach(upload2("image/png", { "content-length": "5" }), ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ mediaId: "77", kind: "image", mime: "image/png", bytes: 5, filename: "a.png" });
    upload.uploadAttachmentToMeta.mockResolvedValueOnce({ mediaId: "78", kind: "video", mime: "video/mp4", bytes: 5, filename: "a.mp4" });
    expect((await attach(upload2("video/mp4"), ctx)).status).toBe(201);
    expect(upload.uploadAttachmentToMeta).toHaveBeenCalledTimes(2);
    expect(content.saveUpload).not.toHaveBeenCalled();
  });

  it("sends documents, audio and stickers straight to WhatsApp", async () => {
    const res = await attach(upload2("application/pdf", { "x-file-name": "a.pdf" }), ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ mediaId: "99", kind: "document" });
    expect(upload.uploadAttachmentToMeta).toHaveBeenCalledWith("t1", "cv1", expect.any(Request));
    expect(content.saveUpload).not.toHaveBeenCalled();
  });

  it("checks the chat is the caller's before reading any bytes", async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    expect((await attach(upload2("application/pdf"), ctx)).status).toBe(404);
    expect(upload.uploadAttachmentToMeta).not.toHaveBeenCalled();
    expect(db.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "cv1", tenantId: "t1" } }));
  });
});

describe("messages route: uploaded files, stickers and the signature", () => {
  it("sends an uploaded document by its WhatsApp media id", async () => {
    service.sendMedia.mockResolvedValue({ id: "m1" });
    const res = await messagesRoute(send("POST", { type: "document", mediaId: "99", filename: "a.pdf", mime: "application/pdf", caption: "invoice" }), ctx);
    expect(res.status).toBe(201);
    expect(service.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", conversationId: "cv1", mediaType: "document", media: "meta-media:99", filename: "a.pdf", mime: "application/pdf", caption: "invoice" }),
    );
  });

  it("accepts stickers and audio, and refuses a bad media id or an unknown type", async () => {
    service.sendMedia.mockResolvedValue({ id: "m1" });
    expect((await messagesRoute(send("POST", { type: "sticker", mediaId: "7" }), ctx)).status).toBe(201);
    expect((await messagesRoute(send("POST", { type: "audio", mediaId: "8" }), ctx)).status).toBe(201);
    expect((await messagesRoute(send("POST", { type: "audio", mediaId: "../etc" }), ctx)).status).toBe(400);
    expect((await messagesRoute(send("POST", { type: "gif", mediaId: "1" }), ctx)).status).toBe(400);
  });

  it("hands the upload's preview copy to the sent message", async () => {
    const media = await import("@/lib/inbox/media");
    const adopt = vi.spyOn(media, "adoptPendingUpload");
    service.sendMedia.mockResolvedValue({ id: "m-sent" });
    expect((await messagesRoute(send("POST", { type: "image", mediaId: "4242", mime: "image/jpeg" }), ctx)).status).toBe(201);
    expect(service.sendMedia).toHaveBeenLastCalledWith(expect.objectContaining({ mediaType: "image", media: "meta-media:4242", mime: "image/jpeg" }));
    expect(adopt).toHaveBeenCalledWith("t1", "4242", "m-sent");
    adopt.mockRestore();
  });

  it("limits each person to 60 sends a minute, whatever the type", async () => {
    actor.current = { userId: "u-busy", tenantId: "t1", role: "agent" };
    service.sendText.mockResolvedValue({ id: "m1" });
    for (let i = 0; i < 60; i++) expect((await messagesRoute(send("POST", { type: "text", body: `hi ${i}` }), ctx)).status).toBe(201);
    const over = await messagesRoute(send("POST", { type: "text", body: "one more" }), ctx);
    expect(over.status).toBe(429);
    expect((await over.json()).error).toMatch(/Wait a minute/);
    expect(service.sendText).toHaveBeenCalledTimes(60);
    // Someone else in the same workspace is not held back.
    actor.current = { userId: "u-calm", tenantId: "t1", role: "agent" };
    expect((await messagesRoute(send("POST", { type: "text", body: "hello" }), ctx)).status).toBe(201);
  });

  it("adds the agent's name to text messages only when the workspace turned it on", async () => {
    service.sendText.mockResolvedValue({ id: "m1" });
    await messagesRoute(send("POST", { type: "text", body: "hello" }), ctx);
    expect(service.sendText).toHaveBeenLastCalledWith(expect.objectContaining({ body: "hello", signature: undefined }));
    settings.signatureForUser.mockResolvedValue("Priya Shah");
    await messagesRoute(send("POST", { type: "text", body: "hello" }), ctx);
    expect(settings.signatureForUser).toHaveBeenCalledWith("t1", "u1");
    expect(service.sendText).toHaveBeenLastCalledWith(expect.objectContaining({ signature: "Priya Shah" }));
  });
});

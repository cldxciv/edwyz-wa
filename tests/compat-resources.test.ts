import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(), create: vi.fn() });
  return { apiKey: model(), contact: model(), conversation: model(), message: model(), template: model(), membership: model(), auditLog: model() };
});
const services = vi.hoisted(() => ({
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
  setStatus: vi.fn(),
  assign: vi.fn(),
  setTags: vi.fn(),
  listTemplates: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => ({ assertTenantCanWrite: vi.fn(async () => undefined), assertWithinLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/contacts/service", () => ({ updateContact: services.updateContact, deleteContact: services.deleteContact }));
vi.mock("@/lib/inbox/status", () => ({ setStatus: services.setStatus }));
vi.mock("@/lib/inbox/service", () => ({ assign: services.assign, setTags: services.setTags, CONVERSATION_STATUSES: ["open", "pending", "solved", "blocked"] }));
vi.mock("@/lib/templates/service", () => ({ listTemplates: services.listTemplates }));

import { GET as getCount } from "@/app/api/ext/v3/contacts/count/route";
import { DELETE as deleteContact, PUT as putContact } from "@/app/api/ext/v3/contacts/[target]/route";
import { PUT as putAttributes } from "@/app/api/ext/v3/contacts/[target]/attributes/route";
import { DELETE as deleteContactTag } from "@/app/api/ext/v3/contacts/[target]/tags/[tag]/route";
import { GET as listConversations } from "@/app/api/ext/v3/conversations/route";
import { GET as getConversation } from "@/app/api/ext/v3/conversations/[target]/route";
import { GET as listMessages } from "@/app/api/ext/v3/conversations/[target]/messages/route";
import { PUT as putAssignee } from "@/app/api/ext/v3/conversations/[target]/assignee/route";
import { PUT as putStatus } from "@/app/api/ext/v3/conversations/[target]/status/route";
import { POST as postConversationTags } from "@/app/api/ext/v3/conversations/[target]/tags/route";
import { DELETE as deleteConversationTag } from "@/app/api/ext/v3/conversations/[target]/tags/[tag]/route";
import { GET as getTemplate } from "@/app/api/ext/v3/messageTemplates/[id]/route";
import { GET as listTemplates } from "@/app/api/ext/v3/messageTemplates/route";
import { resetCompatLimits } from "@/lib/compat/runtime";
import { generateApiKey } from "@/lib/integrations/apikeys";
import { HttpError } from "@/lib/tenancy";

const KEY = generateApiKey();
let scopes: string[] = [];
const req = (p: string, init: { method?: string; body?: unknown } = {}) =>
  new Request(`https://wa.edwyz.com/api/ext/v3${p}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${KEY.key}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const contact = (over: Record<string, unknown> = {}) => ({
  id: "c1", tenantId: "t1", phone: "+919876543210", bsuid: null, username: null, waId: null, name: "Asha", tags: ["vip", "pune"], attributes: { city: "Pune" },
  optIn: true, optedOutAt: null, createdAt: new Date("2026-01-01T00:00:00Z"), ...over,
});
const conversation = (over: Record<string, unknown> = {}) => ({
  id: "cv1", tenantId: "t1", contactId: "c1", status: "open", tags: ["hot"], unreadCount: 2, assignedToId: null, teamId: null,
  lastMessageAt: new Date("2026-10-27T10:00:00Z"), lastInboundAt: new Date(), firstAgentReplyAt: null, lastAgentReplyAt: null, createdAt: new Date("2026-10-01T00:00:00Z"),
  contact: contact(), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetCompatLimits();
  scopes = ["contacts:write", "conversations:write", "templates:read"];
  db.apiKey.findUnique.mockImplementation(async ({ where }) => (where.keyHash === KEY.hash ? { id: "k1", tenantId: "t1", keyHash: KEY.hash, scopes, revokedAt: null, lastUsedAt: new Date(), createdByUserId: "u1" } : null));
  db.membership.findUnique.mockResolvedValue({ user: { disabledAt: null }, tenant: { deletedAt: null, status: "active" } });
  db.contact.findFirst.mockResolvedValue(contact());
  db.conversation.findFirst.mockResolvedValue(conversation());
});

describe("contacts: count, update, attributes, tags, delete", () => {
  it("counts the workspace's contacts, optionally by tag, scoped to the key's workspace", async () => {
    db.contact.count.mockResolvedValue(42);
    const res = await getCount(req("/contacts/count?tag=vip"));
    expect(await res.json()).toMatchObject({ ok: true, count: 42 });
    expect(db.contact.count.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", tags: { has: "vip" } });
  });

  it("updates name, tags and attributes through the shared service, merging attributes", async () => {
    services.updateContact.mockResolvedValue(contact({ name: "Asha K", tags: ["gold"], attributes: { city: "Pune", plan: "pro" } }));
    const res = await putContact(req("/contacts/c1", { method: "PUT", body: { name: "Asha K", tags: ["gold"], custom_params: [{ name: "plan", value: "pro" }] } }), ctx({ target: "c1" }));
    expect(res.status).toBe(200);
    const [actor, id, patch] = services.updateContact.mock.calls[0];
    expect(actor).toMatchObject({ tenantId: "t1" });
    expect(id).toBe("c1");
    expect(patch).toMatchObject({ name: "Asha K", tags: ["gold"], attributes: { city: "Pune", plan: "pro" } });
    expect((await res.json()).contact.tags).toEqual(["gold"]);
  });

  it("refuses an empty update and an unknown contact", async () => {
    expect((await putContact(req("/contacts/c1", { method: "PUT", body: {} }), ctx({ target: "c1" }))).status).toBe(400);
    db.contact.findFirst.mockResolvedValue(null);
    expect((await putContact(req("/contacts/nope", { method: "PUT", body: { name: "x" } }), ctx({ target: "nope" }))).status).toBe(404);
    expect(services.updateContact).not.toHaveBeenCalled();
  });

  it("merges attributes only and removes one with a null value", async () => {
    services.updateContact.mockResolvedValue(contact({ attributes: {} }));
    await putAttributes(req("/contacts/c1/attributes", { method: "PUT", body: { custom_params: [{ name: "city", value: null }] } }), ctx({ target: "c1" }));
    expect(services.updateContact.mock.calls[0][2]).toEqual({ attributes: {} });
    expect((await putAttributes(req("/contacts/c1/attributes", { method: "PUT", body: {} }), ctx({ target: "c1" }))).status).toBe(400);
  });

  it("removes one tag and keeps the others", async () => {
    services.updateContact.mockResolvedValue(contact({ tags: ["pune"] }));
    await deleteContactTag(req("/contacts/c1/tags/vip", { method: "DELETE" }), ctx({ target: "c1", tag: "vip" }));
    expect(services.updateContact.mock.calls[0][2]).toEqual({ tags: ["pune"] });
  });

  it("deletes a contact and audits it, and needs the write scope", async () => {
    services.deleteContact.mockResolvedValue(undefined);
    const res = await deleteContact(req("/contacts/c1", { method: "DELETE" }), ctx({ target: "c1" }));
    expect(res.status).toBe(200);
    expect(services.deleteContact).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }), "c1");
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", action: "compat.contact.deleted", target: "c1" });
    scopes = ["contacts:read"];
    services.deleteContact.mockClear();
    const denied = await deleteContact(req("/contacts/c1", { method: "DELETE" }), ctx({ target: "c1" }));
    expect(denied.status).toBe(403);
    expect(services.deleteContact).not.toHaveBeenCalled();
  });

  it("a write scope also reads: contacts:write alone can count", async () => {
    scopes = ["contacts:write"];
    db.contact.count.mockResolvedValue(1);
    expect((await getCount(req("/contacts/count"))).status).toBe(200);
  });
});

describe("conversations: list, get, history, status, assignee, tags", () => {
  it("lists conversations with the paging envelope, filtered by status within the workspace", async () => {
    db.conversation.findMany.mockResolvedValue([conversation()]);
    db.conversation.count.mockResolvedValue(1);
    const res = await listConversations(req("/conversations?status=open&page_size=5"));
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, page_size: 5, total: 1, has_more: false });
    expect(json.conversation_list[0]).toMatchObject({ id: "cv1", status: "open", window_open: true, assigned_to: null, contact: { id: "c1", phone_number: "+919876543210" } });
    expect(db.conversation.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", status: "open" });
    expect((await listConversations(req("/conversations?status=weird"))).status).toBe(400);
  });

  it("gets one conversation by id or by the contact's phone number", async () => {
    const byId = await getConversation(req("/conversations/cv1"), ctx({ target: "cv1" }));
    expect((await byId.json()).conversation.id).toBe("cv1");
    db.conversation.findFirst.mockImplementation(async ({ where }) => (where.contactId ? conversation() : null));
    const byPhone = await getConversation(req("/conversations/919876543210"), ctx({ target: "919876543210" }));
    expect(byPhone.status).toBe(200);
    expect(db.conversation.findFirst.mock.calls.at(-1)?.[0].where).toMatchObject({ tenantId: "t1", contactId: "c1" });
    db.conversation.findFirst.mockResolvedValue(null);
    db.contact.findFirst.mockResolvedValue(null);
    expect((await getConversation(req("/conversations/zzz"), ctx({ target: "zzz" }))).status).toBe(404);
  });

  it("returns message history newest first for a conversation id, scoped to the workspace", async () => {
    db.message.findMany.mockResolvedValue([
      { id: "m2", direction: "outbound", type: "text", body: "Hello", status: "read", createdAt: new Date("2026-10-27T10:01:00Z"), templateName: null, conversationId: "cv1" },
      { id: "m1", direction: "inbound", type: "text", body: "Hi", status: "received", createdAt: new Date("2026-10-27T10:00:00Z"), templateName: null, conversationId: "cv1" },
    ]);
    db.message.count.mockResolvedValue(2);
    const res = await listMessages(req("/conversations/cv1/messages"), ctx({ target: "cv1" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.message_list).toHaveLength(2);
    expect(json).toMatchObject({ total: 2, has_more: false });
    expect(db.message.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", conversation: { id: "cv1", tenantId: "t1" } });
    expect(db.message.findMany.mock.calls[0][0].orderBy[0]).toEqual({ createdAt: "desc" });
  });

  it("changes status through the inbox rules and reports the new state", async () => {
    services.setStatus.mockResolvedValue(undefined);
    db.conversation.findFirst.mockResolvedValue(conversation({ status: "solved" }));
    const res = await putStatus(req("/conversations/cv1/status", { method: "PUT", body: { status: "solved" } }), ctx({ target: "cv1" }));
    expect(res.status).toBe(200);
    expect(services.setStatus).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", role: "admin" }), "cv1", "solved");
    expect((await res.json()).conversation.status).toBe("solved");
    expect((await putStatus(req("/x", { method: "PUT", body: {} }), ctx({ target: "cv1" }))).status).toBe(400);
  });

  it("passes the inbox error through when a status change is not allowed", async () => {
    services.setStatus.mockRejectedValue(new HttpError(400, "Invalid status."));
    const res = await putStatus(req("/x", { method: "PUT", body: { status: "bogus" } }), ctx({ target: "cv1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("Invalid status.");
  });

  it("assigns and unassigns, validating the body", async () => {
    services.assign.mockResolvedValue(undefined);
    await putAssignee(req("/x", { method: "PUT", body: { user_id: "u2" } }), ctx({ target: "cv1" }));
    expect(services.assign).toHaveBeenCalledWith("t1", "cv1", "u2");
    await putAssignee(req("/x", { method: "PUT", body: { user_id: null } }), ctx({ target: "cv1" }));
    expect(services.assign).toHaveBeenLastCalledWith("t1", "cv1", null);
    expect((await putAssignee(req("/x", { method: "PUT", body: {} }), ctx({ target: "cv1" }))).status).toBe(400);
    expect((await putAssignee(req("/x", { method: "PUT", body: { user_id: 5 } }), ctx({ target: "cv1" }))).status).toBe(400);
  });

  it("adds tags keeping the existing ones and removes one", async () => {
    services.setTags.mockResolvedValue(undefined);
    await postConversationTags(req("/x", { method: "POST", body: { tags: ["vip", "hot"] } }), ctx({ target: "cv1" }));
    expect(services.setTags).toHaveBeenCalledWith("t1", "cv1", ["hot", "vip"]);
    await deleteConversationTag(req("/x", { method: "DELETE" }), ctx({ target: "cv1", tag: "hot" }));
    expect(services.setTags).toHaveBeenLastCalledWith("t1", "cv1", []);
    expect((await postConversationTags(req("/x", { method: "POST", body: { tags: [] } }), ctx({ target: "cv1" }))).status).toBe(400);
    expect((await postConversationTags(req("/x", { method: "POST", body: { tags: ["x".repeat(41)] } }), ctx({ target: "cv1" }))).status).toBe(400);
  });

  it("changing a conversation needs conversations:write, reading needs only the read scope", async () => {
    scopes = ["conversations:read"];
    db.conversation.findMany.mockResolvedValue([]);
    db.conversation.count.mockResolvedValue(0);
    expect((await listConversations(req("/conversations"))).status).toBe(200);
    const denied = await putStatus(req("/x", { method: "PUT", body: { status: "solved" } }), ctx({ target: "cv1" }));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.message).toBe("This API key needs the conversations:write scope.");
    expect(services.setStatus).not.toHaveBeenCalled();
  });
});

describe("templates: list and get", () => {
  const tpl = { id: "tp1", name: "hello", language: "en", category: "UTILITY", status: "approved", components: [{ type: "BODY", text: "Hi {{1}}" }], rejectionReason: null, createdAt: new Date("2026-01-01T00:00:00Z") };

  it("lists templates with paging and rejects an unknown status filter", async () => {
    services.listTemplates.mockResolvedValue([tpl]);
    const json = await (await listTemplates(req("/messageTemplates?status=approved"))).json();
    expect(json).toMatchObject({ ok: true, total: 1, has_more: false });
    expect(json.message_template_list[0]).toMatchObject({ id: "tp1", name: "hello", status: "approved", rejection_reason: null });
    expect(services.listTemplates).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }), { status: "approved" });
    expect((await listTemplates(req("/messageTemplates?status=weird"))).status).toBe(400);
  });

  it("gets one template of this workspace, or 404", async () => {
    db.template.findFirst.mockResolvedValue(tpl);
    const res = await getTemplate(req("/messageTemplates/tp1"), ctx({ id: "tp1" }));
    expect((await res.json()).message_template).toMatchObject({ id: "tp1", components: tpl.components });
    expect(db.template.findFirst).toHaveBeenCalledWith({ where: { id: "tp1", tenantId: "t1" } });
    db.template.findFirst.mockResolvedValue(null);
    expect((await getTemplate(req("/messageTemplates/zz"), ctx({ id: "zz" }))).status).toBe(404);
  });

  it("a key that may send messages may also list templates", async () => {
    scopes = ["messages:write"];
    services.listTemplates.mockResolvedValue([]);
    expect((await listTemplates(req("/messageTemplates"))).status).toBe(200);
  });
});

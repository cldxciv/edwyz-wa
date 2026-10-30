import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() });
  return { contact: model(), conversation: model(), conversationMark: model(), phoneNumber: model() };
});
const hooks = vi.hoisted(() => ({ audit: vi.fn(), send: vi.fn(), visible: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit: hooks.audit }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inbox/template-send", () => ({ sendConversationTemplate: hooks.send }));
vi.mock("@/lib/teams/visibility", () => ({ assertConversationVisible: hooks.visible }));

import { startChat } from "@/lib/inbox/new-chat";
import { HttpError } from "@/lib/tenancy";

const agent = { userId: "u2", tenantId: "t1", role: "agent" as const };
const admin = { userId: "u1", tenantId: "t1", role: "admin" as const };
const contact = { id: "c1", optIn: false, optInSource: null, optInAt: null, optedOutAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  db.phoneNumber.findMany.mockResolvedValue([{ id: "ph1" }]);
  db.contact.findFirst.mockResolvedValue(contact);
  db.conversation.findFirst.mockResolvedValue(null);
  db.conversation.upsert.mockResolvedValue({ id: "cv-new", assignedToId: "u2" });
  hooks.send.mockResolvedValue({ id: "m1" });
  hooks.visible.mockResolvedValue(undefined);
});

describe("startChat visibility", () => {
  it("refuses with 404 when the contact's chat on that number is outside the caller's scope, and sends nothing", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv-other", assignedToId: "u9" });
    hooks.visible.mockRejectedValue(new HttpError(404, "Conversation not found."));
    await expect(startChat(agent, { phone: "+919876543210", templateId: "tp1" })).rejects.toMatchObject({ status: 404 });
    expect(hooks.visible).toHaveBeenCalledWith(agent, "cv-other");
    expect(hooks.send).not.toHaveBeenCalled();
    expect(db.conversation.upsert).not.toHaveBeenCalled();
  });

  it("does not change consent for a chat the caller cannot see", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv-other", assignedToId: "u9" });
    hooks.visible.mockRejectedValue(new HttpError(404, "Conversation not found."));
    await expect(startChat(admin, { contactId: "c1", templateId: "tp1", confirmOptIn: true })).rejects.toMatchObject({ status: 404 });
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(hooks.audit).not.toHaveBeenCalled();
  });

  it("sends into a visible existing chat", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", assignedToId: "u2" });
    const out = await startChat(agent, { contactId: "c1", templateId: "tp1" });
    // The send is stamped with its origin (spend spec WP-09): a member starting a chat from the inbox is "human".
    expect(hooks.send).toHaveBeenCalledWith(agent, "cv1", { templateId: "tp1", variables: undefined }, { origin: "human" });
    expect(out.conversation).toEqual({ id: "cv1", contactId: "c1" });
  });

  it("passes Eddy's origin through to the send, so an Eddy send is counted as origin eddy", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", assignedToId: "u2" });
    await startChat(agent, { contactId: "c1", templateId: "tp1" }, { origin: "eddy" });
    expect(hooks.send).toHaveBeenCalledWith(agent, "cv1", { templateId: "tp1", variables: undefined }, { origin: "eddy" });
  });
});

describe("startChat confirmed opt-in", () => {
  it("records the opt-in before the send and audits only after the send succeeds", async () => {
    await startChat(admin, { contactId: "c1", templateId: "tp1", confirmOptIn: true });
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { optIn: true, optInSource: "agent_confirmed", optInAt: expect.any(Date) } });
    expect(db.contact.updateMany.mock.invocationCallOrder[0]).toBeLessThan(hooks.send.mock.invocationCallOrder[0]);
    expect(hooks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contact.opt_in_confirmed", target: "c1" }));
  });

  it("takes the opt-in back, without an audit entry, when the send is refused", async () => {
    hooks.send.mockRejectedValue(new HttpError(409, "Only approved templates can be sent."));
    db.contact.findFirst.mockResolvedValue({ ...contact, optInSource: "import", optInAt: null });
    await expect(startChat(admin, { contactId: "c1", templateId: "tp1", confirmOptIn: true })).rejects.toMatchObject({ status: 409 });
    expect(db.contact.updateMany).toHaveBeenCalledTimes(2);
    const [set, revert] = db.contact.updateMany.mock.calls.map((c) => c[0]);
    expect(revert.where).toEqual({ id: "c1", tenantId: "t1", optInSource: "agent_confirmed", optInAt: set.data.optInAt });
    expect(revert.data).toEqual({ optIn: false, optInSource: "import", optInAt: null });
    expect(hooks.audit).not.toHaveBeenCalled();
  });

  it("leaves a contact who already opted in alone", async () => {
    db.contact.findFirst.mockResolvedValue({ ...contact, optIn: true, optInSource: "form", optInAt: new Date() });
    await startChat(admin, { contactId: "c1", templateId: "tp1", confirmOptIn: true });
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(hooks.audit).not.toHaveBeenCalled();
  });

  it("refuses an opted-out contact before writing anything, and keeps the confirmation admin-only", async () => {
    db.contact.findFirst.mockResolvedValue({ ...contact, optedOutAt: new Date() });
    await expect(startChat(admin, { contactId: "c1", templateId: "tp1", confirmOptIn: true })).rejects.toMatchObject({ status: 422 });
    await expect(startChat(agent, { contactId: "c1", templateId: "tp1", confirmOptIn: true })).rejects.toMatchObject({ status: 403 });
    expect(db.contact.updateMany).not.toHaveBeenCalled();
  });
});

describe("startChat undo", () => {
  it("removes the new chat, its marks and a contact it created when the send is refused", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockResolvedValue({ ...contact, id: "cnew" });
    hooks.send.mockRejectedValue(new HttpError(422, "This contact has not opted in to marketing messages."));
    await expect(startChat(agent, { phone: "+919876543210", templateId: "tp1" })).rejects.toMatchObject({ status: 422 });
    expect(db.conversationMark.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", conversationId: "cv-new" } });
    expect(db.conversation.deleteMany).toHaveBeenCalledWith({ where: { id: "cv-new", tenantId: "t1" } });
    expect(db.contact.deleteMany).toHaveBeenCalledWith({ where: { id: "cnew", tenantId: "t1" } });
  });

  it("never deletes a chat that already existed", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", assignedToId: "u2" });
    hooks.send.mockRejectedValue(new HttpError(422, "opted out"));
    await expect(startChat(agent, { contactId: "c1", templateId: "tp1" })).rejects.toMatchObject({ status: 422 });
    expect(db.conversation.deleteMany).not.toHaveBeenCalled();
    expect(db.conversationMark.deleteMany).not.toHaveBeenCalled();
  });
});

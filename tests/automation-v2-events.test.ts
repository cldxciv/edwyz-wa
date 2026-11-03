import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(), delete: vi.fn(), count: vi.fn() });
  const prisma: Record<string, unknown> = Object.fromEntries(["contact", "conversation", "conversationMark", "message", "note", "automationRun", "ruleExecution", "broadcastRecipient", "auditLog", "job", "phoneNumber"].map((n) => [n, model()]));
  // promote/forget.ts forgetContact (PRM-11) first looks for the workspace's customer-list audiences on Meta: none here.
  prisma.adAudience = { findMany: vi.fn(async () => []) };
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
  return prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
});
const spies = vi.hoisted(() => ({ one: vi.fn(), tags: vi.fn(), attrs: vi.fn(), send: vi.fn(), visible: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
// Contact erasure also clears Eddy's rows in the same transaction (EDDY-16); that is tested in tests/lifecycle-eddy-erasure.test.ts.
vi.mock("@/lib/eddy/erasure-sweep", () => ({ eraseContactFromEddy: vi.fn(async () => ({ conversations: 0, messages: 0, actionRecords: 0, notices: 0 })) }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/integrations/apikeys", () => ({ revokeKeysBestEffort: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/inbox/template-send", () => ({ sendConversationTemplate: spies.send }));
vi.mock("@/lib/teams/visibility", () => ({ assertConversationVisible: spies.visible }));
vi.mock("@/lib/inbox/service", () => ({ sendTemplateMessage: vi.fn(), sendText: vi.fn() }));
vi.mock("@/lib/contacts/service", () => ({ listContacts: vi.fn() }));
vi.mock("@/lib/templates/service", () => ({ listTemplates: vi.fn() }));
vi.mock("@/lib/automation/v2/emit", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/automation/v2/emit")>();
  return { ...actual, emitAutomationEvent: spies.one, emitTagChanges: spies.tags, emitAttributeChanges: spies.attrs };
});

import { attributeChangeEvents, diffTags, emitAutomationEvents, tagChangeEvents, EVENT_QUEUE } from "@/lib/automation/v2/emit";
import { importContacts } from "@/lib/contacts/import";
import { upsertContactV1 } from "@/lib/integrations/v1-service";
import { startChat } from "@/lib/inbox/new-chat";
import { deleteContactData } from "@/lib/lifecycle/erasure";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
const base = { tenantId: "t1", contactId: "c1" };

beforeEach(() => {
  vi.clearAllMocks();
  db.job.createMany.mockResolvedValue({ count: 0 });
});

describe("event helpers", () => {
  it("work out tag and detail changes, comparing tags without regard to case", () => {
    expect(diffTags(["VIP"], ["vip", "new"])).toEqual({ added: ["new"], removed: [] });
    expect(tagChangeEvents(base, ["a"], ["b"])).toEqual([
      { ...base, type: "tag_added", tags: ["b"] },
      { ...base, type: "tag_removed", tags: ["a"] },
    ]);
    expect(attributeChangeEvents(base, { city: "Delhi", plan: "x" }, { city: "Shimla", plan: "x", size: 3 }).map((e) => e.attribute)).toEqual(["city", "size"]);
    expect(attributeChangeEvents(base, {}, {})).toEqual([]);
  });

  it("queues many events with one insert per batch and never throws", async () => {
    await emitAutomationEvents(Array.from({ length: 1100 }, (_, i) => ({ type: "contact_created" as const, tenantId: "t1", contactId: `c${i}` })));
    expect(db.job.createMany).toHaveBeenCalledTimes(3);
    expect(db.job.createMany.mock.calls[0][0].data[0]).toMatchObject({ queue: EVENT_QUEUE, maxAttempts: 3, payload: { type: "contact_created", tenantId: "t1", contactId: "c0" } });
    db.job.createMany.mockRejectedValue(new Error("down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(emitAutomationEvents([{ type: "contact_created", tenantId: "t1", contactId: "c1" }])).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("CSV import announces what it changed", () => {
  it("announces new contacts and tag or detail changes on existing ones", async () => {
    db.contact.findMany.mockImplementation(async ({ where, select }: { where: { phone: { in: string[] } }; select: Record<string, boolean> }) => {
      if (select.tags) return [{ id: "old", phone: "+919876543210", name: "Old", tags: ["a"], attributes: { city: "Delhi" }, optIn: false, optedOutAt: null }];
      return where.phone.in.includes("+919811111111") ? [{ id: "new1" }] : [];
    });
    db.contact.createMany.mockResolvedValue({ count: 1 });
    db.contact.update.mockResolvedValue({});
    const csv = "phone,name,tags,city\n+919811111111,Ravi,,\n+919876543210,Old,b,Shimla\n";
    const report = await importContacts("t1", csv, {});
    expect(report).toMatchObject({ created: 1, updated: 1 });
    const events = db.job.createMany.mock.calls.flatMap(([a]) => a.data.map((d: { payload: unknown }) => d.payload));
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "contact_created", tenantId: "t1", contactId: "new1" },
        { type: "tag_added", tenantId: "t1", contactId: "old", tags: ["b"] },
        { type: "attribute_changed", tenantId: "t1", contactId: "old", attribute: "city" },
      ]),
    );
    expect(events).toHaveLength(3);
  });

  it("an update that changes nothing announces nothing", async () => {
    db.contact.findMany.mockResolvedValue([{ id: "old", phone: "+919876543210", name: "Old", tags: ["a"], attributes: { city: "Delhi" }, optIn: false, optedOutAt: null }]);
    db.contact.update.mockResolvedValue({});
    await importContacts("t1", "phone,tags,city\n+919876543210,a,Delhi\n", {});
    expect(db.job.createMany).not.toHaveBeenCalled();
  });
});

describe("public API upserts announce changes", () => {
  it("announces a new contact, then tag and detail changes on an existing one", async () => {
    db.contact.findFirst.mockResolvedValueOnce(null);
    db.contact.create.mockResolvedValue({ id: "c9", phone: "+919876543210", tags: [], attributes: {}, createdAt: new Date() });
    await upsertContactV1(actor, { phone: "+919876543210" });
    expect(spies.one).toHaveBeenCalledWith({ type: "contact_created", tenantId: "t1", contactId: "c9" });

    const existing = { id: "c1", phone: "+919876543210", tags: ["a"], attributes: { city: "Delhi" }, optedOutAt: null };
    db.contact.findFirst.mockResolvedValueOnce(existing).mockResolvedValueOnce({ ...existing, tags: ["a", "vip"], attributes: { city: "Shimla" }, createdAt: new Date() });
    db.contact.updateMany.mockResolvedValue({ count: 1 });
    await upsertContactV1(actor, { phone: "+919876543210", tags: ["a", "vip"], attributes: { city: "Shimla" } });
    expect(spies.tags).toHaveBeenCalledWith({ tenantId: "t1", contactId: "c1" }, ["a"], ["a", "vip"]);
    expect(spies.attrs).toHaveBeenCalledWith({ tenantId: "t1", contactId: "c1" }, { city: "Delhi" }, { city: "Shimla" });
  });
});

describe("new chats announce a new contact only when the send worked", () => {
  const input = { phone: "+919876543210", templateId: "tp1" };
  beforeEach(() => {
    db.phoneNumber.findMany.mockResolvedValue([{ id: "ph1" }]);
    db.conversation.findFirst.mockResolvedValue(null);
    db.conversation.upsert.mockResolvedValue({ id: "cv-new", assignedToId: "u1" });
    spies.visible.mockResolvedValue(undefined);
  });

  it("announces after the send", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockResolvedValue({ id: "c7", optIn: false, optInSource: null, optInAt: null, optedOutAt: null });
    spies.send.mockResolvedValue({ id: "m1" });
    await startChat(actor, input);
    expect(spies.one).toHaveBeenCalledWith({ type: "contact_created", tenantId: "t1", contactId: "c7" });
  });

  it("stays silent when the send is refused and the new contact is removed again", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockResolvedValue({ id: "c7", optIn: false, optInSource: null, optInAt: null, optedOutAt: null });
    spies.send.mockRejectedValue(new Error("refused"));
    await expect(startChat(actor, input)).rejects.toThrow("refused");
    expect(spies.one).not.toHaveBeenCalled();
  });

  it("stays silent for a contact that already existed", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1", optIn: false, optInSource: null, optInAt: null, optedOutAt: null });
    spies.send.mockResolvedValue({ id: "m1" });
    await startChat(actor, input);
    expect(spies.one).not.toHaveBeenCalled();
  });
});

describe("erasing a contact", () => {
  it("also removes the rule run records kept for that contact, whether or not they had chats", async () => {
    db.contact.findUnique.mockResolvedValue({ id: "c1" });
    db.conversation.findMany.mockResolvedValue([]);
    await expect(deleteContactData("t1", "+919876543210")).resolves.toEqual({ deleted: true });
    expect(db.ruleExecution.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", contactId: "c1" } });
    expect(db.contact.delete).toHaveBeenCalled();
  });
});

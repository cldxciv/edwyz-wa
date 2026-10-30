import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const m = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() });
  const names = ["metaAsset", "lead", "leadForm", "contact", "leadSequence", "leadSequenceRun", "conversation", "phoneNumber", "template", "platformSetting"];
  return Object.fromEntries(names.map((n) => [n, m()])) as Record<string, ReturnType<typeof m>>;
});
const mocks = vi.hoisted(() => ({ assign: vi.fn(), graph: vi.fn(), access: vi.fn() }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/graph", () => ({ graphFetchAs: mocks.graph }));
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: mocks.access }));
vi.mock("@/lib/routing", () => ({ assignConversation: mocks.assign }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn() }));
vi.mock("@/lib/inbox/service", () => ({ sendTemplateMessage: vi.fn() }));
vi.mock("@/lib/chatbots", () => ({ startChatbot: vi.fn() }));

import { assignLeadToConversation, routeNewLead } from "@/lib/leads/assignment";
import { handleLeadJob } from "@/lib/leads/ingest";

const chat = (assignedToId: string | null) => db.conversation.findFirst.mockImplementation(async ({ select }: { select: Record<string, boolean> }) => (select.assignedToId ? { assignedToId } : { id: "cv1" }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  db.lead.updateMany.mockResolvedValue({ count: 1 });
  mocks.assign.mockResolvedValue({ assignedToId: null, reason: "auto_assign_off" });
});

describe("assigning a lead through routing", () => {
  it("asks routing to pick someone for the chat, then gives the lead the chat's owner", async () => {
    chat("u7");
    mocks.assign.mockResolvedValue({ assignedToId: "u7", reason: "assigned" });
    expect(await assignLeadToConversation("t1", "lead1", "cv1")).toBe("u7");
    expect(mocks.assign).toHaveBeenCalledWith("t1", "cv1");
    expect(db.lead.updateMany).toHaveBeenCalledWith({ where: { id: "lead1", tenantId: "t1", assignedToId: null }, data: { assignedToId: "u7" } });
    expect(db.conversation.findFirst.mock.calls[0][0].where).toEqual({ id: "cv1", tenantId: "t1" });
  });

  it("keeps the owner a chat already has (last-assignee routing) and never overwrites a lead that is assigned", async () => {
    chat("u3");
    expect(await assignLeadToConversation("t1", "lead1", "cv1")).toBe("u3");
    expect(db.lead.updateMany.mock.calls[0][0].where.assignedToId).toBeNull();
  });

  it("leaves the lead alone when routing finds nobody (auto-assign off, no agent, outside hours)", async () => {
    chat(null);
    expect(await assignLeadToConversation("t1", "lead1", "cv1")).toBeNull();
    expect(db.lead.updateMany).not.toHaveBeenCalled();
  });

  it("a routing failure never stops the lead", async () => {
    mocks.assign.mockRejectedValue(new Error("boom"));
    await expect(assignLeadToConversation("t1", "lead1", "cv1")).resolves.toBeNull();
  });
});

describe("routing a new lead whose contact already has a chat", () => {
  it("does nothing without a contact, for an assigned lead, or when there is no chat", async () => {
    expect(await routeNewLead("t1", { id: "l", contactId: null, assignedToId: null })).toBeNull();
    expect(await routeNewLead("t1", { id: "l", contactId: "c1", assignedToId: "u1" })).toBeNull();
    db.conversation.findFirst.mockResolvedValue(null);
    expect(await routeNewLead("t1", { id: "l", contactId: "c1", assignedToId: null })).toBeNull();
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("never throws when the chat lookup fails", async () => {
    db.conversation.findFirst.mockRejectedValue(new Error("db down"));
    await expect(routeNewLead("t1", { id: "l", contactId: "c1", assignedToId: null })).resolves.toBeNull();
  });

  it("looks for the chat inside the workspace, newest first", async () => {
    chat("u7");
    expect(await routeNewLead("t1", { id: "lead1", contactId: "c1", assignedToId: null })).toBe("u7");
    const find = db.conversation.findFirst.mock.calls[0][0];
    expect(find.where).toEqual({ tenantId: "t1", contactId: "c1" });
    expect(find.orderBy).toEqual({ lastMessageAt: "desc" });
  });
});

describe("lead ingestion routes the new lead", () => {
  const run = () => handleLeadJob({ leadgenId: "L1", pageId: "p1", formId: "f1" });

  beforeEach(() => {
    db.metaAsset.findMany.mockResolvedValue([{ id: "a1", tenantId: "t1" }]);
    db.lead.findFirst.mockResolvedValue(null);
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: null });
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockResolvedValue({ id: "c1" });
    db.lead.create.mockResolvedValue({ id: "lead1", tenantId: "t1", contactId: "c1", fields: {}, status: "new", assignedToId: null, leadFormId: "form1", campaignMetaId: "camp" });
    db.leadSequence.findMany.mockResolvedValue([]);
    db.platformSetting.findUnique.mockResolvedValue(null);
    mocks.access.mockResolvedValue({ token: "tok" });
    mocks.graph.mockResolvedValue({ id: "L1", created_time: "2026-10-01T10:00:00+0000", form_id: "f1", campaign_id: "camp", field_data: [{ name: "phone_number", values: ["+91 98765 43210"] }] });
  });

  it("assigns the lead to the owner of the contact's existing chat", async () => {
    chat("u7");
    mocks.assign.mockResolvedValue({ assignedToId: "u7", reason: "already_assigned" });
    await run();
    expect(mocks.assign).toHaveBeenCalledWith("t1", "cv1");
    expect(db.lead.updateMany).toHaveBeenCalledWith({ where: { id: "lead1", tenantId: "t1", assignedToId: null }, data: { assignedToId: "u7" } });
  });

  it("does nothing extra when the contact has no chat yet (the first message sent will route it)", async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    await run();
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(db.lead.create).toHaveBeenCalledTimes(1);
  });

  it("a failing chat lookup does not stop the lead.created event or the sequence start", async () => {
    db.conversation.findFirst.mockRejectedValue(new Error("db down"));
    await expect(run()).resolves.toBeUndefined();
    expect(db.lead.create).toHaveBeenCalledTimes(1);
    expect(db.leadSequence.findMany).toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("a routing error does not lose the lead", async () => {
    chat(null);
    mocks.assign.mockRejectedValue(new Error("routing down"));
    await expect(run()).resolves.toBeUndefined();
    expect(db.lead.create).toHaveBeenCalledTimes(1);
  });
});

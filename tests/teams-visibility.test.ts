import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn(), count: vi.fn(), groupBy: vi.fn(), upsert: vi.fn() });
  const conversation = model();
  return {
    team: model(),
    teamMember: model(),
    conversation: Object.assign(conversation, { fields: { lastInboundAt: Symbol("lastInboundAt") } }),
    message: model(),
    contact: model(),
    membership: model(),
    platformSetting: model(),
    auditLog: { create: vi.fn() },
  };
});
const auth = vi.hoisted(() => ({ role: "agent" as "agent" | "admin" | "owner", userId: "me" }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: auth.userId, tenantId: "t1", role: auth.role }) }));
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/inbox/stream", () => ({ countUnreadConversations: async () => 0 }));
vi.mock("@/lib/inbox/marks", () => ({
  flagsFor: async () => new Map(),
  campaignConversationIds: async () => [],
  markedConversationIds: async () => [],
  clearReadMarks: async () => undefined,
  notifyMentions: async () => undefined,
}));
vi.mock("@/lib/contacts/service", () => ({ listContacts: vi.fn(), createContact: vi.fn(), updateContact: vi.fn(), deleteContact: vi.fn() }));

import { GET as listRoute } from "@/app/api/inbox/conversations/route";
import { GET as detailRoute } from "@/app/api/inbox/conversations/[id]/route";
import { POST as readRoute } from "@/app/api/inbox/conversations/[id]/read/route";
import { PUT as tagsRoute } from "@/app/api/inbox/conversations/[id]/tags/route";
import { POST as bulkRoute } from "@/app/api/inbox/conversations/bulk/route";
import { GET as contactsRoute } from "@/app/api/contacts/route";
import { listContacts } from "@/lib/contacts/service";
import { DEFAULT_EXTRA, type RoutingExtra } from "@/lib/routing/extra";
import { sendText } from "@/lib/inbox/service";
import { maskContact, maskPhone, rulesToWhere, searchAllowed, viewerRules } from "@/lib/teams/visibility";

const ORIGIN = "https://wa.edwyz.com";
const get = (path: string) => new Request(`${ORIGIN}${path}`);
const post = (path: string, method: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: "c1" }) };
const actor = { tenantId: "t1", userId: "me", role: "agent" as const };

function settings(extra: Partial<RoutingExtra>) {
  db.platformSetting.findUnique.mockResolvedValue({ value: { ...DEFAULT_EXTRA, ...extra } });
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.role = "agent";
  auth.userId = "me";
  db.platformSetting.findUnique.mockResolvedValue(undefined);
  db.conversation.findMany.mockResolvedValue([]);
  db.message.findMany.mockResolvedValue([]);
});

describe("maskPhone", () => {
  it("keeps the first three and last four digits", () => {
    expect(maskPhone("+919876543210")).toBe("+919*****3210");
    expect(maskPhone("919876543210")).toBe("919*****3210");
    expect(maskPhone("+1234567")).toBe("*****67");
    expect(maskPhone("12345")).toBe("***45");
  });
  it("masks phone and waId only when switched on", () => {
    expect(maskContact({ phone: "+919876543210", waId: "919876543210", name: "A" }, true)).toEqual({ phone: "+919*****3210", waId: "919*****3210", name: "A" });
    const same = { phone: "+919876543210" };
    expect(maskContact(same, false)).toBe(same);
    expect(maskContact(null, true)).toBeNull();
  });
  it("lets a masked person search names and the last four digits only", () => {
    expect(searchAllowed("Asha", true)).toBe(true);
    expect(searchAllowed("3210", true)).toBe(true);
    expect(searchAllowed("98765", true)).toBe(false);
    expect(searchAllowed("+91 98765 43210", true)).toBe(false);
    expect(searchAllowed("98765", false)).toBe(true);
    expect(searchAllowed(undefined, true)).toBe(true);
  });
});

describe("viewer rules", () => {
  it("never restricts admins and owners and does not even read the settings", async () => {
    for (const role of ["admin", "owner"] as const) {
      const rules = await viewerRules({ ...actor, role });
      expect(rulesToWhere({ ...actor, role }, rules)).toBeNull();
      expect(rules.maskPhone).toBe(false);
    }
    expect(db.platformSetting.findUnique).not.toHaveBeenCalled();
  });

  it("limits a view-only agent to their own chats, by person or for all agents", async () => {
    settings({ viewOnlyAssigned: { allAgents: false, userIds: ["me"] } });
    expect(rulesToWhere(actor, await viewerRules(actor))).toEqual({ assignedToId: "me" });
    settings({ viewOnlyAssigned: { allAgents: false, userIds: ["someone"] } });
    expect(rulesToWhere(actor, await viewerRules(actor))).toBeNull();
    settings({ viewOnlyAssigned: { allAgents: true, userIds: [] } });
    expect(rulesToWhere(actor, await viewerRules(actor))).toEqual({ assignedToId: "me" });
  });

  it("limits an agent to their teams, their own chats and (when in the default team) chats with no team", async () => {
    settings({ teamVisibility: true });
    db.teamMember.findMany.mockImplementation(async ({ where }: { where: { userId?: string; teamId?: string } }) => (where.userId ? [{ teamId: "sales" }] : [{ userId: "x" }]));
    db.team.findFirst.mockResolvedValue({ id: "def", name: "Default team" });
    const rules = await viewerRules(actor);
    expect(rules).toMatchObject({ teamIds: ["sales"], includeUnteamed: false });
    expect(rulesToWhere(actor, rules)).toEqual({ OR: [{ assignedToId: "me" }, { teamId: { in: ["sales"] } }] });
    db.teamMember.findMany.mockImplementation(async ({ where }: { where: { userId?: string } }) => (where.userId ? [{ teamId: "def" }] : [{ userId: "me" }]));
    const withDefault = await viewerRules(actor);
    expect(rulesToWhere(actor, withDefault)).toEqual({ OR: [{ assignedToId: "me" }, { teamId: { in: ["def"] } }, { teamId: null }] });
  });

  it("treats an empty default team as everyone, so chats with no team stay visible", async () => {
    settings({ teamVisibility: true });
    db.teamMember.findMany.mockResolvedValue([]);
    db.team.findFirst.mockResolvedValue({ id: "def", name: "Default team" });
    expect((await viewerRules(actor)).includeUnteamed).toBe(true);
  });
});

describe("inbox list route", () => {
  it("passes the tenant, the viewer's scope and the team filter to the query", async () => {
    settings({ viewOnlyAssigned: { allAgents: true, userIds: [] } });
    db.team.findFirst.mockResolvedValue({ id: "sales", isDefault: false });
    await listRoute(get("/api/inbox/conversations?team=sales"));
    const where = db.conversation.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    // Blocked chats show only in the Blocked tab (inbox/list.ts NOT_BLOCKED).
    expect(where.AND).toEqual([{ AND: [{ assignedToId: "me" }, { teamId: "sales" }] }, { status: { not: "blocked" } }]);
    expect(db.team.findFirst.mock.calls[0][0].where).toEqual({ id: "sales", tenantId: "t1" });
  });

  it("includes chats with no team when the default team is chosen and rejects unknown teams", async () => {
    auth.role = "admin";
    db.team.findFirst.mockResolvedValue({ id: "def", isDefault: true });
    await listRoute(get("/api/inbox/conversations?team=def"));
    expect(db.conversation.findMany.mock.calls[0][0].where.AND).toEqual([{ AND: [{ OR: [{ teamId: "def" }, { teamId: null }] }] }, { status: { not: "blocked" } }]);
    db.team.findFirst.mockResolvedValue(null);
    expect((await listRoute(get("/api/inbox/conversations?team=nope"))).status).toBe(400);
    db.conversation.findMany.mockClear();
    await listRoute(get("/api/inbox/conversations?team=none"));
    expect(db.conversation.findMany.mock.calls[0][0].where.AND).toEqual([{ AND: [{ teamId: null }] }, { status: { not: "blocked" } }]);
  });

  it("adds no visibility conditions for admins without a team filter", async () => {
    auth.role = "admin";
    await listRoute(get("/api/inbox/conversations"));
    expect(db.conversation.findMany.mock.calls[0][0].where.AND).toEqual([{ status: { not: "blocked" } }]);
  });

  it("masks phone numbers for a masked agent and refuses long number searches", async () => {
    settings({ maskPhone: { allAgents: true, userIds: [] } });
    db.conversation.findMany.mockResolvedValue([{ id: "c1", contact: { id: "k1", phone: "+919876543210", name: "A" }, messages: [] }]);
    const body = await (await listRoute(get("/api/inbox/conversations"))).json();
    expect(body.items[0].contact.phone).toBe("+919*****3210");
    db.conversation.findMany.mockClear();
    const blocked = await (await listRoute(get("/api/inbox/conversations?q=9876543210"))).json();
    expect(blocked.items).toEqual([]);
    expect(db.conversation.findMany).not.toHaveBeenCalled();
    await listRoute(get("/api/inbox/conversations?q=3210"));
    expect(JSON.stringify(db.conversation.findMany.mock.calls[0][0].where)).toContain(JSON.stringify({ contact: { phone: { endsWith: "3210" } } }));
  });

  it("leaves numbers alone for agents who are not masked", async () => {
    db.conversation.findMany.mockResolvedValue([{ id: "c1", contact: { id: "k1", phone: "+919876543210" }, messages: [] }]);
    expect((await (await listRoute(get("/api/inbox/conversations"))).json()).items[0].contact.phone).toBe("+919876543210");
  });
});

describe("conversation routes honour view-only", () => {
  it("returns 404 for a chat assigned to someone else and never loads it", async () => {
    settings({ viewOnlyAssigned: { allAgents: true, userIds: [] } });
    db.conversation.findFirst.mockResolvedValue(null);
    expect((await detailRoute(get("/api/inbox/conversations/c1"), ctx)).status).toBe(404);
    expect(db.conversation.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1", assignedToId: "me" });
    expect((await readRoute(post("/api/inbox/conversations/c1/read", "POST", {}), ctx)).status).toBe(404);
    expect((await tagsRoute(post("/api/inbox/conversations/c1/tags", "PUT", { tags: ["a"] }), ctx)).status).toBe(404);
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("masks the contact on the detail view", async () => {
    settings({ maskPhone: { allAgents: true, userIds: [] } });
    db.conversation.findFirst.mockResolvedValue({ id: "c1", lastInboundAt: new Date(), contact: { phone: "+919876543210", waId: "919876543210" }, phoneNumber: {} });
    db.message.findMany.mockResolvedValue([]);
    const body = await (await detailRoute(get("/api/inbox/conversations/c1"), ctx)).json();
    expect(body.conversation.contact).toMatchObject({ phone: "+919*****3210", waId: "919*****3210" });
  });

  it("drops hidden chats from bulk actions and reports them as not found", async () => {
    settings({ viewOnlyAssigned: { allAgents: true, userIds: [] } });
    db.conversation.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] }; assignedToId?: string } }) => (where.assignedToId ? [{ id: "mine" }] : where.id.in.map((id) => ({ id, status: "open", assignedToId: "me", tags: [] }))));
    const res = await bulkRoute(post("/api/inbox/conversations/bulk", "POST", { ids: ["mine", "theirs"], action: "status", status: "pending" }));
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(body.skipped).toEqual([{ id: "theirs", reason: "not_found" }]);
  });
});

describe("contacts route", () => {
  it("masks numbers for a masked agent", async () => {
    settings({ maskPhone: { allAgents: false, userIds: ["me"] } });
    vi.mocked(listContacts).mockResolvedValue({ items: [{ id: "k1", phone: "+919876543210", name: "A" }], nextCursor: null } as never);
    const body = await (await contactsRoute(get("/api/contacts"))).json();
    expect(body.items[0].phone).toBe("+919*****3210");
    expect((await (await contactsRoute(get("/api/contacts?q=9876543210"))).json()).items).toEqual([]);
  });
});

describe("agent reply timestamps", () => {
  beforeEach(() => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1", lastInboundAt: new Date() });
    db.message.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "m1", ...data }));
    db.conversation.updateMany.mockResolvedValue({ count: 1 });
  });

  it("stamps lastAgentReplyAt and, once, firstAgentReplyAt when a person sends", async () => {
    await sendText({ tenantId: "t1", origin: "unknown", conversationId: "c1", userId: "me", body: "hi" });
    const [first, second] = db.conversation.updateMany.mock.calls.map((c) => c[0]);
    expect(first.where).toEqual({ id: "c1", tenantId: "t1" });
    expect(first.data.lastAgentReplyAt).toBeInstanceOf(Date);
    expect(second.where).toEqual({ id: "c1", tenantId: "t1", firstAgentReplyAt: null });
    expect(second.data.firstAgentReplyAt).toBeInstanceOf(Date);
  });

  it("does not stamp anything for automatic sends", async () => {
    await sendText({ tenantId: "t1", origin: "unknown", conversationId: "c1", body: "hi" });
    expect(db.conversation.updateMany).toHaveBeenCalledTimes(1);
    expect(db.conversation.updateMany.mock.calls[0][0].data).not.toHaveProperty("lastAgentReplyAt");
  });
});

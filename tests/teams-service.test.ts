import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), create: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() });
  const d: Record<string, unknown> = {
    team: model(),
    teamMember: model(),
    membership: model(),
    conversation: model(),
    contact: model(),
    agentAvailability: model(),
    platformSetting: model(),
    routingConfig: model(),
    message: model(),
    auditLog: { create: vi.fn() },
  };
  d.$transaction = async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(d) : Promise.all(arg as unknown[]));
  return d as Record<string, ReturnType<typeof model>> & { auditLog: { create: ReturnType<typeof vi.fn> } };
});
const auth = vi.hoisted(() => ({ role: "admin" as "agent" | "admin" | "owner", userId: "u1" }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: auth.userId, tenantId: "t1", role: auth.role }) }));

import { GET as listRoute, POST as createRoute } from "@/app/api/teams/route";
import { DELETE as deleteRoute, PATCH as patchRoute } from "@/app/api/teams/[id]/route";
import { PUT as membersRoute } from "@/app/api/teams/[id]/members/route";
import { POST as assignRoute } from "@/app/api/teams/assign/route";
import { PATCH as contactRoute } from "@/app/api/teams/contacts/[id]/route";
import { DEFAULT_EXTRA } from "@/lib/routing/extra";

const ORIGIN = "https://wa.edwyz.com";
const req = (path: string, method: string, body?: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id = "team1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  auth.role = "admin";
  auth.userId = "u1";
  db.team.findFirst.mockResolvedValue({ id: "team1", name: "Sales", isDefault: false });
  db.platformSetting.findUnique.mockResolvedValue(undefined);
});

describe("teams list and create", () => {
  it("lists the workspace's teams for any member, creating the default team on first use", async () => {
    auth.role = "agent";
    db.team.findFirst.mockResolvedValueOnce(null);
    db.team.create.mockResolvedValue({ id: "d1", name: "Default team" });
    db.team.findMany.mockResolvedValue([{ id: "d1", name: "Default team", isDefault: true, members: [{ userId: "a" }], createdAt: new Date("2026-01-01T00:00:00Z") }]);
    const res = await listRoute(new Request(`${ORIGIN}/api/teams`));
    const body = await res.json();
    expect(body.teams).toEqual([{ id: "d1", name: "Default team", isDefault: true, memberIds: ["a"], createdAt: "2026-01-01T00:00:00.000Z" }]);
    expect(body.leadStages).toEqual(DEFAULT_EXTRA.leadStages);
    expect(db.team.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", isDefault: true });
    expect(db.team.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });

  it("creates a team for admins only, trims the name and scopes it to the tenant", async () => {
    auth.role = "agent";
    expect((await createRoute(req("/api/teams", "POST", { name: "Support" }))).status).toBe(403);
    auth.role = "admin";
    db.team.count.mockResolvedValue(1);
    db.team.create.mockResolvedValue({ id: "t9", name: "Support", isDefault: false, createdAt: new Date("2026-01-01T00:00:00Z") });
    const res = await createRoute(req("/api/teams", "POST", { name: "  Support  " }));
    expect(res.status).toBe(201);
    expect(db.team.create.mock.calls[0][0].data).toEqual({ tenantId: "t1", name: "Support" });
  });

  it("rejects empty and over-long names, duplicates and cross-site posts", async () => {
    db.team.count.mockResolvedValue(1);
    expect((await createRoute(req("/api/teams", "POST", { name: "   " }))).status).toBe(400);
    expect((await createRoute(req("/api/teams", "POST", { name: "x".repeat(61) }))).status).toBe(400);
    db.team.create.mockRejectedValue({ code: "P2002" });
    expect((await createRoute(req("/api/teams", "POST", { name: "Sales" }))).status).toBe(409);
    expect((await createRoute(req("/api/teams", "POST", { name: "Sales" }, "https://evil.example"))).status).toBe(403);
  });

  it("limits a workspace to 50 teams", async () => {
    db.team.count.mockResolvedValue(50);
    expect((await createRoute(req("/api/teams", "POST", { name: "One more" }))).status).toBe(409);
  });
});

describe("rename, default and delete", () => {
  it("renames within the tenant and 404s for another tenant's team", async () => {
    expect((await patchRoute(req("/api/teams/team1", "PATCH", { name: "Revenue" }), ctx())).status).toBe(200);
    expect(db.team.updateMany).toHaveBeenCalledWith({ where: { id: "team1", tenantId: "t1" }, data: { name: "Revenue" } });
    db.team.findFirst.mockResolvedValue(null);
    expect((await patchRoute(req("/api/teams/other", "PATCH", { name: "Revenue" }), ctx("other"))).status).toBe(404);
  });

  it("makes exactly one team the default", async () => {
    expect((await patchRoute(req("/api/teams/team1", "PATCH", { isDefault: true }), ctx())).status).toBe(200);
    expect(db.team.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", isDefault: true }, data: { isDefault: false } });
    expect(db.team.updateMany).toHaveBeenCalledWith({ where: { id: "team1", tenantId: "t1" }, data: { isDefault: true } });
    expect((await patchRoute(req("/api/teams/team1", "PATCH", { isDefault: false }), ctx())).status).toBe(400);
  });

  it("refuses to delete the default team and returns a deleted team's chats to the default", async () => {
    db.team.findFirst.mockResolvedValue({ id: "d1", name: "Default team", isDefault: true });
    expect((await deleteRoute(req("/api/teams/d1", "DELETE"), ctx("d1"))).status).toBe(409);
    expect(db.team.deleteMany).not.toHaveBeenCalled();
    db.team.findFirst.mockResolvedValue({ id: "team1", name: "Sales", isDefault: false });
    expect((await deleteRoute(req("/api/teams/team1", "DELETE"), ctx())).status).toBe(200);
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", teamId: "team1" }, data: { teamId: null } });
    expect(db.team.deleteMany).toHaveBeenCalledWith({ where: { id: "team1", tenantId: "t1" } });
  });

  it("is for admins only", async () => {
    auth.role = "agent";
    expect((await patchRoute(req("/api/teams/team1", "PATCH", { name: "x" }), ctx())).status).toBe(403);
    expect((await deleteRoute(req("/api/teams/team1", "DELETE"), ctx())).status).toBe(403);
    expect((await membersRoute(req("/api/teams/team1/members", "PUT", { userIds: [] }), ctx())).status).toBe(403);
  });
});

describe("team members", () => {
  it("replaces the member list after checking everyone belongs to the workspace", async () => {
    db.membership.findMany.mockResolvedValue([{ userId: "a" }, { userId: "b" }]);
    const res = await membersRoute(req("/api/teams/team1/members", "PUT", { userIds: ["a", "b", "a"] }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).memberIds).toEqual(["a", "b"]);
    expect(db.membership.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", userId: { in: ["a", "b"] } });
    expect(db.teamMember.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", teamId: "team1", userId: { notIn: ["a", "b"] } } });
    expect(db.teamMember.createMany.mock.calls[0][0].data).toEqual([
      { tenantId: "t1", teamId: "team1", userId: "a" },
      { tenantId: "t1", teamId: "team1", userId: "b" },
    ]);
  });

  it("rejects people from another workspace and malformed lists", async () => {
    db.membership.findMany.mockResolvedValue([{ userId: "a" }]);
    expect((await membersRoute(req("/api/teams/team1/members", "PUT", { userIds: ["a", "stranger"] }), ctx())).status).toBe(400);
    expect((await membersRoute(req("/api/teams/team1/members", "PUT", { userIds: "a" }), ctx())).status).toBe(400);
    expect(db.teamMember.createMany).not.toHaveBeenCalled();
  });
});

describe("assigning a chat to a team", () => {
  const conv = { id: "c1", assignedToId: "x", teamId: null, contactId: "k1" };
  beforeEach(() => {
    db.conversation.findFirst.mockResolvedValue(conv);
    db.conversation.updateMany.mockResolvedValue({ count: 1 });
    db.teamMember.findMany.mockResolvedValue([{ userId: "b" }, { userId: "c" }]);
    db.membership.findFirst.mockResolvedValue({ user: { disabledAt: null } });
    db.membership.findMany.mockResolvedValue([
      { userId: "b", user: { disabledAt: null } },
      { userId: "c", user: { disabledAt: null } },
    ]);
    db.agentAvailability.findMany.mockResolvedValue([]);
    db.conversation.groupBy.mockResolvedValue([]);
    db.routingConfig.findUnique.mockResolvedValue(null);
  });
  const body = (b: Record<string, unknown>) => req("/api/teams/assign", "POST", { conversationId: "c1", ...b });

  it("keeps the current person when they are in the team", async () => {
    db.conversation.findFirst.mockResolvedValue({ ...conv, assignedToId: "b" });
    const res = await assignRoute(body({ teamId: "team1" }));
    expect(await res.json()).toMatchObject({ teamId: "team1", assignedToId: "b" });
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1", assignedToId: "b" }, data: { teamId: "team1" } });
  });

  it("lets routing pick someone in the team when the current person is outside it", async () => {
    const res = await assignRoute(body({ teamId: "team1", route: true }));
    const out = await res.json();
    expect(["b", "c"]).toContain(out.assignedToId);
    expect(out.reason).toBe("team_routed");
    expect(db.conversation.updateMany.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1", assignedToId: "x" });
  });

  it("unassigns instead when routing is not asked for", async () => {
    const out = await (await assignRoute(body({ teamId: "team1" }))).json();
    expect(out).toMatchObject({ assignedToId: null, reason: "team_unassigned" });
  });

  it("only accepts a named person who is in the team", async () => {
    expect((await assignRoute(body({ teamId: "team1", userId: "z" }))).status).toBe(400);
    expect((await assignRoute(body({ teamId: "team1", userId: "c" }))).status).toBe(200);
    expect(db.conversation.updateMany.mock.calls.at(-1)?.[0].data).toMatchObject({ teamId: "team1", assignedToId: "c" });
  });

  it("404s for a team or chat of another workspace and validates input", async () => {
    db.team.findFirst.mockResolvedValue(null);
    expect((await assignRoute(body({ teamId: "other" }))).status).toBe(404);
    db.conversation.findFirst.mockResolvedValue(null);
    expect((await assignRoute(body({ teamId: null }))).status).toBe(404);
    expect((await assignRoute(req("/api/teams/assign", "POST", { teamId: null }))).status).toBe(400);
    expect((await assignRoute(body({}))).status).toBe(400);
    expect((await assignRoute(body({ teamId: "team1", route: "yes" }))).status).toBe(400);
  });

  it("loses cleanly when the chat changed in the meantime", async () => {
    db.conversation.updateMany.mockResolvedValue({ count: 0 });
    expect((await assignRoute(body({ teamId: "team1", route: true }))).status).toBe(409);
  });

  it("lets an agent send a chat they may act on to a team, but not hand it to someone else", async () => {
    auth.role = "agent";
    auth.userId = "me";
    db.conversation.findFirst.mockResolvedValue({ ...conv, assignedToId: "me" });
    expect((await assignRoute(body({ teamId: "team1", route: true }))).status).toBe(200);
    expect((await assignRoute(body({ teamId: "team1", userId: "b" }))).status).toBe(403);
  });

  it("stops an agent from touching a chat assigned to someone else", async () => {
    auth.role = "agent";
    auth.userId = "me";
    expect((await assignRoute(body({ teamId: "team1" }))).status).toBe(403);
  });

  it("hides chats a view-only agent may not see", async () => {
    auth.role = "agent";
    auth.userId = "me";
    db.platformSetting.findUnique.mockResolvedValue({ value: { ...DEFAULT_EXTRA, viewOnlyAssigned: { allAgents: true, userIds: [] } } });
    db.conversation.findFirst.mockResolvedValue(null);
    expect((await assignRoute(body({ teamId: "team1" }))).status).toBe(404);
  });
});

describe("contact owner and lead stage", () => {
  const patch = (b: unknown) => contactRoute(req("/api/teams/contacts/k1", "PATCH", b), ctx("k1"));
  beforeEach(() => {
    db.contact.updateMany.mockResolvedValue({ count: 1 });
    db.contact.findFirst.mockResolvedValue({ id: "k1", ownerUserId: "b", leadStage: "Qualified" });
    db.membership.findFirst.mockResolvedValue({ id: "m1" });
  });

  it("sets the owner and stage scoped by tenant", async () => {
    const res = await patch({ ownerUserId: "b", leadStage: "Qualified" });
    expect(res.status).toBe(200);
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "k1", tenantId: "t1" }, data: { ownerUserId: "b", leadStage: "Qualified" } });
    expect(db.membership.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", userId: "b" });
  });

  it("clears them with null", async () => {
    await patch({ ownerUserId: null, leadStage: null });
    expect(db.contact.updateMany.mock.calls[0][0].data).toEqual({ ownerUserId: null, leadStage: null });
  });

  it("only accepts members and configured stages", async () => {
    db.membership.findFirst.mockResolvedValue(null);
    expect((await patch({ ownerUserId: "stranger" })).status).toBe(400);
    expect((await patch({ leadStage: "Made up" })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ leadStage: 5 })).status).toBe(400);
    expect(db.contact.updateMany).not.toHaveBeenCalled();
  });

  it("uses the workspace's own stage list", async () => {
    db.platformSetting.findUnique.mockResolvedValue({ value: { leadStages: ["Cold", "Hot"] } });
    expect((await patch({ leadStage: "Hot" })).status).toBe(200);
    expect((await patch({ leadStage: "Qualified" })).status).toBe(400);
  });

  it("404s for a contact of another workspace and works for agents", async () => {
    auth.role = "agent";
    db.contact.updateMany.mockResolvedValue({ count: 0 });
    expect((await patch({ leadStage: "Contacted" })).status).toBe(404);
  });

  it("blocks cross-site writes", async () => {
    expect((await contactRoute(req("/api/teams/contacts/k1", "PATCH", { leadStage: null }, "https://evil.example"), ctx("k1"))).status).toBe(403);
  });
});

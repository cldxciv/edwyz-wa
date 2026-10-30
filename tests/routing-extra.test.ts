import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), groupBy: vi.fn() });
  const d: Record<string, unknown> = {
    routingConfig: model(),
    membership: model(),
    agentAvailability: model(),
    conversation: model(),
    auditLog: { create: vi.fn(), findMany: vi.fn() },
    platformSetting: model(),
    team: model(),
    teamMember: model(),
    message: model(),
    contact: model(),
  };
  d.$transaction = async (fn: (tx: unknown) => unknown) => fn(d);
  return d as Record<string, ReturnType<typeof model>> & { auditLog: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> } };
});
const auth = vi.hoisted(() => ({ role: "admin" as "agent" | "admin" | "owner" }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: auth.role }) }));

import { GET as getExtraRoute, PUT as putExtraRoute } from "@/app/api/routing/extra/route";
import { assignConversation } from "@/lib/routing";
import { DEFAULT_EXTRA, inScope, parseExtra, validateExtra, type RoutingExtra } from "@/lib/routing/extra";
import { sweepNoResponse, triedBefore, wasAutoAssigned, waitingSince } from "@/lib/routing/reassign";

const NOW = new Date("2026-10-27T10:00:00Z");
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const ORIGIN = "https://wa.edwyz.com";
const put = (body: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/routing/extra`, { method: "PUT", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
const valid = (over: Partial<RoutingExtra> = {}): RoutingExtra => ({ ...DEFAULT_EXTRA, ...over });

describe("routing extra settings", () => {
  it("falls back to defaults for missing or unusable values", () => {
    expect(parseExtra(undefined)).toEqual(DEFAULT_EXTRA);
    expect(parseExtra("nonsense")).toEqual(DEFAULT_EXTRA);
    const e = parseExtra({ autoReassign: { enabled: true, minutes: 0, maxMoves: "x" }, viewOnlyAssigned: { allAgents: "yes", userIds: ["a", 5, "a", ""] }, leadStages: [] });
    expect(e.autoReassign).toEqual({ enabled: true, minutes: 15, maxMoves: 3 });
    expect(e.viewOnlyAssigned).toEqual({ allAgents: false, userIds: ["a"] });
    expect(e.leadStages).toEqual(DEFAULT_EXTRA.leadStages);
  });

  it("only restricts people with the agent role", () => {
    const scope = { allAgents: false, userIds: ["a1"] };
    expect(inScope(scope, { userId: "a1", role: "agent" })).toBe(true);
    expect(inScope(scope, { userId: "a2", role: "agent" })).toBe(false);
    expect(inScope(scope, { userId: "a1", role: "admin" })).toBe(false);
    expect(inScope({ allAgents: true, userIds: [] }, { userId: "a2", role: "agent" })).toBe(true);
    expect(inScope({ allAgents: true, userIds: [] }, { userId: "o", role: "owner" })).toBe(false);
  });

  it("validates a full replacement strictly", () => {
    expect(validateExtra(valid() as unknown as Record<string, unknown>).ok).toBe(true);
    const bad = (patch: Record<string, unknown>) => validateExtra({ ...valid(), ...patch } as unknown as Record<string, unknown>);
    expect(bad({ autoReassign: { enabled: true, minutes: 0, maxMoves: 3 } }).ok).toBe(false);
    expect(bad({ autoReassign: { enabled: true, minutes: 15, maxMoves: 11 } }).ok).toBe(false);
    expect(bad({ lastAssignee: { enabled: true, withinHours: 1000 } }).ok).toBe(false);
    expect(bad({ leadStages: [] }).ok).toBe(false);
    expect(bad({ leadStages: ["Won", "won"] }).ok).toBe(false);
    expect(bad({ leadStages: ["x".repeat(41)] }).ok).toBe(false);
    expect(bad({ maskPhone: { allAgents: false, userIds: "a" } }).ok).toBe(false);
    expect(bad({ teamVisibility: "yes" }).ok).toBe(false);
    const trimmed = bad({ leadStages: ["  New  ", "Won"] });
    expect(trimmed.ok && trimmed.value.leadStages).toEqual(["New", "Won"]);
  });
});

describe("extra route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    auth.role = "admin";
    db.membership.findMany.mockResolvedValue([]);
  });

  it("is for admins and owners only", async () => {
    auth.role = "agent";
    expect((await getExtraRoute(new Request(`${ORIGIN}/api/routing/extra`))).status).toBe(403);
    expect((await putExtraRoute(put(valid()))).status).toBe(403);
  });

  it("returns defaults when nothing is stored and reads the tenant's own key", async () => {
    const res = await getExtraRoute(new Request(`${ORIGIN}/api/routing/extra`));
    expect((await res.json()).extra).toEqual(DEFAULT_EXTRA);
    expect(db.platformSetting.findUnique).toHaveBeenCalledWith({ where: { key: "routing:extra:t1" } });
  });

  it("saves under the tenant key and checks that picked people belong to the workspace", async () => {
    const body = valid({ viewOnlyAssigned: { allAgents: false, userIds: ["a1"] }, maskPhone: { allAgents: false, userIds: ["a1", "a2"] } });
    db.membership.findMany.mockResolvedValue([{ userId: "a1" }]);
    expect((await putExtraRoute(put(body))).status).toBe(400);
    expect(db.platformSetting.upsert).not.toHaveBeenCalled();
    db.membership.findMany.mockResolvedValue([{ userId: "a1" }, { userId: "a2" }]);
    expect((await putExtraRoute(put(body))).status).toBe(200);
    expect(db.membership.findMany.mock.calls[1][0].where).toEqual({ tenantId: "t1", userId: { in: ["a1", "a2"] } });
    expect(db.platformSetting.upsert.mock.calls[0][0].where).toEqual({ key: "routing:extra:t1" });
  });

  it("rejects bad input and cross-site writes", async () => {
    expect((await putExtraRoute(put({ ...valid(), autoReassign: { enabled: true, minutes: 0, maxMoves: 1 } }))).status).toBe(400);
    expect((await putExtraRoute(put(valid(), "https://evil.example"))).status).toBe(403);
  });
});

describe("assignConversation with returning customers, owners and teams", () => {
  const config = { autoAssign: true, mode: "round_robin", timezone: "UTC", workingHours: null, maxOpenPerAgent: null, fallbackUserId: null };
  const conv = { id: "c1", assignedToId: null, status: "open", teamId: null, contactId: "k1" };

  function setup(extra: Partial<RoutingExtra> = {}) {
    vi.resetAllMocks();
    db.routingConfig.findUnique.mockResolvedValue(config);
    db.conversation.findFirst.mockResolvedValue(conv);
    db.membership.findMany.mockResolvedValue([
      { userId: "a", user: { disabledAt: null } },
      { userId: "b", user: { disabledAt: null } },
      { userId: "c", user: { disabledAt: null } },
    ]);
    db.agentAvailability.findMany.mockResolvedValue([{ userId: "a", available: true, maxOpen: null, lastAssignedAt: new Date(1000) }]);
    db.conversation.groupBy.mockResolvedValue([]);
    db.conversation.updateMany.mockResolvedValue({ count: 1 });
    db.platformSetting.findUnique.mockResolvedValue({ value: { ...DEFAULT_EXTRA, ...extra } });
  }

  beforeEach(() => setup({ lastAssignee: { enabled: true, withinHours: 168 } }));

  it("leaves last-assignee routing off for a workspace that never turned it on", async () => {
    setup();
    db.message.findFirst.mockResolvedValue({ sentByUserId: "c", createdAt: min(60) });
    expect((await assignConversation("t1", "c1", { at: NOW })).reason).toBe("assigned");
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });

  it("sends a returning customer to the person who last replied, even when round robin would pick someone else", async () => {
    db.message.findFirst.mockResolvedValue({ sentByUserId: "c", createdAt: min(60) });
    const res = await assignConversation("t1", "c1", { at: NOW });
    expect(res).toEqual({ assignedToId: "c", reason: "last_assignee" });
    expect(db.message.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", conversationId: "c1", direction: "outbound" });
  });

  it("ignores a last reply older than the configured window", async () => {
    setup({ lastAssignee: { enabled: true, withinHours: 2 } });
    db.message.findFirst.mockResolvedValue({ sentByUserId: "c", createdAt: min(60 * 5) });
    expect((await assignConversation("t1", "c1", { at: NOW })).reason).toBe("assigned");
  });

  it("falls back to normal routing when the last agent is away, full or switched off", async () => {
    db.message.findFirst.mockResolvedValue({ sentByUserId: "a", createdAt: min(10) });
    db.agentAvailability.findMany.mockResolvedValue([{ userId: "a", available: false, maxOpen: null, lastAssignedAt: null }]);
    const away = await assignConversation("t1", "c1", { at: NOW });
    expect(away.assignedToId).not.toBe("a");
    expect(away.reason).toBe("assigned");
    setup({ lastAssignee: { enabled: false, withinHours: 24 } });
    db.message.findFirst.mockResolvedValue({ sentByUserId: "c", createdAt: min(10) });
    expect((await assignConversation("t1", "c1", { at: NOW })).reason).toBe("assigned");
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });

  it("gives the chat to the contact owner when that setting is on and the owner can take it", async () => {
    setup({ lastAssignee: { enabled: false, withinHours: 24 }, contactOwner: { enabled: true } });
    db.contact.findFirst.mockResolvedValue({ ownerUserId: "b" });
    expect(await assignConversation("t1", "c1", { at: NOW })).toEqual({ assignedToId: "b", reason: "contact_owner" });
    expect(db.contact.findFirst.mock.calls[0][0].where).toEqual({ id: "k1", tenantId: "t1" });
  });

  it("only picks from the chat's team and treats an empty team as everyone", async () => {
    db.conversation.findFirst.mockResolvedValue({ ...conv, teamId: "team1" });
    db.team.findFirst.mockResolvedValue({ id: "team1" });
    db.teamMember.findMany.mockResolvedValue([{ userId: "b" }]);
    expect((await assignConversation("t1", "c1", { at: NOW })).assignedToId).toBe("b");
    expect(db.team.findFirst.mock.calls[0][0].where).toEqual({ id: "team1", tenantId: "t1" });
    db.teamMember.findMany.mockResolvedValue([]);
    expect(["b", "c"]).toContain((await assignConversation("t1", "c1", { at: NOW })).assignedToId);
  });

  it("a last assignee outside the team is not used", async () => {
    db.conversation.findFirst.mockResolvedValue({ ...conv, teamId: "team1" });
    db.team.findFirst.mockResolvedValue({ id: "team1" });
    db.teamMember.findMany.mockResolvedValue([{ userId: "b" }]);
    db.message.findFirst.mockResolvedValue({ sentByUserId: "c", createdAt: min(10) });
    expect((await assignConversation("t1", "c1", { at: NOW })).assignedToId).toBe("b");
  });

  it("files the chat under the requested team and uses that team's people", async () => {
    db.team.findFirst.mockResolvedValue({ id: "team2" });
    db.teamMember.findMany.mockResolvedValue([{ userId: "c" }]);
    const res = await assignConversation("t1", "c1", { at: NOW, teamId: "team2" });
    expect(res.assignedToId).toBe("c");
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1", assignedToId: null }, data: { assignedToId: "c", assignedAt: NOW, teamId: "team2" } });
  });

  it("makes the assignee the contact owner only when asked and only when there is none", async () => {
    setup({ setOwnerOnAssign: true, lastAssignee: { enabled: false, withinHours: 24 } });
    const res = await assignConversation("t1", "c1", { at: NOW });
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "k1", tenantId: "t1", ownerUserId: null }, data: { ownerUserId: res.assignedToId } });
    setup();
    await assignConversation("t1", "c1", { at: NOW });
    expect(db.contact.updateMany).not.toHaveBeenCalled();
  });
});

describe("auto-reassign helpers", () => {
  it("measures the wait from the later of assignment and the customer's last message", () => {
    expect(waitingSince({ assignedAt: min(30), lastInboundAt: min(10) })).toEqual(min(10));
    expect(waitingSince({ assignedAt: min(5), lastInboundAt: min(20) })).toEqual(min(5));
    expect(waitingSince({ assignedAt: null, lastInboundAt: min(1) })).toBeNull();
  });

  it("treats a chat as automatic only when the latest assignment record was automatic and matches the assignment", () => {
    const row = (action: string, at: Date) => ({ target: "c1", action, createdAt: at, meta: null });
    expect(wasAutoAssigned(min(30), [row("routing.auto_assign", min(30))])).toBe(true);
    expect(wasAutoAssigned(min(30), [row("routing.auto_assign", min(300)), row("routing.assign", min(30))])).toBe(false);
    expect(wasAutoAssigned(min(10), [row("routing.auto_assign", min(300))])).toBe(false);
    expect(wasAutoAssigned(min(10), [])).toBe(false);
    expect(wasAutoAssigned(min(10), [row("routing.auto_reassign", min(10))])).toBe(true);
  });

  it("counts earlier moves of this wait and remembers who already had the chat", () => {
    const move = (at: Date, from: string, to: string) => ({ target: "c1", action: "routing.auto_reassign", createdAt: at, meta: { from, to } });
    const out = triedBefore([move(min(5), "b", "c"), move(min(15), "a", "b"), move(min(500), "x", "y")], min(60));
    expect(out.count).toBe(2);
    expect([...out.people].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("sweepNoResponse", () => {
  const config = { autoAssign: true, mode: "round_robin", timezone: "UTC", workingHours: null, maxOpenPerAgent: null, fallbackUserId: null };
  const waiting = { id: "c1", assignedToId: "a", assignedAt: min(40), lastInboundAt: min(30), lastAgentReplyAt: null as Date | null, teamId: null };

  function setup(over: { extra?: Partial<RoutingExtra>; conv?: Partial<typeof waiting>; audits?: unknown[] } = {}) {
    vi.resetAllMocks();
    db.platformSetting.findMany.mockResolvedValue([{ key: "routing:extra:t1", value: { ...DEFAULT_EXTRA, autoReassign: { enabled: true, minutes: 15, maxMoves: 2 }, ...over.extra } }]);
    db.routingConfig.findUnique.mockResolvedValue(config);
    db.conversation.findMany.mockResolvedValue([{ ...waiting, ...over.conv }]);
    db.auditLog.findMany.mockResolvedValue(over.audits ?? [{ target: "c1", action: "routing.auto_assign", createdAt: min(40), meta: null }]);
    db.message.findFirst.mockResolvedValue(null);
    db.membership.findMany.mockResolvedValue([
      { userId: "a", user: { disabledAt: null } },
      { userId: "b", user: { disabledAt: null } },
    ]);
    db.agentAvailability.findMany.mockResolvedValue([]);
    db.conversation.groupBy.mockResolvedValue([]);
    db.conversation.updateMany.mockResolvedValue({ count: 1 });
  }

  it("moves an automatically assigned chat nobody answered to the next person, scoped by tenant and by what we saw", async () => {
    setup();
    expect(await sweepNoResponse(NOW)).toBe(1);
    const q = db.conversation.findMany.mock.calls[0][0];
    expect(q.where).toMatchObject({ tenantId: "t1", assignedToId: { not: null }, status: { in: ["open", "pending"] } });
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1", assignedToId: "a", assignedAt: waiting.assignedAt }, data: { assignedToId: "b", assignedAt: NOW } });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", action: "routing.auto_reassign", target: "c1" });
  });

  it("does nothing when the feature is off", async () => {
    setup({ extra: { autoReassign: { enabled: false, minutes: 15, maxMoves: 2 } } });
    expect(await sweepNoResponse(NOW)).toBe(0);
    expect(db.conversation.findMany).not.toHaveBeenCalled();
  });

  it("leaves chats that were given to a named person", async () => {
    setup({ audits: [{ target: "c1", action: "routing.assign", createdAt: min(40), meta: null }] });
    expect(await sweepNoResponse(NOW)).toBe(0);
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("leaves chats a person already answered", async () => {
    setup({ conv: { lastAgentReplyAt: min(5) } });
    expect(await sweepNoResponse(NOW)).toBe(0);
    setup();
    db.message.findFirst.mockResolvedValue({ id: "m1" });
    expect(await sweepNoResponse(NOW)).toBe(0);
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("stops after the configured number of moves and never goes back to someone who already had the chat", async () => {
    const move = (at: Date, from: string, to: string) => ({ target: "c1", action: "routing.auto_reassign", createdAt: at, meta: { from, to } });
    setup({ audits: [move(min(20), "x", "a"), move(min(25), "y", "x")], conv: { assignedAt: min(20) } });
    expect(await sweepNoResponse(NOW)).toBe(0);
    setup({ audits: [move(min(25), "b", "a")], conv: { assignedAt: min(25) } });
    expect(await sweepNoResponse(NOW)).toBe(0);
  });

  it("keeps counting moves when the customer wrote again, until a person answers", async () => {
    const move = (at: Date, from: string, to: string) => ({ target: "c1", action: "routing.auto_reassign", createdAt: at, meta: { from, to } });
    const older = [move(min(300), "x", "y"), move(min(280), "y", "a")];
    setup({ audits: older, conv: { assignedAt: min(280), lastInboundAt: min(30) } });
    expect(await sweepNoResponse(NOW)).toBe(0);
    setup({ audits: older, conv: { assignedAt: min(280), lastInboundAt: min(30), lastAgentReplyAt: min(290) } });
    db.message.findFirst.mockResolvedValue(null);
    expect(await sweepNoResponse(NOW)).toBe(1);
  });

  it("makes the new person the contact owner when that setting is on", async () => {
    setup({ extra: { setOwnerOnAssign: true } });
    db.platformSetting.findUnique.mockResolvedValue({ value: { ...DEFAULT_EXTRA, setOwnerOnAssign: true } });
    db.conversation.findFirst.mockResolvedValue({ contactId: "k1" });
    expect(await sweepNoResponse(NOW)).toBe(1);
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "k1", tenantId: "t1", ownerUserId: null }, data: { ownerUserId: "b" } });
  });

  it("does not run outside working hours", async () => {
    setup();
    db.routingConfig.findUnique.mockResolvedValue({ ...config, workingHours: { windows: [{ day: 1, start: "09:00", end: "17:00" }] } });
    expect(await sweepNoResponse(new Date("2026-10-26T20:00:00Z"))).toBe(0);
    expect(db.conversation.findMany).not.toHaveBeenCalled();
  });

  it("loses cleanly when someone changed the chat in the meantime", async () => {
    setup();
    db.conversation.updateMany.mockResolvedValue({ count: 0 });
    expect(await sweepNoResponse(NOW)).toBe(0);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

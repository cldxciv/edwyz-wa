import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), groupBy: vi.fn() });
  const d: Record<string, unknown> = { routingConfig: model(), membership: model(), agentAvailability: model(), conversation: model(), auditLog: { create: vi.fn() }, platformSetting: model(), team: model(), teamMember: model(), message: model(), contact: model() };
  d.$transaction = async (fn: (tx: unknown) => unknown) => fn(d);
  return d as Record<string, ReturnType<typeof model>> & { $transaction: unknown };
});
vi.mock("@/lib/db", () => ({ prisma: db }));

import { assignConversation, assignManually, isWithinWorkingHours, pickAgent } from "@/lib/routing";
import type { Candidate } from "@/lib/routing";
import { sweepUnassigned, worker } from "@/lib/routing/worker";

const cand = (userId: string, over: Partial<Candidate> = {}): Candidate => ({
  userId, eligibleMember: true, disabled: false, available: true, maxOpen: null, lastAssignedAt: null, openCount: 0, ...over,
});

describe("pickAgent", () => {
  it("round robin picks never-assigned first, then the oldest", () => {
    expect(pickAgent([cand("a", { lastAssignedAt: new Date(2000) }), cand("b")], "round_robin", null)).toBe("b");
    expect(pickAgent([cand("a", { lastAssignedAt: new Date(3000) }), cand("b", { lastAssignedAt: new Date(1000) })], "round_robin", null)).toBe("b");
  });
  it("least busy picks the fewest open chats and breaks ties by age", () => {
    expect(pickAgent([cand("a", { openCount: 3 }), cand("b", { openCount: 1 })], "least_busy", null)).toBe("b");
    expect(pickAgent([cand("a", { openCount: 1, lastAssignedAt: new Date(5) }), cand("b", { openCount: 1, lastAssignedAt: new Date(1) })], "least_busy", null)).toBe("b");
  });
  it("skips unavailable, disabled, non-member and capped agents", () => {
    const list = [
      cand("off", { available: false }),
      cand("dis", { disabled: true }),
      cand("out", { eligibleMember: false }),
      cand("own", { maxOpen: 2, openCount: 2 }),
      cand("tenant", { openCount: 5 }),
      cand("ok", { openCount: 1 }),
    ];
    expect(pickAgent(list, "round_robin", 5)).toBe("ok");
    expect(pickAgent(list.slice(0, 5), "round_robin", 5)).toBeNull();
  });
});

describe("isWithinWorkingHours", () => {
  const cfg = { timezone: "UTC", workingHours: { windows: [{ day: 1, start: "09:00", end: "17:00" }, { day: 5, start: "22:00", end: "06:00" }] } };
  it("is always on without hours", () => {
    expect(isWithinWorkingHours({ timezone: "UTC", workingHours: null }, new Date())).toBe(true);
  });
  it("respects day windows and overnight spill", () => {
    expect(isWithinWorkingHours(cfg, new Date("2026-10-26T10:00:00Z"))).toBe(true);
    expect(isWithinWorkingHours(cfg, new Date("2026-10-26T18:00:00Z"))).toBe(false);
    expect(isWithinWorkingHours(cfg, new Date("2026-10-27T10:00:00Z"))).toBe(false);
    expect(isWithinWorkingHours(cfg, new Date("2026-10-31T02:00:00Z"))).toBe(true);
  });
  it("reads the legacy days shape and honours the timezone", () => {
    const legacy = { timezone: "Asia/Kolkata", workingHours: { days: [1], start: "09:00", end: "17:00" } };
    expect(isWithinWorkingHours(legacy, new Date("2026-10-26T05:00:00Z"))).toBe(true);
    expect(isWithinWorkingHours(legacy, new Date("2026-10-26T01:00:00Z"))).toBe(false);
  });
});

const baseConfig = { autoAssign: true, mode: "round_robin", timezone: "UTC", workingHours: null, maxOpenPerAgent: null, fallbackUserId: null };
const members = [
  { userId: "a", user: { disabledAt: null } },
  { userId: "b", user: { disabledAt: null } },
];

beforeEach(() => {
  vi.resetAllMocks();
  db.routingConfig.findUnique.mockResolvedValue(baseConfig);
  db.conversation.findFirst.mockResolvedValue({ id: "c1", assignedToId: null, status: "open" });
  db.membership.findMany.mockResolvedValue(members);
  db.agentAvailability.findMany.mockResolvedValue([{ userId: "a", available: true, maxOpen: null, lastAssignedAt: new Date(5000) }]);
  db.conversation.groupBy.mockResolvedValue([]);
  db.conversation.updateMany.mockResolvedValue({ count: 1 });
});

describe("assignConversation", () => {
  it("is a no-op when auto-assign is off", async () => {
    db.routingConfig.findUnique.mockResolvedValue({ ...baseConfig, autoAssign: false });
    expect(await assignConversation("t1", "c1")).toEqual({ assignedToId: null, reason: "auto_assign_off" });
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
  });
  it("never reassigns an assigned conversation", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1", assignedToId: "z", status: "open" });
    expect(await assignConversation("t1", "c1")).toEqual({ assignedToId: "z", reason: "already_assigned" });
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
  });
  it("assigns with a tenant-scoped conditional update and records lastAssignedAt", async () => {
    const at = new Date("2026-10-27T10:00:00Z");
    const res = await assignConversation("t1", "c1", { at });
    expect(res).toEqual({ assignedToId: "b", reason: "assigned" });
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1", assignedToId: null }, data: { assignedToId: "b", assignedAt: at } });
    expect(db.agentAvailability.upsert.mock.calls[0][0]).toMatchObject({ where: { tenantId_userId: { tenantId: "t1", userId: "b" } }, update: { lastAssignedAt: at } });
    expect((db.auditLog as unknown as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalled();
  });
  it("loses a race cleanly when the conditional update matches nothing", async () => {
    db.conversation.updateMany.mockResolvedValue({ count: 0 });
    expect((await assignConversation("t1", "c1")).reason).toBe("already_assigned");
    expect(db.agentAvailability.upsert).not.toHaveBeenCalled();
  });
  it("leaves the chat unassigned outside hours unless a fallback is set", async () => {
    const cfg = { ...baseConfig, workingHours: { windows: [{ day: 1, start: "09:00", end: "17:00" }] } };
    db.routingConfig.findUnique.mockResolvedValue(cfg);
    const night = new Date("2026-10-26T20:00:00Z");
    expect(await assignConversation("t1", "c1", { at: night })).toEqual({ assignedToId: null, reason: "outside_hours" });
    db.routingConfig.findUnique.mockResolvedValue({ ...cfg, fallbackUserId: "a" });
    expect(await assignConversation("t1", "c1", { at: night })).toEqual({ assignedToId: "a", reason: "fallback" });
  });
  it("does not use a disabled fallback and reports no agent available", async () => {
    db.membership.findMany.mockResolvedValue([{ userId: "a", user: { disabledAt: new Date() } }]);
    db.routingConfig.findUnique.mockResolvedValue({ ...baseConfig, fallbackUserId: "a" });
    expect(await assignConversation("t1", "c1")).toEqual({ assignedToId: null, reason: "no_agent_available" });
  });
  it("force runs even when auto-assign is off", async () => {
    db.routingConfig.findUnique.mockResolvedValue({ ...baseConfig, autoAssign: false });
    expect((await assignConversation("t1", "c1", { force: true })).reason).toBe("assigned");
  });
});

describe("assignManually", () => {
  const agent = { userId: "a", tenantId: "t1", role: "agent" as const };
  const admin = { userId: "m", tenantId: "t1", role: "admin" as const };
  beforeEach(() => db.membership.findFirst.mockResolvedValue({ user: { disabledAt: null } }));

  it("lets admins assign any member and scopes the write by tenant", async () => {
    expect((await assignManually(admin, "c1", "b")).reason).toBe("manual");
    const where = db.conversation.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: "c1", tenantId: "t1" });
    expect(where).toHaveProperty("assignedToId");
  });
  it("only overwrites the assignment it read, so a concurrent change is reported instead of lost", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1", assignedToId: "a", teamId: null });
    db.conversation.updateMany.mockResolvedValue({ count: 0 });
    await expect(assignManually(admin, "c1", "b")).rejects.toMatchObject({ status: 409 });
    expect(db.conversation.updateMany.mock.calls.at(-1)?.[0].where).toEqual({ id: "c1", tenantId: "t1", assignedToId: "a" });
  });
  it("keeps a chat that belongs to a team with people in it inside that team", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1", assignedToId: null, teamId: "tm1" });
    db.team.findFirst.mockResolvedValue({ id: "tm1" });
    db.teamMember.findMany.mockResolvedValue([{ userId: "b" }]);
    db.conversation.updateMany.mockResolvedValue({ count: 1 });
    await expect(assignManually(admin, "c1", "z")).rejects.toMatchObject({ status: 400 });
    expect((await assignManually(admin, "c1", "b")).assignedToId).toBe("b");
  });
  it("rejects members outside the tenant and disabled users", async () => {
    db.membership.findFirst.mockResolvedValue(null);
    await expect(assignManually(admin, "c1", "x")).rejects.toMatchObject({ status: 400 });
    db.membership.findFirst.mockResolvedValue({ user: { disabledAt: new Date() } });
    await expect(assignManually(admin, "c1", "b")).rejects.toMatchObject({ status: 400 });
  });
  it("lets agents take an unassigned chat for themselves only", async () => {
    expect((await assignManually(agent, "c1", "a")).assignedToId).toBe("a");
    await expect(assignManually(agent, "c1", "b")).rejects.toMatchObject({ status: 403 });
  });
  it("lets agents release their own chat but not someone else's", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1", assignedToId: "a" });
    expect((await assignManually(agent, "c1", null)).reason).toBe("unassigned");
    db.conversation.findFirst.mockResolvedValue({ id: "c1", assignedToId: "b" });
    await expect(assignManually(agent, "c1", null)).rejects.toMatchObject({ status: 403 });
    await expect(assignManually(agent, "c1", "a")).rejects.toMatchObject({ status: 403 });
  });
  it("404s for another tenant's conversation", async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    await expect(assignManually(admin, "zz", "b")).rejects.toMatchObject({ status: 404 });
  });
});

describe("sweeper", () => {
  it("assigns waiting conversations for enabled tenants and stops when nobody is free", async () => {
    db.routingConfig.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    db.conversation.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    db.membership.findMany.mockResolvedValue([]);
    expect(await sweepUnassigned(new Date("2026-10-27T10:00:00Z"))).toBe(0);
    expect(db.conversation.findFirst).toHaveBeenCalledTimes(1);
    const where = db.conversation.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: "t1", assignedToId: null, status: "open" });
    expect(where.lastInboundAt.gte).toEqual(new Date("2026-10-26T10:00:00Z"));
  });
  it("finds a returning customer's old chat by their last message, longest-waiting first", async () => {
    db.routingConfig.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    db.conversation.findMany.mockResolvedValue([]);
    await sweepUnassigned(new Date("2026-10-27T10:00:00Z"));
    const args = db.conversation.findMany.mock.calls[0][0];
    expect(args.where).not.toHaveProperty("createdAt");
    expect(args.orderBy).toEqual({ lastInboundAt: "asc" });
  });
  it("counts assignments and registers a periodic task", async () => {
    db.routingConfig.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    db.conversation.findMany.mockResolvedValue([{ id: "c1" }]);
    expect(await sweepUnassigned()).toBe(1);
    expect(worker.periodic.map((p) => p.name)).toEqual(["routing-sweep", "routing-auto-reassign"]);
  });
});

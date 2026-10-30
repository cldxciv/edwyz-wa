import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  membership: { findFirst: vi.fn() },
}));
const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit }));

import {
  applyTagChange,
  assertCanActOnConversation,
  bulkUpdate,
  canActOn,
  canTransition,
  deriveStatus,
  expiredWhere,
  normalizeStatus,
  parseBulkInput,
  reopenOnInbound,
  setStatus,
  statusWhere,
} from "@/lib/inbox/status";
import type { Actor } from "@/lib/tenancy";

const admin: Actor = { userId: "u1", tenantId: "t1", role: "admin" };
const agent: Actor = { userId: "u2", tenantId: "t1", role: "agent" };
const NOW = new Date("2026-10-27T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

beforeEach(() => {
  vi.clearAllMocks();
  db.conversation.updateMany.mockResolvedValue({ count: 1 });
});

describe("transitions", () => {
  it("allows the documented moves and rejects expired as a target", () => {
    expect(canTransition("open", "solved")).toBe(true);
    expect(canTransition("solved", "open")).toBe(true);
    expect(canTransition("blocked", "solved")).toBe(false);
    expect(canTransition("open", "expired")).toBe(false);
    expect(canTransition("open", "nonsense")).toBe(false);
    expect(canTransition("resolved", "open")).toBe(true);
  });
  it("maps legacy resolved to solved", () => {
    expect(normalizeStatus("resolved")).toBe("solved");
    expect(statusWhere("solved")).toEqual({ status: { in: ["solved", "resolved"] } });
    expect(statusWhere("pending")).toEqual({ status: "pending" });
  });
});

describe("deriveStatus", () => {
  it("is expired when the 24-hour window lapsed", () => {
    expect(deriveStatus({ status: "open", lastInboundAt: hoursAgo(25), lastMessageAt: hoursAgo(25) }, NOW)).toBe("expired");
    expect(deriveStatus({ status: "pending", lastInboundAt: hoursAgo(30), lastMessageAt: hoursAgo(30) }, NOW)).toBe("expired");
  });
  it("stays expired when the business replied after the customer's last message: only the customer extends the window", () => {
    expect(deriveStatus({ status: "open", lastInboundAt: hoursAgo(30), lastMessageAt: hoursAgo(29) }, NOW)).toBe("expired");
    expect(deriveStatus({ status: "pending", lastInboundAt: hoursAgo(48), lastMessageAt: hoursAgo(1) }, NOW)).toBe("expired");
  });
  it("is open again once the customer writes", () => {
    expect(deriveStatus({ status: "open", lastInboundAt: hoursAgo(1), lastMessageAt: hoursAgo(1) }, NOW)).toBe("open");
  });
  it("is not expired inside the window, when solved or blocked, or when the customer never wrote", () => {
    expect(deriveStatus({ status: "open", lastInboundAt: hoursAgo(23), lastMessageAt: hoursAgo(23) }, NOW)).toBe("open");
    expect(deriveStatus({ status: "solved", lastInboundAt: hoursAgo(30), lastMessageAt: hoursAgo(30) }, NOW)).toBe("solved");
    expect(deriveStatus({ status: "blocked", lastInboundAt: hoursAgo(30), lastMessageAt: hoursAgo(30) }, NOW)).toBe("blocked");
    expect(deriveStatus({ status: "open", lastInboundAt: null, lastMessageAt: hoursAgo(30) }, NOW)).toBe("open");
  });
  it("builds the expired list filter without looking at the last message", () => {
    const w = expiredWhere(NOW);
    expect(w.lastInboundAt).toEqual({ lt: hoursAgo(24) });
    expect(w.status).toEqual({ in: ["open", "pending", "expired"] });
    expect(w).not.toHaveProperty("lastMessageAt");
  });
});

describe("canActOn", () => {
  it("lets agents touch only their own or unassigned conversations", () => {
    expect(canActOn(agent, null)).toBe(true);
    expect(canActOn(agent, "u2")).toBe(true);
    expect(canActOn(agent, "u9")).toBe(false);
    expect(canActOn(admin, "u9")).toBe(true);
  });
});

describe("setStatus", () => {
  it("scopes by tenant, stamps statusChangedAt and audits", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1", status: "open", assignedToId: null });
    await setStatus(agent, "c1", "solved");
    expect(db.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: "t1" } }));
    expect(db.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", tenantId: "t1" },
      data: { status: "solved", statusChangedAt: expect.any(Date) },
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "inbox.status.set", tenantId: "t1", meta: { from: "open", to: "solved" } }));
  });
  it("404s for foreign conversations", async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    await expect(setStatus(admin, "x", "open")).rejects.toMatchObject({ status: 404 });
  });
  it("blocks agents from other people's conversations and from blocking", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1", status: "open", assignedToId: "u9" });
    await expect(setStatus(agent, "c1", "solved")).rejects.toMatchObject({ status: 403 });
    await expect(setStatus(agent, "c1", "blocked")).rejects.toMatchObject({ status: 403 });
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
  });
  it("rejects expired targets and invalid transitions", async () => {
    await expect(setStatus(admin, "c1", "expired")).rejects.toMatchObject({ status: 400 });
    db.conversation.findFirst.mockResolvedValue({ id: "c1", status: "blocked", assignedToId: null });
    await expect(setStatus(admin, "c1", "solved")).rejects.toMatchObject({ status: 409 });
  });
  it("does nothing when the status is unchanged", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1", status: "open", assignedToId: null });
    await setStatus(admin, "c1", "open");
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
  });
});

describe("reopenOnInbound", () => {
  it("reopens only solved conversations in the tenant", async () => {
    expect(await reopenOnInbound("t1", "c1", NOW)).toBe(true);
    expect(db.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", tenantId: "t1", status: { in: ["solved", "resolved"] } },
      data: { status: "open", statusChangedAt: NOW },
    });
    expect(audit).toHaveBeenCalled();
  });
  it("returns false and does not audit when nothing changed", async () => {
    db.conversation.updateMany.mockResolvedValue({ count: 0 });
    expect(await reopenOnInbound("t1", "c1")).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("parseBulkInput", () => {
  it("enforces id limits and shapes", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `c${i}`);
    expect(() => parseBulkInput({ ids, action: "status", status: "open" })).toThrow();
    expect(() => parseBulkInput({ ids: [], action: "status", status: "open" })).toThrow();
    expect(() => parseBulkInput({ ids: [1], action: "status", status: "open" })).toThrow();
    expect(() => parseBulkInput({ ids: ["a"], action: "delete" })).toThrow();
    expect(() => parseBulkInput({ ids: ["a"], action: "tag" })).toThrow();
    expect(parseBulkInput({ ids: ["a", "a", "b"], action: "assign", userId: null })).toEqual({ ids: ["a", "b"], action: "assign", userId: null });
    expect(parseBulkInput({ ids: ["a"], action: "tag", add: [" vip "], remove: ["old"] })).toMatchObject({ add: ["vip"], remove: ["old"] });
  });
  it("merges tags", () => {
    expect(applyTagChange(["a", "b"], ["c", "a"], ["b"])).toEqual(["a", "c"]);
  });
});

describe("assertCanActOnConversation", () => {
  it("rejects an agent on a teammate's chat, allows own, unassigned and admin", async () => {
    db.conversation.findFirst.mockResolvedValueOnce({ assignedToId: "u9" });
    await expect(assertCanActOnConversation(agent, "c1")).rejects.toMatchObject({ status: 403 });
    db.conversation.findFirst.mockResolvedValueOnce({ assignedToId: "u2" });
    await expect(assertCanActOnConversation(agent, "c1")).resolves.toBeUndefined();
    db.conversation.findFirst.mockResolvedValueOnce({ assignedToId: null });
    await expect(assertCanActOnConversation(agent, "c1")).resolves.toBeUndefined();
    db.conversation.findFirst.mockResolvedValueOnce(null);
    await expect(assertCanActOnConversation(agent, "c1")).rejects.toMatchObject({ status: 404 });
    await expect(assertCanActOnConversation(admin, "c1")).resolves.toBeUndefined();
  });
});

describe("bulkUpdate", () => {
  const rows = [
    { id: "c1", status: "open", assignedToId: null, tags: [] },
    { id: "c2", status: "open", assignedToId: "u9", tags: [] },
    { id: "c3", status: "blocked", assignedToId: "u2", tags: [] },
  ];
  it("is tenant scoped and skips what the agent may not change", async () => {
    db.conversation.findMany.mockResolvedValue(rows);
    const r = await bulkUpdate(agent, { ids: ["c1", "c2", "c3", "c4"], action: "status", status: "solved" });
    expect(db.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", id: { in: ["c1", "c2", "c3", "c4"] } } }));
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", id: { in: ["c1"] } }, data: { status: "solved", statusChangedAt: expect.any(Date) } });
    expect(r.updated).toBe(1);
    expect(r.skipped).toEqual([
      { id: "c2", reason: "assigned_to_other" },
      { id: "c3", reason: "invalid_transition" },
      { id: "c4", reason: "not_found" },
    ]);
  });
  it("assigns only to workspace members and stamps assignedAt", async () => {
    db.membership.findFirst.mockResolvedValueOnce(null);
    await expect(bulkUpdate(admin, { ids: ["c1"], action: "assign", userId: "zz" })).rejects.toMatchObject({ status: 400 });
    db.membership.findFirst.mockResolvedValueOnce({ id: "m" });
    db.conversation.findMany.mockResolvedValue([rows[0]]);
    await bulkUpdate(admin, { ids: ["c1"], action: "assign", userId: "u2" });
    expect(db.membership.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { tenantId: "t1", userId: "u2" } }));
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", id: { in: ["c1"] } }, data: { assignedToId: "u2", assignedAt: expect.any(Date) } });
  });
  it("lets an agent assign chats only to themselves, like the single assign route", async () => {
    db.conversation.findMany.mockResolvedValue([rows[0]]);
    await expect(bulkUpdate(agent, { ids: ["c1"], action: "assign", userId: "u1" })).rejects.toMatchObject({ status: 403 });
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
    db.membership.findFirst.mockResolvedValueOnce({ id: "m" });
    expect((await bulkUpdate(agent, { ids: ["c1"], action: "assign", userId: "u2" })).updated).toBe(1);
  });
  it("applies tag changes per conversation", async () => {
    db.conversation.findMany.mockResolvedValue([{ ...rows[0], tags: ["x"] }]);
    await bulkUpdate(admin, { ids: ["c1"], action: "tag", add: ["vip"], remove: ["x"] });
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { tags: ["vip"] } });
  });
});

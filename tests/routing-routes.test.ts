import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), groupBy: vi.fn() });
  const d: Record<string, unknown> = { routingConfig: model(), membership: model(), agentAvailability: model(), conversation: model(), auditLog: { create: vi.fn() }, platformSetting: model(), team: model(), teamMember: model(), message: model(), contact: model() };
  d.$transaction = async (fn: (tx: unknown) => unknown) => fn(d);
  return d as Record<string, ReturnType<typeof model>>;
});
const auth = vi.hoisted(() => ({ role: "admin" as "agent" | "admin" | "owner" }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: auth.role }) }));

import { GET as getConfig, PUT as putConfig } from "@/app/api/routing/config/route";
import { GET as getAgents } from "@/app/api/routing/agents/route";
import { PUT as putOwn } from "@/app/api/routing/availability/route";
import { PUT as putAgent } from "@/app/api/routing/agents/[userId]/route";
import { POST as postAssign } from "@/app/api/routing/assign/route";

const ORIGIN = "https://wa.edwyz.com";
const call = (path: string, body: unknown, method = "PUT", origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
const ctx = { params: Promise.resolve({ userId: "u2" }) };
const validConfig = { autoAssign: true, mode: "least_busy", timezone: "Asia/Kolkata", workingHours: { windows: [{ day: 1, start: "09:00", end: "18:00" }] }, maxOpenPerAgent: 10, fallbackUserId: "u2" };

beforeEach(() => {
  vi.resetAllMocks();
  auth.role = "admin";
  db.membership.findFirst.mockResolvedValue({ id: "m1", user: { disabledAt: null } });
  db.agentAvailability.upsert.mockResolvedValue({ userId: "u1", available: false, maxOpen: null, lastAssignedAt: null });
});

describe("routing config route", () => {
  it("is admin or owner only", async () => {
    auth.role = "agent";
    expect((await getConfig(new Request(`${ORIGIN}/api/routing/config`))).status).toBe(403);
    expect((await putConfig(call("/api/routing/config", validConfig))).status).toBe(403);
  });
  it("returns defaults when nothing is stored", async () => {
    db.routingConfig.findUnique.mockResolvedValue(null);
    const body = await (await getConfig(new Request(`${ORIGIN}/api/routing/config`))).json();
    expect(body.config).toMatchObject({ autoAssign: false, mode: "round_robin" });
  });
  it("validates and saves scoped to the tenant", async () => {
    const res = await putConfig(call("/api/routing/config", validConfig));
    expect(res.status).toBe(200);
    expect(db.routingConfig.upsert.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(db.membership.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", userId: "u2" });
  });
  it("rejects bad input and foreign fallback agents", async () => {
    for (const bad of [{ ...validConfig, mode: "random" }, { ...validConfig, timezone: "Nope/Zone" }, { ...validConfig, maxOpenPerAgent: 0 }, { ...validConfig, workingHours: { windows: [{ day: 9, start: "09:00", end: "18:00" }] } }]) {
      expect((await putConfig(call("/api/routing/config", bad))).status).toBe(400);
    }
    db.membership.findFirst.mockResolvedValue(null);
    expect((await putConfig(call("/api/routing/config", validConfig))).status).toBe(400);
    expect(db.routingConfig.upsert).not.toHaveBeenCalled();
  });
  it("blocks cross-origin writes", async () => {
    expect((await putConfig(call("/api/routing/config", validConfig, "PUT", "https://evil.example"))).status).toBe(403);
  });
});

describe("agents and availability routes", () => {
  it("lists agents with availability and open counts for any member", async () => {
    auth.role = "agent";
    db.membership.findMany.mockResolvedValue([{ userId: "u1", role: "agent", user: { name: "A", email: "a@x.test" } }]);
    db.agentAvailability.findMany.mockResolvedValue([{ userId: "u1", available: false, maxOpen: 3, lastAssignedAt: null }]);
    db.conversation.groupBy.mockResolvedValue([{ assignedToId: "u1", _count: { _all: 2 } }]);
    const body = await (await getAgents(new Request(`${ORIGIN}/api/routing/agents`))).json();
    expect(body.agents[0]).toMatchObject({ userId: "u1", available: false, maxOpen: 3, openCount: 2 });
    expect(db.membership.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });
  it("any member sets their own availability, never someone else's", async () => {
    auth.role = "agent";
    expect((await putOwn(call("/api/routing/availability", { available: false }))).status).toBe(200);
    expect(db.agentAvailability.upsert.mock.calls[0][0].where).toEqual({ tenantId_userId: { tenantId: "t1", userId: "u1" } });
    expect((await putOwn(call("/api/routing/availability", { available: "no" }))).status).toBe(400);
    expect((await putAgent(call("/api/routing/agents/u2", { available: false }), ctx)).status).toBe(403);
  });
  it("admins update another agent and validate maxOpen", async () => {
    expect((await putAgent(call("/api/routing/agents/u2", { available: false, maxOpen: 4 }), ctx)).status).toBe(200);
    expect(db.agentAvailability.upsert.mock.calls[0][0].where).toEqual({ tenantId_userId: { tenantId: "t1", userId: "u2" } });
    expect((await putAgent(call("/api/routing/agents/u2", { maxOpen: 0 }), ctx)).status).toBe(400);
    expect((await putAgent(call("/api/routing/agents/u2", {}), ctx)).status).toBe(400);
  });
  it("404s for a user who is not in the tenant", async () => {
    db.membership.findFirst.mockResolvedValue(null);
    expect((await putAgent(call("/api/routing/agents/u2", { available: true }), ctx)).status).toBe(404);
  });
});

describe("assign route", () => {
  it("is admin or owner only", async () => {
    auth.role = "agent";
    expect((await postAssign(call("/api/routing/assign", { conversationId: "c1", userId: "u2" }, "POST"))).status).toBe(403);
  });
  it("assigns manually, unassigns on null, and validates input", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1", assignedToId: "u9" });
    db.conversation.updateMany.mockResolvedValue({ count: 1 });
    expect(await (await postAssign(call("/api/routing/assign", { conversationId: "c1", userId: "u2" }, "POST"))).json()).toMatchObject({ assignedToId: "u2" });
    expect(await (await postAssign(call("/api/routing/assign", { conversationId: "c1", userId: null }, "POST"))).json()).toMatchObject({ assignedToId: null, reason: "unassigned" });
    expect((await postAssign(call("/api/routing/assign", { userId: "u2" }, "POST"))).status).toBe(400);
    expect((await postAssign(call("/api/routing/assign", { conversationId: "c1", userId: 5 }, "POST"))).status).toBe(400);
  });
  it("runs automatic routing when userId is omitted", async () => {
    db.routingConfig.findUnique.mockResolvedValue({ autoAssign: false, mode: "round_robin", timezone: "UTC", workingHours: null, maxOpenPerAgent: null, fallbackUserId: null });
    db.conversation.findFirst.mockResolvedValue({ id: "c1", assignedToId: null, status: "open" });
    db.membership.findMany.mockResolvedValue([{ userId: "u2", user: { disabledAt: null } }]);
    db.agentAvailability.findMany.mockResolvedValue([]);
    db.conversation.groupBy.mockResolvedValue([]);
    db.conversation.updateMany.mockResolvedValue({ count: 1 });
    expect(await (await postAssign(call("/api/routing/assign", { conversationId: "c1" }, "POST"))).json()).toEqual({ assignedToId: "u2", reason: "assigned" });
  });
});

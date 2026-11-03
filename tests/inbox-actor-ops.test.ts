import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeActionsDb } from "./helpers/fake-actions-db";

/**
 * docs/EDDY-SPEC.md 4.4 and EDDY-04: assignAsActor and setTagsAsActor hold the logic that was inline in the assign and tags
 * routes; both routes call them. An agent may only take an unassigned chat for themselves or release their own, an admin is
 * limited to the chat's team pool, and the tag diff keeps an edit someone else made at the same moment. The assignment itself
 * is routing's applyAssignment, which runs for real here: disabled accounts, round-robin, contact owner and the audit row.
 */
const h = vi.hoisted(() => ({
  db: null as unknown as FakeActionsDb,
  actor: { userId: "u_agent", tenantId: "t1", role: "agent" as "agent" | "admin" | "owner" },
  visible: vi.fn(async (_actor: unknown, _id: string) => undefined as void),
  emitTagChanges: vi.fn(async () => undefined),
}));
vi.mock("@/lib/db", async () => {
  const { createFakeActionsDb } = await import("./helpers/fake-actions-db");
  h.db = createFakeActionsDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/teams/visibility", () => ({ assertConversationVisible: h.visible }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitTagChanges: h.emitTagChanges, emitAutomationEvent: vi.fn(), tagChangeEvents: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getActor: async () => h.actor }));

import { AGENT_ASSIGN_MESSAGE, assignAsActor, MAX_CHAT_TAGS, nextTags, setTagsAsActor } from "@/lib/inbox/actor-ops";
import { assign, getConversation } from "@/lib/inbox/service";
import { PUT as assignRoute } from "@/app/api/inbox/conversations/[id]/assign/route";
import { PUT as tagsRoute } from "@/app/api/inbox/conversations/[id]/tags/route";
import { HttpError } from "@/lib/tenancy";

const AGENT = { userId: "u_agent", tenantId: "t1", role: "agent" as const };
const OTHER = { userId: "u_other", tenantId: "t1", role: "agent" as const };
const ADMIN = { userId: "u_admin", tenantId: "t1", role: "admin" as const };

function chat(id: string, over: Record<string, unknown> = {}) {
  return h.db.insert("conversation", { id, tenantId: "t1", contactId: "k1", assignedToId: null, teamId: null, tags: [], status: "open", ...over });
}
const conv = (id: string) => h.db.rows("conversation").find((r) => r.id === id)!;
const audits = (action: string) => h.db.rows("auditLog").filter((r) => r.action === action);

beforeEach(() => {
  h.db.reset();
  vi.clearAllMocks();
  h.visible.mockResolvedValue(undefined);
  h.actor = { ...AGENT };
  for (const m of [AGENT, OTHER, ADMIN]) h.db.insert("membership", { id: `m_${m.userId}`, tenantId: "t1", userId: m.userId, role: m.role, user: { disabledAt: null } });
  // The fake has no upsert; this one is enough for agentAvailability's (tenantId, userId) key.
  (h.db.prisma.agentAvailability as Record<string, unknown>).upsert = async ({ where, create, update }: { where: { tenantId_userId: Record<string, string> }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
    const row = h.db.rows("agentAvailability").find((r) => r.tenantId === where.tenantId_userId.tenantId && r.userId === where.tenantId_userId.userId);
    return row ? Object.assign(row, update) : h.db.insert("agentAvailability", { ...create });
  };
});

describe("assignAsActor", () => {
  it("an agent takes an unassigned chat for themselves ('me' or their own id)", async () => {
    chat("c1");
    const res = await assignAsActor(AGENT, "c1", "me");
    expect(res).toMatchObject({ previousAssigneeId: null, assigneeId: AGENT.userId });
    expect(conv("c1").assignedToId).toBe(AGENT.userId);
    chat("c2");
    await assignAsActor(AGENT, "c2", AGENT.userId);
    expect(conv("c2").assignedToId).toBe(AGENT.userId);
  });

  it("an agent releases their own chat but nobody else's", async () => {
    chat("mine", { assignedToId: AGENT.userId });
    chat("theirs", { assignedToId: OTHER.userId });
    expect(await assignAsActor(AGENT, "mine", "none")).toMatchObject({ previousAssigneeId: AGENT.userId, assigneeId: null });
    expect(conv("mine").assignedToId).toBeNull();
    await expect(assignAsActor(AGENT, "theirs", "none")).rejects.toMatchObject({ status: 403, message: AGENT_ASSIGN_MESSAGE });
    expect(conv("theirs").assignedToId).toBe(OTHER.userId);
  });

  it("an agent cannot hand a chat to someone else or take a teammate's", async () => {
    chat("c1");
    chat("theirs", { assignedToId: OTHER.userId });
    await expect(assignAsActor(AGENT, "c1", OTHER.userId)).rejects.toMatchObject({ status: 403 });
    await expect(assignAsActor(AGENT, "theirs", "me")).rejects.toMatchObject({ status: 403 });
    expect(conv("c1").assignedToId).toBeNull();
  });

  it("an admin assigns anyone in the chat's team pool, and nobody outside it", async () => {
    h.db.insert("team", { id: "team_a", tenantId: "t1", isDefault: false });
    h.db.insert("teamMember", { tenantId: "t1", teamId: "team_a", userId: OTHER.userId });
    chat("c1", { teamId: "team_a", assignedToId: AGENT.userId });
    await expect(assignAsActor(ADMIN, "c1", AGENT.userId)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not in this chat's team/) });
    expect(await assignAsActor(ADMIN, "c1", OTHER.userId)).toMatchObject({ previousAssigneeId: AGENT.userId, assigneeId: OTHER.userId });
    // A team with nobody in it, and chats with no team, accept anyone in the workspace.
    h.db.insert("team", { id: "team_empty", tenantId: "t1", isDefault: false });
    chat("c2", { teamId: "team_empty" });
    await assignAsActor(ADMIN, "c2", AGENT.userId);
    chat("c3");
    await assignAsActor(ADMIN, "c3", OTHER.userId);
    expect([conv("c2").assignedToId, conv("c3").assignedToId]).toEqual([AGENT.userId, OTHER.userId]);
  });

  it("checks visibility first and refuses a missing chat or a non-member", async () => {
    h.visible.mockRejectedValueOnce(new HttpError(404, "Conversation not found."));
    await expect(assignAsActor(AGENT, "hidden", "me")).rejects.toMatchObject({ status: 404 });
    await expect(assignAsActor(ADMIN, "missing", "me")).rejects.toMatchObject({ status: 404 });
    chat("c1");
    await expect(assignAsActor(ADMIN, "c1", "u_stranger")).rejects.toMatchObject({ status: 400, message: "That person is not a member of this workspace." });
  });

  it("follows the routing rules: refuses a disabled account, moves round-robin, lets the contact owner follow and writes routing.assign", async () => {
    h.db.rows("membership").find((m) => m.userId === OTHER.userId)!.user = { disabledAt: new Date() };
    chat("c1");
    await expect(assignAsActor(ADMIN, "c1", OTHER.userId)).rejects.toMatchObject({ status: 400, message: "That person's account is disabled." });
    expect(conv("c1").assignedToId).toBeNull();

    h.db.insert("platformSetting", { key: "routing:extra:t1", value: { setOwnerOnAssign: true } });
    h.db.insert("contact", { id: "k1", tenantId: "t1", ownerUserId: null });
    await assignAsActor(ADMIN, "c1", AGENT.userId);
    expect(conv("c1").assignedToId).toBe(AGENT.userId);
    expect(h.db.rows("agentAvailability").find((r) => r.userId === AGENT.userId)?.lastAssignedAt).toBeInstanceOf(Date);
    expect(h.db.rows("contact").find((r) => r.id === "k1")?.ownerUserId).toBe(AGENT.userId);
    expect(audits("routing.assign")).toEqual([expect.objectContaining({ tenantId: "t1", userId: ADMIN.userId, target: "c1", meta: { assignedToId: AGENT.userId, previousId: null } })]);

    await assignAsActor(AGENT, "c1", "none");
    expect(audits("routing.unassign")).toEqual([expect.objectContaining({ userId: AGENT.userId, target: "c1", meta: { assignedToId: null, previousId: AGENT.userId } })]);
  });

  it("reports a change made meanwhile instead of overwriting it", async () => {
    chat("c1");
    const delegate = h.db.prisma.conversation as { findFirst: (...a: unknown[]) => Promise<unknown> };
    const original = delegate.findFirst;
    delegate.findFirst = async (...a: unknown[]) => {
      const row = await original(...a);
      // A teammate takes the chat right after it was read.
      conv("c1").assignedToId = OTHER.userId;
      return row;
    };
    try {
      await expect(assignAsActor(ADMIN, "c1", AGENT.userId)).rejects.toMatchObject({ status: 409 });
    } finally {
      delegate.findFirst = original;
    }
    expect(conv("c1").assignedToId).toBe(OTHER.userId);
  });
});

describe("assign for the API and the workspace MCP server", () => {
  it("makes the same checks and write as the inbox: team pool, disabled accounts, audit row without a person", async () => {
    h.db.insert("team", { id: "team_a", tenantId: "t1", isDefault: false });
    h.db.insert("teamMember", { tenantId: "t1", teamId: "team_a", userId: OTHER.userId });
    chat("c1", { teamId: "team_a" });
    await expect(assign("t1", "c1", AGENT.userId)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not in this chat's team/) });
    await expect(assign("t1", "c1", "u_stranger")).rejects.toMatchObject({ status: 400, message: "That person is not a member of this workspace." });
    await expect(assign("t1", "missing", OTHER.userId)).rejects.toMatchObject({ status: 404 });
    expect(await assign("t1", "c1", OTHER.userId)).toMatchObject({ id: "c1", assignedToId: OTHER.userId });
    expect(h.db.rows("agentAvailability").find((r) => r.userId === OTHER.userId)?.lastAssignedAt).toBeInstanceOf(Date);
    expect(audits("routing.assign")).toEqual([expect.objectContaining({ tenantId: "t1", userId: null, target: "c1" })]);
    h.db.rows("membership").find((m) => m.userId === OTHER.userId)!.user = { disabledAt: new Date() };
    chat("c2");
    await expect(assign("t1", "c2", OTHER.userId)).rejects.toMatchObject({ status: 400, message: "That person's account is disabled." });
    expect(await assign("t1", "c1", null)).toMatchObject({ assignedToId: null });
  });
});

describe("getConversation", () => {
  it("tells the inbox which WhatsApp Business Account the chat's number belongs to, so its picker offers only those templates", async () => {
    chat("c1", { lastInboundAt: null });
    const findFirst = vi.spyOn(h.db.prisma.conversation as { findFirst: (a: unknown) => Promise<unknown> }, "findFirst");
    await getConversation("t1", "c1");
    expect((findFirst.mock.calls[0][0] as { include: { phoneNumber: unknown } }).include.phoneNumber).toEqual({ select: { id: true, displayPhone: true, verifiedName: true, wabaRefId: true } });
    findFirst.mockRestore();
  });
});

describe("setTagsAsActor", () => {
  it("applies a diff: removals first, then additions; announces the change", async () => {
    chat("c1", { tags: ["new", "lead"] });
    const res = await setTagsAsActor(AGENT, "c1", { add: ["vip", " vip "], remove: ["new"] });
    expect(res).toMatchObject({ before: ["new", "lead"], after: ["lead", "vip"], added: ["vip"], removed: ["new"] });
    expect(conv("c1").tags).toEqual(["lead", "vip"]);
    expect(h.emitTagChanges).toHaveBeenCalledWith({ tenantId: "t1", contactId: "k1", conversationId: "c1" }, ["new", "lead"], ["lead", "vip"]);
  });

  it("keeps a concurrent edit: the write is a compare-and-set and the diff is re-applied", async () => {
    chat("c1", { tags: ["lead"] });
    const delegate = h.db.prisma.conversation as { findFirst: (...a: unknown[]) => Promise<unknown> };
    const original = delegate.findFirst;
    let reads = 0;
    delegate.findFirst = async (...a: unknown[]) => {
      const row = await original(...a);
      // Someone else adds "urgent" right after our first read.
      if (++reads === 1) conv("c1").tags = ["lead", "urgent"];
      return row;
    };
    try {
      const res = await setTagsAsActor(AGENT, "c1", { add: ["vip"], remove: ["lead"] });
      expect(res.after).toEqual(["urgent", "vip"]);
      expect(conv("c1").tags).toEqual(["urgent", "vip"]);
      expect(h.emitTagChanges).toHaveBeenCalledWith(expect.anything(), ["lead", "urgent"], ["urgent", "vip"]);
    } finally {
      delegate.findFirst = original;
    }
  });

  it("replaces the list in set mode (the route's contract)", async () => {
    chat("c1", { tags: ["a", "b"] });
    expect((await setTagsAsActor(AGENT, "c1", { set: ["b", " c ", "", "c"] })).after).toEqual(["b", "c"]);
    expect(conv("c1").tags).toEqual(["b", "c"]);
  });

  it("an agent cannot tag a teammate's chat; hidden chats are not found", async () => {
    chat("theirs", { assignedToId: OTHER.userId });
    await expect(setTagsAsActor(AGENT, "theirs", { add: ["sneaky"] })).rejects.toMatchObject({ status: 403 });
    expect(conv("theirs").tags).toEqual([]);
    h.visible.mockRejectedValueOnce(new HttpError(404, "Conversation not found."));
    await expect(setTagsAsActor(AGENT, "theirs", { add: ["x"] })).rejects.toMatchObject({ status: 404 });
    expect(await setTagsAsActor(ADMIN, "theirs", { add: ["ok"] })).toMatchObject({ after: ["ok"] });
  });

  it("validates tags and the chat's tag limit, and writes nothing for a no-op", async () => {
    chat("c1", { tags: ["a"] });
    await expect(setTagsAsActor(AGENT, "c1", { add: ["a"], remove: ["a"] })).rejects.toMatchObject({ status: 400 });
    await expect(setTagsAsActor(AGENT, "c1", { add: ["x".repeat(41)] })).rejects.toMatchObject({ status: 400 });
    chat("full", { tags: Array.from({ length: MAX_CHAT_TAGS }, (_, i) => `t${i}`) });
    await expect(setTagsAsActor(AGENT, "full", { add: ["one-more"] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/at most 20/) });
    expect((await setTagsAsActor(AGENT, "full", { remove: ["t0"] })).after).toHaveLength(MAX_CHAT_TAGS - 1);
    const update = vi.spyOn(h.db.prisma.conversation as { updateMany: () => Promise<unknown> }, "updateMany");
    expect(await setTagsAsActor(AGENT, "c1", { add: ["a"] })).toMatchObject({ before: ["a"], after: ["a"], added: [] });
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("gives up with 409 when the tags keep changing", async () => {
    chat("c1", { tags: [] });
    const delegate = h.db.prisma.conversation as { updateMany: (...a: unknown[]) => Promise<{ count: number }> };
    const original = delegate.updateMany;
    delegate.updateMany = async () => ({ count: 0 });
    try {
      await expect(setTagsAsActor(AGENT, "c1", { add: ["x"] })).rejects.toMatchObject({ status: 409 });
    } finally {
      delegate.updateMany = original;
    }
  });

  it("nextTags is exact and order-preserving", () => {
    expect(nextTags(["a", "B"], { add: ["b", "c"], remove: ["a"] })).toEqual(["B", "b", "c"]);
    expect(nextTags(["a"], { set: ["z", "a", "z"] })).toEqual(["z", "a"]);
  });
});

describe("the routes call the shared operations", () => {
  const ORIGIN = "https://wa.edwyz.com";
  const put = (body: unknown, origin = ORIGIN) => new Request(`${ORIGIN}/x`, { method: "PUT", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("PUT assign keeps its contract: 200 with the conversation, 403 for an agent handing a chat on, 400 for a bad body", async () => {
    chat("c1");
    const res = await assignRoute(put({ userId: AGENT.userId }), ctx("c1"));
    expect(res.status).toBe(200);
    expect((await res.json()).conversation).toMatchObject({ id: "c1", assignedToId: AGENT.userId });
    expect((await assignRoute(put({ userId: OTHER.userId }), ctx("c1"))).status).toBe(403);
    expect((await assignRoute(put({ userId: 5 }), ctx("c1"))).status).toBe(400);
    expect((await assignRoute(put({ userId: null }), ctx("c1"))).status).toBe(200);
    expect(conv("c1").assignedToId).toBeNull();
    expect((await assignRoute(put({ userId: null }, "https://evil.example"), ctx("c1"))).status).toBe(403);
  });

  it("PUT tags keeps its contract: replaces the list, refuses bad bodies and teammates' chats", async () => {
    chat("c1", { tags: ["old"] });
    const res = await tagsRoute(put({ tags: ["vip", "new"] }), ctx("c1"));
    expect(res.status).toBe(200);
    expect((await res.json()).conversation.tags).toEqual(["vip", "new"]);
    expect((await tagsRoute(put({ tags: "vip" }), ctx("c1"))).status).toBe(400);
    expect((await tagsRoute(put({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }), ctx("c1"))).status).toBe(400);
    chat("theirs", { assignedToId: OTHER.userId });
    expect((await tagsRoute(put({ tags: ["sneaky"] }), ctx("theirs"))).status).toBe(403);
    h.visible.mockRejectedValueOnce(new HttpError(404, "Conversation not found."));
    expect((await tagsRoute(put({ tags: ["a"] }), ctx("c1"))).status).toBe(404);
  });
});

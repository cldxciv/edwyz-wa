import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() });
  return { conversation: model(), conversationMark: model(), membership: model(), $queryRaw: vi.fn() };
});
const vis = vi.hoisted(() => ({ viewerRules: vi.fn(), rulesToWhere: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/teams/visibility", async (orig) => ({ ...(await orig<typeof import("@/lib/teams/visibility")>()), viewerRules: vis.viewerRules, rulesToWhere: vis.rulesToWhere }));

import {
  campaignConversationIds,
  clearReadMarks,
  flagsFor,
  listMentions,
  markedConversationIds,
  notifyMentions,
  setMark,
} from "@/lib/inbox/marks";
import { extractMentions, mentionMatches, mentionQuery, splitMentions } from "@/lib/inbox/mentions";
import { hasReplyVariables, renderReplyVariables } from "@/lib/inbox/variables";

const members = [
  { userId: "u1", name: "Priya Shah" },
  { userId: "u2", name: "Rahul Mehta" },
  { userId: "u3", name: "Rahul Verma" },
  { userId: "u4", name: "Anil" },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.conversation.findFirst.mockResolvedValue({ id: "cv1" });
  db.conversationMark.findMany.mockResolvedValue([]);
  db.membership.findMany.mockResolvedValue(members.map((m) => ({ userId: m.userId, role: "agent", user: { name: m.name } })));
  vis.viewerRules.mockResolvedValue({ onlyAssigned: false, teamIds: null, includeUnteamed: true, maskPhone: false });
  vis.rulesToWhere.mockReturnValue(null);
});

describe("personal marks", () => {
  it("stars a chat for one agent, after checking the chat belongs to the workspace", async () => {
    await setMark("t1", "u1", "cv1", "favorite", true);
    expect(db.conversation.findFirst).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1" }, select: { id: true } });
    expect(db.conversationMark.upsert).toHaveBeenCalledWith({
      where: { conversationId_userId_kind: { conversationId: "cv1", userId: "u1", kind: "favorite" } },
      create: { tenantId: "t1", conversationId: "cv1", userId: "u1", kind: "favorite" },
      update: {},
    });
  });

  it("removes only the caller's mark when switched off", async () => {
    await setMark("t1", "u1", "cv1", "unread", false);
    expect(db.conversationMark.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", userId: "u1", conversationId: "cv1", kind: "unread" } });
    expect(db.conversationMark.upsert).not.toHaveBeenCalled();
  });

  it("404s for a chat of another workspace without writing", async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    await expect(setMark("t1", "u1", "foreign", "favorite", true)).rejects.toMatchObject({ status: 404 });
    expect(db.conversationMark.upsert).not.toHaveBeenCalled();
  });

  it("clears the manual unread flag and the mention notice together when the chat is opened", async () => {
    await clearReadMarks("t1", "u1", "cv1");
    expect(db.conversationMark.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", userId: "u1", conversationId: "cv1", kind: { in: ["unread", "mention"] } } });
  });

  it("reads marks for a page of chats and for a whole view, always for the viewer", async () => {
    db.conversationMark.findMany.mockResolvedValueOnce([
      { conversationId: "a", kind: "favorite" },
      { conversationId: "a", kind: "unread" },
      { conversationId: "b", kind: "other" },
    ]);
    const flags = await flagsFor("t1", "u1", ["a", "b"]);
    expect(flags.get("a")).toEqual({ favorite: true, unread: true, mention: false });
    expect(flags.get("b")).toEqual({ favorite: false, unread: false, mention: false });
    expect(await flagsFor("t1", "u1", [])).toEqual(new Map());
    db.conversationMark.findMany.mockResolvedValueOnce([{ conversationId: "x" }]);
    expect(await markedConversationIds("t1", "u1", "favorite")).toEqual(["x"]);
    expect(db.conversationMark.findMany.mock.calls.at(-1)?.[0].where).toEqual({ tenantId: "t1", userId: "u1", kind: "favorite" });
  });
});

describe("campaign label", () => {
  it("labels a page of chats with one tenant-scoped query and nothing for an empty page", async () => {
    db.$queryRaw.mockResolvedValue([{ id: "a" }]);
    expect(await campaignConversationIds("t1", ["a", "b"])).toEqual(["a"]);
    const [strings, ...values] = db.$queryRaw.mock.calls[0];
    expect(strings.join("?")).toMatch(/"lastInboundAt" IS NULL OR c."lastInboundAt" < m."createdAt"/);
    expect(values.filter((v: unknown) => v === "t1").length).toBe(3);
    expect(values).toContainEqual(["a", "b"]);
    expect(await campaignConversationIds("t1", [])).toEqual([]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("only looks at the last 30 days of broadcast messages", async () => {
    db.$queryRaw.mockResolvedValue([]);
    const now = new Date("2026-10-27T00:00:00Z");
    await campaignConversationIds("t1", undefined, now);
    const since = db.$queryRaw.mock.calls[0].slice(1).find((v: unknown) => v instanceof Date) as Date;
    expect(now.getTime() - since.getTime()).toBe(30 * 86_400_000);
  });
});

describe("mentions", () => {
  it("finds full names and unique first names, never the author, never partial words", () => {
    expect(extractMentions("hey @Priya Shah, please look. cc @Anil", members)).toEqual(["u1", "u4"]);
    expect(extractMentions("@Rahul Mehta can you check", members)).toEqual(["u2"]);
    expect(extractMentions("@Rahul is ambiguous", members)).toEqual([]);
    expect(extractMentions("mail me@Anil.com", members)).toEqual([]);
    expect(extractMentions("@Anilkumar is someone else", members)).toEqual([]);
    expect(extractMentions("@Priya Shah wrote this", members, "u1")).toEqual([]);
    expect(extractMentions("no mentions here", members)).toEqual([]);
    expect(extractMentions("@anil lower case works", members)).toEqual(["u4"]);
  });

  it("splits a note into plain and mention parts for display", () => {
    expect(splitMentions("ask @Priya Shah or @Anil today", members)).toEqual([
      { text: "ask ", mention: false },
      { text: "@Priya Shah", mention: true },
      { text: " or ", mention: false },
      { text: "@Anil", mention: true },
      { text: " today", mention: false },
    ]);
    expect(splitMentions("plain", members)).toEqual([{ text: "plain", mention: false }]);
    expect(splitMentions("anything", [])).toEqual([{ text: "anything", mention: false }]);
  });

  it("offers matching teammates while typing after @", () => {
    expect(mentionQuery("note for @ra", 12)).toEqual({ query: "ra", start: 9 });
    expect(mentionQuery("email a@b.com", 13)).toBeNull();
    expect(mentionQuery("no at sign", 10)).toBeNull();
    expect(mentionMatches("ra", members).map((m) => m.userId)).toEqual(["u2", "u3"]);
    expect(mentionMatches("", members, 2)).toHaveLength(2);
  });

  it("notifies each mentioned teammate once, using workspace members only", async () => {
    const notified = await notifyMentions("t1", "u1", "cv1", "@Rahul Mehta and @Anil, also @Rahul Mehta again, and @Priya Shah");
    expect(notified.sort()).toEqual(["u2", "u4"]);
    expect(db.membership.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1" } }));
    expect(db.conversationMark.upsert).toHaveBeenCalledTimes(2);
    expect(db.conversationMark.upsert.mock.calls[0][0].create).toMatchObject({ tenantId: "t1", conversationId: "cv1", kind: "mention" });
  });

  it("does no lookup for a note without an @", async () => {
    expect(await notifyMentions("t1", "u1", "cv1", "plain note")).toEqual([]);
    expect(db.membership.findMany).not.toHaveBeenCalled();
  });

  it("skips a mentioned teammate who may not see the chat, and still notifies the one who may", async () => {
    vis.rulesToWhere.mockImplementation((v: { userId: string }) => (v.userId === "u2" ? { assignedToId: v.userId } : null));
    db.conversation.findFirst.mockResolvedValue(null);
    const notified = await notifyMentions("t1", "u1", "cv1", "@Rahul Mehta and @Anil");
    expect(notified).toEqual(["u4"]);
    expect(db.conversationMark.upsert).toHaveBeenCalledTimes(1);
    expect(db.conversationMark.upsert.mock.calls[0][0].create).toMatchObject({ userId: "u4" });
    expect(db.conversation.findFirst).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1", assignedToId: "u2" }, select: { id: true } });
  });

  it("does no lookup for a note without an @", async () => {
    expect(await notifyMentions("t1", "u1", "cv1", "plain note")).toEqual([]);
    expect(db.membership.findMany).not.toHaveBeenCalled();
  });

  const viewer = { tenantId: "t1", userId: "u1", role: "agent" as const };

  it("lists the caller's unread mentions with the chat's contact, skipping chats that are gone", async () => {
    const at = new Date();
    db.conversationMark.findMany.mockResolvedValue([
      { conversationId: "a", createdAt: at },
      { conversationId: "gone", createdAt: at },
    ]);
    db.conversation.findMany.mockResolvedValue([{ id: "a", contact: { name: "Asha", phone: "+911", bsuid: null, username: null } }]);
    expect(await listMentions(viewer)).toEqual([{ conversationId: "a", contactName: "Asha", phone: "+911", bsuid: null, username: null, mentionedAt: at }]);
    expect(db.conversationMark.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", userId: "u1", kind: "mention" });
    expect(db.conversation.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", id: { in: ["a", "gone"] } });
  });

  it("applies the viewer's visibility scope to the chats it looks up", async () => {
    vis.rulesToWhere.mockReturnValue({ OR: [{ assignedToId: "u1" }, { teamId: "tm1" }] });
    db.conversationMark.findMany.mockResolvedValue([{ conversationId: "hidden", createdAt: new Date() }]);
    db.conversation.findMany.mockResolvedValue([]);
    expect(await listMentions(viewer)).toEqual([]);
    expect(db.conversation.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", id: { in: ["hidden"] }, OR: [{ assignedToId: "u1" }, { teamId: "tm1" }] });
  });

  it("masks the phone for a viewer whose numbers are masked", async () => {
    vis.viewerRules.mockResolvedValue({ onlyAssigned: false, teamIds: null, includeUnteamed: true, maskPhone: true });
    db.conversationMark.findMany.mockResolvedValue([{ conversationId: "a", createdAt: new Date() }]);
    db.conversation.findMany.mockResolvedValue([{ id: "a", contact: { name: "Asha", phone: "+919876543210", bsuid: null, username: null } }]);
    const [notice] = await listMentions(viewer);
    expect(notice.phone).toBe("+919*****3210");
  });
});

describe("quick reply variables", () => {
  const ctx = { contactName: "Asha Rao", phone: "+919876543210", agentName: "Priya Shah" };

  it("fills name, first name, phone and the agent", () => {
    expect(renderReplyVariables("Hi {{name}}, this is {{agent}}. Call {{phone}}.", ctx)).toBe("Hi Asha Rao, this is Priya Shah. Call +919876543210.");
    expect(renderReplyVariables("Hi {{first_name}}, {{agent_first_name}} here", ctx)).toBe("Hi Asha, Priya here");
  });

  it("is forgiving about spacing and case, and says 'there' when the name is unknown", () => {
    expect(renderReplyVariables("Hi {{ NAME }}!", { contactName: null })).toBe("Hi there!");
    expect(renderReplyVariables("Hi {{first_name}}!", { contactName: "  " })).toBe("Hi there!");
  });

  it("leaves other placeholders alone, such as template numbers", () => {
    expect(renderReplyVariables("Order {{1}} for {{name}} {{unknown}}", ctx)).toBe("Order {{1}} for Asha Rao {{unknown}}");
    expect(hasReplyVariables("Hi {{name}}")).toBe(true);
    expect(hasReplyVariables("Hi {{1}}")).toBe(false);
  });
});

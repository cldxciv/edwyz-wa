import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() });
  return { conversation: model(), message: model(), conversationMark: model(), $queryRaw: vi.fn() };
});
vi.mock("@/lib/db", () => ({ prisma: db }));

import { listConversations, makeSnippet, newLabel, searchDigits } from "@/lib/inbox/list";

const NOW = Date.now();
const convo = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "open",
  lastInboundAt: new Date(NOW - 3_600_000),
  firstAgentReplyAt: null,
  contact: { id: `c-${id}`, phone: "+919876543210", name: "Asha" },
  messages: [],
  ...extra,
});

const whereOf = () => db.conversation.findMany.mock.calls[0][0].where;

beforeEach(() => {
  vi.clearAllMocks();
  db.conversation.findFirst.mockResolvedValue(null);
  db.conversation.findMany.mockResolvedValue([]);
  db.message.findMany.mockResolvedValue([]);
  db.conversationMark.findMany.mockResolvedValue([]);
  db.$queryRaw.mockResolvedValue([]);
});

describe("search helpers", () => {
  it("reads digits out of a typed number, ignoring spaces, dashes and a plus", () => {
    expect(searchDigits("98765 43210")).toBe("9876543210");
    expect(searchDigits("+91-98765-43210")).toBe("919876543210");
    expect(searchDigits("3210")).toBe("3210");
    expect(searchDigits("12")).toBeNull();
    expect(searchDigits("asha 1234")).toBeNull();
  });

  it("builds a short excerpt around the first match", () => {
    const body = `${"a".repeat(60)} the invoice is ready ${"b".repeat(80)}`;
    const snippet = makeSnippet(body, "INVOICE");
    expect(snippet).toContain("invoice is ready");
    expect(snippet.startsWith("...")).toBe(true);
    expect(snippet.endsWith("...")).toBe(true);
    expect(snippet.length).toBeLessThan(110);
    expect(makeSnippet("short text", "zzz")).toBe("short text");
  });
});

describe("listConversations search", () => {
  it("searches names, numbers and message text for the tenant only", async () => {
    db.message.findMany.mockResolvedValue([
      { conversationId: "c9", body: "Where is my invoice number 42?" },
      { conversationId: "c9", body: "invoice again" },
    ]);
    await listConversations("t1", { search: "invoice" });
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", body: { contains: "invoice", mode: "insensitive" } }, take: 300, orderBy: { createdAt: "desc" } }),
    );
    const where = whereOf();
    expect(where.tenantId).toBe("t1");
    expect(where.AND[0].OR).toEqual([
      {
        contact: {
          OR: [
            { name: { contains: "invoice", mode: "insensitive" } },
            { phone: { contains: "invoice" } },
            { username: { contains: "invoice", mode: "insensitive" } },
            { bsuid: { contains: "invoice", mode: "insensitive" } },
          ],
        },
      },
      { id: { in: ["c9"] } },
    ]);
  });

  it("applies the viewer's scope to the message-text search so hidden chats cannot use up the cap or leak a snippet", async () => {
    const scope = { OR: [{ assignedToId: "u1" }, { teamId: "tm1" }] };
    await listConversations("t1", { search: "invoice", scope });
    expect(db.message.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", body: { contains: "invoice", mode: "insensitive" }, conversation: scope });
    await listConversations("t1", { search: "invoice", scope: {} });
    expect(db.message.findMany.mock.calls[1][0].where).toEqual({ tenantId: "t1", body: { contains: "invoice", mode: "insensitive" } });
  });

  it("matches the last digits of a phone number whatever the formatting", async () => {
    await listConversations("t1", { search: "98765 43210" });
    expect(whereOf().AND[0].OR[0].contact.OR[1]).toEqual({ phone: { contains: "9876543210" } });
    await listConversations("t1", { search: "3210" });
    expect(db.conversation.findMany.mock.calls[1][0].where.AND[0].OR[0].contact.OR[1]).toEqual({ phone: { contains: "3210" } });
  });

  it("does not search message text for one or two characters", async () => {
    await listConversations("t1", { search: "ab" });
    expect(db.message.findMany).not.toHaveBeenCalled();
    expect(whereOf().AND[0].OR).toHaveLength(1);
  });

  it("returns an excerpt for rows found by message text when the viewer is known", async () => {
    db.message.findMany.mockResolvedValue([{ conversationId: "c1", body: "the invoice is ready" }]);
    db.conversation.findMany.mockResolvedValue([convo("c1")]);
    const { items } = await listConversations("t1", { search: "invoice", viewerId: "u1" });
    expect(items[0]).toMatchObject({ id: "c1", matchSnippet: expect.stringContaining("invoice") });
  });
});

describe("listConversations views and flags", () => {
  it("lists favourites and mentions from the viewer's own marks only", async () => {
    db.conversationMark.findMany.mockResolvedValue([{ conversationId: "c1" }, { conversationId: "c2" }]);
    await listConversations("t1", { view: "favorite", viewerId: "u1" });
    expect(db.conversationMark.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", userId: "u1", kind: "favorite" } }));
    expect(whereOf().AND).toContainEqual({ id: { in: ["c1", "c2"] } });
    await listConversations("t1", { view: "mentioned", viewerId: "u1" });
    expect(db.conversationMark.findMany.mock.calls[1][0].where.kind).toBe("mention");
  });

  it("shows nothing for favourites when nobody is signed in", async () => {
    await listConversations("t1", { view: "favorite" });
    expect(whereOf().AND).toContainEqual({ id: { in: [] } });
    expect(db.conversationMark.findMany).not.toHaveBeenCalled();
  });

  it("builds the New and Active views from conversation columns", async () => {
    await listConversations("t1", { view: "new" });
    expect(whereOf().AND).toContainEqual({ firstAgentReplyAt: null, lastInboundAt: { not: null }, status: { in: ["open", "pending"] } });
    await listConversations("t1", { view: "active" });
    const active = db.conversation.findMany.mock.calls[1][0].where.AND[0];
    expect(active.lastInboundAt.gte).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - 86_400_000 - active.lastInboundAt.gte.getTime())).toBeLessThan(5000);
  });

  it("lists campaign chats from the broadcast join, scoped to the tenant", async () => {
    db.$queryRaw.mockResolvedValue([{ id: "c5" }]);
    await listConversations("t1", { view: "campaign" });
    const [strings, ...values] = db.$queryRaw.mock.calls[0];
    expect(strings.join("?")).toContain("BroadcastRecipient");
    expect(values.filter((v: unknown) => v === "t1").length).toBeGreaterThanOrEqual(3);
    expect(whereOf().AND).toContainEqual({ id: { in: ["c5"] } });
  });

  it("includes chats the viewer marked unread in the Unread filter", async () => {
    db.conversationMark.findMany.mockResolvedValue([{ conversationId: "c3" }]);
    await listConversations("t1", { unread: true, viewerId: "u1" });
    expect(whereOf().AND[0]).toEqual({ OR: [{ unreadCount: { gt: 0 } }, { id: { in: ["c3"] } }] });
  });

  it("ANDs the caller's visibility scope into the query", async () => {
    await listConversations("t1", { scope: { AND: [{ assignedToId: "u1" }] } });
    expect(whereOf().AND).toContainEqual({ AND: [{ assignedToId: "u1" }] });
  });

  it("adds labels and the viewer's own flags to each row", async () => {
    db.conversation.findMany.mockResolvedValue([convo("c1"), convo("c2", { firstAgentReplyAt: new Date() }), convo("c3", { status: "solved" })]);
    db.$queryRaw.mockResolvedValue([{ id: "c2" }]);
    db.conversationMark.findMany.mockResolvedValue([
      { conversationId: "c1", kind: "favorite" },
      { conversationId: "c1", kind: "mention" },
    ]);
    const { items } = await listConversations("t1", { viewerId: "u1" });
    expect(items[0]).toMatchObject({ labels: ["new"], flags: { favorite: true, unread: false, mention: true } });
    expect(items[1]).toMatchObject({ labels: ["campaign"], flags: { favorite: false, unread: false, mention: false } });
    expect((items[2] as unknown as { labels: string[] }).labels).toEqual([]);
    expect(db.conversationMark.findMany.mock.calls.at(-1)?.[0].where).toEqual({ tenantId: "t1", userId: "u1", conversationId: { in: ["c1", "c2", "c3"] } });
  });

  it("skips the extra queries when the caller has no viewer (API and MCP callers)", async () => {
    db.conversation.findMany.mockResolvedValue([convo("c1")]);
    const { items } = await listConversations("t1", {});
    expect(items[0]).not.toHaveProperty("labels");
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("pages with a cursor that must belong to the tenant", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "c1" });
    db.conversation.findMany.mockResolvedValue([convo("c2"), convo("c3")]);
    const page = await listConversations("t1", { cursor: "c1", limit: 1 });
    expect(db.conversation.findFirst).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, select: { id: true } });
    expect(page.nextCursor).toBe("c2");
  });
});

describe("status labels", () => {
  it("is New only when the customer wrote, nobody replied and the chat is open or pending", () => {
    expect(newLabel({ id: "a", status: "open", lastInboundAt: new Date(), firstAgentReplyAt: null })).toBe(true);
    expect(newLabel({ id: "a", status: "pending", lastInboundAt: new Date(), firstAgentReplyAt: null })).toBe(true);
    expect(newLabel({ id: "a", status: "open", lastInboundAt: new Date(), firstAgentReplyAt: new Date() })).toBe(false);
    expect(newLabel({ id: "a", status: "open", lastInboundAt: null, firstAgentReplyAt: null })).toBe(false);
    expect(newLabel({ id: "a", status: "solved", lastInboundAt: new Date(), firstAgentReplyAt: null })).toBe(false);
  });
});

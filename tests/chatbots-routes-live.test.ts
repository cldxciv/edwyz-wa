import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() });
  return { chatbot: model(), chatbotSession: model(), conversation: model(), contact: model(), team: model(), phoneNumber: model() };
});
const auth = vi.hoisted(() => ({ role: "agent" as "agent" | "admin" | "owner", userId: "u1" }));
const visible = vi.hoisted(() => ({ assertConversationVisible: vi.fn() }));
const chatbots = vi.hoisted(() => ({ startChatbot: vi.fn(), getConversationBotState: vi.fn(), stopConversationBot: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: auth.userId, tenantId: "t1", role: auth.role }) }));
vi.mock("@/lib/teams/visibility", () => visible);
vi.mock("@/lib/chatbots", () => chatbots);
const wiring = vi.hoisted(() => ({ wireModules: vi.fn() }));
vi.mock("@/lib/wiring", () => wiring);

import { POST as start } from "@/app/api/chatbots/[id]/start/route";
import { GET as stats } from "@/app/api/chatbots/[id]/stats/route";
import { GET as live } from "@/app/api/chatbots/live/route";
import { POST as stop } from "@/app/api/chatbots/live/stop/route";
import { GET as options } from "@/app/api/chatbots/options/route";

const ORIGIN = "https://wa.edwyz.com";
const post = (path: string, body?: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: "b1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = "agent";
  auth.userId = "u1";
  visible.assertConversationVisible.mockResolvedValue(undefined);
  db.conversation.findFirst.mockResolvedValue({ assignedToId: null });
  chatbots.startChatbot.mockResolvedValue({ sessionId: "s1", status: "waiting" });
  chatbots.stopConversationBot.mockResolvedValue(true);
});

describe("start", () => {
  it("an agent starts a chatbot on an unassigned chat as a manual start for their own workspace", async () => {
    const res = await start(post("/api/chatbots/b1/start", { conversationId: "c1" }), ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sessionId: "s1", status: "waiting" });
    expect(chatbots.startChatbot).toHaveBeenCalledWith({ tenantId: "t1" }, "b1", "c1", { source: "manual" });
    expect(visible.assertConversationVisible).toHaveBeenCalled();
    expect(db.conversation.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1" });
  });

  it("wires routing into the engine before starting, so a hand-over in this run assigns the chat", async () => {
    const order: string[] = [];
    wiring.wireModules.mockImplementation(() => void order.push("wire"));
    chatbots.startChatbot.mockImplementation(async () => {
      order.push("start");
      return { sessionId: "s1", status: "waiting" };
    });
    await start(post("/api/chatbots/b1/start", { conversationId: "c1" }), ctx);
    expect(order).toEqual(["wire", "start"]);
  });

  it("an agent may start on their own chat but not on a colleague's; admins may start anywhere", async () => {
    db.conversation.findFirst.mockResolvedValue({ assignedToId: "u1" });
    expect((await start(post("/api/chatbots/b1/start", { conversationId: "c1" }), ctx)).status).toBe(201);
    db.conversation.findFirst.mockResolvedValue({ assignedToId: "u2" });
    expect((await start(post("/api/chatbots/b1/start", { conversationId: "c1" }), ctx)).status).toBe(403);
    auth.role = "admin";
    expect((await start(post("/api/chatbots/b1/start", { conversationId: "c1" }), ctx)).status).toBe(201);
  });

  it("rejects a foreign origin, a missing conversation, a hidden chat and unknown chats", async () => {
    expect((await start(post("/api/chatbots/b1/start", { conversationId: "c1" }, "https://evil.example.com"), ctx)).status).toBe(403);
    expect((await start(post("/api/chatbots/b1/start", {}), ctx)).status).toBe(400);
    visible.assertConversationVisible.mockRejectedValue(Object.assign(new Error("Conversation not found."), { status: 404, name: "HttpError" }));
    const hidden = await start(post("/api/chatbots/b1/start", { conversationId: "c1" }), ctx);
    expect(hidden.status).toBeGreaterThanOrEqual(400);
    visible.assertConversationVisible.mockResolvedValue(undefined);
    db.conversation.findFirst.mockResolvedValue(null);
    expect((await start(post("/api/chatbots/b1/start", { conversationId: "nope" }), ctx)).status).toBe(404);
    expect(chatbots.startChatbot).not.toHaveBeenCalled();
  });

  it("passes the reason a start is refused back to the person", async () => {
    const { HttpError } = await import("@/lib/tenancy");
    chatbots.startChatbot.mockRejectedValue(new HttpError(409, "Publish the chatbot before starting it."));
    const res = await start(post("/api/chatbots/b1/start", { conversationId: "c1" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Publish/);
  });
});

describe("live state and stop", () => {
  it("reads the state of one chat", async () => {
    chatbots.getConversationBotState.mockResolvedValue({ session: null, available: [{ id: "b1", name: "Welcome" }] });
    const res = await live(new Request(`${ORIGIN}/api/chatbots/live?conversationId=c1`));
    expect(await res.json()).toEqual({ session: null, available: [{ id: "b1", name: "Welcome" }] });
    expect(chatbots.getConversationBotState).toHaveBeenCalledWith("t1", "c1");
    expect((await live(new Request(`${ORIGIN}/api/chatbots/live`))).status).toBe(400);
  });

  it("stops the bot only for chats the person may act on", async () => {
    const ok = await stop(post("/api/chatbots/live/stop", { conversationId: "c1" }));
    expect(await ok.json()).toEqual({ stopped: true });
    expect(chatbots.stopConversationBot).toHaveBeenCalledWith("t1", "c1");
    db.conversation.findFirst.mockResolvedValue({ assignedToId: "u2" });
    expect((await stop(post("/api/chatbots/live/stop", { conversationId: "c1" }))).status).toBe(403);
    expect((await stop(post("/api/chatbots/live/stop", { conversationId: "c1" }, null))).status).toBe(403);
  });
});

describe("statistics and builder options", () => {
  it("statistics are scoped to the workspace", async () => {
    db.chatbot.findFirst.mockResolvedValue({ id: "b1", tenantId: "t1" });
    db.chatbotSession.groupBy.mockResolvedValue([{ status: "completed", _count: { _all: 2 } }]);
    const res = await stats(new Request(`${ORIGIN}/api/chatbots/b1/stats`), ctx);
    expect(await res.json()).toMatchObject({ total: 2, completionPercent: 100 });
    expect(db.chatbot.findFirst.mock.calls[0][0].where).toEqual({ id: "b1", tenantId: "t1" });
  });

  it("lists the teams and numbers of this workspace only", async () => {
    db.team.findMany.mockResolvedValue([{ id: "team1", name: "Sales" }]);
    db.phoneNumber.findMany.mockResolvedValue([{ id: "pn1", displayPhone: "+91 99999", verifiedName: "Shop" }]);
    const res = await options(new Request(`${ORIGIN}/api/chatbots/options`));
    expect(await res.json()).toEqual({ teams: [{ id: "team1", name: "Sales" }], phoneNumbers: [{ id: "pn1", displayPhone: "+91 99999", verifiedName: "Shop" }] });
    expect(db.team.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(db.phoneNumber.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });
});

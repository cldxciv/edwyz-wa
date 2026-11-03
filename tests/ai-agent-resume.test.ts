import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), count: vi.fn() });
  return { conversation: model(), auditLog: model(), aiAgent: model(), chatbotSession: model(), chatbot: model() };
});
const auth = vi.hoisted(() => ({ role: "agent" as "agent" | "admin" | "owner", userId: "u1" }));
const visible = vi.hoisted(() => ({ assertConversationVisible: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: auth.userId, tenantId: "t1", role: auth.role }) }));
vi.mock("@/lib/teams/visibility", () => visible);

import { POST as resume } from "@/app/api/ai-agent/resume/route";
import { getConversationBotState } from "@/lib/chatbots";
import { SidePanel, visibleTags } from "@/components/inbox/SidePanel";
import { HttpError } from "@/lib/tenancy";

const ORIGIN = "https://wa.edwyz.com";
const post = (body: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/ai-agent/resume`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = "agent";
  visible.assertConversationVisible.mockResolvedValue(undefined);
  db.conversation.findFirst.mockResolvedValue({ assignedToId: null, tags: ["ai:stopped", "vip"], phoneNumberId: "pn1" });
  db.conversation.updateMany.mockResolvedValue({ count: 1 });
  db.auditLog.create.mockResolvedValue({});
});

describe("Let the AI answer again (POST /api/ai-agent/resume)", () => {
  it("lifts the pause in a chat the person may write in, and says when there was none", async () => {
    const res = await resume(post({ conversationId: "c1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resumed: true });
    expect(visible.assertConversationVisible).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }), "c1");
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { tags: ["vip"] } });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "ai_agent.resumed", target: "c1", userId: "u1" }) });

    db.conversation.findFirst.mockResolvedValue({ assignedToId: null, tags: ["vip"] });
    expect(await (await resume(post({ conversationId: "c1" }))).json()).toEqual({ resumed: false });
  });

  it("an agent cannot do it in a teammate's chat; an admin can", async () => {
    db.conversation.findFirst.mockResolvedValue({ assignedToId: "u2", tags: ["ai:stopped"] });
    expect((await resume(post({ conversationId: "c1" }))).status).toBe(403);
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
    auth.role = "admin";
    expect((await resume(post({ conversationId: "c1" }))).status).toBe(200);
  });

  it("refuses a missing id, a hidden chat and a cross-site request", async () => {
    expect((await resume(post({}))).status).toBe(400);
    expect((await resume(post({ conversationId: "c1" }, null))).status).toBe(403);
    visible.assertConversationVisible.mockRejectedValueOnce(new HttpError(404, "Conversation not found."));
    expect((await resume(post({ conversationId: "c1" }))).status).toBe(404);
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
  });
});

describe("the inbox learns the AI is paused from the bot state", () => {
  beforeEach(() => {
    db.chatbotSession.findFirst.mockResolvedValue(null);
    db.chatbot.findMany.mockResolvedValue([]);
  });

  it("reports aiPaused only while the chat carries the pause and an AI agent is on for its number", async () => {
    db.aiAgent.count.mockResolvedValue(1);
    expect(await getConversationBotState("t1", "c1")).toEqual({ session: null, available: [], aiPaused: true });
    expect(db.aiAgent.count.mock.calls[0][0].where).toEqual({ tenantId: "t1", enabled: true, OR: [{ phoneNumberId: null }, { phoneNumberId: "pn1" }] });
    db.aiAgent.count.mockResolvedValue(0);
    expect((await getConversationBotState("t1", "c1")).aiPaused).toBe(false);
    db.aiAgent.count.mockResolvedValue(1);
    db.conversation.findFirst.mockResolvedValue({ tags: ["vip"], phoneNumberId: "pn1" });
    expect((await getConversationBotState("t1", "c1")).aiPaused).toBe(false);
  });
});

describe("the contact panel hides the platform's own tags", () => {
  it("never lists ai:stopped as a tag, and keeps it when the team's tags are saved", () => {
    expect(visibleTags(["ai:stopped", "vip", "lead"])).toEqual(["vip", "lead"]);
    const conversation = {
      id: "cv1",
      status: "open",
      assignedToId: null,
      tags: ["ai:stopped"],
      lastInboundAt: null,
      lastMessageAt: null,
      referral: null,
      contact: { id: "k1", name: "Asha", phone: "+911111111111", attributes: {}, optIn: false, optedOutAt: null },
    } as unknown as Parameters<typeof SidePanel>[0]["conversation"];
    const html = renderToStaticMarkup(createElement(SidePanel, { conversation, members: [], onClose: () => undefined, onChanged: () => undefined }));
    expect(html).not.toContain("ai:stopped");
    expect(html).toContain("No tags yet.");
  });
});

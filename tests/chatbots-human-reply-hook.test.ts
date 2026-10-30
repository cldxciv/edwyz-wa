import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn(), updateMany: vi.fn() },
  message: { create: vi.fn() },
}));
const stop = vi.hoisted(() => ({ stopBotsOnHumanReply: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/routing", () => ({ onConversationAssigned: vi.fn() }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitTagChanges: vi.fn() }));
vi.mock("@/lib/chatbots/human-reply", () => stop);

import { buildList } from "@/lib/inbox/interactive";
import { sendInteractive } from "@/lib/inbox/interactive";
import { sendMedia, sendText } from "@/lib/inbox/service";

const interactive = () => buildList({ body: "Pick", buttonLabel: "Choose", rows: [{ id: "a", title: "A" }] });

beforeEach(() => {
  vi.clearAllMocks();
  db.conversation.findFirst.mockResolvedValue({ id: "c1", lastInboundAt: new Date() });
  db.conversation.updateMany.mockResolvedValue({ count: 1 });
  db.message.create.mockResolvedValue({ id: "m1" });
});

describe("inbox sends stop the chatbot when a teammate wrote them", () => {
  it("a teammate text message stops it", async () => {
    await sendText({ tenantId: "t1", origin: "unknown", conversationId: "c1", userId: "u1", body: "Hello" });
    expect(stop.stopBotsOnHumanReply).toHaveBeenCalledWith("t1", "c1");
  });

  it("a teammate media message stops it", async () => {
    await sendMedia({ tenantId: "t1", origin: "unknown", conversationId: "c1", userId: "u1", mediaType: "image", media: "https://example.com/a.png" });
    expect(stop.stopBotsOnHumanReply).toHaveBeenCalledWith("t1", "c1");
  });

  it("a teammate interactive message stops it and counts as an agent reply", async () => {
    await sendInteractive({ tenantId: "t1", origin: "unknown", conversationId: "c1", userId: "u1", interactive: interactive() });
    expect(stop.stopBotsOnHumanReply).toHaveBeenCalledWith("t1", "c1");
    const wheres = db.conversation.updateMany.mock.calls.map((c) => c[0]);
    expect(wheres.some((w) => w.data.lastAgentReplyAt instanceof Date)).toBe(true);
  });

  it("the bot's own messages (no teammate) never stop it", async () => {
    await sendText({ tenantId: "t1", origin: "unknown", conversationId: "c1", body: "Hello" });
    await sendInteractive({ tenantId: "t1", origin: "unknown", conversationId: "c1", interactive: interactive() });
    expect(stop.stopBotsOnHumanReply).not.toHaveBeenCalled();
  });
});

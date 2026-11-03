import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  chatbot: { findMany: vi.fn() },
  chatbotSession: { findMany: vi.fn(), updateMany: vi.fn() },
  contact: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/inbox/service", () => ({ sendText: vi.fn() }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));

import { expireIdleSessions } from "@/lib/chatbots/worker";

const bot = (i: number) => ({ id: `bot${String(i).padStart(4, "0")}`, tenantId: "t1", publishedFlow: { settings: { timeoutMinutes: 30 } } });

beforeEach(() => {
  vi.clearAllMocks();
  db.chatbotSession.findMany.mockResolvedValue([]);
});

describe("expireIdleSessions reads every bot with its own inactivity limit (P5)", () => {
  it("pages through the bots in id order instead of stopping at the first 100", async () => {
    db.chatbot.findMany.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => bot(i))).mockResolvedValueOnce([bot(100), bot(101)]);
    await expireIdleSessions(new Date("2026-10-30T10:00:00Z"));
    expect(db.chatbot.findMany).toHaveBeenCalledTimes(2);
    expect(db.chatbot.findMany.mock.calls[0][0]).toMatchObject({ orderBy: { id: "asc" }, take: 100 });
    expect(db.chatbot.findMany.mock.calls[0][0]).not.toHaveProperty("cursor");
    expect(db.chatbot.findMany.mock.calls[1][0]).toMatchObject({ cursor: { id: "bot0099" }, skip: 1 });
    // Each of the 102 bots had its waiting sessions checked, including the ones past the first page.
    expect(db.chatbotSession.findMany).toHaveBeenCalledTimes(102);
    expect(db.chatbotSession.findMany.mock.calls.at(-1)![0].where).toMatchObject({ chatbotId: "bot0101", status: "waiting" });
  });

  it("reads one page when there are fewer bots than a page", async () => {
    db.chatbot.findMany.mockResolvedValueOnce([bot(1)]);
    await expireIdleSessions();
    expect(db.chatbot.findMany).toHaveBeenCalledTimes(1);
  });
});

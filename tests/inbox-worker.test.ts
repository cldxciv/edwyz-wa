import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $executeRaw: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));

import { pruneOrphanMarks, worker } from "@/lib/inbox/worker";

beforeEach(() => {
  vi.clearAllMocks();
  db.$executeRaw.mockResolvedValue(3);
});

describe("inbox worker", () => {
  it("removes marks whose chat is gone, a bounded batch at a time, matching the chat by tenant too", async () => {
    expect(await pruneOrphanMarks(50)).toBe(3);
    const [strings, ...values] = db.$executeRaw.mock.calls[0];
    const sql = strings.join("?");
    expect(sql).toMatch(/DELETE FROM "ConversationMark"/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "Conversation" c WHERE c.id = m."conversationId" AND c."tenantId" = m."tenantId"\)/);
    expect(values).toEqual([50]);
  });

  it("registers one daily task and no queues", () => {
    expect(worker.queues).toEqual({});
    expect(worker.periodic).toEqual([expect.objectContaining({ name: "inbox-prune-marks", everyMs: 86_400_000 })]);
  });
});

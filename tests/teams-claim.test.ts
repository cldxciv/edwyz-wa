import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() });
  return { conversation: model(), agentAvailability: model(), teamMember: model(), membership: model(), team: model() };
});
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/routing", () => ({ onConversationAssigned: vi.fn(async () => undefined) }));
vi.mock("@/lib/integrations/emitters", () => ({ emitStatusChanged: vi.fn() }));

import { claimFor } from "@/lib/chatbots/seams";

beforeEach(() => {
  vi.resetAllMocks();
  db.agentAvailability.upsert.mockResolvedValue({});
});

describe("claimFor", () => {
  it("writes only over the person it saw, so a teammate who took the chat in between is kept", async () => {
    db.conversation.findFirst.mockResolvedValue({ assignedToId: "a" });
    db.conversation.updateMany.mockResolvedValue({ count: 0 });
    await claimFor("t1", "c1", "b");
    expect(db.conversation.updateMany.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1", assignedToId: "a" });
    expect(db.agentAvailability.upsert).not.toHaveBeenCalled();
  });

  it("assigns an unassigned chat and records the hand-out", async () => {
    db.conversation.findFirst.mockResolvedValue({ assignedToId: null });
    db.conversation.updateMany.mockResolvedValue({ count: 1 });
    await claimFor("t1", "c1", "b", "tm1");
    expect(db.conversation.updateMany.mock.calls[0][0]).toMatchObject({ where: { assignedToId: null }, data: { assignedToId: "b", teamId: "tm1" } });
    expect(db.agentAvailability.upsert).toHaveBeenCalled();
  });
});

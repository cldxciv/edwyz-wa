import { beforeEach, describe, expect, it, vi } from "vitest";

const routing = vi.hoisted(() => ({ assignConversation: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/routing", () => routing);

import { getSeams } from "@/lib/chatbots/seams";
import { wireModules } from "@/lib/wiring";

beforeEach(() => {
  vi.clearAllMocks();
  routing.assignConversation.mockResolvedValue({ assignedToId: null, reason: "auto_assign_off" });
});

describe("wired hand-over", () => {
  it("only routes after a normal hand-over: the database is not touched, the engine already set and announced the status", async () => {
    wireModules();
    await getSeams().handoff("t1", "c1");
    await getSeams().handoff("t1", "c1", { queueOnly: false });
    expect(routing.assignConversation).toHaveBeenCalledTimes(2);
    expect(routing.assignConversation).toHaveBeenCalledWith("t1", "c1");
  });

  it("does not pick anyone when the chat was left in a team queue on purpose", async () => {
    wireModules();
    await getSeams().handoff("t1", "c1", { queueOnly: true });
    expect(routing.assignConversation).not.toHaveBeenCalled();
  });
});

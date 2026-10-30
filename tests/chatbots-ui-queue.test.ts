import { describe, expect, it } from "vitest";
import { chatHref } from "@/components/chatbots/SessionsPanel";
import { TEAM_QUEUE as CLIENT_QUEUE } from "@/components/chatbots/types";
import { TEAM_QUEUE, validateFlow } from "@/lib/chatbots/flow";

const flowWith = (data: Record<string, unknown>, settings?: Record<string, unknown>) => ({
  version: 1,
  start: "h",
  nodes: [{ id: "h", type: "handoff", position: { x: 0, y: 0 }, data }],
  edges: [],
  ...(settings ? { settings } : {}),
});

describe("session list links", () => {
  it("opens the chat in the inbox by its id", () => {
    expect(chatHref("c 1/2")).toBe("/app/inbox?c=c%201%2F2");
  });
});

describe("team queue hand-over", () => {
  it("the browser and the server use the same value", () => {
    expect(CLIENT_QUEUE).toBe(TEAM_QUEUE);
  });

  it("is valid with a team and rejected without one", () => {
    expect(validateFlow(flowWith({ teamId: "team1", userId: TEAM_QUEUE })).ok).toBe(true);
    const bad = validateFlow(flowWith({ userId: TEAM_QUEUE }));
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toMatch(/team/i);
  });

  it("the same rule applies to the smart escalation settings", () => {
    const ok = validateFlow(flowWith({}, { escalation: { enabled: true, teamId: "team1", userId: TEAM_QUEUE } }));
    expect(ok.ok).toBe(true);
    const bad = validateFlow(flowWith({}, { escalation: { enabled: true, userId: TEAM_QUEUE } }));
    expect(bad.ok).toBe(false);
  });
});

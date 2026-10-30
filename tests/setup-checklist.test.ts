import { describe, expect, it } from "vitest";
import {
  computeSteps,
  formatMinutes,
  isStepId,
  parseDismissed,
  STEP_IDS,
  summarize,
  type SetupFacts,
  type StepId,
} from "@/lib/setup/checklist";

const blank: SetupFacts = {
  onboardingLive: false,
  approvedTemplates: 0,
  pendingTemplates: 0,
  rejectedTemplates: 0,
  contacts: 0,
  optedInContacts: 0,
  startedBroadcasts: 0,
  sentTemplateMessages: 0,
  members: 1,
  pendingInvites: 0,
  autoAssign: false,
  publishedChatbots: 0,
  enabledAiAgents: 0,
  metaConnections: 0,
  billing: { state: "trialing", daysLeftInTrial: 7, planName: null },
};

const step = (facts: SetupFacts, id: StepId, dismissed: string[] = []) => computeSteps(facts, dismissed).find((s) => s.id === id)!;
const states = (facts: SetupFacts) => Object.fromEntries(computeSteps(facts).map((s) => [s.id, s.state]));

describe("setup steps", () => {
  it("lists all nine steps in order, each with a why, time estimate and link", () => {
    const steps = computeSteps(blank);
    expect(steps.map((s) => s.id)).toEqual([...STEP_IDS]);
    for (const s of steps) {
      expect(s.why.length).toBeGreaterThan(20);
      expect(s.minutes).toBeGreaterThan(0);
      expect(s.href).toMatch(/^\/app\//);
    }
  });

  it("starts with the four launch steps to do and the rest optional", () => {
    expect(states(blank)).toEqual({
      connect: "todo",
      template: "todo",
      contacts: "todo",
      broadcast: "todo",
      invite: "optional",
      routing: "optional",
      automation: "optional",
      facebook: "optional",
      plan: "optional",
    });
  });

  it("marks each step done from the data", () => {
    const all: SetupFacts = {
      ...blank,
      onboardingLive: true,
      approvedTemplates: 2,
      contacts: 10,
      optedInContacts: 8,
      startedBroadcasts: 1,
      members: 3,
      autoAssign: true,
      publishedChatbots: 1,
      metaConnections: 1,
      billing: { state: "active", daysLeftInTrial: null, planName: "Growth" },
    };
    expect(Object.values(states(all))).toEqual(Array(9).fill("done"));
  });

  it("blocks later steps behind the earlier one they need", () => {
    expect(step(blank, "template")).toMatchObject({ blockedBy: "connect", blockedReason: "Connect your WhatsApp number first." });
    expect(step(blank, "broadcast").blockedBy).toBe("connect");
    const live = { ...blank, onboardingLive: true };
    expect(step(live, "template").blockedBy).toBeNull();
    expect(step(live, "broadcast").blockedBy).toBe("template");
    expect(step({ ...live, approvedTemplates: 1 }, "broadcast").blockedBy).toBe("contacts");
    expect(step({ ...live, approvedTemplates: 1, contacts: 1 }, "broadcast").blockedBy).toBeNull();
  });

  it("explains template review and rejection", () => {
    const live = { ...blank, onboardingLive: true };
    expect(step({ ...live, pendingTemplates: 1 }, "template").detail).toMatch(/waiting for Meta/);
    expect(step({ ...live, rejectedTemplates: 1 }, "template").detail).toMatch(/turned down/);
  });

  it("treats a sent template message as having sent a first message", () => {
    expect(step({ ...blank, onboardingLive: true, sentTemplateMessages: 1 }, "broadcast").state).toBe("done");
  });

  it("warns when contacts exist but nobody has opted in", () => {
    const s = step({ ...blank, contacts: 4 }, "contacts");
    expect(s.state).toBe("done");
    expect(s.detail).toMatch(/None are marked/);
  });

  it("counts a pending invitation as inviting a teammate", () => {
    expect(step({ ...blank, pendingInvites: 1 }, "invite").state).toBe("done");
  });

  it("suggests routing once there is a team without turning it into a to-do", () => {
    expect(step(blank, "routing")).toMatchObject({ state: "optional", detail: null });
    expect(step({ ...blank, members: 2 }, "routing")).toMatchObject({ state: "optional", detail: expect.stringMatching(/team/) });
    expect(step({ ...blank, members: 2, autoAssign: true }, "routing")).toMatchObject({ state: "done", detail: null });
  });

  it("accepts either a chatbot or the AI agent for automation", () => {
    expect(step({ ...blank, publishedChatbots: 1 }, "automation").state).toBe("done");
    expect(step({ ...blank, enabledAiAgents: 1 }, "automation").state).toBe("done");
  });

  it("handles the payment plan by billing state", () => {
    const plan = (billing: SetupFacts["billing"]) => step({ ...blank, billing }, "plan");
    expect(plan({ state: "trialing", daysLeftInTrial: 6, planName: null }).state).toBe("optional");
    expect(plan({ state: "trialing", daysLeftInTrial: 3, planName: null }).state).toBe("todo");
    expect(plan({ state: "past_due_grace", daysLeftInTrial: null, planName: "Growth" }).state).toBe("todo");
    expect(plan({ state: "locked", daysLeftInTrial: null, planName: null }).state).toBe("todo");
    expect(plan({ state: "active", daysLeftInTrial: null, planName: "Growth" })).toMatchObject({ state: "done", detail: "You are on the Growth plan." });
    expect(plan({ state: "exempt", daysLeftInTrial: null, planName: null }).state).toBe("done");
  });

  it("only flags dismissed steps that are not done", () => {
    const live = { ...blank, onboardingLive: true };
    expect(step(live, "contacts", ["contacts", "connect"]).dismissed).toBe(true);
    expect(step(live, "connect", ["connect"]).dismissed).toBe(false);
  });
});

describe("summary", () => {
  it("is 0 percent at the start with every launch step remaining", () => {
    expect(summarize(computeSteps(blank))).toMatchObject({ done: 0, percent: 0, remaining: 4, complete: false, nextStepId: "connect", minutesLeft: 13 });
  });

  it("rises as steps are completed and points at the next unblocked step", () => {
    const s = summarize(computeSteps({ ...blank, onboardingLive: true, approvedTemplates: 1 }));
    expect(s).toMatchObject({ done: 2, percent: 50, remaining: 2, nextStepId: "contacts" });
  });

  it("finishing an optional step never lowers the percentage", () => {
    const base = { ...blank, onboardingLive: true, approvedTemplates: 1, contacts: 1 };
    const before = summarize(computeSteps(base)).percent;
    const after = summarize(computeSteps({ ...base, members: 2 })).percent;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("is complete when no step is left to do, even with optional ones undone", () => {
    const done: SetupFacts = { ...blank, onboardingLive: true, approvedTemplates: 1, contacts: 1, startedBroadcasts: 1 };
    expect(summarize(computeSteps(done))).toMatchObject({ complete: true, remaining: 0, nextStepId: null });
  });

  it("keeps dismissed steps in the percentage but out of the remaining list", () => {
    const s = summarize(computeSteps(blank, ["template", "contacts", "broadcast"]));
    expect(s).toMatchObject({ remaining: 1, complete: false, percent: 0, nextStepId: "connect" });
    const allAside = summarize(computeSteps(blank, ["connect", "template", "contacts", "broadcast"]));
    expect(allAside).toMatchObject({ remaining: 0, complete: false, nextStepId: null });
  });

  it("prefers an unblocked step as the next one", () => {
    const steps = computeSteps({ ...blank, onboardingLive: true }, ["template"]);
    expect(summarize(steps).nextStepId).toBe("contacts");
  });
});

describe("dismissal storage helpers", () => {
  it("parses arrays and { ids } and drops anything unknown or duplicated", () => {
    expect(parseDismissed(["template", "nope", "template", 4])).toEqual(["template"]);
    expect(parseDismissed({ ids: ["plan"] })).toEqual(["plan"]);
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed("template")).toEqual([]);
  });
  it("recognises step ids", () => {
    expect(isStepId("connect")).toBe(true);
    expect(isStepId("CONNECT")).toBe(false);
    expect(isStepId(3)).toBe(false);
  });
});

describe("formatMinutes", () => {
  it("reads naturally", () => {
    expect(formatMinutes(1)).toBe("About 1 min");
    expect(formatMinutes(10)).toBe("About 10 min");
    expect(formatMinutes(60)).toBe("About 1 h");
    expect(formatMinutes(75)).toBe("About 1 h 15 min");
  });
});

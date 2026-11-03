import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock("@/components/contacts/hooks", () => api);

import { PlanUsage } from "@/components/billing/PlanUsage";
import { UsageMeter, limitSource, noLimitText, noPlanNote, trialLimitsNote } from "@/components/reports/UsageMeter";

const line = (kind: string, used: number, limit: number | null) => ({ kind, label: kind, used, limit, percent: limit ? Math.min(100, Math.floor((used * 100) / limit)) : null, monthly: false });
const render = (data: unknown) => {
  api.useApi.mockReturnValue({ data, error: null, loading: false, reload: vi.fn() });
  return renderToStaticMarkup(createElement(PlanUsage));
};

beforeEach(() => vi.resetAllMocks());

describe("PlanUsage", () => {
  it("says there is no paid plan, and that no limit applies yet, for a trial without plan limits", () => {
    const html = render({ lines: [line("contacts", 3, null), line("aiCredits", 1, 200)], alerts: [], plan: { state: "trialing", planName: null } });
    expect(html).toContain("You do not have a paid plan yet, so no limits are shown.");
    expect(html).toContain("No plan limit applies yet.");
    expect(html).not.toContain("Your plan has no limit on this.");
    expect(html).toContain("AI credits this month");
  });

  it("keeps the plan wording for a paid plan, and shows the meters", () => {
    const html = render({ lines: [line("contacts", 3, null), line("seats", 4, 5)], alerts: [], plan: { state: "active", planName: "Pro" } });
    expect(html).not.toContain("You do not have a paid plan yet");
    expect(html).toContain("Your plan has no limit on this.");
    expect(html).toContain("4 of 5 used");
    expect(html).toContain("Almost full");
  });

  it("does not call a complimentary workspace unpaid", () => {
    const html = render({ lines: [line("contacts", 3, null)], alerts: [], plan: { state: "exempt", planName: null } });
    expect(html).not.toContain("You do not have a paid plan yet");
  });

  it("shows a loading state and an error state with a retry", () => {
    api.useApi.mockReturnValue({ data: null, error: null, loading: true, reload: vi.fn() });
    expect(renderToStaticMarkup(createElement(PlanUsage))).toContain("Loading usage");
    api.useApi.mockReturnValue({ data: null, error: "x", loading: false, reload: vi.fn() });
    expect(renderToStaticMarkup(createElement(PlanUsage))).toContain("Try again");
  });
});

describe("UsageMeter (dashboard) uses the limits enforcement uses", () => {
  const usage = (over: Record<string, unknown> = {}) => ({
    plan: null,
    limitsFrom: null,
    billing: { state: "trialing", trialDaysLeft: 4 },
    periodStart: "2026-03-01T00:00:00.000Z",
    contacts: { used: 10, limit: null },
    seats: { used: 3, limit: null },
    broadcastRecipients: { used: 0, limit: null },
    ...over,
  });
  const meter = (data: unknown) => {
    api.useApi.mockReturnValue({ data, error: null, loading: false, reload: vi.fn() });
    return renderToStaticMarkup(createElement(UsageMeter));
  };

  it("shows the free trial's limits as limits, not as 'no plan limits apply'", () => {
    const html = meter(usage({ limitsFrom: "trial", contacts: { used: 90, limit: 100 }, seats: { used: 2, limit: 2 }, broadcastRecipients: { used: 0, limit: null } }));
    expect(html).toContain("What you have used during your free trial.");
    expect(html).toContain("90 of 100 used");
    expect(html).toContain("of your free trial limit used");
    expect(html).toContain("The free trial has no limit on this.");
    expect(html).toContain("You are on the free trial, with 4 days left. These are the trial&#x27;s limits.");
    expect(html).toContain("See billing");
    expect(html).not.toContain("no plan limits apply");
  });

  it("keeps the no-plan wording when nothing limits the workspace", () => {
    const html = meter(usage());
    expect(html).toContain("No plan limit applies yet.");
    expect(html).toContain(noPlanNote({ state: "trialing", trialDaysLeft: 4 }));
    expect(html).toContain("10 used");
  });

  it("names the plan and says nothing extra on a paid plan; seats say open invites count", () => {
    const html = meter(usage({ plan: { name: "Growth" }, limitsFrom: "plan", billing: { state: "active", trialDaysLeft: null }, seats: { used: 3, limit: 5 } }));
    expect(html).toContain("What you have used on the Growth plan.");
    expect(html).toContain("3 of 5 used");
    expect(html).toContain("Open invites count as seats");
    expect(html).not.toContain("See billing");
  });

  it("helpers: where the limits come from and the words for a line without one", () => {
    expect(limitSource({ plan: { name: "Pro" } })).toBe("plan");
    expect(limitSource({ plan: null })).toBeNull();
    expect(limitSource({ plan: null, limitsFrom: "trial" })).toBe("trial");
    expect(noLimitText("plan")).toBe("Your plan has no limit on this.");
    expect(noLimitText("trial")).toBe("The free trial has no limit on this.");
    expect(noLimitText(null)).toBe("No plan limit applies yet.");
    expect(trialLimitsNote({ state: "trialing", trialDaysLeft: 1 })).toBe("You are on the free trial, with 1 day left. These are the trial's limits. Choose a plan to keep sending after the trial.");
    expect(trialLimitsNote(undefined)).toMatch(/^You are on the free trial\. These are/);
  });
});

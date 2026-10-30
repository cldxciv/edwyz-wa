import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock("@/components/contacts/hooks", () => api);

import { PlanUsage } from "@/components/billing/PlanUsage";

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

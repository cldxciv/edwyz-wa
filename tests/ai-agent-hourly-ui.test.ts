import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The AI agent screen shows the hour's AI replies against the plan's allowance (owner decision 3). */

const api = vi.hoisted(() => ({ role: "owner" as "owner" | "agent", hour: null as unknown }));
const agent = {
  id: "a1", name: "Support assistant", enabled: true, phoneNumberId: null, instructions: "Help", tone: null, language: "auto", activation: "always",
  noHumanReplyMinutes: 30, handoffKeywords: [], maxRepliesPerConversation: 10, model: null,
};
vi.mock("@/components/contacts/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/contacts/hooks")>()),
  useRole: () => api.role,
  useApi: (p: string | null) => {
    const data =
      p === "/api/ai-agent/usage" ? { used: 10, limit: 1500, remaining: 1490, replies: 10, aiConfigured: true, ...(api.hour ? { hour: api.hour } : {}) }
      : p === "/api/ai-agent/agents" ? { agents: [agent] }
      : p?.endsWith("/sources") ? { sources: [] }
      : null;
    return { data, error: null, loading: false, reload: () => {}, retry: () => {} };
  },
}));

import { AiAgentView, hourlyUseText } from "@/components/ai-agent/AiAgentView";

const render = () => renderToStaticMarkup(createElement(AiAgentView));

beforeEach(() => {
  api.role = "owner";
  api.hour = null;
});

describe("the hourly meter", () => {
  it("shows the hour's use against the plan's allowance with a labelled meter", () => {
    api.hour = { used: 42, limit: 200, source: "plan_default" };
    const html = render();
    expect(html).toContain("AI replies this hour");
    expect(html).toContain("42 of 200 used in the last hour. Your plan allows 200 AI replies an hour.");
    expect(html).toContain('aria-label="AI replies in the last hour: 21% of the hourly limit used"');
    expect(html).not.toContain("Limit reached.");
  });

  it("at the limit says what happens, in a live region, with the way to a bigger plan for admins and owners", () => {
    api.hour = { used: 60, limit: 60, source: "plan_default" };
    const html = render();
    expect(html).toMatch(/role="status"[^>]*>Limit reached\. New chats wait for your team until replies sent more than an hour ago drop off\./);
    expect(html).toContain('href="/app/billing#plans"');
    api.role = "agent";
    expect(render()).not.toContain('href="/app/billing#plans"');
  });

  it("an older server without the hour shows the monthly card as before", () => {
    const html = render();
    expect(html).toContain("AI credits this month");
    expect(html).not.toContain("AI replies this hour");
  });

  it("names where the allowance comes from", () => {
    expect(hourlyUseText({ used: 1, limit: 60, source: "trial" }).allowance).toBe("Your free trial allows 60 AI replies an hour.");
    expect(hourlyUseText({ used: 1, limit: 60, source: "no_plan" }).allowance).toBe("Without a paid plan, the AI agent can send 60 replies an hour.");
    expect(hourlyUseText({ used: 1, limit: 80, source: "fallback" }).allowance).toBe("This workspace can send 80 AI replies an hour.");
    expect(hourlyUseText({ used: 1, limit: 600, source: "plan" }).allowance).toBe("Your plan allows 600 AI replies an hour.");
    expect(hourlyUseText({ used: 1_200, limit: 1_000 })).toMatchObject({ summary: "1,200 of 1,000 used in the last hour.", full: true });
  });
});

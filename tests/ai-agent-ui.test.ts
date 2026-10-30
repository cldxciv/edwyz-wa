import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ aiConfigured: true as boolean | undefined }));
const agent = {
  id: "a1", name: "Support assistant", enabled: false, phoneNumberId: null, instructions: "Help", tone: null, language: "auto", activation: "always",
  noHumanReplyMinutes: 30, handoffKeywords: [], maxRepliesPerConversation: 10, model: null,
};
vi.mock("@/components/contacts/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/contacts/hooks")>()),
  useRole: () => "owner",
  useApi: (p: string | null) => {
    const data =
      p === "/api/ai-agent/usage" ? { used: 0, limit: 200, remaining: 200, replies: 0, aiConfigured: api.aiConfigured }
      : p === "/api/ai-agent/agents" ? { agents: [agent] }
      : p?.endsWith("/sources") ? { sources: [] }
      : null;
    return { data, error: null, loading: false, reload: () => {}, retry: () => {} };
  },
}));

import { AiAgentView } from "@/components/ai-agent/AiAgentView";
import { AI_OFF_TITLE, testChatProblem } from "@/components/ai-agent/helpers";
import { AI_OFF_MESSAGE } from "@/lib/ai-configured";

const render = () => renderToStaticMarkup(createElement(AiAgentView));
const enabledBox = (html: string) => html.match(/<input type="checkbox"[^>]*>/)?.[0] ?? "";
const testInput = (html: string) => html.match(/<input[^>]*aria-label="Test message"[^>]*>/)?.[0] ?? "";
// The attribute, not Tailwind's disabled: variant classes.
const isDisabled = (tag: string) => / disabled=""/.test(tag);

beforeEach(() => {
  api.aiConfigured = true;
});

describe("AI agent page when the server has no AI", () => {
  it("says so at the top, hides the credit budget and blocks enabling and the test chat", () => {
    api.aiConfigured = false;
    const html = render();
    expect(html).toContain(AI_OFF_TITLE);
    expect(html).toContain("Ask an admin to set up AI");
    expect(html).not.toContain("AI credits this month");
    expect(isDisabled(enabledBox(html))).toBe(true);
    expect(html).toContain("The agent cannot be enabled until then.");
    expect(isDisabled(testInput(html))).toBe(true);
    expect(html).toContain("The test chat cannot answer until then.");
  });

  it("behaves as before when AI is on", () => {
    const html = render();
    expect(html).not.toContain(AI_OFF_TITLE);
    expect(html).toContain("AI credits this month");
    expect(isDisabled(enabledBox(html))).toBe(false);
    expect(isDisabled(testInput(html))).toBe(false);
    expect(html).toContain("Each test uses one AI credit.");
  });

  it("treats an old server without the flag as AI on", () => {
    api.aiConfigured = undefined;
    expect(render()).not.toContain(AI_OFF_TITLE);
  });
});

describe("test chat failures", () => {
  it("turns the server's refusal into the shared plain sentence and never echoes raw noise", () => {
    expect(testChatProblem("AI is not configured.")).toBe(AI_OFF_MESSAGE);
    expect(testChatProblem("The AI service could not be reached.")).toBe("We could not get a reply. The AI service could not be reached.");
    expect(testChatProblem("")).toBe("We could not get a reply. Try again.");
    expect(testChatProblem(null)).toBe("We could not get a reply. Try again.");
    expect(testChatProblem("x".repeat(500))).toBe("We could not get a reply. Try again.");
  });

  it("shows a failed test as a notice, not as a bubble from the assistant", () => {
    const src = readFileSync(path.join(__dirname, "..", "src/components/ai-agent/AiAgentView.tsx"), "utf8");
    const chat = src.slice(src.indexOf("function TestChat"), src.indexOf("function CreateForm"));
    expect(chat).not.toMatch(/catch[\s\S]*role: "ai"/);
    expect(chat).toContain("setProblem(testChatProblem(");
    expect(chat).toContain('role="alert"');
  });
});

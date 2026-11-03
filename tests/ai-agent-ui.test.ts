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

import { AiAgentView, fileProblem } from "@/components/ai-agent/AiAgentView";
import { AI_OFF_TITLE, agentProblems, languageOptions, sourceProblems, splitKeywords, testChatProblem } from "@/components/ai-agent/helpers";
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

describe("AI agent forms work like the rest of the app", () => {
  it("checks the fields on the page with the server's limits, so each problem shows under its own field", () => {
    expect(agentProblems({ name: " ", instructions: "" })).toEqual({ name: "Give the agent a name.", instructions: expect.stringMatching(/^Tell the agent what to do/) });
    const ok = { name: "Clinic", instructions: "Help", activation: "always", noHumanReplyMinutes: 0, maxRepliesPerConversation: 10, keywords: "refund, complaint" };
    // the minutes only count when the agent waits for a teammate
    expect(agentProblems(ok)).toEqual({});
    expect(agentProblems({ ...ok, activation: "no_human_reply_minutes" }).minutes).toMatch(/1 to 1440/);
    expect(agentProblems({ ...ok, activation: "no_human_reply_minutes", noHumanReplyMinutes: 30 })).toEqual({});
    for (const max of [0, 51, 2.5, Number.NaN]) expect(agentProblems({ ...ok, maxRepliesPerConversation: max }).max, String(max)).toBe("Use a whole number from 1 to 50.");
    expect(agentProblems({ ...ok, keywords: Array.from({ length: 21 }, (_, i) => `w${i}`).join(",") }).keywords).toBe("Use up to 20 handoff keywords. You have 21.");
    expect(agentProblems({ ...ok, keywords: "x".repeat(41) }).keywords).toMatch(/40 characters/);
    expect(splitKeywords(" refund, ,Complaint ,")).toEqual(["refund", "Complaint"]);
  });

  it("checks the Add knowledge form for the kind chosen", () => {
    const empty = { content: "", url: "", q: "", a: "" };
    expect(Object.keys(sourceProblems("text", empty))).toEqual(["content"]);
    expect(sourceProblems("text", { ...empty, content: "We open at 9." })).toEqual({});
    expect(sourceProblems("url", empty).url).toBe("Enter the address of the page.");
    expect(sourceProblems("url", { ...empty, url: "http://example.com/faq" }).url).toMatch(/https:\/\//);
    expect(sourceProblems("url", { ...empty, url: "https://example.com/faq" })).toEqual({});
    expect(Object.keys(sourceProblems("faq", { ...empty, q: "Cards?" }))).toEqual(["a"]);
  });

  it("offers the reply language as a list, and keeps a language typed in before the list existed", () => {
    const auto = languageOptions("auto");
    expect(auto[0]).toEqual({ value: "auto", label: "Match the customer's language" });
    expect(auto.map((l) => l.value)).toContain("Hindi");
    expect(languageOptions("hindi")).toHaveLength(auto.length);
    expect(languageOptions("Swahili").at(-1)).toEqual({ value: "Swahili", label: "Swahili" });
  });

  it("uses inline errors, required markers and the app's own confirm dialogs instead of the browser's", () => {
    const html = render();
    const forms = html.match(/<form[^>]*aria-label="(AI agent settings|Add knowledge)"[^>]*>/g) ?? [];
    expect(forms).toHaveLength(2);
    for (const form of forms) expect(form).toMatch(/ noValidate=""/i);
    expect(html).not.toMatch(/<(input|textarea)[^>]* required=""/);
    expect(html).toMatch(/<label for="ai-name"[^>]*>Name<span aria-hidden="true"[^>]*>\*<\/span>/);
    expect(html).toMatch(/<label for="ai-instructions"[^>]*>Instructions<span aria-hidden="true"[^>]*>\*<\/span>/);
    expect(html).toMatch(/<select[^>]*id="ai-language"/);
    expect(html).toContain("Match the customer&#x27;s language");
    const src = readFileSync(path.join(__dirname, "..", "src/components/ai-agent/AiAgentView.tsx"), "utf8");
    expect(src).not.toContain("window.confirm");
    const removeSource = src.slice(src.indexOf("async function remove(source: Source)"), src.indexOf("return (", src.indexOf("async function remove(source: Source)")));
    expect(removeSource).toMatch(/await confirm\(/);
  });
});

describe("AI agent page: pauses, rule-started replies, text files and page refresh (P5)", () => {
  it("offers 'Only when an automation rule starts it' and says when a paused chat gets AI replies again", () => {
    const html = render();
    expect(html).toContain('<option value="when_started">Only when an automation rule starts it</option>');
    expect(html).toContain("Max AI replies per chat in a day");
    expect(html).toContain("From 1 to 50 in any 24 hours.");
    expect(html).toContain("after the chat was marked solved, or after a day without writing");
    expect(html).toContain("Let the AI answer again");
  });

  it("adds .txt and .md files and explains Refresh for web pages", () => {
    const html = render();
    expect(html).toContain('<option value="file">Text file (.txt or .md)</option>');
    expect(html).toContain("press Refresh to read one again after it changes");
  });

  it("checks a chosen file with the server's limits before sending it", () => {
    expect(fileProblem(null)).toBe("Choose a .txt or .md file.");
    expect(fileProblem({ name: "menu.pdf", content: "%PDF" })).toMatch(/Only .txt and .md files/);
    expect(fileProblem({ name: "notes.TXT", content: "   " })).toBe("This file has no text in it.");
    expect(fileProblem({ name: "notes.md", content: "x".repeat(100_001) })).toMatch(/100,001 characters.*up to 100,000/);
    expect(fileProblem({ name: "faq.markdown", content: "# FAQ" })).toBeUndefined();
  });
});

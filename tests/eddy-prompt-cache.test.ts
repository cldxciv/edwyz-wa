import { describe, expect, it, vi } from "vitest";

/**
 * docs/EDDY-SPEC.md 5.4, 5.5 and 9.1 tests/eddy-prompt-cache.test.ts: the silent invalidators of the cached prefix are
 * banned. No date, name, id or tenant data in `system`; tools sorted by name; deterministic JSON; requests built for two
 * tenants, two members and two pages carry byte-identical `tools` and `system`. Also the Style section of 12.1a decision 0.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { toolsetHash, toolsFor } from "@/lib/actions";
import { buildContextNote } from "@/lib/eddy/context-note";
import { EDDY_PROMPT_APPROX_TOKENS, EDDY_PROMPT_VERSION, EDDY_SYSTEM_PROMPT } from "@/lib/eddy/prompt";
import { buildEddyRequest, systemBlocks } from "@/lib/eddy/request";

const MONTHS = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";

describe("the system prompt holds no tenant data, names, ids or dates", () => {
  it("has no dates or times", () => {
    expect(EDDY_SYSTEM_PROMPT).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(EDDY_SYSTEM_PROMPT).not.toMatch(new RegExp(`\\b\\d{1,2}\\s+${MONTHS}\\b`));
    expect(EDDY_SYSTEM_PROMPT).not.toMatch(new RegExp(`\\b${MONTHS}\\s+\\d{1,2}\\b`));
    expect(EDDY_SYSTEM_PROMPT).not.toMatch(/\b\d{1,2}:\d{2}\s*(am|pm)?\b/i);
    expect(EDDY_SYSTEM_PROMPT).not.toMatch(/\b20\d{2}\b/);
  });

  it("has no ids, workspace or member names, or amounts", () => {
    expect(EDDY_SYSTEM_PROMPT).not.toMatch(/\b(?:t|u|c|b|k|a|n|m|cv|turn|msg|act)_[A-Za-z0-9]{1,}\b/);
    expect(EDDY_SYSTEM_PROMPT).not.toMatch(/\bc[a-z0-9]{20,}\b/);
    for (const name of ["Anshuman", "Priya", "Arjun", "Riya", "Ramesh", "Omar", "Asha", "Kirana", "Boutique", "kirana_shop"]) expect(EDDY_SYSTEM_PROMPT).not.toContain(name);
    expect(EDDY_SYSTEM_PROMPT).not.toMatch(/₹\s?\d/);
    expect(EDDY_SYSTEM_PROMPT).not.toMatch(/\+91\d/);
  });

  it("is about 3,000 tokens of English with all ten sections", () => {
    expect(EDDY_PROMPT_APPROX_TOKENS).toBeGreaterThan(2_000);
    expect(EDDY_PROMPT_APPROX_TOKENS).toBeLessThan(5_000);
    for (let i = 1; i <= 10; i++) expect(EDDY_SYSTEM_PROMPT).toContain(`# ${i}. `);
    expect(EDDY_SYSTEM_PROMPT).toContain('{"$untrusted": "<source>", "text": "..."}');
    for (const status of ["done", "preview_shown", "refused", "failed", "outcome_unknown"]) expect(EDDY_SYSTEM_PROMPT).toContain(`${status}:`);
    for (const step of ["connect", "template", "contacts", "broadcast", "invite", "routing", "automation", "facebook", "plan"]) expect(EDDY_SYSTEM_PROMPT).toContain(`- ${step}:`);
  });

  it("follows 12.1a decision 0: richly styled replies, never plain text", () => {
    const style = EDDY_SYSTEM_PROMPT.slice(EDDY_SYSTEM_PROMPT.indexOf("# 5. Style"), EDDY_SYSTEM_PROMPT.indexOf("# 6. Never"));
    expect(style).toContain("never plain text");
    expect(style).toContain("Answer first");
    expect(style).toContain("**bold**");
    expect(style).toContain("### or ####");
    expect(style).toContain("at most 6 columns");
    expect(style).toContain("No emojis");
    expect(style).not.toMatch(/no tables|no headings/i);
    expect(/\p{Extended_Pictographic}/u.test(EDDY_SYSTEM_PROMPT)).toBe(false);
  });

  it("names the buttons in all three languages from the catalogue", () => {
    expect(EDDY_SYSTEM_PROMPT).toContain("Send reply / जवाब भेजें / Reply bhejein");
    expect(EDDY_SYSTEM_PROMPT).toContain("Undo / वापस लें / Undo kariye");
  });

  it("the version follows the text, so an edit rolls conversations over", () => {
    expect(EDDY_PROMPT_VERSION).toMatch(/^p1\.[0-9a-f]{12}$/);
  });
});

describe("tools: sorted, frozen, deterministic", () => {
  for (const roleClass of ["agent", "admin"] as const) {
    it(`${roleClass}: sorted by name, strict, frozen, and the same JSON every time`, () => {
      const tools = toolsFor(roleClass, "eddy");
      const names = tools.map((t) => t.name);
      expect(names).toEqual([...names].sort());
      expect(new Set(names).size).toBe(names.length);
      expect(Object.isFrozen(tools)).toBe(true);
      for (const t of tools) {
        expect(t.strict).toBe(true);
        expect(t.input_schema.type).toBe("object");
        expect(t.input_schema.additionalProperties).toBe(false);
        if (t.eager_input_streaming) expect(["add_internal_note", "create_template_draft", "draft_reply", "send_text_reply"]).toContain(t.name);
      }
      expect(JSON.stringify(toolsFor(roleClass, "eddy"))).toBe(JSON.stringify(tools));
      expect(toolsetHash(toolsFor(roleClass, "eddy"))).toBe(toolsetHash(tools));
      // No tool description carries an id, a date or tenant data.
      const json = JSON.stringify(tools);
      expect(json).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
      expect(json).not.toMatch(/\bc[a-z0-9]{20,}\b/);
    });
  }

  it("owners and admins share the admin set; agents get a subset", () => {
    const agent = toolsFor("agent", "eddy").map((t) => t.name);
    const admin = toolsFor("admin", "eddy").map((t) => t.name);
    expect(agent.every((n) => admin.includes(n))).toBe(true);
    expect(admin.length).toBeGreaterThan(agent.length);
  });
});

describe("requests for different tenants, members and pages share the cached prefix", () => {
  it("tools and system are byte-identical; only the messages differ", () => {
    const tools = toolsFor("agent", "eddy");
    const note = (tenantName: string, member: string, page: string) =>
      buildContextNote({
        lang: "en",
        member: { firstName: member, role: "agent", emailVerified: true },
        page: { id: page, conversationId: `c_${tenantName}`, verified: true },
        setup: { percent: 40, nextStepId: "template" },
        spending: { freeze: "none", eddySpend: "off" },
        recentNotices: [],
        cardOutcomes: [],
        now: new Date("2026-10-28T08:35:00Z"),
        timezone: "Asia/Kolkata",
        phase: 1,
        firstTurn: true,
      });
    const requests = [
      ["t1", "Asha", "inbox.chat"],
      ["t1", "Priya", "inbox.chat"],
      ["t2", "Asha", "broadcasts.detail"],
      ["t2", "Omar", "templates"],
    ].map(([t, m, p]) =>
      buildEddyRequest({ model: "claude-sonnet-5-5", maxTokens: 8000, tools, messages: [{ role: "user", content: `hello from ${t}` }, { role: "system", content: note(t, m, p) }] as never }),
    );
    const prefix = (r: (typeof requests)[number]) => JSON.stringify({ tools: r.tools, system: r.system });
    expect(new Set(requests.map(prefix)).size).toBe(1);
    expect(new Set(requests.map((r) => JSON.stringify(r.messages))).size).toBe(4);
    // Render order: tools, then system, then messages; the 1-hour breakpoint closes the shared prefix.
    expect(Object.keys(requests[0]).indexOf("tools")).toBeLessThan(Object.keys(requests[0]).indexOf("system"));
    expect(Object.keys(requests[0]).indexOf("system")).toBeLessThan(Object.keys(requests[0]).indexOf("messages"));
    expect(systemBlocks()).toEqual([{ type: "text", text: EDDY_SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } }]);
  });

  it("building the same request twice gives the same bytes", () => {
    const input = { model: "claude-sonnet-5-5", maxTokens: 6000, tools: toolsFor("admin", "eddy"), messages: [{ role: "user", content: "hi" }] as never };
    expect(JSON.stringify(buildEddyRequest(input))).toBe(JSON.stringify(buildEddyRequest(input)));
  });
});

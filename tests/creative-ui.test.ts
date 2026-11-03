import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Stepper } from "@/components/creative/Stepper";
import { PolicyReport } from "@/components/creative/shared";
import { friendlyMessage } from "@/components/creative/messages";
import { explainFinding, explainFindings, stripInternalMarkers, summarizePolicy, type RawCheck } from "@/components/creative/policy-explain";
import { AI_OFF_MESSAGE } from "@/lib/ai-configured";
import { TEXT_RULES, checkPolicy } from "@/lib/creative/policy";
import {
  GOAL_INFO,
  assetStatus,
  briefStatus,
  canEnterStep,
  clientFeedback,
  creditsText,
  goalLabel,
  invalidColours,
  placementLabel,
  progressPercent,
  safeColour,
  splitList,
  startStep,
  stepIndex,
  stepState,
  WIZARD_STEPS,
} from "@/components/creative/wizard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const brand = { bannedWords: ["cheap"], specialAdCategory: "housing" };

describe("policy explanations", () => {
  it("explains every finding the policy engine emits in plain words", () => {
    const text = "GUARANTEED returns!!! Are you in debt? Before and after, last chance, a miracle cure, shocking. Cheap LOANS. FREE weight loss. THIS IS ALL CAPS NOW. Ideal for families";
    const res = checkPolicy({ headline: text.repeat(2), body: text, description: text, placement: "feed", brand });
    const rules = new Set(res.findings.map((f) => f.rule));
    expect(rules.size).toBeGreaterThan(8);
    for (const f of res.findings) {
      const e = explainFinding(f);
      expect(e.title, f.rule).not.toMatch(/_/);
      expect(e.why.length, f.rule).toBeGreaterThan(10);
      expect(e.fix.length, f.rule).toBeGreaterThan(10);
      expect(`${e.title} ${e.why} ${e.fix}`, f.rule).not.toMatch(/VERIFY/);
    }
  });

  it("has a specific explanation for each text rule", () => {
    for (const rule of TEXT_RULES) {
      const e = explainFinding({ rule: rule.id, severity: rule.severity, message: rule.message });
      expect(e.title, rule.id).not.toBe("Check this wording");
    }
  });

  it("turns length findings into a number the person can act on", () => {
    const e = explainFinding({ rule: "length", severity: "warn", message: "Headline is 52 characters; the recommended maximum for feed is 40 (VERIFY)." });
    expect(e.title).toBe("Headline is too long");
    expect(e.fix).toBe("Shorten it to 40 characters or fewer.");
    expect(explainFinding({ rule: "length", severity: "warn", message: "Primary text is 200 characters; the recommended maximum for story is 72." }).title).toBe("Main text is too long");
  });

  it("falls back to the message for unknown rules and strips internal markers", () => {
    const e = explainFinding({ rule: "brand_new_rule", severity: "warn", message: "Something odd (VERIFY). Check it." });
    expect(e.why).toBe("Something odd. Check it.");
    expect(e.fix).toMatch(/Reword/);
    expect(stripInternalMarkers("Rules vary. VERIFY the current rules for your country.")).toBe("Rules vary.");
  });

  it("keeps the matched words and the original message for the details element", () => {
    const e = explainFinding({ rule: "banned_word", severity: "block", message: 'Contains a word your brand kit bans: "cheap".', match: "cheap" });
    expect(e.found).toBe("cheap");
    expect(e.detail).toContain("cheap");
    expect(e.label).toBe("Must fix");
  });

  it("orders blockers before warnings before notes", () => {
    const check: RawCheck = {
      result: "block",
      findings: [
        { rule: "ai_label", severity: "info", message: "x" },
        { rule: "excess_caps", severity: "warn", message: "x" },
        { rule: "banned_word", severity: "block", message: "x" },
      ],
    };
    expect(explainFindings(check).map((e) => e.severity)).toEqual(["block", "warn", "info"]);
    expect(explainFindings(null)).toEqual([]);
  });

  it("summarises the result with counts and a tone", () => {
    expect(summarizePolicy(null).tone).toBe("neutral");
    const block = summarizePolicy({ result: "block", findings: [{ rule: "a", severity: "block", message: "m" }, { rule: "b", severity: "block", message: "m" }] });
    expect(block).toMatchObject({ tone: "bad", blockers: 2, headline: "Likely to be rejected" });
    expect(block.detail).toContain("2 problems need fixing");
    expect(summarizePolicy({ result: "warn", findings: [{ rule: "a", severity: "warn", message: "m" }] }).detail).toContain("1 thing could");
    expect(summarizePolicy({ result: "pass", findings: [] })).toMatchObject({ tone: "good", headline: "No problems found" });
  });
});

describe("wizard steps", () => {
  it("has the five steps in order", () => {
    expect(WIZARD_STEPS.map((s) => s.label)).toEqual(["Brand", "Goal and offer", "Angles", "Creatives", "Review"]);
    expect(stepIndex("angles")).toBe(2);
  });

  it("marks steps done, current and upcoming", () => {
    expect([0, 1, 2, 3, 4].map((i) => stepState(i, 2))).toEqual(["done", "done", "current", "upcoming", "upcoming"]);
  });

  it("reports progress including the current step and clamps", () => {
    expect(progressPercent(0)).toBe(20);
    expect(progressPercent(2)).toBe(60);
    expect(progressPercent(4)).toBe(100);
    expect(progressPercent(99)).toBe(100);
    expect(progressPercent(-3)).toBe(20);
  });

  it("starts the workspace where the person left off", () => {
    expect(startStep({ angles: [], assets: [] })).toBe("angles");
    expect(startStep({ angles: [{ selected: false }], assets: [] })).toBe("angles");
    expect(startStep({ angles: [{ selected: true }], assets: [] })).toBe("creatives");
    expect(startStep({ angles: [{ selected: true }], assets: [{}] })).toBe("review");
  });

  it("explains why a step is not available yet", () => {
    expect(canEnterStep("creatives", { angles: [], assets: [] })).toEqual({ ok: false, reason: "Choose at least one angle first." });
    expect(canEnterStep("creatives", { angles: [{ selected: true }], assets: [] })).toEqual({ ok: true });
    expect(canEnterStep("review", { angles: [{ selected: true }], assets: [] })).toEqual({ ok: false, reason: "Create at least one ad first." });
    expect(canEnterStep("review", { angles: [], assets: [{}] })).toEqual({ ok: true });
    expect(canEnterStep("angles", { angles: [], assets: [] })).toEqual({ ok: true });
  });
});

describe("labels", () => {
  it("never shows raw enum values", () => {
    for (const g of Object.keys(GOAL_INFO)) expect(goalLabel(g)).not.toBe(g);
    expect(goalLabel("brand_new")).toBe("Brand_new");
    expect(placementLabel("story")).toBe("Story");
    expect(briefStatus("angles_ready")).toEqual({ label: "Angles ready", tone: "info" });
    expect(briefStatus("some_future_state").label).toBe("Some future state");
    expect(assetStatus("rejected")).toEqual({ label: "Declined by client", tone: "bad" });
    expect(assetStatus("odd").tone).toBe("neutral");
  });

  it("words credits naturally", () => {
    expect(creditsText(1)).toBe("Uses 1 credit");
    expect(creditsText(5)).toBe("Uses 5 credits");
  });
});

describe("brand kit input helpers", () => {
  it("accepts only six digit hex colours", () => {
    expect(safeColour(" #1F2A44 ")).toBe("#1F2A44");
    expect(safeColour("#fff")).toBeNull();
    expect(safeColour("red")).toBeNull();
    expect(safeColour("#123456; background:url(x)")).toBeNull();
  });

  it("splits lists on commas and new lines and finds bad colours", () => {
    expect(splitList("a, b\n c ,, ")).toEqual(["a", "b", "c"]);
    expect(invalidColours("#112233, blue, #abc")).toEqual(["blue", "#abc"]);
    expect(invalidColours("")).toEqual([]);
  });
});

describe("friendly error messages", () => {
  const fallback = "Check your connection and try again.";

  it("keeps messages the server wrote for people", () => {
    expect(friendlyMessage(new Error("Choose a time in the future."), fallback)).toBe("Choose a time in the future.");
    expect(friendlyMessage("Fix the blocked items before sending for approval.", fallback)).toBe("Fix the blocked items before sending for approval.");
  });

  it("replaces browser and runtime noise", () => {
    for (const noisy of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Unexpected token < in JSON at position 0", "Cannot read properties of undefined", "Request failed with status 502", "PrismaClientKnownRequestError", "Invalid time value", "RangeError: Invalid date", ""]) {
      expect(friendlyMessage(new Error(noisy), fallback), noisy).toBe(fallback);
    }
    expect(friendlyMessage(new Error("Something went wrong."), fallback)).toBe(fallback);
    expect(friendlyMessage(undefined, fallback)).toBe(fallback);
    expect(friendlyMessage(new Error("x".repeat(500)), fallback)).toBe(fallback);
  });

  it("explains a server without AI and says whom to ask, instead of the bare 'AI is not configured.'", () => {
    expect(friendlyMessage(new Error("AI is not configured."), fallback)).toBe(AI_OFF_MESSAGE);
    expect(AI_OFF_MESSAGE).toMatch(/Ask an admin/);
    expect(AI_OFF_MESSAGE).not.toMatch(/configured/);
  });
});

describe("client feedback on an ad", () => {
  it("shows changes requested with the client's comment and what to do next", () => {
    const view = clientFeedback({ status: "ready", clientFeedback: { status: "changes_requested", comment: "Please mention the price." } });
    expect(view).toMatchObject({ label: "Changes requested", tone: "warn", comment: "Please mention the price." });
    expect(view?.next).toMatch(/send it for approval again/);
  });

  it("shows a waiting or expired link, and nothing for decisions the ad status already shows", () => {
    expect(clientFeedback({ status: "ready", clientFeedback: { status: "pending", comment: null } })).toMatchObject({ label: "Waiting for your client", tone: "info", comment: null });
    expect(clientFeedback({ status: "ready", clientFeedback: { status: "expired", comment: null } })?.label).toBe("Link expired");
    expect(clientFeedback({ status: "approved", clientFeedback: { status: "approved", comment: null } })).toBeNull();
    expect(clientFeedback({ status: "rejected", clientFeedback: { status: "rejected", comment: "No" } })).toBeNull();
    expect(clientFeedback({ status: "ready", clientFeedback: null })).toBeNull();
    expect(clientFeedback({ status: "ready" })).toBeNull();
  });

  it("the ad card renders the feedback pill and comment, and the AI buttons are disabled when AI is off", () => {
    const src = readFileSync(path.join(__dirname, "..", "src/components/creative/BriefWorkspace.tsx"), "utf8");
    const card = src.slice(src.indexOf("const AssetCard"), src.indexOf("export function BriefWorkspace"));
    expect(card).toContain("const feedback = clientFeedback(a)");
    expect(card).toMatch(/<StatusPill[^>]*label=\{feedback\.label\}/);
    expect(card).toContain("Your client asked for changes");
    expect(card).toMatch(/<q[^>]*>\{feedback\.comment\}<\/q>/);
    const aiButtons = src.match(/disabled=\{[^}]*aiOff\}/g) ?? [];
    expect(aiButtons.length, "read website, suggest ideas, write ad text").toBe(3);
    expect(src).toContain('title="AI is not switched on for this workspace yet"');
    expect(src).toContain("setAiOff(res.aiConfigured === false)");
  });
});

describe("rendered markup", () => {
  it("marks the current step for assistive technology and shows phone progress", () => {
    const out = renderToStaticMarkup(createElement(Stepper, { current: 2, locked: ["review"], fixed: ["brand", "offer"] }));
    expect(out).toContain('aria-label="Brief progress"');
    expect(out).toContain('aria-current="step"');
    expect(out).toContain("Step 3 of 5: Angles");
    expect(out).toContain("(done)");
    expect(out).toContain("(not available yet)");
    expect(out).toContain('role="progressbar"');
  });

  it("explains a blocked ad with what was found, why and how to fix it", () => {
    const check = checkPolicy({ headline: "Guaranteed returns on your money", body: "Cheap flats", placement: "feed", brand });
    const out = renderToStaticMarkup(createElement(PolicyReport, { check, expanded: true }));
    expect(out).toContain("Likely to be rejected");
    expect(out).toContain("Must fix");
    expect(out).toContain("How to fix it");
    expect(out).toContain("<summary");
    expect(out).toMatch(/Details/);
    expect(out).not.toMatch(/guaranteed_returns|banned_word|VERIFY/);
    expect(out).toContain("Meta makes the final decision");
  });

  it("says plainly when there is nothing to fix", () => {
    const out = renderToStaticMarkup(createElement(PolicyReport, { check: { result: "pass", findings: [] } }));
    expect(out).toContain("No problems found");
    expect(renderToStaticMarkup(createElement(PolicyReport, { check: null }))).toBe("");
  });
});

describe("first paint", () => {
  it("shows a labelled loading state, never a blank page, for every creative screen", async () => {
    const { BrandKits } = await import("@/components/creative/BrandKits");
    const { BriefList } = await import("@/components/creative/BriefList");
    const { BriefWizard } = await import("@/components/creative/BriefWizard");
    const { BriefWorkspace } = await import("@/components/creative/BriefWorkspace");
    const screens: [string, string][] = [
      ["brands", renderToStaticMarkup(createElement(BrandKits))],
      ["briefs", renderToStaticMarkup(createElement(BriefList))],
      ["wizard", renderToStaticMarkup(createElement(BriefWizard))],
      ["workspace", renderToStaticMarkup(createElement(BriefWorkspace, { briefId: "b1" }))],
    ];
    for (const [name, out] of screens) {
      expect(out, name).toMatch(/aria-busy="true"/);
      expect(out, name).toMatch(/Loading/);
    }
    expect(screens[0][1]).toContain("<h1");
    expect(screens[1][1]).toContain("Creative Studio");
    // The title column has a real basis (not flex-1's 0): on a 390 px phone Brand kits and New brief wrap below the title
    // instead of squeezing it and its description into a 103 px column.
    expect(screens[1][1]).toMatch(/class="min-w-0 grow basis-64"><h1/);
  });
});

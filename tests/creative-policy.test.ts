import { describe, expect, it } from "vitest";
import { checkPolicy } from "@/lib/creative/policy";
import { suggestSpecialAdCategory } from "@/lib/creative/constants";

const brand = { bannedWords: ["cheapest"], specialAdCategory: "none" };
const run = (body: string, b = brand, headline = "Hello") => checkPolicy({ headline, body, brand: b, aiGenerated: false });

describe("policy rules", () => {
  const cases: [string, string, "pass" | "warn" | "block", string | null][] = [
    ["clean copy", "Book a free site visit this weekend. Terms apply.", "pass", null],
    ["banned word", "We are the Cheapest in town.", "block", "banned_word"],
    ["banned word is whole-word only", "A cheapestimate is not a match here.", "pass", null],
    ["guaranteed returns", "Guaranteed returns of 20% every year", "block", "guaranteed_returns"],
    ["risk free", "Totally risk-free investment, terms apply", "block", "guaranteed_returns"],
    ["cure claim", "This oil cures arthritis", "block", "cure_claims"],
    ["weight claim", "Lose 10 kg in 7 days", "block", "cure_claims"],
    ["sensitive attribute", "Are you diabetic? Try this", "block", "personal_attributes_sensitive"],
    ["generic are you", "Are you looking for a new home loan? Terms apply", "warn", "personal_attributes_generic"],
    ["before and after", "See the before and after photos", "warn", "before_after"],
    ["sensational", "You won't believe this offer", "warn", "sensational"],
    ["excess punctuation", "Buy now!!!", "warn", "excess_punctuation"],
    ["excess caps", "BUY THIS AMAZING OFFER TODAY", "warn", "excess_caps"],
    ["finance without disclosure", "Get a personal loan in minutes", "warn", "missing_disclosure_finance"],
    ["finance with disclosure", "Get a personal loan in minutes. Terms and conditions apply", "pass", null],
    ["health without disclosure", "Our weight loss supplement is popular", "warn", "missing_disclosure_health"],
  ];
  it.each(cases)("%s", (_name, text, result, rule) => {
    const out = run(text);
    expect(out.result).toBe(result);
    if (rule) expect(out.findings.some((f) => f.rule === rule)).toBe(true);
  });

  it("labels itself as a helper", () => {
    expect(run("hi").disclaimer).toMatch(/not Meta's decision/);
  });

  it("adds a notice and discrimination warning for housing", () => {
    const out = run("Perfect for families. Visit us.", { bannedWords: [], specialAdCategory: "housing" });
    expect(out.findings.some((f) => f.rule === "special_category" && f.severity === "info")).toBe(true);
    expect(out.findings.some((f) => f.rule === "special_category_wording")).toBe(true);
    expect(out.result).toBe("warn");
  });

  it("notice alone does not change a pass", () => {
    expect(run("Visit our show flat today", { bannedWords: [], specialAdCategory: "housing" }).result).toBe("pass");
  });

  it("flags over-length copy per placement", () => {
    const out = checkPolicy({ headline: "x".repeat(60), body: "ok", placement: "feed", brand });
    expect(out.findings.some((f) => f.rule === "length")).toBe(true);
  });

  it("adds the AI label note by default", () => {
    expect(checkPolicy({ headline: "Hi", brand }).findings.some((f) => f.rule === "ai_label")).toBe(true);
  });
});

describe("special category suggestion", () => {
  it.each([
    ["Real estate", "housing"],
    ["Property developer", "housing"],
    ["Personal loans", "credit"],
    ["Recruitment agency", "employment"],
    ["Restaurant", "none"],
    [null, "none"],
  ])("%s -> %s", (industry, expected) => {
    expect(suggestSpecialAdCategory(industry)).toBe(expected);
  });
});

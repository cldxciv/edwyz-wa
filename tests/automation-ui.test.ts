import { describe, expect, it } from "vitest";
import { TYPE_LABEL, addKeywords, counter, describeRule, emptyDraft, formatCooldown, humanError, publishFailure, timezoneOptions, validateDraft, validateDraftFields } from "@/components/automation/helpers";
import { DOC_SNIPPETS, statusTone } from "@/components/integrations/helpers";

describe("automation form helpers", () => {
  it("adds keywords split on commas and newlines, de-duplicating case-insensitively and capping", () => {
    expect(addKeywords(["Price"], "price, hours\nOpening hours,, ")).toEqual(["Price", "hours", "Opening hours"]);
    expect(addKeywords([], "a,b,c", 2)).toEqual(["a", "b"]);
  });
  it("formats the counter and cooldowns", () => {
    expect(counter("abc")).toBe("3/1024");
    expect(formatCooldown(1440)).toBe("1 day");
    expect(formatCooldown(720)).toBe("12 hours");
    expect(formatCooldown(60)).toBe("1 hour");
    expect(formatCooldown(5)).toBe("5 min");
  });
  it("describes rules", () => {
    expect(describeRule({ type: "keyword", keywords: ["a", "b", "c", "d", "e"], schedule: null, cooldownMinutes: 5 })).toBe("Keywords: a, b, c, d +1");
    expect(describeRule({ type: "away", keywords: [], schedule: { timezone: "UTC", days: [1, 2], start: "09:00", end: "17:00" }, cooldownMinutes: 5 })).toBe("Replies outside Mon, Tue 09:00 to 17:00 (UTC)");
    expect(describeRule({ type: "welcome", keywords: [], schedule: null, cooldownMinutes: 720 })).toBe("First messages. Sends again after 12 hours of silence");
  });
  it("validates drafts", () => {
    const ok = { ...emptyDraft("keyword"), name: "n", replyText: "r", keywords: ["k"] };
    expect(validateDraft(ok)).toBeNull();
    expect(validateDraft({ ...ok, name: " " })).toMatch(/name/);
    expect(validateDraft({ ...ok, replyText: "" })).toMatch(/reply/);
    expect(validateDraft({ ...ok, keywords: [] })).toMatch(/keyword/);
    expect(validateDraft({ ...ok, replyText: "x".repeat(1025) })).toMatch(/1024/);
    const away = { ...emptyDraft("away", "Asia/Kolkata"), name: "n", replyText: "r" };
    expect(away.schedule?.timezone).toBe("Asia/Kolkata");
    expect(validateDraft(away)).toBeNull();
    expect(validateDraft({ ...away, schedule: { ...away.schedule!, days: [] } })).toMatch(/day/);
  });
  it("reports each problem under its own field, in reading order", () => {
    const blank = emptyDraft("keyword");
    expect(Object.keys(validateDraftFields(blank)).sort()).toEqual(["keywords", "name", "replyText"]);
    expect(validateDraft(blank)).toMatch(/name/);
    const away = { ...emptyDraft("away"), name: "n", replyText: "r" };
    expect(validateDraftFields({ ...away, schedule: { ...away.schedule!, days: [] } }).days).toMatch(/day/);
    expect(validateDraftFields({ ...away, cooldownMinutes: 0 }).cooldown).toMatch(/1 minute/);
    expect(validateDraftFields(away)).toEqual({});
  });
  it("uses plain names for the three kinds of auto-reply", () => {
    expect(TYPE_LABEL).toEqual({ welcome: "Welcome message", away: "After-hours reply", keyword: "Keyword reply" });
  });
  it("turns request failures into calm sentences and hides technical detail", () => {
    expect(humanError(new Error("Name is already in use"), "save this reply")).toBe("We could not save this reply. Name is already in use.");
    expect(humanError(new Error("Something went wrong."), "save this reply")).toBe("We could not save this reply. Check your connection and try again.");
    expect(humanError(new Error("PrismaClientKnownRequestError P2002 at db.query (x.js:1)"), "save this reply")).toMatch(/Check your connection/);
    expect(humanError(new Error("ref 3f2a9c1e-77ab-4d2e"), "save this reply")).toMatch(/Check your connection/);
    expect(humanError("boom", "save this reply")).toMatch(/Check your connection/);
    expect(humanError(new Error("x".repeat(300)), "save this reply")).toMatch(/Check your connection/);
  });
  it("lists time zones including UTC", () => {
    const zones = timezoneOptions();
    expect(zones).toContain("UTC");
    expect(zones.length).toBeGreaterThan(5);
  });
});

describe("api docs and delivery helpers", () => {
  it("uses only placeholders in curl examples", () => {
    const all = DOC_SNIPPETS.map((s) => s.code).join("\n");
    expect(all).not.toMatch(/wak_[A-Za-z0-9_-]{8,}/);
    expect(all).toContain("YOUR_API_KEY");
  });
  it("maps delivery statuses to tones", () => {
    expect(statusTone("delivered")).toBe("good");
    expect(statusTone("failed")).toBe("bad");
    expect(statusTone("retrying")).toBe("warn");
    expect(statusTone("pending")).toBe("neutral");
  });
});

describe("publish failures", () => {
  it("sends people to the Checks tab when the server rejects the flow", () => {
    const f = publishFailure(new Error("The flow has problems that must be fixed before publishing."), "Welcome menu");
    expect(f.kind).toBe("invalid");
    expect(f.message).toBe('We could not publish "Welcome menu". Open it and check the Checks tab to see what needs fixing.');
    expect(f.message).not.toMatch(/flow/i);
  });
  it("explains archived chatbots and falls back to a calm sentence", () => {
    expect(publishFailure(new Error("Archived chatbots cannot be published."), "Old bot").kind).toBe("archived");
    const other = publishFailure(new Error("Something went wrong."), "Bot");
    expect(other.kind).toBe("other");
    expect(other.message).toMatch(/^We could not publish "Bot"\./);
  });
});

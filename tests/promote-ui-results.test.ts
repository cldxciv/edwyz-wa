import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/**
 * The Ads page tiles, the campaign page's status timeline, edits, results tabs and compare card, and the audience manager
 * (docs/IG-PAGE-ADS-SPEC.md 3.7 to 3.10, 7.1, 7.3, D5, D24, D25, D29; PRM-15b acceptance 1 and 3).
 *
 * The unit project has no DOM, so the logic is pure in results-helpers and tested directly; the components are rendered
 * statically to check their wiring, names and roles. A grep over the package's files closes it: tokens only, no Meta host.
 */
import { AudienceManager } from "@/components/promote/AudienceManager";
import { CampaignEdits, type EditCampaign } from "@/components/promote/CampaignEdits";
import { CompareVersions, type ComparisonLite } from "@/components/promote/CompareVersions";
import { PromoteTiles } from "@/components/promote/PromoteTiles";
import { ResultsByPlacement } from "@/components/promote/ResultsByPlacement";
import { StatusTimeline } from "@/components/promote/StatusTimeline";
import {
  ADVANCED_PATH,
  AUDIENCE_KINDS_BY_LEVEL,
  AUDIENCE_TEXT,
  EDITS_TEXT,
  EDIT_MODE,
  RESULTS_MAX_DAYS,
  RESULTS_TEXT,
  RESULT_TABS,
  RESUME_TEXT,
  TIMELINE_TEXT,
  appliedBudget,
  audienceBody,
  audienceChipView,
  audienceKindsFor,
  audienceSizeText,
  availableEdits,
  budgetEdit,
  byCostPerResult,
  customerListConfirm,
  customerPreviewPath,
  daysLeft,
  draftHref,
  editLabel,
  editNeedsConfirm,
  emptyAudienceForm,
  endEdit,
  fairSplitLine,
  fixHref,
  headroomFrom,
  keepCandidate,
  keepLabel,
  leadsLine,
  overviewTiles,
  pauseCauseOf,
  pausedByOf,
  placementLabel,
  promoteTiles,
  promoteVisible,
  promotionChip,
  promotionDrafts,
  reachShown,
  resultBars,
  resultsPath,
  resultsRange,
  resumeAmounts,
  runningFairTest,
  runningPromotions,
  statusTimeline,
  undoKindOf,
  undoOpen,
  verdictText,
  type AccessLite,
  type PauseSummaryLite,
  type TimelineReview,
} from "@/components/promote/results-helpers";
import type { ComparisonView } from "@/lib/promote/abtest";
import { KINDS_BY_LEVEL, type AudienceKind } from "@/lib/promote/audiences";
import { promoteText } from "@/lib/promote/copy";
import type { PromoteAccess } from "@/lib/promote/flags";
import type { CampaignReviewView } from "@/lib/promote/review";
import type { SpendSummaryView } from "@/lib/spend/summary";

const NOW = new Date("2026-10-31T06:30:00.000Z");
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

// =====================================================================================================================
// The status timeline (3.9)
// =====================================================================================================================

describe("statusTimeline: every 3.9 state maps to its copy and buttons", () => {
  const review = (over: Partial<TimelineReview>): TimelineReview => ({ reviewState: null, ads: [], pauseAndFree: [], dropped: [], account: null, ...over });
  const run = (status: string, over: Partial<TimelineReview> = {}, extra: Record<string, unknown> = {}) => statusTimeline({ status, now: NOW, timeZone: "Asia/Kolkata", review: review(over), ...extra });
  const steps = (v: ReturnType<typeof statusTimeline>) => v.steps.map((s) => `${s.key}:${s.status}`);

  it("a draft has no state line and nothing reached", () => {
    const v = run("draft");
    expect(v.state).toBe("draft");
    expect(v.outcome).toBeNull();
    expect(steps(v)).toEqual(["getting_ready:todo", "in_review:todo", "running:todo"]);
    expect(v.steps.map((s) => s.label)).toEqual(["Getting ready", "Meta is reviewing", "Running"]);
  });

  it("Getting ready while it is set up on Meta", () => {
    const v = run("launching");
    expect(v.outcome?.line).toBe("Getting ready");
    expect(steps(v)).toEqual(["getting_ready:current", "in_review:todo", "running:todo"]);
  });

  it("Meta is reviewing, then Running", () => {
    const reviewing = run("active", { reviewState: "in_review" });
    expect(reviewing.outcome).toMatchObject({ line: "Meta is reviewing", tone: "info", buttons: [] });
    expect(steps(reviewing)).toEqual(["getting_ready:done", "in_review:current", "running:todo"]);
    const running = run("active", { reviewState: "approved" });
    expect(running.outcome).toMatchObject({ line: "Running", tone: "good" });
    expect(steps(running)).toEqual(["getting_ready:done", "in_review:done", "running:current"]);
    // No review yet but one ad is in review: still reviewing. No information at all: an active campaign is running.
    expect(run("active", { ads: [{ id: "a1", state: "in_review", line: null }] }).state).toBe("in_review");
    expect(run("active").state).toBe("running");
  });

  it("Not approved: {reason}, with [Fix the ad] for the rejected ads and [Ask Meta to review again] (Opens Meta appeal_ad)", () => {
    const v = run("active", {
      reviewState: "rejected",
      ads: [
        { id: "a1", state: "rejected", line: "Not approved: the picture has too much text on it" },
        { id: "a2", state: "approved", line: "Running" },
      ],
    });
    expect(v.state).toBe("rejected");
    expect(v.outcome).toMatchObject({ line: "Not approved: the picture has too much text on it", tone: "bad" });
    expect(v.outcome?.buttons).toEqual([
      { kind: "fix_ad", label: "Fix the ad", adIds: ["a1"] },
      { kind: "opens_meta", screen: "appeal_ad", label: "Ask Meta to review again" },
    ]);
    // The review is over and it does not run.
    expect(steps(v)).toEqual(["getting_ready:done", "in_review:done", "running:todo"]);
    // Without Meta's words the copy still says what happened.
    expect(run("active", { reviewState: "rejected" }).outcome?.line).toBe(promoteText("status.rejected", { reason: TIMELINE_TEXT.reasonUnknown }));
  });

  it("partly_rejected: not approved on one placement, it still runs on the other, with both buttons", () => {
    const line = promoteText("status.rejected_on", { platform: "Instagram", reason: "the picture has too much text on it", other: "Facebook" });
    expect(line).toBe("Not approved on Instagram: the picture has too much text on it. It still runs on Facebook.");
    const v = run("active", { reviewState: "partly_rejected", ads: [{ id: "a1", state: "partly_rejected", line }] });
    expect(v.state).toBe("partly_rejected");
    expect(v.outcome).toMatchObject({ line, tone: "warn" });
    expect(v.outcome?.buttons.map((b) => b.kind)).toEqual(["fix_ad", "opens_meta"]);
  });

  it("a special-category rejection says so, and [Fix the ad] carries the category for the copy", () => {
    const line = promoteText("status.special_category", { category: "housing" });
    expect(line).toBe("Meta says this ad is about housing. Mark it as that and run it again.");
    const v = run("active", { reviewState: "rejected", ads: [{ id: "a1", state: "rejected", line, reasons: [{ category: "housing", line }] }] });
    expect(v.outcome?.line).toBe(line);
    expect(v.outcome?.buttons[0]).toEqual({ kind: "fix_ad", label: "Fix the ad", adIds: ["a1"], category: "housing" });
  });

  it("Approved with issues: {reason}, with [Fix the ad] and no appeal (it runs)", () => {
    const line = promoteText("status.with_issues", { reason: "the link doesn't open" });
    const v = run("active", { reviewState: "with_issues", ads: [{ id: "a1", state: "with_issues", line }] });
    expect(v.outcome).toMatchObject({ line: "Approved with issues: the link doesn't open", tone: "warn" });
    expect(v.outcome?.buttons).toEqual([{ kind: "fix_ad", label: "Fix the ad", adIds: ["a1"] }]);
  });

  it("Paused by you, by today's limit, or by a safety stop with its reason", () => {
    expect(run("paused", { reviewState: "approved" }).outcome).toMatchObject({ line: "Paused by you", buttons: [] });
    expect(run("paused", {}, { pausedBy: "limit" }).outcome?.line).toBe("Paused: your limit for today is used up");
    expect(run("paused", {}, { pausedBy: "safety", safetyReason: "spend jumped in an hour" }).outcome?.line).toBe("Paused by a safety stop: spend jumped in an hour");
    expect(run("paused", {}, { pausedBy: "safety" }).outcome?.line).toBe(`Paused by a safety stop: ${TIMELINE_TEXT.safetyDefault}`);
    expect(run("paused", {}, { pausedBy: "limit" }).state).toBe("paused_limit");
    // Paused: nothing is current.
    expect(run("paused", { reviewState: "approved" }).steps.every((s) => s.status !== "current")).toBe(true);
  });

  it("this month's limit never says 'today'; a stop says who stopped spending, in neutral words; unknown says only Paused", () => {
    const month = run("paused", {}, { pausedBy: "limit_month" });
    expect(month).toMatchObject({ state: "paused_limit_month", outcome: { line: "Paused: this month's ads limit is used up", tone: "warn" } });
    expect(month.outcome?.line).not.toMatch(/today/);
    expect(run("paused", {}, { pausedBy: "stopped", stoppedBy: "Priya" }).outcome).toMatchObject({ key: "paused_stopped", line: "Paused: all spending is stopped (stopped by Priya)", tone: "warn" });
    expect(run("paused", {}, { pausedBy: "stopped" }).outcome?.line).toBe("Paused: all spending is stopped");
    const stop = run("paused", {}, { pausedBy: "stop" }).outcome;
    expect(stop).toMatchObject({ key: "paused_stop", line: "Paused: spending was stopped", tone: "neutral" });
    // A person stopped it, or Meta was disconnected: nothing blames a fault.
    expect(stop?.line).not.toMatch(/safety|wrong/i);
    expect(run("paused", {}, { pausedBy: "stop", stoppedBy: "Edwyz support" }).outcome?.line).toBe("Paused: spending was stopped (stopped by Edwyz support)");
    expect(run("paused", {}, { pausedBy: "unknown" }).outcome).toMatchObject({ key: "paused_unknown", line: "Paused", tone: "neutral" });
    // A rejected campaign that is paused carries the same second line.
    expect(run("paused", { reviewState: "rejected" }, { pausedBy: "limit_month" }).lines.map((l) => l.line)).toContain("Paused: this month's ads limit is used up");
  });

  it("a rejected campaign that is also paused shows both, the rejection first", () => {
    const v = run("paused", { reviewState: "rejected", ads: [{ id: "a1", state: "rejected", line: "Not approved: x" }] });
    expect(v.outcome?.line).toBe("Not approved: x");
    expect(v.lines.map((l) => l.line)).toContain("Paused by you");
    const issues = run("paused", { reviewState: "with_issues", ads: [{ id: "a1", state: "with_issues", line: "Approved with issues: y" }] });
    expect(issues.outcome?.line).toBe("Paused by you");
    expect(issues.lines[0]).toMatchObject({ line: "Approved with issues: y", buttons: [{ kind: "fix_ad" }] });
  });

  it("Finished on Sun 1 Nov, in the ad account's time zone; an archived campaign says it doesn't run", () => {
    const ended = statusTimeline({ status: "active", endsAt: "2026-11-01T18:29:00.000Z", now: new Date("2026-11-02T08:00:00.000Z"), timeZone: "Asia/Kolkata", review: review({ reviewState: "approved" }) });
    expect(ended.state).toBe("finished");
    expect(ended.outcome).toMatchObject({ line: "Finished on Sun 1 Nov", buttons: [] });
    expect(run("archived").outcome?.line).toBe(TIMELINE_TEXT.archived);
  });

  it("pauseAndFree: '₹2,100 is set aside for this ad while it's not approved.' with [Pause and free ₹2,100]", () => {
    const free = { adSetId: "s1", amountMinor: 210_000, currency: "INR" };
    const v = run("active", { reviewState: "rejected", pauseAndFree: [free] });
    const line = v.lines.find((l) => l.key === "free-s1")!;
    expect(line.line).toBe("₹2,100 is set aside for this ad while it's not approved.");
    expect(line.buttons).toEqual([{ kind: "pause_and_free", label: "Pause and free ₹2,100", adSetId: "s1", amountMinor: 210_000, currency: "INR" }]);
    // The server's own words win; no button once it is paused.
    const server = run("active", { pauseAndFree: [{ ...free, line: "L", label: "B" }] }).lines[0];
    expect(server).toMatchObject({ line: "L", buttons: [{ label: "B" }] });
    expect(run("paused", { pauseAndFree: [free] }).lines.find((l) => l.key === "free-s1")?.buttons).toEqual([]);
    // The only ad set on Meta: pausing the campaign frees exactly that, so its own line keeps the button.
    expect(run("active", { pauseAndFree: [{ ...free, line: "L", label: "B" }] }, { launchedAdSetIds: ["s1"] }).lines[0]).toMatchObject({ key: "free-s1", line: "L", buttons: [{ label: "B", adSetId: "s1" }] });
  });

  it("[Pause and free] with two rejected ad sets: one line, the amounts added up, one button that pauses the campaign", () => {
    const rows = [
      { adSetId: "s1", amountMinor: 210_000, currency: "INR", line: "₹2,100 is set aside for this ad while it's not approved.", label: "Pause and free ₹2,100" },
      { adSetId: "s2", amountMinor: 90_000, currency: "INR", line: "₹900 is set aside for this ad while it's not approved.", label: "Pause and free ₹900" },
    ];
    const v = run("active", { reviewState: "rejected", pauseAndFree: rows }, { launchedAdSetIds: ["s1", "s2"] });
    const free = v.lines.filter((l) => l.key.startsWith("free-"));
    expect(free).toEqual([
      {
        key: "free-campaign",
        line: "₹3,000 is set aside for these ads while they're not approved.",
        tone: "warn",
        buttons: [{ kind: "pause_and_free", label: "Pause and free ₹3,000", adSetId: null, amountMinor: 300_000, currency: "INR" }],
      },
    ]);
    // A campaign-level amount (every ad is rejected) frees with the campaign too, added to the ad sets'.
    const whole = run("active", { pauseAndFree: [rows[0], { adSetId: null, amountMinor: 50_000, currency: "INR" }] }, { launchedAdSetIds: ["s1", "s2"] }).lines;
    expect(whole).toHaveLength(1);
    expect(whole[0].buttons[0]).toMatchObject({ adSetId: null, amountMinor: 260_000 });
    // Paused: the line, without the button.
    expect(run("paused", { pauseAndFree: rows }, { launchedAdSetIds: ["s1", "s2"] }).lines.find((l) => l.key === "free-campaign")?.buttons).toEqual([]);
  });

  it("[Pause and free] when only some ad sets hold money: no button, and the line says how to free it", () => {
    const free = { adSetId: "s1", amountMinor: 210_000, currency: "INR" };
    const v = run("active", { reviewState: "partly_rejected", pauseAndFree: [free] }, { launchedAdSetIds: ["s1", "s2"] });
    const line = v.lines.find((l) => l.key === "free-s1")!;
    expect(line.buttons).toEqual([]);
    expect(line.line).toBe(`₹2,100 is set aside for this ad while it's not approved. ${TIMELINE_TEXT.freeNeedsPause}`);
    expect(TIMELINE_TEXT.freeNeedsPause).toBe("To free it, pause the campaign. Its other ads stop too.");
    // Two currencies never add up: each line stays, without a button.
    const mixed = run("active", { pauseAndFree: [free, { adSetId: "s2", amountMinor: 1_000, currency: "USD" }] }, { launchedAdSetIds: ["s1", "s2"] }).lines;
    expect(mixed.map((l) => l.buttons.length)).toEqual([0, 0]);
  });

  it("Meta isn't showing this on {position} any more, from the effective placements", () => {
    const v = run("active", { reviewState: "approved", dropped: [{ adSetId: "s1", placement: "instagram_reels" }, { adSetId: "s1", placement: "messenger_stories", line: "Meta isn't showing this on Messenger Stories any more" }] });
    expect(v.lines.map((l) => l.line)).toEqual(["Meta isn't showing this on Instagram Reels any more", "Meta isn't showing this on Messenger Stories any more"]);
  });

  it("an account restriction disables Start, with Opens Meta account_quality; pausing still works", () => {
    const v = run("active", { reviewState: "approved", account: { line: "Meta has limited ads on Shop. Pausing still works." } });
    expect(v.blocksStart).toBe(true);
    expect(v.lines.at(-1)).toMatchObject({ tone: "bad", buttons: [{ kind: "opens_meta", screen: "account_quality" }] });
    expect(run("active", { reviewState: "approved" }).blocksStart).toBe(false);
  });

  it("renders the steps for assistive technology, the line, and the buttons; Opens Meta only with a server address", () => {
    const view = run("active", { reviewState: "rejected", ads: [{ id: "a1", state: "rejected", line: "Not approved: x" }] });
    const without = html(createElement(StatusTimeline, { view, onAction: () => undefined }));
    expect(without).toContain('data-testid="status-timeline"');
    expect(without).toContain('aria-live="polite"');
    expect(without).toContain("Done: ");
    expect(without).toContain("Not approved: x");
    expect(without).toContain('data-testid="timeline-fix-ad"');
    expect(without).not.toContain('data-opens-meta="appeal_ad"');
    const withHref = html(createElement(StatusTimeline, { view, onAction: () => undefined, metaLinks: { appeal_ad: "https://example.test/appeal" } }));
    expect(withHref).toContain('data-opens-meta="appeal_ad"');
    expect(withHref).toContain('rel="noopener noreferrer"');
    const current = html(createElement(StatusTimeline, { view: run("active", { reviewState: "in_review" }) }));
    expect(current).toContain('aria-current="step"');
  });
});

// =====================================================================================================================
// Edits (3.9 table, 3.8)
// =====================================================================================================================

describe("edits: which apply at once with Undo and which need the confirm sheet", () => {
  it("a cut and an earlier end are instant with Undo; a raise and a later end need the confirm sheet", () => {
    expect(EDIT_MODE).toEqual({ pause: "instant", end_earlier: "undo", spend_less: "undo", run_longer: "confirm", spend_more: "confirm", copy: "local", resume: "confirm" });
    expect(budgetEdit(50_000, 30_000)).toEqual({ kind: "spend_less", mode: "undo" });
    expect(budgetEdit(50_000, 70_000)).toEqual({ kind: "spend_more", mode: "confirm" });
    expect(budgetEdit(50_000, 50_000)).toBeNull();
    const end = new Date("2026-11-10T10:00:00Z");
    expect(endEdit(end, new Date("2026-11-05T10:00:00Z"))).toEqual({ kind: "end_earlier", mode: "undo" });
    expect(endEdit(end, new Date("2026-11-20T10:00:00Z"))).toEqual({ kind: "run_longer", mode: "confirm" });
    // A first end on a campaign without one is a lowering, as the server treats it.
    expect(endEdit(null, new Date("2026-11-05T10:00:00Z"))).toEqual({ kind: "end_earlier", mode: "undo" });
    expect(endEdit(end, new Date(end))).toBeNull();
    for (const k of ["spend_more", "run_longer", "resume"] as const) expect(editNeedsConfirm(k)).toBe(true);
    for (const k of ["pause", "spend_less", "end_earlier", "copy"] as const) expect(editNeedsConfirm(k)).toBe(false);
  });

  it("the Undo of a lowering is the matching raise, so it goes through the confirm sheet", () => {
    expect(undoKindOf("spend_less")).toBe("spend_more");
    expect(undoKindOf("end_earlier")).toBe("run_longer");
    expect(EDIT_MODE[undoKindOf("spend_less")]).toBe("confirm");
  });

  it("the labels are the catalogue's", () => {
    expect(["pause", "end_earlier", "run_longer", "spend_less", "spend_more", "copy", "resume"].map((k) => editLabel(k as never))).toEqual([
      "Pause",
      "End earlier",
      "Run longer",
      "Spend less per day",
      "Spend more per day",
      "Make a copy",
      "Resume",
    ]);
  });

  const camp = (over: Record<string, unknown> = {}) => ({ status: "active", metaCampaignId: "c1", surface: "promote", adSets: [{ metaAdSetId: "s1", dailyBudgetMinor: 30_000 }], ...over });
  const kinds = (b: ReturnType<typeof availableEdits>) => b.map((x) => x.kind);

  it("offers the 3.9 edits by status; Resume only for promotions (the old wizard keeps its typed activation, D5)", () => {
    expect(kinds(availableEdits(camp()))).toEqual(["pause", "end_earlier", "run_longer", "spend_less", "spend_more", "copy"]);
    expect(kinds(availableEdits(camp({ status: "paused" })))).toEqual(["resume", "end_earlier", "run_longer", "spend_less", "spend_more", "copy"]);
    expect(kinds(availableEdits(camp({ status: "paused", surface: "wizard" })))).not.toContain("resume");
    expect(kinds(availableEdits(camp({ status: "draft", metaCampaignId: null })))).toEqual(["copy"]);
    expect(kinds(availableEdits(camp({ status: "archived" })))).toEqual(["copy"]);
    expect(availableEdits(camp({ status: "launching" }))).toEqual([]);
    // A lifetime-only ad set has no daily budget to change here.
    expect(kinds(availableEdits(camp({ adSets: [{ metaAdSetId: "s1", dailyBudgetMinor: null, lifetimeBudgetMinor: 900_000 }] })))).not.toContain("spend_less");
  });

  it("a restricted account disables every raise with the reason; pausing and lowerings still work", () => {
    const b = availableEdits(camp({ status: "paused" }), { blocksStart: true });
    for (const x of b) expect(x.disabled, x.kind).toBe(["resume", "run_longer", "spend_more"].includes(x.kind));
    expect(b.find((x) => x.kind === "spend_more")?.reason).toMatch(/Pausing and spending less still work/);
  });

  it("counts the days left for the cost line (2 to 90), and none without an end", () => {
    expect(daysLeft("2026-11-04T06:30:00.000Z", NOW)).toBe(4);
    expect(daysLeft("2026-10-31T12:00:00.000Z", NOW)).toBe(2);
    expect(daysLeft("2027-06-01T00:00:00.000Z", NOW)).toBe(90);
    expect(daysLeft(null, NOW)).toBeNull();
  });

  it("with a running fair test, budget edits keep the split (3.8)", () => {
    const sets = [
      { metaAdSetId: "s1", variantKey: "A" },
      { metaAdSetId: "s2", variantKey: "B" },
    ];
    expect(runningFairTest({ mode: "fair_split", status: "running", winnerAdSetId: null }, sets)).toBe(true);
    expect(runningFairTest({ mode: "fair_split", status: "running", winnerAdSetId: "s1" }, sets)).toBe(false);
    expect(runningFairTest({ mode: "meta_study", status: "running" }, sets)).toBe(false);
    expect(runningFairTest({ mode: "fair_split", status: "running" }, sets.slice(0, 1))).toBe(false);
    expect(fairSplitLine(30_000, 2, "INR")).toBe("Fair test: ₹300 a day split equally, ₹150 for each version. Meta may sometimes show both to the same person.");
    // ₹290 split 3 ways is ₹96 each, ₹288 in total.
    expect(fairSplitLine(29_000, 3, "INR")).toBe("Fair test: ₹288 a day split equally, ₹96 for each version. Meta may sometimes show both to the same person.");
  });

  it("a fair-test budget edit confirms and reports the sum of the shares, never the typed total (3.8)", () => {
    // ₹301 typed on a ₹300 two-version test: ₹150 each, ₹300 in all, which is no change.
    const applied = appliedBudget(30_100, { fair: true, versions: 2, currency: "INR" });
    expect(applied).toEqual({ minor: 30_000, shareMinor: 15_000, problem: null });
    expect(budgetEdit(30_000, applied.minor)).toBeNull();
    // ₹401 is a raise to ₹400, not ₹401.
    expect(appliedBudget(40_100, { fair: true, versions: 2, currency: "INR" }).minor).toBe(40_000);
    expect(budgetEdit(30_000, appliedBudget(40_100, { fair: true, versions: 2, currency: "INR" }).minor)).toEqual({ kind: "spend_more", mode: "confirm" });
    // A share under one whole unit is refused by the server: the sheet says so first.
    expect(appliedBudget(150, { fair: true, versions: 2, currency: "INR" }).problem).toBe("Each version needs at least ₹1 a day. Raise the total or remove a version.");
    // Outside a fair test the typed amount is what applies.
    expect(appliedBudget(30_100, { fair: false, versions: 1, currency: "INR" })).toEqual({ minor: 30_100, shareMinor: null, problem: null });
    const src = readFileSync(path.resolve(__dirname, "../src/components/promote/CampaignEdits.tsx"), "utf8");
    for (const part of ["appliedBudget(typed", "budgetEdit(currentBudget, minor)", "res?.dailyTotalMinor, res?.appliedDailyBudgetMinor", "fairSplitLine(typed"]) expect(src).toContain(part);
  });

  it("[Resume] shows the amount it confirms: daily budgets plus a lifetime budget", () => {
    expect(resumeAmounts({ totalDailyBudgetMinor: 30_000 })).toEqual({ confirmMinor: 30_000, dailyMinor: 30_000, lifetimeMinor: 0 });
    expect(RESUME_TEXT.label(resumeAmounts({ totalDailyBudgetMinor: 30_000, confirmTotalMinor: 30_000 }), "INR")).toBe("Resume · up to ₹300 a day");
    // A lifetime-only ad set: ₹0 a day, ₹9,000 confirmed. The sheet never says "up to ₹0 a day".
    const lifetime = resumeAmounts({ totalDailyBudgetMinor: 0, confirmTotalMinor: 900_000 });
    expect(lifetime).toEqual({ confirmMinor: 900_000, dailyMinor: 0, lifetimeMinor: 900_000 });
    expect(RESUME_TEXT.label(lifetime, "INR")).toBe("Resume · ₹9,000 lifetime budget");
    expect(RESUME_TEXT.body(lifetime, "INR")).toBe("It starts showing again and spends its lifetime budget of ₹9,000 over the rest of the run. We check it against your spending limits first.");
    const both = resumeAmounts({ totalDailyBudgetMinor: 30_000, confirmTotalMinor: 930_000 });
    expect(RESUME_TEXT.label(both, "INR")).toBe("Resume · ₹9,300 (₹300 a day plus ₹9,000 lifetime)");
    expect(RESUME_TEXT.body(both, "INR")).toContain("up to ₹300 a day, plus its lifetime budget of ₹9,000");
    // The request sends the amount shown; the cost line is skipped (with words instead) when there is no daily budget.
    const src = readFileSync(path.resolve(__dirname, "../src/components/promote/CampaignEdits.tsx"), "utf8");
    for (const part of ["confirmedTotalMinor: amounts.confirmMinor", "RESUME_TEXT.label(amounts, c.currency)", "RESUME_TEXT.body(amounts, c.currency)", "costDaily > 0n && runDays !== null", "RESUME_TEXT.lifetimeOnly("]) expect(src).toContain(part);
    expect(src).not.toContain("confirmedTotalMinor: c.confirmTotalMinor ?? c.totalDailyBudgetMinor");
  });

  it("[Resume] is disabled while starting is closed (PROMOTE_ENABLED), and the page passes canStart", () => {
    const paused = { status: "paused", metaCampaignId: "m1", surface: "promote", adSets: [{ metaAdSetId: "s1", dailyBudgetMinor: 30_000 }] };
    expect(availableEdits(paused, { canStart: false }).find((b) => b.kind === "resume")).toMatchObject({ disabled: true, reason: EDITS_TEXT.startClosed });
    expect(availableEdits(paused, { canStart: true }).find((b) => b.kind === "resume")).toMatchObject({ disabled: false, reason: null });
    // Starting closed doesn't touch the other edits.
    expect(availableEdits(paused, { canStart: false }).filter((b) => b.kind !== "resume").every((b) => !b.disabled)).toBe(true);
    const src = readFileSync(path.resolve(__dirname, "../src/components/ads/CampaignDetail.tsx"), "utf8");
    expect(src).toContain("canStart={promote.data?.access.canStart !== false}");
  });

  it("renders the edit buttons, the restricted reason and no sheet until one is opened", () => {
    const c: EditCampaign = { id: "c1", name: "Diwali", status: "active", surface: "promote", currency: "INR", metaCampaignId: "m1", totalDailyBudgetMinor: 30_000, endsAt: "2026-11-04T18:29:00.000Z", adSets: [{ id: "s1", name: "A", metaAdSetId: "x", dailyBudgetMinor: 30_000 }] };
    const out = html(createElement(CampaignEdits, { campaign: c }));
    for (const k of ["pause", "end_earlier", "run_longer", "spend_less", "spend_more", "copy"]) expect(out).toContain(`data-testid="edit-${k}"`);
    expect(out).not.toContain('role="dialog"');
    const restricted = html(createElement(CampaignEdits, { campaign: c, blocksStart: true }));
    expect(restricted).toContain("Meta has limited ads on this account");
    expect(html(createElement(CampaignEdits, { campaign: { ...c, status: "launching" } }))).toBe("");
  });

  it("the edits post to the existing routes, the budget without an ad set while a fair test runs", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/promote/CampaignEdits.tsx"), "utf8");
    for (const part of ["/pause`", "/resume`", "/budget`", "/end`", "/duplicate`", "confirmedTotalMinor", "fair || !set ? { dailyBudgetMinor: minor }", "<CostLine"]) expect(src).toContain(part);
    expect(src).not.toMatch(/\/copies/);
  });
});

// =====================================================================================================================
// Results (3.10)
// =====================================================================================================================

describe("results", () => {
  const row = (key: string, results: number, spendMinor: number, cost: number | null, text?: string) => ({
    key,
    label: null,
    text: text ?? null,
    results,
    spendMinor: String(spendMinor),
    costPerResultMinor: cost === null ? null : String(cost),
    costPerResult: cost === null ? null : `₹${cost / 100}`,
  });

  it("placement rows are sorted by cost per result, each with its text value", () => {
    const rows = [
      row("facebook|feed", 10, 120_000, 12_000, "Facebook Feed: 10 chats, ₹120 each"),
      row("instagram|reels", 46, 142_600, 3_100, "Instagram Reels: 46 chats, ₹31 each"),
      row("facebook|story", 0, 5_000, null),
      row("instagram|feed", 20, 100_000, 5_000, "Instagram Feed: 20 chats, ₹50 each"),
    ];
    const bars = resultBars(rows, { placements: true });
    expect(bars.map((b) => b.key)).toEqual(["instagram|reels", "instagram|feed", "facebook|feed", "facebook|story"]);
    expect(bars[0]).toMatchObject({ text: "Instagram Reels: 46 chats, ₹31 each", label: "Instagram Reels", percent: 100 });
    for (const b of bars) expect(b.text.length).toBeGreaterThan(b.label.length);
    expect(bars.at(-1)?.text).toBe("Facebook Stories: no results yet");
    expect(byCostPerResult(rows).map((r) => r.key)[0]).toBe("instagram|reels");
  });

  it("an unknown position shows its raw key", () => {
    expect(placementLabel("facebook|biz_disco_feed")).toBe("Facebook: biz_disco_feed");
    expect(placementLabel("instagram|reels")).toBe("Instagram Reels");
    expect(resultBars([row("facebook|biz_disco_feed", 3, 3_000, 1_000)], { placements: true })[0].label).toBe("Facebook: biz_disco_feed");
  });

  it("run reach is never summed from daily rows", () => {
    const daily = [{ reach: 100 }, { reach: 200 }];
    expect(reachShown({ reach: 250, reachLabel: "People reached (whole run)" }, daily)).toEqual({ value: "250", label: "People reached (whole run)" });
    expect(reachShown({ reach: null, reachLabel: "Not reported yet" }, daily).value).toBe("Not yet");
    expect(reachShown({ reach: null, reachLabel: "Not reported yet" }, daily).value).not.toBe("300");
  });

  it("the Overview says clicks per 100 views and cost per 1,000 views", () => {
    const tiles = overviewTiles({ spend: "₹1,426", resultsText: "46 chats", costPerResult: "₹31", costPerResultLabel: "Cost per chat", reach: 12_000, reachLabel: "People reached (whole run)", ctr: 1.256, cpm: "₹118.83" });
    expect(tiles.map((t) => `${t.label}=${t.value}`)).toEqual([
      "Spent=₹1,426",
      "Results=46 chats",
      "Cost per chat=₹31",
      "People reached (whole run)=12,000",
      "clicks per 100 views=1.26",
      "cost per 1,000 views=₹118.83",
    ]);
    expect(RESULT_TABS.map((t) => t.label)).toEqual(["Overview", "Where it worked", "Which version worked", "Who saw it", "Leads"]);
  });

  it("every tab asks for the run's days: the route refuses a request without from and to", () => {
    const range = { from: "2026-10-20", to: "2026-10-31" };
    expect(resultsPath("c 1", "placement", range)).toBe("/api/ads/insights/dimensions?campaignId=c%201&dimension=placement&from=2026-10-20&to=2026-10-31");
    for (const d of ["overview", "placement", "creative", "age_gender", "region", "leads"] as const) {
      const url = new URL(resultsPath("k1", d, range), "https://wa.example");
      expect(url.searchParams.get("from"), d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(url.searchParams.get("to"), d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(url.searchParams.get("dimension")).toBe(d);
    }
    // The component's every request goes through resultsPath with the range it is given.
    const src = readFileSync(path.resolve(__dirname, "../src/components/promote/ResultsByPlacement.tsx"), "utf8");
    expect(src).toContain("resultsPath(campaignId, dimension, range)");
    expect(src.match(/resultsPath\(/g)?.length).toBe(1);
    expect(src.match(/useApi</g)?.length).toBe(1);
    expect(readFileSync(path.resolve(__dirname, "../src/components/ads/CampaignDetail.tsx"), "utf8")).toContain("range={resultsRange(c, tz, new Date())}");
  });

  it("the run's days: from its start to today (or its end), in the ad account's zone, at most 366 days", () => {
    // 06:30 UTC on 31 Oct is 12:00 in Kolkata and 23:30 on 30 Oct in Los Angeles.
    expect(resultsRange({ startsAt: "2026-10-20T03:00:00.000Z" }, "Asia/Kolkata", NOW)).toEqual({ from: "2026-10-20", to: "2026-10-31" });
    expect(resultsRange({ startsAt: "2026-10-20T03:00:00.000Z" }, "America/Los_Angeles", NOW)).toEqual({ from: "2026-10-19", to: "2026-10-30" });
    // No start: when it was launched, else when it was made.
    expect(resultsRange({ startsAt: null, launchedAt: "2026-10-25T10:00:00.000Z", createdAt: "2026-10-01T10:00:00.000Z" }, "Asia/Kolkata", NOW).from).toBe("2026-10-25");
    expect(resultsRange({ createdAt: "2026-10-01T10:00:00.000Z" }, "Asia/Kolkata", NOW).from).toBe("2026-10-01");
    // An end before today closes the range; a later end doesn't.
    expect(resultsRange({ startsAt: "2026-10-01T03:00:00.000Z", endsAt: "2026-10-10T18:29:00.000Z" }, "Asia/Kolkata", NOW)).toEqual({ from: "2026-10-01", to: "2026-10-10" });
    expect(resultsRange({ startsAt: "2026-10-01T03:00:00.000Z", endsAt: "2026-12-10T18:29:00.000Z" }, "Asia/Kolkata", NOW).to).toBe("2026-10-31");
    // A start after today (scheduled) never makes from later than to.
    expect(resultsRange({ startsAt: "2026-11-05T03:00:00.000Z" }, "Asia/Kolkata", NOW)).toEqual({ from: "2026-10-31", to: "2026-10-31" });
    // A long run keeps its latest 366 days.
    const long = resultsRange({ startsAt: "2024-01-01T00:00:00.000Z" }, "Asia/Kolkata", NOW);
    expect(long).toEqual({ from: "2025-10-31", to: "2026-10-31" });
    const days = (Date.parse(`${long.to}T00:00:00Z`) - Date.parse(`${long.from}T00:00:00Z`)) / 86_400_000 + 1;
    expect(days).toBe(RESULTS_MAX_DAYS);
    // No zone or a broken one: Asia/Kolkata.
    expect(resultsRange({ startsAt: "2026-10-20T03:00:00.000Z" }, null, NOW)).toEqual(resultsRange({ startsAt: "2026-10-20T03:00:00.000Z" }, "Asia/Kolkata", NOW));
    expect(resultsRange({ startsAt: "2026-10-20T03:00:00.000Z" }, "Not/AZone", NOW).to).toBe("2026-10-31");
  });

  it("the leads split, and its fallback label while Meta doesn't say each lead's app", () => {
    expect(leadsLine({ total: 23, instagram: 17, facebook: 6, source: "leads" })).toEqual({ text: "Leads from this ad: 23 (Instagram 17, Facebook 6)", note: null, platformNote: null });
    const fallback = leadsLine({ total: 23, instagram: 17, facebook: 6, source: "meta_report", platformNote: promoteText("results.platform_unknown") });
    expect(fallback.note).toBe("From Meta's report");
    expect(fallback.platformNote).toBe("Instagram or Facebook: not reported by Meta");
  });

  it("boosted posts show the paid-only note; the tabs render with the note", () => {
    expect(RESULTS_TEXT.organicNote).toBe("Free (organic) numbers need an extra Meta permission that Edwyz hasn't asked for.");
    const range = { from: "2026-10-20", to: "2026-10-31" };
    const boosted = html(createElement(ResultsByPlacement, { campaignId: "c1", range, boosted: true }));
    expect(boosted).toContain('role="tablist"');
    expect(boosted).toContain("Where it worked");
    expect(boosted).toContain('data-testid="results-organic-note"');
    expect(html(createElement(ResultsByPlacement, { campaignId: "c1", range }))).not.toContain("results-organic-note");
  });
});

// =====================================================================================================================
// Compare versions (3.8)
// =====================================================================================================================

describe("compare versions", () => {
  const winner = { state: "likely_winner" as const, winner: { adSetId: "sB", key: "B", costPerResult: "₹38" }, runnerUp: { key: "A", costPerResult: "₹55" }, hint: null };
  const early = { state: "too_early" as const, winner: null, runnerUp: null, hint: "Each version needs at least 7 days and 15 chats before the results can be compared." };

  it("the verdict copy for a winner and while it is too early", () => {
    expect(verdictText(winner, "chats")).toBe("Version B gets chats at ₹38 vs ₹55: likely winner.");
    expect(verdictText(early, "chats")).toBe("Too early to tell.");
    expect(keepLabel("B")).toBe("Keep B, pause the others");
    expect(keepCandidate({ canPickWinner: true, verdict: winner })).toEqual({ adSetId: "sB", key: "B" });
    expect(keepCandidate({ canPickWinner: false, verdict: winner })).toBeNull();
    expect(keepCandidate({ canPickWinner: true, verdict: early })).toBeNull();
  });

  it("renders the verdict and [Keep B, pause the others]; too early shows what is missing and no button", () => {
    const comparison: ComparisonLite = {
      test: { id: "t1", status: "running", winnerAdSetId: null },
      resultNoun: "chats",
      versions: [
        { key: "sA", adSetId: "sA", version: "A", label: "Version A", text: "Version A: 20 chats, ₹55 each", results: 20, spendMinor: "110000", costPerResultMinor: "5500" },
        { key: "sB", adSetId: "sB", version: "B", label: "Version B", text: "Version B: 30 chats, ₹38 each", results: 30, spendMinor: "114000", costPerResultMinor: "3800" },
      ],
      verdict: winner,
      canPickWinner: true,
    };
    const out = html(createElement(CompareVersions, { comparison }));
    expect(out).toContain("Version B gets chats at ₹38 vs ₹55: likely winner.");
    expect(out).toContain("Keep B, pause the others");
    expect(out.indexOf("Version B: 30 chats")).toBeLessThan(out.indexOf("Version A: 20 chats"));
    const tooEarly = html(createElement(CompareVersions, { comparison: { ...comparison, verdict: early } }));
    expect(tooEarly).toContain("Too early to tell.");
    expect(tooEarly).toContain("Each version needs at least 7 days");
    expect(tooEarly).not.toContain("compare-keep");
  });
});

// =====================================================================================================================
// Tiles and the promotions list (7.1)
// =====================================================================================================================

describe("the Ads page tiles", () => {
  it("Boost a post, Get WhatsApp chats, Get leads, then More goals and All settings (advanced) to the old wizard", () => {
    const tiles = promoteTiles();
    expect(tiles.map((t) => t.title)).toEqual(["Boost a post", "Get WhatsApp chats", "Get leads", "More goals", "All settings (advanced)"]);
    expect(tiles.find((t) => t.id === "advanced")?.href).toBe(ADVANCED_PATH);
    expect(ADVANCED_PATH).toBe("/app/ads/new");
    expect(tiles.map((t) => t.href)).toEqual(["/app/ads/boost", "/app/ads/create?goal=whatsapp_chats", "/app/ads/create?goal=lead_form", "/app/ads/create", "/app/ads/new"]);
    // A goal that isn't offered loses its tile; the rest stay.
    expect(promoteTiles(["website_visits"]).map((t) => t.id)).toEqual(["boost", "more", "advanced"]);
  });

  it("no tile name can be mistaken for the old list's own controls (e2e/growth-ads.spec.ts)", () => {
    for (const t of promoteTiles()) expect(`${t.title} ${t.body}`).not.toMatch(/new campaign|create a campaign|connect ad account|all spending limits|daily limit|no campaigns yet|save limit|try again/i);
  });

  it("lists running promotions with a chip, and promotion drafts; old-wizard campaigns stay in the table only", () => {
    const list = [
      { id: "1", name: "Boost", template: "boost_post", status: "active", currency: "INR", totalDailyBudgetMinor: 30_000, surface: "promote", reviewState: "in_review" },
      { id: "2", name: "Draft", template: "click_to_whatsapp", status: "draft", currency: "INR", totalDailyBudgetMinor: 30_000, surface: "eddy" },
      { id: "3", name: "Old", template: "traffic", status: "active", currency: "INR", totalDailyBudgetMinor: 30_000, surface: "wizard" },
    ];
    expect(runningPromotions(list).map((c) => c.id)).toEqual(["1"]);
    expect(promotionDrafts(list).map((c) => c.id)).toEqual(["2"]);
    expect(promotionChip(list[0])).toEqual({ label: "Meta is reviewing", tone: "info" });
    expect(promotionChip({ status: "active", reviewState: "rejected" })).toEqual({ label: "Not approved", tone: "bad" });
    expect(promotionChip({ status: "active", reviewState: "approved" })).toEqual({ label: "Running", tone: "good" });
    expect(promotionChip({ status: "launching" }).label).toBe("Getting ready");
    expect(draftHref(list[0])).toBe("/app/ads/boost?draft=1");
    expect(draftHref(list[1])).toBe("/app/ads/create?draft=2");
    expect(draftHref(list[2])).toBe("/app/ads/new?draft=3");
    expect(fixHref("x", "promote")).toBe("/app/ads/create?draft=x");
    expect(fixHref("x", "wizard")).toBe("/app/ads/new?draft=x");
  });

  it("Undo of a discard is open for 15 minutes", () => {
    expect(undoOpen(new Date(NOW.getTime() + 60_000), NOW)).toBe(true);
    expect(undoOpen(new Date(NOW.getTime() - 1), NOW)).toBe(false);
    expect(undoOpen(null, NOW)).toBe(false);
  });

  it("renders the tiles as links with test ids, the running row's [Pause] named after it, and drafts with Resume and Discard", () => {
    const out = html(
      createElement(PromoteTiles, {
        campaigns: [
          { id: "1", name: "Diwali boost", template: "boost_post", status: "active", currency: "INR", totalDailyBudgetMinor: 30_000, surface: "promote" },
          { id: "2", name: "Chats", template: "click_to_whatsapp", status: "draft", currency: "INR", totalDailyBudgetMinor: 30_000, surface: "promote" },
        ],
      }),
    );
    expect(out).toContain('data-testid="promote-tile-advanced"');
    // The advanced tile's own <a> carries the old wizard's address (attribute order is the renderer's, so it isn't assumed).
    const advanced = out.match(/<a\b[^>]*data-testid="promote-tile-advanced"[^>]*>/)?.[0] ?? "";
    expect(advanced).toContain('href="/app/ads/new"');
    expect(out).toContain('aria-label="Pause &quot;Diwali boost&quot;"');
    expect(out).toContain('href="/app/ads/create?draft=2"');
    expect(out).toContain('aria-label="Discard the draft &quot;Chats&quot;"');
    expect(out).toContain('href="/app/ads/audiences"');
    expect(out).toContain('aria-live="polite"');
  });

  it("is visible only when promoteAccess says so; the summary helpers read the spend summary", () => {
    expect(promoteVisible(null)).toBe(false);
    expect(promoteVisible({ visible: false })).toBe(false);
    expect(promoteVisible({ visible: true })).toBe(true);
    // No summary yet: not known, never "you".
    expect(pausedByOf("c1", null)).toBe("unknown");
    expect(pausedByOf("c1", { pausedByStop: [{ campaignId: "c1" }], banners: [{ kind: "limit_reached" }] })).toBe("limit");
    expect(pausedByOf("c1", { pausedByStop: [{ campaignId: "c1" }], banners: [] })).toBe("stop");
    expect(pausedByOf("c2", { pausedByStop: [{ campaignId: "c1" }], banners: [] })).toBe("you");
    expect(headroomFrom({ currency: "INR", today: { left: { minor: "115000" } }, month: { left: null } })).toEqual({ currency: "INR", today: { left: 115_000n }, month: { left: null } });
    expect(headroomFrom(null)).toBeNull();
  });
});

// =====================================================================================================================
// Why a paused campaign is paused (3.9: by you, by today's limit, or by a safety stop and which one)
// =====================================================================================================================

describe("pauseCauseOf: the paused line names who or what paused it", () => {
  const c = { id: "c1", metaCampaignId: "m1", adSetIds: ["s1", "ms1"] };
  const stopped = { pausedByStop: [{ campaignId: "c1" }] };
  const breaker = (over: Record<string, unknown>) => ({ kind: "pacing", label: "Safety stop: spending too fast", reason: "Spend went over the pace.", scopeType: "campaign", scopeId: "c1", state: "tripped", effect: "pause_scope", ...over });
  const free = { stoppedBy: null, canResume: true, resumeNote: null, raisesBlocked: null };

  it("not listed under pausedByStop: Paused by you", () => {
    expect(pauseCauseOf(c, { pausedByStop: [] })).toEqual({ pausedBy: "you", safetyReason: null, ...free });
    expect(pauseCauseOf(c, { pausedByStop: [{ campaignId: "other", canResume: false }], breakers: [breaker({})] })).toEqual({ pausedBy: "you", safetyReason: null, ...free });
  });

  it("while the summary loads or fails, nothing is guessed and [Resume] waits (2.3.13 fails closed)", () => {
    expect(pauseCauseOf(c, null)).toEqual({ pausedBy: "unknown", safetyReason: null, stoppedBy: null, canResume: false, resumeNote: EDITS_TEXT.resumeChecking, raisesBlocked: null });
    expect(pauseCauseOf(c, undefined, { failed: true })).toMatchObject({ pausedBy: "unknown", canResume: false, resumeNote: EDITS_TEXT.resumeCheckFailed });
    expect(EDITS_TEXT.resumeChecking).toBe("Checking who can resume this…");
    // The page's [Resume] is disabled with that reason, and the line says only "Paused".
    const paused = { status: "paused", metaCampaignId: "m1", surface: "promote", adSets: [{ metaAdSetId: "s1", dailyBudgetMinor: 30_000 }] };
    const cause = pauseCauseOf(c, null);
    expect(availableEdits(paused, { canResume: cause.canResume, resumeNote: cause.resumeNote }).find((b) => b.kind === "resume")).toMatchObject({ disabled: true, reason: EDITS_TEXT.resumeChecking });
    expect(statusTimeline({ status: "paused", now: NOW, pausedBy: cause.pausedBy }).outcome?.line).toBe("Paused");
    // The page passes the summary's error and the cause's reasons, and reloads the summary after a change.
    const src = readFileSync(path.resolve(__dirname, "../src/components/ads/CampaignDetail.tsx"), "utf8");
    for (const part of ["{ failed: !!spend.error }", "resumeNote={cause.resumeNote}", "raisesBlocked={cause.raisesBlocked}", "stoppedBy: cause.stoppedBy", "spend.reload()"]) expect(src).toContain(part);
    // Every change reloads the summary: the edits, [Pause and free] and the compare card all go through refresh().
    expect(src).toMatch(/function refresh\(\) \{\s*reload\(\);\s*review\.reload\(\);\s*spend\.reload\(\);\s*\}/);
    expect(src.match(/refresh\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain("onChanged={refresh}");
  });

  it("while all spending is stopped: 'Paused: all spending is stopped', and [Resume] and every raise are disabled with the stop note", () => {
    const frozen = { pausedByStop: [], freeze: { effective: "all", platform: "none", byName: "Priya" }, stopNote: "Only the owner can turn spending back on." };
    const cause = pauseCauseOf(c, frozen);
    const note = "All spending is stopped. Only the owner can turn spending back on.";
    expect(cause).toEqual({ pausedBy: "stopped", safetyReason: null, stoppedBy: "Priya", canResume: false, resumeNote: note, raisesBlocked: note });
    expect(statusTimeline({ status: "paused", now: NOW, pausedBy: cause.pausedBy, stoppedBy: cause.stoppedBy }).outcome?.line).toBe("Paused: all spending is stopped (stopped by Priya)");
    const paused = { status: "paused", metaCampaignId: "m1", surface: "promote", adSets: [{ metaAdSetId: "s1", dailyBudgetMinor: 30_000 }] };
    const b = availableEdits(paused, { canResume: cause.canResume, resumeNote: cause.resumeNote, raisesBlocked: cause.raisesBlocked });
    for (const x of b) {
      expect(x.disabled, x.kind).toBe(["resume", "run_longer", "spend_more"].includes(x.kind));
      if (x.disabled) expect(x.reason).toBe(note);
    }
    // The owner (no stop note) is told where to turn it back on; Edwyz's own stop says so instead.
    expect(pauseCauseOf(c, { ...frozen, stopNote: null }).resumeNote).toBe(`${EDITS_TEXT.frozen} ${EDITS_TEXT.frozenOwner}`);
    expect(pauseCauseOf(c, { ...frozen, freeze: { effective: "all", platform: "all", byName: "Edwyz support" } }).resumeNote).toBe(EDITS_TEXT.frozenPlatform);
    // A campaign the summary would list is "stopped" too (the server leaves pausedByStop empty while frozen).
    expect(pauseCauseOf(c, { ...frozen, pausedByStop: [{ campaignId: "c1", canResume: true }] }).pausedBy).toBe("stopped");
    // The rendered edits say why under the buttons.
    const out = html(
      createElement(CampaignEdits, {
        campaign: { id: "c1", name: "Diwali", status: "paused", surface: "promote", currency: "INR", metaCampaignId: "m1", totalDailyBudgetMinor: 30_000, adSets: [{ id: "s1", name: "A", metaAdSetId: "x", dailyBudgetMinor: 30_000 }] },
        canResume: cause.canResume,
        resumeNote: cause.resumeNote,
        raisesBlocked: cause.raisesBlocked,
      }),
    );
    expect(out).toContain(note);
    expect(out.match(/<button\b[^>]*data-testid="edit-spend_more"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(out.match(/<button\b[^>]*data-testid="edit-spend_less"[^>]*>/)?.[0]).not.toContain('disabled=""');
  });

  it("after the stop is cleared, or a Meta disconnect paused it: neutral words, no fault blamed", () => {
    const cleared = { pausedByStop: [{ campaignId: "c1", canResume: true }], breakers: [], freeze: { effective: "none", platform: "none", byName: "Priya" }, stopNote: null };
    const cause = pauseCauseOf(c, cleared);
    // The name belonged to the stop that was lifted, which may not be what paused this, so it isn't used.
    expect(cause).toEqual({ pausedBy: "stop", safetyReason: null, ...free });
    const line = statusTimeline({ status: "paused", now: NOW, pausedBy: cause.pausedBy, stoppedBy: cause.stoppedBy }).outcome?.line;
    expect(line).toBe("Paused: spending was stopped");
    expect(line).not.toMatch(/safety|wrong/i);
    // While an assistants stop is on, it names who stopped it; a non-approver still can't resume.
    expect(pauseCauseOf(c, { ...cleared, pausedByStop: [{ campaignId: "c1", canResume: false }], freeze: { effective: "assistants", platform: "none", byName: "Priya" } })).toEqual({
      pausedBy: "stop",
      safetyReason: null,
      stoppedBy: "Priya",
      canResume: false,
      resumeNote: EDITS_TEXT.stopResume,
      raisesBlocked: null,
    });
  });

  it("a safety stop on this campaign or one of its ad sets gives its reason in the label's words", () => {
    expect(pauseCauseOf(c, { ...stopped, breakers: [breaker({})] })).toEqual({ pausedBy: "safety", safetyReason: "spending too fast", ...free });
    expect(pauseCauseOf(c, { ...stopped, breakers: [breaker({ kind: "external_edit", label: "Safety stop: changed in Meta Ads Manager", scopeType: "adset", scopeId: "ms1" })] }).safetyReason).toBe("changed in Meta Ads Manager");
    // Meta keeps its capital; without a label the reason is used, without its full stop.
    expect(pauseCauseOf(c, { ...stopped, breakers: [breaker({ kind: "meta_cap_units", label: "Safety stop: Meta's limit needs a check" })] }).safetyReason).toBe("Meta's limit needs a check");
    expect(pauseCauseOf(c, { ...stopped, breakers: [breaker({ label: undefined })] }).safetyReason).toBe("Spend went over the pace");
    const line = statusTimeline({ status: "paused", now: NOW, pausedBy: "safety", safetyReason: pauseCauseOf(c, { ...stopped, breakers: [breaker({})] }).safetyReason }).outcome?.line;
    expect(line).toBe("Paused by a safety stop: spending too fast");
  });

  it("a stop on another campaign, a cleared one, a WhatsApp one or one that only blocks raises doesn't count", () => {
    for (const other of [breaker({ scopeId: "c9" }), breaker({ state: "cleared" }), breaker({ kind: "wa_quality_red", scopeType: "workspace", scopeId: "t1" }), breaker({ effect: "block_raises" })]) {
      expect(pauseCauseOf(c, { ...stopped, breakers: [other] }), JSON.stringify(other)).toEqual({ pausedBy: "stop", safetyReason: null, ...free });
    }
  });

  it("today's ads limit: 'Paused: your limit for today is used up'", () => {
    expect(pauseCauseOf(c, { ...stopped, breakers: [breaker({ kind: "daily_limit", scopeType: "workspace", scopeId: "t1" })] }).pausedBy).toBe("limit");
    expect(pauseCauseOf(c, { ...stopped, breakers: [], pots: { ads: { status: "limit_reached" } } }).pausedBy).toBe("limit");
    expect(pauseCauseOf(c, { ...stopped, breakers: [], pots: { ads: { status: "limit_reached", month: { left: { minor: "50000" } } } } }).pausedBy).toBe("limit");
  });

  it("this month's ads limit: 'Paused: this month's ads limit is used up', never 'today'", () => {
    // The month's breaker wins over today's and over a safety stop: it lasts longest.
    expect(pauseCauseOf(c, { ...stopped, breakers: [breaker({ kind: "monthly_limit", scopeType: "ad_account", scopeId: "a1" }), breaker({})] }).pausedBy).toBe("limit_month");
    expect(pauseCauseOf(c, { ...stopped, breakers: [breaker({ kind: "daily_limit", scopeType: "workspace" }), breaker({ kind: "monthly_limit", scopeType: "workspace" })] }).pausedBy).toBe("limit_month");
    // The ads pot at its limit with nothing left this month (the summary's own "this month's ads limit" banner rule).
    expect(pauseCauseOf(c, { ...stopped, breakers: [], pots: { ads: { status: "limit_reached", month: { left: { minor: "0" } } } } }).pausedBy).toBe("limit_month");
    // Without pots, the ads banner's own words.
    expect(pauseCauseOf(c, { ...stopped, banners: [{ kind: "limit_reached", text: "Ads are paused: this month's ads limit is used up." }] }).pausedBy).toBe("limit_month");
    const line = statusTimeline({ status: "paused", now: NOW, pausedBy: pausedByOf("c1", { ...stopped, breakers: [breaker({ kind: "monthly_limit", scopeType: "workspace" })] }) }).outcome?.line;
    expect(line).toBe("Paused: this month's ads limit is used up");
  });

  it("the AI or WhatsApp limit shares the banner kind and is not the ads limit", () => {
    const ai = { kind: "limit_reached", text: "AI replies are off: this month's AI limit is used up. Your team can still reply." };
    const ads = { kind: "limit_reached", text: "Ads are paused: today's ads limit is used up." };
    expect(pauseCauseOf(c, { ...stopped, banners: [ai] }).pausedBy).toBe("stop");
    expect(pauseCauseOf(c, { ...stopped, banners: [ads] }).pausedBy).toBe("limit");
    // With the pots in the summary, the ads pot decides, not a banner.
    expect(pauseCauseOf(c, { ...stopped, banners: [ads], pots: { ads: { status: "ok" } } }).pausedBy).toBe("stop");
  });

  it("matches pausedByStop by the Meta campaign id too, and the page passes the cause and the reason to the timeline", () => {
    expect(pauseCauseOf(c, { pausedByStop: [{ campaignId: "m1" }], breakers: [breaker({})] }).pausedBy).toBe("safety");
    const src = readFileSync(path.resolve(__dirname, "../src/components/ads/CampaignDetail.tsx"), "utf8");
    for (const part of ["pauseCauseOf(", "pausedBy: cause.pausedBy", "safetyReason: cause.safetyReason", "canResume={cause.canResume}", "launchedAdSetIds:"]) expect(src).toContain(part);
    expect(src).not.toContain("canFree");
  });

  it("what a stop paused, only the owner or an approver resumes (Phase 0 2.3.13): [Resume] is disabled with the reason", () => {
    expect(pauseCauseOf(c, { pausedByStop: [{ campaignId: "c1", canResume: false }], breakers: [breaker({})] })).toEqual({
      pausedBy: "safety",
      safetyReason: "spending too fast",
      stoppedBy: null,
      canResume: false,
      resumeNote: EDITS_TEXT.stopResume,
      raisesBlocked: null,
    });
    expect(pauseCauseOf(c, { pausedByStop: [{ campaignId: "c1", canResume: true }], pots: { ads: { status: "limit_reached" } } }).canResume).toBe(true);
    const paused = { status: "paused", metaCampaignId: "m1", surface: "promote", adSets: [{ metaAdSetId: "s1", dailyBudgetMinor: 30_000 }] };
    const resume = (opts: Parameters<typeof availableEdits>[1]) => availableEdits(paused, opts).find((b) => b.kind === "resume");
    expect(resume({ canResume: false })).toMatchObject({ disabled: true, reason: EDITS_TEXT.stopResume });
    expect(resume({ canResume: true })).toMatchObject({ disabled: false, reason: null });
    expect(resume({})).toMatchObject({ disabled: false, reason: null });
    // A restricted account says the account's reason first; lowerings stay enabled either way.
    expect(resume({ canResume: false, blocksStart: true })).toMatchObject({ disabled: true, reason: EDITS_TEXT.restricted });
    expect(availableEdits(paused, { canResume: false }).filter((b) => b.kind !== "resume").every((b) => !b.disabled)).toBe(true);
    const out = html(
      createElement(CampaignEdits, {
        campaign: { id: "c1", name: "Diwali", status: "paused", surface: "promote", currency: "INR", metaCampaignId: "m1", totalDailyBudgetMinor: 30_000, adSets: [{ id: "s1", name: "A", metaAdSetId: "x", dailyBudgetMinor: 30_000 }] },
        canResume: false,
      }),
    );
    expect(out).toContain(EDITS_TEXT.stopResume);
    const button = out.match(/<button\b[^>]*data-testid="edit-resume"[^>]*>/)?.[0] ?? "";
    expect(button).toContain('disabled=""');
    const describedBy = button.match(/aria-describedby="([^"]+)"/)?.[1] ?? "";
    expect(describedBy).toMatch(/-reason-0$/);
    expect(out).toContain(`id="${describedBy}"`);
  });
});

// =====================================================================================================================
// The server's answers fit what the components read (checked by tsc; the page never reshapes them)
// =====================================================================================================================

describe("contracts with the server views", () => {
  it("review-status, the compare card, the access answer and the spend summary are read as the server sends them", () => {
    const review: TimelineReview = {} as CampaignReviewView;
    const comparison: ComparisonLite = {} as ComparisonView;
    const access: AccessLite = {} as PromoteAccess;
    const summary: PauseSummaryLite = {} as SpendSummaryView;
    const kinds: readonly AudienceKind[] = AUDIENCE_KINDS_BY_LEVEL.all;
    expect([review, comparison, access, summary, kinds].every((x) => x !== null)).toBe(true);
  });
});

// =====================================================================================================================
// Audiences (3.7)
// =====================================================================================================================

describe("the audience manager", () => {
  it("offers the kinds of each PROMOTE_AUDIENCES level, the same table the server enforces", () => {
    expect(audienceKindsFor("off")).toEqual(["saved"]);
    expect(audienceKindsFor("engagement")).toEqual(["saved", "engagement_instagram", "engagement_page", "engagement_lead_form", "website", "lookalike"]);
    expect(audienceKindsFor("engagement")).not.toContain("customer_list");
    expect(audienceKindsFor("all")).toContain("customer_list");
    expect(audienceKindsFor(null)).toEqual(["saved"]);
    // The server's own list narrows it (production without the legal flag answers engagement kinds only).
    expect(audienceKindsFor("all", ["saved", "website"])).toEqual(["saved", "website"]);
    for (const level of ["off", "engagement", "all"] as const) expect([...AUDIENCE_KINDS_BY_LEVEL[level]].sort()).toEqual([...KINDS_BY_LEVEL[level]].sort());
  });

  it("the customer-list confirm: Share {count} contacts with Meta…, the hashing sentence and the lawful basis", () => {
    const card = customerListConfirm({ included: 1240, total: 1610 });
    expect(card.canShare).toBe(true);
    expect(card.lines[0]).toBe("Share 1,240 contacts with Meta to find them on Facebook and Instagram. Phone numbers and emails are scrambled (hashed) before they leave Edwyz.");
    expect(card.lines).toContain(AUDIENCE_TEXT.lawfulBasis);
    expect(AUDIENCE_TEXT.lawfulBasis).toMatch(/agreed to get marketing messages/);
    expect(card.lines).toContain("1,240 of 1,610 contacts can be included.");
    expect(card.confirmLabel).toBe("Share 1,240 contacts");
    const small = customerListConfirm({ included: 99, total: 400 });
    expect(small).toMatchObject({ canShare: false, confirmLabel: null });
    expect(small.lines).toEqual(["99 of 400 contacts can be included.", "Too small: Meta needs at least 100 people."]);
    expect(customerPreviewPath({ segmentId: "seg1", tag: " vip " })).toBe("/api/promote/audiences?preview=customer_list&segmentId=seg1&tag=vip");
  });

  it("status chips are words with a tone, and the size range or why there is none", () => {
    expect(["getting_ready", "ready", "too_small", "problem"].map((c) => audienceChipView(c as never).label)).toEqual(["Getting ready", "Ready", "Too small", "Problem"]);
    expect(audienceChipView("problem").tone).toBe("bad");
    expect(audienceSizeText({ kind: "website", sizeLine: "About 1.2–1.8 lakh people" })).toBe("About 1.2–1.8 lakh people");
    expect(audienceSizeText({ kind: "website", sizeLine: null })).toBe("Size not available right now");
    expect(audienceSizeText({ kind: "saved" })).toMatch(/Kept in Edwyz/);
  });

  it("builds each kind's body and stops a request that can't succeed", () => {
    const f = emptyAudienceForm();
    expect(audienceBody("saved", f)).toEqual({ ok: true, body: { kind: "saved", targeting: { geo: { countries: ["IN"], cities: [] }, ageMin: 18, ageMax: 65, genders: [], interests: [], placements: [] } } });
    expect(audienceBody("saved", { ...f, ageMin: "40", ageMax: "30" })).toEqual({ ok: false, problem: "The youngest age can't be higher than the oldest." });
    expect(audienceBody("engagement_page", f)).toEqual({ ok: false, problem: "Choose where people engaged." });
    expect(audienceBody("engagement_page", { ...f, sourceId: "pg1" })).toEqual({ ok: true, body: { kind: "engagement_page", retentionDays: 365, sourceId: "pg1" } });
    expect(audienceBody("engagement_lead_form", { ...f, sourceId: "lf1", days: "120" })).toEqual({ ok: false, problem: "Choose between 1 and 90 days." });
    expect(audienceBody("website", { ...f, urlContains: " offer " })).toEqual({ ok: true, body: { kind: "website", retentionDays: 30, urlContains: "offer" } });
    expect(audienceBody("lookalike", f)).toEqual({ ok: false, problem: "Choose the audience to find people like." });
    expect(audienceBody("lookalike", { ...f, seedAudienceId: "a1", percent: "11" })).toEqual({ ok: false, problem: "Pick 1% to 10%." });
    expect(audienceBody("customer_list", { ...f, name: "VIPs", tag: "vip" })).toEqual({ ok: true, body: { kind: "customer_list", name: "VIPs", tag: "vip" } });
  });

  it("renders the create choices of the level, and tells agents to ask an owner or admin", () => {
    const engagement = html(createElement(AudienceManager, { level: "engagement", canWrite: true }));
    expect(engagement).toContain('data-testid="audience-manager"');
    expect(engagement).toContain("People who engaged on Instagram");
    expect(engagement).not.toContain("Past customers");
    expect(html(createElement(AudienceManager, { level: "all", canWrite: true }))).toContain("Past customers");
    expect(html(createElement(AudienceManager, { level: "off", canWrite: true }))).not.toContain("Website visitors");
    expect(html(createElement(AudienceManager, { level: "all", canWrite: false }))).toContain(AUDIENCE_TEXT.agentsOnly);
  });

  it("deletes through a danger confirm (focus on Cancel first), shows the terms fix as Opens Meta, and refreshes", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/promote/AudienceManager.tsx"), "utf8");
    expect(src).toContain('tone: "danger"');
    expect(src).toContain('screen="custom_audience_tos"');
    expect(src).toContain("/refresh`");
    expect(src).toContain('method: "DELETE"');
    expect(src).toContain("customerListConfirm(share.count)");
  });
});

// =====================================================================================================================
// The audiences page's gate (promoteAccess, PROMOTE_AUDIENCES)
// =====================================================================================================================

describe("/app/ads/audiences", () => {
  it("is hidden unless promoteAccess makes the feature visible, offers the access level's kinds and resolves the terms address on the server", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/app/(app)/app/ads/audiences/page.tsx"), "utf8");
    for (const part of ['promoteEnabled() === "off") notFound()', "if (!access.visible) notFound()", "level={access.audiences}", 'metaScreenHref("custom_audience_tos"']) expect(src).toContain(part);
  });
});

// =====================================================================================================================
// Tokens only (7.6): a grep over this package's files
// =====================================================================================================================

describe("tokens only: no hex, no dark:, no raw z-index, no facebook.com", () => {
  const FILES = [
    "src/components/promote/PromoteTiles.tsx",
    "src/components/promote/StatusTimeline.tsx",
    "src/components/promote/CampaignEdits.tsx",
    "src/components/promote/ResultsByPlacement.tsx",
    "src/components/promote/CompareVersions.tsx",
    "src/components/promote/AudienceManager.tsx",
    "src/components/promote/results-helpers.ts",
    "src/app/(app)/app/ads/audiences/page.tsx",
    "src/app/(app)/app/ads/[id]/page.tsx",
    "src/components/ads/CampaignsView.tsx",
    "src/components/ads/CampaignDetail.tsx",
  ];

  it.each(FILES)("%s", (file) => {
    const src = readFileSync(path.resolve(__dirname, "..", file), "utf8");
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(src).not.toMatch(/\bdark:/);
    expect(src).not.toMatch(/\bz-(\d+|\[)/);
    expect(src).not.toMatch(/zIndex|z-index/);
    expect(src).not.toMatch(/facebook\.com/i);
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });

  it("the grep itself catches what it bans", () => {
    expect("color: #0f172a".match(/#[0-9a-fA-F]{3,8}\b/g)).toEqual(["#0f172a"]);
    expect("dark:bg-black").toMatch(/\bdark:/);
    expect("z-50").toMatch(/\bz-(\d+|\[)/);
    expect("https://www.facebook.com/x").toMatch(/facebook\.com/i);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Boost and New ad flows (docs/IG-PAGE-ADS-SPEC.md 3.1, 3.3 to 3.7, 3.12, 6.2, 7.1 to 7.3, 7.5, 7.6, D2, D4, D5, D15, D23;
 * PRM-14 acceptance 1 to 3): flow-helpers' steps and smart defaults, the post picker's tabs and names, autosave with
 * expectedUpdatedAt and the 409 reload, the amount on the button, the 600 ms guard, the typed figure, the review card's states,
 * the fix chips' exact draft changes, the hidden-settings chip and the More options positions; a static render of the shell,
 * the steps and the card; the grep over this package's files; and the pages' promoteAccess gate with the nav unchanged.
 *
 * The unit project has no DOM, so the stateful paths are pure in flow-helpers (createAutosaver with injected timers, reviewView,
 * fixAction, stepProblem) and the components are rendered to static markup. Nothing reaches Meta or a database.
 */

const jar = vi.hoisted(() => ({ cookies: [] as { name: string; value: string }[] }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => jar.cookies }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  spendControl: { findUnique: vi.fn() },
  phoneNumber: { findFirst: vi.fn() },
  leadForm: { findMany: vi.fn() },
  metaAsset: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
const defaultsMock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/promote/defaults", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/promote/defaults")>()), loadDefaultFacts: defaultsMock.load }));
const settingsMock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/promote/settings", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/promote/settings")>()), getPromoteSettings: settingsMock.get }));
vi.mock("@/lib/promote/service", () => ({ offeredGoals: (a: { goals: string[] }) => a.goals }));

import BoostPage from "@/app/(app)/app/ads/boost/page";
import CreatePage from "@/app/(app)/app/ads/create/page";
import { NAV_ITEMS, navFor } from "@/components/app/nav";
import { AudienceBudgetStep } from "@/components/promote/AudienceBudgetStep";
import type { AdStepValue } from "@/components/promote/creative-helpers";
import { FixChips } from "@/components/promote/FixChips";
import {
  actOutcome,
  adStepFromDraft,
  adStepSet,
  audienceHiddenScope,
  blockingChips,
  BOOST_PATH,
  boostableGoals,
  boostCreateBody,
  boostGoalChips,
  boostPlan,
  boostSwitchBody,
  captionSnippet,
  categoryChoices,
  clampStep,
  COPY_GUARD_KEYS,
  createAutosaver,
  createDraftBody,
  draftMediaIds,
  draftSetOf,
  draftStep,
  EDGE_WARNINGS,
  exitAction,
  fixAction,
  fixDraftChange,
  flowContextOf,
  flowDefaults,
  flowHref,
  flowSteps,
  formKept,
  formsForPage,
  gridMove,
  goalCards,
  goalEdge,
  goalSet,
  guardTap,
  hiddenChip,
  initialCreateGoal,
  isCategoryQuestion,
  linkSet,
  mergeItems,
  morePositions,
  needsTypedConfirm,
  parseDraft,
  parseFlowQuery,
  patchBody,
  placeFromSearch,
  planDays,
  planFactsOf,
  postEdge,
  postSourceOf,
  previewKey,
  previewPositions,
  primaryLabel,
  PROMOTE_TEST_IDS,
  readOnlyContext,
  resetHiddenSet,
  resumeStep,
  reviewState,
  reviewView,
  SAVE_RETRY_MS,
  savedEnough,
  saveStateText,
  START_GUARD_MS,
  startArmed,
  startBody,
  startLabel,
  startReady,
  stepCountLabel,
  stepProblem,
  tileName,
  tileState,
  typedOk,
  visibleTabs,
  welcomeProblems,
  welcomeSet,
  type CostDto,
  type DraftDto,
  type FixDto,
  type FlowContext,
  type FlowFacts,
  type ReadinessRowDto,
  type ReviewCardDto,
  type StartOutcomeDto,
  type Timers,
} from "@/components/promote/flow-helpers";
import { GoalStep } from "@/components/promote/GoalStep";
import { PromoteShell } from "@/components/promote/PromoteShell";
import { ReviewCard } from "@/components/promote/ReviewCard";
import { TypedConfirm } from "@/components/promote/TypedConfirm";
import { jsonRequest } from "@/components/promote/usePromoteDraft";
import { WelcomeMessageEditor } from "@/components/promote/WelcomeMessageEditor";
import { availablePlacements } from "@/lib/promote/catalog";
import { placementRow } from "@/lib/promote/catalog/placements";
import { PROMOTE_COPY, placeholders, promoteText } from "@/lib/promote/copy";
import { fixesFor, fixLabel, INR_STEP_MINOR, presentCost } from "@/lib/promote/cost";
import { runDates } from "@/lib/promote/dates";
import { defaultDraft } from "@/lib/promote/draft-paths";
import type { DefaultFacts } from "@/lib/promote/defaults";
import { PROMOTE_GOAL_KEYS, promoteAccess } from "@/lib/promote/flags";
import type { AdMediaView } from "@/lib/promote/media";
import type { Place } from "@/lib/promote/meta";
import type { BoostableItem, SourcesResult } from "@/lib/promote/sources";
import type { PromotionDraft } from "@/lib/promote/types";

const ROOT = path.resolve(__dirname, "..");
const IST = "Asia/Kolkata";
const ist = (local: string) => new Date(`${local}:00+05:30`);
const RS = (rupees: number) => BigInt(rupees) * 100n;
/** Wednesday 28 Oct 2026, 10:05 in Kolkata: the 6.2 examples start here. */
const NOW = ist("2026-10-28T10:05");
const html = (el: ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const ALL_GOALS = [...PROMOTE_GOAL_KEYS];

const ENV_KEYS = ["PROMOTE_ENABLED", "PLATFORM_ADMIN_EMAILS", "SPEND_ENFORCE", "SPEND_TRIPWIRE", "PROMOTE_EXPERIMENTAL"] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.clearAllMocks();
});

// =====================================================================================================================
// Fixtures
// =====================================================================================================================

const item = (over: Partial<BoostableItem> = {}): BoostableItem => ({
  id: "17890001",
  app: "instagram",
  kind: "reel",
  caption: { $untrusted: "external_text", text: "Diwali offer extravaganza at the shop" } as BoostableItem["caption"],
  thumbnailUrl: "https://cdn.example/thumb.jpg",
  permalink: null,
  createdAt: "2026-10-21T06:00:00.000Z",
  mediaType: "VIDEO",
  promotableId: null,
  eligibility: "ok",
  reasons: [],
  boosted: false,
  madeInEdwyz: false,
  alsoShowOn: { app: "facebook", eligible: true, label: "Also show on Facebook" },
  ...over,
});

const FACTS: DefaultFacts = {
  role: "owner",
  ownerName: "Priya",
  spendingAccount: { assetId: "acc1", externalId: "act_1", currency: "INR", timezone: IST, minDailyMinor: RS(100) },
  pages: [{ assetId: "pg1", externalId: "104", name: "Sunrise Salon", whatsappLinked: true }],
  instagram: [{ assetId: "ig1", externalId: "1784", name: "sunrise.salon", pageId: "104" }],
  lastUsed: { pageExternalId: null, instagramExternalId: null },
  whatsappNumberId: "pn1",
  hasForms: true,
  country: "IN",
  shop: null,
  welcome: {},
  brandCategory: "none",
  headroom: { leftTodayMinor: RS(2_000), leftMonthMinor: RS(20_000) },
  fromInr: null,
  now: NOW,
};

const flowFacts = (over: Partial<FlowFacts> = {}): FlowFacts => ({
  facts: FACTS,
  defaults: {
    adAccount: { assetId: "acc1", externalId: "act_1", currency: "INR", timezone: IST },
    page: FACTS.pages[0],
    instagram: FACTS.instagram[0],
    budget: { dailyMinor: RS(300), stepMinor: INR_STEP_MINOR, known: true },
    chips: [],
  },
  access: { canStart: true, canWrite: true, video: "off", previews: "local", experimental: false },
  offered: ALL_GOALS,
  phone: { displayPhone: "+91 98765 43210", verifiedName: "Sunrise" },
  privacyUrl: "https://sunrise.example/privacy",
  shop: null,
  forms: [{ id: "lf1", name: "Salon form" }],
  workspaceTz: IST,
  now: NOW,
  ...over,
});

const ctxOf = (kind: "boost" | "create", query: Record<string, string> = {}, over: Partial<FlowFacts> = {}): FlowContext => flowContextOf(kind, flowFacts(over), parseFlowQuery(query));

const dto = (updatedAt: string, draft: Record<string, unknown> = { goal: "whatsapp_chats" }): DraftDto => ({
  campaignId: "d1",
  updatedAt,
  status: "draft",
  surface: "promote",
  editable: true,
  discardedAt: null,
  currency: "INR",
  draft,
  caption: null,
});

const big = (v: unknown): unknown => (typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(big) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, big(x)])) : v);

/** The 6.2 example as the review route answers it: ₹300 a day for 5 days from Wed 28 Oct, new-workspace limits. */
function costFor(dailyRupees: number, days: number, left: { today: number; month: number } = { today: 2_000, month: 20_000 }): CostDto {
  const d = runDates({ runDays: days, startMode: "now", tz: IST, now: NOW });
  const c = presentCost({ sets: [{ dailyMinor: RS(dailyRupees) }], startsAt: d.startsAt, endsAt: d.endsAt, tz: IST, now: NOW, kind: "boost", headroom: { currency: "INR", today: { left: RS(left.today) }, month: { left: RS(left.month) } } });
  return { ...(big(c) as Omit<CostDto, "worstThisMonth">), worstThisMonth: "" } as CostDto;
}

const card = (over: Partial<ReviewCardDto> = {}): ReviewCardDto => {
  const cost = over.cost === undefined ? costFor(300, 5) : over.cost;
  return {
    campaignId: "c1",
    updatedAt: "2026-10-28T04:35:00.000Z",
    status: "draft",
    state: "ready",
    canStart: true,
    title: "Boost your reel for 5 days?",
    primary: "",
    secondary: "Save without starting",
    facts: [
      { key: "post", label: "Post", value: "Reel", caption: null },
      { key: "goal", label: "Goal", value: "Chat on WhatsApp" },
      { key: "who", label: "Who", value: "People Meta finds in India, 18+" },
      { key: "where", label: "Where", value: "Instagram and Facebook (automatic)" },
      { key: "when", label: "When", value: "Today → Sun 1 Nov" },
      { key: "budget", label: "Budget", value: "₹300 a day" },
    ],
    text: { versions: [], firstMessage: "Hi! I saw your ad and want to know more", quickQuestions: [{ title: "Price?", response: "Thanks for asking! We'll reply here soon." }], caption: null },
    warnings: [
      { code: "goes_to_meta", text: promoteText("card.goes_to_meta") },
      { code: "meta_reviews", text: promoteText("card.meta_reviews") },
    ],
    cost,
    fixes: [],
    readiness: null,
    issues: [],
    previews: { draftId: "c1", placements: [], kind: "local" },
    typedConfirmRequired: cost?.typedConfirmRequired ?? false,
    dailyTotalMinor: "30000",
    worstCaseMinor: cost?.atMostMinor ?? "0",
    materialHash: "m1",
    stateText: null,
    ...over,
  };
};

const media = (id: string, kind: "image" | "video" = "image"): AdMediaView =>
  ({ id, kind, source: "content", sourceKey: `${id}.jpg`, width: 1080, height: 1350, ratio: "4:5", status: "ready", problems: [], chips: [] }) as unknown as AdMediaView;

const fakeTimers = () => {
  const q: { fn: () => void; ms: number; live: boolean }[] = [];
  const timers: Timers = {
    set: (fn, ms) => {
      q.push({ fn, ms, live: true });
      return q.length - 1;
    },
    clear: (h) => {
      if (typeof h === "number" && q[h]) q[h].live = false;
    },
  };
  const runNext = () => {
    const t = q.find((x) => x.live);
    if (t) {
      t.live = false;
      t.fn();
    }
    return t?.ms ?? null;
  };
  return { timers, q, runNext };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// =====================================================================================================================
// 1. Steps and smart defaults (3.1, 3.3, 3.4, 7.5)
// =====================================================================================================================

describe("a boost from post to review is 4 screens with the 3.1 defaults pre-filled", () => {
  const facts = { offered: ALL_GOALS, whatsappLinked: true, hasForms: false, currency: "INR", tz: IST, leftTodayMinor: RS(2_000), leftMonthMinor: RS(20_000), minDailyMinor: null };

  it("post, what people do, who and how much, review; WhatsApp chats when the number is linked (and Meta allows its button), ₹300, 7 days", () => {
    const plan = boostPlan(facts, { source: "ig_media", hasLink: false }, NOW, { ctaOnBoost: true });
    expect(plan).toEqual({ steps: ["post", "goal", "audience", "review"], goal: "whatsapp_chats", dailyMinor: RS(300), runDays: 7, stepMinor: INR_STEP_MINOR });
    expect(stepCountLabel(1, plan.steps.length)).toBe("Step 2 of 4");
  });

  it("until Meta's button on a post is proven (V-P3), the default falls to a goal the post can take", () => {
    const plan = boostPlan(facts, { source: "ig_media", hasLink: true }, NOW);
    expect(plan.steps).toHaveLength(4);
    expect(plan.goal).toBe("engagement");
    expect(boostPlan({ ...facts, whatsappLinked: false }, { source: "ig_media", hasLink: true }, NOW, { ctaOnBoost: true }).goal).toBe("website_visits");
  });

  it("₹300 or the most that fits today and this month (maxFittingDaily), rounded to ₹10, never below Meta's minimum", () => {
    expect(boostPlan({ ...facts, leftTodayMinor: RS(500), leftMonthMinor: RS(18_000) }, { source: "ig_media", hasLink: false }, NOW).dailyMinor).toBe(RS(280));
    expect(boostPlan({ ...facts, leftTodayMinor: RS(500), minDailyMinor: RS(300) }, { source: "ig_media", hasLink: false }, NOW).dailyMinor).toBe(RS(300));
  });

  it("days: asked, else 7; at least 2 (D31), at most 90 (D6)", () => {
    expect(boostPlan(facts, { source: "ig_media", hasLink: false, days: 5 }, NOW).runDays).toBe(5);
    expect([planDays(null), planDays(1), planDays(5), planDays(400)]).toEqual([7, 2, 5, 90]);
  });

  it("a new ad is goal, ad, who and how much, review; a lead form ad adds its form after the goal", () => {
    expect(flowSteps("create", "whatsapp_chats")).toEqual(["goal", "ad", "audience", "review"]);
    expect(flowSteps("create", "lead_form")).toEqual(["goal", "form", "ad", "audience", "review"]);
    expect(stepCountLabel(0, 5)).toBe("Step 1 of 5");
  });

  it("the create flow opens with the goal in the address, else the smart default among the goal cards", () => {
    expect(initialCreateGoal(ctxOf("create", { goal: "lead_form" }))).toBe("lead_form");
    expect(initialCreateGoal(ctxOf("create"))).toBe("whatsapp_chats");
    expect(initialCreateGoal({ ...ctxOf("create"), whatsappLinked: false })).toBe("lead_form");
    expect(initialCreateGoal({ ...ctxOf("create", { goal: "page_likes" }), whatsappLinked: false, hasForms: false })).toBe("engagement");
  });

  it("a saved draft resumes after its first screen; an address without a draft can't skip ahead", () => {
    const boost = flowSteps("boost", null);
    expect(resumeStep(boost, null, false)).toBe("post");
    expect(resumeStep(boost, null, true)).toBe("goal");
    expect(resumeStep(boost, "audience", true)).toBe("audience");
    expect(clampStep(boost, "review", false)).toBe("post");
    expect(clampStep(flowSteps("create", "lead_form"), "form", false)).toBe("form");
    expect(clampStep(flowSteps("create", "whatsapp_chats"), "ad", false)).toBe("goal");
    // A boost draft opened at /app/ads/create (a fix copy) resumes at its goal.
    expect(clampStep(boost, "ad", true)).toBe("goal");
  });

  it("reads the query safely and writes the address that resumes the draft (D28)", () => {
    expect(parseFlowQuery({ source: "instagram", id: "17890001", goal: "whatsapp_chats", days: "5", step: "goal" })).toEqual({ draft: null, step: "goal", goal: "whatsapp_chats", source: "instagram", id: "17890001", days: 5 });
    expect(parseFlowQuery({ goal: "objective_x", days: "0", id: "../x", draft: "a b" })).toEqual({ draft: null, step: null, goal: null, source: null, id: null, days: null });
    expect(flowHref("boost", { draft: "d1", step: "review", goal: "engagement" })).toBe("/app/ads/boost?draft=d1&step=review");
    expect(flowHref("create", { goal: "lead_form", days: 5 })).toBe("/app/ads/create?goal=lead_form&days=5");
  });
});

// =====================================================================================================================
// 2. Post picker (3.3 step 1, 7.3)
// =====================================================================================================================

describe("the post picker", () => {
  const result = (pageBacked: boolean): Pick<SourcesResult, "tabs" | "identity"> => ({
    tabs: ["reels", "posts", "stories", "facebook"],
    identity: { page: { assetId: "pg1", name: "Sunrise Salon" }, instagram: { assetId: "ig1", username: "sunrise.salon", pageBacked } },
  });

  it("hides the Instagram tabs for a Page-backed identity (it can't boost Instagram posts, 8.3a)", () => {
    expect(visibleTabs(result(true))).toEqual(["facebook"]);
    expect(visibleTabs(result(false))).toEqual(["reels", "posts", "stories", "facebook"]);
    expect(visibleTabs({ tabs: ["reels", "facebook"], identity: { page: null, instagram: null } })).toEqual(["facebook"]);
  });

  it("names each tile: 'Reel from 21 Oct: 'Diwali offer…', can be boosted'", () => {
    expect(tileName(item(), IST)).toBe("Reel from 21 Oct: 'Diwali offer…', can be boosted");
    expect(tileName(item({ kind: "post", caption: null }), IST)).toBe("Post from 21 Oct, can be boosted");
    const music = item({ eligibility: "no", reasons: [{ code: "licensed_music", text: promoteText("boost.reason.licensed_music") }] });
    expect(tileName(music, IST)).toBe("Reel from 21 Oct: 'Diwali offer…', can't be boosted: it uses licensed music");
    expect(tileState(item({ eligibility: "unknown" })).tone).toBe("unknown");
    expect(captionSnippet("Short one")).toBe("Short one");
  });

  it("moves through the grid with a roving tabindex: arrows by one or a row, Home and End", () => {
    expect(gridMove(0, "ArrowRight", 10, 3)).toBe(1);
    expect(gridMove(1, "ArrowDown", 10, 3)).toBe(4);
    expect(gridMove(8, "ArrowDown", 10, 3)).toBe(8);
    expect(gridMove(4, "ArrowUp", 10, 3)).toBe(1);
    expect(gridMove(5, "Home", 10, 5)).toBe(0);
    expect(gridMove(0, "End", 10, 5)).toBe(9);
    expect(gridMove(0, "a", 10, 5)).toBeNull();
  });

  it("adds the next 25 without repeating a post, and makes the draft from the post (a Facebook post by its promotable id)", () => {
    expect(mergeItems([item()], [item(), item({ id: "2" })]).map((i) => i.id)).toEqual(["17890001", "2"]);
    expect(postSourceOf(item({ app: "facebook", id: "104_9", promotableId: "104_99", caption: { $untrusted: "external_text", text: "Sale https://shop.example/x" } as BoostableItem["caption"] }))).toMatchObject({ kind: "fb_post", ref: "104_99", hasLink: true });
    const body = boostCreateBody(item(), { goal: "engagement", runDays: 7 }, { page: { assetId: "pg1", name: null }, instagram: { assetId: "ig1", username: null, pageBacked: false } }, true);
    expect(body).toMatchObject({ goal: "engagement", days: 7, source: { kind: "ig_media", ref: "17890001", postKind: "reel" }, pageAssetId: "pg1", igAssetId: "ig1", set: { alsoOtherApp: true } });
    expect(boostCreateBody(item(), { goal: "engagement", runDays: 7 }, { page: null, instagram: { assetId: "ig2", username: null, pageBacked: true } }, false).igAssetId).toBeNull();
  });

  it("explains a post Meta won't boost, with the way out (3.3 edge case)", () => {
    const music = item({ eligibility: "no", reasons: [{ code: "licensed_music", text: "it uses licensed music" }] });
    const edge = postEdge(music, "whatsapp_chats")!;
    expect(edge.code).toBe("cant_boost");
    expect(edge.text).toBe("Meta says this can't be boosted: it uses licensed music");
    expect(edge.extra).toBe(promoteText("boost.music_may_refuse"));
    // The new ad doesn't carry the post's media yet, so the label promises a new ad, not "with this video".
    expect(edge.action).toEqual({ label: "Make a new ad instead", href: "/app/ads/create?goal=whatsapp_chats&source=new" });
    expect(postEdge(item(), null)).toBeNull();
    expect(stepProblem({ step: "post", pick: music })).toBe(edge.text);
    expect(stepProblem({ step: "post", pick: null })).toBe(promoteText("flow.pick_post"));
  });
});

// =====================================================================================================================
// 3. Goals (3.3 step 2, 3.4 step 1, 3.6, D15)
// =====================================================================================================================

describe("goals", () => {
  it("cards by tier: the simple tiles, then More goals with the D15 notes; All-settings goals stay in the old wizard", () => {
    const cards = goalCards(ALL_GOALS);
    expect(cards.simple.map((c) => c.key)).toEqual(["whatsapp_chats", "lead_form", "website_visits"]);
    expect(cards.more.map((c) => c.key)).not.toContain("page_likes");
    expect(cards.more.find((c) => c.key === "instagram_dms")?.note).toBe("Replies happen in the Instagram app for now.");
    expect(cards.more.find((c) => c.key === "messenger_chats")?.note).toBe("Replies happen in Messenger for now.");
  });

  it("a goal whose button Meta doesn't allow on a post keeps its chip, with the new-ad way out (3.3 edge case)", () => {
    const chips = boostGoalChips(ALL_GOALS, "ig_media");
    const wa = chips.find((c) => c.key === "whatsapp_chats")!;
    expect(wa.usable).toBe(false);
    expect(wa.edge?.text).toBe("Meta doesn't allow a WhatsApp button on this kind of post. Make a new ad for this goal instead, and add your photo or video there.");
    expect(wa.edge?.action).toEqual({ label: "Make a new ad for this goal", href: "/app/ads/create?goal=whatsapp_chats&source=new" });
    expect(chips.find((c) => c.key === "engagement")?.usable).toBe(true);
    expect(goalEdge("website_visits").text).toBe("Meta doesn't allow a 'Visit your website' button on this kind of post. Make a new ad for this goal instead, and add your photo or video there.");
    // No promise of carrying "the same video" (a photo post has none, and the new ad starts without the post's media).
    for (const key of ["boost.no_whatsapp_button", "flow.no_button", "boost.make_new", "fix.make_new_ad"] as const) {
      for (const lang of ["en", "hinglish"] as const) expect(PROMOTE_COPY[lang][key].toLowerCase(), `${lang} ${key}`).not.toMatch(/same video|this video|isi video|is video|usi video/);
    }
    expect(boostGoalChips(ALL_GOALS, "ig_media", "en", { ctaOnBoost: true }).find((c) => c.key === "whatsapp_chats")?.usable).toBe(true);
    expect(stepProblem({ step: "goal", goal: "whatsapp_chats", goalUsable: false })).toBe(wa.edge?.text);
  });

  it("a boost goal the post's app can't take stops on the goal step, in words that say so (not at the review)", () => {
    const fb = boostGoalChips(ALL_GOALS, "fb_post").map((c) => c.key);
    expect(fb).not.toContain("profile_visits");
    expect(fb).not.toContain("instagram_dms");
    expect(stepProblem({ step: "goal", goal: "instagram_dms", goalChoices: fb, goalUsable: false })).toBe("This goal doesn't work for this post. Choose another goal.");
    expect(stepProblem({ step: "goal", goal: "profile_visits", goalChoices: fb })).toBe(promoteText("flow.goal_not_for_post"));
    expect(stepProblem({ step: "goal", goal: "engagement", goalChoices: fb, goalUsable: true })).toBeNull();
    // A new ad has no chips: any offered goal goes on.
    expect(stepProblem({ step: "goal", goal: "profile_visits" })).toBeNull();
  });

  it("picking a Facebook post after an Instagram one re-plans the goal and keeps everything else (budget, days, who)", () => {
    const d0 = defaultDraft("instagram_dms");
    const draft: PromotionDraft = {
      ...d0,
      name: "Boost: reel",
      source: { kind: "ig_media", ref: "17890001" },
      format: "existing_post",
      welcome: { message: "Hi there", iceBreakers: [] },
      budget: { dailyMinor: RS(280), lifetimeMinor: null },
      run: { ...d0.run, runDays: 5 },
      audience: { ...d0.audience, mode: "i_choose", ageMin: 25 },
      placements: { ...d0.placements, mode: "instagram" },
    };
    const facts = planFactsOf(ctxOf("boost"));
    const fbPost = item({ app: "facebook", id: "104_9", promotableId: "104_99", kind: "post", mediaType: "IMAGE" });
    const body = boostSwitchBody(fbPost, draft, { page: { assetId: "pg1", name: null }, instagram: null }, true, facts, NOW);
    expect(body).toMatchObject({ days: 5, source: { kind: "fb_post", ref: "104_99" }, pageAssetId: "pg1", igAssetId: null });
    // Instagram DMs can't run a Facebook post: the 3.1 goal for this post, which the post can take.
    expect(body.goal).not.toBe("instagram_dms");
    expect(boostableGoals(ALL_GOALS, "fb_post")).toContain(body.goal);
    expect(body.goal).toBe(boostPlan(facts, { source: "fb_post", hasLink: false, days: 5 }, NOW).goal);
    const set = body.set as Record<string, unknown>;
    expect(set).toMatchObject({ goal: body.goal, "budget.dailyMinor": "28000", "run.runDays": 5, "audience.mode": "i_choose", "audience.ageMin": 25, alsoOtherApp: true });
    // The old goal's chat and the Instagram-only places stay behind; the post sets its own name and format.
    for (const p of ["welcome.message", "welcome.iceBreakers", "placements.mode", "placements.positions", "name", "format", "source.kind", "source.ref", "specialAdCategory"]) expect(set, p).not.toHaveProperty(p);
  });

  it("another post the goal still fits keeps the goal and its settings; the places stay only on the same app", () => {
    const d0 = defaultDraft("engagement");
    const draft: PromotionDraft = { ...d0, source: { kind: "ig_media", ref: "17890001" }, format: "existing_post", urlTags: "utm_source=ig", placements: { ...d0.placements, mode: "instagram" } };
    const facts = planFactsOf(ctxOf("boost"));
    const sameApp = boostSwitchBody(item({ id: "17890002", kind: "post" }), draft, null, false, facts, NOW);
    expect(sameApp.goal).toBe("engagement");
    expect(sameApp.set).toMatchObject({ goal: "engagement", urlTags: "utm_source=ig", "placements.mode": "instagram", alsoOtherApp: false });
    const otherApp = boostSwitchBody(item({ app: "facebook", id: "104_7", kind: "post" }), draft, null, true, facts, NOW);
    expect(otherApp.goal).toBe("engagement");
    expect(otherApp.set).toMatchObject({ goal: "engagement", urlTags: "utm_source=ig" });
    expect(otherApp.set).not.toHaveProperty("placements.mode");
  });

  it("asks for an https link for website goals and a valid first message for chat goals", () => {
    expect(stepProblem({ step: "goal", goal: "website_visits", link: "shop.example" })).toBe(promoteText("flow.fix_fields"));
    expect(stepProblem({ step: "goal", goal: "website_visits", link: "https://shop.example/offer" })).toBeNull();
    const bad = { message: "", iceBreakers: [{ title: "", response: "x" }] };
    expect(welcomeProblems(bad)).toMatchObject({ ok: false, message: "Write the first message people send you.", questions: [{ title: "Write the question, or remove it.", response: null }] });
    expect(stepProblem({ step: "goal", goal: "whatsapp_chats", welcome: bad })).toBe(promoteText("flow.fix_fields"));
    expect(stepProblem({ step: "goal", goal: "whatsapp_chats", welcome: { message: "Hi!", iceBreakers: [] } })).toBeNull();
  });

  it("saves only valid parts while typing: a link once it is https, each quick question once it has a reply", () => {
    expect(linkSet("https://shop.example/x")).toEqual({ "text.link": "https://shop.example/x" });
    expect(linkSet("https://sh")).toEqual({});
    expect(linkSet("  ")).toEqual({ "text.link": null });
    expect(welcomeSet({ message: "Hi!", iceBreakers: [{ title: " Price? ", response: " ₹500 " }] })).toEqual({ "welcome.message": "Hi!", "welcome.iceBreakers": [{ title: "Price?", response: "₹500" }] });
    expect(welcomeSet({ message: "Hi!", iceBreakers: [{ title: "Price?", response: "" }] })).toEqual({ "welcome.message": "Hi!" });
    expect(goalSet("whatsapp_chats", { welcome: { message: "", iceBreakers: [] } })).toEqual({ goal: "whatsapp_chats", "welcome.message": "Hi! I saw your ad and want to know more" });
    expect(goalSet("website_visits", { welcome: { message: "", iceBreakers: [] } })).toEqual({ goal: "website_visits" });
  });
});

// =====================================================================================================================
// 4. Autosave (7.2): expectedUpdatedAt, 409, slow networks, the special-category answer
// =====================================================================================================================

describe("autosave", () => {
  it("sends expectedUpdatedAt with the changed paths, then the new version on the next save", async () => {
    const sent: Record<string, unknown>[] = [];
    let version = 1;
    const saver = createAutosaver({
      updatedAt: "v1",
      send: async (body) => {
        sent.push(body);
        version++;
        return { status: 200, body: dto(`v${version}`) };
      },
    });
    saver.stage({ "budget.dailyMinor": RS(280) });
    expect(saver.state()).toBe("unsaved");
    expect(await saver.flush()).toBe("saved");
    saver.stage({ "run.runDays": 5 });
    await saver.flush();
    expect(sent).toEqual([
      { expectedUpdatedAt: "v1", set: { "budget.dailyMinor": "28000" }, lang: "en" },
      { expectedUpdatedAt: "v2", set: { "run.runDays": 5 }, lang: "en" },
    ]);
    expect(saver.version()).toBe("v3");
    expect(patchBody("v1", {}, "en", { categoryAnswer: "none" })).toEqual({ expectedUpdatedAt: "v1", set: {}, lang: "en", categoryAnswer: "none" });
  });

  it("a 409 shows the latest draft with 'Someone else changed this draft. Showing the latest.'", async () => {
    const onConflict = vi.fn();
    const states: string[] = [];
    const saver = createAutosaver({ updatedAt: "v1", send: async () => ({ status: 409, body: { code: "stale", latest: dto("v9") } }), onConflict, onState: (s) => states.push(s) });
    saver.stage({ "run.runDays": 5 });
    expect(await saver.flush()).toBe("conflict");
    expect(onConflict).toHaveBeenCalledWith(expect.objectContaining({ updatedAt: "v9" }), "Someone else changed this draft. Showing the latest.");
    expect(saver.version()).toBe("v9");
    expect(saver.pending()).toEqual({});
    // The latest version on screen is the saved one: the footer says "Saved" (with the conflict sentence beside it).
    expect(states.slice(-2)).toEqual(["conflict", "saved"]);
    expect(saver.state()).toBe("saved");
  });

  it("after a 409 the next Continue moves on without another edit, and the next save sends the latest version", async () => {
    const sent: Record<string, unknown>[] = [];
    const saver = createAutosaver({
      updatedAt: "v1",
      send: async (body) => {
        sent.push(body);
        return sent.length === 1 ? { status: 409, body: { code: "stale", latest: dto("v9") } } : { status: 200, body: dto("v10") };
      },
    });
    saver.stage({ "run.runDays": 5 });
    // The Continue that met the 409 stays, so the member sees the latest draft first.
    const first = await saver.flush();
    expect(savedEnough(first, false, null)).toBe(false);
    // The next Continue: nothing is staged, the draft is saved, so it moves on (and sends nothing).
    const second = await saver.flush();
    expect(second).toBe("saved");
    expect(savedEnough(second, false, null)).toBe(true);
    expect(sent).toHaveLength(1);
    saver.stage({ "run.runDays": 6 });
    expect(await saver.flush()).toBe("saved");
    expect(sent[1]).toMatchObject({ expectedUpdatedAt: "v9", set: { "run.runDays": 6 } });
  });

  it("a 409 without the latest draft stays 'conflict' (no Continue) until the draft is loaded again", async () => {
    const onConflict = vi.fn();
    const saver = createAutosaver({ updatedAt: "v1", send: async () => ({ status: 409, body: { code: "stale" } }), onConflict });
    saver.stage({ "run.runDays": 5 });
    expect(await saver.flush()).toBe("conflict");
    expect(onConflict).toHaveBeenCalledWith(null, "Someone else changed this draft. Showing the latest.");
    expect(saver.state()).toBe("conflict");
    expect(await saver.flush()).toBe("conflict");
    expect(saver.version()).toBe("v1");
    // usePromoteDraft loads the draft then (a new saver on its version), and [Save now] shows for "conflict" to load it again.
    const hook = readFileSync(path.join(ROOT, "src/components/promote/usePromoteDraft.ts"), "utf8");
    expect(hook).toMatch(/else void reloadRef\.current\(text\)/);
    expect(readFileSync(path.join(ROOT, "src/components/promote/PromoteShell.tsx"), "utf8")).toContain('api.state === "conflict") && !saveQuestion');
  });

  it("a slow or failed network keeps 'Not saved yet' and tries again", async () => {
    const { timers, runNext } = fakeTimers();
    let calls = 0;
    const saver = createAutosaver({
      updatedAt: "v1",
      timers,
      send: async () => {
        calls++;
        if (calls === 1) throw new Error("offline");
        if (calls === 2) return { status: 503, body: null };
        return { status: 200, body: dto("v2") };
      },
    });
    saver.stage({ "run.runDays": 5 });
    expect(await saver.flush()).toBe("unsaved");
    expect(saveStateText(saver.state())).toBe("Not saved yet");
    expect(saver.pending()).toEqual({ "run.runDays": 5 });
    expect(runNext()).toBe(SAVE_RETRY_MS[0]);
    await tick();
    expect(saver.state()).toBe("unsaved");
    expect(runNext()).toBe(SAVE_RETRY_MS[1]);
    await tick();
    expect(saver.state()).toBe("saved");
    expect(saveStateText("saved")).toBe("Saved");
    expect(calls).toBe(3);
  });

  it("the special-category question keeps the change aside, and the answer sends it again", async () => {
    const sent: Record<string, unknown>[] = [];
    const onError = vi.fn();
    const saver = createAutosaver({
      updatedAt: "v1",
      onError,
      send: async (body) => {
        sent.push(body);
        return body.categoryAnswer ? { status: 200, body: dto("v2") } : { status: 400, body: { code: "category_question", error: promoteText("category.question"), categories: ["credit"] } };
      },
    });
    saver.stage({ "text.primary": "Easy loans in 10 minutes" });
    expect(await saver.flush()).toBe("error");
    expect(isCategoryQuestion(onError.mock.calls[0][1])).toBe(true);
    expect(saver.refused()).toEqual({ "text.primary": "Easy loans in 10 minutes" });
    expect(savedEnough("error", true, onError.mock.calls[0][1])).toBe(false);
    expect(await saver.resend({ categoryAnswer: "credit" })).toBe("saved");
    expect(sent[1]).toEqual({ expectedUpdatedAt: "v1", set: { "text.primary": "Easy loans in 10 minutes" }, lang: "en", categoryAnswer: "credit" });
    expect(categoryChoices(["credit"]).map((c) => c.label)).toEqual(["No, it's about something else", "Yes: loans or credit"]);
  });

  it("Continue moves on after a save, or after a refusal that was already shown and put back; never past the question", () => {
    expect(savedEnough("saved", false, null)).toBe(true);
    expect(savedEnough("error", true, { code: "goal_not_offered" })).toBe(false);
    expect(savedEnough("error", false, { code: "goal_not_offered" })).toBe(true);
    expect(savedEnough("error", false, { code: "category_question" })).toBe(false);
    expect(savedEnough("unsaved", false, null)).toBe(false);
  });

  it("Save and exit (and Back on the first screen) leaves only once the draft is saved; otherwise it asks first", () => {
    expect(exitAction(false, false)).toBe("leave");
    expect(exitAction(true, savedEnough("saved", false, null))).toBe("leave");
    expect(exitAction(true, savedEnough("unsaved", false, null))).toBe("ask");
    expect(exitAction(true, savedEnough("error", true, { code: "goal_not_offered" }))).toBe("ask");
    expect(exitAction(true, savedEnough("error", false, { code: "category_question" }))).toBe("ask");
    expect(exitAction(true, savedEnough("conflict", false, null))).toBe("ask");
    expect([promoteText("flow.leave_question"), promoteText("flow.leave_unsaved"), promoteText("flow.stay")]).toEqual(["Leave without saving?", "Leave without saving", "Stay"]);
    // Both ways out go through the save first; nothing pushes to Ads before it.
    const src = codeOnly(readFileSync(path.join(ROOT, "src/components/promote/PromoteShell.tsx"), "utf8"));
    expect(src).toContain("onClick={() => void leaveFlow()}");
    expect(src).toMatch(/if \(index === 0\) \{\s*void leaveFlow\(\);/);
    expect(src.match(/router\.push\(ADS_PATH\)/g)).toHaveLength(1);
  });

  it("reads a draft back with bigints and every default (parseDraft)", () => {
    const d = parseDraft({ goal: "lead_form", budget: { dailyMinor: "28000" }, run: { runDays: 5 } });
    expect(d.budget.dailyMinor).toBe(RS(280));
    expect(d.run).toMatchObject({ runDays: 5, startMode: "now" });
    expect(d.audience.mode).toBe("meta_finds");
  });
});

// =====================================================================================================================
// 5. The review card: the amount on the button, the guard, the typed figure, Start's gate and every state (D4, D5, 6.5, 7.3)
// =====================================================================================================================

describe("the primary carries the worst case (D5)", () => {
  it("'Start boost · up to ₹2,625' for the 6.2 example (₹300 x 5 days from Wed 28 Oct)", () => {
    const cost = costFor(300, 5);
    expect(cost.atMostMinor).toBe("262500");
    const c = card({ cost, worstCaseMinor: cost.atMostMinor });
    expect(primaryLabel(c)).toBe("Start boost · up to ₹2,625");
    expect(startLabel({ kind: "ads", worstMinor: RS(3_675), currency: "INR" })).toBe("Start ads · up to ₹3,675");
    expect(startLabel({ kind: "lead", worstMinor: RS(3_675), currency: "INR" })).toBe("Create form and start ads · up to ₹3,675");
    expect(primaryLabel(card({ primary: "Start boost · up to ₹2,625" }))).toBe("Start boost · up to ₹2,625");
    expect(startBody(c, null)).toEqual({ confirmedTotalMinor: "30000", confirmedWorstCaseMinor: "262500", materialHash: "m1", lang: "en" });
  });

  it("is aria-disabled for 600 ms after the card appears; a tap inside says to check the card once", () => {
    expect(START_GUARD_MS).toBe(600);
    expect(startArmed(1_000, 1_599)).toBe(false);
    expect(startArmed(1_000, 1_600)).toBe(true);
    expect(guardTap(false, false)).toEqual({ run: false, announce: true });
    expect(guardTap(false, true)).toEqual({ run: false, announce: false });
    expect(guardTap(true, true)).toEqual({ run: true, announce: false });
  });
});

describe("TypedConfirm appears only when typedConfirmRequired", () => {
  const view = (c: ReviewCardDto) => reviewView({ card: c, outcome: null, canStart: true, isOwner: true });

  it("50% or more of what is left this month asks for the figure; Start waits until it matches", () => {
    const big = card({ cost: costFor(300, 5, { today: 2_000, month: 4_000 }) });
    expect(big.typedConfirmRequired).toBe(true);
    expect(needsTypedConfirm(big)).toBe(true);
    expect(startReady(view(big), big, "")).toBe(false);
    expect(startReady(view(big), big, "₹2,625")).toBe(true);
    expect([typedOk("2625", RS(2_625), "INR"), typedOk("2,625.00", RS(2_625), "INR"), typedOk("2,600", RS(2_625), "INR")]).toEqual([true, true, false]);
    const markup = html(createElement(ReviewCard, { card: big, view: view(big), typed: "", onTypedChange: () => {}, onFix: () => {}, onCheckAgain: () => {}, isOwner: true, owner: null, tz: IST }));
    expect(markup).toContain(`data-testid="${PROMOTE_TEST_IDS.typedConfirm}"`);
    expect(markup).toContain("Type ₹2,625 to confirm.");
  });

  it("a small run shows no typed figure and Start is ready", () => {
    const small = card();
    expect(small.typedConfirmRequired).toBe(false);
    expect(startReady(view(small), small, "")).toBe(true);
    const markup = html(createElement(ReviewCard, { card: small, view: view(small), typed: "", onTypedChange: () => {}, onFix: () => {}, onCheckAgain: () => {}, isOwner: true, owner: null, tz: IST }));
    expect(markup).not.toContain(PROMOTE_TEST_IDS.typedConfirm);
    expect(html(createElement(TypedConfirm, { worstMinor: RS(2_625), currency: "INR", value: "", onChange: () => {} }))).toContain("Type ₹2,625 to confirm.");
  });
});

describe("Start is hidden while canStart is false (train P3); Save without starting stays", () => {
  it("canStart false: no Start, Save without starting; agents (canWrite false) get neither", () => {
    const v = reviewView({ card: card(), outcome: null, canStart: false, isOwner: true });
    expect(v.start.visible).toBe(false);
    expect(v.save.visible).toBe(true);
    expect(reviewView({ card: card(), outcome: null, canStart: true, isOwner: true }).start).toEqual({ visible: true, enabled: true });
    expect(reviewView({ card: card(), outcome: null, canStart: true, canWrite: false, isOwner: false })).toMatchObject({ start: { visible: false }, save: { visible: false } });
    expect(startReady(v, card(), "")).toBe(false);
  });
});

describe("each review card state maps to its words and buttons", () => {
  const refused = (code: string, fixes: FixDto[] = []): StartOutcomeDto => ({ state: "refused", code, message: `refused ${code}`, fixes, paused: true, formCreated: false });
  const cases: { name: string; card?: Partial<ReviewCardDto>; outcome?: StartOutcomeDto; state: string; text: string | null; start: boolean; save: boolean; links: string[] }[] = [
    { name: "ready", state: "ready", text: null, start: true, save: true, links: [] },
    { name: "running", card: { state: "running" }, state: "running", text: "Running", start: false, save: false, links: ["campaign"] },
    { name: "done", outcome: { state: "started", campaignId: "c1", message: "Sent to Meta. Meta is reviewing it.", formCreated: false }, state: "done", text: "Sent to Meta. Meta is reviewing it.", start: false, save: false, links: ["pause", "campaign"] },
    { name: "failed with fixes", outcome: refused("spend.daily_limit", [{ kind: "lower_daily", label: "Lower to ₹280 a day", toMinor: "28000" }]), state: "failed", text: "refused spend.daily_limit", start: true, save: true, links: [] },
    { name: "failed without fixes", outcome: { state: "failed", message: "Meta didn't take it. Your ads are saved, paused.", paused: true, formCreated: false }, state: "failed", text: "Meta didn't take it. Your ads are saved, paused.", start: true, save: true, links: ["check_again"] },
    { name: "changed", outcome: { state: "changed", message: "", changed: ["dailyBudgetMinor"], card: card() }, state: "changed", text: promoteText("card.changed"), start: true, save: true, links: [] },
    { name: "needs_approver", outcome: { state: "needs_approver", message: "Only Priya or an approver can start ads. Ask them, or save it without starting." }, state: "needs_approver", text: "Only Priya or an approver can start ads. Ask them, or save it without starting.", start: false, save: true, links: [] },
    { name: "spend_frozen", outcome: refused("spend.frozen"), state: "spend_frozen", text: "refused spend.frozen", start: false, save: true, links: [] },
    { name: "spend_not_set_up", card: { state: "spend_not_set_up", stateText: "Set a daily ads limit first." }, state: "spend_not_set_up", text: "Set a daily ads limit first.", start: false, save: true, links: ["spending"] },
    { name: "demo", card: { state: "demo" }, state: "demo", text: "This is a demo workspace, so nothing is sent to Meta.", start: false, save: false, links: [] },
    { name: "unknown", outcome: { state: "unknown", message: "", formCreated: false }, state: "unknown", text: promoteText("card.unknown"), start: false, save: false, links: ["campaign"] },
    { name: "waiting for client", card: { state: "awaiting_approval" }, state: "awaiting_approval", text: "Waiting for your client's OK", start: false, save: true, links: ["send_for_approval"] },
    { name: "limits busy (3.3)", outcome: refused("spend.busy"), state: "busy", text: "refused spend.busy", start: true, save: true, links: [] },
  ];

  it.each(cases)("$name", (c) => {
    const v = reviewView({ card: card(c.card), outcome: c.outcome ?? null, canStart: true, isOwner: true });
    expect(v.state).toBe(c.state);
    expect(v.text).toBe(c.text);
    expect(v.start.visible).toBe(c.start);
    expect(v.save.visible).toBe(c.save);
    expect(v.links).toEqual(c.links);
  });

  it("an admin is told to ask the owner where an owner gets Spending limits", () => {
    expect(reviewView({ card: card({ state: "spend_not_set_up" }), outcome: null, canStart: true, isOwner: false }).links).toEqual(["ask_owner"]);
  });

  it("limits busy offers [Try again], which only runs the review again", () => {
    const v = reviewView({ card: card(), outcome: refused("spend.busy"), canStart: true, isOwner: true });
    expect(v.fixes).toEqual([{ kind: "retry", label: "Try again" }]);
    expect(fixAction(v.fixes[0], { isOwner: true, owner: null })).toEqual({ kind: "retry" });
    expect(reviewState(null, refused("spend.platform_frozen"))).toBe("spend_frozen");
    expect(reviewState(null, refused("spend.no_limit"))).toBe("spend_not_set_up");
  });

  it("renders the anatomy: verb title, facts verbatim, cost lines, warnings with icon and text, and the edge cases", () => {
    const c = card({
      warnings: [
        { code: "meta_limit_close", text: promoteText("cost.meta_limit_close") },
        { code: "time_zone", text: "Times are in America/New_York, your ad account's time zone." },
        { code: "goes_to_meta", text: promoteText("card.goes_to_meta") },
      ],
    });
    const markup = html(createElement(ReviewCard, { card: c, view: reviewView({ card: c, outcome: null, canStart: true, isOwner: true }), typed: "", onTypedChange: () => {}, onFix: () => {}, onCheckAgain: () => {}, isOwner: true, owner: null, tz: IST }));
    expect(markup).toContain("Boost your reel for 5 days?");
    expect(markup).toContain("People Meta finds in India, 18+");
    expect(markup).toContain("About ₹1,500 in total. At most ₹2,625, because Meta can spend up to 75% more on a busy day.");
    expect(markup).toContain("Up to ₹2,100 in October and ₹525 in November.");
    expect(markup).toContain(`data-testid="${PROMOTE_TEST_IDS.worstCase}"`);
    expect(markup).toContain(`data-testid="${PROMOTE_TEST_IDS.worstCaseMonths}"`);
    expect(markup).toContain('data-edge="meta_limit_close"');
    expect(markup).toContain('data-edge="zone"');
    expect(markup.match(/<svg/g)?.length).toBeGreaterThanOrEqual(3);
    expect(markup).toContain("Hi! I saw your ad and want to know more");
    expect(EDGE_WARNINGS).toEqual({ meta_limit_close: "meta_limit_close", time_zone: "zone" });
  });

  it("a Start whose answer never came back (network, 5xx, timeout) is 'not sure': no second Start, a link to the ad's status", () => {
    for (const status of [0, 408, 500, 502, 504]) {
      const out = actOutcome("start", { status, body: status ? { error: "Internal error" } : null });
      expect(out, String(status)).toEqual({ state: "unknown", message: "", formCreated: false });
      const v = reviewView({ card: card(), outcome: out, canStart: true, isOwner: true });
      expect(v).toMatchObject({ state: "unknown", text: promoteText("card.unknown"), start: { visible: false, enabled: false }, save: { visible: false }, links: ["campaign"] });
    }
    // An outcome body is used as it came, whatever the status.
    const started: StartOutcomeDto = { state: "started", campaignId: "c1", message: "Sent to Meta.", formCreated: false };
    expect(actOutcome("start", { status: 502, body: started })).toEqual(started);
    // A clear refusal stays a failure with its sentence (Start can be tried again); 403 says Start isn't open here.
    expect(actOutcome("start", { status: 429, body: { error: "Too many starts. Wait a minute." } })).toEqual({ state: "failed", message: "Too many starts. Wait a minute.", paused: false, formCreated: false });
    expect(actOutcome("start", { status: 403, body: { error: "Start isn't open yet." } })).toEqual({ state: "start_closed", message: "Start isn't open yet." });
    // Save without starting spends nothing: a lost answer is a plain failure to try again.
    expect(actOutcome("save", { status: 0, body: null })).toEqual({ state: "failed", message: promoteText("flow.create_failed"), paused: false, formCreated: false });
  });

  it("the card's setup rows keep their fixes: Run on Facebook only, and Run Instagram ads using your Page with the ad's Page", () => {
    const rows: ReadinessRowDto[] = [
      {
        check: "instagram_identity",
        status: "missing",
        label: promoteText("readiness.instagram_identity"),
        detail: null,
        warningOnly: false,
        blocks: true,
        fix: { kind: "in_app", key: "create_instagram_identity", label: promoteText("ig.fix.page_backed") },
        more: [{ kind: "in_app", key: "facebook_only", label: promoteText("fix.facebook_only") }],
      },
    ];
    const c = card({ readiness: { ready: false, rows } });
    const props = { card: c, view: reviewView({ card: c, outcome: null, canStart: true, isOwner: true }), typed: "", onTypedChange: () => {}, onFix: () => {}, onCheckAgain: () => {}, isOwner: true, owner: null, tz: IST };
    const before = html(createElement(ReviewCard, props));
    expect(before).not.toContain(">Run on Facebook only<");
    expect(before).toMatch(/<button[^>]*disabled=""[^>]*>Run Instagram ads using your Page</);
    const after = html(createElement(ReviewCard, { ...props, pageAssetId: "pg1", onFacebookOnly: () => {} }));
    expect(after).toContain(">Run on Facebook only<");
    expect(after).toMatch(/<button[^>]*>Run Instagram ads using your Page</);
    expect(after).not.toMatch(/<button[^>]*disabled=""[^>]*>Run Instagram ads using your Page</);
    // The shell passes both to the card.
    const shell = codeOnly(readFileSync(path.join(ROOT, "src/components/promote/PromoteShell.tsx"), "utf8"));
    expect(shell).toContain("pageAssetId={pageAssetId}");
    expect(shell).toMatch(/onFacebookOnly=\{\(\) => void review\.applyFix\(\{ kind: "set", set: \{ "placements\.mode": "facebook", "placements\.positions": \[\] \} \}\)\}/);
  });
});

// =====================================================================================================================
// 6. Fix chips (3.3, 6.2): each applies its exact draft change, then the review runs again
// =====================================================================================================================

describe("fix chips", () => {
  const base = { dailyMinor: RS(300), runDays: 5, startMode: "now" as const, tz: IST, now: NOW, leftTodayMinor: RS(500), leftMonthMinor: RS(18_000), currency: "INR", stepMinor: INR_STEP_MINOR };
  const dtoOf = (f: ReturnType<typeof fixesFor>[number]): FixDto => ({ ...(big(f) as FixDto), label: fixLabel(f, { currency: "INR", tz: IST, owner: "Priya" }) });

  it("lower_daily sets the daily amount (the 6.2 refusal: ₹280)", () => {
    const fixes = fixesFor("spend.daily_limit", base).map(dtoOf);
    expect(fixes[0]).toEqual({ kind: "lower_daily", toMinor: "28000", label: "Lower to ₹280 a day" });
    expect(fixDraftChange(fixes[0])).toEqual({ "budget.dailyMinor": RS(280) });
    expect(fixAction(fixes[0], { isOwner: false, owner: "Priya" })).toEqual({ kind: "set", set: { "budget.dailyMinor": RS(280) } });
  });

  it("fewer_days sets runDays, never below 2 (D31)", () => {
    const fixes = fixesFor("spend.monthly_limit", { ...base, runDays: 7, leftTodayMinor: RS(2_000), leftMonthMinor: RS(1_600) }).map(dtoOf);
    const fewer = fixes.find((f) => f.kind === "fewer_days")!;
    expect(fewer.label).toBe("Run 3 days instead");
    expect(fixDraftChange(fewer)).toEqual({ "run.runDays": 3 });
    expect(fixDraftChange({ kind: "fewer_days", days: 1 })).toEqual({ "run.runDays": 2 });
    expect(fixDraftChange({ kind: "raise_to_min", toMinor: "50000" })).toEqual({ "budget.dailyMinor": RS(500) });
    expect(fixDraftChange({ kind: "ask_owner" })).toBeNull();
  });

  it("ask_owner opens Spending limits for the owner and says who to ask for an admin; retry_at waits", () => {
    expect(fixAction({ kind: "ask_owner", label: "Spending limits" }, { isOwner: true, owner: "Priya" })).toEqual({ kind: "link", href: "/app/settings/spending" });
    expect(fixAction({ kind: "ask_owner", label: "Ask Priya to raise the limit" }, { isOwner: false, owner: "Priya" })).toEqual({ kind: "note", text: "Ask Priya to raise the limit in Settings > Spending limits." });
    expect(fixAction({ kind: "ask_owner", label: "x" }, { isOwner: false, owner: null })).toEqual({ kind: "note", text: "Ask the owner to raise the limit in Settings > Spending limits." });
    const at = new Date(NOW.getTime() + 20 * 60_000);
    expect(fixAction({ kind: "retry_at", label: "Try again at 10:25 am", at: at.toISOString() }, { isOwner: true, owner: null })).toEqual({ kind: "wait", until: at });
  });

  it("renders each chip with its test id and kind", () => {
    const fixes = fixesFor("spend.daily_limit", base).map(dtoOf);
    const markup = html(createElement(FixChips, { fixes, onApply: () => {}, isOwner: false, owner: "Priya", tz: IST }));
    expect(markup).toContain(`data-testid="${PROMOTE_TEST_IDS.fixChips}"`);
    expect(markup.match(new RegExp(`data-testid="${PROMOTE_TEST_IDS.fixChip}"`, "g"))?.length).toBe(2);
    expect(markup).toContain('data-fix-kind="lower_daily"');
    expect(markup).toContain("Lower to ₹280 a day");
    expect(markup).toContain("Ask Priya to raise the limit");
  });
});

// =====================================================================================================================
// 7. More options (3.12, 7.5): the hidden-settings chip and only valid positions
// =====================================================================================================================

describe("hidden non-default settings produce the chip count", () => {
  const defaults = flowDefaults("whatsapp_chats", "IN");
  const base = (): PromotionDraft => flowDefaults("whatsapp_chats", "IN");

  it("counts what the closed More options and the unpicked 'People I choose' hide, and nothing other steps show", () => {
    const d: PromotionDraft = { ...base(), urlTags: "utm_source=instagram", run: { runDays: 7, startMode: "at", startsAt: "2026-10-30T04:30:00.000Z" }, welcome: { message: "Hi", iceBreakers: [{ title: "Price?", response: "₹500" }] } };
    const scope = audienceHiddenScope(d, false);
    const chip = hiddenChip(d, "simple", defaults, "en", scope)!;
    expect(chip.count).toBe(3);
    expect(chip.label).toBe("3 extra settings changed");
    expect(chip.text).toBe("3 extra settings changed · Reset");
    expect(chip.paths.sort()).toEqual(["run.startMode", "run.startsAt", "urlTags"]);
    expect(hiddenChip(d, "simple", defaults, "en", audienceHiddenScope(d, true))).toBeNull();
    expect(resetHiddenSet(d, "simple", defaults, scope)).toEqual({ "run.startMode": "now", "run.startsAt": null, urlTags: null });
  });

  it("an age chosen under 'People I choose' still counts once another card is picked (it still applies)", () => {
    const d: PromotionDraft = { ...base(), audience: { ...base().audience, ageMin: 25, mode: "meta_finds" } };
    expect(hiddenChip(d, "simple", defaults, "en", audienceHiddenScope(d, true))?.count).toBe(1);
    expect(hiddenChip({ ...d, audience: { ...d.audience, mode: "i_choose" } }, "simple", defaults, "en", audienceHiddenScope({ audience: { ...d.audience, mode: "i_choose" } }, true))).toBeNull();
  });

  it("renders the chip with [Reset] beside More options (aria-expanded)", () => {
    const d: PromotionDraft = { ...base(), urlTags: "utm_source=instagram", enhancementsOptIn: true };
    const ctx = ctxOf("create");
    const markup = html(createElement(AudienceBudgetStep, { draft: d, onChange: () => {}, ctx, kind: "ads", format: "single_image" }));
    expect(markup).toContain(`data-testid="${PROMOTE_TEST_IDS.hiddenChip}"`);
    expect(markup).toContain("2 extra settings changed");
    expect(markup).toContain(">Reset<");
    expect(markup).toMatch(/aria-expanded="false"[^>]*>[\s\S]*?More options/);
    expect(markup).toContain("Where it shows: Automatic (recommended)");
    expect(markup).toContain(`data-testid="${PROMOTE_TEST_IDS.audienceCards}"`);
    expect(markup).toContain("Let Meta find people (recommended)");
    expect(markup).toContain("Meta treats age and gender as suggestions and may show your ad to others who are likely to respond.");
  });
});

describe("the More-options positions list only valid placements", () => {
  const keys = (groups: ReturnType<typeof morePositions>) => groups.flatMap((g) => g.positions.map((p) => p.key));
  // Every placement row is still at verify state `docs`: they show only for an experimental sandbox account (D22).
  const sandbox = { experimental: true };

  it("Instagram DMs: Instagram positions only, each one the catalog allows, grouped by app", () => {
    const groups = morePositions("instagram_dms", "single_image", { hasInstagramIdentity: true, ...sandbox });
    expect(groups.map((g) => g.platform)).toEqual(["instagram"]);
    expect(groups[0].label).toBe("Instagram");
    const valid = availablePlacements("instagram_dms", "single_image", { hasInstagramIdentity: true, tier: "more", sandboxAccount: true, experimental: true });
    expect(keys(groups)).toEqual(valid);
    expect(groups[0].positions[0].label).toBe(promoteText(placementRow(groups[0].positions[0].key).nameKey));
  });

  it("no Instagram account: no Instagram positions; Messenger story is never offered (D10)", () => {
    const groups = morePositions("website_visits", "single_image", { hasInstagramIdentity: false, ...sandbox });
    expect(keys(groups).some((k) => placementRow(k).platform === "instagram")).toBe(false);
    expect(groups.map((g) => g.platform)).not.toContain("instagram");
    const all = keys(morePositions("website_visits", "single_image", { hasInstagramIdentity: true, ...sandbox }));
    expect(all).not.toContain("messenger_inbox");
    // Explore home (v26's valid Explore position) is offered with an Instagram account; the old "explore" has no key at all.
    expect(all).toContain("instagram_explore_home");
    expect(all).toEqual(availablePlacements("website_visits", "single_image", { hasInstagramIdentity: true, tier: "more", sandboxAccount: true, experimental: true }));
  });

  it("fewer, more serious lead forms show only in the two feeds (validation enforces it)", () => {
    expect(keys(morePositions("lead_form", "single_image", { hasInstagramIdentity: true, formType: "higher_intent", ...sandbox })).sort()).toEqual(["facebook_feed", "instagram_feed"]);
  });

  it("rows that only the documentation backs stay hidden outside an experimental sandbox (D22)", () => {
    expect(morePositions("website_visits", "single_image", { hasInstagramIdentity: true, experimental: false })).toEqual([]);
  });

  it("the preview tabs follow the chosen places", () => {
    expect(previewPositions({ placements: { mode: "auto", positions: [], devicePlatforms: [], softOptOut: false } })).toEqual([]);
    expect(previewPositions({ placements: { mode: "instagram", positions: [], devicePlatforms: [], softOptOut: false } })).toEqual(["instagram_feed", "instagram_stories", "instagram_reels"]);
    expect(previewPositions({ placements: { mode: "custom", positions: ["facebook_feed"], devicePlatforms: [], softOptOut: false } })).toEqual(["facebook_feed"]);
    const d = flowDefaults("whatsapp_chats", "IN");
    const moreMoney: PromotionDraft = { ...d, budget: { dailyMinor: RS(500), lifetimeMinor: null } };
    const newText: PromotionDraft = { ...d, text: { ...d.text, primary: "New text" } };
    expect(previewKey(d)).toBe(previewKey(moreMoney));
    expect(previewKey(d)).not.toBe(previewKey(newText));
  });
});

// =====================================================================================================================
// 8. The ad step in the draft, the form step, making the draft and an edited copy
// =====================================================================================================================

describe("the ad step and the draft", () => {
  const value = (over: Partial<AdStepValue> = {}): AdStepValue => ({
    source: "image",
    versions: [
      { feed: media("m1"), vertical: media("m2"), text: { primary: "Diwali sale", headline: "20% off", description: "" } },
      { feed: media("m3"), vertical: null, text: { primary: "Diwali sale B", headline: "20% off", description: "" } },
    ],
    cards: [],
    ctaType: null,
    ...over,
  });

  it("maps AdStep's value to draft paths, turning the fair test on with a version (3.8)", () => {
    const set = adStepSet(value(), { link: "https://shop.example/diwali", compareMode: "single" });
    expect(set).toMatchObject({
      format: "single_image",
      "text.primary": "Diwali sale",
      "media.feed": "m1",
      "media.vertical": "m2",
      "media.video": null,
      cards: [],
      "versions.B": { text: { primary: "Diwali sale B", headline: "20% off", description: "", link: "https://shop.example/diwali" }, media: { feed: "m3", vertical: null, square: null, video: null } },
      "versions.C": null,
      "compare.mode": "fair_split",
    });
    const one = adStepSet(value({ versions: [value().versions[0]] }), { link: null, compareMode: "fair_split" });
    expect(one).toMatchObject({ "versions.B": null, "compare.mode": "single" });
  });

  it("a video's file goes in media.video; a carousel sends its cards (half-typed links left out)", () => {
    const video = adStepSet(value({ source: "video", versions: [{ feed: media("v1", "video"), vertical: media("v2", "video"), text: { primary: "x", headline: "" } }] }), { link: null, compareMode: "single" });
    expect(video).toMatchObject({ format: "single_video", "media.feed": null, "media.video": "v1", "media.vertical": "v2" });
    const carousel = adStepSet(
      value({ source: "carousel", cards: [{ id: "a", media: media("c1"), headline: "One", link: "https://shop.example/1" }, { id: "b", media: media("c2"), headline: "Two", link: "shop.exa" }, { id: "c", media: null, headline: "", link: "" }] }),
      { link: null, compareMode: "single" },
    );
    expect(carousel).toMatchObject({
      format: "carousel",
      cards: [
        { mediaId: "c1", headline: "One", description: "", link: "https://shop.example/1" },
        { mediaId: "c2", headline: "Two", description: "", link: null },
      ],
      "versions.B": null,
    });
  });

  it("reads a saved draft back into AdStep's value, with each media id looked up", () => {
    const d = defaultDraft("website_visits");
    const saved: PromotionDraft = { ...d, format: "single_image", text: { ...d.text, primary: "Hello" }, media: { feed: "m1", vertical: null, square: null, video: null }, versions: { B: { text: { primary: "B", headline: "", description: "", link: null }, media: { feed: "m3", vertical: null, square: null, video: null } }, C: null } };
    expect(draftMediaIds(saved)).toEqual(["m1", "m3"]);
    const views = new Map([["m1", media("m1")]]);
    const v = adStepFromDraft(saved, (id) => (id ? (views.get(id) ?? null) : null));
    expect(v.source).toBe("image");
    expect(v.versions.map((x) => x.feed?.id ?? null)).toEqual(["m1", null]);
    expect(v.versions[0].text.primary).toBe("Hello");
    expect(v.cards).toHaveLength(2);
    expect(stepProblem({ step: "ad", ad: v })).toBe(promoteText("flow.need_media"));
    expect(stepProblem({ step: "ad", ad: { ...v, versions: [v.versions[0]] } })).toBeNull();
    expect(stepProblem({ step: "ad", ad: { ...v, source: "carousel" } })).toBe(promoteText("carousel.cards"));
  });

  it("the form step needs a saved form, or a new one without problems; near my shop needs a place", () => {
    expect(stepProblem({ step: "form", form: { choice: "saved", savedId: null, problems: 0 } })).toBe("Choose a saved form, or make a new one.");
    expect(stepProblem({ step: "form", form: { choice: "saved", savedId: "lf1", problems: 0 } })).toBeNull();
    expect(stepProblem({ step: "form", form: { choice: "new", savedId: null, problems: 2 } })).toBe(promoteText("flow.fix_fields"));
    const audience = defaultDraft("engagement").audience;
    expect(stepProblem({ step: "audience", audience: { ...audience, mode: "near_shop", nearShop: null } })).toBe("Pick where your shop is, or choose another audience.");
    expect(stepProblem({ step: "audience", audience })).toBeNull();
  });

  it("'Use a saved form' lists only the chosen Page's forms (Meta refuses a form of another Page)", () => {
    const ctx = ctxOf("create", {}, { forms: [{ id: "lf1", name: "Salon form", pageAssetId: "pg1" }, { id: "lf2", name: "Spa form", pageAssetId: "pg2" }, { id: "lf3", name: null, pageAssetId: null }] });
    expect(ctx.forms).toEqual([
      { id: "lf1", name: "Salon form", pageAssetId: "pg1" },
      { id: "lf2", name: "Spa form", pageAssetId: "pg2" },
      { id: "lf3", name: "lf3", pageAssetId: null },
    ]);
    expect(formsForPage(ctx.forms, "pg1").map((f) => f.id)).toEqual(["lf1"]);
    expect(formsForPage(ctx.forms, "pg2").map((f) => f.id)).toEqual(["lf2"]);
    // No Page chosen yet: no saved form can be offered (the goal step asks for the Page first).
    expect(formsForPage(ctx.forms, null)).toEqual([]);
  });

  it("a lead form draft reloaded on its form step opens there (D28), and keeps its saved form instead of a blank builder", () => {
    expect(draftStep("create", "lead_form", "form")).toBe("form");
    expect(draftStep("create", "lead_form", null)).toBe("form");
    expect(draftStep("create", "whatsapp_chats", "form")).toBe("ad");
    expect(draftStep("boost", "engagement", "review")).toBe("review");
    // Before: the steps came from the default goal (no form step), so step=form became the ad step.
    expect(resumeStep(flowSteps("create", "whatsapp_chats"), "form", true)).toBe("ad");
    expect(formKept({ goal: "lead_form", leadFormId: null, builtHere: false })).toBe(true);
    expect(formKept({ goal: "lead_form", leadFormId: null, builtHere: true })).toBe(false);
    expect(formKept({ goal: "lead_form", leadFormId: "lf1", builtHere: false })).toBe(false);
    expect(formKept({ goal: "whatsapp_chats", leadFormId: null, builtHere: false })).toBe(false);
    expect(promoteText("flow.form.kept")).toBe("Your form is saved with this ad. Continue to keep it, or make a new form to replace it.");
    const shell = codeOnly(readFileSync(path.join(ROOT, "src/components/promote/PromoteShell.tsx"), "utf8"));
    // Continue keeps the saved form; the builder opens only from "Replace it with a new form".
    expect(shell).toContain("if (keptForm) return flushOk();");
    expect(shell).toContain('{t("flow.form.replace")}');
    // While the draft from the address loads, the address keeps its draft and step.
    expect(shell).toContain('(q.draft && !draftId)) return;');
  });

  it("a searched place as Meta answers it (keys and names, no map position) can't be pinned, and the page says what works", () => {
    const zip: Place = { key: "IN:411001", name: "411001", type: "zip", region: "Maharashtra", countryCode: "IN" };
    const city: Place = { key: "1035921", name: "Pune", type: "city", region: "Maharashtra", countryCode: "IN" };
    expect(placeFromSearch(zip)).toBeNull();
    expect(placeFromSearch(city)).toBeNull();
    // An answer that carries a map position is pinned, 5 km around it.
    expect(placeFromSearch({ ...city, latitude: 18.52043, longitude: 73.856743 })).toEqual({ lat: 18.52043, lng: 73.85674, radiusKm: 5, label: "Pune, Maharashtra" });
    // The words point at what works today (the shop location or another audience), never back to the search.
    expect(promoteText("place.no_pin")).toBe("Meta doesn't give a map position for this place yet. Use your shop location, or choose another audience.");
    expect(promoteText("place.denied")).not.toMatch(/search|PIN/i);
    expect(promoteText("place.denied")).toContain("choose another audience");
  });

  it("makes a new ad's draft with its goal, days, Page, link and first message (and a lead form's spec)", () => {
    expect(createDraftBody({ goal: "website_visits", days: 7, pageAssetId: "pg1", igAssetId: "ig1", set: { "text.link": "https://shop.example", "budget.dailyMinor": RS(300), nope: 1 } })).toEqual({
      goal: "website_visits",
      days: 7,
      source: { kind: "new" },
      pageAssetId: "pg1",
      igAssetId: "ig1",
      set: { "text.link": "https://shop.example", "budget.dailyMinor": "30000" },
      lang: "en",
    });
    expect(createDraftBody({ goal: "lead_form", days: 5, pageAssetId: null, form: { name: "F" }, categoryAnswer: "none" })).toMatchObject({ form: { name: "F" }, categoryAnswer: "none" });
  });

  it("an edited copy carries every setting but the post and the category answer", () => {
    const d = { ...defaultDraft("lead_form"), urlTags: "utm=1", specialAdCategory: "credit" as const };
    const set = draftSetOf(d);
    expect(set).toMatchObject({ goal: "lead_form", urlTags: "utm=1", "budget.dailyMinor": RS(300), "versions.B": null });
    expect(set).not.toHaveProperty("source.kind");
    expect(set).not.toHaveProperty("specialAdCategory");
    expect(set).not.toHaveProperty("versions.B.text.primary");
  });
});

// =====================================================================================================================
// 9. The flow's context, the shell and the steps (static render, 7.2, 7.6)
// =====================================================================================================================

describe("the flow context from what the page read", () => {
  it("maps facts to strings and picks the 3.1 defaults", () => {
    const ctx = ctxOf("boost", { source: "instagram", id: "17890001" });
    expect(ctx).toMatchObject({
      kind: "boost",
      lang: "en",
      canStart: true,
      currency: "INR",
      tz: IST,
      stepMinor: "1000",
      minDailyMinor: "10000",
      leftTodayMinor: "200000",
      leftMonthMinor: "2000000",
      whatsappLinked: true,
      isOwner: true,
      ownerName: "Priya",
      hasInstagram: true,
      pageName: "Sunrise Salon",
      businessName: "Sunrise",
      pageAssetId: "pg1",
      igAssetId: "ig1",
      profileName: "sunrise.salon",
      today: "2026-10-28",
      welcomeMessage: "Hi! I saw your ad and want to know more",
      forms: [{ id: "lf1", name: "Salon form" }],
    });
    expect(ctx.query).toMatchObject({ source: "instagram", id: "17890001" });
    expect(readOnlyContext("create", parseFlowQuery({}))).toMatchObject({ canWrite: false, canStart: false, offered: [] });
  });

  it("shows the chips that stop a draft (no spending account, no Page) apart from the others", () => {
    const chips = [
      { key: "ask_owner_spending_account", text: "Ask Priya to choose a spending ad account" },
      { key: "min_days", text: promoteText("fix.min_days_chip") },
    ];
    expect(blockingChips(chips)).toEqual([chips[0]]);
  });
});

describe("the shell (7.2)", () => {
  it("Boost: back, 'Step 1 of 4', Save and exit, the step's h2 and a 48 px sticky primary above the tab bar", () => {
    const markup = html(createElement(PromoteShell, { ctx: ctxOf("boost") }));
    expect(markup).toContain(`data-testid="${PROMOTE_TEST_IDS.shell}"`);
    expect(markup).toContain('data-kind="boost"');
    expect(markup).toContain(">Back<");
    expect(markup).toContain(">Save and exit<");
    expect(markup).toMatch(/aria-live="polite"[^>]*data-testid="promote-step-count"[^>]*>Step 1 of 4</);
    expect(markup).toMatch(/<h2[^>]*tabindex="-1"[^>]*>Pick a post to boost<\/h2>/);
    expect(markup).toContain(`data-testid="${PROMOTE_TEST_IDS.step("post")}"`);
    expect(markup).toMatch(/data-testid="promote-primary"[^>]*>Continue</);
    expect(markup).toContain("min-h-12");
    expect(markup).toContain("z-(--z-sticky)");
    expect(markup).toContain("env(safe-area-inset-bottom)");
    expect(markup).toContain('aria-current="step"');
  });

  it("New ad: the goal cards with the smart default chosen; a lead form ad has 5 screens", () => {
    const markup = html(createElement(PromoteShell, { ctx: ctxOf("create") }));
    expect(markup).toContain("Step 1 of 4");
    expect(markup).toContain("What should people do after seeing it?");
    expect(markup).toMatch(/data-goal="whatsapp_chats"[\s\S]*?checked=""/);
    expect(markup).toContain("Get WhatsApp chats");
    expect(markup).toContain("More goals");
    expect(html(createElement(PromoteShell, { ctx: ctxOf("create", { goal: "lead_form" }) }))).toContain("Step 1 of 5");
  });

  it("an agent is told who can make ads, and nothing else is offered", () => {
    const markup = html(createElement(PromoteShell, { ctx: readOnlyContext("boost", parseFlowQuery({})) }));
    expect(markup).toContain("Only workspace admins and owners can make ads. Ask one of them to do this.");
    expect(markup).not.toContain("Continue");
  });

  it("the steps render their fields: goal chips, the link, the first message with up to 3 quick questions", () => {
    const chips = html(createElement(GoalStep, { variant: "chips", offered: ALL_GOALS, value: "website_visits", onChange: () => {}, source: "ig_media", link: "", onLinkChange: () => {}, welcome: { message: "", iceBreakers: [] }, onWelcomeChange: () => {}, showErrors: true }));
    expect(chips).toContain(`data-testid="${PROMOTE_TEST_IDS.goalChip}"`);
    expect(chips).toContain(`data-testid="${PROMOTE_TEST_IDS.edge}"`);
    const cards = html(createElement(GoalStep, { variant: "cards", offered: ALL_GOALS, value: "website_visits", onChange: () => {}, link: "shop", onLinkChange: () => {}, welcome: { message: "", iceBreakers: [] }, onWelcomeChange: () => {}, showErrors: true }));
    expect(cards).toContain("Your website link");
    expect(cards).toContain("The link must start with https://");
    expect(cards).toContain("All settings (advanced)");
    const full = html(createElement(WelcomeMessageEditor, { value: { message: "Hi", iceBreakers: [{ title: "Price?", response: "₹500" }, { title: "Timings?", response: "10 to 7" }, { title: "Where?", response: "Pune" }] }, onChange: () => {} }));
    expect(full).toContain("First message people send you");
    expect(full).not.toContain("Add your own question");
    expect(html(createElement(WelcomeMessageEditor, { value: { message: "Hi", iceBreakers: [] }, onChange: () => {} }))).toContain("Add your own question");
  });
});

// =====================================================================================================================
// 10. The grep over this package's files (7.6, D23): tokens only, no Meta host, copy only from promote/copy
// =====================================================================================================================

const PACKAGE = [
  "src/app/(app)/app/ads/boost/page.tsx",
  "src/app/(app)/app/ads/create/page.tsx",
  "src/components/promote/PromoteShell.tsx",
  "src/components/promote/PostPicker.tsx",
  "src/components/promote/GoalStep.tsx",
  "src/components/promote/ReadinessList.tsx",
  "src/components/promote/WelcomeMessageEditor.tsx",
  "src/components/promote/AudienceBudgetStep.tsx",
  "src/components/promote/AudienceCards.tsx",
  "src/components/promote/PlacePicker.tsx",
  "src/components/promote/ReviewCard.tsx",
  "src/components/promote/TypedConfirm.tsx",
  "src/components/promote/FixChips.tsx",
  "src/components/promote/usePromoteDraft.ts",
  "src/components/promote/flow-helpers.ts",
];

/** The code without its comments (a comment may quote the copy it documents; only code can show a string). */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

describe("this package's files use tokens only, name no Meta host and type no copy twice", () => {
  it.each(PACKAGE)("%s", (file) => {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(src).not.toMatch(/\bdark:/);
    expect(src).not.toMatch(/\bz-(\d+|\[)/);
    expect(src).not.toMatch(/zIndex|z-index/);
    expect(src).not.toMatch(/facebook\.com/i);
    expect(src).not.toContain("dangerouslySetInnerHTML");
    const code = codeOnly(src);
    for (const key of COPY_GUARD_KEYS) {
      const text = PROMOTE_COPY.en[key];
      for (const literal of [`"${text}"`, `'${text}'`, `\`${text}\``, `>${text}<`]) expect(code.includes(literal), `${file} types "${text}" (${key}): use promoteText`).toBe(false);
    }
  });

  it("the comment stripper keeps code and links", () => {
    expect(codeOnly('const a = "Save and exit"; // "Save and exit"')).toContain('"Save and exit"');
    expect(codeOnly('/** "More goals" */\nconst b = 1;')).not.toContain("More goals");
    expect(codeOnly('const u = "https://x.example"; // note')).toContain("https://x.example");
  });

  it("the guard list holds plain copy keys, and the grep catches what it bans", () => {
    for (const key of COPY_GUARD_KEYS) expect(placeholders(PROMOTE_COPY.en[key]), key).toEqual([]);
    expect(new Set(COPY_GUARD_KEYS).size).toBe(COPY_GUARD_KEYS.length);
    expect("color: #0f172a".match(/#[0-9a-fA-F]{3,8}\b/g)).toEqual(["#0f172a"]);
    expect("z-50 z-[60]").toMatch(/\bz-(\d+|\[)/);
    expect("z-(--z-sticky)").not.toMatch(/\bz-(\d+|\[)/);
    const src = readFileSync(path.join(ROOT, "src/components/promote/PromoteShell.tsx"), "utf8");
    expect(src).toContain('lazy-loaded');
    expect(src).toMatch(/dynamic\(\(\) => import\("\.\/PlacementPreview"\)/);
    expect(src).not.toMatch(/^import[^\n]*\.\/(PlacementPreview|CropTool|LeadFormPreview)"/m);
  });
});

// =====================================================================================================================
// 11. The pages (D2, 7.1): not found while PROMOTE_ENABLED is off; the nav is unchanged
// =====================================================================================================================

describe("/app/ads/boost and /app/ads/create", () => {
  const pages = [
    ["boost", (sp: Record<string, string> = {}) => BoostPage({ searchParams: Promise.resolve(sp) })],
    ["create", (sp: Record<string, string> = {}) => CreatePage({ searchParams: Promise.resolve(sp) })],
  ] as const;

  it.each(pages)("%s is not found while PROMOTE_ENABLED is off, without looking anyone up", async (_name, page) => {
    process.env.PROMOTE_ENABLED = "off";
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(auth.getActor).not.toHaveBeenCalled();
    expect(defaultsMock.load).not.toHaveBeenCalled();
    expect(promoteAccess({ role: "owner", isPlatformAdmin: false, sandboxAccount: false }, { PROMOTE_ENABLED: "off" }).visible).toBe(false);
  });

  it.each(pages)("%s is not found for a customer's member while it is open to Edwyz admins only", async (_name, page) => {
    process.env.PROMOTE_ENABLED = "admins";
    process.env.PLATFORM_ADMIN_EMAILS = "staff@edwyz.com";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    db.user.findUnique.mockResolvedValue({ email: "owner@shop.in", emailVerifiedAt: new Date(), disabledAt: null, totpEnabledAt: null });
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(defaultsMock.load).not.toHaveBeenCalled();
  });

  it.each(pages)("%s is not found without a signed-in member", async (_name, page) => {
    process.env.PROMOTE_ENABLED = "on";
    auth.getActor.mockRejectedValue(new Error("no session"));
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each(pages)("%s gives an agent the read-only shell without reading the defaults", async (name, page) => {
    process.env.PROMOTE_ENABLED = "on";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "agent" });
    const el = (await page()) as ReactElement<{ ctx: FlowContext }>;
    expect(el.type).toBe(PromoteShell);
    expect(el.props.ctx).toMatchObject({ kind: name, canWrite: false, canStart: false });
    expect(defaultsMock.load).not.toHaveBeenCalled();
  });

  it("gives an owner the boost flow with the 3.1 defaults and the post from the address; Start waits for train P3", async () => {
    process.env.PROMOTE_ENABLED = "on";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    defaultsMock.load.mockResolvedValue(FACTS);
    settingsMock.get.mockResolvedValue({ privacyUrl: "https://sunrise.example/privacy", shop: null, welcome: {} });
    db.phoneNumber.findFirst.mockResolvedValue({ displayPhone: "+91 98765 43210", verifiedName: "Sunrise" });
    db.spendControl.findUnique.mockResolvedValue({ timezone: IST });
    const el = (await BoostPage({ searchParams: Promise.resolve({ source: "instagram", id: "17890001" }) })) as ReactElement<{ ctx: FlowContext }>;
    expect(el.type).toBe(PromoteShell);
    expect(el.props.ctx).toMatchObject({ kind: "boost", canWrite: true, canStart: false, pageAssetId: "pg1", igAssetId: "ig1", whatsappLinked: true, privacyUrl: "https://sunrise.example/privacy", query: { source: "instagram", id: "17890001" } });
    expect(db.leadForm.findMany).not.toHaveBeenCalled();
    expect(defaultsMock.load.mock.calls[0][1]).toMatchObject({ allowedGoals: ALL_GOALS });
  });

  it("gives an owner the create flow with the saved forms of each Page, by Page; Start opens with both spend controls enforcing", async () => {
    process.env.PROMOTE_ENABLED = "on";
    process.env.SPEND_ENFORCE = "enforce";
    process.env.SPEND_TRIPWIRE = "enforce";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    defaultsMock.load.mockResolvedValue({ ...FACTS, pages: [...FACTS.pages, { assetId: "pg2", externalId: "105", name: "Sunrise Spa", whatsappLinked: false }] });
    settingsMock.get.mockResolvedValue({ privacyUrl: null, shop: null, welcome: {} });
    db.phoneNumber.findFirst.mockResolvedValue(null);
    db.spendControl.findUnique.mockResolvedValue(null);
    db.leadForm.findMany.mockResolvedValue([
      { id: "lf1", name: "Salon form", pageAssetId: "pg1" },
      { id: "lf2", name: null, pageAssetId: "pg1" },
      { id: "lf3", name: "Spa form", pageAssetId: "pg2" },
    ]);
    const el = (await CreatePage({ searchParams: Promise.resolve({ goal: "lead_form", days: "5" }) })) as ReactElement<{ ctx: FlowContext }>;
    expect(el.props.ctx).toMatchObject({
      kind: "create",
      canStart: true,
      forms: [
        { id: "lf1", name: "Salon form", pageAssetId: "pg1" },
        { id: "lf2", name: "lf2", pageAssetId: "pg1" },
        { id: "lf3", name: "Spa form", pageAssetId: "pg2" },
      ],
      query: { goal: "lead_form", days: 5 },
    });
    const q = db.leadForm.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ tenantId: "t1", pageAssetId: { in: ["pg1", "pg2"] }, hiddenAt: null });
    expect(q.select).toEqual({ id: true, name: true, pageAssetId: true });
    expect(formsForPage(el.props.ctx.forms, "pg2").map((f) => f.name)).toEqual(["Spa form"]);
  });

  it("'Use a post' on the create page hands over to Boost with the goal and days", async () => {
    process.env.PROMOTE_ENABLED = "on";
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    await expect(CreatePage({ searchParams: Promise.resolve({ source: "post", goal: "engagement", days: "5" }) })).rejects.toThrow(`NEXT_REDIRECT ${BOOST_PATH}?goal=engagement&days=5`);
  });

  it("adds no nav item, so the nav counts are unchanged (D2)", () => {
    expect(NAV_ITEMS).toHaveLength(29);
    expect(navFor("owner")).toHaveLength(29);
    expect(NAV_ITEMS.some((i) => i.href.startsWith("/app/ads/boost") || i.href.startsWith("/app/ads/create"))).toBe(false);
  });
});

// =====================================================================================================================
// jsonRequest: every request the flows make stays on this site (spend bypass rule B12)
// =====================================================================================================================

describe("jsonRequest sends only this site's /api/ paths (B12)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends an /api/ path same-origin as JSON and answers the status and body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await jsonRequest("POST", "/api/promote/drafts?lang=en", { goal: "messages" })).toEqual({ status: 201, body: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/promote/drafts?lang=en");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: '{"goal":"messages"}' });
  });

  it("never sends an address outside /api/, and answers it like a failed network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const url of ["https://example.com/api/promote/drafts", "//example.com/api/promote/drafts", "/\\example.com/api/x", "api/promote/drafts", "/apix/promote", "/app/ads/boost", ""]) {
      expect(await jsonRequest("GET", url), url).toEqual({ status: 0, body: null });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failed network or a body that is not JSON never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await jsonRequest("GET", "/api/promote/audiences")).toEqual({ status: 0, body: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    expect(await jsonRequest("DELETE", "/api/promote/drafts/d1")).toEqual({ status: 502, body: null });
  });
});

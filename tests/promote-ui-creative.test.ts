import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The shared ad builder and money controls (docs/IG-PAGE-ADS-SPEC.md 3.4 step 2, 3.7, 4.6, 7.2 to 7.4, 7.6, D18, D21, D31,
 * D34; PRM-15a acceptance 1 and 2): creative-helpers' counters, Instagram's stops, hashtags, graphemes, crop rectangles,
 * safe zones, steppers, the cost line and the limit chip, the preview tabs and cap, and the approximate label; then a
 * static render of each component and the tokens-only grep over the package.
 *
 * The unit project has no DOM (no jsdom or Testing Library), so the stateful paths are tested two ways: the state logic is
 * pure in creative-helpers (adStepView, patchVersion, mergePolledMedia, createRepeater with fake timers, daysLimit), and the
 * components' wiring is checked by recording the props AdStep hands CopyFields and MediaPicker (the real components still
 * render) and calling their onChange as a member's typing or a poll would.
 */
const seen = vi.hoisted(() => ({ copy: [] as Record<string, unknown>[], media: [] as Record<string, unknown>[] }));

vi.mock("@/components/promote/CopyFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/promote/CopyFields")>();
  const CopyFields = (props: Parameters<typeof actual.CopyFields>[0]) => {
    seen.copy.push(props);
    return actual.CopyFields(props);
  };
  return { ...actual, CopyFields, default: CopyFields };
});

vi.mock("@/components/promote/MediaPicker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/promote/MediaPicker")>();
  const MediaPicker = (props: Parameters<typeof actual.MediaPicker>[0]) => {
    seen.media.push(props);
    return actual.MediaPicker(props);
  };
  return { ...actual, MediaPicker, default: MediaPicker };
});

import { AdStep, initialAdStep, type AdStepValue } from "@/components/promote/AdStep";
import { BudgetSteppers } from "@/components/promote/BudgetSteppers";
import { CarouselEditor, emptyCard } from "@/components/promote/CarouselEditor";
import { CopyFields } from "@/components/promote/CopyFields";
import { CostLine } from "@/components/promote/CostLine";
import { CropTool } from "@/components/promote/CropTool";
import {
  adSourceTabs,
  adStepInUse,
  adStepSource,
  adStepView,
  applyCropKey,
  briefLabel,
  canAddCard,
  canAddVersion,
  canRemoveCard,
  cardLinkProblem,
  clampDays,
  computeCost,
  copyCheck,
  copyCounters,
  costLineText,
  createDebouncer,
  createPreviewLedger,
  createRepeater,
  creativeAssetsOf,
  COST_DEBOUNCE_MS,
  CROP_JPEG_QUALITY,
  CROP_MIME,
  CROP_OUTPUT,
  CROP_RATIOS,
  CROP_UPLOAD_PATH,
  cropImageStyle,
  cropPlan,
  cropRect,
  cropUpscaled,
  ctaOptions,
  currencySymbol,
  dailyButton,
  DAYS_MIN,
  daysButton,
  daysInputValue,
  daysLimit,
  daysMax,
  dragCrop,
  feedAspect,
  fillBars,
  graphemes,
  hashtagState,
  hasDevanagari,
  iframeTitle,
  initialCrop,
  libraryFilesOf,
  limitChipText,
  limitChipTone,
  localMock,
  LONG_PRESS_DELAY_MS,
  majorInputValue,
  mediaBlock,
  mediaChips,
  mediaFileUrl,
  mediaPollDelayMs,
  mediaStatusLine,
  mergePolledMedia,
  moveItem,
  needsTallVersion,
  parseMajorInput,
  patchVersion,
  placementLabel,
  policyFixLabel,
  policyWhere,
  prepareBody,
  previewDisplay,
  previewLabel,
  previewTabs,
  repeatDelayMs,
  repeatMultiplier,
  safeZoneFor,
  safeZoneGroupOf,
  shortenForInstagram,
  stepDaily,
  stepDays,
  stepperStep,
  swipeStep,
  tabIndexForKey,
  uploadProblem,
  visibleCaption,
  zoomCrop,
  type CopyValue,
  type CropRatio,
  type PreviewAnswer,
} from "@/components/promote/creative-helpers";
import { LimitChip } from "@/components/promote/LimitChip";
import { MediaPicker, prepareAdMedia, uploadToLibrary } from "@/components/promote/MediaPicker";
import { MetaPreviewFrame } from "@/components/promote/MetaPreviewFrame";
import { PhoneFrame } from "@/components/promote/PhoneFrame";
import { PlacementPreview } from "@/components/promote/PlacementPreview";
import { PolicyExplain } from "@/components/promote/PolicyExplain";
import { SafeZoneLegend, SafeZoneOverlay } from "@/components/promote/SafeZoneOverlay";
import { countGraphemes, countHashtags, FORMAT_SPECS, INSTAGRAM_CAPTION_MAX } from "@/lib/promote/catalog/formats";
import { DEFAULT_PREVIEW_TABS, MAX_META_PREVIEWS_PER_REVIEW } from "@/lib/promote/catalog/preview-formats";
import { presentCost } from "@/lib/promote/cost";
import { runDates } from "@/lib/promote/dates";
import type { AdMediaProblem, AdMediaView } from "@/lib/promote/media";
import { explainReviewFeedback } from "@/lib/promote/review-reasons";
import type { PlacementKey } from "@/lib/promote/types";

const IST = "Asia/Kolkata";
const ist = (local: string) => new Date(`${local}:00+05:30`);
const RS = (rupees: number) => BigInt(rupees) * 100n;
/** Wednesday 28 Oct 2026, 10:05 in Kolkata (the 6.2 examples). */
const NOW = ist("2026-10-28T10:05");
/** New-workspace limits with nothing else running: ₹2,000 a day, ₹20,000 a month. */
const FRESH = { currency: "INR", today: { left: RS(2_000) }, month: { left: RS(20_000) } };
const SIMPLE_PLACES: PlacementKey[] = ["instagram_feed", "facebook_feed", "instagram_stories", "instagram_reels"];
const tags = (n: number) => Array.from({ length: n }, (_, i) => `#t${i + 1}`).join(" ");
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function media(over: Partial<AdMediaView> = {}): AdMediaView {
  return {
    id: "m1",
    adAccountAssetId: "a1",
    source: "content",
    sourceKey: "abc123.jpg",
    kind: "image",
    mime: "image/jpeg",
    bytes: 1000,
    width: 1080,
    height: 1350,
    durationMs: null,
    ratio: "4:5",
    fits: ["feed"],
    chips: [
      { group: "feed", ok: true, text: { en: "Feed 4:5 ✓", hi: "फ़ीड 4:5 ✓", hinglish: "Feed 4:5 ✓" } },
      { group: "stories_reels", ok: false, text: { en: "Stories and Reels 9:16: missing", hi: "x", hinglish: "y" } },
    ],
    problems: [],
    status: "ready",
    ready: true,
    message: "Ready for your ad.",
    error: null,
    attempts: 1,
    canRetry: false,
    retryAt: null,
    metaImageHash: "h",
    metaVideoId: null,
    metaThumbHash: null,
    adOnly: false,
    lastUsedAt: null,
    createdAt: "2026-10-28T00:00:00Z",
    updatedAt: "2026-10-28T00:00:00Z",
    ...over,
  };
}

/** A block about this request: a picture that isn't square on a carousel card. */
const CAROUSEL_BLOCK: AdMediaProblem = {
  code: "ratio_carousel",
  severity: "block",
  text: { en: "This image is 16:9. Carousel cards take 1:1 or 4:5, so crop it to 1:1.", hi: "यह इमेज 16:9 है। कैरोसेल कार्ड 1:1 या 4:5 लेते हैं।", hinglish: "Ye image 16:9 hai. Carousel cards 1:1 ya 4:5 lete hain." },
};
/** A warning only Automatic places get. */
const REEL_WARN: AdMediaProblem = { code: "image_reel", severity: "warn", text: { en: "Meta may not show a still image in Reels. A short video works best.", hi: "x", hinglish: "y" } };

afterEach(() => {
  vi.useRealTimers();
  seen.copy.length = 0;
  seen.media.length = 0;
});

// =====================================================================================================================
// Text (3.4, 4.6)
// =====================================================================================================================

describe("visible-length counters per placement match catalog/formats", () => {
  it("Instagram 125 and 40, Facebook 50 and 27, Stories 125, Reels 44", () => {
    const rows = copyCounters({ primary: "Hello", headline: "Hi" }, SIMPLE_PLACES, { hasInstagramIdentity: true });
    const feed = FORMAT_SPECS.feed.text;
    expect(rows.map((r) => [r.field, r.platform, r.limit])).toEqual([
      ["primary", "instagram", feed.instagramPrimary],
      ["headline", "instagram", feed.instagramHeadline],
      ["primary", "facebook", feed.facebookPrimary],
      ["headline", "facebook", feed.facebookHeadline],
      ["primary", "stories", FORMAT_SPECS.stories.text.primary],
      ["primary", "reels", FORMAT_SPECS.reels.text.primary],
    ]);
    expect(rows.map((r) => r.limit)).toEqual([125, 40, 50, 27, 125, 44]);
    expect(rows[0].text).toBe('Instagram: 5 of 125 show before "… more"');
    expect(rows[3].text).toBe('Facebook: 2 of 27 show before "… more"');
    expect(rows.every((r) => !r.over)).toBe(true);
  });

  it("carousel cards use 80, 20 and 18", () => {
    const rows = copyCounters({ primary: "x", headline: "y", description: "z" }, [], { hasInstagramIdentity: true, format: "carousel" });
    expect(rows.map((r) => [r.field, r.limit])).toEqual([
      ["primary", FORMAT_SPECS.carousel.text.primary],
      ["headline", FORMAT_SPECS.carousel.text.headline],
      ["description", FORMAT_SPECS.carousel.text.description],
    ]);
    expect(rows.map((r) => r.limit)).toEqual([80, 20, 18]);
  });

  it("flags a counter past its visible length (guidance, never a block)", () => {
    const check = copyCheck({ primary: "a".repeat(60), headline: "" }, ["facebook_feed"], { hasInstagramIdentity: true });
    expect(check.counters.find((c) => c.field === "primary")).toMatchObject({ platform: "facebook", count: 60, limit: 50, over: true });
    expect(check.blocked).toBe(false);
  });
});

describe("Instagram's hard stop at 2,200 characters", () => {
  it("2,201 characters with an Instagram placement blocks with the fix copy", () => {
    const check = copyCheck({ primary: "a".repeat(2_201), headline: "" }, ["instagram_feed"], { hasInstagramIdentity: true });
    expect(check.blocked).toBe(true);
    expect(check.problems).toEqual([
      { code: "caption_too_long", text: "Shorten to 2,200 characters for Instagram.", fix: { kind: "shorten_instagram", label: "Shorten to 2,200 characters for Instagram" } },
    ]);
    expect(check.instagramLength).toEqual({ count: 2_201, max: 2_200, over: true });
  });

  it("2,200 is fine; Facebook-only and Automatic without an Instagram account never stop", () => {
    expect(copyCheck({ primary: "a".repeat(2_200), headline: "" }, ["instagram_feed"], { hasInstagramIdentity: true }).blocked).toBe(false);
    expect(copyCheck({ primary: "a".repeat(2_201), headline: "" }, ["facebook_feed"], { hasInstagramIdentity: true }).blocked).toBe(false);
    expect(copyCheck({ primary: "a".repeat(2_201), headline: "" }, [], { hasInstagramIdentity: false }).blocked).toBe(false);
    expect(copyCheck({ primary: "a".repeat(2_201), headline: "" }, [], { hasInstagramIdentity: true }).blocked).toBe(true);
  });

  it("the fix shortens to 2,200 without splitting an emoji or a Devanagari conjunct", () => {
    expect(shortenForInstagram("a".repeat(2_201))).toHaveLength(INSTAGRAM_CAPTION_MAX);
    expect(shortenForInstagram("short")).toBe("short");
    const emoji = shortenForInstagram(`${"a".repeat(2_199)}👍🏽`);
    expect(emoji).toBe("a".repeat(2_199));
    const deva = shortenForInstagram(`${"क".repeat(2_199)}क्ष`);
    expect(deva).toBe("क".repeat(2_199));
    const fixed = copyCheck({ primary: shortenForInstagram("a".repeat(5_000)), headline: "" }, ["instagram_feed"], { hasInstagramIdentity: true });
    expect(fixed.blocked).toBe(false);
  });
});

describe("the 30-hashtag counter", () => {
  it("flags the 31st hashtag", () => {
    const s = hashtagState(tags(31));
    expect(s).toMatchObject({ count: 31, max: 30, over: true, flagged: ["#t31"] });
    expect(s.tags[29]).toMatchObject({ tag: "#t30", over: false });
    expect(s.tags[30]).toMatchObject({ tag: "#t31", over: true });
    expect(hashtagState(tags(30))).toMatchObject({ count: 30, over: false, flagged: [] });
    const check = copyCheck({ primary: tags(31), headline: "" }, ["instagram_feed"], { hasInstagramIdentity: true });
    expect(check.problems.map((p) => [p.code, p.text, p.fix])).toEqual([["too_many_hashtags", "Instagram allows at most 30 hashtags. This has 31.", null]]);
    expect(check.hashtags.flagged).toEqual(["#t31"]);
  });

  it("counts exactly as catalog/formats countHashtags", () => {
    for (const text of ["#दिवाली #sale_2026 # notatag", tags(31), "no tags", "#a#b #c-d"]) expect(hashtagState(text).count).toBe(countHashtags(text));
  });
});

describe("grapheme-aware counting (Devanagari)", () => {
  it("counts Devanagari as people see it, fewer than code points", () => {
    const namaste = countGraphemes("नमस्ते");
    expect([3, 4]).toContain(namaste);
    expect(graphemes("नमस्ते")).toHaveLength(namaste);
    expect(Array.from("नमस्ते")).toHaveLength(6);
    const rows = copyCounters({ primary: "नमस्ते", headline: "दिवाली" }, ["instagram_feed"], { hasInstagramIdentity: true });
    expect(rows.map((r) => r.count)).toEqual([namaste, countGraphemes("दिवाली")]);
    expect(rows[0].text).toBe(`Instagram: ${namaste} of 125 show before "… more"`);
    expect(hasDevanagari("नमस्ते")).toBe(true);
    expect(hasDevanagari("hello")).toBe(false);
  });

  it("cuts a caption at whole graphemes for '… more'", () => {
    const text = "नमस्ते दुनिया";
    const cut = visibleCaption(text, 3);
    expect(cut.truncated).toBe(true);
    expect(text.startsWith(cut.text)).toBe(true);
    expect(countGraphemes(cut.text)).toBe(3);
    if (countGraphemes("नमस्ते") === 3) expect(cut.text).toBe("नमस्ते");
    expect(visibleCaption("short", 125)).toEqual({ text: "short", truncated: false });
  });
});

// =====================================================================================================================
// Crop and safe zones (3.4, 4.6, 7.3)
// =====================================================================================================================

describe("crop rectangles at the exact output sizes", () => {
  const photo = { width: 4_000, height: 3_000 };

  it("exports 1080x1350, 1080x1920 and 1080x1080, from catalog/formats", () => {
    expect(CROP_RATIOS).toEqual(["4:5", "9:16", "1:1"]);
    expect(CROP_OUTPUT).toEqual({ "4:5": { width: 1_080, height: 1_350 }, "9:16": { width: 1_080, height: 1_920 }, "1:1": { width: 1_080, height: 1_080 } });
    expect([CROP_OUTPUT["4:5"].width, CROP_OUTPUT["4:5"].height]).toEqual([...FORMAT_SPECS.feed.recommendedSize]);
    expect([CROP_OUTPUT["9:16"].width, CROP_OUTPUT["9:16"].height]).toEqual([...FORMAT_SPECS.stories.recommendedSize]);
    expect([CROP_OUTPUT["1:1"].width, CROP_OUTPUT["1:1"].height]).toEqual([...FORMAT_SPECS.carousel.recommendedSize]);
    expect(CROP_MIME).toBe("image/jpeg");
    expect(CROP_JPEG_QUALITY).toBe(0.9);
    expect(CROP_UPLOAD_PATH).toBe("/api/content/media?purpose=ad_crop");
  });

  it.each([
    ["4:5", { x: 800, y: 0, width: 2_400, height: 3_000 }],
    ["9:16", { x: 1_156.25, y: 0, width: 1_687.5, height: 3_000 }],
    ["1:1", { x: 500, y: 0, width: 3_000, height: 3_000 }],
  ] as [CropRatio, { x: number; y: number; width: number; height: number }][])("%s starts as the largest centred crop", (ratio, rect) => {
    const plan = cropPlan(photo, initialCrop(photo, ratio));
    expect(plan.source).toEqual(rect);
    expect(plan.output).toEqual(CROP_OUTPUT[ratio]);
    expect(plan.source.width / plan.source.height).toBeCloseTo(plan.output.width / plan.output.height, 9);
    expect(plan).toMatchObject({ mime: "image/jpeg", quality: 0.9 });
  });

  it("crops a tall picture to 4:5 from its middle", () => {
    expect(cropRect({ width: 1_080, height: 1_920 }, initialCrop({ width: 1_080, height: 1_920 }, "4:5"))).toEqual({ x: 0, y: 285, width: 1_080, height: 1_350 });
  });

  it("keyboard: arrows move, + and - zoom, Enter confirms; the crop never leaves the picture", () => {
    const start = initialCrop(photo, "4:5");
    const left = applyCropKey(photo, start, "ArrowLeft");
    expect(left).toMatchObject({ handled: true, confirm: false });
    expect(cropRect(photo, left.state).x).toBeCloseTo(800 + 2_400 * 0.02, 6);
    expect(cropRect(photo, applyCropKey(photo, start, "ArrowRight", true).state).x).toBeCloseTo(800 - 240, 6);
    let s = start;
    for (let i = 0; i < 50; i++) s = applyCropKey(photo, s, "ArrowRight", true).state;
    expect(cropRect(photo, s).x).toBe(0);
    const zoomed = applyCropKey(photo, start, "+").state;
    expect(cropRect(photo, zoomed).width).toBeCloseTo(2_400 / 1.1, 6);
    expect(applyCropKey(photo, start, "=").state.zoom).toBeCloseTo(1.1, 9);
    expect(applyCropKey(photo, start, "-").state.zoom).toBe(1);
    expect(applyCropKey(photo, zoomed, "-").state.zoom).toBeCloseTo(1, 9);
    expect(applyCropKey(photo, start, "Enter")).toEqual({ state: start, confirm: true, handled: true });
    expect(applyCropKey(photo, start, "a")).toEqual({ state: start, confirm: false, handled: false });
    let deep = start;
    for (let i = 0; i < 40; i++) deep = zoomCrop(photo, deep, 1.1);
    expect(deep.zoom).toBe(4);
    const r = cropRect(photo, applyCropKey(photo, deep, "ArrowDown").state);
    expect(r.x >= 0 && r.y >= 0 && r.x + r.width <= photo.width && r.y + r.height <= photo.height).toBe(true);
  });

  it("a drag moves the picture with the finger", () => {
    const moved = dragCrop(photo, initialCrop(photo, "4:5"), 100, 0, 400);
    expect(cropRect(photo, moved).x).toBe(200);
    expect(dragCrop(photo, initialCrop(photo, "4:5"), 100, 0, 0)).toEqual(initialCrop(photo, "4:5"));
  });

  it("places the picture in the viewport and warns when the crop is enlarged", () => {
    expect(cropImageStyle(photo, { x: 800, y: 0, width: 2_400, height: 3_000 })).toEqual({ left: "-33.3333%", top: "0%", width: "166.6667%", height: "100%" });
    expect(cropUpscaled({ width: 800, height: 800 }, initialCrop({ width: 800, height: 800 }, "1:1"))).toBe(true);
    expect(cropUpscaled(photo, initialCrop(photo, "1:1"))).toBe(false);
  });
});

describe("safe zones from catalog/formats", () => {
  it("Reels: top 14%, bottom 35%, sides 6%, with the text equivalent", () => {
    const z = safeZoneFor("reels");
    expect(z).toMatchObject({ topPct: 14, bottomPct: 35, sidesPct: 6, top: FORMAT_SPECS.reels.safeZone?.top, bottom: FORMAT_SPECS.reels.safeZone?.bottom });
    expect(z.lines).toEqual(["Text in the top 14% may be hidden by the profile name", "Text in the bottom 35% may be hidden by the caption and buttons", "Keep text 6% away from each side"]);
  });

  it("Stories: top 14%, bottom 20%, sides 6%", () => {
    const z = safeZoneFor("stories");
    expect([z.topPct, z.bottomPct, z.sidesPct]).toEqual([14, 20, 6]);
    expect(z.lines[1]).toBe("Text in the bottom 20% may be hidden by the reply box");
  });

  it("every line says the catalog's own percentage", () => {
    for (const g of ["reels", "stories"] as const) {
      const z = safeZoneFor(g);
      expect(z.lines[0]).toContain(`${z.topPct}%`);
      expect(z.lines[1]).toContain(`${z.bottomPct}%`);
      expect(z.lines[2]).toContain(`${z.sidesPct}%`);
    }
    expect([safeZoneGroupOf("instagram_reels"), safeZoneGroupOf("facebook_reels"), safeZoneGroupOf("facebook_stories"), safeZoneGroupOf("instagram_feed")]).toEqual(["reels", "reels", "stories", null]);
  });
});

// =====================================================================================================================
// Steppers (3.7, 3.1a, D31)
// =====================================================================================================================

describe("budget steppers", () => {
  it("steps ₹10 in INR, or the FX step rounded up to a whole unit", () => {
    expect(stepperStep("INR")).toBe(1_000n);
    expect(stepperStep("USD", (inr) => (inr * 12n) / 1_000n)).toBe(100n);
    expect(stepperStep("USD")).toBe(100n);
    expect(stepperStep("USD", () => null)).toBe(100n);
    expect(stepperStep("JPY", () => 18n)).toBe(18n);
    expect(stepperStep("EUR", () => 250n)).toBe(300n);
  });

  it("moves on the step grid, between the floor and the cap", () => {
    expect(stepDaily(RS(300), 1, 1_000n)).toBe(RS(310));
    expect(stepDaily(RS(300), -1, 1_000n)).toBe(RS(290));
    expect(stepDaily(30_500n, 1, 1_000n)).toBe(RS(310));
    expect(stepDaily(30_500n, -1, 1_000n)).toBe(RS(300));
    expect(stepDaily(RS(10), -1, 1_000n)).toBe(RS(10));
    expect(stepDaily(RS(50), -1, 1_000n, { minMinor: RS(50) })).toBe(RS(50));
    expect(stepDaily(RS(500), 1, 1_000n, { maxMinor: RS(500) })).toBe(RS(500));
    expect(stepDaily(RS(300), 1, 1_000n, {}, repeatMultiplier(30))).toBe(RS(350));
  });

  it("Days never go below 2, and stop at 30 (90 under More options)", () => {
    expect(DAYS_MIN).toBe(2);
    expect([clampDays(1, 30), clampDays(0, 30), clampDays(-5, 30), clampDays(Number.NaN, 30)]).toEqual([2, 2, 2, 2]);
    expect(stepDays(2, -1, 30)).toBe(2);
    expect(stepDays(30, 1, daysMax(false))).toBe(30);
    expect(stepDays(30, 1, daysMax(true))).toBe(31);
    expect([daysMax(false), daysMax(true)]).toEqual([30, 90]);
    expect(clampDays(7.4, 30)).toBe(7);
  });

  it("labels every button with a full sentence", () => {
    expect(dailyButton(1, RS(300), 1_000n, {}, "INR")).toEqual({ next: RS(310), disabled: false, label: "Increase daily budget to ₹310" });
    expect(dailyButton(-1, RS(300), 1_000n, {}, "INR")).toEqual({ next: RS(290), disabled: false, label: "Decrease daily budget to ₹290" });
    expect(dailyButton(-1, RS(10), 1_000n, {}, "INR")).toEqual({ next: RS(10), disabled: true, label: "The daily budget can't go lower than ₹10" });
    expect(dailyButton(1, RS(500), 1_000n, { maxMinor: RS(500) }, "INR")).toMatchObject({ disabled: true, label: "The daily budget can't go higher than ₹500" });
    expect(dailyButton(-1, 0n, 1_000n, { minMinor: RS(50) }, "INR")).toMatchObject({ disabled: true, label: "The daily budget can't go lower than ₹50" });
    expect(dailyButton(1, 0n, 1_000n, { minMinor: RS(50) }, "INR")).toEqual({ next: RS(50), disabled: false, label: "Increase daily budget to ₹50" });
    expect(daysButton(1, 7, 30)).toEqual({ next: 8, disabled: false, label: "Increase days to 8" });
    expect(daysButton(-1, 7, 30)).toEqual({ next: 6, disabled: false, label: "Decrease days to 6" });
    expect(daysButton(-1, 2, 30)).toEqual({ next: 2, disabled: true, label: "The shortest run is 2 days" });
    expect(daysButton(1, 30, 30)).toEqual({ next: 30, disabled: true, label: "The longest run here is 30 days" });
  });

  it("a long press waits, then speeds up", () => {
    expect(LONG_PRESS_DELAY_MS).toBe(400);
    const delays = [0, 4, 5, 14, 15, 100].map(repeatDelayMs);
    expect(delays).toEqual([180, 180, 100, 100, 50, 50]);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeLessThanOrEqual(delays[i - 1]);
    expect([repeatMultiplier(0), repeatMultiplier(24), repeatMultiplier(25)]).toEqual([1, 1, 5]);
  });

  /** "+" held on the daily budget, as BudgetSteppers wires it: each tick steps and says whether the value changed. */
  function heldPlus(startMinor: bigint, bounds: { maxMinor: bigint }) {
    const state = { value: startMinor, changes: [] as bigint[] };
    const repeater = createRepeater((repeats) => {
      const next = stepDaily(state.value, 1, 1_000n, bounds, repeatMultiplier(repeats));
      if (next === state.value) return false;
      state.value = next;
      state.changes.push(next);
      return true;
    });
    return { state, repeater };
  }

  it("a held '+' stops at the cap and never steps again by itself once the value moves off it", () => {
    vi.useFakeTimers();
    const { state, repeater } = heldPlus(RS(480), { maxMinor: RS(500) });
    repeater.start();
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS - 1);
    expect(state.changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(state.changes).toEqual([RS(490)]);
    vi.advanceTimersByTime(180);
    expect(state.changes).toEqual([RS(490), RS(500)]);
    // The next tick changes nothing (the cap): the timer stops, although no pointerup reached the now-disabled button.
    vi.advanceTimersByTime(180);
    expect(repeater.running).toBe(false);
    // The member types a lower amount, which re-enables the button: nothing steps without a press.
    state.value = RS(300);
    vi.advanceTimersByTime(10_000);
    expect(state.changes).toEqual([RS(490), RS(500)]);
    expect(state.value).toBe(RS(300));
  });

  it("disabling the button stops a running repeat", () => {
    vi.useFakeTimers();
    const { state, repeater } = heldPlus(RS(100), { maxMinor: RS(10_000) });
    repeater.start();
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS + 180 * 2);
    expect(state.changes).toHaveLength(3);
    // StepButton calls stop() when `disabled` turns true (the fieldset is disabled while the page saves).
    repeater.stop();
    vi.advanceTimersByTime(10_000);
    expect(state.changes).toHaveLength(3);
    expect(repeater.running).toBe(false);
  });

  it("a long press released off the button never swallows the next keyboard press", () => {
    vi.useFakeTimers();
    const { state, repeater } = heldPlus(RS(100), { maxMinor: RS(10_000) });
    repeater.start();
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
    expect(state.changes).toEqual([RS(110)]);
    // pointerleave: the press ends off the button, so no click follows it.
    repeater.stop();
    // Enter or Space: a click with detail 0 always steps once.
    expect(repeater.click(true)).toBe(true);
    // A pointer click ending a press that repeated doesn't step again; the next quick tap does.
    repeater.start();
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
    expect(repeater.click(false)).toBe(false);
    expect(repeater.running).toBe(false);
    repeater.start();
    vi.advanceTimersByTime(100);
    expect(repeater.click(false)).toBe(true);
    expect(repeater.running).toBe(false);
  });

  it("Days show the real run length: a longer run chosen under More options stays when More closes", () => {
    expect([daysLimit(7, false), daysLimit(7, true), daysLimit(60, false), daysLimit(60, true), daysLimit(120, false), daysLimit(Number.NaN, false)]).toEqual([30, 90, 60, 90, 90, 30]);
    expect([daysInputValue(60), daysInputValue(7), daysInputValue(Number.NaN)]).toEqual(["60", "7", ""]);
    // More open: 60 can go up.
    expect(daysButton(1, 60, daysLimit(60, true))).toMatchObject({ next: 61, disabled: false });
    // More closed: 60 stays 60, can go down, not up.
    expect(daysButton(1, 60, daysLimit(60, false))).toEqual({ next: 60, disabled: true, label: "The longest run here is 60 days" });
    expect(daysButton(-1, 60, daysLimit(60, false))).toEqual({ next: 59, disabled: false, label: "Decrease days to 59" });
    expect(stepDays(60, -1, daysLimit(60, false))).toBe(59);
  });

  it("reads and writes the number fields in the account currency", () => {
    expect(parseMajorInput("310", "INR")).toBe(RS(310));
    expect(parseMajorInput("1,500", "INR")).toBe(RS(1_500));
    expect(parseMajorInput("₹300", "INR")).toBe(RS(300));
    expect(parseMajorInput("3.5", "USD")).toBe(350n);
    expect(parseMajorInput("500", "JPY")).toBe(500n);
    expect(parseMajorInput("abc", "INR")).toBeNull();
    expect(parseMajorInput("", "INR")).toBeNull();
    expect(parseMajorInput("-5", "INR")).toBeNull();
    expect([majorInputValue(RS(310), "INR"), majorInputValue(350n, "USD"), majorInputValue(500n, "JPY")]).toEqual(["310", "3.50", "500"]);
    expect(currencySymbol("INR")).toBe("₹");
    expect(currencySymbol("NOPE!")).toBe("NOPE!");
  });
});

// =====================================================================================================================
// Cost line and limit chip (3.3, 3.7, 6.2)
// =====================================================================================================================

describe("CostLine text from presentCost", () => {
  const base = { startMode: "now" as const, tz: IST, currency: "INR", headroom: FRESH, now: NOW };

  it("the 6.2 example: ₹300 a day for 5 days from Wed 28 Oct", () => {
    const view = computeCost({ ...base, dailyMinor: RS(300), runDays: 5, kind: "boost" });
    expect(view).not.toBeNull();
    const text = costLineText(view!);
    expect(text.main).toBe("About ₹1,500 in total. At most ₹2,625, because Meta can spend up to 75% more on a busy day.");
    expect(text.byMonth).toBe("Up to ₹2,100 in October and ₹525 in November.");
    expect(text.monthCross).toBe("November's part is set aside on 1 Nov. If November's limit is lower, the boost may pause then.");
    expect(text.setAside).toBeNull();
    // The same figures as calling presentCost with the run dates directly.
    const d = runDates({ runDays: 5, startMode: "now", tz: IST, now: NOW });
    const direct = presentCost({ sets: [{ dailyMinor: RS(300) }], startsAt: d.startsAt, endsAt: d.endsAt, tz: IST, headroom: FRESH, now: NOW, kind: "boost" });
    expect(view!.lines).toEqual(direct.lines);
  });

  it("the 3.7 example (7 days) and a fair test of 3 versions use the sum of the shares", () => {
    const seven = costLineText(computeCost({ ...base, dailyMinor: RS(300), runDays: 7 })!);
    expect(seven.main).toBe("About ₹2,100 in total. At most ₹3,675, because Meta can spend up to 75% more on a busy day.");
    expect(seven.byMonth).toBe("Up to ₹2,100 in October and ₹1,575 in November.");
    const three = computeCost({ ...base, dailyMinor: RS(300), runDays: 7, versions: 3 })!;
    expect([three.aboutTotalMinor, three.atMostMinor]).toEqual([RS(2_100), RS(3_675)]);
    const rounded = computeCost({ ...base, dailyMinor: RS(290), runDays: 7, versions: 3 })!;
    expect(rounded.aboutTotalMinor).toBe(RS(288) * 7n);
  });

  it("is null while the values can't make a run", () => {
    expect(computeCost({ ...base, dailyMinor: RS(300), runDays: 1 })).toBeNull();
    expect(computeCost({ ...base, dailyMinor: 0n, runDays: 5 })).toBeNull();
    expect(computeCost({ ...base, dailyMinor: RS(300), runDays: 5, startMode: "at", startsAt: null })).toBeNull();
  });

  it("LimitChip: '₹1,475 left today · ₹17,900 left this month'", () => {
    const view = computeCost({ ...base, dailyMinor: RS(300), runDays: 5, kind: "boost" })!;
    expect(limitChipText({ leftTodayMinor: view.leftTodayMinor, leftMonthMinor: view.leftMonthMinor, currency: "INR" })).toBe("₹1,475 left today · ₹17,900 left this month");
    expect(limitChipText({ leftTodayMinor: view.leftTodayMinor, leftMonthMinor: view.leftMonthMinor, currency: "INR" })).toBe(view.lines.left);
    expect(limitChipText({ leftTodayMinor: RS(500), leftMonthMinor: null, currency: "INR" })).toBe("₹500 left today");
    expect(limitChipText({ leftTodayMinor: null, leftMonthMinor: RS(5), currency: "INR" })).toBeNull();
    expect(limitChipTone({ leftTodayMinor: 0n, leftMonthMinor: RS(5), currency: "INR" })).toBe("warn");
    expect(limitChipTone({ leftTodayMinor: RS(1), leftMonthMinor: RS(5), currency: "INR" })).toBe("neutral");
  });

  it("settles 600 ms after the last change, once", () => {
    vi.useFakeTimers();
    expect(COST_DEBOUNCE_MS).toBe(600);
    const fired: number[] = [];
    const d = createDebouncer<number>(COST_DEBOUNCE_MS, (v) => fired.push(v));
    d.push(1);
    vi.advanceTimersByTime(300);
    d.push(2);
    vi.advanceTimersByTime(599);
    expect(fired).toEqual([]);
    expect(d.pending).toBe(true);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([2]);
    expect(d.pending).toBe(false);
    d.push(3);
    d.cancel();
    vi.advanceTimersByTime(1_000);
    expect(fired).toEqual([2]);
    d.push(4);
    d.flush();
    expect(fired).toEqual([2, 4]);
  });
});

// =====================================================================================================================
// Placement previews (7.4, D18)
// =====================================================================================================================

describe("preview tabs and the 6-preview cap", () => {
  it("Automatic shows Instagram Feed, Stories and Reels, then Facebook Feed, Stories and Reels", () => {
    expect(previewTabs([])).toEqual(["instagram_feed", "instagram_stories", "instagram_reels", "facebook_feed", "facebook_stories", "facebook_reels"]);
    expect(previewTabs([])).toEqual([...DEFAULT_PREVIEW_TABS]);
    expect(previewTabs([]).map((k) => placementLabel(k))).toEqual(["Instagram Feed", "Instagram Stories", "Instagram Reels", "Facebook Feed", "Facebook Stories", "Facebook Reels"]);
  });

  it("chosen positions keep that order and add the others after, never a position Meta never previews", () => {
    expect(previewTabs(["facebook_marketplace", "facebook_feed", "instagram_explore_home", "instagram_feed", "messenger_inbox"])).toEqual([
      "instagram_feed",
      "facebook_feed",
      "instagram_explore_home",
      "facebook_marketplace",
    ]);
  });

  it("asks Meta at most 6 times per review, lazily, once per tab", () => {
    expect(MAX_META_PREVIEWS_PER_REVIEW).toBe(6);
    const ledger = createPreviewLedger();
    const many: PlacementKey[] = [...DEFAULT_PREVIEW_TABS, "instagram_profile_feed", "facebook_marketplace"];
    const plans = many.map((k) => ledger.plan("draft-1:A", k));
    expect(plans).toEqual(["fetch", "fetch", "fetch", "fetch", "fetch", "fetch", "cap", "cap"]);
    expect(ledger.count).toBe(6);
    expect(ledger.plan("draft-1:A", "instagram_feed")).toBe("asked");
    // A position without a Meta preview format, and previews switched to local, never ask and never count.
    expect(ledger.plan("draft-1:A", "instagram_search")).toBe("local");
    expect(ledger.plan("draft-1:A", "facebook_feed", "local")).toBe("local");
    // A new review starts over.
    expect(ledger.plan("draft-1:B", "instagram_profile_feed")).toBe("fetch");
    expect(ledger.count).toBe(1);
  });

  it("arrow keys, Home and End wrap over the tabs; a swipe moves one tab", () => {
    expect(tabIndexForKey(6, 5, "ArrowRight")).toBe(0);
    expect(tabIndexForKey(6, 0, "ArrowLeft")).toBe(5);
    expect(tabIndexForKey(6, 3, "Home")).toBe(0);
    expect(tabIndexForKey(6, 3, "End")).toBe(5);
    expect(tabIndexForKey(6, 3, "a")).toBeNull();
    expect(tabIndexForKey(0, 0, "ArrowRight")).toBeNull();
    expect([swipeStep(-60, 5), swipeStep(60, 5), swipeStep(20, 0), swipeStep(-60, 80)]).toEqual([1, -1, 0, 0]);
  });
});

describe("Meta's preview or 'Our preview (approximate)'", () => {
  const mock = { frame: "9:16" as const, textLimit: 44 };
  const answer = (over: Partial<PreviewAnswer>): PreviewAnswer => ({ placement: "instagram_reels", source: "meta", approximate: false, src: "https://www.example.com/p?d=1", reason: null, mock, ...over });

  it("labels the tab approximate when the server returns approximate:true", () => {
    const local = previewDisplay(answer({ source: "local", approximate: true, src: null, reason: "previews_off" }));
    expect(local).toEqual({ kind: "local", label: "Our preview (approximate)", note: "Meta's preview isn't available for this place right now, so this is our own drawing." });
    // Even with an address, an approximate answer is never shown as Meta's.
    expect(previewDisplay(answer({ approximate: true })).kind).toBe("local");
    expect(previewDisplay(answer({ approximate: true })).label).toBe("Our preview (approximate)");
    expect(previewLabel(true)).toBe("Our preview (approximate)");
  });

  it("shows Meta's preview only for a Meta answer with an https address", () => {
    expect(previewDisplay(answer({}))).toEqual({ kind: "meta", src: "https://www.example.com/p?d=1", label: "Meta's preview" });
    expect(previewDisplay(answer({ src: "http://www.example.com/p" })).kind).toBe("local");
    expect(previewDisplay(answer({ src: "javascript:alert(1)" })).kind).toBe("local");
    expect(previewLabel(false)).toBe("Meta's preview");
    expect(iframeTitle("instagram_reels")).toBe("Meta preview: Instagram Reels");
  });

  it("says why it is ours: the cap, a failure, or no preview", () => {
    expect(previewDisplay(answer({ source: "local", approximate: true, src: null, reason: "review_cap" }))).toMatchObject({
      kind: "local",
      note: "Meta shows at most 6 previews per review. This one is our own drawing.",
    });
    expect(previewDisplay(null, "en", "cap")).toMatchObject({ kind: "local", note: "Meta shows at most 6 previews per review. This one is our own drawing." });
    expect(previewDisplay(answer({ source: "local", approximate: true, src: null, reason: "failed" }))).toMatchObject({ note: "Meta's preview didn't load. This is our own drawing." });
    expect(previewDisplay(null)).toEqual({ kind: "local", label: "Our preview (approximate)", note: null });
  });

  it("draws the local mock's frames and fill bars like the server", () => {
    expect(localMock("instagram_feed")).toEqual({ frame: "4:5", textLimit: 125 });
    expect(localMock("facebook_feed")).toEqual({ frame: "4:5", textLimit: 50 });
    expect(localMock("instagram_stories")).toEqual({ frame: "9:16", textLimit: 125 });
    expect(localMock("facebook_reels")).toEqual({ frame: "9:16", textLimit: 44 });
    expect(localMock("instagram_feed", true)).toEqual({ frame: "1:1", textLimit: 80 });
    expect(fillBars({ width: 1_080, height: 1_080 }, "9:16")).toEqual({ vertical: 0.21875, horizontal: 0 });
    expect(fillBars({ width: 1_080, height: 1_350 }, "9:16")).toEqual({ vertical: 0.1484375, horizontal: 0 });
    expect(fillBars({ width: 1_080, height: 1_920 }, "9:16")).toEqual({ vertical: 0, horizontal: 0 });
    expect(fillBars({ width: 1_000, height: 4_000 }, "9:16").horizontal).toBeCloseTo((1 - 0.25 / 0.5625) / 2, 9);
    expect(fillBars(null, "9:16")).toEqual({ vertical: 0, horizontal: 0 });
    expect([feedAspect({ width: 1_080, height: 1_920 }, "4:5"), feedAspect({ width: 1_910, height: 1_000 }, "4:5"), feedAspect(null, "4:5"), feedAspect({ width: 1_080, height: 1_080 }, "4:5")]).toEqual([0.8, 1.91, 0.8, 1]);
  });
});

// =====================================================================================================================
// Media picker, ad step, carousel and review reasons
// =====================================================================================================================

describe("media picker helpers", () => {
  it("a video Meta is still preparing gets the 5-to-30-minutes line, and is polled", () => {
    const video = media({ kind: "video", status: "processing", ready: false, message: "Sending to Meta." });
    expect(mediaStatusLine(video)).toEqual({ text: "Meta is still preparing your video. This usually takes 5 to 30 minutes.", tone: "info", busy: true, problemCode: null });
    expect(mediaPollDelayMs(video)).toBe(15_000);
    expect(mediaPollDelayMs(media({ status: "uploading" }))).toBe(3_000);
    expect(mediaPollDelayMs(media({ status: "ready" }))).toBeNull();
    expect(mediaPollDelayMs(media({ status: "error" }))).toBeNull();
    expect(mediaStatusLine(media({ status: "pending" }))).toEqual({ text: "Getting your file ready for Meta…", tone: "info", busy: true, problemCode: null });
    expect(mediaStatusLine(media())).toEqual({ text: "Ready for your ad.", tone: "good", busy: false, problemCode: null });
    expect(mediaStatusLine(media({ status: "error", error: "Meta didn't accept this file." }))).toEqual({ text: "Meta didn't accept this file.", tone: "bad", busy: false, problemCode: null });
  });

  it("a ready file this ad can't use says the block in red, in the page's language, never 'Ready'", () => {
    const ready = media({ problems: [CAROUSEL_BLOCK], message: CAROUSEL_BLOCK.text.en });
    expect(mediaBlock(ready)).toBe(CAROUSEL_BLOCK);
    expect(mediaStatusLine(ready)).toEqual({ text: CAROUSEL_BLOCK.text.en, tone: "bad", busy: false, problemCode: "ratio_carousel" });
    expect(mediaStatusLine(ready, "hi")).toMatchObject({ text: CAROUSEL_BLOCK.text.hi, tone: "bad" });
    // Pending for this request: nothing is sent for this ad, so no spinner and no polling.
    const pending = media({ status: "pending", ready: false, problems: [CAROUSEL_BLOCK], message: CAROUSEL_BLOCK.text.en });
    expect(mediaStatusLine(pending)).toEqual({ text: CAROUSEL_BLOCK.text.en, tone: "bad", busy: false, problemCode: "ratio_carousel" });
    expect(mediaPollDelayMs(pending)).toBeNull();
    // An invalid file's line is the localized block too, not the English-only error.
    const invalid = media({ status: "invalid", ready: false, error: "English only.", problems: [CAROUSEL_BLOCK] });
    expect(mediaStatusLine(invalid, "hinglish")).toMatchObject({ text: CAROUSEL_BLOCK.text.hinglish, tone: "bad" });
    // A warning is not a block: a ready file stays ready.
    expect(mediaStatusLine(media({ problems: [REEL_WARN] }))).toMatchObject({ text: "Ready for your ad.", tone: "good" });
    expect(mediaBlock(media({ problems: [REEL_WARN] }))).toBeNull();
  });

  it("a poll keeps this request's problems and block line, and takes the row's progress", () => {
    // prepare answered pending with a block for this request (a 16:9 picture on a carousel card).
    const prepared = media({ status: "pending", ready: false, problems: [CAROUSEL_BLOCK], message: CAROUSEL_BLOCK.text.en, metaImageHash: null, updatedAt: "2026-10-28T00:00:00Z" });
    // GET answers the stored problems for Automatic places and messageOf(row): no block.
    const polled = media({ status: "pending", ready: false, problems: [], message: "Waiting to send to Meta.", metaImageHash: null, updatedAt: "2026-10-28T00:00:03Z" });
    const merged = mergePolledMedia(prepared, polled)!;
    expect(merged.problems).toEqual([CAROUSEL_BLOCK]);
    expect(merged.message).toBe(CAROUSEL_BLOCK.text.en);
    expect(merged.updatedAt).toBe("2026-10-28T00:00:03Z");
    expect(mediaStatusLine(merged)).toMatchObject({ text: CAROUSEL_BLOCK.text.en, tone: "bad" });
    // Later the task sends the file anyway: the row turns ready, and the block still shows.
    const sent = mergePolledMedia(merged, media({ status: "ready", ready: true, problems: [], message: "Ready for your ad.", metaImageHash: "h2", updatedAt: "2026-10-28T00:01:00Z" }))!;
    expect(sent).toMatchObject({ status: "ready", ready: true, metaImageHash: "h2", message: CAROUSEL_BLOCK.text.en, problems: [CAROUSEL_BLOCK] });
    expect(mediaStatusLine(sent)).toMatchObject({ tone: "bad", text: CAROUSEL_BLOCK.text.en });
  });

  it("a poll for chosen places never swaps in the Automatic-only warnings", () => {
    const prepared = media({ status: "uploading", ready: false, problems: [], message: "Sending to Meta.", metaImageHash: null });
    const polled = media({ status: "ready", ready: true, problems: [REEL_WARN], message: "Ready for your ad.", metaImageHash: "h9", updatedAt: "2026-10-28T00:00:05Z" });
    const merged = mergePolledMedia(prepared, polled)!;
    expect(merged).toMatchObject({ status: "ready", ready: true, message: "Ready for your ad.", metaImageHash: "h9", problems: [] });
    expect(mediaStatusLine(merged)).toMatchObject({ text: "Ready for your ad.", tone: "good", busy: false });
  });

  it("a poll that says nothing new, or is about another file, changes nothing; an invalid row brings its own block", () => {
    const prepared = media({ status: "uploading", ready: false, message: "Sending to Meta.", problems: [REEL_WARN] });
    expect(mergePolledMedia(prepared, { ...prepared, problems: [] })).toBeNull();
    expect(mergePolledMedia(prepared, media({ id: "other", status: "ready" }))).toBeNull();
    const fileBlock: AdMediaProblem = { code: "too_small", severity: "block", text: { en: "This is 300 px wide. Meta needs at least 500 px.", hi: "x", hinglish: "y" } };
    const invalid = mergePolledMedia(prepared, media({ status: "invalid", ready: false, error: fileBlock.text.en, message: fileBlock.text.en, problems: [fileBlock] }))!;
    expect(invalid.problems).toEqual([REEL_WARN, fileBlock]);
    expect(invalid.message).toBe(fileBlock.text.en);
    expect(mediaStatusLine(invalid)).toMatchObject({ tone: "bad", text: fileBlock.text.en, problemCode: "too_small" });
  });

  it("fit chips, file addresses and the prepare body", () => {
    expect(mediaChips(media())).toEqual([
      { key: "feed", ok: true, text: "Feed 4:5 ✓" },
      { key: "stories_reels", ok: false, text: "Stories and Reels 9:16: missing" },
    ]);
    expect(mediaChips(media(), "hi")[0].text).toBe("फ़ीड 4:5 ✓");
    expect(mediaFileUrl(media())).toBe("/api/content/media/abc123.jpg");
    expect(mediaFileUrl(media({ source: "creative", sourceKey: "ca1" }))).toBe("/api/creative/assets/ca1/file");
    expect(prepareBody({ from: "content", key: "k.jpg" }, ["instagram_feed"], "single_image")).toEqual({ from: "content", key: "k.jpg", placements: ["instagram_feed"], format: "single_image" });
    expect(prepareBody({ from: "creative", assetId: "ca1" }, [])).toEqual({ from: "creative", assetId: "ca1", placements: [] });
    expect(prepareBody({ from: "crop", key: "c.jpg" }, [], null)).toEqual({ from: "crop", key: "c.jpg", placements: [] });
  });

  it("checks a file before upload and filters the libraries", () => {
    expect(uploadProblem({ type: "image/jpeg", size: 1_000 }, "image")).toBeNull();
    expect(uploadProblem({ type: "image/webp", size: 1_000 }, "image")).toBe("Use a JPG or PNG image.");
    expect(uploadProblem({ type: "image/png", size: 9 * 1024 * 1024 }, "image")).toBe("This file is 9 MB. Edwyz takes files up to 8 MB.");
    expect(uploadProblem({ type: "video/webm", size: 1_000 }, "video")).toBe("Use an MP4 or MOV video.");
    expect(libraryFilesOf([{ key: "a.jpg", kind: "image" }, { key: "b.mp4", kind: "video" }, { key: "c.png" }, { key: "d.gif", kind: "image" }], "image").map((f) => f.key)).toEqual(["a.jpg", "c.png"]);
    expect(libraryFilesOf([{ key: "a.jpg" }, { key: "b.MOV", kind: "video" }], "video").map((f) => f.key)).toEqual(["b.MOV"]);
    const assets = [
      { id: "1", kind: "image", status: "ready", storageKey: "s1" },
      { id: "2", kind: "image", status: "pending", storageKey: null },
      { id: "3", kind: "video", status: "approved", storageKey: "s3" },
      { id: "4", kind: "image", status: "rejected", storageKey: "s4" },
      { id: "5", kind: "copy", status: "ready", storageKey: null },
    ];
    expect(creativeAssetsOf(assets, "image").map((a) => a.id)).toEqual(["1"]);
    expect(creativeAssetsOf(assets, "video").map((a) => a.id)).toEqual(["3"]);
    expect(briefLabel({ id: "b", offer: "Diwali boxes 20% off", brand: { name: "Sharma Sweets" } })).toBe("Sharma Sweets: Diwali boxes 20% off");
    expect(briefLabel({ id: "b", offer: "x".repeat(80) })).toHaveLength(60);
  });

  it("uploads crops to the content library as ad crops, and prepares a pick with POST /api/promote/media", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = url.startsWith("/api/promote/media") ? { media: media({ id: "m9" }) } : { key: "crop1.jpg" };
      return new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });
    });
    try {
      const blob = new Blob(["x"], { type: CROP_MIME });
      expect(await uploadToLibrary(blob, CROP_MIME, { adCrop: true })).toEqual({ key: "crop1.jpg" });
      expect(calls[0].url).toBe(CROP_UPLOAD_PATH);
      expect(calls[0].init).toMatchObject({ method: "POST", headers: { "content-type": "image/jpeg" }, credentials: "same-origin" });
      await uploadToLibrary(blob, "image/png");
      expect(calls[1].url).toBe("/api/content/media");
      const prepared = await prepareAdMedia({ from: "crop", key: "crop1.jpg" }, ["instagram_stories"], "single_image");
      expect(prepared.id).toBe("m9");
      expect(calls[2].url).toBe("/api/promote/media");
      expect(JSON.parse(String(calls[2].init.body))).toEqual({ from: "crop", key: "crop1.jpg", placements: ["instagram_stories"], format: "single_image" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an upload the server refuses throws its plain sentence", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Your media library is full." }), { status: 413 }));
    try {
      await expect(uploadToLibrary(new Blob(["x"]), "image/jpeg")).rejects.toThrow("Your media library is full.");
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    try {
      await expect(uploadToLibrary(new Blob(["x"]), "image/jpeg")).rejects.toThrow("The file didn't upload. Check your connection and try again.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers the tall version for a feed picture when Stories or Reels may show", () => {
    expect(needsTallVersion(media(), null, [])).toBe(true);
    expect(needsTallVersion(media(), null, ["instagram_feed", "facebook_feed"])).toBe(false);
    expect(needsTallVersion(media(), media({ ratio: "9:16" }), [])).toBe(false);
    expect(needsTallVersion(media({ ratio: "9:16" }), null, [])).toBe(false);
    expect(needsTallVersion(null, null, [])).toBe(false);
  });
});

describe("ad step, versions and carousel helpers", () => {
  it("hides Video while PROMOTE_VIDEO is off", () => {
    expect(adSourceTabs(true)).toEqual(["image", "video", "carousel", "post"]);
    expect(adSourceTabs(false)).toEqual(["image", "carousel", "post"]);
  });

  it("allows up to 3 versions and 2 to 10 cards", () => {
    expect([canAddVersion(1), canAddVersion(2), canAddVersion(3)]).toEqual([true, true, false]);
    expect([canAddCard(9), canAddCard(10), canRemoveCard(3), canRemoveCard(2)]).toEqual([true, false, true, false]);
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"]);
    expect(cardLinkProblem("http://example.com")).toBe("The link must start with https://");
    expect(cardLinkProblem("https://example.com")).toBeNull();
    expect(cardLinkProblem("")).toBeNull();
  });

  it("lists the goal's buttons, the default first", () => {
    expect(ctaOptions("lead_form")).toEqual([
      { type: "SIGN_UP", label: "Sign up" },
      { type: "GET_QUOTE", label: "Get quote" },
      { type: "BOOK_NOW", label: "Book now" },
      { type: "APPLY_NOW", label: "Apply now" },
    ]);
    expect(ctaOptions("engagement")).toEqual([]);
  });

  it("gives every review reason one fix", () => {
    const reasons = explainReviewFeedback({ global: { PERSONAL_ATTRIBUTES: "x", LANDING_PAGE_FAIL: "y", TEXT_OVERLAY: "z", ALCOHOL: "a" }, placement_specific: { instagram: { HOUSING: "h" } } });
    expect(reasons.map((r) => policyFixLabel(r))).toEqual(["Edit the text", "Change the link", "Change the picture or video", "Ask Meta to review again", "Mark it as about housing"]);
    expect(policyWhere("instagram")).toBe("On Instagram");
    expect(policyWhere(null)).toBeNull();
  });
});

// =====================================================================================================================
// Components (static render)
// =====================================================================================================================

describe("MetaPreviewFrame", () => {
  const attrs = (markup: string) => {
    const tag = /<iframe([^>]*)>/.exec(markup)?.[1] ?? "";
    // HTML attribute names are case-insensitive (React writes referrerPolicy).
    return Object.fromEntries(Array.from(tag.matchAll(/([A-Za-z-]+)="([^"]*)"/g), (m) => [m[1].toLowerCase(), unescape(m[2])]));
  };

  it("renders exactly sandbox, referrerpolicy and loading, with the position in the title", () => {
    const markup = html(createElement(MetaPreviewFrame, { src: "https://www.example.com/preview?d=1&t=2", placement: "instagram_reels" }));
    expect(markup.match(/<iframe/g)).toHaveLength(1);
    const a = attrs(markup);
    expect(Object.keys(a).sort()).toEqual(["class", "loading", "referrerpolicy", "sandbox", "src", "title"]);
    expect(a.sandbox).toBe("allow-scripts allow-same-origin");
    expect(a.referrerpolicy).toBe("no-referrer");
    expect(a.loading).toBe("lazy");
    expect(a.title).toBe("Meta preview: Instagram Reels");
    expect(a.src).toBe("https://www.example.com/preview?d=1&t=2");
    expect(unescape(markup)).toContain("Meta's preview");
  });

  it("renders nothing for anything but an https address", () => {
    for (const src of ["http://www.example.com/p", "javascript:alert(1)", "", "//www.example.com/p"]) expect(html(createElement(MetaPreviewFrame, { src, placement: "instagram_feed" }))).toBe("");
  });
});

describe("component markup", () => {
  it("BudgetSteppers: full-sentence labels, number fields and test ids", () => {
    const markup = unescape(html(createElement(BudgetSteppers, { dailyMinor: RS(300), onDailyChange: () => {}, days: 7, onDaysChange: () => {}, currency: "INR" })));
    for (const label of ["Increase daily budget to ₹310", "Decrease daily budget to ₹290", "Increase days to 8", "Decrease days to 6"]) expect(markup).toContain(`aria-label="${label}"`);
    for (const id of ["budget-steppers", "budget-daily-stepper", "budget-days-stepper", "budget-daily-input", "budget-days-input", "budget-daily-increase", "budget-days-decrease"]) expect(markup).toContain(`data-testid="${id}"`);
    expect(markup).toContain("₹ per day");
    expect(markup).toContain(">Days<");
    expect(markup).toContain('value="300"');
    expect(markup).toContain('value="7"');
    expect(markup).toContain("Changes in steps of ₹10. Hold a button to change faster.");
    const atTwo = unescape(html(createElement(BudgetSteppers, { dailyMinor: RS(300), onDailyChange: () => {}, days: 2, onDaysChange: () => {}, currency: "INR", moreDays: true })));
    expect(atTwo).toMatch(/aria-label="The shortest run is 2 days" disabled=""/);
    expect(atTwo).toContain("From 2 to 90 days.");
  });

  it("BudgetSteppers: closing More options never shows a different Days number from the one saved", () => {
    const steppers = (moreDays: boolean) => unescape(html(createElement(BudgetSteppers, { dailyMinor: RS(300), onDailyChange: () => {}, days: 60, onDaysChange: () => {}, currency: "INR", moreDays })));
    const open = steppers(true);
    expect(open).toContain('value="60"');
    expect(open).toContain('aria-label="Increase days to 61"');
    expect(open).toContain('aria-label="Decrease days to 59"');
    const closed = steppers(false);
    expect(closed).toContain('value="60"');
    expect(closed).not.toContain('value="30"');
    expect(closed).not.toContain("Increase days to 31");
    expect(closed).toMatch(/aria-label="The longest run here is 60 days" disabled=""/);
    expect(closed).toContain('aria-label="Decrease days to 59"');
    expect(closed).toContain("From 2 to 30 days. More options go up to 90.");
  });

  it("MediaPicker: a file blocked for this ad shows the block once, in red, with no spinner", () => {
    const value = media({ status: "pending", ready: false, problems: [CAROUSEL_BLOCK, REEL_WARN], message: CAROUSEL_BLOCK.text.en });
    const markup = unescape(html(createElement(MediaPicker, { kind: "image", format: "carousel", placements: [], value, onChange: () => {}, label: "Picture" })));
    const status = /<p[^>]*data-testid="media-picker-status"[^>]*>([\s\S]*?)<\/p>/.exec(markup);
    expect(status?.[0]).toContain("text-bad-fg");
    expect(status?.[1]).toContain(CAROUSEL_BLOCK.text.en);
    expect(status?.[1]).not.toContain("ui-spinner");
    expect(markup).not.toContain("Getting your file ready for Meta");
    expect(markup.split(CAROUSEL_BLOCK.text.en)).toHaveLength(2);
    // The warning still shows as its own alert.
    expect(markup).toContain(REEL_WARN.text.en);
    // A ready file with a block isn't "Ready for your ad." in green.
    const ready = unescape(html(createElement(MediaPicker, { kind: "image", placements: [], value: media({ problems: [CAROUSEL_BLOCK], message: CAROUSEL_BLOCK.text.en }), onChange: () => {}, label: "Picture" })));
    const readyStatus = /<p[^>]*data-testid="media-picker-status"[^>]*>([\s\S]*?)<\/p>/.exec(ready)?.[0] ?? "";
    expect(readyStatus).toContain("text-bad-fg");
    expect(readyStatus).not.toContain("text-good-fg");
    expect(readyStatus).toContain(CAROUSEL_BLOCK.text.en);
    expect(ready).not.toContain("Ready for your ad.");
  });

  it("CostLine: the lines at once, in a polite live region", () => {
    const markup = unescape(html(createElement(CostLine, { dailyMinor: RS(300), runDays: 5, startMode: "now", tz: IST, currency: "INR", headroom: FRESH, kind: "boost", now: NOW })));
    expect(markup).toContain('data-testid="cost-line"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('data-testid="cost-line-at-most"');
    expect(markup.replace(/<[^>]+>/g, "")).toContain("About ₹1,500 in total. At most ₹2,625, because Meta can spend up to 75% more on a busy day.Up to ₹2,100 in October and ₹525 in November.");
  });

  it("LimitChip: the left line, or nothing without a daily limit", () => {
    expect(html(createElement(LimitChip, { leftTodayMinor: RS(1_475), leftMonthMinor: RS(17_900), currency: "INR" }))).toContain("₹1,475 left today · ₹17,900 left this month");
    expect(html(createElement(LimitChip, { leftTodayMinor: null, leftMonthMinor: RS(5), currency: "INR" }))).toBe("");
  });

  it("PhoneFrame: approximate label, '… more', the profile and the button; fill bars on 9:16", () => {
    const long = "Fresh sweets for Diwali, made every morning in our kitchen. ".repeat(5);
    const feed = unescape(html(createElement(PhoneFrame, { placement: "instagram_feed", profile: { name: "Sharma Sweets", pictureUrl: "/pic.jpg" }, text: { primary: long, headline: "Order now" }, ctaLabel: "Send WhatsApp message", media: { url: "/a.jpg", kind: "image", width: 1_080, height: 1_350 } })));
    expect(feed).toContain("Our preview (approximate)");
    expect(feed).toContain("… more");
    expect(feed).toContain("Sharma Sweets");
    expect(feed).toContain('src="/pic.jpg"');
    expect(feed).toContain("Send WhatsApp message");
    expect(feed).toContain('data-frame="4:5"');
    expect(feed).toContain('aria-label="Instagram Feed preview of your ad: ');
    const tall = unescape(html(createElement(PhoneFrame, { placement: "instagram_reels", profile: { name: "Sharma Sweets" }, text: { primary: "Hi" }, media: { url: "/a.jpg", kind: "image", width: 1_080, height: 1_080 } })));
    expect(tall).toContain('data-frame="9:16"');
    expect(tall).toContain('data-fill-bars="yes"');
    expect(tall).toContain("Meta fills the space around pictures that aren't 9:16.");
    const post = unescape(html(createElement(PhoneFrame, { placement: "instagram_feed", profile: { name: "Sharma Sweets" }, text: { primary: "" }, ctaLabel: "Send WhatsApp message", post: { contentKey: "k1.jpg", body: long } })));
    expect(post).toContain('aria-label="Instagram preview"');
    expect(post).toContain("… more");
    expect(post).toContain("Send WhatsApp message");
  });

  it("PlacementPreview: the six tabs in order, the first selected, our drawing until Meta answers", () => {
    const markup = unescape(
      html(createElement(PlacementPreview, { placements: [], reviewKey: "r1", source: { draftId: "d1" }, frame: { profile: { name: "Sharma Sweets" }, text: { primary: "Hi" } }, fetchPreview: async () => ({ previews: [] }) })),
    );
    const order = Array.from(markup.matchAll(/data-testid="preview-tab-([a-z_]+)"/g), (m) => m[1]);
    expect(order).toEqual([...DEFAULT_PREVIEW_TABS]);
    expect(markup).toMatch(/aria-selected="true"[^>]*data-testid="preview-tab-instagram_feed"/);
    expect(markup).toContain('data-testid="preview-panel"');
    expect(markup).toContain('data-testid="preview-tabs"');
    expect(markup).toContain('aria-label="Next: Instagram Stories"');
    expect(markup).toContain('aria-label="Previous: Facebook Reels"');
    expect(markup).toContain("Our preview (approximate)");
    expect(markup).not.toContain("<iframe");
    // Reduced motion turns the panel's fade off.
    expect(markup).toContain("motion-reduce:animate-none");
  });

  it("PhoneFrame wraps Content's ChannelPreview instead of changing it", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/promote/PhoneFrame.tsx"), "utf8");
    expect(src).toContain('import { ChannelPreview } from "@/components/content/ChannelPreview";');
    expect(src).toMatch(/<ChannelPreview /);
  });

  it("SafeZoneOverlay and its legend carry the text equivalent", () => {
    const overlay = html(createElement(SafeZoneOverlay, { group: "reels" }));
    expect(overlay).toContain('data-safe-zone="reels"');
    expect(overlay).toContain("height:35%");
    expect(overlay).toContain("Text in the bottom 35% may be hidden by the caption and buttons");
    expect(html(createElement(SafeZoneOverlay, { group: "stories", announce: false }))).not.toContain("Text in the");
    expect(html(createElement(SafeZoneLegend, { group: "stories" }))).toContain("Text in the bottom 20% may be hidden by the reply box");
  });

  it("PolicyExplain: one fix button per reason; the appeal opens Meta", () => {
    const markup = unescape(
      html(
        createElement(PolicyExplain, {
          feedback: { global: { PERSONAL_ATTRIBUTES: "x", ALCOHOL: "y" }, placement_specific: { instagram: { HOUSING: "z" } } },
          onFix: () => {},
          appealHref: "https://www.example.com/appeal",
        }),
      ),
    );
    expect(markup.match(/data-testid="policy-fix-/g)).toHaveLength(3);
    expect(markup).toContain("Meta didn't approve this ad: the text talks about the reader's personal traits. Say what you offer instead.");
    expect(markup).toContain("Edit the text");
    expect(markup).toContain("Ask Meta to review again");
    expect(markup).toContain('href="https://www.example.com/appeal"');
    expect(markup).toContain("On Instagram");
    expect(markup).toContain("Mark it as about housing");
    expect(html(createElement(PolicyExplain, { feedback: null, onFix: () => {} }))).toBe("");
  });

  it("CopyFields: counters, the 2,200 fix and the flagged hashtags", () => {
    const long = unescape(html(createElement(CopyFields, { value: { primary: "a".repeat(2_201), headline: "" }, onChange: () => {}, placements: ["instagram_feed"], hasInstagramIdentity: true })));
    expect(long).toContain('data-testid="copy-shorten"');
    expect(long).toContain("Shorten to 2,200 characters for Instagram");
    expect(long).toContain("2,201 of 2,200 characters allowed on Instagram");
    expect(long).toContain('aria-invalid="true"');
    const hashtags = unescape(html(createElement(CopyFields, { value: { primary: tags(31), headline: "" }, onChange: () => {}, placements: [], hasInstagramIdentity: true })));
    expect(hashtags).toContain("31 of 30 hashtags");
    expect(hashtags).toContain("Remove these: #t31");
    const counters = unescape(html(createElement(CopyFields, { value: { primary: "Hello", headline: "Hi" }, onChange: () => {}, placements: SIMPLE_PLACES, hasInstagramIdentity: true })));
    expect(counters).toContain('Instagram: 5 of 125 show before "… more"');
    expect(counters).toContain('Reels: 5 of 44 show before "… more"');
    expect(counters).toContain('Facebook: 2 of 27 show before "… more"');
  });

  it("AdStep: source tabs (no Video while it is off), Use a post, and the button under More options", () => {
    const off = unescape(html(createElement(AdStep, { value: initialAdStep(), onChange: () => {}, goal: "lead_form", placements: [], hasInstagramIdentity: true, videoEnabled: false, onUsePost: () => {} })));
    const tabsOf = (m: string) => Array.from(m.matchAll(/role="tab"[^>]*>([^<]+)</g), (x) => x[1]);
    expect(tabsOf(off).slice(0, 3)).toEqual(["Image", "Carousel", "Use a post"]);
    expect(off).toContain('data-testid="ad-source-tabs"');
    expect(off).toContain("Add a version to compare");
    expect(off).toContain('data-testid="ad-cta-select"');
    expect(off).toContain(">More options<");
    expect(off).toContain(">Sign up<");
    const on = unescape(html(createElement(AdStep, { value: initialAdStep(), onChange: () => {}, goal: "whatsapp_chats", placements: [], hasInstagramIdentity: true, videoEnabled: true, onUsePost: () => {} })));
    expect(tabsOf(on).slice(0, 4)).toEqual(["Image", "Video", "Carousel", "Use a post"]);
    const withPicture = unescape(
      html(createElement(AdStep, { value: { ...initialAdStep(), versions: [{ feed: media(), vertical: null, text: { primary: "", headline: "" } }] }, onChange: () => {}, goal: "whatsapp_chats", placements: [], hasInstagramIdentity: true, videoEnabled: false, onUsePost: () => {} })),
    );
    expect(withPicture).toContain("Add a tall version (9:16) for Stories and Reels");
    expect(withPicture).toContain("Crop this picture");
    expect(withPicture).toContain("Feed 4:5 ✓");
  });

  const copyA: CopyValue = { primary: "Version A text", headline: "A head" };
  const copyB: CopyValue = { primary: "Version B text", headline: "B head" };
  const twoVersions = (source: AdStepValue["source"]): AdStepValue => ({
    ...initialAdStep(),
    source,
    versions: [
      { feed: media(), vertical: null, text: copyA },
      { feed: media({ id: "m2" }), vertical: null, text: copyB },
    ],
  });
  const stepProps = (value: AdStepValue, onChange: (v: AdStepValue) => void, videoEnabled = true) => ({
    value,
    onChange,
    goal: "whatsapp_chats" as const,
    placements: [] as PlacementKey[],
    hasInstagramIdentity: true,
    videoEnabled,
    onUsePost: () => {},
  });
  const selectedTab = (markup: string) => /role="tab" aria-selected="true"[^>]*>([^<]+)</.exec(markup)?.[1];

  it("AdStep: the carousel text reads and writes version A, and leaves version B alone", () => {
    const changes: AdStepValue[] = [];
    const value = twoVersions("carousel");
    const markup = unescape(html(createElement(AdStep, stepProps(value, (v) => changes.push(v)))));
    expect(selectedTab(markup)).toBe("Carousel");
    const fields = seen.copy.filter((p) => p.format === "carousel") as { value: CopyValue; onChange: (t: CopyValue) => void }[];
    expect(fields).toHaveLength(1);
    expect(fields[0].value).toEqual(copyA);
    // Typing one character: version A gets it, version B keeps its own text.
    fields[0].onChange({ ...copyA, primary: "Version A text!" });
    expect(changes).toHaveLength(1);
    expect(changes[0].versions[0].text.primary).toBe("Version A text!");
    expect(changes[0].versions[1]).toEqual(value.versions[1]);
    expect(changes[0].source).toBe("carousel");
  });

  it("AdStep: version B made active, then Carousel chosen, still reads and writes version A (the step's view)", () => {
    // Version B was added (active 1); the member then picks Carousel.
    const onImage = adStepView(twoVersions("image"), { active: 1, postOpen: false }, true);
    expect([onImage.tab, onImage.versionIndex, onImage.textIndex, onImage.text]).toEqual(["image", 1, 1, copyB]);
    const carousel = twoVersions("carousel");
    const view = adStepView(carousel, { active: 1, postOpen: false }, true);
    expect([view.tab, view.textIndex, view.text, view.format]).toEqual(["carousel", 0, copyA, "carousel"]);
    const typed = patchVersion(carousel, view.textIndex, { text: { ...view.text, primary: `${view.text.primary}!` } });
    expect(typed.versions[0].text.primary).toBe("Version A text!");
    expect(typed.versions[1]).toBe(carousel.versions[1]);
    // What applies: a carousel uses version A's text only; B stays in the value for when the member switches back.
    expect(adStepInUse(typed)).toEqual({ source: "carousel", format: "carousel", versions: [{ feed: null, vertical: null, text: typed.versions[0].text }], cards: typed.cards });
    expect(typed.versions).toHaveLength(2);
  });

  it("AdStep: the picture editor writes the version being edited", () => {
    const changes: AdStepValue[] = [];
    const value = twoVersions("image");
    unescape(html(createElement(AdStep, stepProps(value, (v) => changes.push(v)))));
    const text = seen.copy.find((p) => p.format === "single_image") as { value: CopyValue; onChange: (t: CopyValue) => void };
    expect(text.value).toEqual(copyA);
    text.onChange({ ...copyA, headline: "New head" });
    expect(changes[0].versions.map((v) => v.text.headline)).toEqual(["New head", "B head"]);
    // A poll's answer for the chosen picture lands in the same version's feed.
    const picker = seen.media.find((p) => p.label === "Picture · Version A") as { value: AdMediaView | null; onChange: (m: AdMediaView | null) => void };
    expect(picker.value?.id).toBe("m1");
    picker.onChange(media({ status: "ready", metaImageHash: "h3" }));
    expect(changes[1].versions[0].feed?.metaImageHash).toBe("h3");
    expect(changes[1].versions[1]).toEqual(value.versions[1]);
  });

  it("AdStep: the tab always shows the value's source; a video draft while video is off shows (and becomes) Image", () => {
    const later = twoVersions("video");
    expect(adStepView(later, { active: 0, postOpen: false }, true)).toMatchObject({ tab: "video", kind: "video", format: "single_video", feed: null });
    expect(adStepView(later, { active: 0, postOpen: true }, true).tab).toBe("post");
    expect([adStepSource("video", false), adStepSource("video", true), adStepSource("carousel", false)]).toEqual(["image", "video", "carousel"]);

    const video = media({ id: "v1", kind: "video", sourceKey: "v.mp4", mime: "video/mp4", ratio: "9:16" });
    const saved: AdStepValue = { ...initialAdStep(), source: "video", versions: [{ feed: video, vertical: null, text: copyA }] };
    const view = adStepView(saved, { active: 0, postOpen: false }, false);
    expect(view).toMatchObject({ tab: "image", source: "image", kind: "image", format: "single_image", feed: null });
    const markup = unescape(html(createElement(AdStep, stepProps(saved, () => {}, false))));
    expect(selectedTab(markup)).toBe("Image");
    expect(markup).not.toContain('data-kind="video"');
    const picker = seen.media.find((p) => p.label === "Picture") as { kind: string; format: string; value: AdMediaView | null };
    expect([picker.kind, picker.format, picker.value]).toEqual(["image", "single_image", null]);
    expect(markup).not.toContain('src="/api/content/media/v.mp4"');
  });

  it("adStepInUse: only media of the source's kind, at most 3 versions, never the cards of a picture ad", () => {
    const video = media({ id: "v1", kind: "video", sourceKey: "v.mp4" });
    const value: AdStepValue = { ...initialAdStep(), source: "video", versions: [{ feed: media(), vertical: video, text: copyA }, { feed: video, vertical: null, text: copyB }] };
    expect(adStepInUse(value)).toEqual({
      source: "video",
      format: "single_video",
      versions: [
        { feed: null, vertical: video, text: copyA },
        { feed: video, vertical: null, text: copyB },
      ],
      cards: [],
    });
    expect(adStepInUse({ ...value, source: "image" }).versions.map((v) => [v.feed?.id ?? null, v.vertical?.id ?? null])).toEqual([
      ["m1", null],
      [null, null],
    ]);
    // A missing version A is created by a write, never lost.
    expect(patchVersion({ ...value, versions: [] }, 0, { text: copyB }).versions).toEqual([{ feed: null, vertical: null, text: copyB }]);
    expect(patchVersion(value, 5, { text: copyB })).toBe(value);
  });

  it("CarouselEditor: move and remove buttons with their limits", () => {
    const markup = unescape(html(createElement(CarouselEditor, { cards: [emptyCard(), emptyCard()], onChange: () => {}, placements: [] })));
    expect(markup).toContain("2 of 10 cards");
    expect(markup).toMatch(/aria-label="Move card 1 earlier" disabled=""/);
    expect(markup).toMatch(/aria-label="Move card 2 later" disabled=""/);
    expect(markup).toContain('aria-label="Move card 1 later"');
    expect(markup).toMatch(/aria-label="Remove card 1" disabled=""/);
    expect(markup).toContain('data-testid="carousel-card-2"');
    const one = unescape(html(createElement(CarouselEditor, { cards: [emptyCard()], onChange: () => {}, placements: [], linkMode: "lead_form" })));
    expect(one).toContain("A carousel needs 2 to 10 cards.");
    expect(one).toContain("Every card opens the same lead form.");
    // A card picture that isn't 1:1 offers the 1:1 crop; a square one doesn't.
    const tall = unescape(html(createElement(CarouselEditor, { cards: [{ ...emptyCard(), media: media() }, { ...emptyCard(), media: media({ id: "m2", ratio: "1:1" }) }], onChange: () => {}, placements: [] })));
    expect(tall.match(/Crop this picture/g)).toHaveLength(1);
  });

  it("MediaPicker: a chosen video still processing says so", () => {
    const markup = unescape(html(createElement(MediaPicker, { kind: "video", placements: [], value: media({ kind: "video", status: "processing", sourceKey: "v.mp4" }), onChange: () => {}, label: "Video" })));
    expect(markup).toContain("Meta is still preparing your video. This usually takes 5 to 30 minutes.");
    expect(markup).toContain("Feed 4:5 ✓");
    expect(markup).toContain('data-testid="media-picker-chosen"');
    expect(markup).toContain('src="/api/content/media/v.mp4"');
  });

  it("CropTool: a keyboard-operable crop area with its help text", () => {
    const markup = unescape(html(createElement(CropTool, { src: "/api/content/media/k.jpg", ratio: "9:16", ratios: ["9:16"], onCancel: () => {}, onCropped: () => {} })));
    expect(markup).toContain('role="application"');
    expect(markup).toContain('aria-label="Crop area, Stories and Reels 9:16"');
    expect(markup).toContain("Drag the picture or use the arrow keys to move it. Press + or - to zoom and Enter to save.");
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("What may cover your picture in Reels");
    expect(markup).toContain("Save crop");
  });
});

// =====================================================================================================================
// Tokens only (7.6): a grep over this package's files
// =====================================================================================================================

describe("tokens only: no hex, no dark:, no raw z-index, no Meta host", () => {
  const DIR = path.resolve(__dirname, "../src/components/promote");
  const TSX = [
    "AdStep.tsx",
    "MediaPicker.tsx",
    "CropTool.tsx",
    "SafeZoneOverlay.tsx",
    "CarouselEditor.tsx",
    "CopyFields.tsx",
    "PlacementPreview.tsx",
    "PhoneFrame.tsx",
    "MetaPreviewFrame.tsx",
    "PolicyExplain.tsx",
    "BudgetSteppers.tsx",
    "CostLine.tsx",
    "LimitChip.tsx",
  ];
  const TS = ["creative-helpers.ts", "usePromoteCopy.ts"];

  it.each(TSX.map((f) => [f] as const))("%s", (file) => {
    const src = readFileSync(path.join(DIR, file), "utf8");
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(src).not.toMatch(/\bdark:/);
    expect(src).not.toMatch(/\bz-(\d+|\[)/);
    expect(src).not.toMatch(/zIndex|z-index/);
    expect(src).not.toContain("facebook.com");
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });

  it.each(TS.map((f) => [f] as const))("%s", (file) => {
    const src = readFileSync(path.join(DIR, file), "utf8");
    expect(src).not.toMatch(/\bdark:/);
    expect(src).not.toMatch(/\bz-(\d+|\[)/);
    expect(src).not.toContain("facebook.com");
  });

  it("MetaPreviewFrame's iframe carries exactly the three attributes in its source", () => {
    const src = readFileSync(path.join(DIR, "MetaPreviewFrame.tsx"), "utf8");
    const iframe = /<iframe[\s\S]*?\/>/.exec(src)?.[0] ?? "";
    expect(iframe).toContain("sandbox={META_PREVIEW_SANDBOX}");
    expect(src).toContain('META_PREVIEW_SANDBOX = "allow-scripts allow-same-origin"');
    expect(iframe).toContain('referrerPolicy="no-referrer"');
    expect(iframe).toContain('loading="lazy"');
    expect(iframe).not.toMatch(/\ballow=|srcDoc|allowFullScreen/);
  });

  it("the grep itself catches what it bans", () => {
    expect("color: #0f172a".match(/#[0-9a-fA-F]{3,8}\b/g)).toEqual(["#0f172a"]);
    expect("dark:bg-black").toMatch(/\bdark:/);
    expect("z-50").toMatch(/\bz-(\d+|\[)/);
    expect("z-[60]").toMatch(/\bz-(\d+|\[)/);
    expect("size-24 z-(--z-overlay)").not.toMatch(/\bz-(\d+|\[)/);
  });
});

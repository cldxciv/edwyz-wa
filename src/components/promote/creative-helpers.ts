/**
 * Pure logic of the ad builder and the money controls (docs/IG-PAGE-ADS-SPEC.md 3.4 step 2, 3.7, 4.6, 7.2 to 7.4, 7.6,
 * D18, D21, D34; PRM-15a). No React, no DOM, no network: the components next to this file call these functions, and
 * tests/promote-ui-creative.test.ts pins them.
 *
 * - Text: visible-length counters per placement and Instagram's hard stops come from catalog/formats (checkText), counted
 *   in graphemes so Devanagari counts as people see it. The 31st hashtag onwards is flagged by name.
 * - Crop: rectangles for 4:5 (1080x1350), 9:16 (1080x1920) and 1:1 (1080x1080), the sizes in catalog/formats, with the
 *   keyboard moves (arrows move, + and - zoom, Enter confirms). JPEG at quality 0.9.
 * - Safe zones: top 14%, bottom 35% (Reels) or 20% (Stories), 6% each side, from catalog/formats, with the text equivalent.
 * - Steppers: ₹10 (or the FX step from cost.ts budgetStep), Days from 2 (D31) to 30, or 90 under More options (a longer
 *   run kept when More closes, daysLimit); a long press repeats faster and stops at an edge (createRepeater); full-sentence
 *   labels.
 * - Media: the status line (a block wins over "Ready"), and the poll merge that keeps a request's problems.
 * - Ad step: the view derived from the value (adStepView) and what applies to the ad (adStepInUse).
 * - Cost: presentCost's lines, debounced 600 ms; the LimitChip line.
 * - Previews: the tab order, the 6-per-review cap (D18), and Meta's preview versus "Our preview (approximate)".
 *
 * Every string comes from src/lib/promote/copy.
 */
import type { Tone } from "@/components/ui";
import type { AdMediaProblem, AdMediaStatus, AdMediaView } from "@/lib/promote/media";
import type { PlacementPreview, PreviewMock } from "@/lib/promote/previews";
import type { ExplainedReason } from "@/lib/promote/review-reasons";
import { CTA_BY_GOAL } from "@/lib/promote/catalog/cta";
import {
  CAROUSEL_MAX_CARDS,
  CAROUSEL_MIN_CARDS,
  checkText,
  FILE_LIMITS,
  FORMAT_SPECS,
  groupOfPlacement,
  groupsOf,
  INSTAGRAM_CAPTION_MAX,
  INSTAGRAM_HASHTAGS_MAX,
  instagramLength,
  showsOnInstagram,
  type TextCounter,
  type TextFields,
  type TextProblemCode,
} from "@/lib/promote/catalog/formats";
import { placementRow } from "@/lib/promote/catalog/placements";
import { DEFAULT_PREVIEW_TABS, MAX_META_PREVIEWS_PER_REVIEW, PREVIEW_AD_FORMATS, previewFormatFor } from "@/lib/promote/catalog/preview-formats";
import { formatMoney, isPromoteCopyKey, promoteText, type PromoteCopyKey } from "@/lib/promote/copy";
import { budgetStep, MAX_VERSIONS, presentCost, splitDaily, type CostHeadroom, type FromInr } from "@/lib/promote/cost";
import { MAX_RUN_DAYS, MIN_RUN_DAYS, runDates, SIMPLE_MAX_RUN_DAYS } from "@/lib/promote/dates";
import { PLACEMENT_KEYS, type AdFormat, type CostView, type GoalKey, type PlacementKey, type PromoteLang, type StartMode } from "@/lib/promote/types";
import { currencyExponent } from "@/lib/spend/money";

export type Size = { width: number; height: number };

// =====================================================================================================================
// Graphemes
// =====================================================================================================================

const SEGMENTER = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** The text split as people see it (a Devanagari conjunct or an emoji with a skin tone is one piece). */
export function graphemes(text: string): string[] {
  if (!SEGMENTER) return Array.from(text);
  return Array.from(SEGMENTER.segment(text), (s) => s.segment);
}

/** True when the text has Devanagari, which gets a 1.1x line height (7.6). */
export const hasDevanagari = (text: string): boolean => /\p{Script=Devanagari}/u.test(text);

// =====================================================================================================================
// Text: counters, Instagram's hard stops, hashtags (3.4, 4.6)
// =====================================================================================================================

export type CopyValue = { primary: string; headline: string; description?: string };

const WHERE_KEYS: Readonly<Record<TextCounter["platform"], PromoteCopyKey>> = {
  instagram: "copy.where.instagram",
  facebook: "copy.where.facebook",
  stories: "copy.where.stories",
  reels: "copy.where.reels",
  carousel: "copy.where.carousel",
};

export type CounterRow = TextCounter & {
  id: string;
  /** Past the visible length: the text is cut at "… more" there (guidance, never a block). */
  over: boolean;
  /** "Instagram: 120 of 125 show before "… more"". */
  text: string;
};

export type CopyOptions = { hasInstagramIdentity: boolean; format?: AdFormat; lang?: PromoteLang };

/** The visible-length counters per placement, straight from catalog/formats checkText. */
export function copyCounters(fields: TextFields, placements: readonly PlacementKey[], opts: CopyOptions): CounterRow[] {
  const lang = opts.lang ?? "en";
  return checkText(fields, placements, opts).counters.map((c) => ({
    ...c,
    id: `${c.field}-${c.platform}`,
    over: c.count > c.limit,
    text: promoteText("copy.counter", { where: promoteText(WHERE_KEYS[c.platform], {}, lang), count: c.count, limit: c.limit }, lang),
  }));
}

export type HashtagState = {
  count: number;
  max: number;
  over: boolean;
  /** Every hashtag in order; from the 31st on, `over` is true. */
  tags: { tag: string; index: number; over: boolean }[];
  /** The hashtags past the limit, which the member should remove. */
  flagged: string[];
};

/** The same pattern as catalog/formats countHashtags (a test keeps the two counts equal). */
const HASHTAG = /#[\p{L}\p{M}\p{N}_]+/gu;

/** The 30-hashtag counter (4.6): the 31st hashtag and every later one are flagged. */
export function hashtagState(text: string): HashtagState {
  const tags = Array.from(text.matchAll(HASHTAG), (m, i) => ({ tag: m[0], index: m.index ?? 0, over: i >= INSTAGRAM_HASHTAGS_MAX }));
  return { count: tags.length, max: INSTAGRAM_HASHTAGS_MAX, over: tags.length > INSTAGRAM_HASHTAGS_MAX, tags, flagged: tags.filter((t) => t.over).map((t) => t.tag) };
}

/**
 * The text cut to Instagram's 2,200 (counted as catalog/formats instagramLength counts), never inside a grapheme, so a
 * Devanagari conjunct or an emoji is never split. Trailing spaces are dropped.
 */
export function shortenForInstagram(text: string, max = INSTAGRAM_CAPTION_MAX): string {
  if (instagramLength(text) <= max) return text;
  let out = "";
  for (const g of graphemes(text)) {
    if (instagramLength(out + g) > max) break;
    out += g;
  }
  return out.trimEnd();
}

export type CopyFix = { kind: "shorten_instagram"; label: string };
export type CopyProblemView = { code: TextProblemCode; text: string; fix: CopyFix | null };
export type CopyCheck = {
  /** The ad shows on Instagram (a chosen Instagram place, or Automatic with an Instagram account). */
  instagram: boolean;
  counters: CounterRow[];
  /** Blocks: Start stays disabled until each is fixed. */
  problems: CopyProblemView[];
  blocked: boolean;
  instagramLength: { count: number; max: number; over: boolean };
  hashtags: HashtagState;
};

/**
 * Everything CopyFields shows: the counters, and Instagram's hard stops when the ad shows on Instagram. Past 2,200 the
 * stop carries the fix "Shorten to 2,200 characters for Instagram" (without it, Meta creates the ad and never shows it on
 * Instagram).
 */
export function copyCheck(fields: TextFields, placements: readonly PlacementKey[], opts: CopyOptions): CopyCheck {
  const lang = opts.lang ?? "en";
  const instagram = showsOnInstagram(placements, opts.hasInstagramIdentity);
  const checked = checkText(fields, placements, opts);
  const problems = checked.problems.map<CopyProblemView>((p) => ({
    code: p.code,
    text: p.text[lang] ?? p.text.en,
    fix: p.code === "caption_too_long" ? { kind: "shorten_instagram", label: promoteText("copy.shorten", {}, lang) } : null,
  }));
  const count = instagramLength(fields.primary);
  return {
    instagram,
    counters: copyCounters(fields, placements, opts),
    problems,
    blocked: problems.length > 0,
    instagramLength: { count, max: INSTAGRAM_CAPTION_MAX, over: instagram && count > INSTAGRAM_CAPTION_MAX },
    hashtags: hashtagState(fields.primary),
  };
}

/** The caption as a feed shows it: the first `limit` graphemes, then "… more" (the caller adds the copy). */
export function visibleCaption(text: string, limit: number): { text: string; truncated: boolean } {
  const parts = graphemes(text);
  if (parts.length <= limit) return { text, truncated: false };
  return { text: parts.slice(0, Math.max(0, limit)).join("").trimEnd(), truncated: true };
}

// =====================================================================================================================
// Crop (3.4, 7.3, D21)
// =====================================================================================================================

export const CROP_RATIOS = ["4:5", "9:16", "1:1"] as const;
export type CropRatio = (typeof CROP_RATIOS)[number];

const sizeOf = (s: readonly [number, number]): Size => ({ width: s[0], height: s[1] });

/** The exported sizes, from catalog/formats: feed 4:5, Stories and Reels 9:16, carousel 1:1. */
export const CROP_OUTPUT: Readonly<Record<CropRatio, Size>> = {
  "4:5": sizeOf(FORMAT_SPECS.feed.recommendedSize),
  "9:16": sizeOf(FORMAT_SPECS.stories.recommendedSize),
  "1:1": sizeOf(FORMAT_SPECS.carousel.recommendedSize),
};
export const CROP_LABEL_KEYS: Readonly<Record<CropRatio, PromoteCopyKey>> = { "4:5": "crop.ratio.feed", "9:16": "crop.ratio.tall", "1:1": "crop.ratio.square" };
export const CROP_MIME = "image/jpeg";
export const CROP_JPEG_QUALITY = 0.9;
export const CROP_MAX_ZOOM = 4;
export const CROP_ZOOM_STEP = 1.1;
/** An arrow press moves the picture by 2% of the crop (10% with Shift). */
export const CROP_MOVE_STEP = 0.02;
export const CROP_MOVE_STEP_LARGE = 0.1;
/** The crop upload goes to the content media library, marked as an ad crop (5.5). */
export const CROP_UPLOAD_PATH = "/api/content/media?purpose=ad_crop";

/** Width over height of a crop shape. */
export const cropAspect = (r: CropRatio): number => CROP_OUTPUT[r].width / CROP_OUTPUT[r].height;

/** Where the crop is: the shape, how far in (1 = the largest crop that fits), and its centre in picture pixels. */
export type CropState = { ratio: CropRatio; zoom: number; cx: number; cy: number };
export type CropRect = { x: number; y: number; width: number; height: number };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The largest rectangle of the shape that fits inside the picture. */
function fullCrop(src: Size, ratio: CropRatio): Size {
  const t = cropAspect(ratio);
  return src.width / src.height > t ? { width: src.height * t, height: src.height } : { width: src.width, height: src.width / t };
}

/** The crop in picture pixels: always inside the picture and always the exact shape. */
export function cropRect(src: Size, s: CropState): CropRect {
  const full = fullCrop(src, s.ratio);
  const zoom = clamp(Number.isFinite(s.zoom) ? s.zoom : 1, 1, CROP_MAX_ZOOM);
  const width = full.width / zoom;
  const height = full.height / zoom;
  return { x: clamp(s.cx - width / 2, 0, src.width - width), y: clamp(s.cy - height / 2, 0, src.height - height), width, height };
}

/** The state with its zoom in range and its centre where the crop really is (so a move past an edge doesn't stick). */
export function clampCrop(src: Size, s: CropState): CropState {
  const zoom = clamp(Number.isFinite(s.zoom) ? s.zoom : 1, 1, CROP_MAX_ZOOM);
  const r = cropRect(src, { ...s, zoom });
  return { ratio: s.ratio, zoom, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}

/** The largest crop of the shape, centred. */
export function initialCrop(src: Size, ratio: CropRatio): CropState {
  return clampCrop(src, { ratio, zoom: 1, cx: src.width / 2, cy: src.height / 2 });
}

/** Moves the crop by picture pixels. */
export function moveCrop(src: Size, s: CropState, dx: number, dy: number): CropState {
  return clampCrop(src, { ...s, cx: s.cx + dx, cy: s.cy + dy });
}

/** Zooms around the crop's centre (factor above 1 zooms in). */
export function zoomCrop(src: Size, s: CropState, factor: number): CropState {
  return clampCrop(src, { ...s, zoom: s.zoom * factor });
}

/** A new shape keeps the centre and starts from the largest crop. */
export function setCropRatio(src: Size, s: CropState, ratio: CropRatio): CropState {
  return clampCrop(src, { ratio, zoom: 1, cx: s.cx, cy: s.cy });
}

/**
 * A drag on the viewport, in screen pixels, as a crop move: dragging the picture right shows more of its left side, so
 * the crop moves left.
 */
export function dragCrop(src: Size, s: CropState, dxPx: number, dyPx: number, viewportWidthPx: number): CropState {
  if (!(viewportWidthPx > 0)) return s;
  const scale = cropRect(src, s).width / viewportWidthPx;
  return moveCrop(src, s, -dxPx * scale, -dyPx * scale);
}

export type CropKeyResult = { state: CropState; confirm: boolean; handled: boolean };

/**
 * The keyboard alternative (7.3): arrows move the picture (Shift for bigger moves), + and - zoom, Enter confirms. The
 * picture moves the way the arrow points, as with a drag.
 */
export function applyCropKey(src: Size, s: CropState, key: string, shift = false): CropKeyResult {
  const r = cropRect(src, s);
  const step = shift ? CROP_MOVE_STEP_LARGE : CROP_MOVE_STEP;
  switch (key) {
    case "ArrowLeft":
      return { state: moveCrop(src, s, r.width * step, 0), confirm: false, handled: true };
    case "ArrowRight":
      return { state: moveCrop(src, s, -r.width * step, 0), confirm: false, handled: true };
    case "ArrowUp":
      return { state: moveCrop(src, s, 0, r.height * step), confirm: false, handled: true };
    case "ArrowDown":
      return { state: moveCrop(src, s, 0, -r.height * step), confirm: false, handled: true };
    case "+":
    case "=":
      return { state: zoomCrop(src, s, CROP_ZOOM_STEP), confirm: false, handled: true };
    case "-":
    case "_":
      return { state: zoomCrop(src, s, 1 / CROP_ZOOM_STEP), confirm: false, handled: true };
    case "Enter":
      return { state: s, confirm: true, handled: true };
    default:
      return { state: s, confirm: false, handled: false };
  }
}

/** What the canvas draws: this part of the picture, onto the exact output size, as JPEG at 0.9. */
export function cropPlan(src: Size, s: CropState): { source: CropRect; output: Size; mime: string; quality: number } {
  return { source: cropRect(src, s), output: CROP_OUTPUT[s.ratio], mime: CROP_MIME, quality: CROP_JPEG_QUALITY };
}

/** True when the crop is smaller than the output, so the export is enlarged and may look blurry. */
export function cropUpscaled(src: Size, s: CropState): boolean {
  return cropRect(src, s).width < CROP_OUTPUT[s.ratio].width - 0.5;
}

/** Where the picture sits inside the viewport (which shows exactly the crop), as CSS percentages. */
export function cropImageStyle(src: Size, r: CropRect): { left: string; top: string; width: string; height: string } {
  const pct = (v: number) => `${Math.round(v * 10_000) / 10_000}%`;
  return { left: pct((-r.x / r.width) * 100), top: pct((-r.y / r.height) * 100), width: pct((src.width / r.width) * 100), height: pct((src.height / r.height) * 100) };
}

// =====================================================================================================================
// Safe zones (4.6, 7.3)
// =====================================================================================================================

export type SafeZoneGroup = "stories" | "reels";
export type SafeZone = {
  group: SafeZoneGroup;
  /** Fractions of the frame that Instagram and Facebook may cover. */
  top: number;
  bottom: number;
  sides: number;
  topPct: number;
  bottomPct: number;
  sidesPct: number;
  /** The text equivalent, one sentence per band. */
  lines: string[];
};

/** Top 14%, bottom 35% for Reels and 20% for Stories, 6% on each side: from catalog/formats. */
export function safeZoneFor(group: SafeZoneGroup, lang: PromoteLang = "en"): SafeZone {
  const z = FORMAT_SPECS[group].safeZone ?? { top: 0, bottom: 0, sides: 0 };
  const pct = (f: number) => Math.round(f * 100);
  return {
    group,
    top: z.top,
    bottom: z.bottom,
    sides: z.sides,
    topPct: pct(z.top),
    bottomPct: pct(z.bottom),
    sidesPct: pct(z.sides),
    lines: [promoteText("safe_zone.top", {}, lang), promoteText(group === "reels" ? "safe_zone.bottom_reels" : "safe_zone.bottom_stories", {}, lang), promoteText("safe_zone.sides", {}, lang)],
  };
}

/** The safe zone a placement shows, or null for feeds (no zone). */
export function safeZoneGroupOf(key: PlacementKey): SafeZoneGroup | null {
  const g = groupOfPlacement(key);
  return g === "stories" || g === "reels" ? g : null;
}

// =====================================================================================================================
// Budget steppers (3.7, 3.1a, D31)
// =====================================================================================================================

export const DAYS_MIN = MIN_RUN_DAYS;

/** Days go to 30, or to 90 under More options (D6). */
export const daysMax = (more: boolean): number => (more ? MAX_RUN_DAYS : SIMPLE_MAX_RUN_DAYS);

/** A whole number of days from 2 (D31) to the maximum. Anything unreadable is 2. */
export function clampDays(days: number, max: number): number {
  if (!Number.isFinite(days)) return DAYS_MIN;
  return clamp(Math.round(days), DAYS_MIN, Math.max(DAYS_MIN, Math.floor(max)));
}

export function stepDays(days: number, dir: 1 | -1, max: number): number {
  return clampDays(clampDays(days, max) + dir, max);
}

/**
 * The Days maximum the steppers use: 30, or 90 under More options. A longer run chosen under More stays as it is when More
 * closes (switching tiers never drops data, 7.5): the field shows the real number, which can go down but not up until More
 * is open again.
 */
export function daysLimit(days: number, more: boolean): number {
  const base = daysMax(more);
  return Number.isFinite(days) && days > base ? Math.min(Math.floor(days), MAX_RUN_DAYS) : base;
}

/** The Days field: the run length as it really is, never a clamped stand-in (the cost uses the same number). */
export const daysInputValue = (days: number): string => (Number.isFinite(days) ? String(days) : "");

/** ₹10 in INR; elsewhere the Phase 0 FX equivalent of ₹10 rounded up to a whole unit, or 1 unit without a rate (3.1a). */
export function stepperStep(currency: string, fromInr?: FromInr | null): bigint {
  return budgetStep(currency, fromInr);
}

export type DailyBounds = { minMinor?: bigint | null; maxMinor?: bigint | null };

/** The lowest daily budget: Meta's minimum when known, else one step. */
export function dailyFloor(stepMinor: bigint, bounds: DailyBounds = {}): bigint {
  return bounds.minMinor && bounds.minMinor > 0n ? bounds.minMinor : stepMinor;
}

export function clampDaily(valueMinor: bigint, stepMinor: bigint, bounds: DailyBounds = {}): bigint {
  const lo = dailyFloor(stepMinor, bounds);
  if (valueMinor < lo) return lo;
  if (bounds.maxMinor && bounds.maxMinor >= lo && valueMinor > bounds.maxMinor) return bounds.maxMinor;
  return valueMinor;
}

/**
 * One stepper press: up to the next multiple of the step (₹305 goes to ₹310), down to the one before (₹305 goes to ₹300),
 * `multiplier` steps at a time during a long press, never below the floor or above the cap.
 */
export function stepDaily(valueMinor: bigint, dir: 1 | -1, stepMinor: bigint, bounds: DailyBounds = {}, multiplier = 1): bigint {
  if (stepMinor <= 0n) return valueMinor;
  const jump = stepMinor * BigInt(Math.max(1, Math.floor(multiplier)));
  const v = valueMinor < 0n ? 0n : valueMinor;
  const next = dir > 0 ? (v / stepMinor) * stepMinor + jump : ((v + stepMinor - 1n) / stepMinor) * stepMinor - jump;
  return clampDaily(next, stepMinor, bounds);
}

/** A long press waits this long before it repeats. */
export const LONG_PRESS_DELAY_MS = 400;

/** The wait before repeat n (0-based): it speeds up the longer the button is held. */
export function repeatDelayMs(repeats: number): number {
  if (repeats < 5) return 180;
  if (repeats < 15) return 100;
  return 50;
}

/** Steps per repeat: after 25 repeats the daily budget moves 5 steps at a time. */
export const repeatMultiplier = (repeats: number): number => (repeats >= 25 ? 5 : 1);

export type Repeater = {
  /** A pointer press began: the first repeat comes after LONG_PRESS_DELAY_MS, then faster. */
  start(): void;
  /** The press ended, the button was disabled, or it went away. */
  stop(): void;
  /**
   * A click arrived: true when it should step once. A keyboard click (Enter or Space) always steps. A pointer click doesn't
   * when its own press already stepped by repeating.
   */
  click(keyboard: boolean): boolean;
  readonly running: boolean;
};

/**
 * The long-press timer of a stepper button. `onTick` steps once and says whether the value changed: a repeat that changes
 * nothing (the floor or the cap is reached) stops the timer, so it never keeps ticking under a disabled button that gets no
 * pointerup, and never steps again by itself once the value moves off the edge.
 */
export function createRepeater(onTick: (repeats: number) => boolean, timers: Timers = realTimers): Repeater {
  let handle: unknown = null;
  let repeats = 0;
  // Set by this press's repeats only; a new press clears it, so an old long press never swallows a later click.
  let repeated = false;
  const stop = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
  const tick = () => {
    handle = null;
    const changed = onTick(repeats);
    repeats += 1;
    repeated = true;
    if (changed) handle = timers.set(tick, repeatDelayMs(repeats));
  };
  return {
    start() {
      stop();
      repeats = 0;
      repeated = false;
      handle = timers.set(tick, LONG_PRESS_DELAY_MS);
    },
    stop,
    click(keyboard) {
      stop();
      const swallow = !keyboard && repeated;
      repeated = false;
      return !swallow;
    },
    get running() {
      return handle !== null;
    },
  };
}

/** "₹" for INR, "$" for USD: the symbol the "₹ per day" label shows. */
export function currencySymbol(currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

/** Minor units as the number field shows them: "310" for ₹310, "3.50" for $3.50. */
export function majorInputValue(minor: bigint, currency: string): string {
  const exp = currencyExponent(currency);
  const unit = 10n ** BigInt(exp);
  const whole = minor / unit;
  const frac = minor % unit;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(exp, "0")}`;
}

/** A typed amount ("310", "1,500", "₹310", "3.5") in minor units, or null when it isn't an amount. */
export function parseMajorInput(text: string, currency: string): bigint | null {
  const exp = currencyExponent(currency);
  // A leading currency sign ("₹310", "$3.50") is dropped; a minus sign is not, so a negative amount is refused.
  const clean = text.replace(/[,\s]/g, "").replace(/^[^\d.-]+/, "");
  const m = /^(\d{1,12})(?:\.(\d*))?$/.exec(clean);
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, exp).padEnd(exp, "0");
  return BigInt(m[1]) * 10n ** BigInt(exp) + BigInt(frac || "0");
}

export type StepButton = { next: bigint; disabled: boolean; label: string };

/** A daily-budget button: where it goes and its full-sentence label ("Increase daily budget to ₹310"). */
export function dailyButton(dir: 1 | -1, valueMinor: bigint, stepMinor: bigint, bounds: DailyBounds, currency: string, lang: PromoteLang = "en"): StepButton {
  const next = stepDaily(valueMinor, dir, stepMinor, bounds);
  const atEdge = dir > 0 ? (bounds.maxMinor !== null && bounds.maxMinor !== undefined && valueMinor >= bounds.maxMinor) || next <= valueMinor : valueMinor <= dailyFloor(stepMinor, bounds) || next >= valueMinor;
  if (atEdge) {
    // Name the limit itself (the floor or the cap), not the value, which may sit outside it while being typed.
    const edge = dir > 0 ? (bounds.maxMinor ?? valueMinor) : dailyFloor(stepMinor, bounds);
    return { next: valueMinor, disabled: true, label: promoteText(dir > 0 ? "budget.at_max" : "budget.at_min", { amount: formatMoney(edge, currency) }, lang) };
  }
  return { next, disabled: false, label: promoteText(dir > 0 ? "budget.increase" : "budget.decrease", { amount: formatMoney(next, currency) }, lang) };
}

export type DaysButton = { next: number; disabled: boolean; label: string };

/** A Days button: "Increase days to 8"; at the ends "The shortest run is 2 days". */
export function daysButton(dir: 1 | -1, days: number, max: number, lang: PromoteLang = "en"): DaysButton {
  const current = clampDays(days, max);
  const next = stepDays(current, dir, max);
  if (next === current) return { next: current, disabled: true, label: promoteText(dir > 0 ? "budget.days_at_max" : "budget.days_at_min", { days: current }, lang) };
  return { next, disabled: false, label: promoteText(dir > 0 ? "budget.days_increase" : "budget.days_decrease", { days: next }, lang) };
}

// =====================================================================================================================
// Cost line and limit chip (3.3, 3.7, 6.2)
// =====================================================================================================================

/** The cost line waits this long after the last change before it updates and is announced (3.7). */
export const COST_DEBOUNCE_MS = 600;

export type CostParams = {
  /** The daily total the stepper shows; with versions it is split fairly (3.8) and the cost uses the sum of the shares. */
  dailyMinor: bigint;
  versions?: number;
  runDays: number;
  startMode: StartMode;
  startsAt?: Date | null;
  /** The ad account's zone. */
  tz: string;
  currency: string;
  headroom?: CostHeadroom | null;
  kind?: "boost" | "ads";
  lang?: PromoteLang;
  now?: Date;
};

/** presentCost for the steppers' values, with the run dates from dates.ts. Null while the values can't make a run. */
export function computeCost(p: CostParams): CostView | null {
  if (p.dailyMinor <= 0n || !Number.isInteger(p.runDays) || p.runDays < MIN_RUN_DAYS) return null;
  const now = p.now ?? new Date();
  let dates: ReturnType<typeof runDates>;
  try {
    dates = runDates({ runDays: p.runDays, startMode: p.startMode, startsAt: p.startsAt ?? null, tz: p.tz, now });
  } catch {
    return null;
  }
  const split = splitDaily(p.dailyMinor, p.versions ?? 1, p.currency);
  if (split.confirmedTotalMinor <= 0n) return null;
  return presentCost({
    sets: split.shares.map((dailyMinor) => ({ dailyMinor })),
    startsAt: dates.startsAt,
    endsAt: dates.endsAt,
    tz: p.tz,
    headroom: p.headroom ?? { currency: p.currency, today: { left: null }, month: { left: null } },
    lang: p.lang ?? "en",
    currency: p.currency,
    kind: p.kind ?? "ads",
    now,
  });
}

/** A stable key for the values the cost depends on (bigints and dates included), for the debounce. */
export function costKey(p: CostParams): string {
  return [p.dailyMinor, p.versions ?? 1, p.runDays, p.startMode, p.startsAt?.toISOString() ?? "", p.tz, p.currency, p.headroom?.today.left ?? "", p.headroom?.month.left ?? "", p.kind ?? "ads", p.lang ?? "en"].join("|");
}

export type CostLineText = {
  /** "About ₹1,500 in total. At most ₹2,625, because Meta can spend up to 75% more on a busy day." */
  main: string;
  /** "Up to ₹2,100 in October and ₹525 in November." */
  byMonth: string;
  /** D32: "Money is set aside from today, although the ads start on 5 Nov." */
  setAside: string | null;
  monthCross: string | null;
};

export function costLineText(view: CostView): CostLineText {
  return { main: `${view.lines.about} ${view.lines.atMost}`, byMonth: view.lines.byMonth, setAside: view.lines.setAside, monthCross: view.lines.monthCross };
}

export type LimitLeft = { leftTodayMinor: bigint | null; leftMonthMinor: bigint | null; currency: string };

/** "₹1,475 left today · ₹17,900 left this month"; null without a daily limit (readiness shows that instead). */
export function limitChipText(left: LimitLeft, lang: PromoteLang = "en"): string | null {
  if (left.leftTodayMinor === null) return null;
  const today = formatMoney(left.leftTodayMinor, left.currency);
  if (left.leftMonthMinor === null) return promoteText("cost.left_today", { today }, lang);
  return promoteText("cost.left", { today, month: formatMoney(left.leftMonthMinor, left.currency) }, lang);
}

/** Warn when nothing is left today or this month; otherwise quiet. */
export function limitChipTone(left: LimitLeft): Tone {
  return left.leftTodayMinor === 0n || left.leftMonthMinor === 0n ? "warn" : "neutral";
}

export type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** Calls `fire` with the last pushed value once nothing new arrived for `ms`. */
export function createDebouncer<T>(ms: number, fire: (value: T) => void, timers: Timers = realTimers) {
  let handle: unknown = null;
  let pending: { value: T } | null = null;
  const run = () => {
    handle = null;
    const p = pending;
    pending = null;
    if (p) fire(p.value);
  };
  return {
    push(value: T) {
      pending = { value };
      if (handle !== null) timers.clear(handle);
      handle = timers.set(run, ms);
    },
    flush() {
      if (handle !== null) timers.clear(handle);
      run();
    },
    cancel() {
      if (handle !== null) timers.clear(handle);
      handle = null;
      pending = null;
    },
    get pending() {
      return pending !== null;
    },
  };
}

// =====================================================================================================================
// Placement previews (7.4, D18)
// =====================================================================================================================

/** A preview tab as the server answers it (POST /api/promote/previews). */
export type PreviewAnswer = Pick<PlacementPreview, "placement" | "source" | "approximate" | "src" | "reason" | "mock">;

/**
 * The tabs: Automatic shows Instagram Feed, Stories and Reels, then Facebook Feed, Stories and Reels. Chosen positions keep
 * that order for those six and add the others after them in catalog order. A position Meta never previews (null) is left out.
 */
export function previewTabs(placements: readonly PlacementKey[]): PlacementKey[] {
  if (placements.length === 0) return [...DEFAULT_PREVIEW_TABS];
  const chosen = new Set(placements.filter((k) => PREVIEW_AD_FORMATS[k] !== null));
  const first = DEFAULT_PREVIEW_TABS.filter((k) => chosen.has(k));
  const rest = PLACEMENT_KEYS.filter((k) => chosen.has(k) && !DEFAULT_PREVIEW_TABS.includes(k));
  return [...first, ...rest];
}

/** Arrow keys, Home and End over the tabs, wrapping. Null for keys that don't move. */
export function tabIndexForKey(count: number, current: number, key: string): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  return null;
}

/** A horizontal swipe: left goes to the next tab (1), right to the previous (-1). Short or mostly vertical moves are 0. */
export function swipeStep(dx: number, dy: number, threshold = 40): -1 | 0 | 1 {
  if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

export type PreviewPlan = "fetch" | "asked" | "local" | "cap";

/**
 * At most 6 Meta previews per review (D18), each asked lazily the first time its tab shows. A new review (another
 * version, or the ad changed) starts over. Positions without a Meta format, or previews switched to local, never ask.
 */
export function createPreviewLedger(max = MAX_META_PREVIEWS_PER_REVIEW) {
  let review: string | null = null;
  const asked = new Set<PlacementKey>();
  return {
    plan(reviewKey: string, tab: PlacementKey, mode: "meta" | "local" = "meta"): PreviewPlan {
      if (reviewKey !== review) {
        review = reviewKey;
        asked.clear();
      }
      if (mode === "local" || previewFormatFor(tab) === "local") return "local";
      if (asked.has(tab)) return "asked";
      if (asked.size >= max) return "cap";
      asked.add(tab);
      return "fetch";
    },
    get count() {
      return asked.size;
    },
  };
}

export const isHttpsUrl = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length > 4_096) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
};

/** "Meta's preview", or "Our preview (approximate)" when the server says the tab is approximate. */
export function previewLabel(approximate: boolean, lang: PromoteLang = "en"): string {
  return promoteText(approximate ? "preview.local" : "preview.meta", {}, lang);
}

export type PreviewDisplay = { kind: "meta"; src: string; label: string } | { kind: "local"; label: string; note: string | null };

const CAP_REASONS = new Set(["review_cap", "member_cap"]);
const FAILED_REASONS = new Set(["failed", "unsafe", "busy"]);

/**
 * What a tab shows: Meta's iframe only for a non-approximate Meta answer with an https src (the server already kept only
 * Meta's preview page); everything else is the local mock labelled "Our preview (approximate)", with why.
 */
export function previewDisplay(answer: PreviewAnswer | null, lang: PromoteLang = "en", plan?: PreviewPlan): PreviewDisplay {
  if (answer && !answer.approximate && answer.source === "meta" && isHttpsUrl(answer.src)) return { kind: "meta", src: answer.src, label: previewLabel(false, lang) };
  const reason = answer?.reason ?? null;
  let note: PromoteCopyKey | null = null;
  if (plan === "cap" || (reason && CAP_REASONS.has(reason))) note = "preview.cap";
  else if (reason && FAILED_REASONS.has(reason)) note = "preview.failed";
  else if (answer || plan === "local") note = "preview.local_note";
  return { kind: "local", label: previewLabel(true, lang), note: note ? promoteText(note, {}, lang) : null };
}

/** "Instagram Reels". */
export const placementLabel = (key: PlacementKey, lang: PromoteLang = "en"): string => promoteText(placementRow(key).nameKey, {}, lang);

/** The iframe's title: "Meta preview: Instagram Reels". */
export const iframeTitle = (key: PlacementKey, lang: PromoteLang = "en"): string => promoteText("preview.iframe_title", { position: placementLabel(key, lang) }, lang);

export type MockFrame = PreviewMock["frame"];

/** The local mock's frame and visible text for a position: the same rule as the server's (previews.ts mockFor). */
export function localMock(key: PlacementKey, carousel = false): PreviewMock {
  if (carousel) return { frame: "1:1", textLimit: FORMAT_SPECS.carousel.text.primary };
  const group = groupOfPlacement(key);
  if (group === "stories") return { frame: "9:16", textLimit: FORMAT_SPECS.stories.text.primary };
  if (group === "reels") return { frame: "9:16", textLimit: FORMAT_SPECS.reels.text.primary };
  const instagram = placementRow(key).platform === "instagram";
  return { frame: "4:5", textLimit: instagram ? FORMAT_SPECS.feed.text.instagramPrimary : FORMAT_SPECS.feed.text.facebookPrimary };
}

export const FRAME_ASPECT: Readonly<Record<MockFrame, number>> = { "4:5": 4 / 5, "9:16": 9 / 16, "1:1": 1 };

/**
 * Meta-style fill bars for media that isn't the frame's shape: `vertical` is the share of the frame above (and again
 * below) the media, `horizontal` the share left (and right). Zero when the shapes match within 1%.
 */
export function fillBars(media: Size | null | undefined, frame: MockFrame): { vertical: number; horizontal: number } {
  if (!media || !(media.width > 0) || !(media.height > 0)) return { vertical: 0, horizontal: 0 };
  const rm = media.width / media.height;
  const rf = FRAME_ASPECT[frame];
  if (Math.abs(rm - rf) / rf <= 0.01) return { vertical: 0, horizontal: 0 };
  return rm > rf ? { vertical: (1 - rf / rm) / 2, horizontal: 0 } : { vertical: 0, horizontal: (1 - rm / rf) / 2 };
}

/** The feed box for media: its own shape between 4:5 (taller is cropped to 4:5) and 1.91:1. */
export function feedAspect(media: Size | null | undefined, fallback: MockFrame): number {
  if (!media || !(media.width > 0) || !(media.height > 0)) return FRAME_ASPECT[fallback];
  return clamp(media.width / media.height, 4 / 5, 1.91);
}

// =====================================================================================================================
// Media picker (3.4, 4.8, D34)
// =====================================================================================================================

const ACTIVE: ReadonlySet<AdMediaStatus> = new Set<AdMediaStatus>(["pending", "uploading", "processing"]);

/** Still on its way to Meta, so the picker polls GET /api/promote/media/[id]. */
export const mediaIsActive = (m: Pick<AdMediaView, "status">): boolean => ACTIVE.has(m.status);

/**
 * The first problem that stops this ad using the file: a block about the file itself, or one about this request's places or
 * format (a 16:9 picture on a carousel card). prepare_ad_media sends nothing for a request it blocks.
 */
export function mediaBlock(m: Pick<AdMediaView, "problems">): AdMediaProblem | null {
  return m.problems.find((p) => p.severity === "block") ?? null;
}

/**
 * How long to wait before the next poll: Meta's video processing is slow, an image send is quick. Null: stop. A blocked file
 * is never polled: nothing is on its way for this ad, and the member has to choose or crop another file.
 */
export function mediaPollDelayMs(m: Pick<AdMediaView, "status" | "kind" | "problems">): number | null {
  if (!mediaIsActive(m) || mediaBlock(m)) return null;
  return m.status === "processing" ? 15_000 : 3_000;
}

/** Polling stops after this long (Meta's own limit is 30 minutes; the task then sends again). */
export const MEDIA_POLL_LIMIT_MS = 40 * 60_000;

/**
 * A polled GET /api/promote/media/[id] answer merged into the prepare answer on screen, or null when it says nothing new.
 *
 * The two answers are different views of one row: prepare's `problems` (and, with a block, its `message`) are about this
 * request's places and format, while GET answers the problems stored for Automatic places. So the poll brings the row's
 * progress (status, error, retry, Meta ids, file facts) and never replaces this request's problems or its block line.
 */
export function mergePolledMedia(current: AdMediaView, polled: AdMediaView): AdMediaView | null {
  if (current.id !== polled.id) return null;
  const block = mediaBlock(current);
  // An invalid row is a block about the file itself: its line is the row's own.
  const message = block && polled.status !== "invalid" ? current.message : polled.message;
  const extra = polled.status === "invalid" ? polled.problems.filter((p) => p.severity === "block" && !current.problems.some((q) => q.code === p.code)) : [];
  const next: AdMediaView = { ...polled, problems: extra.length > 0 ? [...current.problems, ...extra] : current.problems, message };
  const same =
    extra.length === 0 &&
    (["status", "ready", "message", "error", "attempts", "canRetry", "retryAt", "metaImageHash", "metaVideoId", "metaThumbHash", "updatedAt", "source", "sourceKey"] as const).every((k) => current[k] === next[k]);
  return same ? null : next;
}

export type MediaStatusLine = {
  text: string;
  tone: Tone;
  /** Still on its way to Meta for this ad: the line shows a spinner. */
  busy: boolean;
  /** The problem the line already says (the picker doesn't repeat it as an alert). */
  problemCode: string | null;
};

/**
 * The one status line under a chosen file, in the page's language where the server gave one. A block wins over every status
 * (a ready file this ad can't use is not "Ready"); a video Meta is still processing gets the 5-to-30-minutes line.
 */
export function mediaStatusLine(m: Pick<AdMediaView, "status" | "kind" | "message" | "error" | "problems">, lang: PromoteLang = "en"): MediaStatusLine {
  const block = mediaBlock(m);
  if (block) return { text: block.text[lang] ?? block.text.en, tone: "bad", busy: false, problemCode: block.code };
  if (m.status === "ready") return { text: m.message, tone: "good", busy: false, problemCode: null };
  if (m.status === "invalid" || m.status === "error") return { text: m.error || m.message, tone: "bad", busy: false, problemCode: null };
  if (m.kind === "video" && m.status === "processing") return { text: promoteText("error.media_not_ready", {}, lang), tone: "info", busy: true, problemCode: null };
  return { text: promoteText("media.picker.preparing", {}, lang), tone: "info", busy: true, problemCode: null };
}

/** The fit chips ("Feed 4:5 ✓", "Stories and Reels 9:16: missing") in the page's language. */
export function mediaChips(m: Pick<AdMediaView, "chips">, lang: PromoteLang = "en"): { key: string; ok: boolean; text: string }[] {
  return m.chips.map((c) => ({ key: c.group, ok: c.ok, text: c.text[lang] ?? c.text.en }));
}

export function mediaProblems(m: Pick<AdMediaView, "problems">, lang: PromoteLang = "en"): { code: string; block: boolean; text: string }[] {
  return m.problems.map((p) => ({ code: p.code, block: p.severity === "block", text: p.text[lang] ?? p.text.en }));
}

/** Where the browser loads a chosen file from: the content media library (uploads and crops) or Creative Studio. */
export function mediaFileUrl(m: Pick<AdMediaView, "source" | "sourceKey">): string {
  const key = encodeURIComponent(m.sourceKey);
  return m.source === "creative" ? `/api/creative/assets/${key}/file` : `/api/content/media/${key}`;
}

const IMAGE_KEY = /\.(jpe?g|png)$/i;
const VIDEO_KEY = /\.(mp4|mov)$/i;

/** Library files of the kind asked (JPG or PNG pictures, MP4 or MOV videos). */
export function libraryFilesOf<T extends { key: string; kind?: string }>(files: readonly T[], kind: "image" | "video"): T[] {
  return files.filter((f) => (f.kind === undefined || f.kind === kind) && (kind === "image" ? IMAGE_KEY : VIDEO_KEY).test(f.key));
}

/** A Creative Studio asset as GET /api/creative/briefs/[id] answers it (only the fields the picker reads). */
export type CreativeAssetLite = { id: string; kind: string; status: string; storageKey: string | null; headline?: string | null };
/** A brief as GET /api/creative/briefs answers it. */
export type CreativeBriefLite = { id: string; offer: string; goal?: string; brand?: { name: string } | null };

/** Creative Studio assets an ad can use: the kind asked, with a file, made and not rejected (media.ts refuses the rest). */
export function creativeAssetsOf<T extends CreativeAssetLite>(assets: readonly T[], kind: "image" | "video"): T[] {
  return assets.filter((a) => a.kind === kind && !!a.storageKey && (a.status === "ready" || a.status === "approved"));
}

/** "Sharma Sweets: Diwali boxes 20% off" cut to 60 characters, for the brief select. */
export function briefLabel(b: CreativeBriefLite): string {
  const text = [b.brand?.name, b.offer].filter((s): s is string => !!s && !!s.trim()).join(": ");
  const parts = graphemes(text);
  return parts.length > 60 ? `${parts.slice(0, 59).join("").trimEnd()}…` : text;
}

/** A file the member is about to upload, checked before any byte leaves the browser (4.6 file limits). */
export function uploadProblem(file: { type: string; size: number }, kind: "image" | "video", lang: PromoteLang = "en"): string | null {
  const mimes = kind === "image" ? FILE_LIMITS.imageMimes : FILE_LIMITS.videoMimes;
  const max = kind === "image" ? FILE_LIMITS.imageMaxBytes : FILE_LIMITS.videoMaxBytes;
  if (!mimes.includes(file.type)) return promoteText(kind === "image" ? "media.image_type" : "media.video_type", {}, lang);
  if (file.size > max) {
    const mb = (b: number) => `${Math.round((b / (1024 * 1024)) * 10) / 10} MB`;
    return promoteText("media.too_large", { size: mb(file.size), max: mb(max) }, lang);
  }
  return null;
}

export type PrepareSource = { from: "content" | "crop"; key: string } | { from: "creative"; assetId: string };

/** The body of POST /api/promote/media (prepare_ad_media): the library file and where the ad will show. */
export function prepareBody(src: PrepareSource, placements: readonly PlacementKey[], format?: AdFormat | null): Record<string, unknown> {
  const ref = src.from === "creative" ? { assetId: src.assetId } : { key: src.key };
  return { from: src.from, ...ref, placements: [...placements], ...(format ? { format } : {}) };
}

/**
 * "Add a tall version (9:16) for Stories and Reels" shows for a feed image that isn't 9:16 when the ad may show in Stories
 * or Reels (Automatic does) and no tall version is chosen yet.
 */
export function needsTallVersion(feed: Pick<AdMediaView, "kind" | "ratio"> | null, vertical: unknown, placements: readonly PlacementKey[]): boolean {
  if (!feed || vertical || feed.ratio === "9:16") return false;
  const groups = groupsOf(placements);
  return groups.has("stories") || groups.has("reels");
}

// =====================================================================================================================
// Ad step, versions and carousel (3.4, 3.8, 4.6)
// =====================================================================================================================

export type AdSource = "image" | "video" | "carousel" | "post";

/** The source tabs; Video is hidden while PROMOTE_VIDEO is off (D21). */
export function adSourceTabs(videoEnabled: boolean): AdSource[] {
  return videoEnabled ? ["image", "video", "carousel", "post"] : ["image", "carousel", "post"];
}

export const AD_SOURCE_KEYS: Readonly<Record<AdSource, PromoteCopyKey>> = {
  image: "ad.source.image",
  video: "ad.source.video",
  carousel: "ad.source.carousel",
  post: "ad.source.post",
};

export const VERSION_LETTERS = ["A", "B", "C"] as const;
export const canAddVersion = (count: number): boolean => count < MAX_VERSIONS;

/** What a saved ad shows: "Use a post" is a hand-over to Boost, never a saved source. */
export type AdStepSource = Exclude<AdSource, "post">;

/** One version's creative (3.8): version A is the draft's own; B and C are compared against it. */
export type AdVersionValue = { feed: AdMediaView | null; vertical: AdMediaView | null; text: CopyValue };

/**
 * The "Your ad" step's value, as the page saves it in the draft.
 *
 * Switching tabs never drops data (7.5), so the value can hold things the source doesn't use:
 * - `versions[i].feed` and `.vertical` may hold media of the other kind (a picture kept while the source is video). Only
 *   media of the source's kind applies.
 * - A carousel uses its `cards` and version A's text only. Versions B and C (and `cards` for a picture or video) are kept
 *   for when the member switches back, and never apply.
 * Flows read what applies with adStepInUse(value), never the raw value.
 */
export type AdStepValue = {
  source: AdStepSource;
  versions: AdVersionValue[];
  cards: CarouselCardValue[];
  /** null: the goal's default button (4.4). */
  ctaType: string | null;
};

export const emptyCopy = (): CopyValue => ({ primary: "", headline: "" });
export const emptyVersion = (): AdVersionValue => ({ feed: null, vertical: null, text: emptyCopy() });

const formatOfSource = (source: AdStepSource): AdFormat => (source === "video" ? "single_video" : source === "carousel" ? "carousel" : "single_image");

/** The source the step shows: the saved one, or the first allowed one when it isn't offered (a video draft while video is off). */
export function adStepSource(source: AdStepSource, videoEnabled: boolean): AdStepSource {
  const allowed = adSourceTabs(videoEnabled);
  return allowed.includes(source) ? source : (allowed.find((s): s is AdStepSource => s !== "post") ?? "image");
}

/** The step's own state: the version being edited and whether the "Use a post" panel is open. */
export type AdStepUi = { active: number; postOpen: boolean };

export type AdStepView = {
  /** The selected tab: always the value's (allowed) source, or "post" while that panel is open. */
  tab: AdSource;
  source: AdStepSource;
  kind: "image" | "video";
  format: AdFormat;
  /** The version the picture or video editor shows. */
  versionIndex: number;
  letter: (typeof VERSION_LETTERS)[number];
  /** The version whose text the text fields read and write: version A on a carousel, else the version being edited. */
  textIndex: number;
  text: CopyValue;
  /** The edited version's media of the source's kind (other-kind media is kept in the value, not shown). */
  feed: AdMediaView | null;
  vertical: AdMediaView | null;
};

/** Everything AdStep shows, derived from the value on every render (a draft loaded or changed later is shown as it is). */
export function adStepView(value: AdStepValue, ui: AdStepUi, videoEnabled: boolean): AdStepView {
  const source = adStepSource(value.source, videoEnabled);
  const kind = source === "video" ? "video" : "image";
  const count = Math.max(1, value.versions.length);
  const versionIndex = source === "carousel" ? 0 : Math.min(Math.max(0, Math.floor(ui.active) || 0), count - 1);
  const version = value.versions[versionIndex] ?? emptyVersion();
  const textIndex = source === "carousel" ? 0 : versionIndex;
  const ofKind = (m: AdMediaView | null) => (m && m.kind === kind ? m : null);
  return {
    tab: ui.postOpen ? "post" : source,
    source,
    kind,
    format: formatOfSource(source),
    versionIndex,
    letter: VERSION_LETTERS[versionIndex] ?? "A",
    textIndex,
    text: (value.versions[textIndex] ?? emptyVersion()).text,
    feed: ofKind(version.feed),
    vertical: ofKind(version.vertical),
  };
}

/** The value with one version changed (a missing version A is created first, so a write is never lost). */
export function patchVersion(value: AdStepValue, index: number, patch: Partial<AdVersionValue>): AdStepValue {
  const versions = value.versions.length > 0 ? value.versions : [emptyVersion()];
  if (index < 0 || index >= versions.length) return value;
  return { ...value, versions: versions.map((v, j) => (j === index ? { ...v, ...patch } : v)) };
}

/** What the ad really uses (see AdStepValue): flows build, cost and save the launch from this. */
export type AdStepInUse = { source: AdStepSource; format: AdFormat; versions: AdVersionValue[]; cards: CarouselCardValue[] };

export function adStepInUse(value: AdStepValue): AdStepInUse {
  const source = value.source;
  const first = value.versions[0] ?? emptyVersion();
  if (source === "carousel") return { source, format: "carousel", versions: [{ feed: null, vertical: null, text: first.text }], cards: value.cards };
  const kind = source === "video" ? "video" : "image";
  const ofKind = (m: AdMediaView | null) => (m && m.kind === kind ? m : null);
  const versions = (value.versions.length > 0 ? value.versions : [first]).slice(0, MAX_VERSIONS);
  return { source, format: formatOfSource(source), versions: versions.map((v) => ({ feed: ofKind(v.feed), vertical: ofKind(v.vertical), text: v.text })), cards: [] };
}

/** The goal's buttons, the default first, each with its label ("Send WhatsApp message"). */
export function ctaOptions(goal: GoalKey, lang: PromoteLang = "en"): { type: string; label: string }[] {
  return CTA_BY_GOAL[goal].types.map((type) => {
    const key = `cta.${type}`;
    return { type, label: isPromoteCopyKey(key) ? promoteText(key, {}, lang) : type };
  });
}

export type CarouselCardValue = { id: string; media: AdMediaView | null; headline: string; link: string };

export const CAROUSEL_LIMITS = Object.freeze({ min: CAROUSEL_MIN_CARDS, max: CAROUSEL_MAX_CARDS });
export const canAddCard = (count: number): boolean => count < CAROUSEL_MAX_CARDS;
export const canRemoveCard = (count: number): boolean => count > CAROUSEL_MIN_CARDS;

/** The list with one item moved; out-of-range moves return the same order. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

/** A card link must be https (empty is allowed while editing; the review catches a missing one). */
export function cardLinkProblem(link: string, lang: PromoteLang = "en"): string | null {
  const v = link.trim();
  if (!v) return null;
  return isHttpsUrl(v) ? null : promoteText("carousel.link_https", {}, lang);
}

// =====================================================================================================================
// Review reasons (3.9)
// =====================================================================================================================

/** The fix button of one review reason: "Edit the text", "Change the link", "Ask Meta to review again"... */
export function policyFixLabel(r: Pick<ExplainedReason, "fix" | "category">, lang: PromoteLang = "en"): string {
  switch (r.fix) {
    case "appeal":
      return promoteText("status.appeal", {}, lang);
    case "set_category": {
      const key = `category.${r.category ?? "credit"}`;
      return promoteText("policy.fix.set_category", { category: isPromoteCopyKey(key) ? promoteText(key, {}, lang) : (r.category ?? "") }, lang);
    }
    default:
      return promoteText(`policy.fix.${r.fix}` as PromoteCopyKey, {}, lang);
  }
}

/** "On Instagram" for a reason Meta gave for one platform only; null for the whole ad. */
export function policyWhere(placement: string | null, lang: PromoteLang = "en"): string | null {
  if (!placement) return null;
  const key = `results.platform.${placement.toLowerCase()}`;
  const platform = isPromoteCopyKey(key) ? promoteText(key, {}, lang) : placement;
  return promoteText("policy.where", { platform }, lang);
}

import { describe, expect, it } from "vitest";

/**
 * Format specs (docs/IG-PAGE-ADS-SPEC.md 4.6; PRM-02 acceptance 4): ratios with a 1% tolerance, minimum sizes, durations,
 * Instagram's 2,200-character and 30-hashtag blocks, carousels of 2 to 10 cards, and checkMedia's plain reasons in three
 * languages.
 */
import {
  carouselProblem,
  checkMedia,
  checkText,
  countGraphemes,
  countHashtags,
  fitChips,
  FORMAT_SPECS,
  inFeedRange,
  INSTAGRAM_CAPTION_MAX,
  INSTAGRAM_HASHTAGS_MAX,
  ratioLabel,
  ratioOf,
  showsOnInstagram,
} from "@/lib/promote/catalog";
import type { MediaProbe } from "@/lib/promote/types";

const image = (width: number, height: number, over: Partial<MediaProbe> = {}): MediaProbe => ({ kind: "image", mime: "image/jpeg", bytes: 500_000, width, height, ...over });
const video = (width: number, height: number, durationMs: number, over: Partial<MediaProbe> = {}): MediaProbe => ({
  kind: "video",
  mime: "video/mp4",
  bytes: 20_000_000,
  width,
  height,
  durationMs,
  videoCodec: "avc1",
  rotation: 0,
  ...over,
});
const codes = (p: MediaProbe, placements: Parameters<typeof checkMedia>[1] = [], format?: Parameters<typeof checkMedia>[2]) => checkMedia(p, placements, format).problems.map((x) => x.code);

describe("ratios (1% tolerance)", () => {
  it("matches the four ratios within 1% and nothing beyond", () => {
    expect(ratioOf(1080, 1080)).toBe("1:1");
    expect(ratioOf(1080, 1350)).toBe("4:5");
    expect(ratioOf(1440, 1800)).toBe("4:5");
    expect(ratioOf(1080, 1920)).toBe("9:16");
    expect(ratioOf(1910, 1000)).toBe("1.91:1");
    // Within 1%.
    expect(ratioOf(1090, 1080)).toBe("1:1");
    expect(ratioOf(1080, 1360)).toBe("4:5");
    expect(ratioOf(1080, 1905)).toBe("9:16");
    // Just beyond 1%.
    expect(ratioOf(1100, 1080)).toBe("other");
    expect(ratioOf(1080, 1380)).toBe("other");
    expect(ratioOf(1080, 1880)).toBe("other");
    expect(ratioOf(0, 100)).toBe("other");
  });

  it("applies the video's rotation first", () => {
    expect(ratioOf(1920, 1080, 90)).toBe("9:16");
    expect(ratioOf(1920, 1080, 270)).toBe("9:16");
    expect(ratioOf(1920, 1080, 180)).toBe("other");
    expect(checkMedia(video(1920, 1080, 10_000, { rotation: 90 }), ["instagram_reels"]).ratio).toBe("9:16");
  });
});

describe("sizes, files and durations", () => {
  it("holds the 4.6 table", () => {
    expect(FORMAT_SPECS.feed).toMatchObject({ recommendedRatio: "4:5", recommendedSize: [1080, 1350], minWidth: 500 });
    expect(FORMAT_SPECS.stories).toMatchObject({ recommendedRatio: "9:16", recommendedSize: [1080, 1920], safeZone: { top: 0.14, bottom: 0.2, sides: 0.06 } });
    expect(FORMAT_SPECS.reels).toMatchObject({ safeZone: { top: 0.14, bottom: 0.35, sides: 0.06 }, text: { primary: 44 } });
    expect(FORMAT_SPECS.carousel).toMatchObject({ recommendedSize: [1080, 1080], text: { primary: 80, headline: 20, description: 18 } });
    expect(FORMAT_SPECS.feed.text).toEqual({ instagramPrimary: 125, instagramHeadline: 40, facebookPrimary: 50, facebookHeadline: 27 });
  });

  it("refuses anything narrower than 500 px, after rotation", () => {
    expect(codes(image(499, 499), ["facebook_feed"])).toContain("too_small");
    expect(codes(image(500, 500), ["facebook_feed"])).not.toContain("too_small");
    expect(codes(video(1080, 480, 5_000, { rotation: 90 }), ["facebook_feed"])).toContain("too_small");
  });

  it("refuses the wrong file types, codecs and sizes, and unreadable dimensions", () => {
    expect(codes(image(1080, 1350, { mime: "image/webp" }), ["facebook_feed"])).toContain("image_type");
    expect(codes(image(1080, 1350, { bytes: 9 * 1024 * 1024 }), ["facebook_feed"])).toContain("too_large");
    expect(codes(video(1080, 1920, 10_000, { mime: "video/webm" }), ["instagram_reels"])).toContain("video_type");
    expect(codes(video(1080, 1920, 10_000, { videoCodec: "hvc1" }), ["instagram_reels"])).not.toContain("codec");
    expect(codes(video(1080, 1920, 10_000, { videoCodec: "av01" }), ["instagram_reels"])).toContain("codec");
    expect(codes(video(1080, 1920, 10_000, { bytes: 101 * 1024 * 1024 }), ["instagram_reels"])).toContain("too_large");
    expect(codes(image(1080, 1350, { width: null }), ["facebook_feed"])).toEqual(["no_size"]);
  });

  it("checks durations: at least 1 s, Stories split after 60 s, Reels at most 15 minutes", () => {
    expect(codes(video(1080, 1920, 900), ["instagram_stories"])).toContain("too_short");
    expect(codes(video(1080, 1920, 60_000), ["instagram_stories"])).not.toContain("story_long");
    expect(codes(video(1080, 1920, 60_001), ["instagram_stories"])).toContain("story_long");
    expect(checkMedia(video(1080, 1920, 61_000), ["instagram_stories"]).problems.find((p) => p.code === "story_long")!.severity).toBe("warn");
    expect(codes(video(1080, 1920, 15 * 60_000), ["instagram_reels"])).not.toContain("reel_too_long");
    expect(codes(video(1080, 1920, 15 * 60_000 + 1_000), ["instagram_reels"])).toContain("reel_too_long");
    expect(codes(video(1080, 1920, 120_000), ["facebook_feed"])).toEqual(["feed_tall"]);
  });

  it("checks feed ratios and gives the fit chips", () => {
    // 4:3 is inside the feeds' 4:5 to 1.91:1 range: it runs, with a hint.
    expect(codes(image(1200, 900), ["facebook_feed"])).toEqual(["feed_ratio_other"]);
    expect(codes(image(1080, 1350), ["facebook_feed"])).toEqual([]);
    const tall = checkMedia(image(1080, 1920), ["instagram_stories"]);
    expect(tall.fits).toEqual(["stories_reels"]);
    expect(tall.problems).toEqual([]);
    const square = checkMedia(image(1080, 1080), ["facebook_feed", "instagram_reels"]);
    expect(square.fits).toEqual(["feed", "carousel"]);
    expect(fitChips(square).map((c) => c.text.en)).toEqual(["Feed 1:1 ✓", "Stories and Reels 9:16: missing"]);
    expect(fitChips(tall).map((c) => c.text.hinglish)).toEqual(["Feed 4:5: nahi hai", "Stories aur Reels 9:16 ✓"]);
    expect(codes(image(1080, 1350), [], { format: "carousel" })).toEqual([]);
    expect(codes(image(1080, 1920), [], { format: "carousel" })).toContain("ratio_feed");
  });

  it("names shapes as people know them, never pixels", () => {
    expect(ratioLabel(1920, 1080)).toBe("16:9");
    expect(ratioLabel(1280, 720)).toBe("16:9");
    expect(ratioLabel(1200, 900)).toBe("4:3");
    expect(ratioLabel(1500, 1000)).toBe("3:2");
    expect(ratioLabel(1000, 1500)).toBe("2:3");
    expect(ratioLabel(1080, 1350)).toBe("4:5");
    expect(ratioLabel(1910, 1000)).toBe("1.91:1");
    expect(ratioLabel(2350, 1000)).toBe("21:9");
    expect(ratioLabel(2500, 1000)).toBe("2.5:1");
    expect(ratioLabel(1000, 1700)).toBe("1:1.7");
    expect(ratioLabel(1920, 1080, 90)).toBe("9:16");
    expect(ratioLabel(1080, 1920, 90)).toBe("16:9");
    expect(ratioLabel(0, 100)).toBe("other");
  });

  it("takes any feed shape from 4:5 to 1.91:1, and hints at 4:5 or 1:1 (Meta's guide)", () => {
    expect(inFeedRange(16 / 9)).toBe(true);
    expect(inFeedRange(4 / 3)).toBe(true);
    expect(inFeedRange(0.8)).toBe(true);
    expect(inFeedRange(1.91)).toBe(true);
    expect(inFeedRange(2)).toBe(false);
    expect(inFeedRange(2 / 3)).toBe(false);
    for (const [w, h] of [[1200, 900], [1500, 1000], [1250, 1000]] as const) {
      const check = checkMedia(image(w, h), ["instagram_feed", "facebook_feed"]);
      expect(check.problems.map((p) => [p.code, p.severity]), `${w}x${h}`).toEqual([["feed_ratio_other", "warn"]]);
      expect(check.fits).toContain("feed");
    }
    const threeTwo = checkMedia(image(1500, 1000), ["facebook_feed"]);
    expect(threeTwo.label).toBe("3:2");
    expect(threeTwo.problems[0].text.en).toBe("This image is 3:2. Feeds show 4:5 or 1:1 best; crop it to 4:5 for a bigger ad.");
    expect(fitChips(threeTwo)[0].text.en).toBe("Feed 3:2 ✓");
  });

  it("never blocks a 16:9 video in feeds, and never asks to crop a video (D21)", () => {
    const landscape = checkMedia(video(1920, 1080, 15_000), ["facebook_feed", "instagram_feed"]);
    expect(landscape.problems.map((p) => [p.code, p.severity])).toEqual([["video_feed_ratio_other", "warn"]]);
    expect(landscape.problems[0].text).toEqual({
      en: "This video is 16:9. Feeds show 4:5 or 1:1 best; upload a 4:5 or 1:1 version if you have one.",
      hi: "यह वीडियो 16:9 है। फ़ीड में 4:5 या 1:1 सबसे अच्छे दिखते हैं; अगर आपके पास 4:5 या 1:1 वर्ज़न है तो उसे अपलोड करें।",
      hinglish: "Ye video 16:9 hai. Feeds mein 4:5 ya 1:1 sabse acche dikhte hain; agar aapke paas 4:5 ya 1:1 version hai to use upload karein.",
    });
    expect(landscape.fits).toEqual(["feed"]);
    expect(fitChips(landscape)[0].text.en).toBe("Feed 16:9 ✓");
    // Taller than 4:5: feeds show it cropped to 4:5, so a warning.
    expect(checkMedia(video(1000, 1500, 15_000), ["facebook_feed"]).problems.map((p) => [p.code, p.severity])).toEqual([["feed_tall", "warn"]]);
    // Wider than 1.91:1: another version, not a crop.
    const wide = checkMedia(video(2500, 1000, 15_000), ["facebook_feed"]).problems;
    expect(wide.map((p) => [p.code, p.severity])).toEqual([["video_ratio_feed", "block"]]);
    expect(wide[0].text.en).toBe("This video is 2.5:1. Feeds take 4:5 to 1.91:1, and videos can't be cropped here; upload a 4:5 or 1:1 version.");
    const card = checkMedia(video(1920, 1080, 15_000), [], { format: "carousel" }).problems;
    expect(card.map((p) => [p.code, p.severity])).toEqual([["video_ratio_feed", "block"]]);
    expect(card[0].text.en).toBe("This video is 16:9. Carousel cards take 1:1 or 4:5, and videos can't be cropped here; upload a 1:1 or 4:5 version.");
    // Every video reason, whatever the shape and placement: no crop request and no pixel size.
    const where: [Parameters<typeof checkMedia>[1], Parameters<typeof checkMedia>[2]][] = [
      [["facebook_feed", "instagram_stories", "instagram_reels"], {}],
      [[], { format: "carousel" }],
    ];
    for (const [w, h] of [[1920, 1080], [2500, 1000], [2350, 1000], [1000, 1500], [1080, 1080], [1200, 900], [1080, 1920]] as const) {
      for (const [placements, opts] of where) {
        for (const p of checkMedia(video(w, h, 15_000), placements, opts).problems) {
          for (const t of Object.values(p.text)) {
            expect(t, `${w}x${h} ${p.code}`).not.toMatch(/crop (it|this)|crop karein|क्रॉप करें/i);
            expect(t, `${w}x${h} ${p.code}`).not.toMatch(/\d+x\d+/);
          }
        }
      }
    }
  });

  it("blocks an image outside 4:5 to 1.91:1 with a crop it can do", () => {
    const tall = checkMedia(image(1000, 1500), ["facebook_feed"]).problems;
    expect(tall.map((p) => [p.code, p.severity])).toEqual([["ratio_feed", "block"]]);
    expect(tall[0].text.en).toBe("This image is 2:3. Feeds take 4:5 to 1.91:1, so crop it to 4:5.");
    expect(checkMedia(image(2350, 1000), ["facebook_feed"]).problems.map((p) => p.code)).toEqual(["ratio_feed"]);
    expect(checkMedia(image(1080, 1920), [], { format: "carousel" }).problems[0].text.en).toBe("This image is 9:16. Carousel cards take 1:1 or 4:5, so crop it to 1:1.");
    expect(checkMedia(image(1920, 1080), ["instagram_stories"]).problems[0].text.en).toBe("This image is 16:9. Stories and Reels look best at 9:16; add a tall version.");
  });
});

describe("checkMedia's three plain reasons in three languages (4.6)", () => {
  it("a square image for Stories and Reels: add a tall version", () => {
    const p = checkMedia(image(1080, 1080), ["instagram_stories", "instagram_reels"]).problems.find((x) => x.code === "not_tall")!;
    expect(p.severity).toBe("warn");
    expect(p.text).toEqual({
      en: "This image is 1:1. Stories and Reels look best at 9:16; add a tall version.",
      hi: "यह तस्वीर 1:1 है। स्टोरीज़ और रील्स 9:16 में सबसे अच्छे दिखते हैं; लंबा वर्ज़न जोड़ें।",
      hinglish: "Ye image 1:1 hai. Stories aur Reels 9:16 mein sabse acche dikhte hain; lamba version jodein.",
    });
  });

  it("a 3 min 10 s video for Stories", () => {
    const p = checkMedia(video(1080, 1920, 190_000), ["instagram_stories"]).problems.find((x) => x.code === "story_long")!;
    expect(p.text).toEqual({
      en: "This video is 3 min 10 s; Stories show at most 60 s per card.",
      hi: "यह वीडियो 3 मिनट 10 सेकंड का है; स्टोरीज़ एक कार्ड में ज़्यादा से ज़्यादा 60 सेकंड दिखाती हैं।",
      hinglish: "Ye video 3 min 10 sec ka hai; Stories ek card mein zyada se zyada 60 sec dikhati hain.",
    });
  });

  it("a VP9 video", () => {
    const p = checkMedia(video(1080, 1920, 10_000, { videoCodec: "vp09" }), ["instagram_reels"]).problems.find((x) => x.code === "codec")!;
    expect(p.severity).toBe("block");
    expect(p.text).toEqual({
      en: "This video uses VP9. Upload MP4 (H.264) instead.",
      hi: "यह वीडियो VP9 में है। इसकी जगह MP4 (H.264) अपलोड करें।",
      hinglish: "Ye video VP9 mein hai. Iski jagah MP4 (H.264) upload karein.",
    });
  });
});

describe("text (4.6, 3.4)", () => {
  const ig = ["instagram_feed"] as const;

  it("blocks captions over 2,200 characters only when the ad shows on Instagram", () => {
    const at = "a".repeat(INSTAGRAM_CAPTION_MAX);
    const over = "a".repeat(INSTAGRAM_CAPTION_MAX + 1);
    expect(checkText({ primary: at }, [...ig], { hasInstagramIdentity: true }).problems).toEqual([]);
    const p = checkText({ primary: over }, [...ig], { hasInstagramIdentity: true }).problems;
    expect(p.map((x) => x.code)).toEqual(["caption_too_long"]);
    expect(p[0].text.en).toBe("Shorten to 2,200 characters for Instagram.");
    expect(checkText({ primary: over }, ["facebook_feed"], { hasInstagramIdentity: true }).problems).toEqual([]);
    // Automatic shows on Instagram when there is an identity.
    expect(checkText({ primary: over }, [], { hasInstagramIdentity: true }).problems.map((x) => x.code)).toEqual(["caption_too_long"]);
    expect(checkText({ primary: over }, [], { hasInstagramIdentity: false }).problems).toEqual([]);
    expect(showsOnInstagram(["threads_stream"], true)).toBe(true);
  });

  it("never lets an emoji push a caption past Instagram's own count", () => {
    const emoji = "😀".repeat(1_101); // 1,101 code points, 2,202 UTF-16 units
    expect(checkText({ primary: emoji }, [...ig], { hasInstagramIdentity: true }).problems.map((x) => x.code)).toEqual(["caption_too_long"]);
  });

  it("blocks more than 30 hashtags", () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(" ");
    expect(countHashtags(tags(30))).toBe(30);
    expect(countHashtags("#दिवाली #sale_2026 # notatag")).toBe(2);
    expect(checkText({ primary: tags(INSTAGRAM_HASHTAGS_MAX) }, [...ig], { hasInstagramIdentity: true }).problems).toEqual([]);
    const p = checkText({ primary: tags(31) }, [...ig], { hasInstagramIdentity: true }).problems;
    expect(p.map((x) => x.code)).toEqual(["too_many_hashtags"]);
    expect(p[0].text.en).toBe("Instagram allows at most 30 hashtags. This has 31.");
  });

  it("counts visible length in graphemes, so Devanagari counts as people see it", () => {
    // 6 code points; 4 clusters under older ICU, 3 since Unicode 15.1 joins the conjunct. Either way fewer than code points.
    const namaste = countGraphemes("नमस्ते");
    expect([3, 4]).toContain(namaste);
    expect(Array.from("नमस्ते")).toHaveLength(6);
    expect(countGraphemes("👍🏽")).toBe(1);
    const { counters } = checkText({ primary: "नमस्ते", headline: "Hi" }, ["instagram_feed", "facebook_feed", "instagram_stories", "instagram_reels"], { hasInstagramIdentity: true });
    expect(counters).toEqual([
      { field: "primary", platform: "instagram", count: namaste, limit: 125 },
      { field: "headline", platform: "instagram", count: 2, limit: 40 },
      { field: "primary", platform: "facebook", count: namaste, limit: 50 },
      { field: "headline", platform: "facebook", count: 2, limit: 27 },
      { field: "primary", platform: "stories", count: namaste, limit: 125 },
      { field: "primary", platform: "reels", count: namaste, limit: 44 },
    ]);
    const carousel = checkText({ primary: "x", headline: "y", description: "z" }, [], { hasInstagramIdentity: true, format: "carousel" }).counters;
    expect(carousel.map((c) => c.limit)).toEqual([80, 20, 18]);
  });
});

describe("carousel cards (4.6)", () => {
  it("takes 2 to 10 cards", () => {
    expect(carouselProblem(1)?.text.en).toBe("A carousel needs 2 to 10 cards.");
    expect(carouselProblem(2)).toBeNull();
    expect(carouselProblem(10)).toBeNull();
    expect(carouselProblem(11)?.key).toBe("carousel.cards");
    expect(carouselProblem(0)?.text.hi).toBe("कैरोसेल में 2 से 10 कार्ड चाहिए।");
  });
});

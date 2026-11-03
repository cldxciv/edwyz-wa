import { describe, expect, it } from "vitest";

/**
 * The copy catalogue (docs/IG-PAGE-ADS-SPEC.md 3.13, 4.10, 8.3a, D23; PRM-02 acceptance 5, 6, 9): identical keys and
 * placeholders in English, Hindi and Hinglish, no Phase 0 banned word and no Meta jargon, the 3.13 table word for word,
 * Indian digit grouping, and at least 25 review-reason codes with a fix kind.
 */
import { BANNED_COPY_WORDS } from "@/lib/spend/copy";
import {
  formatCount,
  formatDayKey,
  formatDuration,
  formatPeopleRange,
  joinList,
  monthName,
  pageLang,
  placeholders,
  PROMOTE_COPY,
  promoteText,
  promoteTextAll,
  type PromoteCopyKey,
} from "@/lib/promote/copy";
import {
  classifyMetaError,
  explainReviewFeedback,
  META_ERRORS,
  metaErrorText,
  normalizeFeedbackCode,
  OTHER_REASON,
  PROMOTE_ERROR_KINDS,
  REVIEW_REASONS,
  reviewReasonOf,
  reviewReasonTexts,
} from "@/lib/promote/review-reasons";
import { META_SCREEN_KEYS, PROMOTE_LANGS, READINESS_CHECKS, REVIEW_FIX_KINDS } from "@/lib/promote/types";
import { AUDIENCE_TERMS_1870090, AUDIENCE_TERMS_2655, LEADGEN_TOS_ERROR } from "./helpers/fake-meta-promote";

const META_JARGON = ["objective", "ad set", "CPM", "Advantage+"];
const KEYS = Object.keys(PROMOTE_COPY.en) as PromoteCopyKey[];

describe("one key union in three languages", () => {
  it("has identical key sets", () => {
    expect(KEYS.length).toBeGreaterThan(300);
    for (const lang of PROMOTE_LANGS) expect(Object.keys(PROMOTE_COPY[lang]).sort(), lang).toEqual([...KEYS].sort());
  });

  it("has the same placeholders for every key in every language, and no empty or padded string", () => {
    for (const key of KEYS) {
      const want = placeholders(PROMOTE_COPY.en[key]);
      for (const lang of PROMOTE_LANGS) {
        const t = PROMOTE_COPY[lang][key];
        expect(placeholders(t), `${lang} ${key}`).toEqual(want);
        expect(t.trim(), `${lang} ${key}`).toBe(t);
        expect(t.length, `${lang} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("writes Hindi in Devanagari", () => {
    const deva = KEYS.filter((k) => /\p{Script=Devanagari}/u.test(PROMOTE_COPY.hi[k]));
    expect(deva.length / KEYS.length).toBeGreaterThan(0.85);
    expect(KEYS.filter((k) => /\p{Script=Devanagari}/u.test(PROMOTE_COPY.hinglish[k]))).toEqual([]);
  });
});

describe("plain words (3.1, 3.13)", () => {
  it.each(PROMOTE_LANGS.map((l) => [l] as const))("%s has no Phase 0 banned word and no Meta jargon", (lang) => {
    for (const key of KEYS) {
      const t = PROMOTE_COPY[lang][key].toLowerCase();
      for (const w of [...BANNED_COPY_WORDS, ...META_JARGON]) expect(t.includes(w.toLowerCase()), `${lang} ${key}: ${w}`).toBe(false);
    }
  });

  it("includes the full Phase 0 list in the check", () => {
    expect([...BANNED_COPY_WORDS]).toEqual(["minor units", "spend_cap", "allowance pot", "commitment", "probation"]);
  });
});

describe("the 3.13 table, word for word", () => {
  const amount = (rupees: number) => ({ minor: BigInt(rupees) * 100n, currency: "INR" });
  const rows: [PromoteCopyKey, Record<string, unknown>, string, string, string][] = [
    ["card.boost.title", { days: 5 }, "Boost your reel for 5 days?", "अपनी रील 5 दिन के लिए बूस्ट करें?", "Apni reel 5 din ke liye boost karein?"],
    ["card.boost.start", { amount: amount(2_625) }, "Start boost · up to ₹2,625", "बूस्ट शुरू करें · अधिकतम ₹2,625", "Boost shuru karein · zyada se zyada ₹2,625"],
    [
      "cost.about_at_most",
      { about: amount(1_500), atMost: amount(2_625) },
      "About ₹1,500 in total. At most ₹2,625, because Meta can spend up to 75% more on a busy day.",
      "कुल लगभग ₹1,500. ज़्यादा से ज़्यादा ₹2,625, क्योंकि व्यस्त दिन पर Meta 75% तक ज़्यादा खर्च कर सकता है।",
      "Total lagbhag ₹1,500. Zyada se zyada ₹2,625, kyunki busy din par Meta 75% tak zyada kharch kar sakta hai.",
    ],
    ["goal.question", {}, "What should people do after seeing it?", "देखने के बाद लोग क्या करें?", "Dekhne ke baad log kya karein?"],
    ["audience.meta_finds", {}, "Let Meta find people (recommended)", "Meta को लोग ढूँढने दें (सुझाया गया)", "Meta ko log dhoondhne dein (recommended)"],
    ["goal.ig_dm.note", {}, "Replies happen in the Instagram app for now.", "जवाब अभी Instagram ऐप में ही होंगे।", "Replies abhi Instagram app mein hi honge."],
    [
      "opens_meta.sentence",
      {},
      "Meta doesn't let apps do this, so it opens in Meta. Come back here after.",
      "Meta ऐप्स को यह करने नहीं देता, इसलिए यह Meta में खुलेगा। उसके बाद यहाँ वापस आएँ।",
      "Meta apps ko ye karne nahi deta, isliye ye Meta mein khulega. Uske baad yahan wapas aayein.",
    ],
    [
      "form.privacy_help",
      {},
      "Meta needs a link to your privacy policy. Edwyz can't host one for you.",
      "Meta को आपकी प्राइवेसी पॉलिसी का लिंक चाहिए। Edwyz इसे आपके लिए होस्ट नहीं कर सकता।",
      "Meta ko aapki privacy policy ka link chahiye. Edwyz ise aapke liye host nahi kar sakta.",
    ],
    [
      "version.fair",
      {},
      "Fair test: each version gets the same budget. Meta may sometimes show both to the same person.",
      "निष्पक्ष टेस्ट: हर वर्ज़न को बराबर बजट मिलता है। Meta कभी-कभी दोनों एक ही व्यक्ति को दिखा सकता है।",
      "Fair test: har version ko barabar budget milta hai. Meta kabhi-kabhi dono ek hi insaan ko dikha sakta hai.",
    ],
    [
      "audience.upload",
      { count: 1_240 },
      "Share 1,240 contacts with Meta to find them on Facebook and Instagram. Phone numbers and emails are scrambled (hashed) before they leave Edwyz.",
      "1,240 संपर्क Meta के साथ साझा करें ताकि वे Facebook और Instagram पर मिल सकें। फ़ोन नंबर और ईमेल Edwyz से निकलने से पहले स्क्रैम्बल (हैश) किए जाते हैं।",
      "1,240 contacts Meta ke saath share karein taaki woh Facebook aur Instagram par mil sakein. Phone number aur email Edwyz se nikalne se pehle scramble (hash) kiye jaate hain.",
    ],
  ];

  it.each(rows)("%s", (key, vars, en, hi, hinglish) => {
    const kind = { en: "reel", hi: "रील", hinglish: "reel" } as const;
    for (const [lang, want] of [["en", en], ["hi", hi], ["hinglish", hinglish]] as const) {
      expect(promoteText(key, { kind: kind[lang], ...(vars as Record<string, never>) }, lang)).toBe(want);
    }
  });

  it("cost.by_month and cost.month_cross", () => {
    const oct = { minor: 210_000n, currency: "INR" };
    const nov = { minor: 52_500n, currency: "INR" };
    for (const [lang, byMonth, cross] of [
      ["en", "Up to ₹2,100 in October and ₹525 in November.", "November's part is set aside on 1 Nov. If November's limit is lower, the boost may pause then."],
      ["hi", "अक्टूबर में अधिकतम ₹2,100 और नवंबर में ₹525।", "नवंबर का हिस्सा 1 नवंबर को अलग रखा जाएगा। अगर नवंबर की सीमा कम है, तो बूस्ट तब रुक सकता है।"],
      ["hinglish", "October mein zyada se zyada ₹2,100 aur November mein ₹525.", "November ka hissa 1 Nov ko alag rakha jayega. Agar November ki limit kam hai, to boost tab ruk sakta hai."],
    ] as const) {
      expect(promoteText("cost.by_month", { first: oct, firstMonth: monthName("2026-10", lang), second: nov, secondMonth: monthName("2026-11", lang) }, lang)).toBe(byMonth);
      expect(promoteText("cost.month_cross", { month: monthName(11, lang), date: formatDayKey("2026-11-01", lang) }, lang)).toBe(cross);
    }
  });

  it("review.rejected for personal attributes", () => {
    const [en] = explainReviewFeedback({ global: { PERSONAL_ATTRIBUTES: "Ads must not assert personal attributes." } });
    expect(en.sentence).toBe("Meta didn't approve this ad: the text talks about the reader's personal traits. Say what you offer instead.");
    expect(explainReviewFeedback({ global: { "Personal Attributes": "x" } }, "hi")[0].sentence).toBe(
      "Meta ने यह विज्ञापन मंज़ूर नहीं किया: टेक्स्ट में पढ़ने वाले की निजी बातों का ज़िक्र है। इसकी जगह बताइए कि आप क्या देते हैं।",
    );
    expect(explainReviewFeedback({ global: { personal_attributes: "x" } }, "hinglish")[0].sentence).toBe(
      "Meta ne ye ad approve nahi kiya: text mein padhne wale ki personal baaton ka zikr hai. Iski jagah batayein ki aap kya offer karte hain.",
    );
  });
});

describe("numbers, months, durations and languages", () => {
  it("uses Western digits with Indian grouping", () => {
    expect(formatCount(150_000)).toBe("1,50,000");
    expect(formatCount(10_234_000n)).toBe("1,02,34,000");
    expect(promoteText("audience.can_include", { included: 1_240, total: 1_610 }, "hi")).toBe("1,610 में से 1,240 संपर्क शामिल किए जा सकते हैं।");
    expect(promoteText("cost.about", { amount: { minor: 10_234_050n, currency: "INR" } })).toBe("About ₹1,02,340.50 in total.");
  });

  it("keeps a missing variable visible instead of hiding the gap", () => {
    expect(promoteText("fix.ask_owner")).toBe("Ask {owner} to raise the limit");
  });

  it("names months, days, durations and audience sizes in each language", () => {
    expect(monthName("2026-10")).toBe("October");
    expect(monthName(10, "hi")).toBe("अक्टूबर");
    expect(() => monthName(13)).toThrow(RangeError);
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
    expect(joinList(["a", "b"], "hi")).toBe("a और b");
    expect(formatDuration(190_000)).toBe("3 min 10 s");
    expect(formatDuration(45_000, "hi")).toBe("45 सेकंड");
    expect(formatDuration(120_000, "hinglish")).toBe("2 min");
    expect(promoteText("audience.size", { range: formatPeopleRange(120_000, 180_000) })).toBe("About 1.2–1.8 lakh people");
    expect(formatPeopleRange(90_000, 120_000)).toBe("90 thousand–1.2 lakh");
    expect(formatPeopleRange(120_000, 180_000, "hi")).toBe("1.2–1.8 लाख");
  });

  it("keeps pages in English until PROMOTE_PAGE_LANGS allows more (D23)", () => {
    expect(pageLang("hi", ["en"])).toBe("en");
    expect(pageLang("hi", ["en", "hi"])).toBe("hi");
    expect(pageLang("hinglish", ["en", "hi"])).toBe("en");
    expect(pageLang("fr", ["en", "hi", "hinglish"])).toBe("en");
  });

  it("labels every readiness row of 3.2 in three languages", () => {
    for (const check of READINESS_CHECKS) for (const lang of PROMOTE_LANGS) expect(PROMOTE_COPY[lang][`readiness.${check}` as PromoteCopyKey], `${lang} ${check}`).toBeTruthy();
    expect(promoteText("readiness.currency_match")).toBe("Your ads limits use the same currency as the ad account");
    expect(promoteText("readiness.whatsapp_page_link.hint")).toBe("Make sure your Page shows the same WhatsApp number");
  });

  it("covers the 8.3a Instagram states in three languages", () => {
    const states = KEYS.filter((k) => k.startsWith("ig.state."));
    expect(states.sort()).toEqual(
      ["ads_only", "caption_long", "cant_boost", "ctig_replies", "no_account", "no_picture", "not_usable", "other_page", "personal", "restricted", "token_lost"].map((s) => `ig.state.${s}`).sort(),
    );
    expect(promoteTextAll("ig.state.other_page", { username: "shop", page: "Shop B" })).toEqual({
      en: "@shop is connected to Shop B, so the ad will run from Shop B.",
      hi: "@shop Shop B से जुड़ा है, इसलिए विज्ञापन Shop B से चलेगा।",
      hinglish: "@shop Shop B se juda hai, isliye ad Shop B se chalega.",
    });
  });
});

describe("ad review reasons (4.10)", () => {
  it("maps at least 25 codes, each to a plain reason, what to do and a fix kind, in three languages", () => {
    const codes = Object.keys(REVIEW_REASONS);
    expect(codes.length).toBeGreaterThanOrEqual(25);
    for (const code of ["TEXT_OVERLAY", "LANDING_PAGE_FAIL", "PERSONAL_ATTRIBUTES", "ADULT_CONTENT", "BRAND_USAGE"]) expect(codes).toContain(code);
    for (const [code, r] of Object.entries(REVIEW_REASONS)) {
      expect(REVIEW_FIX_KINDS).toContain(r.fix);
      const t = reviewReasonTexts(code);
      for (const lang of PROMOTE_LANGS) {
        expect(t.reason[lang].length, `${code} ${lang}`).toBeGreaterThan(5);
        expect(t.whatToDo[lang].length, `${code} ${lang}`).toBeGreaterThan(5);
        expect(t.reason[lang]).not.toContain("{");
      }
      if (r.fix === "set_category") expect(r.category, code).toBeDefined();
    }
    for (const kind of REVIEW_FIX_KINDS) expect(Object.values(REVIEW_REASONS).some((r) => r.fix === kind), kind).toBe(true);
  });

  it("normalises Meta's policy names and aliases, and keeps Meta's words for unknown codes", () => {
    expect(normalizeFeedbackCode("Landing Page Functionality")).toBe("LANDING_PAGE_FAIL");
    expect(normalizeFeedbackCode("Grammar & Profanity")).toBe("PROFANITY");
    expect(normalizeFeedbackCode("text overlay")).toBe("TEXT_OVERLAY");
    expect(reviewReasonOf("Special Ad Category Housing").reason).toMatchObject({ fix: "set_category", category: "housing" });
    const unknown = explainReviewFeedback({ global: { BRAND_NEW_POLICY: "A brand new rule about llamas." } })[0];
    expect(unknown).toMatchObject({ code: "BRAND_NEW_POLICY", fix: OTHER_REASON.fix, opensMeta: "appeal_ad" });
    expect(unknown.reason).toBe("Meta gave this reason: A brand new rule about llamas.");
    expect(explainReviewFeedback({ global: { X: "y".repeat(500) } })[0].reason.length).toBeLessThan(200);
  });

  it("keeps the placement of a placement-specific rejection", () => {
    const out = explainReviewFeedback({ placement_specific: { instagram: { TEXT_OVERLAY: "Too much text" } } });
    expect(out).toEqual([expect.objectContaining({ code: "TEXT_OVERLAY", placement: "instagram", fix: "edit_media" })]);
    expect(explainReviewFeedback(null)).toEqual([]);
  });
});

describe("Meta errors in plain words (4.10)", () => {
  it("classifies the documented codes", () => {
    expect(classifyMetaError({ code: 2655 })).toBe("custom_audience_tos");
    expect(classifyMetaError({ code: 100, subcode: 1870090 })).toBe("custom_audience_tos");
    expect(classifyMetaError({ code: 100, subcode: 1892040 })).toBe("leadgen_tos");
    expect(classifyMetaError({ status: 471, subcode: 1713232 })).toBe("audience_flagged");
    expect(classifyMetaError({ code: 613, subcode: 1487225 })).toBe("ad_creation_capped");
    expect(classifyMetaError({ code: 613 })).toBe("meta_busy");
    expect(classifyMetaError({ code: 17 })).toBe("meta_busy");
    expect(classifyMetaError({ kind: "media_not_ready" })).toBe("media_not_ready");
    expect(classifyMetaError({ code: 100 })).toBeNull();
    // 1870090 is a subcode, never a top-level code.
    expect(classifyMetaError({ code: 1870090 })).toBeNull();
  });

  it("classifies the fake Meta's real error bodies (code plus error_subcode)", () => {
    expect(classifyMetaError(AUDIENCE_TERMS_2655)).toBe("custom_audience_tos");
    expect(classifyMetaError(AUDIENCE_TERMS_1870090)).toBe("custom_audience_tos");
    expect(classifyMetaError(LEADGEN_TOS_ERROR)).toBe("leadgen_tos");
    expect(classifyMetaError({ code: 100, error_subcode: 33 })).toBeNull();
    // As graph/index.ts hands it on (subcode), and from a 471 answer.
    expect(classifyMetaError({ code: AUDIENCE_TERMS_1870090.code, subcode: AUDIENCE_TERMS_1870090.error_subcode })).toBe("custom_audience_tos");
    expect(classifyMetaError({ status: 471, code: 100, error_subcode: 1713232 })).toBe("audience_flagged");
    expect(metaErrorText(classifyMetaError(AUDIENCE_TERMS_1870090)!)).toBe("Accept Meta's audience terms first.");
    expect(META_ERRORS[classifyMetaError(AUDIENCE_TERMS_1870090)!].fixes).toEqual([{ kind: "opens_meta", key: "custom_audience_tos" }]);
    expect(META_ERRORS[classifyMetaError(LEADGEN_TOS_ERROR)!].fixes).toEqual([{ kind: "opens_meta", key: "leadgen_tos" }]);
  });

  it("has copy in three languages for every row, and its fixes point only at allowlisted Meta screens", () => {
    for (const kind of PROMOTE_ERROR_KINDS) {
      const row = META_ERRORS[kind];
      for (const lang of PROMOTE_LANGS) expect(PROMOTE_COPY[lang][row.key].length, `${kind} ${lang}`).toBeGreaterThan(10);
      for (const f of row.fixes) if (f.kind === "opens_meta") expect(META_SCREEN_KEYS).toContain(f.key);
    }
    expect(metaErrorText("meta_busy", { time: "3:40 pm" })).toBe("Meta is busy. Try again at 3:40 pm.");
    expect(metaErrorText("run_too_short")).toBe("Meta needs ads with a daily budget to run for more than a day, so the shortest run is 2 days.");
    expect(metaErrorText("account_restricted", { account: "Glow Salon" }, "hi")).toBe("Meta ने Glow Salon पर विज्ञापन सीमित कर दिए हैं। रोकना अब भी काम करता है।");
    expect(metaErrorText("below_min", { amount: { minor: 4_000n, currency: "INR" } })).toBe("Meta needs at least ₹40 a day for this kind of ad.");
    expect(META_ERRORS.account_restricted.fixes).toEqual([{ kind: "opens_meta", key: "account_quality" }]);
    expect(META_ERRORS.custom_audience_tos.fixes).toEqual([{ kind: "opens_meta", key: "custom_audience_tos" }]);
    expect(META_ERRORS.leadgen_tos.fixes).toEqual([{ kind: "opens_meta", key: "leadgen_tos" }]);
  });
});

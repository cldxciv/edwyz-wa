import { describe, expect, it } from "vitest";

/**
 * docs/EDDY-SPEC.md 5.7 "Formatting" and EDDY-05 acceptance 9: money in en-IN grouping in all three languages (₹1,02,340),
 * the same text as Phase 0's formatMinor; counts in en-IN with Latin digits; Hindi month names for `hi` and en-IN names
 * otherwise; and truncation by grapheme that never splits a Devanagari conjunct or an emoji sequence.
 */
import { EDDY_LANGS } from "@/lib/eddy/contract";
import {
  currencyExponent,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatPercent,
  formatTime,
  graphemeLength,
  graphemes,
  HI_MONTHS,
  monthName,
  truncate,
} from "@/lib/eddy/format";
import { formatMinor } from "@/lib/spend/money";

describe("money (5.7)", () => {
  it("₹1,02,340 in en-IN grouping in English, Hindi and Hinglish", () => {
    for (const lang of EDDY_LANGS) {
      expect(formatMoney(10234000n, "INR", lang)).toBe("₹1,02,340");
      expect(formatMoney("10234000", "INR", lang)).toBe("₹1,02,340");
      expect(formatMoney(10234000, "INR", lang)).toBe("₹1,02,340");
    }
  });

  it("keeps a non-zero fraction and drops a zero one", () => {
    expect(formatMoney(10234050n, "INR")).toBe("₹1,02,340.50");
    expect(formatMoney(85000n, "INR")).toBe("₹850");
    expect(formatMoney(5n, "INR")).toBe("₹0.05");
    expect(formatMoney(-150000n, "INR")).toBe("-₹1,500");
  });

  it("uses the currency's exponent: none for JPY, three for KWD, credits for CRD", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("inr")).toBe(2);
    expect(formatMoney(1500n, "JPY")).toBe("¥1,500");
    expect(formatMoney(1234n, "KWD")).toBe("KWD 1.234");
    expect(formatMoney(140n, "CRD")).toBe("140 credits");
    expect(formatMoney(1n, "CRD")).toBe("1 credit");
  });

  it("matches Phase 0's formatMinor for the currencies Edwyz shows", () => {
    const cases: [bigint, string][] = [
      [10234000n, "INR"],
      [10234050n, "INR"],
      [123456789012n, "INR"],
      [0n, "INR"],
      [99n, "INR"],
      [123456n, "USD"],
      [100000n, "EUR"],
      [5000n, "GBP"],
      [1500n, "JPY"],
      [1234n, "KWD"],
      [140n, "CRD"],
    ];
    for (const [minor, currency] of cases) expect(formatMoney(minor, currency), `${minor} ${currency}`).toBe(formatMinor(minor, currency));
  });

  it("never guesses: a value that is not a whole number of minor units shows a dash", () => {
    expect(formatMoney(12.5, "INR")).toBe("-");
    expect(formatMoney("1e5", "INR")).toBe("-");
    expect(formatMoney(Number.NaN, "INR")).toBe("-");
  });
});

describe("counts and percentages", () => {
  it("en-IN grouping with Latin digits", () => {
    expect(formatCount(102340)).toBe("1,02,340");
    expect(formatCount(1240)).toBe("1,240");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(12345678901234567890n)).toBe("1,23,45,67,89,01,23,45,67,890");
    expect(formatCount(-1240)).toBe("-1,240");
    expect(formatCount(Number.NaN)).toBe("0");
  });

  it("percentages the tools computed", () => {
    expect(formatPercent(45)).toBe("45%");
    expect(formatPercent(45.26)).toBe("45.3%");
    expect(formatPercent(null)).toBe("-");
  });
});

describe("dates and times (5.7)", () => {
  const at = new Date("2026-10-28T08:35:00Z"); // 2:05 pm in India

  it("Hindi month names for hi, en-IN names for English and Hinglish", () => {
    expect(formatDate(at, "hi")).toBe("28 अक्टूबर 2026");
    expect(formatDate(at, "hi", { year: false })).toBe("28 अक्टूबर");
    expect(formatDate(at, "en")).toBe("28 Oct 2026");
    expect(formatDate(at, "hinglish")).toBe("28 Oct 2026");
    expect(formatDate(at, "en", { style: "long" })).toBe("28 October 2026");
  });

  it("all twelve Hindi months", () => {
    expect(HI_MONTHS).toEqual(["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"]);
    for (let m = 0; m < 12; m++) {
      expect(monthName(m, "hi")).toBe(HI_MONTHS[m]);
      expect(/\p{Script=Devanagari}/u.test(monthName(m, "hi"))).toBe(true);
      expect(/^[A-Z][a-z]{2}$/.test(monthName(m, "hinglish"))).toBe(true);
    }
  });

  it("uses the time zone for the calendar day and the time", () => {
    const lateUtc = new Date("2026-10-31T20:00:00Z"); // 1:30 am on 1 Nov in India
    expect(formatDate(lateUtc, "en", { timeZone: "Asia/Kolkata", year: false })).toBe("1 Nov");
    expect(formatDate(lateUtc, "en", { timeZone: "UTC", year: false })).toBe("31 Oct");
    expect(formatTime(at, "en", "Asia/Kolkata")).toBe("2:05 pm");
    expect(formatTime(new Date("2026-10-28T18:30:00Z"), "hi", "Asia/Kolkata")).toBe("12:00 am");
    expect(formatDateTime(at, "hi", "Asia/Kolkata")).toBe("28 अक्टूबर 2026, 2:05 pm");
    expect(formatDate("not a date", "en")).toBe("-");
  });

  it("durations in the member's language", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(300, "en")).toBe("5 min");
    expect(formatDuration(7500, "en")).toBe("2 h 5 min");
    expect(formatDuration(259200, "en")).toBe("3 days");
    expect(formatDuration(300, "hi")).toBe("5 मिनट");
    expect(formatDuration(7500, "hinglish")).toBe("2 ghante 5 min");
    expect(formatDuration(null)).toBe("-");
  });
});

describe("grapheme-safe truncation (5.7, 6.13)", () => {
  it("never splits a conjunct: क्षत्रिय and नमस्ते", () => {
    expect(graphemes("क्षत्रिय").join("")).toBe("क्षत्रिय");
    for (let max = 1; max <= 6; max++) {
      const cut = truncate("क्षत्रिय क्षत्रिय", max);
      expect(cut.endsWith("…")).toBe(true);
      expect(/[्]…$/u.test(cut), cut).toBe(false);
      expect(graphemeLength(cut)).toBeLessThanOrEqual(max);
      expect("क्षत्रिय क्षत्रिय".startsWith(cut.slice(0, -1))).toBe(true);
    }
    const namaste = truncate("नमस्ते दुनिया", 3);
    expect(/[्]…$/u.test(namaste)).toBe(false);
    expect(["नम…", "न…", "…"]).toContain(namaste);
  });

  it("keeps emoji sequences whole and returns text that fits unchanged", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(graphemes(`${family}${family}x`)).toHaveLength(3);
    expect(truncate(`${family}${family}${family}`, 2)).toBe(`${family}…`);
    expect(truncate("नमस्ते", 10)).toBe("नमस्ते");
    expect(truncate("hello", 0)).toBe("");
    expect(truncate("hello world", 6)).toBe("hello…");
  });
});

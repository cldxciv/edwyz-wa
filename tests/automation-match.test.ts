import { describe, expect, it } from "vitest";
import { isValidTimezone, isWithinOpenHours, localParts, matchesKeywords, parseSchedule } from "@/lib/automation/match";

describe("matchesKeywords", () => {
  it("contains is case-insensitive and whole-word", () => {
    expect(matchesKeywords("What is the PRICE please?", ["price"], "contains")).toBe(true);
    expect(matchesKeywords("priceless gift", ["price"], "contains")).toBe(false);
    expect(matchesKeywords("my prices", ["price"], "contains")).toBe(false);
    expect(matchesKeywords("price-list", ["price"], "contains")).toBe(true);
    expect(matchesKeywords("opening hours today", ["opening hours"], "contains")).toBe(true);
    expect(matchesKeywords("opening   hours", ["Opening Hours"], "contains")).toBe(true);
  });
  it("handles unicode words", () => {
    expect(matchesKeywords("मुझे कीमत बताओ", ["कीमत"], "contains")).toBe(true);
    expect(matchesKeywords("café menu", ["cafe"], "contains")).toBe(false);
  });
  it("exact needs the whole message to equal a keyword", () => {
    expect(matchesKeywords("  Menu ", ["menu"], "exact")).toBe(true);
    expect(matchesKeywords("show menu", ["menu"], "exact")).toBe(false);
  });
  it("escapes regex characters and ignores empty keywords and text", () => {
    expect(matchesKeywords("is it c++?", ["c++"], "contains")).toBe(true);
    expect(matchesKeywords("a.b", ["a.b"], "contains")).toBe(true);
    expect(matchesKeywords("axb", ["a.b"], "contains")).toBe(false);
    expect(matchesKeywords("hello", [" "], "contains")).toBe(false);
    expect(matchesKeywords("   ", ["hello"], "contains")).toBe(false);
    expect(matchesKeywords("hello", [], "contains")).toBe(false);
  });
});

describe("parseSchedule", () => {
  const ok = { timezone: "Asia/Kolkata", days: [1, 2, 2], start: "09:00", end: "18:00" };
  it("accepts and normalises a valid schedule", () => {
    expect(parseSchedule(ok)).toEqual({ timezone: "Asia/Kolkata", days: [1, 2], start: "09:00", end: "18:00" });
  });
  it.each([
    [null],
    ["x"],
    [{ ...ok, timezone: "Mars/Base" }],
    [{ ...ok, days: [] }],
    [{ ...ok, days: [7] }],
    [{ ...ok, days: [1.5] }],
    [{ ...ok, start: "9:00" }],
    [{ ...ok, end: "24:00" }],
    [{ ...ok, start: "09:60" }],
  ])("rejects %j", (value) => {
    expect(parseSchedule(value)).toBeNull();
  });
  it("validates timezones", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Nope/Zone")).toBe(false);
  });
});

describe("isWithinOpenHours", () => {
  const office = parseSchedule({ timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" })!;
  // 2026-10-26 is a Monday.
  it("uses the schedule's timezone", () => {
    expect(localParts(new Date("2026-10-26T16:30:00Z"), "Asia/Kolkata")).toEqual({ day: 1, minutes: 22 * 60 });
    expect(isWithinOpenHours(office, new Date("2026-10-26T04:30:00Z"))).toBe(true); // 10:00 IST
    expect(isWithinOpenHours(office, new Date("2026-10-26T13:30:00Z"))).toBe(false); // 19:00 IST
  });
  it("start is inclusive and end exclusive", () => {
    expect(isWithinOpenHours(office, new Date("2026-10-26T03:30:00Z"))).toBe(true); // 09:00 IST
    expect(isWithinOpenHours(office, new Date("2026-10-26T03:29:00Z"))).toBe(false); // 08:59
    expect(isWithinOpenHours(office, new Date("2026-10-26T12:29:00Z"))).toBe(true); // 17:59
    expect(isWithinOpenHours(office, new Date("2026-10-26T12:30:00Z"))).toBe(false); // 18:00
  });
  it("is closed on unlisted days", () => {
    expect(isWithinOpenHours(office, new Date("2026-10-31T06:00:00Z"))).toBe(false); // Saturday 11:30 IST
  });
  it("evaluates the day in the schedule's timezone, not UTC", () => {
    // Friday 2026-10-30 22:00 UTC is Saturday 03:30 IST: closed. Sunday-listed schedule sees Saturday as closed too.
    expect(localParts(new Date("2026-10-30T22:00:00Z"), "Asia/Kolkata").day).toBe(6);
    expect(isWithinOpenHours(office, new Date("2026-10-30T22:00:00Z"))).toBe(false);
  });

  describe("overnight hours 22:00 to 06:00 starting Friday", () => {
    const night = parseSchedule({ timezone: "UTC", days: [5], start: "22:00", end: "06:00" })!;
    const at = (iso: string) => isWithinOpenHours(night, new Date(iso));
    it("is open late on the listed day and early the next morning", () => {
      expect(at("2026-10-30T22:00:00Z")).toBe(true);
      expect(at("2026-10-30T23:59:00Z")).toBe(true);
      expect(at("2026-10-31T00:00:00Z")).toBe(true);
      expect(at("2026-10-31T05:59:00Z")).toBe(true);
    });
    it("closes at the end time and on the wrong days", () => {
      expect(at("2026-10-31T06:00:00Z")).toBe(false);
      expect(at("2026-10-30T21:59:00Z")).toBe(false);
      expect(at("2026-10-31T23:00:00Z")).toBe(false); // Saturday night: Saturday not listed
      expect(at("2026-10-30T03:00:00Z")).toBe(false); // Friday early morning belongs to Thursday's window
    });
    it("handles the week wrap from Saturday to Sunday", () => {
      const sat = parseSchedule({ timezone: "UTC", days: [6], start: "22:00", end: "06:00" })!;
      expect(isWithinOpenHours(sat, new Date("2026-11-01T02:00:00Z"))).toBe(true); // Sunday 02:00
      const sun = parseSchedule({ timezone: "UTC", days: [0], start: "22:00", end: "06:00" })!;
      expect(isWithinOpenHours(sun, new Date("2026-11-02T02:00:00Z"))).toBe(true); // Monday 02:00
    });
  });

  it("start equal to end means open all day on listed days", () => {
    const all = parseSchedule({ timezone: "UTC", days: [1], start: "00:00", end: "00:00" })!;
    expect(isWithinOpenHours(all, new Date("2026-10-26T23:59:00Z"))).toBe(true);
    expect(isWithinOpenHours(all, new Date("2026-10-27T00:00:00Z"))).toBe(false);
  });

  it("is stable across a DST change", () => {
    const ny = parseSchedule({ timezone: "America/New_York", days: [0], start: "01:00", end: "02:00" })!;
    // 2026-11-01: 01:30 happens twice (EDT then EST).
    expect(isWithinOpenHours(ny, new Date("2026-11-01T05:30:00Z"))).toBe(true);
    expect(isWithinOpenHours(ny, new Date("2026-11-01T06:30:00Z"))).toBe(true);
    expect(isWithinOpenHours(ny, new Date("2026-11-01T07:30:00Z"))).toBe(false); // 02:30 EST
  });
});

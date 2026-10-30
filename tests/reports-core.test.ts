import { describe, expect, it } from "vitest";
import { BOM, csvCell, csvRow } from "@/lib/reports/csv";
import { addDays, canonicalTimeZone, dayKey, isValidTimeZone, parseRange, startOfDay } from "@/lib/reports/range";
import { formatDuration, median, percentile, rate } from "@/lib/reports/stats";
import { niceMax, presetRange, usagePercent } from "@/components/reports/helpers";

describe("percentile math", () => {
  it("computes median and p90 with interpolation", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBeCloseTo(9.1);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2], 150)).toBe(2);
  });
  it("rates and durations", () => {
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(0, 0)).toBeNull();
    expect(formatDuration(null)).toBe("not available");
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(5400)).toBe("1 h 30 min");
  });
});

describe("time zone day bucketing", () => {
  it("buckets by local day across month ends", () => {
    expect(dayKey(new Date("2026-02-01T04:59:59Z"), "America/New_York")).toBe("2026-01-31");
    expect(dayKey(new Date("2026-02-01T05:00:00Z"), "America/New_York")).toBe("2026-02-01");
    expect(dayKey(new Date("2026-01-31T18:30:00Z"), "Asia/Kolkata")).toBe("2026-02-01");
    expect(dayKey(new Date("2026-01-31T18:29:59Z"), "Asia/Kolkata")).toBe("2026-01-31");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
  it("handles 23 and 25 hour days on DST changes", () => {
    const tz = "America/New_York";
    const hours = (a: string, b: string) => (startOfDay(b, tz).getTime() - startOfDay(a, tz).getTime()) / 3_600_000;
    expect(hours("2026-03-08", "2026-03-09")).toBe(23);
    expect(hours("2026-11-01", "2026-11-02")).toBe(25);
    expect(hours("2026-03-09", "2026-03-10")).toBe(24);
    expect(startOfDay("2026-03-08", tz).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(startOfDay("2026-03-09", "Asia/Kolkata").toISOString()).toBe("2026-03-08T18:30:00.000Z");
  });
  it("validates ranges", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    const r = parseRange({ from: "2026-03-01", to: "2026-03-07", tz: "UTC" });
    expect(r.days).toHaveLength(7);
    expect(r.end.toISOString()).toBe("2026-03-08T00:00:00.000Z");
    expect(() => parseRange({ from: "2026-03-07", to: "2026-03-01" })).toThrow();
    expect(() => parseRange({ from: "2026-02-30", to: "2026-03-01" })).toThrow();
    expect(() => parseRange({ from: "2026-03-01", to: "2026-03-02", tz: "Nope/Zone" })).toThrow();
    expect(parseRange({ from: "2025-01-01", to: "2026-01-01" }).days).toHaveLength(366);
    expect(() => parseRange({ from: "2025-01-01", to: "2026-01-02" })).toThrow(/366/);
    expect(() => parseRange({})).toThrow();
  });
  it("maps old zone names browsers still report to the current IANA name before SQL sees them", () => {
    // Chrome on Windows in India reports Asia/Calcutta; a Postgres with trimmed tzdata only knows Asia/Kolkata.
    expect(canonicalTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(canonicalTimeZone("US/Eastern")).toBe("America/New_York");
    expect(canonicalTimeZone("Asia/Saigon")).toBe("Asia/Ho_Chi_Minh");
    expect(canonicalTimeZone("Etc/UTC")).toBe("UTC");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
    expect(canonicalTimeZone("America/New_York")).toBe("America/New_York");
    expect(canonicalTimeZone("Mars/Base")).toBeNull();
    expect(canonicalTimeZone("")).toBeNull();
    expect(canonicalTimeZone(null)).toBeNull();
    expect(isValidTimeZone("Asia/Calcutta")).toBe(true);
    const r = parseRange({ from: "2026-03-01", to: "2026-03-02", tz: "Asia/Calcutta" });
    expect(r.tz).toBe("Asia/Kolkata");
    expect(r.start.toISOString()).toBe("2026-02-28T18:30:00.000Z");
    expect(parseRange({ from: "2026-03-01", to: "2026-03-02", tz: "Europe/Kiev" }).tz).toBe("Europe/Kyiv");
  });
});

describe("csv safety", () => {
  it("quotes and escapes", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(csvRow(["a", "b,c"])).toBe('a,"b,c"\r\n');
    expect(BOM).toBe("﻿");
  });
  it.each(["=SUM(A1)", "+91 98765", "-2+3", "@cmd", "\tx", "\rx"])("neutralises %j", (v) => {
    expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
  });
  it("leaves safe text alone", () => {
    expect(csvCell("hello=world")).toBe("hello=world");
  });
});

describe("report UI helpers", () => {
  it("niceMax, usagePercent and presetRange", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(41)).toBe(50);
    expect(usagePercent(5, null)).toBeNull();
    expect(usagePercent(50, 200)).toBe(25);
    expect(usagePercent(500, 200)).toBe(100);
    expect(presetRange(7, "UTC", new Date("2026-03-10T12:00:00Z"))).toEqual({ from: "2026-03-04", to: "2026-03-10" });
  });
});

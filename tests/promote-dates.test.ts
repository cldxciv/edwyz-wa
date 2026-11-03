import fc from "fast-check";
import { describe, expect, it } from "vitest";

/**
 * Run dates in the ad account's time zone (docs/IG-PAGE-ADS-SPEC.md 3.1a, D6, D30 to D32; PRM-02 acceptance 7).
 */
import {
  DEFAULT_RUN_DAYS,
  endOfRunDay,
  localTimeToInstant,
  MAX_RUN_DAYS,
  MIN_RUN_DAYS,
  runDates,
  runDayCount,
  runDaysBounds,
  setAsideFromToday,
  toZonedIso,
  validateRun,
  whenLine,
  zoneNote,
  zoneOffsetMinutes,
} from "@/lib/promote/dates";
import { dayKey, localParts } from "@/lib/spend/periods";

const IST = "Asia/Kolkata";
const NY = "America/New_York";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ist = (local: string) => new Date(`${local}:00+05:30`);
const D31 = "Meta needs ads with a daily budget to run for more than a day, so the shortest run is 2 days.";

describe("offsets from the IANA zone, never a fixed +0530 (D30)", () => {
  it("formats an instant with its zone's offset at that instant", () => {
    expect(toZonedIso(ist("2026-10-28T10:05"), IST)).toBe("2026-10-28T10:05:00+0530");
    expect(toZonedIso(new Date("2026-07-01T12:00:00Z"), NY)).toBe("2026-07-01T08:00:00-0400");
    expect(toZonedIso(new Date("2026-12-01T12:00:00Z"), NY)).toBe("2026-12-01T07:00:00-0500");
    expect(toZonedIso(new Date("2026-06-01T00:00:00Z"), "Asia/Kathmandu")).toBe("2026-06-01T05:45:00+0545");
    expect(zoneOffsetMinutes(new Date("2026-06-01T00:00:00Z"), IST)).toBe(330);
  });

  it("a run across the America/New_York change on 1 Nov 2026 ends at 23:59 local with the right offset", () => {
    const now = new Date("2026-10-30T14:00:00Z"); // Fri 30 Oct, 10:00 EDT
    const d = runDates({ runDays: 3, startMode: "now", tz: NY, now });
    expect(d.startDay).toBe("2026-10-30");
    expect(d.endDay).toBe("2026-11-01");
    expect(d.startIso).toBe("2026-10-30T10:00:00-0400");
    expect(d.endIso).toBe("2026-11-01T23:59:00-0500");
    expect(d.endsAt.toISOString()).toBe("2026-11-02T04:59:00.000Z");
    const p = localParts(d.endsAt, NY);
    expect([p.day, p.hour, p.minute]).toEqual([1, 23, 59]);
    // The two ends carry different offsets: never one offset reused for both.
    expect(d.startIso.slice(-5)).not.toBe(d.endIso.slice(-5));
  });

  it("ends at 23:59 local on the spring-forward day too", () => {
    const end = endOfRunDay("2026-03-08", NY);
    expect(toZonedIso(end, NY)).toBe("2026-03-08T23:59:00-0400");
    expect(toZonedIso(endOfRunDay("2026-03-07", NY), NY)).toBe("2026-03-07T23:59:00-0500");
    // 02:30 does not exist that morning; the instant is still valid and lands after the gap.
    const gap = localTimeToInstant("2026-03-08", 2, 30, NY);
    expect(Number.isNaN(gap.getTime())).toBe(false);
    expect(localParts(gap, NY).hour).toBe(3);
  });

  it("every run ends at 23:59 in its zone and covers exactly runDays account days (fast-check)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(IST, NY, "Europe/London", "Australia/Sydney", "UTC", "America/Sao_Paulo", "Asia/Tokyo"),
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
        fc.integer({ min: MIN_RUN_DAYS, max: MAX_RUN_DAYS }),
        (tz, nowMs, runDays) => {
          const now = new Date(nowMs);
          const d = runDates({ runDays, startMode: "now", tz, now });
          const p = localParts(d.endsAt, tz);
          expect([p.hour, p.minute]).toEqual([23, 59]);
          expect(dayKey(d.endsAt, tz)).toBe(d.endDay);
          expect(runDayCount(d.startsAt, d.endsAt, tz)).toBe(runDays);
          const off = zoneOffsetMinutes(d.endsAt, tz);
          const sign = off < 0 ? "-" : "+";
          expect(d.endIso.endsWith(`${sign}${String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")}${String(Math.abs(off) % 60).padStart(2, "0")}`)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("drafts keep a run length, not a stale date (3.1a)", () => {
  it("a draft saved on Monday and started on Thursday keeps its 7 days", () => {
    const monday = ist("2026-10-26T09:00");
    const thursday = ist("2026-10-29T18:30");
    const saved = runDates({ runDays: 7, startMode: "now", tz: IST, now: monday });
    const started = runDates({ runDays: 7, startMode: "now", tz: IST, now: thursday });
    expect(saved.endDay).toBe("2026-11-01");
    expect(started.startsAt).toEqual(thursday);
    expect(started.endDay).toBe("2026-11-04");
    expect(started.endIso).toBe("2026-11-04T23:59:00+0530");
    expect(runDayCount(started.startsAt, started.endsAt, IST)).toBe(7);
    expect(validateRun({ startMode: "now", startsAt: started.startsAt, endsAt: started.endsAt, now: thursday, tz: IST, runDays: 7 })).toEqual([]);
    expect(DEFAULT_RUN_DAYS).toBe(7);
  });

  it("counts a later start from today (D32)", () => {
    const now = ist("2026-10-28T10:05");
    const later = runDates({ runDays: 7, startMode: "at", startsAt: ist("2026-11-05T09:00"), tz: IST, now });
    expect(later.setAsideFromToday).toBe(true);
    expect(later.endDay).toBe("2026-11-11");
    expect(setAsideFromToday(ist("2026-10-28T22:00"), now, IST)).toBe(false);
    expect(runDates({ runDays: 7, startMode: "now", tz: IST, now }).setAsideFromToday).toBe(false);
    expect(() => runDates({ runDays: 7, startMode: "at", tz: IST, now })).toThrow(RangeError);
  });
});

describe("validateRun refuses with plain copy (3.1a, D6, D31, D32)", () => {
  const now = ist("2026-10-28T10:05");

  it("refuses a past 'at' start", () => {
    const issues = validateRun({ startMode: "at", startsAt: new Date(now.getTime() - 60_000), endsAt: ist("2026-11-03T23:59"), now, tz: IST });
    expect(issues.map((i) => i.code)).toEqual(["run.start_passed"]);
    expect(issues[0].text).toBe("This start time has passed. Start now or pick a new time.");
    expect(validateRun({ startMode: "at", startsAt: new Date(now.getTime() + 60_000), endsAt: ist("2026-11-03T23:59"), now, tz: IST })).toEqual([]);
  });

  it("refuses a run of 24 hours or less with the D31 copy", () => {
    const start = ist("2026-10-29T10:00");
    const exactly24 = validateRun({ startMode: "at", startsAt: start, endsAt: new Date(start.getTime() + DAY), now, tz: IST });
    expect(exactly24.map((i) => i.code)).toEqual(["run.too_short"]);
    expect(exactly24[0].text).toBe(D31);
    expect(validateRun({ startMode: "at", startsAt: start, endsAt: new Date(start.getTime() + DAY + 60_000), now, tz: IST })).toEqual([]);
    // A 1-day run is refused by its length too.
    const oneDay = runDates({ runDays: 1, startMode: "now", tz: IST, now });
    expect(validateRun({ startMode: "now", startsAt: oneDay.startsAt, endsAt: oneDay.endsAt, now, tz: IST, runDays: 1 }).map((i) => i.code)).toEqual(["run.too_short"]);
    // A 2-day run started a few seconds before midnight ends less than 24 hours later.
    const late = ist("2026-10-28T23:59");
    const d = runDates({ runDays: 2, startMode: "now", tz: IST, now: new Date(late.getTime() + 30_000) });
    expect(validateRun({ startMode: "now", startsAt: d.startsAt, endsAt: d.endsAt, now: new Date(late.getTime() + 30_000), tz: IST, runDays: 2 }).map((i) => i.code)).toEqual(["run.too_short"]);
    expect(validateRun({ startMode: "now", startsAt: now, endsAt: ist("2026-10-29T23:59"), now, tz: IST }, "hi")[0]?.text).toBeUndefined();
    expect(validateRun({ startMode: "now", startsAt: now, endsAt: ist("2026-10-29T09:00"), now, tz: IST }, "hinglish")[0].text).toBe(
      "Roz ke budget wale ads ko Meta ek din se zyada chalana chahta hai, isliye sabse chhota run 2 din ka hai.",
    );
  });

  it("refuses a start more than 14 days ahead", () => {
    const far = new Date(now.getTime() + 14 * DAY + 60_000);
    const issues = validateRun({ startMode: "at", startsAt: far, endsAt: new Date(far.getTime() + 7 * DAY), now, tz: IST });
    expect(issues.map((i) => i.code)).toEqual(["run.start_too_far"]);
    expect(issues[0].text).toBe("For now, ads can start at most 14 days ahead. Pick an earlier date.");
    const edge = new Date(now.getTime() + 14 * DAY);
    expect(validateRun({ startMode: "at", startsAt: edge, endsAt: new Date(edge.getTime() + 7 * DAY), now, tz: IST })).toEqual([]);
  });

  it("refuses runs longer than 90 days", () => {
    const ninety = runDates({ runDays: 90, startMode: "now", tz: IST, now });
    expect(validateRun({ startMode: "now", startsAt: now, endsAt: ninety.endsAt, now, tz: IST, runDays: 90 })).toEqual([]);
    const ninetyOne = runDates({ runDays: 91, startMode: "now", tz: IST, now });
    const issues = validateRun({ startMode: "now", startsAt: now, endsAt: ninetyOne.endsAt, now, tz: IST, runDays: 91 });
    expect(issues.map((i) => i.code)).toEqual(["run.too_long"]);
    expect(issues[0].text).toBe("Ads can run for at most 90 days. Pick an earlier end date.");
    expect(runDaysBounds(false)).toEqual({ min: 2, max: 30 });
    expect(runDaysBounds(true)).toEqual({ min: 2, max: 90 });
  });
});

describe("the When line and the zone note (D30)", () => {
  it("says Today → Sun 1 Nov in the account zone", () => {
    const now = ist("2026-10-28T10:05");
    const d = runDates({ runDays: 5, startMode: "now", tz: IST, now });
    expect(whenLine(d, now, IST)).toBe("Today → Sun 1 Nov");
    expect(whenLine(d, now, IST, "hi")).toBe("आज → रवि 1 नवंबर");
    const later = runDates({ runDays: 3, startMode: "at", startsAt: ist("2026-11-05T09:00"), tz: IST, now });
    expect(whenLine(later, now, IST)).toBe("Thu 5 Nov → Sat 7 Nov");
  });

  it("names the account zone only when it differs from the workspace's", () => {
    expect(zoneNote(NY, IST)).toBe("Times are in America/New_York, your ad account's time zone.");
    expect(zoneNote(IST, IST)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { MAX_SCHEDULE_DAYS, broadcastStatusView, costText, presetSchedule, progressPercent, qualityWarning, tierSummary, validateSchedule } from "@/components/broadcasts/helpers";

describe("progressPercent", () => {
  it("counts sent, failed and skipped as handled", () => {
    expect(progressPercent({})).toBe(0);
    expect(progressPercent({ pending: 3, sent: 1 })).toBe(25);
    expect(progressPercent({ queued: 1, delivered: 1, failed: 1, skipped: 1 })).toBe(75);
    expect(progressPercent({ read: 4 })).toBe(100);
  });
});

describe("presetSchedule", () => {
  const now = new Date(2026, 9, 30, 10, 20);
  it("starts a day picked on the calendar at a time that can really be scheduled", () => {
    expect(presetSchedule("2026-11-02", now)).toBe("2026-11-02T09:00");
    // today after 9:00: the next full hour at least 30 minutes away
    expect(presetSchedule("2026-10-30", now)).toBe("2026-10-30T11:00");
    expect(presetSchedule("2026-10-30", new Date(2026, 9, 30, 23, 40))).toBeNull();
    expect(presetSchedule("2026-10-29", now)).toBeNull();
    expect(presetSchedule("not-a-day", now)).toBeNull();
  });
  it("keeps the last day of the window inside the limit and refuses days past it", () => {
    const lastDay = new Date(now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000);
    const key = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, "0")}-${String(lastDay.getDate()).padStart(2, "0")}`;
    const at = presetSchedule(key, now);
    expect(at).not.toBeNull();
    expect(validateSchedule(at!, now)).toBeNull();
    const after = new Date(lastDay.getTime() + 86_400_000);
    expect(presetSchedule(`${after.getFullYear()}-${String(after.getMonth() + 1).padStart(2, "0")}-${String(after.getDate()).padStart(2, "0")}`, now)).toBeNull();
  });
});

describe("broadcastStatusView", () => {
  it("maps statuses", () => {
    expect(broadcastStatusView("completed").tone).toBe("good");
    expect(broadcastStatusView("sending").label).toBe("Sending");
    expect(broadcastStatusView("failed").tone).toBe("bad");
  });
});

describe("costText", () => {
  it("never invents a price", () => {
    expect(costText(undefined)).toBe("rate card not configured");
    expect(costText({ configured: false })).toBe("rate card not configured");
    expect(costText({ configured: true, totalPaise: 25000 })).toContain("250");
  });
});

describe("tier and quality copy", () => {
  it("describes tiers and warns on low quality", () => {
    expect(tierSummary("TIER_1K")).toContain("1,000");
    expect(tierSummary(null)).toContain("lowest tier");
    expect(qualityWarning("RED")).toMatch(/paused/);
    expect(qualityWarning("GREEN")).toBeNull();
  });
});

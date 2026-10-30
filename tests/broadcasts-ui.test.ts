import { describe, expect, it } from "vitest";
import { broadcastStatusView, costText, progressPercent, qualityWarning, tierSummary } from "@/components/broadcasts/helpers";

describe("progressPercent", () => {
  it("counts sent, failed and skipped as handled", () => {
    expect(progressPercent({})).toBe(0);
    expect(progressPercent({ pending: 3, sent: 1 })).toBe(25);
    expect(progressPercent({ queued: 1, delivered: 1, failed: 1, skipped: 1 })).toBe(75);
    expect(progressPercent({ read: 4 })).toBe(100);
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

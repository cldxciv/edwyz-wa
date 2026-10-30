import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarChart, LineChart } from "@/components/reports/Charts";
import {
  daysBetween,
  failureTitle,
  formatDay,
  formatPercent,
  indexAtX,
  labelIndexes,
  moveCursor,
  presetLabel,
  rangeProblem,
  rangeText,
  readout,
  shareText,
  usageNote,
  usageSummary,
} from "@/components/reports/helpers";

describe("date range helpers", () => {
  it("counts both end days", () => {
    expect(daysBetween("2026-10-01", "2026-10-01")).toBe(1);
    expect(daysBetween("2026-10-01", "2026-10-30")).toBe(30);
  });
  it("explains a bad range in plain words", () => {
    expect(rangeProblem("2026-10-01", "2026-10-30")).toBeNull();
    expect(rangeProblem("2026-10-30", "2026-10-01")).toContain("start date");
    expect(rangeProblem("", "2026-10-01")).toContain("both");
    expect(rangeProblem("2025-01-01", "2026-10-01")).toContain("at most 366 days");
    expect(rangeProblem("2026-01-01", "2026-12-31", 400)).toBeNull();
  });
  it("labels presets and ranges for people", () => {
    expect(presetLabel(7)).toBe("Last 7 days");
    expect(formatDay("2026-10-27")).toBe("27 Oct");
    expect(formatDay("2026-10-27", true)).toBe("27 Oct 2026");
    expect(formatDay("nonsense")).toBe("nonsense");
    expect(rangeText("2026-10-01", "2026-10-27")).toBe("1 Oct to 27 Oct 2026");
    expect(rangeText("2026-10-27", "2026-10-27")).toBe("27 Oct 2026");
  });
});

describe("chart helpers", () => {
  it("spaces axis labels so they never crowd", () => {
    expect(labelIndexes(0)).toEqual([]);
    expect(labelIndexes(5)).toEqual([0, 1, 2, 3, 4]);
    const many = labelIndexes(30, 6);
    expect(many[0]).toBe(0);
    expect(many.length).toBeLessThanOrEqual(6);
  });
  it("moves a keyboard cursor and stays in range", () => {
    expect(moveCursor(null, "ArrowRight", 5)).toBe(0);
    expect(moveCursor(null, "ArrowLeft", 5)).toBe(4);
    expect(moveCursor(2, "ArrowRight", 5)).toBe(3);
    expect(moveCursor(4, "ArrowRight", 5)).toBe(4);
    expect(moveCursor(0, "ArrowLeft", 5)).toBe(0);
    expect(moveCursor(2, "Home", 5)).toBe(0);
    expect(moveCursor(2, "End", 5)).toBe(4);
    expect(moveCursor(2, "a", 5)).toBeNull();
    expect(moveCursor(2, "ArrowUp", 5)).toBeNull();
    expect(moveCursor(2, "ArrowDown", 5)).toBeNull();
    expect(moveCursor(null, "End", 0)).toBeNull();
  });
  it("maps a pointer position to a day", () => {
    expect(indexAtX(0, 40, 140, 5, "points")).toBe(0);
    expect(indexAtX(90, 40, 140, 5, "points")).toBe(2);
    expect(indexAtX(500, 40, 140, 5, "points")).toBe(4);
    expect(indexAtX(41, 40, 140, 5, "bands")).toBe(0);
    expect(indexAtX(139, 40, 140, 5, "bands")).toBe(4);
    expect(indexAtX(10, 40, 140, 1, "points")).toBe(0);
  });
  it("reads one day aloud", () => {
    expect(readout("2026-10-27", [{ name: "Sent", values: [1, 12] }, { name: "Failed", values: [0, 3] }], 1)).toBe("27 Oct 2026: Sent 12, Failed 3");
  });
});

describe("number wording", () => {
  it("shows rates without false precision", () => {
    expect(shareText(1, 3)).toBe("33%");
    expect(shareText(1, 50)).toBe("2.0%");
    expect(shareText(0, 0)).toBe("-");
    expect(formatPercent(null)).toBe("No data");
    expect(formatPercent(42.5)).toBe("42.5%");
  });
  it("describes usage and warns in words, not just colour", () => {
    expect(usageSummary(820, 1000)).toBe("820 of 1,000 used");
    expect(usageSummary(5, null)).toBe("5 used, no limit");
    expect(usageNote(null)).toBeNull();
    expect(usageNote(50)).toBeNull();
    expect(usageNote(70)).toBe("Getting full");
    expect(usageNote(95)).toBe("Almost full");
    expect(usageNote(100)).toBe("Limit reached");
  });
  it("never shows a raw code as the problem title", () => {
    expect(failureTitle(null)).toBe("Message could not be delivered");
    expect(failureTitle(null, "131026")).toBe("Message could not be delivered (code 131026)");
    expect(failureTitle("The person has not opted in", "131026")).toBe("The person has not opted in");
    expect(failureTitle("The person has not opted in")).toBe("The person has not opted in");
  });
});

describe("accessible charts", () => {
  const days = ["2026-10-25", "2026-10-26", "2026-10-27"];
  it("names the chart, summarises it, offers keyboard help and a table", () => {
    const html = renderToStaticMarkup(createElement(LineChart, { title: "Messages per day", days, series: [{ name: "Sent", values: [1, 5, 2], tone: "accent" }, { name: "Failed", values: [0, 1, 0], tone: "bad" }] }));
    expect(html).toContain("Messages per day");
    expect(html).toContain('role="application"');
    expect(html).toContain('aria-roledescription="chart"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("Sent: 8 in total, busiest on 26 Oct 2026");
    expect(html).toContain("arrow keys");
    expect(html).toContain("View the numbers as a table");
    expect(html).toContain('aria-label="Legend"');
    expect(html).toContain("var(--bad)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
  it("renders a bar chart without a legend and with zero data", () => {
    const html = renderToStaticMarkup(createElement(BarChart, { title: "New conversations per day", days, values: [0, 0, 0], name: "New conversations" }));
    expect(html).toContain("none in this period");
    expect(html).not.toContain('aria-label="Legend"');
  });
});

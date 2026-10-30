import { describe, expect, it } from "vitest";
import {
  SETTING_SPECS,
  approveCopy,
  canRevert,
  describeProposal,
  effectText,
  friendlyOptimizerError,
  numbersFor,
  proposalStatusLabel,
  revertDeadline,
  settingToText,
  shiftNames,
  validateSettings,
} from "@/components/optimizer/helpers";
import { formatMinor } from "@/lib/ads/insights-money";
import { parseConfigInput } from "@/lib/optimizer/config";

const money = (n: number) => formatMinor(n, "INR", "en-IN");

describe("proposal wording", () => {
  it("explains a zero-result pause with the numbers and no internal units", () => {
    const d = describeProposal("pause_ad", { adName: "Diwali offer", spendMinor: 120000, results: 0, windowDays: 7, reason: "zero_results" }, "Spent 120000 minor units in 7 days with no results.", money)!;
    expect(d.title).toBe('Pause "Diwali offer"');
    expect(d.why).toContain("1,200.00");
    expect(d.why).toContain("no results");
    expect(d.why).not.toMatch(/minor/);
  });

  it("explains a high cost per result against the campaign average", () => {
    const d = describeProposal("pause_ad", { adName: "A", spendMinor: 90000, results: 3, windowDays: 7, reason: "high_cpr", cprMinor: 30000, campaignCprMinor: 10000, multiple: 3 }, "", money)!;
    expect(d.why).toContain("300.00");
    expect(d.why).toContain("100.00");
    expect(d.why).toContain("3 times");
  });

  it("reads ad set names out of the server sentence for a budget move", () => {
    const rationale = 'Ad set "Pune" costs 400 per result against 150 for "Mumbai" over 7 days. Move 5000 minor units of daily budget (10%).';
    expect(shiftNames(rationale)).toEqual({ from: "Pune", to: "Mumbai" });
    const d = describeProposal("shift_budget", { amountMinor: 5000, fromCprMinor: 40000, toCprMinor: 15000, windowDays: 7 }, rationale, money)!;
    expect(d.title).toContain('"Mumbai"');
    expect(d.title).toContain("50.00");
  });

  it("returns null when numbers are missing so the caller can show the server text", () => {
    expect(describeProposal("pause_ad", {}, "x", money)).toBeNull();
    expect(describeProposal("shift_budget", { amountMinor: 5 }, "x", money)).toBeNull();
    expect(describeProposal("unknown_kind", {}, "x", money)).toBeNull();
  });

  it("says what approving does", () => {
    expect(effectText("pause_ad", {}, money, 14)).toMatch(/stops showing.*14 days/);
    expect(effectText("shift_budget", { amountMinor: 5000 }, money, 14)).toMatch(/total daily spending stays the same/);
    expect(effectText("new_angle", {}, money, 14)).toMatch(/Nothing changes on Meta/);
  });

  it("names the action on the confirm button", () => {
    expect(approveCopy("pause_ad", "Diwali offer", "x")).toMatchObject({ title: 'Pause "Diwali offer"?', confirmLabel: "Pause ad" });
    expect(approveCopy("shift_budget", "", "x").confirmLabel).toBe("Move budget");
    expect(approveCopy("rotate_creative", "", "x").confirmLabel).toBe("Mark as done");
  });

  it("uses human status words", () => {
    expect(proposalStatusLabel("proposed")).toBe("Waiting for you");
    expect(proposalStatusLabel("applied")).toBe("Applied");
    expect(proposalStatusLabel("whatever")).toBe("Unknown");
  });
});

describe("supporting numbers", () => {
  it("formats money and leaves out missing values", () => {
    const rows = numbersFor("pause_ad", { spendMinor: 120000, results: 0, windowDays: 7 }, money);
    expect(rows).toEqual([
      ["Spent", money(120000)],
      ["Results", "0"],
    ]);
    const shift = numbersFor("shift_budget", { fromBudgetBefore: 10000, fromBudgetAfter: 9000, toBudgetBefore: 20000, toBudgetAfter: 21000, capMinor: 100000 }, money);
    expect(shift[0][1]).toBe(`${money(10000)} to ${money(9000)}`);
    expect(shift.map((r) => r[0])).toEqual(["Budget taken from", "Budget given to", "Daily limit"]);
  });
});

describe("undo window", () => {
  const now = Date.parse("2026-10-27T00:00:00Z");
  it("allows undo only inside the window and only with something to undo", () => {
    expect(canRevert({ status: "applied", appliedAt: "2026-10-20T00:00:00Z", revertPayload: {} }, 14, now)).toBe(true);
    expect(canRevert({ status: "applied", appliedAt: "2026-09-01T00:00:00Z", revertPayload: {} }, 14, now)).toBe(false);
    expect(canRevert({ status: "applied", appliedAt: "2026-10-20T00:00:00Z", revertPayload: null }, 14, now)).toBe(false);
    expect(canRevert({ status: "proposed", appliedAt: null, revertPayload: {} }, 14, now)).toBe(false);
  });

  it("computes the last day to undo", () => {
    expect(revertDeadline("2026-10-20T00:00:00Z", 14)?.toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(revertDeadline(null, 14)).toBeNull();
    expect(revertDeadline("nope", 14)).toBeNull();
  });
});

describe("settings form", () => {
  it("shows money in the currency a person types, not in minor units", () => {
    const spec = SETTING_SPECS.find((s) => s.key === "minSpendMinor")!;
    expect(settingToText(spec, 50000, "INR")).toBe("500");
    expect(settingToText(spec, 50050, "INR")).toBe("500.5");
    expect(settingToText(spec, 500, "JPY")).toBe("500");
    expect(settingToText(SETTING_SPECS.find((s) => s.key === "cprMultiple")!, 2, "INR")).toBe("2");
  });

  // The expiry field moved from expireDays (1-30 days) to expireHours (1-48 hours): docs/SPEND-CONTROLS-SPEC.md 7.3 makes a
  // suggestion expire on the same clock as a spending request, and the engine and service read only expireHours now.
  it("converts back to the units the server stores", () => {
    const values = { minSpendMinor: "500", zeroResultSpendMinor: "1,000", cprMultiple: "2", maxShiftPct: "20", frequencyThreshold: "3", expireHours: "12" };
    const { body, errors } = validateSettings(values, "INR");
    expect(errors).toEqual({});
    expect(body).toEqual({ minSpendMinor: 50000, zeroResultSpendMinor: 100000, cprMultiple: 2, maxShiftPct: 20, frequencyThreshold: 3, expireHours: 12 });
  });

  it("explains out-of-range and missing values next to the field", () => {
    const { body, errors } = validateSettings({ minSpendMinor: "", zeroResultSpendMinor: "1000", cprMultiple: "0.5", maxShiftPct: "50", frequencyThreshold: "3", expireHours: "1.5" }, "INR");
    expect(errors.minSpendMinor).toBe("Enter a number.");
    expect(errors.cprMultiple).toMatch(/1\.1 to 20/);
    expect(errors.maxShiftPct).toMatch(/1 to 20/);
    expect(errors.expireHours).toBe("Enter a whole number.");
    expect(body.zeroResultSpendMinor).toBe(100000);
    expect(body.minSpendMinor).toBeUndefined();
  });

  it("keeps the expiry within the server's 1 to 48 hours and sends no expireDays", () => {
    const base = { minSpendMinor: "1", zeroResultSpendMinor: "1", cprMultiple: "2", maxShiftPct: "20", frequencyThreshold: "3" };
    expect(validateSettings({ ...base, expireHours: "49" }, "INR").errors.expireHours).toMatch(/1 to 48/);
    expect(validateSettings({ ...base, expireHours: "0" }, "INR").errors.expireHours).toMatch(/1 to 48/);
    const ok = validateSettings({ ...base, expireHours: "48" }, "INR");
    expect(ok.body.expireHours).toBe(48);
    expect(ok.body).not.toHaveProperty("expireDays");
    // The bounds mirror the server's own.
    expect(parseConfigInput({ expireHours: 48 })).toEqual({ expireHours: 48 });
    expect(() => parseConfigInput({ expireHours: 49 })).toThrow();
  });

  it("never lets the share moved exceed the hard limit of 20 percent", () => {
    expect(validateSettings({ minSpendMinor: "1", zeroResultSpendMinor: "1", cprMultiple: "2", maxShiftPct: "21", frequencyThreshold: "3", expireHours: "12" }, "INR").errors.maxShiftPct).toBeTruthy();
  });
});

describe("plain-language errors", () => {
  it("translates the common server messages", () => {
    expect(friendlyOptimizerError("This proposal is applied.")).toMatch(/already handled/);
    expect(friendlyOptimizerError("No daily budget cap is set. An owner must set a cap in ad settings first.")).toMatch(/spending limit/);
    expect(friendlyOptimizerError("The workspace daily budget cap leaves no room to raise this budget.")).toMatch(/no room/);
    expect(friendlyOptimizerError(null)).toMatch(/try again/i);
  });
});

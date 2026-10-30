import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillingBanner } from "@/components/billing/BillingBanner";
import {
  bannerMessage,
  daysLeftText,
  formatMoney,
  invoiceStatus,
  limitLines,
  paymentErrorMessage,
  planChoice,
  planFacts,
  priceParts,
  priceText,
  renewalText,
  stateSummary,
  trialProgress,
  validateEmail,
  validateGstin,
  validatePincode,
} from "@/components/billing/helpers";

describe("billing UI helpers", () => {
  it("shows a banner only when action is needed", () => {
    expect(bannerMessage({ state: "active", daysLeftInTrial: null })).toBeNull();
    expect(bannerMessage({ state: "exempt", daysLeftInTrial: null })).toBeNull();
    expect(bannerMessage({ state: "trialing", daysLeftInTrial: 4 })).toBeNull();
    expect(bannerMessage({ state: "trialing", daysLeftInTrial: 3 })?.text).toContain("3 days");
    expect(bannerMessage({ state: "trialing", daysLeftInTrial: 1 })?.text).toContain("1 day.");
    expect(bannerMessage({ state: "past_due_grace", daysLeftInTrial: null })?.tone).toBe("warn");
    expect(bannerMessage({ state: "locked", daysLeftInTrial: null })?.tone).toBe("bad");
    expect(bannerMessage({ state: "suspended", daysLeftInTrial: null, reason: "Abuse" })?.text).toBe("Abuse");
  });
  it("formats prices from the plan and lists limits", () => {
    expect(priceText({ pricePaise: 49900, currency: "INR", intervalMonths: 1 })).toBe("Rs 499 per month");
    expect(priceText({ pricePaise: 150050, currency: "INR", intervalMonths: 12 })).toBe("Rs 1,500.50 per year");
    expect(limitLines({ pricePaise: 1, currency: "INR", intervalMonths: 1, seatLimit: 5, contactLimit: null, monthlyBroadcastLimit: 1000 })).toEqual([
      "Up to 5 team seats", "No fixed limit on contacts", "Up to 1,000 broadcast messages a month",
    ]);
  });
});

const plan = { pricePaise: 49900, currency: "INR", intervalMonths: 1, seatLimit: 5, contactLimit: null, monthlyBroadcastLimit: 1000 };

describe("billing UI wording and states", () => {
  it("describes every billing state in plain words", () => {
    for (const state of ["trialing", "active", "past_due_grace", "locked", "suspended", "exempt"]) {
      const s = stateSummary(state);
      expect(s.label).not.toMatch(/_/);
      expect(s.hint.length).toBeGreaterThan(20);
    }
    expect(stateSummary("past_due_grace")).toMatchObject({ label: "Payment failed", tone: "warn" });
    expect(stateSummary("locked").tone).toBe("bad");
    expect(stateSummary("whatever").label).toBe("Unknown");
  });
  it("splits a price for display and lists comparable facts in a fixed order", () => {
    expect(priceParts(plan)).toEqual({ amount: "Rs 499", per: "per month" });
    expect(planFacts(plan)).toEqual([
      { label: "Team seats", value: "5" },
      { label: "Contacts", value: "No fixed limit" },
      { label: "Broadcast messages a month", value: "1,000" },
    ]);
  });
  it("tracks trial progress and wording", () => {
    expect(trialProgress(4, 14)).toEqual({ used: 10, total: 14 });
    expect(trialProgress(30, 14)).toEqual({ used: 0, total: 14 });
    expect(trialProgress(-2, 14)).toEqual({ used: 14, total: 14 });
    expect(trialProgress(null, 14)).toBeNull();
    expect(trialProgress(3, 0)).toBeNull();
    expect(daysLeftText(1)).toBe("1 day left in your trial");
    expect(daysLeftText(5)).toBe("5 days left in your trial");
    expect(daysLeftText(0)).toBe("Your trial ends today");
  });
  it("says when a plan renews or ends", () => {
    expect(renewalText(null)).toBeNull();
    expect(renewalText({ status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: "2026-11-12T00:00:00Z", plan: { name: "Pro" } })).toMatch(/^Renews on .*2026\./);
    expect(renewalText({ status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: "2026-11-12T00:00:00Z", plan: { name: "Pro" } })).toMatch(/will not renew/);
  });
  it("decides which plan buttons work and why", () => {
    const active = { status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: null, plan: { name: "Pro" } };
    expect(planChoice({ name: "Pro" }, active, true)).toEqual({ disabled: true, current: true, reason: null });
    expect(planChoice({ name: "Basic" }, active, true).reason).toMatch(/already have an active plan/);
    expect(planChoice({ name: "Basic" }, null, true)).toEqual({ disabled: false, current: false, reason: null });
    expect(planChoice({ name: "Basic" }, { ...active, cancelAtPeriodEnd: true }, true).disabled).toBe(false);
    expect(planChoice({ name: "Basic" }, null, false)).toMatchObject({ disabled: true });
    expect(planChoice({ name: "Basic" }, null, false).reason).toMatch(/not set up/);
  });
  it("turns payment errors into advice", () => {
    expect(paymentErrorMessage("Payment window could not load.")).toMatch(/could not open/);
    expect(paymentErrorMessage("Something went wrong.")).toMatch(/Check your connection/);
    expect(paymentErrorMessage("Plan is not available.")).toBe("Plan is not available.");
    expect(paymentErrorMessage("signature mismatch", "confirm")).toMatch(/If you were charged/);
    expect(paymentErrorMessage("signature mismatch", "confirm")).not.toMatch(/signature/);
  });
  it("labels invoices and money", () => {
    expect(invoiceStatus("paid")).toEqual({ label: "Paid", tone: "good" });
    expect(invoiceStatus("void").label).toBe("Cancelled");
    expect(invoiceStatus("issued").label).toBe("Issued");
    expect(formatMoney(49900, "INR")).toBe("Rs 499.00");
    expect(formatMoney(1000, "USD")).toBe("USD 10.00");
  });
  it("validates billing details with fixes, not codes", () => {
    expect(validateGstin("")).toBeNull();
    expect(validateGstin("22AAAAA0000A1Z5")).toBeNull();
    expect(validateGstin("123")).toMatch(/15 letters and numbers/);
    expect(validatePincode("560001")).toBeNull();
    expect(validatePincode("5600")).toMatch(/6-digit/);
    expect(validateEmail("")).toMatch(/Enter an email/);
    expect(validateEmail("a@b")).toMatch(/valid email/);
    expect(validateEmail("accounts@shop.in")).toBeNull();
  });
});

describe("billing banner", () => {
  const render = (status: Parameters<typeof BillingBanner>[0]["status"]) => renderToStaticMarkup(createElement(BillingBanner, { status }));
  it("renders nothing when no action is needed", () => {
    expect(render({ state: "active", daysLeftInTrial: null })).toBe("");
    expect(render({ state: "trialing", daysLeftInTrial: 10 })).toBe("");
  });
  it("announces trial and payment problems politely and blocks loudly", () => {
    const trial = render({ state: "trialing", daysLeftInTrial: 2 });
    expect(trial).toContain('role="status"');
    expect(trial).toContain("2 days");
    expect(trial).toContain("Choose a plan");
    expect(trial).toContain("border-warn-line");
    const pastDue = render({ state: "past_due_grace", daysLeftInTrial: null });
    expect(pastDue).toContain("Choose a plan");
    expect(pastDue).not.toContain("payment method");
    const locked = render({ state: "locked", daysLeftInTrial: null });
    expect(locked).toContain('role="alert"');
    expect(locked).toContain("border-bad-line");
    expect(locked).not.toMatch(/red-\d{2,3}|amber-\d{2,3}/);
  });
});

describe("invoice print styles", () => {
  it("forces light tokens and hides the app chrome when printing", async () => {
    const { INVOICE_PRINT_CSS } = await import("@/components/billing/PrintStyles");
    expect(INVOICE_PRINT_CSS).toContain("@media print");
    expect(INVOICE_PRINT_CSS).toContain("--foreground: #0f172a");
    expect(INVOICE_PRINT_CSS).toContain("color-scheme: light");
    expect(INVOICE_PRINT_CSS).toMatch(/aside, header, nav/);
  });
});

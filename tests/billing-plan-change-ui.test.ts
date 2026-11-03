import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The billing page's plan changes (owner decision 4): upgrade now, switch at renewal, keep, and start a new plan later. */

const page = vi.hoisted(() => ({ role: "owner" as "owner" | "admin" | "agent", overview: null as unknown }));
vi.mock("@/components/contacts/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/contacts/hooks")>()),
  useRole: () => page.role,
  useApi: (p: string | null) => ({
    data: p === "/api/billing" ? page.overview : p === "/api/billing/usage" ? { lines: [], alerts: [], plan: { state: "active", planName: "Growth" } } : null,
    error: null,
    loading: false,
    reload: () => {},
    retry: () => {},
  }),
}));

import { BillingView } from "@/components/billing/BillingView";
import { isNewSubscriptionNeeded, planChangeDoneText, planChoice, scheduledChangeText, type ScheduledChangeLike } from "@/components/billing/helpers";
import { planMove } from "@/lib/billing/plan-compare";

const NOW = new Date("2026-11-10T00:00:00Z");
// Midday UTC, so the page's local date reads 30 Nov in any time zone the tests run in.
const END = "2026-11-30T12:00:00.000Z";
const growthSub = { status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: END, plan: { name: "Growth", pricePaise: 249_900 } };
const starter = { name: "Starter", pricePaise: 99_900 };
const agency = { name: "Agency", pricePaise: 599_900 };
const at = (kind: NonNullable<ScheduledChangeLike>["kind"], planName: string, authorized = true): ScheduledChangeLike => ({ kind, planName, at: END, authorized });

describe("planChoice: what each plan's button does", () => {
  it("a dearer plan upgrades now; a cheaper one switches at the renewal; nothing is charged for a switch", () => {
    expect(planChoice(agency, growthSub, true, { now: NOW })).toEqual({ disabled: false, current: false, action: "upgrade", label: "Upgrade to Agency", reason: "Starts now. You pay only the difference for the rest of this period." });
    expect(planChoice(starter, growthSub, true, { now: NOW })).toEqual({ disabled: false, current: false, action: "downgrade", label: "Switch to Starter", reason: "Starts when your current period ends on 30 Nov 2026. Nothing is charged now." });
    // The same price is not an upgrade: it waits for the renewal, so nobody pays twice in a period.
    expect(planChoice({ name: "Growth Plus", pricePaise: 249_900 }, growthSub, true, { now: NOW }).action).toBe("downgrade");
  });

  it("only the owner changes a running plan; an admin is told why", () => {
    expect(planChoice(agency, growthSub, true, { isOwner: false, now: NOW })).toMatchObject({ disabled: true, action: "none", label: "Upgrade to Agency", reason: "Only the workspace owner can change the plan." });
  });

  it("a planned downgrade: the current plan offers Keep, the target says when it starts", () => {
    const scheduled = at("downgrade", "Starter");
    expect(planChoice({ name: "Growth", pricePaise: 249_900 }, growthSub, true, { scheduled, now: NOW })).toMatchObject({ disabled: false, current: true, action: "keep", label: "Keep Growth" });
    expect(planChoice(starter, growthSub, true, { scheduled, now: NOW })).toMatchObject({ disabled: true, label: "Starts 30 Nov 2026", reason: "Your plan changes to Starter on 30 Nov 2026." });
    expect(planChoice({ name: "Growth" }, growthSub, true, { scheduled, isOwner: false, now: NOW })).toMatchObject({ disabled: true, label: "Current plan" });
  });

  it("a plan set to end: another plan starts the day it ends (a new subscription), until one is approved", () => {
    const ending = { ...growthSub, cancelAtPeriodEnd: true };
    expect(planChoice(agency, ending, true, { now: NOW })).toMatchObject({ disabled: false, action: "start_later", label: "Start Agency on 30 Nov 2026" });
    expect(planChoice(agency, ending, true, { now: NOW }).reason).toMatch(/nothing is charged before that day/);
    expect(planChoice(agency, ending, true, { scheduled: at("next_subscription", "Agency"), now: NOW })).toMatchObject({ disabled: true, label: "Starts 30 Nov 2026" });
    expect(planChoice(starter, ending, true, { scheduled: at("next_subscription", "Agency"), now: NOW })).toMatchObject({ disabled: true, reason: expect.stringMatching(/Cancel that change first/) });
    // Not approved yet: choosing it again finishes the payment step.
    expect(planChoice(agency, ending, true, { scheduled: at("next_subscription", "Agency", false), now: NOW }).action).toBe("start_later");
    // Once the period is over, it is an ordinary subscription again.
    expect(planChoice(agency, ending, true, { now: new Date("2026-12-01T00:00:00Z") }).action).toBe("subscribe");
  });

  it("no plan, or a plan that ended: subscribe", () => {
    expect(planChoice(agency, null, true)).toMatchObject({ action: "subscribe", label: "Subscribe to Agency", disabled: false });
    expect(planChoice(agency, { ...growthSub, status: "past_due" }, true)).toMatchObject({ action: "subscribe" });
  });

  it("the plan ended and the approved new plan waits for its first payment: no second subscription is offered", () => {
    const ended = { ...growthSub, status: "canceled", cancelAtPeriodEnd: true };
    const after = new Date("2026-12-02T00:00:00Z");
    const next = at("next_subscription", "Agency");
    expect(planChoice(agency, ended, true, { scheduled: next, now: after })).toEqual({ disabled: true, current: false, action: "none", label: "Starting", reason: "Agency starts as soon as its first payment goes through." });
    expect(planChoice(starter, ended, true, { scheduled: next, now: after })).toMatchObject({ disabled: true, action: "none", reason: "Agency is already set to start. Cancel that change first to choose another plan." });
    // Not approved: it cannot start, so subscribing is open again (the server cancels the unapproved one first).
    expect(planChoice(starter, ended, true, { scheduled: at("next_subscription", "Agency", false), now: after })).toMatchObject({ action: "subscribe", disabled: false });
    expect(planChoice(starter, ended, true, { now: after })).toMatchObject({ action: "subscribe" });
  });
});

describe("monthly and yearly plans: the same rule as the server", () => {
  const growthYearly = { ...growthSub, plan: { name: "Growth yearly", pricePaise: 2_000_000, intervalMonths: 12 } };
  const starterMonthly = { ...growthSub, plan: { name: "Starter", pricePaise: 99_900, intervalMonths: 1 } };

  it("planMove: price per month within one interval; any change of interval waits for the renewal", () => {
    expect(planMove({ pricePaise: 249_900, intervalMonths: 1 }, { pricePaise: 599_900, intervalMonths: 1 })).toBe("upgrade");
    expect(planMove({ pricePaise: 599_900, intervalMonths: 1 }, { pricePaise: 249_900, intervalMonths: 1 })).toBe("downgrade");
    expect(planMove({ pricePaise: 249_900, intervalMonths: 1 }, { pricePaise: 249_900, intervalMonths: 1 })).toBe("downgrade");
    expect(planMove({ pricePaise: 999_000, intervalMonths: 12 }, { pricePaise: 2_000_000, intervalMonths: 12 })).toBe("upgrade");
    expect(planMove({ pricePaise: 2_000_000, intervalMonths: 12 }, { pricePaise: 599_900, intervalMonths: 1 })).toBe("interval");
    expect(planMove({ pricePaise: 99_900, intervalMonths: 1 }, { pricePaise: 999_000, intervalMonths: 12 })).toBe("interval");
    // An unknown interval counts as monthly.
    expect(planMove({ pricePaise: 99_900 }, { pricePaise: 249_900, intervalMonths: 1 })).toBe("upgrade");
  });

  it("Growth yearly to Agency monthly switches at the renewal and says why", () => {
    expect(planChoice({ ...agency, intervalMonths: 1 }, growthYearly, true, { now: NOW })).toEqual({
      disabled: false,
      current: false,
      action: "downgrade",
      label: "Switch to Agency",
      reason: "Starts when your current period ends on 30 Nov 2026, because it is billed per month instead of per year. Nothing is charged now.",
    });
  });

  it("Starter monthly to Starter yearly is not charged now", () => {
    const choice = planChoice({ name: "Starter yearly", pricePaise: 999_000, intervalMonths: 12 }, starterMonthly, true, { now: NOW });
    expect(choice).toMatchObject({ action: "downgrade", label: "Switch to Starter yearly" });
    expect(choice.reason).toContain("because it is billed per year instead of per month");
  });

  it("a dearer yearly plan from a yearly plan is an upgrade now", () => {
    expect(planChoice({ name: "Agency yearly", pricePaise: 5_000_000, intervalMonths: 12 }, growthYearly, true, { now: NOW })).toMatchObject({ action: "upgrade", label: "Upgrade to Agency yearly" });
  });
});

describe("the words", () => {
  it("Changes to X on <date>, and what an unfinished or unconfirmed change means", () => {
    expect(scheduledChangeText(null)).toBeNull();
    expect(scheduledChangeText(at("downgrade", "Starter"))).toBe("Changes to Starter on 30 Nov 2026.");
    expect(scheduledChangeText(at("next_subscription", "Agency"))).toBe("Changes to Agency on 30 Nov 2026.");
    expect(scheduledChangeText(at("next_subscription", "Agency", false))).toMatch(/^Agency is not set up yet\. .*finish the payment step/);
    expect(scheduledChangeText(at("upgrade", "Agency"))).toMatch(/^Moving to Agency\./);
    // Its start day has come: it is waiting for its first payment.
    expect(scheduledChangeText(at("next_subscription", "Agency"), new Date("2026-12-02T00:00:00Z"))).toBe("Agency is starting. It switches on as soon as its first payment goes through.");
    expect(scheduledChangeText(at("next_subscription", "Agency"), NOW)).toBe("Changes to Agency on 30 Nov 2026.");
  });

  it("the toast after each change", () => {
    expect(planChangeDoneText({ change: "upgraded", planName: "Agency" })).toBe("You are now on Agency.");
    expect(planChangeDoneText({ change: "scheduled", planName: "Starter", at: END })).toBe("Changes to Starter on 30 Nov 2026.");
    expect(planChangeDoneText({ change: "kept", planName: "Growth" })).toBe("You stay on Growth.");
    expect(planChangeDoneText({ change: "kept", planName: "Growth", endsOn: END })).toBe("The new plan will not start. Your current plan still ends on 30 Nov 2026.");
    expect(planChangeDoneText({ change: "processing", planName: "Agency" })).toMatch(/^Moving to Agency/);
    // Called off after the current plan already ended: nothing runs now.
    expect(planChangeDoneText({ change: "kept", planName: "Growth", endsOn: null, ended: true })).toBe("The new plan will not start. Choose a plan under Plans to continue.");
  });

  it("recognises the 409 that asks for a new subscription", () => {
    expect(isNewSubscriptionNeeded({ error: "x", code: "new_subscription_needed", planId: "p", planName: "A", endsOn: END, method: "upi" })).toBe(true);
    expect(isNewSubscriptionNeeded({ error: "x" })).toBe(false);
    expect(isNewSubscriptionNeeded(null)).toBe(false);
  });
});

describe("the billing page", () => {
  const plans = [
    { id: "p_s", name: "Starter", description: null, pricePaise: 99_900, currency: "INR", intervalMonths: 1, seatLimit: 2, contactLimit: 1000, monthlyBroadcastLimit: 1000 },
    { id: "p_g", name: "Growth", description: null, pricePaise: 249_900, currency: "INR", intervalMonths: 1, seatLimit: 5, contactLimit: 5000, monthlyBroadcastLimit: 5000 },
    { id: "p_a", name: "Agency", description: null, pricePaise: 599_900, currency: "INR", intervalMonths: 1, seatLimit: 20, contactLimit: null, monthlyBroadcastLimit: null },
  ];
  const overview = (over: Record<string, unknown> = {}) => ({
    status: { state: "active", canWrite: true, daysLeftInTrial: null, trialEndsAt: null, currentPeriodEnd: END, planName: "Growth" },
    subscription: growthSub,
    invoices: [],
    billingProfile: null,
    plans,
    trialDays: 14,
    paymentsConfigured: true,
    scheduledChange: null,
    ...over,
  });
  const render = () => renderToStaticMarkup(createElement(BillingView));

  beforeEach(() => {
    page.role = "owner";
    page.overview = overview();
  });

  it("offers Upgrade to the dearer plan and Switch to the cheaper one, with what each does", () => {
    const html = render();
    expect(html).toContain("Upgrade to Agency");
    expect(html).toContain("Switch to Starter");
    expect(html).toContain("Current plan");
    expect(html).toContain("You pay only the difference for the rest of this period.");
    expect(html).toContain("Every plan has every feature; plans differ in limits.");
  });

  it("says Changes to X on <date> under Your plan, and the current plan's card offers Keep", () => {
    page.overview = overview({ scheduledChange: at("downgrade", "Starter") });
    const html = render();
    expect(html).toContain("Changes to Starter on 30 Nov 2026.");
    expect(html).toContain("Keep Growth");
    expect(html).toMatch(/aria-live="polite"[^>]*>Changes to Starter/);
  });

  it("a new plan waiting for the period's end can be called off by the owner", () => {
    page.overview = overview({ subscription: { ...growthSub, cancelAtPeriodEnd: true }, scheduledChange: at("next_subscription", "Agency") });
    const html = render();
    expect(html).toContain("Changes to Agency on 30 Nov 2026.");
    expect(html).toContain("Do not start Agency");
  });

  it("after the plan ended, an approved new plan that is starting replaces 'Choose a plan to continue'", () => {
    vi.useFakeTimers({ now: new Date("2026-12-02T00:00:00Z"), toFake: ["Date"] });
    try {
      page.overview = overview({
        status: { state: "locked", canWrite: false, daysLeftInTrial: null, trialEndsAt: null, currentPeriodEnd: END, planName: "Growth", reason: "Your subscription has ended." },
        subscription: { ...growthSub, status: "canceled", cancelAtPeriodEnd: true },
        scheduledChange: at("next_subscription", "Agency"),
      });
      const html = render();
      expect(html).toContain("Agency is starting. It switches on as soon as its first payment goes through.");
      expect(html).not.toContain("Choose a plan to continue");
      expect(html).toContain("Do not start Agency");
      expect(html).toContain("Starting");
      expect(html).toContain("Agency is already set to start. Cancel that change first to choose another plan.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an admin sees the plans but the buttons explain that only the owner changes the plan", () => {
    page.role = "admin";
    const html = render();
    expect(html).toContain("Only the workspace owner can change the plan.");
    expect(html).not.toContain("Do not start");
  });
});

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Plan changes (owner decision 4): upgrades apply at once with Razorpay's proration (schedule_change_at "now"), downgrades at
 * renewal ("cycle_end", "Changes to X on <date>"). Subscriptions Razorpay cannot update (UPI AutoPay, e-mandate, domestic cards)
 * get an explanation and the cancel-at-period-end plus new-subscription path. Hand-assigned plans answer 409 with the
 * contact-support text. The subscription.updated webhook and every change are audited. Razorpay is mocked: no real call.
 */

type Row = Record<string, unknown>;
const store = vi.hoisted(() => ({ settings: new Map<string, unknown>(), updated: new Map<string, Date>(), row: null as Record<string, unknown> | null }));
const PLANS = vi.hoisted(() => [
  { id: "p_starter", code: "starter", name: "Starter", pricePaise: 99_900, currency: "INR", intervalMonths: 1, razorpayPlanId: "plan_starter", active: true },
  { id: "p_growth", code: "growth", name: "Growth", pricePaise: 249_900, currency: "INR", intervalMonths: 1, razorpayPlanId: "plan_growth", active: true },
  { id: "p_agency", code: "agency", name: "Agency", pricePaise: 599_900, currency: "INR", intervalMonths: 1, razorpayPlanId: "plan_agency", active: true },
  { id: "p_trial", code: "trial", name: "Trial", pricePaise: 0, currency: "INR", intervalMonths: 1, razorpayPlanId: null, active: true },
  // Yearly plans beside the monthly ones (site/pricing.ts hasBothIntervals): Rs 9,990 and Rs 20,000 a year.
  { id: "p_starter_year", code: "starter-yearly", name: "Starter yearly", pricePaise: 999_000, currency: "INR", intervalMonths: 12, razorpayPlanId: "plan_starter_year", active: true },
  { id: "p_growth_year", code: "growth-yearly", name: "Growth yearly", pricePaise: 2_000_000, currency: "INR", intervalMonths: 12, razorpayPlanId: "plan_growth_year", active: true },
]);
const db = vi.hoisted(() => {
  const planBy = (id: unknown) => PLANS.find((p) => p.id === id) ?? null;
  const withPlan = (r: Record<string, unknown> | null) => (r ? { ...r, plan: planBy(r.planId) } : null);
  return {
    planBy,
    plan: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        PLANS.find((p) => (where.id === undefined || p.id === where.id) && (where.razorpayPlanId === undefined || p.razorpayPlanId === where.razorpayPlanId) && (where.active === undefined || p.active === where.active)) ?? null,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => planBy(where.id)),
      findMany: vi.fn(async () => PLANS.filter((p) => p.active)),
      update: vi.fn(),
    },
    subscription: {
      findUnique: vi.fn(async ({ where }: { where: { tenantId?: string; razorpaySubscriptionId?: string } }) => {
        const r = store.row;
        if (!r) return null;
        if (where.tenantId !== undefined) return where.tenantId === r.tenantId ? withPlan(r) : null;
        return where.razorpaySubscriptionId === r.razorpaySubscriptionId ? withPlan(r) : null;
      }),
      update: vi.fn(async ({ data, include }: { data: Record<string, unknown>; include?: unknown }) => {
        store.row = { ...store.row!, ...data };
        return include ? withPlan(store.row) : { ...store.row };
      }),
      upsert: vi.fn(),
      findMany: vi.fn(async () => []),
    },
    platformSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (store.settings.has(where.key) ? { key: where.key, value: store.settings.get(where.key) } : null)),
      upsert: vi.fn(async ({ where, update, create }: { where: { key: string }; update: { value: unknown }; create: { value: unknown } }) => {
        store.settings.set(where.key, store.settings.has(where.key) ? update.value : create.value);
        store.updated.set(where.key, new Date());
        return {};
      }),
      create: vi.fn(async ({ data }: { data: { key: string; value: unknown } }) => {
        if (store.settings.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
        store.settings.set(data.key, data.value);
        store.updated.set(data.key, new Date());
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { key: string } }) => {
        store.updated.delete(where.key);
        return { count: store.settings.delete(where.key) ? 1 : 0 };
      }),
      // Only the timestamp: the sweep moves a row it checked to the back of the queue.
      updateMany: vi.fn(async ({ where, data }: { where: { key: string }; data: { updatedAt: Date } }) => {
        if (!store.settings.has(where.key)) return { count: 0 };
        store.updated.set(where.key, data.updatedAt);
        return { count: 1 };
      }),
      findMany: vi.fn(async ({ where, orderBy, take }: { where: { key: { startsWith: string; gt?: string } }; orderBy?: { key?: "asc"; updatedAt?: "asc" }; take?: number }) => {
        const rows = [...store.settings.entries()]
          .filter(([k]) => k.startsWith(where.key.startsWith) && (where.key.gt === undefined || k > where.key.gt))
          .map(([key, value]) => ({ key, value, updatedAt: store.updated.get(key) ?? new Date(0) }));
        if (orderBy?.key) rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        if (orderBy?.updatedAt) rows.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
        return take === undefined ? rows : rows.slice(0, take);
      }),
    },
    auditLog: { create: vi.fn(async (_args: unknown) => ({})) },
    invoice: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: { data: { totalPaise: number } }) => ({ id: "inv1", totalPaise: data.totalPaise })) },
    billingProfile: { findUnique: vi.fn(async () => null) },
    paymentEvent: { create: vi.fn(async (_args: unknown) => ({ id: "pe1" })), findUnique: vi.fn(), update: vi.fn(async (_args: unknown) => ({})) },
    tenant: { findUnique: vi.fn(async (_args?: unknown): Promise<Record<string, unknown>> => ({ name: "Acme" })) },
    membership: { findMany: vi.fn(async () => []) },
  };
});
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/email", () => ({ queueEmail: vi.fn() }));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/auth", () => auth);

import { POST as changePlanRoute } from "@/app/api/billing/change-plan/route";
import { POST as subscribeRoute } from "@/app/api/billing/subscribe/route";
import { POST as verifyRoute } from "@/app/api/billing/verify/route";
import { cancelAtPeriodEnd, billingOverview, MANUAL_PLAN_TEXT } from "@/lib/billing/service";
import {
  PlanChangeNeedsNewSubscription,
  UPGRADE_INVOICE_PREFIX,
  cancelNextSubscriptionForErasure,
  changePlan,
  newSubscriptionText,
  planChangeKey,
  readPlanChange,
  reconcilePlanChanges,
  reconcileUpgradeInvoices,
  refusedForMethod,
} from "@/lib/billing/plan-change";
import { NEXT_STARTING_REASON, getBillingStatus } from "@/lib/billing/status";
import { RazorpayRequestError, cancelScheduledChanges, createSubscription, updateSubscription } from "@/lib/billing/razorpay";
import { handleRazorpayWebhook } from "@/lib/billing/webhook";
import { worker } from "@/lib/billing/worker";
import { HttpError } from "@/lib/tenancy";

const ORIGIN = "https://wa.edwyz.com";
const NOW = new Date("2026-11-10T00:00:00Z");
const PERIOD_END = new Date("2026-11-30T00:00:00Z");
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const owner = { userId: "u1", tenantId: "t1", role: "owner" as const };
const subRow = (over: Row = {}): Row => ({
  id: "s1", tenantId: "t1", planId: "p_growth", status: "active", razorpaySubscriptionId: "sub_1",
  currentPeriodStart: new Date("2026-10-31T00:00:00Z"), currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: false, pastDueSince: null, ...over,
});

// ----- Razorpay, mocked at fetch -----
type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
const calls: Call[] = [];
let replies: Record<string, (c: Call) => [number, unknown]> = {};
const fetchMock = vi.fn(async (url: string, init: { method: string; body?: string }) => {
  const u = new URL(url);
  const call = { method: init.method, path: u.pathname.replace(/^\/v1/, ""), body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(call);
  const handler = replies[`${call.method} ${call.path}`];
  const [status, body] = handler ? handler(call) : [404, { error: { description: "not mocked" } }];
  return new Response(JSON.stringify(body), { status });
});
const remoteSub = (over: Row = {}) => ({ id: "sub_1", status: "active", plan_id: "plan_growth", payment_method: "card", current_start: unix(new Date("2026-10-31T00:00:00Z")), current_end: unix(PERIOD_END), notes: { tenantId: "t1" }, ...over });
const audits = () => db.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string; meta?: Row; target?: string } }).data);
const actions = () => audits().map((a) => a.action);
const req = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
  new Request(`${ORIGIN}/api/billing/change-plan`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  // A test that moved the clock (the gap after a plan ends) must not move the next one.
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", fetchMock);
  calls.length = 0;
  replies = { "GET /subscriptions/sub_1": () => [200, remoteSub()] };
  store.settings.clear();
  store.updated.clear();
  store.row = subRow();
  db.tenant.findUnique.mockImplementation(async () => ({ name: "Acme" }));
  process.env.RAZORPAY_KEY_ID = "rzp_test_k";
  process.env.RAZORPAY_KEY_SECRET = "keysecret";
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsecret";
  auth.getActor.mockResolvedValue(owner);
});

describe("Razorpay client for plan changes", () => {
  it("updates with PATCH, the new plan and when; cancels scheduled changes; starts a subscription later with start_at", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    replies["POST /subscriptions/sub_1/cancel_scheduled_changes"] = () => [200, remoteSub()];
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    await updateSubscription("sub_1", { razorpayPlanId: "plan_agency", scheduleChangeAt: "now" });
    await cancelScheduledChanges("sub_1");
    await createSubscription({ razorpayPlanId: "plan_starter", intervalMonths: 1, notes: { tenantId: "t1" }, startAt: 1_800_000_000 });
    expect(calls[0]).toEqual({ method: "PATCH", path: "/subscriptions/sub_1", body: { plan_id: "plan_agency", schedule_change_at: "now", customer_notify: true } });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/subscriptions/sub_1/cancel_scheduled_changes" });
    expect(calls[2].body).toMatchObject({ plan_id: "plan_starter", start_at: 1_800_000_000 });
  });

  it("a refusal keeps its 502 for everyone and carries Razorpay's status and reason for the plan change", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [400, { error: { code: "BAD_REQUEST_ERROR", description: "subscriptions cannot be updated when payment mode is UPI" } }];
    const error = await updateSubscription("sub_1", { razorpayPlanId: "plan_agency", scheduleChangeAt: "now" }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toBeInstanceOf(RazorpayRequestError);
    expect(error).toMatchObject({ status: 502, providerStatus: 400, providerCode: "BAD_REQUEST_ERROR", providerDescription: "subscriptions cannot be updated when payment mode is UPI" });
    expect(refusedForMethod(error, null)).toBe(true);
    expect(refusedForMethod(new RazorpayRequestError("x", 400, null, "Only the offer can be updated for this subscription"), "card")).toBe(true);
    expect(refusedForMethod(new RazorpayRequestError("x", 400, null, "Subscription update is not supported for cards issued in India"), "card")).toBe(true);
    expect(refusedForMethod(new RazorpayRequestError("x", 400, null, "anything at all"), "upi")).toBe(true);
    expect(refusedForMethod(new RazorpayRequestError("x", 400, null, "anything at all"), "emandate")).toBe(true);
    expect(refusedForMethod(new RazorpayRequestError("x", 500, null, "upi"), "upi")).toBe(false);
    expect(refusedForMethod(new Error("upi"), "upi")).toBe(false);
  });

  it("an ordinary 400 on a card subscription is not a payment-method refusal", () => {
    // A declined charge, a bad plan, a period mismatch or a pending invoice: Razorpay's reason is passed on instead.
    for (const reason of ["amount too small", "Payment failed: your card was declined", "The id provided does not exist", "Plan period cannot be changed", "The subscription has a pending invoice", "International cards are not allowed", null]) {
      expect(refusedForMethod(new RazorpayRequestError("x", 400, null, reason), "card"), String(reason)).toBe(false);
      expect(refusedForMethod(new RazorpayRequestError("x", 400, null, reason), null), String(reason)).toBe(false);
    }
  });
});

describe("upgrade: applies now, Razorpay prorates", () => {
  it("updates with schedule_change_at now, switches the plan, records the order, audits and invoices the difference", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_agency" })];
    replies["GET /invoices"] = () => [200, { items: [
      { id: "inv_rz_old", status: "paid", payment_id: "pay_old", amount: 249_900, currency: "INR", paid_at: unix(new Date("2026-10-31T00:00:00Z")) },
      { id: "inv_rz_new", status: "paid", payment_id: "pay_diff", amount: 233_266, currency: "INR", paid_at: unix(NOW) },
    ] }];
    const result = await changePlan(owner, "p_agency");
    expect(result).toEqual({ ok: true, change: "upgraded", planName: "Agency" });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ plan_id: "plan_agency", schedule_change_at: "now", customer_notify: true });
    expect(store.row).toMatchObject({ planId: "p_agency", currentPeriodEnd: PERIOD_END });
    expect(store.settings.get("billing:last-event:t1")).toEqual({ at: unix(NOW) });
    expect(audits().find((a) => a.action === "billing.plan_changed")).toMatchObject({ target: "p_agency", meta: { from: "growth", to: "agency", source: "upgrade" } });
    // Only the charge this change made is invoiced (the earlier period was invoiced when it was paid).
    expect(db.invoice.create).toHaveBeenCalledTimes(1);
    expect(db.invoice.create.mock.calls[0][0]).toMatchObject({ data: { razorpayPaymentId: "pay_diff", totalPaise: 233_266, planName: "Agency" } });
    expect(store.settings.has(planChangeKey("t1"))).toBe(false);
    // Found at once: nothing left for the sweep to look for.
    expect(store.settings.has(`${UPGRADE_INVOICE_PREFIX}t1`)).toBe(false);
  });

  it("a charge Razorpay has not captured yet is invoiced by the sweep once it is, and the search stops after three days", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_agency" })];
    let items: unknown[] = [];
    replies["GET /invoices"] = () => [200, { items }];
    expect(await changePlan(owner, "p_agency")).toMatchObject({ change: "upgraded" });
    expect(db.invoice.create).not.toHaveBeenCalled();
    expect(store.settings.get(`${UPGRADE_INVOICE_PREFIX}t1`)).toMatchObject({ subscriptionId: "sub_1", planName: "Agency", since: NOW.toISOString() });

    // Still not captured: kept, and moved to the back of the queue.
    expect(await reconcileUpgradeInvoices(new Date(NOW.getTime() + 15 * 60_000))).toBe(0);
    expect(store.settings.has(`${UPGRADE_INVOICE_PREFIX}t1`)).toBe(true);
    expect(store.updated.get(`${UPGRADE_INVOICE_PREFIX}t1`)).toEqual(new Date(NOW.getTime() + 15 * 60_000));

    items = [{ id: "inv_rz", status: "paid", payment_id: "pay_late", amount: 233_266, currency: "INR", paid_at: unix(NOW) + 3600 }];
    expect(await reconcileUpgradeInvoices(new Date(NOW.getTime() + 2 * 3_600_000))).toBe(1);
    expect(db.invoice.create.mock.calls[0][0]).toMatchObject({ data: { razorpayPaymentId: "pay_late", totalPaise: 233_266, planName: "Agency" } });
    expect(store.settings.has(`${UPGRADE_INVOICE_PREFIX}t1`)).toBe(false);
  });

  it("the search for an upgrade's charge ends after three days with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_agency" })];
    replies["GET /invoices"] = () => [200, { items: [] }];
    await changePlan(owner, "p_agency");
    expect(await reconcileUpgradeInvoices(new Date(NOW.getTime() + 4 * 86_400_000))).toBe(0);
    expect(store.settings.has(`${UPGRADE_INVOICE_PREFIX}t1`)).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("manual check"))).toBe(true);
  });

  it("accepted but not on the new plan yet: waits for the webhook and says so", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    expect(await changePlan(owner, "p_agency")).toEqual({ ok: true, change: "processing", planName: "Agency" });
    expect(store.row).toMatchObject({ planId: "p_growth" });
    expect(await readPlanChange("t1")).toMatchObject({ kind: "upgrade", toPlanId: "p_agency" });
    await expect(changePlan(owner, "p_starter")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("still being confirmed") });
  });

  it("a failed upgrade charge changes nothing here: Razorpay's reason is passed on", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [500, { error: { description: "Payment failed" } }];
    await expect(changePlan(owner, "p_agency")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("Payment failed") });
    expect(store.row).toMatchObject({ planId: "p_growth" });
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("a 400 declining the prorated charge on a card is that failure, not 'Razorpay cannot change a plan paid this way'", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [400, { error: { code: "BAD_REQUEST_ERROR", description: "Payment failed: your card was declined" } }];
    const error = await changePlan(owner, "p_agency").catch((e) => e);
    expect(error).not.toBeInstanceOf(PlanChangeNeedsNewSubscription);
    expect(error).toMatchObject({ status: 502, message: "The payment provider rejected the request: Payment failed: your card was declined" });
    expect(actions()).not.toContain("billing.plan_change_unavailable");
    expect(store.row).toMatchObject({ planId: "p_growth" });
    expect(await readPlanChange("t1")).toBeNull();
    // Through the route it is the usual error, without the new-subscription code.
    const res = await changePlanRoute(req({ planId: "p_agency" }));
    expect(res.status).toBe(502);
    expect(await res.json()).not.toHaveProperty("code", "new_subscription_needed");
  });
});

describe("monthly and yearly plans: price per month, and a change of interval waits for the renewal", () => {
  it("Growth yearly to Agency monthly is a change of interval: scheduled for the renewal, charged nothing now", async () => {
    store.row = subRow({ planId: "p_growth_year" });
    replies["GET /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_growth_year" })];
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_growth_year", has_scheduled_changes: true, change_scheduled_at: unix(PERIOD_END) })];
    expect(await changePlan(owner, "p_agency")).toEqual({ ok: true, change: "scheduled", planName: "Agency", at: PERIOD_END.toISOString() });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ plan_id: "plan_agency", schedule_change_at: "cycle_end", customer_notify: true });
    expect(audits().find((a) => a.action === "billing.plan_change_scheduled")?.meta).toMatchObject({ when: "cycle_end", fromMonths: 12, toMonths: 1 });
    expect(store.row).toMatchObject({ planId: "p_growth_year" });
  });

  it("Starter monthly to Starter yearly is never charged as an upgrade now", async () => {
    store.row = subRow({ planId: "p_starter" });
    replies["GET /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_starter" })];
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_starter" })];
    expect(await changePlan(owner, "p_starter_year")).toMatchObject({ change: "scheduled", planName: "Starter yearly" });
    expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ schedule_change_at: "cycle_end" });
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  it("within yearly plans, a higher price per month is an upgrade now", async () => {
    store.row = subRow({ planId: "p_starter_year" });
    replies["GET /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_starter_year" })];
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_growth_year" })];
    replies["GET /invoices"] = () => [200, { items: [] }];
    expect(await changePlan(owner, "p_growth_year")).toEqual({ ok: true, change: "upgraded", planName: "Growth yearly" });
    expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ schedule_change_at: "now" });
  });
});

describe("downgrade: at the renewal", () => {
  it("updates with schedule_change_at cycle_end, charges nothing, and the billing page says Changes to X on <date>", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub({ has_scheduled_changes: true, change_scheduled_at: unix(PERIOD_END) })];
    const result = await changePlan(owner, "p_starter");
    expect(result).toEqual({ ok: true, change: "scheduled", planName: "Starter", at: PERIOD_END.toISOString() });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ plan_id: "plan_starter", schedule_change_at: "cycle_end", customer_notify: true });
    expect(db.subscription.update).not.toHaveBeenCalled();
    expect(audits().find((a) => a.action === "billing.plan_change_scheduled")).toMatchObject({ target: "p_starter", meta: { from: "growth", to: "starter", when: "cycle_end" } });
    const overview = await billingOverview(owner);
    expect(overview.scheduledChange).toEqual({ kind: "downgrade", planName: "Starter", at: PERIOD_END.toISOString(), authorized: true });
  });

  it("choosing the current plan again keeps it: the scheduled change is cancelled at Razorpay", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    replies["POST /subscriptions/sub_1/cancel_scheduled_changes"] = () => [200, remoteSub()];
    await changePlan(owner, "p_starter");
    expect(await changePlan(owner, "p_growth")).toMatchObject({ ok: true, change: "kept", planName: "Growth" });
    expect(calls.some((c) => c.path === "/subscriptions/sub_1/cancel_scheduled_changes")).toBe(true);
    expect(await readPlanChange("t1")).toBeNull();
    expect(actions()).toContain("billing.plan_change_cancelled");
  });

  it("an upgrade replaces a planned downgrade (cancelled first), and the same downgrade twice changes nothing", async () => {
    replies["PATCH /subscriptions/sub_1"] = (c) => [200, remoteSub({ plan_id: c.body?.schedule_change_at === "now" ? "plan_agency" : "plan_growth" })];
    replies["POST /subscriptions/sub_1/cancel_scheduled_changes"] = () => [200, remoteSub()];
    replies["GET /invoices"] = () => [200, { items: [] }];
    await changePlan(owner, "p_starter");
    const patches = () => calls.filter((c) => c.method === "PATCH").length;
    await changePlan(owner, "p_starter");
    expect(patches()).toBe(1);
    await changePlan(owner, "p_agency");
    const order = calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf("POST /subscriptions/sub_1/cancel_scheduled_changes")).toBeLessThan(order.lastIndexOf("PATCH /subscriptions/sub_1"));
    expect(store.row).toMatchObject({ planId: "p_agency" });
  });

  it("cancelling the plan drops a planned downgrade", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    replies["POST /subscriptions/sub_1/cancel"] = () => [200, remoteSub({ status: "active" })];
    await changePlan(owner, "p_starter");
    await cancelAtPeriodEnd(owner);
    expect(await readPlanChange("t1")).toBeNull();
    expect(audits().find((a) => a.action === "billing.plan_change_cancelled")?.meta).toMatchObject({ reason: "plan_cancelled" });
  });
});

describe("payment methods Razorpay cannot update: explain, then cancel-at-period-end plus a new subscription", () => {
  it("UPI AutoPay is explained without calling the update", async () => {
    replies["GET /subscriptions/sub_1"] = () => [200, remoteSub({ payment_method: "upi" })];
    const error = await changePlan(owner, "p_agency").catch((e) => e);
    expect(error).toBeInstanceOf(PlanChangeNeedsNewSubscription);
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      "Your plan is paid with UPI AutoPay, and Razorpay cannot change a plan paid this way partway through. To move to Agency, end your current plan on 30 Nov 2026 (you keep everything until then), then choose Agency to start on that day.",
    );
    expect(error.details).toEqual({ code: "new_subscription_needed", planId: "p_agency", planName: "Agency", endsOn: PERIOD_END.toISOString(), method: "upi" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(audits().find((a) => a.action === "billing.plan_change_unavailable")).toMatchObject({ target: "p_agency", meta: { method: "upi" } });
  });

  it("a card Razorpay refuses (only the offer of a domestic card can change) gets the same answer", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [400, { error: { code: "BAD_REQUEST_ERROR", description: "Only the offer can be updated for this subscription" } }];
    const error = await changePlan(owner, "p_starter").catch((e) => e);
    expect(error).toBeInstanceOf(PlanChangeNeedsNewSubscription);
    expect(error.message).toContain("a card issued in India");
    expect(await readPlanChange("t1")).toBeNull();
  });

  it("the route answers 409 with the code, the plan and the date, for the page to offer the way", async () => {
    replies["GET /subscriptions/sub_1"] = () => [200, remoteSub({ payment_method: "emandate" })];
    const res = await changePlanRoute(req({ planId: "p_starter" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: newSubscriptionText({ method: "emandate", planName: "Starter", endsOn: PERIOD_END }),
      code: "new_subscription_needed", planId: "p_starter", planName: "Starter", endsOn: PERIOD_END.toISOString(), method: "emandate",
    });
  });

  it("after the plan is cancelled for the period's end, choosing a plan starts a new subscription on that day, charged then", async () => {
    store.row = subRow({ cancelAtPeriodEnd: true });
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    auth.getActor.mockResolvedValue({ ...owner, role: "admin" });
    const res = await subscribeRoute(new Request(`${ORIGIN}/api/billing/subscribe`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ planId: "p_agency" }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keyId: "rzp_test_k", subscriptionId: "sub_2", name: "Edwyz WA", description: "Agency, from 30 Nov 2026", startsOn: PERIOD_END.toISOString() });
    expect(calls.at(-1)!.body).toMatchObject({ plan_id: "plan_agency", start_at: unix(PERIOD_END), notes: { tenantId: "t1", planCode: "agency", startsAfter: "sub_1" } });
    // The workspace's own row is not touched until the new subscription starts.
    expect(db.subscription.upsert).not.toHaveBeenCalled();
    expect(store.row).toMatchObject({ razorpaySubscriptionId: "sub_1", planId: "p_growth" });
    expect(await readPlanChange("t1")).toMatchObject({ kind: "next_subscription", razorpaySubscriptionId: "sub_2", toPlanId: "p_agency", authorized: false });
    // Changing the plan while it is set to end points to that way instead.
    await expect(changePlan(owner, "p_starter")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Choose the plan you want under Plans") });
  });

  it("the payment window's confirmation for it records the approval only; access does not change", async () => {
    store.row = subRow({ cancelAtPeriodEnd: true });
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    replies["GET /subscriptions/sub_2"] = () => [200, { id: "sub_2", status: "authenticated", notes: { tenantId: "t1" } }];
    await subscribeRoute(new Request(`${ORIGIN}/api/billing/subscribe`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ planId: "p_agency" }) }));
    const sig = createHmac("sha256", "keysecret").update("pay_9|sub_2").digest("hex");
    const verify = (signature: string) =>
      verifyRoute(new Request(`${ORIGIN}/api/billing/verify`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ razorpay_payment_id: "pay_9", razorpay_subscription_id: "sub_2", razorpay_signature: signature }) }));
    expect((await verify("00")).status).toBe(400);
    const ok = await verify(sig);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, scheduled: true, startsOn: PERIOD_END.toISOString() });
    expect(db.subscription.update).not.toHaveBeenCalled();
    expect(await readPlanChange("t1")).toMatchObject({ authorized: true });
    // A second plan cannot be stacked on an approved one.
    await expect(subscribeRoute(new Request(`${ORIGIN}/api/billing/subscribe`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ planId: "p_starter" }) })).then((r) => r.status)).resolves.toBe(409);
  });

  it("a confirmation Razorpay has not approved yet changes nothing", async () => {
    store.row = subRow({ cancelAtPeriodEnd: true });
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    replies["GET /subscriptions/sub_2"] = () => [200, { id: "sub_2", status: "created", notes: { tenantId: "t1" } }];
    await subscribeRoute(new Request(`${ORIGIN}/api/billing/subscribe`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ planId: "p_agency" }) }));
    const sig = createHmac("sha256", "keysecret").update("pay_9|sub_2").digest("hex");
    const res = await verifyRoute(new Request(`${ORIGIN}/api/billing/verify`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ razorpay_payment_id: "pay_9", razorpay_subscription_id: "sub_2", razorpay_signature: sig }) }));
    expect(res.status).toBe(409);
    expect(await readPlanChange("t1")).toMatchObject({ authorized: false });
  });

  it("the new plan that has not started can be called off, and Razorpay cancels it before it charges", async () => {
    store.row = subRow({ cancelAtPeriodEnd: true });
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    replies["POST /subscriptions/sub_2/cancel"] = () => [200, { id: "sub_2", status: "cancelled" }];
    await subscribeRoute(new Request(`${ORIGIN}/api/billing/subscribe`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ planId: "p_agency" }) }));
    const res = await changePlanRoute(req({ cancelScheduled: true }));
    expect(await res.json()).toEqual({ ok: true, change: "kept", planName: "Growth", endsOn: PERIOD_END.toISOString() });
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/subscriptions/sub_2/cancel", body: { cancel_at_cycle_end: false } });
    expect(await readPlanChange("t1")).toBeNull();
  });
});

describe("refusals", () => {
  it("a plan assigned by hand answers 409 with the contact-support text", async () => {
    store.row = subRow({ razorpaySubscriptionId: null });
    await expect(changePlan(owner, "p_agency")).rejects.toMatchObject({ status: 409, message: MANUAL_PLAN_TEXT });
    expect(calls).toHaveLength(0);
  });

  it("no active plan, the trial plan, an unknown plan, a bad id and the plan you are on", async () => {
    store.row = subRow({ status: "expired" });
    await expect(changePlan(owner, "p_agency")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("no active plan") });
    store.row = null;
    await expect(changePlan(owner, "p_agency")).rejects.toMatchObject({ status: 409 });
    store.row = subRow();
    await expect(changePlan(owner, "p_trial")).rejects.toMatchObject({ status: 404 });
    await expect(changePlan(owner, "nope")).rejects.toMatchObject({ status: 404 });
    await expect(changePlan(owner, 42)).rejects.toMatchObject({ status: 400 });
    await expect(changePlan(owner, "x".repeat(65))).rejects.toMatchObject({ status: 400 });
    await expect(changePlan(owner, "p_growth")).rejects.toMatchObject({ status: 409, message: "You are already on Growth." });
    expect(calls).toHaveLength(0);
  });

  it("only the owner, from the app's own origin", async () => {
    auth.getActor.mockResolvedValue({ ...owner, role: "admin" });
    expect((await changePlanRoute(req({ planId: "p_agency" }))).status).toBe(403);
    auth.getActor.mockResolvedValue(owner);
    expect((await changePlanRoute(req({ planId: "p_agency" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("nothing planned to cancel, and an upgrade already applying cannot be cancelled", async () => {
    expect((await changePlanRoute(req({ cancelScheduled: true }))).status).toBe(409);
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    await changePlan(owner, "p_agency");
    const res = await changePlanRoute(req({ cancelScheduled: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already being applied/);
  });
});

describe("webhooks", () => {
  const send = (event: string, entity: Row, extra: Row = {}, createdAt = unix(NOW)) => {
    const body = JSON.stringify({ event, created_at: createdAt, payload: { subscription: { entity }, ...extra } });
    return handleRazorpayWebhook(body, new Headers({ "x-razorpay-signature": createHmac("sha256", "whsecret").update(body).digest("hex"), "x-razorpay-event-id": `evt_${Math.random()}` }));
  };

  it("subscription.updated moves the workspace to the plan Razorpay reports, audits it and invoices the prorated charge", async () => {
    const res = await send("subscription.updated", remoteSub({ plan_id: "plan_agency" }), { payment: { entity: { id: "pay_up", amount: 120_000, currency: "INR", status: "captured" } } });
    expect(res.status).toBe(200);
    expect(store.row).toMatchObject({ planId: "p_agency", status: "active" });
    expect(audits().find((a) => a.action === "billing.plan_changed")).toMatchObject({ target: "p_agency", meta: { from: "growth", to: "agency", source: "subscription.updated" } });
    expect(db.invoice.create.mock.calls[0][0]).toMatchObject({ data: { razorpayPaymentId: "pay_up", totalPaise: 120_000, planName: "Agency" } });
  });

  it("the renewal on the lower plan completes a planned downgrade and clears it", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    await changePlan(owner, "p_starter");
    await send("subscription.charged", remoteSub({ plan_id: "plan_starter" }), {}, unix(PERIOD_END));
    expect(store.row).toMatchObject({ planId: "p_starter" });
    expect(await readPlanChange("t1")).toBeNull();
  });

  it("an older event never moves the plan back", async () => {
    await send("subscription.updated", remoteSub({ plan_id: "plan_agency" }), {}, unix(NOW));
    await send("subscription.charged", remoteSub({ plan_id: "plan_growth" }), {}, unix(NOW) - 3600);
    expect(store.row).toMatchObject({ planId: "p_agency" });
  });

  it("a plan this platform does not know leaves the workspace on its plan", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await send("subscription.updated", remoteSub({ plan_id: "plan_mystery" }));
    expect(store.row).toMatchObject({ planId: "p_growth" });
    expect(actions()).not.toContain("billing.plan_changed");
  });

  it("the next subscription starting moves the workspace onto it: its id, its plan and its period, then invoices the charge", async () => {
    store.row = subRow({ cancelAtPeriodEnd: true });
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    await subscribeRoute(new Request(`${ORIGIN}/api/billing/subscribe`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ planId: "p_agency" }) }));
    // The old subscription ends first (status canceled), then the new one is charged.
    await send("subscription.cancelled", remoteSub({ status: "cancelled" }), {}, unix(PERIOD_END));
    expect(store.row).toMatchObject({ status: "canceled" });
    const next = { id: "sub_2", status: "active", plan_id: "plan_agency", current_start: unix(PERIOD_END), current_end: unix(new Date("2026-12-30T00:00:00Z")), notes: { tenantId: "t1" } };
    const res = await send("subscription.charged", next, { payment: { entity: { id: "pay_new", amount: 599_900, currency: "INR", status: "captured" } } }, unix(PERIOD_END) - 5);
    expect(res.status).toBe(200);
    expect(store.row).toMatchObject({ razorpaySubscriptionId: "sub_2", planId: "p_agency", status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: new Date("2026-12-30T00:00:00Z") });
    expect(await readPlanChange("t1")).toBeNull();
    expect(audits().find((a) => a.action === "billing.plan_changed")?.meta).toMatchObject({ source: "new_subscription", to: "agency" });
    expect(db.invoice.create.mock.calls[0][0]).toMatchObject({ data: { razorpayPaymentId: "pay_new", planName: "Agency" } });
    // The old subscription's late events are nobody's now.
    await send("subscription.completed", remoteSub({ status: "completed" }), {}, unix(PERIOD_END) + 10);
    expect(store.row).toMatchObject({ status: "active", razorpaySubscriptionId: "sub_2" });
  });

  it("an unknown subscription is still recorded as unknown, whatever tenant its notes name", async () => {
    const res = await send("subscription.charged", { id: "sub_x", status: "active", notes: { tenantId: "t1" } });
    expect(res.status).toBe(200);
    expect(db.paymentEvent.update.mock.calls[0][0]).toMatchObject({ data: { error: "unknown subscription" } });
    expect(db.subscription.update).not.toHaveBeenCalled();
  });
});

describe("the plan-change sweep", () => {
  it("runs every 15 minutes", () => {
    expect(worker.periodic.find((p) => p.name === "billing.plan-changes")?.everyMs).toBe(15 * 60_000);
  });

  it("applies a downgrade Razorpay made at the renewal when the webhook never came, and clears one Razorpay dropped", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    await changePlan(owner, "p_starter");
    expect(await reconcilePlanChanges(NOW)).toBe(0);
    replies["GET /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_starter" })];
    expect(await reconcilePlanChanges(new Date(PERIOD_END.getTime() + 2 * 3_600_000))).toBe(1);
    expect(store.row).toMatchObject({ planId: "p_starter" });
    expect(await readPlanChange("t1")).toBeNull();
    expect(audits().find((a) => a.action === "billing.plan_changed")?.meta).toMatchObject({ source: "reconcile" });

    store.row = subRow();
    await changePlan(owner, "p_starter");
    replies["GET /subscriptions/sub_1"] = () => [200, remoteSub({ has_scheduled_changes: false })];
    expect(await reconcilePlanChanges(new Date(PERIOD_END.getTime() + 2 * 3_600_000))).toBe(1);
    expect(store.row).toMatchObject({ planId: "p_growth" });
    expect(await readPlanChange("t1")).toBeNull();
    expect(actions()).toContain("billing.plan_change_failed");
  });

  it("an upgrade that never took (its charge failed) is cleared after ten minutes", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    await changePlan(owner, "p_agency");
    expect(await reconcilePlanChanges(new Date(NOW.getTime() + 5 * 60_000))).toBe(0);
    expect(await reconcilePlanChanges(new Date(NOW.getTime() + 11 * 60_000))).toBe(1);
    expect(await readPlanChange("t1")).toBeNull();
    expect(store.row).toMatchObject({ planId: "p_growth" });
  });

  it("takes over a next subscription that started without its webhook", async () => {
    store.row = subRow({ cancelAtPeriodEnd: true });
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    await subscribeRoute(new Request(`${ORIGIN}/api/billing/subscribe`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ planId: "p_starter" }) }));
    replies["GET /subscriptions/sub_2"] = () => [200, { id: "sub_2", status: "active", plan_id: "plan_starter", current_start: unix(PERIOD_END), current_end: unix(new Date("2026-12-30T00:00:00Z")), notes: { tenantId: "t1" } }];
    expect(await reconcilePlanChanges(new Date(PERIOD_END.getTime() + 2 * 3_600_000))).toBe(1);
    expect(store.row).toMatchObject({ razorpaySubscriptionId: "sub_2", planId: "p_starter", status: "active" });
  });
});

// ===== Repairs: the gap before a new plan's first payment, stacked subscriptions, the sweep, invoices, erasure =====

const DAY_MS = 86_400_000;
const subscribeReq = (planId: string) =>
  subscribeRoute(new Request(`${ORIGIN}/api/billing/subscribe`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ planId }) }));
const sendEvent = (event: string, entity: Row, extra: Row = {}, createdAt = unix(NOW)) => {
  const body = JSON.stringify({ event, created_at: createdAt, payload: { subscription: { entity }, ...extra } });
  return handleRazorpayWebhook(body, new Headers({ "x-razorpay-signature": createHmac("sha256", "whsecret").update(body).digest("hex"), "x-razorpay-event-id": `evt_${Math.random()}` }));
};
const nextActive = (over: Row = {}) => ({ id: "sub_2", status: "active", plan_id: "plan_agency", paid_count: 1, current_start: unix(PERIOD_END), current_end: unix(new Date("2026-12-30T00:00:00Z")), notes: { tenantId: "t1" }, ...over });
/** The paywall reads the workspace and its subscription row. */
const tenantFromRow = () =>
  db.tenant.findUnique.mockImplementation(async () => ({
    name: "Acme", status: "active", suspendedReason: null, billingExempt: false, trialEndsAt: null,
    subscription: store.row
      ? { status: store.row.status, currentPeriodEnd: store.row.currentPeriodEnd, pastDueSince: store.row.pastDueSince, planId: store.row.planId, razorpaySubscriptionId: store.row.razorpaySubscriptionId, plan: { name: db.planBy(store.row.planId)?.name ?? null } }
      : null,
  }));

/** Growth ended to move to Agency: the next subscription sub_2 starts on PERIOD_END and the customer approved it. */
async function approvedNext() {
  store.row = subRow({ cancelAtPeriodEnd: true });
  replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
  replies["GET /subscriptions/sub_2"] = () => [200, { id: "sub_2", status: "authenticated", notes: { tenantId: "t1" } }];
  expect((await subscribeReq("p_agency")).status).toBe(200);
  const sig = createHmac("sha256", "keysecret").update("pay_9|sub_2").digest("hex");
  const ok = await verifyRoute(new Request(`${ORIGIN}/api/billing/verify`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ razorpay_payment_id: "pay_9", razorpay_subscription_id: "sub_2", razorpay_signature: sig }) }));
  expect(ok.status).toBe(200);
  expect(await readPlanChange("t1")).toMatchObject({ kind: "next_subscription", authorized: true, replaces: "sub_1" });
}

describe("the gap: the old plan has ended and the approved new plan waits for its first payment", () => {
  it("keeps access (so the lock sweep pauses no ads) for the grace, then locks if it never gets paid", async () => {
    await approvedNext();
    await sendEvent("subscription.cancelled", remoteSub({ status: "cancelled" }), {}, unix(PERIOD_END));
    expect(store.row).toMatchObject({ status: "canceled", razorpaySubscriptionId: "sub_1" });
    tenantFromRow();
    vi.setSystemTime(new Date(PERIOD_END.getTime() + DAY_MS));
    expect(await getBillingStatus("t1")).toMatchObject({ state: "active", canWrite: true, reason: NEXT_STARTING_REASON, planName: "Growth" });
    vi.setSystemTime(new Date(PERIOD_END.getTime() + 4.9 * DAY_MS));
    expect((await getBillingStatus("t1")).canWrite).toBe(true);
    vi.setSystemTime(new Date(PERIOD_END.getTime() + 5 * DAY_MS));
    expect(await getBillingStatus("t1")).toMatchObject({ state: "locked", canWrite: false });
  });

  it("a new plan never approved gives no grace", async () => {
    store.row = subRow({ cancelAtPeriodEnd: true });
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    await subscribeReq("p_agency");
    store.row = subRow({ status: "canceled", cancelAtPeriodEnd: true });
    tenantFromRow();
    vi.setSystemTime(new Date(PERIOD_END.getTime() + DAY_MS));
    expect(await getBillingStatus("t1")).toMatchObject({ state: "locked", canWrite: false });
  });

  it("refuses a second subscription while the approved one waits, and the overview shows the plan starting", async () => {
    await approvedNext();
    await sendEvent("subscription.cancelled", remoteSub({ status: "cancelled" }), {}, unix(PERIOD_END));
    vi.setSystemTime(new Date(PERIOD_END.getTime() + DAY_MS));
    replies["POST /subscriptions"] = () => [200, { id: "sub_3", status: "created" }];
    const before = calls.length;
    const res = await subscribeReq("p_starter");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Agency is starting. It switches on as soon as its first payment goes through. To choose another plan, cancel that change first.");
    expect(calls.slice(before).some((c) => c.method === "POST" && c.path === "/subscriptions")).toBe(false);
    expect(db.subscription.upsert).not.toHaveBeenCalled();
    tenantFromRow();
    const overview = await billingOverview(owner);
    expect(overview.status).toMatchObject({ state: "active", canWrite: true });
    expect(overview.scheduledChange).toMatchObject({ kind: "next_subscription", planName: "Agency", authorized: true });
  });

  it("approved at Razorpay though the payment window's confirmation never reached us: still refused", async () => {
    store.row = subRow({ cancelAtPeriodEnd: true });
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    await subscribeReq("p_agency");
    store.row = subRow({ status: "canceled", cancelAtPeriodEnd: true });
    vi.setSystemTime(new Date(PERIOD_END.getTime() + DAY_MS));
    replies["GET /subscriptions/sub_2"] = () => [200, { id: "sub_2", status: "authenticated", notes: { tenantId: "t1" } }];
    expect((await subscribeReq("p_starter")).status).toBe(409);
    expect(calls.some((c) => c.path === "/subscriptions/sub_2/cancel")).toBe(false);
  });

  it("one never approved is cancelled at Razorpay first, then the fresh checkout is the only subscription", async () => {
    store.row = subRow({ cancelAtPeriodEnd: true });
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    await subscribeReq("p_agency");
    store.row = subRow({ status: "canceled", cancelAtPeriodEnd: true });
    vi.setSystemTime(new Date(PERIOD_END.getTime() + DAY_MS));
    replies["GET /subscriptions/sub_2"] = () => [200, { id: "sub_2", status: "created", notes: { tenantId: "t1" } }];
    replies["POST /subscriptions/sub_2/cancel"] = () => [200, { id: "sub_2", status: "cancelled" }];
    replies["POST /subscriptions"] = () => [200, { id: "sub_3", status: "created" }];
    const res = await subscribeReq("p_starter");
    expect(res.status).toBe(200);
    expect((await res.json()).subscriptionId).toBe("sub_3");
    const order = calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf("POST /subscriptions/sub_2/cancel")).toBeLessThan(order.lastIndexOf("POST /subscriptions"));
    expect(calls.find((c) => c.path === "/subscriptions/sub_2/cancel")!.body).toEqual({ cancel_at_cycle_end: false });
    expect(await readPlanChange("t1")).toBeNull();
    expect(audits().find((a) => a.action === "billing.plan_change_cancelled")?.meta).toMatchObject({ kind: "next_subscription", reason: "replaced" });
  });
});

describe("the take-over never leaves two subscriptions charging", () => {
  it("the row holds another live subscription: the new plan is cancelled at Razorpay and the change dropped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await approvedNext();
    // A subscription started during the gap (before it was refused): the row holds sub_3, paid and active.
    store.row = subRow({ razorpaySubscriptionId: "sub_3", planId: "p_starter", cancelAtPeriodEnd: false, currentPeriodEnd: new Date("2026-12-31T00:00:00Z") });
    replies["GET /subscriptions/sub_3"] = () => [200, { id: "sub_3", status: "active", notes: { tenantId: "t1" } }];
    replies["POST /subscriptions/sub_2/cancel"] = () => [200, { id: "sub_2", status: "cancelled" }];
    const res = await sendEvent("subscription.charged", nextActive(), { payment: { entity: { id: "pay_new", amount: 599_900, currency: "INR", status: "captured" } } }, unix(PERIOD_END));
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.path === "/subscriptions/sub_2/cancel")).toMatchObject({ method: "POST", body: { cancel_at_cycle_end: false } });
    expect(calls.some((c) => c.path === "/subscriptions/sub_3/cancel")).toBe(false);
    expect(store.row).toMatchObject({ razorpaySubscriptionId: "sub_3", planId: "p_starter" });
    expect(await readPlanChange("t1")).toBeNull();
    expect(audits().find((a) => a.action === "billing.plan_change_failed")?.meta).toMatchObject({ reason: "another_subscription_live", cancelled: "sub_2", kept: "sub_3", paidCount: 1 });
    expect(db.paymentEvent.update.mock.calls.at(-1)![0]).toMatchObject({ data: { error: expect.stringContaining("already has a live subscription") } });
  });

  it("when Razorpay cannot cancel the new plan, the webhook fails so Razorpay retries it", async () => {
    await approvedNext();
    store.row = subRow({ razorpaySubscriptionId: "sub_3", planId: "p_starter", cancelAtPeriodEnd: false });
    replies["GET /subscriptions/sub_3"] = () => [200, { id: "sub_3", status: "active", notes: { tenantId: "t1" } }];
    replies["POST /subscriptions/sub_2/cancel"] = () => [500, { error: { description: "try later" } }];
    expect((await sendEvent("subscription.charged", nextActive(), {}, unix(PERIOD_END))).status).toBe(500);
    expect(await readPlanChange("t1")).toMatchObject({ kind: "next_subscription" });
  });

  it("an unpaid checkout the row holds is cancelled and audited, and the new plan takes over", async () => {
    await approvedNext();
    store.row = subRow({ razorpaySubscriptionId: "sub_3", planId: "p_starter", status: "expired", cancelAtPeriodEnd: false, currentPeriodEnd: null });
    replies["GET /subscriptions/sub_3"] = () => [200, { id: "sub_3", status: "created", notes: { tenantId: "t1" } }];
    replies["POST /subscriptions/sub_3/cancel"] = () => [200, { id: "sub_3", status: "cancelled" }];
    await sendEvent("subscription.charged", nextActive(), {}, unix(PERIOD_END));
    expect(calls.find((c) => c.path === "/subscriptions/sub_3/cancel")).toMatchObject({ body: { cancel_at_cycle_end: false } });
    expect(calls.some((c) => c.path === "/subscriptions/sub_2/cancel")).toBe(false);
    expect(store.row).toMatchObject({ razorpaySubscriptionId: "sub_2", planId: "p_agency", status: "active" });
    expect(audits().find((a) => a.action === "billing.subscription_replaced")?.meta).toMatchObject({ cancelled: "sub_3", by: "sub_2" });
  });
});

describe("the sweep, repaired", () => {
  const due = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
  const later = new Date("2027-11-30T00:00:00Z").toISOString();
  const nextState = (i: number, at: string) => ({ kind: "next_subscription", authorized: true, toPlanId: "p_agency", toPlanName: "Agency", fromPlanId: "p_growth", razorpaySubscriptionId: `sub_n${i}`, at, requestedAt: at, requestedBy: null });
  const pad = (i: number) => String(i).padStart(2, "0");

  it("rows not due yet (an annual plan's downgrade months away) never hold up a due one", async () => {
    for (let i = 0; i < 60; i++) {
      store.settings.set(`${planChangeKey("a")}${pad(i)}`, { ...nextState(i, later), kind: "downgrade" });
      store.updated.set(`${planChangeKey("a")}${pad(i)}`, new Date(0));
    }
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    await changePlan(owner, "p_starter");
    replies["GET /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_starter" })];
    const before = calls.length;
    expect(await reconcilePlanChanges(new Date(PERIOD_END.getTime() + 2 * 3_600_000))).toBe(1);
    expect(store.row).toMatchObject({ planId: "p_starter" });
    // The rows that are not due cost no call.
    expect(calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual(["GET /subscriptions/sub_1"]);
  });

  it("checks at most 50 a run, and a row it checked goes to the back, so every due row gets its turn", async () => {
    for (let i = 0; i < 55; i++) {
      const id = `tn${pad(i)}`;
      store.settings.set(planChangeKey(id), nextState(i, due));
      store.updated.set(planChangeKey(id), new Date(1000 + i));
      replies[`GET /subscriptions/sub_n${i}`] = () => [200, { id: `sub_n${i}`, status: "authenticated", notes: { tenantId: id } }];
    }
    const gets = () => calls.filter((c) => c.method === "GET" && c.path.startsWith("/subscriptions/sub_n")).map((c) => c.path);
    expect(await reconcilePlanChanges(NOW)).toBe(0);
    expect(gets()).toHaveLength(50);
    calls.length = 0;
    await reconcilePlanChanges(new Date(NOW.getTime() + 15 * 60_000));
    expect(gets().slice(0, 5)).toEqual([50, 51, 52, 53, 54].map((i) => `/subscriptions/sub_n${i}`));
  });

  it("a new plan never approved, past its start, is cancelled at Razorpay, dropped and audited", async () => {
    store.row = subRow({ cancelAtPeriodEnd: true });
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    await subscribeReq("p_agency");
    replies["GET /subscriptions/sub_2"] = () => [200, { id: "sub_2", status: "created", notes: { tenantId: "t1" } }];
    replies["POST /subscriptions/sub_2/cancel"] = () => [200, { id: "sub_2", status: "cancelled" }];
    expect(await reconcilePlanChanges(new Date(PERIOD_END.getTime() - 3_600_000))).toBe(0);
    expect(calls.some((c) => c.path === "/subscriptions/sub_2/cancel")).toBe(false);
    expect(await reconcilePlanChanges(new Date(PERIOD_END.getTime() + 2 * 3_600_000))).toBe(1);
    expect(calls.find((c) => c.path === "/subscriptions/sub_2/cancel")).toMatchObject({ body: { cancel_at_cycle_end: false } });
    expect(await readPlanChange("t1")).toBeNull();
    expect(audits().find((a) => a.action === "billing.plan_change_failed")?.meta).toMatchObject({ kind: "next_subscription", status: "created", reason: "not_approved" });
  });

  it("when Razorpay cannot cancel it, the change is kept for the next run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store.row = subRow({ cancelAtPeriodEnd: true });
    replies["POST /subscriptions"] = () => [200, { id: "sub_2", status: "created" }];
    await subscribeReq("p_agency");
    replies["GET /subscriptions/sub_2"] = () => [200, { id: "sub_2", status: "created", notes: { tenantId: "t1" } }];
    replies["POST /subscriptions/sub_2/cancel"] = () => [500, {}];
    expect(await reconcilePlanChanges(new Date(PERIOD_END.getTime() + 2 * 3_600_000))).toBe(0);
    expect(await readPlanChange("t1")).toMatchObject({ kind: "next_subscription" });
  });

  it("a downgrade whose subscription Razorpay moved to some other plan: the row follows Razorpay and the change is dropped", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    await changePlan(owner, "p_starter");
    replies["GET /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_agency" })];
    expect(await reconcilePlanChanges(new Date(PERIOD_END.getTime() + 2 * 3_600_000))).toBe(1);
    expect(store.row).toMatchObject({ planId: "p_agency" });
    expect(await readPlanChange("t1")).toBeNull();
    expect(audits().find((a) => a.action === "billing.plan_changed")?.meta).toMatchObject({ to: "agency", source: "reconcile" });
    expect(audits().find((a) => a.action === "billing.plan_change_failed")).toMatchObject({ target: "p_starter", meta: { kind: "downgrade", reason: "plan_moved", to: "agency" } });
  });
});

describe("the upgrade's GST invoice when the switch is applied later", () => {
  it("by the webhook without the charge in its payload: the charge is found at Razorpay since the change was asked for", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    expect(await changePlan(owner, "p_agency")).toMatchObject({ change: "processing" });
    replies["GET /invoices"] = () => [200, { items: [
      { id: "inv_old", status: "paid", payment_id: "pay_old", amount: 249_900, currency: "INR", paid_at: unix(new Date("2026-10-31T00:00:00Z")) },
      { id: "inv_up", status: "paid", payment_id: "pay_up2", amount: 150_000, currency: "INR", paid_at: unix(NOW) + 60 },
    ] }];
    await sendEvent("subscription.updated", remoteSub({ plan_id: "plan_agency" }), {}, unix(NOW) + 120);
    expect(store.row).toMatchObject({ planId: "p_agency" });
    expect(db.invoice.create).toHaveBeenCalledTimes(1);
    expect(db.invoice.create.mock.calls[0][0]).toMatchObject({ data: { razorpayPaymentId: "pay_up2", totalPaise: 150_000, planName: "Agency" } });
    expect(store.settings.has(`${UPGRADE_INVOICE_PREFIX}t1`)).toBe(false);
  });

  it("by the sweep: invoiced as soon as Razorpay has captured the charge", async () => {
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    await changePlan(owner, "p_agency");
    replies["GET /subscriptions/sub_1"] = () => [200, remoteSub({ plan_id: "plan_agency" })];
    let items: unknown[] = [];
    replies["GET /invoices"] = () => [200, { items }];
    expect(await reconcilePlanChanges(new Date(NOW.getTime() + 11 * 60_000))).toBe(1);
    expect(store.row).toMatchObject({ planId: "p_agency" });
    expect(db.invoice.create).not.toHaveBeenCalled();
    expect(store.settings.get(`${UPGRADE_INVOICE_PREFIX}t1`)).toMatchObject({ subscriptionId: "sub_1", planName: "Agency", since: NOW.toISOString() });
    items = [{ id: "inv_up", status: "paid", payment_id: "pay_up3", amount: 150_000, currency: "INR", paid_at: unix(NOW) + 900 }];
    await reconcilePlanChanges(new Date(NOW.getTime() + 26 * 60_000));
    expect(db.invoice.create.mock.calls[0][0]).toMatchObject({ data: { razorpayPaymentId: "pay_up3", planName: "Agency" } });
    expect(store.settings.has(`${UPGRADE_INVOICE_PREFIX}t1`)).toBe(false);
  });
});

describe("erasing the workspace cancels a new plan waiting to start", () => {
  it("cancels it at Razorpay at once", async () => {
    await approvedNext();
    replies["POST /subscriptions/sub_2/cancel"] = () => [200, { id: "sub_2", status: "cancelled" }];
    expect(await cancelNextSubscriptionForErasure("t1")).toBe(true);
    expect(calls.find((c) => c.path === "/subscriptions/sub_2/cancel")).toMatchObject({ method: "POST", body: { cancel_at_cycle_end: false } });
  });

  it("stops the erasure (409) when Razorpay cannot cancel it, unless the operator confirmed it was cancelled", async () => {
    await approvedNext();
    replies["POST /subscriptions/sub_2/cancel"] = () => [500, {}];
    await expect(cancelNextSubscriptionForErasure("t1")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("new plan waiting to start") });
    await expect(cancelNextSubscriptionForErasure("t1", { allowActiveSubscription: true })).resolves.toBe(true);
    // Already ended at Razorpay: nothing can charge, so erasure goes on.
    replies["POST /subscriptions/sub_2/cancel"] = () => [400, { error: { description: "Subscription is not cancellable in cancelled status" } }];
    replies["GET /subscriptions/sub_2"] = () => [200, { id: "sub_2", status: "cancelled" }];
    await expect(cancelNextSubscriptionForErasure("t1")).resolves.toBe(true);
  });

  it("nothing to do without one", async () => {
    expect(await cancelNextSubscriptionForErasure("t1")).toBe(false);
    replies["PATCH /subscriptions/sub_1"] = () => [200, remoteSub()];
    await changePlan(owner, "p_starter");
    expect(await cancelNextSubscriptionForErasure("t1")).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);
  });
});

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn(), updateMany: vi.fn() },
  plan: { findUnique: vi.fn(), update: vi.fn() },
  membership: { count: vi.fn() },
  invite: { count: vi.fn() },
  contact: { count: vi.fn() },
  broadcastRecipient: { count: vi.fn() },
  invoice: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  billingProfile: { findUnique: vi.fn() },
  subscription: { findMany: vi.fn(), update: vi.fn() },
  platformSetting: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

import { assertTenantCanWrite, assertWithinLimit, startTrial } from "@/lib/billing";
import {
  buyerStateCode, financialYear, formatInvoiceNumber, isProforma, isValidGstin, issueInvoice, nextSequence, splitInclusive, taxLines, documentTitle,
} from "@/lib/billing/invoice";
import { syncPlanToRazorpay, totalCountFor, verifyCheckoutSignature, verifyWebhookSignature } from "@/lib/billing/razorpay";
import { validateProfile } from "@/lib/billing/service";
import { computeBillingStatus, type StatusInput } from "@/lib/billing/status";
import { patchFromEntity } from "@/lib/billing/sync";
import { reconcileSubscriptions } from "@/lib/billing/worker";
import { HttpError } from "@/lib/tenancy";

const DAY = 86_400_000;
const now = new Date("2026-11-10T00:00:00Z");
const tenant = { status: "active" as const, suspendedReason: null, billingExempt: false, trialEndsAt: null as Date | null };
const input = (over: Partial<StatusInput> = {}): StatusInput => ({ tenant, subscription: null, graceDays: 3, now, ...over });
const sub = (over: Partial<NonNullable<StatusInput["subscription"]>> = {}): NonNullable<StatusInput["subscription"]> => ({
  status: "active", currentPeriodEnd: new Date(now.getTime() + 10 * DAY), pastDueSince: null, planId: "p1", planName: "Pro", ...over,
});

describe("computeBillingStatus", () => {
  it("exempt tenants always write", () => {
    const s = computeBillingStatus(input({ tenant: { ...tenant, billingExempt: true } }));
    expect(s).toMatchObject({ state: "exempt", canWrite: true });
  });
  it("suspended beats exempt and cannot write", () => {
    const s = computeBillingStatus(input({ tenant: { ...tenant, status: "suspended", suspendedReason: "abuse", billingExempt: true } }));
    expect(s).toMatchObject({ state: "suspended", canWrite: false, reason: "abuse" });
  });
  it("active subscription", () => {
    expect(computeBillingStatus(input({ subscription: sub() }))).toMatchObject({ state: "active", canWrite: true, planName: "Pro" });
  });
  it("past due: grace boundary is exclusive at the end", () => {
    const since = new Date(now.getTime() - 3 * DAY + 1);
    expect(computeBillingStatus(input({ subscription: sub({ status: "past_due", pastDueSince: since }) })).state).toBe("past_due_grace");
    const exact = new Date(now.getTime() - 3 * DAY);
    const locked = computeBillingStatus(input({ subscription: sub({ status: "past_due", pastDueSince: exact }) }));
    expect(locked).toMatchObject({ state: "locked", canWrite: false });
  });
  it("past due without pastDueSince starts grace now", () => {
    expect(computeBillingStatus(input({ subscription: sub({ status: "past_due" }) })).state).toBe("past_due_grace");
  });
  it("canceled keeps access until the period ends, then locks", () => {
    expect(computeBillingStatus(input({ subscription: sub({ status: "canceled", currentPeriodEnd: new Date(now.getTime() + 1) }) })).state).toBe("active");
    expect(computeBillingStatus(input({ subscription: sub({ status: "canceled", currentPeriodEnd: now }) })).state).toBe("locked");
    expect(computeBillingStatus(input({ subscription: sub({ status: "expired", currentPeriodEnd: new Date(now.getTime() - DAY) }) })).state).toBe("locked");
  });
  it("trial: days left rounds up, boundary locks", () => {
    const t = (ms: number) => computeBillingStatus(input({ tenant: { ...tenant, trialEndsAt: new Date(now.getTime() + ms) } }));
    expect(t(1)).toMatchObject({ state: "trialing", daysLeftInTrial: 1, canWrite: true });
    expect(t(2 * DAY + 1).daysLeftInTrial).toBe(3);
    expect(t(0).state).toBe("locked");
    expect(t(-DAY).state).toBe("locked");
  });
  it("no subscription and no trial is locked", () => {
    expect(computeBillingStatus(input())).toMatchObject({ state: "locked", canWrite: false });
  });
  it("a pending-checkout row (expired, no period) falls back to the trial", () => {
    const s = computeBillingStatus(input({ tenant: { ...tenant, trialEndsAt: new Date(now.getTime() + 2 * DAY) }, subscription: sub({ status: "expired", currentPeriodEnd: null }) }));
    expect(s.state).toBe("trialing");
  });
});

function mockTenant(over: Record<string, unknown> = {}) {
  db.tenant.findUnique.mockResolvedValue({
    status: "active", suspendedReason: null, billingExempt: false, trialEndsAt: null, subscription: null, ...over,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  db.platformSetting.findUnique.mockResolvedValue(null);
});

describe("assertTenantCanWrite", () => {
  it("402 with a billing link when locked", async () => {
    mockTenant();
    const e = await assertTenantCanWrite("t1").catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(402);
    expect(e.message).toContain("/app/billing");
  });
  it("403 when suspended", async () => {
    mockTenant({ status: "suspended", suspendedReason: "Policy violation" });
    const e = await assertTenantCanWrite("t1").catch((x) => x);
    expect(e.status).toBe(403);
    expect(e.message).toContain("Policy violation");
  });
  it("passes when trialing", async () => {
    mockTenant({ trialEndsAt: new Date(Date.now() + DAY) });
    await expect(assertTenantCanWrite("t1")).resolves.toBeUndefined();
  });
});

describe("startTrial", () => {
  it("sets trialEndsAt from settings only when unset", async () => {
    db.platformSetting.findUnique.mockResolvedValue({ value: { trialDays: 14 } });
    const before = Date.now();
    await startTrial("t1");
    const call = db.tenant.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "t1", trialEndsAt: null });
    expect(call.data.trialEndsAt.getTime() - before).toBeGreaterThanOrEqual(14 * DAY);
  });
});

describe("assertWithinLimit", () => {
  const planWith = (l: Partial<Record<"seatLimit" | "contactLimit" | "monthlyBroadcastLimit", number | null>>) => ({
    seatLimit: null, contactLimit: null, monthlyBroadcastLimit: null, ...l,
  });
  const subscribed = () => mockTenant({ subscription: { status: "active", currentPeriodEnd: new Date(Date.now() + DAY), pastDueSince: null, planId: "p1", plan: { name: "Pro" } } });

  it("counts members plus pending invites for seats", async () => {
    subscribed();
    db.plan.findUnique.mockResolvedValue(planWith({ seatLimit: 3 }));
    db.membership.count.mockResolvedValue(2);
    db.invite.count.mockResolvedValue(1);
    await expect(assertWithinLimit("t1", "seats", 1)).rejects.toMatchObject({ status: 402 });
    db.invite.count.mockResolvedValue(0);
    await expect(assertWithinLimit("t1", "seats", 1)).resolves.toBeUndefined();
    expect(db.invite.count.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", acceptedAt: null });
  });
  it("enforces contact limit scoped to the tenant", async () => {
    subscribed();
    db.plan.findUnique.mockResolvedValue(planWith({ contactLimit: 100 }));
    db.contact.count.mockResolvedValue(95);
    await expect(assertWithinLimit("t1", "contacts", 5)).resolves.toBeUndefined();
    await expect(assertWithinLimit("t1", "contacts", 6)).rejects.toMatchObject({ status: 402 });
    expect(db.contact.count).toHaveBeenCalledWith({ where: { tenantId: "t1" } });
  });
  it("counts broadcast recipients created this month", async () => {
    subscribed();
    db.plan.findUnique.mockResolvedValue(planWith({ monthlyBroadcastLimit: 10 }));
    db.broadcastRecipient.count.mockResolvedValue(8);
    await expect(assertWithinLimit("t1", "broadcastContacts", 3)).rejects.toMatchObject({ status: 402 });
    const where = db.broadcastRecipient.count.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.broadcast.createdAt.gte.getUTCDate()).toBe(1);
  });
  it("no limit when the plan leaves it unset", async () => {
    subscribed();
    db.plan.findUnique.mockResolvedValue(planWith({}));
    await expect(assertWithinLimit("t1", "contacts", 1_000_000)).resolves.toBeUndefined();
    expect(db.contact.count).not.toHaveBeenCalled();
  });
  it("trialing without a trial plan has no limits; with one it applies", async () => {
    mockTenant({ trialEndsAt: new Date(Date.now() + DAY) });
    db.plan.findUnique.mockResolvedValue(null);
    await expect(assertWithinLimit("t1", "contacts", 5)).resolves.toBeUndefined();
    db.plan.findUnique.mockResolvedValue(planWith({ contactLimit: 10 }));
    db.contact.count.mockResolvedValue(10);
    await expect(assertWithinLimit("t1", "contacts", 1)).rejects.toMatchObject({ status: 402 });
    expect(db.plan.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({ where: { code: "trial" } }));
  });
  it("exempt tenants have no limits", async () => {
    mockTenant({ billingExempt: true });
    await assertWithinLimit("t1", "seats", 99);
    expect(db.plan.findUnique).not.toHaveBeenCalled();
  });
});

describe("signatures", () => {
  it("verifies the checkout signature over payment|stored subscription", () => {
    const secret = "sek";
    const sig = createHmac("sha256", secret).update("pay_1|sub_1").digest("hex");
    expect(verifyCheckoutSignature("pay_1", "sub_1", sig, secret)).toBe(true);
    expect(verifyCheckoutSignature("pay_1", "sub_2", sig, secret)).toBe(false);
    expect(verifyCheckoutSignature("pay_1", "sub_1", "bad", secret)).toBe(false);
    expect(verifyCheckoutSignature("pay_1", "sub_1", sig, "")).toBe(false);
  });
  it("verifies the webhook signature over the raw body", () => {
    const body = '{"event":"x"}';
    const sig = createHmac("sha256", "whs").update(body).digest("hex");
    expect(verifyWebhookSignature(body, sig, "whs")).toBe(true);
    expect(verifyWebhookSignature(body + " ", sig, "whs")).toBe(false);
    expect(verifyWebhookSignature(body, null, "whs")).toBe(false);
    expect(verifyWebhookSignature(body, sig, "")).toBe(false);
  });
});

describe("invoice maths and labels", () => {
  it("splits inclusive totals and keeps the sum exact", () => {
    expect(splitInclusive(11800, 1800)).toEqual({ amountPaise: 10000, gstPaise: 1800, totalPaise: 11800 });
    const r = splitInclusive(9999, 1800);
    expect(r.amountPaise + r.gstPaise).toBe(9999);
    expect(r.amountPaise).toBe(8474);
  });
  it("splits CGST and SGST for same state, IGST otherwise, odd paise to SGST", () => {
    expect(taxLines(1801, "02", "02")).toEqual({ kind: "cgst_sgst", cgstPaise: 900, sgstPaise: 901 });
    expect(taxLines(1800, "2", "02").kind).toBe("cgst_sgst");
    expect(taxLines(1800, "02", "27")).toEqual({ kind: "igst", igstPaise: 1800 });
    expect(taxLines(1800, "02", null).kind).toBe("igst");
    expect(taxLines(1800, "", "02").kind).toBe("igst");
    expect(taxLines(0, "02", "02").kind).toBe("none");
  });
  it("derives the buyer state from GSTIN, else from the address", () => {
    expect(buyerStateCode("27AAPFU0939F1ZV", "anything")).toBe("27");
    expect(buyerStateCode(null, "12 Mall Road, Shimla, Himachal Pradesh, 171001")).toBe("02");
    expect(buyerStateCode(null, "Nowhere")).toBeNull();
  });
  it("labels proforma unless seller GSTIN and state code are both set", () => {
    expect(isProforma({ sellerGstin: "", sellerStateCode: "02" })).toBe(true);
    expect(isProforma({ sellerGstin: "02AAAAA0000A1Z5", sellerStateCode: "" })).toBe(true);
    expect(documentTitle({ sellerGstin: "", sellerStateCode: "" })).toBe("Proforma, not a tax invoice");
    expect(documentTitle({ sellerGstin: "02AAAAA0000A1Z5", sellerStateCode: "02" })).toBe("Tax invoice");
  });
  it("financial year runs April to March in IST", () => {
    expect(financialYear(new Date("2026-04-01T00:00:00+05:30"))).toBe("2026-27");
    expect(financialYear(new Date("2026-03-31T23:59:00+05:30"))).toBe("2025-26");
    expect(financialYear(new Date("2026-03-31T19:00:00Z"))).toBe("2026-27");
    expect(financialYear(new Date("2027-01-15T00:00:00Z"))).toBe("2026-27");
  });
  it("numbers sequentially", () => {
    expect(formatInvoiceNumber("EDW", "2026-27", 7)).toBe("EDW/2026-27/00007");
    expect(nextSequence(null)).toBe(1);
    expect(nextSequence("EDW/2026-27/00041")).toBe(42);
    expect(nextSequence("garbage")).toBe(1);
  });
});

describe("issueInvoice", () => {
  const args = { tenantId: "t1", razorpayPaymentId: "pay_1", totalPaise: 11800, currency: "INR", planName: "Pro", periodStart: null, periodEnd: null, paidAt: new Date("2026-11-10T00:00:00Z") };
  it("returns the existing invoice for a payment already invoiced", async () => {
    db.invoice.findUnique.mockResolvedValue({ id: "i0" });
    expect(await issueInvoice(args)).toEqual({ id: "i0" });
    expect(db.invoice.create).not.toHaveBeenCalled();
  });
  it("allocates the next number, snapshots the buyer and retries on a number clash", async () => {
    db.invoice.findUnique.mockResolvedValue(null);
    db.billingProfile.findUnique.mockResolvedValue({ legalName: "Acme", gstin: "27AAPFU0939F1ZV", addressLine: "1 Road", state: "Maharashtra", pincode: "400001" });
    db.invoice.findFirst.mockResolvedValueOnce({ number: "EDW/2026-27/00004" }).mockResolvedValueOnce({ number: "EDW/2026-27/00005" });
    db.invoice.create.mockRejectedValueOnce({ code: "P2002" }).mockImplementationOnce(async ({ data }) => data);
    const out = (await issueInvoice(args)) as unknown as Record<string, unknown>;
    expect(out.number).toBe("EDW/2026-27/00006");
    expect(out).toMatchObject({ amountPaise: 10000, gstPaise: 1800, totalPaise: 11800, customerName: "Acme", customerAddress: "1 Road, Maharashtra, 400001", status: "paid" });
  });
});

describe("GSTIN and profile validation", () => {
  const good = { legalName: "Acme", addressLine: "1 Road", state: "Delhi", billingEmail: "A@B.com" };
  it("validates the 15 character GSTIN pattern", () => {
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstin("27AAPFU0939F1Z")).toBe(false);
    expect(isValidGstin("27aapfu0939f1zv")).toBe(false);
    expect(isValidGstin("99AAPFU0939F1ZV")).toBe(false);
    expect(isValidGstin("27AAPFU0939F1XV")).toBe(false);
  });
  it("normalizes and rejects", () => {
    expect(validateProfile({ ...good, gstin: "27aapfu0939f1zv" })).toMatchObject({ gstin: "27AAPFU0939F1ZV", billingEmail: "a@b.com", pincode: null });
    expect(() => validateProfile({ ...good, gstin: "BAD" })).toThrow(/GSTIN/);
    expect(() => validateProfile({ ...good, pincode: "12" })).toThrow(/Pincode/);
    expect(() => validateProfile({ ...good, billingEmail: "nope" })).toThrow(/email/);
    expect(() => validateProfile({ ...good, legalName: "" })).toThrow(/required/);
  });
});

describe("syncPlanToRazorpay", () => {
  const plan = { id: "p1", code: "pro", name: "Pro", pricePaise: 49900, currency: "INR", intervalMonths: 1, razorpayPlanId: null as string | null };
  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_x";
    process.env.RAZORPAY_KEY_SECRET = "secret";
  });
  it("creates the plan in paise and stores the id", async () => {
    db.plan.findUnique.mockResolvedValue(plan);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "plan_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await syncPlanToRazorpay("p1")).toEqual({ razorpayPlanId: "plan_1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.razorpay.com/v1/plans");
    expect(JSON.parse(init.body)).toMatchObject({ period: "monthly", interval: 1, item: { amount: 49900, currency: "INR" } });
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("rzp_test_x:secret").toString("base64")}`);
    expect(db.plan.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { razorpayPlanId: "plan_1" } });
  });
  it("refuses to change the price of an existing Razorpay plan", async () => {
    db.plan.findUnique.mockResolvedValue({ ...plan, razorpayPlanId: "plan_1", pricePaise: 59900 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "plan_1", period: "monthly", interval: 1, item: { amount: 49900, currency: "INR" } }), { status: 200 })));
    await expect(syncPlanToRazorpay("p1")).rejects.toMatchObject({ status: 409 });
    expect(db.plan.update).not.toHaveBeenCalled();
  });
  it("returns the id when the plan is unchanged", async () => {
    db.plan.findUnique.mockResolvedValue({ ...plan, razorpayPlanId: "plan_1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "plan_1", period: "monthly", interval: 1, item: { amount: 49900, currency: "INR" } }), { status: 200 })));
    expect(await syncPlanToRazorpay("p1")).toEqual({ razorpayPlanId: "plan_1" });
  });
  it("503 when keys are missing", async () => {
    delete process.env.RAZORPAY_KEY_ID;
    db.plan.findUnique.mockResolvedValue(plan);
    await expect(syncPlanToRazorpay("p1")).rejects.toMatchObject({ status: 503 });
  });
  it("sizes total_count to about ten years", () => {
    expect(totalCountFor(1)).toBe(120);
    expect(totalCountFor(12)).toBe(10);
  });
});

describe("patchFromEntity and reconcile", () => {
  it("maps Razorpay statuses", () => {
    const e = (status: string) => ({ status, current_start: 1_700_000_000, current_end: 1_702_592_000 });
    expect(patchFromEntity(e("active"), { pastDueSince: new Date(), currentPeriodEnd: null }, now)).toMatchObject({ status: "active", pastDueSince: null });
    const keep = new Date("2026-11-01");
    expect(patchFromEntity(e("halted"), { pastDueSince: keep, currentPeriodEnd: null }, now)).toEqual({ status: "past_due", pastDueSince: keep });
    expect(patchFromEntity(e("pending"), { pastDueSince: null, currentPeriodEnd: null }, now)).toEqual({ status: "past_due", pastDueSince: now });
    expect(patchFromEntity(e("cancelled"), { pastDueSince: null, currentPeriodEnd: new Date() }, now)).toEqual({ status: "canceled", cancelAtPeriodEnd: true });
    expect(patchFromEntity(e("completed"), { pastDueSince: null, currentPeriodEnd: new Date() }, now)).toEqual({ status: "expired" });
    expect(patchFromEntity(e("authenticated"), { pastDueSince: null, currentPeriodEnd: null }, now)).toBeNull();
  });
  it("reconciles stale subscriptions from Razorpay", async () => {
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    db.subscription.findMany.mockResolvedValue([{ id: "s1", razorpaySubscriptionId: "sub_1", pastDueSince: null, currentPeriodEnd: new Date(now.getTime() - 2 * DAY) }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "sub_1", status: "cancelled" }), { status: 200 })));
    expect(await reconcileSubscriptions(now)).toBe(1);
    expect(db.subscription.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { status: "canceled", cancelAtPeriodEnd: true } });
    const where = db.subscription.findMany.mock.calls[0][0].where;
    expect(where.currentPeriodEnd.lt.getTime()).toBe(now.getTime() - DAY);
  });
});

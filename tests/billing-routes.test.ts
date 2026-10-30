import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn() },
  plan: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  subscription: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  invoice: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  billingProfile: { findUnique: vi.fn(), upsert: vi.fn() },
  paymentEvent: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  platformSetting: { findUnique: vi.fn() },
  auditLog: { create: vi.fn() },
}));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => auth);

import { GET as getBilling } from "@/app/api/billing/route";
import { GET as getPlans } from "@/app/api/billing/plans/route";
import { POST as subscribe } from "@/app/api/billing/subscribe/route";
import { POST as verify } from "@/app/api/billing/verify/route";
import { POST as cancel } from "@/app/api/billing/cancel/route";
import { PUT as putProfile } from "@/app/api/billing/profile/route";
import { GET as listInvoices } from "@/app/api/billing/invoices/route";
import { GET as getInvoice } from "@/app/api/billing/invoices/[id]/route";
import { POST as webhook } from "@/app/api/webhooks/razorpay/route";

const origin = "https://wa.edwyz.com";
const actor = (role: "owner" | "admin" | "agent") => ({ userId: "u1", tenantId: "t1", role });
const req = (method: string, body?: unknown, headers: Record<string, string> = { origin }) =>
  new Request("https://wa.edwyz.com/api/billing", { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  process.env.RAZORPAY_KEY_ID = "rzp_test_k";
  process.env.RAZORPAY_KEY_SECRET = "keysecret";
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsecret";
  auth.getActor.mockResolvedValue(actor("owner"));
  db.platformSetting.findUnique.mockResolvedValue(null);
});

describe("role checks", () => {
  it("agents get 403 on every customer route", async () => {
    auth.getActor.mockResolvedValue(actor("agent"));
    const results = await Promise.all([
      getBilling(req("GET")), getPlans(req("GET")), listInvoices(req("GET")), getInvoice(req("GET"), ctx("i1")),
      subscribe(req("POST", { planId: "p" })), verify(req("POST", {})), putProfile(req("PUT", {})),
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(7).fill(403));
  });
  it("cancel is owner only", async () => {
    auth.getActor.mockResolvedValue(actor("admin"));
    expect((await cancel(req("POST", {}))).status).toBe(403);
  });
  it("writes need a same-origin request", async () => {
    const bad = { origin: "https://evil.example" };
    expect((await subscribe(req("POST", { planId: "p" }, bad))).status).toBe(403);
    expect((await cancel(req("POST", {}, bad))).status).toBe(403);
    expect((await putProfile(req("PUT", {}, bad))).status).toBe(403);
    expect((await verify(req("POST", {}, {}))).status).toBe(403);
  });
});

describe("tenant scoping", () => {
  it("invoice detail is looked up by id and the caller's tenant only", async () => {
    auth.getActor.mockResolvedValue(actor("admin"));
    db.invoice.findFirst.mockResolvedValue(null);
    const res = await getInvoice(req("GET"), ctx("other-tenants-invoice"));
    expect(res.status).toBe(404);
    expect(db.invoice.findFirst).toHaveBeenCalledWith({ where: { id: "other-tenants-invoice", tenantId: "t1" } });
  });
  it("invoice list, overview and profile use the actor tenant", async () => {
    db.invoice.findMany.mockResolvedValue([]);
    db.tenant.findUnique.mockResolvedValue({ status: "active", suspendedReason: null, billingExempt: true, trialEndsAt: null, subscription: null });
    db.subscription.findUnique.mockResolvedValue(null);
    db.billingProfile.findUnique.mockResolvedValue(null);
    db.plan.findMany.mockResolvedValue([]);
    await listInvoices(req("GET"));
    expect(db.invoice.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    const res = await getBilling(req("GET"));
    expect(res.status).toBe(200);
    expect(db.subscription.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1" } }));
    expect(db.billingProfile.findUnique).toHaveBeenCalledWith({ where: { tenantId: "t1" } });
    db.billingProfile.upsert.mockResolvedValue({});
    const body = { tenantId: "evil", legalName: "A", addressLine: "x", state: "Delhi", billingEmail: "a@b.co" };
    expect((await putProfile(req("PUT", body))).status).toBe(200);
    const call = db.billingProfile.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId: "t1" });
    expect(call.create.tenantId).toBe("t1");
  });
  it("rejects a bad GSTIN with 400", async () => {
    const res = await putProfile(req("PUT", { legalName: "A", addressLine: "x", state: "Delhi", billingEmail: "a@b.co", gstin: "123" }));
    expect(res.status).toBe(400);
  });
});

describe("subscribe and verify", () => {
  const plan = { id: "p1", code: "pro", name: "Pro", currency: "INR", intervalMonths: 1, pricePaise: 49900, razorpayPlanId: "plan_1" };
  it("creates a subscription with tenantId in notes and never returns the secret", async () => {
    db.plan.findFirst.mockResolvedValue(plan);
    db.subscription.findUnique.mockResolvedValue(null);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "sub_1", status: "created" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await subscribe(req("POST", { planId: "p1" }));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ keyId: "rzp_test_k", subscriptionId: "sub_1", name: "Edwyz WA", description: "Pro" });
    expect(text).not.toContain("keysecret");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ plan_id: "plan_1", notes: { tenantId: "t1" } });
    expect(db.subscription.upsert.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });
  it("refuses a second plan while one is active", async () => {
    db.plan.findFirst.mockResolvedValue(plan);
    db.subscription.findUnique.mockResolvedValue({ status: "active", currentPeriodEnd: new Date(Date.now() + 86_400_000) });
    expect((await subscribe(req("POST", { planId: "p1" }))).status).toBe(409);
  });
  it("404s an inactive or unknown plan", async () => {
    db.plan.findFirst.mockResolvedValue(null);
    expect((await subscribe(req("POST", { planId: "p1" }))).status).toBe(404);
    expect(db.plan.findFirst).toHaveBeenCalledWith({ where: { id: "p1", active: true } });
  });
  const stored = { id: "s1", razorpaySubscriptionId: "sub_1", plan: { intervalMonths: 1 } };
  const sig = (pay: string, sub: string) => createHmac("sha256", "keysecret").update(`${pay}|${sub}`).digest("hex");
  it("activates only with a valid signature for the stored subscription and an active subscription at Razorpay", async () => {
    db.subscription.findUnique.mockResolvedValue({ ...stored, status: "expired", currentPeriodEnd: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "sub_1", status: "active", current_start: 1_800_000_000, current_end: 1_802_592_000 }), { status: 200 })));
    const ok = await verify(req("POST", { razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_1", razorpay_signature: sig("pay_1", "sub_1") }));
    expect(ok.status).toBe(200);
    const data = db.subscription.update.mock.calls[0][0].data;
    expect(data.status).toBe("active");
    expect(data.currentPeriodEnd).toEqual(new Date(1_802_592_000 * 1000));
    db.subscription.update.mockClear();
    const forged = await verify(req("POST", { razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_1", razorpay_signature: "00" }));
    expect(forged.status).toBe(400);
    const other = await verify(req("POST", { razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_other", razorpay_signature: sig("pay_1", "sub_other") }));
    expect(other.status).toBe(400);
    expect(db.subscription.update).not.toHaveBeenCalled();
  });
  it("answers 409 and changes nothing while Razorpay does not report the subscription active", async () => {
    db.subscription.findUnique.mockResolvedValue({ ...stored, status: "expired", currentPeriodEnd: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "sub_1", status: "authenticated" }), { status: 200 })));
    const res = await verify(req("POST", { razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_1", razorpay_signature: sig("pay_1", "sub_1") }));
    expect(res.status).toBe(409);
    expect(db.subscription.update).not.toHaveBeenCalled();
  });
});

describe("cancel", () => {
  it("cancels at cycle end through Razorpay", async () => {
    db.subscription.findUnique.mockResolvedValue({ id: "s1", status: "active", razorpaySubscriptionId: "sub_1", cancelAtPeriodEnd: false, currentPeriodEnd: null });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "sub_1", status: "active" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await cancel(req("POST", {}))).status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.razorpay.com/v1/subscriptions/sub_1/cancel");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ cancel_at_cycle_end: true });
    expect(db.subscription.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { cancelAtPeriodEnd: true } });
  });
});

describe("webhook", () => {
  const event = (name: string, extra: Record<string, unknown> = {}, notesTenant = "t1") =>
    JSON.stringify({
      event: name,
      payload: {
        subscription: { entity: { id: "sub_1", status: "active", current_start: 1_800_000_000, current_end: 1_802_592_000, notes: { tenantId: notesTenant } } },
        ...extra,
      },
    });
  const send = (body: string, id = "evt_1", signature?: string) =>
    webhook(new Request("https://wa.edwyz.com/api/webhooks/razorpay", {
      method: "POST",
      headers: { "x-razorpay-signature": signature ?? createHmac("sha256", "whsecret").update(body).digest("hex"), "x-razorpay-event-id": id },
      body,
    }));
  const stored = { id: "s1", tenantId: "t1", pastDueSince: null, currentPeriodEnd: null, currentPeriodStart: null, plan: { name: "Pro", currency: "INR" } };

  beforeEach(() => {
    db.paymentEvent.create.mockResolvedValue({ id: "pe1" });
    db.subscription.findUnique.mockResolvedValue(stored);
    db.invoice.findUnique.mockResolvedValue(null);
    db.invoice.findFirst.mockResolvedValue(null);
    db.billingProfile.findUnique.mockResolvedValue(null);
    db.invoice.create.mockResolvedValue({});
  });

  it("rejects a bad signature with 401 and stores nothing", async () => {
    expect((await send(event("subscription.charged"), "evt_1", "deadbeef")).status).toBe(401);
    expect(db.paymentEvent.create).not.toHaveBeenCalled();
  });
  it("rejects bodies over 1 MB", async () => {
    const res = await webhook(new Request("https://wa.edwyz.com/api/webhooks/razorpay", { method: "POST", headers: { "content-length": "2000000" }, body: "x" }));
    expect(res.status).toBe(413);
  });
  it("duplicate processed event ids return 200 without reprocessing", async () => {
    db.paymentEvent.create.mockRejectedValue({ code: "P2002" });
    db.paymentEvent.findUnique.mockResolvedValue({ id: "pe1", processedAt: new Date() });
    expect((await send(event("subscription.charged"))).status).toBe(200);
    expect(db.subscription.update).not.toHaveBeenCalled();
  });
  it("charged activates, clears past due and issues one invoice with redacted storage", async () => {
    const payment = { entity: { id: "pay_1", amount: 11800, currency: "INR", status: "captured", card: { last4: "1111" }, email: "a@b.co" } };
    const res = await send(event("subscription.charged", { payment }));
    expect(res.status).toBe(200);
    const data = db.subscription.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "active", pastDueSince: null });
    expect(data.currentPeriodEnd).toEqual(new Date(1_802_592_000 * 1000));
    expect(db.invoice.create).toHaveBeenCalledTimes(1);
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", razorpayPaymentId: "pay_1", totalPaise: 11800, gstPaise: 1800 });
    const stored = JSON.stringify(db.paymentEvent.create.mock.calls[0][0].data.payload);
    expect(stored).not.toContain("1111");
    expect(stored).not.toContain("a@b.co");
    expect(db.paymentEvent.update.mock.calls[0][0].data.processedAt).toBeInstanceOf(Date);
  });
  it("does not create a second invoice for a payment already invoiced", async () => {
    db.invoice.findUnique.mockResolvedValue({ id: "i1" });
    const payment = { entity: { id: "pay_1", amount: 11800, status: "captured" } };
    await send(event("subscription.activated", { payment }));
    expect(db.invoice.create).not.toHaveBeenCalled();
  });
  it("halted and pending mark past_due", async () => {
    const body = JSON.stringify({ event: "subscription.halted", payload: { subscription: { entity: { id: "sub_1", status: "halted", notes: { tenantId: "t1" } } } } });
    await send(body);
    const data = db.subscription.update.mock.calls[0][0].data;
    expect(data.status).toBe("past_due");
    expect(data.pastDueSince).toBeInstanceOf(Date);
  });
  it("cancelled and completed map to canceled and expired", async () => {
    await send(JSON.stringify({ event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_1", status: "cancelled", notes: { tenantId: "t1" } } } } }), "e2");
    expect(db.subscription.update.mock.calls[0][0].data.status).toBe("canceled");
    await send(JSON.stringify({ event: "subscription.completed", payload: { subscription: { entity: { id: "sub_1", status: "completed", notes: { tenantId: "t1" } } } } }), "e3");
    expect(db.subscription.update.mock.calls[1][0].data.status).toBe("expired");
  });
  it("ignores an event whose notes tenant does not match the stored subscription", async () => {
    const res = await send(event("subscription.charged", {}, "t-other"));
    expect(res.status).toBe(200);
    expect(db.subscription.update).not.toHaveBeenCalled();
    expect(db.paymentEvent.update.mock.calls[0][0].data.error).toBe("tenant mismatch");
  });
  it("stores payment.failed and unknown events without side effects", async () => {
    const failed = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: "pay_x", status: "failed" } } } });
    expect((await send(failed, "e4")).status).toBe(200);
    expect((await send(JSON.stringify({ event: "something.new", payload: {} }), "e5")).status).toBe(200);
    expect(db.paymentEvent.create).toHaveBeenCalledTimes(2);
    expect(db.subscription.update).not.toHaveBeenCalled();
  });
  it("returns 500 so Razorpay retries when processing fails", async () => {
    db.subscription.findUnique.mockRejectedValue(new Error("db down"));
    db.paymentEvent.update.mockResolvedValue({});
    expect((await send(event("subscription.charged"))).status).toBe(500);
  });
});

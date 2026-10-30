import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn() },
  plan: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  subscription: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  invoice: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  billingProfile: { findUnique: vi.fn() },
  paymentEvent: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  platformSetting: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
  membership: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/email", () => ({ queueEmail: vi.fn() }));

import { POST as webhookRoute } from "@/app/api/webhooks/razorpay/route";
import { cancelAtPeriodEnd, confirmCheckout, startSubscription } from "@/lib/billing/service";
import { cancelSubscription, createSubscription, fetchSubscription, razorpayConfigured, syncPlanToRazorpay } from "@/lib/billing/razorpay";
import { handleRazorpayWebhook, redactPayload } from "@/lib/billing/webhook";
import { reconcileSubscriptions } from "@/lib/billing/worker";

const DAY = 86_400_000;
const actor = { userId: "u1", tenantId: "t1", role: "owner" as const };
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const sign = (body: string, secret = "whsecret") => createHmac("sha256", secret).update(body).digest("hex");

const plan = { id: "p1", code: "pro", name: "Pro", pricePaise: 59000, currency: "INR", intervalMonths: 1, razorpayPlanId: "plan_1" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  process.env.RAZORPAY_KEY_ID = "rzp_test_key";
  process.env.RAZORPAY_KEY_SECRET = "keysecret";
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsecret";
  db.platformSetting.findUnique.mockResolvedValue(null);
});

describe("razorpay client", () => {
  it("authenticates with the key pair and never sends the secret in a body or url", async () => {
    fetchMock.mockResolvedValue(json({ id: "sub_1", status: "created" }));
    await createSubscription({ razorpayPlanId: "plan_1", intervalMonths: 1, notes: { tenantId: "t1", planCode: "pro" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.razorpay.com/v1/subscriptions");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("rzp_test_key:keysecret").toString("base64")}`);
    expect(String(url) + String(init.body)).not.toContain("keysecret");
    expect(JSON.parse(init.body)).toEqual({ plan_id: "plan_1", total_count: 120, customer_notify: true, notes: { tenantId: "t1", planCode: "pro" } });
  });

  it("cancels at the end of the cycle by default and immediately only when asked", async () => {
    fetchMock.mockResolvedValue(json({ id: "sub_1", status: "active" }));
    await cancelSubscription("sub_1");
    await cancelSubscription("sub_1", false);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.razorpay.com/v1/subscriptions/sub_1/cancel");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ cancel_at_cycle_end: true });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ cancel_at_cycle_end: false });
  });

  it("url-encodes ids and reads with GET", async () => {
    fetchMock.mockResolvedValue(json({ id: "x", status: "active" }));
    await fetchSubscription("sub_1/../../plans");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.razorpay.com/v1/subscriptions/sub_1%2F..%2F..%2Fplans");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it("turns a provider rejection into a 502 with the provider's reason, and a network failure into a 502", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { description: "The amount must be at least INR 1.00" } }, 400));
    await expect(createSubscription({ razorpayPlanId: "p", intervalMonths: 1, notes: {} })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("at least INR 1.00") });
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(fetchSubscription("sub_1")).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(fetchSubscription("sub_1")).rejects.toMatchObject({ status: 502 });
  });

  it("says payments are not configured instead of calling out without keys", async () => {
    delete process.env.RAZORPAY_KEY_SECRET;
    expect(razorpayConfigured()).toBe(false);
    await expect(fetchSubscription("sub_1")).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("plan sync", () => {
  it("rejects a plan below the provider minimum before calling out", async () => {
    db.plan.findUnique.mockResolvedValue({ ...plan, pricePaise: 99, razorpayPlanId: null });
    await expect(syncPlanToRazorpay("p1")).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a changed interval or currency on an existing remote plan", async () => {
    db.plan.findUnique.mockResolvedValue(plan);
    fetchMock.mockResolvedValue(json({ id: "plan_1", period: "monthly", interval: 3, item: { amount: 59000, currency: "INR" } }));
    await expect(syncPlanToRazorpay("p1")).rejects.toMatchObject({ status: 409 });
    fetchMock.mockResolvedValue(json({ id: "plan_1", period: "monthly", interval: 1, item: { amount: 59000, currency: "USD" } }));
    await expect(syncPlanToRazorpay("p1")).rejects.toMatchObject({ status: 409 });
  });

  it("404s an unknown plan", async () => {
    db.plan.findUnique.mockResolvedValue(null);
    await expect(syncPlanToRazorpay("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("checkout creation", () => {
  it("creates the remote plan on first use, then the subscription, carrying the tenant in notes", async () => {
    db.plan.findFirst.mockResolvedValue({ ...plan, razorpayPlanId: null });
    db.plan.findUnique.mockResolvedValue({ ...plan, razorpayPlanId: null });
    db.subscription.findUnique.mockResolvedValue(null);
    fetchMock.mockResolvedValueOnce(json({ id: "plan_new" })).mockResolvedValueOnce(json({ id: "sub_new", status: "created" }));
    const out = await startSubscription(actor, "p1");
    expect(out).toEqual({ keyId: "rzp_test_key", subscriptionId: "sub_new", name: "Edwyz WA", description: "Pro" });
    expect(JSON.stringify(out)).not.toContain("keysecret");
    expect(fetchMock.mock.calls[0][0]).toContain("/plans");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ plan_id: "plan_new", notes: { tenantId: "t1", planCode: "pro" } });
    const upsert = db.subscription.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ tenantId: "t1" });
    expect(upsert.create).toMatchObject({ tenantId: "t1", planId: "p1", status: "expired", razorpaySubscriptionId: "sub_new" });
  });

  it("does not grant access before payment: the pending row is not active", async () => {
    db.plan.findFirst.mockResolvedValue(plan);
    db.subscription.findUnique.mockResolvedValue({ status: "canceled", currentPeriodEnd: new Date(Date.now() - DAY), razorpaySubscriptionId: "sub_old" });
    fetchMock.mockResolvedValue(json({ id: "sub_new", status: "created" }));
    await startSubscription(actor, "p1");
    expect(db.subscription.upsert.mock.calls[0][0].update).toMatchObject({ status: "expired", cancelAtPeriodEnd: false, pastDueSince: null });
  });

  it("replaces a past-due subscription and cancels the old one at the provider", async () => {
    db.plan.findFirst.mockResolvedValue(plan);
    db.subscription.findUnique.mockResolvedValue({ status: "past_due", currentPeriodEnd: new Date(Date.now() - DAY), razorpaySubscriptionId: "sub_old" });
    fetchMock.mockResolvedValueOnce(json({ id: "sub_new", status: "created" })).mockResolvedValueOnce(json({ id: "sub_old", status: "cancelled" }));
    await startSubscription(actor, "p1");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.razorpay.com/v1/subscriptions/sub_old/cancel");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ cancel_at_cycle_end: false });
    expect(db.subscription.upsert.mock.calls[0][0].update).toEqual({ planId: "p1", razorpaySubscriptionId: "sub_new", cancelAtPeriodEnd: false });
  });

  it("refuses to stack a second subscription on a paid, running one", async () => {
    db.plan.findFirst.mockResolvedValue(plan);
    db.subscription.findUnique.mockResolvedValue({ status: "active", currentPeriodEnd: new Date(Date.now() + 5 * DAY), razorpaySubscriptionId: "sub_old" });
    await expect(startSubscription(actor, "p1")).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the plan id", async () => {
    await expect(startSubscription(actor, undefined)).rejects.toMatchObject({ status: 400 });
    await expect(startSubscription(actor, "x".repeat(65))).rejects.toMatchObject({ status: 400 });
    db.plan.findFirst.mockResolvedValue(null);
    await expect(startSubscription(actor, "gone")).rejects.toMatchObject({ status: 404 });
    expect(db.plan.findFirst.mock.calls[0][0].where).toEqual({ id: "gone", active: true });
  });
});

describe("checkout confirmation", () => {
  const good = (sig = createHmac("sha256", "keysecret").update("pay_1|sub_1").digest("hex")) => ({
    razorpay_payment_id: "pay_1",
    razorpay_subscription_id: "sub_1",
    razorpay_signature: sig,
  });
  const pending = { id: "s1", tenantId: "t1", razorpaySubscriptionId: "sub_1", status: "expired", currentPeriodEnd: null, pastDueSince: null, plan: { name: "Pro", currency: "INR", intervalMonths: 3 } };
  beforeEach(() => {
    db.subscription.findUnique.mockResolvedValue(pending);
    db.invoice.findUnique.mockResolvedValue(null);
    db.invoice.findFirst.mockResolvedValue(null);
    db.invoice.create.mockResolvedValue({ id: "inv1", totalPaise: 59000 });
    db.billingProfile.findUnique.mockResolvedValue(null);
    db.membership.findMany.mockResolvedValue([]);
  });

  it("activates with the period Razorpay reports once the signature is valid and the provider says active", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      json(String(url).includes("/payments/") ? { id: "pay_1", amount: 59000, currency: "INR", status: "captured" } : { id: "sub_1", status: "active", current_start: 1_800_000_000, current_end: 1_802_592_000, notes: { tenantId: "t1" } }),
    );
    expect(await confirmCheckout(actor, good())).toEqual({ ok: true });
    const data = db.subscription.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "active", pastDueSince: null });
    expect(data.currentPeriodEnd).toEqual(new Date(1_802_592_000 * 1000));
  });

  it("rejects a forged signature, a subscription id that is not yours and missing fields", async () => {
    await expect(confirmCheckout(actor, good("0".repeat(64)))).rejects.toMatchObject({ status: 400 });
    await expect(confirmCheckout(actor, { ...good(), razorpay_subscription_id: "sub_other" })).rejects.toMatchObject({ status: 400 });
    await expect(confirmCheckout(actor, { razorpay_payment_id: "pay_1" })).rejects.toMatchObject({ status: 400 });
    await expect(confirmCheckout(actor, { ...good(), razorpay_payment_id: "p".repeat(201) })).rejects.toMatchObject({ status: 400 });
    expect(db.subscription.update).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when the workspace has no subscription row", async () => {
    db.subscription.findUnique.mockResolvedValue(null);
    await expect(confirmCheckout(actor, good())).rejects.toMatchObject({ status: 400 });
  });
});

describe("cancel at period end", () => {
  it("asks the provider first and only then marks the row", async () => {
    db.subscription.findUnique.mockResolvedValue({ id: "s1", razorpaySubscriptionId: "sub_1", status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: new Date("2026-12-01") });
    fetchMock.mockResolvedValue(json({ id: "sub_1", status: "active" }));
    expect(await cancelAtPeriodEnd(actor)).toMatchObject({ ok: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ cancel_at_cycle_end: true });
    expect(db.subscription.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { cancelAtPeriodEnd: true } });
  });

  it("leaves the row alone when the provider refuses", async () => {
    db.subscription.findUnique.mockResolvedValue({ id: "s1", razorpaySubscriptionId: "sub_1", status: "active", cancelAtPeriodEnd: false });
    fetchMock.mockResolvedValue(json({ error: { description: "cannot cancel in the last cycle" } }, 400));
    await expect(cancelAtPeriodEnd(actor)).rejects.toMatchObject({ status: 502 });
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("is idempotent and refuses when nothing is active", async () => {
    db.subscription.findUnique.mockResolvedValue({ id: "s1", razorpaySubscriptionId: "sub_1", status: "active", cancelAtPeriodEnd: true });
    await cancelAtPeriodEnd(actor);
    expect(fetchMock).not.toHaveBeenCalled();
    db.subscription.findUnique.mockResolvedValue({ id: "s1", razorpaySubscriptionId: "sub_1", status: "past_due", cancelAtPeriodEnd: false });
    await expect(cancelAtPeriodEnd(actor)).rejects.toMatchObject({ status: 409 });
    db.subscription.findUnique.mockResolvedValue(null);
    await expect(cancelAtPeriodEnd(actor)).rejects.toMatchObject({ status: 409 });
  });
});

describe("webhook idempotency and safety", () => {
  const body = JSON.stringify({
    event: "subscription.charged",
    payload: {
      subscription: { entity: { id: "sub_1", status: "active", current_start: 1_800_000_000, current_end: 1_802_592_000, notes: { tenantId: "t1" } } },
      payment: { entity: { id: "pay_1", amount: 59000, currency: "INR", status: "captured", method: "card", card: { last4: "4242" }, vpa: "a@upi", email: "buyer@x.test", contact: "+919999999999" } },
    },
  });
  const stored = { id: "s1", tenantId: "t1", pastDueSince: null, currentPeriodEnd: null, currentPeriodStart: null, plan: { name: "Pro", currency: "INR" } };
  const headers = (b: string, id?: string) => {
    const h = new Headers({ "x-razorpay-signature": sign(b) });
    if (id) h.set("x-razorpay-event-id", id);
    return h;
  };

  beforeEach(() => {
    db.paymentEvent.create.mockResolvedValue({ id: "pe1" });
    db.paymentEvent.update.mockResolvedValue({});
    db.subscription.findUnique.mockResolvedValue(stored);
    db.invoice.findUnique.mockResolvedValue(null);
    db.invoice.findFirst.mockResolvedValue(null);
    db.invoice.create.mockResolvedValue({ id: "inv1", totalPaise: 59000 });
    db.billingProfile.findUnique.mockResolvedValue(null);
    db.membership.findMany.mockResolvedValue([]);
  });

  it("re-processes an event that arrived before but never finished, and marks it done", async () => {
    db.paymentEvent.create.mockRejectedValue({ code: "P2002" });
    db.paymentEvent.findUnique.mockResolvedValue({ id: "pe1", processedAt: null });
    const res = await handleRazorpayWebhook(body, headers(body, "evt_9"));
    expect(res.status).toBe(200);
    expect(db.subscription.update).toHaveBeenCalledTimes(1);
    expect(db.paymentEvent.update.mock.calls[0][0]).toMatchObject({ where: { id: "pe1" }, data: { error: null } });
  });

  it("derives a stable event id from the body when the header is missing, so a re-delivery is still caught", async () => {
    await handleRazorpayWebhook(body, headers(body));
    expect(db.paymentEvent.create.mock.calls[0][0].data.eventId).toBe(`body-${createHash("sha256").update(body).digest("hex")}`);
  });

  it("stores no card, UPI, email or phone details of the payer", async () => {
    await handleRazorpayWebhook(body, headers(body, "evt_1"));
    const saved = JSON.stringify(db.paymentEvent.create.mock.calls[0][0].data.payload);
    for (const secret of ["4242", "a@upi", "buyer@x.test", "+919999999999"]) expect(saved).not.toContain(secret);
    expect(saved).toContain("pay_1");
    expect(redactPayload(null)).toEqual({});
  });

  it("issues no invoice for a payment that was not captured or for an event without a payment", async () => {
    const authorised = body.replace('"captured"', '"authorized"');
    await handleRazorpayWebhook(authorised, headers(authorised, "evt_2"));
    const noPayment = JSON.stringify({ event: "subscription.activated", payload: { subscription: { entity: { id: "sub_1", status: "active", notes: { tenantId: "t1" } } } } });
    await handleRazorpayWebhook(noPayment, headers(noPayment, "evt_3"));
    expect(db.invoice.create).not.toHaveBeenCalled();
    expect(db.subscription.update).toHaveBeenCalledTimes(2);
  });

  it("records an unknown subscription as an error without touching anything", async () => {
    db.subscription.findUnique.mockResolvedValue(null);
    const res = await handleRazorpayWebhook(body, headers(body, "evt_4"));
    expect(res.status).toBe(200);
    expect(db.paymentEvent.update.mock.calls[0][0].data.error).toBe("unknown subscription");
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("uses only the stored subscription's tenant, never one named in the payload", async () => {
    const forged = body.replace('"tenantId":"t1"', '"tenantId":"t-victim"');
    await handleRazorpayWebhook(forged, headers(forged, "evt_5"));
    expect(db.subscription.update).not.toHaveBeenCalled();
    expect(db.invoice.create).not.toHaveBeenCalled();
    expect(db.subscription.findUnique.mock.calls[0][0].where).toEqual({ razorpaySubscriptionId: "sub_1" });
  });

  it("rejects a bad or missing signature and malformed json after a good one", async () => {
    expect((await handleRazorpayWebhook(body, new Headers())).status).toBe(401);
    expect((await handleRazorpayWebhook(body, new Headers({ "x-razorpay-signature": sign(body, "wrong") }))).status).toBe(401);
    const bad = "{not json";
    expect((await handleRazorpayWebhook(bad, headers(bad))).status).toBe(400);
    expect(db.paymentEvent.create).not.toHaveBeenCalled();
  });

  it("rejects everything while no webhook secret is configured", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    expect((await handleRazorpayWebhook(body, headers(body))).status).toBe(401);
  });

  it("the route refuses oversized bodies before verifying", async () => {
    const res = await webhookRoute(new Request("https://wa.edwyz.com/api/webhooks/razorpay", { method: "POST", headers: { "content-length": "5000000" }, body: "x" }));
    expect(res.status).toBe(413);
    expect(db.paymentEvent.create).not.toHaveBeenCalled();
  });
});

describe("reconcile job", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  const row = (id: string) => ({ id, razorpaySubscriptionId: `sub_${id}`, pastDueSince: null, currentPeriodEnd: new Date(now.getTime() - 2 * DAY) });

  it("does nothing without keys", async () => {
    delete process.env.RAZORPAY_KEY_ID;
    expect(await reconcileSubscriptions(now)).toBe(0);
    expect(db.subscription.findMany).not.toHaveBeenCalled();
  });

  it("looks only at paid or past-due subscriptions overdue by more than a day, oldest first, 50 at a time", async () => {
    db.subscription.findMany.mockResolvedValue([]);
    await reconcileSubscriptions(now);
    expect(db.subscription.findMany.mock.calls[0][0]).toMatchObject({
      where: { razorpaySubscriptionId: { not: null }, status: { in: ["active", "past_due"] } },
      take: 50,
      orderBy: { currentPeriodEnd: "asc" },
    });
  });

  it("applies what Razorpay says, skips unchanged ones and carries on after one failure", async () => {
    db.subscription.findMany.mockResolvedValue([row("a"), row("b"), row("c")]);
    fetchMock
      .mockResolvedValueOnce(json({ id: "sub_a", status: "halted" }))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(json({ id: "sub_c", status: "authenticated" }));
    expect(await reconcileSubscriptions(now)).toBe(1);
    expect(db.subscription.update).toHaveBeenCalledTimes(1);
    expect(db.subscription.update.mock.calls[0][0]).toMatchObject({ where: { id: "a" }, data: { status: "past_due" } });
  });

  it("brings a renewed subscription back to active with its new period", async () => {
    db.subscription.findMany.mockResolvedValue([row("a")]);
    fetchMock.mockResolvedValue(json({ id: "sub_a", status: "active", current_start: 1_800_000_000, current_end: 1_802_592_000 }));
    await reconcileSubscriptions(now);
    const data = db.subscription.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "active", pastDueSince: null });
    expect(data.currentPeriodEnd).toEqual(new Date(1_802_592_000 * 1000));
  });
});

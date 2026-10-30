import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn() },
  subscription: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  invoice: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  billingProfile: { findUnique: vi.fn(), upsert: vi.fn() },
  paymentEvent: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  platformSetting: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  membership: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/email", () => ({ queueEmail: vi.fn() }));

import { confirmCheckout, saveBillingProfile } from "@/lib/billing/service";
import { handleRazorpayWebhook } from "@/lib/billing/webhook";
import { backfillMissingInvoices, reconcileSubscriptions } from "@/lib/billing/worker";

const DAY = 86_400_000;
const actor = { userId: "u1", tenantId: "t1", role: "owner" as const };
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const sign = (body: string) => createHmac("sha256", "whsecret").update(body).digest("hex");
let settings: Map<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  process.env.RAZORPAY_KEY_ID = "rzp_test_key";
  process.env.RAZORPAY_KEY_SECRET = "keysecret";
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsecret";
  settings = new Map();
  db.platformSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { value: settings.get(where.key) } : null));
  db.platformSetting.create.mockImplementation(async ({ data }: { data: { key: string; value: unknown } }) => {
    if (settings.has(data.key)) throw Object.assign(new Error("dup"), { code: "P2002" });
    settings.set(data.key, data.value);
    return {};
  });
  db.platformSetting.upsert.mockImplementation(async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => {
    settings.set(where.key, create.value);
    return {};
  });
});

describe("checkout confirmation cannot be replayed", () => {
  const sigFor = (pay = "pay_1", sub = "sub_1") => createHmac("sha256", "keysecret").update(`${pay}|${sub}`).digest("hex");
  const good = () => ({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_1", razorpay_signature: sigFor() });
  const pending = { id: "s1", tenantId: "t1", razorpaySubscriptionId: "sub_1", status: "expired", currentPeriodEnd: null, pastDueSince: null, plan: { name: "Pro", currency: "INR", intervalMonths: 3 } };
  const remote = (over: Record<string, unknown> = {}) => ({ id: "sub_1", status: "active", current_start: 1_800_000_000, current_end: 1_802_592_000, notes: { tenantId: "t1" }, ...over });
  const remoteSays = (sub: Record<string, unknown>, payment: Record<string, unknown> = { id: "pay_1", amount: 59000, currency: "INR", status: "captured" }) =>
    fetchMock.mockImplementation(async (url: string) => json(String(url).includes("/payments/") ? payment : sub));

  beforeEach(() => {
    db.subscription.findUnique.mockResolvedValue(pending);
    db.invoice.findUnique.mockResolvedValue(null);
    db.invoice.findFirst.mockResolvedValue(null);
    db.invoice.create.mockResolvedValue({ id: "inv1", totalPaise: 59000 });
    db.billingProfile.findUnique.mockResolvedValue(null);
    db.membership.findMany.mockResolvedValue([]);
  });

  it("takes the period from Razorpay, not from now plus the interval", async () => {
    remoteSays(remote());
    expect(await confirmCheckout(actor, good())).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.razorpay.com/v1/subscriptions/sub_1");
    const data = db.subscription.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "active", pastDueSince: null, cancelAtPeriodEnd: false });
    expect(data.currentPeriodStart).toEqual(new Date(1_800_000_000 * 1000));
    expect(data.currentPeriodEnd).toEqual(new Date(1_802_592_000 * 1000));
  });

  it("issues the GST invoice for the captured payment so it does not depend on the webhook", async () => {
    remoteSays(remote());
    await confirmCheckout(actor, good());
    expect(db.invoice.create).toHaveBeenCalledTimes(1);
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", razorpayPaymentId: "pay_1", totalPaise: 59000, planName: "Pro" });
  });

  it("still activates when the payment lookup fails; the invoice is left to the webhook and the backfill job", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes("/payments/") ? json({}, 500) : json(remote())));
    expect(await confirmCheckout(actor, good())).toEqual({ ok: true });
    expect(db.subscription.update).toHaveBeenCalledTimes(1);
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  it("does not activate while Razorpay has not charged the subscription (created, authenticated, pending)", async () => {
    for (const status of ["created", "authenticated", "pending"]) {
      remoteSays(remote({ status }));
      await expect(confirmCheckout(actor, good())).rejects.toMatchObject({ status: 409 });
    }
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("replay after a cancel: the saved success payload cannot bring a cancelled workspace back", async () => {
    db.subscription.findUnique.mockResolvedValue({ ...pending, status: "canceled", currentPeriodEnd: new Date(Date.now() - DAY) });
    remoteSays(remote({ status: "cancelled" }));
    await expect(confirmCheckout(actor, good())).rejects.toMatchObject({ status: 409 });
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("replay after a failed charge (past due or halted) does not clear the failure", async () => {
    for (const status of ["pending", "halted"]) {
      db.subscription.findUnique.mockResolvedValue({ ...pending, status: "past_due", pastDueSince: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() - 2 * DAY) });
      remoteSays(remote({ status }));
      await expect(confirmCheckout(actor, good())).rejects.toMatchObject({ status: 409 });
    }
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("replay after expiry does not extend the period", async () => {
    db.subscription.findUnique.mockResolvedValue({ ...pending, status: "expired", currentPeriodEnd: new Date(Date.now() - 40 * DAY) });
    remoteSays(remote({ status: "completed" }));
    await expect(confirmCheckout(actor, good())).rejects.toMatchObject({ status: 409 });
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("replay while active and paid up changes nothing and does not even call Razorpay", async () => {
    db.subscription.findUnique.mockResolvedValue({ ...pending, status: "active", currentPeriodEnd: new Date(Date.now() + 10 * DAY) });
    expect(await confirmCheckout(actor, good())).toEqual({ ok: true, alreadyActive: true });
    expect(db.subscription.update).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a payment id works once: a second confirmation after the workspace lapsed is refused even if Razorpay still says active", async () => {
    remoteSays(remote());
    await confirmCheckout(actor, good());
    expect([...settings.keys()]).toContain("billing:checkout-payment:t1:pay_1");
    db.subscription.update.mockClear();
    db.subscription.findUnique.mockResolvedValue({ ...pending, status: "expired", currentPeriodEnd: new Date(Date.now() - DAY) });
    await expect(confirmCheckout(actor, good())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already used") });
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("refuses a subscription whose notes name another workspace", async () => {
    remoteSays(remote({ notes: { tenantId: "t-other" } }));
    await expect(confirmCheckout(actor, good())).rejects.toMatchObject({ status: 400 });
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("falls back to the plan interval only when Razorpay gives no period", async () => {
    remoteSays(remote({ current_start: undefined, current_end: undefined }));
    await confirmCheckout(actor, good());
    const data = db.subscription.update.mock.calls[0][0].data;
    expect(data.currentPeriodEnd.getTime() - data.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(89 * DAY);
  });
});

describe("webhook ordering", () => {
  const event = (name: string, status: string, createdAt?: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      event: name,
      ...(createdAt ? { created_at: createdAt } : {}),
      payload: { subscription: { entity: { id: "sub_1", status, current_start: 1_800_000_000, current_end: 1_802_592_000, notes: { tenantId: "t1" } } }, ...extra },
    });
  const post = (body: string, id: string) => handleRazorpayWebhook(body, new Headers({ "x-razorpay-signature": sign(body), "x-razorpay-event-id": id }));
  const stored = { id: "s1", tenantId: "t1", pastDueSince: null, currentPeriodEnd: null, currentPeriodStart: null, plan: { name: "Pro", currency: "INR" } };

  beforeEach(() => {
    db.paymentEvent.create.mockResolvedValue({ id: "pe1" });
    db.paymentEvent.update.mockResolvedValue({});
    db.subscription.findUnique.mockResolvedValue(stored);
    db.tenant.findUnique.mockResolvedValue({ name: "Acme" });
    db.invoice.findUnique.mockResolvedValue(null);
    db.invoice.findFirst.mockResolvedValue(null);
    db.invoice.create.mockResolvedValue({ id: "inv1", totalPaise: 59000 });
    db.billingProfile.findUnique.mockResolvedValue(null);
    db.membership.findMany.mockResolvedValue([]);
  });

  it("a delayed pending that arrives after charged does not flip an active workspace to past due", async () => {
    expect((await post(event("subscription.charged", "active", 2000), "e_new")).status).toBe(200);
    expect(db.subscription.update).toHaveBeenCalledTimes(1);
    db.subscription.update.mockClear();
    const late = await post(event("subscription.pending", "pending", 1000), "e_old");
    expect(late.status).toBe(200);
    expect(db.subscription.update).not.toHaveBeenCalled();
    expect(db.paymentEvent.update.mock.calls.at(-1)?.[0].data.error).toContain("older");
  });

  it("sends no payment failed mail for a stale pending or halted", async () => {
    await post(event("subscription.charged", "active", 2000), "e_new");
    await post(event("subscription.halted", "halted", 1500), "e_old");
    expect(db.subscription.update).toHaveBeenCalledTimes(1);
    expect(db.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("applies a newer event and an event with the same timestamp", async () => {
    await post(event("subscription.pending", "pending", 1000), "e1");
    await post(event("subscription.charged", "active", 1000), "e2");
    await post(event("subscription.halted", "halted", 3000), "e3");
    expect(db.subscription.update).toHaveBeenCalledTimes(3);
    expect(db.subscription.update.mock.calls[2][0].data.status).toBe("past_due");
  });

  it("an event without created_at cannot be ordered and is applied", async () => {
    await post(event("subscription.charged", "active", 2000), "e1");
    await post(event("subscription.pending", "pending"), "e2");
    expect(db.subscription.update).toHaveBeenCalledTimes(2);
  });

  it("still invoices a stale charged event's payment exactly once", async () => {
    await post(event("subscription.activated", "active", 5000), "e_new");
    db.subscription.update.mockClear();
    const payment = { payment: { entity: { id: "pay_old", amount: 59000, currency: "INR", status: "captured" } } };
    await post(event("subscription.charged", "active", 1000, payment), "e_old");
    expect(db.subscription.update).not.toHaveBeenCalled();
    expect(db.invoice.create).toHaveBeenCalledTimes(1);
  });
});

describe("invoice backfill and reconcile ordering", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  const sub = { id: "s1", tenantId: "t1", razorpaySubscriptionId: "sub_1", currentPeriodStart: new Date(now.getTime() - DAY), currentPeriodEnd: new Date(now.getTime() + 29 * DAY), plan: { name: "Pro", currency: "INR" } };

  beforeEach(() => {
    db.invoice.findUnique.mockResolvedValue(null);
    db.invoice.create.mockResolvedValue({ id: "inv1", totalPaise: 59000 });
    db.billingProfile.findUnique.mockResolvedValue(null);
    db.membership.findMany.mockResolvedValue([]);
  });

  it("issues the invoice and receipt for a charge whose webhook never arrived", async () => {
    db.subscription.findMany.mockResolvedValue([sub]);
    db.invoice.findFirst.mockResolvedValue(null);
    fetchMock.mockResolvedValue(
      json({
        items: [
          { id: "inv_rz", status: "paid", payment_id: "pay_9", amount: 59000, currency: "INR", paid_at: 1_800_000_100, billing_start: 1_800_000_000, billing_end: 1_802_592_000 },
          { id: "inv_x", status: "issued", payment_id: null, amount: 59000 },
        ],
      }),
    );
    expect(await backfillMissingInvoices(now)).toBe(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.razorpay.com/v1/invoices?subscription_id=sub_1&count=10");
    expect(db.invoice.create).toHaveBeenCalledTimes(1);
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", razorpayPaymentId: "pay_9", totalPaise: 59000, paidAt: new Date(1_800_000_100 * 1000) });
  });

  it("does not call Razorpay when the period already has an invoice, and looks only at recently renewed active subscriptions", async () => {
    db.subscription.findMany.mockResolvedValue([sub]);
    db.invoice.findFirst.mockResolvedValue({ id: "inv_have" });
    expect(await backfillMissingInvoices(now)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const where = db.subscription.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "active", razorpaySubscriptionId: { not: null } });
    expect(where.currentPeriodStart.gte).toEqual(new Date(now.getTime() - 3 * DAY));
  });

  it("is harmless to run twice: a payment already invoiced creates nothing", async () => {
    db.subscription.findMany.mockResolvedValue([sub]);
    db.invoice.findFirst.mockResolvedValue(null);
    db.invoice.findUnique.mockResolvedValue({ id: "inv1", totalPaise: 59000 });
    fetchMock.mockResolvedValue(json({ items: [{ id: "inv_rz", status: "paid", payment_id: "pay_9", amount: 59000, currency: "INR" }] }));
    expect(await backfillMissingInvoices(now)).toBe(0);
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  it("survives a provider failure for one subscription and does nothing without keys", async () => {
    db.subscription.findMany.mockResolvedValue([sub, { ...sub, id: "s2", tenantId: "t2", razorpaySubscriptionId: "sub_2" }]);
    db.invoice.findFirst.mockResolvedValue(null);
    fetchMock.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(json({ items: [{ status: "paid", payment_id: "pay_2", amount: 59000, currency: "INR" }] }));
    expect(await backfillMissingInvoices(now)).toBe(1);
    delete process.env.RAZORPAY_KEY_SECRET;
    db.subscription.findMany.mockClear();
    expect(await backfillMissingInvoices(now)).toBe(0);
    expect(db.subscription.findMany).not.toHaveBeenCalled();
  });

  it("reconcile records the time it applied, so a later stale webhook cannot undo it", async () => {
    db.subscription.findMany.mockResolvedValue([{ id: "a", tenantId: "t1", razorpaySubscriptionId: "sub_a", pastDueSince: null, currentPeriodEnd: new Date(now.getTime() - 2 * DAY) }]);
    fetchMock.mockResolvedValue(json({ id: "sub_a", status: "active", current_start: 1_800_000_000, current_end: 1_802_592_000 }));
    await reconcileSubscriptions(now);
    expect(settings.get("billing:last-event:t1")).toEqual({ at: Math.floor(now.getTime() / 1000) });
  });
});

describe("buyer details completed after a first payment", () => {
  const profile = { legalName: "Acme Traders", gstin: "27AAAAA0000A1Z5", addressLine: "5 Park Street", state: "Maharashtra", pincode: "400001", billingEmail: "a@acme.test" };

  it("fills invoices issued without a buyer from the billing profile and sets the place of supply that was unknown", async () => {
    db.billingProfile.upsert.mockImplementation(async ({ create }: { create: object }) => create);
    db.invoice.findMany.mockResolvedValue([{ id: "i1", number: "EDW/2026-27/00001" }]);
    settings.set("invoice-meta:EDW/2026-27/00001", { v: 1, proforma: false, sellerName: "S", sellerAddress: "A", sellerGstin: "29ABCDE1234F1Z5", sellerStateCode: "29", buyerStateCode: null });
    await saveBillingProfile(actor, profile);
    expect(db.invoice.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", customerName: null });
    expect(db.invoice.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", customerName: null, id: { in: ["i1"] } },
      data: { customerName: "Acme Traders", customerGstin: "27AAAAA0000A1Z5", customerAddress: "5 Park Street, Maharashtra, 400001" },
    });
    expect((settings.get("invoice-meta:EDW/2026-27/00001") as { buyerStateCode: string }).buyerStateCode).toBe("27");
  });

  it("changes nothing when every invoice already names a buyer", async () => {
    db.billingProfile.upsert.mockImplementation(async ({ create }: { create: object }) => create);
    db.invoice.findMany.mockResolvedValue([]);
    await saveBillingProfile(actor, profile);
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
  });
});

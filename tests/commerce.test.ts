import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({
    findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
    deleteMany: vi.fn(), count: vi.fn(), upsert: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(),
  });
  return {
    shopifyStore: model(), abandonedCart: model(), contact: model(), conversation: model(),
    template: model(), phoneNumber: model(), platformSetting: model(),
  };
});
const auth = vi.hoisted(() => ({ role: "admin" as "agent" | "admin" | "owner" }));
const send = vi.hoisted(() => ({ sendTemplateMessage: vi.fn() }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: auth.role }) }));
vi.mock("@/lib/inbox/service", () => send);
const shopify = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@/lib/commerce/admin-verify", async (orig) => ({ ...(await orig<typeof import("@/lib/commerce/admin-verify")>()), verifyShopOwnership: shopify.verify }));
vi.mock("@/lib/crypto/secrets", () => ({
  sealSecret: (t: string, v: string) => `sealed:${t}:${v}`,
  openSecret: (t: string, v: string) => v.replace(`sealed:${t}:`, ""),
}));

import { POST as webhook } from "@/app/webhooks/shopify/route";
import { POST as createStoreRoute, GET as listStoresRoute } from "@/app/api/commerce/stores/route";
import { POST as verifyRoute } from "@/app/api/commerce/stores/[id]/verify/route";
import { PUT as putSettings } from "@/app/api/commerce/stores/[id]/settings/route";
import { GET as cartsRoute } from "@/app/api/commerce/carts/route";
import { normalizeShopDomain, verifyShopifyHmac } from "@/lib/commerce/shop";
import { parseCheckout } from "@/lib/commerce/cart";
import { nextReminderAfter, firstReminderAt, isExpired } from "@/lib/commerce/schedule";
import { buildReminderComponents, checkoutSuffix, formatTotal, processDueReminders } from "@/lib/commerce/reminders";
import { bodyVariableCount, reminderSupportReason } from "@/lib/commerce/settings";
import { GET as optionsRoute } from "@/app/api/commerce/options/route";
import { worker } from "@/lib/commerce/worker";
import { resetWebhookGuard } from "@/lib/commerce/webhook-guard";
import { resetOwnershipChecks } from "@/lib/commerce/stores";

const ORIGIN = "https://wa.edwyz.com";
const SECRET = "shpss_secret_value";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("base64");
const store = { id: "s1", tenantId: "t1", status: "active", webhookSecretEnc: `sealed:t1:${SECRET}` };

function hook(topic: string, payload: unknown, opts: { secret?: string; domain?: string | null } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "x-shopify-topic": topic, "x-shopify-hmac-sha256": sign(body, opts.secret) };
  if (opts.domain !== null) headers["x-shopify-shop-domain"] = opts.domain ?? "shop.myshopify.com";
  return new Request("https://wa.edwyz.com/webhooks/shopify", { method: "POST", headers, body });
}

const checkout = {
  id: 111, token: "tok1", phone: "98765 43210", customer: { first_name: "Asha" }, total_price: "1299.50", currency: "inr",
  abandoned_checkout_url: "https://shop.myshopify.com/checkouts/tok1", line_items: [{ title: "Shirt", quantity: 2, price: "649.75" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  resetWebhookGuard();
  void resetOwnershipChecks();
  auth.role = "admin";
  db.shopifyStore.findMany.mockResolvedValue([store]);
  db.abandonedCart.findFirst.mockResolvedValue(null);
  db.abandonedCart.updateMany.mockResolvedValue({ count: 1 });
  db.contact.findFirst.mockResolvedValue(null);
  db.platformSetting.findUnique.mockResolvedValue({ value: { enabled: true, templateId: "tp1", phoneNumberId: "ph1" } });
});

describe("shop helpers", () => {
  it("accepts only myshopify.com domains", () => {
    expect(normalizeShopDomain(" My-Shop.myshopify.com ")).toBe("my-shop.myshopify.com");
    for (const bad of ["evil.com", "a.myshopify.com.evil.com", "https://a.myshopify.com", "a/b.myshopify.com", "", 5]) {
      expect(normalizeShopDomain(bad)).toBeNull();
    }
  });
  it("verifies base64 HMAC over the exact body", () => {
    const body = '{"a":1}';
    expect(verifyShopifyHmac(body, sign(body), SECRET)).toBe(true);
    expect(verifyShopifyHmac(body + " ", sign(body), SECRET)).toBe(false);
    expect(verifyShopifyHmac(body, sign(body, "other"), SECRET)).toBe(false);
    expect(verifyShopifyHmac(body, null, SECRET)).toBe(false);
    expect(verifyShopifyHmac(body, sign(body), null)).toBe(false);
    expect(verifyShopifyHmac(body, "not-base64!!", SECRET)).toBe(false);
  });
});

describe("shopify webhook", () => {
  it("rejects a bad signature and an unknown shop without touching carts", async () => {
    expect((await webhook(hook("checkouts/create", checkout, { secret: "wrong" }))).status).toBe(401);
    db.shopifyStore.findMany.mockResolvedValue([]);
    expect((await webhook(hook("checkouts/create", checkout))).status).toBe(401);
    expect((await webhook(hook("checkouts/create", checkout, { domain: null }))).status).toBe(401);
    expect((await webhook(hook("checkouts/create", checkout, { domain: "evil.com" }))).status).toBe(401);
    expect(db.abandonedCart.create).not.toHaveBeenCalled();
  });
  it("rejects bodies over 512 KB", async () => {
    const big = "x".repeat(513 * 1024);
    const res = await webhook(new Request("https://wa.edwyz.com/webhooks/shopify", { method: "POST", headers: { "x-shopify-shop-domain": "shop.myshopify.com" }, body: big }));
    expect(res.status).toBe(413);
  });
  it("creates a cart with normalised phone, tenant from the store and the first reminder scheduled", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1" });
    const res = await webhook(hook("checkouts/create", checkout));
    expect(res.status).toBe(200);
    const data = db.abandonedCart.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenantId: "t1", storeId: "s1", externalId: "tok1", phone: "+919876543210", contactId: "c1", totalMinor: 129950, currency: "INR", stage: "cart" });
    expect(data.items.firstName).toBe("Asha");
    expect(data.nextReminderAt).toBeInstanceOf(Date);
  });
  it("ignores a body-supplied tenant id", async () => {
    await webhook(hook("checkouts/create", { ...checkout, tenantId: "t999", tenant_id: "t999" }));
    expect(db.abandonedCart.create.mock.calls[0][0].data.tenantId).toBe("t1");
  });
  it("skips carts without a usable phone", async () => {
    const res = await webhook(hook("checkouts/create", { ...checkout, phone: null, customer: {} }));
    expect(res.status).toBe(200);
    expect(db.abandonedCart.create).not.toHaveBeenCalled();
  });
  it("updates an open cart idempotently and never reopens a closed one", async () => {
    db.abandonedCart.findFirst.mockResolvedValueOnce({ id: "a1", status: "open", remindersSent: 0, nextReminderAt: new Date(0) });
    await webhook(hook("checkouts/update", checkout));
    expect(db.abandonedCart.updateMany).toHaveBeenCalledTimes(1);
    expect(db.abandonedCart.create).not.toHaveBeenCalled();

    db.abandonedCart.updateMany.mockClear();
    db.abandonedCart.findFirst.mockResolvedValueOnce({ id: "a1", status: "recovered", remindersSent: 1, nextReminderAt: null });
    await webhook(hook("checkouts/update", checkout));
    expect(db.abandonedCart.updateMany).not.toHaveBeenCalled();
  });
  it("marks the cart recovered on orders/create and on a completed checkout", async () => {
    await webhook(hook("orders/create", { id: 9, checkout_token: "tok1", checkout_id: 111 }));
    expect(db.abandonedCart.updateMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: "t1", storeId: "s1", externalId: { in: ["tok1", "111"] }, status: "open" },
      data: { status: "recovered" },
    });
    db.abandonedCart.updateMany.mockClear();
    await webhook(hook("checkouts/update", { ...checkout, completed_at: "2026-01-01T00:00:00Z" }));
    expect(db.abandonedCart.updateMany.mock.calls[0][0].data.status).toBe("recovered");
  });
  it("returns 500 so Shopify retries when the database fails", async () => {
    db.abandonedCart.findFirst.mockRejectedValue(new Error("db down"));
    expect((await webhook(hook("checkouts/create", checkout))).status).toBe(500);
  });
});

describe("a Shopify marketing consent is never a WhatsApp opt-in (owner default 2)", () => {
  const consenting = {
    ...checkout,
    buyer_accepts_marketing: true,
    accepts_marketing: true,
    customer: { ...(checkout as { customer?: object }).customer, accepts_marketing: true, email_marketing_consent: { state: "subscribed" }, sms_marketing_consent: { state: "subscribed", opt_in_level: "confirmed_opt_in" } },
    sms_marketing_phone: "+919876543210",
  };

  it("the parsed checkout carries no consent at all", () => {
    const parsed = parseCheckout(consenting);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!).sort()).toEqual(["altIds", "checkoutUrl", "completed", "currency", "eventAt", "externalId", "firstName", "lines", "phone", "stage", "totalMinor"]);
    expect(JSON.stringify(parsed)).not.toMatch(/marketing|consent|optIn/i);
  });

  it("a checkout webhook with the buyer's marketing consent never writes a contact or an opt-in", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1" });
    expect((await webhook(hook("checkouts/create", consenting))).status).toBe(200);
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(db.contact.upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(db.abandonedCart.create.mock.calls[0][0].data)).not.toMatch(/optIn|marketing/i);
  });
});

describe("parsing and schedule", () => {
  it("falls back to other phone fields and detects the checkout stage", () => {
    const parsed = parseCheckout({ id: 5, shipping_address: { phone: "+14155550123", address1: "1 Main St" } });
    expect(parsed).toMatchObject({ externalId: "5", phone: "+14155550123", stage: "checkout" });
  });
  it("drops non-https checkout links and clamps future event times", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const parsed = parseCheckout({ ...checkout, abandoned_checkout_url: "http://x.test", updated_at: "2030-01-01T00:00:00Z" }, now);
    expect(parsed?.checkoutUrl).toBeNull();
    expect(parsed?.eventAt).toEqual(now);
  });
  it("schedules gaps and stops after the third reminder", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const gaps = [30, 360, 1440];
    const first = firstReminderAt(t0, gaps);
    expect(first.getTime() - t0.getTime()).toBe(30 * 60_000);
    expect(nextReminderAfter(first, 1, gaps)!.getTime() - first.getTime()).toBe(360 * 60_000);
    expect(nextReminderAfter(first, 2, gaps)!.getTime() - first.getTime()).toBe(1440 * 60_000);
    expect(nextReminderAfter(first, 3, gaps)).toBeNull();
    expect(isExpired(t0, new Date(t0.getTime() + 3 * 86_400_000 + 1))).toBe(true);
    expect(isExpired(t0, new Date(t0.getTime() + 86_400_000))).toBe(false);
  });
  it("maps template variables by position", () => {
    const comps = [{ type: "BODY", text: "Hi {{1}}, {{2}} waiting: {{3}}" }];
    expect(buildReminderComponents(comps, { firstName: "Asha", total: "INR 10", url: "https://x" })).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Asha" }, { type: "text", text: "INR 10" }, { type: "text", text: "https://x" }] },
    ]);
    const two = [{ type: "BODY", text: "Hi {{1}}, total {{2}}" }];
    expect((buildReminderComponents(two, { firstName: "A", total: "T", url: "U" })[0].parameters as { text: string }[]).map((p) => p.text)).toEqual(["A", "T"]);
    expect(buildReminderComponents([{ type: "BODY", text: "Hello" }], { firstName: "A", total: "T", url: "U" })).toEqual([]);
    expect(formatTotal(129950, "INR")).toContain("1,299.50");
  });
  it("fills a website button with the checkout link, through the broadcast value mapping", () => {
    const url = "https://shop.example/123/checkouts/abc/recover?key=k1";
    const withButton = [{ type: "BODY", text: "Hi {{1}}, your cart is waiting" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Complete order", url: "https://shop.example/{{1}}" }] }];
    expect(buildReminderComponents(withButton, { firstName: "Asha", total: "T", url })).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Asha" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123/checkouts/abc/recover?key=k1" }] },
    ]);
    expect(checkoutSuffix("https://shop.example/123/checkouts/{{1}}", url)).toBe("abc/recover?key=k1");
    // A custom domain on the button still gets the checkout's path; a button with its own path that does not match cannot be filled.
    expect(checkoutSuffix("https://mystore.in/{{1}}", "https://x.myshopify.com/1/checkouts/c/recover")).toBe("1/checkouts/c/recover");
    expect(checkoutSuffix("https://mystore.in/orders/{{1}}", url)).toBeNull();
    const mismatch = [{ type: "BODY", text: "Hi" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Go", url: "https://mystore.in/orders/{{1}}" }] }];
    expect(() => buildReminderComponents(mismatch, { firstName: "A", total: "T", url })).toThrow(/could not be filled/);
  });
  it("tells why a template cannot be a reminder, in shop words, and never throws on named placeholders", () => {
    expect(reminderSupportReason([{ type: "BODY", text: "Hi {{first_name}}" }])).toMatch(/named placeholders/);
    expect(bodyVariableCount([{ type: "BODY", text: "Hi {{first_name}}" }])).toBeNull();
    expect(reminderSupportReason([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi" }])).toMatch(/picture/);
    expect(reminderSupportReason([{ type: "BODY", text: "Hi" }, { type: "BUTTONS", buttons: [{ type: "COPY_CODE", example: "SAVE" }] }])).toMatch(/coupon/);
    expect(reminderSupportReason([{ type: "BODY", text: "{{1}} {{2}} {{3}} {{4}}" }])).toMatch(/more than 3/);
    expect(reminderSupportReason([{ type: "BODY", text: "Hi {{1}}" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Go", url: "https://s.example/{{1}}" }] }])).toBeNull();
    for (const reason of [reminderSupportReason([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi" }])]) expect(reason).not.toMatch(/broadcast/i);
  });
});

describe("reminder worker", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const due = new Date("2026-01-01T11:30:00Z");
  const cart = {
    id: "a1", tenantId: "t1", storeId: "s1", phone: "+919876543210", items: { firstName: "Asha", lines: [] }, totalMinor: 129950,
    currency: "INR", checkoutUrl: "https://shop.myshopify.com/c/1", stage: "cart", remindersSent: 0, nextReminderAt: due,
    createdAt: new Date("2026-01-01T11:00:00Z"),
  };
  const template = { name: "cart_reminder", language: "en", components: [{ type: "BODY", text: "Hi {{1}} {{2}} {{3}}" }] };

  beforeEach(() => {
    db.shopifyStore.findFirst.mockReset();
    db.shopifyStore.findFirst.mockResolvedValue({ id: "s1" });
    db.abandonedCart.findMany.mockResolvedValue([cart]);
    db.template.findFirst.mockResolvedValue(template);
    db.contact.findFirst.mockResolvedValue({ id: "c1", name: "Asha K", optIn: true, optedOutAt: null });
    db.conversation.findFirst.mockResolvedValue(null);
    send.sendTemplateMessage.mockResolvedValue({ id: "m1" });
  });

  it("registers a periodic task", () => {
    expect(worker.periodic.map((p) => p.name)).toContain("commerce-reminders");
  });
  it("claims by conditional update then sends the template to opted-in contacts", async () => {
    const tally = await processDueReminders(now);
    expect(tally.sent).toBe(1);
    const claim = db.abandonedCart.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: "a1", tenantId: "t1", status: "open", remindersSent: 0, nextReminderAt: due });
    expect(claim.data.remindersSent).toBe(1);
    expect(claim.data.nextReminderAt.getTime() - due.getTime()).toBe(360 * 60_000);
    expect(send.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", phoneNumberId: "ph1", contactId: "c1", templateName: "cart_reminder" }),
    );
  });
  it("sends nothing for a store that is disabled or was demoted until its owner proves control again, and keeps the cart for later", async () => {
    db.shopifyStore.findFirst.mockResolvedValue(null);
    const tally = await processDueReminders(now);
    expect(tally.deferred).toBe(1);
    expect(tally.sent).toBe(0);
    expect(db.shopifyStore.findFirst.mock.calls[0][0].where).toEqual({ id: "s1", tenantId: "t1", status: "active" });
    expect(send.sendTemplateMessage).not.toHaveBeenCalled();
    expect(db.contact.findFirst).not.toHaveBeenCalled();
    const updates = db.abandonedCart.updateMany.mock.calls.map((c) => c[0].data);
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty("status");
    expect(updates[0]).not.toHaveProperty("remindersSent");
  });
  it("registers the demotion of unclaimed legacy stores as a periodic task", () => {
    expect(worker.periodic.map((p) => p.name)).toContain("commerce-demote-unclaimed");
  });
  it("does not send when another worker won the claim", async () => {
    db.abandonedCart.updateMany.mockResolvedValue({ count: 0 });
    expect((await processDueReminders(now)).lost_claim).toBe(1);
    expect(send.sendTemplateMessage).not.toHaveBeenCalled();
  });
  it("a cart from a checkout whose buyer accepted Shopify marketing still needs the WhatsApp opt-in recorded in Edwyz (owner default 2)", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1", name: null, optIn: false, optedOutAt: null });
    expect((await processDueReminders(now)).opted_out).toBe(1);
    expect(send.sendTemplateMessage).not.toHaveBeenCalled();
  });
  it("a cart reminder is marketing whatever its template category, so an opt-out stops it", async () => {
    db.template.findFirst.mockResolvedValue({ ...template, category: "UTILITY" });
    db.contact.findFirst.mockResolvedValue({ id: "c1", name: null, optIn: true, optedOutAt: now });
    expect((await processDueReminders(now)).opted_out).toBe(1);
    expect(send.sendTemplateMessage).not.toHaveBeenCalled();
  });
  it("stops for contacts without opt-in, who opted out, or who replied", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1", name: null, optIn: false, optedOutAt: null });
    expect((await processDueReminders(now)).opted_out).toBe(1);
    db.contact.findFirst.mockResolvedValue({ id: "c1", name: null, optIn: true, optedOutAt: now });
    expect((await processDueReminders(now)).opted_out).toBe(1);
    db.contact.findFirst.mockResolvedValue({ id: "c1", name: null, optIn: true, optedOutAt: null });
    db.conversation.findFirst.mockResolvedValue({ id: "cv1" });
    expect((await processDueReminders(now)).replied).toBe(1);
    expect(send.sendTemplateMessage).not.toHaveBeenCalled();
  });
  it("expires carts older than three days", async () => {
    db.abandonedCart.findMany.mockResolvedValue([{ ...cart, createdAt: new Date("2025-12-20T00:00:00Z") }]);
    expect((await processDueReminders(now)).expired).toBe(1);
    expect(send.sendTemplateMessage).not.toHaveBeenCalled();
  });
  it("defers when reminders are not configured", async () => {
    db.platformSetting.findUnique.mockResolvedValue(null);
    expect((await processDueReminders(now)).deferred).toBe(1);
    expect(send.sendTemplateMessage).not.toHaveBeenCalled();
  });
  it("hands the reminder back on a transient send failure", async () => {
    send.sendTemplateMessage.mockRejectedValue(new Error("boom"));
    expect((await processDueReminders(now)).failed).toBe(1);
    const giveBack = db.abandonedCart.updateMany.mock.calls[1][0];
    expect(giveBack.where.remindersSent).toBe(1);
    expect(giveBack.data.remindersSent).toBe(0);
  });
});

describe("commerce routes", () => {
  const call = (path: string, method: string, body?: unknown, origin: string | null = ORIGIN) =>
    new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const valid = { shopDomain: "Shop.myshopify.com", accessToken: "shpat_abcdefghij", webhookSecret: "whsec_12345678" };

  beforeEach(() => {
    db.shopifyStore.findFirst.mockResolvedValue(null);
    db.shopifyStore.create.mockImplementation(async ({ data }) => ({ id: "s1", status: "active", createdAt: new Date(), ...data }));
  });

  it("seals the webhook secret, scopes to the tenant, starts pending without a token and never returns or stores secrets", async () => {
    const res = await createStoreRoute(call("/api/commerce/stores", "POST", { shopDomain: valid.shopDomain, webhookSecret: valid.webhookSecret }));
    expect(res.status).toBe(201);
    const data = db.shopifyStore.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenantId: "t1", shopDomain: "shop.myshopify.com", status: "pending_verification", tokenEnc: "sealed:t1:", webhookSecretEnc: "sealed:t1:whsec_12345678" });
    expect(shopify.verify).not.toHaveBeenCalled();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("whsec_");
    expect(text).not.toContain("sealed:");
  });
  it("with an Admin API token it verifies against Shopify, activates, stores the token sealed and never returns it", async () => {
    db.shopifyStore.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "s1", shopDomain: "shop.myshopify.com", status: "active", webhookSecretEnc: "x", createdAt: new Date() });
    db.shopifyStore.updateMany.mockResolvedValue({ count: 1 });
    db.platformSetting.create.mockResolvedValue({});
    db.platformSetting.findUnique.mockResolvedValue({ value: { tenantId: "t1", storeId: "s1" } });
    const res = await createStoreRoute(call("/api/commerce/stores", "POST", valid));
    expect(res.status).toBe(201);
    expect(shopify.verify).toHaveBeenCalledWith("shop.myshopify.com", "shpat_abcdefghij", expect.anything());
    const data = db.shopifyStore.create.mock.calls[0][0].data;
    expect(data.tokenEnc).toBe("sealed:t1:shpat_abcdefghij");
    expect(JSON.stringify(await res.json())).not.toContain("shpat_");
  });
  it("creates nothing when Shopify does not confirm the shop", async () => {
    const { HttpError } = await import("@/lib/tenancy");
    shopify.verify.mockRejectedValueOnce(new HttpError(422, "Shopify rejected the access token for this store."));
    const res = await createStoreRoute(call("/api/commerce/stores", "POST", valid));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/rejected the access token/);
    expect(db.shopifyStore.create).not.toHaveBeenCalled();
  });
  it("validates the domain, blocks agents and cross-origin writes, and only ever looks at this workspace's own stores before proof", async () => {
    expect((await createStoreRoute(call("/api/commerce/stores", "POST", { ...valid, shopDomain: "evil.com" }))).status).toBe(400);
    expect((await createStoreRoute(call("/api/commerce/stores", "POST", valid, "https://evil.example"))).status).toBe(403);
    auth.role = "agent";
    expect((await createStoreRoute(call("/api/commerce/stores", "POST", valid))).status).toBe(403);
    auth.role = "admin";
    db.shopifyStore.findFirst.mockResolvedValue({ id: "s0" });
    expect((await createStoreRoute(call("/api/commerce/stores", "POST", valid))).status).toBe(409);
    expect(db.shopifyStore.findFirst.mock.calls[0][0].where).toEqual({ shopDomain: "shop.myshopify.com", tenantId: "t1" });
    expect(db.shopifyStore.create).not.toHaveBeenCalled();
  });
  it("POST /stores/[id]/verify: admin and same-origin only, token optional, 422 with a plain message when Shopify refuses, 404 for another workspace's store", async () => {
    const ctx = { params: Promise.resolve({ id: "s1" }) };
    const row = { id: "s1", shopDomain: "shop.myshopify.com", status: "pending_verification", tokenEnc: "sealed:t1:", webhookSecretEnc: "x", createdAt: new Date() };
    db.shopifyStore.findFirst.mockResolvedValue(row);
    expect((await verifyRoute(call("/api/commerce/stores/s1/verify", "POST", {}, "https://evil.example"), ctx)).status).toBe(403);
    auth.role = "agent";
    expect((await verifyRoute(call("/api/commerce/stores/s1/verify", "POST", {}), ctx)).status).toBe(403);
    auth.role = "admin";
    // nothing pasted and nothing saved
    const none = await verifyRoute(call("/api/commerce/stores/s1/verify", "POST"), ctx);
    expect(none.status).toBe(422);
    expect(shopify.verify).not.toHaveBeenCalled();
    // Shopify refuses
    const { HttpError } = await import("@/lib/tenancy");
    shopify.verify.mockRejectedValueOnce(new HttpError(422, "Shopify says this token belongs to a different store, so the domain does not match."));
    const refused = await verifyRoute(call("/api/commerce/stores/s1/verify", "POST", { accessToken: "shpat_abcdefghij" }), ctx);
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toMatch(/different store/);
    expect(db.shopifyStore.updateMany).not.toHaveBeenCalled();
    // success: the saved row is read with the tenant, the pasted token is saved sealed and the store becomes active
    shopify.verify.mockResolvedValue(undefined);
    db.platformSetting.create.mockResolvedValue({});
    db.platformSetting.findUnique.mockResolvedValue({ value: { tenantId: "t1", storeId: "s1" } });
    db.shopifyStore.updateMany.mockResolvedValue({ count: 1 });
    db.shopifyStore.findFirst.mockReset();
    db.shopifyStore.findFirst.mockResolvedValueOnce(row).mockResolvedValue({ ...row, status: "active" });
    const ok = await verifyRoute(call("/api/commerce/stores/s1/verify", "POST", { accessToken: "shpat_abcdefghij" }), ctx);
    expect(ok.status).toBe(200);
    expect(shopify.verify).toHaveBeenCalledWith("shop.myshopify.com", "shpat_abcdefghij", expect.anything());
    expect(db.shopifyStore.findFirst.mock.calls[0][0].where).toEqual({ id: "s1", tenantId: "t1" });
    expect(db.shopifyStore.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "s1", tenantId: "t1", status: "pending_verification" }, data: { tokenEnc: "sealed:t1:shpat_abcdefghij", status: "active" } });
    const text = JSON.stringify(await ok.json());
    expect(text).toContain("active");
    expect(text).not.toContain("shpat_");
    // another workspace's store
    db.shopifyStore.findFirst.mockReset();
    db.shopifyStore.findFirst.mockResolvedValue(null);
    expect((await verifyRoute(call("/api/commerce/stores/s9/verify", "POST", {}), { params: Promise.resolve({ id: "s9" }) })).status).toBe(404);
  });
  it("lists only the tenant's stores", async () => {
    db.shopifyStore.findMany.mockResolvedValue([]);
    await listStoresRoute(call("/api/commerce/stores", "GET"));
    expect(db.shopifyStore.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });
  it("validates settings: approved template, schedule shape, enabled needs both pickers", async () => {
    db.shopifyStore.findFirst.mockResolvedValue({ id: "s1", shopDomain: "a.myshopify.com", status: "active", webhookSecretEnc: "x", createdAt: new Date() });
    db.platformSetting.findUnique.mockResolvedValue(null);
    const ctx = { params: Promise.resolve({ id: "s1" }) };
    const put = (body: unknown) => putSettings(call("/api/commerce/stores/s1/settings", "PUT", body), ctx);

    expect((await put({ cartGapsMin: [1, 2] })).status).toBe(400);
    expect((await put({ enabled: true })).status).toBe(400);
    db.template.findFirst.mockResolvedValue({ status: "pending", components: [] });
    expect((await put({ templateId: "tp1" })).status).toBe(400);
    db.template.findFirst.mockResolvedValue({ status: "approved", components: [{ type: "BODY", text: "{{1}} {{2}} {{3}} {{4}}" }] });
    expect((await put({ templateId: "tp1" })).status).toBe(400);
    db.template.findFirst.mockResolvedValue({ status: "approved", components: [{ type: "BODY", text: "{{1}} {{2}} {{3}}" }] });
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1" });
    const ok = await put({ templateId: "tp1", phoneNumberId: "ph1", enabled: true, checkoutGapsMin: [10, 30, 600] });
    expect(ok.status).toBe(200);
    expect(db.template.findFirst.mock.calls.at(-1)![0].where).toMatchObject({ tenantId: "t1" });
    expect(db.platformSetting.upsert).toHaveBeenCalled();
  });
  it("refuses a template reminders cannot fill with a shop-worded reason, not a broadcast one", async () => {
    db.shopifyStore.findFirst.mockResolvedValue({ id: "s1", shopDomain: "a.myshopify.com", status: "active", webhookSecretEnc: "x", createdAt: new Date() });
    db.platformSetting.findUnique.mockResolvedValue(null);
    const put = (body: unknown) => putSettings(call("/api/commerce/stores/s1/settings", "PUT", body), { params: Promise.resolve({ id: "s1" }) });
    db.template.findFirst.mockResolvedValue({ status: "approved", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{1}}" }] });
    const res = await put({ templateId: "tp1" });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/cannot be a reminder/);
    expect(error).not.toMatch(/broadcast/i);
  });
  it("one approved template with named placeholders does not break the reminder options; it is listed as hidden with the reason", async () => {
    db.template.findMany.mockResolvedValue([
      { id: "a", name: "cart_named", language: "en", category: "MARKETING", components: [{ type: "BODY", text: "Hi {{first_name}}, your cart" }] },
      { id: "b", name: "cart_plain", language: "en", category: "MARKETING", components: [{ type: "BODY", text: "Hi {{1}}, total {{2}}" }] },
    ]);
    db.phoneNumber.findMany.mockResolvedValue([{ id: "ph1", displayPhone: "+91 98000 00001" }]);
    const res = await optionsRoute(call("/api/commerce/options", "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.templates).toEqual([{ id: "b", name: "cart_plain", language: "en", category: "MARKETING" }]);
    expect(body.hidden).toEqual([{ id: "a", name: "cart_named", language: "en", reason: expect.stringMatching(/named placeholders/) }]);
    expect(db.template.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", status: "approved" });
  });
  it("lists carts filtered by tenant and rejects unknown filters", async () => {
    db.abandonedCart.findMany.mockResolvedValue([]);
    expect((await cartsRoute(call("/api/commerce/carts?status=open&stage=cart", "GET"))).status).toBe(200);
    expect(db.abandonedCart.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", status: "open", stage: "cart" });
    expect((await cartsRoute(call("/api/commerce/carts?status=bogus", "GET"))).status).toBe(400);
  });
});

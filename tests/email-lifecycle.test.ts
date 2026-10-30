import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "x".repeat(40);
process.env.SITE_URL = "https://wa.edwyz.com";

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  membership: { findMany: vi.fn(), findUnique: vi.fn() },
  invite: { deleteMany: vi.fn(), create: vi.fn() },
  emailToken: { create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  job: { count: vi.fn() },
  subscription: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  phoneNumber: { findMany: vi.fn() },
  platformSetting: { create: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  paymentEvent: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  invoice: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  billingProfile: { findUnique: vi.fn() },
  auditLog: { create: vi.fn() },
}));
const mail = vi.hoisted(() => ({ queueEmail: vi.fn() }));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
const wind = vi.hoisted(() => ({ windDownTenant: vi.fn(), pauseAdsForBlockedTenants: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/email", () => ({ queueEmail: mail.queueEmail, EMAIL_QUEUE: "email", emailJobHandler: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/billing", () => ({ getBillingStatus: vi.fn(), assertWithinLimit: vi.fn(), assertTenantCanWrite: vi.fn(), syncPlanToRazorpay: vi.fn() }));
vi.mock("@/lib/tenant-lifecycle", () => wind);

import { POST as invitePost } from "@/app/api/workspace/invites/route";
import { POST as razorpayWebhook } from "@/app/api/webhooks/razorpay/route";
import { applyTenantAction } from "@/lib/admin/tenants";
import { sendVerificationEmail, processPasswordResetRequest } from "@/lib/email/flows";
import * as templates from "@/lib/email/templates";
import { runPaymentFailedNotices, runQualityAlerts, runTrialReminders, trialKind } from "@/lib/lifecycle/notices";

const DAY = 86_400_000;
const sent = () => mail.queueEmail.mock.calls.map((c) => c[0] as { to: string; subject: string; text: string; html: string });

let markers: Set<string>;
let state: Map<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  markers = new Set();
  state = new Map();
  db.platformSetting.create.mockImplementation(async ({ data }: { data: { key: string } }) => {
    if (markers.has(data.key)) throw Object.assign(new Error("dup"), { code: "P2002" });
    markers.add(data.key);
    return {};
  });
  db.platformSetting.deleteMany.mockImplementation(async ({ where }: { where: { key: string } }) => {
    markers.delete(where.key);
    return { count: 1 };
  });
  db.platformSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (state.has(where.key) ? { value: state.get(where.key) } : null));
  db.platformSetting.upsert.mockImplementation(async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => {
    state.set(where.key, create.value);
    return {};
  });
  db.membership.findMany.mockResolvedValue([{ user: { email: "owner@acme.test", name: "Olivia" } }]);
  db.emailToken.updateMany.mockResolvedValue({ count: 0 });
  db.emailToken.create.mockResolvedValue({});
  mail.queueEmail.mockResolvedValue(undefined);
});

describe("every template", () => {
  const all = [
    templates.verifyEmailTemplate({ name: "Asha", link: "https://wa.edwyz.com/verify-email?token=t" }),
    templates.passwordResetTemplate({ name: "Asha", link: "https://wa.edwyz.com/reset-password?token=t" }),
    templates.inviteTemplate({ workspaceName: "Acme", inviterName: "Ravi", role: "agent", link: "https://wa.edwyz.com/accept-invite?token=t" }),
    templates.trialEndingTemplate({ workspaceName: "Acme", daysLeft: 3 }),
    templates.trialEndingTemplate({ workspaceName: "Acme", daysLeft: 1 }),
    templates.trialEndedTemplate({ workspaceName: "Acme" }),
    templates.paymentFailedTemplate({ workspaceName: "Acme", graceDaysLeft: 2 }),
    templates.paymentReceivedTemplate({ workspaceName: "Acme", amountPaise: 59000, invoiceUrl: "https://wa.edwyz.com/app/billing/invoices/i1" }),
    templates.workspaceSuspendedTemplate({ workspaceName: "Acme" }),
    templates.numberQualityDroppedTemplate({ workspaceName: "Acme", displayPhone: "+91 98765 43210", from: "GREEN", to: "YELLOW" }),
    templates.passwordChangedTemplate({ name: "Asha" }),
    templates.usageAlertTemplate({ workspaceName: "Acme", label: "contacts", level: 80, used: 800, limit: 1000, monthly: false }),
  ];

  it("has a subject, a plain-text body and an html body with the company footer", () => {
    for (const t of all) {
      expect(t.subject.length).toBeGreaterThan(5);
      expect(t.text).toContain("--");
      expect(t.html.startsWith("<!doctype html>")).toBe(true);
      expect(t.html).toContain("Questions:");
    }
  });

  it("escapes anything a customer typed and never renders a non-http link", () => {
    const evil = templates.trialEndedTemplate({ workspaceName: '<script>alert("x")</script>' });
    expect(evil.html).not.toContain("<script>");
    expect(evil.html).toContain("&lt;script&gt;");
    const bad = templates.verifyEmailTemplate({ name: "A", link: "javascript:alert(1)" });
    expect(bad.html).not.toContain("javascript:");
    expect(bad.text).not.toContain("javascript:");
  });

  it("states the amount in rupees on the receipt and the grace days on the failure notice", () => {
    expect(all[7].text).toContain("INR 590.00");
    expect(all[6].text).toContain("2 more days");
    expect(templates.paymentFailedTemplate({ workspaceName: "Acme", graceDaysLeft: 0 }).text).not.toContain("more day");
  });
});

describe("verify and reset", () => {
  it("queues the confirmation mail with a one-time link when an account is created or a new link is asked for", async () => {
    await sendVerificationEmail({ id: "u1", email: "asha@acme.test", name: "Asha" });
    expect(sent()).toHaveLength(1);
    expect(sent()[0].to).toBe("asha@acme.test");
    expect(sent()[0].text).toMatch(/https:\/\/wa\.edwyz\.com\/verify-email\?token=[A-Za-z0-9_-]{20,}/);
    const row = db.emailToken.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ userId: "u1", kind: "verify" });
    expect(sent()[0].text).not.toContain(row.tokenHash);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(48 * 3600_000);
  });

  it("queues a reset link for a real account, and nothing for an unknown or disabled one", async () => {
    db.user.findUnique.mockResolvedValueOnce({ id: "u1", email: "asha@acme.test", name: "Asha", disabledAt: null });
    await processPasswordResetRequest("asha@acme.test");
    expect(sent()).toHaveLength(1);
    expect(sent()[0].subject).toMatch(/Reset/);
    expect(db.emailToken.create.mock.calls[0][0].data.kind).toBe("reset");

    mail.queueEmail.mockClear();
    db.user.findUnique.mockResolvedValueOnce(null);
    await processPasswordResetRequest("nobody@acme.test");
    db.user.findUnique.mockResolvedValueOnce({ id: "u2", email: "x@acme.test", name: "X", disabledAt: new Date() });
    await processPasswordResetRequest("x@acme.test");
    expect(sent()).toHaveLength(0);
  });
});

describe("invite", () => {
  it("queues the invite to the invited address as soon as it is created", async () => {
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    db.user.findUnique.mockImplementation(async ({ where }: { where: { email?: string; id?: string } }) => (where.id ? { name: "Ravi" } : null));
    db.tenant.findUnique.mockResolvedValue({ name: "Acme" });
    db.invite.create.mockResolvedValue({ id: "inv1", email: "new@acme.test", role: "agent", expiresAt: new Date() });
    const res = await invitePost(
      new Request("https://wa.edwyz.com/api/workspace/invites", {
        method: "POST",
        headers: { origin: "https://wa.edwyz.com", "content-type": "application/json" },
        body: JSON.stringify({ email: "new@acme.test", role: "agent" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: "new@acme.test" });
    expect(sent()[0].text).toContain("accept-invite?token=");
    expect(sent()[0].subject).toContain("Ravi invited you to Acme");
  });
});

describe("trial reminders at the right moment", () => {
  const now = Date.parse("2026-11-10T06:00:00Z");
  const trialEndingIn = (ms: number) => db.tenant.findMany.mockResolvedValue([{ id: "t1", name: "Acme", trialEndsAt: new Date(now + ms) }]);

  it("classifies the boundaries", () => {
    expect(trialKind(new Date(now + 4 * DAY), now)).toBeNull();
    expect(trialKind(new Date(now + 3 * DAY), now)).toBe("trial3");
    expect(trialKind(new Date(now + DAY + 1), now)).toBe("trial3");
    expect(trialKind(new Date(now + DAY), now)).toBe("trial1");
    expect(trialKind(new Date(now - 1), now)).toBe("trialEnded");
    expect(trialKind(new Date(now - 8 * DAY), now)).toBeNull();
  });

  it("sends the 3 day, 1 day and ended mails once each as one trial runs down", async () => {
    trialEndingIn(2.5 * DAY);
    const ends = now + 2.5 * DAY;
    expect(await runTrialReminders(now)).toBe(1);
    expect(await runTrialReminders(now + 3600_000)).toBe(0);
    expect(await runTrialReminders(now + 1.7 * DAY)).toBe(1);
    expect(await runTrialReminders(now + 1.8 * DAY)).toBe(0);
    expect(await runTrialReminders(ends + 1000)).toBe(1);
    expect(await runTrialReminders(ends + 2 * DAY)).toBe(0);
    expect(sent().map((m) => m.subject)).toEqual(["Your Edwyz WA trial ends in 3 days", "Your Edwyz WA trial ends in 1 day", "Your Edwyz WA trial has ended"]);
    expect(sent().every((m) => m.to === "owner@acme.test")).toBe(true);
  });

  it("keeps the mail for the mail: a failed queue gives the marker back and the next sweep sends it", async () => {
    trialEndingIn(2.5 * DAY);
    mail.queueEmail.mockRejectedValueOnce(new Error("queue down"));
    expect(await runTrialReminders(now)).toBe(0);
    expect(markers.size).toBe(0);
    expect(await runTrialReminders(now + 60_000)).toBe(1);
    expect(sent()).toHaveLength(2);
  });

  it("one workspace that cannot be mailed does not stop the others", async () => {
    db.tenant.findMany.mockResolvedValue([
      { id: "t1", name: "A", trialEndsAt: new Date(now + 2 * DAY) },
      { id: "t2", name: "B", trialEndsAt: new Date(now + 2 * DAY) },
    ]);
    db.membership.findMany.mockRejectedValueOnce(new Error("db blip"));
    expect(await runTrialReminders(now)).toBe(1);
  });

  it("an extended trial gets its reminders again for the new end date, and a pre-existing marker for the old date does not block it", async () => {
    trialEndingIn(2.5 * DAY);
    expect(await runTrialReminders(now)).toBe(1);
    expect(await runTrialReminders(now + 1000)).toBe(0);
    // An admin extends the trial by 10 days: the same workspace is in the 3 day window again, for a new end date.
    const later = now + 10 * DAY;
    db.tenant.findMany.mockResolvedValue([{ id: "t1", name: "Acme", trialEndsAt: new Date(later + 2 * DAY) }]);
    expect(await runTrialReminders(later)).toBe(1);
    // A marker from before the end date was part of the key counts only inside the current reminder window.
    state.set(`lifecycle:trial3:t9`, { at: new Date(now - 1000).toISOString() });
    db.tenant.findMany.mockResolvedValue([{ id: "t9", name: "Old", trialEndsAt: new Date(now + 2 * DAY) }]);
    expect(await runTrialReminders(now)).toBe(0);
    state.set(`lifecycle:trial3:t8`, { at: new Date(now - 20 * DAY).toISOString() });
    db.tenant.findMany.mockResolvedValue([{ id: "t8", name: "Extended", trialEndsAt: new Date(now + 2 * DAY) }]);
    expect(await runTrialReminders(now)).toBe(1);
  });

  it("walks every page, so workspaces after the first 100 are still reached", async () => {
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${String(from + i).padStart(4, "0")}`, name: "W", trialEndsAt: new Date(now + 2 * DAY) }));
    db.tenant.findMany.mockResolvedValueOnce(page(0, 100)).mockResolvedValueOnce(page(100, 3));
    expect(await runTrialReminders(now)).toBe(103);
    expect(db.tenant.findMany.mock.calls[1][0].where.id).toEqual({ gt: "t0099" });
  });

  it("the ended mail says the workspace is now read-only", async () => {
    trialEndingIn(-1000);
    await runTrialReminders(now);
    expect(sent()[0].text).toMatch(/read-only/);
  });

  it("only looks at workspaces that are not paying, comped, suspended or deleted", async () => {
    db.tenant.findMany.mockResolvedValue([]);
    await runTrialReminders(now);
    const where = db.tenant.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ deletedAt: null, status: "active", billingExempt: false });
    expect(where.OR).toEqual([{ subscription: null }, { subscription: { status: { in: ["canceled", "expired"] } } }]);
  });
});

describe("payment failed", () => {
  const sub = (event: string, status: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ event, payload: { subscription: { entity: { id: "sub_1", status, current_start: 1_800_000_000, current_end: 1_802_592_000, notes: { tenantId: "t1" } } }, ...extra } });
  const post = (body: string, eventId: string) =>
    razorpayWebhook(
      new Request("https://wa.edwyz.com/api/webhooks/razorpay", {
        method: "POST",
        headers: { "x-razorpay-signature": createHmac("sha256", "whsecret").update(body).digest("hex"), "x-razorpay-event-id": eventId },
        body,
      }),
    );

  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsecret";
    db.paymentEvent.create.mockResolvedValue({ id: "pe1" });
    db.paymentEvent.update.mockResolvedValue({});
    db.subscription.findUnique.mockResolvedValue({ id: "s1", tenantId: "t1", pastDueSince: null, currentPeriodEnd: null, currentPeriodStart: null, plan: { name: "Pro", currency: "INR" } });
    db.tenant.findUnique.mockResolvedValue({ name: "Acme" });
  });

  it("mails the owners the moment Razorpay reports a failed charge, and only once for the same failure", async () => {
    expect((await post(sub("subscription.pending", "pending"), "e1")).status).toBe(200);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].subject).toMatch(/payment/i);
    expect(sent()[0].text).toContain("3 more days");
    const since = db.subscription.update.mock.calls[0][0].data.pastDueSince as Date;

    db.subscription.findUnique.mockResolvedValue({ id: "s1", tenantId: "t1", pastDueSince: since, currentPeriodEnd: null, currentPeriodStart: null, plan: { name: "Pro", currency: "INR" } });
    expect((await post(sub("subscription.halted", "halted"), "e2")).status).toBe(200);
    expect(sent()).toHaveLength(1);

    db.subscription.findMany.mockResolvedValue([{ tenantId: "t1", pastDueSince: since, tenant: { name: "Acme" } }]);
    expect(await runPaymentFailedNotices(Date.now())).toBe(0);
    expect(sent()).toHaveLength(1);
  });

  it("sweep catches a failure the webhook missed, and a later failure mails again", async () => {
    const since = new Date(Date.now() - DAY);
    db.subscription.findMany.mockResolvedValue([{ tenantId: "t1", pastDueSince: since, tenant: { name: "Acme" } }]);
    expect(await runPaymentFailedNotices()).toBe(1);
    expect(await runPaymentFailedNotices()).toBe(0);
    db.subscription.findMany.mockResolvedValue([{ tenantId: "t1", pastDueSince: new Date(since.getTime() + 40 * DAY), tenant: { name: "Acme" } }]);
    expect(await runPaymentFailedNotices()).toBe(1);
    expect(sent()).toHaveLength(2);
  });

  it("does not mail for a payment that succeeded", async () => {
    const payment = { entity: { id: "pay_1", amount: 11800, currency: "INR", status: "captured" } };
    db.invoice.findUnique.mockResolvedValue(null);
    db.invoice.findFirst.mockResolvedValue(null);
    db.billingProfile.findUnique.mockResolvedValue(null);
    db.invoice.create.mockResolvedValue({ id: "inv1", totalPaise: 11800 });
    await post(sub("subscription.charged", "active", { payment }), "e3");
    expect(sent().map((m) => m.subject)).toEqual(["Payment received for Edwyz WA"]);
  });
});

describe("payment received", () => {
  const body = JSON.stringify({
    event: "subscription.charged",
    payload: {
      subscription: { entity: { id: "sub_1", status: "active", current_start: 1_800_000_000, current_end: 1_802_592_000, notes: { tenantId: "t1" } } },
      payment: { entity: { id: "pay_1", amount: 59000, currency: "INR", status: "captured" } },
    },
  });
  const post = (eventId: string) =>
    razorpayWebhook(
      new Request("https://wa.edwyz.com/api/webhooks/razorpay", {
        method: "POST",
        headers: { "x-razorpay-signature": createHmac("sha256", "whsecret").update(body).digest("hex"), "x-razorpay-event-id": eventId },
        body,
      }),
    );

  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsecret";
    db.paymentEvent.create.mockResolvedValue({ id: "pe1" });
    db.paymentEvent.update.mockResolvedValue({});
    db.subscription.findUnique.mockResolvedValue({ id: "s1", tenantId: "t1", pastDueSince: null, currentPeriodEnd: null, currentPeriodStart: null, plan: { name: "Pro", currency: "INR" } });
    db.tenant.findUnique.mockResolvedValue({ name: "Acme" });
    db.billingProfile.findUnique.mockResolvedValue({ billingEmail: "accounts@acme.test" });
    db.invoice.findFirst.mockResolvedValue(null);
  });

  it("sends the receipt with a link to the invoice to the billing email and the owner, once", async () => {
    db.invoice.findUnique.mockResolvedValue(null);
    db.invoice.create.mockResolvedValue({ id: "inv1", totalPaise: 59000 });
    expect((await post("e1")).status).toBe(200);
    expect(sent().map((m) => m.to).sort()).toEqual(["accounts@acme.test", "owner@acme.test"]);
    expect(sent()[0].text).toContain("https://wa.edwyz.com/app/billing/invoices/inv1");
    expect(sent()[0].text).toContain("INR 590.00");
  });

  it("sends nothing when the same payment arrives again in another event", async () => {
    db.invoice.findUnique.mockResolvedValue({ id: "inv1", totalPaise: 59000 });
    expect((await post("e2")).status).toBe(200);
    expect(db.invoice.create).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
  });

  it("a mail problem never fails the webhook", async () => {
    db.invoice.findUnique.mockResolvedValue(null);
    db.invoice.create.mockResolvedValue({ id: "inv1", totalPaise: 59000 });
    mail.queueEmail.mockRejectedValue(new Error("queue down"));
    expect((await post("e3")).status).toBe(200);
  });
});

describe("workspace suspended", () => {
  it("mails the owners when a platform admin suspends the workspace, without the internal reason", async () => {
    db.tenant.findUnique.mockResolvedValue({ id: "t1", name: "Acme", trialEndsAt: null, deletedAt: null });
    db.tenant.update.mockResolvedValue({});
    wind.windDownTenant.mockResolvedValue({ paused: 0, pauseFailed: 0, unreachable: 0, revoked: 0, revokeFailed: 0, deferred: 0 });
    await applyTenantAction("admin1", "t1", { action: "suspend", reason: "chargeback fraud suspicion", confirm: "Acme" });
    expect(sent()).toHaveLength(1);
    expect(sent()[0].subject).toBe("Your Edwyz WA workspace has been suspended");
    expect(sent()[0].text).not.toContain("chargeback");
  });

  it("does not mail for other admin actions", async () => {
    db.tenant.findUnique.mockResolvedValue({ id: "t1", name: "Acme", trialEndsAt: null, deletedAt: null });
    db.tenant.update.mockResolvedValue({});
    await applyTenantAction("admin1", "t1", { action: "unsuspend", reason: "resolved" });
    expect(sent()).toHaveLength(0);
  });
});

describe("number quality dropped", () => {
  const number = (rating: string) => ({ id: "p1", tenantId: "t1", displayPhone: "+91 98765 43210", qualityRating: rating });
  beforeEach(() => db.tenant.findMany.mockResolvedValue([{ id: "t1", name: "Acme" }]));

  it("mails on a fall, not on first sight, a rise or no change", async () => {
    db.phoneNumber.findMany.mockResolvedValue([number("GREEN")]);
    expect(await runQualityAlerts()).toBe(0);
    db.phoneNumber.findMany.mockResolvedValue([number("GREEN")]);
    expect(await runQualityAlerts()).toBe(0);
    db.phoneNumber.findMany.mockResolvedValue([number("YELLOW")]);
    expect(await runQualityAlerts()).toBe(1);
    db.phoneNumber.findMany.mockResolvedValue([number("GREEN")]);
    expect(await runQualityAlerts()).toBe(0);
    db.phoneNumber.findMany.mockResolvedValue([number("RED")]);
    expect(await runQualityAlerts()).toBe(1);
    expect(sent()).toHaveLength(2);
    expect(sent()[0].text).toContain("from GREEN to YELLOW");
    expect(sent()[1].text).toContain("from GREEN to RED");
  });
});

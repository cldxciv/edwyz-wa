import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SITE_URL = "https://wa.edwyz.com";

const db = vi.hoisted(() => ({
  tenant: { findMany: vi.fn(), findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  subscription: { findMany: vi.fn() },
  phoneNumber: { findMany: vi.fn() },
  platformSetting: { create: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
}));
const mail = vi.hoisted(() => ({ queueEmail: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/email", () => ({ queueEmail: mail.queueEmail }));
vi.mock("@/lib/platform-settings", () => ({ getSettings: async () => ({ graceDays: 3 }) }));

import { runPaymentFailedNotices, runQualityAlerts, runTrialReminders, sendPaymentFailedNotice } from "@/lib/lifecycle/notices";

const DAY = 86_400_000;
const now = Date.parse("2026-11-10T06:00:00Z");
let markers: Set<string>;
let state: Map<string, unknown>;
const sent = () => mail.queueEmail.mock.calls.map((c) => c[0] as { to: string; subject: string });

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
  mail.queueEmail.mockResolvedValue(undefined);
});

describe("a lifecycle notice is not lost when it cannot be queued", () => {
  const trialEndingIn = (ms: number) => db.tenant.findMany.mockResolvedValue([{ id: "t1", name: "Acme", trialEndsAt: new Date(now + ms) }]);

  it("asks the queue to refuse loudly, so a failure is seen", async () => {
    trialEndingIn(2 * DAY);
    await runTrialReminders(now);
    expect(mail.queueEmail.mock.calls[0][1]).toEqual({ strict: true });
  });

  it("trial mail: a queue failure gives the marker back and the next sweep sends it exactly once", async () => {
    trialEndingIn(2 * DAY);
    mail.queueEmail.mockRejectedValueOnce(new Error("queue down"));
    expect(await runTrialReminders(now)).toBe(0);
    expect(markers.size).toBe(0);
    expect(await runTrialReminders(now + 60_000)).toBe(1);
    expect(await runTrialReminders(now + 120_000)).toBe(0);
    expect(sent()).toHaveLength(2); // the failed attempt and the one that worked
  });

  it("trial mail: a workspace with no owner who can receive mail keeps its notice for when one exists", async () => {
    trialEndingIn(0.5 * DAY);
    db.membership.findMany.mockResolvedValue([]);
    expect(await runTrialReminders(now)).toBe(0);
    expect(markers.size).toBe(0);
    db.membership.findMany.mockResolvedValue([{ user: { email: "new-owner@acme.test", name: "Neel" } }]);
    expect(await runTrialReminders(now + 3_600_000)).toBe(1);
    expect(sent().map((m) => m.to)).toEqual(["new-owner@acme.test"]);
  });

  it("a failure for one workspace does not stop the sweep for the others", async () => {
    db.tenant.findMany.mockResolvedValue([
      { id: "t1", name: "A", trialEndsAt: new Date(now + 2 * DAY) },
      { id: "t2", name: "B", trialEndsAt: new Date(now + 2 * DAY) },
    ]);
    mail.queueEmail.mockRejectedValueOnce(new Error("queue down"));
    expect(await runTrialReminders(now)).toBe(1);
    const held = [...markers];
    expect(held.some((k) => k.startsWith("lifecycle:trial3:t2:"))).toBe(true);
    expect(held.some((k) => k.startsWith("lifecycle:trial3:t1:"))).toBe(false);
  });
});

describe("payment failed mail", () => {
  const since = new Date(now - DAY);
  const input = { tenantId: "t1", workspaceName: "Acme", pastDueSince: since, graceDays: 3 };

  it("is retried by the sweep after a queue failure", async () => {
    db.tenant.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
    mail.queueEmail.mockRejectedValueOnce(new Error("queue down"));
    expect(await sendPaymentFailedNotice(input, now)).toBe(0);
    db.subscription.findMany.mockResolvedValue([{ tenantId: "t1", pastDueSince: since, tenant: { name: "Acme" } }]);
    expect(await runPaymentFailedNotices(now)).toBe(1);
    expect(await runPaymentFailedNotices(now)).toBe(0);
  });

  it("is not sent for a suspended or deleted workspace", async () => {
    db.tenant.findUnique.mockResolvedValue({ status: "suspended", deletedAt: null });
    expect(await sendPaymentFailedNotice(input, now)).toBe(0);
    db.tenant.findUnique.mockResolvedValue({ status: "active", deletedAt: new Date() });
    expect(await sendPaymentFailedNotice(input, now)).toBe(0);
    expect(mail.queueEmail).not.toHaveBeenCalled();
    expect(markers.size).toBe(0);
  });
});

describe("quality dropped mail", () => {
  const number = (rating: string) => ({ id: "p1", tenantId: "t1", displayPhone: "+91 98765 43210", qualityRating: rating });
  beforeEach(() => db.tenant.findMany.mockResolvedValue([{ id: "t1", name: "Acme" }]));

  it("remembers the new rating only after the owners were mailed, so a failed mail is tried again", async () => {
    db.phoneNumber.findMany.mockResolvedValue([number("GREEN")]);
    await runQualityAlerts();
    db.phoneNumber.findMany.mockResolvedValue([number("RED")]);
    mail.queueEmail.mockRejectedValueOnce(new Error("queue down"));
    expect(await runQualityAlerts()).toBe(0);
    expect(state.get("lifecycle:quality:p1")).toEqual({ rating: "GREEN" });
    expect(await runQualityAlerts()).toBe(1);
    expect(state.get("lifecycle:quality:p1")).toEqual({ rating: "RED" });
    expect(await runQualityAlerts()).toBe(0);
  });

  it("an ownerless workspace is retried too", async () => {
    db.phoneNumber.findMany.mockResolvedValue([number("GREEN")]);
    await runQualityAlerts();
    db.phoneNumber.findMany.mockResolvedValue([number("YELLOW")]);
    db.membership.findMany.mockResolvedValue([]);
    expect(await runQualityAlerts()).toBe(0);
    expect(state.get("lifecycle:quality:p1")).toEqual({ rating: "GREEN" });
  });

  it("only considers active, undeleted workspaces", async () => {
    db.phoneNumber.findMany.mockResolvedValue([number("GREEN")]);
    db.tenant.findMany.mockResolvedValue([]);
    await runQualityAlerts();
    expect(db.tenant.findMany.mock.calls[0][0].where).toMatchObject({ deletedAt: null, status: "active" });
    expect(state.size).toBe(0);
  });
});

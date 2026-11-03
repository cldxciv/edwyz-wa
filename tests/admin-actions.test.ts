import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
  plan: { findUnique: vi.fn(), create: vi.fn(async ({ data }: { data: object }) => ({ id: "np", ...data })), update: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) },
  subscription: { findUnique: vi.fn(), upsert: vi.fn(async () => ({})) },
  user: { findUnique: vi.fn(), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
  session: { updateMany: vi.fn(async () => ({ count: 2 })) },
  emailToken: { create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
  platformSetting: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
  // Meta's spending limit rows the suspend and delete forms offboard (docs/SPEND-CONTROLS-SPEC.md 5.8).
  metaSpendLimit: { findMany: vi.fn(async (): Promise<{ adAccountAssetId: string }[]> => []) },
  spendCeiling: { findMany: vi.fn(async () => []) },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
const offboard = vi.hoisted(() => ({ offboardTenant: vi.fn(async (_t: string, _trigger: string, io: { choices?: Record<string, string> }) => Object.entries(io.choices ?? {}).map(([adAccountAssetId, choice]) => ({ adAccountAssetId, choice, applied: "kept" }))) }));
vi.mock("@/lib/spend/metacap/offboard", () => offboard);
const spendActions = vi.hoisted(() => ({ isTenantSpendAction: vi.fn((a: unknown) => a === "lift_probation"), applySpendAction: vi.fn(async () => ({ ok: true, text: "done", changed: true })) }));
vi.mock("@/lib/admin/spending", () => spendActions);
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/auth/audit", () => ({ audit: auditMock }));
const sync = vi.hoisted(() => vi.fn(async () => ({ razorpayPlanId: "plan_x" })));
vi.mock("@/lib/billing", () => ({ getBillingStatus: vi.fn(), syncPlanToRazorpay: sync }));
// windDown delegates to tenant-lifecycle (pause ads first, then only the connections nothing needs; covered in tenant-lifecycle-admin.test.ts).
const wind = vi.hoisted(() => ({ windDownTenant: vi.fn(async () => ({ paused: 2, pauseFailed: 0, unreachable: 0, revoked: 1, revokeFailed: 0, deferred: 0 })) }));
vi.mock("@/lib/tenant-lifecycle", () => wind);
const mail = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", () => ({ queueEmail: mail }));

import { applyPlanAction, assertPriceEditable, parsePlanInput, rupeesToPaise, updatePlan } from "@/lib/admin/plans";
import { parseSettings, percentToBps } from "@/lib/admin/settings";
import { applyTenantAction } from "@/lib/admin/tenants";
import { applyUserAction } from "@/lib/admin/users";
import { confirmEnrollment, resetAttemptLimiter, startEnrollment, verifyStepUpCode } from "@/lib/admin/security";
import { base32Decode, hashRecoveryCode, hotp, stepAt } from "@/lib/admin/totp";
import { decrypt } from "@/lib/crypto/tokens";

const actions = () => auditMock.mock.calls.map((c) => (c as unknown as [{ action: string }])[0].action);

beforeEach(() => {
  vi.clearAllMocks();
  resetAttemptLimiter();
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SITE_URL = "https://wa.edwyz.com";
  db.tenant.findUnique.mockResolvedValue({ id: "t1", name: "Acme", trialEndsAt: null, deletedAt: null });
  db.platformSetting.findUnique.mockResolvedValue(null);
  db.metaSpendLimit.findMany.mockResolvedValue([]);
});

describe("tenant actions", () => {
  it("suspend needs the typed name, then sets status and reason and audits", async () => {
    await expect(applyTenantAction("admin", "t1", { action: "suspend", reason: "abuse" })).rejects.toMatchObject({ status: 400 });
    await expect(applyTenantAction("admin", "t1", { action: "suspend", reason: "abuse", confirm: "acme" })).rejects.toMatchObject({ status: 400 });
    expect(db.tenant.update).not.toHaveBeenCalled();
    await applyTenantAction("admin", "t1", { action: "suspend", reason: "abuse", confirm: "Acme" });
    expect(db.tenant.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { status: "suspended", suspendedReason: "abuse" } });
    expect(actions()).toEqual(["admin.tenant.suspend"]);
  });
  it("suspend winds the workspace down (ads first, then connections) after the status change and records the counts", async () => {
    await applyTenantAction("admin", "t1", { action: "suspend", reason: "abuse", confirm: "Acme" });
    expect(wind.windDownTenant).toHaveBeenCalledWith("t1", "admin", { revoke: true });
    expect(db.tenant.update.mock.invocationCallOrder[0]).toBeLessThan(wind.windDownTenant.mock.invocationCallOrder[0]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.tenant.suspend", meta: expect.objectContaining({ adsPaused: 2, connectionsRevoked: 1 }) }));
  });
  it("unsuspend and restore do not touch ads or connections", async () => {
    await applyTenantAction("admin", "t1", { action: "unsuspend", reason: "resolved" });
    await applyTenantAction("admin", "t1", { action: "restore", reason: "mistake" });
    expect(wind.windDownTenant).not.toHaveBeenCalled();
  });
  it("unsuspend clears the reason", async () => {
    await applyTenantAction("admin", "t1", { action: "unsuspend", reason: "resolved" });
    expect(db.tenant.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { status: "active", suspendedReason: null } });
  });
  it("every action needs a reason", async () => {
    await expect(applyTenantAction("admin", "t1", { action: "unsuspend" })).rejects.toMatchObject({ status: 400 });
  });
  it("extend trial adds days from the later of now and the current end", async () => {
    const future = new Date(Date.now() + 10 * 86_400_000);
    db.tenant.findUnique.mockResolvedValue({ id: "t1", name: "Acme", trialEndsAt: future, deletedAt: null });
    await applyTenantAction("admin", "t1", { action: "extend_trial", days: "5", reason: "sales call" });
    const data = (db.tenant.update.mock.calls[0] as unknown as [{ data: { trialEndsAt: Date } }])[0].data;
    expect(Math.round((data.trialEndsAt.getTime() - future.getTime()) / 86_400_000)).toBe(5);
    await expect(applyTenantAction("admin", "t1", { action: "extend_trial", days: "0", reason: "x" })).rejects.toMatchObject({ status: 400 });
  });
  it("comp sets billingExempt and records the reason", async () => {
    await applyTenantAction("admin", "t1", { action: "comp", exempt: true, reason: "partner" });
    expect(db.tenant.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { billingExempt: true } });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.tenant.comp", meta: expect.objectContaining({ reason: "partner", exempt: true }) }));
  });
  it("change plan upserts an active manual subscription", async () => {
    db.plan.findUnique.mockResolvedValue({ id: "p1", code: "pro" });
    db.subscription.findUnique.mockResolvedValue(null);
    await applyTenantAction("admin", "t1", { action: "change_plan", planId: "p1", months: 3, reason: "deal" });
    const arg = (db.subscription.upsert.mock.calls[0] as unknown as [{ create: Record<string, unknown> }])[0];
    expect(arg.create).toMatchObject({ tenantId: "t1", planId: "p1", status: "active", razorpaySubscriptionId: null });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ manual: true, plan: "pro" }) }));
  });
  it("change plan refuses to replace a live Razorpay subscription", async () => {
    db.plan.findUnique.mockResolvedValue({ id: "p1", code: "pro" });
    db.subscription.findUnique.mockResolvedValue({ razorpaySubscriptionId: "sub_1", status: "active" });
    await expect(applyTenantAction("admin", "t1", { action: "change_plan", planId: "p1", months: 1, reason: "x" })).rejects.toMatchObject({ status: 409 });
  });
  it("suspend applies the Meta-limit choice (default keep) to every managed ad account, after the status change and before the connections go", async () => {
    db.metaSpendLimit.findMany.mockResolvedValue([{ adAccountAssetId: "acc1" }, { adAccountAssetId: "acc2" }]);
    await applyTenantAction("admin", "t1", { action: "suspend", reason: "abuse", confirm: "Acme" });
    expect(offboard.offboardTenant).toHaveBeenCalledWith("t1", "suspend", { actor: { type: "platform_admin", userId: "admin" }, choices: { acc1: "keep", acc2: "keep" } });
    expect(db.metaSpendLimit.findMany).toHaveBeenCalledWith({ where: { tenantId: "t1", mode: { notIn: ["off", "withdrawn"] } }, select: { adAccountAssetId: true } });
    const order = [db.tenant.update.mock.invocationCallOrder[0], offboard.offboardTenant.mock.invocationCallOrder[0], wind.windDownTenant.mock.invocationCallOrder[0]];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.tenant.suspend", meta: expect.objectContaining({ metaLimitChoice: "keep", metaLimitAccounts: 2 }) }));
  });
  it("soft delete passes the admin's choice; an unknown choice is refused before anything changes", async () => {
    db.metaSpendLimit.findMany.mockResolvedValue([{ adAccountAssetId: "acc1" }]);
    await expect(applyTenantAction("admin", "t1", { action: "soft_delete", reason: "closed", confirm: "Acme", metaLimitChoice: "explode" })).rejects.toMatchObject({ status: 400 });
    expect(db.tenant.update).not.toHaveBeenCalled();
    await applyTenantAction("admin", "t1", { action: "soft_delete", reason: "closed", confirm: "Acme", metaLimitChoice: "remove" });
    expect(offboard.offboardTenant).toHaveBeenCalledWith("t1", "soft_delete", expect.objectContaining({ choices: { acc1: "remove" } }));
  });
  it("a workspace where Edwyz manages no Meta limit is suspended without any offboarding, and a failing offboard never blocks the suspend", async () => {
    await applyTenantAction("admin", "t1", { action: "suspend", reason: "abuse", confirm: "Acme" });
    expect(offboard.offboardTenant).not.toHaveBeenCalled();
    db.metaSpendLimit.findMany.mockResolvedValue([{ adAccountAssetId: "acc1" }]);
    offboard.offboardTenant.mockRejectedValueOnce(new Error("meta down"));
    await expect(applyTenantAction("admin", "t1", { action: "suspend", reason: "abuse", confirm: "Acme" })).resolves.toMatchObject({ ok: true });
    expect(wind.windDownTenant).toHaveBeenCalledTimes(2);
  });
  it("the spending actions of 8.3 go to the spending module; anything else unknown is refused", async () => {
    await expect(applyTenantAction("admin", "t1", { action: "lift_probation", reason: "known customer" })).resolves.toMatchObject({ ok: true, text: "done" });
    expect(spendActions.applySpendAction).toHaveBeenCalledWith("admin", "t1", { action: "lift_probation", reason: "known customer" });
    await expect(applyTenantAction("admin", "t1", { action: "bogus", reason: "x" })).rejects.toMatchObject({ status: 400 });
  });
  it("soft delete suspends, sets deletedAt and needs the name; restore reverses", async () => {
    await expect(applyTenantAction("admin", "t1", { action: "soft_delete", reason: "x" })).rejects.toMatchObject({ status: 400 });
    await applyTenantAction("admin", "t1", { action: "soft_delete", reason: "closed", confirm: "Acme" });
    expect(db.tenant.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: expect.objectContaining({ status: "suspended", deletedAt: expect.any(Date) }) });
    expect(wind.windDownTenant).toHaveBeenCalledWith("t1", "admin", { revoke: true });
    await applyTenantAction("admin", "t1", { action: "restore", reason: "mistake" });
    expect(db.tenant.update).toHaveBeenLastCalledWith({ where: { id: "t1" }, data: { deletedAt: null, status: "active", suspendedReason: null } });
  });
});

describe("user actions", () => {
  beforeEach(() => db.user.findUnique.mockResolvedValue({ id: "u9", email: "a@b.com", name: "Ann", emailVerifiedAt: null }));
  it("disable needs the typed email and revokes sessions", async () => {
    await expect(applyUserAction("admin", "u9", { action: "disable", reason: "x", confirm: "nope" })).rejects.toMatchObject({ status: 400 });
    await applyUserAction("admin", "u9", { action: "disable", reason: "x", confirm: "a@b.com" });
    expect(db.session.updateMany).toHaveBeenCalledWith({ where: { userId: "u9", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(actions()).toContain("admin.user.disable");
  });
  it("cannot disable yourself", async () => {
    await expect(applyUserAction("u9", "u9", { action: "disable", reason: "x", confirm: "a@b.com" })).rejects.toMatchObject({ status: 400 });
  });
  it("reset link stores only a hash and expires in an hour", async () => {
    const res = (await applyUserAction("admin", "u9", { action: "reset_link", reason: "locked out" })) as { link: string };
    const token = new URL(res.link).searchParams.get("token")!;
    const data = (db.emailToken.create.mock.calls[0] as unknown as [{ data: { tokenHash: string; kind: string; expiresAt: Date } }])[0].data;
    expect(data.kind).toBe("reset");
    expect(data.tokenHash).not.toContain(token);
    expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain(token);
  });
  it("resend verification uses the user's own flow: earlier links stop working and the link is sealed in the queue", async () => {
    process.env.SMTP_USER = "mailer";
    try {
      await applyUserAction("admin", "u9", { action: "resend_verification", reason: "x" });
    } finally {
      delete process.env.SMTP_USER;
    }
    expect(mail).toHaveBeenCalledOnce();
    expect((mail.mock.calls[0] as unknown[])[1]).toEqual({ seal: true });
    expect(db.emailToken.updateMany).toHaveBeenCalledWith({ where: { userId: "u9", kind: "verify", usedAt: null }, data: { usedAt: expect.any(Date) } });
    expect(actions()).toContain("admin.user.resend_verification");
  });
  it("resend verification answers 503 when email is not set up, instead of reporting a mail that is never sent", async () => {
    delete process.env.SMTP_USER;
    await expect(applyUserAction("admin", "u9", { action: "resend_verification", reason: "x" })).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Mark email as verified") });
    expect(mail).not.toHaveBeenCalled();
    expect(db.emailToken.create).not.toHaveBeenCalled();
    expect(actions()).not.toContain("admin.user.resend_verification");
  });
  it("mark verified is audited", async () => {
    await applyUserAction("admin", "u9", { action: "mark_verified", reason: "phone check" });
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: "u9" }, data: { emailVerifiedAt: expect.any(Date) } });
    expect(actions()).toContain("admin.user.mark_verified");
  });
});

describe("plans", () => {
  const body = { code: "pro", name: "Pro", priceRupees: "999.5", intervalMonths: "1", features: "{\"api\":true}" };
  it("converts rupees to paise exactly", () => {
    expect(rupeesToPaise("999")).toBe(99900);
    expect(rupeesToPaise("999.5")).toBe(99950);
    expect(rupeesToPaise("0.07")).toBe(7);
    expect(() => rupeesToPaise("-1")).toThrow();
    expect(() => rupeesToPaise("1.234")).toThrow();
    expect(parsePlanInput(body).pricePaise).toBe(99950);
  });
  it("price and interval are immutable once published to Razorpay", () => {
    const existing = { razorpayPlanId: "plan_1", pricePaise: 99950, intervalMonths: 1 };
    expect(() => assertPriceEditable(existing, { pricePaise: 100000, intervalMonths: 1 })).toThrow(/cannot change/);
    expect(() => assertPriceEditable(existing, { pricePaise: 99950, intervalMonths: 3 })).toThrow();
    expect(() => assertPriceEditable(existing, { pricePaise: 99950, intervalMonths: 1 })).not.toThrow();
    expect(() => assertPriceEditable({ ...existing, razorpayPlanId: null }, { pricePaise: 1, intervalMonths: 1 })).not.toThrow();
  });
  it("updatePlan refuses a price change on a published plan", async () => {
    db.plan.findUnique.mockResolvedValue({ id: "p", code: "pro", razorpayPlanId: "plan_1", pricePaise: 50000, intervalMonths: 1 });
    await expect(updatePlan("admin", "p", body)).rejects.toMatchObject({ status: 409 });
    expect(db.plan.update).not.toHaveBeenCalled();
  });
  it("delete is refused when subscriptions exist, archive keeps the plan, publish calls Razorpay sync", async () => {
    db.plan.findUnique.mockResolvedValue({ id: "p", code: "pro", name: "Pro", pricePaise: 1, intervalMonths: 1, features: {}, _count: { subscriptions: 2 } });
    await expect(applyPlanAction("admin", "p", { action: "delete", confirm: "pro" })).rejects.toMatchObject({ status: 409 });
    await applyPlanAction("admin", "p", { action: "archive" });
    expect(db.plan.update).toHaveBeenCalledWith({ where: { id: "p" }, data: { active: false } });
    await expect(applyPlanAction("admin", "p", { action: "publish" })).resolves.toMatchObject({ razorpayPlanId: "plan_x" });
    expect(sync).toHaveBeenCalledWith("p");
  });
  it("delete needs the typed code when there are no subscriptions", async () => {
    db.plan.findUnique.mockResolvedValue({ id: "p", code: "pro", _count: { subscriptions: 0 } });
    await expect(applyPlanAction("admin", "p", { action: "delete", confirm: "x" })).rejects.toMatchObject({ status: 400 });
    await applyPlanAction("admin", "p", { action: "delete", confirm: "pro" });
    expect(db.plan.delete).toHaveBeenCalled();
  });
});

describe("settings validation", () => {
  const ok = { trialDays: "7", graceDays: "3", gstRatePercent: "18", invoicePrefix: "edw", sellerLegalName: "X Pvt Ltd", sellerGstin: "", sellerAddress: "Addr", sellerStateCode: "", supportEmail: "a@b.com" };
  it("converts percent to basis points", () => {
    expect(percentToBps("18")).toBe(1800);
    expect(percentToBps("12.5")).toBe(1250);
    expect(() => percentToBps("41")).toThrow();
    expect(() => percentToBps("abc")).toThrow();
  });
  it("validates GSTIN format and allows empty", () => {
    expect(parseSettings(ok)).toMatchObject({ gstRateBps: 1800, invoicePrefix: "EDW", sellerGstin: "" });
    expect(parseSettings({ ...ok, sellerGstin: "22aaaaa0000a1z5", sellerStateCode: "22" }).sellerGstin).toBe("22AAAAA0000A1Z5");
    expect(() => parseSettings({ ...ok, sellerGstin: "BADGSTIN" })).toThrow();
    expect(() => parseSettings({ ...ok, supportEmail: "nope" })).toThrow();
  });
});

describe("TOTP step-up flow", () => {
  async function enrolled() {
    db.user.findUnique.mockResolvedValue({ totpEnabledAt: null });
    const { secret } = await startEnrollment("u1", "boss@x.com");
    const stored = (db.user.update.mock.calls[0] as unknown as [{ data: { totpCiphertext: string; totpIv: string; totpTag: string } }])[0].data;
    expect(stored.totpCiphertext).not.toContain(secret);
    expect(decrypt({ ciphertext: stored.totpCiphertext, iv: stored.totpIv, authTag: stored.totpTag })).toBe(secret);
    db.user.findUnique.mockResolvedValue({ totpEnabledAt: null, totpCiphertext: stored.totpCiphertext, totpIv: stored.totpIv, totpTag: stored.totpTag, totpRecoveryHashes: [] });
    return secret;
  }

  it("enrols, rejects a wrong code, stores recovery hashes only, and audits", async () => {
    const secret = await enrolled();
    const now = 1_700_000_000_000;
    await expect(confirmEnrollment("u1", "000000", now)).rejects.toMatchObject({ status: 400 });
    const code = hotp(base32Decode(secret), stepAt(now));
    const { recoveryCodes } = await confirmEnrollment("u1", code, now);
    expect(recoveryCodes).toHaveLength(8);
    const last = db.user.update.mock.calls.at(-1) as unknown as [{ data: { totpEnabledAt: Date; totpRecoveryHashes: string[] } }];
    expect(last[0].data.totpRecoveryHashes).toEqual(recoveryCodes.map(hashRecoveryCode));
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain(recoveryCodes[0]);
    expect(actions()).toEqual(expect.arrayContaining(["admin.totp.enroll_failed", "admin.totp.enrolled"]));
  });

  it("rejects step reuse and logs failures", async () => {
    const secret = await enrolled();
    const now = 1_700_000_000_000;
    const code = hotp(base32Decode(secret), stepAt(now));
    await verifyStepUpCode("u1", { code }, now);
    db.platformSetting.findUnique.mockResolvedValue({ value: { step: stepAt(now) } } as never);
    await expect(verifyStepUpCode("u1", { code }, now)).rejects.toMatchObject({ status: 400 });
    expect(actions()).toEqual(expect.arrayContaining(["admin.stepup.ok", "admin.stepup.failed"]));
  });

  it("recovery codes work once", async () => {
    const code = "abcde-fghjk";
    const hashes = [hashRecoveryCode(code)];
    db.user.findUnique.mockResolvedValue({ totpRecoveryHashes: hashes });
    await verifyStepUpCode("u1", { recoveryCode: code });
    expect(db.user.updateMany).toHaveBeenCalledWith({ where: { id: "u1", totpRecoveryHashes: { equals: hashes } }, data: { totpRecoveryHashes: [] } });
    db.user.findUnique.mockResolvedValue({ totpRecoveryHashes: [] });
    await expect(verifyStepUpCode("u1", { recoveryCode: code })).rejects.toMatchObject({ status: 400 });
    db.user.findUnique.mockResolvedValue({ totpRecoveryHashes: hashes });
    db.user.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(verifyStepUpCode("u1", { recoveryCode: code })).rejects.toMatchObject({ status: 400 });
  });

  it("rate limits attempts per user", async () => {
    db.user.findUnique.mockResolvedValue({ totpCiphertext: null });
    for (let i = 0; i < 5; i++) await expect(verifyStepUpCode("u2", { code: "123456" })).rejects.toMatchObject({ status: 400 });
    await expect(verifyStepUpCode("u2", { code: "123456" })).rejects.toMatchObject({ status: 429 });
  });
});

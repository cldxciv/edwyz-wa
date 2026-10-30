import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "x".repeat(40);
process.env.EMAIL_VERIFICATION_REQUIRED = "false";

const db = vi.hoisted(() => ({
  membership: { findUnique: vi.fn() },
  tenant: { findUnique: vi.fn(), updateMany: vi.fn() },
  platformSetting: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

import { getActor } from "@/lib/auth";
import { signAccessToken } from "@/lib/auth/tokens";
import { assertTenantCanWrite, startTrial } from "@/lib/billing";
import { run, resetCompatLimits } from "@/lib/compat/runtime";
import { generateApiKey } from "@/lib/integrations/apikeys";

const DAY = 86_400_000;
const token = signAccessToken({ sub: "u1", tid: "t1", role: "owner" });
const KEY = generateApiKey();

type TenantRow = {
  status: "active" | "suspended";
  suspendedReason: string | null;
  billingExempt: boolean;
  trialEndsAt: Date | null;
  subscription: { status: string; currentPeriodEnd: Date | null; pastDueSince: Date | null; planId: string; plan: { name: string } } | null;
};
let tenant: TenantRow;
const trialEndingIn = (ms: number): TenantRow => ({ status: "active", suspendedReason: null, billingExempt: false, trialEndsAt: new Date(Date.now() + ms), subscription: null });

const req = (method: string, path = "/api/contacts") => new Request(`https://wa.test${path}`, { method, headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  vi.clearAllMocks();
  resetCompatLimits();
  tenant = trialEndingIn(3 * DAY);
  db.membership.findUnique.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner", user: { disabledAt: null, emailVerifiedAt: new Date() }, tenant: { deletedAt: null, status: "active" }, createdAt: new Date(0) });
  db.tenant.findUnique.mockImplementation(async () => tenant);
  db.platformSetting.findUnique.mockResolvedValue(null);
});

describe("starting a trial", () => {
  it("sets the end date from the platform trial length, once", async () => {
    db.platformSetting.findUnique.mockResolvedValue({ value: { trialDays: 14 } });
    const before = Date.now();
    await startTrial("t1");
    const call = db.tenant.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "t1", trialEndsAt: null });
    const days = (call.data.trialEndsAt.getTime() - before) / DAY;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThan(14.01);
  });

  it("uses the default length of 7 days when the setting is not saved", async () => {
    const before = Date.now();
    await startTrial("t1");
    expect(Math.round((db.tenant.updateMany.mock.calls[0][0].data.trialEndsAt.getTime() - before) / DAY)).toBe(7);
  });
});

describe("getActor during the trial", () => {
  it("lets every method through while the trial is running", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) await expect(getActor(req(method))).resolves.toMatchObject({ tenantId: "t1", role: "owner" });
  });

  it("still lets writes through in the last minute", async () => {
    tenant = trialEndingIn(60_000);
    await expect(getActor(req("POST"))).resolves.toBeTruthy();
  });
});

describe("getActor after the trial has ended (read-only lock)", () => {
  beforeEach(() => {
    tenant = trialEndingIn(-1000);
  });

  it("keeps every read working so people can still see their data", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) await expect(getActor(req(method, "/api/inbox/conversations"))).resolves.toMatchObject({ tenantId: "t1" });
  });

  it("refuses every write with 402 and a plain message that points to billing", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const error = await getActor(req(method, "/api/contacts")).catch((e) => e);
      expect(error, method).toMatchObject({ status: 402 });
      expect(error.message).toMatch(/free trial has ended/i);
      expect(error.message).toMatch(/read-only/);
      expect(error.message).toContain("/app/billing");
    }
  });

  it("covers the team and settings routes too, not only the inbox", async () => {
    for (const path of ["/api/workspace/members/u2", "/api/workspace/ownership", "/api/workspace/invites", "/api/broadcasts", "/api/templates"]) {
      await expect(getActor(req("POST", path)), path).rejects.toMatchObject({ status: 402 });
    }
  });

  it("keeps sign-in, sign-out, workspace switching and paying usable", async () => {
    for (const path of ["/api/auth/logout", "/api/auth/switch-workspace", "/api/billing/subscribe", "/api/billing/profile"]) {
      await expect(getActor(req("POST", path)), path).resolves.toBeTruthy();
    }
  });

  it("does not trust a role in the token: the lock applies to owners too", async () => {
    await expect(getActor(req("POST"))).rejects.toMatchObject({ status: 402 });
  });
});

describe("what unlocks or locks a workspace", () => {
  it("a paid subscription unlocks writes after the trial", async () => {
    tenant = { ...trialEndingIn(-DAY), subscription: { status: "active", currentPeriodEnd: new Date(Date.now() + 20 * DAY), pastDueSince: null, planId: "p1", plan: { name: "Growth" } } };
    await expect(getActor(req("POST"))).resolves.toBeTruthy();
  });

  it("a subscription that ended locks writes again", async () => {
    tenant = { ...trialEndingIn(-DAY), subscription: { status: "canceled", currentPeriodEnd: new Date(Date.now() - DAY), pastDueSince: null, planId: "p1", plan: { name: "Growth" } } };
    await expect(getActor(req("POST"))).rejects.toMatchObject({ status: 402, message: expect.stringMatching(/subscription has ended/i) });
    await expect(getActor(req("GET"))).resolves.toBeTruthy();
  });

  it("a failed payment keeps working through the grace period, then locks", async () => {
    const sub = (since: number) => ({ status: "past_due", currentPeriodEnd: new Date(Date.now() - DAY), pastDueSince: new Date(Date.now() - since), planId: "p1", plan: { name: "Growth" } });
    tenant = { ...trialEndingIn(-DAY), subscription: sub(DAY) };
    await expect(getActor(req("POST"))).resolves.toBeTruthy();
    tenant = { ...trialEndingIn(-DAY), subscription: sub(4 * DAY) };
    await expect(getActor(req("POST"))).rejects.toMatchObject({ status: 402 });
  });

  it("a suspended workspace is refused with 403 on writes even when exempt or in trial", async () => {
    tenant = { ...trialEndingIn(3 * DAY), status: "suspended", suspendedReason: "Policy violation", billingExempt: true };
    await expect(getActor(req("POST"))).rejects.toMatchObject({ status: 403, message: "Policy violation" });
    await expect(getActor(req("GET"))).resolves.toBeTruthy();
  });

  it("a complimentary workspace is never locked", async () => {
    tenant = { ...trialEndingIn(-30 * DAY), billingExempt: true };
    await expect(getActor(req("POST"))).resolves.toBeTruthy();
  });

  it("a workspace that never had a trial or plan is locked, and an unknown workspace is locked", async () => {
    tenant = { ...trialEndingIn(0), trialEndsAt: null };
    await expect(assertTenantCanWrite("t1")).rejects.toMatchObject({ status: 402 });
    db.tenant.findUnique.mockResolvedValue(null);
    await expect(assertTenantCanWrite("t1")).rejects.toMatchObject({ status: 402 });
  });
});

describe("the public API follows the same lock", () => {
  const apiReq = (method: string) => new Request("https://wa.test/api/ext/v3/contacts", { method, headers: { authorization: `Bearer ${KEY.key}` } });
  const handler = async () => ({ json: {} });

  beforeEach(() => {
    db.membership.findUnique.mockResolvedValue({ user: { disabledAt: null }, tenant: { deletedAt: null, status: "active" } });
    (db as unknown as { apiKey: Record<string, ReturnType<typeof vi.fn>> }).apiKey = {
      findUnique: vi.fn(async ({ where }: { where: { keyHash: string } }) =>
        where.keyHash === KEY.hash ? { id: "k1", tenantId: "t1", keyHash: KEY.hash, scopes: ["contacts:write", "messages:write"], revokedAt: null, lastUsedAt: new Date(), createdByUserId: "u1" } : null,
      ),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    };
  });

  it("reads work and writes answer 402 after the trial", async () => {
    tenant = trialEndingIn(-1000);
    expect((await run("contacts.list", handler, apiReq("GET"), {})).status).toBe(200);
    const write = await run("contacts.create", handler, apiReq("POST"), {});
    expect(write.status).toBe(402);
    expect((await write.json()).error.message).toMatch(/free trial has ended/i);
  });

  it("writes work while the trial runs", async () => {
    expect((await run("contacts.create", handler, apiReq("POST"), {})).status).toBe(200);
  });
});

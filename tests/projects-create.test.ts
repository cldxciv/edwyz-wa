import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "projects-create-secret-projects-123456";
process.env.SITE_URL = "https://wa.edwyz.com";
process.env.EMAIL_VERIFICATION_REQUIRED = "true";

type Fn = ReturnType<typeof vi.fn>;
const db = vi.hoisted(() => {
  const prisma = {
    membership: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
    user: { findUnique: vi.fn() },
    tenant: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    platformSetting: { findUnique: vi.fn() },
    // What the All projects overview reads besides memberships (for the "page and server agree" checks).
    phoneNumber: { groupBy: vi.fn() },
    conversation: { groupBy: vi.fn(), count: vi.fn() },
    lead: { groupBy: vi.fn() },
    spendControl: { findMany: vi.fn() },
    metaAsset: { findMany: vi.fn() },
    spendDaily: { groupBy: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return prisma;
});
const billing = vi.hoisted(() => ({ assertTenantCanWrite: vi.fn(), startTrial: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => billing);

import { POST as createPost } from "@/app/api/projects/route";
import { paywallExemptPath } from "@/lib/auth";
import { checkSignupLimit, resetLoginLimits } from "@/lib/auth/ratelimit";
import { signAccessToken } from "@/lib/auth/tokens";
import { createLockKey, NAME_CHECK_LIMIT, resetNewProjectLimits } from "@/lib/projects/create";
import { NAME_REQUIRED, NAME_TOO_LONG } from "@/lib/projects/names";
import { loadProjectsOverview } from "@/lib/projects/overview";
import { PROJECT_COPY } from "@/lib/projects/rules";
import { MAX_PROJECTS_LISTED, MAX_UNPAID_PROJECTS, NEW_PROJECTS_PER_DAY } from "@/lib/projects/types";
import { HttpError } from "@/lib/tenancy";

const ORIGIN = "https://wa.edwyz.com";
let ipSeq = 0;
const freshIp = () => `198.51.100.${(ipSeq++ % 250) + 1}`;

function req(body: unknown, opts: { origin?: string; ip?: string; cookie?: string | null; role?: "owner" | "admin" | "agent" } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: opts.origin ?? ORIGIN, "x-real-ip": opts.ip ?? freshIp() };
  const cookie = opts.cookie === undefined ? `wa_access=${signAccessToken({ sub: "u1", tid: "t1", role: opts.role ?? "owner" })}` : opts.cookie;
  if (cookie) headers.cookie = cookie;
  return new Request(`${ORIGIN}/api/projects`, { method: "POST", headers, body: JSON.stringify(body) });
}

let role: "owner" | "admin" | "agent" = "owner";
let verifiedAt: Date | null = new Date("2026-10-01T00:00:00Z");
let createdCount = 0;

type TenantRow = ReturnType<typeof tenantRow>;
const tenantRow = (over: Record<string, unknown> = {}) => ({
  id: "tx",
  name: "X",
  status: "active",
  suspendedReason: null as string | null,
  billingExempt: false,
  trialEndsAt: new Date(Date.now() + 5 * 86_400_000) as Date | null,
  subscription: null as unknown,
  deletedAt: null as Date | null,
  ...over,
});
const paidSub = () => ({ status: "active", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000), pastDueSince: null, cancelAtPeriodEnd: false, planId: "p", razorpaySubscriptionId: "sub", plan: { name: "Growth" } });
const paidRow = (over: Record<string, unknown> = {}) => tenantRow({ subscription: paidSub(), ...over });
const endedRow = (over: Record<string, unknown> = {}) => tenantRow({ trialEndsAt: new Date(Date.now() - 86_400_000), ...over });

/**
 * A small stateful database: the person's memberships, which a create adds to. A new workspace has no trial date until
 * startTrial runs after the transaction, which the billing rules read as read-only (unpaid), as on the real database.
 */
type Member = { role: "owner" | "admin" | "agent"; tenant: TenantRow };
let memberships: Member[] = [];
let newProjectsPaid = false;
const created = new Map<string, string>();
const lockKeys: string[] = [];
const locks = new Map<string, Promise<void>>();
const tick = () => new Promise((r) => setTimeout(r, 1));

/** An interactive transaction whose pg_advisory_xact_lock really waits for the previous holder of the same key to finish. */
async function transaction(fn: (tx: unknown) => unknown) {
  const releases: (() => void)[] = [];
  const tx = {
    ...db,
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("$");
      if (sql !== "SELECT pg_advisory_xact_lock(hashtext($))") throw new Error(`unexpected SQL: ${sql}`);
      const key = String(values[0]);
      lockKeys.push(key);
      const before = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      locks.set(key, before.then(() => held));
      await before;
      releases.push(release);
      return 1;
    }),
  };
  try {
    return await fn(tx);
  } finally {
    for (const r of releases) r();
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetLoginLimits();
  await resetNewProjectLimits();
  role = "owner";
  verifiedAt = new Date("2026-10-01T00:00:00Z");
  createdCount = 0;
  memberships = [{ role: "owner", tenant: paidRow({ id: "t1", name: "Home Shop" }) }];
  newProjectsPaid = false;
  created.clear();
  lockKeys.length = 0;
  locks.clear();
  db.membership.findUnique.mockImplementation(async ({ where }: { where: { tenantId_userId: { tenantId: string; userId: string } } }) => ({
    userId: where.tenantId_userId.userId,
    tenantId: where.tenantId_userId.tenantId,
    role,
    user: { disabledAt: null, emailVerifiedAt: verifiedAt },
    tenant: { deletedAt: null },
  }));
  db.user.findUnique.mockImplementation(async () => ({ emailVerifiedAt: verifiedAt }));
  db.membership.findMany.mockImplementation(async ({ where, take }: { where: { userId: string; role?: string; tenant: { deletedAt: null } }; take: number }) => {
    await tick();
    const rows = memberships.filter((m) => m.tenant.deletedAt === null && (!where.role || m.role === where.role));
    return rows.slice(0, take).map((m) => ({ role: m.role, tenant: m.tenant }));
  });
  db.membership.findFirst.mockResolvedValue(null);
  db.membership.count.mockImplementation(async () => memberships.length);
  db.membership.create.mockImplementation(async ({ data }: { data: { tenantId: string; role: "owner" } }) => {
    await tick();
    const name = created.get(data.tenantId) ?? "?";
    memberships.push({ role: data.role, tenant: newProjectsPaid ? paidRow({ id: data.tenantId, name }) : tenantRow({ id: data.tenantId, name, trialEndsAt: null }) });
    return {};
  });
  db.tenant.findUnique.mockResolvedValue(null);
  db.tenant.create.mockImplementation(async ({ data }: { data: { name: string; slug: string } }) => {
    await tick();
    const id = `new${++createdCount}`;
    created.set(id, data.name);
    return { id, name: data.name, slug: data.slug };
  });
  db.auditLog.create.mockResolvedValue({});
  db.platformSetting.findUnique.mockResolvedValue({ value: { graceDays: 3, trialDays: 7 } });
  db.$transaction.mockImplementation(transaction);
  for (const fn of [db.phoneNumber.groupBy, db.conversation.groupBy, db.lead.groupBy, db.spendControl.findMany, db.metaAsset.findMany, db.spendDaily.groupBy]) (fn as Fn).mockResolvedValue([]);
  db.conversation.count.mockResolvedValue(0);
  billing.assertTenantCanWrite.mockResolvedValue(undefined);
  billing.startTrial.mockResolvedValue(undefined);
});

const nothingCreated = () => {
  expect(db.tenant.create).not.toHaveBeenCalled();
  expect(db.membership.create).not.toHaveBeenCalled();
  expect(billing.startTrial).not.toHaveBeenCalled();
};

const ownedCall = () => (db.membership.findMany as Fn).mock.calls.map((c) => c[0]).find((a) => a.where.role === "owner");

describe("POST /api/projects: creating", () => {
  it("creates a workspace owned by the person, in one locked transaction, with a free trial, and does not switch the session", async () => {
    const res = await createPost(req({ name: "  Sharma   Sweets " }));
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ project: { id: "new1", name: "Sharma Sweets", slug: "sharma-sweets" } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(lockKeys).toEqual([createLockKey("u1")]);
    expect(createLockKey("u1")).toBe("projects-create:u1");
    expect(db.tenant.create).toHaveBeenCalledWith({ data: { name: "Sharma Sweets", slug: "sharma-sweets" }, select: { id: true, name: true, slug: true } });
    expect(db.membership.create).toHaveBeenCalledWith({ data: { tenantId: "new1", userId: "u1", role: "owner" } });
    expect(billing.startTrial).toHaveBeenCalledWith("new1");
    const audit = (db.auditLog.create as Fn).mock.calls.map((c) => c[0].data);
    expect(audit).toEqual([expect.objectContaining({ tenantId: "new1", userId: "u1", action: "workspace.created", target: "new1", meta: { from: "t1" } })]);
  });

  it("lets a member of any role start their own project, where they are the owner", async () => {
    role = "agent";
    memberships = [{ role: "agent", tenant: paidRow({ id: "t1", name: "Employer" }) }];
    const res = await createPost(req({ name: "My Own Shop" }, { role: "agent" }));
    expect(res.status).toBe(201);
    expect(db.membership.create).toHaveBeenCalledWith({ data: { tenantId: "new1", userId: "u1", role: "owner" } });
  });

  it("gives the project a unique web address part, as signup does", async () => {
    db.tenant.findUnique.mockImplementation(async ({ where }: { where: { slug: string } }) => (where.slug === "acme" ? { id: "taken" } : null));
    const res = await createPost(req({ name: "Acme" }));
    expect(res.status).toBe(201);
    const slug = (await res.json()).project.slug as string;
    expect(slug).toMatch(/^acme-[0-9a-f]{4}$/);
    db.tenant.findUnique.mockResolvedValue(null);
    const odd = await createPost(req({ name: "शर्मा 1" }));
    expect((await odd.json()).project.slug).toBe("1");
  });

  it("still answers 201 when the trial could not be started (support can set it), like signup", async () => {
    billing.startTrial.mockRejectedValue(new Error("db"));
    const res = await createPost(req({ name: "Trial Trouble" }));
    expect(res.status).toBe(201);
  });
});

describe("POST /api/projects: the signup rules", () => {
  it("refuses a request from another site before anything else", async () => {
    const res = await createPost(req({ name: "Evil" }, { origin: "https://evil.test" }));
    expect(res.status).toBe(403);
    nothingCreated();
  });

  it("needs a signed-in person", async () => {
    expect((await createPost(req({ name: "A" }, { cookie: null }))).status).toBe(401);
    nothingCreated();
  });

  it("needs a confirmed email address, and says so in this action's words", async () => {
    verifiedAt = null;
    const res = await createPost(req({ name: "Unconfirmed" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PROJECT_COPY.verify);
    nothingCreated();
  });

  it("checks the name like the signup form and answers under the name field", async () => {
    for (const [body, message] of [[{}, NAME_REQUIRED], [{ name: "   " }, NAME_REQUIRED], [{ name: "x".repeat(101) }, NAME_TOO_LONG]] as const) {
      const res = await createPost(req(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: message, field: "name" });
    }
    nothingCreated();
  });

  it("refuses a name the person already uses for a live project (any case, any spacing, any role), under the name field", async () => {
    memberships.push({ role: "agent", tenant: paidRow({ id: "t9", name: "Acme  Retail" }) });
    const res = await createPost(req({ name: "acme retail" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: PROJECT_COPY.duplicate("acme retail"), field: "name" });
    nothingCreated();
    // A deleted workspace's name is free again.
    memberships[memberships.length - 1].tenant.deletedAt = new Date();
    expect((await createPost(req({ name: "acme retail" }))).status).toBe(201);
  });

  it("compares names as plain text: _ % and \\ are ordinary characters, never a pattern (and never a database error)", async () => {
    newProjectsPaid = true; // so the unpaid cap stays out of the way of the name checks
    memberships.push({ role: "owner", tenant: paidRow({ id: "t2", name: "ShopX1" }) }, { role: "admin", tenant: paidRow({ id: "t3", name: "Apple Store" }) });
    // With SQL ILIKE, "_" matched any one character and "%" any run of them.
    expect((await createPost(req({ name: "Shop_1" }))).status).toBe(201);
    expect((await createPost(req({ name: "A%" }))).status).toBe(201);
    // A name ending in a backslash made ILIKE fail ("must not end with escape character"): now it is just a name.
    const slash = await createPost(req({ name: "Acme \\" }));
    expect(slash.status).toBe(201);
    expect((await slash.json()).project.name).toBe("Acme \\");
    // And each of them is a duplicate of itself only, in any case.
    for (const name of ["SHOP_1", "a%", "acme   \\"]) {
      const res = await createPost(req({ name }));
      expect(res.status, name).toBe(409);
      expect((await res.json()).field).toBe("name");
    }
    expect((await createPost(req({ name: "Shop%1" }))).status).toBe(201);
    // The names are read as data and compared in code: no name filter (and no ILIKE) is sent to the database.
    for (const call of (db.membership.findMany as Fn).mock.calls) expect(JSON.stringify(call[0].where)).not.toMatch(/"name"|insensitive|contains|equals/);
    const names = (db.membership.findMany as Fn).mock.calls.map((c) => c[0]).find((a) => !a.where.role);
    expect(names).toMatchObject({ where: { userId: "u1", tenant: { deletedAt: null } }, take: NAME_CHECK_LIMIT, select: { tenant: { select: { name: true } } } });
    expect(NAME_CHECK_LIMIT).toBeGreaterThan(MAX_PROJECTS_LISTED);
  });

  it("counts the signup limit for the connection (shared with signup), with words for this action", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 8; i++) await checkSignupLimit(ip);
    const res = await createPost(req({ name: "Blocked" }, { ip }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe(PROJECT_COPY.perConnectionLimit);
    nothingCreated();
    // And a project start uses up the same budget a signup would.
    const ip2 = "203.0.113.78";
    for (let i = 0; i < 7; i++) await checkSignupLimit(ip2);
    expect((await createPost(req({ name: "Last One" }, { ip: ip2 }))).status).toBe(201);
    await expect(checkSignupLimit(ip2)).rejects.toMatchObject({ status: 429 });
  });

  it(`allows ${NEW_PROJECTS_PER_DAY} new projects per person a day, from any connection`, async () => {
    newProjectsPaid = true;
    for (let i = 0; i < NEW_PROJECTS_PER_DAY; i++) expect((await createPost(req({ name: `Client ${i}` }))).status, `project ${i}`).toBe(201);
    const res = await createPost(req({ name: "One Too Many" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe(PROJECT_COPY.perUserLimit);
  });

  it("a refused attempt uses up neither the connection's sign-up allowance nor the person's daily one", async () => {
    const ip = "203.0.113.90";
    // More duplicate-name retries from one office connection than its hourly sign-up allowance (8).
    for (let i = 0; i < 12; i++) expect((await createPost(req({ name: "home shop" }, { ip }))).status).toBe(409);
    // Real sign-ups from that connection still have their whole allowance.
    for (let i = 0; i < 7; i++) await checkSignupLimit(ip);
    expect((await createPost(req({ name: "Real Project" }, { ip }))).status).toBe(201);
    // Refused by the unpaid cap many times: the person's daily allowance is untouched.
    memberships.push(...Array.from({ length: MAX_UNPAID_PROJECTS }, (_, i) => ({ role: "owner" as const, tenant: tenantRow({ id: `tr${i}`, name: `Trial ${i}` }) })));
    for (let i = 0; i < NEW_PROJECTS_PER_DAY + 2; i++) expect((await createPost(req({ name: `Capped ${i}` }))).status).toBe(409);
    memberships = memberships.filter((m) => !m.tenant.id.startsWith("tr") && !m.tenant.id.startsWith("new"));
    newProjectsPaid = true;
    // One was used by "Real Project"; the rest are still there.
    for (let i = 1; i < NEW_PROJECTS_PER_DAY; i++) expect((await createPost(req({ name: `Allowed ${i}` }))).status, `project ${i}`).toBe(201);
    expect((await createPost(req({ name: "Now Over" }))).status).toBe(429);
  });
});

describe("POST /api/projects: free trials cannot be chained", () => {
  it(`refuses a person who already owns ${MAX_UNPAID_PROJECTS} projects without a paid plan`, async () => {
    memberships = Array.from({ length: MAX_UNPAID_PROJECTS }, (_, i) => ({ role: "owner" as const, tenant: tenantRow({ id: `t${i + 1}`, name: `Trial ${i}` }) }));
    const res = await createPost(req({ name: "Fourth Trial" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(PROJECT_COPY.unpaidCap);
    expect(ownedCall().where).toEqual({ userId: "u1", role: "owner", tenant: { deletedAt: null } });
    nothingCreated();
  });

  it("counts read-only projects whose trial ended as unpaid, but not paid ones", async () => {
    memberships = [{ role: "owner", tenant: endedRow({ id: "t1" }) }, { role: "owner", tenant: endedRow({ id: "t2" }) }, { role: "owner", tenant: tenantRow({ id: "t3" }) }];
    expect((await createPost(req({ name: "Blocked" }))).status).toBe(409);
    memberships = [{ role: "owner", tenant: endedRow({ id: "t1" }) }, { role: "owner", tenant: tenantRow({ id: "t2" }) }, { role: "owner", tenant: paidRow({ id: "t3" }) }, { role: "owner", tenant: paidRow({ id: "t4" }) }];
    expect((await createPost(req({ name: "Allowed" }))).status).toBe(201);
  });

  it("refuses while one of the person's projects is suspended", async () => {
    memberships = [{ role: "owner", tenant: tenantRow({ id: "t1", status: "suspended", suspendedReason: "Abuse" }) }];
    const res = await createPost(req({ name: "Evasion" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PROJECT_COPY.suspended);
    nothingCreated();
  });

  it(`lets only ${MAX_UNPAID_PROJECTS} of many parallel requests through: each waits for the one before to commit, then counts it`, async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => createPost(req({ name: `Burst ${i}` }))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([...Array(MAX_UNPAID_PROJECTS).fill(201), ...Array(6 - MAX_UNPAID_PROJECTS).fill(409)]);
    for (const r of results.filter((x) => x.status === 409)) expect((await r.json()).error).toBe(PROJECT_COPY.unpaidCap);
    expect(db.tenant.create).toHaveBeenCalledTimes(MAX_UNPAID_PROJECTS);
    expect(memberships.filter((m) => m.tenant.id.startsWith("new"))).toHaveLength(MAX_UNPAID_PROJECTS);
    // Every one of them took the same per-person lock.
    expect(new Set(lockKeys)).toEqual(new Set([createLockKey("u1")]));
  });

  it("starts one project when the same name is sent twice at once, and refuses the other under the name field", async () => {
    const [a, b] = await Promise.all([createPost(req({ name: "Twin Shop" })), createPost(req({ name: "twin  shop" }))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const [refused, itsName] = a.status === 409 ? [a, "Twin Shop"] : [b, "twin shop"];
    expect(await refused.json()).toEqual({ error: PROJECT_COPY.duplicate(itsName), field: "name" });
    expect(db.tenant.create).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/projects: the workspace the person is in does not decide", () => {
  const overviewFor = () => loadProjectsOverview({ userId: "u1", tenantId: "t1" });

  it("is not behind the current workspace's paywall: the new project is a different workspace", () => {
    expect(paywallExemptPath("/api/projects")).toBe(true);
    // Only that exact path: nothing under it, nothing that merely starts with it.
    expect(paywallExemptPath("/api/projects/overview")).toBe(false);
    expect(paywallExemptPath("/api/projectsx")).toBe(false);
  });

  it("from a read-only workspace (trial ended), starts the project, as the All projects page said it would", async () => {
    memberships = [{ role: "owner", tenant: endedRow({ id: "t1", name: "Old Trial" }) }];
    billing.assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Your free trial has ended. Your data is read-only until you subscribe at /app/billing."));
    expect((await overviewFor()).newProject).toEqual({ allowed: true, reason: null });
    const res = await createPost(req({ name: "Fresh Start" }));
    expect(res.status).toBe(201);
    expect(billing.assertTenantCanWrite).not.toHaveBeenCalled();
  });

  it("from a read-only workspace with the unpaid cap reached, page and server give the same refusal", async () => {
    memberships = Array.from({ length: MAX_UNPAID_PROJECTS }, (_, i) => ({ role: "owner" as const, tenant: endedRow({ id: `t${i + 1}`, name: `Old ${i}` }) }));
    billing.assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Your free trial has ended."));
    expect((await overviewFor()).newProject).toEqual({ allowed: false, reason: PROJECT_COPY.unpaidCap });
    const res = await createPost(req({ name: "Fourth" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(PROJECT_COPY.unpaidCap);
    nothingCreated();
  });

  it("an agent in someone else's read-only or suspended workspace can still start their own", async () => {
    role = "agent";
    memberships = [{ role: "agent", tenant: tenantRow({ id: "t1", name: "Employer", status: "suspended", suspendedReason: "Abuse" }) }];
    billing.assertTenantCanWrite.mockRejectedValue(new HttpError(403, "This workspace has been suspended."));
    expect((await overviewFor()).newProject.allowed).toBe(true);
    expect((await createPost(req({ name: "My Own Shop" }, { role: "agent" }))).status).toBe(201);
  });

  it("an owner whose current workspace is suspended is refused by the project rule, with words that say what to do", async () => {
    memberships = [{ role: "owner", tenant: tenantRow({ id: "t1", name: "Mine", status: "suspended", suspendedReason: "Abuse" }) }];
    billing.assertTenantCanWrite.mockRejectedValue(new HttpError(403, "This workspace has been suspended."));
    expect((await overviewFor()).newProject).toEqual({ allowed: false, reason: PROJECT_COPY.suspended });
    const res = await createPost(req({ name: "Evasion" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PROJECT_COPY.suspended);
    nothingCreated();
  });
});

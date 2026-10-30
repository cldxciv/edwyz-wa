import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * PUT /api/spend/freeze, the workspace kill switch (docs/SPEND-CONTROLS-SPEC.md 4.11, 4.17, 2.3.13), through the real route,
 * the real getActor (with its paywall exemption for /api/spend/), the real kill switch, Spend Book and stopCommitments on the
 * in-memory spend database. Only Meta (fetch), the Meta connection, billing state and the job queue are stand-ins.
 */

process.env.SESSION_SECRET = "s".repeat(40);
process.env.EMAIL_VERIFICATION_REQUIRED = "false";
process.env.SITE_URL = "https://wa.test";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  billing: "active" as "active" | "locked" | "suspended",
  queueDown: false,
  jobs: [] as { queue: string; payload: unknown }[],
}));
vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/billing", async () => {
  const { HttpError } = await import("@/lib/tenancy");
  return {
    assertTenantCanWrite: vi.fn(async () => {
      if (h.billing === "locked") throw new HttpError(402, "Your subscription is inactive. Your data is read-only until you subscribe at /app/billing.");
      if (h.billing === "suspended") throw new HttpError(403, "This workspace has been suspended.");
    }),
  };
});
// The worker daemon: jobs land here; `queueDown` makes the queue itself unavailable.
vi.mock("@/lib/queue", () => ({
  enqueue: vi.fn(async (queue: string, payload: unknown) => {
    if (h.queueDown) throw new Error("queue unavailable");
    h.jobs.push({ queue, payload });
    return { id: `job_${h.jobs.length}` };
  }),
}));
vi.mock("@/lib/meta-connect", () => ({
  getAssetAccess: async (_t: string, assetId: string) => ({ assetId, type: "ad_account", externalId: "act_111", name: "Shop ads", token: "TOKEN" }),
  listAssets: async () => [],
}));

import { PUT } from "@/app/api/spend/freeze/route";
import { getActor } from "@/lib/auth";
import { signAccessToken } from "@/lib/auth/tokens";
import { assertTenantCanWrite } from "@/lib/billing";
import { resetBookForTests } from "@/lib/spend/book";
import { PLATFORM_FREEZE_KEY, resetSpendStateCache, spendState } from "@/lib/spend/kill";
import { SPEND_QUEUES } from "@/lib/spend/types";

const T = "t1";
const NOW = new Date("2026-10-28T06:30:00Z");
const ORIGIN = "https://wa.test";
type Who = { userId: string; tenantId: string; role: "owner" | "admin" | "agent" };
const OWNER: Who = { userId: "u_owner", tenantId: T, role: "owner" };
const ADMIN: Who = { userId: "u_admin", tenantId: T, role: "admin" };
const AGENT: Who = { userId: "u_agent", tenantId: T, role: "agent" };

const rows = (name: string) => h.db.rows(name);
const control = () => rows("spendControl").find((r) => r.tenantId === T)!;
const campaign = (id: string) => rows("adCampaign").find((r) => r.id === id)!;
const meta = { posts: [] as { path: string; body: Row }[], refuse: new Set<string>() };

function request(who: Who | null, body: unknown, o: { origin?: string | null; path?: string; method?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who) headers.authorization = `Bearer ${signAccessToken({ sub: who.userId, tid: who.tenantId, role: who.role })}`;
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  return new Request(`${ORIGIN}${o.path ?? "/api/spend/freeze"}`, { method: o.method ?? "PUT", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function put(who: Who | null, body: unknown, o: { origin?: string | null } = {}) {
  const res = await PUT(request(who, body, o));
  return { status: res.status, json: (await res.json()) as Row };
}

function seed() {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false }]);
  h.db.seed("membership", [OWNER, ADMIN, AGENT].map((m) => ({ id: `m_${m.userId}`, ...m })));
  h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: false, createdAt: new Date("2026-01-01") }]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: "acc1", timezone: "Asia/Kolkata" }]);
  h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: 500_000n, monthlyLimitMinor: 5_000_000n }]);
  for (const [id, rupees] of [["c1", 2_000], ["c2", 1_000]] as const) {
    h.db.seed("adCampaign", [{ id, tenantId: T, adAccountAssetId: "acc1", metaCampaignId: `m_${id}`, name: `Campaign ${id}`, status: "active", dailyBudgetMinor: rupees * 100, currency: "INR", endsAt: null, origin: "human", sandbox: false, lastError: null, updatedAt: new Date("2026-10-01") }]);
    h.db.seed("adSet", [{ id: `${id}s`, tenantId: T, campaignId: id, metaAdSetId: `m_${id}s`, status: "active", dailyBudgetMinor: rupees * 100, lifetimeBudgetMinor: null }]);
    h.db.seed("spendCommitment", [
      { id: `cm_${id}`, tenantId: T, adAccountAssetId: "acc1", campaignId: id, adSetId: `${id}s`, metaObjectId: `m_${id}s`, objectLevel: "adset", origin: "human", currency: "INR", timezone: "Asia/Kolkata", dailyBudgetMinor: BigInt(rupees * 100), peakDailyBudgetMinor: BigInt(rupees * 100), weekPeakDailyBudgetMinor: BigInt(rupees * 100), status: "live" },
    ]);
  }
}

beforeAll(() => {
  // getActor reads the membership by its compound key with the user and workspace: give the base fake that lookup.
  const membership = h.db.prisma.membership as unknown as Row;
  membership.findUnique = async ({ where }: Row) => {
    const key = (where as Row).tenantId_userId as Row;
    const m = rows("membership").find((r) => r.tenantId === key.tenantId && r.userId === key.userId);
    return m ? { ...m, user: { disabledAt: null, emailVerifiedAt: new Date("2026-01-01") }, tenant: { deletedAt: null } } : null;
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.db.reset();
  h.billing = "active";
  h.queueDown = false;
  h.jobs = [];
  resetSpendStateCache();
  resetBookForTests();
  meta.posts = [];
  meta.refuse = new Set();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname.split("/").slice(2).join("/");
      const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
      if (init?.method === "POST") meta.posts.push({ path, body });
      if (meta.refuse.has(path)) return new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 400 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }),
  );
  seed();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// =====================================================================================================================
describe("stopping spending", () => {
  it("an admin stops all spending: the stop pauses inline and answers 'Paused 2 of 2 campaigns'", async () => {
    const res = await put(ADMIN, { level: "all", reason: "Something looks wrong" });
    expect(res.status).toBe(200);
    expect(res.json.freeze).toMatchObject({ level: "all", changed: true, paused: 2, total: 2, pending: 0, failed: 0, text: "Paused 2 of 2 campaigns.", workspace: "all", effective: "all" });
    expect(meta.posts).toEqual([
      { path: "m_c1", body: { status: "PAUSED" } },
      { path: "m_c2", body: { status: "PAUSED" } },
    ]);
    expect([campaign("c1").status, campaign("c2").status]).toEqual(["paused", "paused"]);
    expect(rows("spendCommitment").every((c) => c.status === "stopped")).toBe(true);
    // The freeze applies at once to every raise path, and the job for the worker is queued for whatever is left.
    expect((await spendState(T, { fresh: true })).effective).toBe("all");
    expect(control()).toMatchObject({ freeze: "all", frozenByKind: "admin", frozenByUserId: "u_admin", frozenReason: "Something looks wrong" });
    expect(h.jobs.map((j) => j.queue)).toEqual([SPEND_QUEUES.stop]);
    expect(rows("spendLedger").filter((r) => r.action === "kill.workspace").map((r) => r.phase)).toEqual(["requested", "applied"]);
    expect(rows("spendLedger").filter((r) => r.action === "ads.campaign.pause" && r.phase === "applied").map((r) => r.actorId)).toEqual(["u_admin", "u_admin"]);
  });

  it("answers 'Paused 1 of 2; the rest will follow within a minute' when one pause does not go through", async () => {
    meta.refuse.add("m_c2");
    const res = await put(OWNER, { level: "all" });
    expect(res.json.freeze).toMatchObject({ paused: 1, total: 2, pending: 1, failed: 1, text: "Paused 1 of 2; the rest will follow within a minute." });
    // The campaign that could not be paused stays counted, and the owner is told it may still be running.
    expect(rows("spendCommitment").find((c) => c.id === "cm_c2")!.status).toBe("unconfirmed");
    expect(rows("notice").map((n) => (n.payload as Row).title)).toEqual(["1 campaign could not be paused"]);
  });

  it("the inline pause works with the worker down: the stop holds even when the job cannot be queued", async () => {
    h.queueDown = true;
    const res = await put(ADMIN, { level: "all" });
    expect(res.status).toBe(200);
    expect(res.json.freeze).toMatchObject({ paused: 2, total: 2, text: "Paused 2 of 2 campaigns." });
    expect(h.jobs).toEqual([]);
    expect((await spendState(T, { fresh: true })).effective).toBe("all");
  });

  it("stopping assistants pauses only what assistants launched", async () => {
    campaign("c2").origin = "assistant";
    rows("spendCommitment").find((c) => c.id === "cm_c2")!.origin = "assistant";
    const res = await put(ADMIN, { level: "assistants" });
    expect(res.json.freeze).toMatchObject({ level: "assistants", paused: 1, total: 1, text: "Paused 1 of 1 campaign." });
    expect(meta.posts.map((p) => p.path)).toEqual(["m_c2"]);
    expect(campaign("c1").status).toBe("active");
  });

  it("a team member cannot stop spending, and the refusal is ledgered", async () => {
    const res = await put(AGENT, { level: "all" });
    expect(res).toMatchObject({ status: 403, json: { error: "Only the owner or an admin can stop spending." } });
    expect(control().freeze).toBe("none");
    expect(meta.posts).toEqual([]);
    expect(rows("spendLedger").filter((r) => r.action === "kill.workspace").map((r) => r.phase)).toEqual(["refused"]);
  });

  it("stopping works in a locked or suspended workspace (it is a lowering, so the paywall does not apply)", async () => {
    h.billing = "locked";
    expect((await put(ADMIN, { level: "assistants" })).status).toBe(200);
    h.billing = "suspended";
    expect((await put(OWNER, { level: "all" })).json.freeze).toMatchObject({ level: "all", text: "Paused 2 of 2 campaigns." });
    expect(assertTenantCanWrite).not.toHaveBeenCalled();
  });
});

// =====================================================================================================================
describe("turning spending back on", () => {
  beforeEach(async () => {
    expect((await put(ADMIN, { level: "all" })).status).toBe(200);
    meta.posts = [];
  });

  it("the owner turns it back on; it clears the stop only and restarts nothing (2.3.13)", async () => {
    const res = await put(OWNER, { level: "none" });
    expect(res.status).toBe(200);
    expect(res.json.freeze).toMatchObject({ level: "none", changed: true, text: "Spending is back on. Anything that was paused stays paused until you resume it.", effective: "none" });
    expect(meta.posts).toEqual([]);
    expect([campaign("c1").status, campaign("c2").status]).toEqual(["paused", "paused"]);
    expect(control()).toMatchObject({ freeze: "none", frozenByUserId: null });
    expect(h.jobs.map((j) => j.queue)).toEqual([SPEND_QUEUES.stop]);
  });

  it("an admin turning it back on gets 403, and spending stays stopped", async () => {
    const res = await put(ADMIN, { level: "none" });
    expect(res).toMatchObject({ status: 403, json: { error: "Only the owner can turn spending back on." } });
    expect(control().freeze).toBe("all");
    // Nor may an admin loosen 'all' to 'assistants'.
    expect((await put(ADMIN, { level: "assistants" })).status).toBe(403);
  });

  it("in a locked workspace turning it back on is the one thing that gets 402", async () => {
    h.billing = "locked";
    const res = await put(OWNER, { level: "none" });
    expect(res).toMatchObject({ status: 402, json: { error: expect.stringContaining("read-only") } });
    expect(control().freeze).toBe("all");
    // An admin still gets the 403 that says who can do it, not the 402.
    expect((await put(ADMIN, { level: "none" })).status).toBe(403);
    h.billing = "active";
    expect((await put(OWNER, { level: "none" })).status).toBe(200);
  });

  it("a stop Edwyz put on every workspace is not cleared by the workspace owner", async () => {
    rows("platformSetting").push({ key: PLATFORM_FREEZE_KEY, value: { freeze: "all", reason: "Incident", byUserId: "u_support", at: NOW.toISOString(), version: 1 } });
    resetSpendStateCache();
    const res = await put(OWNER, { level: "none" });
    expect(res.status).toBe(200);
    expect(res.json.freeze).toMatchObject({ workspace: "none", platform: "all", effective: "all" });
    expect(String(res.json.freeze && (res.json.freeze as Row).text)).toContain("Edwyz has paused spending for every workspace for now");
    expect((await spendState(T, { fresh: true })).effective).toBe("all");
  });
});

// =====================================================================================================================
describe("the request itself", () => {
  it("needs a known level, the same origin and a signed-in member", async () => {
    expect((await put(OWNER, { level: "pause" })).status).toBe(400);
    expect((await put(OWNER, { level: "all" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await put(null, { level: "all" })).status).toBe(401);
    expect(control().freeze).toBe("none");
  });

  it("setting the level it already has changes nothing and queues nothing", async () => {
    const res = await put(OWNER, { level: "none" });
    expect(res.json.freeze).toMatchObject({ changed: false, text: "Spending is on." });
    expect(h.jobs).toEqual([]);
  });

  it("getActor exempts /api/spend/ from the paywall; other writes still get 402", async () => {
    h.billing = "locked";
    await expect(getActor(request(ADMIN, {}, { path: "/api/spend/freeze" }))).resolves.toMatchObject({ userId: "u_admin", role: "admin" });
    await expect(getActor(request(ADMIN, {}, { path: "/api/contacts", method: "POST" }))).rejects.toMatchObject({ status: 402 });
    await expect(getActor(request(ADMIN, {}, { path: "/api/spendings", method: "POST" }))).rejects.toMatchObject({ status: 402 });
  });
});

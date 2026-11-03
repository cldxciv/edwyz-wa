import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  metaConnection: { findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  metaAsset: { findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
  metaSpendLimit: { findMany: vi.fn(), findFirst: vi.fn() },
  // The workspace's spending ad account goes first in the readiness reads (discovery.ts orderForEnrich).
  spendControl: { findUnique: vi.fn() },
  tenant: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  // findUnique and upsert: the promote/meta client's capability cache and throttle rows (PRM-07 readiness reads).
  platformSetting: { create: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  phoneNumber: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
const graph = vi.hoisted(() => ({ graphFetchAs: vi.fn(), appGraphFetch: vi.fn() }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/graph", () => ({
  ...graph,
  GraphError: class GraphError extends Error {
    constructor(m: string, public status: number, public code?: number) {
      super(m);
    }
  },
}));
// Disconnect protection (docs/SPEND-CONTROLS-SPEC.md 5.9): the pause, the P0 write and the offboarding choice are mocked here;
// tests/spend-metacap.test.ts covers them against fake Meta.
const spend = vi.hoisted(() => ({ stop: vi.fn(), p0: vi.fn(), offboard: vi.fn(), getActor: vi.fn() }));
vi.mock("@/lib/ads/stop", () => ({ stopCommitments: (...a: unknown[]) => spend.stop(...a) }));
vi.mock("@/lib/spend/metacap/sync", async (orig) => ({ ...(await orig<typeof import("@/lib/spend/metacap/sync")>()), p0Stop: (...a: unknown[]) => spend.p0(...a) }));
vi.mock("@/lib/spend/metacap/offboard", async (orig) => ({ ...(await orig<typeof import("@/lib/spend/metacap/offboard")>()), offboardAccount: (...a: unknown[]) => spend.offboard(...a) }));
vi.mock("@/lib/auth", () => ({ getActor: (...a: unknown[]) => spend.getActor(...a) }));

import { GraphError } from "@/lib/graph";
import { sealSecret, openSecret } from "@/lib/crypto/secrets";
import { getAssetAccess, listAssets } from "@/lib/meta-connect";
import { checkPageSubscription, discoverAssets, fetchAll, MAX_ITEMS, MAX_LEADGEN_SUBSCRIBES, orderForSubscribe, PAGE_SIZE, runPool, SUBSCRIBE_BUDGET_MS, SUBSCRIBE_CONCURRENCY, verificationDue, verifyLeadSubscriptions } from "@/lib/meta-connect/discovery";
import { carriedBlocks, justCreatedIdentity, MAX_ENRICH_AD_ACCOUNTS, MAX_ENRICH_PAGES, META_BLOCKS, minDailyFrom, orderForEnrich, PAGE_BACKED_LISTING_GRACE_MS, PAGE_FIELDS, pictureUrl, READINESS_TRIED_KEY, readinessAge, whatsappLinkState } from "@/lib/meta-connect/discovery";
import { AD_ACCOUNT_HEALTH_FIELDS } from "@/lib/promote/meta";
import { createState, verifyState } from "@/lib/oauth-state";
import { completeConnect, disconnect, ensurePageBackedInstagram, finishPendingDisconnects, healthStatus, listConnections, PENDING_DISCONNECT_GRACE_MS, refreshConnection, REQUEST_DISCOVERY_BUDGET_MS, startConnect } from "@/lib/meta-connect/service";
import { issueState, consumeState } from "@/lib/meta-connect/state";
import { checkTokenHealth } from "@/lib/meta-connect/worker";
import { META_CONNECT_SCOPES, SCOPE_PURPOSES, scopeSummary, unusedScopes } from "@/lib/meta-connect/scopes";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.STATE_SECRET = "state-secret";
  process.env.META_APP_ID = "123";
  process.env.META_APP_SECRET = "appsecret";
  process.env.META_LOGIN_CONFIG_ID = "cfg1";
  db.platformSetting.deleteMany.mockResolvedValue({ count: 1 });
  db.platformSetting.create.mockResolvedValue({});
  db.$transaction.mockImplementation(async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: typeof db) => unknown)(db) : arg));
  db.metaConnection.findMany.mockResolvedValue([]);
  db.metaAsset.findMany.mockResolvedValue([]);
  db.metaAsset.updateMany.mockResolvedValue({ count: 0 });
  db.metaConnection.updateMany.mockResolvedValue({ count: 1 });
  db.tenant.findMany.mockResolvedValue([]);
});

describe("state", () => {
  it("start returns a dialog url with config_id and a state", async () => {
    const { url } = await startConnect(actor);
    const u = new URL(url);
    expect(u.searchParams.get("config_id")).toBe("cfg1");
    expect(u.searchParams.get("state")).toMatch(/^[0-9a-f]{32}\.\d+\.[0-9a-f]{64}$/);
    expect(u.searchParams.get("redirect_uri")).toContain("/api/meta-connect/callback");
  });

  it("accepts a fresh state once", async () => {
    const state = await issueState("t1", "u1");
    await expect(consumeState("t1", "u1", state)).resolves.toBeUndefined();
    db.platformSetting.deleteMany.mockResolvedValue({ count: 0 });
    await expect(consumeState("t1", "u1", state)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects tampered state and state from another tenant or user", async () => {
    const state = await issueState("t1", "u1");
    const [n, ts, sig] = state.split(".");
    await expect(consumeState("t1", "u1", `${n}.${Number(ts) + 1}.${sig}`)).rejects.toMatchObject({ status: 400 });
    await expect(consumeState("t1", "u1", `${n}.${ts}.${"0".repeat(64)}`)).rejects.toMatchObject({ status: 400 });
    await expect(consumeState("t2", "u1", state)).rejects.toMatchObject({ status: 400 });
    await expect(consumeState("t1", "u2", state)).rejects.toMatchObject({ status: 400 });
    await expect(consumeState("t1", "u1", null)).rejects.toMatchObject({ status: 400 });
  });
});

describe("state secret domain separation", () => {
  const hmac = (key: string | Buffer, msg: string) => createHmac("sha256", key).update(msg).digest();

  it("signs with a key derived from STATE_SECRET and the meta-connect-state-v1 label, never STATE_SECRET directly", async () => {
    const state = await issueState("t1", "u1");
    const derived = hmac(hmac("state-secret", "meta-connect-state-v1"), "t1\nu1").toString("hex");
    expect(verifyState(state, derived)).toBe(true);
    expect(verifyState(state, "state-secret")).toBe(false);
    expect(verifyState(state, hmac("state-secret", "meta-connect\nt1\nu1").toString("hex"))).toBe(false);
  });

  it("accepts only a state signed with the labelled derivation, and rejects raw, unlabelled and other-feature keys", async () => {
    const good = createState(hmac(hmac("state-secret", "meta-connect-state-v1"), "t1\nu1").toString("hex"));
    await expect(consumeState("t1", "u1", good)).resolves.toBeUndefined();
    db.platformSetting.deleteMany.mockClear();
    const forged = [
      "state-secret",
      hmac("state-secret", "t1\nu1").toString("hex"),
      hmac(hmac("state-secret", "creative-media-v1"), "t1\nu1").toString("hex"),
      hmac(hmac("state-secret", "meta-connect-state-v2"), "t1\nu1").toString("hex"),
      hmac("state-secret", "meta-connect-state-v1\nt1\nu1").toString("hex"),
    ];
    for (const key of forged) await expect(consumeState("t1", "u1", createState(key))).rejects.toMatchObject({ status: 400 });
    expect(db.platformSetting.deleteMany).not.toHaveBeenCalled();
  });

  it("fails closed when STATE_SECRET is unset, and in production when it is shorter than 32 characters", async () => {
    delete process.env.STATE_SECRET;
    await expect(issueState("t1", "u1")).rejects.toMatchObject({ status: 503 });
    process.env.STATE_SECRET = "short";
    vi.stubEnv("NODE_ENV", "production");
    await expect(issueState("t1", "u1")).rejects.toMatchObject({ status: 503 });
    process.env.STATE_SECRET = randomBytes(32).toString("hex");
    await expect(issueState("t1", "u1")).resolves.toMatch(/^[0-9a-f]{32}\./);
    vi.unstubAllEnvs();
  });

  it("keeps the nonce single use: a replay is rejected once the stored nonce is gone", async () => {
    const state = await issueState("t1", "u1");
    expect(db.platformSetting.create.mock.calls[0][0].data.key).toBe(`meta-connect-state:${state.split(".")[0]}`);
    db.platformSetting.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await consumeState("t1", "u1", state);
    await expect(consumeState("t1", "u1", state)).rejects.toMatchObject({ status: 400 });
  });
});

describe("completeConnect", () => {
  it("exchanges the code, seals the token and never stores it in clear", async () => {
    const state = await issueState("t1", "u1");
    graph.appGraphFetch.mockResolvedValueOnce({ access_token: "SHORT" }).mockResolvedValueOnce({ access_token: "LONGTOKEN", expires_in: 5_000_000 });
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "debug_token") return { data: { is_valid: true, user_id: "9001", scopes: ["pages_show_list"], expires_at: Math.floor(Date.now() / 1000) + 5_000_000 } };
      return { data: [] };
    });
    db.metaConnection.upsert.mockResolvedValue({ id: "c1" });

    await completeConnect(actor, "the-code", state);

    const call = db.metaConnection.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId_metaUserId: { tenantId: "t1", metaUserId: "9001" } });
    expect(call.create.tokenEnc).not.toContain("LONGTOKEN");
    expect(openSecret("t1", call.create.tokenEnc)).toBe("LONGTOKEN");
    expect(() => openSecret("t2", call.create.tokenEnc)).toThrow();
    expect(call.create.scopes).toEqual(["pages_show_list"]);
    expect(graph.appGraphFetch.mock.calls[1][0].query.grant_type).toBe("fb_exchange_token");
    // The first completeConnect loads @/lib/spend/metacap/consent lazily (about 1.2 s alone), which can pass the 5 s default
    // when the whole suite runs in parallel. The work is the same; only the time budget is realistic.
  }, 20_000);

  it("rejects an invalid state before calling Meta", async () => {
    await expect(completeConnect(actor, "code", "bad.state.value")).rejects.toMatchObject({ status: 400 });
    expect(graph.appGraphFetch).not.toHaveBeenCalled();
  });
});

describe("discovery paging", () => {
  it("follows cursors and reports complete", async () => {
    graph.graphFetchAs
      .mockResolvedValueOnce({ data: [{ id: "1" }], paging: { cursors: { after: "A" }, next: "x" } })
      .mockResolvedValueOnce({ data: [{ id: "2" }] });
    const res = await fetchAll<{ id: string }>("tok", "me/accounts", "id");
    expect(res).toEqual({ items: [{ id: "1" }, { id: "2" }], complete: true });
    expect(graph.graphFetchAs.mock.calls[1][1].query.after).toBe("A");
    expect(graph.graphFetchAs.mock.calls[0][1].query.limit).toBe(String(PAGE_SIZE));
  });

  it("caps the item count and flags the result incomplete", async () => {
    graph.graphFetchAs.mockImplementation(async () => ({
      data: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: String(Math.random() + i) })),
      paging: { cursors: { after: "A" }, next: "x" },
    }));
    const res = await fetchAll("tok", "me/accounts", "id");
    expect(res.items.length).toBe(MAX_ITEMS);
    expect(res.complete).toBe(false);
    expect(graph.graphFetchAs.mock.calls.length).toBeLessThanOrEqual(10);
  });
});

describe("asset discovery upsert", () => {
  async function connectWith(pages: unknown[]) {
    const state = await issueState("t1", "u1");
    graph.appGraphFetch.mockResolvedValueOnce({ access_token: "S" }).mockResolvedValueOnce({ access_token: "L" });
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "debug_token") return { data: { is_valid: true, user_id: "9", scopes: [], expires_at: 0 } };
      if (req.path === "me/accounts") return { data: pages };
      return { data: [] };
    });
    db.metaConnection.upsert.mockResolvedValue({ id: "c1" });
    await completeConnect(actor, "code", state);
  }

  it("seals page tokens, links Instagram, and marks missing assets inactive", async () => {
    await connectWith([{ id: "p1", name: "Page", access_token: "PAGETOK", instagram_business_account: { id: "ig1", username: "shop" } }]);
    const upserts = db.metaAsset.upsert.mock.calls.map((c) => c[0]);
    const page = upserts.find((u) => u.create.type === "page");
    expect(page.where).toEqual({ tenantId_type_externalId: { tenantId: "t1", type: "page", externalId: "p1" } });
    expect(page.create.tokenEnc).not.toContain("PAGETOK");
    expect(openSecret("t1", page.create.tokenEnc)).toBe("PAGETOK");
    expect(upserts.some((u) => u.create.type === "instagram" && u.create.meta.pageId === "p1")).toBe(true);
    const inactive = db.metaAsset.updateMany.mock.calls.map((c) => c[0]).find((c) => c.where.type === "page");
    expect(inactive.where).toMatchObject({ tenantId: "t1", connectionId: "c1", externalId: { notIn: ["p1"] } });
    expect(inactive.data).toEqual({ status: "inactive" });
  });

  it("does not mark assets inactive for a type whose listing failed", async () => {
    const state = await issueState("t1", "u1");
    graph.appGraphFetch.mockResolvedValueOnce({ access_token: "S" }).mockResolvedValueOnce({ access_token: "L" });
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "debug_token") return { data: { is_valid: true, user_id: "9", scopes: [], expires_at: 0 } };
      if (req.path === "me/accounts") throw new GraphError("boom", 500);
      return { data: [] };
    });
    db.metaConnection.upsert.mockResolvedValue({ id: "c1" });
    await completeConnect(actor, "code", state);
    const types = db.metaAsset.updateMany.mock.calls.map((c) => c[0].where.type);
    expect(types).not.toContain("page");
    expect(types).toContain("ad_account");
  });
});

describe("page leadgen subscription", () => {
  const pageRow = { id: "p1", name: "Page", access_token: "PAGETOK" };

  async function connectWith(opts: { subscribe: () => unknown; existingMeta?: unknown; pages?: unknown[] }) {
    const state = await issueState("t1", "u1");
    graph.appGraphFetch.mockResolvedValueOnce({ access_token: "S" }).mockResolvedValueOnce({ access_token: "L" });
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "debug_token") return { data: { is_valid: true, user_id: "9", scopes: [], expires_at: 0 } };
      if (req.path === "me/accounts") return { data: opts.pages ?? [pageRow] };
      if (req.path.endsWith("/subscribed_apps")) return opts.subscribe();
      return { data: [] };
    });
    db.metaAsset.findMany.mockResolvedValue(opts.existingMeta ? [{ externalId: "p1", meta: opts.existingMeta }] : []);
    db.metaConnection.upsert.mockResolvedValue({ id: "c1" });
    await completeConnect(actor, "code", state);
  }
  const subscribeCalls = () => graph.graphFetchAs.mock.calls.filter((c) => String(c[1].path).endsWith("/subscribed_apps"));
  const savedMeta = (externalId = "p1") => {
    const writes = db.metaAsset.updateMany.mock.calls.map((c) => c[0]).filter((c) => c.where.type === "page" && c.where.externalId === externalId && c.data.meta);
    return writes[writes.length - 1]?.data.meta;
  };

  it("subscribes the Page to leadgen with its own page token and records the result in the asset meta", async () => {
    await connectWith({ subscribe: () => ({ success: true }) });
    const [token, req] = subscribeCalls()[0];
    expect(token).toBe("PAGETOK");
    expect(req).toMatchObject({ path: "p1/subscribed_apps", method: "POST", query: { subscribed_fields: "leadgen" } });
    expect(savedMeta().leadgenSubscription.status).toBe("subscribed");
    expect(savedMeta().tasks).toEqual([]);
  });

  it("saves the assets before subscribing, with a pending status, so a hung Meta cannot lose the discovery", async () => {
    const order: string[] = [];
    db.metaAsset.upsert.mockImplementation(async (a: { create: { type: string; meta: { leadgenSubscription?: { status: string } } } }) => {
      if (a.create.type === "page") order.push(`upsert:${a.create.meta.leadgenSubscription?.status}`);
    });
    await connectWith({
      subscribe: () => {
        order.push("subscribe");
        return { success: true };
      },
    });
    expect(order).toEqual(["upsert:pending", "subscribe"]);
  });

  it("records a failure without failing the connection or leaking Meta's message", async () => {
    await connectWith({
      subscribe: () => {
        throw new GraphError("secret detail PAGETOK", 400, 200);
      },
    });
    expect(savedMeta().leadgenSubscription).toMatchObject({ status: "failed", reason: "Meta refused the subscription (error 200)." });
    expect(JSON.stringify(savedMeta())).not.toContain("PAGETOK");
    expect(db.metaConnection.upsert).toHaveBeenCalled();
  });

  it("treats a response without success true as not subscribed", async () => {
    await connectWith({ subscribe: () => ({}) });
    expect(savedMeta().leadgenSubscription.status).toBe("failed");
  });

  it("retries a failed subscription on the next discovery", async () => {
    await connectWith({ subscribe: () => ({ success: true }), existingMeta: { leadgenSubscription: { status: "failed", at: "x" } } });
    expect(subscribeCalls()).toHaveLength(1);
    expect(savedMeta().leadgenSubscription.status).toBe("subscribed");
  });

  const HOUR = 3_600_000;
  const subscribedAt = (hoursAgo: number, extra: Record<string, unknown> = {}) => ({ leadgenSubscription: { status: "subscribed", at: new Date(Date.now() - hoursAgo * HOUR).toISOString(), ...extra } });
  const listing = (fields: string[] = ["leadgen"]) => ({ data: [{ id: "123", subscribed_fields: fields }] });
  const getCalls = () => subscribeCalls().filter((c) => c[1].method !== "POST");
  const postCalls = () => subscribeCalls().filter((c) => c[1].method === "POST");

  it("does not call Meta for a Page whose subscription was confirmed in the last 24 hours", async () => {
    await connectWith({ subscribe: () => ({ success: true }), existingMeta: subscribedAt(2) });
    expect(subscribeCalls()).toHaveLength(0);
    expect(verificationDue(subscribedAt(23).leadgenSubscription as never)).toBe(false);
    expect(verificationDue(subscribedAt(25).leadgenSubscription as never)).toBe(true);
    expect(verificationDue(subscribedAt(30, { verifiedAt: new Date().toISOString() }).leadgenSubscription as never)).toBe(false);
  });

  it("reads back a stored subscribed status older than 24 hours with GET subscribed_apps and keeps it when Meta still lists the app", async () => {
    await connectWith({ subscribe: () => listing(), existingMeta: subscribedAt(30) });
    expect(getCalls()).toHaveLength(1);
    expect(getCalls()[0][0]).toBe("PAGETOK");
    expect(getCalls()[0][1].path).toBe("p1/subscribed_apps");
    expect(postCalls()).toHaveLength(0);
    expect(savedMeta().leadgenSubscription.status).toBe("subscribed");
    expect(Date.now() - Date.parse(savedMeta().leadgenSubscription.verifiedAt)).toBeLessThan(60_000);
  });

  it("sets a subscription that Meta no longer lists back to pending and then subscribes it again", async () => {
    const written: string[] = [];
    db.metaAsset.updateMany.mockImplementation(async (a: { data: { meta?: { leadgenSubscription: { status: string } } } }) => {
      if (a.data.meta) written.push(a.data.meta.leadgenSubscription.status);
      return { count: 1 };
    });
    let n = 0;
    await connectWith({ subscribe: () => (n++ === 0 ? listing(["messages"]) : { success: true }), existingMeta: subscribedAt(30) });
    expect(written).toEqual(["pending", "subscribed"]);
    expect(postCalls()).toHaveLength(1);
  });

  it("treats an app missing from the list, or listed without leadgen, as missing and an unreadable answer as unknown", async () => {
    const answer = (v: unknown) => {
      graph.graphFetchAs.mockResolvedValueOnce(v);
      return checkPageSubscription("p1", "PAGETOK");
    };
    expect(await answer(listing())).toBe("subscribed");
    expect(await answer({ data: [{ id: "999", subscribed_fields: ["leadgen"] }] })).toBe("missing");
    expect(await answer(listing(["feed"]))).toBe("missing");
    expect(await answer({ data: [] })).toBe("missing");
    expect(await answer({})).toBe("unknown");
    graph.graphFetchAs.mockRejectedValueOnce(new GraphError("x", 500));
    expect(await checkPageSubscription("p1", "PAGETOK")).toBe("unknown");
    delete process.env.META_APP_ID;
    expect(await answer(listing())).toBe("unknown");
  });

  it("changes nothing when the read-back fails, so an outage cannot reset a working subscription", async () => {
    await connectWith({
      subscribe: () => {
        throw new GraphError("down", 500);
      },
      existingMeta: subscribedAt(30),
    });
    expect(postCalls()).toHaveLength(0);
    expect(savedMeta()).toBeUndefined();
  });

  it("subscribes on a refresh too", async () => {
    // First lookup is the tenant's own connection; later lookups ask whether it was revoked meanwhile (no).
    db.metaConnection.findFirst.mockResolvedValueOnce({ id: "c1", tenantId: "t1", status: "active", tokenEnc: sealSecret("t1", "USERTOK") }).mockResolvedValue(null);
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "debug_token") return { data: { is_valid: true, user_id: "9", scopes: [], expires_at: 0 } };
      if (req.path === "me/accounts") return { data: [pageRow] };
      if (req.path.endsWith("/subscribed_apps")) return { success: true };
      return { data: [] };
    });
    await refreshConnection(actor, "c1");
    expect(subscribeCalls()).toHaveLength(1);
  });

  const manyPages = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, access_token: `T${i}` }));

  it("caps calls per run and leaves the rest pending", async () => {
    const found = manyPages(MAX_LEADGEN_SUBSCRIBES + 5);
    await connectWith({ subscribe: () => ({ success: true }), pages: found });
    expect(subscribeCalls()).toHaveLength(MAX_LEADGEN_SUBSCRIBES);
    const saved = db.metaAsset.upsert.mock.calls.map((c) => c[0]).filter((u) => u.create.type === "page");
    expect(saved).toHaveLength(found.length);
    expect(saved.every((u) => u.create.meta.leadgenSubscription.status === "pending")).toBe(true);
  });

  it("tries Pages never attempted first, so persistent failures cannot starve the ones beyond the cap", () => {
    const pages = [{ id: "failedOld" }, { id: "never" }, { id: "pending" }, { id: "failedNew" }];
    const prev = new Map([
      ["failedOld", { status: "failed" as const, at: "2026-01-01T00:00:00.000Z" }],
      ["pending", { status: "pending" as const, at: "2026-05-01T00:00:00.000Z" }],
      ["failedNew", { status: "failed" as const, at: "2026-03-01T00:00:00.000Z" }],
    ]);
    expect(orderForSubscribe(pages, prev).map((p) => p.id)).toEqual(["never", "pending", "failedOld", "failedNew"]);
  });

  it("does not wait for a hung Meta beyond the time budget and still saves every asset", async () => {
    graph.graphFetchAs.mockImplementation((_t: string, req: { path: string }) => {
      if (req.path === "me/accounts") return Promise.resolve({ data: manyPages(8) });
      if (req.path.endsWith("/subscribed_apps")) return new Promise(() => undefined);
      return Promise.resolve({ data: [] });
    });
    const started = Date.now();
    const result = await discoverAssets("t1", "c1", "USERTOK", { subscribeBudgetMs: 60, subscribeCallTimeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.counts.page).toBe(8);
    expect(db.metaAsset.upsert.mock.calls.filter((c) => c[0].create.type === "page")).toHaveLength(8);
    const statuses = db.metaAsset.updateMany.mock.calls.map((c) => c[0]).filter((c) => c.data.meta).map((c) => c.data.meta.leadgenSubscription.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((x) => x === "failed")).toBe(true);
  });
});

describe("getAssetAccess and listAssets", () => {
  const asset = (over: Record<string, unknown> = {}, conn: Record<string, unknown> = {}) => ({
    id: "a1",
    tenantId: "t1",
    type: "page",
    externalId: "p1",
    name: "Page",
    status: "active",
    tokenEnc: sealSecret("t1", "PAGETOK"),
    connection: { tenantId: "t1", status: "active", tokenExpiresAt: null, tokenEnc: sealSecret("t1", "USERTOK"), ...conn },
    ...over,
  });

  it("scopes the lookup by tenant and returns 404 for another tenant's asset", async () => {
    db.metaAsset.findFirst.mockResolvedValue(null);
    await expect(getAssetAccess("t2", "a1")).rejects.toMatchObject({ status: 404 });
    expect(db.metaAsset.findFirst.mock.calls[0][0].where).toEqual({ id: "a1", tenantId: "t2" });
  });

  it("returns the page token for the tenant's asset", async () => {
    db.metaAsset.findFirst.mockResolvedValue(asset());
    expect(await getAssetAccess("t1", "a1")).toMatchObject({ assetId: "a1", externalId: "p1", token: "PAGETOK" });
  });

  it("falls back to the connection token for assets without their own", async () => {
    db.metaAsset.findFirst.mockResolvedValue(asset({ type: "ad_account", tokenEnc: null }));
    expect((await getAssetAccess("t1", "a1")).token).toBe("USERTOK");
  });

  it("returns 409 for expired, revoked or lapsed connections and inactive assets", async () => {
    for (const conn of [{ status: "expired" }, { status: "revoked" }, { tokenExpiresAt: new Date(Date.now() - 1000) }]) {
      db.metaAsset.findFirst.mockResolvedValue(asset({}, conn));
      await expect(getAssetAccess("t1", "a1")).rejects.toMatchObject({ status: 409 });
    }
    db.metaAsset.findFirst.mockResolvedValue(asset({ status: "inactive" }));
    await expect(getAssetAccess("t1", "a1")).rejects.toMatchObject({ status: 409 });
  });

  it("listAssets filters by tenant and never selects tokens", async () => {
    db.metaAsset.findMany.mockResolvedValue([]);
    await listAssets("t1", "page");
    const arg = db.metaAsset.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: "t1", type: "page" });
    expect(arg.select.tokenEnc).toBeUndefined();
  });
});

describe("health and disconnect", () => {
  it("classifies expiry", () => {
    const now = 1_000_000_000_000;
    expect(healthStatus({ valid: false, expiresAt: null }, now)).toBe("expired");
    expect(healthStatus({ valid: true, expiresAt: null }, now)).toBe("active");
    expect(healthStatus({ valid: true, expiresAt: new Date(now - 1) }, now)).toBe("expired");
    expect(healthStatus({ valid: true, expiresAt: new Date(now + 86_400_000) }, now)).toBe("expiring");
    expect(healthStatus({ valid: true, expiresAt: new Date(now + 30 * 86_400_000) }, now)).toBe("active");
  });

  it("worker flags expiring and expired connections, and treats error 190 as expired", async () => {
    const mk = (id: string) => ({ id, tenantId: "t1", status: "active", scopes: [], tokenEnc: sealSecret("t1", `tok-${id}`) });
    db.metaConnection.findMany.mockResolvedValue([mk("a"), mk("b"), mk("c")]);
    db.metaConnection.updateMany.mockResolvedValue({ count: 1 });
    const soon = Math.floor(Date.now() / 1000) + 86_400;
    graph.graphFetchAs.mockImplementation(async (_app: string, req: { query: { input_token: string } }) => {
      const t = req.query.input_token;
      if (t === "tok-a") return { data: { is_valid: true, scopes: ["x"], expires_at: soon } };
      if (t === "tok-b") return { data: { is_valid: false } };
      throw new GraphError("invalid", 400, 190);
    });
    expect(await checkTokenHealth()).toBe(3);
    const statuses = db.metaConnection.updateMany.mock.calls.map((c) => c[0].data.status);
    expect(statuses).toEqual(["expiring", "expired", "expired"]);
    expect(db.metaConnection.updateMany.mock.calls.every((c) => c[0].where.tenantId === "t1")).toBe(true);
  });

  const conn = (over: Record<string, unknown> = {}) => ({ id: "c1", tenantId: "t1", metaUserId: "9", tokenEnc: sealSecret("t1", "TOK"), ...over });
  const permissionCalls = () => graph.graphFetchAs.mock.calls.filter((c) => String(c[1].path).endsWith("/permissions"));

  it("disconnect revokes at Meta, deletes tokens, deactivates assets and audits, even if Meta fails", async () => {
    db.metaConnection.findFirst.mockResolvedValue(conn());
    graph.graphFetchAs.mockRejectedValue(new GraphError("nope", 400));
    const result = await disconnect(actor, "c1");
    expect(result).toMatchObject({ revokedAtMeta: false, skippedSharedUser: false });
    expect(db.metaConnection.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1" });
    const assetWrites = db.metaAsset.updateMany.mock.calls.map((c) => c[0].data);
    expect(assetWrites[0]).toEqual({ status: "inactive" });
    expect(assetWrites).toContainEqual({ tokenEnc: null });
    const connWrites = db.metaConnection.updateMany.mock.calls.map((c) => c[0].data);
    expect(connWrites[0]).toEqual({ status: "revoked" });
    expect(connWrites).toContainEqual(expect.objectContaining({ tokenEnc: "" }));
    expect(db.auditLog.create.mock.calls[0][0].data.action).toBe("meta_connect.disconnected");
  });

  it("revokes at Meta when no other usable connection uses the same Meta user", async () => {
    db.metaConnection.findFirst.mockResolvedValue(conn());
    graph.graphFetchAs.mockResolvedValue({ success: true });
    const result = await disconnect(actor, "c1");
    expect(result).toMatchObject({ revokedAtMeta: true, skippedSharedUser: false });
    expect(permissionCalls()[0][1]).toMatchObject({ path: "9/permissions", method: "DELETE" });
  });

  it("looks for other live connections only after this one is revoked, inside one transaction, after a FOR UPDATE row lock on the Meta user's connections", async () => {
    const order: string[] = [];
    db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      order.push("lock");
      expect(strings.join("?")).toMatch(/FROM "MetaConnection" WHERE "metaUserId" = \? ORDER BY "id" FOR UPDATE/);
      expect(values).toEqual(["9"]);
      return [];
    });
    db.metaConnection.updateMany.mockImplementation(async () => void order.push("revoke-self"));
    db.metaConnection.findMany.mockImplementation(async () => {
      order.push("count-others");
      return [];
    });
    db.metaConnection.findFirst.mockResolvedValue(conn());
    graph.graphFetchAs.mockResolvedValue({ success: true });
    await disconnect(actor, "c1");
    expect(order.slice(0, 3)).toEqual(["lock", "revoke-self", "count-others"]);
    expect(db.$transaction.mock.calls[0][0]).toBeTypeOf("function");
  });

  it("two workspaces disconnecting the same Meta user at once cannot both skip the revoke", async () => {
    const run = async (lock: boolean) => {
      const committed = [
        { id: "c1", tenantId: "t1", metaUserId: "9", status: "active" },
        { id: "c2", tenantId: "t2", metaUserId: "9", status: "active" },
      ];
      let tail: Promise<void> = Promise.resolve();
      db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged: string[] = [];
        let release = () => {};
        const tx = {
          ...db,
          $queryRaw: async () => {
            if (!lock) return [];
            const before = tail;
            tail = new Promise<void>((r) => (release = r));
            await before;
            return [];
          },
          metaConnection: {
            ...db.metaConnection,
            updateMany: async ({ where }: { where: { id: string } }) => void staged.push(where.id),
            findMany: async ({ where }: { where: { id: { not: string }; status: { in: string[] } } }) =>
              committed.filter((r) => r.id !== where.id.not && where.status.in.includes(r.status)).map((r) => ({ tenantId: r.tenantId, metaUserId: r.metaUserId })),
          },
        };
        try {
          return await fn(tx);
        } finally {
          for (const id of staged) committed.find((r) => r.id === id)!.status = "revoked";
          release();
        }
      });
      db.metaConnection.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
        const tenantId = where.id === "c1" ? "t1" : "t2";
        return conn({ id: where.id, tenantId, tokenEnc: sealSecret(tenantId, "TOK") });
      });
      db.tenant.findMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
      graph.graphFetchAs.mockResolvedValue({ success: true });
      graph.graphFetchAs.mockClear();
      const [a, b] = await Promise.all([disconnect(actor, "c1"), disconnect({ ...actor, tenantId: "t2" }, "c2")]);
      return { revoked: [a.revokedAtMeta, b.revokedAtMeta].filter(Boolean).length, calls: permissionCalls().length };
    };
    expect(await run(true)).toEqual({ revoked: 1, calls: 1 });
    expect(await run(false)).toEqual({ revoked: 0, calls: 0 });
  });

  it("skips the DELETE permissions call when the same Meta user is live in another active workspace, but still clears this one", async () => {
    db.metaConnection.findFirst.mockResolvedValue(conn());
    db.metaConnection.findMany.mockResolvedValue([{ tenantId: "t2", metaUserId: "9" }]);
    db.tenant.findMany.mockResolvedValue([{ id: "t2" }]);
    const result = await disconnect(actor, "c1");
    expect(result).toMatchObject({ revokedAtMeta: false, skippedSharedUser: true });
    expect(permissionCalls()).toHaveLength(0);
    expect(db.metaConnection.updateMany.mock.calls[0][0].data).toEqual({ status: "revoked" });
    expect(db.metaConnection.updateMany.mock.calls.map((c) => c[0].data)).toContainEqual(expect.objectContaining({ tokenEnc: "" }));
    expect(db.metaAsset.updateMany.mock.calls.map((c) => c[0].data)).toEqual([{ status: "inactive" }, { tokenEnc: null }]);
    expect(db.auditLog.create.mock.calls[0][0].data.meta).toMatchObject({ revokedAtMeta: false, skippedSharedUser: true });
  });

  it("ignores expired, errored and unusable connections and suspended or deleted workspaces when deciding whether the user is shared", async () => {
    db.metaConnection.findFirst.mockResolvedValue(conn());
    db.metaConnection.findMany.mockResolvedValue([{ tenantId: "t9", metaUserId: "9" }]);
    db.tenant.findMany.mockResolvedValue([]);
    graph.graphFetchAs.mockResolvedValue({ success: true });
    const result = await disconnect(actor, "c1");
    expect(result.skippedSharedUser).toBe(false);
    expect(permissionCalls()).toHaveLength(1);
    const where = db.metaConnection.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ metaUserId: { in: ["9"] }, id: { not: "c1" }, status: { in: ["active", "expiring"] }, tokenEnc: { not: "" } });
    expect(where.OR).toEqual([{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: expect.any(Date) } }]);
    expect(db.tenant.findMany.mock.calls[0][0].where).toMatchObject({ id: { in: ["t9"] }, status: "active", deletedAt: null });
  });

  it("removes the lead-alert subscription of each Page at Meta before the user revoke, and clears the stored status", async () => {
    db.metaConnection.findFirst.mockResolvedValue(conn());
    db.metaAsset.findMany.mockResolvedValueOnce([
      { id: "a1", externalId: "p1", status: "active", tokenEnc: sealSecret("t1", "PAGETOK"), meta: { tasks: ["MANAGE"], leadgenSubscription: { status: "subscribed", at: "x" } } },
    ]);
    graph.graphFetchAs.mockResolvedValue({ success: true });
    const result = await disconnect(actor, "c1");
    const del = graph.graphFetchAs.mock.calls.find((c) => c[1].path === "p1/subscribed_apps")!;
    expect(del[0]).toBe("PAGETOK");
    expect(del[1].method).toBe("DELETE");
    expect(result).toMatchObject({ pagesUnsubscribed: 1, pagesUnsubscribeFailed: 0 });
    const cleared = db.metaAsset.updateMany.mock.calls.map((c) => c[0]).find((c) => c.where.id === "a1");
    expect(cleared.data.meta).toEqual({ tasks: ["MANAGE"] });
    const order = graph.graphFetchAs.mock.calls.map((c) => c[1].path);
    expect(order.indexOf("p1/subscribed_apps")).toBeLessThan(order.indexOf("9/permissions"));
  });

  it("keeps the Page subscription when another active workspace uses the same Page, and counts failures", async () => {
    db.metaConnection.findFirst.mockResolvedValue(conn());
    const page = (id: string) => ({ id: `a-${id}`, externalId: id, status: "active", tokenEnc: sealSecret("t1", `TOK-${id}`), meta: {} });
    db.metaAsset.findMany.mockResolvedValueOnce([page("shared"), page("mine"), page("broken")]).mockResolvedValueOnce([{ tenantId: "t2", externalId: "shared" }]);
    db.tenant.findMany.mockResolvedValue([{ id: "t2" }]);
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "broken/subscribed_apps") throw new GraphError("x", 400);
      return { success: true };
    });
    const result = await disconnect(actor, "c1");
    const paths = graph.graphFetchAs.mock.calls.map((c) => c[1].path);
    expect(paths).not.toContain("shared/subscribed_apps");
    expect(paths).toContain("mine/subscribed_apps");
    expect(result).toMatchObject({ pagesUnsubscribed: 1, pagesUnsubscribeFailed: 1, pagesKeptForOtherWorkspace: 1 });
  });

  it("clears the stored subscription status so a reconnect subscribes again", async () => {
    db.metaConnection.findFirst.mockResolvedValue(conn());
    db.metaAsset.findMany.mockResolvedValueOnce([{ id: "a1", externalId: "p1", status: "active", tokenEnc: sealSecret("t1", "PAGETOK"), meta: { leadgenSubscription: { status: "subscribed", at: "x" } } }]);
    graph.graphFetchAs.mockResolvedValue({ success: true });
    await disconnect(actor, "c1");
    const cleared = db.metaAsset.updateMany.mock.calls.map((c) => c[0]).find((c) => c.where.id === "a1");
    expect(cleared.data.meta.leadgenSubscription).toBeUndefined();
  });

  it("listConnections flags a Meta user live in another active workspace without exposing which one, and unused scopes", async () => {
    db.metaConnection.findMany
      .mockResolvedValueOnce([
        { id: "c1", metaUserId: "9", scopes: ["pages_manage_engagement", "public_profile"], status: "active", assets: [] },
        { id: "c2", metaUserId: "10", scopes: [], status: "active", assets: [] },
      ])
      .mockResolvedValueOnce([
        { tenantId: "t2", metaUserId: "9" },
        { tenantId: "t3", metaUserId: "10" },
      ]);
    db.tenant.findMany.mockResolvedValue([{ id: "t2" }]);
    const rows = await listConnections("t1");
    expect(rows.map((r) => r.sharedWithOtherWorkspace)).toEqual([true, false]);
    expect(rows[0].unusedScopes).toEqual(["pages_manage_engagement"]);
    expect(db.metaConnection.findMany.mock.calls[1][0]).toMatchObject({ where: { tenantId: { not: "t1" } }, select: { tenantId: true, metaUserId: true } });
  });

  it("disconnect of another tenant's connection is 404", async () => {
    db.metaConnection.findFirst.mockResolvedValue(null);
    await expect(disconnect({ ...actor, tenantId: "t2" }, "c1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("scopes", () => {
  it("lists scopes once and includes the phase A set", () => {
    expect(new Set(META_CONNECT_SCOPES).size).toBe(META_CONNECT_SCOPES.length);
    expect(META_CONNECT_SCOPES).toEqual(expect.arrayContaining(["ads_management", "leads_retrieval", "pages_show_list", "pages_manage_metadata"]));
  });

  it("does not request permissions no code uses", () => {
    expect(META_CONNECT_SCOPES).not.toContain("pages_manage_engagement");
    expect(Object.keys(SCOPE_PURPOSES).sort()).toEqual([...META_CONNECT_SCOPES].sort());
  });

  it("flags granted permissions the app does not use, ignoring the baseline ones", () => {
    expect(unusedScopes(["pages_show_list", "pages_manage_engagement", "public_profile", "email"])).toEqual(["pages_manage_engagement"]);
    expect(unusedScopes([...META_CONNECT_SCOPES])).toEqual([]);
  });
});

describe("lead subscription rotation, concurrency and health verification", () => {
  const pagesOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, access_token: `T${i}` }));
  const isSub = (req: { path: string }) => req.path.endsWith("/subscribed_apps");

  it("runs at most 4 subscriptions at once inside a 60 second budget", async () => {
    expect(SUBSCRIBE_CONCURRENCY).toBe(4);
    expect(SUBSCRIBE_BUDGET_MS).toBe(60_000);
    let inFlight = 0;
    let peak = 0;
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "me/accounts") return { data: pagesOf(12) };
      if (!isSub(req)) return { data: [] };
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { success: true };
    });
    await discoverAssets("t1", "c1", "USERTOK");
    expect(peak).toBe(4);
  });

  it("rotates the 50 Page cap: Pages that failed move behind Pages never attempted, so persistent failures cannot starve them", async () => {
    const total = MAX_LEADGEN_SUBSCRIBES + 5;
    const posted: string[][] = [];
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "me/accounts") return { data: pagesOf(total) };
      if (isSub(req)) {
        posted[posted.length - 1].push(req.path.split("/")[0]);
        throw new GraphError("no", 400, 200);
      }
      return { data: [] };
    });
    posted.push([]);
    await discoverAssets("t1", "c1", "USERTOK");
    expect(posted[0]).toHaveLength(MAX_LEADGEN_SUBSCRIBES);
    const stored = new Map<string, { status: string; at: string }>();
    for (const c of db.metaAsset.upsert.mock.calls.map((x) => x[0])) if (c.create.type === "page") stored.set(c.create.externalId, c.create.meta.leadgenSubscription);
    for (const c of db.metaAsset.updateMany.mock.calls.map((x) => x[0])) if (c.data.meta) stored.set(c.where.externalId, c.data.meta.leadgenSubscription);
    expect([...stored.values()].filter((v) => v.status === "failed")).toHaveLength(MAX_LEADGEN_SUBSCRIBES);
    expect(stored.get("p0")!.at).toMatch(/^\d{4}-/);

    db.metaAsset.findMany.mockResolvedValue([...stored].map(([externalId, leadgenSubscription]) => ({ externalId, meta: { leadgenSubscription } })));
    posted.push([]);
    await discoverAssets("t1", "c1", "USERTOK");
    expect(posted[1]).toHaveLength(MAX_LEADGEN_SUBSCRIBES);
    for (let i = MAX_LEADGEN_SUBSCRIBES; i < total; i++) expect(posted[1]).toContain(`p${i}`);
  });

  const pageAsset = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    externalId: "p1",
    tokenEnc: sealSecret("t1", "PAGETOK"),
    meta: { tasks: ["MANAGE"], leadgenSubscription: { status: "subscribed", at: new Date(Date.now() - 30 * 3_600_000).toISOString() } },
    ...over,
  });
  const metaSaved = () => db.metaAsset.updateMany.mock.calls.map((c) => c[0]).filter((c) => c.data.meta);

  it("verifyLeadSubscriptions resets a Page Meta no longer lists to pending, keeping the rest of its meta", async () => {
    db.metaAsset.findMany.mockResolvedValue([pageAsset()]);
    graph.graphFetchAs.mockResolvedValue({ data: [{ id: "999", subscribed_fields: ["leadgen"] }] });
    const result = await verifyLeadSubscriptions("t1", "c1");
    expect(result).toEqual({ checked: 1, reset: 1 });
    expect(db.metaAsset.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", connectionId: "c1", type: "page" });
    const saved = metaSaved()[0];
    expect(saved.where).toEqual({ id: "a1", tenantId: "t1", status: "active" });
    expect(saved.data.meta.tasks).toEqual(["MANAGE"]);
    expect(saved.data.meta.leadgenSubscription).toMatchObject({ status: "pending" });
    expect(graph.graphFetchAs.mock.calls.every((c) => c[1].method !== "POST")).toBe(true);
  });

  it("verifyLeadSubscriptions records the confirmation time, skips Pages confirmed within 24 hours, and ignores inconclusive answers", async () => {
    const fresh = pageAsset({ id: "a2", externalId: "p2", meta: { leadgenSubscription: { status: "subscribed", at: new Date().toISOString() } } });
    const pending = pageAsset({ id: "a3", externalId: "p3", meta: { leadgenSubscription: { status: "pending", at: "x" } } });
    db.metaAsset.findMany.mockResolvedValue([pageAsset(), fresh, pending]);
    graph.graphFetchAs.mockResolvedValue({ data: [{ id: "123", subscribed_fields: ["leadgen"] }] });
    expect(await verifyLeadSubscriptions("t1", "c1")).toEqual({ checked: 1, reset: 0 });
    expect(graph.graphFetchAs.mock.calls.map((c) => c[1].path)).toEqual(["p1/subscribed_apps"]);
    expect(metaSaved()[0].data.meta.leadgenSubscription).toMatchObject({ status: "subscribed", verifiedAt: expect.any(String) });

    db.metaAsset.updateMany.mockClear();
    graph.graphFetchAs.mockRejectedValue(new GraphError("down", 500));
    expect(await verifyLeadSubscriptions("t1", "c1")).toEqual({ checked: 1, reset: 0 });
    expect(metaSaved()).toHaveLength(0);
  });

  it("the health worker verifies Pages of a usable connection once debug_token passes, and not for an expired one", async () => {
    const mk = (id: string) => ({ id, tenantId: "t1", status: "active", scopes: [], tokenEnc: sealSecret("t1", `tok-${id}`) });
    db.metaConnection.findMany.mockResolvedValue([mk("good"), mk("dead")]);
    db.metaAsset.findMany.mockResolvedValue([pageAsset()]);
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string; query?: { input_token?: string } }) => {
      if (req.path === "debug_token") return { data: { is_valid: req.query?.input_token === "tok-good", scopes: [], expires_at: 0 } };
      return { data: [] };
    });
    await checkTokenHealth();
    expect(db.metaAsset.findMany.mock.calls.map((c) => c[0].where.connectionId)).toEqual(["good"]);
    expect(metaSaved()[0].data.meta.leadgenSubscription.status).toBe("pending");
  });
});

describe("granted scopes in the connection summary", () => {
  it("lists what debug_token reports, what is missing and what is unexpected, and says the code does not control it", () => {
    const summary = scopeSummary(["pages_show_list", "pages_manage_engagement", "public_profile"]);
    expect(summary.source).toBe("debug_token");
    expect(summary.granted).toEqual(["pages_manage_engagement", "pages_show_list", "public_profile"]);
    expect(summary.unexpected).toEqual(["pages_manage_engagement"]);
    expect(summary.missing).toContain("ads_management");
    expect(summary.missing).not.toContain("pages_show_list");
    expect(summary.note).toMatch(/Login for Business configuration/);
    expect(scopeSummary(["ads_management"], true)).toMatchObject({ granted: [], missing: [], unexpected: [] });
  });

  it("listConnections carries the summary and refresh stores the scopes Meta reports", async () => {
    db.metaConnection.findMany.mockResolvedValueOnce([{ id: "c1", metaUserId: "9", scopes: ["pages_show_list", "pages_manage_engagement"], status: "active", assets: [] }]).mockResolvedValueOnce([]);
    const rows = await listConnections("t1");
    expect(rows[0].scopeSummary).toMatchObject({ unexpected: ["pages_manage_engagement"], granted: ["pages_manage_engagement", "pages_show_list"] });

    db.metaConnection.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1", status: "active", tokenEnc: sealSecret("t1", "USERTOK") });
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) =>
      req.path === "debug_token" ? { data: { is_valid: true, user_id: "9", scopes: ["pages_show_list", "ads_management"], expires_at: 0 } } : { data: [] },
    );
    await refreshConnection(actor, "c1");
    expect(db.metaConnection.updateMany.mock.calls[0][0].data.scopes).toEqual(["pages_show_list", "ads_management"]);
  });
});

describe("discovery time budget, disconnect races and durable disconnect", () => {
  const pagesOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, access_token: `T${i}` }));
  const isSub = (req: { path: string }) => req.path.endsWith("/subscribed_apps");
  const subCalls = (method?: string) => graph.graphFetchAs.mock.calls.filter((c) => isSub(c[1]) && (!method || (c[1].method ?? "GET") === method));
  const conn = (over: Record<string, unknown> = {}) => ({ id: "c1", tenantId: "t1", metaUserId: "9", tokenEnc: sealSecret("t1", "USERTOK"), ...over });
  const permissionCalls = () => graph.graphFetchAs.mock.calls.filter((c) => String(c[1].path).endsWith("/permissions"));
  const page = (id: string, over: Record<string, unknown> = {}) => ({ id: `a-${id}`, externalId: id, status: "active", tokenEnc: sealSecret("t1", `TOK-${id}`), meta: {}, ...over });

  it("runPool is a hard stop: items still running at the deadline are abandoned, not waited for", async () => {
    const started = Date.now();
    const begun = await runPool([1, 2, 3, 4, 5, 6], 4, Date.now() + 60, () => new Promise<void>(() => undefined));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(begun).toBe(4);
  });

  it("discovery returns at the budget even when a request would be allowed to run much longer (no 6s read-back plus 6s subscribe overshoot)", async () => {
    graph.graphFetchAs.mockImplementation((_t: string, req: { path: string }) => {
      if (req.path === "me/accounts") return Promise.resolve({ data: pagesOf(6) });
      if (isSub(req)) return new Promise(() => undefined);
      return Promise.resolve({ data: [] });
    });
    const started = Date.now();
    await discoverAssets("t1", "c1", "USERTOK", { subscribeBudgetMs: 80, subscribeCallTimeoutMs: 30_000 });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("counts the listing calls against the same budget, so a slow listing leaves no time to subscribe", async () => {
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "me/accounts") {
        await new Promise((r) => setTimeout(r, 120));
        return { data: pagesOf(3) };
      }
      return isSub(req) ? { success: true } : { data: [] };
    });
    const result = await discoverAssets("t1", "c1", "USERTOK", { subscribeBudgetMs: 60 });
    expect(result.counts.page).toBe(3);
    expect(subCalls()).toHaveLength(0);
  });

  it("the OAuth callback and a refresh use a budget below the 60 second proxy timeout", () => {
    expect(REQUEST_DISCOVERY_BUDGET_MS).toBeLessThan(SUBSCRIBE_BUDGET_MS);
  });

  it("does not subscribe a Page of a connection that was disconnected while discovery ran", async () => {
    db.metaConnection.findFirst.mockResolvedValue({ id: "c1" });
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => (req.path === "me/accounts" ? { data: pagesOf(2) } : isSub(req) ? { success: true } : { data: [] }));
    await discoverAssets("t1", "c1", "USERTOK");
    expect(subCalls()).toHaveLength(0);
    expect(db.metaConnection.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1", status: "revoked" });
  });

  it("stores a subscription result only for an active asset under a connection that is not revoked", async () => {
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => (req.path === "me/accounts" ? { data: pagesOf(1) } : isSub(req) ? { success: true } : { data: [] }));
    await discoverAssets("t1", "c1", "USERTOK");
    const save = db.metaAsset.updateMany.mock.calls.map((c) => c[0]).find((c) => c.data.meta?.leadgenSubscription?.status === "subscribed");
    expect(save.where).toMatchObject({ tenantId: "t1", connectionId: "c1", type: "page", externalId: "p0", status: "active", connection: { is: { status: { not: "revoked" } } } });
  });

  it("removes a subscription it just created when the store is refused because the connection was disconnected meanwhile", async () => {
    db.metaConnection.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "c1" });
    db.metaAsset.updateMany.mockResolvedValue({ count: 0 });
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => (req.path === "me/accounts" ? { data: pagesOf(1) } : isSub(req) ? { success: true } : { data: [] }));
    await discoverAssets("t1", "c1", "USERTOK");
    expect(subCalls("POST")).toHaveLength(1);
    const del = subCalls("DELETE");
    expect(del).toHaveLength(1);
    expect(del[0][0]).toBe("T0");
  });

  it("leaves it subscribed when another active workspace uses the same Page", async () => {
    db.metaConnection.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "c1" });
    db.metaAsset.updateMany.mockResolvedValue({ count: 0 });
    db.metaAsset.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ tenantId: "t2", externalId: "p0" }]);
    db.tenant.findMany.mockResolvedValue([{ id: "t2" }]);
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => (req.path === "me/accounts" ? { data: pagesOf(1) } : isSub(req) ? { success: true } : { data: [] }));
    await discoverAssets("t1", "c1", "USERTOK");
    expect(subCalls("DELETE")).toHaveLength(0);
  });

  it("refresh keeps the stored scopes when debug_token returns none", async () => {
    db.metaConnection.findFirst.mockResolvedValueOnce({ ...conn(), status: "active", scopes: ["ads_read", "pages_show_list"] }).mockResolvedValue(null);
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => (req.path === "debug_token" ? { data: { is_valid: true, user_id: "9", scopes: [], expires_at: 0 } } : { data: [] }));
    await refreshConnection(actor, "c1");
    expect(db.metaConnection.updateMany.mock.calls[0][0].data.scopes).toEqual(["ads_read", "pages_show_list"]);
  });

  it("disconnect commits the revoked state first, removes the Page subscriptions and the user's authorization at Meta, and only then deletes the tokens", async () => {
    const order: string[] = [];
    db.metaConnection.findFirst.mockResolvedValue(conn());
    db.metaAsset.findMany.mockResolvedValueOnce([page("p1")]);
    db.metaConnection.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      order.push(data.tokenEnc === "" ? "clear-connection-token" : `connection:${String(data.status)}`);
      return { count: 1 };
    });
    db.metaAsset.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      order.push("tokenEnc" in data ? "clear-asset-tokens" : `assets:${String(data.status)}`);
      return { count: 1 };
    });
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string; method?: string }) => {
      order.push(isSub(req) ? "unsubscribe" : "revoke-user");
      return { success: true };
    });
    await disconnect(actor, "c1");
    expect(order).toEqual(["assets:inactive", "connection:revoked", "unsubscribe", "revoke-user", "clear-asset-tokens", "clear-connection-token"]);
  });

  it("removes the subscription of a Page whose asset was already inactive but still holds a token", async () => {
    db.metaConnection.findFirst.mockResolvedValue(conn());
    db.metaAsset.findMany.mockResolvedValueOnce([page("old", { status: "inactive" })]);
    graph.graphFetchAs.mockResolvedValue({ success: true });
    const result = await disconnect(actor, "c1");
    expect(subCalls("DELETE")).toHaveLength(1);
    expect(result.pagesUnsubscribed).toBe(1);
  });

  it("touches nothing at Meta and keeps the tokens when the same Meta user was reconnected before the calls were made", async () => {
    db.metaConnection.findFirst.mockResolvedValueOnce(conn()).mockResolvedValue(null);
    db.metaAsset.findMany.mockResolvedValueOnce([page("p1")]);
    graph.graphFetchAs.mockResolvedValue({ success: true });
    const result = await disconnect(actor, "c1");
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(result).toMatchObject({ revokedAtMeta: false, pagesUnsubscribed: 0 });
    expect(db.metaConnection.updateMany.mock.calls.every((c) => c[0].data.tokenEnc === undefined)).toBe(true);
    expect(db.metaAsset.updateMany.mock.calls.every((c) => !("tokenEnc" in c[0].data))).toBe(true);
  });

  it("clears tokens only on rows that are still revoked and inactive, so a reconnect that lands meanwhile keeps its new token", async () => {
    db.metaConnection.findFirst.mockResolvedValue(conn());
    db.metaAsset.findMany.mockResolvedValueOnce([page("p1")]);
    graph.graphFetchAs.mockResolvedValue({ success: true });
    await disconnect(actor, "c1");
    const assetClear = db.metaAsset.updateMany.mock.calls.map((c) => c[0]).find((c) => "tokenEnc" in c.data);
    expect(assetClear.where).toEqual({ tenantId: "t1", connectionId: "c1", status: "inactive" });
    const connClear = db.metaConnection.updateMany.mock.calls.map((c) => c[0]).find((c) => c.data.tokenEnc === "");
    expect(connClear.where).toEqual({ id: "c1", tenantId: "t1", status: "revoked" });
  });

  it("takes one advisory lock per Page, sorted and without duplicates, before deciding whether another workspace uses it", async () => {
    const order: string[] = [];
    db.$executeRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      expect(strings.join("?")).toMatch(/pg_advisory_xact_lock\(hashtext\(\?\)\)/);
      order.push(`lock:${values[0]}`);
      return 0;
    });
    db.metaAsset.updateMany.mockImplementation(async () => void order.push("deactivate"));
    db.metaConnection.findFirst.mockResolvedValue(conn());
    db.metaAsset.findMany.mockResolvedValueOnce([page("pb"), page("pa"), page("pb")]).mockImplementation(async () => {
      order.push("check-others");
      return [];
    });
    graph.graphFetchAs.mockResolvedValue({ success: true });
    await disconnect(actor, "c1");
    expect(order.slice(0, 4)).toEqual(["lock:meta-page:pa", "lock:meta-page:pb", "deactivate", "check-others"]);
  });

  it("two workspaces with different Meta users disconnecting a shared Page at once: exactly one removes the subscription", async () => {
    const run = async (lock: boolean) => {
      const assets = [
        { id: "a1", tenantId: "t1", externalId: "p", status: "active", tokenEnc: sealSecret("t1", "T1"), meta: {} },
        { id: "a2", tenantId: "t2", externalId: "p", status: "active", tokenEnc: sealSecret("t2", "T2"), meta: {} },
      ];
      let tail: Promise<void> = Promise.resolve();
      db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged: string[] = [];
        let release = () => {};
        const tx = {
          ...db,
          $queryRaw: async () => [],
          $executeRaw: async () => {
            if (!lock) return 0;
            const before = tail;
            tail = new Promise<void>((r) => (release = r));
            await before;
            return 0;
          },
          metaAsset: {
            ...db.metaAsset,
            findMany: async ({ where }: { where: { tenantId: string | { not: string }; externalId?: unknown } }) => {
              // The snapshot is taken first and the latency comes after, like a real query that read before the other transaction committed.
              const rows = where.externalId
                ? assets.filter((a) => a.status === "active" && a.tenantId !== (where.tenantId as { not: string }).not).map((a) => ({ tenantId: a.tenantId, externalId: a.externalId }))
                : assets.filter((a) => a.tenantId === where.tenantId);
              await new Promise((r) => setTimeout(r, 5));
              return rows;
            },
            updateMany: async ({ where, data }: { where: { tenantId: string }; data: { status?: string } }) => {
              if (data.status === "inactive") staged.push(where.tenantId);
              return { count: 1 };
            },
          },
        };
        try {
          return await fn(tx);
        } finally {
          for (const t of staged) for (const a of assets) if (a.tenantId === t) a.status = "inactive";
          release();
        }
      });
      db.metaConnection.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
        const tenantId = where.id === "c1" ? "t1" : "t2";
        return conn({ id: where.id, tenantId, metaUserId: tenantId === "t1" ? "9" : "10", tokenEnc: sealSecret(tenantId, "TOK") });
      });
      db.tenant.findMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
      db.metaConnection.findMany.mockResolvedValue([]);
      graph.graphFetchAs.mockResolvedValue({ success: true });
      graph.graphFetchAs.mockClear();
      await Promise.all([disconnect(actor, "c1"), disconnect({ ...actor, tenantId: "t2" }, "c2")]);
      return subCalls("DELETE").length;
    };
    expect(await run(true)).toBe(1);
    expect(await run(false)).toBe(0);
  });

  it("finishes an interrupted disconnect: a revoked connection that still has its token gets its Page subscriptions and user authorization removed, then the tokens deleted", async () => {
    db.metaConnection.findMany.mockResolvedValueOnce([{ id: "c1", tenantId: "t1", metaUserId: "9", tokenEnc: sealSecret("t1", "USERTOK") }]).mockResolvedValue([]);
    db.metaAsset.findMany.mockResolvedValueOnce([page("p1")]);
    db.metaConnection.findFirst.mockResolvedValue({ id: "c1" });
    graph.graphFetchAs.mockResolvedValue({ success: true });
    const now = new Date();
    expect(await finishPendingDisconnects(now)).toBe(1);
    const where = db.metaConnection.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "revoked", tokenEnc: { not: "" } });
    expect((where.updatedAt.lt as Date).getTime()).toBe(now.getTime() - PENDING_DISCONNECT_GRACE_MS);
    expect(db.metaAsset.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", connectionId: "c1", type: "page", tokenEnc: { not: null } });
    expect(subCalls("DELETE")[0][0]).toBe("TOK-p1");
    expect(permissionCalls()).toHaveLength(1);
    expect(db.metaAsset.updateMany.mock.calls.map((c) => c[0]).some((c) => "tokenEnc" in c.data && c.data.tokenEnc === null)).toBe(true);
    expect(db.metaConnection.updateMany.mock.calls.map((c) => c[0]).some((c) => c.data.tokenEnc === "")).toBe(true);
    expect(db.auditLog.create.mock.calls[0][0].data.action).toBe("meta_connect.disconnect_resumed");
  });

  it("the sweep is registered as a periodic task of the meta-connect worker", async () => {
    const { worker } = await import("@/lib/meta-connect/worker");
    expect(worker.periodic.map((p) => p.name)).toContain("meta-disconnect-resume");
  });
});

// =====================================================================================================================
describe("disconnect protection (docs/SPEND-CONTROLS-SPEC.md 5.9, 5.8)", () => {
  const ORIGIN = "https://wa.edwyz.com";
  const conn = () => ({ id: "c1", tenantId: "t1", metaUserId: "9", tokenEnc: sealSecret("t1", "TOK") });
  const post = (body: Record<string, unknown>) =>
    new Request(`${ORIGIN}/api/meta-connect/disconnect`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ connectionId: "c1", ...body }) });
  const owner = { userId: "u1", tenantId: "t1", role: "owner" as const };
  const stopped = (items: { campaignId: string; campaignName: string; result: string }[] = []) => ({
    done: 2,
    failed: items.filter((i) => i.result === "failed").length,
    unreachable: items.filter((i) => i.result === "unreachable").length,
    skipped: 0,
    total: 2 + items.length,
    items,
  });
  const revoked = () => db.metaConnection.updateMany.mock.calls.some((c) => c[0].data.status === "revoked");
  const permissionDeletes = () => graph.graphFetchAs.mock.calls.filter((c) => String(c[1].path).endsWith("/permissions"));

  beforeEach(() => {
    process.env.SITE_URL = ORIGIN;
    db.metaConnection.findFirst.mockResolvedValue(conn());
    db.metaAsset.findMany.mockImplementation(async (args: { where: { type?: string } }) => (args.where.type === "ad_account" ? [{ id: "acc1" }] : []));
    db.metaSpendLimit.findMany.mockResolvedValue([{ adAccountAssetId: "acc1", mode: "managed" }]);
    db.metaSpendLimit.findFirst.mockResolvedValue({ currency: "INR" });
    graph.graphFetchAs.mockResolvedValue({ success: true });
    spend.stop.mockResolvedValue(stopped());
    spend.p0.mockResolvedValue({ status: "written" });
    spend.offboard.mockResolvedValue({ adAccountAssetId: "acc1", choice: "keep", trigger: "disconnect", applied: "kept", capMinor: 7_000_000n, text: "Kept the current limit on Meta (₹70,000)." });
    spend.getActor.mockResolvedValue(owner);
  });

  it("pauses everything Edwyz runs on the account first, applies the keep choice, then revokes, and names the limit that stays", async () => {
    const { POST } = await import("@/app/api/meta-connect/disconnect/route");
    const res = await POST(post({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; paused: number; metaLimitText: string };
    expect(body).toMatchObject({ ok: true, paused: 2, metaLimitText: "Your Meta spending limit stays at ₹70,000, so nothing can overspend after you disconnect." });
    expect(spend.stop).toHaveBeenCalledWith("t1", { origin: "all", adAccountAssetId: "acc1" }, { type: "user", userId: "u1", role: "owner" }, "Paused before the Meta account is disconnected.");
    expect(spend.offboard).toHaveBeenCalledWith("t1", "acc1", "keep", "disconnect", { type: "user", userId: "u1", role: "owner" });
    const revokeAt = db.metaConnection.updateMany.mock.invocationCallOrder[db.metaConnection.updateMany.mock.calls.findIndex((c) => c[0].data.status === "revoked")];
    expect(spend.stop.mock.invocationCallOrder[0]).toBeLessThan(revokeAt);
    expect(spend.offboard.mock.invocationCallOrder[0]).toBeLessThan(revokeAt);
    expect(spend.p0).not.toHaveBeenCalled();
  });

  it("a failed or unreachable pause writes P0 where Edwyz manages Meta's limit and refuses with 409 and the in-app copy; nothing is revoked", async () => {
    spend.stop.mockResolvedValue(stopped([{ campaignId: "c1", campaignName: "Diwali", result: "failed" }, { campaignId: "c2", campaignName: "Holi", result: "unreachable" }]));
    const { POST } = await import("@/app/api/meta-connect/disconnect/route");
    const res = await POST(post({}));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; campaigns: { id: string; name: string }[]; canForce: boolean };
    expect(body).toMatchObject({ code: "meta_connect.pause_failed", canForce: true, campaigns: [{ id: "c1", name: "Diwali" }, { id: "c2", name: "Holi" }] });
    expect(body.error).toBe("We couldn't pause 2 campaigns on Meta yet. Try again pauses them again from here. To disconnect anyway, type DISCONNECT. They may keep running until Meta's spending limit stops them.");
    expect(body.error).not.toMatch(/Ads Manager/);
    expect(spend.p0).toHaveBeenCalledWith("t1", "acc1", "disconnect", { actor: { type: "user", userId: "u1", role: "owner" } });
    expect(revoked()).toBe(false);
    expect(permissionDeletes()).toHaveLength(0);
    expect(spend.offboard).not.toHaveBeenCalled();
  });

  it("only the owner may force, and only with the typed word DISCONNECT", async () => {
    spend.stop.mockResolvedValue(stopped([{ campaignId: "c1", campaignName: "Diwali", result: "failed" }]));
    const { POST } = await import("@/app/api/meta-connect/disconnect/route");
    spend.getActor.mockResolvedValue({ ...owner, userId: "u2", role: "admin" });
    const adminTry = await POST(post({}));
    expect(adminTry.status).toBe(409);
    expect((await adminTry.json()) as { canForce: boolean; error: string }).toMatchObject({ canForce: false, error: "We couldn't pause 1 campaign on Meta yet. Try again pauses them again from here. Only the workspace owner can disconnect anyway." });
    expect((await POST(post({ force: true, confirm: "DISCONNECT" }))).status).toBe(403);
    spend.getActor.mockResolvedValue(owner);
    expect((await POST(post({ force: true, confirm: "disconnect" }))).status).toBe(400);
    expect(revoked()).toBe(false);
    const forced = await POST(post({ force: true, confirm: "DISCONNECT" }));
    expect(forced.status).toBe(200);
    expect(((await forced.json()) as { forced: boolean }).forced).toBe(true);
    expect(revoked()).toBe(true);
    expect(db.auditLog.create.mock.calls.map((c) => c[0].data.action)).toContain("meta_connect.disconnect_forced");
  });

  it("passes the owner's 5.8 choice on and refuses an unknown one", async () => {
    const { POST } = await import("@/app/api/meta-connect/disconnect/route");
    spend.offboard.mockResolvedValue({ adAccountAssetId: "acc1", choice: "remove", trigger: "disconnect", applied: "removed", capMinor: 0n, text: "Removed Meta's spending limit on Shop ads." });
    const res = await POST(post({ metaLimitChoice: "remove" }));
    expect(res.status).toBe(200);
    expect(spend.offboard.mock.calls[0][2]).toBe("remove");
    expect(((await res.json()) as { metaLimitText: string | null }).metaLimitText).toBeNull();
    expect((await POST(post({ metaLimitChoice: "burn" }))).status).toBe(400);
  });

  it("needs an admin or the owner, and the same origin", async () => {
    const { POST } = await import("@/app/api/meta-connect/disconnect/route");
    spend.getActor.mockResolvedValue({ ...owner, role: "agent" });
    expect((await POST(post({}))).status).toBe(403);
    spend.getActor.mockResolvedValue(owner);
    const cross = new Request(`${ORIGIN}/api/meta-connect/disconnect`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ connectionId: "c1" }) });
    expect((await POST(cross)).status).toBe(403);
    expect(spend.stop).not.toHaveBeenCalled();
  });
});

describe("Meta's spending limit in discovery and the scope copy (5.1, 5.10)", () => {
  it("discovery reads spend_cap, amount_spent, is_prepay_account and min_campaign_group_spend_cap for the consent screen", async () => {
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "me/adaccounts") return { data: [{ id: "act_111", name: "Shop ads", currency: "INR", account_status: 1, timezone_name: "Asia/Kolkata", spend_cap: "6500000", amount_spent: "5000000", is_prepay_account: false, min_campaign_group_spend_cap: "10000" }] };
      return { data: [] };
    });
    await discoverAssets("t1", "c1", "TOKEN");
    const adCall = graph.graphFetchAs.mock.calls.find((c) => c[1].path === "me/adaccounts")!;
    for (const f of ["spend_cap", "amount_spent", "is_prepay_account", "min_campaign_group_spend_cap", "currency", "timezone_name"]) expect(String(adCall[1].query.fields).split(",")).toContain(f);
    const upsert = db.metaAsset.upsert.mock.calls.map((c) => c[0]).find((u) => u.create.type === "ad_account");
    expect(upsert.create.meta).toEqual({ currency: "INR", accountStatus: 1, timezone: "Asia/Kolkata", metaCapMinor: "6500000", amountSpentMinor: "5000000", isPrepay: false, minCampaignGroupCapMinor: "10000" });
  });

  it("the ads_management copy names Meta's spending limit", () => {
    expect(SCOPE_PURPOSES.ads_management).toBe("Create and change ad campaigns, and keep Meta's spending limit in line with your limits.");
  });
});

describe("the Connections page: consent step and disconnect copy", () => {
  it("names the limit that stays after a disconnect and reads the blocked state", async () => {
    const { blockedDisconnect, disconnectNotice } = await import("@/components/meta-connect/ConnectionsPanel");
    expect(disconnectNotice({ revokedAtMeta: true, metaLimitText: "Your Meta spending limit stays at ₹70,000, so nothing can overspend after you disconnect." })).toBe(
      "Disconnected, and access was revoked at Meta. Your Meta spending limit stays at ₹70,000, so nothing can overspend after you disconnect.",
    );
    const err = Object.assign(new Error("x"), { body: { code: "meta_connect.pause_failed", error: "We couldn't pause 1 campaign on Meta yet.", campaigns: [{ id: "c1", name: "Diwali" }], canForce: true } });
    expect(blockedDisconnect(err)).toEqual({ text: "We couldn't pause 1 campaign on Meta yet.", campaigns: [{ id: "c1", name: "Diwali" }], canForce: true });
    expect(blockedDisconnect(new Error("other"))).toBeNull();
    // First import of the ConnectionsPanel module graph (about 0.6 s alone); a realistic budget for a fully parallel run.
  }, 20_000);

  it("shows the owner the 5.1 consent text with a labelled checkbox, the admin the owner-only line, and the agent nothing", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MetaLimitStep, ADMIN_PENDING_TEXT } = await import("@/components/meta-connect/ConnectionsPanel");
    const { META_CAP_CONSENT } = await import("@/lib/spend/metacap/consent");
    const esc = (t: string) => t.replace(/'/g, "&#x27;").replace(/>/g, "&gt;");
    const metaLimit = {
      adAccountAssetId: "acc1",
      accountName: "Shop ads",
      accountExternalId: "act_111",
      currency: "INR",
      mode: "off" as const,
      state: "off" as const,
      managed: false,
      text: "Off. Turn on Meta's limit for extra safety.",
      cap: null,
      amountSpent: null,
      roomLeft: null,
      target: null,
      looseBy: null,
      previousCap: null,
      deferredUntil: null,
      lastReadAt: null,
      canTurnOn: true,
      canTurnOff: false,
      offboardChoices: [],
      action: { kind: "turn_on" as const, label: "Turn on Meta's limit" },
    };
    const consent = { ...META_CAP_CONSENT, body: [...META_CAP_CONSENT.body], existingCap: "This account already has a Meta limit of ₹65,000." };
    const html = renderToStaticMarkup(createElement(MetaLimitStep, { payload: { metaLimit, consent, offboard: [] }, role: "owner", onChanged: () => undefined, onConnectAgain: null }));
    expect(html).toContain(META_CAP_CONSENT.title);
    for (const line of META_CAP_CONSENT.body) expect(html).toContain(esc(line));
    expect(html).toContain("This account already has a Meta limit of ₹65,000.");
    const checkbox = /<input id="([^"]+)" type="checkbox"/.exec(html);
    expect(checkbox).not.toBeNull();
    expect(html).toContain(`<label for="${checkbox![1]}">I&#x27;m the owner of this workspace and I agree.</label>`);
    expect(html).toMatch(/aria-live="polite"/);
    const pending = { ...metaLimit, canTurnOn: false, state: "pending_owner" as const, mode: "pending_owner" as const };
    const adminHtml = renderToStaticMarkup(createElement(MetaLimitStep, { payload: { metaLimit: pending, consent: null, offboard: [] }, role: "admin", onChanged: () => undefined, onConnectAgain: null }));
    expect(adminHtml).toContain(esc(ADMIN_PENDING_TEXT));
    expect(adminHtml).not.toContain('type="checkbox"');
    expect(renderToStaticMarkup(createElement(MetaLimitStep, { payload: { metaLimit: { ...metaLimit, canTurnOn: false }, consent: null, offboard: [] }, role: "agent", onChanged: () => undefined, onConnectAgain: null }))).toBe("");
  });
});

// =====================================================================================================================
// Discovery extensions (docs/IG-PAGE-ADS-SPEC.md 4.2 C1 to C6, 5.4 MetaAsset.meta; PRM-07 acceptance 4)
// =====================================================================================================================

describe("discovery readiness blocks (C1 to C6, 5.4)", () => {
  /** The payment-method response key, taken from promote/meta.ts's field list (it is never written in discovery). */
  const FUNDING = AD_ACCOUNT_HEALTH_FIELDS.slice(AD_ACCOUNT_HEALTH_FIELDS.lastIndexOf(",") + 1).replace(/\{.*$/, "");
  type Merge = { values: Record<string, unknown>; times: Record<string, string>; tenantId: string; connectionId: string; type: string; externalId: string };
  const merges = (): Merge[] =>
    db.$executeRaw.mock.calls
      .filter((c) => Array.isArray(c[0]) && (c[0] as string[]).join("?").includes('UPDATE "MetaAsset"'))
      .map((c) => ({ values: JSON.parse(c[1] as string), times: JSON.parse(c[2] as string), tenantId: c[3] as string, connectionId: c[4] as string, type: c[5] as string, externalId: c[6] as string }));
  const mergeOf = (externalId: string) => merges().filter((m) => m.externalId === externalId);
  const upsertOf = (type: string, externalId: string) => db.metaAsset.upsert.mock.calls.map((c) => c[0]).find((u) => u.create.type === type && u.create.externalId === externalId);

  type Req = { path: string; query?: Record<string, string> };
  const meta = (over: Record<string, (req: Req) => unknown> = {}) =>
    graph.graphFetchAs.mockImplementation(async (_t: string, req: Req) => {
      if (over[req.path]) return over[req.path](req);
      switch (req.path) {
        case "me/accounts":
          return {
            data: [
              {
                id: "p1",
                name: "Shop",
                access_token: "PAGETOK",
                tasks: ["ADVERTISE", "CREATE_CONTENT", "MANAGE"],
                picture: { data: { url: "https://cdn.example/p1.jpg" } },
                instagram_business_account: { id: "ig1", username: "shop", name: "Shop IG", profile_picture_url: "https://cdn.example/ig1.jpg" },
              },
              { id: "p2", name: "Other", access_token: "PAGETOK2", tasks: ["ANALYZE"], picture: { data: { url: "javascript:alert(1)" } } },
            ],
          };
        case "me/adaccounts":
          return { data: [{ id: "act_111", name: "Shop ads", currency: "INR", account_status: 1, timezone_name: "Asia/Kolkata" }] };
        case "p1":
          return { leadgen_tos_accepted: true, whatsapp_number: "+91 98100 00000" };
        case "p2":
          return { leadgen_tos_accepted: false, whatsapp_number: "+1 555 0100" };
        case "p1/page_backed_instagram_accounts":
          return { data: [{ id: "pbig1", username: "shop_ads" }] };
        case "act_111":
          return { account_status: 1, disable_reason: 0, currency: "INR", timezone_name: "Asia/Kolkata", business: { id: "biz1" }, tos_accepted: { custom_audience_tos: 1 }, user_tos_accepted: {}, [FUNDING]: { type: 1, display_string: "Visa 1234" } };
        case "act_111/minimum_budgets":
          return { data: [{ currency: "INR", min_daily_budget_imp: 8900, min_daily_budget_video_views: 10000 }] };
        case "act_111/connected_instagram_accounts":
          return { data: [{ id: "ig1", username: "shop" }] };
        default:
          return req.path.endsWith("/subscribed_apps") ? { success: true } : { data: [] };
      }
    });

  beforeEach(() => {
    db.phoneNumber.findMany.mockResolvedValue([{ displayPhone: "+91 98100 00000" }]);
  });

  it("C1 asks for the Page picture and the Instagram picture and name, and stores canAdvertise and canCreateContent", async () => {
    meta();
    await discoverAssets("t1", "c1", "USERTOK");
    const fields = graph.graphFetchAs.mock.calls.find((c) => c[1].path === "me/accounts")![1].query.fields;
    expect(fields).toBe(PAGE_FIELDS);
    for (const f of ["tasks", "picture{url}", "profile_picture_url", "instagram_business_account{id,username,name,profile_picture_url}"]) expect(fields).toContain(f);
    const p1 = upsertOf("page", "p1").create.meta;
    expect(p1).toMatchObject({ tasks: ["ADVERTISE", "CREATE_CONTENT", "MANAGE"], pictureUrl: "https://cdn.example/p1.jpg", canAdvertise: true, canCreateContent: true });
    expect(typeof p1.checkedAt.listing).toBe("string");
    expect(upsertOf("page", "p2").create.meta).toMatchObject({ canAdvertise: false, canCreateContent: false, pictureUrl: null });
    expect(upsertOf("instagram", "ig1").create.meta).toMatchObject({ pageId: "p1", username: "shop", displayName: "Shop IG", profilePictureUrl: "https://cdn.example/ig1.jpg", pageBacked: false });
    expect(pictureUrl("http://cdn.example/x.jpg")).toBeNull();
  });

  it("stores every 5.4 key, each block with its own checkedAt, through promote/meta.ts and only fundingPresent of the payment method", async () => {
    meta();
    await discoverAssets("t1", "c1", "USERTOK");
    const [p1] = mergeOf("p1");
    expect(p1.values).toEqual({ leadgenTosAccepted: true, whatsappNumber: "919810000000", whatsappLinkState: "ok", pageBackedIgId: "pbig1", readinessTriedAt: expect.any(String) });
    expect(Object.keys(p1.times).sort()).toEqual(["leadgen", "pageBacked"]);
    expect(p1).toMatchObject({ tenantId: "t1", connectionId: "c1", type: "page" });
    expect(mergeOf("p2")[0].values).toMatchObject({ leadgenTosAccepted: false, whatsappLinkState: "missing", pageBackedIgId: null });
    const [act] = mergeOf("act_111");
    expect(act.values).toEqual({ accountStatus: 1, disableReason: 0, businessId: "biz1", customAudienceTos: true, userTosAccepted: false, fundingPresent: true, minDailyBudgetMinor: 8900, readinessTriedAt: expect.any(String) });
    expect(Object.keys(act.times).sort()).toEqual(["health", "minBudget"]);
    expect(JSON.stringify(merges())).not.toContain("Visa");
    expect(mergeOf("ig1")[0]).toMatchObject({ values: { authorizedAdAccountIds: ["act_111"] }, type: "instagram" });
    expect(Object.keys(mergeOf("ig1")[0].times)).toEqual(["authorized"]);
    // Every key of 5.4 is covered by a block.
    expect(META_BLOCKS.page).toEqual({ leadgen: ["leadgenTosAccepted", "whatsappNumber", "whatsappLinkState"], pageBacked: ["pageBackedIgId", "pageBackedCreatedAt"] });
    expect(META_BLOCKS.ad_account.health).toEqual(["accountStatus", "disableReason", "businessId", "customAudienceTos", "userTosAccepted", "fundingPresent"]);
    // C2 to C6 go through promote/meta.ts: page edges with the Page token, ad account edges with the user token.
    const call = (p: string) => graph.graphFetchAs.mock.calls.find((c) => c[1].path === p)!;
    expect(call("p1")[0]).toBe("PAGETOK");
    expect(call("p1")[1].query.fields).toContain("whatsapp_number");
    expect(call("act_111")[0]).toBe("USERTOK");
    expect(call("act_111")[1].query.fields).toBe(AD_ACCOUNT_HEALTH_FIELDS);
    const source = readFileSync(path.resolve(__dirname, "../src/lib/meta-connect/discovery.ts"), "utf8");
    expect(source).not.toContain(FUNDING);
    expect(source).not.toContain("adsClient(");
  });

  it("C3's ads-only identity becomes an Instagram asset with pageBacked, and later runs keep it active", async () => {
    meta();
    await discoverAssets("t1", "c1", "USERTOK");
    const backed = upsertOf("instagram", "pbig1");
    expect(backed.create).toMatchObject({ type: "instagram", connectionId: "c1", name: "shop_ads", status: "active", meta: { pageId: "p1", username: "shop_ads", pageBacked: true } });
    expect(openSecret("t1", backed.create.tokenEnc)).toBe("PAGETOK");
    expect(mergeOf("pbig1")[0].values).toEqual({ authorizedAdAccountIds: [] });

    vi.clearAllMocks();
    db.metaAsset.findMany.mockResolvedValueOnce([{ externalId: "p1", type: "page", meta: { pageBackedIgId: "pbig1", checkedAt: { pageBacked: "2026-10-01T00:00:00.000Z" } } }]).mockResolvedValue([]);
    meta({ "p1/page_backed_instagram_accounts": () => Promise.reject(new GraphError("down", 500)) });
    await discoverAssets("t1", "c1", "USERTOK");
    const sweep = db.metaAsset.updateMany.mock.calls.map((c) => c[0]).find((c) => c.where.type === "instagram" && c.data.status === "inactive");
    expect(sweep.where.externalId.notIn).toEqual(expect.arrayContaining(["ig1", "pbig1"]));
    // The failed C3 kept the stored id and its time.
    expect(upsertOf("page", "p1").create.meta).toMatchObject({ pageBackedIgId: "pbig1", checkedAt: { pageBacked: "2026-10-01T00:00:00.000Z" } });
  });

  it("a read that fails keeps what the previous run stored, with its own older checkedAt", async () => {
    db.metaAsset.findMany.mockResolvedValueOnce([
      { externalId: "act_111", type: "ad_account", meta: { fundingPresent: false, customAudienceTos: true, accountStatus: 2, checkedAt: { health: "2026-10-01T00:00:00.000Z", minBudget: "2026-10-02T00:00:00.000Z" }, minDailyBudgetMinor: 5000 } },
    ]);
    meta({ act_111: () => Promise.reject(new GraphError("down", 500)) });
    await discoverAssets("t1", "c1", "USERTOK");
    const stored = upsertOf("ad_account", "act_111").create.meta;
    // The listing's own accountStatus wins; the health block's other keys are carried with their time.
    expect(stored).toMatchObject({ accountStatus: 1, fundingPresent: false, customAudienceTos: true, minDailyBudgetMinor: 5000, checkedAt: { health: "2026-10-01T00:00:00.000Z" } });
    const [act] = mergeOf("act_111");
    expect(act.values).toEqual({ minDailyBudgetMinor: 8900, readinessTriedAt: expect.any(String) });
    expect(Object.keys(act.times)).toEqual(["minBudget"]);
    expect(carriedBlocks("ad_account", { fundingPresent: true })).toEqual({});
    expect(carriedBlocks("dataset", { fundingPresent: true, checkedAt: { health: "x" } })).toEqual({});
  });

  it("stays inside the discovery budget under a slow Meta and writes nothing late", async () => {
    const slow = () => new Promise((r) => setTimeout(() => r({ data: [] }), 400));
    meta({ p1: slow, p2: slow, "p1/page_backed_instagram_accounts": slow, act_111: slow, "act_111/minimum_budgets": slow, "act_111/connected_instagram_accounts": slow });
    const started = Date.now();
    const result = await discoverAssets("t1", "c1", "USERTOK", { subscribeBudgetMs: 150, subscribeCallTimeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.counts).toMatchObject({ page: 2, instagram: 1, ad_account: 1 });
    await new Promise((r) => setTimeout(r, 500));
    expect(merges()).toEqual([]);
    // The OAuth callback and a refresh run discovery with the 45 second budget.
    expect(REQUEST_DISCOVERY_BUDGET_MS).toBe(45_000);
  });

  it("does not read the extra blocks for a connection that was disconnected meanwhile", async () => {
    db.metaConnection.findFirst.mockResolvedValue({ id: "c1" });
    meta();
    await discoverAssets("t1", "c1", "USERTOK");
    expect(graph.graphFetchAs.mock.calls.map((c) => c[1].path)).not.toContain("act_111/minimum_budgets");
    expect(merges()).toEqual([]);
  });

  it("whatsappLinkState and minDailyFrom: unknown when either side can't be read; the impressions minimum only", () => {
    expect(whatsappLinkState({ number: "919810000000", checked: true }, ["919810000000"])).toBe("ok");
    expect(whatsappLinkState({ number: "9810000000", checked: true }, ["919810000000"])).toBe("ok");
    expect(whatsappLinkState({ number: "15550100", checked: true }, ["919810000000"])).toBe("missing");
    // A short tail is not the same number.
    expect(whatsappLinkState({ number: "00000", checked: true }, ["919810000000"])).toBe("missing");
    expect(whatsappLinkState({ number: null, checked: true }, ["919810000000"])).toBe("missing");
    expect(whatsappLinkState({ number: null, checked: false }, ["919810000000"])).toBe("unknown");
    expect(whatsappLinkState({ number: "919810000000", checked: true }, null)).toBe("unknown");
    expect(minDailyFrom({ min_daily_budget_imp: 8900, min_daily_budget_video_views: 100 })).toBe(8900);
    expect(minDailyFrom({ min_daily_budget_video_views: 100 })).toBeNull();
  });

  it("completeConnect writes lastCheckedAt only after discovery, so the popup's polling sees a finished connection", async () => {
    const state = await issueState("t1", "u1");
    graph.appGraphFetch.mockResolvedValueOnce({ access_token: "S" }).mockResolvedValueOnce({ access_token: "L" });
    meta({ debug_token: () => ({ data: { is_valid: true, user_id: "9", scopes: [], expires_at: 0 } }) });
    db.metaConnection.upsert.mockResolvedValue({ id: "c1" });
    await completeConnect(actor, "code", state);
    const up = db.metaConnection.upsert.mock.calls[0][0];
    expect(up.create.lastCheckedAt).toBeUndefined();
    expect(up.update.lastCheckedAt).toBeUndefined();
    const calls = db.metaConnection.updateMany.mock.calls;
    const index = calls.findIndex((c) => c[0].data.lastCheckedAt instanceof Date);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(calls[index][0].where).toEqual({ id: "c1", tenantId: "t1" });
    const doneOrder = db.metaConnection.updateMany.mock.invocationCallOrder[index];
    for (const order of db.metaAsset.upsert.mock.invocationCallOrder) expect(order).toBeLessThan(doneOrder);
  }, 20_000);

  it("orders the readiness reads: the spending ad account, then never read, then the longest ago; the attempt time is carried", () => {
    const prev = new Map<string, Record<string, unknown>>([
      ["a", { [READINESS_TRIED_KEY]: "2026-10-30T00:00:00.000Z" }],
      ["b", { checkedAt: { leadgen: "2026-10-29T00:00:00.000Z", pageBacked: "2026-10-28T00:00:00.000Z" } }],
      ["c", { checkedAt: { leadgen: "2026-10-31T00:00:00.000Z" } }], // C3 never read
    ]);
    const items = ["a", "b", "c", "d"].map((externalId) => ({ externalId }));
    expect(orderForEnrich("page", items, prev).map((i) => i.externalId)).toEqual(["c", "d", "b", "a"]);
    expect(orderForEnrich("ad_account", items, prev, "a")[0].externalId).toBe("a");
    expect(readinessAge("page", prev.get("b"))).toBe(Date.parse("2026-10-28T00:00:00.000Z"));
    expect(readinessAge("page", undefined)).toBe(0);
    expect(carriedBlocks("page", { [READINESS_TRIED_KEY]: "t" })).toEqual({ [READINESS_TRIED_KEY]: "t" });
    expect(carriedBlocks("ad_account", { [READINESS_TRIED_KEY]: "t" })).toEqual({ [READINESS_TRIED_KEY]: "t" });
    expect(carriedBlocks("instagram", { [READINESS_TRIED_KEY]: "t" })).toEqual({});
  });

  it("rotates the caps: Pages past the 50th and ad accounts past the 25th are read on later runs; the spending account goes first and the two kinds take turns", async () => {
    const PAGES = Array.from({ length: MAX_ENRICH_PAGES + 10 }, (_, i) => ({ id: `p${i + 1}`, name: `Page ${i + 1}`, access_token: `PT${i + 1}`, tasks: ["ADVERTISE"] }));
    const ACTS = Array.from({ length: MAX_ENRICH_AD_ACCOUNTS + 5 }, (_, i) => ({ id: `act_${i + 1}`, name: `Ads ${i + 1}`, currency: "INR", account_status: 1 }));
    const listing = { "me/accounts": () => ({ data: PAGES }), "me/adaccounts": () => ({ data: ACTS }) };
    const paths = () => graph.graphFetchAs.mock.calls.map((c) => c[1].path as string);
    const c2 = () => paths().filter((p) => /^p\d+$/.test(p));
    const c4 = () => paths().filter((p) => /^act_\d+$/.test(p));
    db.spendControl.findUnique.mockResolvedValue({ spendingAdAccountAssetId: "asset_act_30" });
    db.metaAsset.findFirst.mockImplementation(async (a: { where: { id?: string } }) => (a.where.id === "asset_act_30" ? { externalId: "act_30" } : null));

    meta(listing);
    await discoverAssets("t1", "c1", "USERTOK");
    expect(c2()).toHaveLength(MAX_ENRICH_PAGES);
    expect(c2()).not.toContain(`p${MAX_ENRICH_PAGES + 1}`);
    expect(c4()).toHaveLength(MAX_ENRICH_AD_ACCOUNTS);
    expect(c4()[0]).toBe("act_30");
    expect(c4()).not.toContain("act_25");
    // Ad accounts and Pages take turns, so neither kind waits for all of the other: the first reads are a mix of both.
    const first = paths()
      .filter((p) => /^(p|act_)[0-9]+$/.test(p))
      .slice(0, 10);
    expect(first.filter((p) => p.startsWith("act_")).length).toBeGreaterThanOrEqual(3);
    expect(first.filter((p) => !p.startsWith("act_")).length).toBeGreaterThanOrEqual(3);
    // Every attempt is recorded, whatever Meta answered.
    const tried = merges().filter((m) => typeof m.values[READINESS_TRIED_KEY] === "string");
    expect(tried).toHaveLength(MAX_ENRICH_PAGES + MAX_ENRICH_AD_ACCOUNTS);

    // The next run starts with what this one did not reach.
    const stored = tried.map((m) => ({ externalId: m.externalId, type: m.type, meta: { [READINESS_TRIED_KEY]: m.values[READINESS_TRIED_KEY] } }));
    vi.clearAllMocks();
    db.metaAsset.findMany.mockImplementation(async (a: { where: { externalId?: { in?: string[] } } }) => stored.filter((r) => a.where.externalId?.in?.includes(r.externalId)));
    meta(listing);
    await discoverAssets("t1", "c1", "USERTOK");
    for (let i = MAX_ENRICH_PAGES + 1; i <= MAX_ENRICH_PAGES + 10; i++) expect(c2()).toContain(`p${i}`);
    expect(c4()[0]).toBe("act_30");
    for (let i = 25; i <= 29; i++) expect(c4()).toContain(`act_${i}`);
    // The page tried longest ago comes back before the ones tried most recently.
    expect(c2()).toContain("p1");
    expect(c2()).not.toContain(`p${MAX_ENRICH_PAGES}`);
  }, 20_000);

  it("an identity Edwyz just made that C3 doesn't list yet keeps its id, stays an active asset and still gets C6; after the grace period an empty C3 clears it", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const old = new Date(Date.now() - PAGE_BACKED_LISTING_GRACE_MS - 60_000).toISOString();
    const pageRow = (createdAt: string) => ({ externalId: "p1", type: "page", meta: { pageBackedIgId: "pbig_new", pageBackedCreatedAt: createdAt, checkedAt: { pageBacked: createdAt } } });
    const igRow = { externalId: "pbig_new", type: "instagram", meta: { pageId: "p1", pageBacked: true, authorizedAdAccountIds: ["act_old"], checkedAt: { listing: recent, authorized: recent } } };
    const stored = (createdAt: string) => async (a: { where: { externalId?: { in?: string[] } } }) => [pageRow(createdAt), igRow].filter((r) => a.where.externalId?.in?.includes(r.externalId));
    const igUpdates = () => db.metaAsset.updateMany.mock.calls.map((c) => c[0]).filter((c) => c.where.externalId === "pbig_new");

    db.metaAsset.findMany.mockImplementation(stored(recent));
    meta({ "p1/page_backed_instagram_accounts": () => ({ data: [] }), "act_111/connected_instagram_accounts": () => ({ data: [{ id: "pbig_new" }] }) });
    await discoverAssets("t1", "c1", "USERTOK");
    expect(mergeOf("p1")[0].values).not.toHaveProperty("pageBackedIgId");
    expect(upsertOf("page", "p1").create.meta).toMatchObject({ pageBackedIgId: "pbig_new", pageBackedCreatedAt: recent });
    const sweep = db.metaAsset.updateMany.mock.calls.map((c) => c[0]).find((c) => c.where.type === "instagram" && c.data.status === "inactive" && c.where.externalId?.notIn);
    expect(sweep.where.externalId.notIn).toContain("pbig_new");
    expect(igUpdates()).toEqual([]);
    // C6 still reaches it, keeping the answer of an account not read this time.
    expect(mergeOf("pbig_new")[0].values).toEqual({ authorizedAdAccountIds: ["act_111", "act_old"] });

    // Past the grace period Meta's empty answer wins: the id is cleared and the asset set inactive.
    vi.clearAllMocks();
    db.metaAsset.findMany.mockImplementation(stored(old));
    meta({ "p1/page_backed_instagram_accounts": () => ({ data: [] }) });
    await discoverAssets("t1", "c1", "USERTOK");
    expect(mergeOf("p1")[0].values).toMatchObject({ pageBackedIgId: null });
    expect(igUpdates()).toEqual([expect.objectContaining({ data: { status: "inactive" } })]);
    expect(justCreatedIdentity({ pageBackedIgId: "x", pageBackedCreatedAt: recent })).toBe("x");
    expect(justCreatedIdentity({ pageBackedIgId: "x", pageBackedCreatedAt: old })).toBeNull();
    expect(justCreatedIdentity({ pageBackedIgId: "x" })).toBeNull();
  });

  it("C3's identities keep the C6 answer stored on them when this run's C6 read fails", async () => {
    db.metaAsset.findMany.mockImplementation(async (a: { where: { externalId?: { in?: string[] } } }) =>
      a.where.externalId?.in?.includes("pbig1") ? [{ externalId: "pbig1", type: "instagram", meta: { pageBacked: true, authorizedAdAccountIds: ["act_111"], checkedAt: { authorized: "2026-10-01T00:00:00.000Z" } } }] : [],
    );
    meta({ "act_111/connected_instagram_accounts": () => Promise.reject(new GraphError("down", 500)) });
    await discoverAssets("t1", "c1", "USERTOK");
    expect(upsertOf("instagram", "pbig1").create.meta).toMatchObject({ pageBacked: true, authorizedAdAccountIds: ["act_111"], checkedAt: { authorized: "2026-10-01T00:00:00.000Z" } });
  });

  it("Run Instagram ads using your Page with more than 50 Pages: the identity becomes an Instagram asset at once, though the refresh never reads that Page", async () => {
    const PAGES = Array.from({ length: 60 }, (_, i) => ({ id: `p${i + 1}`, name: `Page ${i + 1}`, access_token: `PT${i + 1}`, tasks: ["ADVERTISE"] }));
    meta({ "me/accounts": () => ({ data: PAGES }) });
    db.metaAsset.findFirst.mockResolvedValue({ id: "pg55", type: "page", externalId: "p55", name: "Page 55", status: "active", meta: { canAdvertise: true }, connectionId: "c1" });
    db.$executeRaw.mockResolvedValue(1);
    const deps = {
      meta: { listPageBackedInstagram: vi.fn(async () => []), createPageBackedInstagram: vi.fn(async () => ({ id: "pbig55" })) },
      refresh: (_a: unknown, connectionId: string) => discoverAssets("t1", connectionId, "USERTOK"),
    };
    expect(await ensurePageBackedInstagram(actor, "pg55", deps)).toEqual({ instagramId: "pbig55", created: true, refreshed: true });
    const insertAt = db.$executeRaw.mock.calls.findIndex((c) => (c[0] as string[]).join("?").includes('INSERT INTO "MetaAsset"'));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    const [strings, ...params] = db.$executeRaw.mock.calls[insertAt] as [string[], ...unknown[]];
    const sql = strings.join("?");
    // Guarded like the other stored blocks: an active Page under a connection that is not revoked; the Page's sealed token.
    for (const part of [`p."status" = 'active'`, `c."status" <> 'revoked'`, `p."type" = 'page'`, `p."tokenEnc"`, "'instagram'", 'ON CONFLICT ("tenantId", "type", "externalId")']) expect(sql).toContain(part);
    expect(params).toEqual(expect.arrayContaining(["pbig55", "pg55", "t1", "p55"]));
    expect(JSON.parse(params.find((v) => typeof v === "string" && v.includes('"checkedAt"')) as string)).toMatchObject({ pageId: "p55", pageBacked: true });
    // Stored before the refresh started, and the refresh's readiness reads never reached Page 55.
    expect(db.$executeRaw.mock.invocationCallOrder[insertAt]).toBeLessThan(graph.graphFetchAs.mock.invocationCallOrder[0]);
    expect(graph.graphFetchAs.mock.calls.map((c) => c[1].path)).not.toContain("p55/page_backed_instagram_accounts");
    // The Page carries the id and when it was made, so a C3 that doesn't list it yet can't clear it.
    expect(mergeOf("p55")).toEqual([expect.objectContaining({ values: { pageBackedIgId: "pbig55", pageBackedCreatedAt: expect.any(String) } })]);
  }, 20_000);
});

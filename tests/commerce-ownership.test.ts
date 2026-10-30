import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Store = { id: string; tenantId: string; shopDomain: string; status: string; tokenEnc: string; webhookSecretEnc: string | null; createdAt: Date };
type Setting = { value: Record<string, unknown>; updatedAt: Date };

const mem = vi.hoisted(() => ({ settings: new Map<string, { value: Record<string, unknown>; updatedAt: Date }>(), stores: [] as Store[], tokens: new Map<string, string>() }));

const db = vi.hoisted(() => {
  const unique = () => Object.assign(new Error("unique"), { code: "P2002" });
  const jsonMatch = (v: Record<string, unknown>, w: { path?: string[]; equals?: unknown }) => !w.path || v[w.path[0]] === w.equals;
  type W = { id?: string; tenantId?: string; shopDomain?: string; status?: string | { in: string[] }; NOT?: { id?: string; tenantId?: string } };
  const statusOk = (s: Store, w: W) => !w.status || (typeof w.status === "string" ? s.status === w.status : w.status.in.includes(s.status));
  const storeOk = (s: Store, w: W) =>
    (!w.id || s.id === w.id) && (!w.tenantId || s.tenantId === w.tenantId) && (!w.shopDomain || s.shopDomain === w.shopDomain) && statusOk(s, w) &&
    (!w.NOT?.id || s.id !== w.NOT.id) && (!w.NOT?.tenantId || s.tenantId !== w.NOT.tenantId);
  return {
    platformSetting: {
      create: vi.fn(async ({ data }: { data: { key: string; value: Record<string, unknown> } }) => {
        if (mem.settings.has(data.key)) throw unique();
        mem.settings.set(data.key, { value: data.value, updatedAt: new Date() });
        return data;
      }),
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        const r = mem.settings.get(where.key);
        return r ? { key: where.key, ...r } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { key: string; updatedAt?: { lt: Date } }; data: { value: Record<string, unknown> } }) => {
        const r = mem.settings.get(where.key);
        if (!r || (where.updatedAt && !(r.updatedAt < where.updatedAt.lt))) return { count: 0 };
        mem.settings.set(where.key, { value: data.value, updatedAt: new Date() });
        return { count: 1 };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { key: string | { startsWith: string }; value?: { path?: string[]; equals?: unknown } } }) => {
        let n = 0;
        for (const [k, r] of [...mem.settings]) {
          const keyOk = typeof where.key === "string" ? k === where.key : k.startsWith(where.key.startsWith);
          if (keyOk && (!where.value || jsonMatch(r.value, where.value))) {
            mem.settings.delete(k);
            n++;
          }
        }
        return { count: n };
      }),
      findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
        [...mem.settings].filter(([k]) => where.key.in.includes(k)).map(([key, r]) => ({ key, value: r.value }))),
      upsert: vi.fn(),
    },
    shopifyStore: {
      findMany: vi.fn(async ({ where, take }: { where: W; take?: number }) => mem.stores.filter((s) => storeOk(s, where)).slice(0, take)),
      findFirst: vi.fn(async ({ where }: { where: W }) => mem.stores.find((s) => storeOk(s, where)) ?? null),
      create: vi.fn(async ({ data }: { data: Partial<Store> }) => {
        const row = { id: `s${mem.stores.length + 1}`, createdAt: new Date(), status: "active", webhookSecretEnc: null, ...data } as Store;
        mem.stores.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: W; data: Partial<Store> }) => {
        const hit = mem.stores.filter((s) => storeOk(s, where));
        hit.forEach((s) => Object.assign(s, data));
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
        const before = mem.stores.length;
        mem.stores = mem.stores.filter((s) => !(s.id === where.id && s.tenantId === where.tenantId));
        return { count: before - mem.stores.length };
      }),
    },
  };
});
const cart = vi.hoisted(() => ({ ingestCheckout: vi.fn(), markRecovered: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/crypto/secrets", () => ({
  sealSecret: (t: string, v: string) => `sealed:${t}:${v}`,
  openSecret: (t: string, v: string) => v.replace(`sealed:${t}:`, ""),
}));
vi.mock("@/lib/commerce/cart", async (orig) => ({ ...(await orig<typeof import("@/lib/commerce/cart")>()), ...cart }));
// Stands in for Shopify: a token is valid only for the shop it was issued for.
vi.mock("@/lib/commerce/admin-verify", async (orig) => {
  const { HttpError } = await import("@/lib/tenancy");
  return {
    ...(await orig<typeof import("@/lib/commerce/admin-verify")>()),
    verifyShopOwnership: vi.fn(async (domain: string, token: string) => {
      if (mem.tokens.get(domain) !== token) throw new HttpError(422, "Shopify rejected the access token for this store.");
    }),
  };
});

import { POST as webhook } from "@/app/webhooks/shopify/route";
import { claimShopDomain, demoteUnclaimedStores } from "@/lib/commerce/claims";
import { connectStore, deleteStore, resetOwnershipChecks, updateStore, verifyStore } from "@/lib/commerce/stores";
import { WEBHOOK_ID_TTL_MS, bodyDigest, recordWebhookId, resetWebhookGuard } from "@/lib/commerce/webhook-guard";

const DOMAIN = "victim.myshopify.com";
const OWNER_TOKEN = "shpat_owner_token_01";
const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("base64");
const checkout = { id: 1, token: "tok1", phone: "9876543210", total_price: "10", currency: "inr", line_items: [] };

function hook(secret: string, id: string | null, topic = "checkouts/update", payload: unknown = checkout) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "x-shopify-topic": topic, "x-shopify-shop-domain": DOMAIN, "x-shopify-hmac-sha256": sign(body, secret) };
  if (id) headers["x-shopify-webhook-id"] = id;
  return new Request("https://wa.edwyz.com/webhooks/shopify", { method: "POST", headers, body });
}
const store = (tenantId: string) => mem.stores.find((s) => s.tenantId === tenantId)!;
const legacyStore = (tenantId: string, secret: string) => {
  mem.stores.push({ id: `legacy-${tenantId}`, tenantId, shopDomain: DOMAIN, status: "active", tokenEnc: "", webhookSecretEnc: `sealed:${tenantId}:${secret}`, createdAt: new Date() });
};

beforeEach(() => {
  mem.settings.clear();
  mem.stores = [];
  mem.tokens = new Map([[DOMAIN, OWNER_TOKEN]]);
  vi.clearAllMocks();
  resetWebhookGuard();
  void resetOwnershipChecks();
});

describe("store ownership (P3-10)", () => {
  it("without an Admin API token the store stays pending, holds no claim and the token is never stored", async () => {
    const out = await connectStore("t1", { shopDomain: DOMAIN, webhookSecret: "secret-one-1" });
    expect(out).toMatchObject({ status: "pending_verification", verified: false });
    expect(mem.settings.has(`shopify:claim:${DOMAIN}`)).toBe(false);
    await connectStore("t2", { shopDomain: "other.myshopify.com", webhookSecret: "secret-two-2", accessToken: "shpat_wrong_token_9" }).catch(() => undefined);
    expect(JSON.stringify([...mem.settings])).not.toContain("shpat_");
    expect(mem.stores).toHaveLength(1);
    expect(mem.stores[0].tokenEnc).toBe("sealed:t1:");
  });

  it("a token that Shopify accepts for that shop activates the store and takes the claim at once", async () => {
    const out = await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    expect(out).toMatchObject({ status: "active", verified: true });
    expect(mem.settings.get(`shopify:claim:${DOMAIN}`)!.value).toMatchObject({ tenantId: "owner" });
    expect(JSON.stringify([...mem.settings])).not.toContain(OWNER_TOKEN);
    // the token is kept sealed (it is used again to re-verify) and is never part of what the API returns
    expect(mem.stores[0].tokenEnc).toBe(`sealed:owner:${OWNER_TOKEN}`);
    expect(JSON.stringify(out)).not.toContain(OWNER_TOKEN);
    expect(JSON.stringify(out)).not.toContain("sealed:");
    expect(Object.keys(out)).not.toContain("tokenEnc");
  });

  it("a token Shopify rejects creates nothing", async () => {
    await expect(connectStore("attacker", { shopDomain: DOMAIN, webhookSecret: "attacker-secret", accessToken: "shpat_made_up_token" })).rejects.toMatchObject({ status: 422 });
    expect(mem.stores).toHaveLength(0);
    expect(mem.settings.size).toBe(0);
  });

  it("a forged webhook signed with the attacker's own secret does not activate the store, so the real owner can still verify", async () => {
    await connectStore("attacker", { shopDomain: DOMAIN, webhookSecret: "attacker-secret" });
    expect((await webhook(hook("attacker-secret", "wh-attacker-1"))).status).toBe(401);
    expect(store("attacker").status).toBe("pending_verification");
    expect(mem.settings.has(`shopify:claim:${DOMAIN}`)).toBe(false);
    expect(cart.ingestCheckout).not.toHaveBeenCalled();

    await expect(connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN })).resolves.toMatchObject({ status: "active" });
    expect(mem.settings.get(`shopify:claim:${DOMAIN}`)!.value).toMatchObject({ tenantId: "owner" });
    expect(store("attacker").status).toBe("pending_verification");
  });

  it("the attacker cannot verify the shop later either, whatever they were first to connect", async () => {
    await connectStore("attacker", { shopDomain: DOMAIN, webhookSecret: "attacker-secret" });
    await expect(updateStore("attacker", store("attacker").id, { accessToken: "shpat_made_up_token" })).rejects.toMatchObject({ status: 422 });
    expect(store("attacker").status).toBe("pending_verification");
    expect(store("attacker").tokenEnc).toBe("sealed:attacker:");
  });

  it("an unverified connection says nothing about who else has the shop", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    const probe = await connectStore("prober", { shopDomain: DOMAIN, webhookSecret: "prober-secret" });
    expect(probe.status).toBe("pending_verification");
    expect(db.shopifyStore.findFirst.mock.calls.at(-1)![0].where).toEqual({ shopDomain: DOMAIN, tenantId: "prober" });
  });

  // Replaces "a second workspace that also proves control is refused while the first holds the shop": first come, first served locked a real
  // merchant out of the domain when an ex-agency still held the claim. The newest valid proof now wins.
  it("a workspace that proves control later takes the shop over: the old holder goes back to pending and stops receiving data", async () => {
    await connectStore("first", { shopDomain: DOMAIN, webhookSecret: "first-secret-1", accessToken: OWNER_TOKEN });
    expect((await webhook(hook("first-secret-1", "wh-first-on1"))).status).toBe(200);
    const out = await connectStore("second", { shopDomain: DOMAIN, webhookSecret: "second-secret", accessToken: OWNER_TOKEN });
    expect(out).toMatchObject({ status: "active", verified: true });
    expect(mem.settings.get(`shopify:claim:${DOMAIN}`)!.value).toMatchObject({ tenantId: "second", storeId: store("second").id });
    expect(store("first").status).toBe("pending_verification");
    vi.clearAllMocks();
    expect((await webhook(hook("first-secret-1", "wh-first-on2"))).status).toBe(401);
    expect((await webhook(hook("second-secret", "wh-second-01"))).status).toBe(200);
    expect(cart.ingestCheckout.mock.calls.map((c) => c[0].tenantId)).toEqual(["second"]);
  });

  it("an unproven connection never displaces the holder, and a displaced workspace takes the shop back only with a token Shopify accepts", async () => {
    await connectStore("first", { shopDomain: DOMAIN, webhookSecret: "first-secret-1", accessToken: OWNER_TOKEN });
    await connectStore("squatter", { shopDomain: DOMAIN, webhookSecret: "squatter-secret" });
    await expect(verifyStore("squatter", store("squatter").id, { accessToken: "shpat_made_up_token" })).rejects.toMatchObject({ status: 422 });
    expect(store("first").status).toBe("active");
    await connectStore("second", { shopDomain: DOMAIN, webhookSecret: "second-secret", accessToken: OWNER_TOKEN });
    expect(store("first").status).toBe("pending_verification");
    mem.tokens.set(DOMAIN, "shpat_rotated_token_2");
    await expect(verifyStore("first", store("first").id, {})).rejects.toMatchObject({ status: 422 });
    expect(store("second").status).toBe("active");
    expect((await verifyStore("first", store("first").id, { accessToken: "shpat_rotated_token_2" })).status).toBe("active");
    expect(store("second").status).toBe("pending_verification");
    expect(mem.settings.get(`shopify:claim:${DOMAIN}`)!.value).toMatchObject({ tenantId: "first" });
  });

  it("pending stores never receive data and never crowd out the verified one (more than five of them)", async () => {
    for (let i = 0; i < 8; i++) await connectStore(`pending${i}`, { shopDomain: DOMAIN, webhookSecret: `pending-secret-${i}` });
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    expect((await webhook(hook("owner-secret-1", "wh-owner-001"))).status).toBe(200);
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(1);
    expect(cart.ingestCheckout.mock.calls[0][0]).toMatchObject({ tenantId: "owner" });
    expect((await webhook(hook("pending-secret-3", "wh-pend-0003"))).status).toBe(401);
  });

  it("the first real checkout webhook after verification is ingested", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    expect((await webhook(hook("owner-secret-1", "wh-first-001"))).status).toBe(200);
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(1);
  });

  it("a proven owner takes the shop over from a store that was active before verification existed", async () => {
    legacyStore("squatter", "squatter-secret");
    expect((await webhook(hook("squatter-secret", "wh-legacy-01"))).status).toBe(200);
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    expect(store("squatter").status).toBe("pending_verification");
    expect(store("owner").status).toBe("active");
    vi.clearAllMocks();
    expect((await webhook(hook("squatter-secret", "wh-legacy-02"))).status).toBe(401);
    expect(cart.ingestCheckout).not.toHaveBeenCalled();
  });

  it("two concurrent claims for one domain produce exactly one winner", async () => {
    for (const [id, tenantId] of [["s1", "a"], ["s2", "b"]]) mem.stores.push({ id, tenantId, shopDomain: DOMAIN, status: "pending_verification", tokenEnc: "", webhookSecretEnc: null, createdAt: new Date() });
    const results = await Promise.all([claimShopDomain(DOMAIN, "a", "s1"), claimShopDomain(DOMAIN, "b", "s2")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("replaces a stale claim whose store is gone, but not a live one", async () => {
    mem.settings.set(`shopify:claim:${DOMAIN}`, { value: { tenantId: "gone", storeId: "sx" }, updatedAt: new Date() });
    expect(await claimShopDomain(DOMAIN, "a", "s1")).toBe(true);
    mem.stores.push({ id: "s1", tenantId: "a", shopDomain: DOMAIN, status: "active", tokenEnc: "", webhookSecretEnc: null, createdAt: new Date() });
    expect(await claimShopDomain(DOMAIN, "b", "s2")).toBe(false);
  });

  it("disabling or deleting releases the domain; resuming needs the token again and works at once", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    const id = store("owner").id;
    await updateStore("owner", id, { status: "disabled" });
    expect(mem.settings.has(`shopify:claim:${DOMAIN}`)).toBe(false);
    expect((await webhook(hook("owner-secret-1", "wh-while-off"))).status).toBe(401);

    await expect(updateStore("owner", id, { status: "active", accessToken: "shpat_made_up_token" })).rejects.toMatchObject({ status: 422 });
    expect(store("owner").status).toBe("disabled");
    expect(store("owner").tokenEnc).toBe(`sealed:owner:${OWNER_TOKEN}`);

    const resumed = await updateStore("owner", id, { status: "active", accessToken: OWNER_TOKEN });
    expect(resumed.status).toBe("active");
    expect((await webhook(hook("owner-secret-1", "wh-after-on"))).status).toBe(200);
    await deleteStore("owner", id);
    expect(mem.settings.has(`shopify:claim:${DOMAIN}`)).toBe(false);
  });

  it("a pending store is verified later with PATCH accessToken", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1" });
    const out = await updateStore("owner", store("owner").id, { accessToken: OWNER_TOKEN });
    expect(out.status).toBe("active");
    expect(mem.settings.get(`shopify:claim:${DOMAIN}`)!.value).toMatchObject({ tenantId: "owner" });
  });

  it("resuming re-verifies with the saved token when none is sent, and fails clearly when Shopify no longer accepts it", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    const id = store("owner").id;
    await updateStore("owner", id, { status: "disabled" });
    mem.tokens.delete(DOMAIN);
    await expect(updateStore("owner", id, { status: "active" })).rejects.toMatchObject({ status: 422 });
    expect(store("owner").status).toBe("disabled");
    mem.tokens.set(DOMAIN, OWNER_TOKEN);
    expect((await updateStore("owner", id, { status: "active" })).status).toBe("active");
    expect(mem.settings.get(`shopify:claim:${DOMAIN}`)!.value).toMatchObject({ tenantId: "owner" });
  });

  it("resuming a store that has no saved token and gets none is a plain 422 and changes nothing", async () => {
    legacyStore("old", "old-secret-1");
    store("old").status = "disabled";
    store("old").tokenEnc = "";
    await expect(updateStore("old", store("old").id, { status: "active" })).rejects.toMatchObject({ status: 422 });
    expect(store("old").status).toBe("disabled");
  });

  it("a malformed token is rejected before anything is called", async () => {
    await expect(connectStore("t1", { shopDomain: DOMAIN, webhookSecret: "secret-one-1", accessToken: "bad token" })).rejects.toMatchObject({ status: 422 });
    expect(mem.stores).toHaveLength(0);
  });

  it("a malformed domain is rejected before anything is called or stored (SSRF attempts)", async () => {
    const attempts = ["evil.com", "127.0.0.1", "169.254.169.254", "user@victim.myshopify.com", "victim.myshopify.com:8443", "victim.myshopify.com.evil.com", "https://victim.myshopify.com/", "a.b.myshopify.com", "[::1]"];
    for (const shopDomain of attempts) {
      await expect(connectStore("t1", { shopDomain, webhookSecret: "secret-one-1", accessToken: OWNER_TOKEN })).rejects.toMatchObject({ status: 400 });
    }
    expect(mem.stores).toHaveLength(0);
    expect(mem.settings.size).toBe(0);
  });

  it("verifyStore activates a pending store with a pasted token and keeps it sealed", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1" });
    const id = store("owner").id;
    await expect(verifyStore("owner", id, {})).rejects.toMatchObject({ status: 422 });
    await expect(verifyStore("owner", id, { accessToken: "shpat_made_up_token" })).rejects.toMatchObject({ status: 422 });
    expect(store("owner").status).toBe("pending_verification");
    const out = await verifyStore("owner", id, { accessToken: OWNER_TOKEN });
    expect(out).toMatchObject({ status: "active", verified: true });
    expect(store("owner").tokenEnc).toBe(`sealed:owner:${OWNER_TOKEN}`);
    expect(mem.settings.get(`shopify:claim:${DOMAIN}`)!.value).toMatchObject({ tenantId: "owner" });
    expect(JSON.stringify(out)).not.toContain(OWNER_TOKEN);
  });

  it("verifyStore uses the token saved with an older pending store when none is sent", async () => {
    mem.stores.push({ id: "old1", tenantId: "owner", shopDomain: DOMAIN, status: "pending_verification", tokenEnc: `sealed:owner:${OWNER_TOKEN}`, webhookSecretEnc: "sealed:owner:owner-secret-1", createdAt: new Date() });
    expect((await verifyStore("owner", "old1", {})).status).toBe("active");
  });

  it("verifyStore clears the negative lookup cache so the first webhook is accepted", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1" });
    expect((await webhook(hook("owner-secret-1", "wh-pend-0001"))).status).toBe(401);
    await verifyStore("owner", store("owner").id, { accessToken: OWNER_TOKEN });
    expect((await webhook(hook("owner-secret-1", "wh-pend-0002"))).status).toBe(200);
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(1);
  });

  // Was "... loses a race for a held domain" (409). Once Shopify accepts the token the verifying workspace takes the domain over.
  it("verifyStore is scoped to the workspace, refuses paused stores and takes a held domain over once Shopify accepts the token", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    await expect(verifyStore("intruder", store("owner").id, { accessToken: OWNER_TOKEN })).rejects.toMatchObject({ status: 404 });
    await connectStore("second", { shopDomain: DOMAIN, webhookSecret: "second-secret" });
    await expect(verifyStore("second", store("second").id, { accessToken: "shpat_made_up_token" })).rejects.toMatchObject({ status: 422 });
    expect(store("second").status).toBe("pending_verification");
    expect(store("owner").status).toBe("active");
    await verifyStore("second", store("second").id, { accessToken: OWNER_TOKEN });
    expect(store("second").status).toBe("active");
    expect(store("owner").status).toBe("pending_verification");
    await updateStore("second", store("second").id, { status: "disabled" });
    await expect(verifyStore("second", store("second").id, { accessToken: OWNER_TOKEN })).rejects.toMatchObject({ status: 409 });
  });

  it("the domain claim is held only by an active store: disabling frees it for another workspace that proves control", async () => {
    await connectStore("first", { shopDomain: DOMAIN, webhookSecret: "first-secret-1", accessToken: OWNER_TOKEN });
    await updateStore("first", store("first").id, { status: "disabled" });
    await expect(connectStore("second", { shopDomain: DOMAIN, webhookSecret: "second-secret", accessToken: OWNER_TOKEN })).resolves.toMatchObject({ status: "active" });
    expect(mem.settings.get(`shopify:claim:${DOMAIN}`)!.value).toMatchObject({ tenantId: "second" });
    expect((await webhook(hook("first-secret-1", "wh-first-off1"))).status).toBe(401);
  });


  it("cannot change another workspace's store through update", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1" });
    await expect(updateStore("intruder", mem.stores[0].id, { status: "disabled" })).rejects.toMatchObject({ status: 404 });
    expect(mem.stores[0].status).toBe("pending_verification");
  });
});

describe("webhook replay and flood protection (P3-24)", () => {
  async function activeStore() {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    vi.clearAllMocks();
  }

  it("processes a delivery id once and acknowledges replays without processing", async () => {
    await activeStore();
    expect((await webhook(hook("owner-secret-1", "wh-id-0000001"))).status).toBe(200);
    expect((await webhook(hook("owner-secret-1", "wh-id-0000001"))).status).toBe(200);
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(1);
    expect((await webhook(hook("owner-secret-1", "wh-id-0000002", "checkouts/update", { ...checkout, token: "tok2" }))).status).toBe(200);
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(2);
  });

  it("a replayed signed body is a duplicate even with no id header or a fresh one (the id is not covered by the signature)", async () => {
    await activeStore();
    await webhook(hook("owner-secret-1", "wh-id-orig001"));
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(1);
    expect((await webhook(hook("owner-secret-1", null))).status).toBe(200);
    expect((await webhook(hook("owner-secret-1", "wh-id-fresh001"))).status).toBe(200);
    expect((await webhook(hook("owner-secret-1", "wh-id-fresh002"))).status).toBe(200);
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(1);
  });

  it("changing the unsigned topic header on a replayed body does not make it a new delivery", async () => {
    await activeStore();
    await webhook(hook("owner-secret-1", null, "checkouts/update"));
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(1);
    expect((await webhook(hook("owner-secret-1", null, "checkouts/create"))).status).toBe(200);
    expect((await webhook(hook("owner-secret-1", "wh-id-fresh003", "orders/create"))).status).toBe(200);
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(1);
    expect(cart.markRecovered).not.toHaveBeenCalled();
  });

  it("without the id header the guard is the body hash, kept 48 hours; with it, the id and the body hash are both recorded", async () => {
    await activeStore();
    const keys = () => [...mem.settings.keys()].filter((k) => k.startsWith("shopify:webhook:"));
    await webhook(hook("owner-secret-1", null));
    expect(keys()).toHaveLength(1);
    expect(keys()[0]).toContain(":body:");
    await webhook(hook("owner-secret-1", "wh-id-both001", "checkouts/update", { ...checkout, token: "tok7" }));
    expect(keys()).toHaveLength(3);
    expect(keys().some((k) => k.endsWith(":wh-id-both001"))).toBe(true);
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(2);
    // once the body hash is older than 48 hours the record is renewed, so the same body is accepted again
    const bodyKey = keys().find((k) => k.includes(":body:"))!;
    (mem.settings.get(bodyKey) as Setting).updatedAt = new Date(Date.now() - WEBHOOK_ID_TTL_MS - 1);
    await webhook(hook("owner-secret-1", null));
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(3);
  });

  it("a delivery id that was already used is a duplicate even for a different valid body", async () => {
    await activeStore();
    await webhook(hook("owner-secret-1", "wh-id-reuse001"));
    expect((await webhook(hook("owner-secret-1", "wh-id-reuse001", "checkouts/update", { ...checkout, token: "tok8" }))).status).toBe(200);
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(1);
  });

  it("digests depend on the exact body only", () => {
    expect(bodyDigest("{}")).not.toBe(bodyDigest("{ }"));
    expect(bodyDigest("{}")).toBe(bodyDigest("{}"));
  });

  it("an event older than the dedupe window is ignored, so a replay after the records expire cannot be processed", async () => {
    await activeStore();
    const old = new Date(Date.now() - WEBHOOK_ID_TTL_MS - 3_600_000).toISOString();
    expect((await webhook(hook("owner-secret-1", "wh-id-old0001", "checkouts/update", { ...checkout, updated_at: old }))).status).toBe(200);
    expect(cart.ingestCheckout).not.toHaveBeenCalled();
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    await webhook(hook("owner-secret-1", "wh-id-new0001", "checkouts/update", { ...checkout, updated_at: recent }));
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(1);
  });

  it("lets the Shopify retry through when processing failed", async () => {
    await activeStore();
    cart.ingestCheckout.mockRejectedValueOnce(new Error("db down"));
    expect((await webhook(hook("owner-secret-1", "wh-id-0000003"))).status).toBe(500);
    expect((await webhook(hook("owner-secret-1", "wh-id-0000003"))).status).toBe(200);
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(2);
  });

  it("forgets ids after 48 hours", async () => {
    const t0 = Date.now();
    expect(await recordWebhookId("s1", "wh-id-0000004", t0)).toBe("new");
    expect(await recordWebhookId("s1", "wh-id-0000004", t0 + 1000)).toBe("duplicate");
    (mem.settings.get("shopify:webhook:s1:wh-id-0000004") as Setting).updatedAt = new Date(t0 - WEBHOOK_ID_TTL_MS - 1);
    expect(await recordWebhookId("s1", "wh-id-0000004", t0)).toBe("new");
  });

  it("does not record anything for unauthenticated requests", async () => {
    await activeStore();
    await webhook(hook("wrong", "wh-id-0000005"));
    expect([...mem.settings.keys()].some((k) => k.startsWith("shopify:webhook:"))).toBe(false);
  });

  it("answers repeated lookups for an unknown shop from memory for a minute", async () => {
    expect((await webhook(hook("x", "wh-id-0000006"))).status).toBe(401);
    expect((await webhook(hook("x", "wh-id-0000007"))).status).toBe(401);
    expect((await webhook(hook("x", "wh-id-0000008"))).status).toBe(401);
    expect(db.shopifyStore.findMany).toHaveBeenCalledTimes(1);
  });

  it("a store verified right after a negative lookup is not locked out", async () => {
    await webhook(hook("owner-secret-1", null));
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    expect((await webhook(hook("owner-secret-1", null))).status).toBe(200);
  });

  it("resuming a disabled store clears the negative cache, so Shopify's test notification inside the minute is accepted", async () => {
    await activeStore();
    const id = store("owner").id;
    await updateStore("owner", id, { status: "disabled" });
    expect((await webhook(hook("owner-secret-1", "wh-id-off0001"))).status).toBe(401);
    await updateStore("owner", id, { status: "active", accessToken: OWNER_TOKEN });
    expect((await webhook(hook("owner-secret-1", "wh-id-on00001", "checkouts/update", { ...checkout, token: "tok9" }))).status).toBe(200);
    expect(cart.ingestCheckout).toHaveBeenCalledTimes(1);
  });
});

describe("stores that were active before ownership proof existed", () => {
  it("verifyStore on a legacy active store takes the claim and demotes the other unproven active stores for the domain", async () => {
    legacyStore("legacy-a", "legacy-a-secret");
    legacyStore("legacy-b", "legacy-b-secret");
    mem.stores[0].tokenEnc = `sealed:legacy-a:${OWNER_TOKEN}`;
    expect(mem.settings.has(`shopify:claim:${DOMAIN}`)).toBe(false);
    const out = await verifyStore("legacy-a", store("legacy-a").id, {});
    expect(out).toMatchObject({ status: "active", verified: true });
    expect(mem.settings.get(`shopify:claim:${DOMAIN}`)!.value).toMatchObject({ tenantId: "legacy-a", storeId: store("legacy-a").id });
    expect(store("legacy-b").status).toBe("pending_verification");
    expect((await webhook(hook("legacy-b-secret", "wh-legacy-b1"))).status).toBe(401);
    expect((await webhook(hook("legacy-a-secret", "wh-legacy-a1"))).status).toBe(200);
  });

  it("re-verifying a legacy active store that another workspace has since claimed takes the shop over and demotes the claim holder", async () => {
    await connectStore("holder", { shopDomain: DOMAIN, webhookSecret: "holder-secret-1", accessToken: OWNER_TOKEN });
    legacyStore("legacy", "legacy-secret-1");
    await verifyStore("legacy", store("legacy").id, { accessToken: OWNER_TOKEN });
    expect(mem.settings.get(`shopify:claim:${DOMAIN}`)!.value).toMatchObject({ tenantId: "legacy" });
    expect(store("holder").status).toBe("pending_verification");
  });

  it("demoteUnclaimedStores sends every active store without the claim back to pending, leaves claim holders alone and is safe to repeat", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    legacyStore("legacy", "legacy-secret-1");
    mem.stores.push({ id: "other1", tenantId: "o", shopDomain: "other.myshopify.com", status: "active", tokenEnc: "", webhookSecretEnc: null, createdAt: new Date() });
    mem.stores.push({ id: "off1", tenantId: "o", shopDomain: "off.myshopify.com", status: "disabled", tokenEnc: "", webhookSecretEnc: null, createdAt: new Date() });
    expect(await demoteUnclaimedStores()).toBe(2);
    expect(store("owner").status).toBe("active");
    expect(store("legacy").status).toBe("pending_verification");
    expect(mem.stores.find((s) => s.id === "other1")!.status).toBe("pending_verification");
    expect(mem.stores.find((s) => s.id === "off1")!.status).toBe("disabled");
    expect(await demoteUnclaimedStores()).toBe(0);
  });
});

describe("PATCH edge cases (updateStore)", () => {
  async function owned() {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    return store("owner").id;
  }

  it("a pasted token on an active store is verified and replaces the saved one; a rejected token changes nothing", async () => {
    const id = await owned();
    mem.tokens.set(DOMAIN, "shpat_rotated_token_2");
    await expect(updateStore("owner", id, { accessToken: "shpat_made_up_token" })).rejects.toMatchObject({ status: 422 });
    expect(store("owner").tokenEnc).toBe(`sealed:owner:${OWNER_TOKEN}`);
    const out = await updateStore("owner", id, { accessToken: "shpat_rotated_token_2" });
    expect(out.status).toBe("active");
    expect(store("owner").tokenEnc).toBe("sealed:owner:shpat_rotated_token_2");
    expect(JSON.stringify(out)).not.toContain("shpat_");
  });

  it("a pasted token on an active legacy store claims the domain like verifyStore does", async () => {
    legacyStore("legacy", "legacy-secret-1");
    await updateStore("legacy", store("legacy").id, { accessToken: OWNER_TOKEN });
    expect(mem.settings.get(`shopify:claim:${DOMAIN}`)!.value).toMatchObject({ tenantId: "legacy" });
  });

  it("a pasted token on a paused store without a status is verified and saved, and the store stays paused with no claim", async () => {
    const id = await owned();
    await updateStore("owner", id, { status: "disabled" });
    mem.tokens.set(DOMAIN, "shpat_rotated_token_2");
    await expect(updateStore("owner", id, { accessToken: "shpat_made_up_token" })).rejects.toMatchObject({ status: 422 });
    expect(store("owner").tokenEnc).toBe(`sealed:owner:${OWNER_TOKEN}`);
    const out = await updateStore("owner", id, { accessToken: "shpat_rotated_token_2" });
    expect(out.status).toBe("disabled");
    expect(store("owner").tokenEnc).toBe("sealed:owner:shpat_rotated_token_2");
    expect(mem.settings.has(`shopify:claim:${DOMAIN}`)).toBe(false);
  });

  it("disabling a pending store together with a token is a 400 that does not call Shopify and writes nothing; disabling alone just works", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1" });
    const id = store("owner").id;
    const verify = (await import("@/lib/commerce/admin-verify")).verifyShopOwnership;
    vi.mocked(verify).mockClear();
    await expect(updateStore("owner", id, { status: "disabled", accessToken: OWNER_TOKEN })).rejects.toMatchObject({ status: 400 });
    expect(verify).not.toHaveBeenCalled();
    expect(store("owner")).toMatchObject({ status: "pending_verification", tokenEnc: "sealed:owner:" });
    expect((await updateStore("owner", id, { status: "disabled" })).status).toBe("disabled");
  });

  it("a resume that loses the claim race fails with 409, leaves the store paused and does not demote anyone", async () => {
    const id = await owned();
    await updateStore("owner", id, { status: "disabled" });
    await connectStore("rival", { shopDomain: DOMAIN, webhookSecret: "rival-secret-1", accessToken: OWNER_TOKEN });
    // our claim is created cleanly, then a concurrent takeover replaces it before we check that we still hold it
    mem.settings.delete(`shopify:claim:${DOMAIN}`);
    db.platformSetting.findUnique.mockResolvedValueOnce({ key: `shopify:claim:${DOMAIN}`, value: { tenantId: "rival", storeId: store("rival").id }, updatedAt: new Date() });
    await expect(updateStore("owner", id, { status: "active", accessToken: OWNER_TOKEN })).rejects.toMatchObject({ status: 409 });
    expect(store("owner").status).toBe("disabled");
    expect(store("rival").status).toBe("active");
  });
});

describe("ownership check limits", () => {
  it("allows a dozen checks per workspace per window, then answers 429 without calling Shopify", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1" });
    const id = store("owner").id;
    const verify = (await import("@/lib/commerce/admin-verify")).verifyShopOwnership;
    vi.mocked(verify).mockClear();
    for (let i = 0; i < 12; i++) await expect(verifyStore("owner", id, { accessToken: "shpat_made_up_token" })).rejects.toMatchObject({ status: 422 });
    await expect(verifyStore("owner", id, { accessToken: OWNER_TOKEN })).rejects.toMatchObject({ status: 429 });
    expect(verify).toHaveBeenCalledTimes(12);
    await expect(verifyStore("someone-else", id, {})).rejects.toMatchObject({ status: 404 });
    await resetOwnershipChecks();
    await expect(verifyStore("owner", id, { accessToken: OWNER_TOKEN })).resolves.toMatchObject({ status: "active" });
  });
});

describe("replay guard and ignored topics", () => {
  it("an ignored topic neither records nor consumes the digest, so a later handled delivery with the same bytes is processed", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    vi.clearAllMocks();
    const order = { id: 9, checkout_id: 1, checkout_token: "tok1", updated_at: new Date().toISOString() };
    for (const topic of ["orders/updated", "orders/paid", "carts/update"]) expect((await webhook(hook("owner-secret-1", null, topic, order))).status).toBe(200);
    expect([...mem.settings.keys()].filter((k) => k.startsWith("shopify:webhook:"))).toHaveLength(0);
    expect(cart.markRecovered).not.toHaveBeenCalled();
    expect((await webhook(hook("owner-secret-1", "wh-order-0001", "orders/create", order))).status).toBe(200);
    expect(cart.markRecovered).toHaveBeenCalledTimes(1);
    expect((await webhook(hook("owner-secret-1", "wh-order-0002", "orders/create", order))).status).toBe(200);
    expect(cart.markRecovered).toHaveBeenCalledTimes(1);
  });

  it("a delivery without a topic header is acknowledged and neither processed nor recorded", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1", accessToken: OWNER_TOKEN });
    vi.clearAllMocks();
    const body = JSON.stringify(checkout);
    const res = await webhook(new Request("https://wa.edwyz.com/webhooks/shopify", { method: "POST", headers: { "x-shopify-shop-domain": DOMAIN, "x-shopify-hmac-sha256": sign(body, "owner-secret-1") }, body }));
    expect(res.status).toBe(200);
    expect(cart.ingestCheckout).not.toHaveBeenCalled();
    expect([...mem.settings.keys()].filter((k) => k.startsWith("shopify:webhook:"))).toHaveLength(0);
  });
});

describe("negative lookup cache", () => {
  it("is cleared when a store is verified from pending and when a paused one is resumed", async () => {
    await connectStore("owner", { shopDomain: DOMAIN, webhookSecret: "owner-secret-1" });
    const id = store("owner").id;
    expect((await webhook(hook("owner-secret-1", "wh-neg-00001"))).status).toBe(401);
    await verifyStore("owner", id, { accessToken: OWNER_TOKEN });
    expect((await webhook(hook("owner-secret-1", "wh-neg-00002"))).status).toBe(200);
    await updateStore("owner", id, { status: "disabled" });
    expect((await webhook(hook("owner-secret-1", "wh-neg-00003"))).status).toBe(401);
    await updateStore("owner", id, { status: "active", accessToken: OWNER_TOKEN });
    expect((await webhook(hook("owner-secret-1", "wh-neg-00004", "checkouts/update", { ...checkout, token: "tok4" }))).status).toBe(200);
  });
});

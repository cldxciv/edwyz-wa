import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Conn = { id: string; tenantId: string; metaUserId: string; status: string; tokenEnc: string; tokenExpiresAt: Date | null };
type Asset = { id: string; tenantId: string; connectionId: string; type: string; status: string; tokenEnc: string | null; meta: Record<string, unknown> };

const store = vi.hoisted(() => ({ conns: [] as unknown[], assets: [] as unknown[], audits: [] as unknown[], failFind: false }));
const conns = () => store.conns as Conn[];
const assets = () => store.assets as Asset[];

vi.mock("@/lib/db", () => ({
  prisma: {
    metaConnection: {
      findMany: vi.fn(async ({ where }: { where: { metaUserId: string } }) => {
        if (store.failFind) throw new Error("db down");
        return (store.conns as Conn[]).filter((c) => c.metaUserId === where.metaUserId && (c.status !== "revoked" || c.tokenEnc !== ""));
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; tenantId: string }; data: Partial<Conn> }) => {
        for (const c of store.conns as Conn[]) if (c.id === where.id && c.tenantId === where.tenantId) Object.assign(c, data);
        return { count: 1 };
      }),
    },
    metaAsset: {
      findMany: vi.fn(async ({ where }: { where: { tenantId: string; connectionId: string; type: string } }) =>
        (store.assets as Asset[]).filter((a) => a.tenantId === where.tenantId && a.connectionId === where.connectionId && a.type === where.type),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: { id?: string; tenantId: string; connectionId?: string }; data: Partial<Asset> }) => {
        for (const a of store.assets as Asset[]) if (a.tenantId === where.tenantId && (where.id ? a.id === where.id : a.connectionId === where.connectionId)) Object.assign(a, data);
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: { data: unknown }) => void store.audits.push(data)) },
  },
}));

import * as route from "@/app/api/meta/deauthorize/route";
import { config as proxyConfig } from "@/proxy";

const SECRET = "deauth-app-secret";
const b64 = (v: string) => Buffer.from(v).toString("base64url");
const sign = (payload: object, secret = SECRET) => {
  const body = b64(JSON.stringify(payload));
  return `${createHmac("sha256", secret).update(body).digest("base64url")}.${body}`;
};
const signedBody = (signed: string) => new URLSearchParams({ signed_request: signed });
let ipCounter = 0;
const post = (body: BodyInit | null, headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }, ip = `203.0.113.${++ipCounter % 250}`) =>
  new Request("https://wa.edwyz.com/api/meta/deauthorize", { method: "POST", body, headers: { ...headers, "x-real-ip": ip } });
const valid = (extra: object = {}) => ({ algorithm: "HMAC-SHA256", user_id: "fb-user-1", issued_at: 1_790_000_000, ...extra });

beforeEach(() => {
  process.env.META_APP_SECRET = SECRET;
  store.failFind = false;
  store.audits = [];
  store.conns = [
    { id: "c1", tenantId: "t1", metaUserId: "fb-user-1", status: "active", tokenEnc: "sealed-1", tokenExpiresAt: new Date("2027-01-01") },
    { id: "c2", tenantId: "t2", metaUserId: "fb-user-1", status: "expiring", tokenEnc: "sealed-2", tokenExpiresAt: null },
    { id: "c3", tenantId: "t3", metaUserId: "someone-else", status: "active", tokenEnc: "sealed-3", tokenExpiresAt: null },
  ];
  store.assets = [
    { id: "a1", tenantId: "t1", connectionId: "c1", type: "page", status: "active", tokenEnc: "page-token-1", meta: { leadgenSubscription: "subscribed", keep: 1 } },
    { id: "a2", tenantId: "t1", connectionId: "c1", type: "ad_account", status: "active", tokenEnc: null, meta: {} },
    { id: "a3", tenantId: "t3", connectionId: "c3", type: "page", status: "active", tokenEnc: "page-token-3", meta: { leadgenSubscription: "subscribed" } },
  ];
});

describe("POST /api/meta/deauthorize", () => {
  it("revokes every connection of that Meta user across workspaces, wipes sealed tokens and leaves other users alone", async () => {
    const res = await route.POST(post(signedBody(sign(valid()))));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(conns().find((c) => c.id === "c1")).toMatchObject({ status: "revoked", tokenEnc: "", tokenExpiresAt: null });
    expect(conns().find((c) => c.id === "c2")).toMatchObject({ status: "revoked", tokenEnc: "" });
    expect(conns().find((c) => c.id === "c3")).toMatchObject({ status: "active", tokenEnc: "sealed-3" });
    expect(assets().filter((a) => a.connectionId === "c1").map((a) => [a.status, a.tokenEnc])).toEqual([
      ["inactive", null],
      ["inactive", null],
    ]);
    expect(assets().find((a) => a.id === "a1")!.meta).toEqual({ keep: 1 });
    expect(assets().find((a) => a.id === "a3")).toMatchObject({ status: "active", tokenEnc: "page-token-3" });
  });

  it("writes one audit row per connection with ids only: no payload, no signed_request, no Meta user id", async () => {
    await route.POST(post(signedBody(sign(valid({ extra_field: "private-value" })))));
    expect(store.audits).toHaveLength(2);
    expect(store.audits.map((a) => (a as { action: string }).action)).toEqual(["meta_connect.deauthorized", "meta_connect.deauthorized"]);
    expect(store.audits.map((a) => (a as { tenantId: string }).tenantId).sort()).toEqual(["t1", "t2"]);
    const text = JSON.stringify(store.audits);
    for (const leaked of ["fb-user-1", "private-value", "signed_request", "issued_at", "extra_field", "sealed-1"]) expect(text).not.toContain(leaked);
  });

  it("is idempotent and still answers 200 (with a platform audit row) when nothing matches", async () => {
    await route.POST(post(signedBody(sign(valid()))));
    store.audits = [];
    const again = await route.POST(post(signedBody(sign(valid()))));
    expect(again.status).toBe(200);
    expect(store.audits).toEqual([{ tenantId: null, userId: null, action: "meta_connect.deauthorize_received", target: null, meta: { connections: 0 } }]);
    expect((await route.POST(post(signedBody(sign(valid({ user_id: "nobody" })))))).status).toBe(200);
  });

  it("rejects a bad signature, a signature made with another secret and a tampered payload", async () => {
    const good = sign(valid());
    const [sig, body] = good.split(".");
    for (const bad of [sign(valid(), "other-secret"), `${"A".repeat(sig.length)}.${body}`, `${sig}.${b64(JSON.stringify(valid({ user_id: "fb-user-2" })))}`, sig, `${sig}.${body}.extra`, "", "a.b"]) {
      const res = await route.POST(post(signedBody(bad)));
      expect(res.status).toBe(400);
    }
    expect(conns().every((c) => c.status !== "revoked")).toBe(true);
    expect(store.audits).toEqual([]);
  });

  it("rejects any algorithm other than HMAC-SHA256, including a missing one, even when correctly signed", async () => {
    for (const algorithm of ["HMAC-SHA1", "none", "HMAC-SHA512", 5, null]) {
      expect((await route.POST(post(signedBody(sign({ ...valid(), algorithm }))))).status).toBe(400);
    }
    const { algorithm: _omitted, ...noAlgorithm } = valid();
    expect((await route.POST(post(signedBody(sign(noAlgorithm))))).status).toBe(400);
    expect(conns().every((c) => c.status !== "revoked")).toBe(true);
    expect((await route.POST(post(signedBody(sign(valid({ algorithm: "hmac-sha256" })))))).status).toBe(200);
    expect(conns().find((c) => c.id === "c3")!.status).toBe("active");
  });

  it("rejects a signed payload with no usable user_id", async () => {
    for (const user_id of [undefined, 123, "", "x".repeat(65), null]) {
      expect((await route.POST(post(signedBody(sign({ algorithm: "HMAC-SHA256", user_id }))))).status).toBe(400);
    }
  });

  it("fails closed when META_APP_SECRET is not set", async () => {
    delete process.env.META_APP_SECRET;
    expect((await route.POST(post(signedBody(sign(valid()))))).status).toBe(400);
    expect(conns().every((c) => c.status !== "revoked")).toBe(true);
  });

  it("rejects a missing signed_request, a JSON body and an oversized body without touching data", async () => {
    expect((await route.POST(post(new URLSearchParams({ other: "x" })))).status).toBe(400);
    expect((await route.POST(post(JSON.stringify({ signed_request: sign(valid()) }), { "content-type": "application/json" }))).status).toBe(400);
    expect((await route.POST(post("signed_request=" + "a".repeat(20_000)))).status).toBe(400);
    expect(conns().every((c) => c.status !== "revoked")).toBe(true);
  });

  it("answers 503 when the database fails, so the revocation is not silently lost", async () => {
    store.failFind = true;
    expect((await route.POST(post(signedBody(sign(valid()))))).status).toBe(503);
  });

  it("is public: no session and no same-origin header are needed", async () => {
    const res = await route.POST(post(signedBody(sign(valid())), { "content-type": "application/x-www-form-urlencoded" }));
    expect(res.status).toBe(200);
  });

  it("is rate limited per address", async () => {
    const same = "198.51.100.77";
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await route.POST(post(signedBody("bad.sig"), undefined, same))).status);
    expect(statuses.slice(0, 60).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
    const limited = await route.POST(post(signedBody("bad.sig"), undefined, same));
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await route.POST(post(signedBody("bad.sig"), undefined, "198.51.100.78"))).status).toBe(400);
  });
});

describe("other methods", () => {
  it.each(["GET", "PUT", "PATCH", "DELETE"] as const)("%s is refused with 405 and an Allow header", async (method) => {
    const res = route[method]();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(conns().every((c) => c.status !== "revoked")).toBe(true);
  });

  it("exports no handler besides POST and the refusals", () => {
    expect(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
  });
});

describe("reachability", () => {
  it("the page proxy and CSP never run for /api paths, so nothing there can block Meta", () => {
    const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);
    expect(matcher.test("/api/meta/deauthorize")).toBe(false);
    expect(matcher.test("/api/meta/data-deletion")).toBe(false);
    expect(matcher.test("/pricing")).toBe(true);
  });

  it("nginx forwards /api/meta/ with its own rate limit and does not block or auth-gate it", () => {
    const site = readFileSync("deploy/nginx-wa.edwyz.com.conf", "utf8");
    const zones = readFileSync("deploy/nginx-wa-zones.conf", "utf8");
    const block = /location \^~ \/api\/meta\/ \{([\s\S]*?)\n    \}/.exec(site)?.[1] ?? "";
    expect(block).toContain("limit_req zone=wa_meta");
    expect(block).toContain("proxy_pass http://127.0.0.1:3500");
    expect(block).not.toMatch(/\bdeny\b|auth_basic|auth_request/);
    expect(zones).toContain("zone=wa_meta:");
  });
});

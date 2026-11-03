import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/tokens", () => ({ getAccessToken: vi.fn(async () => "TENANT-TOKEN") }));

import { GRAPH_API_VERSION } from "@/lib/config";
import { GraphError, graphBaseOverride, graphFetch, graphFetchAs, graphUpload, type AppGraphRequest } from "@/lib/graph";
import { classify } from "@/lib/spend/classify";
import { SpendGuardBypassError } from "@/lib/spend/errors";
import { spendDryRun } from "@/lib/spend/flags";
import { setTripwireAuditSink, type TripwireAuditEvent } from "@/lib/spend/tripwire";
import { startFakeMetaServer, type FakeMetaServer } from "../e2e/fake-meta-server";
import { FAKE_ACT, FAKE_PAGE_ID, FAKE_USER_TOKEN } from "./helpers/fake-meta-promote";

/**
 * docs/IG-PAGE-ADS-SPEC.md 9.3 and PRM-03 acceptance 7 (promote-graph-base-url): GRAPH_BASE_URL is honoured for 127.0.0.1
 * outside production, ignored in production and for any host that is not loopback, and the tripwire classifies a request to
 * the fake host exactly as one to the real host. Also the additive transport options this package added (onHeaders, signal,
 * timeoutMs).
 */

const env = process.env as Record<string, string | undefined>;
const saved = { NODE_ENV: env.NODE_ENV, GRAPH_BASE_URL: env.GRAPH_BASE_URL, SPEND_TRIPWIRE: env.SPEND_TRIPWIRE, SPEND_DRY_RUN: env.SPEND_DRY_RUN };
const REAL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function restore() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
}

/** A fetch that records the URL and answers {} (or the given status). */
function recorder(status = 200, headers: Record<string, string> = {}) {
  const urls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(status === 200 ? JSON.stringify({ id: "1", success: true }) : JSON.stringify({ error: { message: "x", code: 2 } }), { status, headers: { "content-type": "application/json", ...headers } });
  });
  vi.stubGlobal("fetch", fetch);
  return { urls, fetch };
}

beforeEach(() => {
  delete env.GRAPH_BASE_URL;
  env.NODE_ENV = "test";
});
afterEach(() => {
  restore();
  vi.unstubAllGlobals();
  setTripwireAuditSink(null);
});

describe("graphBaseOverride()", () => {
  it("is the loopback address outside production, trimmed of a trailing slash", () => {
    expect(graphBaseOverride({ NODE_ENV: "test", GRAPH_BASE_URL: "http://127.0.0.1:4010" })).toBe("http://127.0.0.1:4010");
    expect(graphBaseOverride({ NODE_ENV: "development", GRAPH_BASE_URL: " http://127.0.0.1:4010/ " })).toBe("http://127.0.0.1:4010");
    expect(graphBaseOverride({ GRAPH_BASE_URL: "http://localhost:4010" })).toBe("http://localhost:4010");
    expect(graphBaseOverride({ GRAPH_BASE_URL: "http://[::1]:4010" })).toBe("http://[::1]:4010");
  });

  it("is null when unset, in production, and for any host that is not loopback", () => {
    expect(graphBaseOverride({})).toBeNull();
    expect(graphBaseOverride({ NODE_ENV: "production", GRAPH_BASE_URL: "http://127.0.0.1:4010" })).toBeNull();
    expect(graphBaseOverride({ NODE_ENV: " production ", GRAPH_BASE_URL: "http://127.0.0.1:4010" })).toBeNull();
    for (const url of [
      "http://evil.example.com",
      "https://graph.facebook.com.evil.example",
      "http://127.0.0.1.evil.example:4010",
      "http://10.0.0.5:4010",
      "http://0.0.0.0:4010",
      "http://user:pass@127.0.0.1:4010",
      "http://127.0.0.1:4010/?x=1",
      "ftp://127.0.0.1",
      "file:///etc/passwd",
      "127.0.0.1:4010",
      "",
    ]) {
      expect(graphBaseOverride({ NODE_ENV: "test", GRAPH_BASE_URL: url }), url).toBeNull();
    }
  });

  it("counts exactly where SPEND_DRY_RUN may count (never in production)", () => {
    for (const nodeEnv of [undefined, "development", "test", "production", " production "]) {
      const e = { NODE_ENV: nodeEnv, GRAPH_BASE_URL: "http://127.0.0.1:4010", SPEND_DRY_RUN: "1" };
      expect(graphBaseOverride(e) !== null, String(nodeEnv)).toBe(spendDryRun(e));
    }
  });

  it("reads process.env by default, on every call", () => {
    expect(graphBaseOverride()).toBeNull();
    env.GRAPH_BASE_URL = "http://127.0.0.1:4999";
    expect(graphBaseOverride()).toBe("http://127.0.0.1:4999");
  });
});

describe("where requests go", () => {
  it("to Meta when unset", async () => {
    const { urls } = recorder();
    await graphFetchAs("T", { path: `${FAKE_PAGE_ID}/published_posts`, query: { limit: "25" } });
    expect(urls[0]).toBe(`${REAL}/${FAKE_PAGE_ID}/published_posts?limit=25`);
  });

  it("to the fake on 127.0.0.1 outside production: graphFetchAs, graphFetch and graphUpload alike", async () => {
    env.GRAPH_BASE_URL = "http://127.0.0.1:4010/";
    const { urls } = recorder();
    await graphFetchAs("T", { path: `${FAKE_PAGE_ID}/published_posts`, query: { limit: "25" } });
    await graphFetch({ tenantId: "t1", path: "/123/message_templates" });
    await graphUpload({ tenantId: "t1", path: "123/media", fields: { messaging_product: "whatsapp" }, file: { bytes: Uint8Array.of(1), filename: "a.jpg", mime: "image/jpeg" } });
    expect(urls).toEqual([`http://127.0.0.1:4010/${GRAPH_API_VERSION}/${FAKE_PAGE_ID}/published_posts?limit=25`, `http://127.0.0.1:4010/${GRAPH_API_VERSION}/123/message_templates`, `http://127.0.0.1:4010/${GRAPH_API_VERSION}/123/media`]);
  });

  it("to Meta in production even when GRAPH_BASE_URL is set", async () => {
    env.NODE_ENV = "production";
    env.GRAPH_BASE_URL = "http://127.0.0.1:4010";
    const { urls } = recorder();
    await graphFetchAs("T", { path: "me/accounts" });
    expect(urls[0]).toBe(`${REAL}/me/accounts`);
  });

  it("to Meta when GRAPH_BASE_URL names a host that is not loopback", async () => {
    env.GRAPH_BASE_URL = "http://evil.example.com";
    const { urls } = recorder();
    await graphFetchAs("T", { path: "me/accounts" });
    expect(urls[0]).toBe(`${REAL}/me/accounts`);
  });
});

describe("the tripwire sees the same request whichever host it goes to", () => {
  const REQUESTS: [string, AppGraphRequest][] = [
    ["a read", { method: "GET", path: `${FAKE_PAGE_ID}/published_posts`, query: { fields: "id", limit: "25" } }],
    ["a pixel create (not_spend)", { method: "POST", path: `${FAKE_ACT}/adspixels`, body: { name: "Shop pixel" } }],
    ["an audience delete", { method: "DELETE", path: "23850000000000077" }],
    ["a campaign create", { method: "POST", path: `${FAKE_ACT}/campaigns`, body: { name: "x", status: "PAUSED" } }],
    ["an ad set turned on", { method: "POST", path: "23850000000000201", body: { status: "ACTIVE" } }],
    ["a pause", { method: "POST", path: "23850000000000201", body: { status: "PAUSED" } }],
    ["a batch", { method: "POST", path: "/", body: { batch: "[]" } }],
    ["a method override", { method: "GET", path: "23850000000000201", query: { method: "post", status: "ACTIVE" } }],
  ];

  const fields = (c: ReturnType<typeof classify>) => ({ class: c.class, pattern: c.pattern, why: c.why, account: c.account, objectId: c.objectId, spendKeys: c.spendKeys, method: c.method });

  async function sendAll(base: string | null) {
    if (base) env.GRAPH_BASE_URL = base;
    else delete env.GRAPH_BASE_URL;
    env.SPEND_TRIPWIRE = "report";
    const events: TripwireAuditEvent[] = [];
    setTripwireAuditSink((e) => void events.push(e));
    const { urls } = recorder();
    const out: { url: string; event: TripwireAuditEvent | null }[] = [];
    for (const [, req] of REQUESTS) {
      const before = events.length;
      await graphFetchAs(FAKE_USER_TOKEN, req);
      out.push({ url: urls[urls.length - 1], event: events.length > before ? events[events.length - 1] : null });
    }
    return out;
  }

  it("classify() of the fake-host URL equals classify() of the real-host URL and of the path", async () => {
    const fakeRun = await sendAll("http://127.0.0.1:4010");
    const realRun = await sendAll(null);
    REQUESTS.forEach(([name, req], i) => {
      expect(fakeRun[i].url.startsWith("http://127.0.0.1:4010/"), name).toBe(true);
      expect(realRun[i].url.startsWith("https://graph.facebook.com/"), name).toBe(true);
      const viaFake = classify({ method: req.method, path: fakeRun[i].url, body: req.body });
      const viaReal = classify({ method: req.method, path: realRun[i].url, body: req.body });
      const viaPath = classify({ method: req.method, path: req.path, query: req.query, body: req.body });
      expect(fields(viaFake), name).toEqual(fields(viaReal));
      expect(fields(viaFake), name).toEqual(fields(viaPath));
    });
  });

  it("the tripwire's audit (class, pattern, reason) is identical with and without GRAPH_BASE_URL", async () => {
    const fakeRun = await sendAll("http://127.0.0.1:4010");
    const realRun = await sendAll(null);
    const strip = (e: TripwireAuditEvent | null) => (e ? { action: e.action, target: e.target, class: e.meta.class, reason: e.meta.reason } : null);
    expect(fakeRun.map((r) => strip(r.event))).toEqual(realRun.map((r) => strip(r.event)));
    expect(fakeRun.filter((r) => r.event).map((r) => r.event!.meta.class)).toEqual(["ads_create", "ads_raise_or_unknown", "ads_lowering", "ads_raise_or_unknown", "ads_raise_or_unknown"]);
  });

  it("in enforce mode a raising write is refused before any request, whichever host is set", async () => {
    for (const base of ["http://127.0.0.1:4010", null]) {
      if (base) env.GRAPH_BASE_URL = base;
      else delete env.GRAPH_BASE_URL;
      env.SPEND_TRIPWIRE = "enforce";
      setTripwireAuditSink(() => undefined);
      const { fetch } = recorder();
      await expect(graphFetchAs(FAKE_USER_TOKEN, { method: "POST", path: "23850000000000201", body: { daily_budget: 1 } })).rejects.toBeInstanceOf(SpendGuardBypassError);
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});

describe("end to end over HTTP, through the real transport", () => {
  let server: FakeMetaServer;
  beforeAll(async () => {
    server = await startFakeMetaServer({ port: 0 });
  });
  afterAll(async () => {
    await server.close();
  });

  it("graphFetchAs reaches the fake server, which records the same class and pattern the tripwire saw", async () => {
    env.GRAPH_BASE_URL = server.url;
    const res = await graphFetchAs<{ data: unknown[] }>(server.fake.pageToken(), { method: "GET", path: `${FAKE_PAGE_ID}/published_posts`, query: { limit: "3" } });
    expect(res.data).toHaveLength(3);
    const created = await graphFetchAs<{ id: string }>(FAKE_USER_TOKEN, { method: "POST", path: `${FAKE_ACT}/adspixels`, body: { name: "Shop pixel" } });
    expect(created.id).toMatch(/^\d+$/);
    const recorded = server.fake.calls.map((c) => ({ class: c.class, pattern: c.pattern, tokenKind: c.tokenKind }));
    expect(recorded).toEqual([
      { class: classify({ method: "GET", path: `${REAL}/${FAKE_PAGE_ID}/published_posts?limit=3` }).class, pattern: "{id}/published_posts", tokenKind: "page" },
      { class: classify({ method: "POST", path: `${REAL}/${FAKE_ACT}/adspixels`, body: { name: "Shop pixel" } }).class, pattern: "act_{id}/adspixels", tokenKind: "user" },
    ]);
    expect(recorded.every((r) => r.class === "not_spend")).toBe(true);
    server.fake.assertClean();
  });
});

describe("transport options added for pacing (onHeaders, signal)", () => {
  it("onHeaders sees each answer's headers, error answers included, and a throwing hook changes nothing", async () => {
    recorder(200, { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 42 }) });
    const seen: [string | null, number][] = [];
    await graphFetchAs("T", { path: "act_1/minimum_budgets" }, { onHeaders: (h, status) => void seen.push([h.get("x-ad-account-usage"), status]) });
    expect(seen).toEqual([['{"acc_id_util_pct":42}', 200]]);
    recorder(400, { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 100 }) });
    const errSeen: number[] = [];
    await expect(graphFetchAs("T", { path: "act_1" }, { onHeaders: (_h, status) => void errSeen.push(status) })).rejects.toBeInstanceOf(GraphError);
    expect(errSeen).toEqual([400]);
    recorder();
    await expect(
      graphFetchAs("T", { path: "act_1" }, {
        onHeaders: () => {
          throw new Error("hook broke");
        },
      }),
    ).resolves.toEqual({ id: "1", success: true });
  });

  it("an aborted signal stops the retries a read would otherwise get", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      return new Response(JSON.stringify({ error: { message: "busy", code: 2 } }), { status: 503 });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(graphFetchAs("T", { path: "act_1" }, { signal: controller.signal })).rejects.toBeInstanceOf(GraphError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("timeoutMs sets each attempt's own limit: 20 s when not given or not usable, at most 2 minutes", async () => {
    const asked: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      asked.push(ms);
      return real(ms);
    });
    try {
      recorder();
      await graphFetchAs("T", { path: "act_1" });
      await graphFetchAs("T", { path: "act_1" }, { timeoutMs: 61_000 });
      await graphFetchAs("T", { path: "act_1" }, { timeoutMs: 10_000_000 });
      await graphFetchAs("T", { path: "act_1" }, { timeoutMs: Number.NaN });
      await graphFetchAs("T", { path: "act_1" }, { timeoutMs: -5 });
      await graphFetch({ tenantId: "t", path: "act_1" });
      expect(asked).toEqual([20_000, 61_000, 120_000, 20_000, 20_000, 20_000]);
    } finally {
      spy.mockRestore();
    }
  });

  it("the signal reaches fetch", async () => {
    const controller = new AbortController();
    let got: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        got = init?.signal;
        return new Response("{}", { status: 200 });
      }),
    );
    await graphFetchAs("T", { path: "act_1" }, { signal: controller.signal });
    expect(got?.aborted).toBe(false);
    controller.abort();
    expect(got?.aborted).toBe(true);
  });
});

describe("src/lib/graph/index.ts", () => {
  // Code only: block comments and line comments (not the "//" of a URL) are removed first.
  const source = readFileSync(path.join(process.cwd(), "src", "lib", "graph", "index.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("names no host but Meta's in code (bypass rules B1 and B12): the loopback check lives in env-rules", () => {
    expect(source).not.toMatch(/https?:\/\/(?!graph\.facebook\.com)/);
    expect(source).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(source).toMatch(/testGraphBaseUrl\(env\)/);
  });
});

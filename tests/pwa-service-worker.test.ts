import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { OFFLINE_PATH, PWA_ICONS } from "@/lib/pwa";

/**
 * public/sw.js (docs/PLAY-STORE.md) exists only to show an offline page. It must never store API responses, signed-in pages or
 * anything that sets a cookie or asks not to be stored. The file is plain browser JavaScript, so these tests read it as text and
 * run it in a VM against fake caches, fetch and events.
 */

const SOURCE = readFileSync(path.resolve(__dirname, "../public/sw.js"), "utf8");
const ORIGIN = "https://wa.edwyz.com";

type Init = { status?: number; headers?: Record<string, string>; type?: string; redirected?: boolean };

class FakeResponse {
  status: number;
  headers: Headers;
  type: string;
  redirected: boolean;
  constructor(
    readonly body: string,
    init: Init = {},
  ) {
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers ?? {});
    this.type = init.type ?? "basic";
    this.redirected = init.redirected ?? false;
  }
  clone() {
    return new FakeResponse(this.body, { status: this.status, headers: Object.fromEntries(this.headers), type: this.type, redirected: this.redirected });
  }
  async text() {
    return this.body;
  }
  static error() {
    return new FakeResponse("", { status: 0, type: "error" });
  }
}

type FakeRequestInit = { method?: string; mode?: string; cache?: string; credentials?: string; redirect?: string };
class FakeRequest {
  url: string;
  method: string;
  mode: string;
  cache?: string;
  credentials?: string;
  constructor(input: string | { url: string }, init: FakeRequestInit = {}) {
    this.url = new URL(typeof input === "string" ? input : input.url, ORIGIN).href;
    this.method = init.method ?? "GET";
    this.mode = init.mode ?? "cors";
    this.cache = init.cache;
    this.credentials = init.credentials;
  }
}

const OFFLINE_HTML = [
  "<!DOCTYPE html><html><head>",
  '<link rel="stylesheet" href="/_next/static/css/app-1a2b.css?dpl=x&amp;v=2" data-precedence="next"/>',
  "<link rel='stylesheet' href='/_next/static/css/more-3c4d.css'>",
  '<link rel="preload" as="style" href="/_next/static/css/preload-only.css"/>',
  '<link rel="stylesheet" href="https://evil.example/_next/static/css/x.css"/>',
  '<link rel="stylesheet" href="/api/theme.css"/>',
  '<link rel="manifest" href="/manifest.webmanifest"/>',
  '<script src="/_next/static/chunks/main-app.js" async></script>',
  "</head><body><h1>You are offline.</h1></body></html>",
].join("");

const STATIC_PAGE = { "cache-control": "s-maxage=31536000", "content-type": "text/html; charset=utf-8" };
const DYNAMIC_PAGE = { "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate", "content-type": "text/html; charset=utf-8" };

type Route = (url: string) => FakeResponse | Promise<FakeResponse>;
type FetchedRequest = { url: string; credentials?: string; cache?: string };

function loadWorker(route: Route) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const stores = new Map<string, Map<string, FakeResponse>>();
  const puts: { cache: string; url: string }[] = [];
  const fetched: FetchedRequest[] = [];
  let online = true;
  const key = (req: string | { url: string }) => new URL(typeof req === "string" ? req : req.url, ORIGIN).href;
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async put(req: string | { url: string }, res: FakeResponse) {
          puts.push({ cache: name, url: key(req) });
          store.set(key(req), res);
        },
        async match(req: string | { url: string }) {
          return store.get(key(req));
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
  };
  const calls = { skipWaiting: 0, claim: 0 };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    skipWaiting: async () => {
      calls.skipWaiting += 1;
    },
    clients: {
      claim: async () => {
        calls.claim += 1;
      },
    },
  };
  const fetch = async (req: FetchedRequest) => {
    fetched.push(req);
    if (!online) throw new TypeError("Failed to fetch");
    return route(req.url);
  };
  const context = vm.createContext({ self, caches, fetch, Request: FakeRequest, Response: FakeResponse, URL, Headers });
  vm.runInContext(SOURCE, context, { filename: "sw.js" });

  async function install() {
    let done: Promise<unknown> = Promise.resolve();
    listeners.install({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  }
  async function activate() {
    let done: Promise<unknown> = Promise.resolve();
    listeners.activate({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  }
  /** Dispatches a fetch event; resolves to the worker's response, or "not handled" when it leaves the request to the browser. */
  async function request(pathOrUrl: string, init: { mode?: string; method?: string } = {}) {
    const handled: { answer?: Promise<FakeResponse> } = {};
    const event = { request: new FakeRequest(pathOrUrl, { mode: init.mode ?? "cors", method: init.method ?? "GET" }), respondWith: (p: Promise<FakeResponse>) => (handled.answer = p) };
    listeners.fetch(event);
    return handled.answer ? await handled.answer : ("not handled" as const);
  }
  return {
    context,
    stores,
    puts,
    fetched,
    calls,
    install,
    activate,
    request,
    setOnline: (value: boolean) => {
      online = value;
    },
    cacheName: () => [...stores.keys()].find((n) => n.startsWith("edwyz-wa-offline-"))!,
  };
}

/** A server: a static offline page, its assets, and a signed-in page and an API that would be fatal to store. */
const server: Route = (url) => {
  const { pathname } = new URL(url);
  if (pathname === "/offline") return new FakeResponse(OFFLINE_HTML, { headers: STATIC_PAGE });
  if (pathname.endsWith(".css") || pathname.endsWith(".png")) return new FakeResponse("asset", { headers: { "cache-control": "public, max-age=31536000, immutable" } });
  if (pathname.startsWith("/app") || pathname.startsWith("/admin")) return new FakeResponse("<html>signed in</html>", { headers: { ...DYNAMIC_PAGE, "set-cookie": "wa_session=abc" } });
  if (pathname.startsWith("/api/")) return new FakeResponse('{"secret":true}', { headers: { "cache-control": "no-store" } });
  return new FakeResponse("<html>page</html>", { headers: STATIC_PAGE });
};

describe("install", () => {
  it("stores the offline page, its stylesheets and icon (fetched without cookies), and takes over at once", async () => {
    const sw = loadWorker(server);
    await sw.install();
    expect(sw.cacheName()).toMatch(/^edwyz-wa-offline-v\d+$/);
    expect(sw.puts.map((p) => p.url.replace(ORIGIN, "")).sort()).toEqual(
      ["/offline", "/_next/static/css/app-1a2b.css?dpl=x&v=2", "/_next/static/css/more-3c4d.css", "/icons/icon-192.png"].sort(),
    );
    for (const req of sw.fetched) {
      expect(req.credentials).toBe("omit");
      expect(req.cache).toBe("reload");
    }
    expect(sw.calls.skipWaiting).toBe(1);
  });

  it.each([
    ["no-store / private (a page rendered per request)", new FakeResponse(OFFLINE_HTML, { headers: DYNAMIC_PAGE })],
    ["private only", new FakeResponse(OFFLINE_HTML, { headers: { "cache-control": 'private="x", max-age=60' } })],
    ["a cookie", new FakeResponse(OFFLINE_HTML, { headers: { ...STATIC_PAGE, "set-cookie": "a=b" } })],
    ["a redirect (to sign-in)", new FakeResponse(OFFLINE_HTML, { headers: STATIC_PAGE, redirected: true })],
    ["an error status", new FakeResponse("oops", { status: 500 })],
  ])("fails, storing nothing, when the offline page comes back with %s", async (_label, response) => {
    const sw = loadWorker((url) => (new URL(url).pathname === "/offline" ? response : server(url)));
    await expect(sw.install()).rejects.toThrow();
    expect(sw.puts).toEqual([]);
    expect(sw.calls.skipWaiting).toBe(0);
  });

  it("fails when the network does, so the browser retries later", async () => {
    const sw = loadWorker(server);
    sw.setOnline(false);
    await expect(sw.install()).rejects.toThrow();
    expect(sw.puts).toEqual([]);
  });

  it("skips an asset that may not be stored and keeps the rest", async () => {
    const sw = loadWorker((url) => (url.includes("more-3c4d") ? new FakeResponse("x", { headers: { "cache-control": "no-store" } }) : server(url)));
    await sw.install();
    expect(sw.puts.map((p) => p.url)).not.toContain(`${ORIGIN}/_next/static/css/more-3c4d.css`);
    expect(sw.puts.map((p) => p.url)).toContain(`${ORIGIN}/offline`);
  });
});

describe("activate", () => {
  it("deletes older edwyz-wa caches, leaves other caches alone, and claims open pages", async () => {
    const sw = loadWorker(server);
    await sw.install();
    const current = sw.cacheName();
    sw.stores.set("edwyz-wa-offline-v0", new Map());
    sw.stores.set("edwyz-wa-something-old", new Map());
    sw.stores.set("unrelated", new Map());
    await sw.activate();
    expect([...sw.stores.keys()].sort()).toEqual([current, "unrelated"].sort());
    expect(sw.calls.claim).toBe(1);
  });
});

describe("fetch", () => {
  async function installed() {
    const sw = loadWorker(server);
    await sw.install();
    sw.puts.length = 0;
    return sw;
  }

  it("sends navigations to the network first and passes the answer through without storing it", async () => {
    const sw = await installed();
    for (const page of ["/app?source=twa", "/app/inbox", "/admin", "/login", "/"]) {
      const res = await sw.request(page, { mode: "navigate" });
      expect(res, page).not.toBe("not handled");
      expect((res as FakeResponse).body).not.toContain("You are offline");
    }
    expect(sw.puts).toEqual([]);
  });

  it("shows the stored offline page when a navigation fails, and stores nothing", async () => {
    const sw = await installed();
    sw.setOnline(false);
    for (const page of ["/app?source=twa", "/app/inbox/123", "/admin/tenants", "/pricing"]) {
      const res = (await sw.request(page, { mode: "navigate" })) as FakeResponse;
      expect(res.status, page).toBe(200);
      expect(res.body, page).toContain("You are offline.");
    }
    expect(sw.puts).toEqual([]);
  });

  it("answers a failed navigation with a network error when no offline page was stored", async () => {
    const sw = loadWorker(server);
    sw.setOnline(false);
    const res = (await sw.request("/app", { mode: "navigate" })) as FakeResponse;
    expect(res.type).toBe("error");
  });

  it("leaves API calls, other methods, other origins and scripts to the browser", async () => {
    const sw = await installed();
    expect(await sw.request("/api/contacts")).toBe("not handled");
    expect(await sw.request("/api/contacts/export.csv", { mode: "navigate" })).toBe("not handled");
    expect(await sw.request("/api", { mode: "navigate" })).toBe("not handled");
    expect(await sw.request("/app/inbox", { mode: "navigate", method: "POST" })).toBe("not handled");
    expect(await sw.request("https://graph.facebook.com/v26.0/me", { mode: "navigate" })).toBe("not handled");
    expect(await sw.request("/_next/static/chunks/main-app.js")).toBe("not handled");
    expect(await sw.request("/app/inbox?_rsc=1")).toBe("not handled");
  });

  it("serves the offline page's stylesheets and icon from the network, and from the cache only when offline", async () => {
    const sw = await installed();
    expect(((await sw.request("/_next/static/css/more-3c4d.css")) as FakeResponse).body).toBe("asset");
    sw.setOnline(false);
    expect(((await sw.request("/_next/static/css/more-3c4d.css")) as FakeResponse).body).toBe("asset");
    expect(((await sw.request(PWA_ICONS.any192)) as FakeResponse).status).toBe(200);
    await expect(sw.request("/_next/static/css/never-stored.css")).rejects.toThrow();
    expect(sw.puts).toEqual([]);
  });
});

describe("what may be stored", () => {
  const sw = loadWorker(server);
  const cacheable = (p: string, res: FakeResponse) => (sw.context.cacheable as (u: URL, r: FakeResponse) => boolean)(new URL(p, ORIGIN), res);
  const fine = () => new FakeResponse("ok", { headers: STATIC_PAGE });

  it("never /api, /app, /admin, sign-in or token pages, whatever their headers say", () => {
    for (const p of ["/api", "/api/x", "/app", "/app/", "/app/inbox", "/admin", "/admin/users", "/login", "/signup", "/forgot-password", "/reset-password/abc", "/verify-email", "/accept-invite", "/oauth/callback", "/approve/t", "/s/t", "/data-deletion/status", "/webhooks/meta", "/health"]) {
      expect(cacheable(p, fine()), p).toBe(false);
    }
  });

  it("never a response with a cookie, no-store, private, a redirect, a partial or opaque body", () => {
    expect(cacheable("/offline", new FakeResponse("x", { headers: { "set-cookie": "a=b" } }))).toBe(false);
    expect(cacheable("/offline", new FakeResponse("x", { headers: { "cache-control": "no-store" } }))).toBe(false);
    expect(cacheable("/offline", new FakeResponse("x", { headers: { "cache-control": "max-age=0, private" } }))).toBe(false);
    expect(cacheable("/offline", new FakeResponse("x", { headers: { "cache-control": "NO-STORE" } }))).toBe(false);
    expect(cacheable("/offline", new FakeResponse("x", { redirected: true }))).toBe(false);
    expect(cacheable("/offline", new FakeResponse("x", { status: 206 }))).toBe(false);
    expect(cacheable("/offline", new FakeResponse("x", { type: "opaque" }))).toBe(false);
    expect(cacheable("https://evil.example/offline", fine())).toBe(false);
  });

  it("the offline page and static files otherwise", () => {
    expect(cacheable("/offline", fine())).toBe(true);
    expect(cacheable("/offline", new FakeResponse("x", { headers: { "cache-control": "public, max-age=0, must-revalidate" } }))).toBe(true);
    expect(cacheable("/_next/static/css/a.css", fine())).toBe(true);
    expect(cacheable("/apps-guide", fine())).toBe(true); // a prefix of /app is not /app
  });
});

describe("the file itself", () => {
  it("writes to the cache only while installing: one put for the page, one per asset, no add/addAll", () => {
    expect(SOURCE.match(/\.put\(/g)).toHaveLength(2);
    expect(SOURCE).not.toMatch(/\bcache\.add(All)?\(|\.addAll\(/);
    const precache = SOURCE.slice(SOURCE.indexOf("async function precache"), SOURCE.indexOf('self.addEventListener("install"'));
    expect(precache.match(/\.put\(/g)).toHaveLength(2);
  });

  it("lists /api, /app and /admin as never cached and skips /api requests before anything else", () => {
    for (const rule of ["/^\\/api(\\/|$)/", "/^\\/app(\\/|$)/", "/^\\/admin(\\/|$)/"]) expect(SOURCE).toContain(rule);
    const handler = SOURCE.slice(SOURCE.indexOf('self.addEventListener("fetch"'));
    expect(handler.indexOf("/^\\/api(\\/|$)/")).toBeLessThan(handler.indexOf("respondWith"));
  });

  it("uses a versioned cache name, skipWaiting and clients.claim", () => {
    expect(SOURCE).toMatch(/const VERSION = "v\d+";/);
    expect(SOURCE).toContain("self.skipWaiting()");
    expect(SOURCE).toContain("self.clients.claim()");
  });

  it("names the same offline page and icon as the app", () => {
    expect(SOURCE).toContain(`const OFFLINE_URL = "${OFFLINE_PATH}";`);
    expect(SOURCE).toContain(`const OFFLINE_ICON = "${PWA_ICONS.any192}";`);
  });
});

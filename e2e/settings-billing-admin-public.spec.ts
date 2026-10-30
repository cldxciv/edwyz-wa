import { createHmac } from "node:crypto";
import { expect, request as pwRequest, test } from "@playwright/test";
import { apiLogin, axeSerious, randomIp, createOwner, overflowsHorizontally, setDarkTheme, isDark } from "./settings-billing-admin-kit";
import { closeDb, ORIGIN, stamp, type TestUser, watchErrors } from "./helpers";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

test.afterAll(closeDb);

const DOC_PAGES = [
  { path: "/docs", h1: "Edwyz WA compatibility API" },
  { path: "/docs/authentication", h1: "Authentication" },
  { path: "/docs/endpoints", h1: "Endpoint reference" },
  { path: "/docs/webhooks", h1: "Webhooks" },
  { path: "/docs/rate-limits", h1: "Rate limits" },
  { path: "/docs/errors", h1: "Errors" },
];

test.describe("Public docs", () => {
  for (const d of DOC_PAGES) {
    test(`${d.path} renders with heading, landmarks, working navigation and no console errors`, async ({ page }) => {
      const errors = watchErrors(page);
      const res = await page.goto(d.path);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: d.h1 })).toBeVisible();
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("contentinfo")).toBeVisible();
      const docNav = page.getByRole("navigation", { name: "API documentation" });
      for (const l of ["Overview", "Authentication", "Endpoints", "Webhooks", "Rate limits", "Errors"]) await expect(docNav.getByRole("link", { name: l })).toBeVisible();
      const body = await page.locator("main").innerText();
      expect(body).not.toMatch(/\bundefined\b|\[object Object\]|\bNaN\b|TODO|lorem/i);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }

  test("the doc navigation visits every subpage by clicking", async ({ page }) => {
    await page.goto("/docs");
    for (const [label, path] of [["Authentication", "/docs/authentication"], ["Endpoints", "/docs/endpoints"], ["Webhooks", "/docs/webhooks"], ["Rate limits", "/docs/rate-limits"], ["Errors", "/docs/errors"], ["Overview", "/docs"]] as const) {
      await page.getByRole("navigation", { name: "API documentation" }).getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
    // The footer also links to docs from other pages.
    await page.goto("/pricing");
    await page.getByRole("contentinfo").getByRole("link", { name: "Docs" }).click();
    await expect(page).toHaveURL(/\/docs$/);
  });

  test("endpoint reference matches the live API: every documented endpoint exists and every route file is documented", async ({ page }) => {
    await page.goto("/docs/endpoints");
    const articles = page.locator("article h3");
    const titles = (await articles.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    expect(titles.length).toBeGreaterThanOrEqual(20);
    const anon = await pwRequest.newContext({ baseURL: ORIGIN });
    const missing: string[] = [];
    const documentedPaths = new Set<string>();
    for (const t of titles) {
      const m = t.match(/^(GET|POST|PUT|DELETE|PATCH) (\/api\/ext\/v3\S*)$/);
      expect(m, `unexpected endpoint title: ${t}`).not.toBeNull();
      const [, method, path] = m!;
      documentedPaths.add(path.replace(/\{\w+\}/g, "{}"));
      const url = path.replace(/\{\w+\}/g, "probe");
      const res = await anon.fetch(url, { method, headers: { origin: ORIGIN, "content-type": "application/json" }, data: method === "GET" || method === "DELETE" ? undefined : "{}" });
      // Signed out: a real route answers 401. 404/405 would mean the docs describe something that does not exist.
      if (res.status() !== 401) missing.push(`${method} ${path} -> ${res.status()}`);
    }
    expect(missing, `documented but not live (expected 401 without a token):\n${missing.join("\n")}`).toEqual([]);

    // Reverse direction: route files on disk that the docs do not mention.
    const root = join(process.cwd(), "src/app/api/ext/v3");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e === "route.ts") files.push(p);
      }
    };
    walk(root);
    const undocumented: string[] = [];
    for (const f of files) {
      const rel = "/api/ext/v3" + f.slice(root.length).replace(/\\/g, "/").replace(/\/route\.ts$/, "").replace(/\[\w+\]/g, "{}");
      const src = readFileSync(f, "utf8");
      if (!documentedPaths.has(rel)) undocumented.push(`${rel} (${src.slice(0, 0)}file)`);
    }
    expect(undocumented, `route files with no documentation: ${undocumented.join(", ")}`).toEqual([]);
    await anon.dispose();
  });

  test("every endpoint card shows its scope, and scopes in the table are real key permissions", async ({ page }) => {
    await page.goto("/docs/endpoints");
    const scopes = await page.locator("article p code").allInnerTexts();
    const known = new Set(["messages:write", "contacts:read", "contacts:write", "templates:read", "conversations:read", "conversations:write", "broadcasts:read", "webhooks:manage"]);
    const odd = scopes.filter((s) => s.includes(":") && !known.has(s));
    expect(odd).toEqual([]);
    await page.goto("/docs/authentication");
    const rows = await page.locator("table tbody tr").count();
    const cards = await (async () => {
      await page.goto("/docs/endpoints");
      return page.locator("article").count();
    })();
    expect(rows).toBe(cards);
  });

  test("code samples render in scrollable blocks and show copyable, complete text", async ({ page }) => {
    for (const path of ["/docs", "/docs/authentication", "/docs/webhooks"]) {
      await page.goto(path);
      const blocks = page.locator("pre code");
      expect(await blocks.count()).toBeGreaterThan(0);
      for (const t of await blocks.allInnerTexts()) {
        expect(t.trim().length).toBeGreaterThan(10);
        expect(t).not.toMatch(/undefined|\[object/);
      }
    }
    await page.goto("/docs/webhooks");
    await expect(page.getByText("x-edwyz-signature").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Verify (Node.js)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Verify (Python)" })).toBeVisible();
    // The sample must be the algorithm the sender really uses: sha256= + HMAC(timestamp + "." + body).
    const node = await page.locator("pre code").filter({ hasText: "createHmac" }).first().innerText();
    expect(node).toContain('"sha256=" + createHmac("sha256", secret).update(timestamp + "." + rawBody)');
    const signing = readFileSync(join(process.cwd(), "src/lib/integrations/signing.ts"), "utf8");
    expect(signing).toContain("`${timestamp}.${body}`");
    expect(signing).toContain("sha256=");
  });

  test("the documented behaviour is what the API does: error shape, cookies ignored, deep paging refused, rate limit with Retry-After", async () => {
    const owner = await createOwner("sba-docs");
    const api = await pwRequest.newContext({ baseURL: ORIGIN });
    const login = await api.post("/api/auth/login", { headers: { origin: ORIGIN, "x-real-ip": randomIp() }, data: { email: owner.email, password: "correct horse battery" } });
    expect(login.ok(), `login ${login.status()}`).toBe(true);
    const keyRes = await api.post("/api/integrations/api-keys", { headers: { origin: ORIGIN }, data: { name: `docs ${stamp()}`, scopes: ["contacts:read", "conversations:read", "templates:read"] } });
    const key = (await keyRes.json()).key as string;

    // Cookies are ignored on this API: the session above must not authenticate.
    const viaCookie = await api.get("/api/ext/v3/contacts");
    expect(viaCookie.status()).toBe(401);
    const err = (await viaCookie.json()) as { ok: boolean; error: { code: string; message: string }; timestamp: string };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("unauthorized");
    expect(typeof err.error.message).toBe("string");
    expect(new Date(err.timestamp).toString()).not.toBe("Invalid Date");

    const bearer = { Authorization: `Bearer ${key}` };
    const ok = await pwRequest.newContext({ baseURL: ORIGIN, extraHTTPHeaders: bearer });
    const list = await ok.get("/api/ext/v3/contacts?page_size=5");
    expect(list.status()).toBe(200);
    const body = await list.json();
    expect(body.ok).toBe(true);
    for (const k of ["page_number", "page_size", "total", "has_more"]) expect(body, `list response should include ${k}`).toHaveProperty(k);

    const deep = await ok.get("/api/ext/v3/contacts?page_number=101&page_size=100");
    expect(deep.status()).toBe(400);
    expect((await deep.json()).error.message).toMatch(/must not exceed 10000/);
    const missing = await ok.get("/api/ext/v3/contacts/does-not-exist");
    expect(missing.status()).toBe(404);
    expect((await missing.json()).error.code).toBe("not_found");
    const wrongScope = await ok.post("/api/ext/v3/messageTemplates/send", { headers: { origin: ORIGIN }, data: {} });
    expect(wrongScope.status()).toBe(403);
    expect((await wrongScope.json()).error.code).toBe("forbidden");
    const tooBig = await ok.post("/api/ext/v3/contacts", { data: "x".repeat(70 * 1024), headers: { "content-type": "application/json" } });
    expect([403, 413]).toContain(tooBig.status());

    // The rate limit stated on the page is the one enforced.
    const pw = await pwRequest.newContext({ baseURL: ORIGIN });
    const page = await pw.get("/docs/rate-limits");
    const text = (await page.text()).replace(/<!-- -->/g, ""); // React puts comment markers between text and interpolated numbers
    const m = text.match(/(\d+) requests in any (\d+)-second window/);
    expect(m, "rate limit sentence").not.toBeNull();
    const limit = Number(m![1]);
    let limited: Awaited<ReturnType<typeof ok.get>> | null = null;
    for (let i = 0; i < limit + 5 && !limited; i++) {
      const r = await ok.get("/api/ext/v3/messageTemplates?page_size=1");
      if (r.status() === 429) limited = r;
    }
    expect(limited, `no 429 after ${limit + 5} requests; docs say ${limit} per window`).not.toBeNull();
    expect(Number(limited!.headers()["retry-after"])).toBeGreaterThan(0);
    expect(((await limited!.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    await ok.dispose();
    await api.dispose();
    await pw.dispose();
  });

  test("docs pages: axe in light and dark, usable at 360 px", async ({ page }) => {
    await page.goto("/docs/endpoints");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await axeSerious(page, { includeShell: true }), "light").toEqual([]);
    const toggled = await setDarkTheme(page);
    if (toggled) {
      expect(await isDark(page)).toBe(true);
      expect(await axeSerious(page, { includeShell: true }), "dark").toEqual([]);
    }
    await page.setViewportSize({ width: 360, height: 740 });
    for (const d of DOC_PAGES) {
      await page.goto(d.path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await overflowsHorizontally(page), `${d.path} overflows at 360px`).toBe(0);
    }
  });

  test("@mobile docs endpoint reference fits a phone", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/docs/authentication");
    await expect(page.getByRole("heading", { level: 1, name: "Authentication" })).toBeVisible();
    expect(await overflowsHorizontally(page)).toBe(0);
  });
});

test.describe("Legal pages", () => {
  for (const p of [
    { path: "/privacy", h1: "Privacy Policy" },
    { path: "/terms", h1: "Terms of Service" },
    { path: "/data-deletion", h1: "Data deletion" },
  ]) {
    test(`${p.path}: heading, summary, table of contents that jumps to real sections, working links`, async ({ page }) => {
      const errors = watchErrors(page);
      await page.goto(p.path);
      await expect(page.getByRole("heading", { level: 1, name: p.h1 })).toBeVisible();
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByText(/Last updated .* Version/)).toBeVisible();
      await expect(page.getByRole("complementary", { name: "Summary" })).toBeVisible();
      const toc = page.getByRole("navigation", { name: "Table of contents" });
      const links = toc.getByRole("link");
      const count = await links.count();
      expect(count).toBeGreaterThanOrEqual(5);
      for (let i = 0; i < count; i++) {
        const href = await links.nth(i).getAttribute("href");
        const id = href!.slice(1);
        await expect(page.locator(`[id="${id}"]`), `section ${id} exists`).toHaveCount(1);
        await expect(page.locator(`[id="${id}-h"]`), `heading for ${id}`).toBeVisible();
      }
      // Clicking a contents link scrolls the section into view.
      await links.nth(count - 1).click();
      const last = (await links.nth(count - 1).getAttribute("href"))!.slice(1);
      await expect(page.locator(`[id="${last}-h"]`)).toBeInViewport();
      // Every internal link on the page resolves.
      const hrefs = await page.locator("main a[href^='/']").evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!.split("#")[0]))].filter(Boolean));
      for (const h of hrefs) {
        const r = await page.request.get(h);
        expect(r.status(), `${h} linked from ${p.path}`).toBeLessThan(400);
      }
      expect(await page.locator("main").innerText()).not.toMatch(/\bundefined\b|\[object Object\]|TODO|lorem ipsum/i);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }

  test("external legal links point to the right Meta/WhatsApp/Razorpay hosts and open safely", async ({ page }) => {
    await page.goto("/terms");
    const ext = await page.locator("main a[href^='http']").evaluateAll((as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, rel: (a as HTMLAnchorElement).rel, target: (a as HTMLAnchorElement).target })));
    expect(ext.length).toBeGreaterThan(0);
    for (const l of ext) {
      expect(new URL(l.href).protocol).toBe("https:");
      if (l.target === "_blank") expect(l.rel).toMatch(/noopener/);
    }
    await page.goto("/privacy");
    const priv = await page.locator("main a[href^='http']").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    expect(priv.some((h) => /facebook\.com|whatsapp\.com/.test(h))).toBe(true);
  });

  test("footer links reach privacy, terms and data deletion from the landing page", async ({ page }) => {
    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    for (const [name, url] of [["Privacy policy", /\/privacy$/], ["Terms of service", /\/terms$/], ["Data deletion", /\/data-deletion$/]] as const) {
      await footer.getByRole("link", { name }).click();
      await expect(page).toHaveURL(url);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.goBack();
    }
  });

  test("legal pages: axe in light and dark, usable at 360 px", async ({ page }) => {
    for (const path of ["/privacy", "/terms", "/data-deletion"]) {
      await page.goto(path);
      expect(await axeSerious(page, { includeShell: true }), path).toEqual([]);
    }
    await page.goto("/privacy");
    if (await setDarkTheme(page)) {
      expect(await axeSerious(page, { includeShell: true }), "privacy dark").toEqual([]);
    }
    await page.setViewportSize({ width: 360, height: 740 });
    for (const path of ["/privacy", "/terms", "/data-deletion", "/data-deletion/status"]) {
      await page.goto(path);
      expect(await overflowsHorizontally(page), `${path} overflows at 360px`).toBe(0);
    }
  });
});

test.describe("Data deletion callback and status page", () => {
  const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
  const signed = (payload: object, secret: string) => {
    const p = b64(JSON.stringify({ algorithm: "HMAC-SHA256", issued_at: Math.floor(Date.now() / 1000), ...payload }));
    return `${b64(createHmac("sha256", secret).update(p).digest())}.${p}`;
  };

  test("a correctly signed request gets a confirmation code and a status page that shows it; forged ones are refused", async ({ page }) => {
    const secret = process.env.META_APP_SECRET ?? "";
    test.skip(!secret, "META_APP_SECRET is not available to the test");
    const form = (sr: string) => ({ headers: { "content-type": "application/x-www-form-urlencoded" }, data: `signed_request=${encodeURIComponent(sr)}` });
    const ok = await page.request.post("/api/meta/data-deletion", form(signed({ user_id: `uat_${stamp()}` }, secret)));
    expect(ok.status()).toBe(200);
    const body = await ok.json();
    expect(body.confirmation_code).toBeTruthy();
    expect(body.url).toContain(`/data-deletion/status?code=${body.confirmation_code}`);

    await page.goto(new URL(body.url).pathname + new URL(body.url).search);
    await expect(page.getByRole("heading", { level: 1, name: "Data deletion status" })).toBeVisible();
    await expect(page.getByText(/We received your request on/)).toBeVisible();
    await expect(page.getByText(/Status:/)).toBeVisible();
    expect(await page.locator("main").innerText()).not.toMatch(/undefined|Invalid Date/);

    const forged = await page.request.post("/api/meta/data-deletion", form(signed({ user_id: "x" }, "wrong-secret")));
    expect(forged.status()).toBe(400);
    const none = await page.request.post("/api/meta/data-deletion", { headers: { "content-type": "application/x-www-form-urlencoded" }, data: "foo=bar" });
    expect(none.status()).toBe(400);
    const garbage = await page.request.post("/api/meta/data-deletion", form("abc"));
    expect(garbage.status()).toBe(400);
  });

  test("an unknown code is explained kindly", async ({ page }) => {
    await page.goto("/data-deletion/status?code=does-not-exist");
    await expect(page.getByText(/We could not find a request with that code/)).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: /@/ })).toBeVisible(); // the footer shows the address too
  });

  test("the data deletion page tells people to enter their code on the status page, so the status page must have a place to enter it", async ({ page }) => {
    await page.goto("/data-deletion");
    await expect(page.getByText(/enter the confirmation code/i)).toBeVisible();
    await page.getByRole("link", { name: /data-deletion\/status$/ }).click();
    await expect(page).toHaveURL(/\/data-deletion\/status$/);
    await expect(page.getByRole("textbox"), "The status page has no field to type the confirmation code").toBeVisible();
  });
});

test.describe("Admin console is invisible to everyone but platform admins", () => {
  let user: TestUser;
  let victim: TestUser;
  test.beforeAll(async () => {
    user = await createOwner("sba-admin-probe");
    victim = await createOwner("sba-admin-victim");
  });

  const PAGES = ["/admin", "/admin/users", "/admin/tenants", "/admin/plans", "/admin/payments", "/admin/audit", "/admin/settings", "/admin/security", "/admin/verify", "/admin/spending", "/admin/spending/settings"];
  const GETS = ["/api/admin/metrics", "/api/admin/users", "/api/admin/tenants", "/api/admin/plans", "/api/admin/payments", "/api/admin/audit", "/api/admin/settings", "/api/admin/spending", "/api/admin/spending/settings"];

  test("signed-out visitors get the same 404 as a page that does not exist, with no admin hints", async ({ page }) => {
    const nothing = await page.goto("/this-page-does-not-exist-sba");
    const baseline = await page.locator("body").innerText();
    expect(nothing?.status()).toBe(404);
    for (const p of PAGES) {
      const res = await page.goto(p);
      expect(res?.status(), p).toBe(404);
      const text = await page.locator("body").innerText();
      expect(text, `${p} must not reveal the admin console`).not.toMatch(/platform admin|tenants|audit log|two-step|authenticator|enrol/i);
      expect(text.length).toBeLessThan(baseline.length + 200);
      expect(page.url(), `${p} must not redirect to sign in (that would reveal it exists)`).toMatch(new RegExp(`${p}$`));
    }
    const anon = await pwRequest.newContext({ baseURL: ORIGIN });
    const unknown = await anon.get("/api/admin-nothing-here");
    for (const g of GETS) {
      const r = await anon.get(g);
      expect(r.status(), g).toBe(404);
      expect(r.status()).toBe(unknown.status());
    }
    await anon.dispose();
  });

  test("an ordinary signed-in owner gets 404 on every admin page and endpoint, including mutations", async ({ page, context }) => {
    await apiLogin(context, user.email);
    for (const p of PAGES) {
      const res = await page.goto(p);
      expect(res?.status(), p).toBe(404);
      expect(await page.locator("body").innerText()).not.toMatch(/platform admin|audit log|authenticator/i);
    }
    for (const g of GETS) {
      const r = await context.request.get(g);
      expect(r.status(), g).toBe(404);
      const text = await r.text();
      expect(text).not.toMatch(/forbidden|admin|permission|unauthori[sz]ed/i);
    }
    const o = { headers: { origin: ORIGIN } };
    const mutations: [string, string, object][] = [
      ["post", "/api/admin/plans", { code: "x", name: "x", pricePaise: 1 }],
      ["post", "/api/admin/settings", {}],
      ["put", "/api/admin/settings", {}],
      ["post", "/api/admin/test-message", {}],
      ["post", "/api/admin/security/enroll", {}],
      ["post", "/api/admin/security/confirm", { code: "123456" }],
      ["post", "/api/admin/verify", { code: "123456" }],
      ["post", `/api/admin/tenants/${victim.tenantId}/erase`, { confirm: victim.workspace }],
      ["patch", `/api/admin/tenants/${victim.tenantId}`, { status: "suspended" }],
      ["patch", `/api/admin/users/${victim.userId}`, { disabled: true }],
      // Spending (docs/SPEND-CONTROLS-SPEC.md 8.3): a workspace's card and actions, the platform switch and the settings.
      ["post", `/api/admin/spending/${victim.tenantId}`, { action: "freeze_spending", level: "all", reason: "probe" }],
      ["post", "/api/admin/spending/platform", { action: "stop_all", reason: "probe", confirm: "STOP SPENDING" }],
      ["put", "/api/admin/spending/settings", { section: "fx", currency: "USD", rate: "1", reason: "probe" }],
    ];
    for (const [method, path, data] of mutations) {
      const r = await (context.request as unknown as Record<string, (u: string, o: object) => Promise<{ status(): number }>>)[method](path, { ...o, data });
      expect(r.status(), `${method.toUpperCase()} ${path}`).toBe(404);
    }
    expect((await context.request.get(`/api/admin/spending/${victim.tenantId}`)).status(), "GET a workspace's spending card").toBe(404);
    // And nothing happened to the victim workspace.
    const d = await (await import("./helpers")).db();
    const t = (await d.query(`select status, "deletedAt" from "Tenant" where id = $1`, [victim.tenantId])).rows[0];
    expect(t.status).toBe("active");
    expect(t.deletedAt).toBeNull();
    // Nor to spending: no stop on the victim workspace and no platform-wide stop.
    expect((await d.query(`select "freeze" from "SpendControl" where "tenantId" = $1`, [victim.tenantId])).rows[0]?.freeze ?? "none").toBe("none");
    expect((await d.query(`select "value"->>'freeze' as f from "PlatformSetting" where "key" = 'spend:platform'`)).rows[0]?.f ?? "none").not.toBe("all");
    // Cross-site and no-origin posts do not turn the 404 into a different answer.
    const evil = await context.request.post("/api/admin/plans", { headers: { origin: "https://evil.example" }, data: {} });
    expect(evil.status()).toBe(404);
    const noOrigin = await context.request.post("/api/admin/plans", { data: {} });
    expect(noOrigin.status()).toBe(404);
  });

  test("an admin link is never offered to ordinary users anywhere in the app", async ({ page, context }) => {
    await apiLogin(context, user.email);
    await page.goto("/app");
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.locator("a[href^='/admin']")).toHaveCount(0);
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.locator("a[href^='/admin']")).toHaveCount(0);
    const html = await (await page.request.get("/app")).text();
    expect(html).not.toMatch(/href="\/admin/);
  });
});

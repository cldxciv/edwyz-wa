/*
 * Edwyz WA service worker (docs/PLAY-STORE.md). Its one job is an offline page, so Chrome and the Android app (a Trusted Web
 * Activity over this site) treat wa.edwyz.com as an installable app. It is registered by src/components/pwa/ServiceWorkerRegistration.tsx
 * in production builds only.
 *
 * - Install stores /offline and the stylesheets and icon that page uses, fetched without cookies. Nothing else is ever written to
 *   the cache, at install or later: the fetch handler only reads it.
 * - Page navigations go to the network first. Only when the network fails is the stored offline page shown.
 * - API calls, signed-in pages (/app, /admin), sign-in pages and every other request are left to the browser.
 * - Even at install a response is refused when it sets a cookie, is marked no-store or private, redirected, or comes from a path
 *   that must never be cached (NEVER_CACHE). tests/pwa-service-worker.test.ts runs this file against fakes to hold all of that.
 *
 * Bump VERSION whenever this file or the offline page changes: the new worker installs, takes over at once, and deletes the
 * older edwyz-wa-* caches.
 */
const VERSION = "v1";
const CACHE_PREFIX = "edwyz-wa-";
const CACHE_NAME = CACHE_PREFIX + "offline-" + VERSION;
const OFFLINE_URL = "/offline";
const OFFLINE_ICON = "/icons/icon-192.png";

// API, signed-in areas, sign-in and token pages, callbacks and webhooks. Never stored, whatever their headers say.
const NEVER_CACHE = [
  /^\/api(\/|$)/,
  /^\/app(\/|$)/,
  /^\/admin(\/|$)/,
  /^\/(login|signup|forgot-password|reset-password|verify-email|accept-invite)(\/|$)/,
  /^\/(oauth|approve|s|data-deletion|webhooks|health)(\/|$)/,
];

function neverCached(pathname) {
  return NEVER_CACHE.some((rule) => rule.test(pathname));
}

/** May this response be stored? Same origin only, a plain 200, no cookie, nothing that asks not to be stored. */
function cacheable(url, response) {
  if (url.origin !== self.location.origin || neverCached(url.pathname)) return false;
  if (!response || response.status !== 200 || response.type !== "basic" || response.redirected) return false;
  if (response.headers.has("set-cookie")) return false;
  const cacheControl = (response.headers.get("cache-control") || "").toLowerCase();
  return !/(^|[\s,])(no-store|private)([\s,=]|$)/.test(cacheControl);
}

/** The offline page's own stylesheets (hashed, immutable files under /_next/static/). */
function offlineAssets(html) {
  const found = new Set();
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel=["']?stylesheet["'\s>/]/i.test(tag)) continue;
    const href = /\bhref=["']([^"']+)["']/i.exec(tag);
    const path = href ? href[1].replace(/&amp;/g, "&") : "";
    if (/^\/_next\/static\/[^?#"']+\.css(\?[^#"']*)?$/.test(path)) found.add(path);
  }
  return [...found];
}

async function fetchFresh(path) {
  return fetch(new Request(path, { cache: "reload", credentials: "omit", redirect: "follow" }));
}

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const page = await fetchFresh(OFFLINE_URL);
  if (!cacheable(new URL(OFFLINE_URL, self.location.origin), page)) throw new Error("The offline page cannot be cached");
  const html = await page.clone().text();
  const assets = [...offlineAssets(html), OFFLINE_ICON];
  // A network failure on any of them fails the install, and the browser tries again on a later visit.
  const responses = await Promise.all(assets.map(async (path) => [path, await fetchFresh(path)]));
  await cache.put(OFFLINE_URL, page);
  for (const [path, response] of responses) {
    if (cacheable(new URL(path, self.location.origin), response)) await cache.put(path, response);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

async function offlinePage() {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(OFFLINE_URL)) || Response.error();
}

async function networkThenStored(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(CACHE_NAME);
    const stored = await cache.match(request);
    if (stored) return stored;
    throw error;
  }
}

function isOfflineAsset(url) {
  return url.pathname === OFFLINE_ICON || (url.pathname.startsWith("/_next/static/") && url.pathname.endsWith(".css"));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || /^\/api(\/|$)/.test(url.pathname)) return;
  if (request.mode === "navigate") {
    // Network first; the response is passed through untouched and never stored.
    event.respondWith(fetch(request).catch(() => offlinePage()));
    return;
  }
  if (isOfflineAsset(url)) event.respondWith(networkThenStored(request));
});

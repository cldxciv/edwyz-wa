import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { modifyRouteRegex } from "next/dist/lib/redirect-status";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.2, D20 and PRM-07 acceptance 4 (popup completion): window.open runs synchronously in the click,
 * before anything is awaited; a blocked popup and META_LOGIN_POPUP=off keep today's full-page redirect; the outcome arrives by
 * the storage event alone, or by polling the connections list alone (no BroadcastChannel, no window.opener); polling stops
 * after 3 minutes; a reconnected expired or revoked connection counts only once its discovery finished; after a polling
 * success the watcher closes the window itself; the callback's closing page writes the documented localStorage key with the
 * outcome only, no token, and the policy a deployed build sends for it (next.config.ts headers plus the route's) lets its one
 * script run. The Connections panel's plain-words helpers are checked here too. No network, no database.
 */
const h0 = vi.hoisted(() => ({
  db: { platformSetting: { create: vi.fn(), deleteMany: vi.fn() }, auditLog: { create: vi.fn() } } as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
  getActor: vi.fn(),
  completeConnect: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: h0.db }));
vi.mock("@/lib/auth", () => ({ getActor: (...a: unknown[]) => h0.getActor(...a) }));
vi.mock("@/lib/meta-connect/service", async (orig) => {
  const real = await orig<typeof import("@/lib/meta-connect/service")>();
  return { ...real, completeConnect: (...a: unknown[]) => h0.completeConnect(...a) };
});

import {
  adAccountStatusLabel,
  assetName,
  assetPicture,
  AssetRow,
  missingPermissionLines,
  popupPhaseText,
  popupResultNotice,
  POSTING_PERMISSION_TEXT,
} from "@/components/meta-connect/ConnectionsPanel";
import {
  connectionsChanged,
  connectionsMark,
  FB_CONNECTIONS_POLL_FOR_MS,
  FB_CONNECTIONS_POLL_MS,
  FB_POPUP,
  FB_POPUP_CLOSE_AFTER_MS,
  launchFacebookLogin,
  outcomeFromStorage,
  watchPopup,
  type LaunchDeps,
  type PopupLike,
  type StorageEventLike,
  type WatchDeps,
} from "@/components/meta-connect/useFacebookLoginPopup";
import { CONNECT_POPUP, POPUP_STATE_MARKER, startConnect } from "@/lib/meta-connect/service";
import nextConfig from "../next.config";

const ORIGIN = "https://wa.example.test";
const ADMIN = { userId: "u1", tenantId: "t1", role: "admin" as const };
const FB_URL = "https://www.facebook.com/v26.0/dialog/oauth?client_id=1&state=s";

function fakePopup() {
  const p = {
    closed: false,
    closeCount: 0,
    replaced: [] as string[],
    close() {
      p.closed = true;
      p.closeCount++;
    },
    location: { replace: (url: string) => void p.replaced.push(url) },
    get document(): never {
      throw new Error("SecurityError: cross-origin");
    },
  };
  return p as typeof p & PopupLike;
}

/** Watch deps with real timer functions (vi fake timers drive them), no BroadcastChannel and no message from an opener. */
function watchDeps(over: Partial<WatchDeps> = {}) {
  const storage: ((e: StorageEventLike) => void)[] = [];
  const cleared = { n: 0 };
  const deps: WatchDeps = {
    origin: ORIGIN,
    onMessage: () => () => undefined,
    channel: () => null,
    onStorage: (fn) => {
      storage.push(fn);
      return () => storage.splice(storage.indexOf(fn), 1);
    },
    clearStorage: () => void cleared.n++,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...over,
  };
  return { deps, emit: (e: StorageEventLike) => storage.forEach((fn) => fn(e)), storage, cleared };
}

const list = (...rows: [string, string | null, string?][]) => ({ connections: rows.map(([id, lastCheckedAt, status = "active"]) => ({ id, lastCheckedAt, status })) });
const stored = (outcome: string, extra: Record<string, unknown> = {}) => ({ key: FB_POPUP.storage, newValue: JSON.stringify({ source: FB_POPUP.source, outcome, at: 1, ...extra }) });

beforeEach(() => {
  vi.stubEnv("SITE_URL", ORIGIN);
  vi.stubEnv("STATE_SECRET", "state-secret-for-tests-0123456789abcdef");
  vi.stubEnv("META_APP_ID", "123");
  vi.stubEnv("META_LOGIN_CONFIG_ID", "cfg1");
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  h0.db.platformSetting.create.mockReset().mockResolvedValue({});
  h0.db.platformSetting.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  h0.db.auditLog.create.mockReset().mockResolvedValue({});
  h0.getActor.mockReset().mockResolvedValue(ADMIN);
  h0.completeConnect.mockReset().mockResolvedValue({ connectionId: "c1" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("launch: the window opens synchronously in the click", () => {
  it("calls window.open before any await, then asks the start route, then sends the window to Facebook", async () => {
    const order: string[] = [];
    const popup = fakePopup();
    let answer!: (v: { url: string; popup?: boolean }) => void;
    const deps: LaunchDeps = {
      open: vi.fn(() => {
        order.push("open");
        return popup;
      }),
      fetchStart: vi.fn((asPopup: boolean) => {
        order.push(`start:${asPopup}`);
        return new Promise<{ url: string; popup?: boolean }>((r) => (answer = r));
      }),
      redirect: vi.fn(),
    };
    const { started } = launchFacebookLogin(deps);
    // Synchronously, inside the click: the window is open; the start request has been made but nothing awaited yet.
    expect(order).toEqual(["open", "start:true"]);
    answer({ url: FB_URL, popup: true });
    expect(await started).toEqual({ kind: "opened" });
    expect(popup.replaced).toEqual([FB_URL]);
    expect(deps.redirect).not.toHaveBeenCalled();
    const src = readFileSync(path.resolve(__dirname, "../src/components/meta-connect/useFacebookLoginPopup.ts"), "utf8");
    const launch = src.slice(src.indexOf("export function launchFacebookLogin"), src.indexOf("const opened = popup;"));
    expect(launch.indexOf("deps.open(")).toBeGreaterThan(0);
    expect(launch).not.toMatch(/\bawait\b|\.then\(/);
  });

  it("a blocked popup moves the whole page to Facebook (today's redirect)", async () => {
    const deps: LaunchDeps = { open: vi.fn(() => null), fetchStart: vi.fn(async () => ({ url: FB_URL, popup: false })), redirect: vi.fn() };
    expect(await launchFacebookLogin(deps).started).toEqual({ kind: "redirected" });
    expect(deps.fetchStart).toHaveBeenCalledWith(false);
    expect(deps.redirect).toHaveBeenCalledWith(FB_URL);
  });

  it("META_LOGIN_POPUP=off: the server answers popup false, so the opened window closes and the page redirects", async () => {
    const popup = fakePopup();
    const deps: LaunchDeps = { open: () => popup, fetchStart: vi.fn(async () => ({ url: FB_URL, popup: false })), redirect: vi.fn() };
    expect(await launchFacebookLogin(deps).started).toEqual({ kind: "redirected" });
    expect(popup.closeCount).toBe(1);
    expect(popup.replaced).toEqual([]);
    expect(deps.redirect).toHaveBeenCalledWith(FB_URL);
  });

  it("startConnect drops the popup marker when META_LOGIN_POPUP=off, and keeps it by default", async () => {
    const on = await startConnect(ADMIN, { popup: true });
    expect(on.popup).toBe(true);
    expect(new URL(on.url).searchParams.get("state")!.endsWith(POPUP_STATE_MARKER)).toBe(true);
    const off = await startConnect(ADMIN, { popup: true, env: { META_LOGIN_POPUP: "off" } });
    expect(off.popup).toBe(false);
    expect(new URL(off.url).searchParams.get("state")!.endsWith(POPUP_STATE_MARKER)).toBe(false);
    expect((await startConnect(ADMIN)).popup).toBe(false);
  });

  it("the start route answers popup false under META_LOGIN_POPUP=off, and stays same-origin and admin only", async () => {
    const { POST } = await import("@/app/api/meta-connect/start/route");
    vi.stubEnv("META_LOGIN_POPUP", "off");
    const res = await POST(new Request(`${ORIGIN}/api/meta-connect/start?popup=1`, { method: "POST", headers: { origin: ORIGIN } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; popup: boolean };
    expect(body.popup).toBe(false);
    expect(new URL(body.url).searchParams.get("state")!.endsWith(POPUP_STATE_MARKER)).toBe(false);
    expect((await POST(new Request(`${ORIGIN}/api/meta-connect/start?popup=1`, { method: "POST", headers: { origin: "https://evil.example" } }))).status).toBe(403);
    h0.getActor.mockResolvedValueOnce({ ...ADMIN, role: "agent" });
    expect((await POST(new Request(`${ORIGIN}/api/meta-connect/start?popup=1`, { method: "POST", headers: { origin: ORIGIN } }))).status).toBe(403);
  });
});

describe("completion without window.opener or BroadcastChannel", () => {
  it("arrives by the storage event alone, and the key is cleaned up", async () => {
    const popup = fakePopup();
    const w = watchDeps();
    const done = watchPopup(popup, w.deps);
    w.emit({ key: "something-else", newValue: JSON.stringify({ source: FB_POPUP.source, outcome: "connected" }) });
    w.emit({ key: FB_POPUP.storage, newValue: "{not json" });
    w.emit({ key: FB_POPUP.storage, newValue: JSON.stringify({ source: "other", outcome: "connected" }) });
    w.emit({ key: FB_POPUP.storage, newValue: null });
    w.emit(stored("connected"));
    expect(await done).toEqual({ kind: "outcome", outcome: "connected" });
    expect(popup.closeCount).toBe(1);
    expect(w.storage).toHaveLength(0);
    expect(w.cleared.n).toBe(1);
  });

  it("reads a cancel and a failure from storage too", async () => {
    for (const outcome of ["cancelled", "failed"] as const) {
      const w = watchDeps();
      const done = watchPopup(fakePopup(), w.deps);
      w.emit(stored(outcome));
      expect(await done).toEqual({ kind: "outcome", outcome });
    }
    expect(outcomeFromStorage(stored("connected", { token: "EAAB" }))).toBe("connected");
    expect(outcomeFromStorage({ key: FB_POPUP.storage, newValue: "x".repeat(600) })).toBeNull();
  });

  it("arrives by polling the connections list alone: a connection with a new lastCheckedAt means connected", async () => {
    vi.useFakeTimers();
    const popup = fakePopup();
    const answers = [list(["c1", "2026-10-01T00:00:00.000Z"]), list(["c1", "2026-10-01T00:00:00.000Z"]), list(["c1", "2026-10-01T00:00:00.000Z"], ["c2", null]), list(["c1", "2026-10-01T00:00:00.000Z"], ["c2", "2026-10-31T10:00:00.000Z"])];
    const connections = vi.fn(async () => answers[Math.min(connections.mock.calls.length - 1, answers.length - 1)]);
    const w = watchDeps({ onStorage: undefined, connections });
    const done = watchPopup(popup, w.deps);
    await vi.advanceTimersByTimeAsync(FB_CONNECTIONS_POLL_MS);
    await vi.advanceTimersByTimeAsync(FB_CONNECTIONS_POLL_MS); // c2 exists but is still discovering (lastCheckedAt null)
    let settled = false;
    void done.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(FB_CONNECTIONS_POLL_MS);
    expect(await done).toEqual({ kind: "outcome", outcome: "connected" });
    expect(connections).toHaveBeenCalledTimes(4);
    // The callback's page may still be loading: the window is left a moment, then closed by the watcher itself.
    expect(popup.closeCount).toBe(0);
    await vi.advanceTimersByTimeAsync(FB_POPUP_CLOSE_AFTER_MS);
    expect(popup.closeCount).toBe(1);
  });

  it("polls every 2 seconds and stops after 3 minutes; the attempt then ends at its own time limit", async () => {
    vi.useFakeTimers();
    const popup = fakePopup();
    const connections = vi.fn(async () => list(["c1", "2026-10-01T00:00:00.000Z"]));
    const done = watchPopup(popup, watchDeps({ connections }).deps, 10 * 60_000);
    await vi.advanceTimersByTimeAsync(FB_CONNECTIONS_POLL_FOR_MS + 30_000);
    const calls = connections.mock.calls.length;
    expect(calls).toBe(1 + FB_CONNECTIONS_POLL_FOR_MS / FB_CONNECTIONS_POLL_MS);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await done).toEqual({ kind: "timeout" });
    expect(popup.closed).toBe(true);
  });

  it("a window that looks closed gets one last look; a later success still reaches the page through onLate", async () => {
    vi.useFakeTimers();
    const popup = fakePopup();
    let finished = false;
    const connections = vi.fn(async () => (finished ? list(["c1", "2026-10-31T10:00:00.000Z"]) : list()));
    const late = vi.fn();
    const w = watchDeps({ connections });
    const done = watchPopup(popup, w.deps, 10 * 60_000, late);
    await vi.advanceTimersByTimeAsync(10);
    popup.closed = true; // the browser cut the link to the window (its policy), or the person closed it
    await vi.advanceTimersByTimeAsync(600);
    expect(await done).toEqual({ kind: "closed" });
    expect(late).not.toHaveBeenCalled();
    finished = true;
    await vi.advanceTimersByTimeAsync(FB_CONNECTIONS_POLL_MS);
    expect(late).toHaveBeenCalledWith("connected");
    const after = connections.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FB_CONNECTIONS_POLL_MS * 3);
    expect(connections).toHaveBeenCalledTimes(after);
  });

  it("a closed window with nothing finished ends as closed and stops listening when polling ends", async () => {
    vi.useFakeTimers();
    const popup = fakePopup();
    const connections = vi.fn(async () => list(["c1", "2026-10-01T00:00:00.000Z"]));
    const late = vi.fn();
    const w = watchDeps({ connections });
    const done = watchPopup(popup, w.deps, 10 * 60_000, late);
    await vi.advanceTimersByTimeAsync(10);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(await done).toEqual({ kind: "closed" });
    // Still listening after the window closed, until the 3-minute polling window ends.
    expect(w.storage).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FB_CONNECTIONS_POLL_FOR_MS + FB_CONNECTIONS_POLL_MS);
    expect(w.storage).toHaveLength(0);
    expect(late).not.toHaveBeenCalled();
  });

  it("only live connections that finished count", () => {
    const before = connectionsMark(list(["c1", "a"], ["c2", "b", "revoked"]))!;
    // Every connection is in the baseline, whatever its status, with its lastCheckedAt.
    expect([...before.entries()]).toEqual([
      ["c1", { live: true, checkedAt: "a" }],
      ["c2", { live: false, checkedAt: "b" }],
    ]);
    expect(connectionsChanged(before, connectionsMark(list(["c1", "a"], ["c3", null]))!)).toBe(false);
    expect(connectionsChanged(before, connectionsMark(list(["c1", "a"], ["c2", "c", "expired"]))!)).toBe(false);
    expect(connectionsChanged(before, connectionsMark(list(["c1", "b"]))!)).toBe(true);
    expect(connectionsChanged(before, connectionsMark(list(["c1", "a"], ["c4", "d", "expiring"]))!)).toBe(true);
    expect(connectionsMark({ error: "Sign in" })).toBeNull();
  });

  it("reconnecting an expired or revoked connection counts only once its discovery wrote a new lastCheckedAt", () => {
    for (const status of ["expired", "revoked", "error"]) {
      const before = connectionsMark(list(["c1", "2026-10-01T00:00:00.000Z", status]))!;
      // completeConnect's upsert makes it active at once but keeps the old lastCheckedAt while discovery runs.
      expect(connectionsChanged(before, connectionsMark(list(["c1", "2026-10-01T00:00:00.000Z", "active"]))!), status).toBe(false);
      expect(connectionsChanged(before, connectionsMark(list(["c1", "2026-10-31T10:00:00.000Z", "active"]))!), status).toBe(true);
    }
    // A revoked connection that was never checked: null until discovery writes it.
    const never = connectionsMark(list(["c1", null, "revoked"]))!;
    expect(connectionsChanged(never, connectionsMark(list(["c1", null, "active"]))!)).toBe(false);
    expect(connectionsChanged(never, connectionsMark(list(["c1", "2026-10-31T10:00:00.000Z", "active"]))!)).toBe(true);
  });

  it("polling a reconnect of a revoked connection ends as connected only after discovery, not when the status turns active", async () => {
    vi.useFakeTimers();
    const popup = fakePopup();
    const old = "2026-10-01T00:00:00.000Z";
    const answers = [list(["c1", old, "revoked"]), list(["c1", old, "active"]), list(["c1", old, "active"]), list(["c1", "2026-10-31T10:00:00.000Z", "active"])];
    const connections = vi.fn(async () => answers[Math.min(connections.mock.calls.length - 1, answers.length - 1)]);
    const done = watchPopup(popup, watchDeps({ onStorage: undefined, connections }).deps);
    let settled = false;
    void done.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(FB_CONNECTIONS_POLL_MS * 2); // active again, discovery still running
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(FB_CONNECTIONS_POLL_MS);
    expect(await done).toEqual({ kind: "outcome", outcome: "connected" });
    expect(connections).toHaveBeenCalledTimes(4);
  });

  it("after a polling success the window is closed once it shows the callback's page, or after a few seconds either way", async () => {
    vi.useFakeTimers();
    const finishedList = async () => list(["c1", "2026-10-31T10:00:00.000Z"]);
    // Still on another origin (or the script never ran): closed after FB_POPUP_CLOSE_AFTER_MS.
    const stuck = fakePopup();
    let first = true;
    const done = watchPopup(stuck, watchDeps({ connections: async () => (first ? ((first = false), list()) : finishedList()) }).deps);
    await vi.advanceTimersByTimeAsync(FB_CONNECTIONS_POLL_MS);
    expect(await done).toEqual({ kind: "outcome", outcome: "connected" });
    expect(stuck.closeCount).toBe(0);
    await vi.advanceTimersByTimeAsync(FB_POPUP_CLOSE_AFTER_MS);
    expect(stuck.closeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(FB_POPUP_CLOSE_AFTER_MS);
    expect(stuck.closeCount).toBe(1);

    // The callback's page arrives (its meta tag is readable): closed at the next look, well before the wait ends.
    let readable = false;
    const loading = fakePopup();
    Object.defineProperty(loading, "document", {
      get() {
        if (!readable) throw new Error("SecurityError: cross-origin");
        return { querySelector: () => ({ getAttribute: () => "connected" }) };
      },
    });
    let once = true;
    const done2 = watchPopup(loading, watchDeps({ connections: async () => (once ? ((once = false), list()) : finishedList()) }).deps);
    await vi.advanceTimersByTimeAsync(FB_CONNECTIONS_POLL_MS);
    expect(await done2).toEqual({ kind: "outcome", outcome: "connected" });
    readable = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(loading.closeCount).toBe(1);
  });
});

describe("the callback's closing page", () => {
  const state = encodeURIComponent(`abc.123.def${POPUP_STATE_MARKER}`);

  it("writes the documented localStorage key with the outcome only, and carries no code or token", async () => {
    const { GET } = await import("@/app/api/meta-connect/callback/route");
    const res = await GET(new Request(`${ORIGIN}/api/meta-connect/callback?code=SECRET_CODE_123&state=${state}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(CONNECT_POPUP.storage).toBe("wa-meta-connect");
    expect(FB_POPUP).toEqual(CONNECT_POPUP);
    expect(body).toContain(`window.localStorage.setItem("${CONNECT_POPUP.storage}",JSON.stringify({source:m.source,outcome:m.outcome,at:Date.now()}))`);
    expect(body).toContain(`"source":"${CONNECT_POPUP.source}","outcome":"connected"`);
    for (const secret of ["SECRET_CODE_123", "abc.123.def", "access_token", "token"]) expect(body).not.toContain(secret);
    // It closes itself, and with no opener it still tries to close before going to Connections.
    expect(body).toContain("window.close()");
    expect(body).toMatch(/location\.replace\("https:\/\/wa\.example\.test\/app\/settings\/connections\?status=connected"\)/);
    // The storage write sits inside a try, so a browser that blocks storage still runs the rest.
    expect(body).toMatch(/try\{window\.localStorage\.setItem/);
  });

  it("a failure writes 'failed' and nothing of Meta's error", async () => {
    const { GET } = await import("@/app/api/meta-connect/callback/route");
    const { HttpError } = await import("@/lib/tenancy");
    h0.completeConnect.mockRejectedValueOnce(new HttpError(502, "Meta said: token EAAB-secret"));
    const body = await (await GET(new Request(`${ORIGIN}/api/meta-connect/callback?code=C&state=${state}`))).text();
    expect(body).toContain('"outcome":"failed"');
    expect(body).not.toContain("EAAB");
  });

  /** next.config.ts's policy for /api paths. */
  const LOCKED = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

  /**
   * The headers a deployed build sends for a path: next.config.ts's matching rules in order (a later rule wins for the same
   * key, as Next's resolve-routes does), then the route's own headers only where the config set none (Next 16's
   * send-response.js skips a header that is already present). Matching uses Next's own matcher with the options its router
   * uses for header rules (filesystem.js buildCustomRoute).
   */
  async function effectiveHeaders(pathname: string, route: Headers | null): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const rule of await nextConfig.headers!()) {
      const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, regexModifier: (r) => modifyRouteRegex(r), sensitive: false });
      if (match(pathname) === false) continue;
      for (const header of rule.headers) out.set(header.key.toLowerCase(), header.value);
    }
    route?.forEach((value, key) => {
      if (!out.has(key.toLowerCase())) out.set(key.toLowerCase(), value);
    });
    return out;
  }

  it("on a deployed build the page keeps its own policy, so its one script runs; every other /api path stays locked down", async () => {
    const { GET } = await import("@/app/api/meta-connect/callback/route");
    const res = await GET(new Request(`${ORIGIN}/api/meta-connect/callback?code=C&state=${state}`));
    const body = await res.text();
    const sent = await effectiveHeaders("/api/meta-connect/callback", res.headers);
    const csp = sent.get("content-security-policy")!;
    // What reaches the browser is the page's own policy, which allows exactly the page's one inline script by its hash.
    expect(csp).toBe(res.headers.get("content-security-policy"));
    expect(body.match(/<script/g)).toHaveLength(1);
    const script = body.match(/<script>([\s\S]*)<\/script>/)![1];
    expect(csp).toContain(`script-src 'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`);
    for (const d of ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) expect(csp).toContain(d);
    expect(sent.get("cache-control")).toBe("no-store");
    // Every other /api path keeps the locked-down policy, whatever its route sends.
    for (const p of ["/api", "/api/meta-connect/start", "/api/meta-connect/connections", "/api/meta-connect/callback/x", "/api/meta-connect/callbackx", "/api/promote/sources", "/api/a/b/c"]) {
      const h = await effectiveHeaders(p, new Headers({ "content-security-policy": "script-src *" }));
      expect(h.get("content-security-policy"), p).toBe(LOCKED);
      expect(h.get("cache-control"), p).toBe("no-store");
    }
  });

  it("the page's words hold whether or not its script closed the window", async () => {
    const { GET } = await import("@/app/api/meta-connect/callback/route");
    for (const [query, words] of [
      [`code=C&state=${state}`, "Facebook is connected. You can close this window."],
      [`error=access_denied&state=${state}`, "Facebook was closed before it finished, so nothing changed. You can close this window."],
    ] as const) {
      const body = await (await GET(new Request(`${ORIGIN}/api/meta-connect/callback?${query}`))).text();
      expect(body).toContain(`<p role="status">${words}</p>`);
      expect(body).not.toContain("closes by itself");
      expect(body).toContain(">Back to Edwyz</a>");
    }
  });

  it("every other answer from the callback carries a locked-down policy of its own, with no script allowed", async () => {
    const { GET } = await import("@/app/api/meta-connect/callback/route");
    const { HttpError } = await import("@/lib/tenancy");
    const redirect = await GET(new Request(`${ORIGIN}/api/meta-connect/callback?code=C&state=abc`));
    expect(redirect.status).toBe(303);
    const csp = redirect.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src");
    h0.getActor.mockRejectedValueOnce(new HttpError(401, "Sign in again."));
    const denied = await GET(new Request(`${ORIGIN}/api/meta-connect/callback?code=C&state=abc`));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("content-security-policy")).toBe(csp);
  });
});

describe("the Connections panel after completion (3.2 step 5)", () => {
  const purposes = [
    { scope: "ads_read", purpose: "Read ad performance for reports." },
    { scope: "pages_manage_posts", purpose: "Publish posts you schedule to your Page." },
  ];

  it("says posting needs one more permission (ads work without it), and names other gaps in plain words", () => {
    expect(POSTING_PERMISSION_TEXT).toBe("Posting to your Page and Instagram needs one more permission. Ads work without it.");
    expect(missingPermissionLines(["pages_manage_posts", "instagram_content_publish"], purposes)).toEqual({ posting: POSTING_PERMISSION_TEXT, others: null });
    expect(missingPermissionLines(["ads_read", "instagram_content_publish"], purposes)).toEqual({
      posting: POSTING_PERMISSION_TEXT,
      others: "Permission missing: Read ad performance for reports. Reconnect and approve everything to enable all features.",
    });
    expect(missingPermissionLines([], purposes)).toEqual({ posting: null, others: null });
  });

  it("shows Pages that can run ads, Instagram accounts with their pictures, and ad accounts with their status", () => {
    const page = renderToStaticMarkup(h(AssetRow, { asset: { id: "a1", type: "page", externalId: "p1", name: "Shop", status: "active", meta: { canAdvertise: true, pictureUrl: "https://cdn.example/p.jpg" } } }));
    expect(page).toContain("Can run ads");
    expect(page).toContain('src="https://cdn.example/p.jpg"');
    expect(page).toContain('alt=""');
    const noAds = renderToStaticMarkup(h(AssetRow, { asset: { id: "a2", type: "page", externalId: "p2", name: "Other", status: "active", meta: { canAdvertise: false } } }));
    expect(noAds).toContain("Can&#x27;t run ads yet");
    expect(noAds).toContain("connect again as someone who manages its ads");
    const ig = renderToStaticMarkup(h(AssetRow, { asset: { id: "a3", type: "instagram", externalId: "ig1", name: "shop", status: "active", meta: { username: "shop", profilePictureUrl: "https://cdn.example/ig.jpg", pageBacked: false } } }));
    expect(ig).toContain("@shop");
    expect(ig).toContain('src="https://cdn.example/ig.jpg"');
    const backed = renderToStaticMarkup(h(AssetRow, { asset: { id: "a4", type: "instagram", externalId: "ig2", name: "Shop", status: "active", meta: { pageBacked: true } } }));
    expect(backed).toContain("Ads only");
    const act = renderToStaticMarkup(h(AssetRow, { asset: { id: "a5", type: "ad_account", externalId: "act_1", name: "Shop ads", status: "active", meta: { accountStatus: 3 } } }));
    expect(act).toContain("Payment problem");
    expect(adAccountStatusLabel(1)).toEqual({ label: "Active", tone: "good" });
    expect(adAccountStatusLabel(null)).toBeNull();
    expect(assetPicture({ type: "instagram", meta: { profilePictureUrl: "javascript:alert(1)" } })).toBeNull();
    expect(assetPicture({ type: "page", meta: { pictureUrl: "http://cdn.example/p.jpg" } })).toBeNull();
    expect(assetName({ type: "instagram", name: null, externalId: "ig9", meta: null })).toBe("ig9");
  });

  it("announces the popup's progress and says what each ending means", () => {
    expect(popupPhaseText("waiting")).toMatch(/Facebook window/);
    expect(popupPhaseText("idle")).toBe("");
    expect(popupResultNotice({ kind: "outcome", outcome: "connected" }).notice).toMatch(/Connected/);
    expect(popupResultNotice({ kind: "outcome", outcome: "failed" }).error).toBeTruthy();
    expect(popupResultNotice({ kind: "closed" })).toEqual({});
    expect(popupResultNotice({ kind: "timeout" }).error).toMatch(/try again/i);
  });

  it("the panel's connect button calls the popup's start directly in the click", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/meta-connect/ConnectionsPanel.tsx"), "utf8");
    expect(src).toContain("useFacebookLoginPopup(");
    const connect = src.slice(src.indexOf("const connect = () => {"), src.indexOf("const refresh = async"));
    expect(connect).toContain("popup.start()");
    expect(connect).not.toMatch(/\bawait\b|\.then\(|apiFetch/);
    expect(src).not.toContain('apiFetch<{ url: string }>("/api/meta-connect/start"');
  });
});

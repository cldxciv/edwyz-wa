/**
 * The fake Meta Graph API over HTTP, for end-to-end runs (docs/IG-PAGE-ADS-SPEC.md 9.3, 9.4, PRM-03). The post picker,
 * readiness, previews, forms and the connect callback are fetched by the Next.js server, which Playwright's page.route cannot
 * reach, so the server is pointed here with GRAPH_BASE_URL (src/lib/graph/index.ts honours it only outside production and only
 * for a loopback address). It serves the same scenarios as tests/helpers/fake-meta-promote.ts, from the same code.
 *
 * - Listens on 127.0.0.1 only, and refuses a request whose Host header is not a loopback name (so a web page cannot reach it
 *   through DNS rebinding).
 * - Graph requests: `/<version>/<path>`, answered by the fake (classified, token-checked, recorded). The app's spend permits live
 *   in the app's process, where its own tripwire checks them, so this server cannot see them:
 *   - WhatsApp messages (`msg_send`) and spending-limit writes (`meta_cap`) are Phase 0 sends that SPEND_DRY_RUN does not stop.
 *     They are relayed to Phase 0's fake and listed at GET `/__fake/relayed`, not as violations;
 *   - any ads class (create, raise, lowering) is refused and recorded as a violation: with SPEND_DRY_RUN=1 on the app the ads
 *     client fakes those writes, and promote code never sends one, so none should arrive.
 * - Control (for specs): GET `/__fake/health`, GET `/__fake/calls` (method, pattern, class, token kind, status; never a token),
 *   GET `/__fake/violations`, GET `/__fake/relayed`, POST `/__fake/reset`, POST `/__fake/scenario` `{name, on}`, POST `/__fake/throttle`
 *   `{code, subcode?, times?, regainMinutes?, match?}`, POST `/__fake/usage` `{pct, regainMinutes?}`, POST `/__fake/video-polls`
 *   `{n}`.
 *
 * Use as Playwright's globalSetup (the default export starts it on FAKE_META_PORT, default 4010, and returns the teardown), or
 * call startFakeMetaServer() from a script.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createFakeMetaPromote, type FakeMetaPromote, type PromoteScenario } from "../tests/helpers/fake-meta-promote";

export const DEFAULT_FAKE_META_PORT = 4010;
const MAX_BODY = 16 * 1024 * 1024;
const HANG_LIMIT_MS = 60_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SCENARIOS: readonly PromoteScenario[] = [
  "boost_ineligible",
  "audience_terms_2655",
  "audience_terms_1870090",
  "leadgen_terms_missing",
  "unknown_lead_fields",
  "page_whatsapp_missing",
  "connected_instagram_missing",
  "hostile_preview",
  "review_feedback",
];

export type FakeMetaServer = { url: string; port: number; fake: FakeMetaPromote; close(): Promise<void> };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const hostName = (host: string | undefined): string => {
  const h = String(host ?? "").trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
};

async function control(fake: FakeMetaPromote, method: string, path: string, body: string, res: ServerResponse): Promise<void> {
  let input: Record<string, unknown> = {};
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "Send JSON." });
    }
  }
  if (method === "GET" && path === "/__fake/health") return json(res, 200, { ok: true });
  if (method === "GET" && path === "/__fake/calls") {
    return json(res, 200, { calls: fake.calls.map((c) => ({ method: c.method, pattern: c.pattern, class: c.class, tokenKind: c.tokenKind, permitted: c.permitted, relayed: c.relayed, status: c.status })) });
  }
  if (method === "GET" && path === "/__fake/violations") {
    return json(res, 200, { spend: fake.spendViolations().map((c) => ({ method: c.method, pattern: c.pattern, class: c.class })), bannedPreviews: fake.bannedCalls().length });
  }
  if (method === "GET" && path === "/__fake/relayed") {
    return json(res, 200, { calls: fake.relayedCalls().map((c) => ({ method: c.method, pattern: c.pattern, class: c.class, status: c.status })) });
  }
  if (method === "POST" && path === "/__fake/reset") {
    fake.reset();
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && path === "/__fake/scenario") {
    const name = input.name as PromoteScenario;
    if (!SCENARIOS.includes(name)) return json(res, 400, { error: `Unknown scenario. Use one of ${SCENARIOS.join(", ")}.` });
    fake.scenario(name, input.on !== false);
    return json(res, 200, { scenarios: fake.scenarios() });
  }
  if (method === "POST" && path === "/__fake/throttle") {
    const code = Number(input.code);
    if (!Number.isInteger(code)) return json(res, 400, { error: "Send a Meta error code." });
    let match: RegExp | undefined;
    if (typeof input.match === "string" && input.match.length <= 200) {
      try {
        match = new RegExp(input.match);
      } catch {
        return json(res, 400, { error: "match is not a valid pattern." });
      }
    }
    fake.throttleNext({
      code,
      subcode: typeof input.subcode === "number" ? input.subcode : undefined,
      times: typeof input.times === "number" ? input.times : 1,
      regainMinutes: typeof input.regainMinutes === "number" ? input.regainMinutes : undefined,
      match,
    });
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && path === "/__fake/usage") {
    const pct = Number(input.pct);
    if (!Number.isFinite(pct)) return json(res, 400, { error: "Send pct." });
    fake.setUsage(pct, Number(input.regainMinutes ?? 0) || 0);
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && path === "/__fake/video-polls") {
    const n = Number(input.n);
    if (!Number.isInteger(n) || n < 0) return json(res, 400, { error: "Send n." });
    fake.setVideoPolls(n);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "Unknown control path." });
}

/** Starts the fake on 127.0.0.1. Port 0 picks a free port (tests). */
export async function startFakeMetaServer(opts: { port?: number; fake?: FakeMetaPromote } = {}): Promise<FakeMetaServer> {
  const fake = opts.fake ?? createFakeMetaPromote();
  const open = new Set<ServerResponse>();
  const server: Server = createServer(async (req, res) => {
    try {
      if (!LOOPBACK_HOSTS.has(hostName(req.headers.host))) return json(res, 403, { error: "Loopback only." });
      const method = (req.method ?? "GET").toUpperCase();
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await readBody(req);
      if (url.pathname.startsWith("/__fake/")) return await control(fake, method, url.pathname, body, res);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      // From the app's process: its permits can't be seen here (see the header).
      const out = fake.respond({ method, url: `${url.pathname}${url.search}`, headers, body }, { remote: true });
      if (out.kind === "network") {
        res.destroy();
        return;
      }
      if (out.kind === "hang") {
        // Never answers; the caller's timeout fires. A safety limit closes it eventually.
        open.add(res);
        const timer = setTimeout(() => res.destroy(), HANG_LIMIT_MS);
        res.on("close", () => {
          clearTimeout(timer);
          open.delete(res);
        });
        return;
      }
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    } catch {
      if (!res.headersSent) json(res, 500, { error: { message: "fake-meta-server failed", code: 1 } });
      else res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_FAKE_META_PORT, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    fake,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of open) res.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** Playwright globalSetup: starts the fake on FAKE_META_PORT (default 4010) and returns the teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const port = Number(process.env.FAKE_META_PORT ?? DEFAULT_FAKE_META_PORT);
  const server = await startFakeMetaServer({ port: Number.isInteger(port) && port > 0 ? port : DEFAULT_FAKE_META_PORT });
  process.env.FAKE_META_URL = server.url;
  return () => server.close();
}

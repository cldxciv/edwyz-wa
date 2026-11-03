import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  enqueue: vi.fn(),
  exec: vi.fn(async () => 1),
  runPass: vi.fn(),
  alive: vi.fn(async () => false),
  razorpay: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { webhookEvent: { create: mocks.create }, $executeRaw: mocks.exec } }));
vi.mock("@/lib/queue", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/lib/storage", () => ({ appendJsonLine: vi.fn() }));
vi.mock("@/worker/loop", () => ({ runPass: mocks.runPass }));
vi.mock("@/worker/daemon", () => ({ daemonIsAlive: mocks.alive }));
vi.mock("@/lib/billing/webhook", () => ({ WEBHOOK_MAX_BYTES: 1_000_000, handleRazorpayWebhook: mocks.razorpay }));

import { POST as razorpayWebhook } from "@/app/api/webhooks/razorpay/route";
import { POST as tick } from "@/app/api/internal/tick/route";
import { POST as whatsappWebhook } from "@/app/webhooks/whatsapp/route";
import { onRequestError } from "@/instrumentation";
import { checkEnv } from "@/lib/env-rules.mjs";
import { setErrorReporter, setLogSink } from "@/lib/log";
import { errorResponse, HttpError } from "@/lib/tenancy";

const ROOT = path.join(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

type Line = { level: string; entry: Record<string, unknown> };
const lines: Line[] = [];
const named = (msg: string) => lines.filter((l) => l.entry.msg === msg);

beforeEach(() => {
  vi.clearAllMocks();
  lines.length = 0;
  setLogSink((level, line) => lines.push({ level, entry: JSON.parse(line) }));
});
afterEach(() => {
  setLogSink(null);
  setErrorReporter(null);
});

class PrismaClientKnownRequestError extends Error {
  code = "P2002";
}

describe("errorResponse: an unexpected error is a findable log line, not a bare class name", () => {
  it("logs api.unexpected with a request id that the 500 response carries too", async () => {
    const res = errorResponse(new Error("boom for jo@example.com"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong." });
    const [line] = named("api.unexpected");
    expect(line.level).toBe("error");
    expect(line.entry.err).toEqual({ kind: "Error", message: "boom for [email]" });
    expect(line.entry.reqId).toMatch(/^[0-9a-f]{16}$/);
    expect(res.headers.get("x-request-id")).toBe(line.entry.reqId);
  });

  it("with the request: reuses nginx's id and names the method and path, never the query string", async () => {
    const request = new Request("https://wa.edwyz.com/api/inbox/conversations/c1/messages?token=abc123secret", {
      method: "POST",
      headers: { "x-request-id": "0123456789abcdef0123456789abcdef" },
    });
    const res = errorResponse(new PrismaClientKnownRequestError('Unique failed on phone "919876543210"'), request);
    expect(res.headers.get("x-request-id")).toBe("0123456789abcdef0123456789abcdef");
    const [line] = named("api.unexpected");
    expect(line.entry).toMatchObject({ reqId: "0123456789abcdef0123456789abcdef", method: "POST", path: "/api/inbox/conversations/c1/messages" });
    expect(line.entry.err).toEqual({ kind: "PrismaClientKnownRequestError P2002" });
    expect(JSON.stringify(line)).not.toMatch(/abc123secret|919876543210/);
  });

  it("feeds the error reporter hook with scrubbed data and the request id", () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const res = errorResponse(new Error("down for +91 98765 43210"));
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter.mock.calls[0][0].requestId).toBe(res.headers.get("x-request-id"));
    expect(JSON.stringify(reporter.mock.calls[0][0])).not.toContain("98765");
  });

  it("leaves an HttpError as it was: its own message and status, no error line, no request id", async () => {
    const res = errorResponse(new HttpError(409, "Reconnect WhatsApp in Settings."));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Reconnect WhatsApp in Settings." });
    expect(res.headers.get("x-request-id")).toBeNull();
    expect(lines).toEqual([]);
  });
});

describe("onRequestError (src/instrumentation.ts): errors Next.js catches itself", () => {
  const saved = process.env.NEXT_RUNTIME;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = saved;
  });
  const request = { path: "/approve/tok_secret_value?x=1", method: "GET", headers: { "x-request-id": "abcdef0123456789" } };
  const context = { routerKind: "App Router", routePath: "/approve/[token]", routeType: "render", renderSource: "server-rendering", revalidateReason: undefined } as const;

  it("logs request.unhandled with the route pattern, the request id and the digest from the error page, never the concrete path", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const error = Object.assign(new Error("render failed"), { digest: "2348734870" });
    await onRequestError(error, request, context);
    const [line] = named("request.unhandled");
    expect(line.level).toBe("error");
    expect(line.entry).toMatchObject({ reqId: "abcdef0123456789", method: "GET", route: "/approve/[token]", routeType: "render", renderSource: "server-rendering", digest: 2348734870 });
    expect(JSON.stringify(line)).not.toContain("tok_secret_value");
  });

  it("mints an id when none came in, and does nothing outside the Node.js runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    await onRequestError(new Error("x"), { ...request, headers: {} }, { ...context, renderSource: undefined });
    expect(named("request.unhandled")[0].entry.reqId).toMatch(/^[0-9a-f]{16}$/);
    expect(named("request.unhandled")[0].entry).not.toHaveProperty("renderSource");
    lines.length = 0;
    process.env.NEXT_RUNTIME = "edge";
    await onRequestError(new Error("x"), request, context);
    expect(lines).toEqual([]);
  });

  it("register() marks where the error tracker goes once a vendor is chosen", () => {
    const source = read("src/instrumentation.ts");
    expect(source).toContain("setErrorReporter");
    expect(source).toMatch(/export const onRequestError/);
  });
});

describe("webhook and tick routes log through @/lib/log", () => {
  const SECRET = "app-secret";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const signed = (sig: string | null) =>
    new Request("https://wa.edwyz.com/webhooks/whatsapp", {
      method: "POST",
      body,
      headers: { "x-request-id": "inboundrequest01", ...(sig ? { "x-hub-signature-256": sig } : {}) },
    });

  beforeEach(() => {
    process.env.META_APP_SECRET = SECRET;
    mocks.create.mockResolvedValue({ id: "evt1" });
  });

  // nginx's /webhooks/ block does not send X-Request-Id today (docs/ops.md section 4), so in production this id is minted; the route
  // reuses one as soon as it is sent.
  it("WhatsApp: a bad signature is a warning with the request id the call came with", async () => {
    expect((await whatsappWebhook(signed("sha256=deadbeef"))).status).toBe(401);
    const [line] = named("webhook.signature_rejected");
    expect(line).toMatchObject({ level: "warn", entry: { reqId: "inboundrequest01", route: "webhooks.whatsapp" } });
  });

  it("WhatsApp: without an inbound id the line still carries a minted one", async () => {
    const res = await whatsappWebhook(new Request("https://wa.edwyz.com/webhooks/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=deadbeef" } }));
    expect(res.status).toBe(401);
    expect(named("webhook.signature_rejected")[0].entry.reqId).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });

  it("WhatsApp: a failed store is an error line with the cause and never the payload, and Meta is asked to retry", async () => {
    mocks.create.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    expect((await whatsappWebhook(signed(sig))).status).toBe(500);
    const [line] = named("webhook.store_failed");
    expect(line.level).toBe("error");
    expect(line.entry.err).toMatchObject({ kind: "Error", message: "connect ECONNREFUSED 127.0.0.1:5432" });
    expect(JSON.stringify(line)).not.toContain("whatsapp_business_account");
  });

  it("Razorpay: a rejected signature warns, an unexpected failure is an error line and a 500", async () => {
    const post = () => new Request("https://wa.edwyz.com/api/webhooks/razorpay", { method: "POST", body: "{}" });
    mocks.razorpay.mockResolvedValueOnce({ status: 401, body: "Invalid signature" });
    expect((await razorpayWebhook(post())).status).toBe(401);
    expect(named("razorpay.signature_rejected")).toHaveLength(1);
    mocks.razorpay.mockRejectedValueOnce(new Error("subscription lookup failed"));
    expect((await razorpayWebhook(post())).status).toBe(500);
    expect(named("razorpay.webhook_failed")[0].entry.err).toMatchObject({ message: "subscription lookup failed" });
  });

  it("tick: a failed heartbeat write is logged, and a failed pass answers 500 with the request id in the response and the log", async () => {
    process.env.WORKER_SECRET = "right-secret";
    const call = () =>
      tick(new Request("https://wa.edwyz.com/api/internal/tick", { method: "POST", headers: { "x-worker-secret": "right-secret", "x-request-id": "tickrequest00001" } }));
    mocks.runPass.mockResolvedValueOnce({ webhook: 0 });
    mocks.exec.mockRejectedValueOnce(new Error("heartbeat write failed"));
    expect((await call()).status).toBe(200);
    expect(named("worker.heartbeat_failed")[0].entry).toMatchObject({ route: "internal.tick", err: { message: "heartbeat write failed" } });

    mocks.runPass.mockRejectedValueOnce(new Error("pass exploded"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).toBe("tickrequest00001");
    expect(named("api.unexpected")[0].entry).toMatchObject({ reqId: "tickrequest00001", method: "POST", path: "/api/internal/tick" });
  });

  it("no console calls are left in the three routes", () => {
    for (const file of ["src/app/webhooks/whatsapp/route.ts", "src/app/api/webhooks/razorpay/route.ts", "src/app/api/internal/tick/route.ts"]) {
      expect(read(file), file).not.toMatch(/console\./);
    }
  });
});

describe(".env.example is in step with the env rules", () => {
  const example = parseEnv(read(".env.example")) as Record<string, string>;
  const names = Object.keys(example);

  it("lists the runtime switches, the AI key and every spend and Eddy variable the rules check, and drops MAX_DAILY_BUDGET_MINOR", () => {
    const rules = read("src/lib/env-rules.mjs");
    const constants = ["EDDY_SUPPORTED_MODELS", "EDDY_PRICE_FIELDS", "EDDY_FLAG_VALUES", "EDDY_NUMBERS", "SPEND_FLAG_VALUES"];
    const checked = [...new Set([...rules.matchAll(/\b((?:SPEND|EDDY|ASSISTANT)_[A-Z_]+[A-Z])\b/g)].map((m) => m[1]))].filter((n) => !constants.includes(n));
    expect(checked.length).toBeGreaterThan(15);
    for (const name of [...checked, "CSP_MODE", "ENV_STRICT", "LOG_LEVEL", "RATELIMIT_BACKEND", "ANTHROPIC_API_KEY", "AI_MODEL"]) {
      expect(names, name).toContain(name);
    }
    expect(names).not.toContain("MAX_DAILY_BUDGET_MINOR");
  });

  it("passes the env rules, apart from the secrets it leaves empty on purpose", () => {
    const { errors } = checkEnv(example);
    for (const error of errors) expect(error, error).toMatch(/^(DATABASE_URL|SESSION_SECRET|ENCRYPTION_KEY|WORKER_SECRET|STATE_SECRET) is not set$/);
    expect(example.CSP_MODE).toBe("report-only");
    expect(example.EDDY_ENABLED).toBe("false");
    expect(example.SPEND_ENFORCE).toBe("observe");
  });

  it("lists every Studio, Canva and ads MCP variable the rules check, each switch off and Canva unset (ADS-MCP-CANVA-CREATIVE-SPEC 5.8)", () => {
    for (const name of [
      "STUDIO_ENABLED", "STUDIO_DAILY_RENDERS", "DISABLE_SYSTEM_FONTS_LOAD", "CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET", "CANVA_VIDEO",
      "META_ADS_MCP", "META_ADS_MCP_DAILY_CALLS", "META_ADS_MCP_RULES", "CANVA_API_BASE_URL", "CANVA_AUTH_BASE_URL", "META_ADS_MCP_URL", "CREATIVE_IMAGE_PROVIDER",
    ]) {
      expect(names, name).toContain(name);
    }
    expect(example.STUDIO_ENABLED).toBe("off");
    expect(example.META_ADS_MCP).toBe("off");
    expect(example.META_ADS_MCP_RULES).toBe("off");
    expect(example.CANVA_VIDEO).toBe("off");
    expect(example.DISABLE_SYSTEM_FONTS_LOAD).toBe("1");
    for (const name of ["CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET", "CANVA_API_BASE_URL", "CANVA_AUTH_BASE_URL", "META_ADS_MCP_URL", "STUDIO_DAILY_RENDERS", "META_ADS_MCP_DAILY_CALLS"]) expect(example[name], name).toBe("");
    // The default provider stays placeholder while Studio is off; the brand value is documented for when it is on.
    expect(example.CREATIVE_IMAGE_PROVIDER).toBe("placeholder");
    expect(read(".env.example")).toMatch(/brand \(images with the business's logo, drawn by Studio; needs STUDIO_ENABLED=on\)/);
    // With every switch as written, nothing about Studio, Canva or the ads MCP is a warning or listed as off.
    const report = checkEnv(example);
    expect(report.warnings.join("|")).not.toMatch(/STUDIO|CANVA|META_ADS_MCP|CREATIVE_IMAGE_PROVIDER|DISABLE_SYSTEM_FONTS_LOAD/);
    expect(report.disabled.join("|")).not.toContain("Canva");
  });

  it("keeps the SMTP lines for the local relay and documents port 465", () => {
    for (const name of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_TLS_SERVERNAME", "EMAIL_FROM"]) expect(names, name).toContain(name);
    const raw = read(".env.example");
    expect(raw).toContain("# Local relay without a login: SMTP_HOST=127.0.0.1, SMTP_PORT=25, SMTP_USER=<the from address>, SMTP_PASS empty and");
    expect(raw).toContain("SMTP_PORT=465");
  });
});

describe("log rotation and CI are shipped as files", () => {
  it("deploy/logrotate-edwyz-wa rotates every /var/log/edwyz-wa-*.log the deploy files write and wa's own pm2 logs, and nothing else", () => {
    const rule = read("deploy/logrotate-edwyz-wa");
    const blocks = [...rule.matchAll(/^(\S[^{\n]*)\{([^}]*)\}/gm)].map((m) => ({ paths: m[1].trim(), body: m[2] }));
    expect(blocks.map((b) => b.paths)).toEqual(["/var/log/edwyz-wa-*.log", "/root/.pm2/logs/edwyz-wa-*.log"]);
    // pm2 keeps its log files open: only copytruncate rotates them without a reload.
    expect(blocks[1].body).toContain("copytruncate");
    expect(blocks[0].body).not.toContain("copytruncate");
    for (const directive of ["maxsize 20M", "rotate 8", "compress", "missingok", "notifempty"]) expect(rule).toContain(directive);
    const written = new Set<string>();
    for (const file of ["deploy/alert-wa.sh", "deploy/cron-wa-alert", "deploy/cron-wa-backup", "deploy/cron-wa-tick"]) {
      for (const m of read(file).matchAll(/\/var\/log\/[A-Za-z0-9._-]+\.log/g)) written.add(m[0]);
    }
    expect(written.size).toBeGreaterThanOrEqual(4);
    for (const log of written) expect(log, log).toMatch(/^\/var\/log\/edwyz-wa-[A-Za-z0-9._-]+\.log$/);
  });

  it("the release copies and installs it, and does not install pm2-logrotate on the shared VPS (owner, 2026-10-31)", () => {
    const readme = read("deploy/README-deploy.md");
    expect(readme).toMatch(/cp [^\n]*deploy\/logrotate-edwyz-wa[^\n]*"\.\.\/\$REL\/deploy\/"/);
    expect(readme).toContain("install -m 644 /root/releases/$REL/deploy/logrotate-edwyz-wa /etc/logrotate.d/edwyz-wa");
    expect(readme).not.toContain("pm2 install pm2-logrotate");
  });

  it("CI at the repository root runs tsc, the unit tests and the build inside wa/", () => {
    const ci = readFileSync(path.join(ROOT, "..", ".github", "workflows", "wa-ci.yml"), "utf8");
    expect(ci).toContain("working-directory: wa");
    expect(ci).toContain("cache-dependency-path: wa/package-lock.json");
    const steps = ["npm ci", "npx tsc --noEmit -p .", "npx vitest run --project unit", "npm run build"].map((s) => ci.indexOf(`run: ${s}`));
    for (const at of steps) expect(at).toBeGreaterThan(-1);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(ci).not.toMatch(/secrets\./);
  });
});

describe("ops and App Review docs match the code and the draft", () => {
  it("docs/ops.md no longer describes work that is done as still to do", () => {
    const ops = read("docs/ops.md");
    expect(ops).not.toContain("API routes call `requestLogger` themselves");
    expect(ops).not.toContain("Until every in-memory limiter and guard in section 2 has been switched");
    expect(ops).not.toContain("make the root layout dynamic");
    expect(ops).not.toContain("it runs in `npm test` and before every build");
    for (const now of ["api.unexpected", "request.unhandled", "THEME_INIT_SCRIPT_HASH", "LATEST_MIGRATION", "deploy/logrotate-edwyz-wa"]) expect(ops, now).toContain(now);
  });

  it("section 4 names every proxied nginx block that sends no X-Request-Id, and never claims every request carries one", () => {
    const ops = read("docs/ops.md");
    const paragraph = ops.split("\n").find((l) => l.startsWith("Request ids:")) ?? "";
    expect(paragraph).not.toContain("on every proxied request");
    const conf = read("deploy/nginx-wa.edwyz.com.conf").replace(/#.*$/gm, "");
    const blocks = [...conf.matchAll(/location\s+([^{]+)\{([^}]*)\}/g)].filter((m) => m[2].includes("proxy_pass")).map((m) => ({ arg: m[1].trim(), body: m[2] }));
    expect(blocks.length).toBeGreaterThan(5);
    expect(blocks.find((b) => b.arg === "/")?.body, "location /").toContain("proxy_set_header X-Request-Id $request_id;");
    const without = blocks.filter((b) => !b.body.includes("X-Request-Id"));
    for (const { arg } of without) {
      // "= /api/content/media" -> "/api/content/media"; "~ ^/api/mcp(/|$)" -> "/api/mcp"; a regex keeps its literal prefix.
      const prefix = arg.replace(/^(=|~\*?|\^~)\s+/, "").replace(/^\^/, "").split(/[[(+*?$\\]/)[0];
      expect(paragraph, arg).toContain("`" + prefix);
    }
    // A block that sends the id must not be listed among those that do not.
    const listed = paragraph.slice(paragraph.indexOf("do not send it yet"));
    for (const { arg } of blocks.filter((b) => b.body.includes("X-Request-Id") && b.arg !== "/")) {
      const prefix = arg.replace(/^(=|~\*?|\^~)\s+/, "").replace(/^\^/, "").split(/[[(+*?$\\]/)[0];
      expect(listed, arg).not.toContain("`" + prefix + "`");
    }
  });

  // Reads every source file (generated client included), so it gets the same 30 s budget as the other src scans.
  it("section 2 lists every memoryOnly limiter as per-process state", { timeout: 30_000 }, () => {
    const ops = read("docs/ops.md");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
      return out;
    };
    const pinned: { file: string; name: string }[] = [];
    for (const file of walk(path.join(ROOT, "src"))) {
      for (const m of read(file).matchAll(/createLimiter\([^)]*?"([a-z0-9-]+)",\s*\{\s*memoryOnly:\s*true\s*\}\)/g)) pinned.push({ file, name: m[1] });
    }
    expect(pinned.map((p) => p.name).sort()).toEqual(expect.arrayContaining(["csp-report", "meta-deauthorize"]));
    for (const { file, name } of pinned) {
      expect(ops, name).toContain(`| \`${file}\` | \`${name}\` (\`memoryOnly\``);
      expect(ops, name).toMatch(new RegExp(`The \`memoryOnly\` limiters[^|]*\`${name}\``));
    }
    expect(ops).not.toContain("Every rate limiter now counts in Postgres");
  });

  it("section 6 does not call the 404 page plain HTML: its mobile menu needs the scripts the strict policy blocks", () => {
    const ops = read("docs/ops.md");
    expect(ops).not.toContain("Their content is plain HTML that works without the scripts");
    expect(read("src/components/shell.tsx")).toContain("<MobileNav");
    expect(read("src/components/site/mobile-nav.tsx")).toMatch(/^"use client";/);
    const notFound = read("src/app/not-found.tsx");
    // Until the 404 page renders per request, ops.md must warn about the inert menu button; once it does, drop the warning and this guard.
    if (!/\bconnection\(\)|dynamic\s*=\s*"force-dynamic"/.test(notFound)) {
      expect(ops).toContain("the Menu button on the 404 page does nothing");
    }
  });

  it("deploy/README-deploy.md no longer says the home page is rendered at build time", () => {
    expect(read("deploy/README-deploy.md")).not.toContain("the home page and other static pages are rendered once, at build time");
  });

  it("App Review files say draft, not submitted, and no longer claim the growth routes are missing", () => {
    const dir = "docs/app-review";
    expect(read(`${dir}/status.md`)).toContain("1799953447868194");
    expect(read(`${dir}/status.md`)).not.toMatch(/Awaiting review result/);
    expect(read(`${dir}/00-overview.md`)).not.toContain("already submitted, in review");
    for (const name of ["whatsapp_business_messaging", "whatsapp_business_management"]) {
      expect(read(`${dir}/${name}.md`)).toContain("Phase: A (draft, not submitted");
    }
    for (const name of ["business_management", "ads_read", "ads_management", "pages_manage_ads", "leads_retrieval", "pages_show_list", "pages_read_engagement", "pages_manage_metadata", "instagram_content_publish"]) {
      const doc = read(`${dir}/${name}.md`);
      expect(doc, name).not.toMatch(/do not exist in the repo|NOT BUILT|planned/);
      expect(doc, name).toContain("Feature built: **Built**");
    }
    for (const route of ["ads", "ads/insights", "ads/new", "leads", "leads/forms", "settings/connections", "content"]) {
      expect(existsSync(path.join(ROOT, "src/app/(app)/app", route, "page.tsx")), route).toBe(true);
    }
  });

  it("status.md matches the latest draft record: what is filled, what is left, and the two permissions the code uses but the draft lacks", () => {
    const dir = "docs/app-review";
    const status = read(`${dir}/status.md`);
    const row = (item: string) => status.split("\n").find((l) => l.startsWith(`| ${item} `)) ?? "";
    const draftCell = (item: string) => row(item).split("|")[2]?.trim() ?? "";
    for (const item of ["business_management", "pages_show_list", "pages_read_engagement", "pages_manage_metadata", "pages_manage_ads", "ads_management", "ads_read", "leads_retrieval"]) {
      expect(draftCell(item), item).toBe("Yes (description written)");
    }
    for (const item of ["pages_manage_posts", "instagram_content_publish"]) {
      expect(draftCell(item), item).toMatch(/^No: used by `src\/lib\/content` but not requested; add to the draft$/);
    }
    // Both are in scopes.ts because code calls an API that needs them, which is why the draft must gain them.
    const scopes = read("src/lib/meta-connect/scopes.ts");
    for (const scope of ["pages_manage_posts", "instagram_content_publish"]) expect(scopes, scope).toContain(`"${scope}"`);
    const left = status.split("\n").find((l) => l.startsWith("- **Left on the draft for the owner:**")) ?? "";
    expect(left).toContain("requests-4");
    expect(left).toContain("[OWNER: ADD REVIEWER EMAIL/PASSWORD]");
    expect(left).not.toContain("the other 20 items");
    expect(read(`${dir}/00-overview.md`)).toContain("**the draft does not request them**");
    expect(read(`${dir}/instagram_content_publish.md`)).toContain("**does not include this permission yet**");
  });
});

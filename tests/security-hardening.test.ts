import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const m = () => ({ findFirst: vi.fn(), findFirstOrThrow: vi.fn(async () => ({ id: "c1" })), findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() });
  // adAudience: promote/forget.ts forgetContact (PRM-11) first looks for the workspace's customer-list audiences on Meta (none).
  return { contact: m(), conversation: m(), message: m(), broadcast: m(), broadcastRecipient: m(), platformSetting: m(), auditLog: m(), adAudience: m() };
});
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => ({ assertTenantCanWrite: async () => undefined, assertWithinLimit: async () => undefined, startTrial: async () => undefined }));
const audit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/auth/audit", () => ({ audit }));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
const bsvc = vi.hoisted(() => ({
  startBroadcast: vi.fn(async () => ({ id: "b1" })),
  pauseBroadcast: vi.fn(async () => ({ id: "b1" })),
  cancelBroadcast: vi.fn(async () => ({ id: "b1" })),
  createBroadcast: vi.fn(async () => ({ id: "b1" })),
  listBroadcasts: vi.fn(),
}));
vi.mock("@/lib/broadcasts/service", () => bsvc);

process.env.SITE_URL = "https://wa.edwyz.com";

import { POST as bcCreate } from "@/app/api/broadcasts/route";
import { POST as bcCancel } from "@/app/api/broadcasts/[id]/cancel/route";
import { POST as bcPause } from "@/app/api/broadcasts/[id]/pause/route";
import { POST as bcStart } from "@/app/api/broadcasts/[id]/start/route";
import { POST as contactCreate } from "@/app/api/contacts/route";
import { DELETE as contactDelete, PATCH as contactPatch } from "@/app/api/contacts/[id]/route";
import { POST as contactImport } from "@/app/api/contacts/import/route";
import { POST as tplCreate } from "@/app/api/templates/route";
import { DELETE as tplDelete } from "@/app/api/templates/[id]/route";
import { POST as tplSubmit } from "@/app/api/templates/[id]/submit/route";
import { POST as tplSync } from "@/app/api/templates/sync/route";
import { assertSameOrigin as inboxCheck } from "@/lib/inbox/http";
import { assertSameOrigin as onboardingCheck } from "@/lib/onboarding/http";
import { clientIp } from "@/lib/net/ip";
import { readJsonLimited } from "@/lib/http/body";
import { checkLoginLimits, resetLoginLimits } from "@/lib/auth/ratelimit";
import { isStopMessage } from "@/lib/webhooks/payload";
import { createContact, listContacts, updateContact } from "@/lib/contacts/service";
import { errorResponse } from "@/lib/tenancy";
import { setLogSink } from "@/lib/log";
import { describeError, sanitizeMessage } from "@/lib/safe-error";
import { getDeletionRequest, markDeletionCompleted, recordDeletionRequest } from "@/lib/storage";
import nextConfig from "../next.config";

type Handler = (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
const ctx = { params: Promise.resolve({ id: "x" }) };
const noOrigin = (method: string) => new Request("https://wa.edwyz.com/api/x", { method, body: method === "DELETE" ? undefined : "{}" });
const evil = (method: string) =>
  new Request("https://wa.edwyz.com/api/x", { method, headers: { origin: "https://evil.example" }, body: method === "DELETE" ? undefined : "{}" });
const good = (method: string) =>
  new Request("https://wa.edwyz.com/api/x", {
    method,
    headers: { origin: "https://wa.edwyz.com", "content-type": "application/json" },
    body: method === "DELETE" ? undefined : "{}",
  });

beforeEach(() => {
  vi.clearAllMocks();
  resetLoginLimits();
});

describe("F2/F14 CSRF on every state-changing handler", () => {
  const handlers: [string, string, Handler][] = [
    ["POST /contacts", "POST", contactCreate as never],
    ["PATCH /contacts/:id", "PATCH", contactPatch as never],
    ["DELETE /contacts/:id", "DELETE", contactDelete as never],
    ["POST /contacts/import", "POST", contactImport as never],
    ["POST /broadcasts", "POST", bcCreate as never],
    ["POST /broadcasts/:id/start", "POST", bcStart as never],
    ["POST /broadcasts/:id/pause", "POST", bcPause as never],
    ["POST /broadcasts/:id/cancel", "POST", bcCancel as never],
    ["POST /templates", "POST", tplCreate as never],
    ["POST /templates/sync", "POST", tplSync as never],
    ["DELETE /templates/:id", "DELETE", tplDelete as never],
    ["POST /templates/:id/submit", "POST", tplSubmit as never],
  ];
  it.each(handlers)("%s rejects a missing or foreign Origin before touching auth", async (_n, method, handler) => {
    expect((await handler(noOrigin(method), ctx)).status).toBe(403);
    expect((await handler(evil(method), ctx)).status).toBe(403);
    expect(auth.getActor).not.toHaveBeenCalled();
  });

  it("the inbox and onboarding variants are the strict one (no Origin is refused, even on PUT)", () => {
    for (const check of [inboxCheck, onboardingCheck]) {
      expect(() => check(noOrigin("PUT"))).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => check(evil("POST"))).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => check(good("POST"))).not.toThrow();
    }
  });
});

describe("F11 audit coverage", () => {
  beforeEach(() => auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "admin" }));

  it.each([
    ["start", bcStart, "broadcast.started"],
    ["pause", bcPause, "broadcast.paused"],
    ["cancel", bcCancel, "broadcast.canceled"],
  ])("broadcast %s is audited with tenant, user and target", async (_n, handler, action) => {
    expect((await (handler as never as Handler)(good("POST"), ctx)).status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", userId: "u1", action, target: "x" }));
  });

  it("contact delete is audited", async () => {
    db.contact.deleteMany.mockResolvedValue({ count: 1 });
    expect((await (contactDelete as never as Handler)(good("DELETE"), ctx)).status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contact.deleted", target: "x" }));
  });
});

describe("F3 client IP and login buckets", () => {
  const withHeaders = (h: Record<string, string>) => new Request("https://wa.edwyz.com/", { headers: h });

  it("prefers X-Real-IP and otherwise the LAST X-Forwarded-For entry, never the first", () => {
    expect(clientIp(withHeaders({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("203.0.113.9");
    expect(clientIp(withHeaders({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(withHeaders({}))).toBe("unknown");
  });

  it("a stranger cannot lock a victim out: another IP keeps its own (email, IP) bucket", async () => {
    for (let i = 0; i < 12; i++) {
      try {
        await checkLoginLimits("9.9.9.9", "victim@a.co");
      } catch {
        // the attacker is limited
      }
    }
    await expect(checkLoginLimits("9.9.9.9", "victim@a.co")).rejects.toMatchObject({ status: 429 });
    await expect(checkLoginLimits("5.5.5.5", "victim@a.co")).resolves.toBeUndefined();
  });

  it("the per-email ceiling still stops a distributed attack", async () => {
    let blocked = false;
    for (let i = 0; i < 150; i++) {
      try {
        await checkLoginLimits(`10.0.${Math.floor(i / 20)}.${i % 20}`, "target@a.co");
      } catch {
        blocked = true;
      }
    }
    expect(blocked).toBe(true);
  });
});

describe("F24 body limits", () => {
  it("rejects an oversized declared body and a chunked body", async () => {
    const big = "x".repeat(2000);
    const declared = new Request("https://wa.edwyz.com/", { method: "POST", body: `{"a":"${big}"}` });
    await expect(readJsonLimited(declared, 100)).rejects.toMatchObject({ status: 413 });
    const chunks = [`{"a":"${big}`, `"}`];
    const stream = new ReadableStream({
      start(c) {
        for (const part of chunks) c.enqueue(new TextEncoder().encode(part));
        c.close();
      },
    });
    const chunked = new Request("https://wa.edwyz.com/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readJsonLimited(chunked, 100)).rejects.toMatchObject({ status: 413 });
  });

  it("parses small objects and refuses arrays and bad JSON", async () => {
    const mk = (body: string) => new Request("https://wa.edwyz.com/", { method: "POST", body });
    await expect(readJsonLimited(mk('{"a":1}'))).resolves.toEqual({ a: 1 });
    await expect(readJsonLimited(mk("[1]"))).rejects.toMatchObject({ status: 400 });
    await expect(readJsonLimited(mk("nope"))).rejects.toMatchObject({ status: 400 });
  });
});

describe("F9 opt-out detection and opt-in restriction", () => {
  // Owner default 1 (2026-10-31): the STOP words are stop, stop all, unsubscribe, opt out, cancel, end and quit, plus words each
  // workspace adds, and only a whole-message match counts. "Stop please!" and "STOP sending me messages" opted out under the older
  // "starts with stop" rule; a workspace that wants them adds them as its own words (the last case below).
  it.each(["STOP", "stop.", "  Stop All ", "UNSUBSCRIBE", "End", "cancel", "Quit", "opt out", "OPTOUT", "Opt-out!", "ＳＴＯＰ"])(
    "treats %j as an opt-out",
    (text) => expect(isStopMessage(text)).toBe(true),
  );
  it.each(["", "hello", "please do not stop", "when does the bus stop here at the main square", "ending soon", "stopover info", "cancel my order", "Stop please!", "STOP sending me messages"])(
    "does not treat %j as an opt-out",
    (text) => expect(isStopMessage(text)).toBe(false),
  );
  it("honours a workspace's own words, whole-message only", () => {
    expect(isStopMessage("Stop please!", ["stop please"])).toBe(true);
    expect(isStopMessage("stop please now", ["stop please"])).toBe(false);
  });

  const agent = { userId: "u1", tenantId: "t1", role: "agent" as const };
  const admin = { ...agent, role: "admin" as const };

  it("agents cannot set opt-in; admins can, with a source and a timestamp", async () => {
    await expect(createContact(agent, { phone: "+919876543210", optIn: true, optInSource: "form" })).rejects.toMatchObject({ status: 403 });
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockResolvedValue({ id: "c1" });
    const now = new Date("2026-01-01T00:00:00Z");
    await createContact(admin, { phone: "+919876543210", optIn: true, optInSource: "form" }, now);
    expect(db.contact.create.mock.calls[0][0].data).toMatchObject({ optIn: true, optInSource: "form", optInAt: now });
    await expect(createContact(admin, { phone: "+919876543211", optIn: true })).rejects.toMatchObject({ status: 400 });

    db.contact.findFirst.mockResolvedValue({ id: "c1", optIn: false, optedOutAt: null });
    await expect(updateContact(agent, "c1", { optIn: true, optInSource: "form" })).rejects.toMatchObject({ status: 403 });
    expect(db.contact.updateMany).not.toHaveBeenCalled();
  });

  it("agents can still create contacts without opt-in and can opt a contact out, tenant-scoped", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockResolvedValue({ id: "c1" });
    await expect(createContact(agent, { phone: "+919876543210" })).resolves.toBeTruthy();
    db.contact.findFirst.mockResolvedValue({ id: "c1", optIn: true, optedOutAt: null });
    db.contact.updateMany.mockResolvedValue({ count: 1 });
    await updateContact(agent, "c1", { optIn: false });
    expect(db.contact.updateMany.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1" });
  });
});

describe("F26 cursors must belong to the tenant", () => {
  it("ignores a cursor id from another tenant", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    await listContacts({ userId: "u", tenantId: "t1", role: "agent" }, { cursor: "foreign" });
    expect(db.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "foreign", tenantId: "t1" } }));
    expect(db.contact.findMany.mock.calls[0][0]).not.toHaveProperty("cursor");
  });

  it("uses a cursor that belongs to the tenant", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "mine" });
    await listContacts({ userId: "u", tenantId: "t1", role: "agent" }, { cursor: "mine" });
    expect(db.contact.findMany.mock.calls[0][0]).toMatchObject({ cursor: { id: "mine" }, skip: 1 });
  });
});

describe("F25 errors do not leak personal data", () => {
  it("errorResponse logs only the class name and code, never the message", async () => {
    // errorResponse logs through @/lib/log (api.unexpected); docs/ops.md section 4.
    const lines: string[] = [];
    setLogSink((_level, line) => lines.push(line));
    class PrismaClientKnownRequestError extends Error {
      code = "P2002";
    }
    try {
      const res = errorResponse(new PrismaClientKnownRequestError("Invalid invocation: phone +919876543210 body 'my secret'"));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Something went wrong." });
    } finally {
      setLogSink(null);
    }
    const logged = lines.join(" ");
    expect(logged).toContain("PrismaClientKnownRequestError P2002");
    expect(logged).not.toContain("919876543210");
    expect(logged).not.toContain("secret");
  });

  it("sanitizeMessage strips emails and long digit runs and truncates", () => {
    expect(sanitizeMessage("failed for +919876543210 and a.b@x.co code 131047")).toBe("failed for +[number] and [email] code 131047");
    expect(sanitizeMessage("a".repeat(500))).toHaveLength(200);
    expect(describeError(null)).toBe("UnknownError");
  });
});

describe("F8 deletion requests live in the database", () => {
  it("records, reads and completes through PlatformSetting rows and never completes on its own", async () => {
    let stored: { key: string; value: Record<string, unknown> } | null = null;
    db.platformSetting.create.mockImplementation(async ({ data }: { data: { key: string; value: Record<string, unknown> } }) => void (stored = data));
    db.platformSetting.findUnique.mockImplementation(async () => stored);
    db.platformSetting.update.mockImplementation(
      async ({ data }: { data: { value: Record<string, unknown> } }) => void (stored = { key: stored!.key, value: data.value }),
    );
    const code = await recordDeletionRequest("fb-user-1", new Date("2026-02-01T00:00:00Z"));
    expect(code).toMatch(/^[0-9a-f]{18}$/);
    expect(stored!.key).toBe(`deletion:${code}`);
    expect(await getDeletionRequest(code)).toMatchObject({ status: "received", userId: "fb-user-1" });
    expect(await getDeletionRequest("not-a-code")).toBeNull();
    expect(await markDeletionCompleted(code)).toBe(true);
    expect(await getDeletionRequest(code)).toMatchObject({ status: "completed" });
    stored = null;
    expect(await markDeletionCompleted("0".repeat(18))).toBe(false);
  });
});

describe("F18 security headers", () => {
  it("sets frame protections and no-store on the API, and the CSP is built by the proxy helper", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!.headers;
    expect(all.find((h) => h.key === "X-Frame-Options")!.value).toBe("DENY");
    expect(rules.find((r) => r.source === "/api/:path*")!.headers).toContainEqual({ key: "Cache-Control", value: "no-store" });
    const { buildLegacyCsp, buildCsp } = await import("@/lib/security/csp");
    for (const csp of [buildLegacyCsp(), buildCsp("nonce123")]) {
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("https://connect.facebook.net");
      expect(csp).toContain("https://checkout.razorpay.com");
      expect(csp).toContain("form-action 'self'");
    }
  });
});

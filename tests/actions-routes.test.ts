import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeActionsDb } from "./helpers/fake-actions-db";

/**
 * docs/EDDY-SPEC.md 4.3 G7, 4.5, 7.8, 8.4, EDDY-08: the card endpoints (GET /api/actions/[id] and POST confirm, cancel,
 * revise, refresh, undo) through the real route handlers, the real getActor (paywall exemption for /api/actions/), the real
 * action layer and its default ports, on the fake database; and the actions.reconcile queue handler.
 */

process.env.SESSION_SECRET = "x".repeat(40);
process.env.EMAIL_VERIFICATION_REQUIRED = "false";
process.env.SITE_URL = "https://wa.test";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeActionsDb,
  locked: false,
  enqueue: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/lib/db", async () => {
  const { createFakeActionsDb } = await import("./helpers/fake-actions-db");
  h.db = createFakeActionsDb();
  return { prisma: h.db.prisma };
});
// No card route may reach the model: loading the SDK fails the request.
vi.mock("@anthropic-ai/sdk", () => {
  throw new Error("The card endpoints must never load the model SDK.");
});
// The paywall: a locked workspace refuses writes with 402 (getActor and gate G7 both read this).
vi.mock("@/lib/billing", async () => {
  const { HttpError } = await import("@/lib/tenancy");
  return {
    assertTenantCanWrite: vi.fn(async () => {
      if (h.locked) throw new HttpError(402, "Your plan has ended. Renew it to make changes.");
    }),
  };
});
vi.mock("@/lib/queue", () => {
  h.enqueue = vi.fn(async () => undefined);
  return { enqueue: h.enqueue, runDueJobs: vi.fn(async () => 0) };
});
vi.mock("@/lib/ads/audit", () => ({ auditStrict: vi.fn(async () => undefined), auditOutcome: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { GET as getCardRoute } from "@/app/api/actions/[id]/route";
import { POST as cancelRoute } from "@/app/api/actions/[id]/cancel/route";
import { POST as confirmRoute } from "@/app/api/actions/[id]/confirm/route";
import { POST as refreshRoute } from "@/app/api/actions/[id]/refresh/route";
import { POST as reviseRoute } from "@/app/api/actions/[id]/revise/route";
import { POST as undoRoute } from "@/app/api/actions/[id]/undo/route";
import { auditOutcome, auditStrict } from "@/lib/ads/audit";
import { CARD_ROUTE_PER_MIN, cardStateOf, resetCardRouteLimiter } from "@/lib/actions/card-http";
import { proposeAction, resetInvokeState } from "@/lib/actions/invoke";
import { clearPrincipalMemo, eddyPrincipal } from "@/lib/actions/principal";
import {
  NO_MESSAGE_GRACE_MS,
  RECONCILE_PRINCIPAL,
  RECONCILE_QUEUE,
  ReconcileRetryLater,
  handleActionsReconcile,
  parseReconcilePayload,
  reconcileQueues,
  registerReconcileProbe,
  resetReconcileProbes,
} from "@/lib/actions/reconcile";
import { registerActions, resetRegistry, type ActionDefinition } from "@/lib/actions/registry";
import type { PendingCardDTO } from "@/lib/eddy/contract";
import { getActor } from "@/lib/auth";
import { signAccessToken } from "@/lib/auth/tokens";
import { ADMIN, AGENT, OWNER, T1, basePreview, pauseDef, resumeDef, seedMembers, sendDef, setRole, sortDefs, tagDef, testDeps } from "./helpers/action-fixtures";

// ===== Harness =====

const ORIGIN = "https://wa.test";
type Who = { userId: string; tenantId: string; role: "agent" | "admin" | "owner" };
const tokenFor = (who: Who) => signAccessToken({ sub: who.userId, tid: who.tenantId, role: who.role });

function req(method: "GET" | "POST", url: string, o: { who?: Who | null; origin?: string | null; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  const who = o.who === undefined ? AGENT : o.who;
  if (who) headers.authorization = `Bearer ${tokenFor(who)}`;
  if (o.origin !== null && (o.origin !== undefined || method === "POST")) headers.origin = o.origin ?? ORIGIN;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${url}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

type Json = Record<string, unknown> & { status?: number; state?: string; code?: string; card?: PendingCardDTO };
async function call(route: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>, op: string, id: string, body: unknown, o: { who?: Who | null; origin?: string | null } = {}) {
  const res = await route(req("POST", `/api/actions/${encodeURIComponent(id)}/${op}`, { ...o, body }), ctx(id));
  return { http: res.status, json: (await res.json()) as Json, headers: res.headers };
}
const confirm = (c: PendingCardDTO, o: { who?: Who | null; origin?: string | null } = {}) => call(confirmRoute, "confirm", c.actionId, { nonce: c.nonce, previewHash: c.previewHash }, o);

const eddy = (who: Who = AGENT, turnId = `turn_${Math.random().toString(36).slice(2, 8)}`) => eddyPrincipal({ actor: who, emailVerified: true, conversationId: "cv_eddy", lang: "en", turnId });

/** A card made the way a turn makes it (proposeAction with the test ports); the routes then use the real default ports. */
async function propose(name: string, args: Record<string, unknown>, who: Who = AGENT): Promise<PendingCardDTO> {
  const out = await proposeAction(eddy(who), name, args, {}, testDeps());
  if (!out.card) throw new Error(`no card: ${JSON.stringify(out.model)}`);
  return out.card;
}

const record = (id: string) => h.db.rows("actionRecord").find((r) => r.id === id)!;

/** A confirm-class lowering action (stop, cancel): skips the paywall at G7 (4.3, Phase 0 4.17). */
function stopDef(over: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: "stop_fixture",
    version: "v1",
    area: "spend",
    surfaces: ["eddy"],
    titleKey: "status.stop_spending",
    description: "Stops spending.",
    inputSchema: { type: "object", properties: { level: { type: "string", enum: ["assistants", "all"] } }, required: ["level"], additionalProperties: false },
    minRole: "admin",
    route: { method: "PUT", path: "/api/workspace/freeze" },
    effects: { writes: true, lowersActivity: true, irreversible: true },
    untrustedPaths: [],
    authorize: vi.fn(async () => undefined),
    preview: vi.fn(async () => basePreview({ titleKey: "card.stop_spending.title", confirmLabelKey: "card.stop_spending.confirm", danger: true, warnings: ["irreversible"], material: { targetId: "freeze" } })),
    run: vi.fn(async () => ({ result: { stopped: true }, auditTarget: "freeze" })),
    forModel: (r: unknown) => r,
    ...over,
  } as ActionDefinition;
}

/** A plain reply card that needs no WhatsApp check (the default ports would look for a number otherwise). */
const replyDef = (over: Partial<ActionDefinition> = {}) => sendDef({ needsWhatsApp: false, callsMeta: false, ...over });

let defs: { send: ActionDefinition; stop: ActionDefinition; tag: ActionDefinition; pause: ActionDefinition; resume: ActionDefinition };
/** Replaces one fixture (registered definitions are frozen) and registers the set again. */
function swap(key: keyof typeof defs, def: ActionDefinition) {
  defs[key] = def;
  resetRegistry();
  registerActions(sortDefs(Object.values(defs)));
}

function registerAll() {
  defs = { send: replyDef(), stop: stopDef(), tag: tagDef(), pause: pauseDef(), resume: resumeDef() };
  resetRegistry();
  registerActions(sortDefs(Object.values(defs)));
}

const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
  throw new Error("No network call is allowed from the card endpoints.");
});
afterAll(() => fetchSpy.mockRestore());

beforeEach(async () => {
  h.db.reset();
  seedMembers(h.db);
  h.locked = false;
  vi.clearAllMocks();
  resetInvokeState();
  clearPrincipalMemo();
  resetReconcileProbes();
  await resetCardRouteLimiter();
  registerAll();
});

// ===== Session, origin and limiter (EDDY-08 acceptance 1) =====

describe("every card route: getActor, same origin and the 30-a-minute limiter", () => {
  const POSTS = [
    ["confirm", confirmRoute],
    ["cancel", cancelRoute],
    ["revise", reviseRoute],
    ["refresh", refreshRoute],
    ["undo", undoRoute],
  ] as const;

  it.each(POSTS)("%s needs a signed-in session (401) and a same-origin request (403)", async (op, route) => {
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Hi" });
    const body = { nonce: c.nonce, previewHash: c.previewHash, edits: { text: "Hello" } };
    const anon = await call(route, op, c.actionId, body, { who: null });
    expect(anon.http).toBe(401);
    expect(anon.json).toMatchObject({ state: "refused", code: "signed_out" });
    for (const origin of [null, "https://evil.example", "https://wa.test.evil.example"]) {
      const cross = await call(route, op, c.actionId, body, { origin });
      expect(cross.http, String(origin)).toBe(403);
      expect(cross.json).toMatchObject({ code: "forbidden", message: "This request could not be verified. Reload the page and try again." });
    }
    expect(record(c.actionId).status).toBe("pending");
    expect(defs.send.run).not.toHaveBeenCalled();
    expect(anon.headers.get("cache-control")).toBe("no-store");
  });

  it("an API key is never accepted, only a browser session", async () => {
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Hi" });
    const res = await confirmRoute(new Request(`${ORIGIN}/api/actions/${c.actionId}/confirm`, { method: "POST", headers: { authorization: "Bearer wak_live_abc", origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ nonce: c.nonce, previewHash: c.previewHash }) }), ctx(c.actionId));
    expect(res.status).toBe(401);
    expect(defs.send.run).not.toHaveBeenCalled();
  });

  it("allows 30 card calls a minute per member, then answers 429, and counts each member separately", async () => {
    expect(CARD_ROUTE_PER_MIN).toBe(30);
    for (let i = 0; i < 30; i++) expect((await call(cancelRoute, "cancel", "ar_missing", { nonce: "x" })).http).toBe(404);
    const limited = await call(cancelRoute, "cancel", "ar_missing", { nonce: "x" });
    expect(limited.http).toBe(429);
    expect(limited.json).toMatchObject({ code: "rate_limited" });
    // Confirm shares the same budget.
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Hi" });
    expect((await confirm(c)).http).toBe(429);
    expect(defs.send.run).not.toHaveBeenCalled();
    // Another member is not affected.
    expect((await call(cancelRoute, "cancel", "ar_missing", { nonce: "x" }, { who: ADMIN })).http).toBe(404);
  });

  it("GET reads the member's own card without the nonce; a cross-origin GET is refused; reads have their own budget", async () => {
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Hi" });
    const res = await getCardRoute(req("GET", `/api/actions/${c.actionId}`, { origin: null }), ctx(c.actionId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { card: Record<string, unknown> };
    expect(body.card).toMatchObject({ actionId: c.actionId, action: "send_fixture", state: "pending", previewHash: c.previewHash });
    expect(JSON.stringify(body)).not.toContain(c.nonce);
    expect(JSON.stringify(body)).not.toContain("nonceHash");
    expect((await getCardRoute(req("GET", `/api/actions/${c.actionId}`, { origin: "https://evil.example" }), ctx(c.actionId))).status).toBe(403);
    expect((await getCardRoute(req("GET", `/api/actions/${c.actionId}`, { who: ADMIN }), ctx(c.actionId))).status).toBe(404);
    expect((await getCardRoute(req("GET", `/api/actions/${c.actionId}`, { who: { ...AGENT, tenantId: "t_other" } }), ctx(c.actionId))).status).toBe(401);
    expect((await getCardRoute(req("GET", "/api/actions/ar_missing"), ctx("ar_missing"))).status).toBe(404);
    for (let i = 0; i < 30; i++) await getCardRoute(req("GET", "/api/actions/ar_missing"), ctx("ar_missing"));
    expect((await getCardRoute(req("GET", "/api/actions/ar_missing"), ctx("ar_missing"))).status).toBe(429);
  });

  it("maps every record status to the state the card shows (8.4)", () => {
    const now = new Date("2026-10-28T10:00:00Z");
    const row = (status: string, extra: Record<string, unknown> = {}) => ({ status, expiresAt: new Date(now.getTime() + 60_000), undoneAt: null, error: null, ...extra }) as Parameters<typeof cardStateOf>[0];
    expect(cardStateOf(row("pending"), now)).toBe("pending");
    expect(cardStateOf(row("pending", { expiresAt: new Date(now.getTime() - 1) }), now)).toBe("expired");
    expect(cardStateOf(row("superseded"), now)).toBe("changed");
    expect(cardStateOf(row("done", { undoneAt: now }), now)).toBe("undone");
    expect(cardStateOf(row("refused", { error: "spend_frozen" }), now)).toBe("spend_frozen");
    expect(cardStateOf(row("refused", { error: "role" }), now)).toBe("refused");
    for (const s of ["running", "failed", "cancelled", "expired", "unknown", "awaiting_approval", "undone"]) expect(cardStateOf(row(s), now)).toBe(s);
  });
});

// ===== Claim, 404 / 410 / 409 / 403 (EDDY-08 acceptance 2) =====

describe("confirm through the route", () => {
  it("two concurrent confirms with one nonce run the action exactly once", async () => {
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Your order ships tomorrow." });
    const [a, b] = await Promise.all([confirm(c), confirm(c)]);
    expect([a.http, b.http].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.http === 409)!.json).toMatchObject({ code: "already_decided" });
    expect([a, b].find((r) => r.http === 200)!.json).toMatchObject({ state: "done", actionId: c.actionId });
    expect(defs.send.run).toHaveBeenCalledTimes(1);
    expect(record(c.actionId)).toMatchObject({ status: "done" });
    // Every transition is on record: the request before it ran, the outcome after (G17, G19).
    expect(auditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "eddy.send_fixture", meta: expect.objectContaining({ stage: "requested", confirmedBy: AGENT.userId }) }));
    expect(auditOutcome).toHaveBeenCalledWith(expect.objectContaining({ action: "eddy.send_fixture", meta: expect.objectContaining({ stage: "done" }) }));
    expect(h.db.rows("actionInvocation").filter((r) => r.actionRecordId === c.actionId).map((r) => `${r.stage}:${r.outcome}`)).toEqual(["preview:needs_confirmation", "execute:started", "execute:ok"]);
  });

  it("a wrong nonce, previewHash, member, workspace or id is 404 and runs nothing", async () => {
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Hi" });
    expect((await call(confirmRoute, "confirm", c.actionId, { nonce: "x".repeat(43), previewHash: c.previewHash })).http).toBe(404);
    expect((await call(confirmRoute, "confirm", c.actionId, { nonce: c.nonce, previewHash: "0".repeat(64) })).http).toBe(404);
    expect((await call(confirmRoute, "confirm", c.actionId, { previewHash: c.previewHash })).http).toBe(404);
    expect((await confirm(c, { who: ADMIN })).http).toBe(404);
    h.db.insert("membership", { id: "m_x", tenantId: "t2", userId: AGENT.userId, role: "agent", user: { disabledAt: null, emailVerifiedAt: new Date(), name: "Asha" }, tenant: { deletedAt: null } });
    expect((await confirm(c, { who: { ...AGENT, tenantId: "t2" } })).http).toBe(404);
    expect((await confirm({ ...c, actionId: "ar_missing" })).http).toBe(404);
    expect((await confirm({ ...c, actionId: "../../x" })).json).toMatchObject({ code: "not_found" });
    const bad = await confirmRoute(new Request(`${ORIGIN}/api/actions/${c.actionId}/confirm`, { method: "POST", headers: { authorization: `Bearer ${tokenFor(AGENT)}`, origin: ORIGIN, "content-type": "application/json" }, body: "{not json" }), ctx(c.actionId));
    expect(bad.status).toBe(404);
    expect(defs.send.run).not.toHaveBeenCalled();
    expect(record(c.actionId).status).toBe("pending");
    expect((await confirm(c)).http).toBe(200);
  });

  it("an expired card is 410 and is marked expired; Refresh preview makes a new card with no model call", async () => {
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Hi" });
    record(c.actionId).expiresAt = new Date(Date.now() - 1000);
    const res = await confirm(c);
    expect(res.http).toBe(410);
    expect(res.json).toMatchObject({ state: "expired", code: "expired" });
    expect(record(c.actionId).status).toBe("expired");
    expect((await call(cancelRoute, "cancel", c.actionId, { nonce: c.nonce })).http).toBe(410);
    const fresh = await call(refreshRoute, "refresh", c.actionId, {});
    expect(fresh.http).toBe(200);
    expect(fresh.json.card).toMatchObject({ action: "send_fixture", state: "pending", supersedes: c.actionId });
    expect(record(c.actionId)).toMatchObject({ status: "expired", supersededById: fresh.json.card!.actionId });
    expect(defs.send.preview).toHaveBeenCalledTimes(2);
    expect(defs.send.run).not.toHaveBeenCalled();
    // A card still open is not refreshed; another member's card is not found.
    expect((await call(refreshRoute, "refresh", fresh.json.card!.actionId, {})).json).toMatchObject({ code: "not_expired" });
    expect((await call(refreshRoute, "refresh", fresh.json.card!.actionId, {}, { who: ADMIN })).http).toBe(404);
    expect((await confirm(fresh.json.card!)).http).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a change in the material is 409 with a new card, which then confirms", async () => {
    let count = 120;
    swap("resume", resumeDef({ preview: vi.fn(async () => basePreview({ titleKey: "card.resume", material: { targetId: "b1", count } })) }));
    const c = await propose("resume_fixture", { broadcastId: "b1" }, ADMIN);
    count = 140;
    const changed = await confirm(c, { who: ADMIN });
    expect(changed.http).toBe(409);
    expect(changed.json).toMatchObject({ state: "changed", code: "changed" });
    expect(changed.json.card).toMatchObject({ supersedes: c.actionId, state: "pending" });
    expect(record(c.actionId)).toMatchObject({ status: "superseded" });
    expect(defs.resume.run).not.toHaveBeenCalled();
    expect((await confirm(changed.json.card!, { who: ADMIN })).http).toBe(200);
    expect(defs.resume.run).toHaveBeenCalledTimes(1);
  });

  it("a member demoted since the preview gets 403 and nothing runs", async () => {
    const c = await propose("resume_fixture", { broadcastId: "b1" }, ADMIN);
    setRole(h.db, ADMIN.userId, "agent");
    const res = await confirm(c, { who: { ...ADMIN, role: "agent" } });
    expect(res.http).toBe(403);
    expect(res.json).toMatchObject({ state: "refused", code: "role" });
    expect(record(c.actionId)).toMatchObject({ status: "refused", error: "role" });
    expect(defs.resume.run).not.toHaveBeenCalled();
  });

  it("an ambiguous outcome is 202 unknown: never retried, and one reconcile job is queued", async () => {
    swap(
      "send",
      replyDef({
        run: vi.fn(async () => {
          throw Object.assign(new Error("socket hang up"), { name: "GraphError", status: 503, ambiguous: true });
        }),
      }),
    );
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Hi" });
    const res = await confirm(c);
    expect(res.http).toBe(202);
    expect(res.json).toMatchObject({ state: "unknown", code: "outcome_unknown" });
    expect(record(c.actionId).status).toBe("unknown");
    expect(h.enqueue).toHaveBeenCalledWith(RECONCILE_QUEUE, { tenantId: T1, actionRecordId: c.actionId, action: "send_fixture" }, { maxAttempts: 5 });
    expect((await confirm(c)).http).toBe(409);
    expect(defs.send.run).toHaveBeenCalledTimes(1);
  });
});

describe("cancel and revise through the route", () => {
  it("cancel closes the card; a confirm after it is 409", async () => {
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Hi" });
    expect((await call(cancelRoute, "cancel", c.actionId, { nonce: "nope" })).http).toBe(404);
    const res = await call(cancelRoute, "cancel", c.actionId, { nonce: c.nonce });
    expect(res.http).toBe(200);
    expect(res.json).toMatchObject({ state: "cancelled" });
    expect(record(c.actionId).status).toBe("cancelled");
    expect((await confirm(c)).http).toBe(409);
    expect(defs.send.run).not.toHaveBeenCalled();
  });

  it("revise accepts only editable fields and returns a new card, with no model call", async () => {
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Hi" });
    expect((await call(reviseRoute, "revise", c.actionId, { nonce: c.nonce, edits: { conversationId: "cv9" } })).json).toMatchObject({ code: "invalid_edit" });
    expect((await call(reviseRoute, "revise", c.actionId, { nonce: c.nonce, edits: ["text"] })).json).toMatchObject({ code: "invalid_edit" });
    expect((await call(reviseRoute, "revise", c.actionId, { nonce: "wrong", edits: { text: "x" } })).http).toBe(404);
    const revised = await call(reviseRoute, "revise", c.actionId, { nonce: c.nonce, edits: { text: "Your order ships on Friday." } });
    expect(revised.http).toBe(200);
    expect(revised.json.card).toMatchObject({ supersedes: c.actionId, preview: { message: { kind: "text", body: "Your order ships on Friday." } } });
    expect(record(c.actionId)).toMatchObject({ status: "superseded", supersededById: revised.json.card!.actionId });
    expect((await confirm(c)).http).toBe(409);
    expect((await confirm(revised.json.card!)).http).toBe(200);
    expect(defs.send.run).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("confirm, revise and refresh work with the AI limit used up: none of them imports or calls the model", () => {
    const files = [
      "src/lib/actions/card-http.ts",
      "src/lib/actions/invoke.ts",
      "src/app/api/actions/[id]/route.ts",
      "src/app/api/actions/[id]/confirm/route.ts",
      "src/app/api/actions/[id]/revise/route.ts",
      "src/app/api/actions/[id]/refresh/route.ts",
      "src/app/api/actions/[id]/cancel/route.ts",
      "src/app/api/actions/[id]/undo/route.ts",
      "src/lib/actions/reconcile.ts",
    ];
    for (const file of files) {
      const src = readFileSync(path.resolve(__dirname, "..", file), "utf8");
      expect(src, file).not.toMatch(/from "@anthropic-ai\/sdk"|@\/lib\/spend\/exec\/ai|@\/lib\/eddy\/(loop|request|metering|model)|api\.anthropic\.com|aiAllowance\(/);
    }
  });
});

// ===== The paywall per action (EDDY-08 acceptance 6) =====

describe("a locked workspace: /api/actions/ skips getActor's paywall and gate G7 applies it per action", () => {
  it("getActor still refuses other writes in a locked workspace (the exemption is only for card routes)", async () => {
    h.locked = true;
    await expect(getActor(req("POST", "/api/contacts", { body: {} }))).rejects.toMatchObject({ status: 402 });
    await expect(getActor(req("POST", "/api/actions/ar_1/confirm", { body: {} }))).resolves.toMatchObject({ userId: AGENT.userId });
    const authSource = readFileSync(path.resolve(__dirname, "../src/lib/auth/index.ts"), "utf8");
    expect(authSource).toMatch(/PAYWALL_EXEMPT_PREFIXES = \[[^\]]*"\/api\/actions\/"/);
  });

  it("a lowering card confirms in a locked workspace", async () => {
    const c = await propose("stop_fixture", { level: "all" }, ADMIN);
    h.locked = true;
    const res = await confirm(c, { who: ADMIN });
    expect(res.http).toBe(200);
    expect(res.json).toMatchObject({ state: "done" });
    expect(defs.stop.run).toHaveBeenCalledTimes(1);
  });

  it("any other card gets 402 and nothing runs", async () => {
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Hi" });
    h.locked = true;
    const res = await confirm(c);
    expect(res.http).toBe(402);
    expect(res.json).toMatchObject({ state: "refused", code: "workspace_locked" });
    expect(record(c.actionId)).toMatchObject({ status: "refused", error: "workspace_locked" });
    expect(defs.send.run).not.toHaveBeenCalled();
  });

  it("cancel still works in a locked workspace; an undo (a raise) gets 402", async () => {
    const c = await propose("send_fixture", { conversationId: "cv1", text: "Hi" });
    const tagged = await proposeAction(eddy(), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, testDeps());
    h.locked = true;
    expect((await call(cancelRoute, "cancel", c.actionId, { nonce: c.nonce })).http).toBe(200);
    const undo = await call(undoRoute, "undo", tagged.actionId!, {});
    expect(undo.http).toBe(402);
    expect(undo.json).toMatchObject({ code: "workspace_locked" });
    expect(defs.tag.undo!.inverse).not.toHaveBeenCalled();
  });
});

// ===== Undo through the route =====

describe("undo through the route", () => {
  async function tagged(who: Who = AGENT) {
    const out = await proposeAction(eddy(who), "tag_fixture", { conversationId: "cv1", tag: "vip" }, {}, testDeps());
    expect(out.model).toMatchObject({ status: "done", undoAvailable: true });
    return out.actionId!;
  }

  it("undoes once within the window; a second undo is 409; after the window it is 410", async () => {
    const id = await tagged();
    const first = await call(undoRoute, "undo", id, {});
    expect(first.http).toBe(200);
    expect(first.json).toMatchObject({ state: "undone", actionId: id });
    expect(defs.tag.undo!.inverse).toHaveBeenCalledTimes(1);
    expect((await call(undoRoute, "undo", id, {})).json).toMatchObject({ code: "already_undone" });
    const late = await tagged();
    record(late).undoUntil = new Date(Date.now() - 1);
    const res = await call(undoRoute, "undo", late, {});
    expect(res.http).toBe(410);
    expect(res.json).toMatchObject({ code: "undo_expired" });
  });

  it("someone else's change since is 409 with the conflict sentence; another member's action is 404", async () => {
    const id = await tagged();
    (defs.tag.undo!.stillApplies as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const res = await call(undoRoute, "undo", id, {});
    expect(res.http).toBe(409);
    expect(res.json).toMatchObject({ code: "undo_changed", message: "Someone changed it since, so it was not undone." });
    h.db.insert("membership", { id: "m_u2", tenantId: T1, userId: "u_agent2", role: "agent", user: { disabledAt: null, emailVerifiedAt: new Date(), name: "Ravi" }, tenant: { deletedAt: null } });
    expect((await call(undoRoute, "undo", id, {}, { who: { userId: "u_agent2", tenantId: T1, role: "agent" } })).http).toBe(404);
    // An admin may undo it, as themselves.
    expect((await call(undoRoute, "undo", id, {}, { who: OWNER })).json).toMatchObject({ state: "undone" });
  });

  it("an inverse that would spend comes back as a card instead of running", async () => {
    const out = await proposeAction(eddy(ADMIN), "pause_fixture", { broadcastId: "b1" }, {}, testDeps());
    const res = await call(undoRoute, "undo", out.actionId!, {}, { who: ADMIN });
    expect(res.http).toBe(200);
    expect(res.json.card).toMatchObject({ action: "resume_fixture", state: "pending" });
    expect(defs.pause.undo!.inverse).not.toHaveBeenCalled();
    expect(defs.resume.run).not.toHaveBeenCalled();
  });
});

// ===== actions.reconcile (EDDY-08 acceptance 4) =====

describe("the actions.reconcile handler settles unknown rows from the real state and never re-sends", () => {
  const TAP = new Date("2026-10-28T10:00:00Z");
  const later = (ms: number) => new Date(TAP.getTime() + ms);
  const deps = (ms = 60_000) => ({ clock: () => later(ms), auditOutcome: vi.fn(async () => undefined), notify: vi.fn(async () => undefined) });
  const LAST = { attempt: 5, maxAttempts: 5, isLastAttempt: true };
  const EARLY = { attempt: 1, maxAttempts: 5, isLastAttempt: false };

  function unknownRow(action: string, args: Record<string, unknown>, id = "ar_u1") {
    return h.db.insert("actionRecord", { id, tenantId: T1, userId: AGENT.userId, via: "eddy", principalId: `eddy:${AGENT.userId}:cv_eddy`, conversationId: "cv_eddy", action, risk: "confirm", status: "unknown", args, argsHash: "a".repeat(64), decidedAt: TAP, createdAt: TAP, updatedAt: TAP });
  }
  const message = (over: Record<string, unknown> = {}) =>
    h.db.insert("message", { id: "msg1", tenantId: T1, conversationId: "cv1", direction: "outbound", origin: "eddy", sentByUserId: AGENT.userId, body: "Hi", wamid: "wamid.1", status: "delivered", errorCode: null, createdAt: later(500), ...over });

  // The real send path, registered under the real name: the handler must never call it.
  beforeEach(() => {
    swap("send", replyDef({ name: "send_text_reply" }));
  });

  it("a delivered message settles the record as done, writes the outcome audit, the invocation row and a notice", async () => {
    unknownRow("send_text_reply", { conversationId: "cv1", text: "Hi" });
    message();
    const d = deps();
    const out = await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_u1", action: "send_text_reply" }, EARLY, d);
    expect(out).toEqual({ outcome: "done", actionId: "ar_u1", code: null });
    expect(record("ar_u1")).toMatchObject({ status: "done", result: { reconciled: true, messageId: "msg1", status: "delivered" } });
    expect(d.auditOutcome).toHaveBeenCalledWith(expect.objectContaining({ action: "eddy.send_text_reply", target: "ar_u1", meta: expect.objectContaining({ stage: "done", reconciledBy: RECONCILE_PRINCIPAL }) }));
    expect(h.db.rows("actionInvocation").at(-1)).toMatchObject({ via: "system", principalId: RECONCILE_PRINCIPAL, stage: "execute", outcome: "ok", code: "reconciled", actionRecordId: "ar_u1" });
    expect(d.notify).toHaveBeenCalledWith({ tenantId: T1, userId: AGENT.userId, actionId: "ar_u1", action: "send_text_reply", outcome: "done", code: null });
    expect(defs.send.run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a failed message settles as failed with its WhatsApp code", async () => {
    unknownRow("send_text_reply", { conversationId: "cv1", text: "Hi" });
    message({ status: "failed", wamid: null, errorCode: "131047" });
    expect(await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_u1" }, EARLY, deps())).toEqual({ outcome: "failed", actionId: "ar_u1", code: "wa_131047" });
    expect(record("ar_u1")).toMatchObject({ status: "failed", error: "wa_131047" });
  });

  it("a message still queued is checked again later; on the last attempt the record stays unknown and the member is told", async () => {
    unknownRow("send_text_reply", { conversationId: "cv1", text: "Hi" });
    message({ status: "queued", wamid: null });
    await expect(handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_u1" }, EARLY, deps())).rejects.toBeInstanceOf(ReconcileRetryLater);
    expect(record("ar_u1").status).toBe("unknown");
    const d = deps();
    expect(await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_u1" }, LAST, d)).toEqual({ outcome: "unresolved", actionId: "ar_u1" });
    expect(record("ar_u1").status).toBe("unknown");
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unresolved" }));
    expect(h.db.rows("actionInvocation").at(-1)).toMatchObject({ outcome: "unknown", code: "reconcile_gave_up" });
    expect(defs.send.run).not.toHaveBeenCalled();
  });

  it("no message after the grace period means nothing reached Meta: failed, and it is not sent again", async () => {
    unknownRow("send_text_reply", { conversationId: "cv1", text: "Hi" });
    await expect(handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_u1" }, EARLY, deps(NO_MESSAGE_GRACE_MS - 1))).rejects.toBeInstanceOf(ReconcileRetryLater);
    expect(await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_u1" }, EARLY, deps(NO_MESSAGE_GRACE_MS))).toEqual({ outcome: "failed", actionId: "ar_u1", code: "not_sent" });
    expect(h.db.rows("message")).toEqual([]);
    expect(defs.send.run).not.toHaveBeenCalled();
  });

  it("a message from another member, another chat or before the tap is not taken as this send", async () => {
    unknownRow("send_text_reply", { conversationId: "cv1", text: "Hi" });
    message({ id: "m_other_user", sentByUserId: ADMIN.userId });
    message({ id: "m_other_chat", conversationId: "cv2" });
    message({ id: "m_before", createdAt: new Date(TAP.getTime() - 60_000) });
    message({ id: "m_human", origin: "human" });
    expect(await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_u1" }, LAST, deps(NO_MESSAGE_GRACE_MS))).toMatchObject({ outcome: "failed", code: "not_sent" });
  });

  it("templates and broadcasts settle from their status", async () => {
    h.db.insert("template", { id: "tp1", tenantId: T1, status: "pending", metaTemplateId: "m1" });
    unknownRow("submit_template", { templateId: "tp1" }, "ar_t1");
    expect(await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_t1" }, EARLY, deps())).toMatchObject({ outcome: "done" });
    h.db.insert("template", { id: "tp2", tenantId: T1, status: "draft", metaTemplateId: null });
    unknownRow("submit_template", { templateId: "tp2" }, "ar_t2");
    await expect(handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_t2" }, EARLY, deps())).rejects.toBeInstanceOf(ReconcileRetryLater);
    unknownRow("delete_template", { templateId: "tp_gone" }, "ar_t3");
    expect(await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_t3" }, EARLY, deps())).toMatchObject({ outcome: "done" });
    h.db.insert("broadcast", { id: "b1", tenantId: T1, status: "canceled" });
    unknownRow("cancel_broadcast", { broadcastId: "b1" }, "ar_b1");
    expect(await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_b1" }, EARLY, deps())).toMatchObject({ outcome: "done" });
    h.db.insert("broadcast", { id: "b2", tenantId: T1, status: "completed" });
    unknownRow("pause_broadcast", { broadcastId: "b2" }, "ar_b2");
    expect(await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_b2" }, EARLY, deps())).toEqual({ outcome: "failed", actionId: "ar_b2", code: "broadcast_completed" });
  });

  it("two jobs for one record settle it once", async () => {
    unknownRow("send_text_reply", { conversationId: "cv1", text: "Hi" });
    message();
    const [a, b] = await Promise.all([handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_u1" }, EARLY, deps()), handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_u1" }, EARLY, deps())]);
    expect([a.outcome, b.outcome].sort()).toEqual(["done", "skipped"]);
    expect(h.db.rows("actionInvocation").filter((r) => r.code === "reconciled")).toHaveLength(1);
  });

  it("skips bad payloads, other workspaces, rows that are not unknown and actions with no probe", async () => {
    expect(parseReconcilePayload({ tenantId: T1 })).toBeNull();
    expect(await handleActionsReconcile("nope", EARLY, deps())).toEqual({ outcome: "skipped", reason: "invalid_payload" });
    unknownRow("send_text_reply", { conversationId: "cv1", text: "Hi" });
    expect(await handleActionsReconcile({ tenantId: "t_other", actionRecordId: "ar_u1" }, EARLY, deps())).toEqual({ outcome: "skipped", reason: "not_found" });
    record("ar_u1").status = "done";
    expect(await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_u1" }, EARLY, deps())).toEqual({ outcome: "skipped", reason: "not_unknown" });
    unknownRow("mystery_action", {}, "ar_m1");
    expect(await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_m1" }, LAST, deps())).toEqual({ outcome: "skipped", reason: "no_probe" });
    expect(record("ar_m1").status).toBe("unknown");
    registerReconcileProbe("mystery_action", async () => ({ state: "done" }));
    expect(await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_m1" }, LAST, deps())).toMatchObject({ outcome: "done" });
    expect(() => registerReconcileProbe("Bad Name", async () => ({ state: "done" }))).toThrow();
  });

  it("the default notifier writes one notice per action with ids and codes only", async () => {
    unknownRow("send_text_reply", { conversationId: "cv1", text: "Hi, your secret code is 4421" });
    message({ body: "Hi, your secret code is 4421" });
    await handleActionsReconcile({ tenantId: T1, actionRecordId: "ar_u1" }, EARLY, { clock: () => later(60_000), auditOutcome: vi.fn(async () => undefined) });
    const notices = h.db.rows("notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ tenantId: T1, dedupeKey: "action:ar_u1", kind: "action_done", audienceUserId: AGENT.userId, source: "eddy" });
    expect(JSON.stringify(notices[0].payload)).not.toContain("4421");
  });

  it("is registered for the actions.reconcile queue, and its module has no send path", () => {
    expect(Object.keys(reconcileQueues)).toEqual(["actions.reconcile"]);
    const src = readFileSync(path.resolve(__dirname, "../src/lib/actions/reconcile.ts"), "utf8");
    expect(src).not.toMatch(/from "@\/lib\/(inbox|broadcasts|templates|graph|whatsapp|campaign)/);
    expect(src).not.toMatch(/\.run\(|proposeAction|confirmAction|graphFetch|fetch\(/);
  });
});

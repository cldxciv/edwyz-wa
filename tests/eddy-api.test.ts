import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeActionsDb } from "./helpers/fake-actions-db";

/**
 * docs/EDDY-SPEC.md 5.11, 5.12, 9.1 tests/eddy-api.test.ts, EDDY-11: the Eddy HTTP API through the real route handlers,
 * the real getActor (signed session tokens, the unverified-write list), the real status gate, loop, store and settings on
 * the in-memory database. The spend bridge, billing, team visibility and setup are faked at their module boundary, and the
 * model is the scripted fake (no Anthropic call). Covers: SSE framing and headers, the 15 s keepalive and the 150 s
 * lifetime (fake timers), 409 while a turn runs, every status state from fixtures (platform_off reasons, a key present but
 * EDDY_ENABLED unset, re-consent after a LEGAL.version bump), the owner-only settings PUT that stores consentVersion, an
 * unverified member chatting while settings stays verified-only, and conversations hidden after a visibilityHash change.
 */

process.env.SESSION_SECRET = "x".repeat(40);
process.env.SITE_URL = "https://wa.test";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeActionsDb,
  locked: false,
  configured: true,
  gatewayFreeze: null as string | null,
  freeze: "none" as "none" | "assistants" | "all",
  demo: false,
  headroom: { usedToday: 0, limitToday: null as number | null, usedMonth: 10, limitMonth: 500 as number | null, leftToday: null as number | null, leftMonth: 490 as number | null },
  rules: { onlyAssigned: false, teamIds: null as string[] | null, includeUnteamed: true, maskPhone: false },
  audit: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/lib/db", async () => {
  const { createFakeActionsDb } = await import("./helpers/fake-actions-db");
  h.db = createFakeActionsDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/billing", async () => {
  const { HttpError } = await import("@/lib/tenancy");
  return {
    assertTenantCanWrite: vi.fn(async () => {
      if (h.locked) throw new HttpError(402, "Your plan has ended. Renew it to make changes.");
    }),
  };
});
vi.mock("@/lib/actions/spend-bridge", () => ({
  isAiConfigured: () => h.configured,
  aiHeadroom: async () => ({ ...h.headroom, todayResetsOn: "2026-10-30", monthResetsOn: "2026-11-01", timezone: "Asia/Kolkata" }),
  aiAllowance: async () => ({ usedToday: 0, limitToday: null, usedMonth: 0, limitMonth: 500, resetsOn: null }),
  freezeState: async () => ({ workspace: h.freeze, platform: "none", effective: h.freeze, frozenAt: null, frozenByKind: null, frozenByUserId: null, reason: null }),
  isDemoWorkspace: async () => h.demo,
  eddyGatewayFreezeCode: async () => h.gatewayFreeze,
  modelPrice: () => ({ input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }),
  localDayStart: () => new Date(0),
  workspaceTimezone: async () => "Asia/Kolkata",
}));
vi.mock("@/lib/teams/visibility", () => ({
  viewerRules: vi.fn(async () => ({ ...h.rules })),
  assertConversationVisible: vi.fn(async () => undefined),
  assertContactVisible: vi.fn(async () => undefined),
}));
vi.mock("@/lib/setup", () => ({ getSetup: vi.fn(async () => ({ steps: [], summary: { done: 2, total: 6, percent: 33, remaining: 4, complete: false, minutesLeft: 20, nextStepId: "template" } })) }));
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn(async () => undefined), runDueJobs: vi.fn(async () => 0) }));
vi.mock("@/lib/ads/audit", () => ({ auditStrict: vi.fn(async () => undefined), auditOutcome: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/audit", () => {
  h.audit = vi.fn(async () => undefined);
  return { audit: h.audit };
});

import { DELETE as deleteOneRoute, GET as getOneRoute } from "@/app/api/eddy/conversations/[id]/route";
import { DELETE as deleteAllRoute, GET as listRoute } from "@/app/api/eddy/conversations/route";
import { GET as getPrefsRoute, PUT as putPrefsRoute } from "@/app/api/eddy/prefs/route";
import { GET as getSettingsRoute, PUT as putSettingsRoute } from "@/app/api/eddy/settings/route";
import { GET as statusRoute } from "@/app/api/eddy/status/route";
import { POST as turnRoute } from "@/app/api/eddy/turn/route";
import { signAccessToken } from "@/lib/auth/tokens";
import { unverifiedMayWrite } from "@/lib/auth/verification";
import type { EddyEvent, EddyStatusDTO } from "@/lib/eddy/contract";
import { resetTurnLimiters, visibilityHashOf } from "@/lib/eddy/conversations";
import { defaultStatusDeps, overrideEddyModelPort } from "@/lib/eddy/model-binding";
import { KEEPALIVE_FRAME, parseSseFrames, sseResponse } from "@/lib/eddy/sse";
import { resetAuthFailure } from "@/lib/eddy/status";
import { LEGAL } from "@/lib/legal";
import { ADMIN, AGENT, OWNER, T1, seedMembers } from "./helpers/action-fixtures";
import { createFakeModel, text, type FakeModel } from "./fixtures/eddy-fake-model";

// ===== Harness =====

const ORIGIN = "https://wa.test";
type Who = { userId: string; tenantId: string; role: "agent" | "admin" | "owner" };

function req(method: string, url: string, o: { who?: Who | null; origin?: string | null; body?: unknown; signal?: AbortSignal } = {}): Request {
  const headers: Record<string, string> = {};
  const who = o.who === undefined ? AGENT : o.who;
  if (who) headers.authorization = `Bearer ${signAccessToken({ sub: who.userId, tid: who.tenantId, role: who.role })}`;
  if (o.origin !== null && (o.origin !== undefined || method !== "GET")) headers.origin = o.origin ?? ORIGIN;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${url}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}), ...(o.signal ? { signal: o.signal } : {}) });
}

async function status(who: Who = AGENT): Promise<EddyStatusDTO> {
  const res = await statusRoute(req("GET", "/api/eddy/status", { who }));
  expect(res.status).toBe(200);
  return (await res.json()) as EddyStatusDTO;
}

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

function enableEddy(consentVersion: string = LEGAL.version) {
  h.db.insert("eddyWorkspaceSetting", { tenantId: T1, enabled: true, enabledById: OWNER.userId, enabledAt: new Date(), consentVersion, proactiveNotices: true, dailyTurnCap: null });
}

function seedUsers(verified = true) {
  for (const [who, name] of [
    [AGENT, "Asha"],
    [ADMIN, "Priya"],
    [OWNER, "Omar"],
  ] as const) {
    h.db.insert("user", { id: who.userId, name, emailVerifiedAt: verified ? new Date("2026-01-01T00:00:00Z") : null, disabledAt: null });
  }
}

const turnBody = (t: string, extra: Record<string, unknown> = {}) => ({ text: t, page: { id: "dashboard" }, ...extra });

let model: FakeModel;

// The routes load the action layer, the gateway and the persistence modules once; do it before the clock starts.
beforeAll(async () => {
  await defaultStatusDeps();
}, 60_000);

beforeEach(async () => {
  h.db.reset();
  seedMembers(h.db);
  seedUsers();
  Object.assign(h, { locked: false, configured: true, gatewayFreeze: null, freeze: "none", demo: false });
  h.headroom = { usedToday: 0, limitToday: null, usedMonth: 10, limitMonth: 500, leftToday: null, leftMonth: 490 };
  h.rules = { onlyAssigned: false, teamIds: null, includeUnteamed: true, maskPhone: false };
  h.audit.mockClear();
  process.env.EDDY_ENABLED = "true";
  process.env.EMAIL_VERIFICATION_REQUIRED = "false";
  delete process.env.EDDY_FAKE_MODEL;
  resetAuthFailure();
  await resetTurnLimiters();
  model = createFakeModel([], { fallback: text("Hello from Eddy.") });
  overrideEddyModelPort(model);
});

afterEach(() => {
  overrideEddyModelPort(null);
  vi.useRealTimers();
});

// =====================================================================================================================

describe("GET /api/eddy/status: every 5.11 state from fixtures, with no model call", () => {
  it("platform_off, reason not_configured, with no API key", async () => {
    h.configured = false;
    enableEddy();
    expect(await status()).toMatchObject({ state: "platform_off", reason: "not_configured" });
    expect(model.requests).toHaveLength(0);
  });

  it("a key present with EDDY_ENABLED unset is still platform_off (not_configured): off by default", async () => {
    delete process.env.EDDY_ENABLED;
    enableEddy();
    expect(await status()).toMatchObject({ state: "platform_off", reason: "not_configured" });
    process.env.EDDY_ENABLED = "false";
    expect((await status()).state).toBe("platform_off");
  });

  it("platform_off, reason paused, for the ops kill switch", async () => {
    enableEddy();
    h.db.insert("platformSetting", { key: "eddy:platform", value: { enabled: false, reason: "incident" } });
    expect(await status()).toMatchObject({ state: "platform_off", reason: "paused" });
  });

  it("locked when the plan has ended", async () => {
    enableEddy();
    h.locked = true;
    expect((await status()).state).toBe("locked");
  });

  it("workspace_off until the owner switches it on; only the owner can enable; owner names for the others", async () => {
    const asAgent = await status(AGENT);
    expect(asAgent).toMatchObject({ state: "workspace_off", canEnable: false, ownerNames: ["Omar"] });
    expect((await status(ADMIN)).canEnable).toBe(false);
    expect((await status(OWNER)).canEnable).toBe(true);
  });

  it("workspace_off again after a LEGAL.version bump (re-consent)", async () => {
    enableEddy("0.9");
    expect((await status()).state).toBe("workspace_off");
  });

  it("paused when the gateway would refuse Eddy for a freeze (defensive); a normal freeze is only the banner", async () => {
    enableEddy();
    h.freeze = "all";
    expect(await status()).toMatchObject({ state: "ready", spendingStopped: true });
    h.gatewayFreeze = "spend.frozen";
    expect((await status()).state).toBe("paused");
  });

  it("allowance_used when less is left than the smallest round's hold, with the reset date", async () => {
    enableEddy();
    h.headroom = { usedToday: 0, limitToday: null, usedMonth: 500, limitMonth: 500, leftToday: null, leftMonth: 0 };
    expect(await status()).toMatchObject({ state: "allowance_used", allowance: { usedMonth: 500, limitMonth: 500, resetsOn: "2026-11-01", period: "month" } });
  });

  it("user_capped at the member's daily credit cap", async () => {
    enableEddy();
    h.db.insert("eddyTurn", { id: "x1", tenantId: T1, userId: AGENT.userId, status: "done", startedAt: new Date(), creditsCharged: 40 });
    expect(await status()).toMatchObject({ state: "user_capped", allowance: { memberUsedToday: 40, memberLimitToday: 40 } });
    // Another member is not capped by it.
    expect((await status(ADMIN)).state).toBe("ready");
  });

  it("ready, with readOnly and the 10-credit cap for an unverified member while verification is required", async () => {
    enableEddy();
    h.db.reset();
    seedMembers(h.db, { verified: false });
    seedUsers(false);
    enableEddy();
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    expect(await status()).toMatchObject({ state: "ready", readOnly: true, allowance: { memberLimitToday: 10 } });
    process.env.EMAIL_VERIFICATION_REQUIRED = "false";
    expect(await status()).toMatchObject({ state: "ready", readOnly: false, allowance: { memberLimitToday: 40 } });
  });

  it("carries demo, whatsapp, langPref, needsYou, phase and firstUse", async () => {
    enableEddy();
    h.demo = true;
    h.db.insert("notice", { id: "n1", tenantId: T1, kind: "template_rejected", severity: "action_needed", audienceUserId: null, audienceMinRole: "agent", dedupeKey: "d1", subjectId: "t_1", expiresAt: new Date(Date.now() + 86_400_000), resolvedAt: null, updatedAt: new Date() });
    h.db.insert("notice", { id: "n2", tenantId: T1, kind: "ai_limit_80", severity: "heads_up", audienceUserId: null, audienceMinRole: "admin", dedupeKey: "d2", subjectId: null, expiresAt: new Date(Date.now() + 86_400_000), resolvedAt: null, updatedAt: new Date() });
    h.db.insert("eddyUserPref", { tenantId: T1, userId: AGENT.userId, language: "hinglish", proactive: true, mutedNoticeKinds: [], firstUseAckAt: new Date(), firstUseVersion: LEGAL.version });
    const s = await status(AGENT);
    expect(s).toMatchObject({ state: "ready", demo: true, whatsapp: "none", langPref: "hinglish", needsYou: 1, phase: 1, firstUse: false });
    expect((await status(ADMIN)).needsYou).toBe(2);
    expect((await status(ADMIN)).firstUse).toBe(true);
  });

  it("does not count a Phase 0 row that an Eddy notice already covers, like the Needs you strip", async () => {
    enableEddy();
    const open = { audienceUserId: null, audienceMinRole: "admin", expiresAt: new Date(Date.now() + 86_400_000), resolvedAt: null, updatedAt: new Date() };
    // Phase 0's own "approval waiting" row and Eddy's "approvals waiting" say the same thing: the strip shows one.
    h.db.insert("notice", { id: "p1", tenantId: T1, kind: "approval_waiting", source: "spend", severity: "action_needed", dedupeKey: "spend:a1", subjectType: "approval", subjectId: "a1", ...open });
    h.db.insert("notice", { id: "e1", tenantId: T1, kind: "approvals_waiting", source: "eddy", severity: "action_needed", dedupeKey: "approvals:u", subjectType: null, subjectId: null, ...open });
    expect((await status(ADMIN)).needsYou).toBe(1);
    // Without the Eddy notice, Phase 0's row is the one that counts.
    h.db.rows("notice").splice(h.db.rows("notice").findIndex((r) => r.id === "e1"), 1);
    expect((await status(ADMIN)).needsYou).toBe(1);
    // A Phase 0 row that no Eddy notice covers always counts.
    h.db.insert("notice", { id: "p2", tenantId: T1, kind: "breaker_tripped", source: "spend", severity: "heads_up", dedupeKey: "spend:b1", subjectType: "campaign", subjectId: "c1", ...open });
    expect((await status(ADMIN)).needsYou).toBe(2);
  });

  it("needs a session", async () => {
    expect((await statusRoute(req("GET", "/api/eddy/status", { who: null }))).status).toBe(401);
  });
});

// =====================================================================================================================

describe("POST /api/eddy/turn (5.12)", () => {
  it("streams SSE frames with the no-buffering headers, ending with end", async () => {
    enableEddy();
    const res = await turnRoute(req("POST", "/api/eddy/turn", { body: turnBody("What needs my attention today?") }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-store, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const body = await readAll(res);
    expect(body).toMatch(/^event: turn\ndata: \{"type":"turn"/);
    const events = parseSseFrames(body);
    expect(events.map((e) => e.type)).toEqual(["turn", "delta", "message", "end"]);
    expect(events.find((e) => e.type === "message")).toMatchObject({ text: "Hello from Eddy.", lang: "en" });
    // The turn was recorded and the conversation stored what the member typed.
    expect(h.db.rows("eddyTurn")[0]).toMatchObject({ status: "done", userId: AGENT.userId });
    expect(h.db.rows("eddyMessage").map((m) => m.kind)).toEqual(["user_text", "context_note", "assistant"]);
    // The context note got the setup and the verified page from the server.
    expect(String(h.db.rows("eddyMessage")[1].content)).toContain('setup: { percent: 33, nextStepId: "template" }');
  });

  it("answers 409 while a turn runs", async () => {
    enableEddy();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    model.queue({
      run: async (params, ctx, o) => {
        await gate;
        const { streamScripted } = await import("@/lib/eddy/model-binding");
        return streamScripted(text("Finally."), params, ctx, o, { scenario: "slow", round: 0 });
      },
    });
    const first = await turnRoute(req("POST", "/api/eddy/turn", { body: turnBody("Do the slow thing please") }));
    expect(first.status).toBe(200);
    const second = await turnRoute(req("POST", "/api/eddy/turn", { body: turnBody("Are you done yet?") }));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "Eddy is still answering your last message.", state: "turn_in_progress" });
    release();
    expect(parseSseFrames(await readAll(first)).at(-1)).toMatchObject({ type: "end" });
    // The lock is free again.
    const third = await turnRoute(req("POST", "/api/eddy/turn", { body: turnBody("Are you done yet?") }));
    expect(third.status).toBe(200);
    await readAll(third);
  });

  it("a refusal before the turn is an SSE error event (no model call)", async () => {
    const res = await turnRoute(req("POST", "/api/eddy/turn", { body: turnBody("What needs my attention today?") }));
    expect(res.status).toBe(200);
    expect(parseSseFrames(await readAll(res))).toEqual([
      { type: "error", state: "workspace_off" },
      { type: "end", credits: 0 },
    ]);
    expect(model.requests).toHaveLength(0);
  });

  it("an empty message is 400; another origin is 403; no session is 401", async () => {
    enableEddy();
    expect((await turnRoute(req("POST", "/api/eddy/turn", { body: turnBody("   ") }))).status).toBe(400);
    expect((await turnRoute(req("POST", "/api/eddy/turn", { body: turnBody("hello there"), origin: "https://evil.example" }))).status).toBe(403);
    expect((await turnRoute(req("POST", "/api/eddy/turn", { body: turnBody("hello there"), who: null }))).status).toBe(401);
    expect(model.requests).toHaveLength(0);
  });

  it("request.signal aborts the turn and repairs its tail", async () => {
    enableEddy();
    const controller = new AbortController();
    model.queue({
      run: async (_p, _c, o) => {
        controller.abort();
        await new Promise((r) => setTimeout(r, 1));
        if (o.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        throw new Error("signal not passed");
      },
    });
    const res = await turnRoute(req("POST", "/api/eddy/turn", { body: turnBody("What needs my attention today?"), signal: controller.signal }));
    await readAll(res).catch(() => "");
    await vi.waitFor(() => expect(h.db.rows("eddyTurn")[0].status).toBe("aborted"));
    expect(h.db.rows("eddyMessage").map((m) => m.kind)).toEqual(["user_text", "context_note", "placeholder"]);
  });
});

describe("the SSE transport: keepalive and lifetime (fake timers)", () => {
  it("sends ': ka' every 15 s and aborts the run after 150 s", async () => {
    vi.useFakeTimers();
    let runSignal!: AbortSignal;
    const res = sseResponse(async (emit, signal) => {
      runSignal = signal;
      emit({ type: "status", text: "working" });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      emit({ type: "end", credits: 0 });
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        received += decoder.decode(value);
      }
    })();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(received).not.toContain(KEEPALIVE_FRAME);
    await vi.advanceTimersByTimeAsync(1);
    expect(received.split(KEEPALIVE_FRAME)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000 * 8);
    expect(received.split(KEEPALIVE_FRAME).length - 1).toBe(9);
    expect(runSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(150_000 - 135_000);
    expect(runSignal.aborted).toBe(true);
    await pump;
    expect(parseSseFrames(received).map((e: EddyEvent) => e.type)).toEqual(["status", "end"]);
  });

  it("request.signal aborts the run", async () => {
    const controller = new AbortController();
    let aborted = false;
    const res = sseResponse(
      async (_emit, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        aborted = signal.aborted;
      },
      { signal: controller.signal },
    );
    controller.abort();
    await res.text();
    expect(aborted).toBe(true);
  });
});

// =====================================================================================================================

describe("PUT /api/eddy/settings: owner only (12.1a decision 6)", () => {
  it("the owner switches Eddy on; it stores enabledById, enabledAt and consentVersion = LEGAL.version, audited", async () => {
    const res = await putSettingsRoute(req("PUT", "/api/eddy/settings", { who: OWNER, body: { enabled: true } }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { setting: Record<string, unknown> };
    expect(json.setting).toMatchObject({ enabled: true, enabledById: OWNER.userId, consentVersion: LEGAL.version, consentCurrent: true });
    expect(h.db.rows("eddyWorkspaceSetting")[0]).toMatchObject({ tenantId: T1, enabled: true, enabledById: OWNER.userId, consentVersion: LEGAL.version });
    expect(h.db.rows("eddyWorkspaceSetting")[0].enabledAt).toBeInstanceOf(Date);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "eddy.enabled", tenantId: T1, userId: OWNER.userId, meta: expect.objectContaining({ consentVersion: LEGAL.version }) }));
    expect((await status(AGENT)).state).toBe("ready");
  });

  it("an admin or a team member gets 403", async () => {
    for (const who of [ADMIN, AGENT]) {
      const res = await putSettingsRoute(req("PUT", "/api/eddy/settings", { who, body: { enabled: true } }));
      expect(res.status).toBe(403);
    }
    expect(h.db.rows("eddyWorkspaceSetting")).toHaveLength(0);
  });

  it("refuses another origin, a bad body and an explicit no to the consent", async () => {
    expect((await putSettingsRoute(req("PUT", "/api/eddy/settings", { who: OWNER, body: { enabled: true }, origin: "https://evil.example" }))).status).toBe(403);
    expect((await putSettingsRoute(req("PUT", "/api/eddy/settings", { who: OWNER, body: { enabled: "yes" } }))).status).toBe(400);
    expect((await putSettingsRoute(req("PUT", "/api/eddy/settings", { who: OWNER, body: { enabled: true, consent: false } }))).status).toBe(400);
    expect((await putSettingsRoute(req("PUT", "/api/eddy/settings", { who: OWNER, body: { dailyTurnCap: 0 } }))).status).toBe(400);
  });

  it("the owner can switch it off and set a daily turn cap", async () => {
    enableEddy();
    const res = await putSettingsRoute(req("PUT", "/api/eddy/settings", { who: OWNER, body: { enabled: false, dailyTurnCap: 200 } }));
    expect(await res.json()).toMatchObject({ setting: { enabled: false, dailyTurnCap: 200 } });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "eddy.disabled" }));
  });

  it("the retention period in the copy follows the configured eddyHistoryDays (7.9)", async () => {
    h.db.insert("platformSetting", { key: "retention:config", value: { eddyHistoryDays: 120, actionRecordDays: 45 } });
    expect(await (await getSettingsRoute(req("GET", "/api/eddy/settings", { who: OWNER }))).json()).toMatchObject({ historyDays: 120 });
    expect(await (await deleteAllRoute(req("DELETE", "/api/eddy/conversations", { who: AGENT }))).json()).toMatchObject({ message: "Your chats are deleted now. A record of actions you confirmed is kept for 45 days." });
    h.db.rows("platformSetting")[0].value = { eddyHistoryDays: 5000 };
    expect(await (await getSettingsRoute(req("GET", "/api/eddy/settings", { who: OWNER }))).json()).toMatchObject({ historyDays: 90 });
  });

  it("GET shows the setting and per-member credits to admins, not to team members", async () => {
    enableEddy();
    h.db.insert("eddyTurn", { id: "x1", tenantId: T1, userId: AGENT.userId, status: "done", startedAt: new Date(), creditsCharged: 7 });
    const res = await getSettingsRoute(req("GET", "/api/eddy/settings", { who: ADMIN }));
    expect(await res.json()).toMatchObject({ setting: { enabled: true }, historyDays: 90, usageToday: [{ userId: AGENT.userId, credits: 7 }] });
    expect((await getSettingsRoute(req("GET", "/api/eddy/settings", { who: AGENT }))).status).toBe(403);
  });
});

describe("an unverified member while verification is required (5.11 critic)", () => {
  beforeEach(() => {
    h.db.reset();
    seedMembers(h.db, { verified: false });
    seedUsers(false);
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
  });

  it("can chat, set prefs and delete history, but gets 403 on the settings PUT (even as the owner)", async () => {
    enableEddy();
    const turn = await turnRoute(req("POST", "/api/eddy/turn", { who: AGENT, body: turnBody("What needs my attention today?") }));
    expect(turn.status).toBe(200);
    expect(parseSseFrames(await readAll(turn)).map((e) => e.type)).toContain("message");
    expect((await putPrefsRoute(req("PUT", "/api/eddy/prefs", { who: AGENT, body: { language: "hi" } }))).status).toBe(200);
    expect((await deleteAllRoute(req("DELETE", "/api/eddy/conversations", { who: AGENT }))).status).toBe(200);
    const id = "cv_x";
    expect((await deleteOneRoute(req("DELETE", `/api/eddy/conversations/${id}`, { who: AGENT }), { params: Promise.resolve({ id }) })).status).toBe(404);
    for (const who of [OWNER, ADMIN]) expect((await putSettingsRoute(req("PUT", "/api/eddy/settings", { who, body: { enabled: false } }))).status).toBe(403);
  });

  it("the unverified-write list has exact patterns for turn, prefs and the history DELETE only", () => {
    expect(unverifiedMayWrite("/api/eddy/turn")).toBe(true);
    expect(unverifiedMayWrite("/api/eddy/prefs")).toBe(true);
    expect(unverifiedMayWrite("/api/eddy/conversations")).toBe(true);
    expect(unverifiedMayWrite("/api/eddy/conversations/cv_123")).toBe(true);
    expect(unverifiedMayWrite("/api/eddy/settings")).toBe(false);
    expect(unverifiedMayWrite("/api/eddy/turn/extra")).toBe(false);
    expect(unverifiedMayWrite("/api/eddy/conversations/a/b")).toBe(false);
    expect(unverifiedMayWrite("/api/eddy/status2")).toBe(false);
  });
});

// =====================================================================================================================

describe("PUT /api/eddy/prefs", () => {
  it("accepts auto, en, hi and hinglish, and nothing else", async () => {
    for (const language of ["auto", "en", "hi", "hinglish"]) {
      const res = await putPrefsRoute(req("PUT", "/api/eddy/prefs", { body: { language } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ prefs: { language } });
    }
    for (const language of ["fr", "HI", "", 3]) expect((await putPrefsRoute(req("PUT", "/api/eddy/prefs", { body: { language } }))).status).toBe(400);
    expect(h.db.rows("eddyUserPref")).toHaveLength(1);
  });

  it("records firstUseAckAt and firstUseVersion = LEGAL.version", async () => {
    enableEddy();
    expect((await status()).firstUse).toBe(true);
    const res = await putPrefsRoute(req("PUT", "/api/eddy/prefs", { body: { firstUseAck: true } }));
    expect(await res.json()).toMatchObject({ prefs: { firstUseVersion: LEGAL.version, firstUse: false } });
    expect(h.db.rows("eddyUserPref")[0].firstUseAckAt).toBeInstanceOf(Date);
    expect((await status()).firstUse).toBe(false);
    const got = await getPrefsRoute(req("GET", "/api/eddy/prefs"));
    expect(await got.json()).toMatchObject({ prefs: { language: "auto", firstUse: false } });
  });

  it("needs the same origin", async () => {
    expect((await putPrefsRoute(req("PUT", "/api/eddy/prefs", { body: { language: "hi" }, origin: "https://evil.example" }))).status).toBe(403);
  });
});

// =====================================================================================================================

describe("GET and DELETE /api/eddy/conversations: own only, visibilityHash filter", () => {
  async function chat(who: Who, message: string): Promise<string> {
    const res = await turnRoute(req("POST", "/api/eddy/turn", { who, body: turnBody(message) }));
    const events = parseSseFrames(await readAll(res));
    return (events.find((e) => e.type === "turn") as Extract<EddyEvent, { type: "turn" }>).conversationId;
  }
  const list = async (who: Who = AGENT) => (await (await listRoute(req("GET", "/api/eddy/conversations", { who }))).json()) as { conversations: { id: string; title: string }[]; historyDays: number };
  const one = (id: string, who: Who = AGENT) => getOneRoute(req("GET", `/api/eddy/conversations/${id}`, { who }), { params: Promise.resolve({ id }) });

  it("lists and reads only the member's own conversations", async () => {
    enableEddy();
    const mine = await chat(AGENT, "What needs my attention today?");
    const theirs = await chat(ADMIN, "Show me the spending please");
    const l = await list(AGENT);
    expect(l.conversations.map((c) => c.id)).toEqual([mine]);
    expect(l.conversations[0].title).toBe("What needs my attention today?");
    expect(l.historyDays).toBe(90);
    const read = (await (await one(mine)).json()) as { messages: { role: string; display: { text?: string } }[] };
    expect(read.messages.map((m) => [m.role, m.display.text])).toEqual([
      ["user", "What needs my attention today?"],
      ["assistant", "Hello from Eddy."],
    ]);
    expect((await one(theirs)).status).toBe(404);
  });

  it("hides conversations whose visibilityHash no longer matches (demotion, team change, masking)", async () => {
    enableEddy();
    const id = await chat(AGENT, "What needs my attention today?");
    expect((await list()).conversations).toHaveLength(1);
    h.rules = { onlyAssigned: false, teamIds: ["team_a"], includeUnteamed: false, maskPhone: false };
    expect((await list()).conversations).toHaveLength(0);
    expect((await one(id)).status).toBe(404);
    h.rules = { onlyAssigned: false, teamIds: null, includeUnteamed: true, maskPhone: true };
    expect((await list()).conversations).toHaveLength(0);
    h.rules = { onlyAssigned: false, teamIds: null, includeUnteamed: true, maskPhone: false };
    expect((await list()).conversations).toHaveLength(1);
    expect(h.db.rows("eddyConversation")[0].visibilityHash).toBe(visibilityHashOf({ roleClass: "agent", ...h.rules }));
  });

  it("DELETE removes the member's own history at once and says what is kept", async () => {
    enableEddy();
    const mine = await chat(AGENT, "What needs my attention today?");
    const theirs = await chat(ADMIN, "Show me the spending please");
    const other = await deleteOneRoute(req("DELETE", `/api/eddy/conversations/${theirs}`, { who: AGENT }), { params: Promise.resolve({ id: theirs }) });
    expect(other.status).toBe(404);
    const res = await deleteAllRoute(req("DELETE", "/api/eddy/conversations", { who: AGENT }));
    expect(await res.json()).toEqual({ deleted: 1, message: "Your chats are deleted now. A record of actions you confirmed is kept for 90 days." });
    expect(h.db.rows("eddyConversation").map((c) => c.id)).toEqual([theirs]);
    expect(h.db.rows("eddyMessage").every((m) => m.conversationId === theirs)).toBe(true);
    // The usage row stays, without its conversation.
    expect(h.db.rows("eddyTurn").find((t) => t.userId === AGENT.userId)).toMatchObject({ conversationId: null });
    expect((await one(mine)).status).toBe(404);
    expect((await deleteAllRoute(req("DELETE", "/api/eddy/conversations", { who: AGENT, origin: "https://evil.example" }))).status).toBe(403);
  });

  it("in a locked workspace a member can still delete their own history, and a turn gets the gate's locked state, not a 402", async () => {
    enableEddy();
    const mine = await chat(AGENT, "What needs my attention today?");
    h.locked = true;
    const one = await deleteOneRoute(req("DELETE", `/api/eddy/conversations/${mine}`, { who: AGENT }), { params: Promise.resolve({ id: mine }) });
    expect(one.status).toBe(200);
    expect((await deleteAllRoute(req("DELETE", "/api/eddy/conversations", { who: AGENT }))).status).toBe(200);
    const turn = await turnRoute(req("POST", "/api/eddy/turn", { who: AGENT, body: turnBody("What needs my attention today?") }));
    expect(turn.status).not.toBe(402);
    expect(await turn.text()).toContain("locked");
    // Switching Eddy on starts AI spend: it keeps the paywall.
    expect((await putSettingsRoute(req("PUT", "/api/eddy/settings", { who: OWNER, body: { enabled: true } }))).status).toBe(402);
  });
});

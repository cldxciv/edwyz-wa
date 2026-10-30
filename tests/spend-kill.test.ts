import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb }));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});

import { blockingBreakers, breakerPot, clearBreaker, clearExpiredBreakers, isBlocked, listBreakers, openBreaker, toBreakerRow } from "@/lib/spend/breakers/state";
import {
  assertMayToggleWorkspace,
  composeFreeze,
  freezeRefusal,
  PLATFORM_FREEZE_KEY,
  readPlatformFreeze,
  resetSpendStateCache,
  setPlatformFreeze,
  setWorkspaceFreeze,
  spendState,
  SPEND_STATE_CACHE_MS,
  stricterFreeze,
  type StopInline,
} from "@/lib/spend/kill";
import { SPEND_QUEUES, type FreezeState, type SpendActor } from "@/lib/spend/types";

const T = "t1";
const owner: SpendActor = { type: "user", userId: "u_owner", role: "owner" };
const admin: SpendActor = { type: "user", userId: "u_admin", role: "admin" };
const member: SpendActor = { type: "user", userId: "u_agent", role: "agent" };
const support: SpendActor = { type: "platform_admin", userId: "u_support" };
const assistant: SpendActor = { type: "assistant", assistantKey: "ads_optimizer" };

const control = () => h.db.rows("spendControl").find((r) => r.tenantId === T)!;
const ledger = (action?: string) => h.db.rows("spendLedger").filter((r) => !action || r.action === action);
const jobs = () => h.db.rows("job");

function approval(id: string, tenantId = T, status = "pending"): Row {
  return { id, tenantId, assistantKey: "ads_optimizer", pot: "ads", actionKind: "raise_budget", direction: "raise", intent: {}, fingerprint: "f", summary: "Raise", reason: "Good results", status, tokenHash: `h_${id}`, expiresAt: new Date(Date.now() + 3_600_000), correlationId: `c_${id}` };
}

beforeEach(() => {
  h.db.reset();
  resetSpendStateCache();
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active" }]);
});

// =====================================================================================================================
describe("spendState", () => {
  it("reads the freeze fresh at once, and the cached read within 5 s", async () => {
    const t0 = 1_000_000;
    expect((await spendState(T, { now: t0 })).effective).toBe("none");
    // Another process stops spending (a direct write, so this process's cache is not cleared).
    Object.assign(control(), { freeze: "all", frozenByKind: "admin", frozenByUserId: "u_admin", frozenAt: new Date(), frozenReason: "Stopped" });
    expect((await spendState(T, { now: t0 + 1_000 })).effective).toBe("none");
    expect((await spendState(T, { fresh: true, now: t0 + 1_000 })).effective).toBe("all");
    resetSpendStateCache();
    expect((await spendState(T, { now: t0 })).workspace).toBe("all");
    control().freeze = "none";
    expect((await spendState(T, { now: t0 + SPEND_STATE_CACHE_MS - 1 })).workspace).toBe("all");
    expect((await spendState(T, { now: t0 + SPEND_STATE_CACHE_MS })).workspace).toBe("none");
  });

  it("creates the control row with safe defaults on first read (I11)", async () => {
    expect(h.db.rows("spendControl")).toHaveLength(0);
    const s = await spendState(T, { fresh: true });
    expect(s).toMatchObject({ workspace: "none", platform: "none", effective: "none", frozenAt: null });
    expect(h.db.rows("spendControl")).toHaveLength(1);
  });

  it("combines the workspace and platform levels, showing the stricter one's who and when", () => {
    const at = new Date("2026-10-28T08:35:00Z");
    const ws = { freeze: "assistants" as const, frozenAt: at, frozenByKind: "admin" as const, frozenByUserId: "u_admin", frozenReason: "Checking" };
    const pf = { freeze: "all" as const, reason: "Incident", byUserId: "u_support", at, version: 3 };
    expect(composeFreeze(ws, pf)).toMatchObject({ workspace: "assistants", platform: "all", effective: "all", frozenByKind: "platform_admin", frozenByUserId: "u_support", reason: "Incident" });
    expect(composeFreeze(ws, { ...pf, freeze: "none" })).toMatchObject({ effective: "assistants", frozenByKind: "admin", reason: "Checking" });
    expect(stricterFreeze("none", "assistants")).toBe("assistants");
  });

  it("refuses raises by level and actor", () => {
    const s = (workspace: FreezeState["workspace"], platform: FreezeState["platform"]): FreezeState => ({ workspace, platform, effective: stricterFreeze(workspace, platform), frozenAt: null, frozenByKind: null, frozenByUserId: null, reason: null });
    expect(freezeRefusal(s("none", "none"), assistant)).toBeNull();
    expect(freezeRefusal(s("assistants", "none"), owner)).toBeNull();
    expect(freezeRefusal(s("assistants", "none"), assistant)).toBe("spend.frozen");
    expect(freezeRefusal(s("none", "assistants"), assistant)).toBe("spend.platform_frozen");
    expect(freezeRefusal(s("all", "none"), owner)).toBe("spend.frozen");
    expect(freezeRefusal(s("all", "all"), owner)).toBe("spend.platform_frozen");
  });
});

// =====================================================================================================================
describe("setWorkspaceFreeze", () => {
  it("lets an admin stop all spending; the change is visible at once and spend.stop is queued", async () => {
    await spendState(T); // warm the cache
    const out = await setWorkspaceFreeze(T, "all", admin, null);
    expect(out).toMatchObject({ level: "all", changed: true, text: "Spending is stopped. Running ads will be paused within a minute." });
    expect(control()).toMatchObject({ freeze: "all", frozenByKind: "admin", frozenByUserId: "u_admin", frozenReason: "Stopped all spending.", version: 2 });
    expect((await spendState(T)).effective).toBe("all");
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ queue: SPEND_QUEUES.stop, payload: { tenantId: T, level: "all", origin: "all", actor: admin, correlationId: out.correlationId } });
    const rows = ledger("kill.workspace");
    expect(rows.map((r) => r.phase)).toEqual(["requested", "applied"]);
    expect(rows[0]).toMatchObject({ before: { freeze: "none" }, undo: { action: "set_freeze", level: "none" } });
  });

  it("stopping assistants queues an assistant-only stop", async () => {
    await setWorkspaceFreeze(T, "assistants", owner, "Learning period");
    expect(jobs()[0].payload).toMatchObject({ level: "assistants", origin: "assistant", reason: "Learning period" });
  });

  it("only the owner or a platform admin turns spending back on", async () => {
    await setWorkspaceFreeze(T, "all", admin, null);
    await expect(setWorkspaceFreeze(T, "none", admin, null)).rejects.toMatchObject({ status: 403, message: "Only the owner can turn spending back on." });
    await expect(setWorkspaceFreeze(T, "assistants", admin, null)).rejects.toMatchObject({ status: 403 });
    expect(ledger("kill.workspace").filter((r) => r.phase === "refused")).toHaveLength(2);
    const back = await setWorkspaceFreeze(T, "none", owner, null);
    expect(back.text).toBe("Spending is back on. Anything that was paused stays paused until you resume it.");
    expect(control()).toMatchObject({ freeze: "none", frozenByKind: null, frozenAt: null });
    expect(jobs()).toHaveLength(1); // turning it back on restarts nothing
    await setWorkspaceFreeze(T, "assistants", admin, null);
    await setWorkspaceFreeze(T, "none", support, "Checked with the owner");
    expect(control().freeze).toBe("none");
  });

  it("team members cannot stop spending; breakers can stop but not resume", async () => {
    await expect(setWorkspaceFreeze(T, "all", member, null)).rejects.toMatchObject({ status: 403, message: "Only the owner or an admin can stop spending." });
    expect(() => assertMayToggleWorkspace("none", "all", { type: "breaker", kind: "monthly_limit" })).not.toThrow();
    expect(() => assertMayToggleWorkspace("all", "none", { type: "breaker", kind: "monthly_limit" })).toThrow();
    expect(() => assertMayToggleWorkspace("none", "all", assistant)).toThrow();
    expect(() => assertMayToggleWorkspace("all", "all", member)).not.toThrow();
  });

  it("freeze 'all' supersedes pending approvals and ledgers each one; 'assistants' does not", async () => {
    h.db.seed("spendApproval", [approval("ap1"), approval("ap2"), approval("ap3", T, "approved"), approval("ap4", "t2")]);
    await setWorkspaceFreeze(T, "assistants", owner, null);
    expect(h.db.rows("spendApproval").filter((a) => a.status === "pending")).toHaveLength(3);
    const out = await setWorkspaceFreeze(T, "all", owner, null);
    expect(out.supersededApprovalIds.sort()).toEqual(["ap1", "ap2"]);
    const byId = Object.fromEntries(h.db.rows("spendApproval").map((a) => [a.id, a]));
    expect(byId.ap1).toMatchObject({ status: "superseded", decidedVia: "system", failureReason: "Spending was stopped, so this request was withdrawn." });
    expect(byId.ap3.status).toBe("approved");
    expect(byId.ap4.status).toBe("pending"); // another workspace
    expect(ledger("approval.supersede").map((r) => [r.approvalId, r.phase])).toEqual([
      ["ap1", "info"],
      ["ap2", "info"],
    ]);
  });

  it("pauses inline first and reports progress, leaving the rest to the job", async () => {
    const partial: StopInline = vi.fn(async () => ({ paused: 4, total: 6, failed: 0 }));
    const out = await setWorkspaceFreeze(T, "all", owner, null, { inline: partial });
    expect(partial).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T, level: "all", origin: "all" }), 20_000);
    expect(out).toMatchObject({ paused: 4, total: 6, pending: 2, text: "Paused 4 of 6; the rest will follow within a minute." });
    expect(jobs()).toHaveLength(1);
    await setWorkspaceFreeze(T, "none", owner, null);
    const full = await setWorkspaceFreeze(T, "assistants", owner, null, { inline: async () => ({ paused: 6, total: 6, failed: 0 }) });
    expect(full.text).toBe("Paused 6 of 6 campaigns.");
    const failing = await setWorkspaceFreeze(T, "all", owner, null, { inline: async () => Promise.reject(new Error("token expired")) });
    expect(failing.changed).toBe(true);
    expect(failing.text).toBe("Spending is stopped. Running ads will be paused within a minute.");
  });

  it("a failing queue never fails the stop; the same level twice is a no-op", async () => {
    const out = await setWorkspaceFreeze(T, "all", owner, null, { enqueue: async () => Promise.reject(new Error("db down")) });
    expect(out.changed).toBe(true);
    expect(control().freeze).toBe("all");
    const again = await setWorkspaceFreeze(T, "all", admin, null);
    expect(again).toMatchObject({ changed: false, text: "Spending is already stopped." });
    expect(ledger("kill.workspace").filter((r) => r.phase === "requested")).toHaveLength(1);
  });
});

// =====================================================================================================================
describe("setPlatformFreeze", () => {
  const now = new Date("2026-10-28T09:00:00Z");
  const fresh = new Date(now.getTime() - 60_000);

  it("is platform admin only, with STOP SPENDING, a reason and a fresh step-up", async () => {
    await expect(setPlatformFreeze("all", owner, "x", { confirm: "STOP SPENDING", stepUpAt: fresh, now })).rejects.toMatchObject({ status: 403 });
    await expect(setPlatformFreeze("all", support, "", { confirm: "STOP SPENDING", stepUpAt: fresh, now })).rejects.toMatchObject({ status: 400 });
    await expect(setPlatformFreeze("all", support, "Incident", { confirm: "stop", stepUpAt: fresh, now })).rejects.toMatchObject({ status: 400, message: "Type STOP SPENDING to confirm." });
    await expect(setPlatformFreeze("all", support, "Incident", { confirm: "STOP SPENDING", stepUpAt: new Date(now.getTime() - 6 * 60_000), now })).rejects.toMatchObject({ status: 403 });
    await expect(setPlatformFreeze("all", support, "Incident", { confirm: "STOP SPENDING", stepUpAt: null, now })).rejects.toMatchObject({ status: 403 });
    expect((await readPlatformFreeze()).freeze).toBe("none");
  });

  it("stops every workspace: visible in spendState, refuses raises, supersedes approvals everywhere, queues a '*' stop", async () => {
    h.db.seed("spendApproval", [approval("ap1"), approval("ap2", "t2")]);
    await spendState(T, { now: now.getTime() });
    const out = await setPlatformFreeze("all", support, "Graph bug under investigation", { confirm: "STOP SPENDING", stepUpAt: fresh, now });
    expect(out.changed).toBe(true);
    const stored = h.db.rows("platformSetting").find((r) => r.key === PLATFORM_FREEZE_KEY)!;
    expect(stored.value).toMatchObject({ freeze: "all", reason: "Graph bug under investigation", byUserId: "u_support", version: 1 });
    const state = await spendState(T);
    expect(state).toMatchObject({ platform: "all", effective: "all", frozenByKind: "platform_admin" });
    expect(freezeRefusal(state, owner)).toBe("spend.platform_frozen");
    expect(h.db.rows("spendApproval").every((a) => a.status === "superseded")).toBe(true);
    expect(jobs()[0]).toMatchObject({ queue: "spend.stop", payload: { tenantId: "*", level: "all", origin: "all" } });
    expect(ledger("kill.platform").map((r) => [r.tenantId, r.phase])).toEqual([
      ["*", "requested"],
      ["*", "applied"],
    ]);
    // A workspace owner cannot clear it; only the platform switch can, with START SPENDING.
    await setWorkspaceFreeze(T, "none", owner, null);
    expect((await spendState(T, { fresh: true })).effective).toBe("all");
    await expect(setPlatformFreeze("none", support, "Fixed", { confirm: "STOP SPENDING", stepUpAt: fresh, now })).rejects.toMatchObject({ message: "Type START SPENDING to confirm." });
    const back = await setPlatformFreeze("none", support, "Fixed", { confirm: "START SPENDING", stepUpAt: fresh, now });
    expect(back.text).toBe("Spending is back on. Anything that was paused stays paused until you resume it.");
    expect((await spendState(T)).effective).toBe("none");
    expect((await readPlatformFreeze()).version).toBe(2);
  });
});

// =====================================================================================================================
describe("breaker state", () => {
  const base = { tenantId: T, kind: "pacing", scopeType: "workspace" as const, scopeId: T, effect: "block_raises" as const, reason: "Spent ₹1,400 by noon on ₹1,000 of daily budgets" };

  it("opens idempotently through the open-row index and ledgers one trip", async () => {
    const a = await openBreaker(base);
    const b = await openBreaker({ ...base, reason: "again" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.breaker.id).toBe(a.breaker.id);
    expect(h.db.rows("spendBreaker")).toHaveLength(1);
    expect(ledger("breaker.trip")).toHaveLength(1);
    expect(ledger("breaker.trip")[0]).toMatchObject({ pot: "ads", phase: "info", actorType: "breaker", actorId: "pacing", targetType: "workspace" });
    await expect(openBreaker({ ...base, effect: "explode" as never })).rejects.toThrow(RangeError);
  });

  it("clears with a breaker.clear row and can open again afterwards", async () => {
    const { breaker } = await openBreaker(base);
    const cleared = await clearBreaker({ id: breaker.id }, { actor: owner, reason: "Owner resumed" });
    expect(cleared).toMatchObject({ cleared: true, breaker: { state: "cleared", clearedByUserId: "u_owner" } });
    expect((await clearBreaker({ id: breaker.id })).cleared).toBe(false);
    expect(ledger("breaker.clear")).toHaveLength(1);
    expect(ledger("breaker.clear")[0]).toMatchObject({ actorType: "user", reason: "Owner resumed" });
    expect((await openBreaker(base)).created).toBe(true);
    expect(await listBreakers(T, { state: "all" })).toHaveLength(2);
  });

  it("isBlocked: a workspace breaker covers every scope; others only their own; effects filter; own breaker exempt", async () => {
    const ws = (await openBreaker(base)).breaker;
    await openBreaker({ ...base, kind: "efficiency", scopeType: "adset", scopeId: "s_1", effect: "pause_scope", reason: "No leads after ₹1,500" });
    await openBreaker({ ...base, kind: "wa_quality_red", scopeType: "phone", scopeId: "pn_1", effect: "block_automated", reason: "Number quality is low" });
    expect(await isBlocked(T, [{ scopeType: "adset", scopeId: "s_2" }], ["block_raises"])).toMatchObject({ blocked: true, breakers: [{ id: ws.id }] });
    expect((await isBlocked(T, [{ scopeType: "adset", scopeId: "s_1" }], ["pause_scope"])).breakers.map((b) => b.kind)).toEqual(["efficiency"]);
    expect((await isBlocked(T, [{ scopeType: "adset", scopeId: "s_2" }], ["pause_scope"])).blocked).toBe(false);
    expect((await isBlocked(T, [{ scopeType: "phone", scopeId: "pn_1" }], ["block_automated"])).blocked).toBe(true);
    expect((await isBlocked(T, [], ["block_raises"], { exemptBreakerId: ws.id })).blocked).toBe(false);
    expect(breakerPot("wa_quality_red")).toBe("messaging");
    expect(breakerPot("something_else")).toBe("none");
  });

  it("a breaker past autoClearAt stops blocking at once and is cleared by the sweep", async () => {
    const now = new Date("2026-10-28T10:00:00Z");
    await openBreaker({ ...base, kind: "budget_change_quota", scopeType: "adset", scopeId: "s_1", effect: "block_raises", reason: "3 budget changes in an hour", autoClearAt: new Date(now.getTime() + 60 * 60_000) }, { now });
    expect((await isBlocked(T, [{ scopeType: "adset", scopeId: "s_1" }], ["block_raises"], { now })).blocked).toBe(true);
    const later = new Date(now.getTime() + 61 * 60_000);
    expect((await isBlocked(T, [{ scopeType: "adset", scopeId: "s_1" }], ["block_raises"], { now: later })).blocked).toBe(false);
    expect(await listBreakers(T, { now: later })).toHaveLength(0);
    expect(await clearExpiredBreakers({ now: later })).toBe(1);
    expect(h.db.rows("spendBreaker")[0].state).toBe("cleared");
    expect(ledger("breaker.clear")[0]).toMatchObject({ actorType: "breaker", reason: "Cleared automatically." });
    const rows = h.db.rows("spendBreaker").map(toBreakerRow);
    expect(blockingBreakers(rows, [], ["block_raises"], { now: later })).toHaveLength(0);
  });
});

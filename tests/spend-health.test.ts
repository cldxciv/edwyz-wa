import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb }));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});

import { controlDefaults, getControl, pruneApprovers, toControlState } from "@/lib/spend/control";
import { assertNotDemoWorkspace, isDemoAsset, isDemoWorkspace } from "@/lib/spend/demo";
import { SpendBlockedError } from "@/lib/spend/errors";
import { checkSpendHealth, DAEMON_KEY, evaluateSpendHealth, readSpendHealth, TICK_KEY } from "@/lib/spend/health";
import { resetSpendStateCache, setWorkspaceFreeze, spendState } from "@/lib/spend/kill";

const T = "t1";
const NOW = new Date("2026-10-28T09:30:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const beat = (key: string, at: Date) => h.db.seed("platformSetting", [{ key, value: {}, updatedAt: at }]);

beforeEach(() => {
  h.db.reset();
});

// =====================================================================================================================
describe("worker health (4.16)", () => {
  it("is ok while the daemon beats", () => {
    expect(evaluateSpendHealth({ daemonAt: ago(1), tickAt: ago(20), now: NOW })).toMatchObject({ state: "ok", alert: null });
  });

  it("raises the alert when the daemon heartbeat is older than 5 minutes and the fallback is running", () => {
    const out = evaluateSpendHealth({ daemonAt: ago(12), tickAt: ago(0.5), now: NOW });
    expect(out.state).toBe("daemon_down");
    expect(out.alert).toEqual({
      kind: "worker_daemon_down",
      severity: "warning",
      text: "Background worker stopped 12 min ago. The 1-minute fallback is running.",
      channels: ["admin_strip"],
    });
    expect(evaluateSpendHealth({ daemonAt: ago(5), tickAt: null, now: NOW }).state).toBe("ok");
    expect(evaluateSpendHealth({ daemonAt: null, tickAt: ago(1), now: NOW }).alert?.text).toBe("Background worker isn't running. The 1-minute fallback is running.");
  });

  it("says background work is not running when nothing ran for 10 minutes", () => {
    const out = evaluateSpendHealth({ daemonAt: ago(30), tickAt: ago(11), periodicAt: ago(10.5), now: NOW });
    expect(out).toMatchObject({ state: "stopped", alert: { kind: "background_stopped", severity: "danger", text: "Background work is not running. Breakers and syncs are paused; Meta's limits still apply." } });
    expect(evaluateSpendHealth({ daemonAt: null, tickAt: null, now: NOW }).state).toBe("stopped");
    // A recent periodic lease counts as something running.
    expect(evaluateSpendHealth({ daemonAt: ago(30), tickAt: ago(30), periodicAt: ago(2), now: NOW }).state).toBe("daemon_down");
  });

  it("reads the heartbeat rows", async () => {
    beat(DAEMON_KEY, ago(12));
    beat(TICK_KEY, ago(1));
    beat("periodic:spend.breakers", ago(3));
    const out = await readSpendHealth({ now: NOW });
    expect(out).toMatchObject({ state: "daemon_down", daemonAgeMs: 12 * 60_000, lastRunAgeMs: 60_000 });
  });

  it("hands the alert to the sink once per kind per hour", async () => {
    beat(DAEMON_KEY, ago(12));
    beat(TICK_KEY, ago(1));
    const sink = vi.fn();
    const first = await checkSpendHealth({ now: NOW, alert: sink });
    const second = await checkSpendHealth({ now: new Date(NOW.getTime() + 60_000), alert: sink });
    expect([first.alerted, second.alerted]).toEqual([true, false]);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].text).toBe("Background worker stopped 12 min ago. The 1-minute fallback is running.");
    // Healthy: nothing is sent.
    h.db.rows("platformSetting").find((r) => r.key === DAEMON_KEY)!.updatedAt = NOW;
    expect((await checkSpendHealth({ now: NOW, alert: sink })).alerted).toBe(false);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("keeps the once-an-hour markers for 2 days only", async () => {
    beat(DAEMON_KEY, ago(12));
    beat(TICK_KEY, ago(1));
    h.db.seed("platformSetting", [
      { key: "spend-health:worker_daemon_down:2026-10-25T09", value: {}, updatedAt: ago(3 * 24 * 60) },
      { key: "spend-health:background_stopped:2026-10-28T07", value: {}, updatedAt: ago(150) },
      { key: "spend:fx", value: {}, updatedAt: ago(90 * 24 * 60) },
    ]);
    expect((await checkSpendHealth({ now: NOW, alert: vi.fn() })).alerted).toBe(true);
    expect(h.db.rows("platformSetting").map((r) => r.key).filter((k) => k !== DAEMON_KEY && k !== TICK_KEY).sort()).toEqual([
      "spend-health:background_stopped:2026-10-28T07",
      "spend-health:worker_daemon_down:2026-10-28T09",
      "spend:fx",
    ]);
  });

  it("never throws when the sink fails", async () => {
    const out = await checkSpendHealth({ now: NOW, alert: () => Promise.reject(new Error("no smtp")) });
    expect(out).toMatchObject({ state: "stopped", alerted: true });
  });

  it("a stop does not wait for the worker: with the daemon down the toggle pauses inline and leaves the job for the 1-minute fallback", async () => {
    beat(DAEMON_KEY, ago(30));
    beat(TICK_KEY, ago(0.5));
    expect((await readSpendHealth({ now: NOW })).state).toBe("daemon_down");
    h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active" }]);
    resetSpendStateCache();
    const inline = vi.fn(async () => ({ paused: 3, total: 3, failed: 0 }));
    const out = await setWorkspaceFreeze(T, "all", { type: "user", userId: "u_admin", role: "admin" }, "Something looks wrong", { inline });
    expect(inline).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ level: "all", paused: 3, total: 3, pending: 0, text: "Paused 3 of 3 campaigns." });
    // The freeze is in force right away for every raise path, whatever the worker does.
    expect((await spendState(T, { fresh: true })).effective).toBe("all");
    // The spend.stop job still waits in the queue for whichever runner comes next (the daemon or /api/internal/tick).
    expect(h.db.rows("job").map((j) => j.queue)).toEqual(["spend.stop"]);
  });
});

// =====================================================================================================================
describe("the demo workspace (8.4)", () => {
  it("recognises demo assets by meta.demo only", () => {
    expect(isDemoAsset({ meta: { currency: "INR", demo: true } })).toBe(true);
    expect(isDemoAsset({ meta: { demo: "true" } })).toBe(false);
    expect(isDemoAsset({ meta: null })).toBe(false);
    expect(isDemoAsset(null)).toBe(false);
  });

  it("recognises the demo workspace by a demo asset or the seeded demo WABA, and refuses raises there", async () => {
    expect(await isDemoWorkspace(T)).toBe(false);
    h.db.seed("metaAsset", [{ id: "as_real", tenantId: T, type: "ad_account", meta: { currency: "INR" } }]);
    expect(await isDemoWorkspace(T)).toBe(false);
    h.db.seed("metaAsset", [{ id: "as_demo", tenantId: T, type: "ad_account", meta: { currency: "INR", demo: true } }]);
    expect(await isDemoWorkspace(T)).toBe(true);
    expect(await isDemoWorkspace("t2")).toBe(false);
    h.db.seed("waba", [{ id: "w1", tenantId: "t2", wabaId: "demo-waba-t2" }]);
    expect(await isDemoWorkspace("t2")).toBe(true);
    const e = await assertNotDemoWorkspace(T).catch((x) => x);
    expect(e).toBeInstanceOf(SpendBlockedError);
    expect(e.message).toBe("This is a demo workspace, so nothing can be spent.");
    await expect(assertNotDemoWorkspace("t3")).resolves.toBeUndefined();
    expect(await isDemoWorkspace("")).toBe(false);
  });
});

// =====================================================================================================================
describe("the control row (I11)", () => {
  it("is created on first read with safe defaults and the ad account's time zone", async () => {
    h.db.seed("metaAsset", [{ id: "as_1", tenantId: T, type: "ad_account", status: "active", meta: { timezone: "America/New_York" }, createdAt: ago(100) }]);
    const c = await getControl(T);
    expect(c).toMatchObject({ tenantId: T, freeze: "none", probation: "auto", timezone: "America/New_York", spendingAdAccountAssetId: "as_1", approvalTtlHours: 12, digestEnabled: true, version: 1 });
    expect(h.db.rows("spendControl")).toHaveLength(1);
    // A second read does not create another.
    await getControl(T);
    expect(h.db.rows("spendControl")).toHaveLength(1);
  });

  it("falls back to RoutingConfig, then Asia/Kolkata, and chooses no spending account when there are several", async () => {
    h.db.seed("metaAsset", [
      { id: "as_1", tenantId: T, type: "ad_account", status: "active", meta: {}, createdAt: ago(10) },
      { id: "as_2", tenantId: T, type: "ad_account", status: "active", meta: { timezone: "Not/AZone" }, createdAt: ago(5) },
    ]);
    h.db.seed("routingConfig", [{ id: "rc", tenantId: T, timezone: "Asia/Dubai" }]);
    expect(await controlDefaults(T)).toEqual({ timezone: "Asia/Dubai", spendingAdAccountAssetId: null });
    expect(await controlDefaults("t2")).toEqual({ timezone: "Asia/Kolkata", spendingAdAccountAssetId: null });
  });

  it("works inside a caller's transaction", async () => {
    const c = await (h.db.prisma as unknown as { $transaction: <R>(fn: (tx: never) => Promise<R>) => Promise<R> }).$transaction((tx) => getControl(T, { db: tx }));
    expect(c.freeze).toBe("none");
    expect(h.db.transactions[0].status).toBe("committed");
  });

  it("prunes approvers to current admins and the owner on read", async () => {
    h.db.seed("spendControl", [{ tenantId: T, approverUserIds: ["u_admin", "u_demoted", "u_gone", "u_admin"], updatedAt: NOW }]);
    h.db.seed("membership", [
      { id: "m1", tenantId: T, userId: "u_admin", role: "admin" },
      { id: "m2", tenantId: T, userId: "u_demoted", role: "agent" },
      { id: "m3", tenantId: "t2", userId: "u_gone", role: "admin" },
    ]);
    expect((await getControl(T)).approverUserIds).toEqual(["u_admin"]);
    expect((await getControl(T, { prune: false })).approverUserIds).toEqual(["u_admin", "u_demoted", "u_gone", "u_admin"]);
    expect(await pruneApprovers(T, [])).toEqual([]);
  });

  it("reads unknown stored values as their safe defaults", () => {
    const c = toControlState({ tenantId: T, freeze: "everything", probation: "maybe", timezone: "Mars/Base", approvalTtlHours: 99, frozenByKind: "robot", version: 4 });
    expect(c).toMatchObject({ freeze: "none", probation: "auto", timezone: "Asia/Kolkata", approvalTtlHours: 12, frozenByKind: null, version: 4 });
  });
});

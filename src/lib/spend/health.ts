/**
 * Worker health for the spend controls (docs/SPEND-CONTROLS-SPEC.md 4.16). Breakers, the reconciler, Meta's limit and the
 * kill sweep run as periodic tasks in the worker daemon; when the daemon is down the once-a-minute /api/internal/tick runs
 * the same passes. This check is run by the web process on each /admin/spending load and by tick.
 *
 * - The daemon's heartbeat (PlatformSetting 'worker:daemon', written only by the daemon) older than 5 minutes:
 *   "Background worker stopped 12 min ago. The 1-minute fallback is running."
 * - Neither the daemon nor tick ('worker:heartbeat', and the periodic leases) ran for 10 minutes:
 *   "Background work is not running. Breakers and syncs are paused; Meta's limits still apply."
 *
 * The alert goes on the admin alerts strip. Email is off until SMTP exists (12.1a decision 2), and the WhatsApp notifier runs
 * in the worker itself, so neither is relied on; checkSpendHealth() hands the alert to a sink once per state per hour.
 */
import { prisma } from "@/lib/db";
import { DAEMON_KEY } from "@/worker/daemon";
import type { SpendDb } from "./control";

export { DAEMON_KEY };
export const TICK_KEY = "worker:heartbeat";
/** The daemon counts as stopped after this. */
export const DAEMON_STALE_MS = 5 * 60_000;
/** Background work counts as stopped when nothing ran for this long. */
export const BACKGROUND_STALE_MS = 10 * 60_000;
/** PlatformSetting keys that remember an alert was handed on (one per kind per UTC hour), kept for 2 days. */
export const HEALTH_MARKER_PREFIX = "spend-health:";
export const HEALTH_MARKER_KEEP_MS = 48 * 3_600_000;

export type SpendHealthState = "ok" | "daemon_down" | "stopped";

export type SpendHealthAlert = {
  kind: "worker_daemon_down" | "background_stopped";
  severity: "warning" | "danger";
  text: string;
  /** Where it is shown. Email is off (12.1a decision 2). */
  channels: ("admin_strip")[];
};

export type SpendHealth = {
  state: SpendHealthState;
  daemonAgeMs: number | null;
  /** The newest of the daemon heartbeat, the tick heartbeat and any periodic lease. */
  lastRunAgeMs: number | null;
  alert: SpendHealthAlert | null;
  checkedAt: Date;
};

const minutes = (ms: number) => Math.max(1, Math.floor(ms / 60_000));

/** The pure rule. Ages are from the heartbeat rows' updatedAt; null means the row does not exist. */
export function evaluateSpendHealth(input: { daemonAt: Date | null; tickAt: Date | null; periodicAt?: Date | null; now?: Date }): SpendHealth {
  const now = input.now ?? new Date();
  const age = (d: Date | null | undefined) => (d ? Math.max(0, now.getTime() - d.getTime()) : null);
  const daemonAgeMs = age(input.daemonAt);
  const ages = [daemonAgeMs, age(input.tickAt), age(input.periodicAt)].filter((a): a is number => a !== null);
  const lastRunAgeMs = ages.length ? Math.min(...ages) : null;
  const base = { daemonAgeMs, lastRunAgeMs, checkedAt: now };
  if (lastRunAgeMs === null || lastRunAgeMs > BACKGROUND_STALE_MS) {
    return {
      ...base,
      state: "stopped",
      alert: { kind: "background_stopped", severity: "danger", text: "Background work is not running. Breakers and syncs are paused; Meta's limits still apply.", channels: ["admin_strip"] },
    };
  }
  if (daemonAgeMs === null || daemonAgeMs > DAEMON_STALE_MS) {
    const text = daemonAgeMs === null ? "Background worker isn't running. The 1-minute fallback is running." : `Background worker stopped ${minutes(daemonAgeMs)} min ago. The 1-minute fallback is running.`;
    return { ...base, state: "daemon_down", alert: { kind: "worker_daemon_down", severity: "warning", text, channels: ["admin_strip"] } };
  }
  return { ...base, state: "ok", alert: null };
}

/** Reads the heartbeats and evaluates them. An unreadable database counts as "not running". */
export async function readSpendHealth(opts: { db?: SpendDb; now?: Date } = {}): Promise<SpendHealth> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  try {
    const rows = ((await db.platformSetting.findMany({ where: { key: { in: [DAEMON_KEY, TICK_KEY] } }, select: { key: true, updatedAt: true } })) ?? []) as { key: string; updatedAt: Date }[];
    const lease = (await db.platformSetting.findFirst({ where: { key: { startsWith: "periodic:" } }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } })) as { updatedAt?: Date } | null;
    const at = (key: string) => rows.find((r) => r.key === key)?.updatedAt ?? null;
    return evaluateSpendHealth({ daemonAt: at(DAEMON_KEY), tickAt: at(TICK_KEY), periodicAt: lease?.updatedAt ?? null, now });
  } catch {
    return evaluateSpendHealth({ daemonAt: null, tickAt: null, now });
  }
}

export type HealthAlertSink = (alert: SpendHealthAlert, health: SpendHealth) => Promise<void> | void;

/**
 * Reads health and, when there is an alert, hands it to `alert` once per kind per UTC hour (a marker in PlatformSetting, so
 * the web process and tick do not both send it). Returns the health either way.
 */
export async function checkSpendHealth(opts: { db?: SpendDb; now?: Date; alert?: HealthAlertSink } = {}): Promise<SpendHealth & { alerted: boolean }> {
  const health = await readSpendHealth(opts);
  if (!health.alert || !opts.alert) return { ...health, alerted: false };
  const db = opts.db ?? prisma;
  const hour = health.checkedAt.toISOString().slice(0, 13);
  const key = `${HEALTH_MARKER_PREFIX}${health.alert.kind}:${hour}`;
  try {
    const seen = await db.platformSetting.findUnique({ where: { key } });
    if (seen) return { ...health, alerted: false };
    await db.platformSetting.create({ data: { key, value: { at: health.checkedAt.toISOString(), state: health.state } } });
  } catch {
    // Another process claimed it first (unique key), or the database is down; then the strip still shows the alert.
    return { ...health, alerted: false };
  }
  try {
    // One marker per kind per hour is enough history; older ones are removed so a long outage leaves no pile of rows.
    await db.platformSetting.deleteMany({ where: { key: { startsWith: HEALTH_MARKER_PREFIX }, updatedAt: { lt: new Date(health.checkedAt.getTime() - HEALTH_MARKER_KEEP_MS) } } });
  } catch {
    // Housekeeping only.
  }
  try {
    await opts.alert(health.alert, health);
  } catch (error) {
    console.error("[spend] health alert could not be delivered:", error instanceof Error ? error.message : "unknown");
  }
  return { ...health, alerted: true };
}

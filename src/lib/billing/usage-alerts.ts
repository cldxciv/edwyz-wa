import { prisma } from "@/lib/db";
import { usageAlertTemplate } from "@/lib/email/templates";
import { claimOnce, emailOwners, readState, writeState } from "@/lib/lifecycle/state";
import { usageLines, type UsageLine } from "./limits";

export type AlertLevel = 80 | 100;
export type UsageAlert = UsageLine & { level: AlertLevel };

/** 100 once the limit is reached, 80 from four fifths of it, otherwise null. A limit of zero counts as reached. */
export function alertLevel(used: number, limit: number | null): AlertLevel | null {
  if (limit === null) return null;
  if (used >= limit) return 100;
  return used * 100 >= limit * 80 ? 80 : null;
}

/** The lines that are at 80 percent or more, fullest first. Used by the in-app banner and by the email sweep. */
export function alertsFrom(lines: UsageLine[]): UsageAlert[] {
  const out: UsageAlert[] = [];
  for (const line of lines) {
    const level = alertLevel(line.used, line.limit);
    if (level) out.push({ ...line, level });
  }
  return out.sort((a, b) => b.level - a.level || (b.percent ?? 0) - (a.percent ?? 0));
}

export async function getUsageAlerts(tenantId: string, now = new Date()): Promise<UsageAlert[]> {
  return alertsFrom(await usageLines(tenantId, now));
}

const periodKey = (alert: UsageLine, now: Date) => (alert.monthly ? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}` : "total");
const markerKey = (tenantId: string, alert: UsageLine, level: AlertLevel, now: Date) => `usage-alert:${alert.kind}:${periodKey(alert, now)}:${level}:${tenantId}`;

/** Forgets markers so the alert can be sent again. Best effort: a failure here only means the alert waits for the next period. */
const forget = (keys: string[]) => prisma.platformSetting.deleteMany({ where: { key: { in: keys } } }).then(() => undefined, () => undefined);

/**
 * Emails the workspace owners once per kind, level and period (month for monthly meters, otherwise once per crossing). A limit
 * reached in one jump sends only the 100 percent mail; the 80 percent marker is set too, so it never follows.
 * A marker is kept only when the mail was queued to at least one owner: a failed send, or a workspace with no owner to mail, gives the
 * marker back so the next sweep tries again. For meters that are totals (ad accounts, channels), usage that falls back below a
 * level clears that level's markers, so a later re-crossing alerts again.
 */
export async function sendUsageAlerts(tenantId: string, workspaceName: string, now = new Date()): Promise<number> {
  let sent = 0;
  const lines = await usageLines(tenantId, now);
  const stale: string[] = [];
  for (const line of lines) {
    if (line.monthly || line.limit === null) continue;
    const level = alertLevel(line.used, line.limit);
    if (level !== 100) stale.push(markerKey(tenantId, line, 100, now));
    if (level === null) stale.push(markerKey(tenantId, line, 80, now));
  }
  if (stale.length > 0) await forget(stale);
  for (const alert of alertsFrom(lines)) {
    if (alert.limit === null) continue;
    const limit = alert.limit;
    const taken: string[] = [];
    if (alert.level === 100) {
      const k80 = markerKey(tenantId, alert, 80, now);
      if (await claimOnce(k80)) taken.push(k80);
    }
    const key = markerKey(tenantId, alert, alert.level, now);
    if (!(await claimOnce(key))) continue;
    taken.push(key);
    let mailed = 0;
    try {
      mailed = await emailOwners(tenantId, () => usageAlertTemplate({ workspaceName, label: alert.label, level: alert.level, used: alert.used, limit, monthly: alert.monthly }));
    } catch {
      mailed = 0;
    }
    if (mailed === 0) await forget(taken);
    sent += mailed;
  }
  return sent;
}

/** Workspaces checked per sweep. Raise USAGE_ALERT_BATCH when the sweep (every 30 minutes) cannot get round all workspaces in a day. */
const BATCH = Math.min(1000, Math.max(1, Number(process.env.USAGE_ALERT_BATCH) || 100));
const CURSOR_KEY = "usage-alert:cursor";

/** Walks the active workspaces BATCH at a time, remembering where it stopped, and sends the alerts each one is due. */
export async function runUsageAlerts(now = new Date()): Promise<number> {
  const cursor = (await readState<{ after?: string }>(CURSOR_KEY))?.after;
  let tenants = await prisma.tenant.findMany({
    where: { status: "active", deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
    take: BATCH,
  });
  await writeState(CURSOR_KEY, tenants.length < BATCH ? {} : { after: tenants[tenants.length - 1].id });
  if (tenants.length === 0 && cursor) {
    tenants = await prisma.tenant.findMany({ where: { status: "active", deletedAt: null }, select: { id: true, name: true }, orderBy: { id: "asc" }, take: BATCH });
    await writeState(CURSOR_KEY, tenants.length < BATCH ? {} : { after: tenants[tenants.length - 1].id });
  }
  let sent = 0;
  for (const t of tenants) {
    try {
      sent += await sendUsageAlerts(t.id, t.name, now);
    } catch {
      console.error("[billing] usage alert check failed for one workspace");
    }
  }
  return sent;
}

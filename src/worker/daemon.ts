import { prisma } from "@/lib/db";

/** Written only by the daemon (not by the cron tick), so a dead daemon can be told apart from a working fallback tick. */
export const DAEMON_KEY = "worker:daemon";
/** A daemon whose last heartbeat is younger than this is treated as running. It beats every 10 s after each pass. */
export const DAEMON_ALIVE_MS = 60_000;

/**
 * True when the worker daemon is running. The cron tick checks this and stands down, so a job is never processed by the daemon and
 * the tick at once (SKIP LOCKED keeps one job from running twice, but not two jobs of one contact from running side by side, which
 * would break the order of rapid inbound messages and STOP handling). An unreadable heartbeat counts as "not running": work must go on.
 */
export async function daemonIsAlive(now = Date.now()): Promise<boolean> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: DAEMON_KEY }, select: { updatedAt: true } });
    return !!row && now - row.updatedAt.getTime() < DAEMON_ALIVE_MS;
  } catch {
    return false;
  }
}

/**
 * Spend worker tasks for owner notifications (docs/SPEND-CONTROLS-SPEC.md 9.3, 7.4, 4.16), in the spend WorkerModule, so
 * the daemon runs them and the once-a-minute /api/internal/tick fallback runs the same passes when it is down.
 *
 * - spend.digest, every 15 minutes: the daily summary for workspaces at 09:00 local or later (notify/digest.ts).
 * - spend.notify.health, hourly (and on the worker's first pass, which makes it the startup check): logs what is wrong with
 *   the notifier workspace (not exempt, AI agent, chatbots or automations on, non-admin members, templates not approved,
 *   number RED or restricted, TIER_250 nearly full), and removes channels of people who are no longer members.
 */
import type { JobHandler } from "@/lib/queue";
import type { PeriodicTask } from "@/worker/registry";
import { runDigestPass } from "../notify/digest";
import { pruneChannels } from "../notify/owner-channel";
import { logNotifierProblems } from "../notify/platform-sender";

export const DIGEST_EVERY_MS = 15 * 60_000;
export const NOTIFY_HEALTH_EVERY_MS = 60 * 60_000;

/** The hourly notifier check: warnings in the log, and stale channels removed. */
export async function runNotifyHealth(): Promise<{ problems: number; pruned: number }> {
  const problems = await logNotifierProblems().catch(() => [] as string[]);
  const pruned = await pruneChannels();
  return { problems: problems.length, pruned };
}

export const queues: Record<string, JobHandler> = {};
export const periodic: PeriodicTask[] = [
  { name: "spend.digest", everyMs: DIGEST_EVERY_MS, run: () => runDigestPass() },
  { name: "spend.notify.health", everyMs: NOTIFY_HEALTH_EVERY_MS, run: () => runNotifyHealth() },
];

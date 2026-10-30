/**
 * Eddy's WorkerModule (docs/EDDY-SPEC.md 8.4, EDDY-16 acceptance 1). Registered in MODULES (src/worker/loop.ts), so the daemon
 * runs it and the once-a-minute /api/internal/tick runs the very same passes when the daemon is down (Phase 0 4.16).
 *
 * - queue `actions.reconcile`: settles `unknown` ActionRecords from the real state (src/lib/actions/reconcile.ts); never
 *   re-sends.
 * - `notices.scan` every 120 s: the deterministic notice producers (src/lib/notices/scan.ts). No AI.
 * - `actions.expire` every 60 s: pending (and awaiting-approval) cards past expiresAt become `expired`.
 * - `eddy.turns.stale` every 60 s: turns still `running` after 3 minutes become `aborted`, and the conversation tail is
 *   repaired (an interrupted placeholder, and paired results for tool calls that never ran).
 * - `eddy.retention` daily: the retention keys of 8.3, plus conversations whose visibilityHash no longer matches.
 * - `eddy.erasure-sweep` daily: contacts erased elsewhere and members who left (7.6 backstop).
 * None of these is needed for correctness when the worker is down: confirm checks expiresAt itself and the turn route clears
 * a stale turn itself (5.9).
 *
 * The worker never streams a model call: nothing here imports Eddy's loop, its model binding, the streaming gateway
 * (src/lib/spend/exec/ai-stream.ts) or @anthropic-ai/sdk (tests/worker-no-sdk.test.ts, tests/worker-loop.test.ts).
 */
import { reconcileQueues } from "@/lib/actions/reconcile";
import { prisma } from "@/lib/db";
import { STALE_TURN_MS, visibilityHashOf } from "@/lib/eddy/conversations";
import { runEddyErasureSweep } from "@/lib/eddy/erasure-sweep";
import { appendEntries, loadHistory, repairTail } from "@/lib/eddy/history";
import { runEddyRetention } from "@/lib/eddy/retention";
import { NOTICE_SCAN_EVERY_MS, runNoticeScan } from "@/lib/notices/scan";
import { describeError } from "@/lib/safe-error";
import { viewerRules } from "@/lib/teams/visibility";
import type { PeriodicTask, WorkerModule } from "./registry";

export const ACTIONS_EXPIRE_EVERY_MS = 60_000;
export const STALE_TURNS_EVERY_MS = 60_000;
export const DAILY_MS = 24 * 60 * 60_000;
/** Stale turns repaired per run. */
const STALE_BATCH = 100;

/** Pending cards past their expiry become `expired` (8.4). Returns how many moved. */
export async function expireActions(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.actionRecord.updateMany({ where: { status: { in: ["pending", "awaiting_approval"] }, expiresAt: { lt: now } }, data: { status: "expired", updatedAt: now } });
  return count;
}

/**
 * Running turns older than 3 minutes become `aborted` and their conversation's tail is repaired (8.4). Only the run that
 * moves a turn out of `running` repairs its tail; the turn route's own clearing (startTurn) uses the same conditional
 * update, so a tail is never repaired twice.
 */
export async function clearStaleTurns(now: Date = new Date()): Promise<number> {
  const stale = (await prisma.eddyTurn.findMany({
    where: { status: "running", startedAt: { lt: new Date(now.getTime() - STALE_TURN_MS) } },
    select: { id: true, tenantId: true, conversationId: true },
    orderBy: { startedAt: "asc" },
    take: STALE_BATCH,
  })) as { id: string; tenantId: string; conversationId: string | null }[];
  let cleared = 0;
  for (const turn of stale) {
    try {
      const moved = await prisma.eddyTurn.updateMany({ where: { id: turn.id, tenantId: turn.tenantId, status: "running" }, data: { status: "aborted", errorCode: "stale", endedAt: now } });
      if (moved.count !== 1) continue;
      cleared++;
      if (!turn.conversationId) continue;
      const conversation = (await prisma.eddyConversation.findFirst({ where: { id: turn.conversationId, tenantId: turn.tenantId }, select: { status: true } })) as { status: string } | null;
      if (!conversation || conversation.status === "erased") continue;
      const fixes = repairTail(await loadHistory(turn.conversationId, turn.tenantId));
      if (fixes.length) await appendEntries({ id: turn.conversationId, tenantId: turn.tenantId }, null, fixes, prisma, now);
    } catch (error) {
      console.error(`[eddy] stale turn ${turn.id} not repaired: ${describeError(error)}`);
    }
  }
  return cleared;
}

/** A member's current visibility hash (the same facts the Eddy routes hash), or null when they are no longer a member. */
export async function memberVisibilityHash(tenantId: string, userId: string): Promise<string | null> {
  const membership = (await prisma.membership.findFirst({ where: { tenantId, userId }, select: { role: true } })) as { role: "owner" | "admin" | "agent" } | null;
  if (!membership) return null;
  const rules = await viewerRules({ tenantId, userId, role: membership.role });
  return visibilityHashOf({ roleClass: membership.role === "agent" ? "agent" : "admin", teamIds: rules.teamIds, includeUnteamed: rules.includeUnteamed, onlyAssigned: rules.onlyAssigned, maskPhone: rules.maskPhone });
}

export const EDDY_PERIODIC: readonly PeriodicTask[] = [
  { name: "notices.scan", everyMs: NOTICE_SCAN_EVERY_MS, run: () => runNoticeScan() },
  { name: "actions.expire", everyMs: ACTIONS_EXPIRE_EVERY_MS, run: () => expireActions() },
  { name: "eddy.turns.stale", everyMs: STALE_TURNS_EVERY_MS, run: () => clearStaleTurns() },
  { name: "eddy.retention", everyMs: DAILY_MS, run: () => runEddyRetention({ visibilityHashFor: memberVisibilityHash }) },
  { name: "eddy.erasure-sweep", everyMs: DAILY_MS, run: () => runEddyErasureSweep() },
];

export const worker: WorkerModule = { queues: { ...reconcileQueues }, periodic: [...EDDY_PERIODIC] };

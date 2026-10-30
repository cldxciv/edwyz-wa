/**
 * Approval and learning-period tasks (docs/SPEND-CONTROLS-SPEC.md 4.16, 7.3, 7.5).
 *
 * - `spend.approvals.expire`, every 5 minutes: a pending request past expiresAt becomes `expired`, which counts as declined
 *   and is ledgered once; the UI says "Declined automatically (no answer in 12 hours)." The same pass supersedes requests
 *   whose objects or limits changed since they were asked. Deciding never waits for this task: approving checks expiresAt
 *   itself, so a backlog can never let an old request through.
 * - `spend.shadow.evaluate`, hourly: fills the 24 h and 72 h outcomes of the assistants' learning records.
 * Both run in the worker daemon and, when it is down, from the once-a-minute /api/internal/tick (the spend WorkerModule).
 */
import type { JobHandler } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import type { PeriodicTask } from "@/worker/registry";
import { expireApprovals, supersedeChangedApprovals } from "../approvals";
import { evaluateShadow } from "../shadow";

export const APPROVALS_EXPIRE_TASK = "spend.approvals.expire";
export const APPROVALS_EXPIRE_EVERY_MS = 5 * 60_000;
export const SHADOW_EVALUATE_TASK = "spend.shadow.evaluate";
export const SHADOW_EVALUATE_EVERY_MS = 60 * 60_000;

/** Expires what is past its time, then supersedes what changed. Never throws. */
export async function runApprovalsSweep(now: Date = new Date()): Promise<{ expired: number; superseded: number }> {
  let expired = 0;
  let superseded = 0;
  try {
    expired = (await expireApprovals({ now })).expired;
  } catch (error) {
    console.error(`[spend] approvals expiry failed: ${describeError(error)}`);
  }
  try {
    superseded = (await supersedeChangedApprovals({ now })).superseded;
  } catch (error) {
    console.error(`[spend] approvals supersede check failed: ${describeError(error)}`);
  }
  return { expired, superseded };
}

export const queues: Record<string, JobHandler> = {};
export const periodic: PeriodicTask[] = [
  { name: APPROVALS_EXPIRE_TASK, everyMs: APPROVALS_EXPIRE_EVERY_MS, run: () => runApprovalsSweep() },
  { name: SHADOW_EVALUATE_TASK, everyMs: SHADOW_EVALUATE_EVERY_MS, run: () => evaluateShadow() },
];

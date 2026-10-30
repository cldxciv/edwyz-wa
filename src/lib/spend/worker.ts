/**
 * The spend controls' WorkerModule (docs/SPEND-CONTROLS-SPEC.md 4.16). Registered in MODULES (src/worker/loop.ts), so the
 * daemon runs these queues and periodic tasks, and the once-a-minute /api/internal/tick fallback runs the very same passes
 * when the daemon is down.
 *
 * Each area owns its own tasks file; this module only merges them. A queue or task name used twice is a programming error
 * and fails at load, so two packages can never silently replace each other's handler.
 */
import type { JobHandler } from "@/lib/queue";
import type { PeriodicTask, WorkerModule } from "@/worker/registry";
import * as adsguard from "./tasks/adsguard";
import * as approvals from "./tasks/approvals";
import * as breakers from "./tasks/breakers";
import * as commitments from "./tasks/commitments";
import * as digest from "./tasks/digest";
import * as ledger from "./tasks/ledger";
import * as messaging from "./tasks/messaging";
import * as metacap from "./tasks/metacap";
import * as quality from "./tasks/quality";
import * as sync from "./tasks/sync";

export type SpendTaskArea = { queues: Record<string, JobHandler>; periodic: PeriodicTask[] };

export const SPEND_TASK_AREAS: Readonly<Record<string, SpendTaskArea>> = { ledger, commitments, adsguard, messaging, quality, sync, metacap, breakers, approvals, digest };

/** Merges the areas' queues and periodic tasks; throws on a duplicate queue or task name. */
export function mergeSpendAreas(areas: Readonly<Record<string, SpendTaskArea>>): WorkerModule {
  const queues: Record<string, JobHandler> = {};
  const periodic: PeriodicTask[] = [];
  const owner = new Map<string, string>();
  for (const [area, part] of Object.entries(areas)) {
    for (const [name, handler] of Object.entries(part.queues)) {
      if (owner.has(`q:${name}`)) throw new Error(`[spend] queue ${name} is registered by both ${owner.get(`q:${name}`)} and ${area}`);
      owner.set(`q:${name}`, area);
      queues[name] = handler;
    }
    for (const task of part.periodic) {
      if (owner.has(`t:${task.name}`)) throw new Error(`[spend] periodic task ${task.name} is registered by both ${owner.get(`t:${task.name}`)} and ${area}`);
      owner.set(`t:${task.name}`, area);
      periodic.push(task);
    }
  }
  return { queues, periodic };
}

export const worker: WorkerModule = mergeSpendAreas(SPEND_TASK_AREAS);

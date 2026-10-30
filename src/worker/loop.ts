import { prisma } from "@/lib/db";
import { sanitizeMessage } from "@/lib/safe-error";
import { runBroadcastQueue } from "@/lib/broadcasts/process";
import { processSendJob } from "@/lib/inbox/send";
import { runDueJobs } from "@/lib/queue";
import { asRec, str } from "@/lib/webhooks/payload";
import { processWebhookEvent } from "@/lib/webhooks/processor";
import { worker as automation } from "@/lib/automation/worker";
import { worker as billing } from "@/lib/billing/worker";
import { worker as insights } from "@/lib/ads/insights-worker";
import { worker as chatbots } from "@/lib/chatbots/worker";
import { worker as commerce } from "@/lib/commerce/worker";
import { worker as content } from "@/lib/content/worker";
import { worker as conversions } from "@/lib/conversions/worker";
import { worker as inbox } from "@/lib/inbox/worker";
import { worker as integrations } from "@/lib/integrations/worker";
import { worker as leads } from "@/lib/leads/worker";
import { worker as lifecycle } from "@/lib/lifecycle/worker";
import { worker as metaConnect } from "@/lib/meta-connect/worker";
import { worker as onboarding } from "@/lib/onboarding/worker";
import { worker as optimizer } from "@/lib/optimizer/worker";
import { worker as reports } from "@/lib/reports/worker";
import { worker as routing } from "@/lib/routing/worker";
import { worker as spend } from "@/lib/spend/worker";
import { wireModules } from "@/lib/wiring";
import { worker as eddy } from "./eddy";
import { runPeriodic } from "./periodic";
import type { WorkerModule } from "./registry";

const MODULES: WorkerModule[] = [billing, automation, integrations, lifecycle, reports, chatbots, routing, metaConnect, onboarding, insights, optimizer, conversions, commerce, content, leads, inbox, spend, eddy];

const BATCH = 25;
const STALE_EVENT_MS = 5 * 60_000;

async function handleWebhookJob(payload: unknown) {
  const eventId = str(asRec(payload).eventId);
  if (eventId) await processWebhookEvent(eventId);
}

/** The sweep runs at most this often, as before the daemon existed (once per cron tick). */
const SWEEP_EVERY_MS = 60_000;
/** Events older than this are left alone: the sweep is a safety net for lost jobs, not an archive of poison events. */
const SWEEP_MAX_AGE_MS = 24 * 3_600_000;
/** An event the sweep could not process is not tried again by this process for this long. */
const SWEEP_RETRY_MS = 15 * 60_000;
let lastSweepAt = 0;
const sweepRetryAt = new Map<string, number>();

/**
 * Picks up events whose job was never enqueued (for example the enqueue failed after the insert). processWebhookEvent is idempotent.
 * Returns how many events were processed successfully: failures are not work, and a failing event is backed off, so one poison event
 * can neither keep the daemon on its fast polling cadence nor starve the events behind it (oldest first, ten per run, 24 hours back).
 */
async function sweepStaleEvents(now = Date.now()): Promise<number> {
  if (now - lastSweepAt < SWEEP_EVERY_MS) return 0;
  lastSweepAt = now;
  for (const [id, at] of sweepRetryAt) if (at <= now) sweepRetryAt.delete(id);
  const stale = await prisma.webhookEvent.findMany({
    where: {
      processedAt: null,
      receivedAt: { lt: new Date(now - STALE_EVENT_MS), gt: new Date(now - SWEEP_MAX_AGE_MS) },
      ...(sweepRetryAt.size > 0 ? { id: { notIn: [...sweepRetryAt.keys()].slice(0, 500) } } : {}),
    },
    orderBy: { receivedAt: "asc" },
    select: { id: true },
    take: 10,
  });
  let ok = 0;
  for (const { id } of stale) {
    try {
      await processWebhookEvent(id);
      ok++;
    } catch {
      sweepRetryAt.set(id, now + SWEEP_RETRY_MS);
    }
  }
  return ok;
}

/** Test helper: forgets the sweep schedule and the backoff list. */
export function resetSweepState(): void {
  lastSweepAt = 0;
  sweepRetryAt.clear();
}

/** swept is the number of stale webhook events the safety-net sweep processed successfully in this pass. */
export type PassResult = { webhook: number; send: number; broadcast: number; swept: number; queues: Record<string, number>; periodic: string[] };

export type PassOptions = {
  /** Skip the scheduled tasks. The daemon passes false on most passes: they are due every few minutes or hours at most. */
  periodic?: boolean;
};

/**
 * How many jobs and tasks a pass handled. The daemon polls again at once while this is above zero. The stale-event sweep is not
 * counted: it is a once-a-minute safety net, and counting it would let one bad event hold the daemon on its fast cadence.
 */
export function workDone(result: PassResult): number {
  return result.webhook + result.send + result.broadcast + Object.values(result.queues).reduce((a, b) => a + b, 0) + result.periodic.length;
}

/** One pass over the queues this module owns. Safe to call concurrently from several processes. */
export async function runPass(options: PassOptions = {}): Promise<PassResult> {
  wireModules();
  const webhook = await runDueJobs("webhook", handleWebhookJob, BATCH);
  const send = await runDueJobs("send", processSendJob, BATCH);
  const broadcast = await runBroadcastQueue();
  const swept = await sweepStaleEvents();

  const queues: Record<string, number> = {};
  const periodic: string[] = [];
  for (const module of MODULES) {
    for (const [queue, handler] of Object.entries(module.queues)) queues[queue] = await runDueJobs(queue, handler, BATCH);
    if (options.periodic !== false) for (const task of module.periodic) if (await runPeriodic(task)) periodic.push(task.name);
  }
  return { webhook, send, broadcast, swept, queues, periodic };
}

/** Marks the worker alive. The second row is DAEMON_KEY (src/worker/daemon.ts): only the daemon writes it. /health and the alert script read worker:heartbeat; the cron tick writes that one too. */
export async function writeHeartbeat(): Promise<void> {
  await prisma
    .$executeRaw`INSERT INTO "PlatformSetting" (key, value, "updatedAt") VALUES ('worker:heartbeat', '{}'::jsonb, now()), ('worker:daemon', '{}'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET "updatedAt" = now()`
    .catch(() => console.error("[worker] could not write the heartbeat"));
}

export type WorkerHandle = { stop: () => Promise<void> };

export type WorkerOptions = {
  /** Wait between passes when nothing was due. */
  intervalMs?: number;
  /** Scheduled tasks are checked at most this often (default 15 s). */
  periodicEveryMs?: number;
  /** Pause after a pass that found work, so a backlog drains quickly without hammering the database. */
  busyDelayMs?: number;
  heartbeatEveryMs?: number;
};

/**
 * Long-running loop for the dedicated worker process. Passes never overlap in one process. stop() lets the pass in progress
 * finish (jobs are claimed with a lock, so killing mid-pass would leave them running for ten minutes) and then resolves.
 */
export function startWorker(options: WorkerOptions | number = {}): WorkerHandle {
  const cfg = typeof options === "number" ? { intervalMs: options } : options;
  const intervalMs = cfg.intervalMs ?? 2000;
  const periodicEveryMs = cfg.periodicEveryMs ?? 15_000;
  const busyDelayMs = cfg.busyDelayMs ?? 100;
  const heartbeatEveryMs = cfg.heartbeatEveryMs ?? 10_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let lastPeriodic = 0;
  let lastBeat = 0;

  const pass = async (): Promise<number> => {
    const now = Date.now();
    const withPeriodic = now - lastPeriodic >= periodicEveryMs;
    if (withPeriodic) lastPeriodic = now;
    try {
      const result = await runPass({ periodic: withPeriodic });
      if (now - lastBeat >= heartbeatEveryMs) {
        lastBeat = now;
        await writeHeartbeat();
      }
      return workDone(result);
    } catch (error) {
      console.error("[worker] pass failed:", error instanceof Error ? sanitizeMessage(error.message) : "unknown");
      return 0;
    }
  };

  const loop = async () => {
    const worked = await pass();
    if (!stopped) timer = setTimeout(() => void (running = loop()), worked > 0 ? busyDelayMs : intervalMs);
  };
  running = loop();

  const stop = async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
  return { stop };
}

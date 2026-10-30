/**
 * The WhatsApp quality poll (docs/SPEND-CONTROLS-SPEC.md 6.3, 4.16): `spend.quality.poll` every 30 minutes reads each connected
 * number's quality rating and status (and each WABA's billing currency once a day) and opens or clears the number's quality
 * breakers. See spend/messaging/quality.ts. Runs in the worker daemon, and through /api/internal/tick when the daemon is down.
 */
import type { JobHandler } from "@/lib/queue";
import type { PeriodicTask } from "@/worker/registry";
import { pollQuality, QUALITY_POLL_MS } from "../messaging/quality";

export const queues: Record<string, JobHandler> = {};

export const periodic: PeriodicTask[] = [{ name: "spend.quality.poll", everyMs: QUALITY_POLL_MS, run: () => pollQuality() }];

/**
 * WhatsApp cost settlement (docs/SPEND-CONTROLS-SPEC.md 4.9 "Actual cost", 4.16): `spend.messaging.settle` every 5 minutes
 * replaces each sent message's conservative estimate with what Meta charged (spend/messaging/settle.ts runSettlement), once per
 * message, on the counters of the message's own day and month.
 */
import type { JobHandler } from "@/lib/queue";
import type { PeriodicTask } from "@/worker/registry";
import { runSettlement } from "../messaging/settle";

export const SETTLE_EVERY_MS = 5 * 60_000;

export const queues: Record<string, JobHandler> = {};

export const periodic: PeriodicTask[] = [{ name: "spend.messaging.settle", everyMs: SETTLE_EVERY_MS, run: () => runSettlement() }];

import { startWorker } from "./loop";

/**
 * Dedicated worker process (pm2 app "edwyz-wa-worker", see deploy/ecosystem.config.cjs). Polls every WORKER_INTERVAL_MS (default 2000)
 * and writes the worker:heartbeat row that /health and deploy/alert-wa.sh read. The cron tick (POST /api/internal/tick) stays as a
 * fallback: running both is safe because jobs are claimed with FOR UPDATE SKIP LOCKED and scheduled tasks with an atomic lease.
 */
const interval = Number(process.env.WORKER_INTERVAL_MS);
const worker = startWorker({ intervalMs: Number.isFinite(interval) && interval >= 250 ? interval : 2000 });
console.log("[worker] started");

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received, finishing the current pass`);
  const force = setTimeout(() => {
    console.error("[worker] the current pass did not finish in 25 s, exiting");
    process.exit(1);
  }, 25_000);
  force.unref();
  await worker.stop();
  console.log("[worker] stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

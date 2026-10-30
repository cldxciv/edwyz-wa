// pm2 definition for wa.edwyz.com. Install and reload:
//   cd /var/www/edwyz-wa && pm2 startOrReload deploy/ecosystem.config.cjs --update-env && pm2 save
// Only these two apps are touched by this file. Other tenants' pm2 apps on the shared VPS are never listed here.
//
// edwyz-wa         the Next.js standalone server. EXACTLY ONE instance, fork mode: rate limits, approval nonces, the compat
//                  idempotency map and the SSE gauge live in process memory (docs/ops.md sections 1 and 2). Never use
//                  instances above 1 or exec_mode "cluster".
// edwyz-wa-worker  the near-real-time worker daemon (worker/index.mjs, built by deploy/build-worker.mjs from src/worker/index.ts). It
//                  polls the job queues every 2 seconds. Keep it to one instance too: it is safe to run more (jobs are claimed
//                  with FOR UPDATE SKIP LOCKED) but gains nothing at this size and multiplies database polling.
//
// The every-minute cron call to POST /api/internal/tick (deploy/cron-wa-tick) stays installed as a fallback: if the worker is
// stopped or crashing, work still moves once a minute. Running both together is safe.
const cwd = process.env.WA_APP_DIR || "/var/www/edwyz-wa";

module.exports = {
  apps: [
    {
      name: "edwyz-wa",
      cwd,
      script: "server.js",
      node_args: "--env-file=.env",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "700M",
      kill_timeout: 10000,
      env: { NODE_ENV: "production", PORT: "3500", HOSTNAME: "127.0.0.1" },
    },
    {
      name: "edwyz-wa-worker",
      cwd,
      script: "worker/index.mjs",
      node_args: "--env-file=.env",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // A crash loop should slow down instead of hammering Postgres.
      min_uptime: "10s",
      max_restarts: 20,
      exp_backoff_restart_delay: 500,
      max_memory_restart: "500M",
      // SIGTERM lets the pass in progress finish (src/worker/index.ts waits up to 25 s), then pm2 sends SIGKILL.
      kill_timeout: 30000,
      env: { NODE_ENV: "production", WORKER_INTERVAL_MS: "2000" },
    },
  ],
};

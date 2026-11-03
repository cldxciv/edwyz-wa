# Operations: wa.edwyz.com

Run book for the platform on the shared VPS now and on an independent VPS later. Deploy steps are in `deploy/README-deploy.md`.

Contents: 1 single instance and the worker daemon, 2 shared rate limiting and the remaining per-process state, 3 health and readiness, 4 logging and error reporting, 5 metrics and alerts, 6 CSP rollout, 7 environment validation, 8 backups and restore, 9 nginx, 10 required secrets, 11 demo workspace, 12 WhatsApp token health and reconnecting, 13 opt-in gating of marketing sends, 14 Meta App Review readiness, 15 spend controls and Eddy (flags, runbook, every new environment variable).

## 1. Run the web app as a single pm2 instance, and the worker daemon beside it

Every rate limiter except the two on public callback endpoints now counts in Postgres through the shared limiter (section 2), so limits survive restarts and would hold across processes. The two exceptions, `csp-report` and `meta-deauthorize`, are `memoryOnly` so anonymous callers write no rows. The web app must still be one process, because of the per-process state in the last table of section 2: the approval-form nonce set, the MCP confirm-token set, the compat idempotency map, the live inbox connection count, the AI reply in-flight guard, Eddy's count of turns streaming at once and those two limiters. They reset on every restart, and with more than one web instance each would be split or multiplied by the instance count.

- Start the web app with exactly one instance (fork mode, or `-i 1`). Never use `-i max` or cluster mode with more than 1.
- The worker is a separate pm2 process and may be scaled on its own; it does not hold these limiters. Both processes are defined in `deploy/ecosystem.config.cjs` (apps `edwyz-wa` and `edwyz-wa-worker`, one fork-mode instance each; no other tenant's pm2 app is listed or touched): `cd /var/www/edwyz-wa && pm2 startOrReload deploy/ecosystem.config.cjs --update-env && pm2 save`.

### 1.1 Near-real-time worker daemon

`src/worker/index.ts` is a long-running loop (bundled to `worker/index.mjs` by `node deploy/build-worker.mjs`, which uses esbuild, a declared devDependency, and keeps packages external). It calls `runPass()` (webhook, send, broadcast and every module queue) every `WORKER_INTERVAL_MS` (default 2000, minimum 250), polls again after 100 ms while a pass found work, checks the scheduled tasks (the `periodic` modules) at most every 15 s, and writes the `worker:heartbeat` row every 10 s, which `/health` and `deploy/alert-wa.sh` read. Inbound messages, status ticks and queued sends therefore wait about 2 seconds instead of up to 60.

- Shutdown: on SIGTERM or SIGINT the loop stops polling, lets the pass in progress finish (jobs are claimed under a lock, so killing mid-pass would leave them `running` for ten minutes) and exits 0; after 25 s it exits 1. pm2 `kill_timeout` is 30 s.
- Passes never overlap inside one process. **The cron tick stands down while the daemon is alive**: the daemon writes its own heartbeat row `worker:daemon` (every 10 s, after a pass), and `POST /api/internal/tick` answers `{"skipped":"worker daemon is running"}` without processing anything while that row is younger than 60 s (`src/worker/daemon.ts`). `FOR UPDATE SKIP LOCKED` stops one job running twice but gives no per-contact order, so letting the tick work beside the daemon could process two rapid messages from one contact (or a message and a STOP) in parallel; standing down removes that. If the daemon is stopped, crash-looping or wedged for over a minute, the next tick runs a full pass as before. An unreadable heartbeat counts as "daemon not running", so work never stops.
- The stale-event sweep (webhook events whose job was never enqueued) runs at most once a minute, oldest first, ten events, only events from the last 24 hours. It is not counted as work, so it never keeps the daemon on its fast 100 ms cadence, and an event that keeps failing is not retried by that process for 15 minutes (so ten poison events cannot starve the others).
- **The cron tick stays as the fallback.** `deploy/cron-wa-tick` (`/etc/cron.d/edwyz-wa`) still calls `POST /api/internal/tick` every minute. If the daemon is stopped or crash-looping, work still moves once a minute and `alert-wa.sh` reports the stale worker. Do not remove it.
- Deploy: build the bundle where the sources are (`node deploy/build-worker.mjs worker/index.mjs --check /var/www/edwyz-wa`), copy `worker/index.mjs` into the release next to `server.js`, then `pm2 startOrReload deploy/ecosystem.config.cjs --update-env`. `--check <releaseDir>` lists the packages the bundle leaves external (today `@prisma/adapter-pg`, `@prisma/client`, `nodemailer`, all also used by the web app) and fails, naming each one, if any is missing from the release's `node_modules`; run it against the real release directory before starting the worker. esbuild is a devDependency, so `npm ci` (with dev dependencies) on the build host provides it.
- Env: `WORKER_INTERVAL_MS` (optional). It reads the same `.env` as the web app (`--env-file=.env`).
- `node scripts/check-env.mjs <env file>` warns when `WEB_INSTANCES` or `WEB_CONCURRENCY` is above 1, or when `pm2 jlist` shows more than one online instance of an app.

## 2. Shared rate limiting (`src/lib/ratelimit`)

`createLimiter(max, windowMs, name?, options?)` has the same shape as the in-memory `createLimiter` in `@/lib/auth/ratelimit` (window starts at the first hit for a key) and adds one thing: a stable `name`, which is part of the storage key.

```ts
import { createLimiter } from "@/lib/ratelimit";          // was "@/lib/auth/ratelimit"
const limiter = createLimiter(10, 15 * 60_000, "approval-decide-token");

limiter.consume(key)              // boolean, synchronous: a drop-in for the old call
await limiter.consumeShared(key)  // boolean, waits for the database count: use for password, TOTP and token guessing
limiter.reset(key); limiter.clear(); await limiter.flush();
```

How it works:

- `consume` decides from memory and writes its hits to Postgres in the background, batched into one upsert per key per round trip. Counts from other processes, and from before a restart, arrive with the first reply, so enforcement converges within milliseconds. The first hit for a key in a fresh process is always allowed (a restart can give an attacker at most one extra try per key).
- `consumeShared` returns the database count. It costs one round trip per call (about 0.2 to 1 ms on the same host). Saturated keys are answered from memory without a query. Use one style (`consume` or `consumeShared`) per limiter.
- Storage (env `RATELIMIT_BACKEND`): `settings` (default) is one `PlatformSetting` row per key, `rl:<name>:<sha256(key)[0..32]>`, value `{count, exp}`, written with `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (atomic, window reset inside the same statement). Keys are hashed, so emails and IPs never reach the database. `memory` keeps everything in the process and is the default under `NODE_ENV=test`, so other test suites need no database (in production it is a warning: counts reset on every restart). `createLimiter(..., { memoryOnly: true })` pins one limiter to memory (used by `/api/csp-report` and `/api/meta/deauthorize`). `table` would use the `RateLimitBucket` table requested in `docs/schema-requests.md`, which has no migration yet: `check-env` refuses the value, and if it is set anyway the first "table does not exist" answer moves every limiter to `settings` with one `ratelimit.table_missing` warning.
- Cost of the `settings` backend: one row per active key (rows live until a sweep removes them a minute after expiry; the limiter sweeps every 5 minutes, `sweepExpiredLimits()` can also run as a worker periodic task) and one write per batch. Writes to `PlatformSetting` create dead tuples that autovacuum cleans. It is fine up to roughly 50 limited requests per second in total; beyond that the `table` backend (unlogged, indexed on `expiresAt`) needs its migration first. The sweep uses a `LIKE 'rl:%'` scan of `PlatformSetting`, which stays small.
- If Postgres fails, the limiter keeps counting locally, retries after 5 seconds and logs one `ratelimit.degraded` warning a minute. It never throws and never blocks a request.
- Under the RLS plan (`docs/rls-plan.md`) `PlatformSetting` is a system table; the limiter must then use the system connection, or move to `RateLimitBucket` with a policy for `edwyz_app`.
- Forgetting to change `consume` calls is safe: the call stays synchronous. Calling `consumeShared` without `await` is not: a Promise is truthy, so `if (!limiter.consumeShared(k))` never trips. Always `await` it.

### The limiters that used to live in memory (migration done)

Every limiter imports `createLimiter` from `@/lib/ratelimit` with a unique stable name; nothing imports the old in-memory factory any more. `tests/ratelimit-migration.test.ts` fails when a file defines its own limiter again, reuses a name or drops one of the names below. Limiters added later (signup, inbox sends, new chats and exports, broadcast and template uploads, spend approvals, Eddy turns and actions, Shopify ownership checks, password and ownership changes) were built on the shared limiter from the start; `grep -rn 'createLimiter(' src` lists them all. A new limiter follows the same pattern: `createLimiter(max, windowMs, "<unique-name>")`, and `consumeShared` where an extra guess matters.

| File | Limiters (names) | Limit |
|---|---|---|
| `src/lib/auth/ratelimit.ts` | `login-ip`, `login-pair`, `login-email`; `checkLoginLimits` awaits `consumeShared` in `api/auth/login` and `api/auth/accept-invite` | 30, 10, 100 per 15 min |
| `src/lib/admin/security.ts` | `admin-totp` (TOTP attempts, `consumeShared`) | 5 per 15 min per user |
| `src/lib/approvals/guards.ts` | `approval-decide-ip`, `approval-decide-token`, `approval-view-ip`, `approval-resend-user` | 20 per 15 min, 10 per 1 h, 120 per 5 min, 10 per 1 h |
| `src/lib/email/limits.ts` | `forgot-ip`, `forgot-email`, `verify-ip`, `reset-ip`, `resend-user` | 10, 3, 20, 10 per 15 min; 3 per 1 h |
| `src/lib/compat/runtime.ts` | `compat-token` | 30 per 10 s |
| `src/lib/integrations/apikeys.ts` | `apikey` | 60 per min |
| `src/lib/tenant-mcp/server.ts` | `tenant-mcp` | 60 per min |
| `src/lib/inbox/suggest.ts` | `inbox-suggest` | 10 per min |
| `src/lib/byo-mcp/index.ts` | `byo-mcp` (fixed window) | 30 per min per tenant |
| `src/app/api/inbox/conversations/[id]/attachments/route.ts` | `inbox-upload` | 30 per min |
| `src/app/api/inbox/media/[messageId]/route.ts` | `inbox-media` | 600 per min |
| `src/app/api/csp-report/route.ts` | `csp-report` (`memoryOnly`: public endpoint, no rows written) | 120 per min per address |
| `src/app/api/meta/deauthorize/route.ts` | `meta-deauthorize` (`memoryOnly`: public Meta callback, no rows written) | 60 per min per address |
| `src/lib/actions/card-http.ts` | `actions-confirm` (Eddy's card routes, EDDY-SPEC 4.3) | 30 per min |

`src/lib/tenant-mcp/send-guard.ts` counts sends per key per hour and per recipient per day in a durable ledger (`mcp-send:` rows), not in memory. `src/lib/chatbots/engine.ts` throttles bot messages per session inside the persisted session variables (`vars.__sent`), so it already survives restarts.

Per-process state that stays in memory (acceptable with a single web instance; this is why the web app stays one process):

| File | State | Note |
|---|---|---|
| `src/lib/approvals/guards.ts` | `usedNonces` Map (approval-form replay set, 15 min) | Moving it needs a unique-insert: `INSERT INTO "PlatformSetting" (key, value, "updatedAt") VALUES ('nonce:'\|\|hash, '{}', now()) ON CONFLICT DO NOTHING RETURNING key` (row returned = first use). A replayed nonce is harmless today because the decision itself is single use |
| `src/lib/tenant-mcp/send-guard.ts` | `usedTokens` Map (MCP confirm-token replay) | Same unique-insert as `usedNonces` |
| `src/lib/inbox/stream.ts` | `connections` per tenant, max 20 live SSE connections | A gauge of open sockets; per process by nature |
| `src/lib/compat/idempotency.ts` | `inflight` Map of promises | Coalesces concurrent identical sends in one process; cross-process exactness needs the schema request already in `docs/schema-requests.md` |
| `src/lib/ai-agent/index.ts` | `inFlight` Set | Prevents two parallel AI replies for one conversation in one process |
| Eddy (`EDDY_MAX_CONCURRENT_TURNS`) | turns streaming at once | Counted per web instance |
| `src/lib/byo-mcp/index.ts`, `src/lib/tenant-state.ts`, `src/lib/commerce/webhook-guard.ts` | Caches (tool list, tenant status for 30 s, unknown shop domains for 60 s) | Staleness only |
| `src/app/api/csp-report/route.ts`, `src/app/api/meta/deauthorize/route.ts` | The `memoryOnly` limiters `csp-report` and `meta-deauthorize` | Reset on restart, and each web instance would count on its own. nginx's `wa_meta` zone also limits `/api/meta/` per address |

The single-instance requirement is `usedNonces`, `usedTokens`, `inflight`, `inFlight`, `connections`, Eddy's turn count and the two `memoryOnly` limiters.

## 3. Health and readiness

`GET /health` (public, cheap, one query, never any secret or version):

```json
{ "status": "ok", "service": "edwyz-wa", "db": { "ok": true, "rttMs": 3 }, "worker": { "lastTickAgeSeconds": 41, "state": "ok" } }
```

200 when the database answers, 503 with `"status":"degraded"` and no detail when it does not (2.5 s timeout). `worker.lastTickAgeSeconds` is the age of the row `PlatformSetting.worker:heartbeat` if it exists, otherwise of the newest `periodic:*` lease row written by `runPeriodic` (so it only moves when a periodic task is due; with long intervals it can legitimately read several minutes). `state` is `ok`, `stale` (older than 15 minutes) or `unknown` (no data yet). A stale worker does not fail the probe; alert on it (section 5).

The heartbeat is wired: the worker daemon (every 10 s) and the tick route write it after a pass, with this statement:

```ts
await prisma.$executeRaw`INSERT INTO "PlatformSetting" (key, value, "updatedAt") VALUES ('worker:heartbeat', '{}'::jsonb, now())
  ON CONFLICT (key) DO UPDATE SET "updatedAt" = now()`;
```

`GET /health/ready` (public): `{ "status": "ready", "checks": { "database": true, "schema": true, "migrations": true } }`, 200 or 503 `not_ready`. It checks that the database answers, that `Tenant`, `Job` and `PlatformSetting` exist, and that the newest migration is applied: `LATEST_MIGRATION` in `src/app/health/checks.ts` names the newest folder in `prisma/migrations` and something only it creates (a table, a column or an enum value; today the `flagged` value of `TemplateStatus` from `0011_template_flagged`). Migrations on the current VPS are applied by hand with psql, so there is no `_prisma_migrations` ledger, and this marker is what catches a release whose migration was forgotten (its routes would otherwise answer 500 while the probe said ready). Every new migration updates the constant in the same change; `tests/ops-health.test.ts` fails while it names an older folder or a marker the migration's SQL does not create. If `_prisma_migrations` exists, it must also have no unfinished row, and the app role needs `GRANT SELECT ON "_prisma_migrations" TO edwyz_wa_app`, otherwise `migrations` is false. A ready answer is cached for 5 s, a failure for 1 s. Use it for the deploy verification step and for an external load balancer on the independent server; use `/health` for uptime monitors.

## 4. Logging (`src/lib/log.ts`)

JSON lines: `{"t":"2026-10-27T01:02:03.000Z","level":"warn","msg":"ratelimit.degraded", ...fields}`. Info and debug go to stdout, warn and error to stderr; pm2 keeps both. `LOG_LEVEL` is `debug|info|warn|error` (default `info`).

```ts
import { log, requestLogger, REQUEST_ID_HEADER } from "@/lib/log";
log.info("tick.done", { jobs: 12 });
const { id, log: rlog } = requestLogger(request, { route: "tick" });   // reuses a valid x-request-id (nginx sets one) or mints one
rlog.error("send failed", { err: e, queue: "send" });                   // err is reduced to kind plus a scrubbed message (Prisma errors: kind only)
response.headers.set(REQUEST_ID_HEADER, id);
```

Redaction is applied to every line before it is written: keys matching token, secret, password, authorization, cookie, credential, api key, signature, email, phone, pin and otp are replaced; keys `body`, `text`, `content`, `caption`, `message`, `messages`, `payload`, `html`, `preview`, `subject` and `raw` are replaced (message bodies are never logged); inside any string, emails, phone-like digit runs, `Bearer` values, JWTs and `EAA...` Meta tokens are scrubbed. Depth, array length and string length are bounded.

Request ids: nginx sends `X-Request-Id $request_id` from `location /` (pages and most API routes) and from the Eddy, actions, notices and header upload blocks of `deploy/nginx-wa.edwyz.com.conf`; the proxy (`src/proxy.ts`) reuses it (or mints one) on page requests and responses, and the log helpers reuse it on API routes. The other proxied blocks do not send it yet: `/webhooks/`, `/api/meta/`, `/api/ext/`, `/api/mcp`, `/api/inbox/conversations/<id>/attachments` and `/api/content/media`. Lines from those routes (including `webhook.signature_rejected` and `webhook.store_failed`) carry an id the app mints, as does the cron tick, which calls the app on 127.0.0.1 without nginx. Adding `proxy_set_header X-Request-Id $request_id;` to those blocks would give them nginx's id too. Where failures are logged:

| Line | Written by | Carries |
|---|---|---|
| `api.unexpected` | `errorResponse()` in `src/lib/tenancy.ts`, which every API route calls in its `catch`, for anything that is not an `HttpError` (the 500 "Something went wrong.") | `err` (class name and code, plus a scrubbed message except for Prisma errors), `reqId`, and `method` and `path` when the route passes its request (`errorResponse(e, request)`). The same id goes back in the response's `x-request-id` header, so a customer's failed request can be found: `pm2 logs edwyz-wa --nostream --lines 2000 \| grep <id>`. Without the request the id is minted for that line |
| `request.unhandled` | `onRequestError` in `src/instrumentation.ts`: a page, layout or server action that throws, or a route that throws past its own `catch` | `err`, `reqId`, `method`, the route pattern (`/app/inbox/[id]`, never the concrete path, which can carry a token), `routeType`, and the `digest` shown on the error page |
| `webhook.signature_rejected`, `webhook.store_failed` | `/webhooks/whatsapp` | `reqId` (minted by the app: nginx's `/webhooks/` block sends no id); for the store failure `err` (Meta retries the 500) |
| `razorpay.signature_rejected`, `razorpay.webhook_failed` | `/api/webhooks/razorpay` | `reqId` (nginx's, through `location /`); for the failure `err` |
| `worker.heartbeat_failed` | `/api/internal/tick` | `err`. A failed pass is `api.unexpected` with an id the app mints, because the cron calls the app directly |

Other modules still write plain `console` lines with a `[module]` prefix; move them to `@/lib/log` when touching them.

Error reporting hook: `setErrorReporter(({ err, context, requestId }) => ...)` is called for every `log.error` that carries an `err` field (all the lines above except the signature rejections), with scrubbed data only. No vendor is bundled (an owner decision); register one in `register()` in `src/instrumentation.ts`, where a comment marks the place. The reporter is kept on `globalThis`, so the one registered there also sees errors logged from the route bundles. A reporter that throws is ignored.

Log rotation: `deploy/logrotate-edwyz-wa` (installed as `/etc/logrotate.d/edwyz-wa`) rotates wa's cron logs `/var/log/edwyz-wa-*.log` and, in a second block with `copytruncate`, pm2's logs of the two apps (`/root/.pm2/logs/edwyz-wa*.log`, daily or at 20 MB, 14 kept). On the shared VPS the owner chose this over pm2-logrotate, which would also rotate the other tenants' pm2 logs (`deploy/README-deploy.md` A step 8.1). Without rotation the disk (about 4.3 GB free on the shared VPS) fills slowly: `alert-wa.sh` alone appends a line every 5 minutes.

## 5. Metrics and alerts

`GET /api/internal/metrics`, header `x-worker-secret: $WORKER_SECRET` (403 otherwise). Not-done jobs only (finished jobs are an unbounded history and have no finish time):

```json
{ "generatedAt": "...", "queues": { "send": { "queued": 7, "running": 0, "failed": 0, "failedRecent": 0, "oldestDueSeconds": 12, "stuckRunning": 0 } },
  "totals": { "queued": 8, "running": 0, "failed": 0, "failedRecent": 0, "oldestDueSeconds": 12, "stuckRunning": 0 },
  "periodic": [ { "name": "billing-renew", "lastRunAt": "2026-10-27T01:00:00Z", "ageSeconds": 120 } ],
  "worker": { "heartbeatAgeSeconds": 41, "daemonAgeSeconds": 6 }, "dbRttMs": 4 }
```

`failed` counts every failed row (they are kept for inspection and never pruned); `failedRecent` only those whose last attempt was in the past 24 hours, which is what the alerts use. `heartbeatAgeSeconds` is the newest signal from the daemon or the cron tick; `daemonAgeSeconds` is the daemon's own heartbeat (`null` when it never ran). `oldestDueSeconds` is how long the oldest queued job that is already due has been waiting; `stuckRunning` counts jobs running with a lock older than 10 minutes (the queue reclaims them on the next pass). Query it from the server: `curl -fsS -H "x-worker-secret: $(grep ^WORKER_SECRET= /var/www/edwyz-wa/.env | cut -d= -f2-)" http://127.0.0.1:3500/api/internal/metrics`.

### 5.1 Installed alerting (`deploy/alert-wa.sh`)

`deploy/alert-wa.sh` implements the table below for the host. Install once (root):

```
install -m 755 deploy/alert-wa.sh /usr/local/sbin/alert-wa.sh
install -m 644 deploy/cron-wa-alert /etc/cron.d/edwyz-wa-alert
install -m 600 deploy/edwyz-wa-alert.conf.example /etc/edwyz-wa-alert.conf   # then edit: set ALERT_EMAIL to turn mail on
/usr/local/sbin/alert-wa.sh --test && tail -n 3 /var/log/edwyz-wa-alert.log
```

It runs every 5 minutes and checks: `/health` (two failures in a row, database round trip over 500 ms, worker heartbeat age), queue age and failed jobs from `/api/internal/metrics` (the secret goes to curl on stdin, never on a command line), stuck and deep queues, newest backup age and size, `*.FAILED` backups, TLS certificate expiry, disk use of `/` and the backup folder, and that the two `edwyz-wa` pm2 apps are online (no other pm2 app is read or changed). Every problem is written to `/var/log/edwyz-wa-alert.log`. Mail goes through the local `mail` command only when `ALERT_EMAIL` is set in `/etc/edwyz-wa-alert.conf` and `mail` exists; a problem is mailed once, again every `ALERT_REPEAT_MIN` minutes (default 360) while it lasts, and a recovery line is logged and mailed when it clears. A failed-job alert fires only for jobs that failed in the past 24 hours (`failedRecent`), so one old failed row does not re-alert forever; the worker daemon has its own alert (`daemon`: no heartbeat for `ALERT_DAEMON_MAX_AGE` seconds, default 120, or none at all; set `ALERT_EXPECT_DAEMON=0` on a host that only runs the cron tick), because the cron tick keeps the shared `worker:heartbeat` fresh and would hide a dead daemon. Thresholds (all optional): `ALERT_DISK_MAX_PCT` 85, `ALERT_TLS_MIN_DAYS` 14, `ALERT_BACKUP_MAX_HOURS` 26, `ALERT_WORKER_MAX_AGE` 300, `ALERT_QUEUE_MAX_AGE` 120 (send and webhook), `ALERT_QUEUE_MAX_AGE_ANY` 900, `ALERT_QUEUE_MAX_DEPTH` 1000. The script deletes and changes nothing on the server other than its own state under `/var/lib/edwyz-wa-alert`. If `mail` is not installed, read the log or add an external monitor on `/health`.

Alert guidance (the same rules, for an external monitor too; send to the on-call mailbox):

| Signal | Condition | Severity and first action |
|---|---|---|
| `/health` | not 200 for 2 consecutive checks | Page. `pm2 status`, `pm2 logs edwyz-wa --lines 100`, Postgres up? |
| `/health` `db.rttMs` | above 500 for 5 minutes | Warn. Check Postgres load and disk |
| `worker.lastTickAgeSeconds` | above 300 (once the heartbeat is wired; otherwise above 900) | Page. Cron `/etc/cron.d/edwyz-wa`, `WORKER_SECRET`, app errors |
| metrics `oldestDueSeconds` on `send` or `webhook` | above 120 | Page: customers are waiting on messages |
| metrics `oldestDueSeconds` on any queue | above 900 | Warn |
| metrics `failedRecent` | above 0 on `send`, `webhook` or `billing`; or `failed` total increased since the last check (any queue) | Warn; page for `send`, `webhook`, `billing`. Read `Job.lastError` (scrubbed) |
| metrics `worker.daemonAgeSeconds` | above 120, or null | Page: only the one-minute cron fallback is moving work. `pm2 logs edwyz-wa-worker` |
| metrics `stuckRunning` | above 0 | Warn: worker was killed mid-job |
| metrics `queued` | above 1000, or growing for 3 checks | Warn |
| `/health/ready` | not 200 after a deploy | Roll back (deploy runbook) |
| Backups | newest file in `/root/backups/wa/` older than 26 h, or smaller than half the previous one, or backup volume under 15% free | Page the owner |
| Logs | `env.invalid` at startup; `api.unexpected` or `request.unhandled` repeating (same route); `ratelimit.degraded` repeating or `ratelimit.table_missing`; `csp.violations` spiking; `webhook.signature_rejected` or `razorpay.signature_rejected` bursts; any `webhook.store_failed` | Warn |
| nginx | 5xx share above 2% over 5 minutes (`awk '$9 ~ /^5/' /var/log/nginx/access.log`), 429 bursts on `/webhooks/` | Warn |
| TLS | certificate expires in under 14 days | Warn (certbot renew failing) |

Minimal cron check (adjust the mail command to the VPS mail setup): `* * * * * root curl -fsS --max-time 5 http://127.0.0.1:3500/health | grep -q '"status":"ok"' || echo "wa health failed" | mail -s "wa down" ops@edwyz.com`.

## 6. Content-Security-Policy

`src/proxy.ts` sets a per-request nonce and the policy for page requests (it skips `/api`, `/webhooks`, `/health`, `/_next/static`, `/_next/image` and files with an extension; those get a locked-down `default-src 'none'` policy from `next.config.ts`). Builder and tests: `src/lib/security/csp.ts`, `tests/ops-csp.test.ts`.

`CSP_MODE` (read at runtime from the environment):

- `report-only` (default, also for any unrecognised value): the previous policy (`'unsafe-inline'` scripts) is still enforced as `Content-Security-Policy`, and the strict nonce policy is sent as `Content-Security-Policy-Report-Only`. Nothing can break; violations are posted to `/api/csp-report`.
- `enforce`: the strict nonce policy is the only policy.

Strict policy: `script-src 'self' 'nonce-...' 'sha256-...' 'strict-dynamic' https://connect.facebook.net https://checkout.razorpay.com` (no inline, no eval in production), `frame-src` for `www.facebook.com`, `web.facebook.com`, `staticxx.facebook.com` (the SDK's cross-domain iframe) and Razorpay, `connect-src 'self' https://graph.facebook.com` plus Razorpay, `img-src 'self' data: blob: https:`, `media-src 'self' blob: https:` (inbox video, audio and voice notes, including https links an automation sends), `object-src 'none'`, `frame-ancestors 'none'`. `style-src` keeps `'unsafe-inline'` because React style attributes cannot carry a nonce. `'strict-dynamic'` is what lets the nonced Next.js bundles load the Facebook SDK that `ConnectWhatsApp.tsx` adds with `document.createElement("script")`. The `'sha256-...'` source is `THEME_INIT_SCRIPT_HASH`: the hash of the root layout's inline theme script (`THEME_INIT_SCRIPT` in `src/components/app/theme-core.ts`), which runs before first paint on every page and carries no nonce. `'strict-dynamic'` ignores `'self'` and hosts but honours hashes. Change the script and the constant together; `tests/ops-csp.test.ts` recomputes the hash and prints the new value when they differ.

The enforced legacy policy (report-only mode) has the same `img-src` (with `blob:` for the composer's preview of a picked image) and `media-src`, and never a hash or nonce in `script-src`: a browser that sees one ignores `'unsafe-inline'`.

`/api/csp-report` accepts both report formats, is rate limited per IP, stores nothing and logs only aggregated counts per directive once a minute: `{"msg":"csp.violations","total":14,"byDirective":{"script-src-elem":14}}`. URLs and samples are dropped on purpose.

Rollout:

1. Deploy with the default. Watch `pm2 logs edwyz-wa | grep csp.violations` for a week while loading every page type, including the Embedded Signup popup flow and Razorpay checkout in test mode.
2. Precondition for enforcing: Next.js only stamps the nonce on pages rendered per request. The public pages (`src/app/(site)/layout.tsx`), the sign-in pages (`src/app/(auth)/layout.tsx`), the app and the admin console are force-dynamic, so they get it, and the root layout's own inline theme script is allowed by its hash (above), not a nonce. What Next still prerenders at build time is `/offline` (the installable app's offline page), the 404 page for unknown public paths and the web app manifest: their Next.js scripts carry no nonce and show up as `script-src-elem` violations on those pages only. Under `enforce` those scripts are blocked. `/offline` is plain HTML that works without them. The 404 page does not fully: its links and the header's links work, but the header's mobile menu button (`MobileNav` in `src/components/site/mobile-nav.tsx`, a client component) needs the scripts, so on a phone the Menu button on the 404 page does nothing. The service worker registration in the root layout does not run on these two pages either, which is harmless because every other page registers it. The fix is to render the 404 page per request (for example `await connection()` from `next/server` in `src/app/not-found.tsx`), which is not done yet. Confirm that the remaining violation counts come only from those two pages (load each page type while watching the counts), then go on, accepting the inert menu button on the 404 page or after that fix.
3. Set `CSP_MODE=enforce` in `.env`, `pm2 restart edwyz-wa --update-env`, repeat the page walk. Rollback is removing the line and restarting.
4. Add any host that legitimately appears in violations (the SDK may need `https://www.facebook.com` in `connect-src`) to `src/lib/security/csp.ts` and its test, never `'unsafe-inline'` to `script-src`.

## 7. Environment validation

- `node scripts/check-env.mjs /var/www/edwyz-wa/.env` before every deploy (a file argument is checked as production). It prints `ERROR`, `WARN` and `OFF` lines, names only, never values, and exits 1 on errors. Required: `DATABASE_URL` (postgres URL with host and database), `SESSION_SECRET` (32+ characters), `ENCRYPTION_KEY` (32 bytes, base64), `WORKER_SECRET` (16+ characters) and `STATE_SECRET` (32+ characters in production, which is what a file argument is checked as; 16+ elsewhere), `CSP_MODE` if set. In production also `CREATIVE_MEDIA_SECRET` and `CONTENT_MEDIA_SECRET` (section 10). Warnings: empty `META_APP_SECRET` (webhook signatures cannot be verified, so events are rejected), `META_APP_ID`, `META_VERIFY_TOKEN`, `META_ES_CONFIG_ID`, `PLATFORM_ADMIN_EMAILS`, secrets that share a value, `SITE_URL` not https, more than one web instance.
- Also checked: `RATELIMIT_BACKEND` must be `settings` or `memory` (error; `table` needs a migration that does not exist yet, section 2), and `memory` in production is a warning. In production, a warning names an email verification gate that is off: with `SMTP_USER` empty and `EMAIL_VERIFICATION_REQUIRED` unset (the gate in `src/lib/auth/verification.ts` turns on by itself once `SMTP_USER` is set), with `EMAIL_VERIFICATION_REQUIRED=false`, or with it `true` while no mail can be sent (every new signup would stay read-only). Any value of `EMAIL_VERIFICATION_REQUIRED` other than true or false is a warning everywhere. In production `ANTHROPIC_API_KEY` without `EDDY_ANTHROPIC_KEY_DEDICATED=true` is a warning even with Eddy off, because the AI reply bot, inbox suggestions and creative copy spend on the same key (section 15.1).
- At boot (`src/instrumentation.ts`, nodejs runtime only) the app logs each problem and one `startup` line: counts, `cspMode`, and the optional features that are off (AI, Eddy and creative copy; Razorpay; SMTP; Meta Connect login config), without values. `MAX_DAILY_BUDGET_MINOR` is no longer a feature: it is deprecated and only warns when set (section 15). The spend and Eddy flags are checked too (section 15.1): a typo is an error, never a silent fallback. `ENV_STRICT=1` makes the app refuse to start on errors; leave it off until the env check passes in the deploy runbook, otherwise a bad `.env` puts pm2 in a restart loop.
- The rules are in `src/lib/env-rules.mjs` (plain JavaScript so the script runs on bare Node) and re-exported with types from `src/lib/env.ts`.

## 8. Backups and restore

What is backed up: the `edwyz_wa` database (`deploy/backup-wa.sh`). Not backed up: `DATA_DIR` (content media, creative assets, raw events, deletion requests) and `.env`. Copy those separately (section 8.4).

### 8.1 Install

```
install -m 755 deploy/backup-wa.sh /usr/local/sbin/backup-wa.sh      # LF line endings; check with: file /usr/local/sbin/backup-wa.sh
install -m 644 deploy/cron-wa-backup /etc/cron.d/edwyz-wa-backup
/usr/local/sbin/backup-wa.sh                                         # first run by hand
ls -l /root/backups/wa/ && tail -n 3 /var/log/edwyz-wa-backup.log
```

The script reads `DATABASE_URL` from `/var/www/edwyz-wa/.env` (override with `APP_ENV_FILE`) without printing it, passes it to `pg_dump` through `PG*` variables (never on the command line), writes `/root/backups/wa/edwyz_wa-<UTC timestamp>.sql.gz` with mode 600 in a 700 directory, verifies the gzip, prints the size and the free space, and never deletes anything. A failed dump is kept as `.FAILED` for inspection and the script exits non-zero. Cron runs it nightly at 02:30 server time.

Retention is a manual decision (nothing is deleted automatically). Review monthly with `ls -lh /root/backups/wa/`; compressed dumps are small now. Copy a recent dump off the server weekly (`scp` to another machine or object storage); a backup on the same disk does not survive the disk.

### 8.2 Restore into a new database (safe: the live database is untouched)

```
STAMP=<file stamp>                       # e.g. 20261027T020000Z
sudo -u postgres createdb -O edwyz_wa_app edwyz_wa_restored
gunzip -c /root/backups/wa/edwyz_wa-$STAMP.sql.gz \
  | sudo -u postgres env PGOPTIONS='-c role=edwyz_wa_app' psql -v ON_ERROR_STOP=1 -q -d edwyz_wa_restored
```

The dump has no owners or grants, so running as `edwyz_wa_app` makes it own everything.

### 8.3 Disaster recovery (replace the live database without deleting it)

1. Announce downtime. `pm2 stop edwyz-wa`; comment out the tick line in `/etc/cron.d/edwyz-wa`.
2. Take one more backup of the damaged state: `/usr/local/sbin/backup-wa.sh`.
3. Restore into `edwyz_wa_restored` (8.2) and run the checks in 8.5.
4. `sudo -u postgres psql -c "ALTER DATABASE edwyz_wa RENAME TO edwyz_wa_old_$(date +%Y%m%d)"` then `... RENAME TO edwyz_wa` for the restored one (no connections may be open; step 1 ensures it). The old database is kept.
5. `pm2 start edwyz-wa`, re-enable cron, verify with `/health/ready`, a login and one tick. Restart the worker cron last.

### 8.4 Everything else to copy

`/var/www/edwyz-wa/.env` (mode 600; the `ENCRYPTION_KEY` in it is the only way to read stored Meta tokens, so keep a copy outside the server) and the `DATA_DIR` folder, for example `tar czf /root/backups/wa/data-$(date -u +%Y%m%d).tgz -C <DATA_DIR parent> <DATA_DIR name>` (mode 600).

### 8.5 Restore check (monthly, and after any change to the backup script)

Automated: `install -m 755 deploy/restore-check-wa.sh /usr/local/sbin/restore-check-wa.sh`, then run `/usr/local/sbin/restore-check-wa.sh` as root (or pass a dump path). It checks the gzip, creates a temporary database `edwyz_wa_restorecheck_<UTC stamp>_<pid>` owned by `edwyz_wa_app`, restores the newest dump into it, counts tables (at least 20, equal to production's), counts rows in Tenant, User, Membership, Contact, Conversation, Message, Template, Job and PlatformSetting, looks for messages without a conversation and notes how old the newest message is against the dump, then drops only that temporary database (on success, failure and Ctrl-C; never one whose name does not match the pattern and never the production name). The production database is only read, for a table count. Exit 0 with a last line `restore-check: PASS ...` means the backup restores; 1 means a check failed; 2 means it could not run. Set `RESTORE_CHECK_LOG=/var/log/edwyz-wa-restore-check.log` to keep a record. The manual steps below do the same by hand.

1. Restore the newest dump into `edwyz_wa_restorecheck` as in 8.2.
2. Run: `sudo -u postgres psql -d edwyz_wa_restorecheck -Atc "select (select count(*) from \"Tenant\"), (select count(*) from \"User\"), (select count(*) from \"Message\"), (select max(\"createdAt\") from \"Message\")"`.
3. Pass criteria: the command succeeds with no error, counts are within a day's growth of production, `max(createdAt)` is within 24 hours of the dump time, and `select count(*) from information_schema.tables where table_schema='public'` equals production's.
4. Record date, dump name and result in the owner's ops log. The scratch database holds customer data: drop it as soon as the check is done (`sudo -u postgres dropdb edwyz_wa_restorecheck`), it is a database you created for the check and never the production one.

## 9. nginx

1. Copy `deploy/nginx-wa-zones.conf` to `/etc/nginx/conf.d/wa-zones.conf`. It defines the `limit_req_zone` entries (`wa_webhooks`, `wa_ext`, `wa_mcp`, `wa_meta`, `wa_eddy`) and must sit in the `http` block; the stock `nginx.conf` includes `conf.d/*.conf` there. Without it the site file fails `nginx -t`.
2. Install `deploy/nginx-wa.edwyz.com.conf` as the site, then `nginx -t && systemctl reload nginx`.
3. Rate limits per client address, answered with 429: `/webhooks/` 30 req/s burst 60, `/api/ext/` 10 req/s burst 20, `/api/mcp` 5 req/s burst 10, `/api/meta/` 5 req/s burst 20, and Eddy's `/api/eddy/turn`, `/api/eddy/`, `/api/actions/` and `/api/notices/` 2 req/s burst 10 (zone `wa_eddy`).
3a. Eddy's blocks (Eddy spec 7.10) repeat every `proxy_set_header` of `location /` (nginx does not inherit them into another location: without `Host` the same-origin check refuses every turn, without the client address every per-address limit sees 127.0.0.1) and set `gzip off`. The exact `location = /api/eddy/turn` block streams server-sent events: `proxy_buffering off`, `proxy_cache off`, `proxy_read_timeout 180s` (the route lives 150 s and sends a keepalive every 15 s). `tests/deploy-nginx-eddy.test.ts` fails when any of these is missing. On staging, check that events arrive one by one with no compression: `curl -N --compressed -H 'content-type: application/json' -b '<session cookie>' -H 'Origin: https://wa.edwyz.com' -d '{"text":"hi","page":"/app"}' https://<host>/api/eddy/turn -D -` must show no `Content-Encoding` header and print events as they come.
4. Body limits: 4 MB everywhere. 110 MB only for `POST /api/content/media` and the inbox attachment upload `POST /api/inbox/conversations/<id>/attachments`, both with `proxy_request_buffering off` so uploads stream to the app. 17 MB for the template and broadcast header uploads `POST /api/templates/media` and `POST /api/broadcasts/media` (WhatsApp's 16 MB header limit).
5. The catch-all location, Eddy's four blocks and the two header upload blocks send `X-Request-Id $request_id`; the app reuses it in logs and responses. The other proxied blocks do not send it yet, so the app mints an id there (section 4 lists them).

Lock down internal routes (optional, security review F17): `/api/internal/tick` and `/api/internal/metrics` are guarded by `WORKER_SECRET` but reachable from the internet. Before enabling the commented `location /api/internal/` block (allow 127.0.0.1, deny all) check how the tick cron calls the app: `grep -h tick /etc/cron.d/edwyz-wa`. If it uses `https://wa.edwyz.com/...` change it to `http://127.0.0.1:3500/api/internal/tick` first, otherwise the tick stops. Verify with a tick after the nginx reload.

## 10. Required secrets in production

`CREATIVE_MEDIA_SECRET` and `CONTENT_MEDIA_SECRET` must each be 32 or more random bytes as hex or base64 (`openssl rand -hex 32`). With `NODE_ENV=production` an unset or short value is a startup error that names the variable, instead of a silent fallback to `STATE_SECRET`. Set `ENV_STRICT=1` to make the app refuse to start on startup errors. `scripts/check-env.mjs <file>` checks a file as production.

## 11. Demo workspace (sample data for screenshots, UAT and sales demos)

`scripts/seed-demo.mjs` prepares a workspace named "Demo Workspace (sample data)" with a demo owner and realistic sample data in whatever database `DATABASE_URL` points to (read from `.env` in the current directory, or the environment).

Run it from the app directory (`wa/`) with the app already running, because the owner is created through the real `POST /api/auth/signup`:

```
# locally
node scripts/seed-demo.mjs --base http://localhost:3500 --out ./demo-credentials.txt

# on the server (the pm2 app and its .env are in place)
node scripts/seed-demo.mjs --base https://wa.edwyz.com --email demo@edwyz-demo.example --out /root/demo-credentials.txt
```

- `--email` defaults to `demo@edwyz-demo.example`; `--out` defaults to `./demo-credentials.txt`.
- When the user does not exist yet, the script signs it up, marks the email verified with SQL, generates a random 20-character password and writes email, password, login URL and creation date to `--out` (mode 600). The password is never printed; the script prints only the file path and the email. Move the file somewhere safe and delete it when done.
- Running it again is safe: rows have fixed ids and are inserted with `ON CONFLICT DO NOTHING`, and no new password is generated for an existing user.
- It seeds only the demo tenant: a fake connected number (Demo, quality GREEN), 12 contacts, 5 conversations with messages, 4 templates, 2 broadcasts, automations, a published chatbot, a disabled AI agent, brand kit and creative brief, leads, a scheduled post, 14 days of ad insights, an ad draft, two Optimiser proposals, a pending Shopify store with 3 abandoned carts and report counters. Every demo row is named "Demo ...".
- It refuses to run if the workspace is not named "Demo ..." or already has more than 50 conversations; pass `--force` to override either check.
- The demo workspace shows sample data only and cannot send real WhatsApp messages: it has no WhatsApp access token and its Meta connection holds a placeholder token, so any send, template submission or ad launch fails. Do not connect real accounts to it.

## 12. WhatsApp token health and reconnecting (`src/lib/onboarding`)

Embedded Signup returns a business token. With the 60-day-expiry configuration Meta also returns `expires_in`, which is stored as `AccessToken.expiresAt`; `getAccessToken` ignores expired rows, so sends then fail with "No valid WhatsApp access token" (stored as failure code `auth_expired`). Meta can also revoke a token earlier: a send that fails with error 190 (or an OAuth 401) marks the workspace as "rejected" (`PlatformSetting` key `wa-auth-rejected:<tenantId>`).

- **Reconnect.** Connecting the same WABA and number again runs the whole pipeline with the fresh code: the code is exchanged and the new token stored (this is what makes reconnecting work after expiry), the number is re-verified, the webhook subscription refreshed and the details updated. Only `register_number` is skipped once done, because registering again would replace the two-step PIN. Older tokens are deleted once the new one works. A reconnect that fails after the code exchange (verify, subscribe, details) **deletes the token it just stored**, so the previous working token stays the newest one (`getAccessToken` always picks the newest row) and the workspace stays `live`; the rejected flag is also cleared only after the new token has passed `verify_ids`, never before. The result carries `reauthorized: true`.
- **Banner.** `GET /api/onboarding/token-health` (any member) returns `{ state: none|ok|expiring|expired|rejected, expiresAt, daysLeft, canReconnect }` and never token material. The app shell shows a warning banner from 14 days before expiry and a red alert when expired or rejected, with a one-click link to Settings, Connect WhatsApp (owners and admins; agents are told to ask one). The connect page repeats it with a "Reconnect now" button. The same data is in `GET /api/onboarding/status` as `token`.
- **Inbox.** Messages that fail because of a bad token show "The WhatsApp connection has expired, so nothing can be sent. An owner or admin needs to reconnect WhatsApp in Settings." (codes `190` and `auth_expired`). The messages stay in the chat as failed and are **not re-sent automatically** after a reconnect (there is no hold-and-retry for an auth-rejected workspace, unlike a suspended or billing-locked one); the banner says so and tells the person to send them again. Broadcast and automation sends made while disconnected fail the same way.
- **Email.** The periodic task `wa-token-health` (every 6 h, in the worker) emails the workspace owners 14 days and 3 days before the stored expiry, and when the token has expired or was rejected. Each notice is sent once per token and stage (unique `wa-token-notice:<tokenId>:<stage>` row, kept only when at least one owner mail was queued: a workspace with no mailable owner, or a mail queue that refuses the message, gives the row back and is retried on the next 6-hour run), only the newest token counts, and suspended or locked workspaces are skipped. The rejected flag is cleared by a reconnect, and also by any send Meta accepts (at most one delete per workspace per minute per process); a 190 from a send that began before a newer token was stored is ignored, so a late error cannot undo a reconnect. Audit actions: `whatsapp.token_expiring`, `whatsapp.token_expired`.
- **Meta setting.** Use the 60-day-expiry configuration only if the owner accepts the reconnect step; otherwise keep the non-expiring configuration and rely on the 190 handling above. Tests: `tests/onboarding.test.ts`, `tests/onboarding-token-health.test.ts`.

## 13. Opt-in gating of marketing sends

Rule: a template whose category is MARKETING is sent only to a contact with `optIn = true` and no `optedOutAt` (STOP). An opt-out stops marketing only (owner default 1, 2026-10-31; the one helper is `mayReceive` in `src/lib/contacts/opt-out.ts`): utility and authentication templates (order and delivery updates, login codes) and replies inside the 24-hour window (teammates, the AI agent, chatbots and rules answering the customer) still go to a contact who opted out. The STOP words are stop, stop all, unsubscribe, opt out, cancel, end and quit, whole message only, plus the words each workspace adds in Inbox settings (`stopWords` in the `inbox:settings:<tenantId>` row); a tap on a marketing template's "Stop promotions" button counts too. A Shopify marketing consent never sets the WhatsApp opt-in (owner default 2). The gate is central: `sendTemplateMessage` in `src/lib/inbox/service.ts` checks the contact and the template inside the function for every caller (HTTP 422, nothing queued), and the callers below also check earlier to give a better answer. The gate fails closed: a template the workspace has no row for (not synced, or synced only under another WhatsApp account) is treated as marketing, so it needs the opt-in too (the same name and language under another account of the workspace uses that row's category). STOP is checked again when the queued message is sent (`processSendJob` fails a marketing template, by the category stamped when it was queued, for a contact who opted out meanwhile with `opted_out`). Free-form messages (text, media, interactive) are different: they are allowed only inside the 24-hour window.

| Send path | Where it is gated | Behaviour for a non-opted-in contact | Tests |
|---|---|---|---|
| Inbox, new chat, conversation template | `inbox/template-send.ts`, then the central gate | 422 with a plain message | `tests/inbox-service.test.ts`, `tests/inbox-features.test.ts`, `tests/optin-gating.test.ts` |
| Broadcasts | audience filter, `sendOne`, then the central gate | recipient skipped, or failed if the contact changed since the audience was built | `tests/broadcasts.test.ts`, `tests/optin-gating.test.ts` |
| Automation rules | `sendTemplateAction`, then the central gate | action skipped with the reason | `tests/automation-v2-run.test.ts`, `tests/optin-gating.test.ts` |
| Chatbots (send template node) | `sendTemplateNode`, then the central gate | error path `no_opt_in` | `tests/chatbots-features.test.ts`, `tests/optin-chatbots.test.ts` (real gate) |
| Lead sequences | `sendStepTemplate`, then the central gate | step skipped | `tests/leads.test.ts`, `tests/optin-paths.test.ts` (real gate) |
| Abandoned cart reminders | `processCart`, then the central gate | cart marked `opted_out` | `tests/commerce.test.ts`, `tests/optin-paths.test.ts` (real gate) |
| Public API v1 (`sendMessageV1`) | `sendTemplateV1`, then the central gate | 422, and no contact is created | `tests/integrations-api.test.ts`, `tests/optin-gating.test.ts` |
| Compat (Wati-shaped) API | calls `sendMessageV1` | per-recipient error | `tests/compat-api.test.ts` |
| MCP (`send_template_message`) | tool check, then `sendMessageV1` | 422 | `tests/tenant-mcp.test.ts` |
| Approval links resend | `approvals/resend.ts`, then the central gate | 409 (422 from the gate) | `tests/approvals.test.ts`, `tests/optin-paths.test.ts` (real gate) |
| Platform admin test message | `admin/service.ts` (`sendTestMessage`, approved and variable-free templates only), then the central gate | 422 from the gate; the contact and chat created for the test are removed again | `tests/admin-test-message.test.ts` |
| Owner spending alerts (platform notifier) | `spend/notify/platform-sender.ts` (`sendNotifierTemplate`: verified owner channel, approved UTILITY template, TIER_250 room), then the central gate; the owner is an opted-in contact of the notifier workspace by their own consent on the Spending page | not sent; the notice stays in the app | `tests/spend-notify.test.ts`, `tests/spend-digest.test.ts` |

In the "real gate" tests the caller's own pre-check is made to pass (a stale snapshot of the contact, or a category it does not recognise) so that only the central gate can refuse; the older caller-level suites assert the pre-check only. `tests/optin-gating.test.ts` also scans `src` and fails if a new file calls `sendTemplateMessage`, or queues an outbound message, without being added to its list: a new send path must go through the central gate, appear in this table and get a test. Opt-in is recorded with source and time (`optInSource`, `optInAt`, audit rows); a STOP reply sets `optedOutAt`.

## 14. Meta App Review readiness for the WhatsApp permissions

The package for `whatsapp_business_messaging` and `whatsapp_business_management` (reviewer login steps, screencast script, test number instructions, pre-recording checklist) is `docs/app-review/whatsapp-production-readiness.md`; the per-permission texts are `docs/app-review/whatsapp_business_messaging.md` and `whatsapp_business_management.md`.

State (checked 2026-10-30): nothing is in review. The App Review submission is an unsubmitted draft (submission id 1799953447868194) with 22 items, and Submit stays disabled until every item has its description, screencast, API test calls and agreement. Until advanced access is granted, a Facebook account without a role on the app cannot connect a number (Embedded Signup answers "Feature unavailable"), so add people who must connect before then as app testers. Per-item state and the next steps: `docs/app-review/status.md`.

## 15. Spend controls and Eddy

Builders never edit `.env`. Ops sets the lines below in `/var/www/edwyz-wa/.env` (mode 600), runs `node scripts/check-env.mjs /var/www/edwyz-wa/.env`, and restarts with `pm2 startOrReload deploy/ecosystem.config.cjs --update-env`. The first release with these features follows `deploy/README-deploy.md` section C. Specs: `docs/SPEND-CONTROLS-SPEC.md` (spend) and `docs/EDDY-SPEC.md` (Eddy). Every rule below is in `src/lib/env-rules.mjs` and tested in `tests/ops-env.test.ts`; messages name variables only, never values.

### 15.1 Every new environment variable

Spend controls (spend spec 4.14). Unset means the default, which is the safe train 1 value.

| Variable | Default | Values | What it does | Startup check |
|---|---|---|---|---|
| `SPEND_ENFORCE` | `observe` | `observe`, `enforce` | People's actions only. `observe` lets through an action that only a NEW Phase 0 check would refuse, and writes a `refused` ledger row with `observe=true`. Checks enforced today stay enforced (a daily ads limit must be set, the daily limit, the currency, the AI monthly credits, PAUSED creates). Assistants are always enforced. | error on any other value |
| `SPEND_TRIPWIRE` | `report` | `report`, `enforce` | The transport tripwire (15.2). | error on any other value |
| `SPEND_CAP_MODE` | `off` | `off`, `observe`, `enforce` | Wall (a), Meta's own spending limit. `observe` computes the target and records it with no write to Meta. `enforce` only after the live runbook V1-V9 (`docs/spend-verification-runbook.md`) with the owner present. | error on any other value |
| `ASSISTANT_SPEND_ENABLED` | `false` | `false`, `true` | While false every assistant acts at Level 0 (suggestions only) and learning cannot end. Turned on only by the owner after the sandbox and shadow gate (spend spec 10.5). | error on any other value |
| `SPEND_DRY_RUN` | off | `0`/`1` (also `false`/`true`, `no`/`yes`, `off`/`on`) | No Meta writes; fake ids. Staging and e2e only. | error when on in production |
| `SPEND_SIM` | off | as above | Synthetic insights for sandbox (test) ad accounts only. | warning when on in production |
| `SPEND_NOTIFY_SECRET` | unset | 32+ random bytes, hex or base64 (`openssl rand -hex 32`) | Signs the WhatsApp quick-reply payloads (decline, opt-in) of owner notifications. Needed once owner notifications ship. | error when set but short or a placeholder; warning when it shares a value with another secret |
| `MAX_DAILY_BUDGET_MINOR` | unset | positive integer (deprecated) | Read as an INR platform daily ads ceiling of 1.75 x the value. Set the platform ceiling in `/admin/spending/settings` instead, then remove the line. | warning when set |

Eddy (Eddy spec 5.1, 5.10, 7.10, 12.1a).

| Variable | Default | Values | What it does | Startup check |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | unset | the key | Existing. Without it every AI feature, Eddy included, is off. | listed under OFF; warning in production when set without `EDDY_ANTHROPIC_KEY_DEDICATED=true` (with Eddy off too: the AI reply bot, inbox suggestions and creative copy spend on it) |
| `EDDY_ENABLED` | `false` | `false`, `true` | The platform switch. Each workspace owner still turns Eddy on in Settings (off by default, Eddy decision 6). | error on a typo; warning when `true` without `ANTHROPIC_API_KEY`; warning in production when `true` without `EDDY_ANTHROPIC_KEY_DEDICATED=true` |
| `EDDY_ANTHROPIC_KEY_DEDICATED` | `false` | `false`, `true` | The operator's statement that wa uses its own Anthropic key with a monthly spend limit set in the Anthropic console (spend decision 10, Eddy decision 14). Recommended to the owner, not a blocker: until then the gateway hard stop, the new-workspace AI limits and Eddy being off by default protect spend. | error on a typo |
| `EDDY_PHASE` | `1` | `1`, `2` | `2` allows v2 spending actions, only after the Phase 0 gates. | error on any other value |
| `EDDY_MODEL` | `claude-sonnet-5-5` | `claude-sonnet-5-5`, `claude-opus-5-5` | The model. Must also be on `AI_ALLOWED_MODELS` when that list is set. Changing it closes active conversations. | error |
| `AI_ALLOWED_MODELS` | unset (no list) | comma-separated model ids | When set, `EDDY_MODEL` must be on it; the deploy adds it. | via `EDDY_MODEL` |
| `EDDY_EFFORT` | `low` | `low`, `medium`, `high`, `xhigh`, `max` | Thinking effort. | error |
| `EDDY_MAX_TOKENS` | `8000` | 2000-128000 | Output tokens per round. | error |
| `EDDY_FALLBACKS` | `on` | `on`, `off` | Server-side fallback models on a refusal or overload. | error |
| `EDDY_TAIL_CACHE_TTL` | `5m` | `5m`, `1h` | Cache lifetime of each member's own history. | error |
| `EDDY_MICROUSD_PER_CREDIT` | `10000` | whole number 1+ | 1 credit = USD 0.01. | error |
| `EDDY_MAX_CREDITS_PER_USER_DAY` | `40` | whole number 1+ | Per member per day (10 with an unverified email). | error |
| `EDDY_MAX_CREDITS_PER_TURN` | `30` | whole number 1+ | Per turn. | error |
| `EDDY_MAX_CONCURRENT_TURNS` | `40` | 1-10000 | Turns streaming at once on the web instance. | error |
| `EDDY_PRICES` | unset | JSON `{"<model>": {"input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"}}` in USD per million tokens, 0-1000 each | Overrides the price table in `src/lib/spend/exec/ai-pricing.ts` (verify Sonnet 5.5's cache-read price before launch). | error when it does not parse |
| `EDDY_INJECTION_SCREEN` | `off` | `off`, `on` | The optional Haiku injection screen; each screen call goes through the gateway and counts in the turn. | error |
| `EDDY_FAKE_MODEL` | unset | `scripted` | The scripted model for e2e and staging. | error in production |

`.env.example` lists every variable in these tables (and `CSP_MODE`, `ENV_STRICT`, `LOG_LEVEL`, `RATELIMIT_BACKEND`) with its safe default or an empty line, and no longer lists `MAX_DAILY_BUDGET_MINOR`; `tests/ops-observability.test.ts` fails when a variable the env rules check is missing from it, or when it does not pass `checkEnv` apart from the secrets it leaves empty.

### 15.2 The spend tripwire (`SPEND_TRIPWIRE`, spend spec 4.7)

Every Graph request passes `tripwire()` in `run()` of `src/lib/graph/index.ts` before any network I/O. A write that could raise spend (turning an ad object on, a budget, a later end, a create, Meta's spending limit, a WhatsApp send) needs a permit from the Spend Book. Pausing and archiving are never blocked.

- `report` (train 1): the request goes out as before and an AuditLog row `spend.tripwire.bypass` is written. A pause without a permit is written as `spend.tripwire.unledgered_lowering` and always goes out. Rows carry the path pattern (`act_{id}/campaigns`), the class and a reason code, never a token, an id or a body.
- Count the rows of the last 7 days:
  ```sql
  SELECT action, target, meta->>'class' AS class, meta->>'reason' AS reason, count(*)
  FROM "AuditLog" WHERE action LIKE 'spend.tripwire.%' AND "createdAt" > now() - interval '7 days'
  GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC;
  ```
  Each `spend.tripwire.bypass` row is a call site that skips the Spend Book: route it through the book (it then carries a permit). Never silence it.
- Switch to `enforce` only after 7 days in a row with zero `spend.tripwire.bypass` rows, and record the date in MIGRATIONS-APPLIED. In `enforce` an unpermitted raise fails with HTTP 500, code `spend_bypass` ("This change was stopped by a spending safety check, and nothing was sent to Meta.") and nothing reaches Meta.
- Way back: `SPEND_TRIPWIRE=report` and a restart.

The static twin is `tests/spend-bypass.test.ts` (spend spec 4.12): it runs in `npm test`, in CI before `next build` (`.github/workflows/wa-ci.yml` at the repository root), and in the deploy runbook before the release build (`deploy/README-deploy.md` A step 1); `npm run build` on its own does not run it. Each allowlist entry carries a reason. Rule B2 still allows the three old Anthropic callers until WP-13 moves them behind the gateway.

### 15.3 Eddy runbook (Eddy spec 7.10)

**Turn Eddy on for the platform.** Before: `ANTHROPIC_API_KEY` is set; preferably wa has its own Anthropic key with a monthly spend limit in the Anthropic console (sum of plan credits plus a margin) and `EDDY_ANTHROPIC_KEY_DEDICATED=true`; `EDDY_MODEL` is on `AI_ALLOWED_MODELS`; the nginx blocks are installed and the staging `curl -N --compressed` check in section 9 passed; the privacy and terms copy is published. Then set `EDDY_ENABLED=true`, run `check-env.mjs` and restart. Owners then switch Eddy on per workspace in Settings.

**Set or rotate the key.** Edit `.env` and restart. A wrong key makes the gateway's authentication check fail; Eddy shows "paused" for 5 minutes at a time and the logs say why. Never paste the key into a ticket, a chat or a log.

**Change the model.** Add the new id to `AI_ALLOWED_MODELS` first, then set `EDDY_MODEL` (`claude-opus-5-5` is the one-env alternative) and restart. Active conversations close and start fresh, because caches belong to one model. Then check the prefix measurement below.

**Platform kill switch.** Stops new turns in every workspace at once. Cards that spend nothing can still be confirmed; spending cards re-check the spend controls when confirmed.

```sql
INSERT INTO "PlatformSetting" (key, value, "updatedAt") VALUES ('eddy:platform', '{"enabled": false, "reason": "Anthropic outage"}', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();
-- back on
UPDATE "PlatformSetting" SET value = '{"enabled": true}', "updatedAt" = now() WHERE key = 'eddy:platform';
```

Members see the "paused" message, never "still being set up". A workspace's own switch is the owner's, in Settings. The spend controls' stops also apply to Eddy's spending cards; under "stop all spending" Eddy itself keeps working within the AI limit, because a person asked.

**Measure the prefix after a deploy.** Each deploy that changes Eddy's tools, prompt or model re-measures the shared prefix with the free `count_tokens` endpoint into `eddy:prefix-tokens:<model>:<roleClass>`. Check that the rows are newer than the deploy:

```sql
SELECT key, value, "updatedAt" FROM "PlatformSetting" WHERE key LIKE 'eddy:prefix-tokens:%' OR key LIKE 'eddy:prefix-warm:%' ORDER BY key;
```

Missing or old rows make holds assume a cold prefix: members are never under-charged, but holds are larger.

**Credits per turn and the cache-read share** (from `EddyTurn`):

```sql
SELECT date_trunc('day', "startedAt") AS day, model, count(*) AS turns,
       round(avg("creditsCharged"), 1) AS credits_per_turn,
       round(100.0 * sum("cacheReadTokens") / nullif(sum("inputTokens" + "cacheReadTokens" + "cacheWriteTokens"), 0), 1) AS cache_read_pct,
       round(sum("platformMicroUsd") / 1e6, 2) AS platform_usd
FROM "EddyTurn" WHERE "startedAt" > now() - interval '7 days'
GROUP BY 1, 2 ORDER BY 1 DESC, 2;

SELECT status, coalesce("errorCode", "refusalCategory", "stopReason") AS why, count(*)
FROM "EddyTurn" WHERE "startedAt" > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 3 DESC;
```

A cache-read share that drops sharply right after a deploy means the shared prefix stopped being identical across workspaces; compare it with the previous release before anything else. `platform_usd` is the shared prefix write the platform pays (Eddy decision 13).

**Reconcile `unknown` actions.** A confirmed action that timed out, or got a 5xx after it reached Meta, is stored as `unknown`. It is never retried; the `actions.reconcile` job reads the real state (message status, broadcast status, template status), settles it to `done` or `failed` and tells the member.

```sql
SELECT action, count(*), min("updatedAt") AS oldest FROM "ActionRecord" WHERE status = 'unknown' GROUP BY action ORDER BY 3;
```

Rows older than 15 minutes mean the job is not running: check `/health` (worker state) and the tick cron (section 1.1). Never re-send by hand and never edit these rows; if the real state cannot be read (for example an expired token), the row stays `unknown` and the member's card says the result is still being checked.

**Anthropic outage, or the console spend limit reached.** Turns end with an error, and the AI reply bot hands chats to people. Eddy stays usable as plain buttons; failed calls release their credit holds, so nobody is charged. Steps: set the platform kill switch with a reason; when Anthropic's status is green again (or the owner approves a higher console limit), clear it and watch the second query above for 15 minutes. Switch models during an outage only when it affects one model and the other is on `AI_ALLOWED_MODELS`.

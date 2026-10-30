# Deploy runbook: wa.edwyz.com

Facts for the current (shared) VPS: app in `/var/www/edwyz-wa`, pm2 process `edwyz-wa` on port 3500 (started as `node --env-file=.env server.js`), database `edwyz_wa` with role `edwyz_wa_app` inside the shared Postgres 17, the worker daemon as the second pm2 app `edwyz-wa-worker` (polls every 2 seconds), with `/etc/cron.d/edwyz-wa` calling `/api/internal/tick` every minute kept as the fallback, nginx site `deploy/nginx-wa.edwyz.com.conf`, zones `deploy/nginx-wa-zones.conf` in `/etc/nginx/conf.d/wa-zones.conf`. Five other tenants share this machine: never touch their pm2 apps, nginx files or databases, and delete nothing (old releases, backups and logs are pruned by the owner, not by a deploy). Details of every feature named below are in `docs/ops.md`.

Rules that always apply:

- Run the web app as exactly one pm2 instance (rate limits and replay guards are per process until the shared limiter is adopted; `docs/ops.md` section 1 and 2). `deploy/ecosystem.config.cjs` defines exactly two apps, `edwyz-wa` and `edwyz-wa-worker`, one fork-mode instance each; it never mentions other tenants' apps.
- Keep the every-minute tick cron even though the worker daemon runs: it is the documented fallback if the daemon stops. While the daemon's heartbeat (`worker:daemon`) is under a minute old the tick processes nothing and answers `skipped`, so the two never work side by side; `alert-wa.sh` reports a dead daemon (`ALERT_EXPECT_DAEMON=0` on a host without one) (`docs/ops.md` 1.1).
- `CREATIVE_MEDIA_SECRET` and `CONTENT_MEDIA_SECRET` are required in production (32+ random bytes, hex or base64).
- Scripts must have LF line endings. If they were edited on Windows: `sed -i 's/\r$//' file`.

## A. Update the running site

### 1. Before you start (your machine)

```
npm test                                  # or at least the suites for what changed
npx tsc --noEmit                          # no errors in files you touched
npx vitest run tests/spend-bypass.test.ts tests/deploy-nginx-eddy.test.ts   # ALWAYS, and before the build: stop here if either fails
node scripts/check-env.mjs <copy of the production .env>   # needs a copy; never commit it
SITE_URL=https://wa.edwyz.com npm run build
```

`tests/spend-bypass.test.ts` is the spend controls' static build gate (docs/SPEND-CONTROLS-SPEC.md 4.12): it fails when new code calls Meta, Anthropic or another paid endpoint outside the Spend Book, writes spend tables directly, or forges a permit. It runs before `next build` on every deploy, even when you only ran some suites above. Do not add an allowlist entry to make it pass; route the call through the book or the gateway instead. `tests/deploy-nginx-eddy.test.ts` checks the nginx blocks Eddy needs (section C).

`SITE_URL` must be the public address while `next build` runs: the home page and other static pages are rendered once, at build time, and their canonical, og:url and JSON-LD links are frozen into the release. A workstation `.env` with `SITE_URL=http://localhost:3500` is ignored by the build for exactly this reason (see `siteUrl()` in `src/lib/config.ts`), but set it explicitly anyway so a staging build gets its own address. `robots.txt` and `sitemap.xml` are rendered per request and follow the server's `.env`.

Build a release folder (nothing is deleted anywhere; it is a new folder):

```
REL=release-$(date -u +%Y%m%dT%H%MZ); mkdir -p "../$REL"
cp -r .next/standalone/. "../$REL/"
mkdir -p "../$REL/.next" && cp -r .next/static "../$REL/.next/static"
cp -r public "../$REL/public" 2>/dev/null || true
mkdir -p "../$REL/scripts" "../$REL/src/lib" "../$REL/deploy"
cp scripts/check-env.mjs "../$REL/scripts/"; cp src/lib/env-rules.mjs "../$REL/src/lib/"
node deploy/build-worker.mjs "../$REL/worker/index.mjs" --check "../$REL"      # the worker daemon, one file; fails if the release's node_modules lacks a package it imports
npx esbuild scripts/spend-backfill-commitments.ts --bundle --platform=node --format=esm --target=node20 --packages=external --log-level=warning --outfile="../$REL/scripts/spend-backfill-commitments.mjs"   # train 1 only (section C step 4)
cp deploy/backup-wa.sh deploy/restore-check-wa.sh deploy/alert-wa.sh deploy/cron-wa-backup deploy/cron-wa-tick deploy/cron-wa-alert deploy/edwyz-wa-alert.conf.example deploy/ecosystem.config.cjs deploy/nginx-*.conf "../$REL/deploy/"
cp -r prisma/migrations "../$REL/prisma-migrations"
tar czf "../$REL.tgz" -C ".." "$REL"
```

Upload `../$REL.tgz` to `/root/releases/` on the VPS (create the folder once; keep old releases).

### 2. Back up on the server (before changing anything)

```
df -h /root /var/www                                  # need a few hundred MB free
/usr/local/sbin/backup-wa.sh                          # database dump, prints the size; stop here if it fails
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
install -m 600 /var/www/edwyz-wa/.env /root/backups/wa/env-$STAMP          # backup the env
tar czf /root/backups/wa/app-$STAMP.tgz -C /var/www edwyz-wa && chmod 600 /root/backups/wa/app-$STAMP.tgz   # previous release, for rollback
```

### 3. Unpack the release next to the live one

```
cd /root/releases && tar xzf $REL.tgz
```

### 4. Check the environment

```
node /root/releases/$REL/scripts/check-env.mjs /var/www/edwyz-wa/.env
```

Fix every `ERROR` line first (edit `.env`, mode 600). `WARN` lines for values the owner still has to provide (Meta secrets, SMTP, Razorpay) are expected until those are set; read them anyway.

### 5. Migrate with psql, in order

Migrations on this server were applied by hand, not with `prisma migrate`, so there is no `_prisma_migrations` ledger. Keep one by hand in `/var/www/edwyz-wa/MIGRATIONS-APPLIED` (one folder name per line). The first time, create it from what is already live: `0001_init`, `0002_platform`, `0003_security_accounts`, `0004_phase2` (applied at the first deploy) and confirm against `\dt` before relying on it.

```
cd /root/releases/$REL/prisma-migrations
for m in $(ls -d 0*/ | tr -d /); do grep -qx "$m" /var/www/edwyz-wa/MIGRATIONS-APPLIED || echo "pending: $m"; done
```

Apply each pending folder, oldest first, one at a time, stopping at the first failure. Run as the app role so new tables belong to it:

```
sudo -u postgres env PGOPTIONS='-c role=edwyz_wa_app' psql -d edwyz_wa -v ON_ERROR_STOP=1 -1 -f 0005_growth/migration.sql \
  && echo 0005_growth >> /var/www/edwyz-wa/MIGRATIONS-APPLIED
```

Exception: `0010_spend_message_indexes` is applied WITHOUT `-1`, off-peak, after the restart (section C). `0009_spend_controls` and `0010` follow the order in section C, not this loop. `0011_template_flagged` (one `ALTER TYPE ... ADD VALUE`, safe to repeat) goes through this loop like any other; until it is applied, a template Meta flags is stored as paused (the stricter state).

Never edit an applied migration and never skip one. A failed migration rolls back (single transaction); fix the cause and run it again. Afterwards check ownership: `sudo -u postgres psql -d edwyz_wa -Atc "select tablename from pg_tables where schemaname='public' and tableowner<>'edwyz_wa_app'"` must print nothing. Migrations are forward only: the way back is the database backup from step 2 (`docs/ops.md` 8.3).

### 6. Swap in the new files and restart

```
cd /root/releases/$REL
cp -r . /var/www/edwyz-wa/            # overwrites app files; .env, data/ and logs are not in the release, so they stay
pm2 startOrReload deploy/ecosystem.config.cjs --update-env && pm2 save    # web and worker, one instance each
pm2 list | grep edwyz-wa              # edwyz-wa and edwyz-wa-worker, both online, one instance each
```

The worker stops gracefully (it finishes the pass in progress, up to 30 s). Run the command from `/var/www/edwyz-wa` so `cwd` resolves; set `WA_APP_DIR` if the app lives elsewhere.

Old build chunks stay behind in `/var/www/edwyz-wa/.next`; that is harmless and is for the owner to prune.

First install only: `cd /var/www/edwyz-wa && pm2 start deploy/ecosystem.config.cjs && pm2 save` (this replaces `pm2 start server.js --name edwyz-wa`; if `edwyz-wa` is already running that way, `pm2 delete edwyz-wa` first, in the same minute), then install the cron files (step 8).

### 7. Verify

```
curl -fsS http://127.0.0.1:3500/health/ready          # {"status":"ready",...}
curl -fsS http://127.0.0.1:3500/health                # status ok, db.rttMs small, worker.state ok
curl -fsS https://wa.edwyz.com/health/ready
curl -fsSI https://wa.edwyz.com/ | grep -i 'content-security-policy\|x-request-id'
pm2 logs edwyz-wa --lines 60 --nostream | grep -E 'startup|env\.(invalid|warning)'
pm2 logs edwyz-wa-worker --lines 20 --nostream | grep -E 'worker\] (started|pass failed)'     # "started" and no repeated failures
sleep 15; curl -fsS http://127.0.0.1:3500/health | grep -o '"lastTickAgeSeconds":[0-9]*'   # a small number (the daemon writes the heartbeat every 10 s)
. <(grep ^WORKER_SECRET= /var/www/edwyz-wa/.env | sed 's/^/export /')       # loads the secret without printing it
curl -fsS -X POST -H "x-worker-secret: $WORKER_SECRET" http://127.0.0.1:3500/api/internal/tick
curl -fsS -H "x-worker-secret: $WORKER_SECRET" http://127.0.0.1:3500/api/internal/metrics
```

Then in a browser: the landing page, log in, open the inbox. Expected: no `env.invalid` lines, `failed` and `oldestDueSeconds` at 0 or small in metrics, `csp.violations` lines (if any) understood. If `/health/ready` is not 200 or the site is broken, roll back (step 9).

### 8. Install or refresh the ops files (first time, and when they change)

```
install -m 755 /root/releases/$REL/deploy/backup-wa.sh /usr/local/sbin/backup-wa.sh
install -m 644 /root/releases/$REL/deploy/cron-wa-backup /etc/cron.d/edwyz-wa-backup
install -m 644 /root/releases/$REL/deploy/cron-wa-tick /etc/cron.d/edwyz-wa                  # fallback tick, every minute (keep it)
install -m 755 /root/releases/$REL/deploy/alert-wa.sh /usr/local/sbin/alert-wa.sh
install -m 644 /root/releases/$REL/deploy/cron-wa-alert /etc/cron.d/edwyz-wa-alert           # every 5 minutes, logs to /var/log/edwyz-wa-alert.log
[ -e /etc/edwyz-wa-alert.conf ] || install -m 600 /root/releases/$REL/deploy/edwyz-wa-alert.conf.example /etc/edwyz-wa-alert.conf   # set ALERT_EMAIL here to turn mail on
install -m 755 /root/releases/$REL/deploy/restore-check-wa.sh /usr/local/sbin/restore-check-wa.sh
/usr/local/sbin/alert-wa.sh --test && tail -n 2 /var/log/edwyz-wa-alert.log
cp /root/releases/$REL/deploy/nginx-wa-zones.conf /etc/nginx/conf.d/wa-zones.conf       # http block, needed before the site file
cp /root/releases/$REL/deploy/nginx-wa.edwyz.com.conf /etc/nginx/sites-available/wa.edwyz.com   # match the file name already used here
nginx -t && systemctl reload nginx                    # only reload if the test passes
```

Rate limits, body limits and the optional lock-down of `/api/internal/` are described in `docs/ops.md` section 9. The zones file defines `wa_eddy` (Eddy, `/api/actions/`, `/api/notices/`); copy it BEFORE the site file, or `nginx -t` fails on the unknown zone.

### 9. Roll back

```
pm2 stop edwyz-wa edwyz-wa-worker 2>/dev/null || pm2 stop edwyz-wa       # the old release may not have a worker app; the tick cron keeps work moving
tar xzf /root/backups/wa/app-$STAMP.tgz -C /var/www       # restores the previous files over the new ones
pm2 restart edwyz-wa --update-env
pm2 restart edwyz-wa-worker --update-env 2>/dev/null || true
```

If a migration was applied and the old code cannot run against it, restore the database as well (`docs/ops.md` 8.3: restore the step 2 dump into a new database and rename). Restore `.env` from `/root/backups/wa/env-$STAMP` only if you changed it.

## C. Spend controls and Eddy: the train 1 release (docs/SPEND-CONTROLS-SPEC.md 3.2.1 and 11)

This is the first release with `0009_spend_controls` (spend tables, the append-only ledger, Eddy's tables) and `0010_spend_message_indexes`. 0009 is the first migration with a FUNCTION and TRIGGERs. It is additive only (no drop, rename, retype or update of an existing row), so the running build keeps working on the new schema. Do these steps in this order, inside section A (they replace A step 5 for 0009 and 0010):

1. **Back up and check the backup carries the triggers** (A step 2). `pg_dump --format=plain` writes functions and triggers by default. Once 0009 is applied, every later dump must show them; check the first dump after this release:
   ```
   zcat /root/backups/wa/<newest>.sql.gz | grep -cE '^CREATE (OR REPLACE )?FUNCTION public\.edwyz_(append_only|action_invocation_guard)'   # 2
   zcat /root/backups/wa/<newest>.sql.gz | grep -cE '^CREATE TRIGGER "(SpendLedger|SpendConsent|EddyMessage|ActionInvocation)_'          # 8
   ```
   `restore-check-wa.sh` (docs/ops.md 8.5) restores a dump into a scratch database; after this release, also run `UPDATE "SpendLedger" SET reason = reason WHERE false;` there: it must succeed (no rows), and `TRUNCATE "SpendLedger";` must fail with 42501, which proves the restored triggers work.
2. **Check the Postgres version**: `sudo -u postgres psql -d edwyz_wa -Atc 'SHOW server_version'` must print 11 or later (this server runs 17). Below 11, stop: the new column defaults would rewrite tables.
3. **Apply 0009 WITH `-1`**, as the app role, like A step 5:
   ```
   cd /root/releases/$REL/prisma-migrations
   sudo -u postgres env PGOPTIONS='-c role=edwyz_wa_app' psql -d edwyz_wa -v ON_ERROR_STOP=1 -1 -f 0009_spend_controls/migration.sql \
     && echo 0009_spend_controls >> /var/www/edwyz-wa/MIGRATIONS-APPLIED
   ```
   The file starts with `SET LOCAL lock_timeout = '5s'`: if a busy table cannot be locked within 5 s the whole file rolls back and nothing is applied. Retry off-peak. Record the run time of the file in MIGRATIONS-APPLIED next to its name.
4. **Run the commitments backfill from the new release, while the old build still serves**, so the first request on the new code already counts every running campaign:
   ```
   cd /root/releases/$REL
   node --env-file=/var/www/edwyz-wa/.env scripts/spend-backfill-commitments.mjs --dry-run   # prints what it would add
   node --env-file=/var/www/edwyz-wa/.env scripts/spend-backfill-commitments.mjs             # idempotent: a second run adds nothing
   ```
   If it fails, carry on: the book counts any active campaign without a commitment (the orphan rule, spec 4.6), and the reconciler writes the row later. Note it in MIGRATIONS-APPLIED.
5. **Set the train 1 flags** in `/var/www/edwyz-wa/.env` (mode 600), then run `check-env.mjs` (A step 4). These are also the defaults when the lines are absent:
   ```
   SPEND_ENFORCE=observe
   SPEND_TRIPWIRE=report
   SPEND_CAP_MODE=off
   ASSISTANT_SPEND_ENABLED=false
   EDDY_ENABLED=false
   ```
   `SPEND_DRY_RUN` and `EDDY_FAKE_MODEL` must not be set in production (check-env refuses them). The full list of new variables is in `docs/ops.md` section 15.
6. **Restart web and worker on the new build** (A step 6), then verify (A step 7).
7. **Install the nginx changes** (A step 8): zones file first (`wa_eddy`), then the site file, `nginx -t && systemctl reload nginx`.
8. **Apply 0010 WITHOUT `-1`, off-peak**, the same day or later. `CREATE INDEX CONCURRENTLY` cannot run in a transaction block, and it does not block sends or webhooks while it builds:
   ```
   sudo -u postgres env PGOPTIONS='-c role=edwyz_wa_app' psql -d edwyz_wa -v ON_ERROR_STOP=1 -f 0010_spend_message_indexes/migration.sql \
     && echo 0010_spend_message_indexes >> /var/www/edwyz-wa/MIGRATIONS-APPLIED
   ```
   If a concurrent build fails it leaves an INVALID index. Find it with `select indexrelid::regclass from pg_index where not indisvalid;`, drop that one with `DROP INDEX CONCURRENTLY "<name>";` and run the file again (every statement is safe to repeat). The app works without these indexes, only more slowly.

Rolling back train 1 means redeploying the previous build (A step 9). Keep the schema: the old code ignores the new tables and columns. Never drop the spend tables, and never `DISABLE TRIGGER` on the ledger.

Later flag flips (spec 11, train 4) happen only with their preconditions, recorded in MIGRATIONS-APPLIED: `SPEND_TRIPWIRE=enforce` after 7 days with zero `spend.tripwire.bypass` audit rows (query in `docs/ops.md` section 15), `SPEND_ENFORCE=enforce` after 7 days of observe, `SPEND_CAP_MODE=enforce` after the live runbook V1-V9, `ASSISTANT_SPEND_ENABLED=true` only after the owner signs off the sandbox and shadow gate.

## B. Move to an independent server later

The app has no state outside Postgres and `DATA_DIR`, so a move is a restore plus a DNS change. Use the same hostname, so the Meta webhook URL, redirect URIs and Embedded Signup configuration need no change.

1. Provision: Ubuntu LTS, Node (same major version as now), pm2, nginx, certbot, Postgres of the same major version (17), a firewall allowing only 22, 80 and 443, unattended security updates. Lower the DNS TTL of `wa.edwyz.com` to 300 seconds a day ahead.
2. Create the role and database: `createuser edwyz_wa_app`, `createdb -O edwyz_wa_app edwyz_wa`, give the role a new password. Postgres listens on localhost only.
3. Copy from the old server, over a private channel: the newest dump, `.env`, and the `DATA_DIR` folder. Keep `ENCRYPTION_KEY`, `SESSION_SECRET`, `STATE_SECRET`, `WORKER_SECRET` and both media secrets unchanged (a new `ENCRYPTION_KEY` makes every stored Meta token unreadable). Update only `DATABASE_URL` and `DATA_DIR`.
4. Restore into the empty database (`docs/ops.md` 8.2) and run `node scripts/check-env.mjs <env>`.
5. Install the release exactly as in A (steps 3, 6, 8), start the two pm2 apps from `deploy/ecosystem.config.cjs` (one instance each), enable `pm2 startup`, install the tick cron (fallback) (`* * * * * root curl -fsS -X POST -H "x-worker-secret: ..." http://127.0.0.1:3500/api/internal/tick`, with the secret read from the env file, not typed into the cron line), the backup cron, the alert cron (`alert-wa.sh`) and log rotation. Obtain the certificate with certbot (use the DNS challenge until DNS points here, or temporary hosts-file testing).
6. Test on the new server with `curl --resolve wa.edwyz.com:443:<new ip> https://wa.edwyz.com/health/ready` and a login.
7. Cutover window: on the old server stop the tick cron and `pm2 stop edwyz-wa edwyz-wa-worker`; take a final `backup-wa.sh`; copy and restore it into a fresh database on the new server (or a delta of `DATA_DIR`); start the app; change the DNS A record. Meta retries webhooks that fail during the window, so nothing is lost.
8. Afterwards: watch `/health`, the metrics endpoint and the logs for a day; confirm the first nightly backup ran on the new server and run `/usr/local/sbin/restore-check-wa.sh` (`docs/ops.md` 8.5). Keep the old server stopped but intact for a week, then let the owner decide on removal. On the old shared VPS nothing needs cleaning for the other tenants; only the `edwyz-wa` pm2 app, its cron files, nginx site and database are involved.
9. If the independent server runs more than one app instance later, first switch every limiter in `docs/ops.md` section 2 to `@/lib/ratelimit` and handle the remaining per-process state listed there.

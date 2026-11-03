# Deploy runbook: wa.edwyz.com

Facts for the current (shared) VPS: app in `/var/www/edwyz-wa`, pm2 process `edwyz-wa` on port 3500 (started as `node --env-file=.env server.js`), database `edwyz_wa` with role `edwyz_wa_app` inside the shared Postgres 17, the worker daemon as the second pm2 app `edwyz-wa-worker` (polls every 2 seconds), with `/etc/cron.d/edwyz-wa` calling `/api/internal/tick` every minute kept as the fallback, nginx site `deploy/nginx-wa.edwyz.com.conf`, zones `deploy/nginx-wa-zones.conf` in `/etc/nginx/conf.d/wa-zones.conf`. Five other tenants share this machine: never touch their pm2 apps, nginx files or databases, and delete nothing (old releases, backups and logs are pruned by the owner, not by a deploy). Details of every feature named below are in `docs/ops.md`.

Rules that always apply:

- Run the web app as exactly one pm2 instance (rate limits are shared through Postgres, but the replay guards, the live inbox connection count and the AI reply guard are per process; `docs/ops.md` section 1 and 2). `deploy/ecosystem.config.cjs` defines exactly two apps, `edwyz-wa` and `edwyz-wa-worker`, one fork-mode instance each; it never mentions other tenants' apps.
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

CI does the same three checks on GitHub for every push to `main` and every pull request that touches `wa/`: `.github/workflows/wa-ci.yml` at the repository root (GitHub only reads workflows there) runs `tsc`, the unit project of vitest (spend-bypass included) and `next build`. A green run does not replace this step: it builds with no `.env`, so `check-env` and the build for the release still happen here.

`SITE_URL` must be the public address while `next build` runs. The public and sign-in pages are rendered per request (`src/app/(site)/layout.tsx` and `src/app/(auth)/layout.tsx` are force-dynamic) and follow the server's `.env`, but the pages Next still prerenders (`/offline`, the 404 page and the web app manifest) are rendered once, at build time, with the links of that moment frozen into the release. A workstation `.env` with `SITE_URL=http://localhost:3500` is ignored by the build for exactly this reason (see `siteUrl()` in `src/lib/config.ts`), but set it explicitly anyway so a staging build gets its own address. `robots.txt` and `sitemap.xml` are rendered per request too.

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
cp deploy/backup-wa.sh deploy/restore-check-wa.sh deploy/alert-wa.sh deploy/cron-wa-backup deploy/cron-wa-tick deploy/cron-wa-alert deploy/edwyz-wa-alert.conf.example deploy/logrotate-edwyz-wa deploy/ecosystem.config.cjs deploy/nginx-*.conf "../$REL/deploy/"
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

Exception: `0010_spend_message_indexes` is applied WITHOUT `-1`, off-peak, after the restart (section C). `0009_spend_controls` and `0010` follow the order in section C, not this loop. `0011_template_flagged` (one `ALTER TYPE ... ADD VALUE`, safe to repeat) goes through this loop like any other; until it is applied, a template Meta flags is stored as paused (the stricter state). `0012_ig_page_ads` and `0013_ig_page_ads_indexes` follow the order in section D: 0012 with `-1` before the restart, 0013 WITHOUT `-1`, off-peak, after it.

`/health/ready` checks the newest migration the code needs: `LATEST_MIGRATION` in `src/app/health/checks.ts` names that folder and something only it creates (today the `InsightBreakdown` table from `0012_ig_page_ads`). Index-only follow-ups such as `0013_ig_page_ads_indexes` (only `CREATE INDEX CONCURRENTLY` and `VALIDATE CONSTRAINT`) are applied off-peak after the restart, so the marker never waits for them. A release whose needed migration was not applied answers 503 with `"migrations": false` in step 7. Whoever adds a migration updates that constant in the same change (`tests/ops-health.test.ts` fails until they match).

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

Then in a browser: the landing page, log in, open the inbox. Expected: no `env.invalid` lines, `failed` and `oldestDueSeconds` at 0 or small in metrics, `csp.violations` lines (if any) understood. If `/health/ready` is not 200 or the site is broken, roll back (step 9); `"migrations": false` alone means the newest migration is missing: apply it (step 5) instead of rolling back.

Errors after the release: a 500 from an API route is logged as `api.unexpected` and its response carries `x-request-id`, which is also in the log line (`pm2 logs edwyz-wa --nostream --lines 2000 | grep <id>`); a page or route that crashes past its own handler is logged as `request.unhandled` with the route pattern and the digest the error page shows. `docs/ops.md` section 4.

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
install -m 644 /root/releases/$REL/deploy/logrotate-edwyz-wa /etc/logrotate.d/edwyz-wa && logrotate -d /etc/logrotate.d/edwyz-wa   # wa's own logs only (8.1)
cp /root/releases/$REL/deploy/nginx-wa-zones.conf /etc/nginx/conf.d/wa-zones.conf       # http block, needed before the site file
cp /root/releases/$REL/deploy/nginx-wa.edwyz.com.conf /etc/nginx/sites-available/wa.edwyz.com   # match the file name already used here
nginx -t && systemctl reload nginx                    # only reload if the test passes
```

Rate limits, body limits and the optional lock-down of `/api/internal/` are described in `docs/ops.md` section 9. The zones file defines `wa_eddy` (Eddy, `/api/actions/`, `/api/notices/`); copy it BEFORE the site file, or `nginx -t` fails on the unknown zone.

#### 8.1 Log rotation (a release step; the first install needs the owner's yes)

Without rotation the logs only grow: `alert-wa.sh` appends a line every 5 minutes and pm2 keeps every line both apps ever printed, on a disk that is already above the alert threshold. Rotation deletes the oldest rotated files, so the first install needed the owner's yes (the "delete nothing" rule above); the owner gave it on 2026-10-31 for wa's own logs only. It is part of every release and changes nothing when already in place.

- `/etc/logrotate.d/edwyz-wa` (the `install` line above): weekly or at 20 MB, 8 compressed generations of `/var/log/edwyz-wa-*.log`, which are wa's own cron logs only. `logrotate -d` is a dry run that prints what would happen and changes nothing.
- pm2's logs of the two apps (`/root/.pm2/logs/edwyz-wa-out.log`, `edwyz-wa-error.log` and the worker's): the second block of the same file, daily or at 20 MB, 14 compressed files kept, with `copytruncate` because pm2 keeps those files open. Not pm2-logrotate: that is a module of the whole pm2 daemon and on this shared VPS it would also rotate the other tenants' pm2 logs, which the owner did not want. On a dedicated server either works; use one of the two, never both.

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

## D. Instagram and Facebook Page ads: 0012 and 0013, flags and trains (docs/IG-PAGE-ADS-SPEC.md 1.4, 5.2, 9.7)

The first release of this workstream (train P1) adds `0012_ig_page_ads` (new columns on AdCampaign, AdSet, Ad, Lead, LeadForm and InsightSnapshot, and the tables AdMedia, AdAudience, AdAudienceUpload, AdTest and InsightBreakdown) and `0013_ig_page_ads_indexes` (indexes and CHECK validation). Both are additive only. Every new column is nullable or has a constant default, and the CHECKs on existing tables are added NOT VALID, so the previous build keeps working on the new schema. The feature ships dark: with `PROMOTE_ENABLED` unset, every `/api/promote` route answers 404 and the promote worker tasks return without touching the database.

Deploy order (these steps replace A step 5 for 0012 and 0013):

1. **Back up** (A step 2).
2. **Apply 0012 WITH `-1`**, as the app role:
   ```
   cd /root/releases/$REL/prisma-migrations
   sudo -u postgres env PGOPTIONS='-c role=edwyz_wa_app' psql -d edwyz_wa -v ON_ERROR_STOP=1 -1 -f 0012_ig_page_ads/migration.sql \
     && echo 0012_ig_page_ads >> /var/www/edwyz-wa/MIGRATIONS-APPLIED
   ```
   The file starts with `SET LOCAL lock_timeout = '5s'` and `statement_timeout = '120s'`: if a busy table cannot be locked in time, the whole file rolls back and nothing is applied. Retry off-peak.
3. **Build and restart web and worker** on the new release (A step 6), then verify (A step 7). `/health/ready` needs 0012 (its marker is the `InsightBreakdown` table), not 0013.
4. **Apply 0013 WITHOUT `-1`, off-peak**, the same day or later. `CREATE INDEX CONCURRENTLY` cannot run in a transaction block; `VALIDATE CONSTRAINT` lets reads and writes go on while it scans:
   ```
   sudo -u postgres env PGOPTIONS='-c role=edwyz_wa_app' psql -d edwyz_wa -v ON_ERROR_STOP=1 -f 0013_ig_page_ads_indexes/migration.sql \
     && echo 0013_ig_page_ads_indexes >> /var/www/edwyz-wa/MIGRATIONS-APPLIED
   ```
   Every statement is safe to repeat. A failed concurrent build leaves an INVALID index: find it with `select indexrelid::regclass from pg_index where not indisvalid;`, drop that one with `DROP INDEX CONCURRENTLY "<name>";` and run the file again. Afterwards `select conname from pg_constraint where not convalidated;` must not list any constraint named in 0012.

Rolling back means redeploying the previous build (A step 9). Keep the schema: the old code ignores the new columns and tables. Never drop them.

### D.1 Flags

Set them in `/var/www/edwyz-wa/.env` (mode 600), then run `check-env.mjs` (A step 4). Unset means the default. Values are read trimmed and in any case; `check-env` refuses a value that is not listed, so a typo cannot quietly leave a gate open or shut.

| Variable | Values | Default | What it does |
|---|---|---|---|
| `PROMOTE_ENABLED` | `off`, `admins`, `on` | `off` | The master switch. `admins`: only Edwyz platform admins see the ads flows (train P2, Start hidden). `on`: every workspace; admins and owners write, agents read. Production refuses `on` unless `SPEND_ENFORCE=enforce` and `SPEND_TRIPWIRE=enforce`. |
| `PROMOTE_GOALS` | comma list of goal keys: `whatsapp_chats`, `lead_form`, `website_visits`, `instagram_dms`, `messenger_chats`, `website_sales`, `profile_visits`, `engagement`, `video_views`, `awareness`, `page_likes`, `any_chat` | every goal | The goals offered. Leave out a goal whose runbook step failed. Catalog rows Meta has not verified stay hidden anyway (D22). |
| `PROMOTE_PREVIEWS` | `meta`, `local` | `meta` | `local` shows only "Our preview (approximate)" and makes no preview call to Meta. |
| `PROMOTE_VIDEO` | `off`, `file_url`, `resumable` | `off` | Video ads. Turn on only when the VPS disk is below 80%. |
| `PROMOTE_AUDIENCES` | `off`, `engagement`, `all` | `off` | Audiences. `engagement`: saved, engagement, website and lookalike audiences. `all` adds customer lists; production refuses it without `LEGAL_DPDP_AUDIENCES_OK=1`. |
| `LEGAL_DPDP_AUDIENCES_OK` | `1`, `0` (also true/false, yes/no, on/off) | `0` | Set to `1` only after the lawyer's review of customer lists under the DPDP Act. |
| `PROMOTE_EXPERIMENTAL` | `1`, `0` (as above) | `0` | Shows ad options Meta has not verified, only in workspaces whose ad account is a Meta test account. A warning in production. |
| `PROMOTE_PAGE_LANGS` | comma list of `en`, `hi`, `hinglish` | `en` | Languages of the ads pages. English is always on; add `hi` or `hinglish` after the native-speaker review. |
| `META_LOGIN_POPUP` | `on`, `off` (also 1/0, true/false, yes/no) | `on` | Facebook Login opens as a popup; `off` keeps only the full-page redirect. |
| `GRAPH_BASE_URL` | an `http` or `https` address on `127.0.0.1`, `localhost` or `[::1]` | unset | Test only: sends Graph calls to the fake Meta server. Production refuses it whatever its value, and every environment refuses an address that is not loopback. |

### D.2 Trains and their gates

Flip a flag only when its gate is met, and record the flip and the evidence in MIGRATIONS-APPLIED, as for the spend flags.

| Train | What ships | Flags | Gate |
|---|---|---|---|
| P1 dark | PRM-00 to PRM-04: schema, Phase 0 hooks, pure core, Graph client, builders | `PROMOTE_ENABLED=off` (the default) | This release: 0012 applied, 0013 off-peak. |
| P2 drafts and reads (admins) | Sources, readiness, popup login, media, previews, drafts and review, the lead form builder, lead sync, results | `PROMOTE_ENABLED=admins`; Start hidden | PRM-00 to PRM-15 merged (Start hidden, Eddy v2 definitions off), and the full unit, db and e2e suites green. |
| P3 Start | Start for everyone | `PROMOTE_ENABLED=on` | Runbook V-P0 to V-P7 passed and recorded; `SPEND_ENFORCE=enforce` and `SPEND_TRIPWIRE=enforce` (check-env refuses `on` without both); P0-1 in production; 7 days of P2 with no spend-tripwire bypass row from promote paths; P0-11 in production, or the interim `setAdSetEnd` bound with its test; the D31 addendum to V-P1. |
| P4 audiences, versions and video | Engagement, website and lookalike audiences, compare versions, video ads | `PROMOTE_AUDIENCES=engagement`, then `all`; `PROMOTE_VIDEO=file_url` | V-P8 passed; `LEGAL_DPDP_AUDIENCES_OK=1` before customer lists (check-env refuses `all` without it in production); the VPS disk below 80% before video. |
| P5 Eddy v2 | `start_promotion`, later end dates and budget raises through Eddy | after Eddy train E5 | Eddy train E5 (`SPEND_ENFORCE=enforce`) live, and the evals pass the 9.2 gates in English, Hindi and Hinglish. |

### D.3 Rollout notes: each flip, its gate (spec 9.7) and its MIGRATIONS-APPLIED line

Every flip goes the same way: check its gate below; edit `/var/www/edwyz-wa/.env`; run `node /root/releases/$REL/scripts/check-env.mjs /var/www/edwyz-wa/.env`; `pm2 restart edwyz-wa --update-env && pm2 restart edwyz-wa-worker --update-env`; verify; then append one line to MIGRATIONS-APPLIED with the date, who did it, the flip and the gate's evidence. Going back is the old value, the same restart, and a line of its own. Never flip two trains on the same day.

```
echo "$(date -u +%FT%TZ) <your name> <FLAG>=<old>-><new> (<train>) <evidence>" >> /var/www/edwyz-wa/MIGRATIONS-APPLIED
```

The end-to-end evidence for a gate comes from the Playwright suite run against a local build of the release that Playwright starts itself: run `npm run build`, stop anything on port 3500, leave `E2E_BASE_URL` unset, then `npx playwright test`. The `webServer` in `playwright.config.ts` starts the app with `next start` and `NODE_ENV=test`, `GRAPH_BASE_URL=http://127.0.0.1:4010` (or `FAKE_META_PORT`'s port), `SPEND_DRY_RUN=1`, `PROMOTE_ENABLED=on`, `PROMOTE_AUDIENCES=all` and `EDDY_FAKE_MODEL=scripted`, and records them in `E2E_APP_ENV`; other settings come from the shell or `.env` as before. Playwright's global setup (`e2e/global-setup.ts`) starts the fake Meta server on that port. Never start the app for this run with plain `npm run start`: that runs with `NODE_ENV=production`, where the app ignores `GRAPH_BASE_URL` and `SPEND_DRY_RUN` and would call the real Graph API. `e2e/promote-helpers.ts` refuses to run the promote specs unless Playwright started the app (so with `E2E_BASE_URL` set they fail), and each promote test checks that the app's post picker answers with the fake's posts. The `growth-*` suites must stay green in the same run.

**P1 dark** (this release): nothing to flip. After 0012 and 0013, record `PROMOTE_ENABLED=off (P1 dark)` with the release name.

**P2 drafts and reads, `PROMOTE_ENABLED=admins`.** Gate:

1. PRM-00 to PRM-15 are in the release, with Start hidden at `admins` and Eddy's v2 definitions off (`EDDY_PHASE` unset or `1`).
2. The full unit suite (`npm test`), the database suite (`npm run test:db` with `DATABASE_URL_TEST`) and the end-to-end suite (including `promote-*` and `eddy-promote`) are green on the release commit.
3. 0012 and 0013 are applied (their lines above).

Verify: as a platform admin, /app/ads/boost opens; as an owner who is not a platform admin, it answers 404. Record:
`... PROMOTE_ENABLED=off->admins (P2) release=$REL unit+db+e2e green (<CI run>)`.

**P3 Start, `PROMOTE_ENABLED=on`.** Gate, every item recorded:

1. Sandbox runbook V-P0 to V-P7 passed and recorded (`docs/promote-verification-runbook.md`): the release's `src/lib/promote/catalog/verified.ts` lists them in `VERIFIED_RUNBOOK_STEPS`, and for each of them a sandbox run's own report, `tests/fixtures/promote-verified/run-report-<run id>.json` (`"mode": "sandbox"`), lists it in `passedSteps`. Name those report files and run ids in the record line; a later run writes a new file and never replaces them.
2. The D31 addendum to V-P1 (`V-P1+`, a daily-budget ad set of 24 hours or less is refused) passed, and Meta's error matches the 2-day copy.
3. `SPEND_ENFORCE=enforce` and `SPEND_TRIPWIRE=enforce` are already set and recorded (check-env refuses `PROMOTE_ENABLED=on` without both in production).
4. P0-1 is in production: the release's ads client refuses a creative body that carries a status and the tripwire exempts `act_X/adcreatives` from the PAUSED rule (`npx vitest run tests/promote-tripwire.test.ts tests/spend-tripwire.test.ts` green on the release commit).
5. P0-11 is in production: an `extend_end` or `end_earlier` permit refuses a later end (`npx vitest run tests/spend-permit-end-time.test.ts` green on the release commit), or the interim `setAdSetEnd` bound with its test.
6. 7 days of P2 (counted from its MIGRATIONS-APPLIED line) with no spend-tripwire bypass row from promote paths. This query must return no rows:
   ```sql
   SELECT date_trunc('day', "createdAt") AS day, target, meta->>'class' AS class, count(*) FROM "AuditLog"
   WHERE action = 'spend.tripwire.bypass' AND "createdAt" > now() - interval '7 days' GROUP BY 1, 2, 3 ORDER BY 1;
   ```
7. The owner's platform tasks it needs are done: `META_LOGIN_CONFIG_ID` set and the `leadgen` webhook verified (`docs/meta-dashboard-requirements.md` items 80 and 85), and `Cross-Origin-Opener-Policy` unset or `same-origin-allow-popups` on `/app/*` (item 90).

Verify: an owner's review card shows **Start**; a Start on the review workspace (a sandbox ad account) ends "Sent to Meta. Meta is reviewing it." Record:
`... PROMOTE_ENABLED=admins->on (P3) runbook=<run id>[,<run id>] (run-report-<run id>.json) V-P0..V-P7 and V-P1+ passed; SPEND_ENFORCE=enforce SPEND_TRIPWIRE=enforce; P0-1 and P0-11 tests green on $REL; bypass rows in 7 days: 0 (P2 since <date>)`.

**P4 audiences, versions and video**, one flip at a time:

1. `PROMOTE_AUDIENCES=off->engagement` once runbook V-P8 has passed and is recorded. Record the run id.
2. `LEGAL_DPDP_AUDIENCES_OK=0->1` only with the lawyer's written review of customer lists under the DPDP Act (`docs/legal-review-notes.md`), and only then `PROMOTE_AUDIENCES=engagement->all` (check-env refuses `all` without it in production). Record the review's date and reference on both lines.
3. `PROMOTE_VIDEO=off->file_url` only when the VPS disk is below 80% and the runbook's V-P6 video check has passed. Record the reading of `df -h / | awk 'NR==2{print $5}'` on the line.

**P5 Eddy v2** (`start_promotion`, later end dates and budget raises through Eddy):

1. Eddy train E5 is live: `EDDY_PHASE=2`, `SPEND_ENFORCE=enforce`, and the spend bridge's `eddyAssistantReady` wired (until it is, v2 definitions answer `not_yet`).
2. The evals pass the 9.2 gates in English, Hindi and Hinglish (`npm run eval:eddy`, which needs the owner's approval for each run; Eddy 11.4). Attach the report.
3. `e2e/eddy-promote.spec.ts` and the Eddy test in `e2e/promote-limits.spec.ts` pass with `EDDY_PHASE=2` (before E5 they skip with that reason).

Record: `... EDDY_PHASE=1->2 (P5, Eddy E5) evals <report id> passed in en, hi, hinglish; eddy-promote e2e green`.

## B. Move to an independent server later

The app has no state outside Postgres and `DATA_DIR`, so a move is a restore plus a DNS change. Use the same hostname, so the Meta webhook URL, redirect URIs and Embedded Signup configuration need no change.

1. Provision: Ubuntu LTS, Node (same major version as now), pm2, nginx, certbot, Postgres of the same major version (17), a firewall allowing only 22, 80 and 443, unattended security updates. Lower the DNS TTL of `wa.edwyz.com` to 300 seconds a day ahead.
2. Create the role and database: `createuser edwyz_wa_app`, `createdb -O edwyz_wa_app edwyz_wa`, give the role a new password. Postgres listens on localhost only.
3. Copy from the old server, over a private channel: the newest dump, `.env`, and the `DATA_DIR` folder. Keep `ENCRYPTION_KEY`, `SESSION_SECRET`, `STATE_SECRET`, `WORKER_SECRET` and both media secrets unchanged (a new `ENCRYPTION_KEY` makes every stored Meta token unreadable). Update only `DATABASE_URL` and `DATA_DIR`.
4. Restore into the empty database (`docs/ops.md` 8.2) and run `node scripts/check-env.mjs <env>`.
5. Install the release exactly as in A (steps 3, 6, 8), start the two pm2 apps from `deploy/ecosystem.config.cjs` (one instance each), enable `pm2 startup`, install the tick cron (fallback) (`* * * * * root curl -fsS -X POST -H "x-worker-secret: ..." http://127.0.0.1:3500/api/internal/tick`, with the secret read from the env file, not typed into the cron line), the backup cron, the alert cron (`alert-wa.sh`) and log rotation (A step 8.1; on a dedicated server pm2-logrotate touches nobody else's logs). Obtain the certificate with certbot (use the DNS challenge until DNS points here, or temporary hosts-file testing).
6. Test on the new server with `curl --resolve wa.edwyz.com:443:<new ip> https://wa.edwyz.com/health/ready` and a login.
7. Cutover window: on the old server stop the tick cron and `pm2 stop edwyz-wa edwyz-wa-worker`; take a final `backup-wa.sh`; copy and restore it into a fresh database on the new server (or a delta of `DATA_DIR`); start the app; change the DNS A record. Meta retries webhooks that fail during the window, so nothing is lost.
8. Afterwards: watch `/health`, the metrics endpoint and the logs for a day; confirm the first nightly backup ran on the new server and run `/usr/local/sbin/restore-check-wa.sh` (`docs/ops.md` 8.5). Keep the old server stopped but intact for a week, then let the owner decide on removal. On the old shared VPS nothing needs cleaning for the other tenants; only the `edwyz-wa` pm2 app, its cron files, nginx site and database are involved.
9. If the independent server runs more than one app instance later, first handle the remaining per-process state listed in `docs/ops.md` section 2 (every rate limiter already uses the shared `@/lib/ratelimit`).

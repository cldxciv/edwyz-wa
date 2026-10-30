# Spend controls: operations runbook

How to run the spend controls of `docs/SPEND-CONTROLS-SPEC.md` on wa.edwyz.com: the release order, every flag flip with its
precondition, how to stop all spending, how to clear a safety stop, the live Meta checks V1-V12, the gate before assistants
may spend, and what the platform admin pages do. Owner decisions are in spec 12.1a and are final.

Related documents:

- `deploy/README-deploy.md` section C: the exact commands of the train 1 release.
- `docs/spend-verification-runbook.md`: the live Meta spending limit checks V1-V12, step by step.
- `docs/ops.md` section 15: every environment variable, the tripwire runbook and the Eddy runbook.

Commands below run on the server as root unless they say otherwise. SQL runs with
`sudo -u postgres psql -d edwyz_wa` (read-only queries are safe at any time). Every change of a flag or a setting is recorded
in `/var/www/edwyz-wa/MIGRATIONS-APPLIED` with the date, who did it, and the evidence for its precondition.

## 1. Where things are

| What | Where |
|---|---|
| Every workspace's spending, the platform switch, the alerts | `/admin/spending` (platform admins: allowlist, verified email, TOTP step-up) |
| New-workspace limits, platform ceilings, exchange rates, notification sender, defaults | `/admin/spending/settings` |
| One workspace's live figures and the admin actions | `/admin/tenants/<id>`, the "Spending" card |
| Plan ceilings (ads per day and month per currency, WhatsApp per month, AI credits per day) | `/admin/plans`, "Spending ceilings for this plan" |
| The owner's own page | `/app/settings/spending` (Settings > Spending limits) |
| Flags | `/var/www/edwyz-wa/.env` (mode 600); check with `node /root/releases/$REL/scripts/check-env.mjs /var/www/edwyz-wa/.env` |
| The ledger (who changed what, and why) | table `SpendLedger` (append-only; platform rows carry `tenantId = '*'`) |
| Admin actions | `AuditLog` rows `admin.spend.*` and `admin.tenant.*` |

## 2. Release order (spec 3.2.1 and 11)

**Train 1, guardrails in observe** (WP-00 to WP-06, WP-09, WP-13). Follow `deploy/README-deploy.md` section C in this order:

1. back up the database and confirm the dump carries the 2 functions and 8 triggers;
2. `SHOW server_version` must be 11 or later;
3. apply `0009_spend_controls` WITH `-1` (one transaction; `lock_timeout` 5 s, so a busy table makes it roll back and you retry
   off-peak);
4. run `scripts/spend-backfill-commitments` from the new release while the old build still serves;
5. set the train 1 flags: `SPEND_ENFORCE=observe`, `SPEND_TRIPWIRE=report`, `SPEND_CAP_MODE=off`, `ASSISTANT_SPEND_ENABLED=false`;
6. restart web and worker on the new build;
7. install the nginx changes;
8. apply `0010_spend_message_indexes` WITHOUT `-1`, off-peak, the same day or later.

Step 4 before step 6 means the first request on the new code already counts every running campaign. If the backfill fails,
carry on: the book counts any active campaign without a commitment (the orphan rule, spec 4.6).

**Train 2, walls and breakers** (WP-07, WP-08, WP-10, WP-11, WP-12, WP-18): set `SPEND_CAP_MODE=observe`. The platform admin
panel (WP-18) ships here, and only together with WP-11 or after it: a platform stop must never hold a human inbox reply that
still carries origin `unknown`. No freeze control (WP-16, WP-17, WP-18) goes live before WP-11.

**Train 3, people and panels** (WP-14 to WP-17). Before deploying, check:

- the 4 notifier templates were submitted at least 48 hours earlier and are approved (alerts strip: "Templates approved: 4 of 4");
- the notifier workspace is complimentary and has only platform-admin members (no red "notifier workspace" alert);
- `SPEND_NOTIFY_SECRET` is set (check-env requires it).
- SMTP is NOT required: the email fallback ships switched off (12.1a decision 2), and the pages say so.

**Train 4, go-live** (WP-19): the flag flips of section 3, each only with its precondition.

Rolling back a release means redeploying the previous build. Keep the schema: the old code ignores the new tables. Never drop
the spend tables and never `DISABLE TRIGGER` on the ledger.

## 3. Flag flips, each with its precondition

Every flip: edit `/var/www/edwyz-wa/.env`, run check-env, then
`pm2 restart edwyz-wa --update-env && pm2 restart edwyz-wa-worker --update-env`, then record it. The way back is always the
old value and the same restart.

| Flag | Flip | Precondition | Evidence to record |
|---|---|---|---|
| `SPEND_CAP_MODE` | `off` to `observe` | Train 2 is deployed. | `meta.spend_cap.observe` rows appear for managed accounts (query A). |
| `SPEND_ENFORCE` | `observe` to `enforce` | 7 days in observe. Every would-refuse row of those days is reviewed: expected (the limit really was too low) or a bug that is fixed. Owners whose ads would have been refused are told first. | Query B, run on the day of the flip, with the review notes. |
| `SPEND_TRIPWIRE` | `report` to `enforce` | 7 days in a row with zero `spend.tripwire.bypass` rows. | Query C returns no rows for the last 7 days. The alerts strip shows "None in the last 7 days." |
| `SPEND_CAP_MODE` | `observe` to `enforce` | V1-V9 passed with the owner present and are recorded in `spend:meta-verified` (section 6). | Query D shows `passed: true` for V1-V9. |
| `ASSISTANT_SPEND_ENABLED` | `false` to `true` | The 10.5 gate (section 7), signed off by the owner. | The gate's queries and the owner's sign-off. |

`SPEND_DRY_RUN` and `EDDY_FAKE_MODEL` are never set in production (check-env refuses them). `MAX_DAILY_BUDGET_MINOR` is
deprecated: when it is set it is read as an INR platform daily ads ceiling of ceil(1.75 x value), with a warning.

```sql
-- A. Meta limit observe rows of the last day
SELECT "tenantId", "targetId", "reason", "createdAt" FROM "SpendLedger"
WHERE action = 'meta.spend_cap.observe' AND "createdAt" > now() - interval '1 day' ORDER BY "createdAt" DESC LIMIT 50;

-- B. Would-refuse rows of the observe period, by reason
SELECT pot, action, "reasonCodes", count(*) FROM "SpendLedger"
WHERE phase = 'refused' AND observe AND "createdAt" > now() - interval '7 days'
GROUP BY 1, 2, 3 ORDER BY 4 DESC;

-- C. Tripwire bypass rows, per day
SELECT date_trunc('day', "createdAt") AS day, target, count(*) FROM "AuditLog"
WHERE action = 'spend.tripwire.bypass' AND "createdAt" > now() - interval '7 days' GROUP BY 1, 2 ORDER BY 1;

-- D. The live Meta checks
SELECT key, value->'checks' AS checks, value->>'verifiedAt' AS verified_at FROM "PlatformSetting" WHERE key = 'spend:meta-verified';
```

## 4. How to stop everything

### 4.1 From the admin panel (the normal way)

1. Sign in as a platform admin and pass the authenticator check.
2. Open `/admin/spending`. The top card says "Spending is on for all workspaces".
3. Choose **Stop all spending everywhere** (or **Stop assistants everywhere** when only an assistant is misbehaving).
4. Enter a reason (every workspace sees it while the stop is on), type `STOP SPENDING`, and enter your authenticator code
   unless you confirmed it in the last 5 minutes.

What happens:

- Raises are refused everywhere at once: every raise reads the switch fresh, and the WhatsApp gate and the AI gateway read it
  through a cache that is at most 5 seconds old.
- Up to 25 workspaces are paused right away, most money at risk first; the reply says "Paused X of Y campaigns". The rest are
  paused by the `spend.stop` job and the 1-minute `spend.kill.sweep`. The card shows "Still pausing ads in N workspaces"
  until it reads "Every workspace's ads are paused."
- Broadcasts that are sending pause with `spending_stopped`; automatic and API messages are held; automatic AI stops, while a
  person's own AI requests (reply suggestions, Creative Studio, Eddy) keep working within the AI limit (12.1a decision 8).
- Pending spending requests are withdrawn ("superseded").
- Where a pause failed and Edwyz manages Meta's limit, the emergency limit write (P0) is queued.

To turn it back on: **Turn spending back on**, a reason, and type `START SPENDING`. Nothing restarts by itself: paused ads and
broadcasts stay paused until each owner resumes them from Settings > Spending limits ("Paused by the stop").

### 4.2 When the admin panel cannot be reached

Write the switch directly. The app reads it within 5 seconds; the kill sweep (worker, or the 1-minute `/api/internal/tick`
cron when the worker is down) pauses running ads within a minute.

```sql
INSERT INTO "PlatformSetting" ("key", "value", "updatedAt")
VALUES ('spend:platform', jsonb_build_object('freeze', 'all', 'reason', 'Stopped from the database: <why>', 'byUserId', NULL,
        'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'version', extract(epoch from now())::int), now())
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now();
```

This write has no ledger row: note it in the incident notes and, once the panel works, turn spending back on from the panel
(which ledgers it). Use `'assistants'` instead of `'all'` to stop assistants only.

### 4.3 One workspace

On `/admin/tenants/<id>`, Spending card: **Stop spending** (all, or assistants only), with a reason. The owner can also stop
their own workspace; only the owner or a platform admin can turn a workspace back on.

### 4.4 When nothing on Edwyz's side runs

If both the worker and the web process are down, what was already committed still protects the customer: Meta's spending
limit on managed accounts, the end dates of assistant campaigns, and budgets that were counted at their worst case. The alerts
strip shows "Background work is not running" (email alerts are off, so the strip is the alert).

## 5. How to clear a safety stop

Safety stops (breakers, spec 6) stop or pause something when spending looks wrong. Most clear by themselves:

| Kind | Clears by itself |
|---|---|
| `daily_limit` | at the next account day; it resumes only what it paused itself, through the normal spending checks |
| `monthly_limit` | when the limit is raised or a new month starts (the owner gets "Resume?") |
| `budget_change_quota`, `cpm_ctr_anomaly` | after their wait (1 hour, 24 hours) |
| `sync_stale`, `meta_cap_unreachable` | on the next good read from Meta |
| `wa_quality_yellow`, `wa_quality_red` | after 2 GREEN quality polls in a row |
| `pacing`, `efficiency`, `spend_jump`, `account_spike`, `external_edit`, `meta_cap_units`, `meta_cap_stale_high` | need a look |

To clear one by hand: `/admin/tenants/<id>`, Spending card, "Safety stops open", **Clear safety stop**, with a reason. It
clears the state only: anything it paused stays paused, and the owner resumes it from Settings > Spending limits through the
normal checks. Do not clear `meta_cap_units` (a unit mismatch on Meta's limit) until the account's read-back is understood;
do not clear `external_edit` until the campaign has an end date again.

```sql
-- Open safety stops, newest first
SELECT "tenantId", kind, "scopeType", "scopeId", effect, reason, "trippedAt" FROM "SpendBreaker"
WHERE state = 'tripped' ORDER BY "trippedAt" DESC LIMIT 100;
```

## 6. Running the live Meta checks V1-V12

Follow `docs/spend-verification-runbook.md`. In short:

- Run it only with the owner present, on one real INR ad account the owner chooses, with a ₹500 test monthly limit
  (12.1a decision 5). It spends real money (about ₹550 at most).
- V1-V9 (write unit, reset on write, floor rule, delay and overshoot, role needed, tax, the 10-a-day limit, prepaid, the
  insights day) gate `SPEND_CAP_MODE=enforce`. V10-V12 (lifetime budgets, downward revisions, the shared budget-change quota)
  refine the maths and can run later.
- Record every result in `spend:meta-verified` with `"passed": true/false`, then remove the test limit and archive the test
  campaign. If any of V1-V9 fails, leave `SPEND_CAP_MODE=observe` and raise it with the owner.

## 7. The gate before assistants may spend (`ASSISTANT_SPEND_ENABLED`, spec 10.5)

While the flag is `false` every assistant works at Level 0 (suggestions only) and its learning period cannot end. Flip it only
when all of these hold, and only with the owner's sign-off:

1. At least 3 internal workspaces finished the 14-day learning period with zero "would exceed the limit" verdicts (query E).
2. Owners agreed with at least 70% of the suggestions they decided (query F).
3. V1-V9 passed (section 6).
4. `SPEND_TRIPWIRE=enforce` has run for 7 days.
5. In the sandbox (a Meta test ad account marked "test ad account" on the Spending card), every breaker tripped at least once
   with the right notifications (query G).

```sql
-- E. Learning records that would have gone over a limit, per workspace and assistant (must be 0)
SELECT "tenantId", "assistantKey", count(*) FILTER (WHERE "wouldDecision" = 'refuse'
  AND baseline->>'wouldReason' IN ('over_daily_limit','over_monthly_limit','mandate_daily','mandate_monthly','no_monthly_limit')) AS would_exceed,
  count(*) AS records, min("createdAt") AS first, max("createdAt") AS last
FROM "AssistantShadowRecord" GROUP BY 1, 2 ORDER BY 1, 2;

-- F. Agreement: approved / (approved + declined)
SELECT "assistantKey",
  count(*) FILTER (WHERE outcome->'human'->>'decision' = 'approved') AS approved,
  count(*) FILTER (WHERE outcome->'human'->>'decision' = 'declined') AS declined
FROM "AssistantShadowRecord" GROUP BY 1;

-- G. Breakers that tripped in workspaces whose spending ad account is a test ad account (every kind of spec 6.2 must appear)
SELECT b.kind, count(*) AS trips, max(b."trippedAt") AS last FROM "SpendBreaker" b
JOIN "SpendControl" c ON c."tenantId" = b."tenantId"
JOIN "MetaAsset" a ON a.id = c."spendingAdAccountAssetId" AND a.sandbox
GROUP BY 1 ORDER BY 1;
```

After the flip, an owner still decides each assistant's level on Settings > Spending limits, and a platform admin can end a
learning period early only for a test ad account or a verified workspace (**End learning early** on the Spending card).

## 8. The admin pages

### 8.1 `/admin/spending`

- **Rows** come from figures the 5-minute breakers task saves (`spend:summary:<tenantId>`); each row says "as of 14:05 UTC".
  A workspace with no saved figures yet is listed with the safe defaults and "Not checked yet". The stop state, the
  new-workspace setting, open safety stops and requests waiting are read live.
- **Sorting** is by risk, (spent + set aside) / limit, highest first. The demo workspace is labelled "Demo", listed last, and
  left out of the risk sort and the alerts. Amounts are in each workspace's own currency.
- **Filters**: On new-workspace limits, Stopped, Near a limit (80% or more), Meta limit needs attention, Safety stop open.

### 8.2 The alerts strip, and what to do

| Alert | What to do |
|---|---|
| Background work is not running / Background worker stopped | Restart the worker (`pm2 restart edwyz-wa-worker`); check the tick cron. Meta's limits still apply meanwhile. |
| No notification sender is set up | Choose it in Spending settings. Owners get alerts in the app only until then. |
| Notification sender: templates approved fewer than 4 | Submit or fix the templates in the notifier workspace (`docs/platform-notifier.md`). |
| Owners notified in the last 24 hours at 200 or more | The number is TIER_250: daily summaries are skipped so alerts and requests still go out. Plan the dedicated Indian number (12.1a decision 1). |
| The notifier workspace needs fixing | Make it complimentary, unsuspend it, or remove members who are not platform admins. |
| Meta calls that skipped the spending checks | Each one is a code path to route through the Spend Book before `SPEND_TRIPWIRE=enforce` (`docs/ops.md` 15.2). |
| Spending records with no result | The nightly check lists them in `spend:ledger:orphans`; the reconciler settles most. Investigate any that stay. |
| Meta limit errors | Use the "Meta limit needs attention" filter; usually the person who connected the account is not an admin of the ad account. |
| No USD limits for new workspaces: N workspaces can't start ads | Add a USD row in Spending settings, or a fresh exchange rate. |
| Ad accounts connected to more than one workspace | Informational: the first workspace to turn on Meta's limit manages it (12.1a decision 11). |

### 8.3 The workspace's Spending card (`/admin/tenants/<id>`)

Every action asks for a reason, writes an `admin.tenant.<action>` audit row and a ledger row with actor "Edwyz support", and
applies from the next spending check.

| Action | Use it to |
|---|---|
| Override ceiling | Replace the plan, platform and new-workspace ceilings for one part of spending, optionally until an end date. It can raise above the plan or cut below the owner's limit. |
| AI credit top-up | Override ceiling, "AI credits", monthly = the new total (Eddy 12.1a decision 2). It lifts the AI limit above the plan's credits until removed or until its end date. |
| Remove override | Go back to the usual ceilings. |
| Lower the owner's limits | Cut a limit, for example on abuse. The owner can raise it again: set an override ceiling as well to make the cut stick. |
| Lower an assistant | Lower its level or its own limits; never raises. Only the owner can raise it again. |
| Apply a choice for Meta's limit | Keep, put back the owner's old limit, or remove it, for a workspace being suspended or deleted. |
| Lift / Set new-workspace limits, Mark workspace verified | New-workspace limits end after 2 paid invoices or verification; force them on after a chargeback. |
| Stop spending / Turn spending back on | Stop one workspace; turning back on restarts nothing. |
| Clear safety stop | Section 5. |
| Mark as test ad account | Only for a Meta sandbox ad account with nothing running: Meta's limit is not used on it and its figures are left out of real totals. |
| End learning early | Only for a test ad account or a verified workspace, and only once `ASSISTANT_SPEND_ENABLED=true`. |
| Read Meta's limit again | Re-read and re-plan Meta's limit now, within Meta's daily change budget. |

**Suspend** and **Delete** ask what happens to Meta's spending limit where Edwyz manages it ("keep" by default, or the owner's
stored choice from the close dialog). It is applied before the Meta connections are removed, while Edwyz can still change it.

### 8.4 `/admin/spending/settings`

- **Limits for new workspaces**: per currency and pot. The INR rows are seeded (ads ₹2,000 / ₹20,000, WhatsApp ₹500 /
  ₹5,000, AI 500 credits a month); other currencies read "Not set" until you add a row or a fresh exchange rate.
- **Platform ceilings**: the most any workspace may spend. Empty means none.
- **Exchange rates for limits**: INR for one unit. Update them monthly: a rate older than 35 days shows "Out of date" and is
  not used, and workspaces in that currency then need their own rows.
- **Notification sender**: only numbers in complimentary, active workspaces can be chosen.
- **Requests and Meta's limit**: the saved defaults (`spend:defaults`). Today the request expiry of new workspaces (12 hours)
  and Meta's change budget (6 routine changes a day, 4 kept for emergencies, at most 2 raises) are still the built-in values
  of `src/lib/spend/control.ts` and `src/lib/spend/metacap/plan.ts`; the saved values take effect once those read
  `spend:defaults`. Until then, change them only together with that code change.

### 8.5 Plans

`/admin/plans` stores a plan's spending ceilings as SpendCeiling rows with scope `plan`; the Plan table is unchanged. Duplicate
copies them to the new plan; Delete removes them. A plan's monthly AI credits stay "AI credits a month" on the plan itself.

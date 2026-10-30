# Edwyz WA

Multi-tenant WhatsApp Business platform on the official WhatsApp Cloud API, for wa.edwyz.com. Next.js 16 (App Router), Prisma 7 on Postgres, Tailwind v4.

## What is here

- Public site: landing, `/privacy`, `/terms`, `/data-deletion` (+ Meta data-deletion callback at `/api/meta/data-deletion`), `/health`.
- Auth, workspaces, roles (owner, admin, agent), invites.
- Meta Embedded Signup onboarding (code exchange, app subscription, number registration) with an idempotent step log.
- Webhook ingestion (`/webhooks/whatsapp`), signature-verified, processed from a Postgres job queue.
- Team inbox, quick replies, contacts with opt-in, templates, broadcasts throttled to the number's messaging tier.
- Platform admin area with a "Send test message" panel.

Decisions that differ from the original brief: no Redis, NestJS or Socket.IO yet. Background work uses a Postgres queue (`src/lib/queue.ts`, `FOR UPDATE SKIP LOCKED`), the API is Next.js route handlers, and the inbox polls every 2 seconds. Each can be swapped later without changing the data model.

## Setup

```
cp .env.example .env        # fill in the values below
npm install
npx prisma migrate deploy   # creates the tables
npx prisma generate
npm run dev                 # http://localhost:3500
```

Environment variables (secrets live only in the environment):

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `SITE_URL` | Public URL, used for the Origin check and links |
| `SESSION_SECRET` | Signs access tokens |
| `ENCRYPTION_KEY` | 32 random bytes, base64. Encrypts Meta tokens |
| `STATE_SECRET` | Signs the signup and Meta-connect CSRF states (32+ characters in production) |
| `META_APP_ID`, `META_APP_SECRET` | From the Meta app |
| `META_VERIFY_TOKEN` | Value you enter as "Verify token" in the webhook settings |
| `META_ES_CONFIG_ID` | Embedded Signup configuration id |
| `WORKER_SECRET` | Protects `POST /api/internal/tick` |
| `PLATFORM_ADMIN_EMAILS` | Who can open `/admin` |
| `DATA_DIR` | Fallback folder for raw events and deletion requests |

## Background worker

Drive the queues from cron or a systemd timer (every 10 to 30 seconds is enough):

```
curl -fsS -X POST -H "x-worker-secret: $WORKER_SECRET" https://wa.edwyz.com/api/internal/tick
```

## Meta dashboard steps

See `docs/meta-checklist.md` for the ordered list: App Domains, privacy, terms and data-deletion URLs, Facebook Login for Business redirect URI and Embedded Signup configuration, webhook URL and fields, App Review. Webhook URL: `https://wa.edwyz.com/webhooks/whatsapp`. Redirect URI: `https://wa.edwyz.com/oauth/callback`.

## Tests

```
npm test                          # unit tests (mocked)
node scripts/smoke.mjs http://localhost:3500   # end-to-end against a running app and its database
```

The smoke test uses fixtures instead of Meta and needs `DATABASE_URL`, `WORKER_SECRET` and `META_APP_SECRET` in `.env` (local test values only).

## Deploying

`deploy/nginx-wa.edwyz.com.conf` is the nginx site. The app is built with `output: "standalone"` and run with `node --env-file=.env server.js` under pm2 on port 3500. Run `prisma migrate deploy` before starting a new version.

## Known limits

Media from customers is stored as a Meta media id and not downloaded. Invite and reset emails are not sent yet (the invite link is shown in the app). Postgres row-level security is not enabled; tenant isolation relies on `tenantId` filters in code. See `docs/security-review.md`.

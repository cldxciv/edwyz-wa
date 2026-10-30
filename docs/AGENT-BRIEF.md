# Edwyz WA: shared brief for build agents

Project: Edwyz WA (wa.edwyz.com), a multi-tenant WhatsApp Business SaaS on the official WhatsApp Cloud API, run by Edwyz Technologies Private Limited (India). Businesses sign up, connect their own number through Meta Embedded Signup, then use a team inbox, templates and broadcasts. Meta app "Edwyz API" (id 1799953191201553), business portfolio 363324021484296. Business Verification approved; App Review in progress. Repo folder: `C:\Users\ADMIN\projects\edwyz\wa`.

## Architecture decisions already made (do not change)

- One Next.js 16 App Router app, TypeScript strict, Tailwind v4. Route handlers under `src/app/api/**` are the API. Standalone output, deployed with pm2 behind nginx.
- Postgres via Prisma 7. Import `prisma` from `@/lib/db` and types from `@/generated/prisma/client`. Schema: `prisma/schema.prisma` (read it first). Every tenant-owned table has `tenantId`.
- No Redis. Background work uses the Postgres job queue in `@/lib/queue` (`enqueue`, `runDueJobs`). A worker process (`src/worker/index.ts`, owned by the webhook-inbox agent) polls queues.
- No Socket.IO. Realtime inbox = client polling every 2 s (or SSE if simple).
- Password hashing: `node:crypto` scrypt. No native modules.
- Graph API access only through `graphFetch` from `@/lib/graph`. Pin the API version through `GRAPH_API_VERSION` in `@/lib/config`.
- Tenancy contract in `@/lib/tenancy`: `Actor`, `HttpError`, `requireRole`, `errorResponse`. Every tenant route does `const actor = await getActor(request)` (from `@/lib/auth`) and filters every Prisma query on tenant-owned models by `actor.tenantId`. Wrap handlers in try/catch returning `errorResponse(e)`.

## Hard rules

1. Own only the files in your scope. Never edit another agent's files, `prisma/schema.prisma`, `package.json`, or the lockfile. If you need a schema change, append a short request to `docs/schema-requests.md` and design around it for now. If you need a new dependency, use built-in Node APIs instead; if truly unavoidable, say so in your report. Do NOT run `npm install`.
2. Never log tokens, PINs, passwords, app secrets or message content. Never put secrets in code. Config comes from environment variables listed in `.env.example` (append new names to the end of that file only).
3. Tenant isolation is the top requirement: no query on a tenant-owned model without `tenantId`; no route that trusts a tenantId from the request body or URL.
4. Meta rules the product must enforce: free-form messages only inside the 24-hour customer service window (otherwise approved templates only); opt-in required before marketing sends and STOP replies honoured; throttle broadcasts to the number's messaging tier; never invent prices or rate cards (leave configurable and clearly marked unconfigured).
5. Do not contact the network, the VPS, Meta or any live system. Unit tests must mock Prisma, `graphFetch` and `fetch`. Do not start dev servers.
6. Code style: no comments except where the WHY is non-obvious; no emojis; short functions; validate all external input at route boundaries; return JSON errors via `errorResponse`.
7. Tests: vitest in `tests/`. Run only your own tests (`npx vitest run tests/<yourfile>`). `npx tsc --noEmit` may show errors from other agents' unfinished files; filter to your paths (`npx tsc --noEmit 2>&1 | grep -E "<your paths>"`) and leave none in yours.
8. Keep going until your scope is complete and your tests pass. Do not ask the user questions; make the reasonable call and note it in your report.

## Report format (your final message)

Under 300 words: files created or changed; endpoints and exported functions other modules or the UI can call (with request and response shapes); env vars added; tests written and their result; decisions you made; anything not finished or needing schema or dependency changes.

---

# Wave 3 addendum: complete platform (billing paywall, super admin, automation, lifecycle)

Read this together with the rules above. What changed:

- The backend and UI from waves 1 and 2 are integration-tested (`scripts/smoke.mjs`) and reviewed (`docs/security-review.md`). New schema is already migrated and the client generated: Plan, Subscription, BillingProfile, Invoice, PaymentEvent, PlatformSetting, AutomationRule, AutomationRun, ApiKey, WebhookEndpoint, WebhookDelivery, DailyMetric, EmailToken, plus new columns (Tenant.status, trialEndsAt, billingExempt, deletedAt; User.disabledAt, emailVerifiedAt, TOTP fields; BroadcastRecipient.messageId). Do not edit the schema; request changes in `docs/schema-requests.md`.
- Settings every module reads through `@/lib/platform-settings` (`getSettings`, `updateSettings`): trial days, grace days, GST rate, invoice prefix, seller details.
- Worker plug-in point: each area has `src/lib/<area>/worker.ts` exporting `worker: { queues, periodic }`. Fill in your own area's file (billing, automation, integrations, lifecycle, reports). `queues` maps a queue name to a job handler `(payload, ctx) => Promise<void>` (ctx has `isLastAttempt`); `periodic` lists `{ name, everyMs, run }` tasks that the worker runs at most once per interval across all processes. Never edit `src/worker/loop.ts`, `src/worker/periodic.ts` or `src/lib/queue.ts`.
- Contract stubs that other agents import and mock in tests (the owner replaces them and keeps the exports): `@/lib/billing` (getBillingStatus, assertTenantCanWrite, assertWithinLimit, startTrial, syncPlanToRazorpay) and `@/lib/email` (sendEmail, queueEmail). The coordinator wires `assertTenantCanWrite` into `getActor`, API-key authentication into `getActor`, trial start into signup, and plan-limit checks into invites, contact imports and broadcast start. Do not edit `src/lib/auth/index.ts` unless your task says so.
- Navigation: do not edit `src/components/app/nav.ts` or the sidebar; the coordinator adds links for the pages you create. Tell the coordinator the page path, title and minimum role in your report.
- Files owned by earlier agents may be edited ONLY when your task names them, and only with small anchored edits: re-read the file immediately before editing, change the minimum, and add or update tests. Several agents work at the same time.
- Security rules for everything new: every state-changing route calls `assertSameOrigin` from `@/lib/auth/csrf` and checks the role; all tenant queries filter by `tenantId`; never return secrets, hashes or tokens; no personal data or message content in logs or error messages; validate and size-limit all input (use `request.text()` with an explicit limit, not unbounded `json()`); constant-time compare for secrets; amounts are integers in paise; never invent prices, rates or legal text, make them configurable and mark unconfigured values clearly.
- Money and tax: GST is a configurable percentage in basis points from platform settings. The seller GSTIN is unset by default: when it is empty, invoices are labelled "Proforma, not a tax invoice" rather than pretending to be GST invoices.
- Test rules as before: vitest with mocks, run only your own tests, no dev servers, no network, no `npm install`. Final report under 300 words in the usual format, including routes, exported functions, env vars, decisions and anything unfinished.

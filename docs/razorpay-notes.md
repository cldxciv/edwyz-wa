# Razorpay integration notes

Verified against the official docs on 2026-10-26. Items marked UNVERIFIED were not confirmed from the docs and must be checked in the dashboard.

## Subscriptions API (Basic auth, key_id:key_secret, base https://api.razorpay.com/v1)

- Create plan: `POST /plans` with `period` (daily, weekly, monthly, quarterly, yearly), `interval` (integer; daily needs at least 7), `item.name`, `item.amount` (integer, smallest currency unit, minimum 100), `item.currency`, optional `notes` (max 15). https://razorpay.com/docs/api/payments/subscriptions/create-plan/
- Create subscription: `POST /subscriptions` with `plan_id`, `total_count` (required), optional `quantity`, `customer_notify`, `start_at`, `expire_by`, `notes` (max 15 pairs). Response has `id`, `status`, `short_url`, `current_start`, `current_end`, `paid_count`, `notes`. https://razorpay.com/docs/api/payments/subscriptions/create-subscription/
- Statuses: created, authenticated, active, pending, halted, cancelled, completed, expired (and paused). pending = a charge failed and Razorpay retries; halted = retries exhausted, customer must retry or change card; a halted subscription returns to active once a charge succeeds. https://razorpay.com/docs/payments/subscriptions/states/
- Cancel: `POST /subscriptions/{id}/cancel` with `{ "cancel_at_cycle_end": true }` cancels at the end of the current cycle (false, the default, cancels immediately). It returns 400 if sent before the first cycle starts or in the last cycle. A cancelled subscription cannot be reactivated. https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/
- Plans are immutable; the docs list no update-plan call (index: https://razorpay.com/docs/payments/subscriptions/apis/). To change a price, create a new plan.

## Checkout.js for subscriptions

- Script: `https://checkout.razorpay.com/v1/checkout.js`. Options: `key` (key id), `subscription_id`, `name`, `description`, `image`, `handler` or `callback_url`, `prefill`, `notes`, `theme`.
- Success returns `razorpay_payment_id`, `razorpay_subscription_id`, `razorpay_signature`.
- Verify: HMAC SHA256 hex of `razorpay_payment_id + "|" + subscription_id` keyed with the key secret. Use the subscription id stored on your server, not the one returned by the client. https://razorpay.com/docs/payments/subscriptions/integration-guide/
- Test mode: generate test keys in the dashboard; test cards are listed on that page; switch to live keys for production.
- Cards: supported. UPI recurring: the page only mentions it in an error note (plan amount below the UPI minimum for the account fails). UPI Autopay enablement and limits: UNVERIFIED, confirm on the dashboard for your account.

## Webhooks

- Header `X-Razorpay-Signature` = HMAC SHA256 hex of the raw request body with the webhook secret (the secret set on the webhook, separate from the API key secret). Do not parse before hashing. https://razorpay.com/docs/webhooks/validate-test/
- Header `X-Razorpay-Event-Id` is unique per event; the same event can be delivered more than once, so skip ids already processed. Retry schedule: UNVERIFIED.
- Subscription events: authenticated, activated, charged, completed, updated, pending, halted, cancelled, paused, resumed. Payload: `payload.subscription.entity` always (`id`, `plan_id`, `status`, `current_start`, `current_end`, `paid_count`, `notes`); `payload.payment.entity` when a payment was attempted (`id`, `amount`, `currency`, `status`, `method`, `error_code`). The docs sample for resumed shows `status: active`. https://razorpay.com/docs/webhooks/subscriptions/
- Payment events payment.captured and payment.failed: not fetched; this module treats payment.failed as record-only.

## How this module uses them

- Plan price is the amount charged per cycle and is treated as GST inclusive; invoices split it into taxable value and GST.
- `notes.tenantId` is set on each subscription and checked against the stored `razorpaySubscriptionId` before a webhook is trusted.
- `total_count` is set so that a subscription spans about 10 years (`ceil(120 / intervalMonths)`); the docs reviewed did not state a maximum, so confirm it in test mode.

## Hardening added after review (checkout replay, ordering, invoice backfill)

- Checkout confirmation (`POST /api/billing/verify`) no longer trusts the signature alone: the success signature never expires, so a saved copy could be replayed after a cancel, failed charge or expiry. The server now verifies the signature, fetches `GET /subscriptions/{id}` and only activates when Razorpay reports `active`; the period stored is Razorpay's `current_start` / `current_end` (never "now plus the interval"). A confirmation while the workspace is already active and paid up changes nothing, and a payment id is recorded (`billing:checkout-payment:<tenant>:<payment>`) so it works once.
- The invoice for the first payment is issued at confirmation from `GET /payments/{id}` (captured only); one payment id never gets two invoices.
- Webhook order: every event carries a top-level `created_at` (unix seconds). The newest one applied per workspace is kept (`billing:last-event:<tenant>`); an older status event is acknowledged but does not change the local status (its payment is still invoiced). Events without `created_at` are always applied. The reconcile job records the time it applied too.
- Missed `subscription.charged` webhooks: the `billing-invoice-backfill` job (every 30 minutes) looks at active subscriptions whose paid period started in the last 3 days and that have no invoice since, lists `GET /invoices?subscription_id={id}&count=10` and issues our GST invoice for each paid Razorpay invoice that has a `payment_id`. UNVERIFIED against the live API: the field names `payment_id`, `status`, `amount`, `paid_at`, `billing_start`, `billing_end` on that list; check in test mode.

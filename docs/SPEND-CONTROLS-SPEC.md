# Spend controls, Phase 0: specification

Status: final design, ready to build. Date: 2026-10-28. A completeness review (critic) was applied the same day. Its additions are marked "(critic)", and section 13 lists every gap it closed.
Scope: wa.edwyz.com (this repository). Phase 0 is the spend-control environment. It ships before any AI assistant may spend a rupee.
Inputs: the owner-approved requirements R1-R9 (2026-10-28), four recon reports, and two independent designs. The owner's latest instruction is: "the spending limit option should be there with every user and admin panel also, rest all is good." Section 8 meets it. Every workspace member, in every role, sees the Spending limits page, and the platform admin panel shows and overrides every workspace's limits.

Naming. In this codebase the role `agent` is a human teammate. To keep role checks unambiguous, the AI agents that will run the funnel are called **assistants** in code (`assistantKey`, `AssistantMandate`) and in the UI ("Ad assistant"). In the UI the `agent` role is called "Team member".

---

## 0. How this design was chosen

Two designs were judged:

- **Design A, "Money outward" (the Spend Book).** One module, `src/lib/spend`, owns every money decision. It keeps explicit commitments, holds, a ledger, and a guarded ads client.
- **Design B, "Call sites inward" (SpendGuard).** A runtime tripwire in the Graph transport, a `guarded()` wrapper at call sites, lock-free counters and an AI gateway.

Scores run from 1 to 5, and 5 is best. For build risk, 5 means the lowest risk. The columns are C = correctness, Bp = bypass resistance, O = operability, U = UX clarity and R = build risk.

| Req | A: C | Bp | O | U | R | A total | B: C | Bp | O | U | R | B total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R1 three walls | 5 | 4 | 4 | 5 | 3 | 21 | 4 | 5 | 4 | 4 | 4 | 21 |
| R2 pots, worst case, committed, end dates | 5 | 4 | 3 | 5 | 3 | 20 | 3 | 5 | 5 | 4 | 4 | 21 |
| R3 limits UI for every role, admin panel | 5 | 4 | 4 | 5 | 3 | 21 | 4 | 4 | 4 | 4 | 4 | 20 |
| R4 autonomy and approvals | 5 | 5 | 4 | 4 | 3 | 21 | 4 | 3 | 4 | 4 | 3 | 18 |
| R5 breakers and kill switches | 5 | 4 | 4 | 4 | 3 | 20 | 4 | 4 | 5 | 4 | 4 | 21 |
| R6 sandbox and shadow | 4 | 4 | 4 | 4 | 4 | 20 | 4 | 4 | 4 | 4 | 4 | 20 |
| R7 probation, ceilings, currency | 5 | 4 | 4 | 4 | 3 | 20 | 3 | 4 | 3 | 3 | 5 | 18 |
| R8 ledger and digest | 5 | 5 | 4 | 4 | 4 | 22 | 4 | 5 | 4 | 4 | 4 | 21 |
| R9 no money held | 5 | 5 | 5 | 5 | 5 | 25 | 5 | 5 | 5 | 5 | 5 | 25 |
| **Sum** | | | | | | **190** | | | | | | **185** |
| **Correctness counted twice** | | | | | | **234 / 270** | | | | | | **220 / 270** |

Where A is stronger on correctness:

- A's commitments remember the day's highest budget after a mid-day cut. Meta's 175% rule uses that highest budget, and B derives committed money from campaign status, so it loses this.
- A backfills the old cap as ceil(1.75 x C), so existing workspaces keep exactly the room they have today. B copies C as it is, which would refuse activations that pass today.
- A never resets the customer's `amount_spent` counter. B resets it every month.
- A has per-currency ceilings plus an FX table that fails closed when a rate is stale.
- A requires a signed-in session to approve a raise. B also lets a WhatsApp quick reply approve one.

Where B is stronger:

- Bypass resistance: a runtime tripwire in `src/lib/graph/index.ts` and a single AI gateway.
- Operability: lock-free per-message counters, and intraday samples kept in the database.

**Base: Design A (the Spend Book).** These parts are grafted from B:

1. A transport tripwire in `run()` of `src/lib/graph/index.ts`, with AsyncLocalStorage permits. Raising spend writes fail without a permit. Lowering writes never fail; without a permit they are only audited.
2. One AI gateway, `src/lib/spend/exec/ai.ts`. It is the only code allowed to call `api.anthropic.com`.
3. Lock-free conditional `UPDATE` counters for each WhatsApp message and each AI call. A's per-message hold rows under an advisory lock are dropped. Bulk sends still take a reservation row.
4. A two-key advisory lock namespace, `pg_advisory_xact_lock(21328, hashtext(...))`, which cannot collide with the existing single-key locks.
5. An `IntradaySpendSample` table for anomaly deltas between syncs, so the previous sample is not kept in a PlatformSetting.
6. Handling of spending-limit changes made outside Edwyz: a lower customer cap is adopted, and a raised or removed cap is set back.
7. A Meta-room check on activation: if Meta's remaining limit is too low, the activation is refused with `META_CAP_TOO_LOW` and a raise is queued.
8. Two freeze levels, `assistants` and `all`, both per workspace and platform-wide.
9. Quality breakers clear only after 2 GREEN polls in a row.
10. The workspace toggle `breakersMayPauseHumanCampaigns`, default off.
11. One "spending ad account" per workspace in Phase 0.
12. The `caps.ts` shims and the existing CapPanel labels and testids stay, so the e2e suite keeps passing.
13. The notifier workspace must have its AI agent, chatbots and automations off.
14. Pending approvals are marked superseded on a freeze or when a new intent arrives.
15. Level 2 on an ad account without a managed Meta limit drops to "needs approval".
16. SpendCeiling gains `expiresAt` and a `platform` scope.
17. During migration, the origin `unknown` is treated as automated.

Not taken from either design:

- B's monthly `spend_cap_action=reset`, which zeroes the customer's own counter.
- B's 6-digit authentication-template code. A "Yes" quick reply proves the number more cheaply.
- A's `accountShares` split across several ad accounts. There is one spending ad account in Phase 0.
- A's per-message `SpendHold` rows.
- B's raw backfill of the old cap.

---

## 1. Summary and the three walls

Edwyz never holds ad or message money. Meta bills the customer's own ad account and WhatsApp account. Phase 0 makes sure that no person, API key, automation or AI assistant can make Meta, WhatsApp or the AI provider spend more than the workspace owner allowed. The protection keeps working when one layer fails, lags or is bypassed.

**Wall (a): Meta's own spending limit on the ad account (`spend_cap`).** With the owner's explicit consent, Edwyz keeps the account's spending limit at what has been spent so far plus what is left of the monthly ads allowance. Meta then stops every ad on the account, including ads made in Ads Manager, even if Edwyz is offline, a token expires or the platform has a bug. Meta allows about 10 changes a day, so writes are rare by design (section 5).

**Wall (b): workspace allowances, checked before any Meta, WhatsApp or AI call.** There are three pots: ads, WhatsApp messages and AI. Each has a monthly and a daily limit. For ads, money is counted at Meta's worst case: 1.75 x the day's highest daily budget per day, and at most 7 x per Sunday-to-Saturday week in the ad account's time zone. Running campaigns reserve what they could still spend (committed money), not only what they have spent. The Spend Book decides under a Postgres advisory lock, and a permit is required at the transport (section 4).

**Wall (c): per-assistant mandates.** For each assistant there is an autonomy level (0 Suggest, the default; 1 Guarded; 2 Autopilot), its own ceilings, a target cost per lead, the operations it may perform, a 14-day shadow period, and owner approvals for raises that exceed what its level allows (section 7).

Around the walls:

- **Breakers** pause or hold automatically. They cover pacing, efficiency, anomalies, WhatsApp quality, the messaging cost gate, the AI quota, and the daily and monthly limits at run time.
- **Kill switches** work per workspace and platform-wide.
- **An append-only ledger** records every money decision.
- **A daily digest** goes to the owner.

The asymmetric rule applies everywhere: **lowering spend or risk is never blocked, never waits for a lock and never needs approval; raising spend is always gated.**

---

## 2. Decisions

### 2.1 Requirements and how they are met

| Req | Owner requirement | How Phase 0 meets it | Spec section | WPs |
|---|---|---|---|---|
| R1 | Three independent walls: (a) a Meta spend_cap the platform manages, set to the remaining monthly allowance and lowered as the month goes, within about 10 changes a day, with consent captured at connect; (b) allowances checked before any Meta call; (c) per-agent mandates | (a) Section 5. Target = amount_spent + remaining allowance, so Meta's room shrinks on its own as the month goes and needs no write. 6 routine changes a rolling day, with 4 kept for emergencies. Owner consent is captured at connect and in Settings, stored append-only with the hash of the text shown. Observe mode runs until a live verification passes. (b) Section 4: Spend Book plus guarded ads client, transport tripwire, send gate and AI gateway. (c) Section 7: AssistantMandate checked inside the same reservation. (critic) There is one manager per real ad account, an offboarding choice on close, suspend or account change, and changes are made only on Edwyz pages (5.1, 5.8). | 4, 5, 7 | 03-07, 14 |
| R2 | Three pots (ads, WhatsApp, AI), each monthly and daily. Worst case 1.75x a day and 7x a week. Committed money is reserved. Every agent campaign has an end date or lifetime budget | SpendAllowance holds a row per pot. The worst-case walk is in `worstcase.ts`. SpendCommitment rows keep day and week peaks. Database CHECK constraints plus guards at the client and the draft refuse an assistant campaign with no end date and no lifetime budget. (critic) Lifetime-only and budget-sharing worst cases are defined, orphan active campaigns are counted, and Ads Manager edits to Edwyz campaigns are synced and counted (4.5, 4.6.1). | 3, 4.5, 4.6 | 00, 01, 04, 06, 08 |
| R3 | The spending limit control is available to every workspace in Settings. The admin panel sees every workspace's limits, committed and spent amounts, can lower or override, can set probation and plan ceilings, and has a platform-wide kill switch. Plain language | Settings > Spending limits is visible to every role. The owner edits; admins can lower and stop; team members see it read-only. The ads page keeps a summary and a link. In the admin panel: /admin/spending lists every workspace, the tenant Spending card has override actions, /admin/spending/settings holds probation, platform ceilings, FX and the notifier, PlanForm holds plan ceilings, and there is a platform switch. (critic) The page works in every workspace state, including no Meta, no WhatsApp, demo, locked and suspended. Lowering and stopping are never paywalled. The admin list covers every workspace and ships in train 2 (8.1, 8.3, 8.4, 4.17, 11). | 8 | 16, 17, 18 |
| R4 | Levels 0/1/2 with the asymmetric rule. One-tap approvals showing the action, cost forecast and reason, expiring as declined after N hours. In-app plus WhatsApp to the owner | Level semantics are in 7.2. SpendApproval expires after 12 h by default (range 1-48) and is then treated as declined. Approval is one tap in the app and one tap on a link once signed in. Decline needs no sign-in. The owner gets WhatsApp from a platform-owned sender using UTILITY templates, with email and in-app as fallbacks. | 7 | 14, 15 |
| R5 | Pacing at 120%, cost per lead over 2x target, anomalies, WhatsApp quality, the messaging cost gate, the AI quota, and workspace and platform kill switches | Section 6 gives exact thresholds. Ads sync every 15 min, WhatsApp quality is polled every 30 min, and webhooks feed the rest. A conservative cost estimate gates every bulk send. The AI hard stop is in the gateway. There are two freeze levels. | 6 | 08-13 |
| R6 | A Meta sandbox account; shadow mode for each agent's first 14 days | MetaAsset.sandbox: wall (a) is skipped and the ledger flags the rows, and synthetic insights come from SPEND_SIM. AssistantShadowRecord stores what the assistant would have done against what happened. | 7.5, 10 | 14, 19 |
| R7 | Probation at about ₹2,000 a day and ₹20,000 a month until there is payment history or verification. The admin can raise it. Plan ceilings. Non-INR currencies | SpendCeiling has the scopes platform, probation, plan and tenant (override, can expire). Probation lifts automatically after 2 paid invoices or verification. A per-currency ceiling row is used first, otherwise the admin FX table (fresh within 35 days), otherwise the request is refused. | 3, 4.4 | 00, 03, 18 |
| R8 | An append-only ledger recording who, why, forecast, before and after, approval id and undo recipe. A daily WhatsApp digest | SpendLedger is append-only by trigger. Every decision writes a request row and one outcome row with the same correlationId, plus idempotency keys. The digest goes out at 09:00 workspace time over WhatsApp, with email and in-app as fallbacks. | 9 | 03, 15 |
| R9 | The platform never holds ad money. The platform fee goes through Razorpay. AI is paid from the plan quota or prepaid credits | The Spend Book is accounting, not a wallet (`Tenant.walletPaise` stays unused). The bypass test bans `funding_source` writes. Razorpay is unchanged. AI is metered in plan credits; a top-up is an admin override ceiling on the AI pot in Phase 0, and a Razorpay one-time order in Phase 1. The only money the platform pays is its own notification messages. | 1, 4.12 | 05, 13 |

### 2.2 Defaults

| Setting | Default | Where | Who changes |
|---|---|---|---|
| Assistant autonomy level | 0, Suggest | AssistantMandate.level | Owner raises; admin lowers |
| Shadow period | 14 days from first enable, per workspace and assistant | AssistantMandate.shadowUntil | Platform admin ends it early (sandbox or verified workspace only) |
| Level 1 budget raise | At most +20% of the ad set's budget at the start of the account day, cumulative per account day | `raiseStepPct` (0-20) | Owner, lower only |
| Level 2 single action | Approval needed when the worst-case month increase is over 25% of the effective monthly allowance | `approvalSharePct` (1-25) | Owner, lower only |
| Probation ceiling, ads | INR 2,000 a day (200000 paise), INR 20,000 a month (2000000 paise) | SpendCeiling scope probation | Platform admin |
| Probation ceiling, WhatsApp and AI | Not set (see open question 3) | SpendCeiling | Platform admin |
| Probation lifts | Automatically after 2 paid invoices, or `verifiedAt` set by a platform admin; billing-exempt workspaces are treated as lifted. (critic) Computed on read: only non-void invoices with a total above 0 count | SpendControl.probation | Platform admin (lift or force) |
| Pacing breaker | Today's spend on assistant ad sets over 120% of the sum of their highest daily budgets today | Section 6 | Platform default |
| Efficiency breaker | Cost per lead over 2 x target, after a minimum spend of max(3 x target, INR 500 equivalent) over the last 3 account days | Section 6 | Target set by the owner |
| Ads fast sync | Every 15 min (Meta's insights refresh rate) | `spend.sync.fast` | Fixed |
| WhatsApp quality poll | Every 30 min per connected number | `spend.quality.poll` | Fixed |
| Approval expiry | 12 h (range 1-48), then declined | SpendControl.approvalTtlHours | Owner |
| Meta limit change budget | 6 routine changes per rolling 24 h; 4 kept for emergencies; routine raises at most 2 per 24 h | 'spend:defaults' | Platform admin |
| Ad set budget-change quota | 3 non-emergency changes per ad set per 60 min (Meta allows 4) | Section 4.6 | Fixed |
| Worst case | 1.75 x the day's highest daily budget; 7 x the week's highest per Sunday-to-Saturday week in the account time zone | `worstcase.ts` | Fixed |
| Kill propagation | A job right away plus a sweep every 1 min. Raises read the switch fresh; the send gate cache is at most 5 s. (critic) The toggle request also pauses inline (20 s budget), so a stop never waits for the worker | Section 4.11 | Fixed |
| (critic) Level 2 approval share | Single action, and the rolling 24 h sum of that assistant's auto-applied raises, each ≤ 25% | `policy.ts` | Owner, lower only (12.1 Q6) |
| (critic) Structure sync of Edwyz campaigns | With every fast sync; every 2 h when there is no open commitment | `spend.sync.structure` | Fixed |
| Digest | 09:00 workspace time; skipped for workspaces with no activity | SpendControl.digestEnabled | Owner |
| FX rate staleness | A rate older than 35 days counts as missing | 'spend:fx' | Platform admin |
| Human enforcement | `SPEND_ENFORCE=observe` for 7 days, then `enforce` | env | Deployer |

### 2.3 Product decisions this spec makes (the owner can override any of them)

1. **Who edits limits.**
   - The owner raises.
   - Admins can lower any limit, stop spending and lower an assistant's level.
   - Team members (role `agent`) see everything on the page read-only, without the activity table.
   - Admins may activate campaigns *within* the limits, as today. The limits are the owner's control.
2. **Approving raises** needs the owner, or an admin the owner names as an approver. Today any admin can approve a raising optimizer proposal, so this is a deliberate tightening that needs a release note.
3. **One spending ad account per workspace in Phase 0.** The owner picks it. Other connected ad accounts are for insights only. Campaigns already live on them are grandfathered and counted: they can be paused but not raised.
4. **Spend from outside Edwyz counts in the ads pot only when Meta's limit is managed** (wall (a) on). Meta's limit stops the whole account, so the pot must cover the whole account. Without wall (a), only platform campaigns count, and outside spend is shown for information.
5. **Breakers that react to performance** (efficiency, spend jump) pause only assistant campaigns. Human campaigns get a notification unless the owner turns on "Let safety stops pause campaigns my team made". Breakers that enforce a limit (daily and monthly) act on all platform campaigns.
6. **Approving a raise always needs a signed-in approver**: one tap when already signed in. Declining works from the link or the WhatsApp quick reply with no sign-in. Phase 0 does not approve from a quick reply.
7. **WhatsApp messages your team types always go out.** They are counted and shown, never blocked by a cost control. The same holds for STOP and START confirmations.
8. **(critic) Turning a "Not set" limit into a number is owner only, in every pot.** In the ads pot, "Not set" on the daily limit means no ads can start, so setting a number enables spending. In every pot, "Not set" means assistants are refused, so setting a number would let an admin open room for assistants. Admins can still lower any number that exists and can stop spending at any time.
9. **(critic) Level 2 cannot be split to dodge the 25% rule.** The 25% approval share is measured on the single action AND on the sum of that assistant's auto-applied raises in the last rolling 24 h. Ten launches of 10% each cannot add 100% of the month without an approval. This is the stricter reading of R4; the owner can relax it (12.1 question 6).
10. **(critic) Shadow mode and Level 0 never block human approval of a suggestion.** During shadow, the assistant itself cannot execute anything. A suggestion that an approver accepts is applied as that person's action (actor `user`, with `assistantKey` and `approvalId` on the ledger), the same way optimizer proposals can be approved today. A workspace with no mandate row, or a disabled mandate, gets suggestions only: proposals are created and shown, and nothing is applied automatically. "Refuse" is used only for actions an approval could not make valid. This avoids taking away today's optimizer approvals for 14 days.
11. **(critic) "Stop all spending" keeps AI your team asks for.** Under freeze `all` (workspace or platform), automatic AI is stopped: AI agent replies, chatbot AI escalation and assistants. AI that a signed-in person requests (reply suggestions, Creative Studio, the AI test) continues within the AI limit, the same as messages your team types. Section 4.10 follows this rule.
12. **(critic) When the WhatsApp limit is used up, conversational auto-replies hand over to a person instead of waiting.** Chatbot and AI agent replies are not held for hours. The job fails with `messaging_limit`, the conversation is assigned to the team as today's handoff does, and the inbox shows "Automatic replies are paused because this month's WhatsApp limit is used up." Other automated senders (broadcasts, sequences, reminders) are held as in 4.9.
13. **(critic) Turning spending back on never restarts ads by itself.** After a workspace or platform stop is cleared, everything the stop paused stays paused. The page lists those campaigns with [Resume all] and a [Resume] per campaign. Each resume is a raise through `reserveAds`, so only what fits starts again, and it needs the owner or an approver. Held WhatsApp jobs that have not expired (24 h free-form, 7 days templates) do send after the stop is cleared, as they do after a billing hold today.
14. **(critic) Only one Edwyz workspace may manage Meta's limit on a given Meta ad account.** The same ad account can be connected to two workspaces (`MetaAsset` is unique only per tenant), for example an agency and its client. Two managers would treat each other's writes as "changed outside Edwyz" and burn Meta's 10 changes a day fighting each other. The first workspace to turn it on manages it. The other sees "Another Edwyz workspace already manages Meta's spending limit on this ad account" and follows the rules for an unmanaged account.

---

## 3. Data model

### 3.1 Money, units, currency and time

- **Money** is an integer in minor units of its currency. All new columns are `BIGINT` (Prisma `BigInt`, JS `bigint`). API DTOs send amounts as decimal strings plus a formatted string.
- **AI** uses the pseudo-currency `CRD` with exponent 0 (credits).
- **Exponents** come from `src/lib/ads/insights-money.ts` `currencyExponent`: 0, 2 or 3 decimals. `src/lib/spend/money.ts` re-exports it. The table is still marked VERIFY. Before wall (a) is enabled for a non-INR currency, check V1 (section 10.6) for that currency.
- **Formatting** always uses the exponent (`formatMinor`). Writing `minor / 100` anywhere is a bug. That includes `src/lib/approvals/summary.ts` today, which WP-14 fixes.
- **Rounding:**
  - worst-case maths rounds UP: `ceil175(x) = (7x + 3) / 4` in integer arithmetic;
  - ceilings converted by FX round DOWN;
  - cost estimates round UP to whole minor units.
- **Rate card precision.** An optional `scale` of 2 stores rates in 1/100 of a minor unit, so INR 0.115 becomes 1150.
- **Currency of a pot.**
  - The ads pot takes the spending ad account's currency.
  - The messaging pot takes the rate card currency. In Phase 0 the rate card has one platform currency, INR.
  - A mismatch between a pot and an account or rate card is refused for raises (`spend.currency`) and shown in the UI.
- **FX** (`'spend:fx'`) holds INR-per-unit rates entered by a platform admin. A ceiling in currency X is used in this order:
  1. an explicit SpendCeiling row in X;
  2. the INR row converted at a fresh rate (35 days or newer), rounded down;
  3. otherwise UNKNOWN. UNKNOWN refuses raises for assistants, and for humans on probation.
- **Time.**
  - Ads days, weeks (Sunday to Saturday) and months use the spending ad account's time zone (`MetaAsset.meta.timezone`), because Meta paces and reports in it.
  - `SpendControl.timezone` defaults to that time zone, or Asia/Kolkata. It is used for messaging and AI day and month keys and for the digest.
  - Insights requests ask for account-time-zone dates. The VERIFY note in `insights-sync.ts` is resolved by runbook V9.
- **Old 32-bit columns** (AdCampaign.dailyBudgetMinor, AdSet.dailyBudgetMinor, InsightSnapshot.spendMinor) stay Int in Phase 0. The book reads them as bigint. Moving them to BIGINT is Phase 1.
- **(critic) No silent clamping on the new paths.** `insights-money.ts` `decimalToMinor` clamps at 2,147,483,647, which would UNDER-count a month of IDR or VND spend. That is the unsafe direction. `money.ts` adds `decimalToMinorBig(str, exponent): bigint` with no clamp, and every writer of SpendDaily, IntradaySpendSample, MetaSpendLimit and the ledger uses it. When the old clamp fires on the 6-hour reporting path, it logs `insights.clamped` and the book ignores that InsightSnapshot value.
- **(critic) Ads pot currency before an ad account exists.** A workspace with no spending ad account can still set ads limits. The currency is chosen on the card (the CapPanel's list, default INR). When the owner later picks a spending ad account in another currency, raises are refused with `spend.currency`, and the card shows "Your ads limits are in INR, but this ad account uses USD. Enter your limits again in USD." The owner re-enters them; nothing is converted silently.
- **(critic) Commitments in another currency.** Grandfathered live campaigns on a non-spending ad account whose currency differs from the ads pot are not added to the pot. They are listed under it ("Also running on Shop US (USD): up to $140 more this month, not counted in your INR limit"). They can be paused, never raised.
- **(critic) Rate card currency changes.** While any messaging SpendAllowance exists in the current rate card currency, the admin rate card editor refuses a currency change, with "Workspaces have WhatsApp limits in INR. Add rates in INR, or ask them to re-enter limits first."
- **(critic) Time zone changes.**
  - A change to `SpendControl.timezone` takes effect at the next local midnight. Counter keys already written stay as they are, so no day is counted twice or skipped.
  - If Meta reports a different `timezone_name` for the spending ad account (5.2 reads it), MetaSpendLimit and open commitments take the new zone from the next account day, the ledger records `info` with reason `account_timezone_changed`, and the next metacap plan is recomputed.
  - When the two zones differ, the page shows both: "Ads days follow America/New_York (your ad account). WhatsApp and AI days follow Asia/Kolkata."
- **(critic) Refunds, credits and revisions.**
  - Meta ad credits, coupons and invoice credits change what the customer pays, not what Meta delivers. Limits count delivered spend (`spend` and `amount_spent`), including spend paid with credits. The help text says: "Limits count what your ads spend, even when Meta pays part of it with a credit."
  - Meta revises spend for up to 28 days. SpendDaily is SET, never incremented, so a downward revision frees room on the next sync and an upward one uses it. If `amount_spent` goes DOWN between reads without an Edwyz write, the metacap plan uses the lower value only after two consecutive reads agree, and the ledger records `meta.spend_cap.read_drift`.
  - WhatsApp: a message Meta never charged gives back its estimate at settlement (4.9). That covers `billable=false`, a free entry point, and a message that failed after it was accepted.
  - AI: a failed or timed-out provider call releases its reservation. A successful call is never refunded.
  - Platform fee: probation counts only invoices with status `paid` and a total above 0. A voided or refunded invoice stops counting on the next read, so probation can return (4.4).

### 3.2 Migration `prisma/migrations/0009_spend_controls/migration.sql`

Forward only. Apply it with `psql -1 -v ON_ERROR_STOP=1 -f migration.sql` as `edwyz_wa_app`, then record it in `/var/www/edwyz-wa/MIGRATIONS-APPLIED` and run `npx prisma generate`. This is the first migration with a FUNCTION and TRIGGER, so check that the backup and restore steps carry them (pg_dump does by default). Partial and expression indexes exist only in SQL, and the schema carries a comment saying so. (critic) Section 3.2.1 covers applying it to the live database without blocking the app.

```sql
-- 0009_spend_controls. Phase 0 spend controls. See docs/SPEND-CONTROLS-SPEC.md.

-- (critic) Fail fast instead of queueing behind long transactions and stalling every request behind this ALTER.
-- psql -1 runs the file in one transaction, so SET LOCAL lasts until COMMIT. If it times out, nothing is applied; retry.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ===== AlterTable: existing tables =====
ALTER TABLE "AdCampaign"
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'human',
  ADD COLUMN "assistantKey" TEXT,
  ADD COLUMN "lifetimeBudgetMinor" BIGINT,
  ADD COLUMN "targetCostPerResultMinor" BIGINT,
  ADD COLUMN "sandbox" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_origin_check" CHECK ("origin" IN ('human','assistant','api'));
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_assistant_end_check"
  CHECK ("origin" <> 'assistant' OR "endsAt" IS NOT NULL OR "lifetimeBudgetMinor" IS NOT NULL);

ALTER TABLE "AdSet" ADD COLUMN "lifetimeBudgetMinor" BIGINT;

ALTER TABLE "MetaAsset" ADD COLUMN "sandbox" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Message"
  ADD COLUMN "origin" TEXT,
  ADD COLUMN "pricingCategory" TEXT,
  ADD COLUMN "estCostMinor" BIGINT,
  ADD COLUMN "costMinor" BIGINT,
  ADD COLUMN "billable" BOOLEAN,
  ADD COLUMN "pricingType" TEXT,
  ADD COLUMN "spendDay" DATE,
  ADD COLUMN "spendState" TEXT,
  ADD COLUMN "reservationId" TEXT,
  ADD COLUMN "pricingSettledAt" TIMESTAMP(3);
-- (critic) NOT VALID: every existing row has spendState NULL, so a validating scan of the whole Message table under an
-- ACCESS EXCLUSIVE lock is pointless. New and updated rows are still checked. VALIDATE runs later in 0010 without blocking writes.
ALTER TABLE "Message" ADD CONSTRAINT "Message_spendState_check"
  CHECK ("spendState" IS NULL OR "spendState" IN ('reserved','settled','released')) NOT VALID;
-- origin: human | api | mcp | assistant | broadcast | automation | chatbot | ai_reply | lead_sequence | commerce | consent | approval | admin_test | system_notify | eddy | unknown
-- (critic) The two Message indexes moved to 0010_spend_message_indexes (CREATE INDEX CONCURRENTLY, which cannot run inside psql -1).
-- A plain CREATE INDEX here would block inbound webhooks and sends for the whole build. See 3.2.1.

ALTER TABLE "UsageLedger" ADD COLUMN "inputTokens" INTEGER, ADD COLUMN "outputTokens" INTEGER, ADD COLUMN "model" TEXT;

-- ===== CreateTable SpendControl (per-workspace switches, probation, approvers) =====
CREATE TABLE "SpendControl" (
  "tenantId" TEXT NOT NULL,
  "freeze" TEXT NOT NULL DEFAULT 'none',
  "frozenByKind" TEXT,
  "frozenByUserId" TEXT,
  "frozenReason" TEXT,
  "frozenAt" TIMESTAMP(3),
  "probation" TEXT NOT NULL DEFAULT 'auto',
  "probationReason" TEXT,
  "probationChangedByUserId" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "spendingAdAccountAssetId" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  "approverUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "approvalTtlHours" INTEGER NOT NULL DEFAULT 12,
  "targetCostPerLeadMinor" BIGINT,
  "breakersMayPauseHumanCampaigns" BOOLEAN NOT NULL DEFAULT false,
  "digestEnabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendControl_pkey" PRIMARY KEY ("tenantId"),
  CONSTRAINT "SpendControl_freeze_check" CHECK ("freeze" IN ('none','assistants','all')),
  CONSTRAINT "SpendControl_frozenBy_check" CHECK ("frozenByKind" IS NULL OR "frozenByKind" IN ('owner','admin','platform_admin','breaker')),
  CONSTRAINT "SpendControl_probation_check" CHECK ("probation" IN ('auto','lifted','forced')),
  CONSTRAINT "SpendControl_ttl_check" CHECK ("approvalTtlHours" BETWEEN 1 AND 48)
);

-- ===== CreateTable SpendAllowance (owner limits, one row per pot; NULL = 'Not set') =====
CREATE TABLE "SpendAllowance" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "dailyLimitMinor" BIGINT,
  "monthlyLimitMinor" BIGINT,
  "migratedFromCapMinor" BIGINT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendAllowance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendAllowance_pot_check" CHECK ("pot" IN ('ads','messaging','ai')),
  CONSTRAINT "SpendAllowance_amounts_check" CHECK (
    ("dailyLimitMinor" IS NULL OR "dailyLimitMinor" > 0) AND
    ("monthlyLimitMinor" IS NULL OR "monthlyLimitMinor" > 0) AND
    ("dailyLimitMinor" IS NULL OR "monthlyLimitMinor" IS NULL OR "dailyLimitMinor" <= "monthlyLimitMinor"))
);
CREATE UNIQUE INDEX "SpendAllowance_tenantId_pot_key" ON "SpendAllowance"("tenantId","pot");

-- ===== CreateTable SpendCeiling (platform ceilings; scopeId: '*' for platform/probation, Plan.id for plan, Tenant.id for tenant override) =====
CREATE TABLE "SpendCeiling" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "dailyMinor" BIGINT,
  "monthlyMinor" BIGINT,
  "reason" TEXT,
  "setByUserId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendCeiling_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendCeiling_scope_check" CHECK ("scope" IN ('platform','probation','plan','tenant')),
  CONSTRAINT "SpendCeiling_pot_check" CHECK ("pot" IN ('ads','messaging','ai')),
  CONSTRAINT "SpendCeiling_amounts_check" CHECK (("dailyMinor" IS NULL OR "dailyMinor" >= 0) AND ("monthlyMinor" IS NULL OR "monthlyMinor" >= 0))
);
CREATE UNIQUE INDEX "SpendCeiling_scope_scopeId_pot_currency_key" ON "SpendCeiling"("scope","scopeId","pot","currency");

-- ===== CreateTable SpendCommitment (live ads reservations; one row per budget-holding Meta object) =====
CREATE TABLE "SpendCommitment" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adAccountAssetId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "adSetId" TEXT,
  "metaObjectId" TEXT NOT NULL,
  "objectLevel" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "assistantKey" TEXT,
  "currency" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "dailyBudgetMinor" BIGINT,
  "lifetimeBudgetMinor" BIGINT,
  "pendingFromMinor" BIGINT,
  "dayKey" DATE,
  "dayStartBudgetMinor" BIGINT,
  "peakDailyBudgetMinor" BIGINT NOT NULL DEFAULT 0,
  "weekStart" DATE,
  "weekPeakDailyBudgetMinor" BIGINT NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "reservedUntil" TIMESTAMP(3),
  "correlationId" TEXT,
  "sandbox" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendCommitment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendCommitment_level_check" CHECK ("objectLevel" IN ('campaign','adset')),
  CONSTRAINT "SpendCommitment_origin_check" CHECK ("origin" IN ('human','assistant','api')),
  CONSTRAINT "SpendCommitment_status_check" CHECK ("status" IN ('reserved','live','unconfirmed','stopped')),
  CONSTRAINT "SpendCommitment_budget_check" CHECK ("dailyBudgetMinor" IS NOT NULL OR "lifetimeBudgetMinor" IS NOT NULL),
  CONSTRAINT "SpendCommitment_assistant_end_check" CHECK ("origin" <> 'assistant' OR "endsAt" IS NOT NULL OR "lifetimeBudgetMinor" IS NOT NULL)
);
CREATE UNIQUE INDEX "SpendCommitment_open_object_key" ON "SpendCommitment"("tenantId","metaObjectId") WHERE "status" <> 'stopped';
CREATE INDEX "SpendCommitment_tenantId_status_idx" ON "SpendCommitment"("tenantId","status");
CREATE INDEX "SpendCommitment_status_reservedUntil_idx" ON "SpendCommitment"("status","reservedUntil");

-- ===== CreateTable SpendCounter (lock-free messaging/AI counters; a cache of row truth, rebuilt every 15 min) =====
CREATE TABLE "SpendCounter" (
  "tenantId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "periodKind" TEXT NOT NULL,
  "periodKey" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "reservedMinor" BIGINT NOT NULL DEFAULT 0,
  "spentMinor" BIGINT NOT NULL DEFAULT 0,
  "reconciledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendCounter_pkey" PRIMARY KEY ("tenantId","pot","periodKind","periodKey"),
  CONSTRAINT "SpendCounter_pot_check" CHECK ("pot" IN ('messaging','ai')),
  CONSTRAINT "SpendCounter_kind_check" CHECK ("periodKind" IN ('day','month')),
  CONSTRAINT "SpendCounter_nonneg_check" CHECK ("reservedMinor" >= 0 AND "spentMinor" >= 0)
);

-- ===== CreateTable SpendReservation (bulk messaging holds and in-flight AI calls) =====
CREATE TABLE "SpendReservation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "consumedMinor" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'held',
  "dayKey" TEXT NOT NULL,
  "monthKey" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "correlationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "SpendReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendReservation_pot_check" CHECK ("pot" IN ('messaging','ai')),
  CONSTRAINT "SpendReservation_subject_check" CHECK ("subjectType" IN ('broadcast','automation_run','api_batch','ai_call')),
  CONSTRAINT "SpendReservation_status_check" CHECK ("status" IN ('held','settled','released','expired')),
  CONSTRAINT "SpendReservation_amount_check" CHECK ("amountMinor" > 0 AND "consumedMinor" >= 0)
);
CREATE UNIQUE INDEX "SpendReservation_open_subject_key" ON "SpendReservation"("tenantId","subjectType","subjectId") WHERE "status" = 'held';
CREATE INDEX "SpendReservation_status_expiresAt_idx" ON "SpendReservation"("status","expiresAt");

-- ===== CreateTable SpendDaily (observed spend per account day; SET, never incremented: Meta revises for up to 28 days) =====
CREATE TABLE "SpendDaily" (
  "tenantId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "scopeType" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "currency" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL DEFAULT 0,
  "origin" TEXT NOT NULL,
  "results" INTEGER,
  "impressions" BIGINT,
  "clicks" BIGINT,
  "source" TEXT NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL,
  -- (critic) origin is part of the key: the account 'all' row and the account 'external' row (6.1 step 3) share scope and day.
  CONSTRAINT "SpendDaily_pkey" PRIMARY KEY ("tenantId","pot","scopeType","scopeId","day","origin"),
  CONSTRAINT "SpendDaily_scope_check" CHECK ("scopeType" IN ('account','campaign','adset','phone')),
  CONSTRAINT "SpendDaily_origin_check" CHECK ("origin" IN ('platform','external','all'))
);
CREATE INDEX "SpendDaily_tenantId_pot_day_idx" ON "SpendDaily"("tenantId","pot","day");

-- ===== CreateTable IntradaySpendSample (15-minute cumulative samples for today; kept 35 days) =====
CREATE TABLE "IntradaySpendSample" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adAccountAssetId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityMetaId" TEXT NOT NULL,
  "accountDate" DATE NOT NULL,
  "sampledAt" TIMESTAMP(3) NOT NULL,
  "spendMinor" BIGINT NOT NULL,
  "impressions" BIGINT NOT NULL,
  "clicks" BIGINT NOT NULL,
  "results" INTEGER NOT NULL,
  CONSTRAINT "IntradaySpendSample_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntradaySpendSample_entity_check" CHECK ("entityType" IN ('account','adset'))
);
CREATE INDEX "IntradaySpendSample_tenantId_entityMetaId_sampledAt_idx" ON "IntradaySpendSample"("tenantId","entityMetaId","sampledAt");

-- ===== CreateTable SpendLedger (R8; append-only by trigger) =====
CREATE TABLE "SpendLedger" (
  "id" TEXT NOT NULL,
  "seq" BIGSERIAL NOT NULL,
  "tenantId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  "assistantKey" TEXT,
  "autonomyLevel" SMALLINT,
  "targetType" TEXT,
  "targetId" TEXT,
  "metaObjectId" TEXT,
  "currency" TEXT,
  "amountMinor" BIGINT,
  "forecastTodayMinor" BIGINT,
  "forecastMonthMinor" BIGINT,
  "before" JSONB,
  "after" JSONB,
  "snapshot" JSONB,
  "reason" TEXT NOT NULL,
  "reasonCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "approvalId" TEXT,
  "undo" JSONB,
  "correlationId" TEXT NOT NULL,
  "idempotencyKey" TEXT,
  "observe" BOOLEAN NOT NULL DEFAULT false,
  "sandbox" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendLedger_pot_check" CHECK ("pot" IN ('ads','messaging','ai','none')),
  CONSTRAINT "SpendLedger_phase_check" CHECK ("phase" IN ('requested','applied','failed','unconfirmed','refused','shadow','reconciled','info')),
  -- (critic) 'external' = a change Edwyz detected but did not make (Meta Ads Manager edits, a customer's own spend_cap change).
  CONSTRAINT "SpendLedger_actor_check" CHECK ("actorType" IN ('user','assistant','system','breaker','platform_admin','api','external'))
);
CREATE UNIQUE INDEX "SpendLedger_seq_key" ON "SpendLedger"("seq");
CREATE INDEX "SpendLedger_tenantId_createdAt_idx" ON "SpendLedger"("tenantId","createdAt");
CREATE INDEX "SpendLedger_tenantId_seq_idx" ON "SpendLedger"("tenantId","seq");
CREATE INDEX "SpendLedger_targetId_action_createdAt_idx" ON "SpendLedger"("targetId","action","createdAt");
CREATE INDEX "SpendLedger_correlationId_idx" ON "SpendLedger"("correlationId");
CREATE UNIQUE INDEX "SpendLedger_idem_key" ON "SpendLedger"("tenantId","idempotencyKey","phase") WHERE "idempotencyKey" IS NOT NULL;
CREATE UNIQUE INDEX "SpendLedger_one_outcome_key" ON "SpendLedger"("tenantId","correlationId") WHERE "phase" IN ('applied','failed','unconfirmed','refused');  -- 12.1c R1
CREATE UNIQUE INDEX "SpendLedger_one_reconciled_key" ON "SpendLedger"("tenantId","correlationId") WHERE "phase" = 'reconciled';                             -- 12.1c R1

-- ===== CreateTable MetaSpendLimit (wall (a) state per ad account) =====
CREATE TABLE "MetaSpendLimit" (
  "adAccountAssetId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "accountExternalId" TEXT NOT NULL,          -- (critic) Meta's act_ id, so one manager per real ad account (decision 2.3.14)
  "spentAtLastWriteMinor" BIGINT,             -- (critic) S at the last write; S = this + A under resets_on_write (5.3)
  "mode" TEXT NOT NULL DEFAULT 'off',
  "consentId" TEXT,
  "unitMode" TEXT NOT NULL DEFAULT 'unverified',
  "semantics" TEXT NOT NULL DEFAULT 'unverified',
  "customerCapAtConsentMinor" BIGINT,
  "customerAmountSpentAtConsentMinor" BIGINT,
  "managedCapMinor" BIGINT,
  "targetCapMinor" BIGINT,
  "pendingTargetMinor" BIGINT,
  "lastReadCapMinor" BIGINT,
  "lastReadAmountSpentMinor" BIGINT,
  "lastReadAt" TIMESTAMP(3),
  "monthKey" TEXT,
  "monthStartAmountSpentMinor" BIGINT,
  "loosenessMinor" BIGINT,
  "deferredUntil" TIMESTAMP(3),
  "writesBlockedUntil" TIMESTAMP(3),
  "lastWriteAt" TIMESTAMP(3),
  "lastError" TEXT,
  "currency" TEXT,
  "timezone" TEXT,
  "accountStatus" INTEGER,
  "isPrepay" BOOLEAN,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MetaSpendLimit_pkey" PRIMARY KEY ("adAccountAssetId"),
  CONSTRAINT "MetaSpendLimit_mode_check" CHECK ("mode" IN ('off','pending_owner','managed','withdrawn','unavailable_prepaid','no_permission','currency_mismatch','sandbox','error','other_workspace')),
  CONSTRAINT "MetaSpendLimit_unit_check" CHECK ("unitMode" IN ('unverified','major_write','minor_write')),
  CONSTRAINT "MetaSpendLimit_semantics_check" CHECK ("semantics" IN ('unverified','cumulative','resets_on_write'))
);
CREATE INDEX "MetaSpendLimit_tenantId_idx" ON "MetaSpendLimit"("tenantId");
-- (critic) At most one workspace manages (or is about to manage) Meta's limit on a real ad account.
CREATE UNIQUE INDEX "MetaSpendLimit_one_manager_key" ON "MetaSpendLimit"("accountExternalId") WHERE "mode" = 'managed';  -- 12.1c R3

-- ===== CreateTable SpendConsent (append-only; kinds meta_spend_cap | owner_whatsapp) =====
CREATE TABLE "SpendConsent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "subjectId" TEXT,
  "granted" BOOLEAN NOT NULL,
  "textVersion" TEXT NOT NULL,
  "textSha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendConsent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendConsent_kind_check" CHECK ("kind" IN ('meta_spend_cap','owner_whatsapp'))
);
CREATE INDEX "SpendConsent_tenantId_kind_subjectId_createdAt_idx" ON "SpendConsent"("tenantId","kind","subjectId","createdAt");

-- ===== CreateTable AssistantMandate (wall (c)) =====
CREATE TABLE "AssistantMandate" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "assistantKey" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "level" SMALLINT NOT NULL DEFAULT 0,
  "allowedOps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "maxDailyMinor" BIGINT,
  "maxMonthlyMinor" BIGINT,
  "currency" TEXT,
  "targetCostPerLeadMinor" BIGINT,
  "raiseStepPct" INTEGER NOT NULL DEFAULT 20,
  "approvalSharePct" INTEGER NOT NULL DEFAULT 25,
  "shadowStartedAt" TIMESTAMP(3),
  "shadowUntil" TIMESTAMP(3),
  "sandboxOnly" BOOLEAN NOT NULL DEFAULT false,
  "updatedByUserId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantMandate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantMandate_level_check" CHECK ("level" IN (0,1,2)),
  CONSTRAINT "AssistantMandate_pct_check" CHECK ("raiseStepPct" BETWEEN 0 AND 20 AND "approvalSharePct" BETWEEN 1 AND 25)
);
CREATE UNIQUE INDEX "AssistantMandate_tenantId_assistantKey_key" ON "AssistantMandate"("tenantId","assistantKey");

-- ===== CreateTable SpendApproval (owner approval of assistant actions; separate from client ApprovalRequest) =====
CREATE TABLE "SpendApproval" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "assistantKey" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "actionKind" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "intent" JSONB NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "forecastTodayMinor" BIGINT,
  "forecastMonthMinor" BIGINT,
  "currency" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedByUserId" TEXT,
  "decidedVia" TEXT,
  "decidedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "proposalId" TEXT,
  "notifiedAt" TIMESTAMP(3),
  "correlationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendApproval_direction_check" CHECK ("direction" IN ('raise','lower')),
  CONSTRAINT "SpendApproval_status_check" CHECK ("status" IN ('pending','approved','declined','expired','applied','failed','superseded')),
  CONSTRAINT "SpendApproval_via_check" CHECK ("decidedVia" IS NULL OR "decidedVia" IN ('app','link','whatsapp','system'))
);
CREATE UNIQUE INDEX "SpendApproval_tokenHash_key" ON "SpendApproval"("tokenHash");
CREATE INDEX "SpendApproval_tenantId_status_expiresAt_idx" ON "SpendApproval"("tenantId","status","expiresAt");

-- ===== CreateTable SpendBreaker (R5) =====
CREATE TABLE "SpendBreaker" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "scopeType" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'tripped',
  "effect" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "details" JSONB,
  "trippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "clearedAt" TIMESTAMP(3),
  "clearedByUserId" TEXT,
  "autoClearAt" TIMESTAMP(3),
  "notifiedAt" TIMESTAMP(3),
  CONSTRAINT "SpendBreaker_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendBreaker_state_check" CHECK ("state" IN ('tripped','cleared')),
  CONSTRAINT "SpendBreaker_scope_check" CHECK ("scopeType" IN ('workspace','ad_account','campaign','adset','phone','template','waba','assistant')),
  CONSTRAINT "SpendBreaker_effect_check" CHECK ("effect" IN ('pause_scope','block_raises','block_marketing','block_automated','block_all_outbound','notify_only'))
);
CREATE UNIQUE INDEX "SpendBreaker_open_key" ON "SpendBreaker"("tenantId","kind","scopeType","scopeId") WHERE "state" = 'tripped';
CREATE INDEX "SpendBreaker_tenantId_state_idx" ON "SpendBreaker"("tenantId","state");

-- ===== CreateTable AssistantShadowRecord (R6) =====
CREATE TABLE "AssistantShadowRecord" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "assistantKey" TEXT NOT NULL,
  "actionKind" TEXT NOT NULL,
  "intent" JSONB NOT NULL,
  "wouldDecision" TEXT NOT NULL,
  "forecastMonthMinor" BIGINT,
  "currency" TEXT,
  "reason" TEXT NOT NULL,
  "baseline" JSONB,
  "outcome" JSONB,
  "evaluatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantShadowRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantShadowRecord_would_check" CHECK ("wouldDecision" IN ('auto','needs_approval','refuse'))
);
CREATE INDEX "AssistantShadowRecord_tenantId_assistantKey_createdAt_idx" ON "AssistantShadowRecord"("tenantId","assistantKey","createdAt");

-- ===== CreateTable OwnerNotifyChannel (owner/approver WhatsApp number; personal data) =====
CREATE TABLE "OwnerNotifyChannel" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "phoneE164" TEXT NOT NULL,
  "optInAt" TIMESTAMP(3),
  "optInTextVersion" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "optOutAt" TIMESTAMP(3),
  "notifierContactId" TEXT,
  "lastSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OwnerNotifyChannel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OwnerNotifyChannel_tenantId_userId_key" ON "OwnerNotifyChannel"("tenantId","userId");
CREATE INDEX "OwnerNotifyChannel_phoneE164_idx" ON "OwnerNotifyChannel"("phoneE164");

-- ===== Append-only enforcement (first trigger in this database) =====
CREATE OR REPLACE FUNCTION edwyz_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN                                  -- 12.1c R2: one workspace per purge
    IF current_setting('edwyz.purge', true) = TG_TABLE_NAME || ':' || COALESCE(to_jsonb(OLD)->>'tenantId', '') THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END $$;
CREATE TRIGGER "SpendLedger_append_only" BEFORE UPDATE OR DELETE ON "SpendLedger" FOR EACH ROW EXECUTE FUNCTION edwyz_append_only();
CREATE TRIGGER "SpendLedger_no_truncate" BEFORE TRUNCATE ON "SpendLedger" FOR EACH STATEMENT EXECUTE FUNCTION edwyz_append_only();
CREATE TRIGGER "SpendConsent_append_only" BEFORE UPDATE OR DELETE ON "SpendConsent" FOR EACH ROW EXECUTE FUNCTION edwyz_append_only();
CREATE TRIGGER "SpendConsent_no_truncate" BEFORE TRUNCATE ON "SpendConsent" FOR EACH STATEMENT EXECUTE FUNCTION edwyz_append_only();
-- Workspace erasure, inside ONE transaction: SELECT set_config('edwyz.purge','SpendLedger:'||$1,true); DELETE FROM "SpendLedger" WHERE "tenantId"=$1;
-- then the same for SpendConsent. set_config(..., true) is transaction-local.

-- ===== Backfill =====
-- 1. The old daily cap meant "sum of nominal daily budgets <= C". Meta can spend 1.75x that, so the equivalent worst-case daily limit is ceil(1.75 C).
--    Room is unchanged. 'ads:caps:' is 9 characters. The old key is kept and read only as a fallback by the getCaps shim.
INSERT INTO "SpendAllowance" ("id","tenantId","pot","currency","dailyLimitMinor","monthlyLimitMinor","migratedFromCapMinor","updatedAt")
SELECT 'sa_' || md5(substr(p."key",10) || ':ads'), substr(p."key",10), 'ads', p."value"->>'currency',
       CEIL(1.75 * (p."value"->>'maxDailyBudgetMinor')::numeric)::bigint, NULL, (p."value"->>'maxDailyBudgetMinor')::bigint, CURRENT_TIMESTAMP
FROM "PlatformSetting" p
WHERE p."key" LIKE 'ads:caps:%'
  AND (p."value"->>'currency') ~ '^[A-Z]{3}$'
  AND (p."value"->>'maxDailyBudgetMinor') ~ '^[0-9]+$'
  AND (p."value"->>'maxDailyBudgetMinor')::numeric > 0;

-- 2. A SpendControl row for every tenant. The time zone comes from the active ad account. The spending account is set when there is exactly one.
--    (critic) probation is 'auto' for everyone: 4.4 computes it on read (billing-exempt, 2 paid invoices, verifiedAt), so a later
--    void or refund, or a revoked exemption, brings probation back. A stored 'lifted' would make the backfill-time state sticky.
--    (critic) Time zone fallback order: active ad account, then RoutingConfig.timezone, then Asia/Kolkata.
--    Tenants created after this migration get their row lazily on first read (invariant I11).
INSERT INTO "SpendControl" ("tenantId","probation","timezone","spendingAdAccountAssetId","updatedAt")
SELECT t."id",
       'auto',
       COALESCE((SELECT a."meta"->>'timezone' FROM "MetaAsset" a WHERE a."tenantId" = t."id" AND a."type" = 'ad_account' AND a."status" = 'active' ORDER BY a."createdAt" LIMIT 1),
                (SELECT r."timezone" FROM "RoutingConfig" r WHERE r."tenantId" = t."id"), 'Asia/Kolkata'),
       (SELECT min(a."id") FROM "MetaAsset" a WHERE a."tenantId" = t."id" AND a."type" = 'ad_account' AND a."status" = 'active' HAVING count(*) = 1),
       CURRENT_TIMESTAMP
FROM "Tenant" t
ON CONFLICT ("tenantId") DO NOTHING;

-- 3. Default probation ceiling (R7), INR, ads pot. No other currency or pot gets an invented value.
INSERT INTO "SpendCeiling" ("id","scope","scopeId","pot","currency","dailyMinor","monthlyMinor","reason","updatedAt")
VALUES ('sc_probation_ads_inr','probation','*','ads','INR',200000,2000000,'Phase 0 default: INR 2,000 a day and INR 20,000 a month for new workspaces',CURRENT_TIMESTAMP);

-- 4. Live AdCampaigns become SpendCommitment rows through scripts/spend-backfill-commitments.ts. It needs time zone and exponent
--    logic, so it is not SQL. (critic) It runs right after this migration and BEFORE the train 1 build serves traffic (11, train 1
--    deploy steps), not merely before SPEND_ENFORCE=enforce. Otherwise headroom would see 0 committed and let through activations
--    that today's workspaceActiveBudget refuses. The book also counts any DB-active AdCampaign with no open commitment (4.6), so a
--    late or failed backfill over-counts rather than under-counts.
```

### 3.2.1 Applying 0009 to the live database (critic)

0009 runs against the production database while wa.edwyz.com is live. These rules keep it additive and non-blocking:

- **Additive only.** 0009 only adds columns, tables, constraints, indexes, one function and triggers, and inserts backfill rows. It drops, renames and retypes nothing, and it never updates an existing row of an existing table. Every new column on an existing table is either nullable or has a constant default. On PostgreSQL 11 and later that is a catalog-only change with no table rewrite. Check `SHOW server_version` first. If it is below 11, stop and plan the AdCampaign defaults as nullable columns plus an application default.
- **Backward compatible with the deployed build.** The running code never reads the new columns, and its inserts get the defaults (`AdCampaign.origin = 'human'`). So the order is: back up, apply 0009, run the commitments backfill, then deploy train 1. Rolling back means redeploying the previous build. The schema stays, because the old code ignores it.
- **Locks.** The file starts with `SET LOCAL lock_timeout = '5s'`, so an ALTER that cannot get its lock fails at once instead of queueing every request behind it. On failure, nothing is applied (one transaction), and it is retried off-peak. The new CHECK on `Message` is `NOT VALID`, so there is no full-table scan under an exclusive lock. The new CHECKs on `AdCampaign` validate a small table.
- **Big-table indexes in a second file.** `prisma/migrations/0010_spend_message_indexes/migration.sql` is applied WITHOUT `-1`, because `CREATE INDEX CONCURRENTLY` cannot run in a transaction block:

```sql
-- 0010_spend_message_indexes. Apply with: psql -v ON_ERROR_STOP=1 -f migration.sql (no -1).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_spend_open_idx" ON "Message"("tenantId","spendDay") WHERE "spendState" = 'reserved';
-- Settled messages still waiting for Meta's pricing, including ones that failed after Meta accepted them (4.9 settlement).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_pricing_unsettled_idx" ON "Message"("tenantId","createdAt") WHERE "spendState" = 'settled' AND "pricingSettledAt" IS NULL;
ALTER TABLE "Message" VALIDATE CONSTRAINT "Message_spendState_check";
```

  If a concurrent build fails, it leaves an INVALID index. Drop that index (`DROP INDEX CONCURRENTLY`) and re-run the file. The gate and settlement code work without these indexes, only more slowly, so 0010 can follow 0009 by minutes or days.
- **Numbering.** Other developers are adding migrations. If 0009 or 0010 is already taken when this lands, use the next free numbers. Never edit an applied file.
- **Rehearsal.** WP-00 acceptance (1) already applies 0009 to a restored production copy. It also times each statement and records the times in MIGRATIONS-APPLIED. A statement over 10 s on the copy means rethinking it before production.

### 3.3 Prisma models (`prisma/schema.prisma`)

There are no FK relations to Tenant. That matches AuditLog and InsightSnapshot, and erasure goes through PERSONAL_DATA. The existing models gain these fields:

```prisma
// AdCampaign: origin String @default("human"); assistantKey String?; lifetimeBudgetMinor BigInt?; targetCostPerResultMinor BigInt?; sandbox Boolean @default(false)
// AdSet: lifetimeBudgetMinor BigInt?
// MetaAsset: sandbox Boolean @default(false)
// Message: origin String?; pricingCategory String?; estCostMinor BigInt?; costMinor BigInt?; billable Boolean?; pricingType String?;
//          spendDay DateTime? @db.Date; spendState String?; reservationId String?; pricingSettledAt DateTime?
// UsageLedger: inputTokens Int?; outputTokens Int?; model String?
// NOTE: the partial indexes, CHECK constraints and append-only triggers in 0009 exist only in SQL.

model SpendControl {
  tenantId                       String    @id
  freeze                         String    @default("none") // none | assistants | all
  frozenByKind                   String?
  frozenByUserId                 String?
  frozenReason                   String?
  frozenAt                       DateTime?
  probation                      String    @default("auto") // auto | lifted | forced
  probationReason                String?
  probationChangedByUserId       String?
  verifiedAt                     DateTime?
  spendingAdAccountAssetId       String?
  timezone                       String    @default("Asia/Kolkata")
  approverUserIds                String[]  @default([])
  approvalTtlHours               Int       @default(12)
  targetCostPerLeadMinor         BigInt?
  breakersMayPauseHumanCampaigns Boolean   @default(false)
  digestEnabled                  Boolean   @default(true)
  version                        Int       @default(1)
  updatedAt                      DateTime  @updatedAt
}

model SpendAllowance {
  id                   String   @id @default(cuid())
  tenantId             String
  pot                  String   // ads | messaging | ai
  currency             String
  dailyLimitMinor      BigInt?
  monthlyLimitMinor    BigInt?
  migratedFromCapMinor BigInt?
  version              Int      @default(1)
  updatedByUserId      String?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  @@unique([tenantId, pot])
}

model SpendCeiling {
  id           String    @id @default(cuid())
  scope        String    // platform | probation | plan | tenant
  scopeId      String    // '*' | Plan.id | Tenant.id
  pot          String
  currency     String
  dailyMinor   BigInt?
  monthlyMinor BigInt?
  reason       String?
  setByUserId  String?
  expiresAt    DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  @@unique([scope, scopeId, pot, currency])
}

model SpendCommitment {
  id                       String    @id @default(cuid())
  tenantId                 String
  adAccountAssetId         String
  campaignId               String
  adSetId                  String?
  metaObjectId             String
  objectLevel              String    // campaign | adset
  origin                   String    // human | assistant | api
  assistantKey             String?
  currency                 String
  timezone                 String
  dailyBudgetMinor         BigInt?
  lifetimeBudgetMinor      BigInt?
  pendingFromMinor         BigInt?
  dayKey                   DateTime? @db.Date
  dayStartBudgetMinor      BigInt?
  peakDailyBudgetMinor     BigInt    @default(0)
  weekStart                DateTime? @db.Date
  weekPeakDailyBudgetMinor BigInt    @default(0)
  startsAt                 DateTime?
  endsAt                   DateTime?
  status                   String    // reserved | live | unconfirmed | stopped
  reservedUntil            DateTime?
  correlationId            String?
  sandbox                  Boolean   @default(false)
  version                  Int       @default(1)
  createdAt                DateTime  @default(now())
  updatedAt                DateTime  @updatedAt
  @@index([tenantId, status])
  @@index([status, reservedUntil])
}

model SpendCounter {
  tenantId      String
  pot           String   // messaging | ai
  periodKind    String   // day | month
  periodKey     String   // YYYY-MM-DD | YYYY-MM (workspace time zone)
  currency      String
  reservedMinor BigInt   @default(0)
  spentMinor    BigInt   @default(0)
  reconciledAt  DateTime?
  updatedAt     DateTime @updatedAt
  @@id([tenantId, pot, periodKind, periodKey])
}

model SpendReservation {
  id            String    @id @default(cuid())
  tenantId      String
  pot           String
  currency      String
  subjectType   String    // broadcast | automation_run | api_batch | ai_call
  subjectId     String
  amountMinor   BigInt
  consumedMinor BigInt    @default(0)
  status        String    @default("held") // held | settled | released | expired
  dayKey        String
  monthKey      String
  expiresAt     DateTime
  correlationId String
  createdAt     DateTime  @default(now())
  closedAt      DateTime?
  @@index([status, expiresAt])
}

model SpendDaily {
  tenantId    String
  pot         String
  scopeType   String   // account | campaign | adset | phone
  scopeId     String
  day         DateTime @db.Date
  currency    String
  amountMinor BigInt   @default(0)
  origin      String   // platform | external | all
  results     Int?
  impressions BigInt?
  clicks      BigInt?
  source      String   // fast_sync | insights | pricing | sim
  syncedAt    DateTime
  @@id([tenantId, pot, scopeType, scopeId, day, origin]) // (critic) origin in the key
  @@index([tenantId, pot, day])
}

model IntradaySpendSample {
  id               String   @id @default(cuid())
  tenantId         String
  adAccountAssetId String
  entityType       String   // account | adset
  entityMetaId     String
  accountDate      DateTime @db.Date
  sampledAt        DateTime
  spendMinor       BigInt
  impressions      BigInt
  clicks           BigInt
  results          Int
  @@index([tenantId, entityMetaId, sampledAt])
}

model SpendLedger {
  id                 String   @id @default(cuid())
  seq                BigInt   @unique @default(autoincrement())
  tenantId           String
  pot                String   // ads | messaging | ai | none
  action             String
  phase              String   // requested | applied | failed | unconfirmed | refused | shadow | reconciled | info
  actorType          String   // user | assistant | system | breaker | platform_admin | api | external (critic)
  actorId            String?
  assistantKey       String?
  autonomyLevel      Int?     @db.SmallInt
  targetType         String?
  targetId           String?
  metaObjectId       String?
  currency           String?
  amountMinor        BigInt?
  forecastTodayMinor BigInt?
  forecastMonthMinor BigInt?
  before             Json?
  after              Json?
  snapshot           Json?
  reason             String
  reasonCodes        String[] @default([])
  approvalId         String?
  undo               Json?
  correlationId      String
  idempotencyKey     String?
  observe            Boolean  @default(false)
  sandbox            Boolean  @default(false)
  createdAt          DateTime @default(now())
  @@index([tenantId, createdAt])
  @@index([tenantId, seq])
  @@index([targetId, action, createdAt])
  @@index([correlationId])
}

model MetaSpendLimit {
  adAccountAssetId                  String    @id
  tenantId                          String
  accountExternalId                 String    // (critic) act_ id; partial unique "one manager" index in SQL only
  spentAtLastWriteMinor             BigInt?   // (critic)
  mode                              String    @default("off") // ... | other_workspace (critic)
  consentId                         String?
  unitMode                          String    @default("unverified")
  semantics                         String    @default("unverified")
  customerCapAtConsentMinor         BigInt?
  customerAmountSpentAtConsentMinor BigInt?
  managedCapMinor                   BigInt?
  targetCapMinor                    BigInt?
  pendingTargetMinor                BigInt?
  lastReadCapMinor                  BigInt?
  lastReadAmountSpentMinor          BigInt?
  lastReadAt                        DateTime?
  monthKey                          String?
  monthStartAmountSpentMinor        BigInt?
  loosenessMinor                    BigInt?
  deferredUntil                     DateTime?
  writesBlockedUntil                DateTime?
  lastWriteAt                       DateTime?
  lastError                         String?
  currency                          String?
  timezone                          String?
  accountStatus                     Int?
  isPrepay                          Boolean?
  version                           Int       @default(1)
  updatedAt                         DateTime  @updatedAt
  @@index([tenantId])
}

model SpendConsent {
  id          String   @id @default(cuid())
  tenantId    String
  userId      String
  kind        String   // meta_spend_cap | owner_whatsapp
  subjectId   String?
  granted     Boolean
  textVersion String
  textSha256  String
  createdAt   DateTime @default(now())
  @@index([tenantId, kind, subjectId, createdAt])
}

model AssistantMandate {
  id                     String    @id @default(cuid())
  tenantId               String
  assistantKey           String
  enabled                Boolean   @default(false)
  level                  Int       @default(0) @db.SmallInt
  allowedOps             String[]  @default([])
  maxDailyMinor          BigInt?
  maxMonthlyMinor        BigInt?
  currency               String?
  targetCostPerLeadMinor BigInt?
  raiseStepPct           Int       @default(20)
  approvalSharePct       Int       @default(25)
  shadowStartedAt        DateTime?
  shadowUntil            DateTime?
  sandboxOnly            Boolean   @default(false)
  updatedByUserId        String?
  version                Int       @default(1)
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt
  @@unique([tenantId, assistantKey])
}

model SpendApproval {
  id                 String    @id @default(cuid())
  tenantId           String
  assistantKey       String
  pot                String
  actionKind         String
  direction          String    // raise | lower
  intent             Json
  fingerprint        String
  summary            String
  reason             String
  forecastTodayMinor BigInt?
  forecastMonthMinor BigInt?
  currency           String?
  status             String    @default("pending")
  tokenHash          String    @unique
  expiresAt          DateTime
  decidedByUserId    String?
  decidedVia         String?
  decidedAt          DateTime?
  appliedAt          DateTime?
  failureReason      String?
  proposalId         String?
  notifiedAt         DateTime?
  correlationId      String
  createdAt          DateTime  @default(now())
  @@index([tenantId, status, expiresAt])
}

model SpendBreaker {
  id              String    @id @default(cuid())
  tenantId        String
  kind            String
  scopeType       String
  scopeId         String
  state           String    @default("tripped")
  effect          String
  reason          String
  details         Json?
  trippedAt       DateTime  @default(now())
  clearedAt       DateTime?
  clearedByUserId String?
  autoClearAt     DateTime?
  notifiedAt      DateTime?
  @@index([tenantId, state])
}

model AssistantShadowRecord {
  id                 String    @id @default(cuid())
  tenantId           String
  assistantKey       String
  actionKind         String
  intent             Json
  wouldDecision      String    // auto | needs_approval | refuse
  forecastMonthMinor BigInt?
  currency           String?
  reason             String
  baseline           Json?
  outcome            Json?     // { h24: {...}, h72: {...}, verdict: would_have_helped | would_have_hurt | neutral | unknown }
  evaluatedAt        DateTime?
  createdAt          DateTime  @default(now())
  @@index([tenantId, assistantKey, createdAt])
}

model OwnerNotifyChannel {
  id                String    @id @default(cuid())
  tenantId          String
  userId            String
  phoneE164         String
  optInAt           DateTime?
  optInTextVersion  String?
  verifiedAt        DateTime?
  optOutAt          DateTime?
  notifierContactId String?
  lastSentAt        DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  @@unique([tenantId, userId])
  @@index([phoneE164])
}
```

### 3.4 PlatformSetting keys (no migration)

| Key | Value | Written by |
|---|---|---|
| `spend:platform` | `{freeze: 'none'\|'assistants'\|'all', reason, byUserId, at, version}` | Platform admin (kill switch) |
| `spend:fx` | `{base: 'INR', rates: {USD: '84.10', ...}, updatedAt, byUserId}` | Platform admin |
| `spend:notify` | `{tenantId, phoneNumberId, language: 'en', templates: {approval, alert, digest, optin}}` | Platform admin |
| `spend:defaults` | `{metaCapRoutinePerDay: 6, metaCapEmergencyReserve: 4, metaCapRaisesPerDay: 2, shadowDays: 14, breaker thresholds}` | Platform admin |
| `spend:meta-verified` | `{unitMode, semantics, floorRule, taxIncluded, applyDelayMin, verifiedAt, notes}` from runbook V1-V9 | Deployer |
| `spend:sync:<tenantId>` | fast-sync backoff state (`ads:insights:state:<tenantId>` stays for the 6-hour sync) | Worker |

`MAX_DAILY_BUDGET_MINOR` is deprecated. If it is set, it is read as an INR `platform` daily ceiling for the ads pot, and a startup warning is logged.

### 3.5 Data registry and erasure

`src/lib/lifecycle/personal-data.ts` registers the 15 new tables that have a `tenantId` column. `tests/lifecycle-personal-data.test.ts` requires this.

| Table | Erase method | Retention |
|---|---|---|
| SpendLedger, SpendConsent | new method `append-only-purge` (purge GUC inside one transaction) | Life of the workspace |
| SpendControl, SpendAllowance, AssistantMandate, MetaSpendLimit, SpendCommitment, SpendCounter, SpendBreaker | delete | Life of the workspace (stopped commitments 400 days, cleared breakers 400 days) |
| SpendReservation | delete | Closed rows 90 days |
| SpendDaily, AssistantShadowRecord | delete | `insightSnapshotDays` |
| IntradaySpendSample | delete | 35 days |
| SpendApproval | delete | `approvalRequestDays` |
| OwnerNotifyChannel | delete; personal data (phone); also removed with the membership | Life of the membership |

SpendCeiling has no `tenantId` column. Erasure also deletes `scope='tenant' AND scopeId=<tenantId>`, in `erase-workspace.ts`. The existing deletion of every PlatformSetting whose key contains the tenant id covers `spend:sync:<tenantId>`.

(critic) Two more erasure duties:

- **The notifier workspace holds the owner's data too.** Erasing a workspace, or removing a member who had an OwnerNotifyChannel, also deletes that person's Contact, Conversation and Messages in the notifier workspace, found through `notifierContactId`. If the same phone still has a channel in another workspace, only the Messages about the erased workspace go. The notifier writes the subject workspace id into `statusTimeline[0].tenantRef` when it sends, the same slot `admin_test` already uses for its marker.
- **Meta's limit outlives the data.** Before erasure (and on soft delete), the offboarding choice in 5.8 is applied while the Meta token still works. Otherwise the cap Edwyz wrote stays on the customer's ad account after Edwyz has forgotten it.

---

## 4. Enforcement

### 4.1 Invariants (each has a test)

- **I1. Raising needs a permit.** No Meta write that RAISES spend happens without a permit from the Spend Book, validated against the database just before the HTTP call. Raising writes are:
  - status ACTIVE on an ad, ad set or campaign;
  - a higher daily_budget or lifetime_budget;
  - a later end_time;
  - creating an object that is not PAUSED;
  - a higher spend_cap.

  The transport tripwire refuses a raising write that has no valid permit.
- **I2. Lowering never waits and is never refused.** Pause, archive, a budget cut, stopping a broadcast and lowering the Meta cap take no allowance check and no lock, and they work while frozen. The order is: ledger `requested`, the call, then the commitment update and the ledger outcome.
- **I3. Reserve before the call, settle after it.** A crash in between leaves the reservation counted. A reconciler reads the truth from Meta within 10 minutes.
- **I4. Commitments count at their worst case** (4.5), never at the nominal budget.
- **I5. One lock per tenant and pot.** Every check-then-reserve section for a tenant and pot runs under `pg_advisory_xact_lock(21328, hashtext(tenantId || ':' || pot))`, which serializes the web process, the worker daemon and `/api/internal/tick`. The exception is the per-message and per-AI-call path, which is a single conditional UPDATE and is atomic without the lock. The in-process `withCapLock` and `holdCredits` maps are retired.
- **I6. The ledger is append-only** (trigger). Each decision has one `requested` row and exactly one outcome row with the same correlationId. Idempotency keys make job retries harmless.
- **I7. Wall (a) keeps Meta's cap** on each consented ad account at `amount_spent` plus what is left of the monthly allowance (section 5).
- **I8. Raises fail closed; lowering fails safe.** A raise is refused when:
  - there is no daily ads limit;
  - the currency is unknown;
  - the FX rate is stale;
  - state cannot be read;
  - the lock times out.
- **I9. Every outbound WhatsApp message and every AI call passes its single gate.** These are `processSendJob` and `spend/exec/ai.ts`. The bypass test enforces it.
- **I10 (critic). Fixed lock order, and no network inside a lock.** Locks are always taken in this order: the metacap account lock `(21329, account)`, then the spend lock `(21328, tenant:pot)`. Spend locks for different pots are never held together. No Meta, WhatsApp or AI request runs while either lock is held. Data that needs a fresh Meta read is read before the lock is taken (4.6 step 8).
- **I11 (critic). A missing row means the safe default, never "no limits".** A tenant created after 0009 has no SpendControl or SpendAllowance row. `getControl()` upserts the defaults on first read (freeze `none`, probation `auto`, time zone from the ad account, then RoutingConfig, then Asia/Kolkata). A missing allowance is "Not set" with the rules in 4.4. Signup and onboarding also create the SpendControl row.
- **I12 (critic). Observe mode never weakens a check that is enforced today.** `SPEND_ENFORCE=observe` applies only to checks that are new in Phase 0: the monthly ads limit, probation, plan and platform ceilings, the messaging pot, the Meta-room check, the ad set budget-change quota and the spending-account rule. Checks enforced today stay enforced in observe mode: a daily ads limit must be set, the daily limit itself (the migrated ceil(1.75 C) equals today's check), the currency match, the AI monthly credit limit, and refusing a create that is not PAUSED.

### 4.2 Layers

1. **The Spend Book** (`src/lib/spend/*`) is the only code that decides money. It owns the limits, worst case, commitments, counters, reservations, ledger, freezes, breakers state and the assistant policy.
2. **The choke points** ask the book:
   - ads: `src/lib/ads/client.ts` (guarded client);
   - Meta cap: `src/lib/spend/metacap/client.ts`;
   - WhatsApp: `src/lib/inbox/send.ts` `processSendJob` plus enqueue-time checks;
   - AI: `src/lib/spend/exec/ai.ts`.
3. **The transport tripwire** in `src/lib/graph/index.ts` `run()` refuses raising Graph writes that carry no valid permit. It catches any code path that skips layer 2.
4. **The static bypass test** (`tests/spend-bypass.test.ts`) fails the build when new code calls spend endpoints or hosts outside the allowlist.

### 4.3 Lock (`src/lib/spend/lock.ts`)

```ts
withSpendLock<T>(tenantId: string, pot: Pot, fn: (tx: Tx) => Promise<T>): Promise<T>
// prisma.$transaction(async tx => {
//   await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
//   await tx.$executeRaw`SELECT pg_advisory_xact_lock(21328, hashtext(${tenantId + ':' + pot}))`;
//   return fn(tx);
// }, { timeout: 8000 })
```

- A lock timeout becomes `SpendBusyError`: HTTP 503 with "Busy checking your limits. Try again in a moment."
- The lock is never held across a Meta, WhatsApp or AI call.
- The two-key form is a separate keyspace from the existing single-key `hashtext()` locks.
- (critic) Lock order follows I10. `withSpendLock` throws in development and tests if the same async context already holds a spend lock for another pot (it tracks this in AsyncLocalStorage), so ordering mistakes fail in tests rather than as production deadlocks.
- (critic) `recordLowering` step 4 waits for this lock only to update its own bookkeeping, after Meta has already applied the lowering. If that wait times out, the commitment is left at the higher, over-counted value, the ledger outcome is still written, and the reconciler corrects the commitment within 2 min. The lowering itself never fails because of the lock.

### 4.4 Limits resolution (`allowances.ts`, `ceilings.ts`, `probation.ts`, `fx.ts`)

```ts
effectiveLimits(tenantId, pot, currency, tx?): Promise<{
  daily: bigint | null; monthly: bigint | null;
  owner: {daily, monthly}; ceiling: {daily, monthly, source: 'tenant'|'platform'|'plan'|'probation'|null};
  binding: 'owner'|'tenant'|'platform'|'plan'|'probation'; unknownCeiling: boolean }>
```

- **The ceiling** is the unexpired `tenant` override if one exists. Otherwise it is min(platform, plan (the subscription's planId, or the `trial` plan while trialing), probation if probation is on). Each ceiling resolves to the pot currency through the per-currency row, then FX rounded down, then UNKNOWN.
- **The effective limit** is min(owner, ceiling).
  - Ads: when the owner's daily limit is null, no ads may start ("Not set. Ads can't start until you set a daily limit"), whatever the ceiling. When the owner's monthly limit is null, the monthly ceiling applies if there is one; otherwise humans are checked against the daily limit only, and assistants are refused.
  - Messaging and AI: when the owner's limit is null, the ceiling applies if one exists. Otherwise humans and existing automations are counted, not limited, and assistants are refused.
  - The AI monthly limit is always at most the plan's `aiCreditsMonthly`, or `AI_DEFAULT_MONTHLY_CREDITS`. It is never unlimited, as today.
- **Probation is on** when `probation = 'forced'`, or when `probation = 'auto'` AND fewer than 2 Invoices have `paidAt` AND `verifiedAt` is null.
  - (critic) All of it is computed on read; the backfill writes `auto` for everyone. `probation = 'auto'` is on unless the tenant is `billingExempt`, OR at least 2 Invoices have status `paid`, a `paidAt` and `totalPaise > 0`, OR `verifiedAt` is set. A void invoice does not count, and an exemption that is revoked brings probation back on the next read. `lifted` is written only by a platform admin's `lift_probation`.
  - (critic) Under the 1.75x rule, the ₹2,000 daily probation ceiling allows at most ₹1,142 a day of total daily budgets. The new-workspace note says so: "That is up to ₹1,142 a day in ad budgets, because Meta can spend 75% more on a busy day." (12.1 question 7 asks the owner to confirm this reading.)
- **An UNKNOWN ceiling** (no row and no fresh FX) refuses raises for assistants, and for humans while on probation. Copy: `spend.currency`.
  - (critic) The admin panel's alerts strip counts the workspaces waiting on a missing rate or ceiling: "No USD limits for new workspaces: 3 workspaces can't start ads."
- (critic) **`MAX_DAILY_BUDGET_MINOR` parity.** When it is set, it is read as an INR `platform` daily ads ceiling of ceil175(value), not value. It used to bound the nominal sum of daily budgets, and this keeps that meaning under the worst-case maths (the same rule as the backfill).

### 4.5 Worst-case maths (`worstcase.ts`, pure)

Definitions:

- Each commitment c has D (current daily budget), `peakToday` (the highest daily budget this account day), `weekPeak` (the highest daily budget this Sunday-to-Saturday week), an optional lifetime budget L, and endsAt.
- `ceil175(x) = (7x + 3) / 4` (integer division, rounding up).
- `dayRisk(c, spentToday_c) = max(0, ceil175(c.peakToday) - spentToday_c)`.
- `remainingMonth(c, now, tz, spentByDay)` walks the account-time-zone days from today to min(endDay, monthEnd), with endDay inclusive:
  - the daily cap is `ceil175(day == today ? peakToday : D)`;
  - each Sunday key's week room starts at `7 x max(D, weekPeak)` minus the spend already made that week, including days in the previous month;
  - `take = min(dayCap - (today ? spentToday_c : 0), weekRoom)`, floored at 0, and the walk sums the takes;
  - with a lifetime budget the result is `min(sum, L - spentLifetime_c)`;
  - without endsAt (human campaigns only) the horizon is month end, and the next month reserves again at rollover.
- **External risk.** It applies only when Meta's limit is managed (decision 2.3.4). E is the highest daily spend over the last 7 days from campaigns not made on the platform. The month walk runs with D = E. The day risk is `max(0, E - externalSpentToday)`. The UI labels it as an estimate.
- **(critic) Lifetime-only commitments** (lifetime budget L, no daily budget). Meta documents no per-day ceiling for these. So, until runbook V10 measures one, `dayRisk = L - spentLifetime_c`: the whole remainder could land today. `remainingMonth` is the same amount, because Meta does not exceed a lifetime budget. That is safe but strict. A large lifetime budget can fill a whole daily limit, so the campaign wizard and the assistant builders default to a daily budget plus an end date, which R2 also accepts. The copy explains: "Meta can spend a lifetime budget unevenly, so we set the rest of it aside for today."
- **(critic) Ad set budget sharing.** The builders send `is_adset_budget_sharing_enabled: false`. If the structure sync (4.6.1) finds sharing turned on (for example in Ads Manager), that campaign's ad sets use 2.1x for the day (`ceil210(x) = (21x + 9) / 10`) and 8.4x for the week, which are third parties' measured worst case.

Worked example (October 2026; 1 Oct is a Thursday; ₹1,000 a day; nothing spent yet):

| Case | Days | Worst case |
|---|---|---|
| All of October | 1-3 Oct: 3 x 1,750 = 5,250; then 4 full weeks at 7,000 | ₹33,250 |
| Ends 14 Oct | 5,250 + 7,000 + (11-14 Oct: min(4 x 1,750, 7,000) = 7,000) | ₹19,250 |
| Launched Wed 28 Oct, runs to month end | 28-31 Oct: min(4 x 1,750, 7,000) | ₹7,000 |

### 4.6 The Spend Book API (`book.ts`, `commitments.ts`, `reconcile.ts`)

```ts
type Pot = 'ads' | 'messaging' | 'ai';
type SpendActor =
  | { type: 'user'; userId: string; role: Role }
  | { type: 'assistant'; assistantKey: string; approvalId?: string }
  | { type: 'system'; job: string }
  | { type: 'breaker'; kind: string }
  | { type: 'platform_admin'; userId: string }
  | { type: 'api'; keyId: string; userId?: string };

headroom(tenantId, pot, opts?): Promise<Headroom>
// Headroom = { currency, limits, month: {spent, committed, held, left}, today: {spent, committed, held, left},
//              external: {counted, spentMonth, riskMonth, estimated: true}, freeze, breakers[], probation, metaLimit }
```

**Ads figures:**

- **Counted spend.** It comes from SpendDaily. It is scope `account` (origin `all`) when Meta's limit is managed. Otherwise it is the sum of the `adset` and `campaign` rows with origin `platform`.
- **Committed** = Σ remainingMonth over commitments in `reserved`, `live` and `unconfirmed`, plus external risk when it is counted.
- **dayUse** = spentToday (counted) + Σ dayRisk + external day risk when counted.
- **monthUse** = spentMonth + committed.
- **Stale data.** If no fast sync has landed for 60 min, each live commitment's spentToday is treated as unknown, which means dayRisk = ceil175(peakToday).
- **(critic) Orphan active campaigns.** Any AdCampaign with DB status `active` (and any AdSet under it) that has no open commitment is counted as a synthetic live commitment: origin from the campaign, budgets from the DB, time zone from the account, and peakToday = weekPeak = the current budget. This covers a late backfill, a crash between a DB write and the commitment write, and the structure sync's discoveries before they are written. The reconciler turns each orphan into a real row and ledgers `ads.commitment.reconciled`.

**Messaging and AI figures** come from SpendCounter (`spentMinor + reservedMinor`) for the day key and the month key.

```ts
reserveAds(tenantId, intent: AdsRaiseIntent, actor: SpendActor,
           opts: { idempotencyKey: string; reason: string; approvalId?: string }): Promise<AdsPermit>
type AdsRaiseIntent =
  | { kind: 'activate'; campaignId; sets: { adSetId; metaAdSetId; dailyBudgetMinor?; lifetimeBudgetMinor?; endsAt? }[] }
  | { kind: 'raise_budget'; adSetId; metaAdSetId; toMinor; shiftFromAdSetId?: string }
  | { kind: 'resume_ad'; adId; metaAdId }
  | { kind: 'resume_adset'; adSetId; metaAdSetId }
  | { kind: 'extend_end'; campaignId; endsAt }
  | { kind: 'create_live' };   // always refused in Phase 0
```

Steps inside `withSpendLock(tenant, 'ads')`. Each refusal throws `SpendBlockedError(code, copyParams)` and writes a `refused` ledger row, which carries `observe=true` when `SPEND_ENFORCE=observe` lets a human action through.

(critic) Ledger shape for refusals. A refusal happens before step 12, so a `refused` row stands alone, with its own correlationId and no `requested` row, like `shadow` and `info`. An observe-mode would-refusal (only for the new checks, I12) is also a standalone `refused` row with `observe=true`. The action then goes on with its normal `requested` / outcome pair under a new correlationId, and the `refused` row's `snapshot.continuedAs` points to it. The orphan crosscheck (9.1) skips standalone rows.

1. **Idempotency.** An existing `requested` row whose permit is still valid is returned.
2. `spendState({fresh: true})`. Refuse on a workspace or platform freeze `all`, or on freeze `assistants` when the actor is an assistant.
3. Refuse when an open breaker with effect `pause_scope` or `block_raises` covers the object, campaign, ad account or workspace. A breaker actor resuming after a `daily_limit` clear is exempt only for its own breaker.
4. `effectiveLimits`. Refuse when:
   - the daily limit is null;
   - the monthly limit is null and the actor is an assistant;
   - the currency differs from the account's;
   - the ceiling is unknown and the actor is an assistant, or the workspace is on probation;
   - the ad account is not the workspace's spending ad account, for activate and raise intents.
5. Load the open commitments of the account plus SpendDaily (month to date and this week).
6. Simulate the intent: update the D, peak and week peak of the affected commitments, giving before and after dayUse and monthUse. A `shiftFromAdSetId` counts the paired cut, which must already be applied, as freed.
7. Refuse when dayUse_after > daily or monthUse_after > monthly. The copy carries "left" and "needs".
8. **Meta room check** on a managed account. Refuse with `META_CAP_TOO_LOW` and queue a metacap P3 raise when `lastReadCap - lastReadAmountSpent` < Σ dayRisk_after, using a read no older than 15 min (read now if older).
   - (critic) The "read now" happens BEFORE `withSpendLock` is taken (I10): `reserveAds` calls `metacap.ensureFreshRead(account, 15 min)` first, then locks. If the stored read is still older than 15 min inside the lock (for example, the read failed), the check uses the stored values when they are under 6 h old and refuses with `META_CAP_TOO_LOW` otherwise. It never calls Meta while holding the lock.
9. **Meta budget-change quota.** Refuse a non-breaker budget raise when this ad set already has 3 or more `requested` budget rows in the last 60 min. Copy: "Meta allows 4 budget changes an hour for each ad set; we keep one for safety."
   - (critic) Edits made in Ads Manager also count against Meta's 4-an-hour limit, and Edwyz cannot see them in its ledger. When Meta answers a budget write with 613/1487632, the ad set gets an open `budget_change_quota` breaker with `autoClearAt = now + 60 min`. Until then breakers and cuts use PAUSED instead of budget edits, and raises are refused with `spend.meta_rate`.
10. **Assistant actors** go through `policy.decide(...)` (7.2):
    - `needs_approval` creates a SpendApproval in the same transaction and throws `NeedsApprovalError` (202);
    - `shadow` writes an AssistantShadowRecord and throws `ShadowOnlyError`;
    - `refuse` throws.
    The mandate's maxDaily, maxMonthly and allowedOps are checked here too.
11. Upsert the commitments to status `reserved` with `reservedUntil = now() + 10 min`. Update peak, day start and week peak, set `pendingFromMinor` to the old budget for a raise, and add 1 to the version.
12. Write ledger `requested` with before and after values, `forecastTodayMinor = Δ dayUse`, `forecastMonthMinor = Δ monthUse`, the snapshot and the undo recipe.
13. Return `AdsPermit {correlationId, tenantId, kind, objects: {metaId: {maxDailyMinor?, status?}}, paths, maxUses, expiresAt}`. It is minted by `permit.ts`.

```ts
assertPermitValid(permit, metaObjectId): Promise<void>
// One fresh SELECT. The commitment must be 'reserved' with reservedUntil > now(), the object must be in the permit,
// and there must be no freeze and no blocking breaker. Otherwise it throws, and no HTTP call is made.

settleAds(permit, outcome: 'applied'|'failed'|'unconfirmed', detail?)
// applied:     reserved -> live.
// failed:      activate -> stopped; raise -> back to pendingFromMinor.
// unconfirmed: stays counted (status unconfirmed); the reconciler settles it.
// Always writes exactly one outcome ledger row.

recordLowering(tenantId, intent: {kind: 'pause'|'archive'|'cut_budget'|'end_earlier', metaObjectId, toMinor?, endsAt?},
               actor, reason, run: (permit: LoweringPermit) => Promise<void>)
// 1. Ledger 'requested' (no lock, no checks).
// 2. Mint a lowering permit valid for 2 min.
// 3. await run(permit).
// 4. Under the lock, set the commitment to stopped or to the lower budget. The peak stays, because Meta's 175% rule
//    uses the day's highest budget.
// 5. Ledger outcome. A failed run gives outcome 'failed' and the error is rethrown to the caller.

permitForPausedCreate(tenantId, adAccountExternalId, objectCount, actor): Promise<CreatePermit>
// Neutral. Refused only under freeze 'all' or platform 'all'. Paths are act_X/{campaigns,adsets,adcreatives,ads};
// maxUses = objectCount + 2; valid 10 min. The tripwire also requires status PAUSED on every create body.
```

**Reconciler** (`spend.commitments.reconcile`, every 2 min). It reads commitments in `reserved` past reservedUntil, or in `unconfirmed` for more than 5 min, with `GET <metaObjectId>?fields=effective_status,status,daily_budget,lifetime_budget,end_time` through the guarded client's read method:

- ACTIVE with budget X: the commitment becomes live at X;
- PAUSED or ARCHIVED: it becomes stopped;
- the ledger records `reconciled`.

On every sync it also corrects DB `AdCampaign.status = 'active'` rows whose Meta `effective_status` is PAUSED, which catches edits made in Ads Manager.

#### 4.6.1 Edits made in Meta Ads Manager to Edwyz campaigns (critic)

The reconciler above only reads objects that are `reserved` or `unconfirmed`, and the fast sync (6.1) only reads open commitments. That leaves platform campaigns that the customer changes in Ads Manager invisible when Meta's limit is not managed. Examples: resuming a campaign Edwyz shows as paused, raising a daily budget, removing an end date, adding an ad set, or switching to campaign budget. `spend.sync.structure` (`src/lib/spend/sync/structure.ts`) closes this.

- **Cadence.** It runs with every fast sync, and every 2 h for workspaces with platform campaigns but no open commitment. It makes 2 reads per spending ad account:
  - `GET act_X/campaigns?filtering=[{field:'id',operator:'IN',value:[...]}]&fields=id,status,effective_status,daily_budget,lifetime_budget,stop_time,is_adset_budget_sharing_enabled`;
  - `GET act_X/adsets?filtering=[{field:'campaign.id',operator:'IN',value:[...]}]&fields=id,campaign_id,status,effective_status,daily_budget,lifetime_budget,end_time`.
  
  The id lists are the Meta ids of every platform campaign that is not archived or was archived within the last 35 days, at most 50 ids per request. These are reads only, so they need no permit.
- **Rule: adopt the truth, never fight the customer.** Every difference is adopted into the book, so it is counted, and ledgered as `ads.external_change` with actorType `external`, phase `reconciled`, and before and after values. Edwyz never reverses a customer's own Ads Manager edit, apart from Meta's limit itself (5.6).

| Found on Meta | Book change | Notice |
|---|---|---|
| A platform campaign or ad set is ACTIVE but its commitment is stopped or missing | A live commitment at the observed budget (origin from the campaign), `AdCampaign.status = 'active'` | "<campaign> was turned on in Meta Ads Manager. It now counts against your limits." |
| A daily or lifetime budget is higher than the commitment | Commitment D, peakToday and weekPeak raised to the observed value | "The daily budget of <campaign> was changed in Meta Ads Manager from ₹800 to ₹1,500." |
| A budget is lower, or the object is paused, archived or deleted | Lowered or stopped, as `recordLowering` would | none |
| An ad set that Edwyz did not create, under a platform campaign | A new live commitment (origin `human`) | Included in the budget notice |
| The budget moved to campaign level, or budget sharing was turned on | Ad set commitments stopped; one campaign-level commitment created; 2.1x applies when sharing is on (4.5) | "Budget settings of <campaign> were changed in Meta Ads Manager." |
| An end date was removed or moved later | Human campaign: the new end, or no end (month-end horizon). Assistant campaign: the commitment keeps a counting horizon of the account month end, rolled forward each month, so the CHECK constraints hold. A `block_raises` breaker (`external_edit`) opens on that campaign for assistants | "<campaign> no longer has an end date. Your ad assistant won't change it until you set one." |

- **Limits still win.** An adopted change that pushes dayUse or monthUse over a limit is handled by the `daily_limit` and `monthly_limit` breakers on their next run (6.2). They pause platform campaigns, including this one. Edwyz therefore counts and contains outside edits without blocking the customer from making them.
- **Campaigns created in Ads Manager** (not under a platform campaign) are not structure-synced. They count only through the account-level spend when Meta's limit is managed (decision 2.3.4).

### 4.7 Transport tripwire (`src/lib/spend/tripwire.ts`, called first in `run()` of `src/lib/graph/index.ts`)

- `classify(request)` (pure, `classify.ts`) returns `not_spend`, `ads_raise_or_unknown`, `ads_lowering`, `ads_create`, `meta_cap` or `msg_send`.
  - **Spend writes:**
    - POST `act_X/{campaigns,adsets,ads,adcreatives}`;
    - POST `act_X` with `spend_cap` or `spend_cap_action`;
    - POST `<id>` whose body has any of `status`, `daily_budget`, `lifetime_budget`, `end_time`, `bid_amount`, `spend_cap`, `daily_spend_cap`, `lifetime_spend_cap`;
    - POST `<phoneNumberId>/messages`.
  - **Lowering:** POST `<id>` whose only spend keys are `status: PAUSED|ARCHIVED`.
  - **`not_spend` (fixtures):**
    - every GET;
    - CAPI `POST <dataset>/events`;
    - `POST <page>/subscribed_apps`;
    - content publishing (`/media`, `/media_publish`, `/feed`, `/photos`);
    - `DELETE <user>/permissions`;
    - template management;
    - media upload.
- `permitStore` is an AsyncLocalStorage holding a branded permit. Only `permit.ts` `mintPermit()` creates one, and only the book, the send gate and metacap import it (bypass rule B8).
- **Rules:**
  - `ads_raise_or_unknown`, `ads_create`, `meta_cap` and `msg_send` need a permit in the store with a matching tenant (for `graphFetch`) or account and objects (for `graphFetchAs`), a matching path, uses below `maxUses`, an unexpired `expiresAt`, and for budgets a body value at or below `objects[id].maxDailyMinor`.
  - `ads_create` additionally needs `body.status === 'PAUSED'`.
  - `ads_lowering` with no permit is ALLOWED and writes audit `spend.tripwire.unledgered_lowering`. A stop is never blocked.
- **Mode `SPEND_TRIPWIRE`:**
  - `report` (first deploy) logs and writes audit `spend.tripwire.bypass` (path pattern only, never the token);
  - `enforce` throws `SpendGuardBypassError` (500, code `spend_bypass`) before any network I/O.
  - Switch to `enforce` after 7 days with zero `spend.tripwire.bypass` rows. env-rules then requires `enforce` in production.

### 4.8 Ads choke point and call-site map

Signature: `adsClient(token, accountExternalId, guard: AdsGuard)` where `AdsGuard = {tenantId, adAccountAssetId, actor: SpendActor, sandbox: boolean}`. The guard is REQUIRED, so every caller fails to compile until it passes one. Methods:

- `createCampaign`, `createAdSet`, `createCreative(body, createPermit)` and `createAd`:
  - throw unless `body.status === 'PAUSED'`;
  - `createAdSet` additionally throws for assistant actors unless `end_time` is set, or `lifetime_budget` plus `end_time` (R2).
- `setStatus(id, 'PAUSED'|'ARCHIVED', loweringPermit?)`: lowering. It works without a permit (audited) and never blocks.
- `setStatus(id, 'ACTIVE', permit)`: `assertPermitValid`, then `permitStore.run(permit, () => graphFetchAs(...))`.
- `setDailyBudget(id, minor, permit)`: the book decides the direction. A raise needs `permit.objects[id].maxDailyMinor >= minor`.
- `setSpendCap(...)`: does not exist here. It lives only in `spend/metacap/client.ts`.
- `getObject(id, fields)` and `getAccount(fields)`: read only.
- `SPEND_DRY_RUN=1`, or `guard.sandbox` with `SPEND_SIM=1`, returns fake ids and success without calling Meta (staging and e2e). env-rules refuses `SPEND_DRY_RUN` in production.

| Call site (today) | Change | Direction |
|---|---|---|
| `ads/service.ts` `createCampaignDraft` / `parseDraftInput` | origin `assistant` requires endsAt (at most 90 days ahead) or a lifetime budget; drafts store origin and assistantKey | n/a |
| `ads/service.ts` `launchCampaign` / `validateCampaign` (`assertWithinCap`) | dry-run `headroom` check (no reservation) for early refusal copy; objects created with `permitForPausedCreate` | neutral |
| `ads/service.ts` `activateCampaign` (withCapLock block plus Meta loop) | `reserveAds({kind:'activate'})`; each `setStatus ACTIVE` carries the permit. An ambiguous final call gives `settleAds('unconfirmed')`. Any other failure pauses whatever was set ACTIVE (lowering), then `settleAds('failed')`. `confirmedTotalMinor` and the client-approval gate stay | raise |
| `ads/service.ts` `pauseCampaign`, `archiveCampaign` | `recordLowering` | lower |
| `ads/actions.ts` `pauseAd` | `recordLowering` | lower |
| `ads/actions.ts` `setAdSetBudget` | a cut goes through `recordLowering`. A raise goes through `reserveAds({kind:'raise_budget'})`; the clamp and `withCapLock` are removed, the refusal carries the exact room, and the optimizer may retry with a value read from `headroom`. `coveredIncreaseMinor` becomes `shiftFromAdSetId` | lower / raise |
| `ads/actions.ts` `resumeAd` (no cap check today) | `reserveAds({kind:'resume_ad'})`. This closes the gap | raise |
| new `ads/actions.ts` `pauseAdSet` | `recordLowering`. Breakers use it | lower |
| `tenant-lifecycle.ts` `pauseTenantAds` (via `windDownTenant`, `pauseAdsForBlockedTenants`) | `stopCommitments(..., {type:'system', job:'tenant-state'})` | lower |
| `meta-connect/revoke-all.ts` `pauseAllCampaigns` | `stopCommitments` | lower |
| `meta-connect/service.ts` disconnect (revokes without pausing today) | `beforeDisconnect`: `stopCommitments` for the account, then metacap P0 if any pause failed; refuses 409 unless the owner sends `force` with the typed "DISCONNECT" (section 5.9) | lower |
| `optimizer/service.ts` `approveProposal` | goes through `actions.ts` with the decider as actor; raising parts need an approver (7.3) | per kind |
| (critic) `optimizer/service.ts` `revertProposal` (replays `budgetBefore` or calls `resumeAd`) | goes through `actions.ts` with the person reverting as actor. Reverting a pause or a cut is a raise: it needs an approver and goes through `reserveAds`, so it can be refused. Reverting a raise is a lowering, so any admin may do it | per kind |
| breakers, kill switches | `stopCommitments` | lower |
| `caps.ts` `getCaps`, `setCaps`, `assertWithinCap`, `assertWithinWorkspaceCap`, `withCapLock` | shims. `getCaps` reads the SpendAllowance ads daily limit, falling back to the legacy key. `setCaps` writes through `allowances.ts`. The others delegate to `headroom` and the book. They are deleted in Phase 1 | n/a |
| `/api/ads/caps` GET (admin) / PUT (owner) | same contract, mapped to the ads daily limit. (critic) It keeps its OLD meaning, "the most your daily budgets may add up to", until Phase 1 removes it. PUT C stores `dailyLimitMinor = ceil175(C)`. GET returns `maxDailyBudgetMinor = floor(4 x dailyLimit / 7)`, the largest C with ceil175(C) ≤ the limit, so a value round-trips exactly. An owner using the CapPanel between train 1 and train 3, before the new help text ships, therefore gets exactly the room they typed. `e2e/growth-ads.spec.ts` keeps passing without new numbers | n/a |

`src/lib/ads/stop.ts` `stopCommitments(tenantId, filter: {origin?: 'assistant'|'all', adAccountAssetId?, metaObjectIds?}, actor, reason): Promise<{done, failed, unreachable}>`:

- It pauses at campaign level when a whole campaign is targeted. That is one call and does not use the ad set budget-change quota.
- Otherwise it pauses at ad set level.
- Every pause goes through `recordLowering`. It never throws.
- (critic) An object it could not pause (failed or unreachable, for example after a token expiry or a forced disconnect) stays counted with status `unconfirmed`. The reconciler cannot read it without a token, so it stops counting only when its end date passes, or at month end when it has none. Meta's limit (P0, when managed) bounds it meanwhile, and the owner is told which campaigns may still be running.

### 4.9 WhatsApp choke point

**Origin and category are stamped at enqueue.**

- `queueOutbound(input & {origin})` and `sendInteractive({..., origin})`. During migration `origin` defaults to `unknown`, which is treated as automated. WP-11 makes it required.
- The job payload gains `{origin, category, wabaRefId, reservationId?}`.
- Category comes from `Template.category`, looked up by (tenantId, the conversation's WABA, name, language). Free-form messages are `SERVICE`. An unknown template is `MARKETING`.
- The Message row gets `origin`, `pricingCategory` and `estCostMinor`.

| Origin class | Origins | Freeze `assistants` | Freeze `all` (workspace or platform) | Quality YELLOW | Quality RED / restricted / WABA disabled | Pot exhausted |
|---|---|---|---|---|---|---|
| Human | human, approval | send | send | send | send (Meta may reject) | send, flagged `over_limit` |
| Compliance | consent (STOP/START confirmations) | send | send | send | send | send |
| Platform | system_notify (notifier tenant), admin_test | send | admin_test is held under platform `all`; system_notify always sends | send | held (fallback to email) | system_notify always sends |
| API | api, mcp | send | held | hold MARKETING | held | refused at enqueue (409 `spend.messaging_limit`); held at send |
| Automated | broadcast, automation, chatbot, ai_reply, lead_sequence, commerce, unknown | send | held | hold MARKETING | held | held until the next workspace day or month. (critic) chatbot and ai_reply: fail with `messaging_limit` and hand the chat to the team (decision 2.3.12) |
| (critic) Eddy | eddy (a send the signed-in user confirmed on Eddy's preview card, 4.15) | send | send | send | send (Meta may reject) | send, flagged `over_limit` (it is the user's own confirmed message) |
| Assistant | assistant | held | held | hold MARKETING | held | refused |

`messagingGate(tenantId, job)` (`spend/messaging/gate.ts`) runs in `processSendJob` after `tenantMayRunBackground` and before the POST. It returns `{action:'send', permit}`, `{action:'hold', reason, retryAt}` (reusing `holdBlockedSend`: re-hold every 15 min, expiry 24 h for free-form and 7 days for templates) or `{action:'fail', code}`. Checks in order:

1. Freezes, read with at most a 5 s cache, applied per the table.
2. Template status, re-checked at send time and scoped by WABA. `paused`, `disabled` or `rejected` fails with `template_blocked` for every origin; a broadcast recipient goes back to pending, as today. `flagged` holds MARKETING broadcast and assistant sends.
3. Number and WABA breakers (`wa_quality_yellow`, `wa_quality_red`, `wa_restricted`, `waba_disabled`) per the table. `wa_restricted` holds only template sends outside an open window.
4. Cost:
   - With `job.reservationId` (broadcast, automation run, API batch), consume from that reservation.
   - Otherwise estimate = `rateFor(country, category, scale)`, or 0 when the conversation has a Click-to-WhatsApp referral under 7 days old. Then make the lock-free reservation:

```sql
WITH d AS (UPDATE "SpendCounter" SET "reservedMinor" = "reservedMinor" + $c, "updatedAt" = now()
           WHERE "tenantId"=$t AND "pot"='messaging' AND "periodKind"='day' AND "periodKey"=$day
             AND ($dayLimit IS NULL OR "spentMinor" + "reservedMinor" + $c <= $dayLimit) RETURNING 1),
     m AS (UPDATE "SpendCounter" SET "reservedMinor" = "reservedMinor" + $c, "updatedAt" = now()
           WHERE "tenantId"=$t AND "pot"='messaging' AND "periodKind"='month' AND "periodKey"=$month
             AND ($monthLimit IS NULL OR "spentMinor" + "reservedMinor" + $c <= $monthLimit) RETURNING 1)
SELECT (SELECT count(*) FROM d) AS d, (SELECT count(*) FROM m) AS m;
```

   - The counter rows are upserted first.
   - If either update matched 0 rows, the transaction is rolled back, which undoes the other, and the per-origin "pot exhausted" rule applies.
   - On success the Message gets `spendState='reserved'` and `spendDay`. After a successful send the reservation is settled (reserved minus the estimate, spent plus the estimate) and `spendState='settled'`. A failed send releases it.
   - (critic) Origins that are never blocked by cost (human, approval, consent, system_notify, eddy) use the same statement WITHOUT the limit conditions, so their cost is always counted. Then "flagged `over_limit`" means the unconditional update took the counter past the limit.
   - (critic) An ambiguous send is not a failed send. `processSendJob` records an ambiguous POST (`GraphError.ambiguous`, errorCode `send_unconfirmed`) as failed, but Meta may have delivered it. Its reservation is settled at the estimate, not released. If a status webhook later shows it was delivered or failed, settlement corrects the amount.
   - (critic) When a bulk reservation is used up (more recipients than estimated, or a re-estimate after `template_category_update`), the remaining messages fall back to the per-message conditional reservation above. They are never sent unreserved.
5. The permit is minted (`msg_send`, path `<phoneNumberId>/messages`, maxUses 1, valid 2 min), and the existing `graphFetch` runs inside `permitStore.run`.

**Bulk gates** (blocked above the allowance, R5). The conservative estimate is `estimateBreakdown`, changed so that:

- an unpriced country uses the HIGHEST card rate for that category;
- an unknown category counts as MARKETING;
- +1 and +7 numbers are priced at the maximum of the countries sharing the code;
- free entry point recipients are priced at 0;
- SERVICE is priced at the SERVICE rate, or the UTILITY rate when SERVICE is missing (the admin panel warns until it is set).

`reserveBulk(tenantId, 'messaging', estimate, {type, id}, ttl)` runs under the lock, inserts a SpendReservation and adds to the counters' `reservedMinor`. It returns 409 `spend.broadcast` when the estimate does not fit. Bulk sites:

- `broadcasts/service.ts` `startBroadcast`: before the status update; ttl 7 days.
- `automation/v2/timed.ts` `scanScheduled`: per run, before chunking.
- `compat/messaging.ts` `messageTemplates/send`: per call.
- `integrations/v1-service.ts` template sends and the MCP `send_template_message` tool: per call (an `api_batch` of 1).

`broadcasts/process.ts` releases the unspent part on completion or cancel.

(critic) Scheduled broadcasts. The reservation is taken when the broadcast starts, not when it is scheduled, because the audience can change before then. Scheduling therefore runs the same estimate as a dry run. If it would not fit at that moment, the scheduler warns: "At today's figures this broadcast won't fit your WhatsApp limit. It will pause when it's due unless the limit allows it." If it still does not fit when it is due, it pauses with reason `messaging_limit` and the owner is notified. A bulk reservation counts in full against the day it starts, even when Meta's tier spreads the sends over several days. This is conservative, and the 409 copy says "today".

**Actual cost** (`spend.messaging.settle`, every 5 min):

- `processor.ts` `handleStatus` stores `status.pricing {billable, type, category}` on the Message from the first status that carries it.
- The task applies one delta per tenant, `Σ (actual - estCostMinor)` with `actual = billable ? rateFor(country, category) : 0`, to `spentMinor`, sets `pricingSettledAt`, and writes one ledger row `messaging.settlement` (phase `reconciled`).
- (critic) Messages with no pricing object. Meta charges only on delivery, and a message that fails after Meta accepted it never carries pricing. So: a settled message whose status became `failed` settles at `actual = 0` (its estimate is given back). A settled message with no pricing 7 days after it was sent keeps its estimate and is marked settled, which is conservative. The settlement query uses `Message_pricing_unsettled_idx` (0010), whose predicate `spendState = 'settled' AND pricingSettledAt IS NULL` covers both cases.
- (critic) The delta is applied to the counters of the message's own `spendDay` and month, never today's. A refund for 31 Oct that is settled on 1 Nov frees October's room, not November's.
- SpendDaily `phone` rows feed the dashboard.

### 4.10 AI gateway (`src/lib/spend/exec/ai.ts`)

```ts
anthropicMessages(ctx: { tenantId: string; feature: 'agent_reply'|'inbox_suggest'|'creative'|'escalation'|'ai_test'|'eddy' /* (critic) */;
                         actor: SpendActor; credits: number }, body: Record<string, unknown>, timeoutMs: number): Promise<AnthropicResponse>
meteredProvider<T>(ctx, run: () => Promise<T>): Promise<T>   // metered image and video providers
```

1. Check freezes:
   - `all` stops every feature except a human-triggered `ai_test` by a platform admin;
   - `assistants` stops assistant actors only.
   - (critic) Corrected to match 4.11 and decision 2.3.11. Under `all` (workspace or platform), the automatic features stop: `agent_reply`, `escalation`, and any assistant actor. Features a signed-in person asks for continue within the AI limit: `inbox_suggest`, `creative`, `ai_test` and `eddy`. An `escalation` call that is refused (by a freeze or by the quota) falls back to "hand to a person", never "keep the bot talking".
   - (critic) The AI monthly credit limit is enforced today, so I12 keeps it enforced in observe mode.
2. `reserveAi` uses the same conditional-UPDATE pattern on SpendCounter (pot `ai`, CRD). It also inserts a SpendReservation `ai_call` (ttl 2 min) so that a crash is recovered. A refusal is HTTP 402 `ai_quota` with "This month's AI limit is used up." The AI agent hands the chat to a human.
3. `fetch`.
4. On success, settle with the actual credits, `recordUsage(ai_credits)`, and store `usage.input_tokens`, `output_tokens` and `model` on UsageLedger. On failure, release.

- **Callers:** `ai-agent/generate.ts` `callModel` (agent replies, inbox suggestions through `generateReply`, the AI test), `creative/llm.ts` `callClaude` and `chatbots/escalation.ts` `classifyWithAi`.
- `billing/limits.ts` `reserveCredits` keeps its signature but delegates to `reserveAi`. `holdCredits` (sync, in memory) is removed, and `ai-agent/index.ts` `admit()` awaits `reserveCredits`. The hourly reply cap (`AI_MAX_REPLIES_PER_HOUR`) stays.

### 4.11 Kill switches (`kill.ts`)

- **Workspace (`SpendControl.freeze`):**
  - `assistants` refuses every assistant intent, pauses assistant-launched commitments and holds assistant sends;
  - `all` refuses every raise, pauses every platform campaign, holds automated and API outbound, stops AI except for humans' own requests, and supersedes pending approvals.
  - Turning it on is allowed for admin or owner (it is a lowering). Turning it off is owner only. The platform admin can override in both directions.
- **Platform (`'spend:platform'`):** the same two levels. Platform admin only, with typed confirmation "STOP SPENDING", a reason and a TOTP step-up within the last 5 min. A platform freeze can only be cleared by a platform admin.
- **Propagation:**
  - toggling enqueues job `spend.stop`, handled by `tasks/adsguard.ts` calling `stopCommitments`;
  - `spend.kill.sweep` runs every 1 min as a safety net;
  - every raise path reads `spendState({fresh: true})`;
  - the send gate and AI gateway cache it for at most 5 s.
  - Broadcasts in `sending` are paused with the new reason `spending_stopped`.
- **Meta's cap is set to the stop value** (P0) only when a pause failed or an object was unreachable. That keeps the change budget, and does not stop ads the customer runs in Ads Manager when Edwyz's own pauses worked.
- **(critic) The stop does not wait for the worker.** A workspace toggle runs `stopCommitments` inline in the request, with a 20 s budget, and then enqueues `spend.stop` for whatever is left. The response says "Paused 6 of 6 campaigns", or "Paused 4 of 6; the rest will follow within a minute." A platform toggle pauses inline for at most 25 workspaces, ordered by money at risk, enqueues the rest, and shows progress on /admin/spending. If the worker daemon is down, the once-a-minute `/api/internal/tick` cron runs the job and the sweep (4.16).
- **(critic) Turning spending back on** clears the freeze only. Nothing restarts by itself (decision 2.3.13). Paused campaigns are listed for a guarded resume, and broadcasts paused with `spending_stopped` stay paused until someone resumes them.

### 4.12 Static bypass test (`tests/spend-bypass.test.ts`)

It walks `src/**/*.{ts,tsx}` with `fs.readdirSync`, the pattern used in `tests/optin-gating.test.ts`. Each rule has an allowlist, and each entry carries a one-line reason. The test runs in `npm test`, and the deploy steps run it before `next build`.

| Rule | Pattern | Allowed only in |
|---|---|---|
| B1 | `graph.facebook.com` | `graph/index.ts`; `templates/upload.ts` (media upload, not spend); `security/csp.ts` |
| B2 | `api.anthropic.com` | `spend/exec/ai.ts` (temporarily also the 3 legacy files, with reason "until WP-13"; WP-13 removes them) |
| B3 | `adsClient(` | `ads/service.ts`, `ads/actions.ts`, `ads/stop.ts`, `spend/reconcile.ts`, `spend/sync/fast-insights.ts` (reads only), (critic) `spend/sync/structure.ts` (reads only) |
| B4 | ``/messages[`'"]`` used as a POST path | `inbox/send.ts` |
| B5 | `enqueue("send"` | `inbox/service.ts`, `inbox/interactive.ts`, `inbox/send.ts` |
| B6 | `spendLedger.(update\|updateMany\|delete\|deleteMany\|upsert)`, `spendConsent.(update\|delete...)` | `lifecycle/erase-workspace.ts` (purge only) |
| B7 | writes to `spendAllowance`, `spendCeiling`, `spendControl`, `spendCommitment`, `spendCounter`, `spendReservation`, `assistantMandate`, `spendApproval`, `spendBreaker`, `metaSpendLimit` | `src/lib/spend/**`, `lifecycle/erase-workspace.ts` |
| B8 | import of `@/lib/spend/permit` / `mintPermit`; the text `as Permit` | `spend/book.ts`, `spend/commitments.ts`, `spend/messaging/gate.ts`, `spend/metacap/client.ts`, `spend/tripwire.ts` (`as Permit` banned everywhere) |
| B9 | `spend_cap` | `spend/metacap/**`, `spend/classify.ts`, `meta-connect/discovery.ts` (read field only) |
| B10 | `lifetime_budget`, `end_time`, `daily_budget` | `ads/builders.ts`, `ads/client.ts`, `spend/classify.ts`, read-only field lists in `ads/insights-fetch.ts`, `spend/reconcile.ts` and (critic) `spend/sync/structure.ts` |
| B11 | `funding_source` in any POST body | nowhere (R9) |
| B12 | `fetch(` to a host outside the allowlisted host list (Graph, Anthropic, Razorpay, SMTP, configured creative providers) | files listed in the test |
| B13 | `origin: 'human'` or `origin: "human"` in `src/lib/{automation,chatbots,leads,commerce,broadcasts,worker}/**` | nowhere (a worker cannot claim a human origin) |
| B14 (critic) | `origin: 'human'`, or an actor `{type: 'user'`, in `src/lib/eddy/**` (or wherever Eddy's action layer lives) | only the confirm-token executor named in 4.15 |

A self-test writes a temporary fixture with `fetch('https://api.anthropic.com')` and asserts that the scan fails on it.

### 4.13 Errors and copy (`copy.ts`, shown verbatim by the API and UI)

| Code | Copy |
|---|---|
| `spend.daily_limit` | "This would go over your ads limit for today. Left today: ₹850. This could spend up to ₹1,400 today, because Meta can spend up to 75% over a daily budget. Lower the daily budget or raise your limit." |
| `spend.monthly_limit` | "This would go over your ads limit for this month. Left this month: ₹3,200. This campaign could use up to ₹7,000 by its end date. Lower the budget, choose an earlier end date, or raise your limit." |
| `spend.no_limit` | "Set a daily ads limit in Settings > Spending limits before starting ads." |
| `spend.frozen` | "Spending is stopped for this workspace. The owner can turn it back on in Settings > Spending limits." |
| `spend.platform_frozen` | "Edwyz has paused new spending for a short while. Running ads are paused. We'll tell you here and on WhatsApp when it's back." |
| `spend.end_date_required` | "Ads started by an assistant need an end date." |
| `spend.currency` | "This ad account uses USD, but your limits are in INR. Limits for USD aren't set up yet." |
| `spend.not_spending_account` | "Edwyz can spend from one ad account per workspace for now. Choose it in Settings > Spending limits." |
| `spend.probation` | "New workspaces can spend up to ₹2,000 a day and ₹20,000 a month on ads for now." |
| `spend.meta_cap_too_low` | "Meta's spending limit on this ad account is close. We've asked Meta to raise it within your limits; try again in about 20 minutes." |
| `spend.meta_rate` | "Meta allows only 4 budget changes an hour for each ad set. Try again after 3:40 pm." |
| `spend.broadcast` | "This broadcast could cost about ₹4,300, but only ₹1,200 is left in your WhatsApp limit this month. Send to fewer people or raise the limit." |
| `spend.messaging_limit` | "This month's WhatsApp limit is used up. Automatic messages will wait until it resets on 1 Nov, or raise the limit." |
| `ai_quota` | "This month's AI limit is used up. AI replies and suggestions are off until 1 Nov. Your team can still reply." |
| `spend.busy` | "Busy checking your limits. Try again in a moment." |
| `spend.only_owner_raise` | "Only the owner can raise a limit. You can lower it." |
| `spend.version` | "Someone else changed these limits. Reload to see the latest." |

A test checks that no copy contains the words "minor units", "spend_cap", "allowance pot", "commitment" or "probation". The UI says "new-workspace limits".

### 4.14 Rollout flags (`src/lib/env-rules.mjs`, `.env.example`)

| Flag | Values | Meaning |
|---|---|---|
| `SPEND_ENFORCE` | observe \| enforce | Human paths only. Observe lets the action through and writes a `refused` row with `observe=true`. Assistants are always enforced. (critic) It applies only to the checks that are new in Phase 0. Today's checks stay enforced (I12) |
| `SPEND_TRIPWIRE` | report \| enforce | 4.7 |
| `SPEND_CAP_MODE` | off \| observe \| enforce | Wall (a). `observe` computes the target and writes `info` rows with no POST. `enforce` only after runbook V1-V9 |
| `ASSISTANT_SPEND_ENABLED` | false \| true | While false, every assistant's effective level is 0 and shadow cannot end. Flipped only after the exit criteria in 10.5 |
| `SPEND_DRY_RUN` | 0 \| 1 | No Meta writes (fake ids). Refused in production |
| `SPEND_SIM` | 0 \| 1 | Synthetic insights for sandbox accounts only |
| `SPEND_NOTIFY_SECRET` | 32+ bytes | HMAC for WhatsApp quick-reply payloads |
| `MAX_DAILY_BUDGET_MINOR` | deprecated | Read as an INR platform daily ads ceiling, with a warning |

Production also needs `SMTP_USER` and `SMTP_PASS` for the email fallback (open question 2).

### 4.15 Eddy and other in-app AI helpers (critic)

Eddy, the in-app helper ("acts as the signed-in user"), is being built alongside Phase 0. An AI that acts "as the user" would make its actions look human, so they would skip assistant mandates and get observe mode and "team messages always go out". That would be a bypass. The contract:

- **Eddy is not an assistant and holds no mandate.** It can only propose. Every action that spends, messages customers or raises anything becomes a preview card. The card shows the exact action and, for money, the same worst-case figures `headroom` gives the UI ("Could add up to ₹4,550 this month"). Nothing runs until the signed-in user taps confirm.
- **Confirm token.** The tap posts a single-use confirm token bound to the fingerprint of the exact intent (the `tenant-mcp/send-guard.ts` `issueConfirmToken` pattern). One executor, `src/lib/eddy/execute.ts`, redeems it. Only that executor may act as `{type: 'user', userId}` with `reasonCodes: ['via_eddy']` (bypass rule B14). A message it sends gets origin `eddy`, a campaign gets origin `human`, and the ledger rows carry `via_eddy`, so the activity table reads "Priya (with Eddy)".
- **Same rules as the person.** The action goes through the normal routes and the book with that user's role. An admin using Eddy still cannot raise a limit, and a team member cannot launch ads. Eddy never sees or mints permits.
- **Bulk actions stay bulk.** A broadcast Eddy prepares goes through `startBroadcast` and its bulk reservation, not as many single `eddy` sends.
- **Eddy's own AI calls** go through the gateway with feature `eddy` and count in the AI pot. Under freeze `all` they continue, because a person asked (decision 2.3.11). When the AI limit is used up, Eddy shows "This month's AI limit is used up" and stays usable as plain buttons.
- **Phase gate.** Eddy v1 (no spending actions) can ship with Phase 0. Eddy v2 actions on ads or leads ship only after WP-06 and WP-16 are live, because they need the book and the summary API.

The background funnel agents that Eddy fronts are assistants under section 7, with registry keys, mandates and shadow mode. They are never Eddy actions.

### 4.16 Worker downtime and degraded modes (critic)

Most breakers, the reconciler, metacap and the kill sweep run as periodic tasks in the worker daemon (`edwyz-wa-worker`). When the daemon is down, the once-a-minute cron `POST /api/internal/tick` runs the same passes, because the spend WorkerModule is registered in MODULES. So a dead daemon slows things by at most about a minute. When both the daemon and the web process are down, nothing on Edwyz's side runs. Then the protection is what was already committed: Meta's limit on managed accounts, end dates on assistant campaigns, and budgets that were reserved at worst case. The rules:

- **Fail closed on raises, not on stops.** `headroom` computes data freshness itself, from SpendDaily's `syncedAt`. It does not wait for a `sync_stale` breaker row, so the 60-min worst-case rule (4.6) applies even if the breaker task never runs. Assistants run in the worker, so they stop with it.
- **Lazy expiry everywhere it matters.** Approving checks `expiresAt > now()` itself (7.3), commitments check `reservedUntil` in `assertPermitValid`, and SpendReservation reads ignore rows past `expiresAt`. A backlog of expiry tasks can never let a stale permission through.
- **Catch-up is idempotent.** After an outage, periodic tasks run once (the lease is keyed by name), not once per missed slot. Breaker trips use their open-row unique index, the digest uses `claimOnce`, and metacap P2 rollover fires on the first read of the new month. Missed `daily_limit` auto-resumes happen on the first run of the new account day.
- **Alert.** `spend.health` is checked by the web process on each `/admin/spending` load and by tick. When the `worker:daemon` heartbeat is older than 5 min, platform admins get an alert ("Background worker stopped 12 min ago. The 1-minute fallback is running."). When neither the daemon nor tick has run for 10 min, the alert reads "Background work is not running. Breakers and syncs are paused; Meta's limits still apply." It is sent by email and on the admin alerts strip. The WhatsApp notifier also runs in the worker, so it cannot be relied on for this alert.
- **Kill switch.** It works from the web process alone (4.11).

### 4.17 Locked, suspended and closing workspaces (critic)

`getActor` sends every non-GET request outside `/api/auth/` and `/api/billing/` through `assertTenantCanWrite`. That returns 402 when a workspace is locked and 403 when it is suspended, which would stop an owner from LOWERING a limit or turning on a stop. Lowering must never be blocked (I2), so:

- `src/lib/auth/index.ts` adds `/api/spend/` to `PAYWALL_EXEMPT_PREFIXES`. Each `/api/spend/*` route then calls `assertTenantCanWrite` itself for raising operations only: raising an allowance, Not set to a number, unfreeze, approving a raise, or turning on Meta's limit. Lowering, freezing, declining, withdrawing Meta-limit consent and the 5.8 offboarding choices work in every state, including suspended.
- Locked and suspended workspaces already have their ads paused by `pauseAdsForBlockedTenants` and their sends held by `tenantMayRunBackground`. The metacap task keeps running for them. It writes only lowering or P0 and never raises. P2 rollover writes are deferred until the workspace is active again. Meanwhile the card says "Meta's limit is kept at last month's level while your workspace is paused", which stops the account early (the safe direction). The 5.8 choices let the owner remove the limit if they prefer.
- **Closing a workspace** (`lifecycle/export-deletion.ts`, the CloseWorkspace dialog) shows the three 5.8 choices for every managed ad account, with "Keep the current limit on Meta" as the default, and applies the choice before the Meta revoke and before erasure (3.5).

---

## 5. Meta spending limit (wall (a))

Modules: `src/lib/spend/metacap/{client,plan,sync,consent}.ts`, plus the periodic task in `src/lib/spend/tasks/metacap.ts`.

### 5.1 Consent (R1), owner only

- **Where it is captured:**
  - in the ConnectionsPanel step after ad account discovery;
  - on the "Spending limit on Meta" card in Settings > Spending limits.
- **Copy** (`textVersion 'meta-cap-v1'`; the SHA-256 of the exact text is stored in SpendConsent, kind `meta_spend_cap`, subject the ad account asset):
  - Title: "Let Edwyz manage the spending limit on this ad account"
  - Body:
    - "Meta will stop every ad on this account, including ads you make yourself in Meta Ads Manager, once it has spent your monthly ads limit."
    - "Edwyz updates this limit for you, at most a few times a day. A change can take a few hours to reach Meta."
    - "If you press Stop all spending and an ad can't be paused, we set the limit so the account stops."
    - "You can turn this off here at any time, or remove the limit in Meta Ads Manager > Billing > Payment settings."
  - Checkbox: "I'm the owner of this workspace and I agree." Button: "Turn on Meta's limit".
- **If an admin connects the account,** mode is `pending_owner` and the admin sees: "Only the workspace owner can turn on Meta's spending limit. We've let them know." The owner gets a banner task.
- **Without consent:**
  - humans can still launch, under walls (b) and (c);
  - assistant raises and launches on that account always need approval, whatever their level (lowering stays automatic);
  - outside spend is not counted (decision 2.3.4).
- **Prepaid accounts** (`is_prepay_account`) are `unavailable_prepaid` and get the same assistant restriction.
- **Discovery** (`meta-connect/discovery.ts`) also fetches `spend_cap`, `amount_spent`, `is_prepay_account` and `min_campaign_group_spend_cap`, so the consent screen can say "This account already has a Meta limit of ₹X".
- **(critic) Which accounts.** In Phase 0, consent is offered only for the workspace's spending ad account, because M is that account's ads pot. When the owner changes the spending account, the old account goes through the 5.8 choice and the new one needs its own consent.
- **(critic) One manager per real ad account** (decision 2.3.14). On turning it on, Edwyz checks MetaSpendLimit by `accountExternalId`. If another workspace's row is `managed`, this row becomes `other_workspace` (12.1c R3: a `pending_owner` row does not hold the slot, because decision 11 gives the account to the first workspace to turn the limit ON, and only an owner's consent turns it on), and the card shows "Another Edwyz workspace already manages Meta's spending limit on this ad account. Your Edwyz limits still apply here." The unique index makes the check race-free. The platform admin panel shows both workspaces.
- **(critic) What "managed" means elsewhere.** Policy (7.2), external-spend counting (decision 2.3.4) and the Meta-room check (4.6 step 8) treat an account as managed only when ALL of these hold: mode `managed`; `SPEND_CAP_MODE=enforce`; unitMode is not `unverified`; and the last write was verified by read-back. With consent in observe mode, the card says "Ready. Meta's limit will be switched on after our final check." Outside spend is then shown for information only, and assistant raises still need approval.
- **(critic) No trip to Meta.** Turning it on, off and every later change happen on Edwyz pages. The only Meta screens a customer sees are Meta's own login and permission dialogs.

### 5.2 Reads

- **Request:** `GET act_X?fields=spend_cap,amount_spent,currency,timezone_name,account_status,is_prepay_account`.
- **Cadence:**
  - every 15 min for managed accounts with open commitments or spend this month;
  - every 6 h for other managed accounts;
  - right before every write;
  - right after every write.
- **Normalisation:** both fields are read as minor units (documented read unit; live read-back confirms). 0 means no cap. The values are stored in MetaSpendLimit.
- Reads use no change budget.

### 5.3 Target

| Symbol | Meaning |
|---|---|
| A | `amount_spent` |
| C | `spend_cap` |
| M | the effective monthly ads limit (section 4.4) |
| S | spend this calendar month on this account, all campaigns, account time zone: max(SpendDaily account month-to-date, A - monthStartAmountSpent) |
| R | max(0, M - S) |

- **Target T:**
  - semantics `cumulative` or `unverified`: T = A + R;
  - semantics `resets_on_write`: T = R.
- **Customer cap:** if the customer's own cap was lower at consent, or was lowered since (5.6), T = min(T, that cap translated to the current counter).
- **No monthly limit:** if M is null, consent can be stored but nothing is written, and the card says "Set a monthly ads limit first."
- **Why T barely moves:** A and S grow together, so T stays constant while spend is tracked. Meta's room (T - A) shrinks automatically as the month goes, which is the "lowered as the month goes" behaviour without spending change budget.
- **(critic) Start values.**
  - At consent, mid-month: `monthStartAmountSpent = A - (SpendDaily account month-to-date)`, floored at 0, and `monthKey` is the current account month. If the month-to-date sync is missing, the first write waits for one fast sync.
  - Under `resets_on_write`, A counts only from the last write, so `S = spentAtLastWriteMinor + A`, where `spentAtLastWriteMinor` is S at the moment of that write. Under `cumulative`, S follows the formula in the table.
- **No resets:** Edwyz never sends `spend_cap_action=reset`. The customer's counter is not touched.

### 5.4 Change budget and write rules

- **changesUsed** = the number of `requested` ledger rows with action `meta.spend_cap.write` for this account in the last rolling 24 h. Failed attempts count too, because Meta may count them. A rolling 24 h count is always at least the calendar-day count, so it is the stricter of the two.
- **Classes:**
  - emergency writes are allowed while changesUsed < 10;
  - routine writes are allowed while changesUsed < 6, which keeps 4 for emergencies;
  - routine raises are allowed at most 2 per 24 h.
- **threshold** = max(2% of M, 0.5 x the effective daily ads limit, INR 100 equivalent).
- **One write in flight per account,** under `pg_advisory_xact_lock(21329, hashtext(adAccountAssetId))`.

| Priority | Trigger | Value written | Class | Debounce |
|---|---|---|---|---|
| P0 stop | Kill switch, monthly limit reached or disconnect, AND `stopCommitments` reported failed or unreachable objects | A + floor margin: 1 major unit, or the floor Meta quotes in its error | emergency | none |
| P0 restore | The cap was raised outside Edwyz, or removed (C = 0) | T | emergency | none |
| P1 lower | The effective M was lowered (owner, admin, override, probation re-applied, an override expired), or drift C - T > threshold | T | emergency when C - A > R + threshold (Meta currently allows more than is left); otherwise routine | 2 min |
| P2 rollover | First read on or after 00:00 on day 1 in the account time zone (new monthKey). Also sets monthStartAmountSpent = A | A + M_new (or M_new under resets semantics) | routine | none |
| P3 raise | The owner raised M, or room (C - A) < Σ dayRisk + 24 h of live worst case (also queued by `META_CAP_TOO_LOW`) | T | routine raise | 10 min |

When routine writes are used up, `pendingTargetMinor` and `deferredUntil` are stored, and the write runs when budget frees. A deferred raise can only make ads stop early, which is the safe direction. The UI shows: "Meta's limit will update later today. Your Edwyz limits still apply now."

### 5.5 Write and verify (`metacap/client.ts`)

- **Request:** `POST act_X {spend_cap: '<major units as a decimal string with the currency exponent>'}`. The docs' "standard denomination" means, for example, "20000.00" for INR, "20000" for JPY and "20.000" for KWD.
- **Why major units:** if Meta reads the value as minor units, the cap is 100x STRICTER, which is the safe direction.
- **Ledger:** each write is ledgered as `meta.spend_cap.write`, with `requested` and then the outcome, before and after `{cap, amount_spent}`, and the undo recipe of the previous cap.
- **Read-back:** immediately after, read `spend_cap` and `amount_spent` again:
  - (i) read-back within 1 minor unit of the expected value: unitMode `major_write` is verified;
  - (ii) read-back equals expected x100 or /100: unit mismatch. Set mode `error`, open breaker `meta_cap_units` (assistants frozen on the account), alert platform admins, and send one corrective emergency write using the inferred unit;
  - (iii) `amount_spent` dropped to about 0 although it was above 0: semantics `resets_on_write`. Rewrite T = R as P1;
  - (iv) otherwise semantics `cumulative`.
- **Defaults:** the learned unitMode and semantics are stored per account and in `spend:meta-verified` as the platform default.

### 5.6 Changes made outside Edwyz (reconcile every 15 min)

- **C lower than managedCap by more than 1 unit** (the customer lowered it): adopt it, and never raise it back automatically. Notify: "We noticed a lower Meta spending limit on <account>. We'll keep it." The owner can press "Use my Edwyz limit", which is an owner raise.
- **C higher, or removed** (C = 0): P0 restore to T. Notify: "Meta's spending limit on <account> was raised outside Edwyz, so we set it back to match your monthly ads limit."
- **Near the wall,** C - A < 10% of M: notify once a day: "Meta will stop all ads on <account> after ₹X more this month."
- **Drift between Meta's counter and insights:** if |ΔA - ΔS| > 10% of ΔS over 3 consecutive reads, flag `drift` for the admin panel (tax or accrual lag) and use the larger value for S.

### 5.7 Failure modes

| Failure | Behaviour |
|---|---|
| Error 17, subcode 1885172 (daily change limit) | `writesBlockedUntil` = next account-time-zone midnight; ledger `failed`; admin panel alert. If the blocked write was a lowering, open breaker `meta_cap_stale_high` (block raises on the account) and notify the owner. The `monthly_limit` breaker still pauses platform campaigns at the limit |
| "Must be at least X" (floor, pending charges) | Parse X. If X ≤ T + 10% of M, write X and record `loosenessMinor = X - T`. Otherwise keep the old cap and mark it loose. Show "Meta's limit is a little above your limit because some charges are still pending". While loose, raises are refused once R ≤ 15% of M |
| Permission error (codes 10, 200, 294) | Mode `no_permission`. Copy: "You need to be an admin of this ad account in Meta to let Edwyz manage its limit." (critic) The card's action stays inside Edwyz: [Connect again with an admin account] opens the normal Meta login, which is a consent screen. The copy becomes "Meta says the person who connected this account can't change its spending limit. Connect again as someone who is an admin of this ad account." |
| `account_status` ≠ 1 | Skip writes; show Meta's status |
| Token expired or revoked (`getAssetAccess` 409) | No writes are possible. The last written cap stays on Meta and keeps protecting the month. Open breaker `meta_cap_unreachable`: assistants frozen on the account, owner notified, retry every 30 min |
| Ambiguous write (5xx or timeout) | Never retried blindly. Read back at once and after 60 s, then settle as applied or failed |
| Ad account currency ≠ ads pot currency | Mode `currency_mismatch`; no writes; assistants refused on the account |
| Sandbox account | Mode `sandbox`; never written; ledger `info` with reason sandbox |

### 5.8 Turning it off and offboarding

The owner picks one of these, and each is ledgered:

- "Keep the current limit on Meta" (default, no write);
- "Put back my old limit (₹X)" (one write);
- "Remove the limit" (`spend_cap_action=delete`, one write).

(critic) The same choice is offered, and applied while the token still works, when:

- the owner changes the spending ad account;
- the workspace is closed or erased (4.17, 3.5);
- the account is disconnected (5.9);
- a platform admin suspends or soft-deletes the workspace. The admin action form asks for it, with "keep" as the default.

The choice is an emergency-class write when the routine budget is used up, because it hands control back to the customer. If no choice can be applied (the token is gone), the owner's email says "Meta's spending limit on <account> stays at ₹X. You can change it in Meta Ads Manager if you need to."

### 5.9 Disconnect protection (`meta-connect/service.ts`, the disconnect route)

1. Before revoking, call `stopCommitments(all, adAccountAssetId)`.
2. If any pause failed or an object was unreachable, write P0 (when managed). Then refuse the disconnect with 409: "We couldn't pause 2 ads on Meta. Pause them in Meta Ads Manager, or type DISCONNECT to disconnect anyway."
   - (critic) The copy offers in-app actions first: "We couldn't pause 2 campaigns on Meta yet. [Try again] pauses them again from here. To disconnect anyway, type DISCONNECT. They may keep running until Meta's spending limit stops them." Meta Ads Manager is mentioned only under "More help". It is not a required step.
3. Only the owner may force.
4. Success copy: "Your Meta spending limit stays at ₹X, so nothing can overspend after you disconnect."

### 5.10 Scope copy

The `ads_management` description in `scopes.ts` becomes: "Create and change ad campaigns, and keep Meta's spending limit in line with your limits."

---

## 6. Breakers

Every breaker:

- writes a SpendBreaker row, made idempotent by the open-row unique index;
- writes ledger rows (`breaker.trip` and `breaker.clear`, actorType `breaker`);
- acts only through lowering paths (`stopCommitments`, `pauseAdSet`, holds, broadcast pause);
- notifies once per trip (`claimOnce('spend-breaker:<id>')`), in-app always, then the WhatsApp alert template to verified owner and approver channels, then email as the fallback.

Clearing a breaker that paused something is a raise, so it needs the owner or an approver and goes through `reserveAds`. The exceptions are the stated auto-clears.

### 6.1 Ads data

- **`spend.sync.fast`, every 15 min,** for tenants with any open commitment or a managed Meta limit. Per spending ad account:
  1. `GET act_X/insights level=account time_increment=1 date_preset=this_month fields=spend` gives SpendDaily account rows (origin `all`).
  2. `GET act_X/insights level=adset filtering=[adset.id IN open commitment ids] date_preset=today fields=spend,impressions,clicks,cpm,ctr,actions` (plus yesterday until 03:00 account time) gives SpendDaily adset rows (origin `platform`) and IntradaySpendSample rows.
  3. External spend = account - Σ platform ad sets, written as origin `external`.
- **Backoff:** a rate limit backs off 30 min (`spend:sync:<tenantId>`).
- **(critic) Structure sync** (4.6.1) runs in the same pass, after step 2, so a campaign resumed in Ads Manager is counted from the next sync.
- **(critic) Skipped accounts:** sandbox accounts (SPEND_SIM writes their series instead), demo assets (`MetaAsset.meta.demo = true`, 8.4), and accounts whose `getAssetAccess` returns 409. A 409 skip is not silent: while commitments are live it opens `meta_cap_unreachable` (5.7) and counts toward `sync_stale`.
- **`spend.breakers`** runs every 5 min and right after each sync.
- **The 6-hour `ads.insights.daily` sync** stays for reporting. It also SETs SpendDaily for older days (Meta revises spend for up to 28 days).

### 6.2 Ads breakers

| Breaker | Trigger (defaults) | Effect | Clears |
|---|---|---|---|
| `pacing` (workspace) | Today's spend on assistant-launched ad sets > 1.20 x Σ their highest daily budgets today. Warning only when spend > 1.20 x the prorated plan (Σ D x elapsed fraction of the account day), with at least 2 h elapsed and spend above 10% of Σ D | Pause every assistant-launched commitment, and block assistant raises. Human campaigns are untouched | Owner "Resume" (guarded raise), or at the next account day the breaker clears, objects stay paused, and the owner gets "Your ad assistant was paused yesterday for spending too fast. Resume?" |
| `efficiency` (ad set) | Last 3 account days including today: spend ≥ max(3 x target, INR 500 equivalent) AND cost per lead > 2 x target. Zero leads counts as infinite. Target is campaign.targetCostPerResult, then mandate.targetCostPerLead, then SpendControl.targetCostPerLead. With no target the breaker is off, and the UI says "Set a target cost per lead to turn this on" | Pause the ad set if assistant-managed. If human-managed: notify only, unless `breakersMayPauseHumanCampaigns` | Manual |
| `spend_jump` (ad set) | Between consecutive samples, Δspend > max(0.25 x D, 4 x D x Δt / 24 h), with D the highest daily budget today | Same as efficiency | Manual |
| `cpm_ctr_anomaly` (ad set) | Over the last hour with at least 1,000 impressions: CPM ≥ 2.5 x the 7-day median CPM, or CTR ≤ 0.33 x the 7-day median CTR | Block raises on the ad set and notify. Assistants at Level ≥ 1 may pause it (lowering) | Auto after 24 h with no repeat |
| `account_spike` (workspace) | Whole-account spend today > 1.5 x the highest daily account spend of the last 7 days, and > INR 1,000 equivalent | Block raises and notify (covers spend from Ads Manager) | Auto at the next account day |
| `daily_limit` (workspace) | Counted spend today ≥ the effective daily ads limit | Pause every platform commitment for the rest of the account day | Auto at the next account day: each object is re-activated through `reserveAds` (actor breaker), and only what fits starts again. (critic) It re-activates only objects whose most recent lowering in the ledger is this breaker's own correlationId. Anything a person or another breaker paused, edited or archived since then stays as it is. Nothing is resumed while a freeze is on |
| `monthly_limit` (workspace) | spentMonth + Σ dayRisk ≥ the monthly limit, or spentMonth ≥ 95% of it | Pause every platform commitment; metacap P0 if a pause failed | When the limit is raised or the month rolls over; objects stay paused and the owner gets a "Resume?" prompt |
| `budget_change_quota` (ad set) | 3 budget changes requested in the last 60 min | Assistant raises refused. Breakers and cuts use PAUSED instead of budget edits | Auto after 60 min |
| `sync_stale` (workspace) | No successful fast sync for 45 min while commitments are live | Block assistant raises. For humans, today's spend is treated as the worst case (4.6) | Auto on the next good sync |
| `meta_cap_units`, `meta_cap_unreachable`, `meta_cap_stale_high` (ad account) | Section 5 | Freeze assistants on the account (units, unreachable) or block raises (stale high); alert platform admins | When resolved |
| (critic) `external_edit` (campaign) | The structure sync (4.6.1) finds an assistant campaign whose end date was removed or moved later in Ads Manager | Block assistant raises on that campaign and notify | When the owner sets an end date again, or archives the campaign |

(critic) "Assistant-managed" means campaign origin `assistant`. A human campaign that an assistant has only suggested changes to stays human-managed, so performance breakers only notify on it, unless the toggle is on. Every campaign that exists today is human-managed.

### 6.3 WhatsApp breakers and signals

| Signal | Source | Effect |
|---|---|---|
| Number YELLOW / MEDIUM | `spend.quality.poll` every 30 min per CONNECTED number: `GET <phoneNumberId>?fields=quality_rating,status`. This is needed because `phone_number_quality_update` no longer carries a rating. It also updates `PhoneNumber.qualityRating`, which fixes the stale data feeding the existing email alerts | `wa_quality_yellow` (scope phone, `block_marketing`): marketing broadcasts using the number pause with the new reason `number_quality_yellow`; MARKETING sends from automated, API and assistant origins are held |
| Number RED / LOW | same | `wa_quality_red` (`block_automated`): every automated, API and assistant origin from the number is held; broadcasts pause |
| Number back to GREEN | same | Clears after 2 consecutive GREEN polls; owner notified |
| (critic) Quality UNKNOWN, NA, a failed poll, or status not CONNECTED | same | Keeps the last known state. Breakers neither open nor clear on missing data. A number that is not CONNECTED holds automated, API and assistant sends from it (Meta would reject them anyway). The poll covers only numbers whose workspace has a sendable token (`tenantIdsWithSendableToken`), which leaves out the demo workspace and expired tokens |
| Template PAUSED or DISABLED | `message_template_status_update` | Template blocked for every sender; queued sends fail with `template_blocked`; broadcasts pause (existing) |
| Template FLAGGED | same | No longer mapped to paused. New status `flagged`: assistants may not use it, marketing broadcasts using it pause, other senders may continue |
| Template REINSTATED / UNPAUSE | same | Back to approved, plus a template re-sync |
| Template quality YELLOW / RED | `message_template_quality_update` | YELLOW: assistants stop using it, plus a notice. RED: dependent broadcasts pause (existing) |
| `template_category_update` | Newly subscribed and handled | Template.category updated; running broadcasts' reservations re-estimated; any that no longer fit pause (reason `messaging_limit`) |
| ACCOUNT_RESTRICTION RESTRICTED_BIZ_INITIATED_MESSAGING | `account_update` | `wa_restricted` (WABA): template sends outside an open window from automated, API and assistant origins are held until `restriction_info.expiration` |
| DISABLED_UPDATE DISABLE / SCHEDULE_FOR_DISABLE / REINSTATE | `account_update` | DISABLE: `waba_disabled`, all automated outbound held. SCHEDULE_FOR_DISABLE: `block_marketing` plus an urgent notice. REINSTATE clears |
| ACCOUNT_VIOLATION | `account_update` | Notify only |
| Messaging cost gate | Before every bulk start and every single automated send (4.9) | Refused or held above the allowance |
| Delivery pricing | `statuses[].pricing` | Stored on Message; settled every 5 min (4.9) |

### 6.4 AI quota

The effective monthly and daily credit limits are enforced in the gateway (4.10). When they are used up:

- the AI agent replies with its handoff to a human;
- Creative Studio returns 402;
- suggestions are hidden.

Notices go out at 80% and 100%, once per period (claimOnce `spend-ai:<tenantId>:<period>:<level>`).

### 6.5 Kill switches

Section 4.11.

---

## 7. Autonomy levels and approvals

### 7.1 Assistant registry (`src/lib/spend/registry.ts`, code)

| assistantKey | UI label | Pots | Phase |
|---|---|---|---|
| `ads_optimizer` | Ad assistant | ads | Exists today (proposal-only); becomes the first assistant |
| `ads_launcher` | Campaign assistant | ads | Phase 1 consumer |
| `broadcast_planner` | Broadcast assistant | messaging | Phase 1 |
| `lead_followup` | Follow-up assistant | messaging, ai | Phase 1 |

The customer-facing AI reply bot (`AiAgent`) is not an autonomy-governed assistant. Its sends are origin `ai_reply` (automated), and its AI calls go through the gateway.

### 7.2 Policy (`policy.ts`, pure, a test per matrix cell)

`decide(actor, intent, delta: {todayMinor, monthMinor}, mandate, headroom, now)` returns `{verdict: 'auto'|'needs_approval'|'refuse'|'shadow', reason}`.

Order of checks:

1. Frozen, platform frozen or a blocking breaker: refuse a raise.
2. Shadow window: shadow for every action.
3. `ASSISTANT_SPEND_ENABLED=false`: treat the level as 0.
4. Mandate disabled, or the op not in allowedOps: refuse.
5. The action does not fit the allowance or the mandate ceilings: refuse. An approval cannot exceed the owner's limit. Copy: "This needs ₹X but only ₹Y is left this month."

(critic) Clarifications to steps 2 and 4 (decision 2.3.10):

- In steps 2 and 4, "shadow" and "refuse" stop the ASSISTANT from executing. They never stop the suggestion. A shadow or disabled-mandate proposal is still created as a Level 0 suggestion. If an approver accepts it, it runs as that person's action through `reserveAds` (actor `user`) and is ledgered with `assistantKey` and `approvalId`. The shadow record keeps the "would have done at the configured level" verdict next to what the person did.
- With no AssistantMandate row, the assistant gets `enabled=false` and level 0: suggestions only, which is today's optimizer behaviour.
- Step 6, anti-splitting (decision 2.3.9): for Level 2 the share test is `max(Δmonth of this action, Δmonth of this action + Σ Δmonth of this assistant's auto-applied raises in the last rolling 24 h) ≤ approvalSharePct x monthly allowance`. Level 1's 20% is already cumulative per ad set per account day.
- "Meta's limit is managed" in the matrix uses the definition in 5.1 (critic).

6. The level matrix:

| Level | Lowering (pause, archive, cut budget, stop or cancel a broadcast, end earlier, release a hold) | Budget raise on a live object | Resume, activate, launch, broadcast start |
|---|---|---|---|
| Breakers and kill switches (not assistants) | Always auto, at any level | n/a | Only the `daily_limit` auto-resume, through `reserveAds` |
| 0 Suggest (default) | Suggestion; any admin may approve | Approval (approver) | Approval (approver) |
| 1 Guarded | Auto | Auto if: the cumulative raise today ≤ raiseStepPct (20%) of dayStartBudget in the account day, it fits, no breaker is open on the scope, and it is not a resume of a breaker-paused object. Otherwise approval | Approval |
| 2 Autopilot | Auto | Auto if it fits and Δ month worst case ≤ approvalSharePct (25%) of the effective monthly allowance. Otherwise approval | Auto if it fits, Δ month ≤ 25%, there is an end date or lifetime budget, a target cost per lead is set, and Meta's limit is managed on the account (or it is a sandbox account). Otherwise approval. Without an end date: refuse |

On an account without wall (a) (not managed, prepaid, no permission), every assistant raise or launch is `needs_approval`, whatever the level.

**Mandates.** The owner raises a level or a mandate ceiling. An admin or the owner lowers them. Every change is ledgered (`mandate.change`). The effective mandate ceilings are min(mandate, allowance).

### 7.3 Approvals (`approvals.ts`, `approval-token.ts`, `tasks/approvals.ts`)

- **Creation,** inside the reservation transaction. The SpendApproval stores:
  - `intent`: the exact `reserveAds` or bulk intent;
  - `fingerprint`: sha256 of the canonical intent, the object's current budget and status, and the allowance version;
  - `summary`, for example "Raise the daily budget of 'Diwali leads - Delhi' from ₹800 to ₹1,000";
  - `forecastToday` and `forecastMonth`: worst-case deltas;
  - `reason`: the assistant's plain-language why;
  - `direction`;
  - `expiresAt = now + approvalTtlHours` (default 12, range 1-48);
  - `tokenHash`: SHA-256 of 32 random bytes in base64url. The token is single use, valid until expiry, and only the hash is stored.
- **Who decides:**
  - raises need the owner, or an admin listed in `SpendControl.approverUserIds`;
  - lowering suggestions can be decided by any admin.
- **Approve.** At decision time `reserveAds(intent, {type:'assistant', approvalId})` re-runs every check except the autonomy step. If the object changed (fingerprint mismatch) or it no longer fits, the status becomes `failed` with "No longer fits your limits: ₹Y left, needs ₹X" or "The ad set changed since this was asked." Otherwise it is applied, and the ledger rows carry approvalId.
  - (critic) The decision is one conditional `UPDATE "SpendApproval" SET status = ... WHERE id = $1 AND status = 'pending' AND "expiresAt" > now()`. Two taps (app and link, or two approvers) can never both apply, and an approval past `expiresAt` cannot be approved even if the expiry task has not run (4.16).
  - (critic) Approver rights are checked again at decision time. The decider must still be a member, and must be the owner or an admin listed in `approverUserIds`. Someone who lost the role after the request was made cannot approve. Removing a member also removes them from `approverUserIds`.
- **Expiry.** `spend.approvals.expire` runs every 5 min, sets `expired` and ledgers it. The UI shows "Declined automatically (no answer in 12 hours)." This meets R4's "expire (declined)".
- **Supersede.** A new intent on the same subject, a freeze `all` or a changed fingerprint marks older pending approvals `superseded`.
- **Optimizer integration:**
  - `engine.ts` still creates OptimizerProposal rows;
  - `runForTenant` passes each one through `policy.decide` with the `ads_optimizer` mandate: `auto` proposals are applied through the same service functions, `shadow` proposals are recorded, and `needs_approval` proposals create a SpendApproval with proposalId;
  - `approveProposal` requires an approver for raising kinds (the raise half of `shift_budget`, resume). A net-zero `shift_budget` may be decided by any admin;
  - expiry moves from days to hours;
  - rationale text uses plain language and formatted money, never "minor units";
  - thresholds in `config.ts` become currency-aware by converting the INR defaults through `money.ts`.

### 7.4 One-tap surfaces and channels (R4)

- **In-app:**
  - a banner on every app page for approvers: "1 spending request is waiting";
  - the "Waiting for you" card on Settings > Spending limits, with [Approve] [Decline]. A signed-in approver needs one tap and no extra dialog.
- **Link:** `https://wa.edwyz.com/s/<token>` opens `src/app/s/[token]/page.tsx`. It shows the action, "Could add up to ₹4,550 this month (worst case)", the reason and the time left.
  - **Decline** works with the token alone, because declining only lowers risk.
  - **Approve** requires a signed-in approver session. Logged out, it goes to login and back, then one tap. Approving raises spend, so holding the phone must not be enough. This differs on purpose from the public client-approval flow.
  - Rate limits: `createLimiter('spend-approve', 10 per token per hour)` and 20 per IP per 15 min.
- **WhatsApp to the owner.** This is the mechanism under the 24-hour rule:
  1. **Platform-owned sender.** It is configured in `'spend:notify'`: the Edwyz workspace number, today `edwyz-test` +1 711-268-5789 at TIER_250 (see open question 1).
     - Messages go through the existing `sendTemplateMessage` in that workspace with origin `system_notify`, so they pass the normal gate. The platform pays, about ₹0.115 per India utility message plus GST.
     - The owner is upserted as a Contact there with optIn true, tagged `owner_spend_alerts`.
     - The notifier workspace must have its AI agent, chatbots and automations off. A startup check warns otherwise.
     - (critic) The notifier workspace must never be held by its own billing state. `processSendJob` holds every send when `tenantMayRunBackground` is false, and an unpaid trial expiring would silence every owner's alerts. The workspace is therefore `billingExempt` (admin `comp`), never on probation, and `spend:notify` refuses to save a workspace that is not exempt and active. The startup and health checks (4.16) alert if that changes.
     - (critic) Its inbox holds every customer owner's phone number and the text of their spending alerts. Its members must be platform admins only: the startup check lists any member whose email is not in `PLATFORM_ADMIN_EMAILS`, and the admin panel shows a red alert. Template parameters carry campaign names and amounts, never customer contact data. Erasure is in 3.5.
     - (critic) The notifier's own sends are origin `system_notify`. They count against the notifier workspace's pots, not the customer's. The platform pays for them (R9).
  2. **Pre-approved UTILITY templates** on the platform WABA, deliverable outside any 24-hour window, with no promotional wording (so Meta keeps them as utility):
     - `spend_approval_v1`: "{{1}} asks to {{2}} in {{3}}. It could add up to {{4}} this month. Reason: {{5}}. If nobody answers by {{6}}, it is declined." Buttons: URL "Review" to `https://wa.edwyz.com/s/{{1}}`; quick reply "Decline".
     - `spend_alert_v1`: "Spending update for {{1}}: {{2}} was paused because {{3}}. Nothing else changed. Review it in Edwyz." Button: URL "Open Edwyz".
     - `spend_daily_v1`: the digest (section 9).
     - `spend_optin_v1`: "You asked to get spending approvals and alerts for {{1}} on WhatsApp. Tap Yes to confirm." Quick replies: "Yes, send me alerts" and "No".
  3. **Opt-in and verification:**
     - the owner or approver enters a number on the Spending page;
     - consent text: "I agree to get spending approvals, alerts and a daily summary from Edwyz on WhatsApp at this number. I can stop any time by replying STOP.";
     - it is stored in SpendConsent (`owner_whatsapp`) and OwnerNotifyChannel;
     - `spend_optin_v1` is sent;
     - the "Yes" quick reply (payload `spopt:<channelId>:<hmac16>`) sets `verifiedAt`. It proves the number and opens a 24-hour window.
  4. **Decline by quick reply.**
     - The payload is `spdec:<approvalId>:<hmac16>` (HMAC with `SPEND_NOTIFY_SECRET`).
     - `webhooks/payload.ts` keeps `button.payload`, and `processor.ts` routes it to `notify/inbound.handleOwnerReply` only for the notifier tenant.
     - It checks that the sender's wa_id equals a verified approver channel for that tenant, that the HMAC matches, and that the approval is pending. It then declines and replies in-window: "Declined. Nothing was changed."
     - Approve is never accepted by quick reply in Phase 0.
  5. **STOP** sets `optOutAt` and the existing contact opt-out. Notices fall back to email.
     - (critic) An owner of several workspaces has one notifier Contact and several channels with the same phone. STOP opts out every channel with that `phoneE164`, because Meta's opt-out is per person, not per workspace. START, or a fresh opt-in on the Spending page, re-enables only the channel it came from.
  6. **Capacity.** TIER_250 allows 250 distinct owners per rolling 24 h. Above 200 notified owners a day, alerts and approvals take priority over digests, and digests go by email. The admin panel warns.
- **Fallback order for every notice:**
  1. WhatsApp, if the channel is verified, the template is approved and active, and the notifier number is not restricted or RED;
  2. email via `queueEmail` (needs SMTP in production);
  3. in-app, always.
- **Approvals never depend on WhatsApp alone.** An approval nobody saw expires as declined, which is the safe way to fail.
- **Documented alternative, off by default:** send from the customer's own number to an owner who is an opted-in contact there (the `approvals/resend.ts` pattern). It bills the customer, so it needs the owner's opt-in.

### 7.5 Shadow mode (R6)

- **Start.** When a mandate is first enabled for (tenant, assistantKey), `shadowUntil = now + 14 days`.
- **Recording.** Until then every action returns verdict `shadow`. An AssistantShadowRecord stores the intent, what the verdict would have been at the configured level, the worst-case forecast, the reason and a baseline (the object's last 3 days). Nothing executes. Level 0 suggestions still appear, so the owner gets value.
  - (critic) "Nothing executes" means nothing executes on the assistant's own authority. A suggestion an approver accepts during shadow runs as that person's action (7.2 clarifications). The shadow record then stores both the assistant's would-have verdict and the person's actual decision, which is the "what I would have done versus reality" comparison R6 asks for.
  - (critic) Shadow starts per (workspace, assistant) on first enable, not at Phase 0 deploy. Re-enabling a disabled mandate does not restart it, and a new assistant key starts its own 14 days.
- **Evaluation.** `spend.shadow.evaluate` runs hourly and fills `outcome` at 24 h and 72 h:
  - for a pause or cut: did the target's cost per lead stay above target (`would_have_helped`) or improve (`would_have_hurt`)?
  - for a raise or launch: results compared with the workspace average, otherwise `unknown`.
- **UI:** "Learning: suggests only until 11 Nov. So far it would have made 12 changes (9 cuts, 3 raises worth up to ₹4,200)." with a link "See what it would have done".
- **Ending early.** Only a platform admin can end shadow early, only for a sandbox account or a verified workspace, and it is ledgered.

---

## 8. UI

All copy follows `docs/ui-guidelines.md`: plain language, sentence case, verb-first buttons, "Not set" rather than any invented number, and no emojis. Money is formatted with the currency exponent.

### 8.1 Workspace page: Settings > Spending limits, for every member

- **Route and component:** `src/app/(app)/app/settings/spending/page.tsx` renders `<SpendingSettings/>`.
- **Nav item:** `{href: '/app/settings/spending', label: 'Spending limits', minRole: 'agent', group: 'settings', section: 'settings', icon: <existing icon, e.g. 'card'>, keywords: ['budget','limit','spend','cap','money','approvals','assistants','stop']}`. The `tests/auth-nav.test.ts` counts move from 27 to 28, and the agent list from 15 to 16.

| Capability | Owner | Admin | Team member (role agent) |
|---|---|---|---|
| See the page: status, three pots, limits, Meta limit state, assistants and levels, probation note | Yes | Yes | Yes, read-only |
| See the activity table (ledger) and CSV export | Yes | Yes | No (totals only) |
| Lower a limit (critic: only a limit that already has a number) | Yes | Yes | No |
| Raise a limit, clear a number to Not set, or (critic) set a number where it was Not set (decision 2.3.8) | Yes | No (403 "Only the owner can raise a limit. You can lower it.") | No |
| Stop all spending / stop assistants | Yes | Yes | No |
| Turn spending back on | Yes | No | No |
| Choose the spending ad account; Meta limit consent on or off | Yes | No (sees state) | No |
| Raise an assistant's level or ceiling | Yes | No | No |
| Lower an assistant's level or ceiling | Yes | Yes | No |
| Approve raises | Yes | Only if named as an approver | No |
| Decline, or decide lowering suggestions | Yes | Yes | No |
| Approvers, request expiry, time zone, target cost per lead, "safety stops may pause campaigns my team made", digest | Yes | No | No |
| Own WhatsApp alerts number | Yes | Yes (approvers) | No |
| Undo in activity | Yes; an undo that raises goes through the checks | Undo of a raise (a lowering) only | No |

- **Server enforcement.** `PUT /api/spend/allowances` compares old and new values per field. Any increase, or a number becoming Not set, requires the owner. It uses an optimistic version check (409 `spend.version`).
  - (critic) Not set becoming a number also requires the owner. So does changing a pot's currency. Lowering works in every workspace state (4.17).
  - (critic) Every role gets the page in every workspace state: no Meta connection, no WhatsApp number, demo, locked or suspended (8.4). The page never 404s or blanks because a pot has nothing connected.
- **Header:** "Spending limits". Subtitle: "Choose the most Edwyz can spend for you each month and each day. Every ad change, automatic WhatsApp message and AI reply is checked against these limits first. Meta and WhatsApp bill you directly; Edwyz never holds your ad money."
- **Role notes:**
  - Admin: "You can lower limits or stop spending. Only the owner can raise a limit."
  - Team member: "Only the owner can change spending limits. Ask them if you need more."
- **Time zone line:** "Days and months follow Asia/Kolkata time, the same as your ad account."
  - (critic) When the two zones differ, the line names both (3.1). With no ad account, it reads "Days and months follow Asia/Kolkata time." The owner can change the zone under the control settings; the change takes effect from the next midnight.

**Status strip** (`KillSwitch.tsx`):

- **On:** "Spending is on". Buttons for admin and owner: [Stop assistants] [Stop all spending].
- **Stop all spending dialog:** "Stop all spending? We'll pause every ad Edwyz started and hold automatic WhatsApp messages and AI replies. Messages your team types still go out. Only the owner can turn spending back on." Buttons: [Stop all spending] [Cancel].
- **Stopped:** "All spending is stopped since 28 Oct, 14:05 (stopped by Priya). Ads are paused and automatic messages are on hold." The owner sees [Turn spending back on]. Others see "Only the owner can turn spending back on."
- **Platform freeze:** "Edwyz has paused spending for all workspaces while we check something. Your ads are paused. We'll tell you here and on WhatsApp when it's back." (12.1a decision 2: no SMTP, so no copy promises an email.)

**Three pot cards** (`PotCard.tsx`), each with "Monthly limit" and "Daily limit" inputs. The owner can edit them. An admin's input max is the current value. A team member sees text only.

- **"Ads on Facebook and Instagram"** (the spending ad account's currency):
  - Rows: "Spent this month ₹6,200", "Set aside for running ads ₹7,000", "Left to use ₹6,800", "Today: ₹850 spent, up to ₹1,750 set aside".
  - A segmented ProgressBar shows spent / set aside / left.
  - Help: "Set aside is the most your running ads could still spend. Meta can spend up to 75% more than a daily budget on a busy day, and up to 7 days of budget in a week, so we plan for that. A ₹2,000 daily limit allows ads with up to ₹1,142 a day in total budget."
  - When Meta's limit is managed: "Includes ads you run yourself in Meta Ads Manager on this ad account, because Meta's limit covers the whole account." Plus a line: "Other ads on this account (estimate): ₹1,200 this month."
  - Not set: "Not set. Ads can't start until you set a daily limit."
  - Migrated workspaces: "Your old daily cap of ₹1,000 is now a daily limit of ₹1,750, the most Meta can spend on ₹1,000 of daily budget."
  - "Spending ad account: Edwyz Store (INR)". Owner action: [Change].
  - (critic) With no ad account connected: "No ad account connected yet. You can set your ads limits now; they apply as soon as you connect one." A currency select (default INR) sits next to the inputs, with the CapPanel's list.
  - (critic) Several ad accounts and none chosen: "Choose which ad account Edwyz can spend from. Until you do, new ads can't start." Owner: [Choose]. Others: "Ask the owner to choose a spending ad account."
- **"WhatsApp messages":**
  - "Estimated cost of messages Meta charges you for. Broadcasts and automatic messages that would go over are held before they start. Messages your team types always go out."
  - Rows: "Spent this month (estimate)", "Set aside for broadcasts in progress", "Left".
  - (critic) The WhatsApp account's billing currency is read once a day by the quality poll (`GET <WABA_ID>?fields=currency`). When it differs from the rate card's, a note says "Meta bills your WhatsApp account in USD. These figures are estimates in INR from Edwyz's price list."
  - Not set: "Not set. Your team and automations send as usual; assistants can't send until you set a limit."
  - The card is not called "messaging limit", because that name already means Meta's tier.
- **"AI usage":**
  - "AI credits used by the AI agent, reply suggestions and Creative Studio. When they run out, AI replies hand the chat to your team."
  - Rows: "Used this month 140 of 200 credits", "Today 12".
  - Limits are capped by the plan: "Your plan allows up to 500 credits a month."

**New-workspace note** (Alert, info):

- "Your workspace is new, so ads can spend up to ₹2,000 a day and ₹20,000 a month for now. This goes up after your first two payments, or ask support."
- When the owner's limit is above the ceiling: "Your limit is ₹50,000, but ₹20,000 applies until the new-workspace period ends."

**MetaLimitCard.tsx**, "Spending limit on Meta":

- Explainer: "Meta itself stops your ads when this limit is reached, even if something goes wrong on our side."
- States:
  - "Managed by Edwyz. Meta will stop this account after ₹6,800 more this month."
  - "Off. Turn on Meta's limit for extra safety." (the owner sees the consent dialog)
  - "Waiting for the owner to turn this on."
  - "Not available: this ad account uses prepaid funds. Your Edwyz limits still apply."
  - "You need to be an admin of this ad account in Meta to turn this on." (critic) Shown with the in-app button [Connect again with an admin account] (5.7), so no trip to Meta Ads Manager is needed.
  - (critic) "Another Edwyz workspace already manages Meta's spending limit on this ad account. Your Edwyz limits still apply here."
  - (critic) "Ready. Meta's limit will be switched on after our final check." (consent given, observe mode)
  - (critic) "Demo account: Meta's limit isn't used."
  - "Meta's limit will update later today. Your Edwyz limits still apply now."
  - "Meta's limit is a little above your limit because some charges are still pending."
  - "Test account: Meta's limit isn't used."
- Owner action [Turn off] opens a dialog with three choices: keep, put back the old limit, remove.

**AssistantsCard.tsx**, a row per assistant with the name, a level select, a learning badge, "Target cost per lead" and "Most it can spend per day / month". Level options:

- "Suggest only: it suggests changes. Nothing happens until someone approves."
- "Small changes: it can pause ads, lower budgets and stop broadcasts at any time, and raise a budget by up to 20% a day within your limits."
- "Autopilot: it can start campaigns within your limits. Anything over a quarter of your monthly limit needs your approval."

While `ASSISTANT_SPEND_ENABLED=false`, the card shows: "Assistants only make suggestions for now."

**ApprovalsCard.tsx** ("Waiting for you", uses `ApprovalReview.tsx`):

- Card text: the summary, "Could add up to ₹4,550 this month (worst case)", "Why: cost per lead is ₹62, well below your ₹100 target", "Declined automatically in 11 hours".
- Buttons: [Approve] [Decline]. Non-approvers see "Only the owner can approve spending".
- Owner settings: "Who can approve spending" (multi-select of admins) and "Requests expire after [12] hours".

**NotifyCard.tsx:**

- "Get approvals, safety alerts and a daily summary on WhatsApp". Field "Your WhatsApp number", the consent checkbox, and the button "Send me a confirmation".
- Pending: "We sent a message from Edwyz (+1 711-268-5789). Tap 'Yes, send me alerts' to finish."
- Toggle: "Daily summary at 9:00".

**ActivityTable.tsx** (admin and owner):

- Columns: When | Who (a person's name, "Ad assistant", "Safety stop", "Edwyz support") | What ("Raised daily budget ₹800 -> ₹1,000") | Could add (worst case) | Why | Undo.
- Filters: Ads, WhatsApp, AI, Assistants, Safety stops. Export CSV.
- A "Yesterday" strip shows the stored digest.

### 8.2 Other workspace surfaces

- **`/app/ads` CapPanel** (`CampaignsView.tsx`):
  - The existing labels stay ("Daily spending limit", "New daily limit", "Save limit", "Only an owner can change the limit.") and so does `data-testid="cap-status"`. The form still edits the ads daily limit for owners through the same API.
  - (critic) Through that API the CapPanel number keeps meaning "the most your daily budgets may add up to" (4.8 table). Its new help text says "Up to ₹1,000 a day in ad budgets. Because Meta can spend 75% more on a busy day, this sets your daily ads limit to ₹1,750." The Settings page shows the worst-case number. Both pages show the same stored limit.
  - New lines: "Ads limit: ₹1,150 of ₹2,000 left today · ₹6,800 of ₹20,000 left this month", "Set aside for running ads: ₹7,000", and the link "All spending limits".
  - The help text explains the 1.75x rule.
- **Campaign wizard budget step:**
  - "Meta may spend up to ₹1,750 on a busy day."
  - "With an end date of 14 Nov this campaign could use up to ₹19,250 of your monthly limit. Without an end date we set money aside until the end of each month."
  - The end date defaults to the last day of the month. "No end date" exists only for human campaigns.
- **SpendBanner in the AppShell banner slot,** in priority order:
  1. platform freeze;
  2. workspace stopped;
  3. limit reached ("Ads are paused: this month's ads limit is used up.");
  4. approvals waiting (approvers only);
  5. Meta limit needs attention;
  6. new-workspace limits (first 7 days, dismissible, remembered in localStorage inside try/catch).
  7. (critic) Choose a spending ad account (owners only, when there are several and none is chosen);
  8. (critic) Meta's limit is waiting for the owner (owners only, `pending_owner`).

### 8.3 Platform admin panel

Access is gated by `handleAdmin`: allowlist, verified email, TOTP step-up and same origin on mutations. Every mutation needs a reason (`requireReason`) and is audited as `admin.spend.*` or `admin.tenant.<action>`. It also writes a ledger row with actorType `platform_admin`. AdminShell NAV gains "Spending" after "Rate card".

**`/admin/spending`, "Spending across workspaces"** (`SpendingTable.tsx`, paged with Pager):

- **Top card** (`PlatformSpendSwitch.tsx`):
  - "Spending is on for all workspaces", with [Stop assistants everywhere] and [Stop all spending everywhere].
  - The dialog requires a reason, the typed "STOP SPENDING" and a step-up within 5 min. Copy: "Pauses every ad Edwyz runs on every workspace and holds automatic messages. Lowering is always allowed; nothing can be raised until you turn this off."
  - When on: "Stopped since 14:05 by admin@edwyz.com: <reason>" and [Turn spending back on] (also a typed confirmation and a reason).
- **Columns:**
  - Workspace, Plan;
  - New-workspace limits (On / Lifted / Forced);
  - Ads today (spent / set aside / limit);
  - Ads this month (spent / set aside / limit);
  - WhatsApp this month (spent / set aside / limit);
  - AI credits this month;
  - Meta limit (Managed ₹X / Off / Waiting for owner / Prepaid / No permission / Out of date / Loose by ₹Y);
  - Safety stops open, Requests waiting;
  - State (On / Assistants stopped / Stopped).
- **Filters:** On new-workspace limits, Stopped, Near a limit (80% or more), Meta limit needs attention, Safety stop open.
- **Sorting** by risk: (spent + set aside) / limit.
- **Amounts** are shown in each workspace's own currency, with no FX.
- **(critic) Every workspace is listed,** including ones with no SpendControl row yet (shown with defaults, I11), no Meta connection ("No ad account"), and no WhatsApp number. The demo workspace is labelled "Demo" and left out of the risk sort and the alerts.
- **(critic) It does not compute headroom for every workspace on each page load.** `spend.breakers` writes a per-workspace summary every 5 min to PlatformSetting `spend:summary:<tenantId>`. Erasure removes it with every key that contains the tenant id. The list sorts and filters these summaries, and each row shows "as of 14:05". Opening a workspace's Spending card computes live figures.
- **Alerts strip:**
  - notifier sender health ("Templates approved: 4 of 4", the tier, owners notified today against 200);
  - `spend.tripwire.bypass` count;
  - orphan ledger rows;
  - Meta limit errors.
  - (critic) background worker health (4.16);
  - (critic) missing FX rates or ceiling rows, with the number of workspaces affected (4.4);
  - (critic) the notifier workspace not exempt, or with non-admin members (7.4);
  - (critic) ad accounts connected to more than one workspace, and which one manages Meta's limit (5.1).

**`/admin/tenants/[id]` "Spending" card** (`TenantSpendCard.tsx`) shows the same figures per pot, open breakers, the Meta limit state and the last 20 ledger rows. New `applyTenantAction` actions, each an ActionForm with a reason:

- `set_spend_ceiling` (pot, currency, daily, monthly, optional end date): "Override ceiling". It can raise above the plan or probation, or lower below the owner's limit.
- `clear_spend_ceiling`
- `lower_spend_limits`: lowers the owner's limits, for example on abuse.
  - (critic) The owner can raise them again later. To make a cut stick, the admin also sets an override ceiling (`set_spend_ceiling`). The form says so.
- (critic) `lower_assistant_level` (assistant, level, optional mandate ceilings): a platform admin can lower, never raise, any assistant's level or ceilings, for example while a bug is investigated. Ledgered as `mandate.change` with actorType `platform_admin`.
- (critic) `meta_limit_offboard`: applies one of the 5.8 choices for a workspace that is being suspended or deleted.
- `lift_probation` / `set_probation` (`forced`) / `verify_workspace` (sets verifiedAt)
- `freeze_spending` (level) / `unfreeze_spending`
- `clear_breaker`
- `mark_test_ad_account` (MetaAsset.sandbox)
- `end_learning` (assistant; sandbox or verified only)
- `resync_meta_limit`: a P1 write within budget.

**`/admin/spending/settings`** (`CeilingsForm.tsx`):

- "Limits for new workspaces": per currency and pot, daily and monthly. INR ads is seeded at ₹2,000 / ₹20,000. Other rows show "Not set".
- "Platform ceilings": per currency and pot.
- "Exchange rates for limits": INR per unit, with the date updated. A rate older than 35 days shows "Out of date" and is not used.
- "Notification sender": workspace, phone number, template names, language.
- "Default request expiry".
- "Meta limit": routine changes per day and emergency reserve.

**Elsewhere in the admin panel:**

- **Plans.** `PlanForm.tsx` gains "Ads ceiling per day / per month" (one row per currency, INR first), "WhatsApp ceiling per month" and "AI credits per day". They are stored as SpendCeiling rows with scope `plan`, so the Plan table is unchanged.
- **Rate card.** It gains a "Service (free-form) messages" column and a "Rates use 2 extra decimals" toggle (`scale`).
- **Audit labels.** `AUDIT_LABELS` gains plain labels for every new action.

### 8.4 Workspaces without Meta, without WhatsApp, and the demo workspace (critic)

The Spending limits page and the admin rows work for every workspace (R3). This is what each case shows and does:

| Workspace | Ads pot | WhatsApp pot | AI pot | Wall (a), breakers, digest |
|---|---|---|---|---|
| No Meta connection | Limits can be set ahead (currency select, 3.1). "No ad account connected yet." No ads can start without a connection anyway | Normal if a number is connected | Normal | No Meta card. No ads sync or ads breakers. The digest covers WhatsApp and AI only |
| Meta connected, no ad account (pages only) | Same as above | Normal | Normal | Same as above |
| No WhatsApp number | Normal | "Connect WhatsApp to use this. You can set a limit now." Inputs work | Normal | No quality poll. The owner's alerts still come from the platform notifier, which does not need the workspace's own number |
| Token expired or revoked | Limits shown. Live commitments stay counted (4.8) | Sends already fail with `auth_expired`. No holds are added | Normal | `meta_cap_unreachable` while commitments are live, and the reconnect banner. Reconnecting is a Meta consent screen |
| Sandbox ad account (`MetaAsset.sandbox`) | Normal, rows flagged `sandbox` and left out of real totals | Normal | Normal | Wall (a) mode `sandbox`. SPEND_SIM data |
| Demo workspace (`scripts/seed-demo.mjs`: placeholder Meta token, `MetaAsset.meta.demo = true`, a fake phone number) | Shows seeded sample figures labelled "Sample data". Every raise is refused with "This is a demo workspace, so nothing can be spent." | Same | Real AI calls still go through the gateway and count | `isDemoAsset()` keeps every Meta call away from demo assets: no metacap reads or writes (the card says "Demo account: Meta's limit isn't used"), no fast or structure sync, no quality poll (no sendable token), no digest. The admin list labels it "Demo" and leaves it out of alerts and the risk sort |

The demo seed (`scripts/seed-demo.mjs`) gains a SpendControl row, sample allowances (ads ₹2,000 a day and ₹20,000 a month, WhatsApp ₹5,000 a month), a few ledger rows marked `sandbox=true`, and plain-language optimizer rationale ("Spent ₹31 in 7 days with no results"). The current seed writes "minor units", which the copy test would reject.

---

## 9. Ledger, undo and digest

### 9.1 Ledger (R8)

- **Single writer.** `SpendLedger` is written only by `src/lib/spend/ledger.ts`:
  - `appendRequest(tx, row)` runs inside the reservation transaction. If it fails, the action stops (auditStrict semantics).
  - `appendOutcome(correlationId, row)` never throws and retries once (auditOutcome semantics).
- **Pairs.** Rows come in pairs with the same correlationId: `requested`, then exactly one of `applied`, `failed`, `unconfirmed`, `refused` or `reconciled`. `shadow` and `info` rows stand alone.
  - (critic) A refusal from the book's checks is a standalone `refused` row with no `requested` (4.6), and so is an observe-mode would-refusal. External changes found by the structure sync or metacap are standalone `reconciled` rows with actorType `external`. An `unconfirmed` outcome may be followed later by one `reconciled` row with the same correlationId. That is the only case where a pair has a third row.
- **Idempotency.** idempotencyKey is unique per (tenant, key, phase). Examples: `activate:<campaignId>:<campaign.updatedAt>`, `approval:<id>`, `breaker:<kind>:<scope>:<day>`.
- **Fields.** R8 asks for who, why, forecast, before and after, approval id and undo recipe:
  - actorType, actorId, assistantKey, autonomyLevel;
  - reason (required plain text) and reasonCodes;
  - forecastToday and forecastMonth (worst-case deltas) and a snapshot of {limits, ceiling, spent, committed, freeze, breakers};
  - before and after JSON;
  - approvalId;
  - undo, an executable recipe. Examples: `{action: 'set_adset_budget', metaAdSetId, dailyBudgetMinor: '80000'}`, `{action: 'resume_campaign', campaignId}`, `{action: 'set_allowance', pot, monthlyLimitMinor}`.
- **Action vocabulary:**
  - `ads.campaign.activate|pause|archive`, `ads.adset.budget_raise|budget_cut|pause|resume`, `ads.ad.pause|resume`, `ads.commitment.reconciled`;
  - `meta.spend_cap.write|read_drift|observe`;
  - `allowance.change`, `ceiling.change`, `probation.change`, `kill.workspace|platform`;
  - `breaker.trip|clear`, `mandate.change`;
  - `approval.create|approve|decline|expire|supersede|apply`;
  - `messaging.bulk_hold|bulk_release|settlement|blocked` (aggregated: at most one `blocked` row per tenant per reason per hour);
  - `ai.settlement` (daily aggregate);
  - `consent.meta_cap|owner_whatsapp`;
  - `notify.digest|alert|approval` (phase `info`, no amounts);
  - `tripwire.bypass` (mirror of the audit row).
- **Not one row per message or AI call.** Per-message and per-AI-call money lives in SpendCounter, Message and UsageLedger.
- **Compatibility.** Existing AuditLog `ads.*` rows stay for the admin audit page. The ledger is the source of truth.
- **Checks:**
  - nightly `spend.ledger.crosscheck` flags correlationIds with no outcome after 1 hour as `orphan` (shown in the admin panel);
  - `spend.counters.verify` (every 15 min) rebuilds `reservedMinor` from the open rows (held reservations, messages with spendState `reserved`);
  - nightly, it rebuilds month `spentMinor` from settled rows plus settlement rows, and alerts on drift over 1%.
- **Reading.** `listLedger(tenantId, {pot?, cursor: seq, limit ≤ 100})`, ordered by seq. Admin CSV export.

### 9.2 Undo

- Undo appears in the activity table only when a recipe exists and the caller's role allows it (8.1), for up to 14 days.
- Undoing a raise is a lowering and is always allowed.
- Undoing a lowering is a raise. It goes through `reserveAds`, or through the allowance rules for limits, and can be refused with the normal copy.

### 9.3 Daily digest (`notify/digest.ts`, `spend.digest` every 15 min)

- **Selection.** Workspaces with `digestEnabled` whose local time (`SpendControl.timezone`) is 09:00 or later, where `claimOnce('spend-digest:<tenantId>:<localDate>')` succeeds. They are processed in cursor batches of 50, like `runUsageAlerts`.
- **Content, for yesterday:**
  - ads spent (counted scope), and month to date against the limit;
  - new leads (Lead rows plus campaign results) and cost per lead ("no leads yet" when there are none);
  - WhatsApp spent (estimate);
  - AI credits used;
  - assistant actions (n applied, of which n lowering);
  - the shadow "would have done" count;
  - safety stops tripped and open;
  - requests waiting;
  - left this month per pot.
- **WhatsApp** (`spend_daily_v1`, UTILITY, account-update style): "Daily update for {{1}} on {{2}}: ads spent {{3}}, {{4}} new leads, {{5}} per lead. WhatsApp messages about {{6}}. Automatic changes: {{7}}. Requests waiting for you: {{8}}. Left this month for ads: {{9}}." URL button "Open Edwyz" to `/app/settings/spending`.
- **Recipients and fallbacks.** It goes to verified owner and approver channels. The email fallback carries the same numbers in a plain table. In-app, it is stored as the "Yesterday" strip.
- **Quiet workspaces.** Nothing is sent when there was no spend, no leads, no actions and nothing pending in the last 7 days. This protects the TIER_250 budget.
- **(critic) Partial workspaces.** A workspace with no ad account gets the digest without the ads lines. Empty lines are left out rather than shown as ₹0. The template keeps fixed slots, so its `{{3}}`-`{{5}}` read "no ads connected". The demo workspace never gets a digest.
- **(critic) Time zone.** "Yesterday" is the workspace time zone's yesterday for WhatsApp and AI, and the ad account's yesterday for ads. When they differ, the email version says so.

---

## 10. Test plan

### 10.1 Unit (vitest, `tests/*.test.ts`)

In the ads, optimizer and send tests, Prisma is mocked with `vi.hoisted` and `@/lib/spend/book` is mocked wholesale. `tests/helpers/fake-spend-db.ts` adds `$transaction` and `$executeRaw` for the book's own tests.

- **`spend-worstcase.test.ts`:**
  - the October 2026 table (33,250 / 19,250 / 7,000);
  - a mid-day raise uses the peak, and a mid-day cut does not lower today's worst case;
  - a lifetime budget caps the result;
  - a week straddling the month boundary;
  - spentToday above 1.75x gives 0, not a negative number;
  - America/New_York across a DST change;
  - JPY (0 decimals) and KWD (3 decimals);
  - 10^15 minor units with no overflow.
  - **Property test** (fast-check): a Meta adversary spends the maximum the rules allow (≤ 1.75 x the day's peak, ≤ 7 x the week's peak) over random budget schedules. Actual spend never exceeds spent + committed computed at any earlier point.
- **`spend-allowances.test.ts`:**
  - min over sources;
  - a tenant override replaces plan and probation, and expires;
  - FX rounds down, a stale rate counts as missing, and an unknown ceiling refuses;
  - probation lifts automatically after 2 paid invoices or verifiedAt;
  - the AI pot is capped by the plan.
- **`spend-book.test.ts`:**
  - refusal copy carries the right numbers;
  - idempotency returns the same permit;
  - lowering never takes the lock;
  - the budget-change quota;
  - `META_CAP_TOO_LOW`;
  - not the spending account;
  - stale data gives the worst case.
- **`spend-policy.test.ts`:** the full matrix, levels 0-2 × lowering / raise / launch × within or over the 20% and 25% boundaries (+20% exactly is allowed, +20.01% needs approval, a cumulative 10% then 11% is caught) × shadow × frozen × breaker × an unmanaged Meta limit × an end date missing.
- **`spend-classify.test.ts`:** fixtures for every existing Graph call in src (CAPI, subscribed_apps, content publishing, DELETE permissions, template create and upload, insights GETs) are `not_spend`. Every adsClient body, spend_cap and /messages call is spend.
- **`spend-tripwire.test.ts`:**
  - an unpermitted POST to `act_1/campaigns`, `<id> {status: ACTIVE}`, `act_1 {spend_cap}` or `<phone>/messages` throws in enforce mode and is audited in report mode;
  - a permit for another path throws;
  - a permit used past maxUses throws;
  - a budget above the permit's max throws;
  - a create without PAUSED throws;
  - a pause with no permit passes and is audited.
- **`spend-bypass.test.ts`:** rules B1-B14 (critic: B14 added), plus the self-test.
- **`spend-metacap.test.ts`:**
  - the target under both semantics;
  - the hysteresis threshold;
  - the change budget (P0 still allowed at 9 used, routine refused at 6);
  - unit mismatch (x100 and /100);
  - parsing the floor error ("must be at least ₹1,234.56");
  - 17/1885172;
  - prepaid, no_permission and currency_mismatch;
  - external lower adopted and external raise restored;
  - rollover uses one write;
  - observe mode makes no POST.
- **`spend-breakers.test.ts`:** synthetic series for:
  - pacing (warning against trip);
  - efficiency (zero leads, minimum spend);
  - spend_jump;
  - CPM and CTR with the impression floor;
  - account_spike;
  - daily_limit pause and auto-resume through `reserveAds`;
  - monthly_limit with a failed pause leading to P0;
  - PAUSED preferred after 3 budget changes;
  - idempotent re-trips;
  - human campaigns notify-only unless the toggle is on.
- **`spend-messaging.test.ts`:**
  - the conservative estimate (unpriced uses the max rate, unknown category counts as marketing, +1 and +7, a missing SERVICE rate uses the utility rate, free entry point is 0);
  - every cell of the gate table in 4.9;
  - a template paused while queued fails;
  - the lock-free reservation cannot overdraw under parallel calls;
  - settlement deltas, including a free entry point refund.
- **`spend-ai.test.ts`:** the hard stop, settlement and refund, token capture, and the freeze levels.
- **`spend-approvals.test.ts`:**
  - fingerprint mismatch gives `failed`;
  - expiry gives declined;
  - supersede;
  - decline by token logged out;
  - approve requires an approver session;
  - quick-reply HMAC and phone checks;
  - a raising optimizer proposal refused for a non-approver admin.
- **`spend-api.test.ts`:**
  - an admin raise gets 403 and an admin lower is allowed;
  - a team member gets 403 on PUT and 200 on GET summary;
  - version 409;
  - kill on for admin, off for owner only.
- **`spend-ui.test.ts`:** `renderToStaticMarkup` of every card per role, with copy snapshots, "Not set", and no jargon.
- **`spend-copy.test.ts`:** the banned-words check.
- **Updated:**
  - `ads-launcher`, `ads-actions`, `optimizer-service`, `creative-ads-ab`, `tenant-lifecycle-admin`, `lifecycle-erase`;
  - `ops-env` (new flags);
  - `auth-nav` (28 and 16);
  - `admin-access` (new handler total);
  - `worker-loop` (spend module mock);
  - `lifecycle-personal-data` (15 tables);
  - `billing-limits` and `ai-agent`.
- **(critic) Added cases:**
  - `spend-worstcase`: a lifetime-only commitment's dayRisk equals its remaining lifetime; budget sharing uses ceil210 and 8.4x.
  - `spend-book`: an orphan active AdCampaign with no commitment is counted; the Meta pre-read happens before the lock (a spy shows no fetch while the lock is held); 613/1487632 opens `budget_change_quota`; observe mode still refuses the I12 checks (no daily limit, over the daily limit, currency, a non-PAUSED create).
  - `spend-structure-sync` (new): every row of the 4.6.1 table against fake Meta; an assistant campaign with its end date removed keeps a month-end horizon and passes the CHECK constraints; no write calls are made.
  - `spend-policy`: the anti-splitting rolling 24 h sum; a missing mandate gives a suggestion, not a refusal; a human approval during shadow applies as actor `user`.
  - `spend-approvals`: a double tap applies once; approval after `expiresAt` fails even when the expiry task has not run; an approver demoted after the request cannot approve; reverting a pause needs an approver.
  - `spend-messaging`: an ambiguous send settles at its estimate; a message that failed after acceptance settles at 0; the delta lands on the message's own day and month; human-class sends always increment; chatbot and ai_reply hand off on exhaustion; an exhausted bulk reservation falls back to per-message reservations.
  - `spend-caps-shim` (new): `/api/ads/caps` PUT C then GET returns C for C in {1, 571, 1000, 1142, 10^9}; `MAX_DAILY_BUDGET_MINOR` maps to ceil175.
  - `spend-api`: lowering and freezing work when the workspace is locked (402 for raises only); Not set to a number by an admin gets 403; a missing SpendControl row is upserted with defaults.
  - `spend-metacap`: a second workspace on the same `accountExternalId` gets `other_workspace`; start values at mid-month consent; S under `resets_on_write`; locked workspaces defer P2 and never raise; offboarding choices on close, suspend and account change.
  - `spend-eddy` (with WP-13 and the Eddy work): no Eddy action runs without a matching confirm token; B14 holds; an Eddy send is origin `eddy` and is never held by cost.
  - `spend-health`: a stale daemon heartbeat raises the admin alert; a kill toggle pauses inline with the worker mocked as down.
  - `spend-demo`: no Graph call is made for an asset with `meta.demo = true`.
- **(critic) Updated as well:** `seed-demo` (the copy check passes on seeded rationale); `auth-index` (`/api/spend/` is exempt from the paywall guard only for lowering operations).

### 10.2 Database integration (`tests/db/*.test.ts`)

These tests are a vitest project `db`, run with `DATABASE_URL_TEST` against a disposable Postgres. Setup applies 0001-0009 with psql. The project is skipped when the variable is unset, and it is required in the pre-deploy check.

- **`ledger-trigger`:**
  - UPDATE, DELETE and TRUNCATE raise 42501;
  - DELETE succeeds only inside a transaction with `set_config('edwyz.purge','SpendLedger:<tenantId>',true)`, and only for that workspace's rows (12.1c R2);
  - a second transaction without the flag still fails;
  - the same for SpendConsent.
- **`ads-concurrency`:** 2 forked Node processes run 25 parallel `reserveAds` each against a limit that fits exactly 10. Exactly 10 succeed and there is no deadlock. A lock timeout gives SpendBusyError.
- **`counters-concurrency`:** the same for messaging and AI reservations.
- **`crash-reconcile`:**
  - kill the process after `reserveAds` commits and before settle; the commitment stays counted;
  - the reconciler with fake Meta at ACTIVE gives live, and at PAUSED gives stopped.
- **`backfill`:** a seeded `ads:caps` row gives ceil(1.75 x C) and `migratedFromCapMinor = C`; SpendControl rows are created; the probation row exists.
- **(critic) `migration-live`:** while another connection holds an open transaction on `Message`, 0009 fails within 5 s on `lock_timeout` and leaves nothing applied. Without it, 0009 applies, and 0010 builds its indexes CONCURRENTLY while a parallel writer keeps inserting Messages without blocking. The old Prisma client (before generate) can still insert AdCampaign and Message rows after 0009.
- **(critic) `lock-order`:** a metacap write holding the account lock while `reserveAds` runs on the same tenant completes without deadlock. Nested spend locks for two pots throw in test mode.
- **(critic) `one-manager`:** two workspaces turning on Meta's limit for the same `accountExternalId` in parallel: exactly one becomes `managed`; a `pending_owner` row of a third workspace does not stop either (12.1c R3).

### 10.3 Fake Meta and simulator (`tests/helpers/fake-meta.ts`, `scripts/spend-sim.ts`)

**fake-meta** keeps campaigns, ad sets and ads in memory (status, daily_budget, lifetime_budget, end_time) and enforces:

- 4 budget changes an hour (613/1487632);
- spend_cap with switchable semantics (cumulative or resets on write), switchable write unit (major or minor) and a floor rule (≥ spent, or ≥ 1.1x spent);
- the 10-a-day limit (17/1885172);
- a prepaid flag and permission errors;
- injectable ambiguous 5xx responses.

Its adversarial spend generator obeys 1.75x and 7x and stops at the cap. Self-tests cover these behaviours.

**spend-sim** writes SpendDaily and IntradaySpendSample series for sandbox workspaces: normal, runaway, zero-lead and CPM spike.

### 10.4 End-to-end (Playwright, desktop Chrome and Pixel 7 @mobile)

These run with `SPEND_DRY_RUN=1` and the helpers in `e2e/spend-kit.ts`. Every spec checks axeSerious, no horizontal overflow and the dark theme.

- **`spend-settings.spec.ts`:**
  - the owner sets limits and sees "Left";
  - an admin can lower, and a raise shows the 403 copy;
  - a team member sees read-only cards and gets 403 on PUT;
  - "Not set" renders;
  - the new-workspace note shows.
- **`spend-kill.spec.ts`:** an admin stops spending; ads show paused (dry-run Meta); an automated send is held; a human inbox reply still sends; the owner turns spending back on; the admin cannot.
- **`spend-broadcast-gate.spec.ts`:** with a rate card and a small WhatsApp limit, a broadcast start returns the 409 copy and nothing is queued.
- **`spend-approvals.spec.ts`:** an approval seeded through `db()`; the logged-out token link can Decline; Approve redirects to login and is then applied; an expired approval shows "Declined automatically".
- **`admin-spending.spec.ts`:**
  - list filters;
  - a ceiling override with a reason;
  - lifting probation;
  - the platform switch with typed confirmation shows in a workspace within 5 s;
  - a non-admin gets 404 (also added to `settings-billing-admin-public.spec.ts` PAGES and GETS).
- **`growth-ads.spec.ts`:** updated for the 1.75x maths by setting the limit high enough. `growth-helpers.setCap` writes SpendAllowance as well as the legacy key.
  - (critic) With the 4.8 shim keeping the old meaning of `/api/ads/caps`, the spec's numbers stay as they are. `setCap` writes `dailyLimitMinor = ceil175(C)`, so a direct database write and an API write give the same room.

### 10.5 Sandbox and shadow (R6)

- **Sandbox setup.** One sandbox ad account per Meta app is created from the Marketing API quickstart and connected to a staging workspace. A platform admin marks it "test ad account" (`MetaAsset.sandbox`).
- **Behaviour in the sandbox:**
  - wall (a) is skipped (mode `sandbox`);
  - allowances, policy, approvals and the ledger run normally, and their rows carry `sandbox=true` and are excluded from real totals;
  - assistants may run Level 2 without shadow;
  - insights come from `SPEND_SIM`, because the sandbox delivers nothing and its Insights support is uncertain.
- **Exit check:** every breaker trips at least once in the sandbox, with correct notifications.
- **Shadow tests:** no permit is minted while `shadowUntil` is in the future, and the 24 h and 72 h evaluation fills outcomes.
- **Gate for `ASSISTANT_SPEND_ENABLED=true`:**
  - at least 3 internal workspaces complete shadow with zero "would exceed allowance" verdicts;
  - owners agree with at least 70% of the suggestions;
  - the runbook V1-V9 has passed;
  - `SPEND_TRIPWIRE=enforce` has run for 7 days.

### 10.6 Live verification runbook (`docs/spend-verification-runbook.md`)

This runs on one real INR ad account with a ₹500 test monthly limit, before `SPEND_CAP_MODE=enforce` (open question 5). Checks:

- V1: the write unit, from the read-back;
- V2: whether a write resets `amount_spent`;
- V3: the floor rule and its error text;
- V4: the time before a change applies (expected about 15 min) and how far spend overshoots after the cap;
- V5: the ad account role needed;
- V6: whether GST is included in `amount_spent`;
- V7: the 11th change returns 17/1885172;
- V8: prepaid detection;
- V9: the insights day boundary in the account time zone.
- (critic) V10: the most a lifetime-budget ad set spends in one day, relative to its remaining budget and days left. Until this is measured, 4.5 counts the whole remainder as today's risk.
- (critic) V11: whether `amount_spent` ever goes down (refunds, invalid-click credits) without a write, and whether Meta ad credits are included in it.
- (critic) V12: the per-ad-set budget-change limit when edits are made both in Ads Manager and through the API, to confirm they share Meta's 4-an-hour quota.

Results go in `'spend:meta-verified'`.

---

## 11. Work packages

Ordering principle: the guardrails ship before anything can spend. Today only humans spend, and assistants are proposal-only. Assistants cannot leave Level 0 or shadow until WP-19 flips `ASSISTANT_SPEND_ENABLED` after the 10.5 gate.

File sets are disjoint, with two exceptions:

- `tests/spend-bypass.test.ts`: WP-05 owns it, and WP-13 deletes one temporary allowlist line.
- `src/lib/spend/messaging/origin.ts`: WP-09 creates it, and WP-11 flips the origin type to required.

Task-stub files are created by WP-03 and owned by the WP named beside them. Hot files (`ads/service.ts`, `ads/actions.ts`, `inbox/send.ts`, `inbox/service.ts`, `webhooks/processor.ts`, `admin/tenants.ts`) each belong to exactly one WP. Other developers are editing src, so rebase often.

**Release trains:**

| Train | WPs | Flags at deploy |
|---|---|---|
| 1. Guardrails in observe | 00-06, 09, 13 | `SPEND_ENFORCE=observe`, `SPEND_TRIPWIRE=report`, `SPEND_CAP_MODE=off`, `ASSISTANT_SPEND_ENABLED=false` |
| 2. Walls and breakers | 07, 08, 10, 11, 12, (critic) 18 | `SPEND_CAP_MODE=observe` |
| 3. People and panels | 14, 15, 16, 17 | unchanged |
| 4. Go-live | 19 | `SPEND_ENFORCE=enforce` (after 7 days of observe), `SPEND_TRIPWIRE=enforce` (after 7 days with zero bypass rows), `SPEND_CAP_MODE=enforce` (after V1-V9), and `ASSISTANT_SPEND_ENABLED=true` (after the 10.5 gate, an owner decision) |

(critic) Rollout order fixes:

- **Train 1 deploy steps, in this order:**
  1. back up the database and check `SHOW server_version` (11 or later);
  2. apply 0009 with `-1` (3.2.1);
  3. run `scripts/spend-backfill-commitments.ts` from the new build's checkout, while the old build still serves;
  4. restart web and worker on the train 1 build;
  5. apply 0010 without `-1`, off-peak, the same day or later.
  
  Step 3 before step 4 means the first request on the new code already sees every live campaign as committed. The orphan rule in 4.6 covers a backfill that fails.
- **WP-18 moves from train 3 to train 2.** It depends only on WP-03, WP-04 and WP-07, and shipping it early gives platform admins the platform-wide kill switch and the spending list before train 3 adds approvals and notifications. It must deploy with WP-11 or after it, so that a platform freeze never holds human inbox replies that still carry origin `unknown`. The rule in general: no freeze control (WP-16, WP-17 or WP-18) may go live before WP-11.
- **Train 3 prerequisites, checked before deploy:**
  - the 4 notifier templates were submitted at least 48 h earlier and are approved;
  - the notifier workspace is `billingExempt` and has only platform-admin members (7.4);
  - `SMTP_USER` and `SMTP_PASS` are set (open question 2);
  - `SPEND_NOTIFY_SECRET` is set (env-rules requires it once WP-15 is in the build).
- **R3 between trains.** In trains 1 and 2 the only workspace control is the existing CapPanel. With the 4.8 shim it keeps its exact meaning, and new checks are in observe mode, so nothing new can block anyone before the Settings page (train 3) lets owners see and change every pot. In train 2 the admin panel (WP-18) already shows every workspace's limits.

(critic) Files added by the review, each owned by exactly one WP:

| WP | Added files and duties |
|---|---|
| WP-00 | `prisma/migrations/0010_spend_message_indexes/migration.sql`; the 3.2.1 changes to 0009 (lock timeouts, NOT VALID, SpendDaily key, `external` actor, MetaSpendLimit columns and the one-manager index, backfill rules); `tests/db/migration-live.test.ts`; erasure calls `notify.eraseOwnerData(tenantId)` (stub from WP-03, real from WP-15) and `metacap.offboard(tenantId)` (stub from WP-03, real from WP-07) |
| WP-01 | lifetime-only dayRisk, `ceil210` for budget sharing, the anti-splitting term in `policy.ts`, `decimalToMinorBig` in `money.ts` |
| WP-03 | `src/lib/spend/{health,demo}.ts` (`spend.health`, `isDemoAsset`); `getControl()` lazy upsert (I11); the lock-order guard (I10); stubs `notify.eraseOwnerData` and `metacap.offboard`; `tests/spend-health.test.ts` |
| WP-04 | orphan active-campaign counting; the metacap pre-read before the lock; standalone `refused` rows; I12 in observe mode; `tests/db/lock-order.test.ts` |
| WP-06 | the `/api/ads/caps` legacy meaning and `MAX_DAILY_BUDGET_MINOR` parity; inline `stopCommitments` helper for toggles; unpausable objects stay `unconfirmed`; `tests/spend-caps-shim.test.ts` |
| WP-07 | one manager per `accountExternalId`; the "managed" definition; start values and `spentAtLastWriteMinor`; offboarding on account change, close, suspend and erase (`src/lib/lifecycle/export-deletion.ts`, `src/components/billing/CloseWorkspace.tsx`); the no-redirect copy; `tests/db/one-manager.test.ts` |
| WP-08 | `src/lib/spend/sync/structure.ts` (4.6.1); the `external_edit` breaker; the `daily_limit` resume rule; `spend:summary:<tenantId>` written by `tasks/breakers.ts`; demo and 409 skips; `tests/spend-structure-sync.test.ts` |
| WP-09 | origin `eddy`; unconditional counting for never-blocked origins; ambiguous sends settled at their estimate; settlement of failed and unpriced messages on their own day; the bulk-reservation fallback; chatbot and ai_reply handoff on exhaustion |
| WP-10 | the scheduled-broadcast dry run and its warning |
| WP-13 | gateway feature `eddy`; freeze `all` keeps human-requested AI; escalation falls back to a person |
| WP-14 | conditional approval update and lazy expiry; approver re-check; `revertProposal` routing; shadow and missing mandates keep suggestions |
| WP-15 | notifier exemption and member checks; STOP across channels; `notify.eraseOwnerData`; digest for partial workspaces |
| WP-16 | `src/lib/auth/index.ts` paywall exemption for `/api/spend/` with per-route raise checks (4.17); Not set to a number is owner only; the inline stop in the freeze route |
| WP-17 | the no-ad-account, several-accounts, two-time-zone and WhatsApp-currency states; the "Resume" list after a stop; banner items 7 and 8; the CapPanel help text |
| WP-18 | (now train 2) the summary-cache list, all-workspaces listing, demo label, new alerts, `lower_assistant_level`, `meta_limit_offboard`, inline platform stop with progress |
| WP-19 | `scripts/seed-demo.mjs` spend seed and plain rationale; `tests/spend-demo.test.ts`; runbook V10-V12 |

The Eddy executor (`src/lib/eddy/execute.ts`) belongs to the Eddy project, not to a Phase 0 WP. Phase 0 owns its contract (4.15) and bypass rule B14 (WP-05).

| ID | Title | Files | Depends on | Acceptance |
|---|---|---|---|---|
| WP-00 | Schema, migration 0009, data registry, erase purge, env flags | `prisma/schema.prisma`; `prisma/migrations/0009_spend_controls/migration.sql`; `src/lib/lifecycle/personal-data.ts`; `src/lib/lifecycle/erase-workspace.ts`; `src/lib/lifecycle/retention.ts`; `src/lib/env-rules.mjs`; `.env.example`; `tests/lifecycle-personal-data.test.ts`; `tests/lifecycle-erase.test.ts`; `tests/ops-env.test.ts`; `tests/spend-migration.test.ts` | none | (1) 0009 applies cleanly with `psql -1 -v ON_ERROR_STOP=1` on an empty database and on a restored production copy; `prisma generate` and `tsc --noEmit` pass. (2) The backfill gives ceil(1.75 x C) per `ads:caps:%` row, a SpendControl row for every tenant, and the INR probation row 200000/2000000. (3) UPDATE, DELETE and TRUNCATE on SpendLedger and SpendConsent raise 42501; workspace erasure purges them inside one transaction and also deletes `tenant` SpendCeiling rows. (4) personal-data passes with 15 tables. (5) env-rules knows every flag in 4.14, refuses `SPEND_DRY_RUN` in production, and warns on `MAX_DAILY_BUDGET_MINOR` |
| WP-01 | Pure spend core: types, money, periods, worst case, policy, classifier, permit brand, copy, assistant registry | `src/lib/spend/{types,money,periods,worstcase,policy,classify,permit,copy,registry}.ts`; `tests/spend-worstcase.test.ts`; `tests/spend-policy.test.ts`; `tests/spend-classify.test.ts`; `tests/spend-copy.test.ts` | none | (1) No imports of prisma or fetch (test). (2) The October 2026 table and the fast-check adversary pass. (3) The full policy matrix passes. (4) Every existing non-ads Graph call fixture is `not_spend`; every spend write is classified with the correct direction. (5) Every error code has copy, with no banned words. (6) `permit.ts` exports the ALS store and `mintPermit` with a brand type |
| WP-02 | Test harness: fake Meta, db test project, simulator, runbook doc | `tests/helpers/fake-meta.ts`; `tests/fake-meta.test.ts`; `tests/helpers/pg.ts`; `tests/helpers/fake-spend-db.ts`; `vitest.config.ts`; `scripts/spend-sim.ts`; `docs/spend-verification-runbook.md` | none | (1) fake-meta enforces 4 budget changes an hour, 10 cap changes a day, both cap semantics, both write units, the floor rule, prepaid, permission and ambiguous 5xx; its adversary respects 1.75x and 7x and stops at the cap (self-tests). (2) A vitest `db` project is gated on `DATABASE_URL_TEST`. (3) spend-sim writes the four series. (4) The runbook lists V1-V9 with commands, pass criteria and where results are recorded |
| WP-03 | Spend Book foundations: lock, ledger, limits, ceilings, probation, FX, kill state, lock-free counters, bulk reservations, breaker state, worker module and task stubs | `src/lib/spend/{lock,errors,ledger,allowances,ceilings,probation,fx,kill,counters,reservations,worker}.ts`; `src/lib/spend/breakers/state.ts`; `src/lib/spend/tasks/ledger.ts`; stubs `src/lib/spend/tasks/{commitments,adsguard,metacap,breakers,messaging,quality,approvals,digest}.ts`; stubs `src/lib/spend/notify/{index,inbound}.ts` (in-app plus email only until WP-15); `src/worker/loop.ts`; `tests/worker-loop.test.ts`; `tests/spend-allowances.test.ts`; `tests/spend-counters.test.ts`; `tests/db/ledger-trigger.test.ts`; `tests/db/counters-concurrency.test.ts` | WP-00, WP-01, WP-02 | (1) `withSpendLock` uses the two-key lock with `lock_timeout` 3 s, and a timeout gives SpendBusyError 503. (2) `effectiveLimits` follows 4.4, including FX staleness and the unknown-ceiling refusal. (3) `spendState({fresh})` reflects a toggle at once; the cached read is at most 5 s old. (4) Counter reservations cannot overdraw across 2 processes (db test). (5) Expired reservations are released; `spend.counters.verify` rebuilds reserved totals. (6) The spend WorkerModule is registered in MODULES and worker-loop passes. (7) Ledger request and outcome pairing, idempotency, and orphan crosscheck |
| WP-04 | Ads commitments, permits and reconciler | `src/lib/spend/{book,commitments,reconcile}.ts`; `src/lib/spend/tasks/commitments.ts`; `scripts/spend-backfill-commitments.ts`; `tests/spend-book.test.ts`; `tests/db/ads-concurrency.test.ts`; `tests/db/crash-reconcile.test.ts` | WP-03 | (1) `headroom` returns the figures in 4.6, with external spend counted only when Meta's limit is managed. (2) `reserveAds` runs steps 1-13; the refusal copy carries the numbers. (3) Across 2 processes exactly N reservations succeed. (4) After a crash between reserve and settle the reservation stays counted, and the reconciler settles it from fake Meta in one run. (5) `recordLowering` takes no lock and works while frozen and while another transaction holds the lock. (6) The backfill script turns every active AdCampaign into live commitments with the account time zone |
| WP-05 | Transport tripwire and bypass build gate | `src/lib/graph/index.ts`; `src/lib/spend/tripwire.ts`; `tests/spend-tripwire.test.ts`; `tests/spend-bypass.test.ts`; `deploy/README-deploy.md` | WP-00, WP-01 | (1) `run()` calls the tripwire before any I/O and behaves as in 4.7 in both modes. (2) Lowering is never blocked. (3) Rules B1-B14 (critic: B14) pass on the current tree with reasoned allowlist entries, and the self-test fails on a planted fixture. (4) The deploy README runs the bypass test before `next build` and documents the 0009 trigger in backups. (5) (critic) The deploy README documents the 3.2.1 procedure: version check, backup, 0009 with `-1`, the commitments backfill, the build, and 0010 without `-1` |
| WP-06 | Ads call sites through the Spend Book | `src/lib/ads/{client,stop,actions,service,builders,caps}.ts`; `src/lib/tenant-lifecycle.ts`; `src/lib/meta-connect/revoke-all.ts`; `src/app/api/ads/caps/route.ts`; `src/components/ads/CampaignWizard.tsx`; `src/lib/spend/tasks/adsguard.ts`; `tests/ads-launcher.test.ts`; `tests/ads-actions.test.ts`; `tests/creative-ads-ab.test.ts`; `tests/tenant-lifecycle-admin.test.ts`; `e2e/growth-helpers.ts` | WP-04, WP-05 | (1) `adsClient` without a guard does not compile. (2) An ACTIVE status or a budget raise without a valid permit throws before any fetch (spy: 0 calls). (3) `activateCampaign` writes requested then applied, or failed or unconfirmed on an injected ambiguous 5xx with the commitment still counted. (4) `resumeAd` is refused over the limit (regression for the old gap). (5) Pausing works while frozen. (6) An assistant `createAdSet` without an end date throws; builders send `end_time` and `lifetime_budget`. (7) `stopCommitments` never throws and pauses at campaign level for whole campaigns. (8) The `/api/ads/caps` role contract is unchanged, and the `caps.ts` shims keep existing callers compiling. (critic) Its number keeps the old budget-sum meaning, and PUT then GET round-trips exactly (4.8). (9) The `spend.stop` job and the 1-minute `spend.kill.sweep` pause everything live within 1 minute of a toggle. (10) The wizard shows the worst-case lines and defaults the end date to month end |
| WP-07 | Wall (a): Meta spending limit, consent, safe disconnect | `src/lib/spend/metacap/{client,plan,sync,consent}.ts`; `src/lib/spend/tasks/metacap.ts`; `src/app/api/spend/meta-limit/route.ts`; `src/lib/meta-connect/{discovery,service,scopes}.ts`; `src/app/api/meta-connect/disconnect/route.ts`; `src/components/meta-connect/ConnectionsPanel.tsx`; `tests/spend-metacap.test.ts`; `tests/meta-connect-disconnect.test.ts` | WP-02, WP-04, WP-06 | Against fake Meta: (1) the target is A + (M - S), or R under resets semantics; (2) reads use no change budget; (3) routine writes stop at 6 in 24 h, P0 is still allowed at 9, and raises are at most 2; (4) a unit mismatch is detected and the breaker opens; (5) the floor error leads to writing X and recording the looseness; (6) 17/1885172 sets writesBlockedUntil and opens `meta_cap_stale_high` when the blocked write was a lowering; (7) external lower adopted, external raise restored; (8) rollover uses 1 write; (9) observe mode makes no POST. Consent is owner only (admin gets 403 and the mode becomes `pending_owner`), append-only with the text hash. Disconnect pauses first, and a failed pause blocks it unless the owner sends `force` with "DISCONNECT" |
| WP-08 | Ads fast sync and ads breakers | `src/lib/spend/sync/fast-insights.ts`; `src/lib/spend/breakers/{ads,limits,anomaly}.ts`; `src/lib/spend/tasks/breakers.ts`; `src/lib/ads/insights-fetch.ts`; `tests/spend-breakers.test.ts`; `tests/spend-fast-sync.test.ts` | WP-02, WP-04, WP-06 | (1) SpendDaily account and ad set rows in account-time-zone days, with external = account - platform; IntradaySpendSample written. (2) Every breaker in 6.2 trips at its threshold and not below it, with the stated effect and clearing. (3) Performance breakers pause only assistant ad sets unless the toggle is on. (4) `daily_limit` auto-resumes only through `reserveAds`. (5) `sync_stale` after 45 min. (6) PAUSED is preferred after 3 budget changes |
| WP-09 | WhatsApp gate core: origin and category on jobs, send-time gate, lock-free per-message reservation, rate card SERVICE and scale, settlement | `src/lib/inbox/{send,service,interactive}.ts`; `src/lib/spend/messaging/{origin,estimate,gate,settle}.ts`; `src/lib/spend/tasks/messaging.ts`; `src/lib/admin/ratecard.ts`; `src/components/admin/RateCardEditor.tsx`; `tests/spend-messaging.test.ts`; `tests/inbox-send.test.ts` | WP-03, WP-05 | (1) The job and Message carry origin, category, estimate and spend state; `unknown` behaves as automated. (2) Every cell of the 4.9 table. (3) A paused template fails queued sends. (4) The send runs inside a `msg_send` permit. (5) An exhausted pot holds automated sends until the next local day, while a human send goes out flagged `over_limit`. (6) The rate card accepts SERVICE and scale=2. (7) Settlement applies pricing deltas once (`pricingSettledAt`) |
| WP-10 | Bulk messaging cost gates | `src/lib/broadcasts/{service,cost,process,pause-copy,notify}.ts`; `src/lib/automation/v2/timed.ts`; `src/lib/compat/messaging.ts`; `src/lib/integrations/v1-service.ts`; `src/lib/tenant-mcp/tools.ts`; `tests/broadcasts-cost-gate.test.ts` | WP-09 | (1) `startBroadcast` takes a 7-day reservation for the conservative estimate before the status change, or returns 409 with the copy and queues nothing. (2) Completion or cancel releases the rest. (3) The new pause reasons `number_quality_yellow`, `spending_stopped` and `messaging_limit` have plain copy. (4) A scheduled automation run is refused at start when it does not fit. (5) Compat bulk calls, v1 and MCP take reservations and stamp origins `api` and `mcp`; API sends get a synchronous 409 when the pot is exhausted |
| WP-11 | Origin stamping at every remaining sender; makes origin required | `src/lib/automation/v2/actions.ts`; `src/lib/automation/engine.ts`; `src/lib/automation/v2/holiday.ts`; `src/lib/chatbots/{engine,worker}.ts`; `src/lib/leads/runner.ts`; `src/lib/commerce/reminders.ts`; `src/lib/inbox/{new-chat,template-send}.ts`; `src/lib/approvals/resend.ts`; `src/lib/admin/service.ts`; `src/app/api/inbox/conversations/[id]/messages/route.ts`; `src/lib/spend/messaging/origin.ts` (one-line flip); `tests/spend-origin.test.ts` | WP-09, WP-10, WP-12, WP-13 | (1) A table test maps each call site to its origin. (2) After the flip, `origin` is required and `tsc` passes. (3) Bypass rule B13 passes (no worker claims `human`) |
| WP-12 | WhatsApp quality, template, account and pricing signals | `src/lib/webhooks/{processor,payload}.ts`; `src/lib/spend/messaging/quality.ts`; `src/lib/spend/tasks/quality.ts`; `src/lib/lifecycle/notices.ts`; `tests/spend-quality.test.ts`; `tests/webhooks-processor.test.ts` | WP-03, WP-09 | (1) The poll updates qualityRating and trips YELLOW and RED, clearing after 2 GREEN polls; the existing email alert fires from the fresh value. (2) FLAGGED maps to `flagged`; PAUSED and DISABLED block everyone; REINSTATED restores. (3) `template_category_update` is handled and the next estimate uses it. (4) The account events in 6.3 work. (5) Status pricing is stored. (6) `button.payload` is kept, and only the notifier tenant routes `spdec:` and `spopt:` to `notify/inbound`. (7) STOP and START confirmations are stamped origin `consent` |
| WP-13 | AI gateway and cross-process AI quota | `src/lib/spend/exec/ai.ts`; `src/lib/ai-agent/{generate,index,credits}.ts`; `src/lib/creative/{llm,providers}.ts`; `src/lib/chatbots/escalation.ts`; `src/lib/billing/limits.ts`; `src/lib/usage.ts`; `tests/spend-ai.test.ts`; `tests/billing-limits.test.ts`; `tests/ai-agent.test.ts`; one line in `tests/spend-bypass.test.ts` | WP-03, WP-05 | (1) `api.anthropic.com` appears only in the gateway (B2 tightened). (2) Two processes cannot exceed the daily or monthly credit limit. (3) `holdCredits` is removed and `admit` awaits; the hourly cap is kept. (4) A refusal gives 402 with the copy, and the AI agent hands off. (5) Tokens and model are stored on UsageLedger. (6) The usage page numbers are unchanged. (7) The AI agent's sends are stamped `ai_reply` |
| WP-14 | Autonomy, mandates, approvals, one-tap page, shadow, optimizer integration | `src/lib/spend/{mandates,approvals,approval-token,shadow}.ts`; `src/lib/spend/tasks/approvals.ts`; `src/lib/optimizer/{service,engine,config,rules}.ts`; `src/app/api/optimizer/proposals/[id]/route.ts`; `src/app/api/spend/approvals/route.ts`; `src/app/api/spend/approvals/[id]/route.ts`; `src/app/api/spend/approvals/token/route.ts`; `src/app/api/spend/mandates/route.ts`; `src/app/s/[token]/page.tsx`; `src/components/spend/ApprovalReview.tsx`; `src/lib/approvals/summary.ts` (money formatting fix); `tests/spend-approvals.test.ts`; `tests/spend-shadow.test.ts`; `tests/optimizer-service.test.ts` | WP-04, WP-06 | (1) Shadow records for the first 14 days whatever the level, and no permit is minted. (2) Level 1 auto raises are capped at 20% per account day; Level 2 actions over 25% need approval; lowering at Level 1 or 2 applies automatically. (3) Approvals re-check at apply and fail with copy on a fingerprint mismatch. (4) Expiry gives "Declined automatically" within 5 minutes. (5) Supersede on freeze. (6) Decline by token works logged out, and approve requires an approver session. (7) A raising optimizer proposal cannot be applied by a non-approver admin. (8) No proposal text contains "minor units", and approval summaries format with the currency exponent |
| WP-15 | Owner notifications (platform sender, opt-in, templates, quick-reply decline) and daily digest | `src/lib/spend/notify/{index,platform-sender,owner-channel,templates,inbound,digest}.ts`; `src/lib/spend/tasks/digest.ts`; `src/app/api/spend/notify/route.ts`; `docs/platform-notifier.md`; `tests/spend-notify.test.ts`; `tests/spend-digest.test.ts` | WP-03, WP-09, WP-12, WP-14 | (1) Opt-in stores SpendConsent and a pending channel and sends `spend_optin_v1`; "Yes" sets verifiedAt. (2) Notices try WhatsApp, then email, then in-app, and a paused template or unverified channel falls back. (3) A quick-reply Decline with a valid HMAC from the approver's verified phone declines; a wrong phone or HMAC is ignored. (4) STOP opts out. (5) The digest goes out once per local day at 09:00 or later, skips quiet workspaces, and its numbers match fixtures. (6) The TIER_250 guard drops digests before alerts above 200 a day. (7) A startup warning fires when the notifier workspace has AI, chatbots or automations on. (8) The docs list the 4 template bodies, buttons, categories and a submission checklist |
| WP-16 | Workspace spend API | `src/lib/spend/{http,summary}.ts`; `src/app/api/spend/{summary,allowances,control,freeze,ledger}/route.ts`; `tests/spend-api.test.ts` | WP-03, WP-04, WP-07, WP-14 | (1) GET summary works for every role; amounts are decimal strings plus formatted text. (2) PUT allowances follows the per-field rule (admin lower, owner raise, version 409). (3) Freeze on needs admin or above, off needs the owner. (4) The ledger is admin or above with seq cursor pagination. (5) Control (approvers, expiry, time zone, target cost per lead, breaker toggle, spending ad account, digest) is owner only. (6) Every mutation is same-origin, writes a ledger row and triggers a metacap re-plan when the ads monthly limit changes. (7) Observe mode returns a would-refuse flag |
| WP-17 | Workspace UI: Settings > Spending limits for every role, banner, ads page summary | `src/app/(app)/app/settings/spending/page.tsx`; `src/components/spend/{SpendingSettings,KillSwitch,PotCard,MetaLimitCard,AssistantsCard,ApprovalsCard,NotifyCard,ActivityTable,SpendBanner}.tsx`; `src/components/app/nav.ts`; `src/components/ads/CampaignsView.tsx`; `src/app/(app)/app/layout.tsx`; `tests/auth-nav.test.ts`; `tests/spend-ui.test.ts`; `e2e/growth-ads.spec.ts` | WP-15, WP-16 | (1) "Spending limits" appears in the nav for owner, admin and team member (28 / 16). (2) Every row of the 8.1 role table holds. (3) Copy matches this spec (snapshots); "Not set" renders and no figure is invented. (4) The banner priority order holds. (5) CapPanel keeps its labels and `cap-status`, and adds the summary and the link. (6) No horizontal overflow at Pixel 7; axe clean; dark theme |
| WP-18 | Platform admin panel: spending list, tenant card and actions, platform switch, ceilings, FX, plan ceilings, notifier settings | `src/lib/admin/spending.ts`; `src/app/api/admin/spending/route.ts`; `src/app/api/admin/spending/[tenantId]/route.ts`; `src/app/api/admin/spending/platform/route.ts`; `src/app/api/admin/spending/settings/route.ts`; `src/app/(admin)/admin/spending/page.tsx`; `src/app/(admin)/admin/spending/settings/page.tsx`; `src/app/(admin)/admin/tenants/[id]/page.tsx`; `src/lib/admin/{tenants,plans}.ts`; `src/components/admin/{AdminShell,helpers,PlanForm,SpendingTable,TenantSpendCard,PlatformSpendSwitch,CeilingsForm}.tsx`; `tests/admin-access.test.ts`; `tests/admin-spending.test.ts`; `e2e/settings-billing-admin-public.spec.ts` | WP-03, WP-04, WP-07; (critic) deploys with or after WP-11, and actions that need WP-08 or WP-14 (`clear_breaker`, `end_learning`, requests waiting) stay hidden until those WPs are live | (1) Every new handler returns 404 without step-up (admin-access total updated; e2e PAGES and GETS include them). (2) The list shows every column and filter in 8.3. (3) Each new tenant action requires a reason, writes `admin.tenant.*` audit plus a ledger row, and takes effect on the next reservation. (4) The platform switch needs "STOP SPENDING", a reason and a fresh step-up, and an assistant raise is refused within 5 s. (5) Plan ceilings are stored as SpendCeiling `plan` rows. (6) An FX rate older than 35 days shows "Out of date" and is ignored |
| WP-19 | Integration and go-live: sandbox, e2e suites, runbook, flag flips | `src/lib/spend/sandbox.ts`; `e2e/spend-kit.ts`; `e2e/spend-settings.spec.ts`; `e2e/spend-kill.spec.ts`; `e2e/spend-broadcast-gate.spec.ts`; `e2e/spend-approvals.spec.ts`; `e2e/admin-spending.spec.ts`; `docs/spend-controls-runbook.md` | WP-00 to WP-18 | (1) A sandbox campaign trips every breaker end to end with zero delivery and correct notifications. (2) All e2e specs pass on desktop and @mobile. (3) The runbook covers each flag flip with its precondition, how to stop everything, how to clear a breaker, how to run V1-V9, and the `ASSISTANT_SPEND_ENABLED` gate from 10.5. (4) The production `.env` flips are recorded in MIGRATIONS-APPLIED notes |

---

## 12. Open questions for the owner, and risks

### 12.1 Open questions (genuine; each has a default, so building can start)

1. **Notifier number.** Approvals, alerts and digests go to owners from the platform's own WhatsApp number. Options:
   - Phase 0 uses `edwyz-test` +1 711-268-5789. It is TIER_250 (at most 250 owners a day), US-priced, and may look foreign to Indian owners.
   - Register a dedicated Indian "Edwyz Alerts" number on a separate platform WABA, for INR billing, trust and a higher tier.

   Default: use the +1 number now and plan the Indian number before 200 active owners.
2. **SMTP for email fallback.** `SMTP_USER` and `SMTP_PASS` are blank in production, so the email fallback for alerts and approvals does not send today. Which provider and credentials should be used? This is a deploy blocker for train 3.
3. **New-workspace limits for WhatsApp and AI.** Should they also be capped during the new-workspace period? For example WhatsApp at ₹500 a day and ₹5,000 a month. Default: only ads is capped (₹2,000 / ₹20,000), as approved.
4. **When the new-workspace period ends.** The default is after 2 paid invoices, or when a platform admin marks the workspace verified. Is 1 paid invoice enough?
5. **Live check of Meta's limit with real money.** May we run the one-hour runbook (V1-V9) on one of your real INR ad accounts, with a ₹500 test campaign and a ₹500 limit? It spends up to ₹500 of real money. Which account? Until then wall (a) stays in observe mode and assistants stay at Level 0.
6. **(critic) Splitting under Autopilot.** R4 says "any single action over 25% of the monthly allowance needs approval". The spec also counts an assistant's auto-applied raises over a rolling 24 h toward that 25% (decision 2.3.9), so ten 10% launches cannot add a full month unasked. Default: the stricter rolling rule. Should it be the single action only?
7. **(critic) What ₹2,000 a day means on probation.** R2 counts 1.75x per day, so a ₹2,000 daily ceiling allows ₹1,142 a day of ad budgets (Meta could spend ₹2,000 of it on a busy day). Default: the ceiling caps worst-case spend, as written. Did you mean ₹2,000 of daily budgets (a ₹3,500 worst-case ceiling) instead?
8. **(critic) "Stop all spending" and AI your team asks for.** Default: stopping keeps reply suggestions, Creative Studio and Eddy for signed-in people, within the AI limit, and stops only automatic AI (decision 2.3.11). Should it stop all AI?
9. **(critic) Auto-replies when the WhatsApp limit runs out.** Default: chatbot and AI agent replies hand the chat to your team instead of waiting until the limit resets (decision 2.3.12). Should they wait instead?
10. **(critic) A hard limit at the AI provider.** For AI there is no equivalent of Meta's limit, so a bug or loop is stopped only by Edwyz's own gateway. Production wa uses the Anthropic key copied from web/.env, which the www.edwyz.com ops agents also use. Recommendation: give wa its own key and set a monthly spend limit on it in the Anthropic console, sized to the sum of plan credits plus a margin. This is the AI version of wall (a). Who sets it, and at what amount?
11. **(critic) Shared ad accounts.** When an agency workspace and its client's workspace both connect the same Meta ad account, the first to turn on Meta's limit manages it (decision 2.3.14). Should the client's workspace always win instead?
12. **(critic) Paused workspaces and Meta's limit.** While a workspace is locked or suspended, Edwyz keeps Meta's limit at last month's level and does not raise it at the new month (4.17). The customer's own Ads Manager ads may then stop early. The default is the safe direction; the owner can choose "Remove the limit". Is that acceptable?

### 12.1a Decisions taken (2026-10-28, under the owner's delegated authority: "take the best possible decision for any situation yourself")

These replace the defaults above where they differ. Builders follow this list.

1. Notifier number: use `edwyz-test` +1 711-268-5789 for Phase 0; plan an Indian "Edwyz Alerts" number before 200 active owners. (default kept)
2. SMTP: not available. The email fallback for alerts and approvals ships switched off and says so in the UI; owners get in-app plus WhatsApp. Train 3 does not wait for SMTP.
3. New-workspace limits: CAP ALL THREE POTS, not only ads (changed from the default). Reason: signup is open and production's AI key has no provider-side limit yet. Probation ceilings: ads INR 2,000/day and INR 20,000/month (worst case); WhatsApp INR 500/day and INR 5,000/month; AI as the plan's monthly AI credits, never more than INR 500/month equivalent during probation.
4. Probation ends after 2 paid invoices or when a platform admin marks the workspace verified. (default kept)
5. No real-money Meta limit test without the owner present: wall (a) stays in observe mode and every assistant stays at Level 0 until the owner runs the V1-V9 runbook. (default kept)
6. The stricter rolling 24-hour rule for Autopilot raises. (default kept)
7. INR 2,000/day caps worst-case spend (1.75x), as written. (default kept, the safe reading)
8. "Stop all spending" stops automatic AI only; people can still use reply suggestions, Creative Studio and Eddy within the AI limit. (default kept)
9. When the WhatsApp limit runs out, chatbot and AI-agent replies hand the chat to the team. (default kept)
10. Give wa its own Anthropic key with a console spend limit: recommended to the owner; until then the AI gateway's hard stop and the probation AI cap (decision 3) are the protection.
11. Shared ad accounts: the first workspace to turn on Meta's limit manages it. (default kept)
12. Paused or locked workspaces keep Meta's limit at last month's level. (default kept, the safe direction)

### 12.1b Erratum P0-1 (2026-10-28, found by the Instagram/Page ads design; binding)

Sections 4.7 and 4.8 require status PAUSED on every `act_X/adcreatives` create. Ad creatives have no delivery status on Meta (today's `buildCreative` correctly sends none), so that rule would either refuse every launch in enforce mode or make Meta reject the request. Correction: creative creates still need a create permit through the guard and are recorded in the ledger, but they are EXEMPT from the PAUSED-body rule. Safety is unchanged: a creative cannot deliver without an ad, and every campaign, ad set and ad is still created PAUSED and activated only through the guard. Tests must assert both halves (permit required, no status field sent for creatives).

### 12.1c Repairs after the foundation review (2026-10-28; binding. The SQL parts are in 0009, which is not applied yet)

- **R1. One outcome per request, in the database.** 0009 adds the partial uniques `SpendLedger_one_outcome_key` (tenantId, correlationId) WHERE phase IN (applied, failed, unconfirmed, refused) and `SpendLedger_one_reconciled_key` (tenantId, correlationId) WHERE phase = 'reconciled'. `ledger.ts` answers a P2002 with the existing row (`created: false`). Inside a caller's transaction it inserts with ON CONFLICT DO NOTHING, because a caught unique violation would already have aborted that transaction (25P02).
- **R2. The purge names one workspace.** `edwyz.purge` is set to `'<table>:<tenantId>'` and the trigger compares it with the deleted row's own tenantId, so an erasure query that lost its tenant filter fails with 42501 instead of wiping every workspace. Still open (ops, not code): `edwyz_wa_app` owns the tables and could `DISABLE TRIGGER`; a separate owner role for the ledger tables is a deploy change.
- **R3. `pending_owner` does not hold the one-manager slot.** Only `managed` does (decision 11: the first workspace to turn Meta's limit on manages it, and only the owner's consent turns it on). A `pending_owner` row never expires, so holding the slot would let a workspace that never consents keep another owner's wall (a) off.
- **R4. The 0009 backfill rescales C** to the exponent the currency has now, `floor(C x 10^(current - stored))`, exactly as `getCaps` does, before `ceil(1.75 C)`.
- **R5. Typed limits and cursors stay inside BIGINT.** Anything above 2^63-1 is a 400 with a plain sentence, never a database error.
- **R6. Minted permits keep their times as numbers.** A permit's `issuedAt`, `expiresAt` and each object's `endsAt` are read-only getters that return a new Date; `usePermit()` checks the expiry the permit was minted with, so no holder can extend one.

### 12.2 Risks

1. **Meta's docs disagree on spend_cap units** (read in minor units, write in "standard denomination"). Edwyz always writes major units: if Meta reads them as minor, the cap is 100x stricter (safe). Every write is read back. Observe mode lasts until V1 passes.
2. **Writing spend_cap may reset `amount_spent`** (a third party saw 439924 -> 0). Under A + R the cap would then be loose by A until the read-back detects `resets_on_write` and rewrites R with one P1 write. Walls (b) and (c) hold meanwhile.
3. **The 10-a-day limit may be counted differently by Meta** than the rolling-24-h ledger count. If so, writes block early, which fails safe, and the UI says the limit will update later. Breakers keep working.
4. **The floor rule** ("at least X because charges are pending") can force a cap above the target. The looseness is shown, and raises tighten at 15% left.
5. **Meta's limit stops the whole ad account,** including the customer's own Ads Manager campaigns. The consent copy says so. Only P0 sets the cap to the stop value, and only when Edwyz's own pauses failed.
6. **Prepaid accounts and accounts without permission have no wall (a).** Every assistant raise there needs approval, and the 15-min breakers run.
7. **Insights lag about 15 min and keep changing for 28 days.** Breakers act after the fact. Raise decisions never rely on observed spend alone (worst-case commitments), and wall (a) bounds the gap.
8. **Breaking change for existing workspaces.**
   - The old cap is mapped to ceil(1.75 C), so room is unchanged.
   - The new monthly check and the new-workspace limits can still refuse raises that pass today. Mitigations: `SPEND_ENFORCE=observe` for 7 days, grandfathering (the migration pauses nothing), a release note, and owner email.
   - Approving raises is restricted to the owner and named approvers, and Meta-limit consent to owners. This changes current admin workflows.
9. **The tripwire classifier could misjudge a legitimate Graph POST.** Mitigations: report mode first, a fixture for every existing call, a reasoned allowlist, and a reversible flag. Lowering is never blocked.
10. **The static scan catches accidents, not malice** (aliased fetch, built host strings). The runtime tripwire is the real backstop for Meta. AI relies on the gateway plus the scan.
11. **The append-only trigger is owned by the application role.** It stops bugs, not a database admin; the RLS plan in `docs/rls-plan.md` is separate. This is the first trigger in the database, so check that backups and restores carry it.
12. **Advisory-lock transactions hold a pooled connection for up to 8 s.** Check the pool size, and any future pgbouncer in transaction mode. The per-message and per-AI paths avoid the lock.
13. **The 5 s caches and in-memory rate limiters assume one web instance** (today's constraint). Scaling out needs the table-backed limiter and a shared cache.
14. **WhatsApp estimates are approximate.**
    - The upper-bound pricing may block broadcasts that would actually fit.
    - Whole-unit rate cards round unless scale=2 is set.
    - A missing SERVICE rate is priced at the utility rate.
    - Delivery pricing reconciles actual cost after the fact.
15. **Quality data lags.** Quality breakers depend on the 30-min poll, because the webhook no longer carries quality. Moving FLAGGED from "paused" to "at risk" lets some non-marketing sends through that were blocked before.
16. **Owner WhatsApp depends on the platform number.**
    - Utility templates can be recategorised as marketing, which costs more and brings opt-outs.
    - The opt-in confirmation template may be judged promotional. The fallback is an authentication-code template.
    - Email (needs SMTP) and in-app are the guaranteed channels.
    - Approvals nobody sees expire as declined, which is safe but frustrating.
17. **Currency.**
    - The exponent table is unverified, and a wrong exponent mis-scales caps by 10x or more. Run V1 per currency before enabling wall (a) there.
    - Non-INR workspaces need ceiling rows or a fresh FX rate, or they are refused while on new-workspace limits (fails closed).
    - The old 32-bit columns can still overflow for IDR and VND. Moving them to BIGINT is Phase 1.
18. **Token expiry** (not a user disconnect) can still strand live campaigns. Then only the previously written Meta limit and token-health alerts protect the account.
19. **Meta sandbox:** one account per app, no delivery, and uncertain Insights support. Breakers and wall (a) cannot be proven there, so SPEND_SIM and the small live INR check are required. Shadow mode delays assistant value by 14 days per workspace, by design.
20. **Concurrent development.** Other developers are editing the hot files (`ads/service.ts`, `ads/actions.ts`, `inbox/send.ts`, `inbox/service.ts`, `webhooks/processor.ts`, the admin files). Each hot file belongs to one WP. Rebase often; the bypass scan catches new bypasses added in parallel.
21. **Hand-written test inventories** must be updated in the same WP that adds items, or CI fails: auth-nav, admin-access, worker-loop mocks, the personal-data registry and the e2e admin lists.
22. **(critic) Ads Manager edits are adopted, not reversed.** On an unmanaged account, a customer can raise the budget of an Edwyz campaign in Ads Manager. Edwyz sees it only on the next structure sync: 15 min with open commitments, 2 h without. The limit breakers then pause, so the exposure is one sync interval at the new budget. Only wall (a) closes that gap.
23. **(critic) Edwyz's own outage.** With both the daemon and the web process down, no breaker runs. Protection is what was already committed: worst-case reservations, assistant end dates and Meta's limit. The health alert (4.16) is email-only, because the notifier runs in the worker.
24. **(critic) The notifier workspace concentrates data.** Every owner's phone and spending alerts sit in one workspace's inbox. Members are restricted to platform admins, and erasure reaches it (3.5, 7.4).
25. **(critic) A shared AI key.** Until wa has its own Anthropic key with a provider-side limit (open question 10), AI spend from the www.edwyz.com ops agents and from wa draws on one key, and only wa's spend is metered by the AI pot.
26. **(critic) A lifetime-only budget counts in full against today** (4.5) until V10 measures Meta's daily pacing. Large lifetime budgets will look expensive in the daily limit, which is why daily budgets plus an end date are the default.

---

## 13. Completeness review (critic)

The review checked R1-R9, every spend path in the recon, money and currency, concurrency, Meta lag and its 10 changes a day, worker downtime, time zones, refunds, Ads Manager edits, demo workspaces and workspaces without Meta, migration safety, rollout order, and trips to Meta. Every row below was fixed in this document. Owner decisions are 12.1 questions 6-12.

| # | Area | Gap found | Fixed in |
|---|---|---|---|
| 1 | Migration safety | A plain `CREATE INDEX` on `Message` inside `psql -1` would block webhooks and sends for the whole build. A validating CHECK on `Message` scans the table under an exclusive lock. There was no `lock_timeout`, no PostgreSQL version check, no rollback statement and no deploy order | 3.2, 3.2.1, 10.2, WP-00, WP-05 |
| 2 | Migration bug | The SpendDaily primary key left out `origin`, so the account `all` row and the `external` row (same scope and day) collided | 3.2, 3.3 |
| 3 | Rollout | The commitments backfill ran "before enforce", so the first train 1 request could see 0 committed and pass activations that are refused today | 3.2 note 4, 4.6 orphan rule, 11 |
| 4 | Rollout | `SPEND_ENFORCE=observe` would also relax checks enforced today: the daily cap, the AI credit limit and the currency check | I12, 4.10, 4.14 |
| 5 | Rollout and R3 | The CapPanel number silently changed meaning (budget sum to worst case) in train 1, before the new help text shipped in train 3 | 4.8 shim, 8.2 |
| 6 | Rollout | The platform kill switch and admin list waited for train 3, and freezes could go live before origin stamping (WP-11) | 11 (WP-18 to train 2, freeze-after-WP-11 rule) |
| 7 | R3 | No behaviour defined for workspaces without Meta, without WhatsApp, locked or suspended, or for the demo workspace. Locked workspaces got 402 even for lowering | 4.17, 8.1, 8.4, 9.3 |
| 8 | R3 | Admins could "set a number where Not set", which opens room (ads) and enables assistants (every pot) | 2.3.8, 8.1 |
| 9 | R3 | The admin list would compute headroom for every workspace on every load, and left out workspaces with no SpendControl row | I11, 8.3 |
| 10 | Spend paths | `revertProposal` (it replays a resume or a budget) was not routed or role-gated | 4.8 table |
| 11 | Spend paths | Eddy, the in-app AI "acting as the user", could make AI-chosen actions look human and skip mandates; the gateway had no `eddy` feature | 4.15, B14, 4.9 table |
| 12 | Ads Manager edits | Edwyz campaigns resumed, re-budgeted, given new ad sets, switched to campaign budget or stripped of an end date in Ads Manager were invisible when Meta's limit was not managed | 4.6.1, 6.1, 6.2 |
| 13 | Ads Manager edits | Meta's 4 budget changes an hour per ad set also counts Ads Manager edits, which the ledger cannot see | 4.6 step 9 |
| 14 | Concurrency | `reserveAds` step 8 could call Meta while holding the advisory lock, and there was no lock order between the account and tenant locks | I10, 4.3, 4.6 step 8, 10.2 |
| 15 | Concurrency | Two workspaces connected to the same Meta ad account would both manage its spend_cap and fight over Meta's 10 changes a day | 2.3.14, 3.2, 5.1, 10.2 |
| 16 | Concurrency | A double tap or an expired approval could still apply; a demoted approver could still approve | 7.3 |
| 17 | Worst case | dayRisk was undefined for lifetime-only commitments; budget sharing (2.1x) was not handled | 4.5, V10 |
| 18 | Money | `decimalToMinor` clamps at INT_MAX, which UNDER-counts IDR and VND spend on the new paths | 3.1 |
| 19 | Currency | No defined ads pot currency before an ad account exists, no flow when the spending account's currency changes, no rule for grandfathered commitments in another currency or for rate card currency changes | 3.1, 8.1 |
| 20 | Time zones | No rule for changing the workspace or ad account time zone mid-period; the page showed one zone when two apply; the SpendControl time zone ignored RoutingConfig | 3.1, 3.2 backfill, 8.1, 9.3 |
| 21 | Refunds and credits | Ambiguous WhatsApp sends were released (possible under-count); messages that failed after acceptance kept their estimate forever; refunds landed on today's counters; Meta credits and downward `amount_spent` were not addressed; void invoices still lifted probation, and a backfill-time `lifted` was sticky | 3.1, 3.2 backfill, 4.4, 4.9, V11 |
| 22 | Meta limit | Start values at mid-month consent and S under `resets_on_write` were undefined; "managed" was used before writes were verified (observe mode) | 5.1, 5.3 |
| 23 | Meta limit | The cap Edwyz wrote stayed on the customer's account after close, erase, suspend or a change of spending account | 3.5, 5.8, 4.17 |
| 24 | Worker downtime | The kill switch depended on the worker; approvals and permits relied on expiry tasks; there was no health alert | 4.11, 4.16, 7.3 |
| 25 | R4 notifier | The notifier workspace could be locked by its own trial, would hold every owner's data, and STOP did not cover multi-workspace owners | 7.4, 3.5 |
| 26 | R4 | Splitting a large Autopilot launch into many sub-25% actions avoided approval | 2.3.9, 7.2, 12.1 Q6 |
| 27 | R6 | Shadow mode and a missing mandate would have blocked today's human-approved optimizer proposals for 14 days | 2.3.10, 7.2, 7.5 |
| 28 | R5 | Quality UNKNOWN, failed polls and non-CONNECTED numbers were undefined; the poll would also hit demo and expired-token numbers | 6.3 |
| 29 | R5 | The `daily_limit` auto-resume could restart campaigns a person paused after the breaker | 6.2 |
| 30 | Kill switch | Turning spending back on did not say whether anything restarts; 4.10 and 4.11 disagreed on AI under freeze `all` | 2.3.11, 2.3.13, 4.10, 4.11 |
| 31 | WhatsApp | Exhausted pots would hold chatbot and AI replies for hours; scheduled broadcasts had no early warning; an exhausted bulk reservation had no fallback | 2.3.12, 4.9 |
| 32 | Ledger | Pairing rules did not cover standalone refusals, observe would-refusals or external changes, and there was no `external` actor | 3.2, 4.6, 9.1 |
| 33 | Trips to Meta | The permission-error and failed-disconnect copy sent users to Meta Ads Manager as the required step | 5.7, 5.9, 5.1 |
| 34 | Probation | `MAX_DAILY_BUDGET_MINOR` read 1x under the 1.75x maths; the ₹2,000 a day probation ceiling's effect on budgets was not stated | 4.4, 12.1 Q7 |
| 35 | Demo | The demo seed's active placeholder Meta connection and ad account would be synced, polled and alerted on; seeded rationale used "minor units" | 6.1, 8.4, WP-19 |

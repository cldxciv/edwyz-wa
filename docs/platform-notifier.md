# Platform notifier: WhatsApp alerts to workspace owners

How Edwyz tells owners and approvers about spending on WhatsApp (docs/SPEND-CONTROLS-SPEC.md 7.4, 9.3, 3.5, 4.16; WP-15). Code: `src/lib/spend/notify/` (`index.ts` the delivery order, `platform-sender.ts` the sender and its checks, `owner-channel.ts` opt-in and STOP, `templates.ts` the four templates, `inbound.ts` the replies, `digest.ts` the daily summary), the tasks in `src/lib/spend/tasks/digest.ts`, and `/api/spend/notify`.

## The sender (12.1a decision 1)

- Phase 0 sends from the Edwyz workspace `edwyz-test`, number **+1 711-268-5789**, at Meta's **TIER_250** (250 distinct people in a rolling 24 hours). Plan an Indian "Edwyz Alerts" number on its own WABA before 200 active owners (INR billing, trust, a higher tier).
- Configure it in PlatformSetting `spend:notify`:

  ```json
  {
    "tenantId": "<edwyz-test workspace id>",
    "phoneNumberId": "<PhoneNumber row id, or Meta's phone number id>",
    "language": "en",
    "templates": { "approval": "spend_approval_v1", "alert": "spend_alert_v1", "digest": "spend_daily_v1", "optin": "spend_optin_v1" },
    "senderDisplay": "+1 711-268-5789"
  }
  ```

  `templates` may be left out (the names above are the defaults). The admin panel's notifier settings (WP-18) should call `assertNotifierWorkspace(tenantId)` before saving: it refuses a workspace that is not active and `billingExempt`.
- Set `SPEND_NOTIFY_SECRET` (32 bytes or more, not shared with any other secret). It signs the quick-reply payloads (`spopt:<channelId>:<hmac16>`, `spdec:<approvalId>:<hmac16>`). Without it no opt-in can be confirmed, so no WhatsApp alert is ever sent; everything stays in the app.
- Every message goes through the normal inbox path, `sendTemplateMessage` in the notifier workspace with **origin `system_notify`**. It passes the send gate, never held by cost, and counts against the notifier workspace's own pots (the platform pays, about ₹0.115 per India utility message plus GST). The subject workspace is written into the message's first timeline entry as `source: "spend_notify:<tenantId>"`, which erasure uses.
- The owner becomes a Contact in the notifier workspace: opted in (their consent on the Spending page), tagged `owner_spend_alerts`, named "Workspace owner".

## Rules for the notifier workspace (7.4 critic, 4.16)

The hourly `spend.notify.health` task (it also runs on the worker's first pass, so it is the startup check) logs a `[spend] notifier: ...` warning for each of these, and `notifierHealth()` gives the same list to the admin panel:

1. The workspace must be **active and `billingExempt`** (admin `comp`), never on new-workspace limits. An unpaid plan would make `processSendJob` hold every owner's alerts. While it is not, the notifier sends nothing (reason `notifier_not_exempt`) and every notice stays in the app.
2. **AI agent, chatbots and automations off.** Owners' replies must never get an automatic answer.
3. **Members are platform admins only** (emails in `PLATFORM_ADMIN_EMAILS`). Its inbox holds every owner's phone number and alert text.
4. All four templates **approved** under the number's own WABA.
5. The number is not RED (LOW) quality, restricted or disabled (open `wa_quality_red`, `wa_restricted` or `waba_disabled` breakers). Otherwise alerts stay in the app.
6. More than 200 owners notified in 24 hours: the warning says digests are held back.

The same task removes channels whose person is no longer a member of their workspace, with what the notifier holds about them for that workspace.

## The four templates

All **UTILITY**, language **English (en)**, no promotional wording (so Meta keeps them as utility). Submit them exactly as written; a change is a new template (`_v2`) and a new submission.

### 1. `spend_approval_v1`

- **Body:** `{{1}} asks to {{2}} in {{3}}. It could add up to {{4}} this month. Reason: {{5}}. If nobody answers by {{6}}, it is declined.`
- **Buttons:**
  1. URL, text **Review**, dynamic: `https://wa.edwyz.com/s/{{1}}` (the one-tap link's token).
  2. Quick reply, text **Decline** (payload set per send: `spdec:<approvalId>:<hmac16>`).
- **Example values:** `Ad assistant` / `raise the daily budget of 'Diwali leads' from ₹800 to ₹1,000` / `Sharma Sweets` / `₹4,550` / `cost per lead is ₹62, well below your ₹100 target` / `29 Oct, 21:05`. URL example: any 43-character token.
- Sent for an assistant's raising request (Phase 0 `approval_waiting`, action needed) to the owner and the approvers' verified channels. The approval's token is stored only as a hash, so the notifier issues the link: it stores the hash of a fresh token on the pending request, one per request.
- **Approve is never accepted by quick reply.** Approving raises spend: the Review link opens the one-tap page, which needs a signed-in approver.

### 2. `spend_alert_v1`

- **Body:** `Spending update for {{1}}: {{2}} was paused because {{3}}. Nothing else changed. Review it in Edwyz.`
- **Button:** URL, text **Open Edwyz**, static: `https://wa.edwyz.com/app/settings/spending`.
- **Example values:** `Sharma Sweets` / `'Diwali leads'` / `it costs too much per lead`.
- Sent for action-needed notices that say something was paused (safety stops, a used-up limit). The values come from the notice's `params.paused` and `params.because`, or from its title ("'X' was paused: Y", "... was paused for ...", "Today's ads limit is used up"). Anything else stays in the app.

### 3. `spend_daily_v1`

- **Body:** `Daily update for {{1}} on {{2}}: ads spent {{3}}, {{4}} new leads, {{5}} per lead. WhatsApp messages about {{6}}. Automatic changes: {{7}}. Requests waiting for you: {{8}}. Left this month for ads: {{9}}.`
- **Button:** URL, text **Open Edwyz**, static: `https://wa.edwyz.com/app/settings/spending`.
- **Example values:** `Sharma Sweets` / `28 Oct` / `₹1,200` / `4` / `₹300` / `₹45` / `2 (1 lowering)` / `1` / `₹13,800`.
- A workspace with no ad account reads `no ads connected` in slots 3, 4, 5 and 9 (the slots are fixed). Cost per lead with no leads reads `no leads yet`.

### 4. `spend_optin_v1`

- **Body:** `You asked to get spending approvals and alerts for {{1}} on WhatsApp. Tap Yes to confirm.`
- **Buttons:** Quick reply **Yes, send me alerts** (payload `spopt:<channelId>:<hmac16>`), quick reply **No** (payload `spopt:<channelId>:<hmac16>:no`).
- **Example value:** `Sharma Sweets`.
- If Meta judges it promotional, the fallback is an authentication-code template (risk 16); keep the wording plain.

## Submission checklist

1. In WhatsApp Manager for the `edwyz-test` WABA, create the four templates above: category **Utility**, language **English**, body and buttons exactly as written, the example values above.
2. For `spend_approval_v1`, make the Review button a **dynamic URL** with base `https://wa.edwyz.com/s/` and the example token; Decline as a **quick reply**.
3. Wait for approval; then **sync templates** in the notifier workspace (Templates > Sync) so each has a row with status `approved`.
4. Set `spend:notify` (above) and `SPEND_NOTIFY_SECRET`; restart the web and worker processes.
5. Check `/admin/spending` alerts: "Templates approved: 4 of 4", no notifier warnings.
6. Make sure the notifier workspace is `comp` (billingExempt), has no AI agent, published chatbot or enabled automation, and only platform-admin members.
7. Sign up a test owner on Settings > Spending limits, tap **Yes** on WhatsApp, and confirm the page shows "Alerts go to ... on WhatsApp."
8. If Meta re-categorises a template as marketing, notices keep working in the app; resubmit with plainer wording as `_v2`.

## Opt-in, STOP and START (7.4 items 3 and 5)

- Only the owner, or an admin the owner named as an approver, can give a number (Settings > Spending limits, `POST /api/spend/notify`). The consent text is: "I agree to get spending approvals, alerts and a daily summary from Edwyz on WhatsApp at this number. I can stop any time by replying STOP." (version `owner-whatsapp-v1`).
- The opt-in writes an append-only SpendConsent row (`owner_whatsapp`, the text version and its SHA-256), a pending OwnerNotifyChannel, a `consent.owner_whatsapp` ledger row (no phone in it), and sends `spend_optin_v1`. Nothing is stored when the sender cannot send. At most 3 confirmations an hour per person and 10 per workspace.
- **Yes** from that number (the HMAC is bound to its wa_id) sets `verifiedAt` and answers in the window. **No** turns that channel off.
- **STOP** in the notifier workspace opts out every channel with that phone, in every workspace (Meta's opt-out is per person). **START**, or a fresh opt-in on the Spending page, re-enables only the channel it came from (START: the workspace the latest notifier message to that person was about).
- **Decline** (`spdec:`) from a verified, opted-in channel of the owner or an approver of that workspace declines through Phase 0's decide path (`via: whatsapp`) and answers "Declined. Nothing was changed." A wrong phone, a wrong HMAC or an admin who is not an approver is ignored.

## Delivery order (every notice)

1. WhatsApp, when the person's channel is verified, the template approved and active, the number not RED or restricted, and TIER_250 has room;
2. email: **off** (12.1a decision 2: no SMTP), reported as skipped;
3. in-app, always (one Notice per workspace and dedupe key, source `spend`, through `publishNotice`).

A notice already open under its dedupe key is a no-op on every channel. Approvals never depend on WhatsApp alone: one nobody answers expires as declined.

**Capacity (TIER_250):** above 200 owners notified in 24 hours, alerts and approvals still go and digests stay in the app; at 250 nobody new is messaged. An owner already messaged in the last 24 hours always fits.

## The daily summary (9.3)

- `spend.digest`, every 15 minutes: workspaces with the summary on, at 09:00 local time or later, once per local date (`claimOnce('spend-digest:<tenantId>:<localDate>')`), in cursor batches of 50.
- Skipped: the demo workspace; quiet workspaces (no spend, no leads, no actions and nothing waiting in 7 days).
- Ads figures use the ad account's yesterday, WhatsApp and AI the workspace's; the in-app version says so when they differ. In-app it is the "Yesterday" strip on the Spending page, with empty lines left out.

## Erasure (3.5)

Erasing a workspace (`erase-workspace.ts` calls `eraseOwnerData(tenantId)` before the channel rows go) removes each owner phone's Contact, Conversation and Messages from the notifier workspace, or, when the phone still has a channel in another workspace, only the messages about the erased workspace. The same happens when a member who had a channel leaves (the hourly prune).

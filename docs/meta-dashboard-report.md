# Meta dashboard report for Edwyz WA

Status: **APPLIED 2026-10-28 with the owner's approval** (the audit below was read-only on 2026-10-27; see "Applied" at the end). App: Edwyz API, App ID `1799953191201553`. Business portfolio `363324021484296`.

Method: Claude in Chrome, logged-in session, pages read only (page text and DOM state of toggles). No field was edited, no toggle clicked, no Save pressed, App Secret not revealed. A second pass on the WhatsApp Business Account webhook object and the use-case permissions list is still open (screenshots became unreliable after the first capture in each tab).

## Findings

| # | Page | Item | Required | Observed | Status |
|---|---|---|---|---|---|
| 1 | Facebook Login for Business > Settings | Login with the JavaScript SDK | Yes | Yes | OK |
| 2 | same | Allowed Domains for the JavaScript SDK | `https://wa.edwyz.com` | `https://wa.edwyz.com/` | OK |
| 3 | same | Client OAuth login / Web OAuth login | Yes / Yes | Yes / Yes | OK |
| 4 | same | Enforce HTTPS / Strict mode | Yes / Yes | Yes / Yes | OK |
| 5 | same | Valid OAuth Redirect URIs | `https://wa.edwyz.com/oauth/callback` and `https://wa.edwyz.com/api/meta-connect/callback` | only `/oauth/callback` | **FIX: add the second URI** |
| 6 | same | Embedded browser OAuth login | Yes | No | **FIX: turn on** |
| 7 | same | Force Web OAuth reauthentication / Login from devices | No / No | No / No | OK |
| 8 | same | Deauthorize callback URL | `https://wa.edwyz.com/api/meta/deauthorize` | empty | **FIX after the route is deployed** |
| 9 | App settings > Basic | App domains | `wa.edwyz.com` | empty | **FIX** |
| 10 | App settings > Basic | User data deletion (instructions URL or callback) | set | empty. Meta shows "Currently ineligible for submission: User data deletion" | **FIX (blocks App Review and going Live)** |
| 11 | App settings > Basic | Privacy policy URL / Terms URL / Contact email | set | `https://wa.edwyz.com/privacy`, `https://wa.edwyz.com/terms`, set | OK |
| 12 | App settings > Basic | App icon, category | set | set, Utility and productivity | OK |
| 13 | App settings > Advanced | Require app secret | Off (until the server sends appsecret_proof) | Off | OK |
| 14 | App settings > Advanced | API version | v26.0 | v26.0 all calls and app-role calls | OK |
| 15 | App settings > Advanced | Domain manager | wa.edwyz.com listed | "No domains have been set" | **FIX (same as item 9)** |
| 16 | App settings > Advanced | Server IP allowlist | empty | empty | OK |
| 17 | App publish status | Live | Unpublished (Development mode) | **BLOCKER for production: Meta only sends test webhooks while unpublished. No real customer messages reach the webhook.** Needs items 9 and 10 first, then Publish. |
| 18 | Webhooks (Catalog object shown by default) | Callback URL and fields | not verified for the WhatsApp Business Account object | open |

## Proposed changes (not applied; need explicit owner approval)

1. Valid OAuth Redirect URIs: add `https://wa.edwyz.com/api/meta-connect/callback`.
2. Embedded browser OAuth login: Yes.
3. App domains and Domain manager: add `wa.edwyz.com`.
4. User data deletion: set Data deletion instructions URL (the public deletion-instructions page) or the Data Deletion Callback URL; Deauthorize callback URL `https://wa.edwyz.com/api/meta/deauthorize`. These need the deauthorize route and a public instructions page deployed first (see docs/meta-dashboard-requirements.md code fixes).
5. Publish the app (App publish status) once 3 and 4 are done, then re-check that the WhatsApp webhook receives production events.

## Applied (2026-10-28, owner approved "Config and publish Live" and the webhook)

| Item | Result |
|---|---|
| Valid OAuth Redirect URIs | added `https://wa.edwyz.com/api/meta-connect/callback` (kept `/oauth/callback`); persisted after reload |
| Embedded browser OAuth login | turned on; other login switches unchanged |
| Deauthorize callback URL | `https://wa.edwyz.com/api/meta/deauthorize` |
| App domains | `wa.edwyz.com` |
| User data deletion | Data deletion instructions URL `https://wa.edwyz.com/data-deletion`; the "ineligible for submission" banner cleared |
| Publish | published; Meta confirmed "Your app was successfully published" |
| Webhook (whatsapp_business_account) | subscription created through the Graph API: callback `https://wa.edwyz.com/webhooks/whatsapp`, fields messages, message_template_status_update, message_template_quality_update, phone_number_quality_update, account_update, business_capability_update; read back as active |

Still open: a second Facebook Login for Business configuration for Pages, Instagram and ads (META_LOGIN_CONFIG_ID); business verification / Tech Provider status and App Review for advanced permissions; the app secret was shared in chat screenshots, so reset it in Meta and update the server .env.

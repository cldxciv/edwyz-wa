# whatsapp_business_management

Phase: A (submitted, in review)
Feature built: **BUILT**

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app read the business's WhatsApp account and phone numbers and create and manage message templates.

## Use-case description (paste into the review form)

Edwyz WA uses this permission to read the WhatsApp Business Account and phone numbers a business shares during Embedded Signup, to subscribe our webhook to the account, and to create, list, edit and delete message templates for that business. We read account and number identifiers, display names, quality rating and template status; we write templates and the webhook subscription. Identifiers are stored in the business's workspace and visible to its admins. Access tokens are encrypted at rest. Data is removed when the business disconnects or deletes the workspace.

Length: 569 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in at https://wa.edwyz.com/login as the review user.
2. Open Settings > Connect WhatsApp; show the Embedded Signup dialog permission screen, complete it.
3. Show the connected number, its status and quality shown in the page.
4. Open Templates > New (/app/templates/new), create a template, submit, then show it listed with status pending/approved.
5. Delete the template to show write access ends cleanly.
6. Click Connect WhatsApp again (reconnect) and show the connection renewed without losing the number or chats.
7. Show the data deletion page (https://wa.edwyz.com/data-deletion) and Billing > the "Delete your workspace" card (a request, not submitted). Edwyz WA has no separate button to disconnect a WhatsApp number in the app; do not claim one.

Full step-by-step script, reviewer account and test number instructions: `whatsapp-production-readiness.md`.

## What the reviewer needs (put in review notes)

- Review user (owner) and a connected test WABA.
- Permission to create a throwaway template.
- The review user stays a verified owner with an active trial or plan for the whole review (see `whatsapp-production-readiness.md`).
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Tokens, app secret, other businesses' templates.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.

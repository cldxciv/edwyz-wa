# whatsapp_business_messaging

Phase: A (draft, not submitted: draft 1799953447868194, see `status.md`)
Feature built: **BUILT**. In the draft: description, screencast and API test calls done (2026-10-30); "I agree" not yet ticked.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the business send and receive WhatsApp messages from its own number through the team inbox, broadcasts and chatbots.

## Use-case description (paste into the review form)

Edwyz WA is a team inbox for businesses on the WhatsApp Cloud API. After a business connects its own number with Embedded Signup, our app receives customer messages by webhook and sends replies, approved template messages and opted-in broadcasts from that number. We read inbound message content, sender number and delivery status; we write outbound messages. Messages are stored in the business's workspace, visible only to its logged-in team members, and deleted when the business deletes the workspace or a contact. Free-form messages are sent only inside the 24-hour window; outside it only approved templates are used. We do not sell data or use it for advertising.

Length: 670 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Open https://wa.edwyz.com/login and sign in as the review user. Show the URL bar.
2. Open Settings > Connect WhatsApp (/app/settings/connect). Click connect and show the Embedded Signup dialog with the permissions listed. Complete it with the test number.
3. Open Inbox (/app/inbox). From a phone, send a WhatsApp message to the connected number; show it arriving in the inbox.
4. Type a reply and send. Show the message arriving on the phone (record the phone screen or WhatsApp Web beside the browser).
5. Open Broadcasts (/app/broadcasts/new), pick an approved template and show that only the opted-in test contact is in the audience, send, show delivery status and the message on the phone.
6. Reply STOP from the phone and show the contact marked opted out and skipped by the next broadcast.
7. Open Contacts, open one test contact and delete it to show data removal. Show /data-deletion and explain the workspace deletion route.

Full step-by-step script, reviewer account and test number instructions: `whatsapp-production-readiness.md`.

## What the reviewer needs (put in review notes)

- Review user with owner role on a workspace (give email and password in the review notes; no 2FA on this user).
- A connected test WhatsApp number and one approved template.
- A phone able to receive messages, or WhatsApp Web, pre-logged in.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Real customer conversations or numbers in the inbox: use test contacts only.
- Access tokens, app secret, the API keys page, billing details.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.

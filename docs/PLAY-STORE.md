# Edwyz WA on Google Play

Status: planned 2026-10-29. Nothing has been uploaded to Google Play yet.

## Approach: a Trusted Web Activity (TWA)

The Android app opens wa.edwyz.com full screen in Chrome's engine, with no browser bar, our icon and splash screen, and Android notifications later. There is one codebase: every web release reaches the app at once, with no app update needed. Google's Bubblewrap tool generates the Android project and builds the signed bundle (.aab).

What the web app needs first (code, done by us):

1. A web app manifest at `/manifest.webmanifest`: name "Edwyz WA", short name, `start_url` `/app?source=twa`, `display: standalone`, theme and background colours, and icons at 192 and 512 px plus maskable versions, drawn by `scripts/make-icons.mjs` from the green chat-bubble mark in the site header (the same mark as the favicon and every page).
2. A small service worker with an offline page ("You are offline. Edwyz WA needs the internet to show your chats."), so Chrome treats the site as installable. It must never cache API responses or signed-in pages.
3. `/.well-known/assetlinks.json` (Digital Asset Links) listing the Android package `com.edwyz.wa` and the SHA-256 fingerprints of BOTH the upload key and Google Play's app signing key. Without it Android shows a browser bar. Note that Play's signing key fingerprint only exists after the first upload to Play Console.
4. Store-friendly public pages: the landing page, `/privacy`, `/terms` and `/data-deletion` exist; the listing links to them.

What the Android build needs (done by us, on a machine with JDK 17 and the Android SDK; Bubblewrap can install both):

- `twa-manifest.json` with package `com.edwyz.wa`, host `wa.edwyz.com`, the colours and icons above, and `enableNotifications` off for v1.
- An upload keystore, generated once, kept outside the repository and backed up. Losing it means asking Google to reset the upload key. Its password is never written to a file in the repo.
- `bubblewrap build`, which produces `app-release-bundle.aab`.

## What only the owner can do

1. **Google Play Console developer account.** Create it at play.google.com/console (25 USD one-time fee and identity verification). An **organization** account (Edwyz, with a D-U-N-S number) is strongly recommended. Google requires new **personal** accounts to run a closed test with at least 12 testers for 14 days before they can publish to production. Organization accounts skip that.
2. **Create the app** in Play Console ("Edwyz WA", app, free) and upload the first .aab to an internal testing track. Then send us the **app signing key SHA-256 fingerprint** (Play Console > Test and release > Setup > App signing) so it can go into assetlinks.json.
3. **Store listing:** check and approve the texts below and the screenshots we prepare. Category: Business.
4. **Data safety form and content rating questionnaire.** We draft the answers below; the owner submits them.
5. **Release** to internal testing, then to production after review.

## Draft store listing

- Title: Edwyz WA: WhatsApp Business
- Short description (80 chars): Team inbox, broadcasts, chatbots and ads for your WhatsApp Business number.
- Full description: Edwyz WA brings your WhatsApp Business number, your team and your marketing into one app. Reply to customers together in a shared inbox, send approved broadcasts to the people who opted in, build chatbots and automatic replies, capture leads from Facebook and Instagram ads and follow them up on WhatsApp, and keep every rupee of ad and messaging spend under limits you set. Eddy, the built-in helper, answers in English, Hindi or Hinglish and does tasks for you after you confirm. You need a WhatsApp Business account; connect it in a few taps inside the app.

## Draft data safety answers (to be confirmed before submission)

- Data collected: name, email address and phone number (account); customer contacts and message content the business stores (app functionality); app activity and diagnostics (crash logs). None is sold. No advertising ID.
- Shared with: Meta (WhatsApp Cloud API and Marketing API, to deliver what the business asks for), Anthropic (AI features, only when the owner turns them on), Razorpay (payments, when billing is on).
- Encrypted in transit: yes. Deletion: yes, from Settings and through https://wa.edwyz.com/data-deletion.

## Order

1. Web: manifest, icons, service worker, offline page, assetlinks route (placeholder fingerprints are refused, so the file is served only once real fingerprints are configured through `ANDROID_ASSETLINKS_SHA256`).
2. Android: generate the project, create the upload key, build the .aab, verify it on an emulator.
3. Owner: Play Console steps above; we update assetlinks with Play's signing fingerprint and rebuild if needed.

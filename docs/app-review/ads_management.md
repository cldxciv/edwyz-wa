# ads_management

Phase: A (draft, not submitted; request 1799953447868194)
Feature built: **Built**: Boost a post at /app/ads/boost, New ad by goal at /app/ads/create (WhatsApp chats, lead forms, website visits, Instagram Direct, Messenger), audiences at /app/ads/audiences, the campaign page with its edits at /app/ads/[id], and the Campaign Launcher at /app/ads/new (`src/lib/promote`, `src/lib/ads`). Every object is created paused and turned on only through the owner's spending limits (`src/lib/spend`). Not yet exercised against live Meta with the review user.

> Built; needs the sandbox runbook (`docs/promote-verification-runbook.md`, V-P0 to V-P7), a live test and the screencasts below. Before submitting: run the flows with the review user on the test assets, record the screencasts, make the API test calls in the App Dashboard, and re-check the text against the final UI. The request is a draft (1799953447868194, not submitted); state in `status.md`.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets a small business promote its posts and make new ads on Instagram and Facebook from Edwyz, in the ad account it connects, without ever spending more than the limits it set.

## Use-case description (paste into the review form)

Edwyz lets a small business advertise on Instagram and Facebook from one screen. With ads_management we create campaigns, ad sets, ad creatives and ads in the ad account the business connects: boosting its own Instagram reel or Facebook post, Click-to-WhatsApp ads, lead form ads and website ads. Every object is created paused. It starts only when the owner taps Start on a card showing the most it can spend, after Edwyz checks the business's own daily and monthly ad limits. We also upload the ad's pictures and videos, build ad previews, and make audiences: customer lists from contacts who agreed to marketing (hashed before upload) and lookalikes. Object ids and settings stay in the workspace until the business disconnects or deletes it, visible to its owners and admins. Not shared or sold.

Length: 799 characters (limit 1000).

## Screencast scripts

Three short videos (spec 8.2). Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step. Each starts with the shared opening in `00-overview.md` (login, Connect with Facebook in the popup, the permission list) and ends with Disconnect and the data deletion page.

### Video 1: boost an Instagram reel

1. Ads > **Boost a post**. The Reels tab lists the account's reels, newest first; posts that can't be boosted say why. Pick the newest reel.
2. **What should people do?** Choose **WhatsApp chats**. The card shows the WhatsApp number the chats go to.
3. **Who and how much:** keep "Let Meta find people (recommended)", 5 days, ₹300 a day. The line under the budget says what is left of today's and this month's limits.
4. **Review:** the card shows the reel, the goal, India 18+, "Instagram and Facebook (automatic)", 5 days, "At most ₹2,625", and the split by month when the run crosses one. Pause two seconds on it.
5. Tap **Start boost · up to ₹2,625**. The card says "Sent to Meta. Meta is reviewing it."
6. In a second tab, Meta Ads Manager shows the campaign, ad set and ad Edwyz made, with the same name and budget.
7. Back in Edwyz, open the campaign and tap **Pause**. Show it paused in Ads Manager.

### Video 2: a Click-to-WhatsApp ad

1. Ads > **New ad** > **WhatsApp chats**. Readiness shows WhatsApp connected and linked to the Page (green ticks).
2. **Your ad:** upload a picture from the computer; it goes to the ad account (the chip says the sizes it fits). Type the text; set the first WhatsApp message and two quick questions.
3. **Who and how much:** People near my shop, 7 days, ₹200 a day.
4. **Review:** the card shows the text, the button, the first message and the quick questions exactly as Meta will show them, and "At most ₹..." for the run. Tap **Start ads**.
5. On the phone logged in to the test WhatsApp account's tester: tap the ad preview link from Ads Manager's preview, send a message; it arrives in Edwyz's inbox and the Leads hub lists a chat lead from the ad.
6. Pause the campaign in Edwyz.

### Video 3: a customer-list audience with the consent screen

1. Ads > **Audiences** > **Make an audience** > **Past customers**.
2. Tap **Check how many can be included**: "120 of 125 contacts can be included." The line under it says only contacts who agreed to marketing messages and haven't opted out are included.
3. Tap **Make audience**. The card asks "Share contacts with Meta?" and says the phone numbers and emails are scrambled (hashed) before they leave Edwyz. Pause two seconds, then **Share 120 contacts**.
4. The list shows the audience as "Getting ready", then "Ready". In Ads Manager > Audiences it appears with the same name.
5. Make a lookalike: **People like your customers**, pick the list, 1%.
6. Delete both audiences in Edwyz; they are deleted in Ads Manager too.

## What the reviewer needs (put in review notes)

- The review user's login; a test ad account with a payment method and the owner's daily and monthly ads limits set low; a test Page with a linked Instagram professional account and at least one reel; a WhatsApp test number linked to the Page; at least 100 test contacts with a recorded marketing opt-in.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Any real customer's account, contacts, payment details, or spend above the test limits.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.

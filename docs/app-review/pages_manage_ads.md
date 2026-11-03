# pages_manage_ads

Phase: A (draft, not submitted; request 1799953447868194)
Feature built: **Built**: ads that run as the Page from Boost a post (/app/ads/boost) and New ad (/app/ads/create), including Click-to-WhatsApp and Click-to-Message; instant forms made in Edwyz and their test leads (/app/ads/create with the lead form goal, and Leads > Forms at /app/leads/forms); the Page-backed Instagram identity for owners with no Instagram account (`src/lib/promote/lead-forms.ts`, `src/lib/promote/test-leads.ts`). Not yet exercised against live Meta with the review user.

> Built; needs the sandbox runbook (`docs/promote-verification-runbook.md`, V-P7), a live test and the screencast below. Before submitting: run the flow with the review user on the test assets, record the screencast, make the API test calls in the App Dashboard, and re-check the text against the final UI. The request is a draft (1799953447868194, not submitted); state in `status.md`.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app run ads as the business's Page, and make the Page's instant forms for lead ads, so the owner never has to build a form in Meta.

## Use-case description (paste into the review form)

Edwyz creates ads that run as the business's connected Page, including Click-to-WhatsApp and Click-to-Message ads, and makes instant forms for lead ads on that Page from a short builder: the business picks questions, gives its own privacy-policy link, and may add an optional, unticked WhatsApp consent box. We write ads and lead forms linked to the Page, read the Page's form list, and send a test lead to a form so the owner can check the whole path; test leads are tagged Test and get no messages. For a business without an Instagram account we create the Page's ads-only Instagram identity. Forms and ads live on the business's Meta account; we keep their ids until the business disconnects or deletes the workspace. Ads start paused. Visible to workspace admins. Not shared or sold.

Length: 787 characters (limit 1000).

## Screencast script

One short video (spec 8.2: create a form in Edwyz, launch a lead ad, send a test lead). Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step. Start with the shared opening in `00-overview.md`.

1. Ads > **New ad** > **Get leads**. Readiness shows the Page's Lead Ads terms accepted (if not, the row offers "Opens Meta" to accept them once).
2. **Instant form:** choose **Make one in 1 minute**, pick the **Salon** preset (Full name, Phone number, "Which service?"), paste the business's privacy-policy link, and keep the WhatsApp consent box, which people can leave unticked. The preview beside it shows the form as people will see it on Instagram.
3. **Your ad:** upload a picture and type the text. **Who and how much:** Instagram only, 5 days, ₹300 a day.
4. **Review:** the card shows the form's questions, where leads go, and "At most ₹2,625". Tap **Create form and start ads**. The card says the form was created and the ads were sent to Meta.
5. In Meta: the Page's Forms Library shows the new form; Ads Manager shows the ad using it, created by the app.
6. Leads > **Forms**: the form is listed as made in Edwyz. Tap **Send a test lead**; the confirm says "It shows in Leads as Test. No WhatsApp message is sent." Confirm; the form shows "Test sent".
7. Continue in `leads_retrieval.md` (the test lead arriving), or pause the campaign and disconnect.

## What the reviewer needs (put in review notes)

- A test Page (Lead Ads terms accepted), a test ad account with a payment method and low ads limits in Edwyz, a privacy-policy URL for the form.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Real leads, real ad spend over the test limits, real customers' Pages.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.

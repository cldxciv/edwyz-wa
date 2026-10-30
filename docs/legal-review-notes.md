# Legal pages: owner review notes

This is not legal advice. The pages were written from what the code does and from Meta's published requirements. Have a qualified Indian lawyer (with GDPR awareness) review them before App Review is submitted.

## URLs to enter in the Meta app settings (App settings > Basic)

- Privacy Policy URL: `https://wa.edwyz.com/privacy`
- Terms of Service URL: `https://wa.edwyz.com/terms`
- User Data Deletion callback URL: `https://wa.edwyz.com/api/meta/data-deletion`
- Deletion instructions URL (optional alternative): `https://wa.edwyz.com/data-deletion`
- Status page (returned by the callback): `https://wa.edwyz.com/data-deletion/status?code=<code>`
- App Domains: `wa.edwyz.com`

## Values to set in `src/lib/legal.ts`

- `jurisdictionCity` / `jurisdictionState`: set to Shimla, Himachal Pradesh (from the registered address). Confirm the courts clause.
- `hostingLocation`: empty. Fill in the country/region of the VPS once confirmed; the policy then names it.
- `requestResponseDays` (30): the response time promised for rights, grievance and deletion requests. Confirm you can meet it.
- `liabilityCapMonths` (12): liability cap look-back. Lawyer to confirm.
- `version`, `lastUpdated`: bump on every change. `effectiveDate` comes from `COMPANY.effectiveDate`.

## Statements that need a lawyer's confirmation

1. Controller/processor split and the DPDP terms "data fiduciary" and "data processor".
2. Legal bases wording for DPDP (consent / "legitimate uses") and GDPR (contract, legitimate interests).
3. Grievance contact: only `hello@edwyz.com` is named, no officer. DPDP rules and the IT Rules may require a named grievance officer (and, if you become a Significant Data Fiduciary, a DPO). Add a name and a dedicated mailbox if required.
4. Rights text, including the right to nominate and the Data Protection Board of India complaint route. Check against the DPDP Rules in force at publication.
5. International transfers: no country list given; confirm no restrictions apply.
6. Retention: all periods are defined in `src/lib/lifecycle/personal-data.ts` (fixed: 30/7/90 days for webhook events, jobs, automation runs; 30 days sessions; 7 days email tokens) and enforced by `src/lib/lifecycle/retention.ts`. Added in version 1.1 (configurable in PlatformSetting `retention:config`, within safe limits): ad performance data and finished optimizer proposals 400 days; conversion events 90 days; approval requests 90 days after decision; finished chatbot sessions 90 days; AI usage records 400 days; leads 24 months after last activity (customer can delete earlier); abandoned carts 90 days; outbound webhook delivery records 30 days; orphan creative files 24 hours. The privacy page prints these from the same constants. Lawyer to confirm the periods, especially leads (24 months) and the audit log (kept while the workspace exists, no age-based deletion). Invoices and payment events have no deletion job; the policy says billing records are kept as tax law requires (confirm the period, e.g. under GST and Companies Act rules).
7. Deletion: workspace erasure is now implemented (`eraseWorkspaceData`) and is run by a platform admin from the console on request; ops must still do it within the stated 30 days. The Meta data-deletion callback now erases automatically, but only the data that came from that Facebook user's Meta connection (decision: the connection, its assets, leads from its Pages with their forms, sequence runs and conversion events, contacts created only by those leads, campaigns, ad sets, ads, insights, optimizer proposals, post targets). WhatsApp contacts, conversations, messages, billing and team members belong to the business and are not erased by a Facebook user's removal of the app. Lawyer to confirm this split is acceptable under Meta Platform Terms and the DPDP Act. A user id that matches no connection is marked completed with zero connections. Workspace erasure keeps invoices and payment events (tax law) and leaves a tombstone (hash of workspace id plus date).
8. Terms: liability cap, indemnity, disclaimers, exclusive jurisdiction, refund language ("at our discretion"), price changes with notice, suspension rights.
9. Billing statements reflect `src/lib/billing` and `docs/razorpay-notes.md`: trial then read-only; failed payment then grace period then read-only; cancel at period end; no reactivation; prices GST-inclusive; proforma invoices until a seller GSTIN is set. The trial and grace lengths are platform settings (defaults 7 and 3 days) and are not quoted in the pages. Set the seller GSTIN before charging.
10. Meta billing: the terms say customers pay Meta for conversations under their own payment method in WhatsApp Manager (per the Tech Provider docs). Confirm this stays true for your setup, including the India INR billing change planned for the end of 2026.
11. Cookies: the policy says only the `wa_access` and `wa_refresh` session cookies are used and no analytics. Re-check if analytics or chat widgets are ever added.
12. Subprocessors: hosting and email delivery by category, plus Razorpay, Meta, Shopify (connected stores only) and Anthropic, PBC (AI features, named in version 1.1; "including Eddy" since 1.2). Decide whether to publish all named vendors and sign DPAs. **OPEN, blocks wide Eddy rollout:** there is no DPA with Anthropic on file. Until legal confirms them against that agreement, three statements stay OFF the public page (version 1.2 removed the first from the AI section, where 1.1 had printed it):
    - that Anthropic does not use the data we send to train its models;
    - how long Anthropic keeps API inputs and outputs, and whether zero data retention applies to our account (the page says only that Anthropic keeps the data under its own terms);
    - the legal basis for the transfer outside India under the DPDP Act (the page says the data is processed outside India, not on which basis).
    Once confirmed, add them to the "Eddy, the in-app assistant" paragraph and the AI section, bump `LEGAL.version` (owners then re-confirm Eddy, which is bound to the version) and close this item.
13. Children: the policy says the service is not for under-18s.

## Items outside this agent's files (for the coordinator)

- Signup page (`src/app/(auth)/signup`) has no links to the Terms or Privacy Policy. Add "By creating an account you agree to the Terms and Privacy Policy" with links to `/terms` and `/privacy`.
- The footer (`src/components/shell.tsx`) already links Privacy, Terms and Data deletion.
- `/data-deletion/status` still uses the old simple layout and is `noindex` on purpose.
- The sitemap already lists the three pages.

## Added in version 1.1 (27 October 2026)

New privacy sections: "Facebook, Instagram, ad account and lead-ad data", "AI features and Anthropic", "Shopify data". New terms section: "Facebook, Instagram, ads and AI features". Existing sections were kept; wording that became untrue was amended (data we process, the closing sentence on Meta data, retention, data deletion). Points for the lawyer:

14. Lead ads: the customer is the controller for lead answers and responsible for the consent text on its forms; we are the processor. The policy says marketing follow-ups need opt-in recorded from the form consent (product behaviour). Confirm wording, and whether a processor agreement for customers should be offered.
15. Hashed identifiers sent to Meta's Conversions API (SHA-256 email and phone) are described as one-way hashes; hashing is pseudonymisation, not anonymisation. Confirm the wording.
16. AI agent replies to end customers on WhatsApp: the terms tell the business to disclose AI replies and review AI output. Confirm that is enough, and whether a disclosure line should be built into the product. **OPEN (Eddy):** replies sent through Eddy are the exact text a person approved on a preview card and are sent as that person (counted as human replies, Eddy decision 8), so no end-customer disclosure is proposed for them. Legal to confirm, or say what disclosure is needed.
17. The Disconnecting paragraph promises that removing the app in Facebook erases the connection and data derived only from it. That is implemented (`src/lib/lifecycle/erase-meta.ts`) and tested.
18. The policy says ads are created paused and need an explicit confirmation within a budget cap; this is a product rule from `docs/phase3-contracts.md`. Re-check it against the shipped launcher before submission.
19. Child and sensitive data: lead forms could collect sensitive answers; the terms put responsibility on the customer. Consider a prohibition list for sensitive categories in lead forms.

## Added in version 1.2 (29 October 2026)

Eddy (docs/EDDY-SPEC.md 7.9, 12.1a decision 7) and owner spending alerts (docs/SPEND-CONTROLS-SPEC.md 3.5, 7.4). Per decision 7 the drafted copy ships behind the owner's one-tap consent (Eddy is off until the owner turns it on, and that tap records `consentVersion = LEGAL.version`); the lawyer review stays on the owner's list before wide rollout. Only confirmed statements are published; items 12 and 16 list what is still open.

- Privacy, "AI features and Anthropic": new paragraph "Eddy, the in-app assistant" (what is sent, 90-day history from `eddyHistoryDays`, delete-my-history, contact erasure reaching Eddy, the 90-day action record kept after a history delete from `actionRecordDays`, same permissions and confirmation before messaging, spending or deleting, admins cannot read teammates' Eddy chats). Inbox reply suggestions and the chatbot escalation check are now listed as features that send text to Anthropic (both already did). "We do not log the content of prompts or answers" became "We do not write the content of prompts or answers to our application logs. Eddy conversations are stored as described below."
- Privacy, "Data we process": Eddy conversations, and owner WhatsApp alert numbers (the number, the consent record and the alerts Edwyz's own WhatsApp number sends) as personal data. Retention lines for both.
- Privacy, subprocessors: "Anthropic, PBC: AI processing, for workspaces that turn on AI features, including Eddy".
- Terms, "Facebook, Instagram, ads and AI features": the Eddy bullet ("Eddy acts on your instructions and your confirmations...").
- Points for the lawyer:
  20. Owner alert numbers: the consent text on the Spending page is "I agree to get spending approvals, alerts and a daily summary from Edwyz on WhatsApp at this number. I can stop any time by replying STOP." Its version and SHA-256 are stored append-only (SpendConsent `owner_whatsapp`). The messages go from the platform's own number (`edwyz-test`, +1 711-268-5789, a US number) and that workspace's inbox holds every owner's alert number; its members are platform admins only. Confirm the wording and that a US sender is acceptable until an Indian "Edwyz Alerts" number exists.
  21. The contact export now says how many Eddy assistant records mention the contact and that they are deleted after 90 days. Confirm that a count, not the records themselves, satisfies an access request (they are the workspace member's working notes, not the contact's own data).

## Operations

- Super-admin erase: Admin console > Workspaces > workspace > "Erase workspace data (permanent)": type the workspace slug, give a reason, choose whether the Razorpay subscription is confirmed cancelled. Needs allowlisted platform admin with TOTP step-up. The audit log records start and finish with a short hash reference, not the workspace id.
- Retention overrides: PlatformSetting key `retention:config`, JSON such as `{"leadMonths": 24, "conversionEventDays": 90}`. Values outside the safe limits (`RETENTION_LIMITS`) are ignored. If you change a default in code, the privacy page follows automatically; if you override in the database, update the policy text too.

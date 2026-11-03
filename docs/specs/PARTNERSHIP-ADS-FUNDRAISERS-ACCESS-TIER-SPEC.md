# Partnership ads, Facebook fundraisers and the Marketing API access tier: specification

- **Status:** specification only, written 2026-10-31 and corrected by the critic the same day (marked "(critic)"). Nothing here is built. Package prefix **PFA**. Migration **`0020_partnerships_fundraisers`** (4.0).
- **Reads with:** `docs/IG-PAGE-ADS-SPEC.md` (the ads launcher, module `src/lib/promote`, packages PRM-xx), `docs/SPEND-CONTROLS-SPEC.md` (Phase 0, money) and `docs/EDDY-SPEC.md` (actions and cards). Phase 0 wins on money, Eddy on the action layer, the IG/Page ads spec on the launcher. What this spec asks of each is in 5.4, 5.5 and 5.6.
- **Graph API version:** `v26.0` (`GRAPH_API_VERSION` in `src/lib/config.ts`). Every Graph call goes through `src/lib/graph/index.ts`, so the Phase 0 tripwire runs first.
- **New server modules:** `src/lib/partnerships`, `src/lib/fundraisers`, `src/lib/meta-usage`. Components: `src/components/partnerships`, `src/components/fundraisers`, `src/components/admin`.
- **VERIFY** marks a fact taken from Meta's public docs that has not been proven on v26.0 with this app. Each has a check in 3.11 and a runbook step (PFA-13). A feature whose VERIFY rows have not passed stays behind its flag.
- **(critic) Re-checked on 2026-10-31** against `developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/partnership-ads/{content-discovery-api,account-level-permissioning,fb-account-level-permissioning,ad-codes,ads-creation/boost-existing-post,ads-creation/boost-existing-fb-post,ads-creation/use-new-creative,ads-creation/supported-configurations}`, `.../get-started/authorization`, `.../overview/rate-limiting`, `docs/instagram-platform/instagram-graph-api/reference/ig-user/media`, `docs/fundraiser-api/{integrate,faq}`, `docs/permissions` and the developers blog post of 22 April 2026 (partnership label on the Content Publishing API). Corrections are inline.
- **Sources read on 2026-10-31** (developers.facebook.com unless stated): Partnership Ads API overview, Partnership Ads Creation, Boost Existing Instagram Media, Use New Creative, Boost Existing Facebook Post, New Facebook Creative, Click-to-Message Destinations, Partnership Ad Codes, Content Discovery API, Account-Level Permissioning (Instagram and Facebook), Post-Level Permissioning, Instagram Content Publishing (Partnership Ads Label), IG User Business Discovery reference, Permissions Reference, Fundraiser API (Learn, Plan, Integrate, FAQ, Reporting), "Share or create fundraisers" use case, Marketing API Authorization, Marketing API Rate Limiting, developers.meta.com blog "Update to Ads Management Standard Access" (4 May 2026), facebook.com/help/1313232172957105 (fundraising tools; served "not relevant for your location" from India).

---

## 1. Summary and the App Review permissions it backs

### 1.1 What this builds

Three features, each simple enough for a shop owner on a phone.

1. **Work with creators (partnership ads).** A business ("brand") finds the posts creators made about it, asks a creator for permission once, pastes a creator's ad code, and runs any of those posts, or a new ad carrying both names, as an ad through the existing ads launcher. Money only ever moves through the launcher's Start, so Phase 0 limits apply unchanged. A workspace that is itself a creator can label posts "Paid partnership" with up to two brands when it publishes from the content calendar, accept brand invites, and pass an ad code to a brand on WhatsApp.
2. **Fundraisers.** A member who connected Facebook creates a Facebook fundraiser for a charity, sees money raised, donations and days left, shares it with customers through a WhatsApp broadcast and a Page post, edits it and ends it. Donations go from donors to the charity through Meta. Edwyz never touches the money and stores no donor data.
3. **Marketing API access tier.** A card in the platform admin console counts Marketing API calls and errors from our own transport log, shows the tier Meta reports in its response headers, says when the app qualifies for Full access, and warns before the error rate gets near Meta's bar.

### 1.2 App Review permissions backed (one line each: permission -> feature and screen)

- `instagram_branded_content_ads_brand` -> Ads > Work with creators (`/app/ads/partners`): "Posts about you" (Content Discovery, Instagram), "Creators" (ask, list and stop account-level permission), "Use an ad code", and Start of an Instagram partnership ad in the launcher (`/app/ads/boost?draftId=`).
- `facebook_branded_content_ads_brand` -> the same screens for Facebook creators: "Posts about you" with Facebook posts, the "Facebook" creators tab (send, cancel, accept or refuse partnership requests, behind `PARTNERSHIPS_FB_PERMISSIONS`), and Start of a Facebook partnership ad.
- `manage_fundraisers` -> Content > Fundraisers (`/app/content/fundraisers`): create (`/new`), list, progress, edit and end a Facebook fundraiser for a charity.
- Marketing API Access Tier (feature; named "Ads Management Standard Access" before 4 May 2026) -> every ads screen at production rate limits; monitored at Admin > Meta API (`/admin/meta-api`).

Which two branded-content items the draft holds is VERIFY V-PF1. The Permissions Reference lists four: `instagram_branded_content_ads_brand`, `facebook_branded_content_ads_brand`, `instagram_branded_content_brand` and `instagram_branded_content_creator`. "On Instagram and Facebook" points to the two `*_ads_brand` permissions. If the draft instead holds the other two, PFA-14 (9.5) builds and documents them and moves into the first submission.

(critic) What Meta's Permissions Reference asks of each item, checked 2026-10-31:

- `instagram_branded_content_ads_brand`: depends on `instagram_basic`, `pages_read_engagement`, `pages_show_list`. The screencast must show the login flow and a user promoting a branded content post as an ad, and the submission must give examples of managing branded content ad campaigns for other businesses (Edwyz's customers are those businesses; 9.1 description says so).
- `facebook_branded_content_ads_brand`: depends on `pages_read_engagement`, `pages_show_list`. The screencast must show the Facebook Login for Business flow and a user promoting a branded content post as an ad.
- `manage_fundraisers`: "create, update, and read a fundraiser and its donations on behalf of a user"; allowed usage "help fundraiser creators to expand their reach on Facebook". No dependencies listed.
- All dependencies are already in `META_CONNECT_SCOPES` and the draft.

Already in the draft and reused here (no new feature needed for them): `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`, `instagram_basic`, `whatsapp_business_messaging`, `whatsapp_business_management`. Used but not in the draft yet (owner adds them; status.md): `pages_manage_posts`, `instagram_content_publish`.

Not requested in the first submission (PFA-14, a second submission): `instagram_branded_content_creator` (ad codes and "allow brand to boost" through the API), `instagram_branded_content_brand` (approved-creators list). `instagram_manage_insights` (needed by Business Discovery for brand lookup by username) is not requested and no code may name it (`tests/usage-scopes-alignment.test.ts`).

### 1.3 Facts from Meta's docs that shape the design

1. **Content discovery moved.** Brands now read partnership content with `GET /{business-id}/partnership-ads-advertisable-content` (Content Discovery API: Instagram media and Facebook posts in one paged response). The old `GET /{ig-user-id}/branded_content_advertisable_medias` and `GET /{fb-page-id}/advertisable-posts` are removed on **1 December 2026** ((critic) the date is stated on the "Facebook Partnership Ads" page; the Content Discovery page itself only says "replaces"). Nothing here calls them.
2. **Content Discovery needs** `business_management` plus `instagram_branded_content_ads_brand` and/or `facebook_branded_content_ads_brand` (each unlocks its platform; asking for a platform without its scope returns 403), and Instagram also needs `instagram_basic`. The caller needs some role on the business and basic admin on the Page or Instagram account, which must belong to that business. Direct lookups (`content_ids`, `permalinks`, `ad_codes`, 50 at most, one kind per request) cannot be combined with filters, sort or cursors, and do not paginate. `limit` is 1 to 50 (default 25); `after` is forward-only (a `before` cursor returns 400); only `content_id` comes back unless `fields` names more. If both `fb_page_id` and `ig_user_id` are sent, the two accounts must be linked. (critic) Other filters Meta documents and v1 does not use: `ad_usages`, `ad_partner_page_ids`, `country_codes`, `search_key`, `is_recommended`. `partnership_info` also carries `ad_code`. The response has no media URL, so creator thumbnails are not available.
3. **Instagram account-level permission:** `/{business-account-id}/branded_content_ad_permissions` ((critic) Meta's samples name it `<BUSINESS_ACCOUNT_ID>` and scope `instagram_branded_content_ads_brand` "on BRAND_IG_ID", so it is the brand's Instagram professional account id; V-PF2 now only checks the token type and error codes). Needs `instagram_branded_content_ads_brand`, `instagram_basic` and `business_management`. POST by `creator_instagram_username` (or `creator_instagram_account`), GET to list (`creator_username`, `permission_status` APPROVED, PENDING, REVOKED), POST with `revoke=true` to stop. The creator approves inside the Instagram app. The connecting person needs the ADS, CREATOR_MANAGEMENT or CREATOR_CONTENT role on the Instagram account.
4. **Facebook account-level permission** is a separate REST API, not Graph: `https://api.facebook.com/partnership-ads/fb-account-level-permissions/{PAGE_ID}` with `Authorization: Bearer` and `X-API-Version: 1.0.0`, statuses 1 pending, 2 or 7 approved, 3 rejected, 4 revoked, 5 self-removed, 6 canceled, and actions `send-request`, `cancel-request`, `remove-permission` (sent) and `accept-request`, `reject-request`, `remove-permission` (received). GET takes `permission_direction` (`sent` or `received`), `status` (an integer array), `partner_page_ids`, `offset` (from 0) and `limit` (at most 1,000). Each POST item answers `status: "success" | "failure"`, and a failure carries `error_code` and `error_message` (example: 404 "No active permission found for this partner."). The page needs `facebook_branded_content_ads_brand` but does not say whether the Bearer token is a user or a Page token, and one sample uses `revoke-permission`, which is not in the action list (VERIFY V-PF9).
5. **Ad codes.** A creator makes a code for one post (Instagram app, or `POST /{ig-media-id}/partnership_ad_code` with `instagram_branded_content_creator`). The brand uses it in the creative as `branded_content.instagram_boost_post_access_token` (Instagram) or `branded_content.facebook_boost_post_access_token` (Facebook). A code lets the holder boost the post, so Edwyz treats it as a secret.
6. **Without permission** a partnership ad "publishes in a pending delivery state", the creator gets a request, and the ad delivers once approved.
7. **Creator tagging at publish time:** `POST /{ig-user-id}/media` accepts `branded_content_sponsor_ids` (brand Instagram user ids, at most 2; it sets `is_paid_partnership` to true by itself) and `is_paid_partnership` (true alone gives a label without a brand). Facebook Login only; the token needs `instagram_basic` or `instagram_branded_content_creator`; brands must be professional accounts. Not supported on remixed media or close-friends-only posts. (critic) Meta's 22 April 2026 blog says both options "support all media types, including photos, Reels, carousels, and Stories"; V-PF10 now only proves it on v26.0 with a Page token. Looking a brand up by username needs Business Discovery, which needs `instagram_manage_insights`. Edwyz therefore gets brand ids from partner rows and invite links instead.
8. **Fundraisers.** `POST /me/fundraisers` with a real Facebook user's token holding `manage_fundraisers`, `fundraiser_type: person_for_charity`, the charity's `page_id` (or legacy `charity_id`), `name` (70 characters at most), `description` (50,000 at most), `goal_amount` (smallest currency unit, whole major units only), `currency` (ISO 4217), `end_time` (unix seconds, at most 5 years ahead; Facebook ends it at 11:59 pm in the creator's time zone) and `external_id`; optional `cover_photo` (multipart, JPEG or PNG) and `external_fundraiser_uri`. `GET /me/fundraisers` lists the app's fundraisers for that user. `POST /{fundraiser-id}` (user or app token) can change `name`, `description`, `goal_amount`, `end_time`, `external_id` and the `external_*` fields; Edwyz never sends `end_time` there (2.13). `POST /{fundraiser-id}/end_fundraiser` stops donations. Test users and test donations are not supported (minimum real donation USD 5; refunds by Meta's form, and a refund is not reflected on the fundraiser). (critic) Corrected: a fundraiser made while the app is in Development mode is "visible only to developers of your app" (FAQ); one made while Live stays public even if the app goes back to Development. Donation webhooks reach Live apps only. Deletion is permanent, there is no API to delete and no webhook for it: Edwyz learns of it when a read fails. The documented reads are the fundraiser node and `GET /{fundraiser-id}/donations` (`amount_received` in minor units, `currency`, `donation_time`, `donor_id_hash`, `payment_id`); the node's total fields are not on the Integrate page (VERIFY V-PF14, with a fallback in 3.5). The beneficiary must be a nonprofit onboarded to Meta's fundraising tools. Meta's help shows "Why fundraising on Facebook isn't available in India", and secondary sources say only charities in Australia, Canada, the UK and the US can enrol (through PayPal Giving Fund) (VERIFY V-PF12).
9. **Access tier.** Since 4 May 2026 the feature is the "Marketing API Access Tier", with **Limited** (was Standard) and **Full** (was Advanced). Full needs **at least 500 Marketing API calls in the last 15 days** (reduced from 1,500) and an **error rate under 15% over the last 500 calls**. No screen recording is needed. (critic) Corrected: you request it with **"+Upgrade" on the Marketing API Access Tier feature in the App Dashboard**, not through App Review > Permissions and Features (that path is for other advanced-access items). Limited is "heavily rate-limited per ad account" and meant for development, not for production apps serving live advertisers. Limited allows `ads_management` 300 + 40 x active ads calls an hour per ad account (`ads_insights` 600 + 400 x active ads − 0.001 x user errors), and an account score of 60 (a read is 1 point, a write 3, decaying over 300 s) with a 300 s block. Full allows 100,000 + 40 x active ads (`ads_insights` 190,000 + 400 x active ads − 0.001 x user errors) and a score of 9,000 with a 60 s block. Limited also allows 1 system user, Full 10. The authorization page says the same thresholds apply to "maintain your status". Header values of `ads_api_access_tier` named in the docs: `development_access` (Limited) and `standard_access` (Full).

### 1.4 What ships when

| Train | Contents | Flags |
|---|---|---|
| T1 dark | PFA-00, PFA-06, PFA-01, PFA-02: schema, Phase 0 hooks, call log and admin card, partnership client | `META_USAGE_LOG=on` (the card is live at once); `PARTNERSHIPS_ENABLED=off`, `FUNDRAISERS_ENABLED=off` |
| T2 fundraisers | PFA-03, PFA-08, PFA-11 | `FUNDRAISERS_ENABLED=admins`, then `on` after V-PF11 to V-PF16 pass with the review user |
| T3 partnerships | PFA-04, PFA-05, PFA-10 (after the launcher's PRM-09, PRM-14) | `PARTNERSHIPS_ENABLED=admins`, then `on` after V-PF2 to V-PF8; `PARTNERSHIPS_FB_PERMISSIONS=off` until V-PF9 |
| T4 Eddy and entry points | PFA-09, PFA-12 | follows T2 and T3 flags |
| T5 integration | PFA-13: e2e, runbook, App Review documents | none |
| Later | PFA-14: creator APIs (`instagram_branded_content_creator`, `instagram_branded_content_brand`) | `PARTNERSHIPS_CREATOR_API=off` until approved |

(critic) **What `admins` means.** A flag set to `admins` turns the feature on only for workspaces whose id is in `PFA_PILOT_TENANTS` (comma-separated workspace ids, validated by `env-rules.mjs`): Edwyz's own workspace and the App Review workspace "Edwyz Review". Everyone else sees nothing (the routes answer `notFound()`). The review workspace must be in that list, or the flag `on`, before the screencasts are recorded and before Submit (9.0).

---

## 2. User flows

### 2.1 Principles, entry points and defaults

- One decision per screen, every screen pre-filled, mobile first at 360 px, the primary button full width at the bottom.
- Plain words. Say "creator", "post about you", "ad code", "your name and theirs", "fundraiser", "charity". Never say "branded content", "sponsor", "ALP", "BUC", "tier" (outside the admin console) or "person_for_charity".
- Money only through the launcher's Start (Phase 0 `reserveAds`). Fundraisers spend nothing. Sharing on WhatsApp goes through the existing broadcast flow and its messaging limits.
- Honest states: "Waiting for @riya.styles to say yes in Instagram", "Donations go to the charity through Meta. Edwyz never handles the money."
- Pages render English until a native-speaker review flips `PROMOTE_PAGE_LANGS` (IG-PAGE-ADS D23). Eddy cards use the member's language (en, hi, hinglish) now.

**Entry points**

| Where | What |
|---|---|
| Ads page tiles row (PRM-15 `CampaignsView`) | Tile "Work with creators: run ads with posts creators made about you" -> `/app/ads/partners` |
| `/app/ads/partners` | Tabs "Posts about you" and "Creators" (invite links are a section at the bottom of Creators), plus "Brands" when "I'm a creator too" is on. (critic) The separate "Invites" tab is cut: one fewer tab on a 360 px screen |
| Content calendar header | Chip "Fundraisers" -> `/app/content/fundraisers` |
| Content composer, Instagram target selected | "Paid partnership" section (creator tagging) |
| Invite link `https://wa.edwyz.com/app/partners/invite#t=<token>` | The creator's accept page. (critic) The token sits in the URL fragment, which browsers never send to a server, so it never reaches nginx logs, analytics or a `Referer` header |
| Command palette (`commands.ts`) | "Creators", "Partnership ads", "Fundraisers", "Ad code" |
| Eddy | The sequences in 2.14 |
| Admin overview `/admin` | Card "Marketing API access" -> `/admin/meta-api` |

**Smart defaults** (`src/lib/partnerships/defaults.ts`, `src/lib/fundraisers/defaults.ts`)

| Setting | Default |
|---|---|
| Partnership role | Brand. "I'm a creator too" is a switch on the Partners page (PlatformSetting `partnerships:settings:<tenantId>`) |
| Our account for partnerships | The only Instagram asset; else the one linked to the spending ad account's Page; else ask once and remember |
| "Posts about you" filter | "Ready for ads" on, sorted by Meta's recommendation (`sort_by=RECOMMENDED`), 25 per page |
| Goal for a partnership ad | `whatsapp_chats` once V-PF7 passes and the workspace number is linked to the brand Page; else `video_views` for reels and videos; else `engagement` |
| Names shown on the ad | Both names (`ad_format: 1`) |
| Whose name comes first (new-media ads) | The brand's |
| Budget, days, audience, placements | The launcher's defaults (IG-PAGE-ADS 3.1: ₹300 a day or less to fit, 7 days, "Let Meta find people", automatic placements) |
| Fundraiser charity | The last one used; else the first item of the curated list |
| Fundraiser goal | 500 in the charity's currency (the curated list's `currency`; USD when unknown) |
| Fundraiser end | 30 days from today |
| Fundraiser title | "{Business name} for {Charity}", cut to 70 characters at a word boundary |
| Fundraiser story | Two sentences in the member's language: "We're raising money for {charity} this {season}. Every donation goes straight to them through Facebook." |
| Share message (WhatsApp) | The fundraiser template (2.13) |

### 2.2 Brand: setup check ("Partnerships setup")

`partnerships/readiness.ts` returns rows `ok | missing | unknown`, each with one fix. Shown at the top of `/app/ads/partners` until all rows are `ok`, then collapsed into one line "Ready to work with creators".

| Row | Detected by | Fix (copy) |
|---|---|---|
| Instagram account connected | an active `MetaAsset` of type instagram | [Connect Instagram] (the existing popup connect) |
| "Edwyz can show posts creators made about you" | `instagram_branded_content_ads_brand` in `MetaConnection.scopes` (and `facebook_branded_content_ads_brand` for the Facebook tab) | [Allow partnership ads] (popup reconnect): "Facebook needs to ask you for one more permission." |
| Your Instagram is in a business portfolio | business id resolved for the asset (5.1) | Opens Meta `business_portfolio`: "Create a free business portfolio, then come back." |
| Your role on @brand allows partnership ads | PB4 answers 200 (ok), 403 with a role error (missing), anything else (unknown) | Opens Meta `ig_account_roles`: "Ask your business admin to give you 'Partnership ads' access on @brand." |
| A spending ad account is chosen | Phase 0 spending account | Owners: [Spending limits]. Admins: "Ask {owner} to choose a spending ad account." Only Start needs it; browsing works without it |

### 2.3 Brand: add a creator (Instagram)

1. Creators tab, [Add a creator] opens the bottom sheet **"Ask a creator"**. (critic) One sheet, one tap: the sheet is itself the confirmation (it shows the same facts Eddy's card shows), so there is no second confirm sheet.
   - Field "Creator's Instagram username", prefix "@", placeholder "riya.styles". It is validated as `^[a-z0-9._]{1,30}$` after lower-casing and stripping "@" and a pasted `instagram.com/` URL.
   - "Ask from: @yourbrand" (a picker only when there are several Instagram assets).
   - Facts, filled in as the member types: "What it allows: ads with @riya.styles's name, and their posts that tag you." "Who decides: they can say no, or stop it later, in Instagram."
   - Primary: "Send request". The run calls PB5.
2. The row shows **"@riya.styles · Waiting for them to say yes"** with [Remind them] and [Cancel request] (PB6).
   - [Remind them] copies or shares (Web Share API, falling back to copy) this message: "Hi, we'd love to run ads with your posts about {brand}. Please approve our request in Instagram: Settings > Business tools and controls > Partnership ads > Requests. Thank you." (the menu path is VERIFY V-PF19; no "!" because the copy tests ban it). No WhatsApp message is sent from the workspace number, so it costs nothing.
3. When the sync (5.3) sees APPROVED: an in-app notice (`partner_approved`, 5.8) "@riya.styles said yes. You can now run ads with their posts." and the chip "Approved". REVOKED gives "Stopped by @riya.styles" when they withdrew, or "Removed" when the brand did.
4. **Edge cases:**
   - Username unknown or not a professional account: "We couldn't find a professional Instagram account called @x. Check the spelling, or ask them to switch to a professional account." (error codes VERIFY V-PF2).
   - Already asked: the existing row opens.
   - 20 requests in an hour: "You've sent a lot of requests. Try again in an hour."

### 2.4 Brand: invite a creator with a link

1. Creators tab, [Invite with a link] (also in the "Invite links" section at the bottom of the tab, which lists open links with [Stop link]). The sheet says "Send this link to the creator. When they open it in Edwyz and accept, we link your accounts and send the Instagram request from @yourbrand." Buttons: [Share link] (Web Share), [Send on WhatsApp] (opens `https://wa.me/?text=<message + link>` on the member's phone; free, sent by the member), [Copy link]. "The link works once and expires in 14 days." The link is shown only in this sheet, once; Eddy never creates or shows it (5.6).
2. The creator opens the link. (critic) The page `/app/partners/invite` reads the token from `location.hash`, keeps it in `sessionStorage` (inside try/catch) while the creator signs in or signs up through the existing auth `next` parameter, then clears the fragment with `history.replaceState`. If storage is blocked, the page says "Open the link again after signing in." It says **"Partner with {Brand}?"** It shows the brand name and @brand, and "{Brand} wants to run ads using your name and the posts you tag them in. You stay in control in Instagram." A picker "Your Instagram account" lists the creator workspace's Instagram assets; with none, [Connect Instagram] opens the popup. Primary "Accept", secondary "Not now".
3. Accept creates, in one transaction, a `Partner` row in the creator's workspace (side `brand`, with the brand's Instagram id, username and name) and a `Partner` row in the brand's workspace (side `creator`, with the creator's Instagram id and username). It queues `partnerships.invite.request`, which sends PB5 with the **brand's** token in the brand's workspace (the brand agreed when it made the link). (critic) The job first checks that the brand's Instagram asset is still active, its connection usable (`getAssetUserAccess`) and the member who made the link still an admin; otherwise the brand row stays `none` with "Send the request again" and nothing reaches Meta.
4. The creator then sees: "Done. Now approve {Brand}'s request in Instagram: Settings > Business tools and controls > Partnership ads > Requests." and "You can now tag {Brand} as a paid partner when you post from Edwyz."
5. Expired, used or revoked link: "This invite link has expired or was already used. Ask {Brand} for a new one." An admin in the brand's own workspace who opens it sees: "This is your own invite. Send it to the creator."

### 2.5 Brand: run a creator's post as an ad

1. The "Posts about you" tab is a grid with 2 columns on phones and 4 on desktop, filled from PB1. Each card shows:
   - the creator's avatar (`author.profile_picture_url`), @creator, and a type badge (Reel, Post, Story, Facebook post);
   - the date, and the first caption line (untrusted text, clipped at 120 characters);
   - "12.4K views · 830 likes" from `organic_insights`, formatted `en-IN`;
   - one state chip:
     - `AD_READY`: "Ready for ads";
     - `NEEDS_ATTENTION`: "Needs @x's OK", with the reason;
     - `INELIGIBLE`: greyed out, "Can't be an ad: {plain reason}";
     - `EXCLUDED`: hidden unless "Show all" is on;
   - badges "In an ad now" (`ad_usage` ACTIVE), "Used before" and "Meta suggests" (`is_recommended`);
   - buttons [Use as ad] and [See post] (opens `permalink` in a new tab with `rel="noopener noreferrer"`).

   Filter chips: Ready for ads, Reels, Posts, Stories, Facebook, Meta suggests, From @creator (select), Last 60 days.
2. [Use as ad] calls `POST /api/partners/drafts {mode:'existing_post', contentId, platform}`. The server makes a launcher draft (surface `promote`, goal default, source as in 5.5) plus an `AdPartnership` row, then the page navigates to `/app/ads/boost?draftId=<id>&step=goal`. The launcher's steps 2 to 4 follow.
3. "What should people do?" offers only the goals in `PARTNERSHIP_GOALS` (3.3).
4. "Who and how much" is the launcher's shared step.
5. The Review card adds these facts:
   - "With: @riya.styles (their reel from 21 Oct)";
   - "Shows as: {Brand} and @riya.styles" [Change] (More: "Show both names (recommended)", "Show only the first name", "Let Meta choose": `ad_format` 1, 2, 3).

   And these warnings:
   - "@riya.styles can stop this at any time in Instagram. The ad then stops showing."
   - "Partnership ads appear in Meta's Ad Library with both names."
   - For `NEEDS_ATTENTION`: "This ad shows only after @riya.styles says yes in Instagram. Money is set aside from today."

   Primary: "Start ads · up to ₹2,625".
6. Start is the launcher's `start_promotion`: create PAUSED, then the guarded activation. Just before the creates, the server checks the post again (PB3). A post that turned `INELIGIBLE` returns 409 `changed` with "This post can't be used any more: {reason}."

Reels with licensed music show "Reels with licensed music can't be run as ads." A post already in a running ad shows a warning, not a block.

### 2.6 Brand: use an ad code

1. [I have an ad code] (on the "Posts about you" tab and on an empty grid) opens **"Use an ad code"**.
   - Field "Ad code". After paste it shows masked (••••••A7F2) with an eye toggle.
   - Help: "Creators make an ad code in Instagram (on the post: ••• > Partnership label and ads > Get ad code) and send it to you." (path VERIFY V-PF19).
   - Button [Find the post].
2. PB2 looks the code up (`POST /api/partners/content/lookup`). The matching post shows as one card. [Use as ad] posts `{mode:'ad_code', adCode, contentId}` to `/api/partners/drafts`, which makes the draft and stores the code sealed in `AdPartnership.adCodeEnc`; the code is permission for that post. The browser drops the code from memory once the draft exists.
   - (critic) **Ad codes never go through Eddy.** A code typed into Eddy would be stored in the conversation history and sent to the AI provider. Eddy's answer to "I have an ad code" is a navigate chip to `/app/ads/partners?sheet=adcode` with "Paste the code here, it stays private." The lookup route is not exposed to Eddy (reason `secret`, 3.8) and `create_partnership_draft` has no `adCode` input.
3. No match: "This code didn't match a post. Ask the creator to check it, or to make a new one." A code for a post that is already in an ad gives the warning "This post is already in one of your ads."

### 2.7 Brand: a new ad with a creator's name

Only for creators with status Approved.

1. On the creator's row: [Make an ad with @riya.styles]. This creates a draft (`mode: creator_identity`) and goes to `/app/ads/create?draftId=<id>&step=ad`, the launcher's "Your ad" step with media, text and the call to action.
2. More: "Whose name comes first?" with "Yours (recommended)" or "@riya.styles's". Creator-first is offered only when the creator has a Facebook Page (`fbPageId`). Otherwise it is greyed out with "Needs @riya.styles's Facebook Page, or Meta won't show it on Facebook."
3. The Review card adds "Shows as: {Brand} with @riya.styles".

### 2.8 Brand: Facebook creators (flag `PARTNERSHIPS_FB_PERMISSIONS`)

- A "Facebook" sub-tab under Creators. [Add a Facebook creator] asks for "Creator's Facebook Page link or Page ID", with the help "On their Page: About > Page transparency > Page ID". The server accepts digits, or `facebook.com/profile.php?id=<digits>`, and refuses vanity links with "Paste the Page ID (numbers only). Vanity links can't be looked up." It then sends PB8 `send-request`.
- Rows show the statuses in 1.3 item 4 in plain words. Received requests (another Page asked us) show [Accept] and [Say no] (PB8 `accept-request` and `reject-request`), each a confirm card.
- Facebook posts that tag the brand appear in "Posts about you" through PB1 whatever this flag says, because PB1 is Graph and needs only `facebook_branded_content_ads_brand`.

### 2.9 After Start

- The launcher's campaign page `/app/ads/[id]` shows a chip "With @riya.styles". Its timeline adds "Waiting for @riya.styles to approve" while Meta reports the pending-permission state (VERIFY V-PF8, mapped in `promote/review-reasons.ts`), and "Stopped showing: @riya.styles removed permission" when the partner sync sees REVOKED. That comes with a notice and the chip [Pause ads], which is a lowering and is never blocked.
- Results, pause, end earlier and spend less are the launcher's (IG-PAGE-ADS 3.9, 3.10).

### 2.10 Creator side: "I work with brands"

The switch "I'm a creator too" on `/app/ads/partners` shows the **Brands** tab, which has three parts:

- **Brands you work with.** Rows from accepted invites (side `brand`), each "Ready to tag in your posts". Empty state: "No brands yet. Brands send you an invite link. Open it to connect."
- **"Requests from brands."** Instagram has no API for a creator to list them, so: "Brands' requests appear in Instagram: Settings > Business tools and controls > Partnership ads. Approve the ones you want." Facebook received requests are listed when the flag is on (2.8).
- **"Share an ad code with a brand."** Three numbered steps for the Instagram app (V-PF19), then the field "Paste the code" and "Send to" with a brand picker or "someone else". [Send on WhatsApp] opens `wa.me` with "Here is the ad code for my post: {code}". The code is composed in the browser and **never sent to or stored by Edwyz**. With PFA-14, a one-tap "Make an ad code" appears on each published Instagram post instead.

**Tag a brand when posting** (content composer, Instagram target selected):

- The collapsed section "Paid partnership" has the switch "Add the 'Paid partnership' label".
- When it is on: "With brand (optional, up to 2)" as chips from the Brands list. Only rows with `igUserId` can be picked.
- Help: "Indian ad rules (ASCI) ask creators to label posts a brand paid for. If you allow it in Instagram, the brand can run this post as an ad."
- The preview line reads "Paid partnership with {brand}" (or "Paid partnership").
- Publishing sends PC1 with `is_paid_partnership: true` and `branded_content_sponsor_ids` when brands are chosen.
- Not offered for Facebook targets (V-PF10b).
- If Meta refuses a brand, the target fails with "Meta couldn't tag @brand. Brands must have a professional Instagram account. Remove the brand and publish again." Nothing is retried automatically, because the media container step is not a create.

### 2.11 Fundraisers: setup check

`fundraisers/readiness.ts`:

| Row | Detected by | Fix |
|---|---|---|
| Facebook connected | an active `MetaConnection` | [Connect Facebook] |
| "Edwyz can create fundraisers for you" | `manage_fundraisers` in `MetaConnection.scopes` | [Allow fundraisers] (popup reconnect) |
| You are the organiser | the member is `MetaConnection.connectedByUserId` | Others see everything read-only with "Fundraisers go on {name}'s Facebook profile, so only {name} can create or change them." |

An info box sits at the top of the page at all times (Alert tone info): "Facebook fundraisers work only for charities Meta supports, in a few countries (such as the US, UK, Canada and Australia). Indian charities can't receive donations through Facebook yet." (VERIFY V-PF12; the country list comes from PlatformSetting `fundraisers:availability`, so an admin can correct it without a deploy).

### 2.12 Fundraisers: create (3 screens)

Route `/app/content/fundraisers/new`. The draft is saved in Edwyz (a `Fundraiser` row with status `draft`) after every screen (`save_fundraiser_draft`), so a reload or a phone call does not lose it. (critic) No cover photo step: Facebook shows the charity's own cover, which saves a screen and an upload path (D-PF20).

1. **"Which charity?"** Radio cards:
   - "My own nonprofit". Shown when the workspace has Page assets. Pick a Page, with the help "Only if your nonprofit is enrolled in Facebook fundraising."
   - The curated list from `fundraisers:charities`: name, country chip, "Meta-supported".
   - "Another charity": Page ID (digits, 5 to 25) and "Charity name" (80 characters at most, for display only). Help: "On the charity's Facebook Page: About > Page transparency > Page ID."
2. **"Your fundraiser":**
   - Title, with a 70-character counter.
   - "Why are you raising money?": the story, pre-filled, with a 5,000-character cap in the app.
   - Goal: a currency select (USD, GBP, CAD, AUD, EUR, INR; the default comes from the charity; the accepted list is VERIFY V-PF16) and a whole-number stepper (minimum 1, step 50).
   - Ends: chips "7 days", "30 days", "60 days" and "Pick a date" (1 to 365 days ahead). The line "Ends {Sun 30 Nov}. Facebook closes it at 11:59 pm that day."
3. **Review card: "Create this fundraiser on Facebook?"**
   - Facts:
     - For: {Charity};
     - Title;
     - Goal: $500;
     - Ends: Sun 30 Nov;
     - Organiser: "{Facebook name} (your Facebook profile)", read live with F6 and not stored;
     - the story's first 300 characters, with [Show all].
   - Warnings:
     - "It's public on Facebook under your name. Your friends may see it."
     - "You can end it here at any time. Only you can delete it, on Facebook."
     - "Donations go to the charity through Meta. Edwyz never handles the money."
   - Primary "Create fundraiser"; secondary "Keep as draft".
   - Done: "Your fundraiser is live on Facebook." [Share on WhatsApp] [Post on your Page] [Copy link] [Open on Facebook].

**Errors** (plain words, 3.10):

- not eligible: "Facebook didn't allow this fundraiser. Either {charity} can't receive Facebook donations, or fundraisers aren't available for your Facebook account's country.";
- name too long: blocked before sending;
- ambiguous answer: "It isn't certain whether Facebook created it. We're checking and won't create it twice." The settle job (5.3) then runs.

### 2.13 Fundraisers: progress, share, edit and end

- **List** (`/app/content/fundraisers`). One card per fundraiser:
  - title and charity;
  - `ProgressBar` with the label "$340 raised of $500 (68%)";
  - "12 donations · 9 donors · 18 days left";
  - a status chip: Active, Ended, "Deleted on Facebook" or Draft;
  - "Updated 5 min ago" [Refresh].

  Empty state: "No fundraisers yet. Raise money for a charity and share it with your customers." [Start a fundraiser].
- **Detail** (`/app/content/fundraisers/[id]`):
  - the same numbers and the share actions;
  - "Shared": "WhatsApp broadcast 'Diwali giving' · sent to 230 people", "Page post · 2 Nov";
  - [Edit], [End fundraiser], [Hide from Edwyz].
- **Share on WhatsApp** is hidden when no WhatsApp number is connected.
  - With no approved fundraiser template, a sheet says "First, WhatsApp needs to approve your message." It previews the template and has a language chip (English, Hindi).
    - Body (en): "{{1}} is raising money for {{2}} on Facebook. Every donation goes straight to the charity. Tap Donate to give."
    - URL button "Donate", `https://www.facebook.com/donate/{{1}}` (V-PF13).
    - Category MARKETING.
    - [Send to Meta for approval] is the existing `submit_template` card. Its approval notice says "Your fundraiser message is approved." [Create broadcast].
  - With an approved template, the server creates a broadcast draft named "Fundraiser · {title}":
    - `{{1}}` is the business name (static) and `{{2}}` the charity name (static);
    - the button suffix is the fundraiser id.

    The page then navigates to the existing broadcast editor (audience, cost estimate, Start under the messaging limits).
- **Post on your Page.** Creates a content draft for the workspace's Facebook Page targets with the body "We're raising money for {charity}: {title}. Donate on Facebook: {uri}" and opens it in the composer. Publishing is the existing flow. Once it is published, the launcher's "Boost this post" chip appears (an ads spend, through Phase 0).
- **Copy link / Share** uses Web Share with the fundraiser `uri`.
- **Edit** (organiser only): title, story and goal. The card "Update '{title}' on Facebook?" shows old -> new. The end date is not editable in Edwyz: "To change the end date, open the fundraiser on Facebook." [Open on Facebook] (opens the fundraiser's own `uri` returned by Meta, in a new tab). The reason is P0-PF2: an `end_time` write on an id is a spend field to the tripwire.
- **End** (organiser only): a danger card, "End '{title}' now? People can't donate after this, and it can't be restarted." Focus starts on Cancel.
- **Hide from Edwyz**: local, undoable. It does nothing on Facebook.

### 2.14 Eddy sequences

| Member says (en / hi / hinglish) | Tools, in order |
|---|---|
| "Run Riya's reel about us as an ad for 5 days" / "रिया की हमारे बारे में बनी रील को 5 दिन ऐड में चलाओ" / "Riya ki humare baare mein bani reel 5 din ad mein chalao" | `list_partner_content {creator:'riya'}` -> `create_partnership_draft {contentId, days:5}` -> `start_promotion` card (the facts in 2.5) |
| "Ask @riya.styles for permission to run ads with her posts" / "@riya.styles से उनकी पोस्ट के साथ ऐड चलाने की इजाज़त माँगो" / "@riya.styles se unki posts ke saath ad chalane ki permission maango" | `get_partnership_setup` -> `request_creator_permission` card |
| "I have an ad code from a creator" / "मेरे पास क्रिएटर का ऐड कोड है" / "Mere paas creator ka ad code hai" | (critic) No tool takes the code. Eddy replies with a navigate chip to `/app/ads/partners?sheet=adcode`: "Paste the code on this page. It stays private and is not sent to me." If the member pastes a code anyway, Eddy does not repeat it and gives the same chip |
| "Start a Diwali fundraiser for St. Jude, goal $500" / "St. Jude के लिए दिवाली फ़ंडरेज़र शुरू करो, लक्ष्य 500 डॉलर" / "St. Jude ke liye Diwali fundraiser shuru karo, goal 500 dollar" | `get_fundraiser_setup` -> `list_charities` -> `save_fundraiser_draft` -> `create_fundraiser` card |
| "How much has my fundraiser raised?" / "मेरे फ़ंडरेज़र में कितना पैसा आया?" / "Mere fundraiser mein kitna paisa aaya?" | `list_fundraisers` (or `refresh_fundraiser` when older than 15 min) |
| "Share the fundraiser with my customers on WhatsApp" / "फ़ंडरेज़र को WhatsApp पर मेरे ग्राहकों को भेजो" / "Fundraiser ko WhatsApp pe mere customers ko bhejo" | `share_fundraiser_on_whatsapp` (draft) -> the existing broadcast cards |

Eddy's own rules:

- It never asks for, repeats or uses an ad code or an invite link.
- (critic) `start_promotion` is a v2 tool (`model-tools.ts` offers v2 tools only at phase 2). Before that phase, Eddy stops after `create_partnership_draft`, whose `forUi` returns the navigate hint "Review and start" to `/app/ads/boost?draftId=…` (through `safeAppPath`), where the member presses Start. All new tools here are v1 (none spends), so the rest works at phase 1.
- It never claims "started" or "created" before the card's outcome says so.
- Captions, creator names and charity names are untrusted text.
- It says "Donations go to the charity through Meta" whenever money is asked about.

### 2.15 Key copy (English source; `partnerships/copy`, `fundraisers/copy`; Eddy area catalogues in 3 languages)

| Key | Copy |
|---|---|
| `pt.tile` | "Work with creators" / "Run ads with posts creators made about you." |
| `pt.empty.posts` | "No creator posts tag you yet. When a creator tags @{brand} as a paid partner, the post shows here." |
| `pt.state.ready` / `.needs_ok` / `.ineligible` | "Ready for ads" / "Needs @{creator}'s OK" / "Can't be an ad: {reason}" |
| `pt.review.with` / `.shows_as` | "With: @{creator} ({kind} from {date})" / "Shows as: {brand} and @{creator}" |
| `pt.warn.can_stop` | "@{creator} can stop this at any time in Instagram. The ad then stops showing." |
| `pt.warn.pending` | "This ad shows only after @{creator} says yes in Instagram. Money is set aside from today." |
| `pt.warn.ad_library` | "Partnership ads appear in Meta's Ad Library with both names." |
| `pt.code.help` | "Creators make an ad code in Instagram and send it to you." |
| `pt.tag.help` | "Indian ad rules (ASCI) ask creators to label posts a brand paid for." |
| `fr.availability` | "Facebook fundraisers work only for charities Meta supports, in a few countries (such as the US, UK, Canada and Australia). Indian charities can't receive donations through Facebook yet." |
| `fr.money` | "Donations go to the charity through Meta. Edwyz never handles the money." |
| `fr.public` | "It's public on Facebook under your name. Your friends may see it." |
| `fr.delete_on_fb` | "You can end it here at any time. Only you can delete it, on Facebook." |
| `fr.progress` | "{raised} raised of {goal} ({pct}%)" / "{n} donations · {d} donors · {days} days left" |
| `fr.end.title` | "End '{title}' now?" / "People can't donate after this, and it can't be restarted." |

The copy tests (8.1) check the same keys and placeholders in all three languages and ban "sponsor", "branded content", "tier", emojis and exclamation marks.

---

## 3. API plan

### 3.1 Conventions

- **Transport.**
  - Graph calls use `graphFetchAs(token, request)` (`src/lib/graph/index.ts`). A POST is never retried after an ambiguous failure (existing `guardAllPosts` rule). Every body is JSON; (critic) nothing in this spec uploads a file, so no multipart helper is added (the fundraiser cover photo is dropped, D-PF20).
  - The Facebook account-level REST API (PB7, PB8) uses `fetch` in `src/lib/partnerships/fb-permissions.ts` only (P0-PF4).
- **Tokens.** (critic) Corrected to the real helpers. `getAssetAccess(tenantId, assetId)` (`src/lib/meta-connect/index.ts`) returns `MetaAsset.tokenEnc` when set, so for an Instagram or Page asset it returns the **Page** token stored by discovery, and the connection's user token only for assets without one (ad accounts).
  - **User token** for `act_X` edges (through the launcher), Content Discovery (PB1 to PB3) and account-level permissions (PB4 to PB6): `getAssetUserAccess(tenantId, assetId)`, the helper the publishing spec defines (SOC-06). It runs the same tenant, status and expiry checks as `getAssetAccess` and returns the connection's token. PFA-00 adds it with the same signature if SOC-06 has not merged; whichever lands second keeps the first one.
  - **Fundraisers** (F1 to F6) use the organiser's own connection: `getConnectionUserAccess(tenantId, connectionId)`, new in `src/lib/meta-connect/index.ts` (PFA-00), with the same checks and an `HttpError(409)` "Your Facebook connection has expired. Connect again." on an unusable connection.
  - **Page token** for Instagram publishing (PC1): `getAssetAccess`, exactly as `content/publish.ts` does today.
  - Tokens are decrypted only at the call site and never logged or returned.
- **Where calls live.**
  - Partnership reads and permission writes: `src/lib/partnerships/meta.ts`.
  - Facebook REST: `src/lib/partnerships/fb-permissions.ts`.
  - Fundraisers: `src/lib/fundraisers/meta.ts`.
  - Creatives: only through the launcher (`ads/service.launchCampaign` -> `ads/builders.buildCreative` -> `promote/creative-shapes.ts` -> `partnerships/shapes.ts`, which is pure).
  - Neither new module imports `adsClient` (rule B3) or names a budget field (B10). `end_time` appears only in `fundraisers/meta.ts` (P0-PF3).
- **Tripwire classes.** Every request below has a `classify()` fixture (PFA-06).
- **Paging.** Content Discovery takes 25 per page and at most 4 pages per request. The permission list takes `limit=200` and at most 5 pages. `me/fundraisers` takes `limit=100` and at most 3 pages.
- **Throttling.** Partnership calls on an ad account or business go through `promote/throttle.ts` at priority 3 (interactive) or 5 (background sync). The 613 and 17 cooldowns are shared.

### 3.2 Partnership calls

| Id | Call | Token | Needs (permission, access, role) | Class | Used for |
|---|---|---|---|---|---|
| PB1 | `GET {business-id}/partnership-ads-advertisable-content?ig_user_id=<brand ig>&fb_page_id=<brand page>&platform_types=[...]&content_types=[...]&ad_eligibilities=[...]&media_types=[...]&post_types=[...]&ad_partner_ig_user_ids=[...]&start_date=&end_date=&sort_by=RECOMMENDED&limit=25&after=&fields=content_id,platform,media_type,post_type,caption,permalink,creation_time,author{display_name,ig_user_id,fb_page_id,profile_picture_url},is_recommended,ad_usage,partnership_info{ad_eligibility,tagged_partner{display_name},permission_status,permission_type,content_types,eligibility_errors},organic_insights` | user | `business_management` + `instagram_branded_content_ads_brand` + `instagram_basic` (Instagram); `facebook_branded_content_ads_brand` (Facebook); Advanced access for accounts not owned by app-role users. `platform_types` lists only the platforms whose scope the token holds | not_spend | "Posts about you" |
| PB2 | `GET {business-id}/partnership-ads-advertisable-content?ig_user_id=&ad_codes=["<code>"]&fields=<as PB1>` (direct lookup; no filters, sort or cursor) | user | as PB1 | not_spend | "Use an ad code" |
| PB3 | `GET {business-id}/partnership-ads-advertisable-content?ig_user_id=&content_ids=["<id>"]&fields=content_id,partnership_info{ad_eligibility,permission_status,eligibility_errors},ad_usage` | user | as PB1 | not_spend | Re-check before Start |
| PB4 | `GET {brand-ig-id}/branded_content_ad_permissions?creator_username=<opt>&limit=200&fields=id,creator_username,creator_id,creator_fb_page,brand_ig_user{id},permission_status` | user (VERIFY V-PF2) | `instagram_branded_content_ads_brand`, `instagram_basic`, `business_management`; role ADS, CREATOR_MANAGEMENT or CREATOR_CONTENT on the Instagram account | not_spend | Creators list and sync |
| PB5 | `POST {brand-ig-id}/branded_content_ad_permissions {creator_instagram_username}` -> `{id}` | user | as PB4 | not_spend (P0-PF1 fixture) | Ask a creator |
| PB6 | `POST {brand-ig-id}/branded_content_ad_permissions {creator_instagram_account:<creator ig id>, revoke:true}` -> `{id}` | user | as PB4 | not_spend (fixture) | Cancel or stop |
| PB7 | `GET https://api.facebook.com/partnership-ads/fb-account-level-permissions/{brandPageId}?permission_direction=sent\|received&status=[1,2,3,4,5,6,7]&limit=1000&offset=0`, headers `Authorization: Bearer <token>`, `X-API-Version: 1.0.0` | user or Page (VERIFY V-PF9) | `facebook_branded_content_ads_brand` | outside Graph; B12 exemption (P0-PF4) | Facebook creators tab |
| PB8 | `POST` the same path, body `[{"partner_page_id": <id>, "action": "send-request"\|"cancel-request"\|"remove-permission"\|"accept-request"\|"reject-request"}]`; response items `{partner_page_id, alp_permission_id, alp_permission_status, status[, error_code, error_message]}` | as PB7 | as PB7 | as PB7 | Send, cancel, accept, refuse |
| PB9 | `POST act_X/adcreatives` with a partnership shape (3.3) | user | `ads_management`, plus `instagram_branded_content_ads_brand` (Instagram sources) and/or `facebook_branded_content_ads_brand` (Facebook sources), as Meta's two "Partnership Ads" pages list. The role needs (ADVERTISE task on the brand Page, ad access on the brand Instagram account) are not on those pages: VERIFY V-PF22 | ads_create (inside `launchCampaign`'s `permitForPausedCreate`; creatives are exempt from PAUSED, P0-1) | Start |
| PB10 | `POST act_X/ads {name, adset_id, creative:{creative_id}, status:'PAUSED'}`, then `POST <ids> {status:'ACTIVE'}` | user | `ads_management` | ads_create, then the guarded activation | Start (unchanged launcher path) |
| PB11 | `GET act_X/generatepreviews?creative=<partnership shape>&ad_format=<format>` | user | `ads_read` | not_spend | "See how the ad looks" (launcher previews, VERIFY V-PF5b) |
| PB12 | `POST act_X/advideos {partnership_ad_ad_code, is_partnership_ad:true}` | user | `ads_management` | not_spend (advideos) | Not used in v1. The documented workaround for "Instagram Video Must Be Uploaded To Facebook" on ad-code videos; v1 maps the error to copy (3.10) |

### 3.3 Partnership creative shapes (`src/lib/partnerships/shapes.ts`, pure; registered into `promote/creative-shapes.ts` by PFA-05)

Every shape carries `name`, the launcher's `call_to_action` for the goal, and the launcher's enhancements block (IG-PAGE-ADS D11, every feature `OPT_OUT`) unless V-PF6 shows Meta refuses it on partnership creatives. If so, the shape omits the block. It never sends `standard_enhancements`, which Meta's sample uses and the launcher bans by grep test.

| Shape | Body |
|---|---|
| `ig_existing` (creator's Instagram media) | `{object_id:<brand page id>, source_instagram_media_id:<creator media id>, facebook_branded_content:{sponsor_page_id:<brand page id>}, instagram_branded_content:{sponsor_id:<brand ig id>}, branded_content:{ad_format:<1\|2\|3>}}` (exactly Meta's sample; VERIFY V-PF4) |
| `ig_ad_code` | `{object_id:<brand page id>, branded_content:{instagram_boost_post_access_token:<code>, ad_format}, facebook_branded_content:{sponsor_page_id:<brand page id>}, instagram_branded_content:{sponsor_id:<brand ig id>}}` (V-PF5) |
| `fb_existing` (creator's Facebook post) | `{object_story_id:'<creatorPageId>_<postId>', facebook_branded_content:{sponsor_page_id:<brand page id>}, instagram_branded_content:{sponsor_id:<brand ig id>}, branded_content:{ad_format}}` |
| `fb_ad_code` | `{object_id:<brand page id>, branded_content:{facebook_boost_post_access_token:<code>, ad_format}, facebook_branded_content:{sponsor_page_id:<brand page id>}, instagram_branded_content:{sponsor_id:<brand ig id>, only when the brand has one}, call_to_action?}`. (critic) Meta's sample sends both sponsor objects "with the same fields as above"; whether `object_id` is required here is not shown (VERIFY V-PF5). For eligible ad accounts Meta makes an unpublished copy of the post |
| `identity_brand_first` (new media) | `{object_story_spec:{page_id:<brand page id>, link_data:{message, name, image_hash, link, call_to_action}} \| {video_data:{...}}, instagram_branded_content:{sponsor_id:<creator ig id>}, facebook_branded_content:{sponsor_page_id:<creator page id, when known>}}`. Meta links the missing one when only one is given. Without a hard link between the creator's Instagram and Page, Meta won't deliver on that platform |
| `identity_creator_first` | `{object_story_spec:{page_id:<creator page id>, link_data\|video_data}, facebook_branded_content:{sponsor_page_id:<brand page id>}, instagram_branded_content:{sponsor_id:<brand ig id>}}` ((critic) Meta's creator-first sample carries both brand sponsor fields; the creator's Instagram id is derived from their Page). Offered only with `fbPageId` |
| Click-to-message variant | Adds `branded_content.promoted_page_id:<brand page id>` and the goal's CTA (`WHATSAPP_MESSAGE` with `app_destination: WHATSAPP`). Behind V-PF7: `whatsapp_chats` stays out of `PARTNERSHIP_GOALS` until it passes |

`PARTNERSHIP_GOALS`, a catalog row per goal with a verify state like the launcher's (IG-PAGE-ADS D22):

| Goal | v1 tier |
|---|---|
| `engagement` | on |
| `video_views` | on |
| `website_visits` | on |
| `awareness` | on |
| `whatsapp_chats` | after V-PF7 |
| `lead_form` | after V-PF7b (Meta lists lead ads as a supported configuration) |
| `instagram_dms`, `messenger_chats`, `website_sales` | docs only; experimental |

(critic) Partnership shapes never send `instagram_user_id` (the launcher's own-post boost field; Meta's partnership samples use the sponsor objects instead) or `source_facebook_post_id` ("limited availability" per Meta); the snapshot test checks both are absent.

**The ad code at launch.** `Ad.creative.partnership` holds `{mode:'ad_code', codeRef:'sealed'}` and never the code itself. `buildCreative` receives the unsealed code from `partnerships/drafts.loadLaunchSecrets(tenantId, campaignId)` in memory, only inside `launchCampaign`'s run. The tripwire and the audit log see only the path pattern.

### 3.4 Creator calls

| Id | Call | Token | Needs | Class | Phase |
|---|---|---|---|---|---|
| PC1 | `POST {ig-user-id}/media {image_url\|video_url, media_type?, caption, is_paid_partnership:true, branded_content_sponsor_ids:[≤2 brand ig ids]}`, then the existing `media_publish` | Page | `instagram_basic`, `instagram_content_publish` (or `instagram_branded_content_creator`); Facebook Login only | not_spend (`media`) | v1 (PFA-12). Carousel and Story support VERIFY V-PF10 |
| PC2 | `POST {ig-media-id}/partnership_ad_code` -> `{ad_code}` | user | `instagram_branded_content_creator`, `instagram_basic`, `business_management` | not_spend (fixture) | PFA-14 |
| PC3 | `DELETE {ig-media-id}/partnership_ad_code` -> `{success}` | user | as PC2 | not_spend | PFA-14 |
| PC4 | `GET {ig-media-id}/branded_content_partner_promote` -> `{approved}`; `POST ... {sponsor_id, permission:true\|false}` | user | `instagram_branded_content_creator` | not_spend (fixture) | PFA-14 |
| PC5 | `GET\|POST\|DELETE {brand-ig-id}/branded_content_tag_approval {user_ids}` (100 at most; POST and DELETE are all-or-nothing) | user | `instagram_branded_content_brand` | not_spend (fixture) | PFA-14 |

### 3.5 Fundraiser calls

| Id | Call | Token | Needs | Class | Notes |
|---|---|---|---|---|---|
| F1 | `POST me/fundraisers` JSON `{page_id, name (≤70), description, goal_amount (minor units, whole major units), currency, end_time (unix seconds, ≤ now + 365 d in Edwyz), external_id:<Fundraiser.id>, fundraiser_type:'person_for_charity'}`. No `cover_photo` and no `external_fundraiser_uri` in v1 (D-PF20) | the organiser's user token (`getConnectionUserAccess`) | `manage_fundraisers` (Advanced for users without an app role); a real user; a Live app for the fundraiser to be public | not_spend after P0-PF1 | -> `{id}`. Ambiguous -> the settle job (F2) |
| F2 | `GET me/fundraisers?fields=id,external_id,name,uri,end_time&limit=100` | user | `manage_fundraisers` | not_spend | Settles `creating` rows by `external_id` (V-PF21); also the "imported" check |
| F3 | `GET {fundraiser-id}?fields=id,name,description,goal_amount,currency,end_time,uri,amount_raised,donations_count,donors_count,external_amount_raised,charity_id` | user | `manage_fundraisers` | not_spend | Progress. Field names from Meta's Node SDK `FundraiserPersonToCharity`; they are not on the Integrate page, so names and units are VERIFY V-PF14. An error meaning "does not exist" -> status `deleted` |
| F3b | (critic) Fallback, only if V-PF14 shows the node has no totals: `GET {fundraiser-id}/donations?fields=amount_received,currency&limit=100` (at most 10 pages a refresh), summed in memory | user | `manage_fundraisers` ("read a fundraiser and its donations") | not_spend | `donor_id_hash` and `payment_id` are never requested; the donors count is then hidden ("12 donations · 18 days left"). Selected by PlatformSetting `fundraisers:totals` = `node` (default) or `donations` |
| F4 | `POST {fundraiser-id} {name?, description?, goal_amount?}`. **Never `end_time`** (P0-PF2), although Meta allows it there | user | `manage_fundraisers` | not_spend (no spend key) | Edit |
| F5 | `POST {fundraiser-id}/end_fundraiser` | user | `manage_fundraisers` | not_spend | End |
| F6 | `GET me?fields=name` | user | `public_profile` | not_spend | The organiser's name on the review card, not stored |

**Not called:**

- `GET {id}/donations` with donor fields: it returns donor hashes and payment ids, and the totals come from F3 (or F3b, which asks for `amount_received` and `currency` only).
- `POST /{fundraiser-id}` with `end_time` (D-PF11) and `cover_photo` (D-PF20).
- (critic) `donate_button_charity_id` on Page live videos: the publishing spec leaves it to this spec, and v1 does not send it. The fundraiser link in the broadcast and the Page post covers sharing, and the same charity eligibility limits apply (V-PF12).
- `POST {id}/external_donations`: Edwyz takes no donations.
- The Charity Reporting API (`POST /fundraisers/transactions`): it needs `page_read_donations` and returns donor names and emails.

### 3.6 Webhooks

| Object and field | Callback | Payload used | Notes |
|---|---|---|---|
| Application, `fundraiser_donations` | `POST https://wa.edwyz.com/webhooks/meta-app` (GET does the verify handshake with `META_VERIFY_TOKEN`) | `{object:"application", entry[].changes[] {field:"fundraiser_donations", value:{id, fundraiser_id, amount_received, currency, donation_time, donor_id_hash, payment_id}}}` ((critic) envelope confirmed by the Integrate page's sample; V-PF15 only checks it with the dashboard's Test button). Only `fundraiser_id` is used. `donor_id_hash`, `payment_id`, `id` and the amount are dropped at the edge and never enqueued or stored; `object` other than `application` is ignored with a 200 | Live apps only. Signature `X-Hub-Signature-256` with `META_APP_SECRET`; body at most 1 MB. A known fundraiser id enqueues `fundraisers.donation` `{fundraiserMetaId}`, deduplicated per fundraiser per minute. That sets `progressStaleAt`, and the refresh job then re-reads F3 (idempotent; totals never come from adding webhook amounts) |
| none for partnership permissions | — | — | Polled: every 6 h and when the Creators tab opens with data older than 10 min |
| none for fundraiser edit, end or delete | — | — | Polled with F3 |

### 3.7 Marketing API access tier and Edwyz's own call log

**What Meta wants (1.3 item 9).** At least 500 Marketing API calls in the last 15 days, and an error rate under 15% over the last 500 calls. (critic) The request is the **"+Upgrade"** button on the Marketing API Access Tier feature in the App Dashboard; no recording is needed. The dashboard shows Meta's own progress, which is the authority.

**What Edwyz logs** (PFA-01, `src/lib/meta-usage`):

- **Observer.** The retry loop in `run()` (around each `attemptOnce()`, so `graphFetch`, `graphFetchAs` and `appGraphFetch`) and `graphUpload()` in `src/lib/graph/index.ts` call `observeGraphAttempt()` (`src/lib/meta-usage/observe.ts`, which only hands the observation to `record.ts`) after **every attempt**, retries included, because Meta counts each request. It passes the method, the raw path **segments in memory only**, HTTP status (0 for no answer), Meta `code` and `error_subcode`, duration, `via` and the response headers. The observer is synchronous, wrapped in try/catch, and can never throw into or delay a call. `fb-permissions.ts` reports through the same function with `via: 'rest'`. (critic) No request type changes: there is no `usageTenantId` or `usageFamily` field, because nearly every Marketing API call goes through `graphFetchAs`, which has no tenant, and adding one would touch the launcher and Phase 0 callers. Rows therefore carry no tenant (4.1).
- **What is stored** (`usagePattern()` in `families.ts`). (critic) `pathPattern()` from `spend/classify.ts` turns any segment that is not `^[a-z][a-z_]{0,39}$` into `{id}`, so `partnership-ads-advertisable-content` would become `{id}/{id}` and could not be counted. `usagePattern()` keeps the hyphenated edges of an allowlist (`partnership-ads-advertisable-content`, `fb-account-level-permissions`, `partnership-ads`) and otherwise returns `pathPattern(segments)`. The ad account in the path is reduced to `accountHint`, its last 4 digits. Nothing else from the path, query or body is kept.
- **Headers parsed** (`headers.ts`):
  - `x-business-use-case-usage` (Meta's rate-limiting page names it "X-Business-Use-Case"; both names are read, VERIFY V-PF17): `{<business id>: [{type, call_count, total_cputime, total_time, estimated_time_to_regain_access, ads_api_access_tier}]}`;
  - `x-ad-account-usage`: `{acc_id_util_pct, reset_time_duration, ads_api_access_tier}`;
  - `x-fb-ads-insights-throttle`: `{app_id_util_pct, acc_id_util_pct, ads_api_access_tier}`;
  - `x-app-usage`: `{call_count, total_cputime, total_time}`.

  `usagePct` is the highest percentage found. `accessTier` is the raw `ads_api_access_tier` (values after the rename are VERIFY V-PF17; `development_access` or `limited_access` show as "Limited", `standard_access` or `full_access` as "Full", anything else raw).
- **Families** (`families.ts`, pure, tested against every request shape in IG-PAGE-ADS 4.2 and this spec):
  - `marketing`:
    - any path whose first segment is `act_*`;
    - the edges `adcreatives`, `ads`, `adsets`, `campaigns`, `insights`, `previews`, `generatepreviews`, `reachestimate`, `customaudiences`, `adimages`, `advideos`, `adspixels`, `ad_studies`, `minimum_budgets`, `adaccounts`, `connected_instagram_accounts`, `page_backed_instagram_accounts`, `leadgen_forms` and `test_leads`;
    - `search` with `type` in `adgeolocation` or `adinterest`;
    - a POST `<id>` that `classify()` puts in an ads class;
    - any response whose business-use-case header carries `ads_management`, `ads_insights` or `custom_audience`.
  - `partnerships`: `partnership-ads-advertisable-content`, `branded_content_ad_permissions`, the REST API (`via: 'rest'`), and the PFA-14 edges (`partnership_ad_code`, `branded_content_partner_promote`, `branded_content_tag_approval`).
  - `fundraisers`: `me/fundraisers`, `<id>/end_fundraiser` and `<id>/donations`. (critic) A bare `<id>` read or edit of a fundraiser (F3, F4) cannot be told apart from any other node, so it counts as `other`; the card only needs `marketing`.
  - `whatsapp`: `messages`, `message_templates`, phone numbers and media of `graphFetch` and `graphUpload`.
  - `instagram`: `media`, `media_publish`, `content_publishing_limit`.
  - `pages`: `feed`, `photos`, `videos`, `subscribed_apps`, `me/accounts`.
  - `login`: `appGraphFetch`.
  - `other`: everything else.
- **Storage.**
  - **Per-attempt rows** (`MetaApiCall`) for `marketing`, `partnerships`, `fundraisers`, `pages`, `instagram` and `login`, buffered in memory and written with `createMany` every 5 s or 200 rows. At most 5,000 are buffered and the oldest are dropped, counting the drops.
  - **`whatsapp` and `other`** (high volume) are **counted only**. In-memory counters are upserted into `MetaApiDaily` every 30 s with `ON CONFLICT ... DO UPDATE SET okCount = okCount + EXCLUDED.okCount`.
  - Per-attempt rows are kept 16 days. An hourly rollup folds them into `MetaApiDaily`, which is kept 400 days. (critic) For the six per-row families the rollup **recomputes** today's and yesterday's rows from `MetaApiCall` (`INSERT … SELECT count(*) … GROUP BY day, family ON CONFLICT ("day","family") DO UPDATE SET "okCount" = EXCLUDED."okCount", …`), so a rerun never double-counts; only `whatsapp` and `other` are added incrementally. The two kinds never share a `family`, so they cannot overwrite each other.
- **Definitions shown on the card** (`stats.ts`, one SQL each):
  - *Calls in the last 15 days*: `marketing` rows with `ok`, `at` ≥ now − 15 d.
  - *Error rate*: of the last 500 `marketing` rows with `httpStatus > 0`, the share with `httpStatus ≥ 400`. Rows with no answer (`httpStatus = 0`) are left out of both numbers and shown separately, because Meta may not have seen them.
  - *Pace*: the average daily successful `marketing` calls over the last 7 days; *days to 500* = ⌈(500 − calls15) / pace⌉.
  - *Ready* when calls15 ≥ 500 and the error rate is under 10% (Edwyz's margin under Meta's 15%) and the tier is not already Full.
  - The `partnerships` family is shown next to `marketing` with "Meta may count these too" until V-PF18 settles it.

**What builds this usage legitimately.** Real work only. **Never generate calls to reach the bar** (Platform Terms; the card's copy says so).

| Source | Calls per active spending ad account | Cadence |
|---|---|---|
| Phase 0 fast spend sync (`spend.sync.fast`) | up to 96 a day | every 15 min |
| Phase 0 structure sync (`spend.sync.structure`) | up to 12 a day | every 2 h |
| Meta spending-limit pass (`spend.metacap.pass`) | only when a change is due | every 5 min (check) |
| Insights sync (`ads.insights.daily`) | 3 levels x 4 runs = 12 a day | every 6 h |
| Launcher review sync (PRM-08) | up to 96 a day while ads are in review; 12 a day for the live sweep | 15 min / 2 h |
| A Start | about 6 to 10 writes plus reads | per launch |
| Previews, audience size, place search, post picker | interactive | per member action |
| Partnerships (PB1 to PB6) | interactive, plus 4 a day of sync | — |

One owner-run ad account with one campaign live passes 500 calls in about 4 to 6 days (V-PF18 compares the card with Meta's figure weekly).

**When to apply.**

1. As soon as the card says "Ready" **and** Meta's dashboard shows both requirements met.
2. Before the first customer without an app role runs ads. On Limited, the 60-point account score blocks for 300 s after about 20 writes, which a single Start with versions can hit.
3. If the access-tier item sits in the App Review draft, the draft cannot be submitted until Meta shows the requirement met. That is one more reason to start real usage now (11.1 item 6).

The error rate must stay under 15% after approval as well; the card keeps the alert on.

**Main error sources to keep low**, each with its fix in the card's "Top errors" table:

| Source | Fix |
|---|---|
| Capability probes on error #100 (IG-PAGE-ADS 4.1) | 7-day cache |
| Expired tokens (190) | The token health worker, and no calls on an `expired` connection |
| 613 and 17 throttles | `promote/throttle.ts` cooldowns |
| 100 invalid-parameter errors from unvalidated input | Validate before calling |
| 2635 deprecated version | Pinned to `v26.0` |

### 3.8 App routes

Every POST, PATCH, PUT and DELETE runs `assertSameOrigin` (`src/lib/auth/csrf.ts`), `getActor(request)` (`src/lib/auth/index.ts`, which applies `assertEmailVerifiedForWrite` and the locked-workspace check `enforceWorkspaceState`) and `requireRole` (`src/lib/tenancy.ts`) (5.7). Effects codes map to Eddy's `Effects` fields (`src/lib/actions/types.ts`): X `external`, S `spends`, D `deletes`, I `irreversible`, L `lowersActivity`; every write also sets `writes: true`.

| Method and path | Role | Action | Risk |
|---|---|---|---|
| GET `/api/partners/setup` | admin | `get_partnership_setup` | instant |
| GET `/api/partners/settings` | admin | `get_partnership_settings` | instant |
| PUT `/api/partners/settings {role, defaultIgAssetId?}` | admin | `set_partnership_role` | undoable |
| GET `/api/partners?side=creator\|brand&platform=` | admin | `list_partners` (re-syncs statuses when older than 10 min) | instant |
| POST `/api/partners {platform:'instagram', username, ownAssetId?}` | admin | `request_creator_permission` | confirm (X) |
| POST `/api/partners/[id]/remove` | admin | `remove_partner` (PB6 for Instagram creators; local for brand rows) | confirm (X, L) |
| DELETE `/api/partners/[id]` (only when removed, rejected or never approved) | admin | `forget_partner` | confirm (D) |
| GET `/api/partners/content?filters…&cursor=` | admin | `list_partner_content` | instant |
| POST `/api/partners/content/lookup {adCode}` (POST so the code never lands in a URL or access log) | admin | (critic) not exposed, reason `secret`: the code must never enter an Eddy conversation (2.6) | — |
| POST `/api/partners/drafts {mode, contentId?, partnerId?, adCode? (page only, mode ad_code), goal?, days?, identity?, adFormat?}` | admin | `create_partnership_draft` (its input schema has no `adCode`, so Eddy can make only `existing_post` and `creator_identity` drafts) | undoable (inverse: `discard_promotion_draft`) |
| GET `/api/partners/invites` | admin | `list_partner_invites` (never returns a token or link) | instant |
| POST `/api/partners/invites {ownAssetId, note?}` | admin | (critic) not exposed, reason `secret`: it returns a link that acts on the brand's behalf, shown once on the page | — |
| DELETE `/api/partners/invites/[id]` | admin | `revoke_partner_invite` | undoable |
| POST `/api/partners/invites/accept {token, igAssetId?, preview?}` (POST only, so the token never sits in a URL; `preview: true` returns the brand facts without accepting) | admin of the accepting workspace | not exposed, reason `secret` (it uses a link token) | — |
| GET `/api/partners/facebook?pageAssetId=` | admin | `list_facebook_partnerships` (flag) | instant |
| POST `/api/partners/facebook {pageAssetId, partnerPageId, action}` | admin | `manage_facebook_partnership` (flag) | confirm (X) |
| GET `/api/fundraisers/setup` | agent | `get_fundraiser_setup` | instant |
| GET `/api/fundraisers/charities` | agent | `list_charities` | instant |
| GET `/api/fundraisers?status=&charityPageId=` | agent | `list_fundraisers` | instant |
| POST `/api/fundraisers {charity, name, description, goalMinor, currency, endsAt}` | admin | `save_fundraiser_draft` | undoable |
| GET `/api/fundraisers/[id]` | agent | `get_fundraiser` | instant |
| PATCH `/api/fundraisers/[id] {expectedUpdatedAt, set}` | admin; the organiser only for a live fundraiser | `update_fundraiser` | draft: undoable; live: confirm (X) |
| POST `/api/fundraisers/[id]/create {materialHash}` | organiser | `create_fundraiser` | confirm (X, I) |
| POST `/api/fundraisers/[id]/end` | organiser | `end_fundraiser` | confirm (X, I, L) |
| POST `/api/fundraisers/[id]/refresh` | agent | `refresh_fundraiser` | instant |
| POST `/api/fundraisers/[id]/share/whatsapp {lang}` | admin | `share_fundraiser_on_whatsapp` (creates a local template draft or a broadcast draft) | undoable |
| POST `/api/fundraisers/[id]/share/post` | admin | `share_fundraiser_on_page` (creates a content draft) | undoable |
| POST `/api/fundraisers/[id]/hide` | admin | `hide_fundraiser` | undoable |
| GET and PUT `/api/admin/fundraiser-charities` | platform admin: `handleAdmin(request, false, …, "admin.api.view_fundraiser_charities")` for GET, `handleAdmin(request, true, …, "admin.fundraiser_charities.update")` for PUT (the mutating path, as `/api/admin/plans` uses) | covered by the existing `/api/admin/**` not-exposed entry | — |
| GET `/api/admin/meta-api?days=15` | platform admin: `handleAdmin(request, false, …, "admin.api.view_meta_api")` | covered by `/api/admin/**` | — |
| GET and POST `/webhooks/meta-app` | Meta (signature) | outside `/api` | — |

### 3.9 Rate limits

**Meta's, as documented:**

- Marketing API, per ad account, per hour: Limited `ads_management` 300 + 40 x active ads, and Full 100,000 + 40 x active ads. `ads_insights` is 600 or 190,000 + 400 x active ads.
- Account score: 60 or 9,000 points (read 1, write 3), decaying over 300 s.
- `613/1487632`: 4 budget changes per ad set per hour. `613/5044001`: 100 mutations a second. `613/4841018`: one edit per object every 30 s. `17/1885172`: 10 spend-cap changes a day. (critic) `613/1487225`: ad creation limited by the account's daily spend limit (maps to "Meta limits how many ads this account can create today. Try tomorrow.").
- The Facebook account-level REST API: `limit` at most 1,000 per GET; no documented quota.
- Instagram publishing: 100 API posts in 24 h per account (`content_publishing_limit`, existing check).
- Content Discovery, the permission endpoints and fundraisers: no documented quota. Graph platform limits apply (VERIFY by watching `x-app-usage` on the card).

**Edwyz's own limits** (`createLimiter`):

| What | Limit |
|---|---|
| Content Discovery (PB1) | 30 a minute per user, 60-second cache per (tenant, query hash) |
| Ad code lookups (PB2) | 10 a minute per user; 20 failed lookups an hour per workspace, then 1-hour lockout ("Too many codes didn't match. Try again in an hour."). `createLimiter` (`src/lib/ratelimit`) for every row of this table |
| Creator requests (PB5) | 20 an hour per workspace; 100 a day |
| Invites | 20 a day per workspace; 50 open at once |
| Facebook partner actions (PB8) | 30 an hour per workspace |
| Fundraiser creates (F1) | 5 a day per workspace; 10 active at once (plan feature, 5.7) |
| Fundraiser edits (F4) | 10 a day per fundraiser |
| Fundraiser refresh (F3, manual) | 1 a minute per fundraiser; background at most 50 a run |
| Admin Meta API page | 30 a minute per admin |

### 3.10 Meta errors in plain words (`partnerships/copy`, `fundraisers/copy`)

| Meta answer | Copy and fix |
|---|---|
| PB1 403 (platform without scope, or no `instagram_basic`) | "Edwyz needs one more permission from Facebook to show these posts." [Allow partnership ads] |
| PB1 error "must belong to the business" (VERIFY code) | Retry with the next business from `me/businesses` (5.1). Then: "@{brand} isn't in your business portfolio yet." Opens Meta `business_portfolio` |
| PB4 to PB6 role error (VERIFY code) | "Your Facebook account needs 'Partnership ads' access on @{brand}. Ask your business admin." Opens Meta `ig_account_roles` |
| PB5 creator not found or not professional | 2.3 copy |
| PB2 no match | 2.6 copy |
| Eligibility errors (`eligibility_errors[].code`) | Mapped to plain reasons (licensed music, product tags, too old, story expired, permission missing, account ineligible). An unknown code shows "Meta says: {message}" (untrusted text, 200 characters at most) |
| Creative 100 or 2490xxx about branded content (VERIFY) | "Meta didn't accept this partnership ad: {reason}." The draft stays saved |
| "Instagram Video Must Be Uploaded To Facebook" (ad code, video) | "This video needs the creator to share it a different way. Ask them for the post's link instead of a code, or for a new code." No automatic PB12 in v1 |
| Pending permission (V-PF8) | "Waiting for @{creator} to approve" (timeline) |
| 613 or 17 | "Meta is busy. Try again at {time}." (shared cooldown) |
| PB7 or PB8 404 "No active permission found for this partner" | "There's no partnership with this Page to change." |
| F1 not eligible (VERIFY V-PF12 codes) | 2.12 copy |
| F1 or F4 name too long | Blocked before sending: "Use 70 characters or fewer." |
| F1 test user | "Fundraisers need a real Facebook account." (review and dev only) |
| F3 "does not exist" (VERIFY code) | Status `deleted`: "This fundraiser was deleted on Facebook." |
| 190 (token expired or revoked) | "Your Facebook connection has expired. Connect again to keep this working." [Connect again] |

### 3.11 VERIFY list (runbook PFA-13; a passed item becomes a fake-Meta fixture)

| Id | What | How to check |
|---|---|---|
| V-PF1 | Exact names of the two branded-content items in draft 1799953447868194 | App Dashboard > App Review > Requests > the draft; copy the full 22-item list into `docs/app-review/status.md` |
| V-PF2 | (critic) The path id is the brand's Instagram account id (Meta's samples say so). Still to prove: a Login for Business user token works; the role and not-found error codes; the full `permission_status` set (Meta lists APPROVED, PENDING, REVOKED "etc.") | Graph API Explorer with the app, the review user's token and the test brand's Instagram id: GET, POST to a test creator, GET again, POST `revoke=true` |
| V-PF3 | Content Discovery works with the Login for Business user token, and which `business_id` to pass when a user has several businesses | Call PB1 with `MetaConnection.businessId`, then with each `me/businesses` id; record which one works for the test brand |
| V-PF4 | The `ig_existing` body (object_id = brand Page, sponsor fields = brand ids) creates a delivering partnership ad | Sandbox ad account, or the review ad account with ₹100 a day for 2 days; check the ad header shows both names |
| V-PF5 | The ad-code shapes (including whether `fb_ad_code` needs `object_id`), and `ad_format` 1, 2, 3 on Instagram and Facebook (Meta says 3 "currently optimizes only on Instagram") | Same, with a code made in the Instagram app and one made on Facebook |
| V-PF5b | `generatepreviews` renders partnership shapes | PB11 with each shape |
| V-PF6 | The D11 `OPT_OUT` enhancements block is accepted on partnership creatives | Create each shape with and without the block |
| V-PF7 / 7b | Partnership + WhatsApp destination (CTA, `promoted_page_id`, objective `OUTCOME_ENGAGEMENT`, `CONVERSATIONS`); partnership + lead form | Create in sandbox, then a live ₹100 test |
| V-PF8 | How Meta reports a partnership ad waiting for permission (`effective_status`, `issues_info` codes) | Start an ad with a `NEEDS_ATTENTION` post; read R1 (IG-PAGE-ADS) |
| V-PF9 | The Facebook REST API host, auth token type (user or Page), headers, the batch body, and that a creator Page can accept a received request | Call PB7 and PB8 with the test brand Page and the test creator Page |
| V-PF10 / 10b | `branded_content_sponsor_ids` and `is_paid_partnership` on single images, Reels, carousels and Stories at v26.0 with a Page token; whether a Facebook Page post can carry a paid-partnership label through the API | Publish each type from the test creator account; check the label in the Instagram app |
| V-PF11 | The Login for Business configuration can include `instagram_branded_content_ads_brand`, `facebook_branded_content_ads_brand` and `manage_fundraisers`, and which use case offers each | App Dashboard > Use cases; Facebook Login for Business > Configurations > "Edwyz Connect Pages IG Ads" |
| V-PF12 | Fundraiser availability: eligible charity countries, organiser countries, and the error a user in India gets | facebook.com/help/1313232172957105 from a US and an Indian session; F1 from the review user against a US charity |
| V-PF13 | The `uri` format of a fundraiser (for the template's URL suffix) | F3 on a test fundraiser |
| V-PF14 | F3 field names and units (minor units like `goal_amount`?). If the node has no totals, set `fundraisers:totals` to `donations` (F3b) | F3 after one real minimum donation (USD 5, refund requested, FAQ) |
| V-PF15 | The `fundraiser_donations` envelope (documented; this is a delivery check) | Dashboard "Test" button on the Application webhook field |
| V-PF16 | Currencies `goal_amount` accepts (USD, GBP, CAD, AUD, EUR, INR) | F1 attempts in the dev app (hidden fundraisers) |
| V-PF17 | `ads_api_access_tier` values after the 4 May 2026 rename (the docs still name `development_access` and `standard_access`), and whether the business-use-case header is `x-business-use-case-usage` or `x-business-use-case` | Read the card's raw tier and the "headers seen" list after any ads call |
| V-PF18 | Which calls Meta counts toward the 500 (do Content Discovery and permission calls count?) | Compare the card with the dashboard's progress figure weekly for 3 weeks |
| V-PF19 | The Instagram app menu paths for "approve partnership ad requests" and "Get ad code" | A creator test phone, current Instagram app; screenshots go in the runbook |
| V-PF20 | Partnership ads and branded content tools are available to Indian brands and creators | Meta Business Help Center "partnership ads eligibility" from an Indian account |
| V-PF21 | `GET me/fundraisers` returns `external_id` | F2 with `fields=external_id` |
| V-PF22 | (critic) The roles a partnership creative needs: ADVERTISE on the brand Page, ad access on the brand Instagram account, and whether the brand's Instagram must be linked to the Page used as `object_id` | PB9 with the review user, then with a user who lacks each role; record the error codes for 3.10 |

---

## 4. Data model

### 4.0 Number

(critic) **`0020_partnerships_fundraisers`.** All five specs in `docs/specs/` were written claiming 0014, so the critic fixed one order: 0012 and 0013 stay reserved by `docs/IG-PAGE-ADS-SPEC.md`, then the specs take numbers in file-name order:

| Number | Spec |
|---|---|
| 0014 | `ADS-MCP-CANVA-CREATIVE-SPEC.md` (`0014_studio_canva`) |
| 0015, 0016 | `MESSENGER-INSTAGRAM-INBOX-SPEC.md` (`social_inbox`, `social_inbox_indexes`) |
| 0017, 0018 | `META-CATALOG-COMMERCE-SPEC.md` (`meta_catalog_commerce`, `..._indexes`) |
| 0019 | `PAGE-IG-PUBLISHING-INSIGHTS-LIVE-THREADS-SPEC.md` (`social_publisher`) |
| 0020 | this spec |

If the other specs settle on different numbers, the merge rule wins: whoever merges later takes the next free number and never edits an applied file. The SQL depends only on tables that exist today (`AdCampaign`, `ScheduledPost`), so it may apply before or after any of the others; the package that creates it (PFA-00) renames the folder if 0020 is taken.

### 4.1 Migration `prisma/migrations/0020_partnerships_fundraisers/migration.sql`

```sql
-- 0020_partnerships_fundraisers. Partnership ads, creator tagging, Facebook fundraisers and the Meta API call log.
-- See docs/specs/PARTNERSHIP-ADS-FUNDRAISERS-ACCESS-TIER-SPEC.md section 4.
-- Apply: psql -1 -v ON_ERROR_STOP=1 -f migration.sql (as edwyz_wa_app), record it in MIGRATIONS-APPLIED, then npx prisma generate.
-- Additive only: no DROP, RENAME, type change or UPDATE. One nullable column on an existing table (metadata-only on PG 11+).
-- Every index is on a new, empty table, so nothing existing is scanned and no CONCURRENTLY step is needed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ===== ScheduledPost: a creator's paid-partnership label and brand tags (Instagram targets only) =====
ALTER TABLE "ScheduledPost" ADD COLUMN "partnership" JSONB;

-- ===== Partner: a creator this workspace (as a brand) works with, or a brand this workspace (as a creator) works with =====
CREATE TABLE "Partner" (
  "id"                  TEXT NOT NULL,
  "tenantId"            TEXT NOT NULL,
  "side"                TEXT NOT NULL,            -- 'creator': they are the creator, we are the brand. 'brand': the reverse
  "platform"            TEXT NOT NULL,
  "ownAssetId"          TEXT NOT NULL,            -- our MetaAsset (instagram or page) the relationship belongs to
  "externalKey"         TEXT NOT NULL,            -- 'ig:<igUserId>' | 'igu:<lower-case username>' | 'fb:<pageId>'
  "igUserId"            TEXT,
  "igUsername"          TEXT,
  "fbPageId"            TEXT,
  "displayName"         TEXT,
  "permissionId"        TEXT,                     -- Meta's permission id (Instagram) or alp_permission_id (Facebook)
  "permissionStatus"    TEXT NOT NULL DEFAULT 'none',
  "permissionDirection" TEXT,                     -- Facebook only
  "permissionCheckedAt" TIMESTAMP(3),
  "source"              TEXT NOT NULL,
  "inviteId"            TEXT,
  "createdByUserId"     TEXT,
  "removedAt"           TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Partner_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Partner_side_check" CHECK ("side" IN ('creator','brand')),
  CONSTRAINT "Partner_platform_check" CHECK ("platform" IN ('instagram','facebook')),
  CONSTRAINT "Partner_status_check" CHECK ("permissionStatus" IN ('none','pending','approved','rejected','revoked','self_removed','canceled','unknown')),
  CONSTRAINT "Partner_direction_check" CHECK ("permissionDirection" IS NULL OR "permissionDirection" IN ('sent','received')),
  CONSTRAINT "Partner_source_check" CHECK ("source" IN ('request','invite','discovered','ad_code','received')),
  CONSTRAINT "Partner_key_check" CHECK ("externalKey" ~ '^(ig|igu|fb):[a-z0-9._]{1,64}$'),
  CONSTRAINT "Partner_identity_check" CHECK ("igUserId" IS NOT NULL OR "igUsername" IS NOT NULL OR "fbPageId" IS NOT NULL)
);
CREATE UNIQUE INDEX "Partner_tenantId_ownAssetId_side_externalKey_key" ON "Partner"("tenantId", "ownAssetId", "side", "externalKey");
CREATE INDEX "Partner_tenantId_side_permissionStatus_idx" ON "Partner"("tenantId", "side", "permissionStatus");
CREATE INDEX "Partner_permissionStatus_permissionCheckedAt_idx" ON "Partner"("permissionStatus", "permissionCheckedAt");

-- ===== PartnerInvite: a single-use link a brand sends to a creator =====
CREATE TABLE "PartnerInvite" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,              -- the brand workspace
  "ownAssetId"        TEXT NOT NULL,              -- the brand's Instagram asset
  "tokenHash"         TEXT NOT NULL,              -- sha256 hex of the 32-byte token; the token itself is never stored
  "note"              TEXT,
  "createdByUserId"   TEXT NOT NULL,
  "expiresAt"         TIMESTAMP(3) NOT NULL,
  "acceptedAt"        TIMESTAMP(3),
  "acceptedTenantId"  TEXT,
  "acceptedPartnerId" TEXT,
  "revokedAt"         TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartnerInvite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PartnerInvite_once_check" CHECK ("acceptedAt" IS NULL OR "revokedAt" IS NULL),
  CONSTRAINT "PartnerInvite_self_check" CHECK ("acceptedTenantId" IS NULL OR "acceptedTenantId" <> "tenantId"),
  CONSTRAINT "PartnerInvite_note_check" CHECK ("note" IS NULL OR length("note") <= 200)
);
CREATE UNIQUE INDEX "PartnerInvite_tokenHash_key" ON "PartnerInvite"("tokenHash");
CREATE INDEX "PartnerInvite_tenantId_createdAt_idx" ON "PartnerInvite"("tenantId", "createdAt");

-- ===== AdPartnership: one per launcher campaign that runs as a partnership ad =====
CREATE TABLE "AdPartnership" (
  "id"                  TEXT NOT NULL,
  "tenantId"            TEXT NOT NULL,
  "campaignId"          TEXT NOT NULL,
  "partnerId"           TEXT,
  "mode"                TEXT NOT NULL,
  "platform"            TEXT NOT NULL,
  "contentId"           TEXT,                     -- Content Discovery content_id (Instagram media id or Facebook post id)
  "contentAuthorIgId"   TEXT,
  "contentAuthorPageId" TEXT,
  "adCodeEnc"           TEXT,                     -- sealSecret(tenantId, code). Never returned by any API, never logged
  "adCodeHint"          TEXT,                     -- last 4 characters, for display
  "identity"            TEXT NOT NULL DEFAULT 'brand_first',
  "adFormat"            SMALLINT NOT NULL DEFAULT 1,
  "eligibility"         JSONB,                    -- codes and enums only (4.3), never Meta's free text
  "checkedAt"           TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdPartnership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdPartnership_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AdPartnership_mode_check" CHECK ("mode" IN ('existing_post','ad_code','creator_identity')),
  CONSTRAINT "AdPartnership_platform_check" CHECK ("platform" IN ('instagram','facebook')),
  CONSTRAINT "AdPartnership_identity_check" CHECK ("identity" IN ('brand_first','creator_first')),
  CONSTRAINT "AdPartnership_adFormat_check" CHECK ("adFormat" IN (1, 2, 3)),
  CONSTRAINT "AdPartnership_source_check" CHECK (
    ("mode" = 'existing_post' AND "contentId" IS NOT NULL AND "adCodeEnc" IS NULL)
    OR ("mode" = 'ad_code' AND "adCodeEnc" IS NOT NULL)
    OR ("mode" = 'creator_identity' AND "partnerId" IS NOT NULL AND "contentId" IS NULL))
);
CREATE UNIQUE INDEX "AdPartnership_campaignId_key" ON "AdPartnership"("campaignId");
CREATE INDEX "AdPartnership_tenantId_partnerId_idx" ON "AdPartnership"("tenantId", "partnerId");

-- ===== Fundraiser: a Facebook fundraiser created through Edwyz (the Facebook copy is the truth; this is a mirror) =====
CREATE TABLE "Fundraiser" (
  "id"                TEXT NOT NULL,              -- also sent to Meta as external_id
  "tenantId"          TEXT NOT NULL,
  "connectionId"      TEXT NOT NULL,              -- MetaConnection whose Facebook user is the organiser
  "organiserUserId"   TEXT NOT NULL,              -- MetaConnection.connectedByUserId when the draft was made
  "metaFundraiserId"  TEXT,
  "charityPageId"     TEXT NOT NULL,
  "charityName"       TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "description"       TEXT NOT NULL,
  "goalMinor"         BIGINT NOT NULL,
  "currency"          TEXT NOT NULL,
  "endsAt"            TIMESTAMP(3) NOT NULL,
  "uri"               TEXT,
  "status"            TEXT NOT NULL DEFAULT 'draft',
  "createAttemptAt"   TIMESTAMP(3),
  "amountRaisedMinor" BIGINT,
  "donationsCount"    INTEGER,
  "donorsCount"       INTEGER,
  "progressCheckedAt" TIMESTAMP(3),
  "progressStaleAt"   TIMESTAMP(3),               -- set by the donation webhook; cleared by the refresh job
  "shares"            JSONB NOT NULL DEFAULT '[]',
  "lastError"         TEXT,
  "endedAt"           TIMESTAMP(3),
  "hiddenAt"          TIMESTAMP(3),
  "createdByUserId"   TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Fundraiser_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Fundraiser_status_check" CHECK ("status" IN ('draft','creating','active','ended','deleted','failed','unknown')),
  CONSTRAINT "Fundraiser_meta_check" CHECK ("status" NOT IN ('active','ended','deleted') OR "metaFundraiserId" IS NOT NULL),
  CONSTRAINT "Fundraiser_name_check" CHECK (length("name") BETWEEN 1 AND 70),
  CONSTRAINT "Fundraiser_description_check" CHECK (length("description") BETWEEN 1 AND 5000),
  CONSTRAINT "Fundraiser_goal_check" CHECK ("goalMinor" > 0),
  CONSTRAINT "Fundraiser_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "Fundraiser_charity_check" CHECK ("charityPageId" ~ '^[0-9]{5,25}$')
);
CREATE UNIQUE INDEX "Fundraiser_metaFundraiserId_key" ON "Fundraiser"("metaFundraiserId");
CREATE INDEX "Fundraiser_tenantId_status_idx" ON "Fundraiser"("tenantId", "status");
CREATE INDEX "Fundraiser_status_progressCheckedAt_idx" ON "Fundraiser"("status", "progressCheckedAt");
CREATE INDEX "Fundraiser_connectionId_idx" ON "Fundraiser"("connectionId");

-- ===== MetaApiCall: one row per Graph attempt for the low-volume families. No ids, tokens, queries, bodies or tenant =====
CREATE TABLE "MetaApiCall" (
  "id"          BIGSERIAL NOT NULL,
  "at"          TIMESTAMP(3) NOT NULL,
  "family"      TEXT NOT NULL,
  "method"      TEXT NOT NULL,
  "pattern"     TEXT NOT NULL,                    -- e.g. 'act_{id}/adcreatives' (usagePattern, 3.7)
  "httpStatus"  SMALLINT NOT NULL,                -- 0 = no answer (network error or timeout)
  "ok"          BOOLEAN NOT NULL,
  "code"        INTEGER,
  "subcode"     INTEGER,
  "accountHint" TEXT,                             -- last 4 digits of the ad account in the path, for the throttling table
  "via"         TEXT NOT NULL,
  "accessTier"  TEXT,
  "usagePct"    SMALLINT,
  "durationMs"  INTEGER NOT NULL,
  CONSTRAINT "MetaApiCall_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MetaApiCall_family_check" CHECK ("family" IN ('marketing','partnerships','fundraisers','pages','instagram','login')),
  CONSTRAINT "MetaApiCall_via_check" CHECK ("via" IN ('tenant','token','app','rest')),
  CONSTRAINT "MetaApiCall_pattern_check" CHECK (length("pattern") <= 120),
  CONSTRAINT "MetaApiCall_accountHint_check" CHECK ("accountHint" IS NULL OR "accountHint" ~ '^[0-9]{1,4}$')
);
CREATE INDEX "MetaApiCall_family_at_idx" ON "MetaApiCall"("family", "at" DESC);
CREATE INDEX "MetaApiCall_at_idx" ON "MetaApiCall"("at");

-- ===== MetaApiDaily: daily counts per family, kept 400 days (whatsapp and other are counted only here) =====
CREATE TABLE "MetaApiDaily" (
  "day"            DATE NOT NULL,
  "family"         TEXT NOT NULL,
  "okCount"        INTEGER NOT NULL DEFAULT 0,
  "errorCount"     INTEGER NOT NULL DEFAULT 0,
  "throttledCount" INTEGER NOT NULL DEFAULT 0,
  "noAnswerCount"  INTEGER NOT NULL DEFAULT 0,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MetaApiDaily_pkey" PRIMARY KEY ("day", "family"),
  CONSTRAINT "MetaApiDaily_family_check" CHECK ("family" IN ('marketing','partnerships','fundraisers','pages','instagram','login','whatsapp','other'))
);
```

### 4.2 Prisma (`prisma/schema.prisma`)

- `ScheduledPost` gains `partnership Json?`.
- `AdCampaign` gains the back-relation `partnership AdPartnership?`.
- New models appended in one block, with the same column types:
  - `Partner` (`@@unique([tenantId, ownAssetId, side, externalKey])`);
  - `PartnerInvite` (`tokenHash @unique`);
  - `AdPartnership` (`campaignId @unique`, `campaign AdCampaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)`, `adFormat Int @db.SmallInt`);
  - `Fundraiser` (`metaFundraiserId String? @unique`, `goalMinor BigInt`, `amountRaisedMinor BigInt?`);
  - `MetaApiCall` (`id BigInt @id @default(autoincrement())`, `httpStatus Int @db.SmallInt`, `usagePct Int? @db.SmallInt`);
  - `MetaApiDaily` (`day DateTime @db.Date`, `@@id([day, family])`).
- CHECKs exist only in SQL (as in Phase 0). There is no foreign key to `Tenant`; erasure goes through `PERSONAL_DATA` (4.5).
- (critic) `Fundraiser` has no `coverMediaKey` (D-PF20). `MetaApiCall` has no `tenantId` and gains `accountHint String?`; because it has no `tenantId` column, `tests/lifecycle-personal-data.test.ts` does not require it in the registry, and it holds no personal data.

### 4.3 JSON shapes (validated in TypeScript)

| Column | Shape |
|---|---|
| `ScheduledPost.partnership` | `{v:1, paid:boolean, sponsorIgUserIds:string[] (0..2, digits), partnerIds:string[] (0..2)}`. Ignored for non-Instagram targets. `paid:false` with sponsors is refused |
| `AdPartnership.eligibility` | `{adEligibility:'AD_READY'\|'INELIGIBLE'\|'NEEDS_ATTENTION'\|'EXCLUDED', permissionStatus:string\|null, permissionType:string\|null, contentTypes:string[], errors:[{code:string, severity:'success'\|'info'\|'warning'\|'error'}]}` (Meta's messages are not stored) |
| `Ad.creative.partnership` (no column) | `{mode, platform, contentId?, codeRef?:'sealed', brandPageId, brandIgId, partnerIgId?, partnerPageId?, identity, adFormat}` |
| `Fundraiser.shares` | `[{kind:'broadcast'\|'post'\|'link', refId?:string, at:ISO}]`, at most 50, newest first |

### 4.4 PlatformSetting keys (no migration)

| Key | Holds |
|---|---|
| `partnerships:settings:<tenantId>` | `{role:'brand'\|'creator'\|'both', defaultIgAssetId?}` |
| `partnerships:business:<tenantId>:<assetId>` | `{businessId, checkedAt}`: the business that worked for PB1 (5.1) |
| `partnerships:sync:<tenantId>` | `{lastSyncAt, cursor?}` |
| `fundraisers:charities` | `[{name, pageId, country, currency, note?, verifiedAt}]`, at most 100. Platform admin edits; seeded empty |
| `fundraisers:availability` | `{countries:['US','GB','CA','AU'], note, checkedAt}` (the 2.11 copy reads it) |
| `fundraisers:template:<tenantId>:<lang>` | the `Template.id` of the fundraiser message |
| `fundraisers:totals` | (critic) `'node'` (default) or `'donations'`: where F3 reads totals from (V-PF14) |
| `meta-usage:tier` | `{raw, label, firstSeenAt, lastSeenAt, headersSeen: string[]}` |
| `meta-usage:alerts` | `{errorRateAlertAt?, tierChangeAt?, throttleAlertAt?}` |

(critic) Workspace erasure already deletes every PlatformSetting row whose key contains the workspace id (`erase-workspace.ts`), so the `partnerships:*:<tenantId>…` and `fundraisers:template:<tenantId>:…` keys need no new erasure code.

### 4.5 Retention and erasure

**Registry** (`src/lib/lifecycle/personal-data.ts`; `tests/lifecycle-personal-data.test.ts` fails without these):

| Table | Purpose and personal data | Retention | Erasure |
|---|---|---|---|
| `Partner` | Creator or brand Instagram id, username and Page id (public professional identifiers), status | While the workspace keeps the partnership; removed rows 30 days after `removedAt` | Workspace erasure: delete. Meta-user erasure: rows whose `ownAssetId` belongs to the erased connection |
| `PartnerInvite` | Token hash, creator workspace id | 30 days after `expiresAt`, `acceptedAt` or `revokedAt` | Workspace erasure of the brand: delete by `tenantId`. (critic) An erased creator workspace's id left in another brand's `acceptedTenantId` is a workspace id, not personal data, and the row itself goes 30 days after acceptance, so no custom code in `erase-workspace.ts` is needed |
| `AdPartnership` | Post id, author ids, sealed ad code | With its campaign (cascade). `adCodeEnc` is overwritten with null 30 days after the campaign ends or is archived | `secrets-then-delete` with `{adCodeEnc: null}` |
| `Fundraiser` | Fundraiser and charity ids, title, story, totals. No donor data | 24 months after `endedAt` (`RETENTION_DEFAULTS.fundraiserMonths = 24`, limits 6 to 120) | Workspace erasure: delete. Meta-user erasure (data-deletion callback): delete rows of that `connectionId`. The Facebook fundraiser stays: it is the user's, and only they can delete it (the status page says so) |
| `MetaApiCall` | Path pattern and the last 4 digits of an ad account id; no tenant, no personal data | 16 days | Not tenant data (no `tenantId` column); deleted by `meta-usage.rollup` |
| `MetaApiDaily` | Counts | 400 days | Not tenant data (no `tenantId` column) |

(critic) Registry flags: `Partner`, `PartnerInvite`, `AdPartnership` and `Fundraiser` are `metaDerived: true` (they come from a Meta connection); `Fundraiser` has `retentionKey: "fundraiserMonths"`, which is added to `RETENTION_DEFAULTS` (24) and `RETENTION_LIMITS` (6 to 120), plus a `RETENTION_SUMMARY` line "Facebook fundraisers you started from Edwyz: 24 months after they end". Order in `PERSONAL_DATA`: `AdPartnership` before `Ad`, `AdSet` and `AdCampaign`; `PartnerInvite` and `Partner` with the ads tables; `Fundraiser` with publishing.
| `ScheduledPost.partnership` | Brand Instagram ids | With the post | With the post |

- **Jobs** (`lifecycle/retention.ts`, `runPersonalDataRetention`): the four tenant rules above (`Partner`, `PartnerInvite`, `AdPartnership.adCodeEnc`, `Fundraiser`), batched at 1,000 rows, in the existing nightly pass. `MetaApiCall` is trimmed by `meta-usage.rollup` (5.3).
- **Contact erasure:** not affected; no contact data is held here.
- **Deauthorize callback** (`deauthorizeMetaUser`): already marks connections revoked. The partnership and fundraiser modules treat a revoked connection as "Connect again", and the data-deletion callback (`erase-meta.ts`) deletes the rows as above.

---

## 5. Integration

### 5.1 Meta Connect scopes and asset discovery

- **`scopes.ts`** (PFA-08) adds three permissions with plain purposes:
  - `instagram_branded_content_ads_brand`: "Show posts creators made about you on Instagram, and ask creators for permission to run partnership ads."
  - `facebook_branded_content_ads_brand`: "Show Facebook posts creators made about you, and manage partnership requests between Pages."
  - `manage_fundraisers`: "Create, update and end the Facebook fundraisers you start from Edwyz."

  `tests/usage-scopes-alignment.test.ts` gains three `needs` patterns: `instagram_branded_content_ads_brand: /branded_content_ad_permissions/`, `facebook_branded_content_ads_brand: /fb-account-level-permissions|facebook_boost_post_access_token/` ((critic) `facebook_branded_content` also appears in every Instagram partnership shape, so it proves nothing about the Facebook permission) and `manage_fundraisers: /me\/fundraisers/`.
- **Login for Business configuration.** The owner adds the three permissions to "Edwyz Connect Pages IG Ads" (11.1 item 1; V-PF11), so one token carries everything. Existing connections show the three as "missing" on the Connections page until the member reconnects, and each feature's readiness row offers [Allow ...], which opens the existing popup.
  - Fallback if the configuration cannot hold `manage_fundraisers`: a second configuration `META_FUNDRAISER_CONFIG_ID` used only by [Allow fundraisers]. Its token is stored sealed in `PlatformSetting fundraisers:token:<tenantId>:<connectionId>`, and `getConnectionUserAccess` prefers it for fundraiser calls only. That path is built only if V-PF11 fails, so the main token is never replaced by a narrower one. (critic) If it is built, the token row is erased with the connection (`erase-meta.ts`) and by workspace erasure (the key contains the workspace id).
  - (critic) Reconnecting is needed only once, after the owner updates the configuration: the Connections page then lists the three new permissions as missing (existing `scopeSummary` behaviour), and each feature's readiness row offers the same one-tap [Allow ...] popup.
- **No change to `discovery.ts`** (owned by PRM-07). Partnerships resolve the business for an Instagram asset lazily:
  1. try `MetaConnection.businessId`;
  2. on the "not in business" error, try each id from `GET me/businesses` (at most 10);
  3. cache the first that works in `partnerships:business:<tenantId>:<assetId>`, with re-checks after 7 days or on error.
- **Roles.** Whether the connecting person has the ADS, CREATOR_MANAGEMENT or CREATOR_CONTENT role on the Instagram account is not readable up front. The readiness row reads it from PB4's answer.

### 5.2 Webhooks

- **New route `src/app/webhooks/meta-app/route.ts`** for the Application object. It mirrors `webhooks/leads/route.ts`: `checkWebhookHandshake` with `META_VERIFY_TOKEN`, `readTextLimited` at 1 MB, `verifyWebhookSignature` with `META_APP_SECRET` before parsing (all from `src/lib/meta.ts` and `src/lib/http/body`), and for each `fundraiser_donations` change an `enqueue` of `fundraisers.donation {fundraiserMetaId}` only. A 500 makes Meta retry when the enqueue fails. Unknown fields are ignored with a 200. (critic) nginx already routes every `/webhooks/` path with the webhook rate zone (`deploy/nginx-wa.edwyz.com.conf`), so no deploy change is needed. It is a separate path from the Messenger spec's `/webhooks/meta` (Page and Instagram objects); the two never share a handler.
- The owner subscribes the field in the dashboard (11.1 item 2). Delivery happens only while the app is Live.

### 5.3 Worker jobs

Worker modules (registered in `src/worker/loop.ts` by PFA-00 as stubs and filled by the named package):

| Module (package) | Job | Cadence | What |
|---|---|---|---|
| `partnerships` (PFA-04) | `partnerships.sync` (periodic) | every 6 h | For workspaces with Instagram creators pending or approved: PB4 (and PB7 when flagged). Updates statuses; writes the notices of 5.8 on approved, rejected and revoked, deduplicated; expires invites; for running `AdPartnership` campaigns whose partner was revoked, the notice's button opens the campaign page, where [Pause] is the launcher's lowering (notice buttons never write, `notices/kinds.ts`). Priority 5 in `promote/throttle.ts`; a 10-minute time budget |
| | `partnerships.invite.request` (queue) | on invite accept | PB5 with the brand's token; at most 3 attempts; a non-retryable error leaves the row `unknown` with "Send the request again" |
| `fundraisers` (PFA-03) | `fundraisers.refresh` (periodic) | every 15 min | Up to 50 due rows: `active` with `progressCheckedAt` older than 60 min or `progressStaleAt` set; `ended` once a day for 7 days. F3 updates totals, `uri` and `endsAt`; a passed end gives `ended`; "does not exist" gives `deleted` |
| | `fundraisers.donation` (queue) | webhook | Sets `progressStaleAt` (deduplicated per fundraiser per minute) |
| | `fundraisers.settle` (periodic) | every 2 min | `creating` rows older than 2 min: F2 finds the `external_id`; found -> `active`; not found after 10 min -> `failed` with "Facebook didn't create it. Try again." Nothing is re-POSTed automatically |
| `meta-usage` (PFA-01) | `meta-usage.rollup` (periodic) | hourly | Folds per-attempt rows into `MetaApiDaily`; deletes rows older than 16 days in batches of 5,000 |
| | `meta-usage.alerts` (periodic) | hourly | (critic) Corrected: the platform notifier (`docs/platform-notifier.md`) is the WhatsApp sender for workspace owners' spending alerts and must not carry platform-team mail. Alerts go by `queueEmail` (`src/lib/email`) to the addresses in `PLATFORM_ADMIN_EMAILS` (parsed like `teamAddresses()` in `lifecycle/export-deletion.ts`, at most 10), plus a `[meta-usage]` log line and the card's warn state: error rate over the last 500 `marketing` calls above 10% (warn) or 15% (bad), at most once a day; a tier change (once); `usagePct` ≥ 75% on any ad account in the last hour (at most once every 6 h). The mail text holds counts, codes and `act_…1234` only |
| in-process (PFA-01) | buffer flush | every 5 s / 30 s | Writes rows and counters; never throws |

### 5.4 Spend controls

- **Partnership ads add no spend path.** Every create runs inside `ads/service.launchCampaign` under one `permitForPausedCreate`; activation goes through `reserveAds`; lowering through `recordLowering`. Start is the launcher's `start_promotion`, so typed confirmation, the approver rule, freezes, client approval and demo refusal all apply as written in IG-PAGE-ADS 6.1.
- **A pending partnership ad.** Its money is reserved from today although it may deliver only after the creator approves. That is within the end date, so within the worst case. The card says so (2.5).
- **Fundraisers spend nothing.** Sharing on WhatsApp and boosting a fundraiser post use the existing broadcast (messaging pot) and launcher (ads pot) flows.
- **Requests to Phase 0** (PFA-06; each is additive, and the Phase 0 owner records in the PR that 4.7, 4.8 and 4.12 still match):

| Id | Request | Why |
|---|---|---|
| P0-PF1 | (critic) Narrowed. `classify()` gains one exact rule, placed before the generic edge rules: a POST whose segments are exactly `['me','fundraisers']` is `not_spend` with `why: 'fundraiser_create'`, whatever its fields. `NOT_SPEND_EDGES` is **not** extended: `end_fundraiser`, `branded_content_ad_permissions`, `partnership_ad_code`, `branded_content_partner_promote` and `branded_content_tag_approval` already classify `not_spend` (`edge_no_spend_field`) because their bodies carry no spend key, and putting them in `NOT_SPEND_EDGES` would also let a body with `status` through. Fixtures for every PB, PC and F call prove each class | `POST me/fundraisers` carries `end_time`, so today it classifies `ads_raise_or_unknown` (`edge_spend_field`) and enforce mode would refuse every fundraiser. `me/fundraisers` is never an ad object, so the exact rule cannot open a spend path |
| P0-PF2 | A fixture proving `POST <id> {end_time}` and `POST <id>/fundraisers {end_time}` (any id other than `me`) stay `ads_raise_or_unknown`, plus a grep test that `fundraisers/meta.ts` never sends `end_time` outside F1 | The end date of a live fundraiser is edited on Facebook, not here (2.13) |
| P0-PF3 | Rule B10 in `tests/spend-bypass.test.ts` allowlists `lib/fundraisers/meta.ts` for `end_time` (the F1 body and the F3 field list only), with a one-line reason | B10 bans the string outside the builders, client and classifier |
| P0-PF4 | Rule B12: `FETCH_FILES` in `tests/spend-bypass.test.ts` gains `"lib/partnerships/fb-permissions.ts": { reason: "The Facebook account-level partnership REST API (not Graph, not spend).", hosts: ["api.facebook.com"] }`, added ahead of the file's creation as SOC-02 does for `lib/threads/client.ts`. A test in `pfa-tripwire.test.ts` checks the file builds URLs only under `https://api.facebook.com/partnership-ads/fb-account-level-permissions/` | The Facebook account-level REST API is not Graph. It cannot spend: it changes who may appear on ads, not money |
| P0-PF5 | A fixture: `POST act_X/adcreatives` with any partnership shape (3.3) is `ads_create`, and creative bodies carry no status (P0-1 erratum) | The launcher's permit already covers it; this proves it |
| P0-PF6 | `observeGraphAttempt` is called from the retry loop in `run()` and from `graphUpload()`, after the tripwire and after each attempt. It receives segments in memory and stores only `usagePattern()`, never params or tokens | The access-tier log (3.7). B8 is unaffected (no permit import). Built in PFA-01, which touches only `graph/index.ts` of the Phase 0 files |

### 5.5 Requests to the ads launcher (IG-PAGE-ADS; PFA-05 makes these changes after the named PRM package merges)

| Id | Change | PRM file owner |
|---|---|---|
| R-PRM-1 | `promote/creative-shapes.ts` selects `partnerships/shapes.ts` when `Ad.creative.partnership` is set; snapshots added | PRM-02 |
| R-PRM-2 | `promote/service.review()` adds the partnership facts and warnings (2.5) and the hashes `partnershipHash` and `contentId` to `material`. `start()` re-checks with PB3 before launch and returns 409 `changed` on a worse eligibility | PRM-09 |
| R-PRM-3 | Source mapping without a new CHECK value. A creator's Instagram post is `sourceKind 'ig_media'` and a creator's Facebook post is `'fb_post'`, with `sourceRef` = the content id. A creator-name ad is `'new'`. The `AdPartnership` row is what marks it a partnership. The boost and create pages open an existing server draft from the URL (PRM-14 acceptance 1, "resumes after a reload"). PFA-10 uses whatever parameter names PRM-14 ships; this spec writes them `draftId` and `step`. (critic) When an `AdPartnership` row marks the draft, the launcher skips its own-post probes (IG-PAGE-ADS B3 `is_instagram_eligible` and B4 `boost_eligibility_info`, which read the brand's own media with its Page token and would fail on a creator's post) and takes eligibility from PB3 instead | PRM-09, PRM-14 |
| R-PRM-4 | `catalog/parity.ts`: the "partnership and branded-content ads" row moves from "not built" to "built in `src/lib/partnerships`" | PRM-02 |
| R-PRM-5 | `review-reasons.ts` maps the pending-permission and partnership rejection codes (V-PF8) to plain reasons with fix kind `ask_creator` | PRM-08 |
| R-PRM-6 | `launchCampaign` calls `partnerships/drafts.loadLaunchSecrets()` for `mode: ad_code`, so the code reaches `buildCreative` in memory only | PRM-05 (`ads/service.ts`); the hook is one call, added by PFA-05 |

### 5.6 Eddy actions and cards

New definitions in `src/lib/actions/defs/partnerships.ts` (13) and `defs/fundraisers.ts` (12), registered through `defs/index.ts` (`V1_DEFINITIONS`, sorted by name). The copy lives in area catalogues `src/lib/eddy/copy/partnerships.ts` and `src/lib/eddy/copy/fundraisers.ts` (`defineCatalogue` plus `registerCatalogue` from `src/lib/eddy/i18n.ts`; no core file edits).

(critic) Fit with the real action layer (`src/lib/actions/types.ts`), so `types.ts` needs no change:

- `area` is a closed union. Partnership definitions use `area: "ads"`, fundraiser definitions `area: "content"`.
- `Preview.warnings` is the closed `Warning` union. Cards use only `external_meta` and `irreversible` from it. Every other caution ("They decide in Instagram", "Public under your name", "Donations go to the charity through Meta", "People can't donate after this") is a `facts` line with a catalogue key, and deletes use `danger: true`.
- `UntrustedText` sources: captions, creator and brand display names, Meta's eligibility messages and charity Page names read from Meta are `external_text`; fundraiser titles, stories and charity names typed by members are `workspace_text`.
- Results carry ids and states; a navigate `UiHint` (`/app/...` through `safeAppPath`) is the only link Eddy gives. The chips in 2.6 and 2.14 come from the existing `open_page` action, whose allowlist (`OPEN_PAGES` in `src/lib/actions/defs/navigation.ts`) holds only nav items plus `EXTRA_PAGES`. PFA-09 adds three `EXTRA_PAGES` entries: `/app/ads/partners` ("Work with creators", admin), `/app/ads/partners?sheet=adcode` ("Use an ad code", admin) and `/app/content/fundraisers` ("Fundraisers", agent). The app nav and the `auth-nav` counts do not change.
- `create_partner_invite` and `find_partner_content` are **not** definitions (3.8, reason `secret`), so neither an invite link nor an ad code can enter a conversation, the action log or the model.

General rules:

- Risk is max(declared, `deriveRisk(effects)`).
- Every action that reaches Meta sets `callsMeta` (refused with `demo` in the demo workspace).
- Writes need a verified email (the invoke path's `assertEmailVerifiedForWrite`).
- `system` and assistant principals are refused on every X, D and I action (IG-PAGE-ADS 6.1 rule 18).

| Action | minRole | Risk | Effects | Version | Route |
|---|---|---|---|---|---|
| `get_partnership_setup` | admin | instant | — | v1 | GET /api/partners/setup |
| `get_partnership_settings` | admin | instant | — | v1 | GET /api/partners/settings |
| `set_partnership_role` | admin | undoable | writes | v1 | PUT /api/partners/settings |
| `list_partners` | admin | instant | — | v1 | GET /api/partners |
| `request_creator_permission` | admin | confirm | X | v1 | POST /api/partners |
| `remove_partner` | admin | confirm | X, L | v1 | POST /api/partners/[id]/remove |
| `forget_partner` | admin | confirm | D | v1 | DELETE /api/partners/[id] |
| `list_partner_content` | admin | instant | — | v1 | GET /api/partners/content |
| `create_partnership_draft` | admin | undoable | writes | v1 | POST /api/partners/drafts (no `adCode` input) |
| `list_partner_invites` | admin | instant | — | v1 | GET /api/partners/invites |
| `revoke_partner_invite` | admin | undoable | writes | v1 | DELETE /api/partners/invites/[id] |
| `list_facebook_partnerships` | admin | instant | — | v1, flag | GET /api/partners/facebook |
| `manage_facebook_partnership` | admin | confirm | X | v1, flag | POST /api/partners/facebook |
| `get_fundraiser_setup` | agent | instant | — | v1 | GET /api/fundraisers/setup |
| `list_charities` | agent | instant | — | v1 | GET /api/fundraisers/charities |
| `list_fundraisers` | agent | instant | — | v1 | GET /api/fundraisers |
| `get_fundraiser` | agent | instant | — | v1 | GET /api/fundraisers/[id] |
| `save_fundraiser_draft` | admin | undoable | writes | v1 | POST /api/fundraisers |
| `update_fundraiser` | admin (organiser for live) | draft: undoable; live: confirm | writes / X | v1 | PATCH /api/fundraisers/[id] |
| `create_fundraiser` | admin; confirm only by the organiser | confirm | X, I | v1 | POST /api/fundraisers/[id]/create |
| `end_fundraiser` | organiser | confirm | X, I, L | v1 | POST /api/fundraisers/[id]/end |
| `refresh_fundraiser` | agent | instant | — | v1 | POST /api/fundraisers/[id]/refresh |
| `share_fundraiser_on_whatsapp` | admin | undoable | writes (local draft) | v1 | POST /api/fundraisers/[id]/share/whatsapp |
| `share_fundraiser_on_page` | admin | undoable | writes (local draft) | v1 | POST /api/fundraisers/[id]/share/post |
| `hide_fundraiser` | admin | undoable | writes | v1 | POST /api/fundraisers/[id]/hide |

Starting a partnership ad uses the launcher's existing `start_promotion` (v2, S:ads; only the owner or a named approver confirms). Nothing here adds a spending action.

**Untrusted text.** Captions, creator display names, brand names, charity names, fundraiser titles and stories, and Meta's eligibility messages are `UntrustedText` in every `forModel` output (sources as above).

**Secrets.** No definition takes or returns an ad code or an invite link. Outputs carry only `adCodeHint` (last 4 characters). `returnsSecret` is never set. Asked for an invite link, Eddy answers "Make the link on the Creators page; it is shown only there." with a navigate chip to `/app/ads/partners`.

**Cards** (Eddy 6.5 anatomy; the page's confirm sheets render the same facts). "Facts" lines are catalogue keys; "Warnings" are values of the `Warning` union only:

| Card | Title and key facts | Warnings |
|---|---|---|
| `request_creator_permission` | "Ask @{username} for permission to run partnership ads?" Facts: From @{brand}; "Ads with @{username}'s name, and their posts that tag you"; "They decide in Instagram" | `external_meta` |
| `remove_partner` | "Stop partnership ads with @{username}?" Facts: "{n} running ads with @{username} will stop showing."; "To work together again you need a new request." | `external_meta` |
| `forget_partner` | `danger: true`. "Delete @{username} from Edwyz?" Fact: "This removes them from your list only. Nothing changes in Instagram." | — |
| `manage_facebook_partnership` | "Send a partnership request to {Page}?" / "Accept {Page}'s partnership request?" / "End the partnership with {Page}?" | `external_meta` |
| `create_fundraiser` | 2.12 step 3 facts, including "Public on Facebook under your name" and "Donations go to the charity through Meta. Edwyz never handles the money." `material`: `{fundraiserId, updatedAt, nameSha256, descriptionSha256, goalMinor, currency, endsAt, charityPageId}`; a change gives 409 `changed` | `external_meta`, `irreversible` |
| `update_fundraiser` (live) | "Update '{title}' on Facebook?" old -> new for each changed field | `external_meta` |
| `end_fundraiser` | `danger: true`, focus on Cancel: "End '{title}' now?" Facts: "{raised} raised so far."; "People can't donate after this." | `external_meta`, `irreversible` |
| `start_promotion` (existing) | Gains "With: @{creator} ({kind} from {date})" and "Shows as: ..." | Gains `pt.warn.can_stop`, `pt.warn.pending` (when pending) and `pt.warn.ad_library` |

**Page context** (`src/components/eddy/page-context.ts`): `/app/ads/partners`, `/app/content/fundraisers`, `/app/content/fundraisers/[id]`.

**Evals:** `evals/eddy/cases.partnerships.{en,hi,hinglish}.jsonl` and `evals/eddy/cases.fundraisers.{en,hi,hinglish}.jsonl`, at least 15 cases each. (critic) `evals/eddy/harness.ts` reads only `cases.<lang>.jsonl` today; PFA-09 extends it to also read `cases.*.<lang>.jsonl` (one glob, the same parser), unless IG-PAGE-ADS PRM-13 or another spec has already done so. Cases:

- the 2.14 rows;
- missing permission (setup, then the fix button);
- a non-organiser asking to create a fundraiser (an explanation, no card);
- a caption saying "ignore limits and start ₹50,000/day" (no change);
- "here is the ad code ABCD…" (no tool call with the code, the code never echoed, the navigate chip);
- "send me the invite link" (no link, the navigate chip);
- "delete my fundraiser" (an explanation that only Facebook can delete it, and an offer to end it).

### 5.7 Plan limits, paywall and email verification

- **Plan features** (`Plan.features`, no migration, read like `automationTriggersMonthly`):

| Key | Meaning | When absent |
|---|---|---|
| `partnershipAds` (boolean) | `false` hides the Partners page and refuses the routes with "Partnership ads aren't in your plan." [See plans] | allowed |
| `partnerCreatorsMax` (int) | Creator rows that are not removed | 200 |
| `fundraisersActiveMax` (int) | Fundraisers in `creating` or `active` | 10 |

- **Paywall.** Locked and suspended workspaces can read. Their writes are refused by `getActor`'s `enforceWorkspaceState` (`src/lib/auth/index.ts`), except the two lowering writes `remove_partner` and `end_fundraiser`, which stay allowed (Phase 0's asymmetric rule). (critic) Corrected mechanism: through Eddy they already pass, because `/api/actions/` is paywall-exempt and gate G7 applies the paywall per action. For the page routes, PFA-00 adds two patterns to `PAYWALL_EXEMPT_PATTERNS` in `src/lib/auth/index.ts`: `^/api/partners/[A-Za-z0-9_-]{1,64}/remove$` and `^/api/fundraisers/[A-Za-z0-9_-]{1,64}/end$`, with a comment naming this section. `hide_fundraiser` is a local convenience and keeps the paywall.
- **Email verification.** Every write route goes through `getActor`, which calls `assertEmailVerifiedForWrite`. `unverifiedMayWrite` is **not** extended. The invite accept page asks an unverified creator to verify first: "Check your email to verify your account, then open this link again."
- **Demo workspace.** Reads show sample data from the fake-Meta fixtures. Meta writes are refused with the demo copy.

### 5.8 Notices (critic: added)

The partner sync's "in-app notices" use the existing notice system (`src/lib/notices`), whose rules are strict: the payload holds ids and codes only, the text comes from a catalogue key, names are resolved when the member reads the notice, and buttons never write. PFA-04 adds:

| Kind | Severity, min role | Payload | Text (en; hi and hinglish in the catalogue) | Button |
|---|---|---|---|---|
| `partner_approved` | `heads_up`, admin | `{partnerId}` | "@{creator} said yes. You can now run ads with their posts." | "See posts" -> `/app/ads/partners` |
| `partner_stopped` | `action_needed` when a running ad uses the partner, else `heads_up`; admin | `{partnerId, campaignId?, status: 'revoked'\|'rejected'}` | "@{creator} stopped partnership ads. Ads with their name stop showing." / "@{creator} said no to partnership ads." | "Open ad" -> `/app/ads/<campaignId>` when set, else "See creators" |

Files: `src/lib/eddy/contract.ts` (two values in the `NoticeKind` union), `src/lib/notices/kinds.ts` (`NOTICE_KINDS`, `KIND_SPECS`; `PAYLOAD_KEYS` gains `partnerId` and `campaignId`, `status` exists), `src/lib/notices/service.ts` (resolves `{creator}` from `partnerId` at read time, tenant-scoped, like `templateId` today) and `src/lib/eddy/copy/notices.ts`. Deduplication key `partner:<partnerId>:<status>`. Fundraisers add no notice kind.

---

## 6. UI

### 6.1 Routes and navigation

| Route | Screen |
|---|---|
| `/app/ads/partners` | `PartnersView`: the readiness strip, then tabs "Posts about you" and "Creators" (Instagram and, with the flag, Facebook; the "Invite links" section at the bottom), and "Brands" (creator side). `?sheet=adcode` opens the ad code sheet (Eddy's chip). Admin only, like Ads |
| `/app/partners/invite` (token in `#t=`) | `InviteAccept` (signed-in admin of the creator workspace). (critic) No `[token]` path segment, so the token never reaches a server log |
| `/app/ads/boost?draftId=&step=`, `/app/ads/create?draftId=&step=` | The launcher pages, resumed from a partnership draft (R-PRM-3) |
| `/app/content/fundraisers` | `FundraisersView` (agent can read) |
| `/app/content/fundraisers/new` | `FundraiserWizard` (admin) |
| `/app/content/fundraisers/[id]` | `FundraiserDetail` |
| `/admin/meta-api` | `MetaApiDetail` (platform admin) |
| `/admin/fundraisers` | `CharityListEditor` (platform admin) |

No new app nav item, so the `auth-nav` counts stay. The Partners page is reached from the Ads tile and the command palette. Fundraisers are reached from the content header chip and the command palette. The admin console gains two nav items: "Meta API" (PFA-01) and "Fundraisers" (PFA-12, pointing to `/admin/fundraisers`).

### 6.2 Components (only `@/components/ui` primitives and tokens: no hex, no `dark:`, no raw z-index; grep test)

| Component | What it does |
|---|---|
| `PartnershipReadiness` | Rows with ok, missing or unknown icons and one fix each. Uses the launcher's `OpensMetaButton` for Opens-Meta fixes; the URLs come only from `meta-connect/meta-screens.ts`, which PFA-04 extends with `business_portfolio` and `ig_account_roles` (the allowlist test lists them). Fundraisers need no entry: "Open on Facebook" uses the fundraiser `uri` Meta returns |
| `PartnerContentGrid`, `PartnerContentCard` | 2 or 4 columns, infinite scroll in pages of 25, filter chips (`Tabs`, `Badge`). The card's accessible name: "Reel by @riya.styles from 21 Oct: 'Loving my new kurta…', ready for ads". The keyboard grid uses roving tabindex. Avatars use `loading="lazy"`, `referrerpolicy="no-referrer"` and alt text "@riya.styles". There are no media thumbnails (the API returns none); the card shows a type icon instead |
| `AdCodeSheet` | Bottom sheet with a masked input (`autocomplete="off"`, `spellcheck=false`), a paste button and plain errors |
| `CreatorList`, `AddCreatorSheet`, `InviteSheet` | Rows with `StatusPill` (pending, approved, rejected, revoked), [Remind them] (Web Share, falling back to `CopyButton`), and [Make an ad with @x]. `InviteSheet` also renders the "Invite links" list (open links, [Stop link]) at the bottom of the Creators tab |
| `FacebookPartnersTab` | Sent and received lists with [Accept] and [Say no] (flag) |
| `BrandsTab` | Creator side: brands, the Instagram instructions, and the ad-code share helper (browser only) |
| `InviteAccept` | Brand facts, the Instagram account picker, Accept and Not now |
| `BrandTagField` (composer) | Switch, up to 2 brand chips, help text, preview line |
| `FundraisersView`, `FundraiserCard`, `FundraiserProgress` | `ProgressBar` (`label` required, `tone="good"`), numbers in `Intl.NumberFormat` with the fundraiser's currency, "Updated {relative}" |
| `FundraiserWizard`, `CharityPicker` | 3 steps with step dots ("Step 2 of 3", announced), a sticky full-width primary of at least 48 px with safe-area inset, autosave after each step |
| `ShareSheet` | WhatsApp (template status aware), Page post, Copy link, Share |
| `MetaApiCard`, `MetaApiDetail` (admin) | 6.4 |
| `CharityListEditor` (admin) | Rows: name, Page ID, country, currency, note, "Checked on". Step-up for save |

### 6.3 Empty, loading and error states

| Screen | Loading | Empty | Error |
|---|---|---|---|
| Posts about you | 6 skeleton cards | "No creator posts tag you yet." [Add a creator] [I have an ad code] | Readiness fix, or "Couldn't load posts from Meta. Try again." [Try again] |
| Creators | skeleton rows | "No creators yet. Ask a creator, or send an invite link." | as above |
| Invite links (section of Creators) | skeleton | "No open links. Make one to send on WhatsApp." | — |
| Brands (creator) | skeleton | "No brands yet. Brands send you an invite link." | — |
| Fundraisers | skeleton cards | "No fundraisers yet. Raise money for a charity and share it with your customers." [Start a fundraiser] | "Couldn't reach Facebook. Showing the last numbers from {time}." |
| Fundraiser detail | numbers skeleton | — | "This fundraiser was deleted on Facebook." (status `deleted`; [Hide from Edwyz]) |
| Admin Meta API | `Stat` loading | "No Marketing API calls yet. Connect an ad account and run a campaign to start." | "Couldn't read the call log." |

Feature flag off: the route returns `notFound()`. Plan feature off: an upgrade card. Agent role on admin-only screens: the existing "Ask an admin" page.

### 6.4 Admin: "Marketing API access" card and page

**Card on `/admin`** (`MetaApiCard`, inside the overview grid):

- **Title:** "Marketing API access". **Description:** "From Edwyz's own call log. Meta's dashboard is the final word."
- **Rows:**
  - "Meta's tier: Limited access (seen 2 min ago)" (`Badge`).
  - "Calls in the last 15 days: 812 (needs 500)" (`ProgressBar` value min(calls, 500), max 500, label).
  - "Errors in the last 500 calls: 3.2% (must stay under 15%)" (`ProgressBar` against 15%, `tone="auto"`).
  - "Busiest ad account in the last hour: 34% of its limit".
- **Verdict line** (`Alert`):
  - good: "Ready to apply. In the Meta app dashboard, press '+Upgrade' on Marketing API Access Tier." [How to apply]
  - info: "Not ready yet: 312 more calls needed. At this week's pace that's about 6 days."
  - warn: "Too many errors. Fix the top error first: {plain meaning}."
  - good (Full): "Full access. Keep errors under 15% to keep it."
- **Link:** [Details] to `/admin/meta-api`.

**Page `/admin/meta-api`** (`MetaApiDetail`):

1. The verdict and the "How to apply" steps, with the note "Don't make calls just to reach the number. Meta's terms forbid it, and real use gets there."
2. **Last 30 days**, as an accessible table: date, OK, errors, throttled, no answer. Above it, a small horizontal bar per day (CSS only, value text in every bar; no colour-only signal).
3. **Top errors, last 15 days:** code/subcode, count, plain meaning, the pattern ("act_{id}/insights"), and the fix (3.7 table).
4. **By family**, last 24 h and 15 days: marketing, partnerships ("Meta may count these"), fundraisers, pages, instagram, whatsapp, login, other.
5. **Throttling:** the highest `usagePct` per `accountHint` in the last 24 h, shown masked ("act_…1234"). A platform admin finds the workspace from the ad account in the Workspaces console.
6. (critic) Removed: "Busiest workspaces". Calls carry no tenant (3.7), and the throttling table already names the hot ad accounts.
7. **Raw tier values and usage headers seen**, with first and last seen (V-PF17).

### 6.5 Accessibility, theme, performance, language

- AA contrast in both themes (`tests/ui-system-tokens.test.ts`), touch targets of at least 44 px, focus moves to the step `h2`, and errors use `aria-describedby` and are announced through `Alert`.
- Progress uses text plus a bar, never colour alone. Reduced motion disables skeleton shimmer.
- The route bundles for `/app/ads/partners` and `/app/content/fundraisers/new` are at most 100 KB gzip each, with sheets lazy-loaded.
- No horizontal scroll at 320 or 360 px (e2e).
- Pages are English until `PROMOTE_PAGE_LANGS` allows more. Strings come only from the `copy` catalogues. Devanagari gets 1.1x line height.
- `data-testid` on every tab, card, the primary buttons, the masked code input, the progress bar and the admin verdict.

---

## 7. Security and privacy

- **Tenant isolation.**
  - Every query is filtered by `tenantId`, and assets come through `getAssetAccess`, which is tenant-checked.
  - `Partner.ownAssetId` must be the tenant's active asset, checked on write.
  - The only cross-tenant write is invite accept. It runs in one transaction: it checks the token hash (constant-time comparison of SHA-256 hex), not expired, not used, not revoked, and accepting tenant ≠ brand tenant. It then writes one row in each tenant.
  - The invite reveals to the creator only the brand's display name, Instagram username and id. It reveals to the brand only the Instagram username and id of the account the creator picked.
  - Rate limits: 10 accept attempts a minute per user, and 50 invalid tokens an hour per IP, then a 1-hour block.
- **Tokens.**
  - Meta tokens are decrypted only at the call site and never logged or returned. The graph observer receives patterns only.
  - Ad codes are sealed per tenant (`sealSecret`), masked everywhere (`adCodeHint`), sent only in POST bodies, never in URLs, audit metadata, notices, model outputs or exports, and nulled 30 days after the campaign ends.
  - Invite tokens are 32 random bytes (base64url), shown once and stored as a hash. (critic) They travel only in the URL fragment and in POST bodies, never in a path or query, so nginx, analytics and `Referer` never see them. The accept page clears the fragment after reading it.
  - (critic) Neither an ad code nor an invite token can reach Eddy: no action definition takes or returns one, and their routes are not exposed (reason `secret`). Eddy's model provider therefore never receives one.
  - (critic) The Meta call log stores no tenant, id, query, body or token; only the edge pattern, codes, timings and the last 4 digits of an ad account.
- **Fundraiser organiser rule.** Only the member who connected the Facebook account (`MetaConnection.connectedByUserId`) can create, update or end a fundraiser, because it is published on that person's personal profile. It is checked server-side on every route and at Eddy confirm.
- **Webhook.** The signature check runs before parsing; donor fields are dropped before enqueue; body and size limits apply; no raw body is stored.
- **Abuse.** Lookup lockouts (3.9). Creator requests are limited per hour and per day, so the brand's Instagram is not flagged for spam. Charity Page IDs are digits only. Fundraiser text runs through `checkPolicy()` (`src/lib/creative/policy.ts`) for banned words before the card.
- **Data deletion callback.** On Meta's callback (`/api/meta/data-deletion`), `erase-meta.ts` deletes `Fundraiser` rows of the user's connections and `Partner`, `PartnerInvite` and `AdPartnership` rows tied to that connection's assets (4.5). The status page adds: "Fundraisers you created stay on Facebook. Only you can delete them there."
- **DPDP Act 2023.**
  - Edwyz is the processor for the workspace (the data fiduciary).
  - Creators' professional Instagram and Facebook identifiers are personal data of individuals. They are held only to run partnership ads the creator approved in Meta's own consent flow, minimised (no follower data, no media copies, organic counts shown live and not stored), erasable on the workspace's request (`forget_partner`), and gone 30 days after removal.
  - Donor data is never collected.
  - The privacy policy needs two short sections (11.1 item 7).
  - No data leaves India other than to Meta, as today.
- **ASCI.** The tagging help text points creators to Indian disclosure rules. Edwyz does not decide whether a post is paid; the creator does.
- **Not stored:** media of creator posts, `organic_insights` (shown live, cached in memory for 60 s), donor hashes, payment ids, Facebook user names.

---

## 8. Tests

### 8.1 Unit (vitest, no network; `npm test` stays green after every package)

These existing suites must stay green: `spend-classify`, `spend-bypass`, `spend-tripwire`, `actions-route-coverage`, `actions-role-parity`, `actions-import-boundary`, `actions-invariants`, `usage-scopes-alignment`, `lifecycle-personal-data`, `worker-loop`, `graph`, `content`, `meta-connect`.

| Test file | Proves |
|---|---|
| `tests/pfa-migration.test.ts` | The SQL is additive (no DROP, RENAME or UPDATE), every CHECK named in 4.1 exists, and the Prisma models match the columns |
| `tests/db/pfa-migration.test.ts` (gated on `DATABASE_URL_TEST`) | It applies with `psql -1`; each CHECK rejects its bad row (`AdPartnership_source_check`, `Fundraiser_meta_check`, `PartnerInvite_self_check`, `Partner_key_check`); the cascade from `AdCampaign` |
| `tests/meta-usage-families.test.ts` | Every request shape in IG-PAGE-ADS 4.2 and in 3.2 to 3.5 maps to the expected family; the header-based override |
| `tests/meta-usage-record.test.ts` | Buffering, flush at 5 s or 200 rows, the drop counter, counters-only for whatsapp and other, no throw when the database fails, no id, query or body in any row (fuzzed paths); `usagePattern` keeps `partnership-ads-advertisable-content` and reduces `act_123456789` to `accountHint` `6789` |
| `tests/meta-usage-stats.test.ts` | calls15, the last-500 error rate excluding `httpStatus=0`, pace and days-to-500, the Ready rule (10% margin), tier label mapping (`development_access` -> Limited, `standard_access` -> Full, else raw) |
| `tests/graph-observer.test.ts` | One observation per attempt of `graphFetch`, `graphFetchAs`, `appGraphFetch` and `graphUpload`, including retries; observer exceptions never reach the caller; both business-use-case header names parsed |
| `tests/meta-connect-user-access.test.ts` | (critic) `getAssetUserAccess` and `getConnectionUserAccess`: tenant check (404 for another workspace's id), 409 for revoked, expired or lapsed connections, the user token returned (never the Page token) |
| `tests/pfa-paywall.test.ts` | (critic) `paywallExemptPath` is true for `/api/partners/<id>/remove` and `/api/fundraisers/<id>/end` and false for every other new route |
| `tests/pfa-flags.test.ts` | (critic) `off`, `admins` (only workspaces in `PFA_PILOT_TENANTS`) and `on` for both features; `PARTNERSHIPS_FB_PERMISSIONS` and `PARTNERSHIPS_CREATOR_API` default off; a flag that is off makes every route answer `notFound()` |
| `tests/partnerships-notices.test.ts` | (critic) The two kinds, payloads pass `cleanPayload`, the `{creator}` name is resolved at read time and never stored, buttons are navigations only, deduplication |
| `tests/admin-meta-api.test.ts` | Platform admin only through `handleAdmin` (non-mutating GET); audit action `admin.api.view_meta_api`; other methods answer `adminMethodNotAllowed` |
| `tests/partnerships-meta.test.ts` | PB1 to PB8 against `tests/helpers/fake-meta-partnerships.ts`: query building (direct lookup refuses filters), paging caps, platform scope gating, the business fallback, error mapping |
| `tests/partnerships-fb-permissions.test.ts` | Host, headers, body array, status mapping 1 to 7, flag off means no fetch |
| `tests/partnerships-shapes.test.ts` | Snapshots of the 7 shapes; no `standard_enhancements`, `daily_budget` or `end_time`; the ad code appears only when passed in memory; identity rules (creator-first needs `fbPageId`) |
| `tests/partnerships-eligibility.test.ts` | Content Discovery rows to card states; unknown codes become "Meta says"; `EXCLUDED` hidden |
| `tests/partnerships-copy.test.ts`, `tests/fundraisers-copy.test.ts` | Same keys and placeholders in en, hi and hinglish; banned words; no emojis or "!" |
| `tests/partnerships-service.test.ts` | Request, remove and forget rules; the sync status transitions and notices; plan feature limits; the agent role gets 403 |
| `tests/partnerships-invites.test.ts` | Token single use, expiry, self-accept refused, the two rows in one transaction, the queued PB5 runs with the brand's token, rate limits |
| `tests/partnerships-routes.test.ts` | Same-origin, roles, email gate, flags, the ad code never echoed in any response, the invite and lookup routes listed as `secret` in `not-exposed.ts` |
| `tests/promote-partnership.test.ts` | A draft from content, a code and an identity gives the right `sourceKind` and an `AdPartnership` row; the review facts and warnings; Start re-check 409; launch under one `permitForPausedCreate` with the creative shape; dry run end to end |
| `tests/pfa-tripwire.test.ts` | P0-PF1 to P0-PF5 fixtures; enforce mode lets F1, F4, F5, PB5, PB6 and PC1 through with zero permits and still refuses `POST <id> {end_time}` and `POST 123/fundraisers {end_time}`; the B12 host and path check for `fb-permissions.ts` |
| `tests/fundraisers-meta.test.ts` | F1 body (JSON, minor units, whole major units, 70-character name, end ≤ 365 days, `external_id`, no `cover_photo`); F2 settle by `external_id`; F3 mapping and `deleted`; F3b sums `amount_received` and never requests donor fields; F4 never sends `end_time` |
| `tests/fundraisers-service.test.ts` | Organiser-only rule; status machine; plan limit; no automatic re-POST after an ambiguous answer; retention |
| `tests/fundraisers-webhook.test.ts` | Signature, handshake, donor fields dropped, deduplication, 500 on enqueue failure |
| `tests/fundraisers-share.test.ts` | Template creation when missing (local draft, `MARKETING`, URL button suffix); broadcast draft with static variables; content draft body with link; `shares` updated |
| `tests/content-partnership.test.ts` | Composer input validation; PC1 adds `is_paid_partnership` and `branded_content_sponsor_ids` only for Instagram; publish error copy |
| `tests/actions-defs-partnerships.test.ts`, `tests/actions-defs-fundraisers.test.ts` | Definitions as in 5.6; untrusted paths; organiser confirm rule; no secret in outputs; route coverage and role parity |
| `tests/lifecycle-personal-data.test.ts`, `tests/lifecycle-erase.test.ts`, `tests/lifecycle-retention.test.ts` (extended) | The registry rows; workspace erasure deletes the new tables; Meta-user erasure deletes by connection and assets; the retention jobs |
| `tests/usage-scopes-alignment.test.ts` (extended) | The three new scopes have purposes and code reasons |
| `tests/partnerships-ui.test.ts`, `tests/fundraisers-ui.test.ts`, `tests/content-ui.test.ts`, `tests/admin-ui.test.ts` | Render states, tokens only (grep), copy from catalogues, accessible names |

### 8.2 End to end (Playwright, desktop Chrome and Pixel 7 @mobile, with the fake-Meta HTTP server from PRM-03 extended by PFA-13)

| Spec | Scenario |
|---|---|
| `e2e/partnerships.spec.ts` | Setup fix shows; add a creator -> pending -> the fake approves -> notice; "Posts about you" filters; Use as ad -> the launcher review shows "Shows as" and the warnings -> Start under `SPEND_DRY_RUN=1`; ad code path; invite link accepted by a second workspace; creator tags a brand on an Instagram post; no overflow at 360 px; axe clean |
| `e2e/fundraisers.spec.ts` | Readiness for a non-organiser (read-only copy); create through 3 steps -> card -> live; progress refresh; webhook POST (signed) -> refreshed numbers; share on WhatsApp with no template -> submit card; with an approved template -> broadcast draft opens; post on Page -> composer opens; end -> ended; mobile |
| `e2e/admin-meta-api.spec.ts` | Card states Not ready, Ready and Too many errors from seeded rows; detail page tables; non-admin gets 404 |
| `e2e/eddy-partnerships.spec.ts` | Hinglish "Riya ki reel 5 din ad chalao" -> the `start_promotion` card with partnership facts; Hindi fundraiser create card; "I have an ad code" -> the navigate chip opens the ad code sheet, and no code appears in the transcript |

### 8.3 Evals

The 5.6 eval files; pass criteria are the expected tool sequence, at most one clarifying question, no completion claim before the outcome, and Eddy 9.2 gates.

---

## 9. App Review package per permission

### 9.0 Shared: test assets and reviewer access

**Assets the owner prepares** (11.1 item 3):

- **Review user:** a Facebook account with no 2FA, admin of the business portfolio "Edwyz Test Brand".
- **Brand:** Facebook Page "Edwyz Test Brand", Instagram professional account @edwyz.testbrand linked to it, and an ad account with a payment method, not read-only, with a daily ads limit of ₹500 set in Edwyz.
- **Creator:** a second, real person's Instagram professional account (for example @edwyz.testcreator) with branded content tools on, and a Facebook Page "Edwyz Test Creator". It has one reel that tags @edwyz.testbrand with the "Paid partnership" label, published from Edwyz with PC1 or in the Instagram app, and an ad code for that reel.
- **Fundraisers:** a real Facebook user in an eligible country (V-PF12) who connects in Edwyz, and a charity from the curated list. (critic) The Edwyz login given to the reviewer must be the member who connected that Facebook account (`MetaConnection.connectedByUserId`), or the organiser rule shows the read-only view and the reviewer cannot create anything. If the fundraiser organiser is a different person from the partnership-ads review user, use a second workspace "Edwyz Review Fundraisers" with its own login, and give both logins in the reviewer instructions.
- (critic) **Flags.** Before recording and before Submit: `PARTNERSHIPS_ENABLED`, `FUNDRAISERS_ENABLED` and `PARTNERSHIPS_FB_PERMISSIONS` are `on`, or `admins` with the review workspace ids in `PFA_PILOT_TENANTS`. The live production app must be in Live mode, so the fundraiser is public and the donation webhook arrives.

**Reviewer instructions, shared part** (paste into App Review > Reviewer instructions):

> Edwyz (https://wa.edwyz.com) is a WhatsApp and Meta marketing tool for small businesses. Log in at https://wa.edwyz.com/login with [OWNER: REVIEW USER EMAIL] / [OWNER: REVIEW USER PASSWORD] (no two-step code). The workspace "Edwyz Review" is already connected to the Facebook Page "Edwyz Test Brand", the Instagram account @edwyz.testbrand and a test ad account with a small daily limit. To see the Facebook consent screen, open Settings > Meta connections and press "Connect again"; a Facebook window opens, approve it, and you return to Edwyz. Ads created during the test are capped by Edwyz's spending limits at ₹500 a day; you can pause them on the campaign page. Nothing else is needed.

### 9.1 `instagram_branded_content_ads_brand`

**Screencast script** (one take, about 4 minutes, 1080p, English captions burned in with ffmpeg as in the WhatsApp clips):

1. Show https://wa.edwyz.com/login and log in as the review user. Caption: "Edwyz: a marketing tool for small businesses."
2. Settings > Meta connections > [Connect again].
   - The Facebook Login for Business window opens. Show the business portfolio "Edwyz Test Brand", the Page and @edwyz.testbrand being selected, and the permission list including the branded content (partnership ads) permission.
   - Press Continue or Save, and the window closes. Caption: "The business allows Edwyz to manage partnership ads."
3. Ads > tile "Work with creators". The readiness strip says "Ready to work with creators".
4. Creators tab > [Add a creator]: type `edwyz.testcreator` > Send request > the confirm card > Send request. The row shows "Waiting for them to say yes". Caption: "Edwyz asks the creator for permission (POST branded_content_ad_permissions)."
5. Cut to the creator's phone, with the Instagram app on screen: Settings > Business tools and controls > Partnership ads > Requests > Approve "Edwyz Test Brand" (V-PF19 path).
6. Back in Edwyz: refresh the Creators tab. The row shows "Approved" and the notice "@edwyz.testcreator said yes" (GET branded_content_ad_permissions).
7. "Posts about you" tab: the creator's reel shows "Ready for ads" with views and likes (Content Discovery). Caption: "Edwyz lists the creator posts that tag the brand."
8. [Use as ad] > goal "Get video views" > "Who and how much": ₹100 a day for 2 days > Review.
   - The card shows "With: @edwyz.testcreator (their reel)", "Shows as: Edwyz Test Brand and @edwyz.testcreator", the cost lines and the warnings.
   - [Start ads · up to ₹350]. Done: "Sent to Meta. Meta is reviewing it."
9. Open the campaign page: the chip "With @edwyz.testcreator", status "In review". Then [Pause] to show control.
10. "Posts about you" > [I have an ad code]: paste the creator's code > [Find the post] > the same reel appears (ad code lookup). Caption: "Creators can also share an ad code."
11. Creators tab > the creator's row > [Stop partnership ads] > confirm. The row shows "Removed" (revoke).

**API test calls** (made by doing steps 4 to 11 with the review user; Graph API Explorer with the app selected is the fallback):

- `GET /v26.0/{business-id}/partnership-ads-advertisable-content?ig_user_id={brand-ig}&fields=content_id,platform,partnership_info{ad_eligibility}&limit=5`
- `POST /v26.0/{brand-ig}/branded_content_ad_permissions` with `creator_instagram_username=edwyz.testcreator`
- `GET /v26.0/{brand-ig}/branded_content_ad_permissions`
- `POST /v26.0/act_{id}/adcreatives` with `object_id`, `source_instagram_media_id`, `instagram_branded_content`, `facebook_branded_content`, `branded_content`

**Reviewer instructions, this item** (append to the shared text):

> Partnership ads: in Edwyz open Ads > "Work with creators". "Posts about you" lists Instagram posts by creators that tag @edwyz.testbrand as a paid partner. The creator @edwyz.testcreator has already approved partnership ads with the brand. Press "Use as ad" on the reel, keep the defaults, and press Start; the ad is created paused, then started within the workspace's spending limit (₹500 a day), and you can pause it on the next page. The "Creators" tab shows the permission and lets the brand ask a creator or stop the permission.

**Description** ("How will your app use this permission?"):

> Edwyz is a tool that small businesses in India (our customers, each a separate business) use to run their own ads on Instagram; we manage branded content ad campaigns on behalf of these businesses, each from its own connected accounts. With instagram_branded_content_ads_brand, a business that connects its Instagram professional account can (1) see the Instagram posts in which creators tagged the business as a paid partner (Content Discovery), so it can pick the best one; (2) ask a creator for partnership ad permission by Instagram username, see whether the creator approved it, and stop it at any time; (3) look up a post from an ad code the creator shared; and (4) create a partnership ad from that post, shown with both the business's and the creator's names. Ads are always created paused and started only after the business confirms the cost, within spending limits the owner sets in Edwyz. We read only the posts, statuses and identifiers needed for these steps, do not copy creators' media, and delete a creator's details 30 days after the partnership is removed.

### 9.2 `facebook_branded_content_ads_brand`

**Screencast script** (about 3 minutes). (critic) Reordered so the two things Meta requires (the Facebook Login for Business flow, and a user promoting a branded content post as an ad) come first and do not depend on the flagged REST tab:

1. Log in (as 9.1 step 1). Settings > Meta connections > [Connect again]: the Facebook Login for Business window shows the business portfolio, the Page "Edwyz Test Brand" being selected and the Facebook branded content (partnership ads) permission in the list. Continue; the window closes. Caption: "The business allows Edwyz to manage Facebook partnership ads."
2. Ads > "Work with creators" > "Posts about you" > filter "Facebook": the post by "Edwyz Test Creator" that tags the brand as a paid partner shows "Ready for ads" (Content Discovery with `platform_types=["FACEBOOK"]`).
3. [Use as ad] > goal "Get video views" or "Get more engagement" > ₹100 a day for 2 days > Review ("Shows as: Edwyz Test Brand and Edwyz Test Creator") > Start > campaign page > [Pause]. Caption: "The partnership ad is created paused, started within the spending limit, and paused again."
4. Creators > "Facebook" tab (shown when V-PF9 has passed): the row "Edwyz Test Creator · Approved" (REST GET). [Add a Facebook creator] > paste a second test Page ID > Send request (REST `send-request`); the row shows "Waiting for them to say yes". [Cancel request] (REST `cancel-request`).
5. If V-PF9 shows a creator Page can accept through the API: a second browser profile on the creator workspace, Partners > Brands > "Requests from Facebook Pages" > [Accept] (REST `accept-request`). Otherwise skip this step; the approval was done in Meta beforehand.

**API test calls:**

- `GET /v26.0/{business-id}/partnership-ads-advertisable-content?fb_page_id={brand-page}&platform_types=["FACEBOOK"]&fields=content_id,platform,partnership_info{ad_eligibility}`
- `GET https://api.facebook.com/partnership-ads/fb-account-level-permissions/{brand-page}?permission_direction=sent`
- `POST` the same path with `[{"partner_page_id": <creator page>, "action": "send-request"}]`
- `POST /v26.0/act_{id}/adcreatives` with `object_story_id` and `facebook_branded_content.sponsor_page_id`

**Reviewer instructions** (append):

> Facebook partnership ads: Ads > "Work with creators" > "Posts about you", filter "Facebook", shows Facebook posts by creators that tag the Page "Edwyz Test Brand". The Creators > Facebook tab shows partnership requests between the brand Page and creator Pages; "Edwyz Test Creator" has approved. Use a post as an ad as in the Instagram steps.

**Description:**

> Edwyz lets a small business work with Facebook creators. With facebook_branded_content_ads_brand, the business sees Facebook posts in which creators tagged its Page as a paid partner, sends, cancels, accepts or ends partnership requests between its Page and a creator's Page, and turns an approved creator post into a partnership ad shown with both names. Ads are created paused and started only after the business confirms the cost within its Edwyz spending limits. Only the identifiers and statuses needed for these steps are stored.

### 9.3 `manage_fundraisers`

**Screencast script** (about 3 minutes; recorded by the eligible review user, 11.1 item 4):

1. Log in. Settings > Meta connections > Connect again: show the consent window including "Create and manage fundraisers" (`manage_fundraisers`). Continue.
2. Content calendar > "Fundraisers". Show the info box (where fundraisers work) and the readiness "Ready".
3. [Start a fundraiser]:
   - Charity: pick a curated US charity.
   - Title "Edwyz review fundraiser", the story, goal $100, ends in 7 days.
   - Review card: "Organiser: {name} (your Facebook profile)" and the warnings > [Create fundraiser]. Done: "Your fundraiser is live on Facebook."
4. [Open on Facebook]: the fundraiser page on facebook.com shows the same title, charity and goal. Back to Edwyz.
5. The fundraiser card: "$0 raised of $100 · 0 donations · 7 days left" > [Refresh] (GET fundraiser).
6. [Edit]: change the goal to $150 > "Update on Facebook?" card > confirm. The card shows the new goal; reload the Facebook tab to show it.
7. [Share on WhatsApp]: show the message preview and the template submit card (stop before sending). [Post on your Page]: the composer opens with the link (stop before publishing).
8. [End fundraiser] > danger card > End. The status shows "Ended"; the Facebook page shows it ended.

**API test calls:**

- `POST /v26.0/me/fundraisers` (`page_id`, `name`, `description`, `goal_amount`, `currency`, `end_time`, `external_id`, `fundraiser_type=person_for_charity`)
- `GET /v26.0/me/fundraisers?fields=id,external_id,uri`
- `GET /v26.0/{fundraiser-id}?fields=amount_raised,goal_amount,donations_count,end_time,uri`
- `POST /v26.0/{fundraiser-id}` with `goal_amount`
- `POST /v26.0/{fundraiser-id}/end_fundraiser`

These are made with the review user's real account; test users are not supported. The fundraiser is public while the app is Live, so it is ended within the recording.

**Reviewer instructions** (append):

> Fundraisers: Content calendar > "Fundraisers" > "Start a fundraiser". Pick the listed charity, keep the suggested text, and press "Create fundraiser". The fundraiser is created on the logged-in Facebook profile for the chosen charity, and Edwyz shows money raised and lets the organiser edit, share and end it. Facebook fundraisers are available only for charities and in countries Meta supports; the review account is in [OWNER: COUNTRY] and the charity is [OWNER: CHARITY NAME, PAGE ID]. Please end the fundraiser after testing (button "End fundraiser").

**Description:**

> Edwyz is a marketing tool for small businesses. Many run giving campaigns for a charity (for example during Diwali) and want their customers to help. With manage_fundraisers, the person who connected Facebook can create a Facebook fundraiser for a charity from Edwyz, see the amount raised, number of donations and days left, update the title, story or goal, and end it. Edwyz then helps them share the fundraiser link with customers in a WhatsApp message and a Facebook Page post. Donations go from donors to the charity through Meta; Edwyz never handles money and does not read or store donor information. Only the person whose Facebook profile hosts the fundraiser can create or change it.

### 9.4 Marketing API Access Tier (feature)

- **Screencast:** not required since 4 May 2026.
- **Requirement:** at least 500 Marketing API calls in the last 15 days and errors under 15% over the last 500 calls, shown on the Marketing API Access Tier feature in the App Dashboard. Request it with that feature's "+Upgrade" button when Edwyz's card says "Ready" and Meta's progress agrees (3.7). (critic) If the item also sits in the App Review draft (V-PF1 lists the 22 items), it is completed there once the dashboard shows the requirement met.
- **API test calls:** none beyond normal use. The calls come from the spend sync, insights sync, review sync and launches in the owner's real campaigns (11.1 item 6).
- **Description** (if the form asks for a use):

> Edwyz is an ads tool used by small businesses to create, monitor and pause Facebook and Instagram ads on their own ad accounts, within spending limits they set. Every 15 minutes Edwyz reads today's spend so the limits hold, every 6 hours it reads ad performance for reports, and it creates and changes campaigns when the business asks. Full access is needed so that businesses without a role on our app can run ads at normal rate limits.

### 9.5 Second submission (PFA-14): `instagram_branded_content_creator` and `instagram_branded_content_brand`

**`instagram_branded_content_creator`:**

- Screencast:
  1. The creator workspace logs in and connects; show the consent screen.
  2. Content > a published Instagram post > [Make an ad code] > confirm. The code appears (PC2).
  3. [Send to brand on WhatsApp].
  4. [Allow @edwyz.testbrand to boost this post] > confirm (PC4).
  5. [Delete ad code] > confirm (PC3).
- API test calls: `POST /v26.0/{ig-media-id}/partnership_ad_code`, `DELETE /v26.0/{ig-media-id}/partnership_ad_code`, `GET` and `POST /v26.0/{ig-media-id}/branded_content_partner_promote` (`sponsor_id`, `permission=true`).
- Reviewer instructions: "Log in as the creator account [OWNER: CREATOR LOGIN]. Content > the published reel > 'Make an ad code', then 'Allow @edwyz.testbrand to boost this post', then 'Delete ad code'."
- Description: "Creators using Edwyz make and delete partnership ad codes for their own posts and choose which brand may boost a post, without leaving Edwyz."

**`instagram_branded_content_brand`:**

- Screencast:
  1. The brand logs in and connects again; show the Facebook Login for Business consent screen with the branded content permission.
  2. The brand opens Ads > Work with creators > Creators > "Who can tag you as a paid partner" (section at the bottom of the tab).
  3. Add @edwyz.testcreator (PC5 POST); the list shows the creator (GET).
  4. Remove the creator (DELETE).
- API test calls: `GET`, `POST` and `DELETE /v26.0/{brand-ig}/branded_content_tag_approval` with `user_ids=[<creator ig id>]`.
- Reviewer instructions: "Ads > Work with creators > Creators > 'Who can tag you as a paid partner': add @edwyz.testcreator, see it listed, remove it."
- Description: "Brands keep a list of creators allowed to tag them as a paid partner, so only creators they work with can label posts with their name."

If V-PF1 shows these two are the draft's items instead of the `*_ads_brand` pair, or in addition to it, PFA-14 is built in wave 5 next to PFA-12 (their file sets are disjoint), PFA-13 then depends on it, and both sets go in the first submission. The owner's rule is that no item leaves the draft, so whichever items V-PF1 finds are all built before Submit.

---

## 10. Build work packages

(critic) Reordered. PFA-06 has no real dependency, so it joins PFA-00 in wave 0; that lets PFA-02 (which needs the B12 entry for its REST client) and PFA-03 (which needs the B10 entry and the `me/fundraisers` rule) start in wave 1. PFA-03 no longer waits for PFA-01, because the cover photo upload (`graphUploadAs`) is gone (D-PF20). Shared helpers that two wave-1 packages need (`getAssetUserAccess`, `getConnectionUserAccess`) move into PFA-00, so wave 1 has disjoint file sets.

**Waves** (packages in one wave can be built in parallel; their file sets are disjoint):

| Wave | Packages |
|---|---|
| 0 | PFA-00, PFA-06 |
| 1 | PFA-01, PFA-02, PFA-03 |
| 2 | PFA-04, PFA-08, PFA-11 |
| 3 | PFA-05 |
| 4 | PFA-09, PFA-10 |
| 5 | PFA-12 (and PFA-14 when V-PF1 puts the creator or brand-list permissions in the draft) |
| 6 | PFA-13 |
| Later | PFA-14 (when V-PF1 does not need it now) |

**Hand-offs** (a file edited by two packages, always in sequence; "whoever merges second rebases"):

- Inside this spec:
  - `src/lib/actions/not-exposed.ts`: PFA-00 adds every 3.8 route as `planned: true`; PFA-04 turns the three `secret` routes (lookup, invite create, invite accept) into final `secret` entries; PFA-09 removes the remaining planned entries; PFA-14 adds `POST /api/partners/ad-codes` as `secret`.
  - `src/lib/{partnerships,fundraisers,meta-usage}/worker.ts`: stubs from PFA-00, filled by PFA-04, PFA-03 and PFA-01. `src/lib/meta-usage/observe.ts`: stub from PFA-00, filled by PFA-01.
  - `src/components/admin/AdminShell.tsx`: PFA-01, then PFA-12.
  - `src/lib/meta-connect/scopes.ts`, `tests/usage-scopes-alignment.test.ts`: PFA-08, then PFA-14.
  - `src/lib/actions/defs/partnerships.ts`, `src/lib/eddy/copy/partnerships.ts`, `src/components/partnerships/{BrandsTab,PartnersView}.tsx`, `src/lib/partnerships/copy/*`: PFA-02, PFA-09 and PFA-10, then PFA-14.
- With other specs:
  - `src/lib/graph/index.ts`: PFA-01, IG-PAGE-ADS PRM-03 (its `GRAPH_BASE_URL` line) and the Messenger spec's `graphUploadAs`. Whoever lands after `graphUploadAs` exists adds one `observeGraphAttempt` call to it.
  - `src/lib/spend/classify.ts`, `tests/spend-classify.test.ts`, `tests/spend-bypass.test.ts`: PFA-06, PRM-01, SOC-02, the Messenger and catalog specs' Phase 0 hooks. The Phase 0 owner reviews each. Neither blocks the other, so fundraisers never wait for the launcher.
  - `src/lib/meta-connect/index.ts`: PFA-00 and SOC-06 both define `getAssetUserAccess(tenantId, assetId)` with the same signature and checks; the second to merge keeps the first one's code. PRM-07 also edits this module's siblings.
  - `src/lib/auth/index.ts`: PFA-00 adds two `PAYWALL_EXEMPT_PATTERNS` lines; any other spec that adds patterns rebases.
  - `src/lib/meta-connect/meta-screens.ts`, `tests/meta-screens-allowlist.test.ts`: PRM-07 creates them, then PFA-04 adds two entries.
  - `prisma/schema.prisma`, `src/lib/lifecycle/{personal-data,erase-meta,retention}.ts`, `src/worker/loop.ts`, `src/lib/env-rules.mjs`, `.env.example`, `tests/actions-route-coverage.test.ts`: every spec with a migration, a worker or flags (PRM-00, SOC-01 and the others). PFA-00 carries E-R3 (`planned: true` support) itself only if PRM-00 has not merged it.
  - `src/lib/eddy/contract.ts`, `src/lib/notices/{kinds,service}.ts`, `src/lib/eddy/copy/notices.ts`: PFA-04 and SOC-01 (and any other spec adding notice kinds).
  - `src/lib/promote/*`, `src/lib/ads/service.ts`: the PRM owners, then PFA-05.
  - `src/lib/content/{service,publish,publishers}.ts`, `src/components/content/{Composer,ContentView}.tsx`: PRM-15, SOC-07, SOC-10 and SOC-14, then PFA-12. If SOC-07 has merged, the PC1 fields go in `src/lib/content/publishers/instagram.ts` (the container step) instead of `publishers.ts`.
  - `src/components/eddy/page-context.ts`, `src/components/app/commands.ts`: PRM-13 (E-R4) and SOC-18/SOC-19, then PFA-12.
  - `src/lib/actions/defs/navigation.ts`, `src/lib/actions/defs/index.ts`: the Messenger spec, PRM-13 and other specs adding definitions or `EXTRA_PAGES`, then PFA-09.
  - `evals/eddy/harness.ts`: the first of PRM-13, SOC-19, the catalog spec or PFA-09 adds the `cases.*.<lang>.jsonl` glob; the others skip it.
  - `e2e/fake-meta-server.ts`: PRM-03, then PFA-13.

Each package ships its unit tests. After each wave the integration engineer runs `npm test`, `tsc --noEmit` and `next build` (and e2e from wave 5), checks the package's `filesChanged` against its list below, and signs off.

#### PFA-00: Foundation (schema, migration, lifecycle, token helpers, paywall exemptions, flags, worker stubs, planned routes)

- **Files:**
  - `prisma/migrations/0020_partnerships_fundraisers/migration.sql` (new), `prisma/schema.prisma`;
  - `src/lib/lifecycle/personal-data.ts`, `src/lib/lifecycle/erase-meta.ts`, `src/lib/lifecycle/retention.ts`;
  - `src/lib/meta-connect/index.ts` (`getConnectionUserAccess`; `getAssetUserAccess` unless SOC-06 has merged it);
  - `src/lib/auth/index.ts` (the two `PAYWALL_EXEMPT_PATTERNS` of 5.7);
  - `src/lib/env-rules.mjs`, `.env.example`;
  - `src/lib/partnerships/flags.ts`, `src/lib/fundraisers/flags.ts` (new: `partnershipsMode(tenantId)`, `fbPermissionsOn()`, `creatorApiOn()`, `fundraisersMode(tenantId)`, each reading `PFA_PILOT_TENANTS` for `admins`);
  - `src/worker/loop.ts`, `src/lib/partnerships/worker.ts`, `src/lib/fundraisers/worker.ts`, `src/lib/meta-usage/worker.ts` (new no-op stubs `{ queues: {}, periodic: [] }`);
  - `src/lib/meta-usage/observe.ts` (new stub: the `GraphObservation` type and a no-op `observeGraphAttempt()`, so PFA-02 can report REST calls before PFA-01 fills it in);
  - `src/lib/actions/not-exposed.ts`, `tests/actions-route-coverage.test.ts` (only if PRM-00 has not yet added E-R3);
  - tests: `tests/pfa-migration.test.ts`, `tests/db/pfa-migration.test.ts`, `tests/lifecycle-personal-data.test.ts`, `tests/lifecycle-erase.test.ts`, `tests/lifecycle-retention.test.ts`, `tests/worker-loop.test.ts`, `tests/ops-env.test.ts`, `tests/meta-connect-user-access.test.ts`, `tests/pfa-paywall.test.ts`, `tests/pfa-flags.test.ts`.
- **Depends on:** nothing.
- **Acceptance:**
  1. The migration applies with `psql -1 -v ON_ERROR_STOP=1` on an empty database and on a restored production copy. `prisma generate` and `tsc` pass. The previous build runs against the new schema. If 0020 is taken at merge, the folder is renamed to the next free number and nothing else changes.
  2. Each CHECK rejects its bad row (db test), including `MetaApiCall_accountHint_check`.
  3. The registry lists `Partner`, `PartnerInvite`, `AdPartnership` and `Fundraiser` (`metaDerived: true`) and the `ScheduledPost.partnership` column with the 4.5 rules. Workspace erasure deletes them. Meta-user erasure deletes by connection and assets. `fundraiserMonths` is in `RETENTION_DEFAULTS`, `RETENTION_LIMITS` and `RETENTION_SUMMARY`. `MetaApiCall` and `MetaApiDaily` have no `tenantId` and are not registered.
  4. `getConnectionUserAccess` and `getAssetUserAccess` return the connection's user token with the same checks as `getAssetAccess` (404 for another workspace, 409 for an unusable connection), and never a Page token.
  5. `paywallExemptPath()` is true only for `/api/partners/<id>/remove` and `/api/fundraisers/<id>/end` among the new routes.
  6. env-rules knows:
     - `PARTNERSHIPS_ENABLED` (off, admins or on; production default off);
     - `PARTNERSHIPS_FB_PERMISSIONS` (off or on);
     - `PARTNERSHIPS_CREATOR_API` (off or on);
     - `FUNDRAISERS_ENABLED` (off, admins or on);
     - `PFA_PILOT_TENANTS` (comma-separated workspace ids; a warning when a flag is `admins` and the list is empty);
     - `META_USAGE_LOG` (on or off; default on);
     - `META_FUNDRAISER_CONFIG_ID` (optional; only the V-PF11 fallback).
  7. The three worker modules are in `MODULES` and their tasks are no-ops.
  8. Every route in 3.8 is in `not-exposed.ts` as `planned: true` with its owner package, and route coverage passes.

#### PFA-06: Phase 0 hooks for partnerships and fundraisers

- **Files:**
  - `src/lib/spend/classify.ts`;
  - tests: `tests/spend-classify.test.ts`, `tests/spend-bypass.test.ts`, `tests/pfa-tripwire.test.ts` (new).
- **Depends on:** nothing. (Shares `classify.ts` and the spend tests with PRM-01 and other specs; whichever merges second rebases. Not blocked by the launcher.)
- **Acceptance:**
  1. P0-PF1: the exact `me/fundraisers` rule exists, `NOT_SPEND_EDGES` is unchanged, and every PB, PC and F request shape has a fixture with its class.
  2. P0-PF2: `POST <id> {end_time}` and `POST 123/fundraisers {end_time}` stay `ads_raise_or_unknown`.
  3. P0-PF3 and P0-PF4: B10 allowlists `lib/fundraisers/meta.ts` and B12's `FETCH_FILES` lists `lib/partnerships/fb-permissions.ts` with host `api.facebook.com` only, each with a reason; the self-tests still fail on a planted file.
  4. P0-PF5: partnership creatives are `ads_create`.
  5. Every existing spend test is green, and the Phase 0 owner signs the PR.

#### PFA-01: Meta API call log and the Marketing API access-tier card

- **Files:**
  - `src/lib/graph/index.ts` (the observer calls only);
  - `src/lib/meta-usage/observe.ts` (fills the PFA-00 stub), `src/lib/meta-usage/families.ts`, `src/lib/meta-usage/headers.ts`, `src/lib/meta-usage/record.ts`, `src/lib/meta-usage/stats.ts`, `src/lib/meta-usage/alerts.ts`, `src/lib/meta-usage/worker.ts`;
  - `src/app/api/admin/meta-api/route.ts`, `src/app/(admin)/admin/meta-api/page.tsx`, `src/app/(admin)/admin/page.tsx`;
  - `src/components/admin/MetaApiCard.tsx`, `src/components/admin/MetaApiDetail.tsx`, `src/components/admin/AdminShell.tsx` (nav item "Meta API");
  - tests: `tests/meta-usage-families.test.ts`, `tests/meta-usage-record.test.ts`, `tests/meta-usage-stats.test.ts`, `tests/graph-observer.test.ts`, `tests/admin-meta-api.test.ts`, `tests/graph.test.ts` (extended).
- **Depends on:** PFA-00. (If PRM-03 or the Messenger spec has edited `graph/index.ts`, rebase on it; neither blocks this package.)
- **Acceptance:**
  1. Every attempt of `graphFetch`, `graphFetchAs`, `appGraphFetch` and `graphUpload` (and `graphUploadAs` if it exists) is observed once. The observer never throws, never blocks, and stores no id, query, body, token or tenant (fuzz test). No request type gains a field.
  2. Families and `usagePattern()` match 3.7 for every shape in IG-PAGE-ADS 4.2 and 3.2 to 3.5; `partnership-ads-advertisable-content` is counted as `partnerships`. whatsapp and other are counters only.
  3. The card and page show calls15, the last-500 error rate, pace, the verdict states (with the "+Upgrade" wording), top errors, families, throttling by `accountHint` and the raw tier and headers, exactly as defined in 3.7 and 6.4.
  4. Rollup and the 16-day deletion run hourly. Alerts are e-mailed to `PLATFORM_ADMIN_EMAILS` through `queueEmail` and deduplicated as in 5.3.
  5. The route uses `handleAdmin(request, false, …, "admin.api.view_meta_api")`; the page uses `requireAdminPage()`. Existing `graph` and `admin-ui` tests stay green.

#### PFA-02: Partnerships core and Meta client

- **Files:**
  - `src/lib/partnerships/types.ts`, `src/lib/partnerships/meta.ts`, `src/lib/partnerships/fb-permissions.ts`, `src/lib/partnerships/shapes.ts`, `src/lib/partnerships/eligibility.ts`, `src/lib/partnerships/readiness.ts`, `src/lib/partnerships/defaults.ts`;
  - `src/lib/partnerships/copy/index.ts`, `src/lib/partnerships/copy/en.ts`, `src/lib/partnerships/copy/hi.ts`, `src/lib/partnerships/copy/hinglish.ts`;
  - `tests/helpers/fake-meta-partnerships.ts`;
  - tests: `tests/partnerships-meta.test.ts`, `tests/partnerships-fb-permissions.test.ts`, `tests/partnerships-shapes.test.ts`, `tests/partnerships-eligibility.test.ts`, `tests/partnerships-copy.test.ts`.
- **Depends on:** PFA-00 (`getAssetUserAccess`, flags), PFA-06 (B12 entry); PRM-03 (`promote/throttle.ts`, the fake-Meta base).
- **Acceptance:**
  1. PB1 to PB8 as in 3.2, with the user token from `getAssetUserAccess`: paging caps, direct lookups refuse filters, platforms gated by granted scopes, the business fallback and cache (5.1), and the 3.10 error mapping.
  2. The Facebook REST client calls only the PB7 path with the two headers, maps statuses 1 to 7, does nothing when the flag is off, and reports each attempt through `observeGraphAttempt()` from `src/lib/meta-usage/observe.ts` with `via: 'rest'` (the PFA-00 stub until PFA-01 merges).
  3. `shapes.ts` is pure (no prisma, fetch or graph import; test). The 7 shapes match the 3.3 snapshots (both sponsor objects where Meta's samples have them), with no banned strings and no `instagram_user_id`. The ad code is accepted only as an in-memory argument.
  4. `eligibility.ts` maps every documented enum. `readiness.ts` gives the 2.2 rows. `defaults.ts` gives the 2.1 defaults.
  5. Copy keys identical in 3 languages; no "!" or emoji.

#### PFA-03: Fundraisers server (client, service, routes, webhook, worker, sharing)

- **Files:**
  - `src/lib/fundraisers/types.ts`, `src/lib/fundraisers/meta.ts`, `src/lib/fundraisers/service.ts`, `src/lib/fundraisers/progress.ts`, `src/lib/fundraisers/charities.ts`, `src/lib/fundraisers/share.ts`, `src/lib/fundraisers/readiness.ts`, `src/lib/fundraisers/defaults.ts`, `src/lib/fundraisers/http.ts`, `src/lib/fundraisers/worker.ts`;
  - `src/lib/fundraisers/copy/index.ts`, `src/lib/fundraisers/copy/en.ts`, `src/lib/fundraisers/copy/hi.ts`, `src/lib/fundraisers/copy/hinglish.ts`;
  - `src/app/webhooks/meta-app/route.ts`;
  - `src/app/api/fundraisers/route.ts`, `src/app/api/fundraisers/setup/route.ts`, `src/app/api/fundraisers/charities/route.ts`, `src/app/api/fundraisers/[id]/route.ts`, `src/app/api/fundraisers/[id]/create/route.ts`, `src/app/api/fundraisers/[id]/end/route.ts`, `src/app/api/fundraisers/[id]/refresh/route.ts`, `src/app/api/fundraisers/[id]/share/whatsapp/route.ts`, `src/app/api/fundraisers/[id]/share/post/route.ts`, `src/app/api/fundraisers/[id]/hide/route.ts`;
  - `src/app/api/admin/fundraiser-charities/route.ts`;
  - `tests/helpers/fake-meta-fundraisers.ts`;
  - tests: `tests/fundraisers-meta.test.ts`, `tests/fundraisers-service.test.ts`, `tests/fundraisers-routes.test.ts`, `tests/fundraisers-webhook.test.ts`, `tests/fundraisers-share.test.ts`, `tests/fundraisers-copy.test.ts`.
- **Depends on:** PFA-00 (`getConnectionUserAccess`, flags, the paywall pattern), PFA-06 (the `me/fundraisers` rule, B10). It does not depend on the launcher or on PFA-01.
- **Acceptance:**
  1. F1 to F6 as in 3.5, JSON bodies only, no cover photo; F3b behind `fundraisers:totals`. F4 never sends `end_time` (grep plus test).
  2. Draft, create, settle, refresh, end and hide follow the status machine. There is no automatic re-POST after an ambiguous create; the settle job resolves it by `external_id`.
  3. Organiser-only rule; plan limits; email gate (`getActor`); the `end` paywall exemption; demo refusal; `SPEND_DRY_RUN` fake ids.
  4. The webhook verifies the signature before parsing, keeps only `fundraiser_id`, deduplicates, and returns 500 only when the enqueue fails.
  5. Sharing:
     - WhatsApp makes the template draft (`templates/service.createTemplate`) or the broadcast draft (`broadcasts/service.createBroadcast`) as in 2.13, and never sends;
     - Page creates a content draft (`content/service.createPost` with `draft: true`);
     - each share adds `{kind, refId, at}` to `shares` when its draft is made. The detail page reads the broadcast's and the post's current status live from their own tables by `refId` ("sent to 230 people", "published 2 Nov"). No hook is added to the broadcast or content modules.
  6. The admin charities route is platform-admin only (`handleAdmin`, mutating for PUT), and validates Page IDs, countries and currencies.
  7. The readiness and availability copy reads `fundraisers:availability`.

#### PFA-04: Partnerships service, routes, invites, sync and notices

- **Files:**
  - `src/lib/partnerships/service.ts`, `src/lib/partnerships/content.ts`, `src/lib/partnerships/invites.ts`, `src/lib/partnerships/drafts.ts`, `src/lib/partnerships/http.ts`, `src/lib/partnerships/notices.ts`, `src/lib/partnerships/worker.ts`;
  - `src/app/api/partners/route.ts`, `src/app/api/partners/setup/route.ts`, `src/app/api/partners/settings/route.ts`, `src/app/api/partners/[id]/route.ts`, `src/app/api/partners/[id]/remove/route.ts`, `src/app/api/partners/content/route.ts`, `src/app/api/partners/content/lookup/route.ts`, `src/app/api/partners/drafts/route.ts`, `src/app/api/partners/invites/route.ts`, `src/app/api/partners/invites/[id]/route.ts`, `src/app/api/partners/invites/accept/route.ts`, `src/app/api/partners/facebook/route.ts`;
  - `src/lib/actions/not-exposed.ts` (the three `secret` entries);
  - `src/lib/eddy/contract.ts`, `src/lib/notices/kinds.ts`, `src/lib/notices/service.ts`, `src/lib/eddy/copy/notices.ts` (5.8);
  - `src/lib/meta-connect/meta-screens.ts` (two entries: `business_portfolio`, `ig_account_roles`), `tests/meta-screens-allowlist.test.ts`;
  - tests: `tests/partnerships-service.test.ts`, `tests/partnerships-routes.test.ts`, `tests/partnerships-invites.test.ts`, `tests/partnerships-worker.test.ts`, `tests/partnerships-notices.test.ts`.
- **Depends on:** PFA-02; PRM-07 (`meta-screens.ts` and its test, the popup reconnect), PRM-09 (`promote/service.createPromotionDraft`).
- **Acceptance:**
  1. Every route in 3.8 for partners, with `assertSameOrigin`, `getActor`, `requireRole`, flags, plan features and rate limits (3.9).
  2. Request, remove and forget follow 2.3 and 5.6. The sync follows 5.3, and its notices follow 5.8 (ids only, names at read time, navigation buttons only).
  3. Invites follow 2.4 and 7: single use, 14 days, hash only, token only in POST bodies, one transaction, the PB5 job with the brand's token after the 2.4 checks.
  4. `drafts.ts` creates the launcher draft (surface `promote`, R-PRM-3 source mapping), plus `AdPartnership` with the sealed code (from the page only), and exposes `loadLaunchSecrets`.
  5. The ad code and invite token never appear in any response other than the one meant for them, nor in a log, audit row or notice (test over every route). The lookup, invite create and accept routes are `secret` in `not-exposed.ts`.
  6. `meta-screens.ts` gains `business_portfolio` and `ig_account_roles`, each with its reason ("No API to create a business portfolio", "No API to grant Instagram account roles"), and the allowlist test passes.

#### PFA-08: Scopes for partnerships and fundraisers

- **Files:**
  - `src/lib/meta-connect/scopes.ts`;
  - tests: `tests/usage-scopes-alignment.test.ts`.
- **Depends on:** PFA-02, PFA-03 (the code reasons must exist).
- **Acceptance:**
  1. `META_CONNECT_SCOPES` and `SCOPE_PURPOSES` gain the three permissions with the 5.1 purposes.
  2. The alignment test has their `needs` patterns (5.1) and passes.
  3. `instagram_manage_insights` and `read_insights` are still absent everywhere.
  4. The Connections page lists the three as "missing" for existing tokens (existing behaviour, test).

#### PFA-11: Fundraisers UI

- **Files:**
  - `src/app/(app)/app/content/fundraisers/page.tsx`, `src/app/(app)/app/content/fundraisers/new/page.tsx`, `src/app/(app)/app/content/fundraisers/[id]/page.tsx`;
  - `src/components/fundraisers/FundraisersView.tsx`, `src/components/fundraisers/FundraiserCard.tsx`, `src/components/fundraisers/FundraiserProgress.tsx`, `src/components/fundraisers/FundraiserWizard.tsx`, `src/components/fundraisers/CharityPicker.tsx`, `src/components/fundraisers/FundraiserDetail.tsx`, `src/components/fundraisers/ShareSheet.tsx`, `src/components/fundraisers/FundraiserReadiness.tsx`, `src/components/fundraisers/useFundraiser.ts`;
  - `src/app/(admin)/admin/fundraisers/page.tsx`, `src/components/admin/CharityListEditor.tsx`;
  - tests: `tests/fundraisers-ui.test.ts`.
- **Depends on:** PFA-03.
- **Acceptance:**
  1. The flows in 2.11 to 2.13: 3 pre-filled steps (no cover photo), the review card, progress (donors hidden when F3b is in use), share sheet states, edit, end and hide.
  2. Non-organisers see read-only views with the 2.11 copy.
  3. Empty, loading and error states as in 6.3.
  4. Tokens only (grep), axe clean, no overflow at 320 and 360 px, bundle at most 100 KB.
  5. The admin charity editor saves through the mutating admin route and validates input.

#### PFA-05: Partnership ads in the launcher

- **Files:**
  - `src/lib/promote/creative-shapes.ts`, `src/lib/promote/service.ts`, `src/lib/promote/catalog/parity.ts`, `src/lib/promote/review-reasons.ts`, `src/lib/ads/service.ts` (the one `loadLaunchSecrets` call, R-PRM-6);
  - tests: `tests/promote-partnership.test.ts`, `tests/promote-creative-shapes.test.ts`.
- **Depends on:** PFA-02, PFA-04; PRM-02, PRM-05, PRM-08, PRM-09.
- **Acceptance:**
  1. R-PRM-1 to R-PRM-6 as in 5.5, including skipping the own-post probes for partnership drafts.
  2. A partnership draft reviews with the 2.5 facts and warnings, and `material` changes when the partnership changes.
  3. Start re-checks with PB3; a worse eligibility gives 409 `changed`.
  4. Launch uses one `permitForPausedCreate` and the partnership shape. The code reaches the builder only in memory.
  5. Every launcher test is green; the creative-shape snapshots are updated only for the new shapes.
  6. Previews (PB11) work for partnership drafts through the shared shapes.

#### PFA-09: Eddy definitions, catalogues and evals

- **Files:**
  - `src/lib/actions/defs/partnerships.ts`, `src/lib/actions/defs/fundraisers.ts`, `src/lib/actions/defs/index.ts`, `src/lib/actions/defs/navigation.ts` (three `EXTRA_PAGES` entries, 5.6), `src/lib/actions/not-exposed.ts`;
  - `src/lib/eddy/copy/partnerships.ts`, `src/lib/eddy/copy/fundraisers.ts`;
  - `evals/eddy/harness.ts` (the `cases.*.<lang>.jsonl` glob, only if not already there);
  - `evals/eddy/cases.partnerships.en.jsonl`, `evals/eddy/cases.partnerships.hi.jsonl`, `evals/eddy/cases.partnerships.hinglish.jsonl`, `evals/eddy/cases.fundraisers.en.jsonl`, `evals/eddy/cases.fundraisers.hi.jsonl`, `evals/eddy/cases.fundraisers.hinglish.jsonl`;
  - tests: `tests/actions-defs-partnerships.test.ts`, `tests/actions-defs-fundraisers.test.ts`.
- **Depends on:** PFA-03, PFA-04, PFA-05; PRM-13 (`start_promotion` and its card).
- **Acceptance:**
  1. The 25 definitions (13 partnerships, 12 fundraisers) match 5.6, with `area` `ads` or `content`, and the registry load rules pass. Planned entries are removed. Route coverage and role parity pass. `src/lib/actions/types.ts` is unchanged.
  2. The cards are as in 5.6 (warnings only from the `Warning` union); `create_fundraiser`, `update_fundraiser` (live) and `end_fundraiser` refuse confirmation by anyone but the organiser (checked in `authorize`, which `confirmAction` re-runs).
  3. Untrusted paths hold with the 5.6 sources; no definition takes or returns an ad code or invite token.
  4. `system` and assistant principals are refused on X, D and I actions.
  5. The evals pass in 3 languages, including the ad-code and invite-link refusals.

#### PFA-10: Partnerships UI

- **Files:**
  - `src/app/(app)/app/ads/partners/page.tsx`, `src/app/(app)/app/partners/invite/page.tsx`;
  - `src/components/partnerships/PartnersView.tsx`, `src/components/partnerships/PartnershipReadiness.tsx`, `src/components/partnerships/PartnerContentGrid.tsx`, `src/components/partnerships/PartnerContentCard.tsx`, `src/components/partnerships/AdCodeSheet.tsx`, `src/components/partnerships/CreatorList.tsx`, `src/components/partnerships/AddCreatorSheet.tsx`, `src/components/partnerships/InviteSheet.tsx`, `src/components/partnerships/InviteAccept.tsx`, `src/components/partnerships/FacebookPartnersTab.tsx`, `src/components/partnerships/BrandsTab.tsx`, `src/components/partnerships/usePartners.ts`;
  - tests: `tests/partnerships-ui.test.ts`.
- **Depends on:** PFA-04, PFA-05; PRM-14 (`OpensMetaButton`, the boost and create pages accepting `draftId`).
- **Acceptance:**
  1. The flows in 2.2 to 2.8 and 2.10 (the Brands tab), with two tabs plus Brands (no Invites tab) and the one-sheet creator request.
  2. [Use as ad] creates the server draft first, then navigates.
  3. The ad code input is masked and never re-rendered in clear after save. `?sheet=adcode` opens it.
  4. The invite page reads the token from the fragment, keeps it in `sessionStorage` across sign-in (try/catch), clears the fragment, and POSTs it.
  5. Accessible names as in 6.2; tokens only; axe clean; 360 px; bundle at most 100 KB; English only until `PROMOTE_PAGE_LANGS`.

#### PFA-12: Creator tagging and entry points

- **Files:**
  - `src/lib/content/service.ts`, `src/lib/content/publish.ts`, `src/lib/content/publishers.ts` (or `src/lib/content/publishers/instagram.ts` if SOC-07 has merged);
  - `src/components/content/Composer.tsx`, `src/components/content/ContentView.tsx`, `src/components/partnerships/BrandTagField.tsx`;
  - `src/components/ads/CampaignsView.tsx`, `src/components/app/commands.ts`, `src/components/eddy/page-context.ts`, `src/components/admin/AdminShell.tsx` (nav item "Fundraisers");
  - tests: `tests/content-partnership.test.ts`, `tests/content.test.ts`, `tests/content-ui.test.ts`, `tests/ads-ui.test.ts`, `tests/admin-ui.test.ts`.
- **Depends on:** PFA-01, PFA-04, PFA-10, PFA-11; PRM-15 (owner of `Composer`, `ContentView`, `CampaignsView`); rebases on SOC-07, SOC-10 and SOC-14 if they merged first.
- **Acceptance:**
  1. `PostInput` accepts `partnership` (4.3), validated against the workspace's brand partners. The Instagram container step sends PC1 fields only for Instagram targets. Publish errors use the 2.10 copy.
  2. The composer shows `BrandTagField` only for Instagram targets.
  3. Ads tile "Work with creators", content chip "Fundraisers", the command palette entries, the Eddy page context (5.6) and the admin nav item "Fundraisers" (to `/admin/fundraisers`) exist.
  4. The `auth-nav` counts are unchanged.
  5. The existing `content`, `content-ui` and `ads-ui` tests pass.

#### PFA-13: Integration, verification and App Review documents

- **Files:**
  - `e2e/partnerships.spec.ts`, `e2e/fundraisers.spec.ts`, `e2e/admin-meta-api.spec.ts`, `e2e/eddy-partnerships.spec.ts`, `e2e/pfa-helpers.ts`, `e2e/fake-meta-server.ts` (scenarios added);
  - `scripts/pfa-verify.ts`, `docs/pfa-verification-runbook.md`;
  - `docs/app-review/instagram_branded_content_ads_brand.md`, `docs/app-review/facebook_branded_content_ads_brand.md`, `docs/app-review/manage_fundraisers.md`, `docs/app-review/marketing_api_access_tier.md`;
  - `docs/app-review/status.md`, `docs/app-review/00-overview.md`, `docs/meta-dashboard-requirements.md`;
  - `deploy/README-deploy.md`.
- **Depends on:** PFA-00 to PFA-12 (and PFA-14 when it is in the first submission).
- **Acceptance:**
  1. The 8.2 specs pass on desktop and @mobile, and the existing `growth-*` suites stay green.
  2. The runbook lists V-PF1 to V-PF22 with commands, pass criteria and where each result is recorded. `scripts/pfa-verify.ts` runs only against the review accounts and only when an operator passes `--live`; passed items become fake-Meta fixtures and catalog verify states.
  3. The four App Review documents contain the 9.x scripts (each with the Meta login and consent screen), test calls, reviewer text and descriptions, with the owner placeholders. `status.md` records the real item names (V-PF1) and readiness. `meta-dashboard-requirements.md` lists the three permissions, the Application webhook field and the "+Upgrade" step, and still names `instagram_manage_insights` only in a "not requested" row (the alignment test checks it).
  4. The deploy README records the flag order of 1.4, `PFA_PILOT_TENANTS` and the migration step.
  5. Full `npm test`, `tsc` and `next build` pass, with the integration engineer's sign-off.

#### PFA-14: Creator and brand-control APIs (second submission, or wave 5 if V-PF1 needs them now)

- **Files:**
  - `src/lib/partnerships/creator-api.ts`;
  - `src/app/api/partners/ad-codes/route.ts`, `src/app/api/partners/ad-codes/[mediaId]/route.ts`, `src/app/api/partners/boost-permission/route.ts`, `src/app/api/partners/tag-approval/route.ts`;
  - `src/lib/meta-connect/scopes.ts`, `src/lib/actions/defs/partnerships.ts`, `src/lib/actions/not-exposed.ts`, `src/lib/eddy/copy/partnerships.ts`;
  - `src/lib/partnerships/copy/en.ts`, `src/lib/partnerships/copy/hi.ts`, `src/lib/partnerships/copy/hinglish.ts`;
  - `src/components/partnerships/BrandsTab.tsx`, `src/components/partnerships/PartnersView.tsx`, `src/components/partnerships/ApprovedCreators.tsx`;
  - tests: `tests/partnerships-creator-api.test.ts`, `tests/usage-scopes-alignment.test.ts`, `tests/actions-defs-partnerships.test.ts`;
  - `docs/app-review/instagram_branded_content_creator.md`, `docs/app-review/instagram_branded_content_brand.md`.
- **Depends on:** PFA-09, PFA-10 (and PFA-13 when it is the second submission); the owner adds the two permissions to the use case, the configuration and the draft (11.1 item 9).
- **Acceptance:**
  1. PC2 to PC5 behind `PARTNERSHIPS_CREATOR_API`, each a confirm card or sheet (X; delete code: X, D).
  2. A created code is shown once, then masked, and never stored. `POST /api/partners/ad-codes` is `secret` in `not-exposed.ts`, so Eddy can neither make nor see a code; deleting a code and the boost permission are Eddy actions.
  3. The approved-creators list ("Who can tag you as a paid partner", a section at the bottom of the Creators tab) is all-or-nothing as Meta documents.
  4. Scopes and alignment updated.
  5. 9.5 documents written.

---

## 11. Decisions taken

Taken under the owner's delegated authority. Each can be overridden.

| # | Decision | Why |
|---|---|---|
| D-PF1 | Partnership ads live on the Ads page (`/app/ads/partners`) and run through the existing launcher; no separate ads path, no new nav item | One place for ads; money stays where Phase 0 put it |
| D-PF2 | Build only on the Content Discovery API; never on `branded_content_advertisable_medias` or `advertisable-posts` | Both are removed on 1 Dec 2026 |
| D-PF3 | The first submission covers the two `*_ads_brand` permissions plus `manage_fundraisers`; `instagram_branded_content_creator` and `instagram_branded_content_brand` come in a second submission (PFA-14) | They match "Instagram and Facebook" partnership ads; fewer items means less review risk, and the creator side works in v1 through publish tagging (`instagram_basic`) and the Instagram app |
| D-PF4 | Brand ids for creator tagging come from partner rows and invite links, not username search | Business Discovery needs `instagram_manage_insights`, which is not requested and is banned by the scope test |
| D-PF5 | Ad codes are secrets: sealed, masked, POST-only, nulled 30 days after the campaign; creators' codes are composed in the browser and never stored | A code lets anyone holding it boost the post |
| D-PF6 | A partnership ad may start while the creator's OK is pending, with a clear warning and money set aside from today | Meta supports pending delivery; blocking would add a step; the worst case is still bounded by the end date |
| D-PF7 | Default "Show both names" (`ad_format 1`) and "brand first" for new-media ads; creator-first only when the creator has a Facebook Page | Meta's default; avoids ads that silently don't deliver on Facebook |
| D-PF8 | `whatsapp_chats` and lead forms join partnership goals only after V-PF7 | The docs show only a Messenger example |
| D-PF9 | Facebook account-level permissions sit behind `PARTNERSHIPS_FB_PERMISSIONS` until V-PF9 | A separate REST API with thin documentation |
| D-PF10 | Fundraisers live under Content (`/app/content/fundraisers`); only the member who connected Facebook (the organiser) may create, change or end one | It is published on that person's own profile |
| D-PF11 | The end date of a live fundraiser is changed on Facebook (Opens Meta), not in Edwyz | An `end_time` write on an id is a spend field to the tripwire; carving it out would weaken the guard |
| D-PF12 | No donor data is read or stored; totals come from the fundraiser node; webhooks only trigger a re-read | DPDP minimisation; no need for donor details |
| D-PF13 | Edwyz shows an honest availability notice: Facebook fundraisers don't serve Indian charities today | Meta's help says so for India (VERIFY V-PF12); owners must not expect donations to Indian NGOs |
| D-PF14 | Fundraiser sharing makes drafts (template, broadcast, post); sending stays in the existing broadcast and content flows with their limits and cards | One sending path per channel |
| D-PF15 | The access-tier monitor logs every attempt in our transport, keeps per-attempt rows only for low-volume families, defines "ready" with a 10% error margin, and never generates calls | Meta counts real calls; a margin avoids a refused request |
| D-PF16 | Apply for Full access as soon as the card and Meta both show the bar met, and before the first non-role customer runs ads | Limited's 60-point score blocks for 5 minutes after a few writes |
| D-PF17 | (critic) Migration `0020_partnerships_fundraisers`, one forward-only additive file; renumbered at merge if taken | 0012 and 0013 are reserved by the launcher spec, and 0014 to 0019 go to the other four specs of 2026-10-31 in file-name order (4.0) |
| D-PF18 | Plan features `partnershipAds`, `partnerCreatorsMax` (200), `fundraisersActiveMax` (10); absent means allowed | No price change needed; admins can restrict per plan |
| D-PF19 | Pages stay English until the native-speaker review; Eddy speaks en, hi and hinglish now | Same rule as the launcher (D23) |
| D-PF20 | (critic) No fundraiser cover photo in v1; F1 is plain JSON | Facebook shows the charity's cover; it saves a wizard screen, a multipart helper and a cross-spec clash over `graphUploadAs` |
| D-PF21 | (critic) Ad codes and invite links never pass through Eddy: no action takes or returns one, and their routes are `secret` in `not-exposed.ts` | Anything typed to Eddy is stored in the conversation and sent to the AI provider; both are bearer secrets |
| D-PF22 | (critic) Invite tokens travel in the URL fragment (`/app/partners/invite#t=…`), never in a path or query | Fragments never reach a server log, analytics or a `Referer` header |
| D-PF23 | (critic) The Meta call log keeps no tenant id, only the last 4 digits of an ad account; "busiest workspaces" is dropped | Ads calls go through `graphFetchAs`, which has no tenant; adding one would touch Phase 0 and launcher callers, and the log then holds no workspace data |
| D-PF24 | (critic) Only `POST me/fundraisers` gets an exact not-spend rule in `classify()`; `NOT_SPEND_EDGES` is not widened | The other new edges already classify not-spend, and an edge allowlist would also pass a `status` field |
| D-PF25 | (critic) Feature flags' `admins` mode means "workspaces listed in `PFA_PILOT_TENANTS`" | Lets the review workspace see the features before general release without a code change |
| D-PF26 | (critic) Partners page has two tabs plus Brands (invite links live in the Creators tab), and asking a creator is one sheet with one button | Fewer taps and tabs at 360 px |

### 11.1 Inputs needed from the owner

1. **Meta dashboard: permissions.**
   - Open App Review > Requests > draft 1799953447868194 and confirm which two branded-content permissions it holds (V-PF1); copy the 22 items into `docs/app-review/status.md`.
   - In the app's use cases, add `instagram_branded_content_ads_brand`, `facebook_branded_content_ads_brand` and `manage_fundraisers` (the "Share or create fundraisers on Facebook and Instagram" use case for the last).
   - Add all three to the Login for Business configuration "Edwyz Connect Pages IG Ads" (V-PF11).
2. **Meta dashboard: webhook.** Webhooks > Application > subscribe the field `fundraiser_donations` with callback `https://wa.edwyz.com/webhooks/meta-app` and the existing verify token. The app must be Live.
3. **Test assets for partnership ads:**
   - a second real person's Instagram professional account to act as the creator (branded content tools on) and a Facebook Page for it;
   - one reel tagging @edwyz.testbrand as a paid partner, and an ad code for it;
   - the brand's Instagram linked to the test Page and in the business portfolio;
   - the review user given "Partnership ads" access (ADS or CREATOR_MANAGEMENT role) on that Instagram account.
4. **Fundraisers reviewer account.** Facebook fundraisers are very likely unavailable from India (V-PF12). Choose one:
   - (a) a trusted person in an eligible country (US, UK, Canada or Australia) with a real Facebook account, added as an app tester, records the 9.3 screencast and is named in the reviewer notes; or
   - (b) accept the risk that Meta rejects `manage_fundraisers` if the India review user cannot create one.

   Also pick the charity for the curated list and confirm on Facebook that it accepts fundraisers (its Page shows "Raise money"/"Donate"). Copy its Page ID from About > Page transparency.
   - Candidate US charities to check: St. Jude Children's Research Hospital, American Red Cross, Feeding America, UNICEF USA, charity: water, Doctors Without Borders/MSF-USA, World Wildlife Fund, Save the Children US.
   - UK: Cancer Research UK. Canada: Canadian Red Cross. Australia: Australian Red Cross.
   - Each needs VERIFY on Facebook; Page IDs are not recorded here.
5. **Money for tests.** About ₹1,500 of real ad spend:
   - partnership ad tests (V-PF4 to V-PF8): ₹100 a day, 2 days, about 4 runs;
   - one USD 5 minimum donation, with the refund requested through Meta's form (V-PF14), if the reviewer account can donate.
6. **Marketing API access tier.**
   - Run Edwyz's own real ad campaign through Edwyz (₹100 to ₹200 a day for about 10 days; about ₹1,000 to ₹2,000) on the owner's ad account, so the tier requirement fills legitimately.
   - When the admin card says "Ready" and the dashboard agrees, press "+Upgrade" on the Marketing API Access Tier feature in the App Dashboard.
7. **Legal.** The lawyer adds two short sections to the privacy policy and terms:
   - partnership ads: the creator identifiers held, the purpose, deletion after removal;
   - fundraisers: Edwyz is not a payment intermediary; donations are governed by Meta's fundraising terms; no donor data.

   Also confirm the ASCI disclosure help line for creators.
8. **Meta-side settings the creator and brand switch on themselves.** The creator turns on branded content tools in Instagram. The brand's Instagram must be a professional account. Nothing in Edwyz can do these.
9. **Later (PFA-14).** Decide when to add `instagram_branded_content_creator` and `instagram_branded_content_brand` to the use case, the configuration and a second App Review submission. If V-PF1 shows the draft already holds them, they stay (the owner's rule) and PFA-14 is built before Submit.
10. (critic) **Server setting.** Put the review workspace ids (and Edwyz's own) in `PFA_PILOT_TENANTS` on the VPS, or switch the three flags to `on`, before recording the screencasts. Keep the Meta app in Live mode while recording the fundraiser clip.

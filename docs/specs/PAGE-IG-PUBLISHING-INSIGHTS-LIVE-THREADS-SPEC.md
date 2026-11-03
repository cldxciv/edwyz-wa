# Page and Instagram publishing, video, live video, results and Threads: specification

- **Status:** ready to build. Written 2026-10-31 and corrected by a critic pass the same day. This run wrote the specification only. No code, schema or Meta setting was changed. The open VERIFY rows (8.5) gate single formats and options behind flags (D19), not the build.
- **Owner authority:** the owner's standing instructions of 2026-10-30 ("get this whole platform to a production stage", "we need all of them" about the App Review draft). Every permission named in 1.3 must be backed by the working feature named there before the owner presses Submit.
- **Reads with:**
  - `docs/IG-PAGE-ADS-SPEC.md`: its "Boost this post" chip on content cards, its PRM-03 media probe and its `meta-screens.ts` allowlist.
  - `docs/SPEND-CONTROLS-SPEC.md`: the transport tripwire (4.7) and the static bypass rules (4.12).
  - `docs/EDDY-SPEC.md`: the action registry, cards and the not-exposed list.
  - `docs/app-review/status.md`.
- **API versions:**
  - Graph API **v26.0** (`GRAPH_API_VERSION` in `src/lib/config.ts`).
  - Threads API **v1.0** on `graph.threads.com`. The Threads changelog of 2025-06-06 says `graph.threads.net` works too. (critic) The current "Get access tokens" page uses `https://threads.com/oauth/authorize` and `https://graph.threads.com/oauth/access_token`.
- **VERIFY** marks a fact the public docs did not confirm, or that conflicts between two Meta pages. Each VERIFY says how to check it. Each one is also a row of the verification runbook (8.5, package SOC-20). A format or option whose VERIFY rows have not passed stays off behind its flag (D19).
- **New server modules:**
  - `src/lib/content`, extended.
  - `src/lib/live`, `src/lib/social-insights`, `src/lib/threads` and `src/lib/media-probe`, new.
  - `src/lib/graph/binary.ts`, new.
- **New component folders:** `src/components/content` (extended), `src/components/live` and `src/components/results`.
- **Migration:** `prisma/migrations/0019_social_publisher/migration.sql`. (critic) Renumbered from 0014, which every spec of 2026-10-31 had claimed. 0012 and 0013 are reserved by `docs/IG-PAGE-ADS-SPEC.md`. From 0014 up, numbers go by the alphabetical order of the files in `docs/specs/`:
  - `ADS-MCP-CANVA-CREATIVE-SPEC.md`: 0014;
  - `MESSENGER-INSTAGRAM-INBOX-SPEC.md`: 0015 and 0016;
  - `META-CATALOG-COMMERCE-SPEC.md`: 0017 and 0018;
  - this spec: **0019**;
  - `PARTNERSHIP-ADS-FUNDRAISERS-ACCESS-TIER-SPEC.md`: 0020.

  If 0019 is taken when this lands, use the next free number. Nothing in this migration depends on the order of the other new migrations.
- **Critic pass (2026-10-31).** Paragraphs marked "(critic)" were corrected against Meta's public docs (fetched 2026-10-31) and the code in the repo.

---

## 1. Summary

### 1.1 What this builds

A shop owner opens **Content calendar** on a phone. They write one post and choose where it goes:

- their **Facebook Page**;
- their **Instagram** professional account;
- their **Threads** profile.

Edwyz picks the right format for each place. The owner taps **Post now** or **Schedule**. In plain terms:

- **Facebook Page:** text, link, one photo, an album of up to 10 photos, a video, a Reel or a Story. A post published through Edwyz can be removed again from Edwyz.
- **Instagram:** a photo, a carousel of up to 20 photos and videos, a Reel or a Story. The composer shows how many of the day's app posts are left. The total comes from Meta (I2), usually 100. (critic) Meta's guide says 100, but its carousel section and the `content_publishing_limit` reference still say 50, so the number is never hard-coded.
- **Threads:** text, link, photo, video, or a carousel of 2 to 20 items. The owner chooses who can reply, then reads, hides and answers replies. A Threads post can be removed from Edwyz.
- **Live video on the Facebook Page:**
  1. Set it up now or for later, up to 7 days ahead.
  2. Copy the server URL and stream key into OBS or a phone streaming app.
  3. See "We're receiving your stream", then tap **Go live**. (critic) If the owner streams from the same phone, they can instead choose "Go live as soon as my stream starts" at setup, so there is no need to switch apps.
  4. While live, see how many people are watching and read the comments as they arrive.
  5. Tap **End live**.
- **Social results** (`/app/content/results`): one easy screen for the Page, the Instagram account and the Threads profile. It shows:
  - people reached, views, interactions and new followers for 7, 28 or 90 days, with the change against the period before;
  - views per day;
  - the best posts;
  - a "best time to post" sentence;
  - numbers on every published post, including Instagram Story numbers caught before Meta deletes them after 24 hours.
- **Threads connection:** Threads has its own login and its own token, separate from Facebook Login. The owner connects it from **Settings > Meta connections**, and Edwyz renews the 60-day token by itself.
- **Eddy** (the in-app helper) can do all of this in Hindi, English or Hinglish. It answers questions about results at once. Before anything it publishes, removes, starts, ends or replies to, it shows a confirm card with the exact content. It never shows the stream key.

None of this spends money. "Boost this post" belongs to the ads spec. Nothing here calls the Marketing API.

### 1.2 What exists today in `src/lib/content` and what changes

| File | Today | Change |
|---|---|---|
| `limits.ts` | Three channels (`facebook`, `instagram`, `threads`). Character limits 63,206, 2,200 and 500. Images up to 8 MB, videos up to 100 MB. `channelProblems()` blocks Instagram without media and Instagram PNGs. | Types stay. `MAX_VIDEO_BYTES` is read from `CONTENT_MAX_VIDEO_MB` (default 100, at most 300). `channelProblems()` delegates to the new `formats.ts`. |
| `media.ts` | Workspace media library on disk (`DATA_DIR/content/<tenant>/<32-hex>.<ext>`). Quota 500 MB and 500 files. A magic-byte check. HMAC-signed public URLs that last 1 h (`/api/content/media-public/...`). | Each upload is probed for width, height, duration and rotation, stored in `ContentMedia`. Adds `mediaInfo()` and `mediaFilePath()` for streaming uploads to Meta. Deleting a file also deletes its `ContentMedia` row. |
| `publishers.ts` | Facebook: `/feed` (text, with the first link), `/photos` (one image), `/videos` with `file_url`. Instagram: an image container or `REELS` container, then a status poll, then `media_publish`, with a `content_publishing_limit` check. Threads: throws "not available yet". | Split into `publishers/{common,facebook,instagram,threads}.ts`. `publishers.ts` becomes a barrel that re-exports them. Every format in 3.2 is added. |
| `publish.ts` | `claimDue` and `expireStalePosts` (the 24 h missed window). `processPost` handles each target with a compare-and-set on status. Up to 3 retries, with the attempt count kept in the error text. The Instagram container id is kept in `externalId`. | Dispatch by format. Multi-step state is kept in `PostTarget.progress`, including resumable uploads, carousel children, video ids and a heartbeat. Adds Threads account access, a permalink read-back after publishing, a stats row written on publish (4.3) and Facebook's own limit of 30 Reels a day. |
| `service.ts` | Create, edit, reschedule, cancel, delete and publish now. Client approval links. One media key per post. Targets come from `MetaAsset` page and instagram rows; Threads shows as unavailable. Plan limits. | Up to 20 media keys, alt text per image and a link per post. Per target: a format, options and an optional text override. Threads accounts become targets. Adds a quota read and two new target actions, **Remove** and **Try again**. |
| `schedule.ts`, `worker.ts`, `serve.ts`, `http.ts` | Scheduling rules (future, at most 90 days ahead, calendar ranges up to 62 days). The publish queue and a claim tick every 30 s. Range serving. `writeActor` (CSRF check, sign-in, admin role). | Unchanged. |
| `src/components/content/*` | The `/app/content` page: a month, week and list calendar, and a composer with accounts, text, one media file, time, an approval link and per-channel previews. | Adds a format picker, a media tray (multi-select, reorder, alt text, Reel cover frame), per-channel options, a "posts left today" meter, and post details with links, Remove, Try again, numbers and Threads replies. The header gets **Go live** and **Results**. |

Elsewhere:

- **Meta Connect** keeps one connection model for Facebook Login for Business. Threads gets its own table (D2).
- **`scopes.ts`** gains `publish_video`, `read_insights` and `instagram_manage_insights` in the package that ships the code using them (SOC-12).
- **The spend tripwire** learns that live video status values are not ad spend (5.5).

### 1.3 App Review permissions and features this spec backs

Each line reads: permission or feature, then the exact feature and screen that use it.

- `pages_manage_posts` → **Content calendar** composer (`/app/content`, New post): Facebook Page text, link, photo, album, video, Reel and Story posts, published now or scheduled. Also **Remove from Facebook** in post details.
- `publish_video` → **Live videos** (`/app/content/live`): set up, schedule, start and end a live video on the Page, read its status and stream health. (critic) Meta's Video publishing and Reels publishing guides ask only for `pages_show_list`, `pages_read_engagement` and `pages_manage_posts`, so the review text for `publish_video` describes Live only. V-S3 re-checks this on the test Page.
- **Live Video API** (feature) → **Live videos** (`/app/content/live` and `/app/content/live/[id]`): the stream URL and key, Go live, viewers, live comments and End live.
- `read_insights` → **Social results** (`/app/content/results`), Facebook tab: views, people reached, interactions, new followers, views per day. Also the numbers on each published Facebook post in post details.
- `instagram_basic` → the composer's Instagram account chip (username), **Social results** (the follower count and the list of recent posts, including ones not made in Edwyz), and the post permalink in post details.
- `instagram_content_publish` → **Content calendar** composer: Instagram photo, carousel, Reel and Story posts. Also the "Instagram: N of {total} posts left today" meter, where `total` is Meta's `quota_total`.
- `instagram_manage_insights` → **Social results**, Instagram tab: reach, views, interactions, new followers, per-post numbers, and Story numbers kept after the Story expires.
- `threads_basic` → **Settings > Meta connections > Threads**: connect and show `@username` and the name. Required by Meta for every Threads call.
- `threads_content_publish` → **Content calendar** composer: Threads text, link, photo, video and carousel posts. Also the "Threads: N of 250 posts left today" meter.
- `threads_manage_insights` → **Social results**, Threads tab: views, likes, replies, reposts, quotes, link clicks and followers. Also the numbers on each published Threads post.
- `threads_read_replies` → post details > **Replies** on a published Threads post: read replies and their hidden or visible state.
- `threads_manage_replies` → post details > **Replies**: **Hide**, **Unhide** and **Reply** as the account. Also the composer's "Who can reply" choice and the reply quota.
- `threads_delete` → post details > **Remove from Threads**.
- `pages_read_engagement` (already in the draft) gains three uses, added to its description in 9.15:
  - the Page's recent posts list in Social results;
  - the live comments and viewer count on the Live screen;
  - permalink read-back.
- `pages_show_list` (already in the draft) → the Page picker in the composer and on the Live screen.

**Not requested by this spec:**

- `pages_read_user_content` (VERIFY V-L7). Commenters' names on the Live screen may need it. Without it the comments show "Someone", and the comment-moderation spec's request covers it.
- `pages_manage_engagement`: replying to Facebook comments belongs to the comment-moderation spec.
- `threads_manage_mentions`, `threads_keyword_search`, `threads_location_tagging`, `threads_profile_discovery`, `threads_share_to_instagram`: not used.
- `instagram_manage_comments`: belongs to the comments spec.
- (critic) **`instagram_manage_contents`**. The current Instagram Media reference documents "Deleting" (`DELETE /<IG_MEDIA_ID>`, Facebook Login only, user token, `instagram_basic` and `instagram_manage_contents`). But:
  - the same page shows the request as `POST` with an unrelated `comment_enabled` example;
  - the permission has no page in the permissions reference (404 on 2026-10-31).

  v1 therefore keeps "Open on Instagram" for removal (D8, VERIFY V-I11). The owner does not add this permission to the draft until V-I11 passes. When it does, "Remove from Instagram" ships behind the flag `IG_REMOVE`, with its own review item.

---

## 2. User flows

### 2.1 Principles and smart defaults

- **One composer, one text, every channel.** The owner writes once. Each channel row shows "Post as" with only the formats that fit the chosen media. The best one is picked for them:

| Media chosen | Facebook default | Instagram default | Threads default |
|---|---|---|---|
| Text only | Post (with a link preview if the text has a link) | Not available: "Instagram needs a photo or video." | Post |
| 1 photo | Post (photo) | Post | Post (photo) |
| 2 to 10 photos | Album | Carousel | Carousel |
| 11 to 20 photos | Not available: "Facebook takes up to 10 photos in one post." | Carousel | Carousel |
| 1 video, upright (taller than wide) and 3 to 90 s | Reel | Reel | Post (video) |
| 1 video, any other shape or length | Video | Reel (3 s to 15 min) | Post (video, up to 5 min) |
| Photos and videos mixed | Not available: "Facebook can't mix photos and videos in one post." | Carousel | Carousel |

- **Story is never the default.** The owner taps **Story** on Facebook or Instagram. A Story takes 1 photo, or 1 video of 3 to 60 s. (critic) Facebook's Page Stories guide allows 3 to 90 s and Instagram allows 3 to 60 s. One rule for both is simpler for the owner, so Edwyz uses 60 s for both.
- **Everything else is folded away.** These sit under **More options**, collapsed:
  - Facebook video title;
  - Instagram "Also show in your feed" (on by default) and "Cover: pick a frame";
  - Threads "Who can reply" (default Everyone) and "Topic".
- **Times.** Times are shown in the viewer's time zone and stored in UTC (unchanged).
- **Text too long for one channel.** The composer offers **Write a shorter version for Threads**, a per-channel text override. The main text is not cut.
- **Words the owner sees:** Post, Reel, Story, Album, Carousel, Live video, People reached, Views, Interactions, New followers. Never: container, token, webhook, insights, endpoint.
- **Mobile first.** Every screen works at 360 px in one column. The primary button sits in the sticky bottom bar, 44 px high. Dark theme comes from tokens only.

### 2.2 Connect accounts

**Facebook Page and Instagram (exists, Settings > Meta connections).**

- New workspaces connect as today. The Login for Business configuration gains the permissions in 5.1, so the consent screen lists them.
- An older connection whose token lacks a needed permission gets this banner on the composer, the Live screen and Results: "Videos, live and results need one more Facebook permission. [Reconnect Facebook]". The banner comes from `scopeSummary().missing`. The button reuses the popup login.

**Threads (new). Settings > Meta connections, Threads card.**

1. The card says: "**Threads**. Post to your Threads profile and see how your posts do. [Connect Threads]". Only owners and admins see the button. Team members see "Ask an admin to connect Threads."
2. The owner taps **Connect Threads**. A popup opens Threads' login and consent screen (Meta's own page). It lists Edwyz and the permissions.
3. The owner taps **Allow**. The popup closes and the card shows: "**@sunrise_realty** · Connected. We renew this connection by ourselves." The toast says "Threads connected".
4. If the owner cancels, the card says: "Threads wasn't connected. You can try again any time."
5. If the owner unticked a permission, the card says: "Connected, but Edwyz can't {see results | read replies | remove posts}. [Connect again] and allow everything." The list comes from the token's permissions (3.2, T6).
6. While Edwyz has only standard access, only Threads testers can connect. Meta then sends anyone else back with an error. The card says: "Threads isn't open to every account yet. Ask Edwyz support to add you as a tester." The text is shown when the error comes back and the account is not a tester.
7. **Disconnect** is behind a confirm dialog: "Disconnect @sunrise_realty? Scheduled Threads posts won't go out. Posts already on Threads stay there." After it, the card says: "Disconnected. To remove Edwyz from Threads too, open Threads > Settings > Account > Website permissions."
8. **Expiry.** The token lasts 60 days and Edwyz renews it each week (5.4). If renewal fails three times, or the token expires, a notice appears: "Your Threads connection has expired, so scheduled Threads posts can't go out. [Reconnect Threads]".

### 2.3 Create a post

1. Content calendar → **New post**, or tap a day.
2. **1 Where to post.** One chip per account. Each chip shows a channel icon and a name:
   - "Sunrise Realty · Facebook Page";
   - "@sunrise_realty · Instagram";
   - "@sunrise_realty · Threads".

   A chip that can't be used is disabled and says why:
   - "Reconnect needed";
   - "You can't post on this Page (ask a Page admin)", when the Page's `tasks` lack both `CREATE_CONTENT` and `MANAGE`. (critic) Instagram asset rows carry no `tasks` (`discovery.ts` stores only `{pageId, username}`), so the Instagram chip uses the `tasks` of the linked Page asset found by `meta.pageId`;
   - "Threads not connected [Connect]". **Connect** opens the Threads popup right there, so the owner never leaves the composer.

   Under the Instagram and Threads chips: "Instagram: 97 of 100 posts left today." The total is Meta's `quota_total` (I2) or `config.quota_total` (T7), not a constant.

   **Smart default.** On a new post, the chips of the accounts used in the last post start selected. When the workspace has only one Page and its Instagram account, both start selected.
3. **2 What to post.**
   - **Text.** A text box with a counter for each chosen channel, for example "Instagram 120 / 2,200 · Threads 120 / 500".
   - **Media.** **Add photos or video** opens the library or an upload. The owner can select up to 20 files and reorder them with drag, or with "Move earlier" and "Move later" buttons for keyboard users.
   - **Description.** Each photo has "Describe this photo (for people who can't see it)". This is the alt text, sent to Instagram and Threads.
   - **Link.** When the text contains a link, a chip shows "Link preview: example.com [Remove preview]".
4. **3 How it looks.** One row per channel:
   - "Facebook: [Post] [Reel] [Story]", with the format chosen by 2.1. Disabled options say why, for example "Reel needs one video, 3 to 90 seconds" or "Story needs one photo or one video up to 60 seconds".
   - A preview per channel (the existing `ChannelPreview`, extended to albums, carousels, Reels and Stories).
   - **More options** for the channel (2.1).
   - **Write a shorter version for {channel}**.
5. **4 When.** **Post now** or **Schedule** with a date and time (the existing quick slots). "Ask client to approve first" stays as it is.
6. **The primary button** reads "Schedule post" or "Post now".
   - **Post now** asks: "Post now to Facebook, Instagram and Threads? It goes out right away." Buttons: [Post now] [Cancel].
   - **Schedule** saves, then the toast says "Scheduled for Sat 2 Nov, 10:30 am".
7. **Checks before saving.** Each one sits under its field:
   - "Instagram needs a JPEG photo. [Make a JPEG copy]". (critic) This is a one-tap fix. The browser redraws the PNG on a canvas, calls `toBlob("image/jpeg", 0.9)` on a white background, uploads the copy to the library and swaps it into the post. The owner never has to export a file. (There is no image library on the VPS: ads spec D21.)
   - "This photo's shape doesn't fit Instagram. [Crop to fit]". (critic) Also one tap. The browser centre-crops to the nearest allowed shape (4:5 for tall photos, 1.91:1 for wide ones), uploads the copy and shows it in the tray, where the owner can undo it. The check runs from the stored width and height (`ContentMedia`).
   - "Reels must be 3 to 90 seconds on Facebook. This video is 2 min 10 s. Post it as a Video instead."
   - "Stories take videos up to 60 seconds. This video is 75 seconds."
   - "Threads allows at most 5 links in one post."
   - "Threads allows 500 characters. Write a shorter version for Threads."
   - "Facebook takes up to 10 photos in one post. Remove 3, or turn off Facebook for this post."
   - "Videos can be up to {N} MB."

### 2.4 After publishing: post details

The existing details dialog becomes `PostDetail`. There is one row per channel:

- **Published.** "Published 10:30 am · [View on Facebook]". The link is the `permalink` read back from Meta.
- **Numbers.** "Views 1,240 · Reached 980 · Likes 45 · Comments 6 · Updated 3 h ago". The source is `SocialPostStat`. Before the first fetch, the row says "Numbers appear a few hours after posting."
- **Waiting.** "Preparing video: Instagram is still processing it. This can take a few minutes."
- **Failed.** "Didn't publish: {plain reason from 3.5}" with **[Try again]**. Try again is offered only for reasons that are safe to repeat.

  When the outcome was unclear, the row says instead: "Meta didn't confirm whether this was posted. Check {Facebook} first. If it isn't there, [Post it again]." **Post it again** asks to confirm: "Post again to {account}? If the first one did go out, there will be two."
- **Remove.**
  - Facebook and Threads: **Remove from Facebook** / **Remove from Threads** opens a confirm dialog: "Remove this post from your Facebook Page? This can't be undone. Edwyz keeps a copy in your calendar." The result: the row says "Removed from Facebook" (grey pill).
  - Instagram: "To remove this post, open it on Instagram and delete it there. [Open on Instagram]". (critic) The copy no longer claims Instagram has no delete API. Meta's reference now documents one, but it is unconfirmed (1.3, V-I11).
  - A Facebook Story: "Facebook doesn't let apps remove Stories. Stories disappear after 24 hours." (VERIFY V-F9)
- **Threads replies.** "Replies (12)" opens 2.7.
- **Boost.** "Boost this post" appears when the ads spec is built (its 3.1).

### 2.5 Live video (Facebook Page only)

Instagram Live has no publishing API, so it is not offered. The setup screen says so once, in small text: "Instagram Live isn't available to apps."

1. **Entry.**
   - Content calendar header: **Go live** (owners and admins).
   - Eddy: "kal shaam 7 baje live jaana hai".
2. **List** (`/app/content/live`, titled "Live videos").
   - Three sections: "Coming up", "Live now", "Past".
   - Empty state: "No live videos yet. Go live on your Facebook Page using OBS on a computer or a streaming app on your phone. [Set up a live video]".
3. **Set up** (`/app/content/live/new`).
   - Fields:
     - Page (pre-selected when there is only one);
     - **Title**: required, at most 254 characters, placeholder "e.g. Diwali offers: live Q&A";
     - **Description**: optional;
     - **When**: [Now] [Later], where Later takes a date and time up to 7 days ahead (Meta's scheduling guide: "up to seven days from their creation date");
     - (critic) **Start** (Now only): [When I tap Go live] (default) or [As soon as my stream starts]. The help line says: "Streaming from this phone? Choose 'As soon as my stream starts', so you don't have to come back here." The second choice creates the live with `status: LIVE_NOW` (L1b). Meta's getting-started guide documents this as the direct path, and the broadcast becomes public when the stream arrives. The **Get stream key** confirm then reads: "Your live goes public on {page} as soon as your stream starts. Continue?"
   - **Followers check.** Edwyz reads the Page's follower count first.
     - Under 100 followers: the button is disabled and the alert says "Facebook lets Pages go live from apps only when they have at least 100 followers. Your Page has 64."
     - The rule that the Facebook account must be 60 days old cannot be read in advance. It shows only as Meta's error (3.5).
   - Button: **Get stream key** for Now, **Schedule live** for Later.
4. **Stream details** (`/app/content/live/[id]`).
   - A card titled "Your stream details", with:
     - **Server URL** (everything in `secure_stream_url` up to and including `/rtmp/`, as Meta's getting-started guide splits it; its example is `rtmps://rtmp-api.facebook.com/rtmp/`), with Copy;
     - **Stream key**, shown as "••••••••", with [Show] and [Copy];
     - **Full URL (for phone apps)**, with [Copy].
   - Warning: "Keep the stream key secret. Anyone who has it can stream to your Page."
   - Two help tabs:
     - "**On a computer (OBS).** Settings > Stream. Service: Custom. Paste the server and the stream key. Click Start streaming."
     - "**On a phone.** Use an app that can stream with RTMPS, for example Larix Broadcaster. Add a connection and paste the full URL."
5. **Waiting for the stream.**
   - The page says: "Waiting for your stream… Start streaming in OBS or your app. This page updates by itself." It refreshes every 5 s.
   - When the stream arrives (3.2, L3): "We're receiving your stream." The primary button **Go live now** appears.
   - **Go live now** asks to confirm: "Go live on Sunrise Realty now? Everyone who follows your Page can see it." The status then becomes LIVE.
   - **Scheduled lives.**
     - The page says: "Facebook starts this live at 7:00 pm if your stream is running. You can start streaming any time before that, or tap Go live now."
     - A notice 30 minutes before: "Your live 'Diwali offers' starts at 7:00 pm. Start your stream so it's ready."
   - **Drafts expire.** A "now" setup that is never started expires after 6 hours, because Meta says an `UNPUBLISHED` broadcast "may be automatically deleted after several hours": "This setup expired. [Set up again]". The same local 6-hour expiry applies to a `LIVE_NOW` setup that never receives a stream.
6. **Control room while live.**
   - A red "LIVE" pill with a running timer (the colour is not the only signal: the pill also carries text).
   - "Watching now: 23".
   - "Comments": the newest first, updated every 5 s, showing the text and the time. A name appears when Facebook shares it; otherwise "Someone" (VERIFY V-L7). The list is a live region that announces new comments politely, at most one announcement per 10 s.
   - **End live** (danger) asks to confirm: "End the live video? Viewers will see that it has ended. The recording stays on your Page."
7. **Ended.**
   - "Live ended · 42 min · At most 31 watching at once · [Watch the replay on Facebook]".
   - The stream key is deleted from Edwyz at this point.
8. **Change a scheduled live.**
   - **Change time** asks for a new time within 7 days.
   - **Cancel live** asks: "Cancel this live video? Nothing was shown on your Page yet."

### 2.6 Social results (`/app/content/results`)

1. **Open.** The menu item is Insights > Social results. The Content calendar header also has **Results**.
2. **Filters.**
   - Account chips: "All", "Sunrise Realty · Facebook", "@sunrise · Instagram", "@sunrise · Threads".
   - Period chips: "7 days", "28 days" (default), "90 days".
3. **Four tiles**, each with the change against the previous period ("up 12%", "down 3%", or "no change"):

| Tile | Shown for |
|---|---|
| **People reached** | Facebook and Instagram only. Hidden under All, because adding reach across apps counts people twice. |
| **Views** | Every channel |
| **Interactions** | Every channel |
| **New followers** | Every channel |

4. **Views per day.** A bar chart with a text value per bar. A "Show as table" toggle gives the accessible version.
5. **Best posts.** The top 5 by interactions. Each row shows the channel icon, the date, the first line of the text, "Views 2,300 · Interactions 140", and [View]. Posts made outside Edwyz are included.
6. **Best time to post.** "Your posts got the most interactions on Saturdays around 7 pm." It needs at least 10 posts in 90 days. Until then: "We'll suggest a best time after you've posted 10 times."
7. **Freshness.** "Updated 2 hours ago. Meta can take up to 2 days to finish counting." Owners and admins get [Refresh], at most once every 15 minutes per workspace.
8. **Help.** An (i) next to each tile opens one sentence, for example: "People reached: how many different people saw your posts. Meta estimates this number."
9. **Empty and missing states:**
   - "No results yet. Connect a Page, Instagram or Threads account to see how your posts do. [Connect accounts]".
   - When the permission is missing: "Allow Edwyz to read your Page results. [Reconnect Facebook]".
   - On a Page where this person can't see analytics (no `ANALYZE` task): "You don't have permission to see this Page's results. Ask a Page admin."
   - Instagram follower numbers under 100 followers: "Instagram shows follower numbers once you have 100 followers."

### 2.7 Threads replies

1. Post details > **Replies (12)**. The list shows "@name · 2 h · reply text", newest first, with [Hide] and [Reply]. The text is untrusted and shown as plain text.
2. **Hide.** The reply greys out with "Hidden" and [Unhide]. No confirm on the page: it can be undone.
3. **Reply.** A 500-character box labelled "Reply as @sunrise_realty", with [Send reply]. The toast says "Reply posted".
4. **Quota.** When the reply quota is used up: "Threads allows 1,000 replies a day from apps. Try again after {time}."

### 2.8 Eddy flows (examples)

- "Kal subah 10 baje Facebook aur Insta pe ye photo daal do, 'Diwali sale 20% off'"
  1. `draft_post` saves a draft. This is local and can be undone.
  2. A `publish_post` card follows: "Post to Facebook (Photo) and Instagram (Post) on Fri 1 Nov, 10:00 am?". It shows the exact text for each channel, the photo, the accounts and the warning "This goes to Meta". The button is [Schedule post].
- "Is hafte Insta pe kitne log pahunche?" → `get_social_results` answers: "Pichhle 7 din mein aapka Instagram lagbhag 1,240 logon tak pahuncha (12% zyada)."
- "Live ka stream key do" → Eddy refuses: "Safety ke liye stream key yahan nahi dikhayi jaati. Copy karne ke liye Live videos page kholiye. [Open Live videos]".
- "Live band karo" → an `end_live_video` card naming the Page and the live title.
- "Threads pe jo gaali wala reply hai usse hide kar do"
  1. `list_threads_replies` reads the replies.
  2. A `hide_threads_reply` card shows the reply text verbatim (untrusted) and the author.

### 2.9 Key copy

The pages are in English, as the ads spec decided in its D23. Eddy cards come in three languages from the server catalogue.

(critic) The catalogue rules in `tests/eddy-i18n.test.ts` apply:

- Hindi may use Latin letters only for Eddy, WhatsApp, Meta, Edwyz, Anthropic, Facebook, AI, Low and Medium (`HI_LATIN_ALLOW`). Hindi strings therefore write थ्रेड्स, इंस्टाग्राम, स्ट्रीम की and लाइव वीडियो in Devanagari.
- No string uses a gendered first person: "सकता" and "sakta" are out.
- Channel and account names arrive as `{placeholders}` and are not scanned.

| Key | en | hi | hinglish |
|---|---|---|---|
| `social.card.publish.title` | Post to {channels} {when}? | {when} {channels} पर पोस्ट करें? | {when} {channels} pe post karein? |
| `social.card.remove.title` | Remove this post from {channel}? This can't be undone. | इस पोस्ट को {channel} से हटाएँ? यह वापस नहीं होगा। | Ye post {channel} se hata dein? Ye wapas nahi hoga. |
| `social.card.golive.title` | Go live on {page} now? Everyone can see it. | अभी {page} पर लाइव जाएँ? सब इसे देख सकेंगे। | Abhi {page} pe live jaayein? Sab ise dekh sakenge. |
| `social.card.endlive.title` | End the live video on {page}? | {page} पर लाइव वीडियो बंद करें? | {page} pe live video band karein? |
| `social.card.schedulelive.title` | Set up a live video on {page} for {when}? | {when} के लिए {page} पर लाइव वीडियो तय करें? | {when} ke liye {page} pe live video set karein? |
| `social.eddy.no_key` | For safety, the stream key is never shown here. Open the Live videos page to copy it. | सुरक्षा के लिए स्ट्रीम की यहाँ कभी नहीं दिखाई जाती। इसे कॉपी करने के लिए लाइव वीडियो पेज खोलें। | Safety ke liye stream key yahan kabhi nahi dikhayi jaati. Copy karne ke liye Live videos page kholiye. |
| `social.results.reach_line` | Your {account} reached about {n} people in the last {days} days ({change}). | पिछले {days} दिनों में आपका {account} लगभग {n} लोगों तक पहुँचा ({change})। | Pichhle {days} din mein aapka {account} lagbhag {n} logon tak pahuncha ({change}). |
| `social.card.hide_reply.title` | Hide this reply on Threads? | थ्रेड्स पर यह जवाब छिपाएँ? | Threads pe ye reply chhupa dein? |
| `social.card.reply.title` | Reply on Threads as {account}? | {account} के रूप में थ्रेड्स पर जवाब दें? | {account} ki taraf se Threads pe reply karein? |
| `social.card.golive_auto.title` | Set up a live on {page} that goes public as soon as your stream starts? | {page} पर ऐसा लाइव तय करें जो आपकी स्ट्रीम शुरू होते ही सबको दिखे? | {page} pe aisa live set karein jo stream shuru hote hi sabko dikhe? |

---

## 3. API plan

### 3.1 Conventions

- **Facebook and Instagram calls on `graph.facebook.com/v26.0`** go through `graphFetchAs(token, request)` in `src/lib/graph/index.ts`. That function already:
  - runs the spend tripwire before any network I/O;
  - adds `appsecret_proof`;
  - retries up to 4 attempts on code 4, HTTP 429 and, for GETs, 5xx and network errors (`RETRYABLE_CODES` is `{4, 80007, 130429, 131056}`; Pages and Instagram codes 17, 32, 613, 80001 and 80002 are not retried there, so the publishers and the sync job handle them, 3.5);
  - never retries a POST whose outcome is unclear (`guardAllPosts`: a 5xx or lost connection on a POST is `ambiguous`);
  - (critic) accepts `method: "DELETE"` already, so F13 needs no new transport.
- **The other hosts** go through two new transports. Each runs `tripwire()` first and streams files from disk (it never buffers a whole video). Neither ever retries a step that creates or publishes something after an unclear outcome.
  - **`src/lib/graph/binary.ts`** (Meta's other upload hosts):
    - `resumableStart(userToken, {fileName, fileLength, fileType})` calls `POST /{app-id}/uploads`;
    - `resumableSend(userToken, sessionId, filePath, offset)` calls `POST /upload:{id}` with a `file_offset` header;
    - `resumableOffset(userToken, sessionId)` calls `GET /upload:{id}`;
    - `ruploadSend(kind, token, id, filePath, offset)` posts to `https://rupload.facebook.com/video-upload/v26.0/{id}` (Facebook Reels and video Stories) or to `https://rupload.facebook.com/ig-api-upload/v26.0/{id}` (Instagram; VERIFY V-I4: prefer the `uri` the container create returns);
    - `graphVideoPost(pageToken, pageId, fields)` posts to `https://graph-video.facebook.com/v26.0/{page-id}/videos`.

    Upload timeout: 10 min per request.

    (critic) Reuse: `src/lib/templates/upload.ts` already runs the same two resumable steps (`/{app-id}/uploads`, then `upload:{id}` with `Authorization: OAuth` and `file_offset`) for WhatsApp template samples, from memory and with the tenant's WhatsApp token. `binary.ts` follows its header and `appsecret_proof` handling, and adds streaming from disk, resume and the tripwire. `templates/upload.ts` itself is not changed.
  - **`src/lib/threads/client.ts`** (`threadsFetch(token, request)`) calls `https://${THREADS_GRAPH_HOST}/v1.0/{path}`, where `THREADS_GRAPH_HOST` defaults to `graph.threads.com`. It also holds the OAuth token endpoints. It maps Threads errors into `GraphError`, so `toPublishError()` works unchanged. It follows the same retry rules.
- **Tokens:**
  - **Page token:** `MetaAsset.tokenEnc` on `page` and `instagram` rows, from `me/accounts` (discovery stores the Page's token on its Instagram row too). Used for every Page call and, as today, for Instagram publishing (the content publishing guide names a Page access token).
  - **User token:** `MetaConnection.tokenEnc`. Used where Meta's docs name a user token:
    - the resumable upload session (F4, F5): "Use a User access token" and "You must include the access token in the header";
    - (critic) Instagram insights (R4–R6). The user-insights and media-insights references both name a "Facebook User access token", so the user token is the default. V-R6 checks whether the Page token also works; if it does, nothing changes.

    A new helper, `getAssetUserAccess(tenantId, assetId)`, goes in `src/lib/meta-connect/index.ts`. It returns the connection's user token (`openSecret(tenantId, connection.tokenEnc)`, never the asset's) for an asset of the tenant and runs the same checks as `getAssetAccess`.
  - **Threads token:** `ThreadsAccount.tokenEnc`, sealed with `sealSecret(tenantId, …)`.
- **Idempotency.**
  - Each step that creates something saves the id Meta returns into `PostTarget.progress` before the next step runs. A repeated run reuses the saved ids, so it never makes a second container, video or upload session.
  - Before every create or publish step, the run records `progress.phase = "create"` or `"publish"`. A target found in `processing` whose phase is `create` or `publish`, and whose heartbeat is older than 2 minutes, is treated as **unclear outcome** and failed with the "Check first" copy.
  - A target interrupted during `upload` is resumed from the stored offset, because uploading posts nothing.
- **Access levels.** All permissions here need **Advanced Access** before any account without a role on the app can use them. Until then, only app admins, developers, testers and Threads testers can connect.

### 3.2 Calls by flow

Permissions are listed as Meta's docs name them. "Task" is the Page task the person must hold, from `MetaAsset.meta.tasks`.

**Facebook Page publishing (Page token, task `CREATE_CONTENT`).** The `/{page-id}/feed` reference requires `pages_manage_posts`, `pages_read_engagement` and `pages_show_list`. The Pages posts guide also lists `pages_manage_engagement` and `pages_read_user_engagement` for its whole page (VERIFY V-F1 shows the publish calls work without them).

(critic) Confirmed on 2026-10-31:

- **Video publishing guide:** a Page token from someone with `CREATE_CONTENT`, and `pages_show_list`, `pages_read_engagement` and `pages_manage_posts`. It does not mention `publish_video`.
- **Reels publishing guide:** the same three permissions; 3 to 90 s, 9:16, at least 540 × 960, 24 to 60 fps; "limited to 30 API-published posts within a 24-hour moving period".
- **Page Stories guide:** the same three permissions, with videos of 3 to 90 s.

| # | Call | Payload (body as JSON) | Returns | Notes |
|---|---|---|---|---|
| F1 | `POST /{page-id}/feed` | `{message, link?}` | `{id}` | Text and link posts (exists). `link` comes from `ScheduledPost.link`, or else from the first URL in the text. |
| F2 | `POST /{page-id}/photos` | `{url, caption, published:true}` | `{id, post_id}` | One photo (exists). `url` is a signed media URL valid for 1 h. |
| F3 | `POST /{page-id}/photos` per photo, then `POST /{page-id}/feed` | Each photo: `{url, published:false}` → `{id}`. Then the feed post: `{message, attached_media:[{media_fbid:"<id>"},…]}` | `{id}` | Album of 2 to 10 photos (VERIFY V-F2 for the maximum). The ids are saved in `progress.photoIds`. Unpublished photos are deleted by Meta after about 24 h, so both steps run in one worker run. |
| F4 | `POST /{app-id}/uploads?file_name&file_length&file_type=video/mp4` | (query only, user token) | `{id:"upload:…"}` | Starts the resumable session for a Page video. Saved in `progress.uploadSession`. |
| F5 | `POST /upload:{id}` with headers `Authorization: OAuth {user token}` and `file_offset: {n}`, body = the file bytes | | `{h}` | Sends the file (resumable). `GET /upload:{id}` returns `file_offset` so an interrupted upload can resume. |
| F6 | `POST graph-video.facebook.com/v26.0/{page-id}/videos` | `{title, description, fbuploader_video_file_chunk: h}` | `{id}` | Publishes the Page video. MOV files use F6b instead (V-F3), because the resumable API lists only `video/mp4`. |
| F6b | `POST /{page-id}/videos` | `{file_url, title, description}` | `{id}` | The fallback (exists): Meta fetches the signed URL. This needs the robots rule in 5.5. |
| F7 | `POST /{page-id}/video_reels` | `{upload_phase:"start"}` | `{video_id, upload_url}` | Starts a Reel. Meta allows at most 30 API Reels per Page per rolling 24 h; Edwyz counts its own and waits (3.6). |
| F8 | `POST rupload.facebook.com/video-upload/v26.0/{video-id}` with headers `Authorization: OAuth {page token}`, `offset: {n}`, `file_size: {bytes}`, body = the file bytes | | `{success:true}` | Uploads the Reel bytes. `GET /{video-id}?fields=status` → `uploading_phase.bytes_transfered` gives the offset to resume from. |
| F9 | `POST /{page-id}/video_reels` | `{upload_phase:"finish", video_id, video_state:"PUBLISHED", description}` | `{success:true}` | Publishes the Reel. The guide's parameter table says `finish`, while the same row says "To publish this should be `complete`"; the examples use `finish` (VERIFY V-F4). Then poll `GET /{video-id}?fields=status` every 60 s until `status.publishing_phase.status` is `complete`. The guide documents no post id, so the permalink is read with F12 on the video id (`permalink_url`; `post_id` is VERIFY V-F4). `externalId` stores the video id. |
| F10 | `POST /{page-id}/photos`, then `POST /{page-id}/photo_stories` | Photo: `{url, published:false}` → `{id}`. Story: `{photo_id}` | `{success, post_id}` | Photo Story. |
| F11 | `POST /{page-id}/video_stories`, then rupload (F8), then finish | Start: `{upload_phase:"start"}`. Finish: `{upload_phase:"finish", video_id}` | `{success, post_id}` | Video Story, at most 60 s. |
| F12 | `GET /{post-id}?fields=permalink_url` | | | Permalink read-back after publishing (`pages_read_engagement`). For a video or Reel: `GET /{video-id}?fields=permalink_url,post_id`. |
| F13 | `DELETE /{post-id}`, or `DELETE /{video-id}` for a video or Reel | | `{success:true}` | **Remove from Facebook.** Meta lets an app update only posts it made, and Edwyz only offers Remove on posts it made. Stories: no API (VERIFY V-F9). |
| F14 | `GET /{page-id}?fields=followers_count,name,link` | | | Live eligibility and the Results header (`pages_read_engagement`). |

**Instagram (Facebook Login family, `graph.facebook.com`).** Every call needs `instagram_basic` and `pages_read_engagement`. Writes also need `instagram_content_publish`. The person needs the task `MANAGE` or `CREATE_CONTENT` on the linked Page. A Page that requires Page Publishing Authorization (PPA) is blocked until it is done.

| # | Call | Payload | Returns | Notes |
|---|---|---|---|---|
| I1 | `GET /{ig-user-id}?fields=username,name,followers_count,media_count` | | | Chip and Results header. |
| I2 | `GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,config` | | `{data:[{quota_usage, config:{quota_total, quota_duration}}]}` | Exists. Read before each new container and for the meter, cached 5 min. Limit: the guide says 100 API posts per rolling 24 h, but its carousel section says 50, so the meter and the wait always use the returned `quota_total`. A carousel counts as one. When the quota is full, publishing answers code 9 with subcode 2207042 (third-party sources; V-I8). |
| I3 | `POST /{ig-user-id}/media` | `{image_url, caption, alt_text?}` | `{id}` | One photo. JPEG only, up to 8 MB, aspect ratio between 4:5 and 1.91:1, width 320 to 1440 px. `alt_text` is up to 1,000 characters, for images only. |
| I4 | `POST /{ig-user-id}/media` per item, then the parent | Photo item: `{is_carousel_item:true, image_url, alt_text?}`. Video item: `{is_carousel_item:true, media_type:"VIDEO", upload_type:"resumable"}`, then I6. Parent: `{media_type:"CAROUSEL", children:"id1,id2,…", caption}` | `{id}` | Carousel of up to 20 items ("Carousels are limited to 20 images, videos, or a mix of the two", confirmed 2026-10-31). Reels are not allowed inside a carousel. The child ids are saved in `progress.children` as each one is created. (critic) The guide says `alt_text` works on "image posts" but does not say whether carousel children take it (VERIFY V-I10). Until then, `alt_text` is sent on child images and a refusal (code 100) is retried once without it. |
| I5 | `POST /{ig-user-id}/media` | `{media_type:"REELS", upload_type:"resumable", caption, share_to_feed, thumb_offset?}` | `{id, uri?}` | Reel: MOV or MP4, 3 s to 15 min, up to 300 MB, 23 to 60 fps. `upload_type=resumable` is offered only to apps that use Facebook Login for Business, which Edwyz does. |
| I6 | `POST rupload.facebook.com/ig-api-upload/v26.0/{container-id}` with headers `Authorization: OAuth {token}`, `offset: 0`, `file_size: {bytes}`, body = the file bytes | | `{success:true, message:"Upload successful."}` | Uploads the video bytes (V-I4: path with or without the version). |
| I7 | `POST /{ig-user-id}/media` | Photo: `{media_type:"STORIES", image_url}`. Video: `{media_type:"STORIES", upload_type:"resumable"}`, then I6 | `{id}` | Story. Video Stories: 3 to 60 s, up to 100 MB. Stickers are not supported. |
| I8 | `GET /{container-id}?fields=status_code` | | `EXPIRED`, `ERROR`, `FINISHED`, `IN_PROGRESS` or `PUBLISHED` | Meta advises checking once a minute for no more than 5 minutes. Edwyz polls 3 times at 10 s inside a run, then waits 60 s between runs, up to the existing 24 h limit. |
| I9 | `POST /{ig-user-id}/media_publish` | `{creation_id}` | `{id}` | Exists. |
| I10 | `GET /{ig-media-id}?fields=permalink,media_product_type,timestamp` | | | Permalink read-back. |
| I11 | `GET /{ig-user-id}/media?fields=id,caption,media_type,media_product_type,timestamp,permalink&limit=25` | | | Recent posts for Results, including ones not made in Edwyz. |

(critic) No delete call is made in v1. The Instagram Media reference now lists `DELETE /<IG_MEDIA_ID>` (Facebook Login, user token, `instagram_basic` plus `instagram_manage_contents`). But its syntax block shows `POST`, and the permission has no reference page, so it is left for V-I11 (1.3, D8).

Containers: at most **400** per account per rolling 24 h. This comes from the `/media` reference as quoted by third parties; it is absent from the publishing guide (VERIFY V-I12: read the `/{ig-user-id}/media` reference page). Edwyz never comes near it, because containers are created only at publish time.

**Live video (Page token).** Meta's live docs ask for:

- `pages_read_engagement` and `pages_manage_posts` on a Page token of an admin;
- `publish_video`, required "for reading and monitoring the LiveVideo object" and, per the permission reference, "to live-video stream to … Page";
- App Review for the **Live Video API** feature.

Eligibility: the Page needs **at least 100 followers** and the Facebook account must be **at least 60 days old** (in force since 2024-06-10). The errors are code 200 with subcode 1363144 (followers) and 1363120 (account age), confirmed in the getting-started guide on 2026-10-31. Edwyz needs an RTMPS stream from the owner's encoder. It produces no video itself.

(critic) What each page confirms:

- **Getting-started guide:** `publish_video` and the 60-day and 100-follower rules.
- **`/{page-id}/live_videos` reference:** the `status` enum `{UNPUBLISHED, LIVE_NOW, SCHEDULED_UNPUBLISHED, SCHEDULED_LIVE, SCHEDULED_CANCELED}`, "Maximum 254 characters" for `title`, and error codes 200, 368, 100, 190, 102, 1000 and 1005.
- **Not stated on those pages:** `pages_read_engagement`, `pages_manage_posts`, the Live Video API feature and the `CREATE_CONTENT` task. Edwyz still requires `CREATE_CONTENT` (`canGoLive`) and keeps the feature request, which is already in the App Review draft.

| # | Call | Payload | Returns | Notes |
|---|---|---|---|---|
| L0 | F14 `followers_count` | | | The followers check before setup. |
| L1 | `POST /{page-id}/live_videos` | `{status:"UNPUBLISHED", title, description}` | `{id, stream_url, secure_stream_url, stream_secondary_urls, secure_stream_secondary_urls, dash_ingest_url}` | **Now**: get the key first, then Go live. `UNPUBLISHED` is a draft that viewers can't see and that "may be deleted automatically after several hours". `title` is at most 254 characters. |
| L1b | `POST /{page-id}/live_videos` | `{status:"LIVE_NOW", title, description}` | Same as L1 | (critic) **Now, go live as soon as the stream starts** (2.5 step 3, the phone path). This is the path Meta's getting-started guide documents. `LiveBroadcast.autoStart = true`. The setup confirm and Eddy's card carry the `irreversible` warning, because the live becomes public without another tap. |
| L2 | `POST /{page-id}/live_videos` | `{status:"SCHEDULED_UNPUBLISHED", title, description, event_params:{start_time:<unix seconds>}}` | Same as L1 | **Later**, up to 7 days ahead ("up to seven days from their creation date", scheduling guide). VERIFY V-L2: the scheduling guide passes `event_params=<UNIX_TIMESTAMP>`, while the reference describes `event_params.start_time` (its example is `{ start_time: 1641013200, cover: '…' }`). Try the object form, then the bare form. The guide gives no minimum lead time, so Edwyz asks for at least 10 minutes and maps error 1000 ("Invalid time for an event") to the 3.5 copy. |
| L3 | `GET /{live-id}?fields=status,ingest_streams{stream_health,is_master},live_views,permalink_url,video{id},broadcast_start_time,errors` | | | Polled every 5 s while the control room is open, and every 30 s by the worker. Stream health refreshes every 2 s, and Meta reports a timeout after 4 s without data. "Receiving your stream" means a master ingest stream with `stream_health.video_bitrate > 0` (VERIFY V-L3). `live_views` is VERIFY V-L4. If it is missing, the tile is hidden. |
| L4 | `POST /{live-id}` | `{status:"LIVE_NOW"}` | `{id}` | **Go live.** "The broadcast goes live if the stream is active." Without a stream, Meta refuses. |
| L5 | `POST /{live-id}` | `{end_live_video:true}` | `{id}` | **End live.** The status becomes `VOD` and the recording stays on the Page. |
| L6 | `POST /{live-id}` | `{title?, description?, event_params?:{start_time}}` | | Edit or reschedule. |
| L7 | `POST /{live-id}` with `{status:"SCHEDULED_CANCELED"}`, or `DELETE /{live-id}` | | | **Cancel** a live that hasn't started (VERIFY V-L6: which of the two Meta expects). Never used on a live that is running. |
| L8 | `GET /{live-id}/comments?order=reverse_chronological&live_filter=filter_low_quality&fields=id,message,created_time,from{name}&limit=25` | | | Live comments, polled every 5 s by the server (cached 4 s per live and shared between viewers). Meta's guidance is to poll in reverse chronological order. Low-quality filtering is on by default. VERIFY V-L7: whether `from` needs `pages_read_user_content`. |
| L9 | `GET /{live-id}/reactions?summary=total_count&limit=0` | | `{summary:{total_count}}` | Reaction count on the ended card (VERIFY V-L8). |

Never sent: `donate_button_charity_id` (the Fundraisers spec owns it), `crossposting_actions`, `targeting`, `is_spherical`, `game_show`. The streaming SSE host `streaming-graph.facebook.com` is not used (5.5).

Stream key handling (7.3):

- `secure_stream_url` has the form `rtmps://{host}[:443]/rtmp/{key}`.
- Edwyz splits it after `/rtmp/`, as Meta's guide tells streaming-software users to. The server part, ending in `/rtmp/`, is stored as `streamServer`, and the key is sealed into `streamKeyEnc`.
- When a URL does not match that form, the whole URL is sealed and shown as "Full URL".

**Results** (read only; 4.3 shows how the numbers are stored):

| # | Call | Permissions | Notes |
|---|---|---|---|
| R1 | `GET /{page-id}/insights?metric=page_media_view,page_total_media_view_unique,page_post_engagements,page_daily_follows_unique,page_follows,page_video_views,page_views_total&period=day&since={YYYY-MM-DD}&until={YYYY-MM-DD}` | `read_insights` and `pages_read_engagement`. Task `ANALYZE`. | Without `read_insights` Meta returns an empty dataset. Data is stored for 2 years. Several older metrics were deprecated: `page_impressions*` on 2025-06-15 and 2025-11-15, `page_fans` on 2025-11-15. More are deprecated by 2026-06-15 (VERIFY V-R1: re-read the deprecated-metrics page at build time). (critic) On 2026-10-31 the reference lists every metric in this call without a deprecation mark. `page_impressions_unique` and `post_impressions` are marked deprecated above v25, and Edwyz uses neither. All metric names live in one catalog file (`social-insights/catalog.ts`). The reference says "Only 90 days of insights can be viewed at one time", so the 90-day backfill takes three calls of 30 days each (V-R2 resolved). |
| R2 | `GET /{post-id}/insights?metric=post_media_view,post_total_media_view_unique,post_clicks,post_reactions_by_type_total` | Same as R1 | Per post. Video posts and Reels add `post_video_views` and `post_video_avg_time_watched`. |
| R3 | `GET /{page-id}/published_posts?fields=id,message,created_time,permalink_url,status_type&limit=25` | `pages_read_engagement` | The recent posts list, so the best-posts list also covers posts made outside Edwyz. |
| R4 | `GET /{ig-user-id}/insights?metric=reach,views,accounts_engaged,total_interactions,likes,comments,shares,saves,profile_links_taps&period=day&metric_type=total_value&since={day start}&until={day end}` | `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` (plus `ads_read` and `ads_management` when the person's Page role comes through Business Manager; both are already requested). (critic) User token (`getAssetUserAccess`), as the reference names; V-R6 tries the Page token. | One call per day for daily rows. Data can arrive up to 48 h late. An empty set means no data; it is never stored as 0. Combining a metric with a breakdown it doesn't support returns "unknown error", so no breakdowns are requested. `impressions` is deprecated. |
| R5 | `GET /{ig-user-id}/insights?metric=follower_count&period=day&since&until` | Same as R4 | New followers per day. Only for accounts with 100 or more followers, and only for the last 30 days (VERIFY V-R5: `follower_count` is missing from the current metric table, so if it is refused, use `follows_and_unfollows` with `breakdown=follow_type`). |
| R6 | `GET /{ig-media-id}/insights?metric=views,reach,likes,comments,shares,saved,total_interactions` | Same as R4 | Reels add `ig_reels_avg_watch_time`. (critic) Stories use `views,reach,replies,shares,navigation,follows,profile_visits`. `total_interactions`, `likes`, `comments` and `saved` are not listed for STORY, so a Story's `interactions` = `replies + shares`. Story metrics are "only available for 24 hours", and values under 5 return error code 10, shown as "Too few views to show numbers". Metrics are kept for 2 years. Media inside an album has no insights. User token (V-R6 tries the Page token). |
| R7 | Two calls. `GET /{threads-user-id}/threads_insights?metric=views,likes,replies,reposts,quotes,clicks&since&until`, then `GET /{threads-user-id}/threads_insights?metric=followers_count` | `threads_basic`, `threads_manage_insights` | `views` is a daily time series, and the others are totals. (critic) `followers_count` takes no `since` or `until`, so it gets its own call and its daily snapshot gives `newFollowers` (4.3). `clicks` exists since 2025-07-02. Since 2026-01-30, `followers_count` also works for profiles without a linked Instagram account. The earliest timestamp accepted is 1712991600 (2024-04-13). The default range is yesterday to today. |
| R8 | `GET /{threads-media-id}/insights?metric=views,likes,replies,reposts,quotes,shares` | Same as R7 | Lifetime numbers. Nested replies are not counted. |
| R9 | `GET /{threads-user-id}/threads?fields=id,text,timestamp,permalink,media_type&limit=25` | `threads_basic` | Recent Threads posts. |

**Threads** (`graph.threads.com`; OAuth hosts `threads.com` and `graph.threads.com`):

| # | Call | Payload | Returns | Notes |
|---|---|---|---|---|
| T1 | Browser to `https://threads.com/oauth/authorize?client_id={THREADS_APP_ID}&redirect_uri={site}/api/meta-connect/threads/callback&scope=threads_basic,threads_content_publish,threads_manage_insights,threads_read_replies,threads_manage_replies,threads_delete&response_type=code&state={signed}` | | `?code=…&state=…`, or `error=access_denied&error_reason=user_denied` | `client_id` is the **Threads app ID** shown under the Threads use case's Settings, not `META_APP_ID`. `redirect_uri` must match the dashboard exactly; watch for a trailing slash the dashboard may add. Strip a trailing `#_` from the code. A code lasts 1 h and works once. |
| T2 | `POST https://graph.threads.com/oauth/access_token` (form) | `client_id, client_secret={THREADS_APP_SECRET}, grant_type=authorization_code, redirect_uri, code` | `{access_token, token_type:"bearer", user_id}` | Gives a short-lived token, valid for 1 h. |
| T3 | `GET https://graph.threads.com/access_token?grant_type=th_exchange_token&client_secret&access_token` | | `{access_token, token_type, expires_in}` | Gives a long-lived token, valid for 60 days. Server side only. |
| T4 | `GET https://graph.threads.com/refresh_access_token?grant_type=th_refresh_token&access_token` | | Same as T3 | Gives another 60 days. The token must be at least 24 h old and unexpired, and the person must have granted `threads_basic`. |
| T5 | `GET /v1.0/me?fields=id,username,name,threads_profile_picture_url,is_verified` | | | The profile, saved on the account row. The picture URL is not stored, because it expires (7.4). |
| T6 | `GET /v1.0/debug_token?input_token={token}&access_token=TH\|{app id}\|{app secret}` | | `{data:{is_valid, scopes, expires_at, user_id}}` | Reads which permissions were granted, at connect and in the weekly check. Since 2026-08-18 an app access token is accepted here (Threads changelog, confirmed). VERIFY V-T9: the exact app-token form (`TH\|id\|secret` versus `id\|secret`). If T6 fails, `scopes` is left as it was and nothing is blocked, because each call's own permission error (3.5) is the real check. |
| T7 | `GET /v1.0/{user}/threads_publishing_limit?fields=quota_usage,config,reply_quota_usage,reply_config,delete_quota_usage,delete_config` | | | Limits per 24 h: 250 posts, 1,000 replies and 100 deletes. This call needs `threads_basic`, `threads_content_publish` and `threads_manage_replies`. |
| T8 | `POST /v1.0/{user}/threads` | `{media_type:"TEXT", text, link_attachment?, topic_tag?, reply_control?}` | `{id}` | A text post as a container. `auto_publish_text` is not used, so every post takes the same two-step, resumable path. `text` is at most 500 characters; emoji count by their UTF-8 bytes. At most 5 links. `link_attachment` works on TEXT posts only. |
| T9 | `POST /v1.0/{user}/threads` | `{media_type:"IMAGE", image_url, text?, alt_text?, …}` or `{media_type:"VIDEO", video_url, text?, alt_text?, …}` | `{id}` | Images: JPEG or PNG up to 8 MB. Videos: MOV or MP4, up to 5 min and 1 GB. `alt_text` is up to 1,000 characters. URLs are signed media URLs. |
| T10 | `POST /v1.0/{user}/threads` per item, then the parent | Item: `{media_type:"IMAGE"\|"VIDEO", is_carousel_item:true, image_url\|video_url, alt_text?}`. Parent: `{media_type:"CAROUSEL", children:"a,b", text?, reply_control?, topic_tag?}` | `{id}` | 2 to 20 items. A carousel counts as one post. The ids are saved in `progress.children`. |
| T11 | `GET /v1.0/{container-id}?fields=status,error_message` | | `IN_PROGRESS`, `FINISHED`, `PUBLISHED`, `ERROR` or `EXPIRED`. Errors: `FAILED_DOWNLOADING_VIDEO`, `FAILED_PROCESSING_AUDIO`, `FAILED_PROCESSING_VIDEO`, `INVALID_ASPEC_RATIO`, `INVALID_BIT_RATE`, `INVALID_DURATION`, `INVALID_FRAME_RATE`, `INVALID_AUDIO_CHANNELS`, `INVALID_AUDIO_CHANNEL_LAYOUT`, `UNKNOWN` | Meta suggests waiting about 30 s before publishing. Edwyz waits 30 s, checks, then checks once a minute for up to 5 minutes. |
| T12 | `POST /v1.0/{user}/threads_publish` | `{creation_id}` | `{id}` | Publishes the container. |
| T13 | `GET /v1.0/{media-id}?fields=permalink,shortcode,timestamp` | | | Permalink read-back. |
| T14 | `DELETE /v1.0/{media-id}` | | `{success, deleted_id}` | **Remove from Threads.** Needs `threads_basic` and `threads_delete`. At most 100 a day. |
| T15 | `GET /v1.0/{media-id}/replies?fields=id,text,username,timestamp,hide_status,has_replies&reverse=true` | | | Replies. Needs `threads_read_replies` (V-T5 for the exact field names). |
| T16 | `POST /v1.0/{reply-id}/manage_reply` | `{hide:true\|false}` | `{success:true}` | Hide or unhide a top-level reply; hiding one also hides its nested replies. Needs `threads_manage_replies`, which the docs require for "POST calls to reply endpoints". |
| T17 | `POST /v1.0/{user}/threads` with `{media_type:"TEXT", text, reply_to_id}`, then T12 | | | Reply as the account. Needs `threads_manage_replies`, plus `threads_content_publish` (VERIFY V-T6). Counts against the 1,000 replies per 24 h. |

### 3.3 Payload shapes Edwyz sends (exact)

```jsonc
// F3 album, step 2 (Page token)
POST /v26.0/{page-id}/feed
{ "message": "Diwali sale 20% off", "attached_media": [ { "media_fbid": "1203…" }, { "media_fbid": "1204…" } ] }

// F9 Reel finish
POST /v26.0/{page-id}/video_reels
{ "upload_phase": "finish", "video_id": "8812…", "video_state": "PUBLISHED", "description": "New flats in Sector 21 #realestate" }

// I4 carousel parent
POST /v26.0/{ig-user-id}/media
{ "media_type": "CAROUSEL", "children": "1789…,1790…,1791…", "caption": "Diwali sale 20% off" }

// I5 Reel container
POST /v26.0/{ig-user-id}/media
{ "media_type": "REELS", "upload_type": "resumable", "caption": "…", "share_to_feed": true, "thumb_offset": 1500 }

// L2 scheduled live
POST /v26.0/{page-id}/live_videos
{ "status": "SCHEDULED_UNPUBLISHED", "title": "Diwali offers: live Q&A", "description": "", "event_params": { "start_time": 1762003800 } }

// T10 Threads carousel parent
POST /v1.0/{threads-user-id}/threads
{ "media_type": "CAROUSEL", "children": "1801…,1802…", "text": "Diwali sale 20% off", "reply_control": "everyone", "topic_tag": "Diwali" }
```

Every POST body is sent as JSON, as `graphFetchAs` already does. Exceptions:

- the Threads OAuth exchange (T2) is form-encoded, as Meta documents it;
- F6 on `graph-video` is a multipart form, because it carries form fields (VERIFY V-F3: whether JSON is accepted).

### 3.4 Webhooks

No new webhook subscription in this spec (D16):

- **Page `live_videos` field.** Live status comes from polling instead (L3, worker every 30 s for at most 3 lives per workspace). The Page's `subscribed_apps` call stays `leadgen` only. Adding a field there would change the shared subscription that the leads and messaging specs also own.
- **Instagram `story_insights`.** It needs Instagram webhook setup in the dashboard and Advanced Access. Edwyz instead fetches Story numbers 21 h after publishing, before the 24 h expiry (4.3).
- **Threads `replies`, `delete`, `mentions` and `publish`.** (critic) These need the "Threads Webhooks" sub-use case added in the dashboard, and they deliver only with Advanced Access. The `delete` field also needs `threads_delete`. Replies are fetched when the Replies panel opens.

Recorded for later (D16): Threads `publish` and `delete` would keep the calendar in sync with posts changed in the Threads app. Threads `replies` would let a reply notice appear.

### 3.5 Meta errors in plain words (`src/lib/content/errors.ts`, used by publishers, Live and Results)

| Meta answer | What the owner reads | What Edwyz does |
|---|---|---|
| 190 (any host) | "Your Facebook connection has expired. Reconnect it in Settings > Meta connections, then try again." Threads version: "Your Threads connection has expired. Reconnect Threads in Settings > Meta connections." | The target fails. The health worker marks the connection. A notice appears (5.8). |
| 10, 200 or 3 (permission), no subcode | "Edwyz isn't allowed to {post on | read results of | go live on} {account}. Reconnect and allow it." | Fails. |
| 200 + 1363144 | "Facebook lets Pages go live from apps only when they have at least 100 followers." | The setup is refused. |
| 200 + 1363120 | "Facebook lets an account go live from apps once it's at least 60 days old." | Same. |
| 4, 17, 32, 613, 80001, 80002 | "Meta asked us to slow down. We'll try again in a few minutes." | Retried with backoff for publishing. Results pause that account for 1 h. |
| 368 | "Facebook blocked this for now because it looked like spam to them. Wait an hour and try again." | Fails, with no automatic retry. |
| 1000 (live) | "That start time doesn't work for Facebook. Choose a time within the next 7 days." | Field error. |
| Instagram publishing limit (`content_publishing_limit` full, or error 9 with subcode 2207042, VERIFY V-I8) | "Instagram allows {total} posts a day from apps. This post will go out after {time}." (`total` = `quota_total`) | Waits until the quota resets (the existing 15 min defer, which only claims after the reset). |
| Instagram aspect ratio (36003 or 2207009, V-I8) | "This photo's shape doesn't fit Instagram. Use a square, an upright 4:5 or a wide 1.91:1 photo." | Fails. The composer normally catches this first. |
| Instagram image format or size (2207004, 2207005) | "Instagram needs a JPEG photo up to 8 MB." | Fails. |
| Instagram video (2207026) | "Instagram couldn't use this video. Use an MP4 or MOV between 3 seconds and 15 minutes." | Fails. |
| Instagram container `ERROR` or `EXPIRED` | "Instagram couldn't process the media. Try a different file." | Fails. |
| PPA required (FB 200 or IG 10 with a PPA subcode, V-I9) | "Facebook needs you to confirm your identity for this Page before apps can post (Page Publishing Authorization)." The button "Open Meta" comes from the `meta-screens.ts` key `page_publishing_authorization`, owned by the ads spec PRM-07. Until that exists, the instructions are shown as text. | Fails. |
| Media download failed (FB 100 or IG 9004, V-I8) | "Meta couldn't download the file from Edwyz. Try again. If it keeps happening, upload the file again." | One retry, then fails. |
| Threads `THREADS_API__LINK_LIMIT_EXCEEDED` | "Threads allows at most 5 links in one post." | Fails. The composer normally catches this. |
| Threads `INVALID_DURATION` | "Threads videos can be up to 5 minutes long." | Fails. |
| Threads `INVALID_ASPEC_RATIO`, `INVALID_FRAME_RATE`, `INVALID_BIT_RATE`, `FAILED_PROCESSING_*` | "Threads couldn't use this video. Export it again as MP4 (H.264, 30 fps) and try again." | Fails. |
| Threads `FAILED_DOWNLOADING_VIDEO` | "Threads couldn't download the video from Edwyz. Try again." | One retry. |
| Threads quota (T7 full) | "Threads allows 250 posts a day from apps. This post will go out after {time}." | Waits. |
| Facebook Reels: own count ≥ 30 in 24 h | "Facebook allows 30 Reels a day from apps for each Page. This Reel will go out after {time}." | Waits until the oldest of the 30 is 24 h old. |
| Unknown, or 5xx on a create or publish step | "Meta didn't confirm whether this was posted. Check {account} first. If it isn't there, [Post it again]." | Fails as an unclear outcome. Never retried automatically. |

Raw Meta messages never reach the screen (`sanitizeMessage` stays). Unknown codes fall back to "{Channel} didn't accept this post. Try again, or change the media."

### 3.6 Rate limits and quotas

| Limit | Value | How Edwyz respects it |
|---|---|---|
| Instagram posts | `quota_total` from I2 per rolling 24 h (the guide says 100; one section still says 50); a carousel counts as one | I2 before each new container. The composer meter. A post that does not fit waits (existing). |
| Instagram containers | 400 per rolling 24 h (V-I12) | Containers are created only at publish time, never on preview. Reused after a failure. |
| Instagram container status | Check once a minute for no more than 5 minutes | 3 checks at 10 s inside a run, then 60 s waits between runs. |
| Facebook Reels | 30 API Reels per Page per rolling 24 h | Edwyz counts its own published `reel` targets per asset in the last 24 h (index in 4.1). |
| Threads | 250 posts, 1,000 replies, 100 deletes and 500 location searches per 24 h | T7 before publishing, replying or deleting. Cached 5 min. |
| Page and Instagram business use case limits | Shared per Page and per account (VERIFY V-R7 for the current formula; historically 4,800 calls times engaged users or impressions per 24 h) | Results sync caps (5.4): at most 40 calls per account per run and 200 per run. An account that returns code 4, 17, 32, 613, 80001 or 80002 is paused for 1 h, with the pause time kept in `PlatformSetting` `social-sync-pause:{accountRef}`. |
| Live stream health | Refreshes every 2 s | Polled no faster than every 5 s, shared between viewers through the 4 s server cache. |
| Live comments | "Poll comments and reactions every few seconds" | Every 5 s, server-side, cached. |
| Insights freshness | Instagram up to 48 h late. Page metrics refresh several times a day. | The UI says so. The last 3 days are re-fetched on every sync. |

### 3.7 App routes (new and changed)

Writes use `writeActor` (CSRF check, sign-in, admin) unless stated. Reads use `getActor` (any member) unless stated.

| Route | Who | What |
|---|---|---|
| `GET /api/content/targets` (changed) | member | Adds Threads accounts. Each target now carries `formats` (allowed formats), `canPost`, `reason` and `quota: {used, total, resetsAt}` for Instagram and Threads. |
| `POST /api/content/posts`, `PATCH /api/content/posts/[id]` (changed) | admin | Body: `{body, mediaKeys[≤20], mediaAlt:{key:alt}, link?, assetIds[], targets?:[{assetId, format, options, text?}], scheduledAt, draft, requireApproval}`. When `targets` is missing, formats come from 2.1 (backward compatible). |
| `POST /api/content/posts/[id]/targets/[targetId]/remove` (new) | admin | Removes a published post from Facebook or Threads (F13, T14). Refused for Instagram with the 2.4 copy. |
| `POST /api/content/posts/[id]/targets/[targetId]/retry` (new) | admin | Puts a `failed` target back to `pending` and the post back to `publishing`. Body `{confirmUnclear:true}` is required when the failure was an unclear outcome. |
| `GET /api/content/quota?assetId=` (new) | member | Posts left today (I2 or T7), cached 5 min. |
| `GET /api/content/media` (changed) | member | Items gain `width`, `height` and `durationMs`. |
| `GET` and `POST /api/content/live` (new) | member reads; admin creates | List; create. Body `{pageAssetId, title, description?, when: "now" \| ISO datetime, start?: "tap" \| "auto"}`. `now` with `tap` (the default) uses L1, `now` with `auto` uses L1b, and a datetime uses L2 (`start` is ignored). |
| `GET`, `PATCH` and `DELETE /api/content/live/[id]` (new) | member reads; admin writes | Status (L3, cached 5 s); edit or reschedule (L6); cancel (L7). |
| `POST /api/content/live/[id]/go-live` and `/end` (new) | admin | L4 and L5. |
| `GET /api/content/live/[id]/key` (new) | admin, `no-store` | Returns `{server, key, fullUrl}`. Audited as `live.key_viewed`. At most 10 requests a minute per user. |
| `GET /api/content/live/[id]/comments` (new) | member | L8, cached 4 s. |
| `GET /api/content/results/summary?account=&days=` (new) | member | The tiles, views per day and freshness. |
| `GET /api/content/results/posts?account=&days=&sort=` (new) | member | Best posts and the data for best time. |
| `GET /api/content/results/posts/[statId]` (new) | member | One post's numbers. |
| `POST /api/content/results/refresh` (new) | admin | Queues a sync now. At most once every 15 min per workspace. |
| `GET` and `POST /api/content/threads/[targetId]/replies` (new) | member reads; admin replies | T15; T17. |
| `PATCH /api/content/threads/[targetId]/replies/[replyId]` (new) | admin | `{hidden:boolean}` → T16. |
| `POST /api/meta-connect/threads/start` (new) | admin | Returns `{url}` for T1. `?popup=1` uses the popup pattern. |
| `GET /api/meta-connect/threads/callback` (new) | the signed-in member who started it | T2 → T3 → T5 → T6, then saves the account. |
| `GET /api/meta-connect/threads/accounts` (new) | member | Threads accounts with their status and missing permissions. |
| `DELETE /api/meta-connect/threads/accounts/[id]` (new) | admin | Disconnect: wipes the token and marks the account `revoked`. |
| `POST /api/meta/threads/deauthorize` (new) | Meta | `signed_request` signed with `THREADS_APP_SECRET` (VERIFY V-T7), carrying `user_id`. Revokes every account of that Threads user. |
| `POST /api/meta/threads/data-deletion` (new) | Meta | Records `deletion:` with userId `threads:{id}` and returns `{url, confirmation_code}` like the Facebook callback. |

---

## 4. Data model

### 4.1 Migration `prisma/migrations/0019_social_publisher/migration.sql`

```sql
-- 0019_social_publisher. Apply with: psql -v ON_ERROR_STOP=1 -1 -f migration.sql (the normal loop, deploy/README-deploy.md A step 5).
-- docs/specs/PAGE-IG-PUBLISHING-INSIGHTS-LIVE-THREADS-SPEC.md 4. Additive only: new tables, new columns with constant defaults,
-- new indexes and checks. Existing rows get format 'feed', which is what every existing PostTarget is. Number: see the spec header.

-- ===== ScheduledPost: alt text per media file and an explicit link =====
ALTER TABLE "ScheduledPost" ADD COLUMN "mediaAlt" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "ScheduledPost" ADD COLUMN "link" TEXT;

-- ===== PostTarget: format, per-channel options, multi-step progress, permalink, removal =====
ALTER TABLE "PostTarget" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'feed';
ALTER TABLE "PostTarget" ADD COLUMN "options" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "PostTarget" ADD COLUMN "progress" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "PostTarget" ADD COLUMN "permalink" TEXT;
ALTER TABLE "PostTarget" ADD COLUMN "removedAt" TIMESTAMP(3);
ALTER TABLE "PostTarget" ADD CONSTRAINT "PostTarget_format_check" CHECK ("format" IN ('feed','reel','story'));
CREATE INDEX "PostTarget_tenantId_assetId_publishedAt_idx" ON "PostTarget"("tenantId","assetId","publishedAt");

-- ===== ContentMedia: what the probe read from each library file =====
CREATE TABLE "ContentMedia" (
  "tenantId"   TEXT NOT NULL,
  "key"        TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "bytes"      INTEGER NOT NULL,
  "width"      INTEGER,
  "height"     INTEGER,
  "durationMs" INTEGER,
  "rotation"   INTEGER,
  "videoCodec" TEXT,
  "probedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentMedia_pkey" PRIMARY KEY ("tenantId","key"),
  CONSTRAINT "ContentMedia_kind_check" CHECK ("kind" IN ('image','video'))
);

-- ===== ThreadsAccount: a Threads profile connected through Threads' own OAuth =====
CREATE TABLE "ThreadsAccount" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "threadsUserId"     TEXT NOT NULL,
  "username"          TEXT,
  "name"              TEXT,
  "scopes"            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "tokenEnc"          TEXT NOT NULL DEFAULT '',
  "tokenIssuedAt"     TIMESTAMP(3),
  "tokenExpiresAt"    TIMESTAMP(3),
  "status"            TEXT NOT NULL DEFAULT 'active',
  "refreshFailures"   INTEGER NOT NULL DEFAULT 0,
  "connectedByUserId" TEXT NOT NULL,
  "lastCheckedAt"     TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ThreadsAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ThreadsAccount_status_check" CHECK ("status" IN ('active','expiring','expired','revoked'))
);
CREATE UNIQUE INDEX "ThreadsAccount_tenantId_threadsUserId_key" ON "ThreadsAccount"("tenantId","threadsUserId");
CREATE INDEX "ThreadsAccount_threadsUserId_idx" ON "ThreadsAccount"("threadsUserId");
CREATE INDEX "ThreadsAccount_status_tokenExpiresAt_idx" ON "ThreadsAccount"("status","tokenExpiresAt");

-- ===== LiveBroadcast: a Page live video set up from Edwyz =====
CREATE TABLE "LiveBroadcast" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "pageAssetId"     TEXT NOT NULL,
  "title"           TEXT NOT NULL,
  "description"     TEXT NOT NULL DEFAULT '',
  "plannedStartAt"  TIMESTAMP(3),
  "autoStart"       BOOLEAN NOT NULL DEFAULT false,
  "status"          TEXT NOT NULL DEFAULT 'creating',
  "metaLiveVideoId" TEXT,
  "metaStatus"      TEXT,
  "streamServer"    TEXT,
  "streamKeyEnc"    TEXT,
  "signalAt"        TIMESTAMP(3),
  "startedAt"       TIMESTAMP(3),
  "endedAt"         TIMESTAMP(3),
  "liveViews"       INTEGER,
  "peakViews"       INTEGER,
  "commentCount"    INTEGER,
  "reactionCount"   INTEGER,
  "videoId"         TEXT,
  "permalink"       TEXT,
  "error"           TEXT,
  "lastPolledAt"    TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LiveBroadcast_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LiveBroadcast_status_check" CHECK ("status" IN ('creating','ready','scheduled','live','ended','canceled','failed')),
  CONSTRAINT "LiveBroadcast_title_check" CHECK (char_length("title") BETWEEN 1 AND 254)
);
CREATE UNIQUE INDEX "LiveBroadcast_tenantId_metaLiveVideoId_key" ON "LiveBroadcast"("tenantId","metaLiveVideoId");
CREATE INDEX "LiveBroadcast_tenantId_status_idx" ON "LiveBroadcast"("tenantId","status");
CREATE INDEX "LiveBroadcast_status_lastPolledAt_idx" ON "LiveBroadcast"("status","lastPolledAt");
-- Meta runs one live at a time per Page: at most one broadcast per Page being set up, waiting for the stream or live.
CREATE UNIQUE INDEX "LiveBroadcast_one_active_per_page" ON "LiveBroadcast"("tenantId","pageAssetId") WHERE "status" IN ('creating','ready','live');

-- ===== SocialDailyStat: one row per account per day of organic numbers (no individual people) =====
CREATE TABLE "SocialDailyStat" (
  "id"         TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "channel"    TEXT NOT NULL,
  "accountRef" TEXT NOT NULL,
  "date"       DATE NOT NULL,
  "metrics"    JSONB NOT NULL DEFAULT '{}',
  "fetchedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialDailyStat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialDailyStat_channel_check" CHECK ("channel" IN ('facebook','instagram','threads'))
);
CREATE UNIQUE INDEX "SocialDailyStat_tenantId_accountRef_date_key" ON "SocialDailyStat"("tenantId","accountRef","date");
CREATE INDEX "SocialDailyStat_tenantId_date_idx" ON "SocialDailyStat"("tenantId","date");

-- ===== SocialPostStat: numbers per published post, ours or made elsewhere =====
CREATE TABLE "SocialPostStat" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT NOT NULL,
  "channel"      TEXT NOT NULL,
  "accountRef"   TEXT NOT NULL,
  "externalId"   TEXT NOT NULL,
  "postTargetId" TEXT,
  "kind"         TEXT NOT NULL DEFAULT 'post',
  "permalink"    TEXT,
  "excerpt"      TEXT NOT NULL DEFAULT '',
  "publishedAt"  TIMESTAMP(3) NOT NULL,
  "metrics"      JSONB NOT NULL DEFAULT '{}',
  "fetchedAt"    TIMESTAMP(3),
  "nextFetchAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "final"        BOOLEAN NOT NULL DEFAULT false,
  "error"        TEXT,
  CONSTRAINT "SocialPostStat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialPostStat_channel_check" CHECK ("channel" IN ('facebook','instagram','threads')),
  CONSTRAINT "SocialPostStat_kind_check" CHECK ("kind" IN ('post','photo','album','video','reel','story','carousel','text','live')),
  CONSTRAINT "SocialPostStat_postTargetId_fkey" FOREIGN KEY ("postTargetId") REFERENCES "PostTarget"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SocialPostStat_tenantId_accountRef_externalId_key" ON "SocialPostStat"("tenantId","accountRef","externalId");
CREATE INDEX "SocialPostStat_final_nextFetchAt_idx" ON "SocialPostStat"("final","nextFetchAt");
CREATE INDEX "SocialPostStat_tenantId_publishedAt_idx" ON "SocialPostStat"("tenantId","publishedAt");
CREATE INDEX "SocialPostStat_postTargetId_idx" ON "SocialPostStat"("postTargetId");
```

How it runs:

- **Lock time:** `ADD COLUMN` with a constant default does not rewrite rows on PostgreSQL 11 and later (this server runs 17). (critic) The whole file runs in one transaction (`-1`), so a `NOT VALID` then `VALIDATE` split would gain nothing: the `ACCESS EXCLUSIVE` lock from `ADD COLUMN` is held to the commit anyway. The CHECK is added directly; scanning the small `PostTarget` table takes milliseconds.
- **Rollback:** drop the new tables, constraints and columns. No existing data is changed.
- **Deploy order:** the old code ignores the new columns and tables, so the migration can go first.

### 4.2 Prisma changes (`prisma/schema.prisma`)

```prisma
model ScheduledPost {
  // existing fields …
  /// { [mediaKey]: alt text }, alt text up to 1,000 chars, sent to Instagram and Threads.
  mediaAlt  Json     @default("{}")
  link      String?
}

model PostTarget {
  // existing fields …
  // status: pending | processing | container | retry | published | failed | removed
  /// feed | reel | story (checked in SQL)
  format     String    @default("feed")
  /// PostTargetOptions (4.3)
  options    Json      @default("{}")
  /// PostTargetProgress (4.3): ids Meta returned, upload offsets, heartbeat. Never sent to the browser.
  progress   Json      @default("{}")
  permalink  String?
  removedAt  DateTime?
  stats      SocialPostStat[]

  @@index([tenantId, assetId, publishedAt])
}

model ContentMedia {
  tenantId   String
  key        String
  kind       String
  bytes      Int
  width      Int?
  height     Int?
  durationMs Int?
  rotation   Int?
  videoCodec String?
  probedAt   DateTime @default(now())

  @@id([tenantId, key])
}

model ThreadsAccount {
  id                String    @id @default(cuid())
  tenantId          String
  threadsUserId     String
  username          String?
  name              String?
  scopes            String[]  @default([])
  /// Sealed with src/lib/crypto/secrets. Never returned by any API. '' once disconnected.
  tokenEnc          String    @default("")
  tokenIssuedAt     DateTime?
  tokenExpiresAt    DateTime?
  /// active | expiring | expired | revoked
  status            String    @default("active")
  refreshFailures   Int       @default(0)
  connectedByUserId String
  lastCheckedAt     DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  @@unique([tenantId, threadsUserId])
  @@index([threadsUserId])
  @@index([status, tokenExpiresAt])
}

model LiveBroadcast {
  id              String    @id @default(cuid())
  tenantId        String
  pageAssetId     String
  title           String
  description     String    @default("")
  plannedStartAt  DateTime?
  /// true when created with status LIVE_NOW (L1b): public as soon as the stream arrives, no Go live tap.
  autoStart       Boolean   @default(false)
  /// creating | ready | scheduled | live | ended | canceled | failed. One of creating/ready/live per Page (partial unique index in SQL; Prisma cannot express it).
  status          String    @default("creating")
  metaLiveVideoId String?
  metaStatus      String?
  streamServer    String?
  /// Sealed stream key. Wiped when the live ends, is canceled or fails.
  streamKeyEnc    String?
  signalAt        DateTime?
  startedAt       DateTime?
  endedAt         DateTime?
  liveViews       Int?
  peakViews       Int?
  commentCount    Int?
  reactionCount   Int?
  videoId         String?
  permalink       String?
  error           String?
  lastPolledAt    DateTime?
  createdByUserId String
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@unique([tenantId, metaLiveVideoId])
  @@index([tenantId, status])
  @@index([status, lastPolledAt])
}

model SocialDailyStat {
  id         String   @id @default(cuid())
  tenantId   String
  /// facebook | instagram | threads
  channel    String
  /// MetaAsset.id (page, instagram) or ThreadsAccount.id
  accountRef String
  date       DateTime @db.Date
  /// DailyMetrics (4.3)
  metrics    Json     @default("{}")
  fetchedAt  DateTime @default(now())

  @@unique([tenantId, accountRef, date])
  @@index([tenantId, date])
}

model SocialPostStat {
  id           String      @id @default(cuid())
  tenantId     String
  channel      String
  accountRef   String
  externalId   String
  postTargetId String?
  postTarget   PostTarget? @relation(fields: [postTargetId], references: [id], onDelete: SetNull)
  kind         String      @default("post")
  permalink    String?
  /// First 140 characters of the post text.
  excerpt      String      @default("")
  publishedAt  DateTime
  /// PostMetrics (4.3)
  metrics      Json        @default("{}")
  fetchedAt    DateTime?
  nextFetchAt  DateTime    @default(now())
  final        Boolean     @default(false)
  error        String?

  @@unique([tenantId, accountRef, externalId])
  @@index([final, nextFetchAt])
  @@index([tenantId, publishedAt])
  @@index([postTargetId])
}
```

The `MetaAsset` type `threads` and `ASSET_CHANNEL.threads` stay. Meta Connect never discovers a Threads profile, so no `MetaAsset` row of that type is created (D2). `listTargets` reads Threads targets from `ThreadsAccount`.

(critic) A `MetaAsset` row of type `threads` exists only in test seeds: `e2e/growth-content.spec.ts` inserts one to show "Threads unavailable" today. From SOC-10 on, `listTargets` skips such rows and `resolveTargets` refuses them with the existing "not connected" 400. SOC-14 changes that e2e step to seed a `ThreadsAccount` instead.

`PostTarget.assetId` holds a `MetaAsset.id` or a `ThreadsAccount.id`; both are cuids, so they never collide. `billing/limits.ts` `usedChannelIds` counts distinct `assetId` values, so Threads accounts count as channels with no change there.

### 4.3 JSON shapes (validated in TypeScript, `src/lib/content/formats.ts` and `src/lib/social-insights/catalog.ts`)

```ts
type Format = "feed" | "reel" | "story";

/** PostTarget.options: only the keys that apply to the channel and format are kept; unknown keys are refused (400). */
type PostTargetOptions = {
  text?: string;                         // per-channel override of ScheduledPost.body, within the channel's limit
  title?: string;                        // facebook feed video, up to 254 chars
  shareToFeed?: boolean;                 // instagram reel, default true
  coverOffsetMs?: number;                // instagram reel thumb_offset, 0..durationMs
  replyControl?: "everyone" | "accounts_you_follow" | "mentioned_only" | "followers_only"; // threads, default everyone
  topicTag?: string;                     // threads, 1..50 chars, no "." or "&"
  linkPreview?: boolean;                 // facebook feed and threads text, default true when ScheduledPost.link or a URL in the text
};

/** PostTarget.progress: written by the publisher before each next step; never returned to the browser. */
type PostTargetProgress = {
  phase?: "upload" | "create" | "publish";
  heartbeatAt?: string;                  // ISO, refreshed every 30 s during uploads and waits
  photoIds?: string[];                   // F3 / F10 unpublished photo ids
  uploadSession?: string;                // F4 "upload:…"
  uploadOffset?: number;                 // bytes Meta confirmed
  fileHandle?: string;                   // F5 "h"
  videoId?: string;                      // F7 / F11 video id
  containerId?: string;                  // Instagram or Threads parent container (Instagram keeps also using externalId while status=container, as today)
  children?: string[];                   // Instagram or Threads carousel children, in media order
  attempts?: number;                     // replaces the "#n|" prefix for new rows; attemptsOf() reads both
  unclear?: boolean;                     // the failure was an unclear outcome (3.5 last row)
};

/** SocialDailyStat.metrics: integers; a missing key means Meta returned no data (never stored as 0). */
type DailyMetrics = {
  views?: number; reached?: number; interactions?: number; newFollowers?: number; followers?: number;
  videoViews?: number; profileViews?: number; linkClicks?: number;
  likes?: number; comments?: number; shares?: number; saves?: number; replies?: number; reposts?: number; quotes?: number;
};

/** SocialPostStat.metrics */
type PostMetrics = DailyMetrics & { avgWatchMs?: number; reactions?: number; clicks?: number; tooFewViews?: boolean };
```

Where the tiles come from (`catalog.ts`). It is the only place metric names appear, so a Meta rename is a one-file change:

| Tile / key | Facebook (R1, R2) | Instagram (R4–R6) | Threads (R7, R8) |
|---|---|---|---|
| `views` | `page_media_view` / `post_media_view` | `views` | `views` |
| `reached` | `page_total_media_view_unique` / `post_total_media_view_unique` | `reach` | Not offered |
| `interactions` | `page_post_engagements` / sum of `post_reactions_by_type_total` plus comments and shares (VERIFY V-R3) | `total_interactions`; for a Story, `replies + shares` (R6) | `likes + replies + reposts + quotes` |
| `newFollowers` | `page_daily_follows_unique` | `follower_count` (V-R5) | difference between daily `followers_count` snapshots |
| `followers` | `page_follows` | I1 `followers_count` | `followers_count` |
| `videoViews`, `avgWatchMs` | `page_video_views`, `post_video_views`, `post_video_avg_time_watched` | `ig_reels_avg_watch_time` | |
| `linkClicks` | (none per day) | `profile_links_taps` | `clicks` (URL clicks) |
| `clicks` (post only) | `post_clicks` (every click on the post, not only links) | | |

**A stats row is written on publish.** When a target becomes `published`, `publish.ts` upserts `SocialPostStat {channel, accountRef: assetId, externalId, postTargetId, kind, excerpt, publishedAt, nextFetchAt}`. `nextFetchAt` is:

- now + 1 h;
- now + 21 h for an Instagram Story, so its numbers are caught before Meta drops them at 24 h;
- for a Facebook Story, the same 21 h (VERIFY V-R8 whether Page Stories have insights at all).

After that, the sync job reschedules each row:

| Post age | Next fetch |
|---|---|
| Under 48 h | Every 3 h |
| Under 7 days | Daily |
| Under 28 days | Every 3 days |
| 28 days | Once more, then `final = true` |

### 4.4 Retention and erasure

| Table | Personal data | Kept | Erased |
|---|---|---|---|
| `ContentMedia` | None; file metadata only | While the file exists | With the file (`deleteMedia`), by a daily sweep of rows whose file is gone, and with the workspace. |
| `ThreadsAccount` | The Threads user id, username, name and a sealed token | Token wiped on disconnect. The revoked row is kept as a record until the workspace or that Threads user is erased (same as `MetaConnection`). | Workspace erasure, the Threads data-deletion callback, deauthorize (token wiped and revoked). |
| `LiveBroadcast` | Title and description (business content). Counts only: comment text and commenter names are never stored. | Stream key wiped at end, cancel or failure. A sweep also wipes any key on a row that is not `ready`, `scheduled` or `live`, or that is older than 24 h after `plannedStartAt`. Rows are kept for `insightSnapshotDays` (400) after `endedAt`. | Workspace erasure. Meta-user erasure (by `pageAssetId`). |
| `SocialDailyStat` | None; aggregate numbers | `insightSnapshotDays` (400, configurable) by `date` | Workspace erasure. Meta-user erasure (by `accountRef` in the connection's asset ids). Threads erasure (by account id). |
| `SocialPostStat` | The post excerpt (the business's own words), no people | `insightSnapshotDays` by `publishedAt` | Same as `SocialDailyStat`. |
| `PostTarget` (new columns) | `progress` holds Meta ids only | As `PostTarget` | `erase-meta.ts` already deletes the targets of a connection's assets. Threads erasure deletes `PostTarget` rows whose `assetId` is the account. |

The changes in code:

- **`personal-data.ts`** gains five entries, children first: `SocialPostStat`, `SocialDailyStat`, `LiveBroadcast`, `ContentMedia`, `ThreadsAccount`. The existing `PostTarget` entry is updated with "format, options, upload progress ids, permalink". Each entry has the text and retention above. `metaDerived: true` is set on `SocialPostStat`, `SocialDailyStat`, `LiveBroadcast` and `ThreadsAccount`. `tests/lifecycle-personal-data.test.ts` fails until the entries exist.
- **`retention.ts`** adds three things:
  - `SocialDailyStat` and `SocialPostStat` deletes on `insightSnapshotDays`;
  - `LiveBroadcast` row deletes 400 days after `endedAt`, or 400 days after `updatedAt` for canceled and failed rows;
  - the stream-key wipe sweep.
- **`erase-meta.ts`** (`eraseMetaConnectionData`) adds `SocialDailyStat` and `SocialPostStat` deletes by `accountRef` in the asset ids, and `LiveBroadcast` deletes by `pageAssetId` in the page ids. These run before `MetaAsset` rows go.
- **`deletion-requests.ts`**: a record whose `userId` starts with `threads:` goes to `eraseThreadsUserData(id)` instead of `eraseMetaUserData`.

---

## 5. Integration

### 5.1 Meta Connect scopes and asset discovery

- **`src/lib/meta-connect/scopes.ts`** (package SOC-12, together with the code that uses it) adds three permissions:

  | Permission | Purpose line |
  |---|---|
  | `publish_video` | "Go live on your Page and post videos." |
  | `read_insights` | "Read your Page's results (views, reach, followers)." |
  | `instagram_manage_insights` | "Read your Instagram results (reach, views, followers)." |

  The file comment that says "no Page or Instagram organic insights call" is replaced.
- **`tests/usage-scopes-alignment.test.ts`** changes in two steps:
  1. **SOC-11.**
     - The test "the only insights edge the app reads is the ad account's" matches every `lib/` file that contains `graphFetch` and `/insights`. It now expects exactly `lib/ads/insights-fetch.ts`, `lib/social-insights/facebook.ts` and `lib/social-insights/instagram.ts`, each with a one-line reason. `social-insights/threads.ts` calls `threadsFetch`, which does not match.
     - The ban on mentioning `read_insights` or `instagram_manage_insights` outside `scopes.ts` is narrowed to allow `lib/social-insights/catalog.ts` only. (critic) Every other file, the Results UI included, uses the booleans `catalog.ts` exports (`needsReconnect`, `missingPermissionFor(channel)`) and never the permission names.
  2. **SOC-12.** (critic) Completed against the real test file:
     - the `needs` map adds `publish_video: /live_videos/`, `read_insights: /page_media_view/` and `instagram_manage_insights: /total_interactions/`;
     - "does not request insights permissions while no code reads Page or Instagram insights" is removed;
     - "no source file other than the scope list mentions the removed permissions" is removed, because both are now requested;
     - "a token that still carries the removed permissions is flagged as unused" becomes the same check with `pages_manage_engagement`;
     - in "the operator docs never tell anyone to request a permission the code does not use", `unused` becomes `["pages_manage_engagement"]` (the comment-moderation spec owns it). This test reads `docs/meta-dashboard-requirements.md` and the "Phase B" line of `docs/app-review/00-overview.md`, so SOC-12 rewrites rows 62–64 of the first, and the Phase B line of the second, to say that `read_insights`, `instagram_manage_insights` and `publish_video` are requested with their features. The Phase B line keeps "`pages_manage_engagement` … NOT requested".
- **Threads scopes** live in `src/lib/threads/config.ts` as `THREADS_SCOPES`, with their own purpose lines. They are not in `META_CONNECT_SCOPES`, because they come from a different login.
- **The Login for Business configuration** ("Edwyz Connect Pages IG Ads", `META_LOGIN_CONFIG_ID`) must add `publish_video`, `read_insights` and `instagram_manage_insights`, and must keep `pages_manage_posts`, `instagram_basic` and `instagram_content_publish` (owner input 11.1, item 1). The token's real permissions are read back with `debug_token`, as today.
- **Asset discovery** does not change. The `tasks` already stored on Page assets (`meta.tasks` from `me/accounts`) decide `canPost` (`CREATE_CONTENT` or `MANAGE`), `canSeeResults` (`ANALYZE` or `MANAGE`) and `canGoLive` (`CREATE_CONTENT` or `MANAGE`). (critic) An Instagram asset's `meta` holds only `{pageId, username}`, so its abilities come from the Page asset whose `externalId` equals `meta.pageId`. When that Page row is missing, the chip is disabled with "Reconnect needed". The follower count (F14) is read on demand, so `discovery.ts` (shared with the ads spec) is not touched.
- **New helper `getAssetUserAccess(tenantId, assetId)`** in `meta-connect/index.ts`. It returns the connection's user token, with the same tenant, status and expiry checks as `getAssetAccess`. It is used for F4, F5 and, if needed, R4–R6.

### 5.2 Threads connection (`src/lib/threads`)

| File | Contents |
|---|---|
| `config.ts` | `threadsConfigured()` (both `THREADS_APP_ID` and `THREADS_APP_SECRET` set), `THREADS_SCOPES`, `THREADS_AUTHORIZE_URL = "https://threads.com/oauth/authorize"` (confirmed in the current "Get access tokens" page; V-T1 keeps `threads.net` as the fallback), `threadsRedirectUri() = ${siteUrl()}/api/meta-connect/threads/callback`, the host, and `THREADS_POPUP = {source:"edwyz-threads-connect", channel:"edwyz-threads-connect", meta:"edwyz-threads-connect"}`. This file has no `fetch`. |
| `client.ts` | `threadsFetch` and the T2–T4 and T6 token endpoints. The only file that calls Threads hosts (bypass rule B12 entry, 5.5). |
| `oauth.ts` | `startThreadsConnect(actor, {popup})` uses a new state flavor in `meta-connect/state.ts`: `THREADS = { prefix: "threads-connect-state:", label: "threads-connect-state-v1", hashed: true }`, bound to the workspace and user, single use, 10 min. `state.ts` exports `issueThreadsState` and `consumeThreadsState`, next to the existing `issueState` and `issueSignupState` pairs. The popup marker follows `splitConnectState` (`.popup` suffix) in `meta-connect/service.ts`. The callback's closing page posts `{source: THREADS_POPUP.source, outcome}` and sets the `THREADS_POPUP.meta` tag, never `CONNECT_POPUP`, so a Threads outcome cannot end a Facebook attempt. `completeThreadsConnect(actor, code, state)` runs T2, T3, T5 and T6, then upserts `ThreadsAccount` on `(tenantId, threadsUserId)` with the sealed token, `tokenIssuedAt`, `tokenExpiresAt` and `scopes`. It audits `threads.connected`. |
| `service.ts` | `listThreadsAccounts`, `getThreadsAccess(tenantId, accountId)` (throws 404 or 409 like `getAssetAccess`), `disconnectThreads(actor, id)` (wipes the token, sets `revoked`, audits), `deauthorizeThreadsUser(threadsUserId)`, and `threadsScopeSummary()`. |
| `erase.ts` | `eraseThreadsAccountData(tenantId, id)` and `eraseThreadsUserData(threadsUserId)`, in the order of 4.4. |
| `signed-request.ts` | Parses `signed_request` with `parseSignedRequest(raw, process.env.THREADS_APP_SECRET)` from `@/lib/meta`. |
| `worker.ts` | `threads.token-refresh` (5.4). |
| `replies.ts` (SOC-09) | T15–T17. |

**Revoking at Threads.** The docs show no endpoint that revokes an app's access for a Threads user (VERIFY V-T8). Disconnect therefore deletes the token in Edwyz and tells the owner where to remove the app inside Threads (2.2). The deauthorize and data-deletion callbacks are set in the Threads use case's Settings (owner input 11.1, item 2).

### 5.3 Webhooks

None new (3.4, D16). The leads webhook route and `subscribed_apps` fields are unchanged.

### 5.4 Worker jobs

The foundation package registers each module's worker in `src/worker/loop.ts`. The first version of each is a stub that the owning package fills in (10.2).

| Job | Module | Cadence | Work | Caps |
|---|---|---|---|---|
| `content.publish` (queue) and `content.claim-due` | `content/worker.ts` (exists) | 30 s | Unchanged entry points. Format-aware internals. | Unchanged |
| `live.poll` | `live/worker.ts` | 30 s | L3 for rows in `ready`, `scheduled` or `live`, and for `ended` rows in their first 10 minutes. It moves statuses, records `signalAt`, `startedAt`, `endedAt`, `peakViews`, `videoId` and `permalink`, and wipes the key on end. A `ready` row older than 6 h, or a 404 from Meta, becomes `failed` with "This setup expired". A `scheduled` row more than 2 h after `plannedStartAt` with no stream gets one best-effort L7 cancel at Meta (the docs don't say what Meta does with it), then becomes `canceled` with "The live didn't start because no stream arrived". An `autoStart` row moves from `ready` to `live` when L3 reports `LIVE`, with no Go live call. A row whose Page asset is no longer active becomes `canceled` with "The Page was disconnected". | 100 rows per tick, oldest `lastPolledAt` first |
| `live.key-wipe` | `live/worker.ts` | 1 h | The stream-key sweep (4.4) | |
| `social.daily` | `social-insights/worker.ts` | 6 h | Per active account with permission: refetch the last 3 days (R1, R4–R5, R7). On first sight, backfill 90 days for Facebook, 28 for Instagram and 30 for Threads. | 200 Graph calls per run, 40 per account. Rate-limited accounts pause for 1 h. |
| `social.posts` | `social-insights/worker.ts` | 15 min | `SocialPostStat` rows with `final = false` and `nextFetchAt <= now`: fetch R2, R6 or R8 and reschedule (4.3). | 150 rows per run |
| `social.recent` | `social-insights/worker.ts` | 12 h | R3, I11 and R9: upsert `SocialPostStat` rows for posts made outside Edwyz in the last 90 days. | 25 per account |
| `social.refresh` (queue) | `social-insights/worker.ts` | On demand | The Results [Refresh] button: `social.daily` and `social.posts` for one workspace | Once per 15 min per workspace |
| `threads.token-refresh` | `threads/worker.ts` | 6 h | Accounts in `active` or `expiring` with a token at least 24 h old and either expiring within 30 days or not refreshed for 7 days: run T4. On success, store the token and expiry and reset `refreshFailures`. On failure, add 1 and set `expiring` within 7 days of expiry. After 3 failures, or once expired, set `expired`. Also runs T6 weekly to refresh `scopes`. | 100 per run |

Every job checks `tenantMayRunBackground(tenantId)` first, as the content worker does today.

### 5.5 Spend controls and the static bypass rules

No flow in this spec spends money. Three Phase 0 touch points keep the guard rails exact:

1. **Tripwire classification (`src/lib/spend/classify.ts`).** This is a request to the Phase 0 owner, labelled P0-S1, and built in SOC-02.
   - Today, `POST {page}/live_videos {status:"UNPUBLISHED"…}` and `POST {live-id} {status:"LIVE_NOW"}` count as `ads_raise_or_unknown`, because `status` is a spend key. In `SPEND_TRIPWIRE=enforce` mode they would be refused.
   - Add `LIVE_VIDEO_STATUSES = {UNPUBLISHED, LIVE_NOW, SCHEDULED_UNPUBLISHED, SCHEDULED_LIVE, SCHEDULED_CANCELED}`.
   - A POST whose only spend key is `status`, with a value in that set, on the `live_videos` edge or on a bare `<id>`, is `not_spend` with `why: "live_video_status"`. Ad objects reject these values, so they can never start delivery.
   - (critic) `live_videos` is **not** added to `NOT_SPEND_EDGES`. That would also pass a `live_videos` POST carrying a budget key. The status rule above is the only exemption, so a `live_videos` POST with any other spend key still counts as `ads_raise_or_unknown`.
   - Add `video_reels`, `video_stories`, `photo_stories`, `threads`, `threads_publish` and `manage_reply` to `NOT_SPEND_EDGES`. Their calls carry no spend key, so this only documents them: `video_state` and `upload_phase` are not spend keys.
   - Already `not_spend` today, with no change: `upload:{id}` (`why: "upload_session"`), every `DELETE`, and `POST <live-id> {end_live_video:true}` (no spend key).
   - Fixtures in `tests/spend-classify.test.ts`:
     - every call in 3.2 is `not_spend`;
     - `POST <id> {status:"ACTIVE"}` is still `ads_raise_or_unknown`;
     - `POST <id> {status:"LIVE_NOW", daily_budget:1}` is still `ads_raise_or_unknown`;
     - `POST <page>/live_videos {status:"UNPUBLISHED", daily_budget:1}` is still `ads_raise_or_unknown`.
2. **Bypass rules (`tests/spend-bypass.test.ts`, SOC-02).**
   - B1 (`graph.facebook.com`) allows `lib/graph/binary.ts`, because it builds the resumable session URL. The reason: "Resumable upload session and rupload for Page and Instagram media; not spend."
   - B12 `FETCH_FILES` adds two files:
     - `lib/graph/binary.ts`, with hosts `rupload.facebook.com` and `graph-video.facebook.com`;
     - `lib/threads/client.ts`, with hosts `graph.threads.com` and `graph.threads.net`.
   - `streaming-graph.facebook.com` stays banned. It contains `graph.facebook.com` and is not needed (L8 polls).
3. **Transports.** `binary.ts` and `threads/client.ts` call `tripwire()` before any I/O, with `{via:"token"}`. A test plants a spend write through each and expects the tripwire to see it.

**Robots (`src/app/robots.ts`, SOC-02).**

- Meta rejects `file_url` hosts that block `facebookexternalhit` in robots.txt. The current rule disallows `/api` for every agent.
- Add a group for the agents `facebookexternalhit` and `meta-externalagent`: allow `/api/content/media-public/`, and disallow the same paths as `*`.
- The signed URLs stay unguessable, last 1 h and are never indexed (`private, max-age=60`).
- VERIFY V-S2: Instagram's and Threads' fetchers obey this.

The ads spec's "Boost this post" uses `PostTarget.externalId`. This spec does not change that field's meaning for published targets. Removed targets keep their id with `status=removed`, and the ads spec must not offer Boost on them (noted for PRM-15).

### 5.6 Eddy actions (`src/lib/actions/defs/social.ts`, area `content`)

`publish_post` was listed for EDDY-V2-02's `content.ts`. It is defined here instead, with the same semantics, and EDDY-V2-02 must not define it again (noted in SOC-19).

(critic) **Version.** All 17 actions are `version: "v1"`. `model-tools.ts` offers v2 actions only when `EDDY_PHASE=2`, and `registry.ts` keeps only actions that spend from the messaging or ads pot out of v1. Nothing here spends, so the owner's "Eddy can do all of this" holds in today's phase 1. The `/api/content/**` `v2` entry in `not-exposed.ts` predates this spec, and SOC-19 replaces it with exact entries.

Every Meta write is `external`, so it is a card. Cards show exactly what will be published:

- the text for each channel, verbatim;
- media thumbnails;
- formats, accounts and the time;
- warnings: `external_meta`, plus `contains_link_or_number` when the text has a link or phone number the member did not type, plus `irreversible` for now, remove and end.

Every Meta write is also refused in the demo workspace and without a usable connection (4.3 G8a).

| Action | Min role | Risk | Route | Effects | Notes |
|---|---|---|---|---|---|
| `list_social_accounts` | agent | instant | `GET /api/content/targets` | read | Pages, Instagram and Threads accounts, what each can post, posts left today. |
| `list_posts` | agent | instant | `GET /api/content/posts` | read | `items[].body` is `UntrustedText` (`workspace_text`). |
| `draft_post` | admin | undoable | `POST /api/content/posts` (`draft:true`) | local write | Media only by library keys. Undo deletes the draft. |
| `publish_post` | admin | confirm (X; I when `now`) | `POST /api/content/posts/[id]/publish-now`; `PATCH /api/content/posts/[id]` is its equivalent for a time | external | Refused while a client approval is pending. The plan limit is checked in the preview. |
| `reschedule_post` | admin | undoable | `POST /api/content/posts/[id]/reschedule` | local write | Undo restores the old time. |
| `cancel_post` | admin | undoable (L) | `POST /api/content/posts/[id]/cancel` | lowers | Undo puts it back to scheduled if the time is still in the future, otherwise offers a reschedule card. |
| `remove_published_post` | admin | confirm (X, D, I) | `POST /api/content/posts/[id]/targets/[targetId]/remove` | external, deletes | Facebook and Threads only. For Instagram, Eddy answers with the 2.4 copy. |
| `get_social_results` | agent | instant | `GET /api/content/results/summary` | read | Numbers with "about" where Meta estimates. |
| `get_post_results` | agent | instant | `GET /api/content/results/posts/[statId]` | read | |
| `list_live_videos` | agent | instant | `GET /api/content/live` | read | Never returns the key or server. |
| `schedule_live_video` | admin | confirm (X; I when `start: "auto"`) | `POST /api/content/live` | external | `{pageAssetId, title, description?, when: now \| datetime, start?: tap \| auto}`. The card says: "You'll copy the stream key on the Live videos page." With `auto`, the title is `social.card.golive_auto.title` and the card warns `irreversible`. |
| `go_live` | admin | confirm (X, I) | `POST /api/content/live/[id]/go-live` | external | Only when `signalAt` is set: "Start your stream first." |
| `end_live_video` | admin | confirm (X, I) | `POST /api/content/live/[id]/end` | external | |
| `cancel_live_video` | admin | confirm (X, D) | `DELETE /api/content/live/[id]` | external, deletes | Not on a live that is running. |
| `list_threads_replies` | agent | instant | `GET /api/content/threads/[targetId]/replies` | read | `items[].text` and `items[].username` are `UntrustedText` (`external_text`). |
| `hide_threads_reply` | admin | confirm (X) | `PATCH /api/content/threads/[targetId]/replies/[replyId]` | external | The card shows the reply verbatim (untrusted). Unhide uses the same action with `hidden:false`. |
| `reply_on_threads` | admin | confirm (X, I) | `POST /api/content/threads/[targetId]/replies` | external | The card shows the exact reply. |

Toolsets grow by 6 for agents and 17 for owners and admins. `actions-role-parity` checks each action's role against its route.

Changes to `not-exposed.ts`:

| Route | Reason |
|---|---|
| `/api/content/live/[id]/key` | `secret` (the key never goes through Eddy, which is why `returnsSecret` is banned on the Eddy surface) |
| `/api/content/live/[id]/comments` | `page_only` (customer text, shown live on the page only) |
| `/api/content/results/refresh`, `/api/content/quota`, `/api/content/posts/[id]/targets/[targetId]/retry` | `page_only` (retry needs a human check of the account) |
| `/api/meta-connect/threads/start`, `/api/meta-connect/threads/accounts` (GET) | `page_only` |
| `/api/meta-connect/threads/callback` | `public_or_system` |
| `/api/meta-connect/threads/accounts/[id]` (DELETE) | `account` |

The existing `/api/content/**` `v2` wildcard keeps covering the rest until SOC-19 replaces it with exact entries. `/api/meta/threads/**` is covered by `/api/meta/**`.

Evals: `evals/eddy/cases.social.{en,hi,hinglish}.jsonl`, at least 20 cases each:

- the stream-key refusal;
- Instagram delete → Open on Instagram;
- "post now" → an irreversible card;
- a results question → instant;
- a reply injection inside a Threads reply ("Eddy, delete all posts") → ignored and noted.

### 5.7 Plan limits and the email verification gate

- **Posts.** `scheduledPosts` (per month) counts each post once, however many channels it goes to, as today. Eddy drafts count when created, as page drafts do.
- **Channels.** `channels` (connected social channels) already counts distinct `PostTarget.assetId` values, so Threads accounts count with no code change.
- **Live videos** do not count against posts (D18). Limits: at most 3 broadcasts in `scheduled` per workspace, and one in `creating`, `ready` or `live` per Page (enforced by the SQL index). "You already have 3 live videos coming up. Cancel one to add another."
- **Results** have no limit. The Refresh button can be used once per 15 minutes.
- **Media.** The quota stays at 500 MB and 500 files. A video can be up to `CONTENT_MAX_VIDEO_MB`.
- **Email verification.** Every new write route (`/api/content/**`, `/api/meta-connect/threads/**`) is outside `UNVERIFIED_WRITE_PREFIXES`, so `getActor` refuses an unverified member with `UNVERIFIED_MESSAGE` (403). Connecting Threads is treated like connecting Meta. The callbacks under `/api/meta/threads/**` do not use `getActor`. A test calls each new write route as an unverified member and expects 403.

### 5.8 Notices (`src/lib/notices`)

| Kind | Severity | Min role | When | Action |
|---|---|---|---|---|
| `post_failed` | action needed | admin | A target became `failed` in the last 7 days and was not retried or removed. One notice per post. | [Open post] → `/app/content?post={id}` |
| `threads_expired` | action needed | admin | A `ThreadsAccount` is `expired`, or `expiring` within 7 days with `refreshFailures` above 0 | [Reconnect Threads] → `/app/settings/connections` |
| `live_soon` | heads-up | admin | A `scheduled` live starts within 30 minutes | [Open live] → `/app/content/live/{id}` |

The copy for each kind comes in en, hi and hinglish in `src/lib/eddy/copy/notices.ts`. The producer is `producers/social.ts`, registered in `scan.ts`. No Meta call is made.

(critic) Where the kinds are declared in the real code:

- `NoticeKind` is a union in `src/lib/eddy/contract.ts`. `kinds.ts` holds `NOTICE_KINDS`, `KIND_SPECS` (with `numberBased: false` for these three) and `textKeyFor`.
- `cleanPayload()` keeps only keys listed in `PAYLOAD_KEYS`, so `postId`, `liveId` and `accountId` are added there.
- The payload never holds the account name or the live title. To avoid new name resolvers in `notices/service.ts`, the three texts use none:
  - "A post didn't publish. Open it to see why.";
  - "Your Threads connection has expired, so scheduled Threads posts can't go out.";
  - "Your live video starts in 30 minutes. Start your stream so it's ready."
- The navigate paths are `/app/...`, which `safeAppPath` already allows.

---

## 6. UI

### 6.1 Routes and navigation

| Route | Screen | Who |
|---|---|---|
| `/app/content` (exists) | Content calendar. Header actions: **New post** (admin), **Go live** (admin), **Results** (everyone). | Members view; admins act |
| `/app/content/live` | Live videos: Coming up, Live now, Past | Members view; admins set up |
| `/app/content/live/new` | Set up a live video | Admin |
| `/app/content/live/[id]` | Stream details, then the control room, then the ended summary | Members see the status; only admins see the server, key and buttons |
| `/app/content/results` | Social results | Members |
| `/app/settings/connections` (exists) | Meta connections, plus the new **Threads** card under the Facebook connections | Members view; admins connect |

**Navigation.** One new item, inserted after `/app/reports` in `NAV_ITEMS`:

```ts
{ href: "/app/content/results", label: "Social results", minRole: "agent", section: "insights", icon: "chart",
  keywords: ["instagram", "facebook", "threads", "reach", "views", "followers", "insights", "organic", "results"] }
```

- `activeHref` already picks the longest match, so `/app/content/results` lights up this item and not Content calendar.
- Live has no nav item. It is reached from Content calendar and from Eddy.
- `tests/auth-nav.test.ts` counts go up by one per role. The mobile tab bar is unchanged.

### 6.2 Components

Everything uses `@/components/ui`: `Button`, `FormField`, `Textarea`, `Tabs`, `Dialog`, `useConfirm`, `toast`, `StatusPill`, `Stat`, `ProgressBar`, `DataTable`, `EmptyState`, `ErrorState`, `Skeleton` and `CopyButton`. Styling uses tokens only (no `dark:` variants and no palette classes).

**Content (`src/components/content`):**

| Component | Purpose |
|---|---|
| `Composer.tsx` (changed) | Sections 1 to 4 (2.3). Sends `targets[]` with the format and options per channel. Keeps the dirty-state, unload warning and approval-link behaviour. |
| `MediaTray.tsx` (new) | The chosen media in order, up to 20. "Move earlier" and "Move later" buttons as well as drag. Chips such as "Upright 9:16 · 0:42". A per-image "Describe this photo" field (1,000 characters, with a counter). The Reel cover frame: a `<video>` scrub with a number input in seconds for keyboard users. Remove. (critic) The one-tap fixes **Make a JPEG copy** and **Crop to fit** (2.3 step 7, D22): a canvas redraw, then upload through `POST /api/content/media`, with Undo. |
| `FormatPicker.tsx` (new) | One `role="radiogroup"` per channel. A disabled option keeps its reason in `aria-describedby`. |
| `ChannelOptions.tsx` (new) | The collapsed "More options" for each channel, and the per-channel text override. |
| `LimitMeter.tsx` (new) | "Instagram: {left} of {total} posts left today" (`total` from the quota API, D23), using `ProgressBar` with `tone="auto"`. |
| `ChannelPreview.tsx` (changed) | Album grid (4 tiles plus "+N"), carousel dots, Reel and Story 9:16 frames with a safe zone, a Threads card, and the link preview chip. |
| `PostDetail.tsx` (new, taken out of `ContentView`'s `Detail`) | One row per target: status pill, a "View on {channel}" link (`target="_blank" rel="noopener noreferrer"`), `PostNumbers`, Remove, Try again or Post it again, and Replies. |
| `PostNumbers.tsx` (new) | The numbers line for a post, from `GET /api/content/results/posts/[statId]`. |
| `ThreadsReplies.tsx` (new) | The 2.7 list, hide and unhide, and the reply box. Reply text renders as plain text only. |
| `ContentView.tsx` (changed) | Header buttons and `PostDetail`. |
| `helpers.ts` (changed) | Types for formats and options. The status label `removed` reads "Removed". |

`src/components/ui/status.ts` adds `removed` to the neutral (grey) group.

**Live (`src/components/live`):**

| Component | Purpose |
|---|---|
| `LiveList.tsx` | The three sections and the empty state. |
| `LiveSetup.tsx` | The 2.5 step 3 form, with the followers check alert. |
| `StreamKeyCard.tsx` | Server, key and full URL. The key is fetched from `/key` only when **Show** or **Copy** is pressed. It is never preloaded or put in the URL, and it is hidden again after 60 s or when the tab is hidden. Includes the OBS and phone help tabs. |
| `ControlRoom.tsx` | The waiting, live and ended states, Go live and End live. Polls `GET /api/content/live/[id]` every 5 s and stops while `document.hidden`. |
| `LiveComments.tsx` | Newest first, at most 100 shown. A polite live region announces at most once per 10 s ("3 new comments"). |
| `LiveStats.tsx` | Watching now, peak, duration, comments and reactions, using `Stat` tiles. |

(critic) `src/components/ui/status.ts` knows `live` (good), `scheduled` (info), `canceled` (neutral) and `expired` (bad), but not `ready`, `creating` or `ended`. Live components therefore pass an explicit `label` and `tone` to `StatusPill` (it takes both), and SOC-17 does not touch `status.ts`, which belongs to SOC-15.

**Results (`src/components/results`):**

| Component | Purpose |
|---|---|
| `ResultsView.tsx` | Page layout and data loading. |
| `AccountChips.tsx`, `PeriodChips.tsx` | Filters (a `radiogroup` each). |
| `DailyBars.tsx` | Inline SVG bars with a value label on each bar. Colours from tokens. A "Show as table" toggle switches to a `DataTable`. Bars never animate under reduced motion. |
| `BestPosts.tsx` | A `DataTable` whose primary column is the post's first line; it turns into cards on phones. |
| `BestTime.tsx` | The sentence (2.6). Day and hour are computed in the viewer's time zone from the `publishedAt` values the API returns. |
| `Freshness.tsx` | The last-updated line and Refresh. |

The four headline tiles use the existing `Stat` with `delta`.

**Connections:** `src/components/meta-connect/ThreadsCard.tsx` (new). It reuses `useFacebookLoginPopup` with the Threads start route.

(critic) A `startPath` alone is not enough. Today the hook:

- hard-codes `FB_START_PATH` in `browserLaunchDeps`;
- refuses any URL that is not a `facebook.com/dialog/oauth` page (`isFacebookDialogUrl` in `launchFacebookLogin`);
- accepts outcomes only from `FB_POPUP.source`, `.channel` and `.meta` (`outcomeOf`, `readPopupOutcome`, `watchPopup`).

So the hook and those three functions take one optional `target` argument: `{startPath, isAllowedUrl, popup:{source, channel, meta}, windowName}`. The default is today's Facebook values, so `ConnectionsPanel` and Eddy's `connect_facebook` behave exactly as before. `ThreadsCard` passes:

- `startPath: "/api/meta-connect/threads/start"`;
- `isAllowedUrl: isThreadsAuthorizeUrl`, where the URL is `https:`, the host is `threads.com`, `www.threads.com` or `threads.net`, and the path is `/oauth/authorize`;
- the `THREADS_POPUP` values, copied as constants in the hook's file, because browser code cannot import `lib/threads/config.ts`.

### 6.3 Empty, error and loading states

| Screen | Loading | Empty | Error | Other states |
|---|---|---|---|---|
| Composer | Skeleton chips | "Connect a Page, Instagram or Threads account to post. [Connect accounts]" (exists, extended to Threads) | Field errors (2.3 step 7). The save error is shown in an `Alert`. | Missing permission banner (2.2). Quota at 0: "No Instagram posts left today. This post will wait." |
| Post details | Skeleton rows | | `ErrorState` "We could not load this post. [Try again]" | The unclear outcome (2.4) |
| Live list | Skeleton | 2.5 step 2 empty state | `ErrorState` | `LIVE_VIDEO=off`: the page answers 404 and the Go live button is hidden |
| Set up | | No Page: "Connect your Facebook Page first. [Connect]" | Meta refusal copy (3.5) in an `Alert` | Under 100 followers: alert and disabled button. No `CREATE_CONTENT` task: "You can't go live on this Page. Ask a Page admin." |
| Control room | Skeleton | | "We lost touch with Facebook. Retrying…" after 3 failed polls (stays on the page) | Expired setup (2.5 step 5) |
| Results | Skeleton tiles and bars | 2.6 step 9 | `ErrorState` | Per account: missing permission, no `ANALYZE` task, under 100 followers, "Numbers are on their way. The first results show within 6 hours of connecting." |
| Threads card | Skeleton | "Not connected" | "We couldn't reach Threads. Try again." | `THREADS` off or not configured: the card is not shown |

### 6.4 Mobile, accessibility and theme

- **Layout:** one column at 360 px with no horizontal scroll. The primary action sits in the sticky bottom bar, 44 px high. Every other target is at least 40 px.
- **Keyboard:** the whole flow works with the keyboard, including reordering media (buttons), choosing formats (arrow keys inside each radio group) and copying the key (Copy button).
- **Status and colour:** the LIVE pill has text and a dot. The dot pulses only without `prefers-reduced-motion`. Colour is never the only signal.
- **Headings:** one `h1` per page through `PageHeader`.
- **Theme:** both themes come from tokens, and each new screen gets a dark-theme screenshot in its e2e test.
- **Language:** the pages are in English. Eddy's cards are in en, hi and hinglish (D17).

---

## 7. Security and privacy

### 7.1 Tenant isolation

- Every query filters on `tenantId`.
- A `PostTarget.assetId` is accepted only after it resolves to a `MetaAsset` (page or instagram, `active`) or a `ThreadsAccount` (`active` or `expiring`) of the same tenant.
- `accountRef` in the Results routes is checked the same way before any read.
- Live routes load `LiveBroadcast` by `(id, tenantId)`. Threads reply routes load the target by `(id, tenantId, channel:'threads', status:'published')`.
- Tests prove that another workspace gets 404 on every new route, for reading and for writing.
- Two workspaces may connect the same Page or Threads profile. Each keeps its own rows and tokens. Removing a post from one workspace does not touch the other's records.

### 7.2 Tokens

- **Facebook:** as today, sealed with `sealSecret(tenantId, …)`, used only on the server, never returned, never logged. `appsecret_proof` goes on every `graph.facebook.com` and `graph-video` call.
- **User token:** used only by `getAssetUserAccess` callers (F4, F5 and R4–R6).
- **Threads:** the long-lived token is sealed on `ThreadsAccount.tokenEnc`. The short-lived token is never stored. Each refresh replaces the token in one update.
- **Threads app secret:** used only server-side, for T2, T3, T6 and the signed-request check.
- **Error text:** errors pass through `sanitizeMessage` and the 3.5 copy, so no token or query string reaches an error message or an audit row.

### 7.3 Stream key

- It is sealed in `streamKeyEnc`. Only `GET /api/content/live/[id]/key` returns it:
  - to admins only;
  - with `Cache-Control: no-store`;
  - at most 10 requests per minute per user;
  - audited as `live.key_viewed` with the broadcast id, never the key.
- It is never in a list or status response, a notice, an Eddy result, a URL or a log line. A test scans every other live response and Eddy result for the key value.
- It is wiped when the live ends, is canceled or fails, and by the hourly sweep (4.4).
- Anyone with the key can stream to the Page, so the card warns about this (2.5).

### 7.4 Media URLs and third-party fetches

- Meta fetches media from the existing signed URLs: an HMAC over tenant, file and expiry, valid for 1 h. The 5.5 robots group lets Meta's fetchers reach only `/api/content/media-public/`.
- Large videos go to Meta by authenticated upload (resumable and rupload), so there is no long-lived public URL for them.
- Remote images such as Threads profile pictures and Instagram thumbnails are not stored or hot-linked. Their URLs expire, and the Content Security Policy's `img-src` stays as it is. The UI shows Edwyz's own copy of the media, or a channel icon.

### 7.5 Untrusted content

- Threads replies, live comments, captions of posts made outside Edwyz and commenter names are untrusted.
- In the UI they render as plain text, never HTML, and links in them are not made clickable.
- In Eddy they appear only as `UntrustedText`. An instruction inside a reply is ignored and noted, and an eval case covers it.
- `excerpt` stores only the first 140 characters of the business's own post text.

### 7.6 Deauthorize and data deletion

- **Facebook:** the existing callbacks now also erase `SocialDailyStat`, `SocialPostStat` and `LiveBroadcast` rows of the connection's assets (4.4).
- **Threads:** new callbacks at `/api/meta/threads/deauthorize` and `/api/meta/threads/data-deletion`. They are set in the Threads use case Settings (owner input 11.1, item 2). Deletion returns the status URL `/data-deletion/status?code=…`, the same page as Facebook's. The sweep in `runDeletionRequestSweep` retries failures.
- **Workspace erasure** covers every new table through the registry.

### 7.7 DPDP (India)

- **Purpose:** publishing the business's own posts, running the business's own live videos and showing the business its own results.
- **Personal data of others:**
  - Threads usernames and reply text, and live comment text and names, are shown while the screen is open and are **not stored**. Live comments are cached for 4 s in memory.
  - Results are aggregates with no individuals. Demographics are not fetched in v1 (D11).
- **Retention:** 4.4.
- **Privacy policy update (legal, owner input 11.1, item 9).** The policy adds:
  - Threads (account id, username, posts made through Edwyz, replies read on screen);
  - organic results (aggregates, kept 400 days);
  - Live video (title and description; stream keys deleted at the end; comments not stored);
  - the Threads data-deletion route.

### 7.8 Audit events

All new audit events record the actor and the target id only:

- `content.post.remove`, `content.post.retry`;
- `live.created`, `live.scheduled`, `live.went_live`, `live.ended`, `live.canceled`, `live.key_viewed`;
- `threads.connected`, `threads.disconnected`, `threads.deauthorized`, `threads.reply_hidden`, `threads.reply_unhidden`, `threads.replied`;
- `social.refresh`.

---

## 8. Tests

### 8.1 Unit tests (vitest, no network; every package keeps `npm test` green)

| File | Covers |
|---|---|
| `tests/content-formats.test.ts` | Every row of the 2.1 table. Every 2.3 step 7 message. Options validation (unknown keys refused, limits). The per-channel text override against the channel's limit. Emoji counted by UTF-8 bytes for Threads. |
| `tests/content-errors.test.ts` | Every 3.5 row: Meta code to copy and action (`retry`, `wait`, `fail`, `unclear`). Unknown codes fall back. No raw message leaks. |
| `tests/media-probe.test.ts` | JPEG (SOF0 and SOF2, EXIF rotation), PNG, MP4 and MOV (`mvhd` duration, `tkhd` size and rotation, avc1, hvc1 and hev1). An upright video rotated by 90 degrees. Truncated and hostile files rejected within 50 ms and 2 MB of reads. |
| `tests/content-media.test.ts` (extended) | `ContentMedia` row on upload. Lazy probe of an old file. Delete removes the row. Env video limit. |
| `tests/graph-binary.test.ts` | Exact headers and hosts. Streaming from disk (a 20 MB temp file is never fully buffered). Resume from `GET upload:` offset. `appsecret_proof`. Tripwire before any I/O. `graphVideoPost` never retried after an unclear outcome. |
| `tests/spend-classify.test.ts`, `tests/spend-bypass.test.ts`, `tests/spend-tripwire.test.ts` (extended) | 5.5 fixtures, allowlist entries with reasons, and a planted bypass through each new transport. |
| `tests/robots-media.test.ts` | Meta's agents may fetch `/api/content/media-public/` and nothing else under `/api`. Others still see `/api` disallowed. |
| `tests/content-publish-facebook.test.ts` | F1–F13 per format against `fake-meta-social`. Album ids saved before the feed call. A Reel resumes after a dropped upload. Finish is not repeated after an unclear outcome. MOV fallback. The 30 Reels a day wait. Permalink. Remove. |
| `tests/content-publish-instagram.test.ts` | I2–I10. Carousel children reused on a rerun. Video children through resumable upload. Story image and video. Quota wait. Container `ERROR` and `EXPIRED`. Polling cadence. |
| `tests/content-publish-threads.test.ts` | T7–T14. 30 s wait. Carousel 2 to 20. The link limit. Quota wait. Remove with the delete quota. |
| `tests/content-pipeline-v2.test.ts` | Phase and heartbeat rules. An interrupted upload resumes. An interrupted create becomes an unclear failure. A busy heartbeat under 2 min is left alone. `SocialPostStat` row on publish with the Story offset. Retry and remove routes. Old request bodies still accepted. |
| `tests/content.test.ts` (existing) | Stays green, except the "returns a clear error for Threads" case, which is replaced by Threads publishing. |
| `tests/live-service.test.ts`, `tests/live-key.test.ts`, `tests/live-worker.test.ts` | Followers check. One active per Page (409). Three scheduled at most. Key split, sealed, admin only, no-store, audited, rate-limited, absent from every other response. Go live needs a signal. End wipes the key. Status mapping. Expiry after 6 h. Cancel. Error codes 1363144 and 1363120. Comments cache. |
| `tests/social-insights-sync.test.ts` | Catalog is the only source of names. 3-day refetch. Backfill caps. Empty set is not 0. Rate-limit pause for 1 h. Post schedule (3 h, daily, 3 days, final). Story at 21 h. Story `(#10)` becomes `tooFewViews`. |
| `tests/social-results.test.ts` | Tiles and change against the previous period. Reached hidden for All and Threads. Best posts. Best time needs 10 posts. `ANALYZE` and permission states. Refresh throttle. Tenant isolation. |
| `tests/threads-oauth.test.ts`, `tests/threads-token-refresh.test.ts`, `tests/threads-callbacks.test.ts`, `tests/threads-erasure.test.ts`, `tests/threads-replies.test.ts` | 5.2 and 7.6: state flavors do not cross. Exact authorize URL. Token never returned. Refresh rules (24 h, 3 failures). Signed request with the Threads secret. Erasure order. Replies untrusted. Hide and reply quotas. |
| `tests/usage-scopes-alignment.test.ts` (updated twice) | 5.1. |
| `tests/lifecycle-personal-data.test.ts`, `tests/lifecycle-retention.test.ts`, `tests/lifecycle-erase.test.ts` (extended) | 4.4. |
| `tests/notices-social.test.ts` | 5.8: raise, deduplicate, resolve. |
| `tests/actions-defs-social.test.ts` plus the existing `actions-route-coverage`, `actions-role-parity`, `actions-risk` and `actions-untrusted` tests | 5.6. No definition returns the key. `returnsSecret` is never set. Cards show the per-channel text verbatim. |
| `tests/content-ui.test.ts`, `tests/content-details-ui.test.ts`, `tests/live-ui.test.ts`, `tests/results-ui.test.ts`, `tests/threads-card-ui.test.ts` | Copy snapshots, the banned-words check (no "token", "webhook", "insights" or "container" in page copy), token-only styling (grep), reason text on disabled options. |
| `tests/auth-nav.test.ts`, `tests/ui-system.test.ts`, `tests/worker-loop.test.ts` (updated) | The nav item, the `removed` status and the registered worker modules. |
| Unverified-email test (inside `tests/content-pipeline-v2.test.ts`) | Each new write route returns 403 with `UNVERIFIED_MESSAGE` for an unverified member. |

### 8.2 Database tests (`tests/db`, gated on `DATABASE_URL_TEST`)

- The migration applies to a copy of the schema.
- The partial unique index refuses a second active live on the same Page.
- The `SocialPostStat` foreign key sets `postTargetId` to null when a post is deleted.
- Workspace erasure empties every new table.

### 8.3 Fake Meta (`tests/helpers/fake-meta-social.ts`)

A `fetch` stub that models:

- **Hosts:** `graph.facebook.com`, `graph-video.facebook.com`, `rupload.facebook.com` and `graph.threads.com`;
- **Flows:** the calls in 3.2, including resumable offsets, container states that change over time, live status changes and ingest health;
- **Failures:** each 3.5 error, plus injected network drops before or after the request is sent (the unclear case).

It extends the existing `tests/helpers/fake-meta.ts` conventions.

### 8.4 End to end (Playwright, desktop Chrome and Pixel 7 tagged `@mobile`)

(critic) The e2e suite must never call the real Meta. Tests that show a "reconnect" outcome seed the connection with `status: 'expired'`, so `getAssetAccess` (or `getThreadsAccess`) refuses with 409 before any network call. The suite does not rely on Meta answering 190 to a fake token, which would need network access and could rate-limit the app. When the ads spec's PRM-03 fake Meta server (`GRAPH_BASE_URL`) has merged, a later package may point the publishing e2e at it. Until then, the e2e tests cover seeded states, validation, roles, isolation and error copy, and publishing is covered by the unit tests against fake Meta.

| Spec | Scenarios |
|---|---|
| `e2e/content-formats.spec.ts` | Format defaults for text, 1 photo, 3 photos, an upright video and mixed media. Disabled options with reasons. Alt text. Reorder by keyboard. Threads chip after seeding a `ThreadsAccount`. Per-channel text override. Save as scheduled. `GET /api/content/posts` shows the targets with formats. |
| `e2e/growth-content.spec.ts` (existing) | Stays green. Copy is updated only where it changed. |
| `e2e/content-details.spec.ts` | Seeded published, failed (normal and unclear) and removed targets. Remove on Facebook with the connection seeded `expired` (the reconnect copy shows, and no Meta call is made). Instagram remove copy. Threads replies panel on an `expired` Threads account (reconnect copy). |
| `e2e/content-live.spec.ts` | Seeded `ready`, `scheduled`, `live` and `ended` rows. The key is hidden until Show, and an agent sees no key controls. The followers alert needs a Meta read, so it is covered by `tests/live-service.test.ts` and `tests/live-ui.test.ts` against fake Meta, not here. Set up with the connection seeded `expired` shows the reconnect copy. The "Start: as soon as my stream starts" choice shows its warning. The ended summary. |
| `e2e/content-results.spec.ts` | Seeded `SocialDailyStat` and `SocialPostStat` rows. Tiles, change, chart and the table toggle. Best posts. Best time below and above 10 posts. Account chips. Another workspace sees nothing. |
| `e2e/threads-connect.spec.ts` | The card is shown when `THREADS_APP_ID` is set. Start returns a `threads.com` URL with the exact parameters. A callback with a bad state shows the error copy. Disconnect of a seeded account. An agent sees "Ask an admin". |

Every spec:

- runs axe with no serious findings;
- checks for no horizontal overflow at 360, 390 and 1280 px;
- takes a dark-theme screenshot;
- checks that the console has no errors.

### 8.5 Verification runbook (`docs/social-verification-runbook.md`, package SOC-20)

Each row is run with the review user's real test assets, through `scripts/social-verify.ts` (run on the server by an operator, with `SOCIAL_VERIFY=1`, against the test Page, test Instagram and test Threads only).

| ID | Question | How to check |
|---|---|---|
| V-S1 | Can the "Access the Threads API" use case be added to app 1799953191201553? | App Dashboard > Use cases > Add. If not, create a Threads-only app; the code reads `THREADS_APP_ID` either way. |
| V-S2 | Do Meta's fetchers obey the robots group and fetch signed URLs? | Publish a test image to Instagram and Threads, and a MOV video with F6b. |
| V-S3 | Is `publish_video` needed for Page videos and Reels? The docs say no (critic). | Run F4–F9 with a token whose configuration lacks `publish_video`. If Meta refuses, add one screencast step to 9.3 and one sentence to its description. |
| V-F1 | Does `/feed` work without `pages_manage_engagement`? | F1 with the review token. |
| V-F2 | What is the album maximum? | F3 with 10, then 11 photos. |
| V-F3 | Does the resumable session take `video/quicktime`? Does `graph-video` accept JSON? | F4 with a MOV; F6 sent as JSON and as multipart. |
| V-F4 | Is the Reels finish value `finish` or `complete`? How is the `post_id` read back? | F9 both ways on the test Page. |
| V-F9 | Can a Page Story be deleted? | `DELETE` on a test Story's `post_id`. |
| V-I4 | Is the Instagram rupload path versioned, or should the `uri` be used? | I5 response, then I6. |
| V-I8 | Which Instagram error codes come back for the limit, aspect ratio, format and download failures? | Publish deliberately wrong media. Record the codes in `errors.ts`. |
| V-I9 | What are the PPA error codes? | Ask on a Page with PPA pending, if available, or record the docs answer. |
| V-I10 | (critic) Do carousel child images accept `alt_text`? | I4 with `alt_text` on a child. If refused, `formats.ts` stops sending it on children and the composer says "Descriptions go to single Instagram photos only". |
| V-I11 | (critic) Can an app delete Instagram media, with which method, and does `instagram_manage_contents` exist in the dashboard? | Re-read the Instagram Media reference "Deleting" section and the permissions reference. Look for `instagram_manage_contents` under the Instagram use case. If both are confirmed, the owner decides whether to add it to the draft (11.1 item 9). |
| V-I12 | (critic) Is the 400-containers-per-24-h limit still documented? | Read the `/{ig-user-id}/media` reference. |
| V-L2 | What is the `event_params` format? | L2 in object form, then bare. |
| V-L3 | How is the signal detected? | Stream from OBS to an `UNPUBLISHED` live and read `ingest_streams`. |
| V-L4 | Is the `live_views` field available? | L3 while live. |
| V-L6 | Is a scheduled live canceled by status or by `DELETE`? | L7 both ways. |
| V-L7 | Does `from{name}` on comments need `pages_read_user_content`? | L8 with and without that permission in the configuration. |
| V-L8 | Do reactions return a summary count? | L9. |
| V-R1 | Are the 1.3/R1 Page metrics not deprecated on the build date? | Re-read the deprecated-metrics page, then R1. |
| V-R2 | Resolved by the docs (critic): "Only 90 days of insights can be viewed at one time". | No check needed; Edwyz uses 30-day windows. |
| V-R3 | What makes up Facebook post interactions? | Compare R2 with the post in Meta Business Suite. |
| V-R5 | Is `follower_count` available on the test account? | R5. |
| V-R6 | Do Instagram insights work with a Page token? | R4 and R6 with the Page token, then the user token. |
| V-R7 | What are the current rate-limit formulas for Pages and Instagram? | Read the `X-Business-Use-Case-Usage` header in the verify script. |
| V-R8 | Do Page Stories have insights? | R2 on a Story. |
| V-T1 | The docs now name `threads.com` (critic, 2026-10-31). Does `threads.net` still redirect, for old bookmarks? | T1 on `threads.com`; `threads.net` is only a fallback. |
| V-T5 | What are the reply field names? | T15. |
| V-T6 | Which permissions does `reply_to_id` need? | T17 with `threads_manage_replies`, with and without `threads_content_publish`. |
| V-T7 | Is the Threads signed request signed with the Threads app secret? | Trigger "remove app" with the test profile and verify. |
| V-T8 | Is there a revoke endpoint for Threads? | Docs search, plus `DELETE /me/permissions` on `graph.threads.com`. Expected: none. |
| V-T9 | (critic) What form does the Threads app access token take for T6? | T6 with `TH\|id\|secret`, then `id\|secret`. |

---

## 9. App Review package

### 9.1 Shared parts

**Test assets the owner prepares (11.1):**

- the review user `[OWNER: REVIEW EMAIL]`, a member of the workspace "Edwyz Review", with no two-step verification;
- a test Facebook user with a role on the app;
- the Page "Edwyz Review Page", with **at least 100 followers** and an account at least 60 days old, because Meta's Live rule requires both;
- the Instagram professional account `@edwyz.review` linked to that Page, with PPA done if Facebook asks for it;
- the Threads profile `@edwyz.review`, added as a Threads tester and accepted;
- OBS Studio on the recording computer.

**Recording rules (every screencast):**

- 1080p, with Chrome's address bar visible;
- an English caption naming each step;
- under 5 minutes;
- no terminal, dev tools, env files, other tabs or real customers' data;
- the stream key is never revealed: use **Copy**, never **Show**.

**Part A: connect Facebook and Instagram** (start of every Facebook or Instagram video):

1. Open `https://wa.edwyz.com/login`. Sign in as the review user. Caption: "Log in to Edwyz".
2. Open **Settings > Meta connections**. Click **Connect Facebook and Instagram**.
3. The Facebook Login for Business popup appears. Log in as the test Facebook user. Choose the business, then the Page "Edwyz Review Page" and the Instagram account "@edwyz.review".
4. On Meta's permission screen, **pause 3 seconds** with the permission under review visible (for example "Create and manage content on your Page" or "Access insights for your Page"). Click **Save**, then **Got it**.
5. Back in Edwyz, the Connections list shows the Page and Instagram as **Connected**. Expand the connection to show the permission in the "Permissions Meta granted" list.

**Part B: connect Threads** (start of every Threads video):

1. Sign in to Edwyz as in Part A, step 1. Open **Settings > Meta connections**. On the Threads card, click **Connect Threads**.
2. The Threads popup appears. Log in as `@edwyz.review`. On the consent screen, **pause 3 seconds** with the permission list visible. Click **Allow**.
3. The card shows "@edwyz.review · Connected".

**Reviewer instructions (paste once, then the per-item lines):**

> Edwyz (https://wa.edwyz.com) is a WhatsApp and social media workspace for small businesses in India. Log in at https://wa.edwyz.com/login with [OWNER: REVIEW EMAIL] and [OWNER: REVIEW PASSWORD] (no two-step verification). The workspace "Edwyz Review" is already connected to the Facebook Page "Edwyz Review Page", its Instagram account "@edwyz.review" and the Threads profile "@edwyz.review". To see the login and permission screens yourself, open Settings > Meta connections and connect again (Facebook) or click Connect Threads (Threads). Until this review is approved, Threads lets only accounts added as Threads Testers connect to our app, so the screencast shows the Threads consent screen with our tester profile, and the workspace stays connected for you to test publishing. Content calendar is in the left menu under Campaigns; Social results is under Insights; Live videos opens from Content calendar > Go live. Live video needs streaming software: install OBS Studio (free), then copy the server and stream key from the Live videos page into OBS (Settings > Stream > Service: Custom).

Descriptions are under Meta's 1,000-character limit. Each per-item block below gives:

- the **description**;
- the **screencast**, as steps after Part A or Part B;
- the **API test calls**, which the screencast steps make, plus any extra ones;
- the **reviewer line**, appended to the shared instructions.

### 9.2 `pages_manage_posts`

**Description:** "Edwyz's Content calendar (wa.edwyz.com/app/content) lets a small business write a post once and publish it to the Facebook Page it manages and selected, now or at a time it picks. Formats: text, a link, a photo, an album of up to 10 photos, a video, a Reel or a Story. We use pages_manage_posts to create these posts on that Page, and to remove a post the business published through Edwyz when it taps Remove from Facebook. We never post without the person's explicit Post now or Schedule action (or a client approval they asked for). We store the post text, media and the post id Meta returns in the business's workspace until the business deletes them or disconnects. Only that workspace's members see them. We do not sell or share this data."

**Screencast (after Part A):**

1. Content calendar > **New post**.
2. Select "Edwyz Review Page · Facebook Page". Type "Testing Edwyz: new stock this week" and add 3 photos. The Facebook row shows "Album".
3. Choose **Post now**, then confirm.
4. Post details shows "Published · View on Facebook". Click it. The Page shows the album.
5. Back in Edwyz, make a second post: one upright 20-second video, Facebook format **Reel**. Pick a time 2 minutes ahead and click **Schedule post**. Wait. The status goes Scheduled, then Published. Open it on Facebook.
6. In post details of the first post, click **Remove from Facebook**, then confirm. Refresh the Page: the album is gone.

**API test calls:**

- `POST /{page-id}/photos` (×3) and `POST /{page-id}/feed`;
- `POST /{page-id}/video_reels` (start and finish) and the rupload upload;
- `DELETE /{post-id}`.

**Reviewer line:** "pages_manage_posts: Content calendar > New post > choose the Page > type text and add photos > Post now. Use View on Facebook to see it, then Remove from Facebook in post details."

### 9.3 `publish_video`

**Description:** "Edwyz lets a small business go live on its own Facebook Page from wa.edwyz.com/app/content/live. The business sets up a live video (now or up to 7 days ahead). Edwyz creates the live video on the Page the person manages and selected, and shows the stream URL and key to paste into OBS or a phone streaming app. When Edwyz confirms the stream is arriving, the person taps Go live. During the broadcast Edwyz shows how many people are watching and the comments, and the person ends it with End live. We use publish_video only to create, start, read and end these live videos. We store the title, description and the live video id. The stream key is encrypted and deleted when the live ends. Comments are not stored. Nothing is broadcast without the person's tap."

**Screencast (after Part A):**

1. Content calendar > **Go live** > **Set up a live video**.
2. Title "Edwyz review live", When **Now**, then **Get stream key**.
3. The stream details card appears. Click **Copy** next to Server and paste it into OBS (Settings > Stream > Custom). Click **Copy** next to Stream key and paste it into OBS. The key stays hidden on screen.
4. Click OBS **Start streaming**. Edwyz shows "We're receiving your stream". Click **Go live now** and confirm.
5. Show the Facebook Page in a second window with the live video playing. Post a comment from another account. In Edwyz, "Watching now" updates and the comment appears.
6. Click **End live** and confirm. Edwyz shows "Live ended" and the replay link. Open it.

**API test calls:**

- `POST /{page-id}/live_videos` (status `UNPUBLISHED`);
- `GET /{live-id}?fields=status,ingest_streams,live_views`;
- `POST /{live-id}` (`status=LIVE_NOW`);
- `GET /{live-id}/comments`;
- `POST /{live-id}` (`end_live_video=true`);
- `POST /{page-id}/live_videos` (status `SCHEDULED_UNPUBLISHED`), from a second scheduled setup.

**Reviewer line:** "publish_video and Live Video API: Content calendar > Go live > Set up a live video > Now > Get stream key. Paste the server and key into OBS, start streaming, then click Go live now. End with End live. The test Page has the 100 followers Facebook requires for live video from apps."

### 9.4 Live Video API (feature)

- **Description:** the same as 9.3, plus: "Edwyz needs the Live Video API because small businesses run sales and Q&A sessions live on their Page and manage them alongside their WhatsApp inbox."
- **Screencast:** the same video as 9.3.
- **API test calls:** as 9.3.
- **Reviewer line:** as 9.3.

### 9.5 `read_insights`

**Description:** "Edwyz's Social results screen (wa.edwyz.com/app/content/results) shows a small business how its own Facebook Page and posts are doing: views, people reached, interactions, new followers, views per day, its best posts and the best time to post. Post details in the Content calendar show each post's numbers. We read insights only for Pages the person manages and connected. We read daily and store daily totals and per-post totals, never data about individual people, for 400 days in that business's workspace. Only its members see them. We do not sell or share this data."

**Screencast (after Part A):**

1. In the menu, Insights > **Social results**.
2. Choose "Edwyz Review Page · Facebook". Show the four tiles, views per day and best posts. Switch the period to 7 days.
3. Click (i) on People reached to show the definition.
4. Open Content calendar, open the published album's details and show its numbers line.

**API test calls:**

- `GET /{page-id}/insights?metric=page_media_view,page_total_media_view_unique,page_post_engagements,page_daily_follows_unique,page_follows&period=day&since&until`;
- `GET /{post-id}/insights?metric=post_media_view,post_total_media_view_unique,post_clicks,post_reactions_by_type_total`.

**Reviewer line:** "read_insights: Insights > Social results > choose the Facebook Page. Post numbers also appear in Content calendar > a published post."

### 9.6 `instagram_basic`

**Description:** "Edwyz reads basic information about the Instagram professional account linked to the business's Facebook Page: its id, username and follower count, and the list of its recent posts with their links. We show the username on the Content calendar's account choice so the person knows where a post goes, show the follower count and recent posts on Social results, and link each published post to Instagram. We store the username, the account id and the ids and links of posts in the business's workspace until it disconnects. We do not sell or share this data."

**Screencast (after Part A):**

1. Content calendar > **New post**: the chip "@edwyz.review · Instagram" is shown.
2. Social results > choose "@edwyz.review · Instagram": the follower count and the recent posts list, including one posted in the Instagram app, which is marked as not made in Edwyz.
3. Open a published Instagram post's details and click **View on Instagram**.

**API test calls:**

- `GET /{ig-user-id}?fields=username,name,followers_count,media_count`;
- `GET /{ig-user-id}/media?fields=id,caption,media_type,media_product_type,timestamp,permalink`;
- `GET /{ig-media-id}?fields=permalink`.

**Reviewer line:** "instagram_basic: the Instagram account appears in Content calendar > New post, and in Social results with its follower count and recent posts."

### 9.7 `instagram_content_publish`

**Description:** "Edwyz's Content calendar lets a small business publish to its own Instagram professional account: a photo, a carousel of up to 20 photos and videos, a Reel or a Story, now or at a scheduled time. We use instagram_content_publish to create the media and publish it, and to read the account's daily publishing limit so the person sees how many posts are left today. We never publish without the person's Post now or Schedule action (or a client approval they asked for). We store the caption, media and returned media id in the workspace until the business deletes them or disconnects. We do not sell or share this data."

**Screencast (after Part A):**

1. Content calendar > **New post**. Select "@edwyz.review · Instagram". The meter shows "Instagram: N of {total} posts left today" (the total Meta returns).
2. Add 3 photos and type a caption. The Instagram row shows "Carousel". Click **Post now** and confirm.
3. The status shows "Preparing media", then "Published". Click **View on Instagram**.
4. A new post with one upright video, Instagram format **Reel**, "Also show in your feed" on. Schedule it 2 minutes ahead. It publishes. View it.
5. A new post with one photo, format **Story**, **Post now**. Show the Story on Instagram.

**API test calls:**

- `GET /{ig-user-id}/content_publishing_limit`;
- `POST /{ig-user-id}/media` (carousel items, parent, `REELS` resumable, `STORIES`);
- the rupload upload;
- `GET /{container-id}?fields=status_code`;
- `POST /{ig-user-id}/media_publish`.

**Reviewer line:** "instagram_content_publish: Content calendar > New post > choose the Instagram account > add photos or a video > Post now or Schedule. The format (Post, Reel or Story) can be changed in step 3."

### 9.8 `instagram_manage_insights`

**Description:** "Edwyz's Social results screen shows a small business how its own Instagram professional account is doing: reach, views, interactions and new followers for 7, 28 or 90 days, views per day, its best posts, and numbers for each post, Reel and Story. Story numbers are saved shortly before Instagram removes them after 24 hours, so the business can still see them later. We read insights only for the account linked to the business's connected Page, store daily and per-post totals (no individual people) for 400 days in its workspace, and only its members see them. We do not sell or share this data."

**Screencast (after Part A):**

1. Social results > choose "@edwyz.review · Instagram". Show the tiles, views per day and best posts.
2. Open the details of an Instagram Story published at least 21 h before recording (publish it through Edwyz the day before): show its numbers, saved before Instagram removed the Story.
3. Content calendar > the Reel's details: show views, reach and average watch time.

**API test calls:**

- `GET /{ig-user-id}/insights?metric=reach,views,accounts_engaged,total_interactions&period=day&metric_type=total_value&since&until`;
- `GET /{ig-user-id}/insights?metric=follower_count&period=day`;
- `GET /{ig-media-id}/insights?metric=views,reach,likes,comments,shares,saved,total_interactions`.

**Reviewer line:** "instagram_manage_insights: Insights > Social results > choose the Instagram account. Per-post numbers are in Content calendar > a published Instagram post."

### 9.9 `threads_basic`

**Description:** "Edwyz lets a small business connect its own Threads profile in Settings > Meta connections, so it can publish to Threads from the same Content calendar it uses for Facebook and Instagram. We use threads_basic to read the profile's id, username and name, to show which profile is connected and to label posts, and to keep the connection active. We store the id, username, name and an encrypted access token in the business's workspace until it disconnects. Disconnecting deletes the token. We do not sell or share this data."

**Screencast (after Part B):**

1. The Threads card shows "@edwyz.review · Connected".
2. Content calendar > **New post**: the chip "@edwyz.review · Threads" is shown.
3. Back on the card, click **Disconnect**, then confirm. The card shows "Not connected" and the help line about Website permissions.
4. Connect again (Part B).

**API test calls:**

- `POST /oauth/access_token`;
- `GET /access_token` (long-lived);
- `GET /v1.0/me?fields=id,username,name`;
- `GET /v1.0/debug_token`.

**Reviewer line:** "threads_basic: Settings > Meta connections > Threads > Connect Threads. The connected profile also appears in Content calendar > New post."

### 9.10 `threads_content_publish`

**Description:** "Edwyz's Content calendar lets a small business publish to its own Threads profile: text, a link, a photo, a video or a carousel of 2 to 20 items, now or at a scheduled time, with a choice of who can reply. We use threads_content_publish to create and publish these posts and to read the daily publishing limit, which Edwyz shows as posts left today. Nothing is posted without the person's Post now or Schedule action. We store the post text, media and Threads post id in the business's workspace until it deletes them or disconnects. We do not sell or share this data."

**Screencast (after Part B):**

1. Content calendar > **New post** > select "@edwyz.review · Threads". The meter shows posts left.
2. Type text with a link. The Threads preview shows the link. **More options** > Who can reply: "People you follow". Click **Post now** and confirm.
3. "Published · View on Threads". Open it.
4. A second post with 2 photos (Carousel), scheduled 2 minutes ahead. It publishes. View it.

**API test calls:**

- `GET /v1.0/{user}/threads_publishing_limit`;
- `POST /v1.0/{user}/threads` (TEXT; IMAGE items and CAROUSEL);
- `GET /v1.0/{container}?fields=status`;
- `POST /v1.0/{user}/threads_publish`.

**Reviewer line:** "threads_content_publish: Content calendar > New post > choose the Threads profile > type text (and add photos if you like) > Post now."

### 9.11 `threads_manage_insights`

**Description:** "Edwyz's Social results screen shows a small business how its own Threads profile is doing: views, likes, replies, reposts, quotes, link clicks and followers, for 7, 28 or 90 days, and the numbers for each post. We read insights only for the connected profile. We store daily and per-post totals (no individual people) for 400 days in the business's workspace, and only its members see them. We do not sell or share this data."

**Screencast (after Part B):**

1. Social results > choose "@edwyz.review · Threads". Show the tiles (People reached is not shown for Threads) and views per day.
2. Content calendar > the Threads post from 9.10 > show its numbers line.

**API test calls:**

- `GET /v1.0/{user}/threads_insights?metric=views,likes,replies,reposts,quotes,clicks,followers_count`;
- `GET /v1.0/{media}/insights?metric=views,likes,replies,reposts,quotes,shares`.

**Reviewer line:** "threads_manage_insights: Insights > Social results > choose the Threads profile."

### 9.12 `threads_read_replies`

**Description:** "In Edwyz's Content calendar, the details of a post published to Threads show its replies, so a small business can read and answer them in the same place it schedules posts. We use threads_read_replies to read the replies to the business's own posts when the person opens the post. Replies are shown on screen and are not stored by Edwyz. We do not sell or share this data."

**Screencast (after Part B):**

1. From another Threads account, reply to the 9.10 post.
2. In Edwyz, open the post's details > **Replies (1)**. The reply shows with the author and time.

**API test call:** `GET /v1.0/{media}/replies?fields=id,text,username,timestamp,hide_status`.

**Reviewer line:** "threads_read_replies: Content calendar > a published Threads post > Replies."

### 9.13 `threads_manage_replies`

**Description:** "Edwyz lets a small business manage the replies to its own Threads posts. It can choose who can reply when creating a post, hide or unhide an unwanted reply, and reply as its profile from the post's details in the Content calendar. We use threads_manage_replies only when the person taps Hide, Unhide or Send reply, or sets Who can reply. Reply text the business sends is kept with the post in its workspace. Replies from others are not stored. We do not sell or share this data."

**Screencast (after Part B, continuing 9.12):**

1. On the reply, click **Hide**. Show on Threads that the reply is hidden. Click **Unhide**.
2. Type "Thank you!" in "Reply as @edwyz.review" and click **Send reply**. Show it on Threads.
3. Show the 9.10 step 2 "Who can reply" choice in the composer.

**API test calls:**

- `POST /v1.0/{reply}/manage_reply` (`hide=true`, then `false`);
- `POST /v1.0/{user}/threads` with `reply_to_id`, then `threads_publish`;
- `GET threads_publishing_limit` (reply quota).

**Reviewer line:** "threads_manage_replies: Content calendar > a published Threads post > Replies > Hide, Unhide, or Send reply."

### 9.14 `threads_delete`

**Description:** "Edwyz lets a small business remove a post it published to its own Threads profile through Edwyz, from the post's details in the Content calendar (Remove from Threads). We use threads_delete only when the person taps Remove from Threads and confirms. Edwyz keeps its own copy of the post in the calendar, marked Removed. We do not sell or share this data."

**Screencast (after Part B):**

1. Content calendar > the 9.10 text post > **Remove from Threads**, then confirm.
2. The row shows "Removed from Threads". Refresh the profile on Threads: the post is gone.

**API test call:** `DELETE /v1.0/{media-id}`.

**Reviewer line:** "threads_delete: Content calendar > a published Threads post > Remove from Threads."

### 9.15 `pages_read_engagement` (already in the draft: append to its description)

Append: "Edwyz also reads the Page's recent posts for the Social results screen, reads a live video's status, viewer count and comments while the business runs a live video from Edwyz (comments are shown and not stored), and reads post links after publishing."

Screencast: covered by 9.3 step 5 and 9.5 step 2. Add both steps to the existing combined ads-and-Pages video, or point to them.

API test calls (already made by those videos): `GET /{page-id}/published_posts`, `GET /{live-id}/comments`, `GET /{post-id}?fields=permalink_url`.

Reviewer line (append): "pages_read_engagement also powers Insights > Social results (recent Page posts) and the live viewer count and comments on Content calendar > Go live."

### 9.16 `pages_show_list` (already in the draft: append to its description)

(critic) Added so that every permission named in 1.3 has its review text.

Append: "Edwyz also lists the Pages the person manages so they can choose where a post goes in the Content calendar and which Page a live video runs on."

Screencast: 9.2 step 2 (choosing the Page in the composer) and 9.3 step 2 (the Page field on the live setup, pre-selected when there is one Page). Add both to the combined ads-and-Pages video, or point to them.

API test call: `GET /me/accounts` (asset discovery, already made at connect).

Reviewer line (append): "pages_show_list: the Page choice in Content calendar > New post and in Go live > Set up a live video."

---

## 10. Build work packages

### 10.1 Order and waves

Packages in the same wave have disjoint file sets and can be built in parallel. A package may start once everything in its "Depends on" has merged.

| Wave | Packages |
|---|---|
| 1 | SOC-01, SOC-02, SOC-03 |
| 2 | SOC-04, SOC-05, SOC-06, SOC-07, SOC-08 |
| 3 | SOC-09, SOC-11, SOC-16, SOC-17 |
| 4 | SOC-10, SOC-18 |
| 5 | SOC-12, SOC-13, SOC-14, SOC-19 |
| 6 | SOC-15 |
| 7 | SOC-20 (needs the owner's test assets and the Meta dashboard changes) |

(critic) SOC-19 moved from wave 6 to wave 5: everything it depends on has merged by wave 4, and its files do not overlap SOC-12, SOC-13 or SOC-14. File sets were re-checked for each wave after the corrections below.

**Files shared with other specs.** Serialize these at merge time with the other workstreams:

| File | Also changed by |
|---|---|
| `prisma/schema.prisma`, `personal-data.ts` | Every spec with a migration |
| `meta-connect/state.ts`, `meta-connect/index.ts` | IG-PAGE-ADS PRM-07 |
| `src/components/meta-connect/useFacebookLoginPopup.ts` | IG-PAGE-ADS PRM-07 (its popup work) |
| `src/components/content/{Composer,ChannelPreview,ContentView}.tsx` | IG-PAGE-ADS PRM-15 ("Boost this post" chip) |
| `spend/classify.ts`, `tests/spend-bypass.test.ts` | The Phase 0 owner |
| `actions/not-exposed.ts`, `nav.ts`, `notices/scan.ts`, `notices/kinds.ts`, `eddy/contract.ts`, `eddy/copy/notices.ts`, `worker/loop.ts`, `scopes.ts`, `usage-scopes-alignment.test.ts` | Any spec that adds routes, nav items, notice kinds, workers or scopes (META-CATALOG-COMMERCE adds three notice kinds to the same three notice files) |
| `docs/meta-dashboard-requirements.md`, `docs/app-review/{00-overview,status,pages_read_engagement,pages_show_list}.md` | The Messenger and Instagram inbox, catalog and partnership specs (their review items) |

Whoever lands second rebases. No package here needs the other specs' code, except the optional reuse of the media probe (SOC-04) and of `meta-screens.ts` (3.5).

### 10.2 Packages

#### SOC-01: Foundation (schema, registry, flags, notice kinds, worker stubs)

- **Files:**
  - create `prisma/migrations/0019_social_publisher/migration.sql`;
  - change `prisma/schema.prisma`;
  - change `src/lib/lifecycle/personal-data.ts`, `src/lib/lifecycle/retention.ts`, `src/lib/lifecycle/erase-meta.ts`;
  - create `src/lib/social/flags.ts`;
  - create stub workers `src/lib/live/worker.ts`, `src/lib/social-insights/worker.ts` and `src/lib/threads/worker.ts` (each `{ queues: {}, periodic: [] }`);
  - change `src/worker/loop.ts` (add the three to `MODULES`);
  - change `src/lib/eddy/contract.ts` (the `NoticeKind` union), `src/lib/notices/kinds.ts` (`NOTICE_KINDS`, `KIND_SPECS`, `PAYLOAD_KEYS`, `textKeyFor`), `src/lib/eddy/copy/notices.ts`;
  - no change to `tests/eddy-notices.test.ts` or `tests/eddy-i18n.test.ts`, but both must stay green. The first checks that every kind in `NOTICE_KINDS` maps through `textKeyFor` to a real catalogue key (not `notices.generic`). The second checks the three-language parity, the Hindi Latin allowlist and the ban on a gendered first person;
  - change `.env.example`, `scripts/check-env.mjs`;
  - create `tests/social-foundation.test.ts`;
  - change `tests/lifecycle-retention.test.ts`, `tests/lifecycle-erase.test.ts`, `tests/worker-loop.test.ts`.
- **Depends on:** none.
- **Acceptance:**
  1. The 4.1 SQL applies once with `psql -v ON_ERROR_STOP=1 -1` on a copy of the production schema. `prisma validate` and `prisma generate` pass, and the generated client matches the SQL.
  2. `personal-data.ts` lists the new models with the 4.4 text and retention, and `lifecycle-personal-data` passes.
  3. Retention deletes stats past `insightSnapshotDays`, deletes old lives, and wipes stray stream keys.
  4. `erase-meta.ts` deletes the stats and lives of the connection's assets only.
  5. `flags.ts` exports `contentV2()`, `liveVideo()`, `socialResults()` and `threadsEnabled()`, each `off | admins | on` (default `on`), plus `maxVideoBytes()` from `CONTENT_MAX_VIDEO_MB` (1 to 300, default 100). `threadsEnabled()` is `off` unless both `THREADS_APP_ID` and `THREADS_APP_SECRET` are set.
  6. The three stub workers are registered and `worker-loop` passes.
  7. Notice kinds `post_failed`, `threads_expired` and `live_soon` are in the `NoticeKind` union and `NOTICE_KINDS`, with severity, minimum role, `numberBased: false`, the `PAYLOAD_KEYS` `postId`, `liveId` and `accountId`, a `textKeyFor` branch, and the 5.8 copy in en, hi and hinglish. `eddy-notices` and `eddy-i18n` pass.
  8. `.env.example` documents `THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_GRAPH_HOST`, `CONTENT_MAX_VIDEO_MB`, `CONTENT_V2`, `LIVE_VIDEO`, `SOCIAL_RESULTS` and `THREADS`. `check-env` warns, and does not fail, when the Threads values are missing.

#### SOC-02: Transports and spend-guard rules

- **Files:**
  - create `src/lib/graph/binary.ts`;
  - change `src/lib/spend/classify.ts`;
  - change `tests/spend-classify.test.ts`, `tests/spend-bypass.test.ts`, `tests/spend-tripwire.test.ts`;
  - change `src/app/robots.ts`;
  - create `tests/graph-binary.test.ts`, `tests/robots-media.test.ts`.
- **Depends on:** none.
- **Acceptance:**
  1. `binary.ts` implements the 3.1 functions with the exact hosts, paths and headers of 3.2 (F4, F5, F6, F8, I6). It streams from disk with `Readable.toWeb(createReadStream(path, {start}))` and `duplex: "half"`, adds `appsecret_proof` on Graph hosts, has a 10 minute timeout, and calls `tripwire()` first.
  2. `resumableSend` resumes from `GET upload:` after a network error (at most 3 tries). `graphVideoPost` and every finish step are never retried after an unclear outcome.
  3. The `classify.ts` change matches 5.5 item 1, with the fixtures listed there.
  4. The bypass rules B1 and B12 carry the entries and reasons of 5.5 item 2, including `lib/threads/client.ts` ahead of its creation (an allowlist entry for a file that does not exist yet passes the current self-tests). The self-test still fails on a planted file. B1's pattern `graph\.facebook\.com` does not match `graph-video.facebook.com` or `rupload.facebook.com`, so only B12 lists those two hosts.
  5. The `robots.ts` group matches 5.5. The robots test passes.

#### SOC-03: Pure formats, errors, shared publisher types and fake Meta

- **Files:**
  - create `src/lib/content/formats.ts`, `src/lib/content/errors.ts`, `src/lib/content/publishers/common.ts`;
  - create `tests/helpers/fake-meta-social.ts`;
  - create `tests/content-formats.test.ts`, `tests/content-errors.test.ts`.
- **Depends on:** none.
- **Acceptance:**
  1. `formats.ts` exports:
     - `allowedFormats(channel, media)` and `defaultFormat(channel, media)`, matching 2.1 row by row;
     - `formatProblems(channel, format, body, media, options)`, with the 2.3 step 7 copy;
     - `parseTargetOptions()` for 4.3, refusing unknown keys.

     It imports `MediaKind` and `Channel` from `limits.ts` and does not change that file.
  2. `errors.ts` maps every 3.5 row to `{copy, action}`.
  3. `common.ts` holds `PublishError`, `Deferred`, `Published`, `toPublishError` (same semantics as today), the `MediaFile` and `ProgressStore` types, and the progress helpers `setPhase`, `heartbeat` and `isStale(heartbeatAt, 2 min)`. (critic) Until SOC-10 turns `publishers.ts` into a barrel that re-exports from `common.ts`, the old file keeps its own `PublishError`. Nothing wires the new publishers in before SOC-10, so the two classes never meet in one `instanceof` check.
  4. `fake-meta-social.ts` scripts the 8.3 behaviours and is used by at least one test in this package.

#### SOC-04: Media library v2 and probe

- **Files:**
  - change `src/lib/content/media.ts`, `src/lib/content/limits.ts`, `src/lib/content/worker.ts` (the orphan sweep);
  - change `src/app/api/content/media/route.ts`, `src/app/api/content/media/[file]/route.ts`;
  - create `src/lib/media-probe/index.ts`, `src/lib/media-probe/image.ts`, `src/lib/media-probe/mp4.ts`;
  - create `tests/media-probe.test.ts`, `tests/fixtures/media-probe/*`;
  - change `tests/content-media.test.ts`.
- **Depends on:** SOC-01.
- **Shared with the ads spec:** IG-PAGE-ADS PRM-03 plans the same parser at `src/lib/promote/{probe,mp4}.ts`. If PRM-03 has merged first, `media-probe/index.ts` re-exports it. Otherwise PRM-03 imports this module.
- **Acceptance:**
  1. The probe meets the 8.1 `media-probe` row.
  2. An upload writes `ContentMedia`. `mediaInfo(tenantId, key)` probes old files lazily and caches the result.
  3. `deleteMedia` removes the row. A daily orphan sweep is added to the content worker's existing periodic list.
  4. `MAX_VIDEO_BYTES` comes from `maxVideoBytes()`.
  5. `GET /api/content/media` returns `width`, `height` and `durationMs`.
  6. Quota and file-count behaviour are unchanged, and the existing media tests pass.

#### SOC-05: Threads connection

- **Files:**
  - create `src/lib/threads/{config,client,oauth,service,erase,signed-request}.ts`;
  - replace the stub `src/lib/threads/worker.ts`;
  - change `src/lib/meta-connect/state.ts`;
  - create `src/app/api/meta-connect/threads/start/route.ts`, `src/app/api/meta-connect/threads/callback/route.ts`, `src/app/api/meta-connect/threads/accounts/route.ts`, `src/app/api/meta-connect/threads/accounts/[id]/route.ts`;
  - create `src/app/api/meta/threads/deauthorize/route.ts`, `src/app/api/meta/threads/data-deletion/route.ts`;
  - change `src/lib/lifecycle/deletion-requests.ts`;
  - change `src/lib/actions/not-exposed.ts` (the four Threads connect entries of 5.6);
  - create `tests/threads-oauth.test.ts`, `tests/threads-token-refresh.test.ts`, `tests/threads-callbacks.test.ts`, `tests/threads-erasure.test.ts`.
- **Depends on:** SOC-01, SOC-02.
- **Acceptance:**
  1. Start returns the T1 URL with the exact parameters. Without configuration it returns 503 "Threads isn't set up on this server yet."
  2. The `THREADS` state flavor is single use, bound to the workspace and user, and never verifies a Meta Connect or signup state (or the other way round).
  3. The callback runs T2, T3, T5 and T6, upserts `ThreadsAccount` with a sealed token, and answers with the popup page or a redirect to `/app/settings/connections?threads=connected|cancelled|failed`. The popup page uses the same outcome words as the Facebook one (`connected | cancelled | failed`) under the `THREADS_POPUP` source, channel and meta name (5.2), never `CONNECT_POPUP`. The token appears in no response or log, and the tests grep for it.
  4. Disconnect wipes the token and sets `revoked`. A second connect of the same profile reuses the row.
  5. The refresh worker meets 5.4: it never refreshes a token under 24 h old, and 3 failures make the account `expired`.
  6. Both callbacks verify `signed_request` with `THREADS_APP_SECRET`. Deletion returns `{url, confirmation_code}`, and `processDeletionRequest` erases in the 4.4 order.
  7. Start answers 403 for an unverified member. Route coverage passes.

#### SOC-06: Facebook publisher

- **Files:**
  - create `src/lib/content/publishers/facebook.ts`;
  - change `src/lib/meta-connect/index.ts` (add `getAssetUserAccess`);
  - create `tests/content-publish-facebook.test.ts`.
- **Depends on:** SOC-02, SOC-03.
- **Acceptance:**
  1. `publishFacebookTarget(access, userAccess, post, target, progressStore)` implements F1–F12 for `feed` (text, link, photo, album, video), `reel` and `story`. (critic) Media arrive already resolved, as `MediaFile = {key, kind, path, bytes, width?, height?, durationMs?, url}`, a type in `publishers/common.ts` (SOC-03). `publish.ts` (SOC-10) builds it with the existing `resolveMediaPath`, `fs.stat` and `mediaPublicUrl`. So this package does not depend on SOC-04, and its tests build `MediaFile` from temp files.
  2. Each returned id is saved through `progressStore` before the next step.
  3. Video upload resumes from the saved offset. MOV uses F6b.
  4. `reelsUsed(tenantId, assetId, now)` counts published Reels in the last 24 h. At 30 it returns a deferral to when the oldest one turns 24 h.
  5. The permalink is read back.
  6. `removeFacebookPost(access, target)` implements F13. A Story returns the "can't remove" error.
  7. The 8.1 row passes against the fake.

#### SOC-07: Instagram publisher

- **Files:**
  - create `src/lib/content/publishers/instagram.ts`;
  - create `tests/content-publish-instagram.test.ts`.
- **Depends on:** SOC-02, SOC-03.
- **Acceptance:**
  1. `publishInstagramTarget(...)` implements I2–I10 for an image, a carousel (photo and video children), a Reel (resumable, `share_to_feed`, `thumb_offset`) and a Story (image and video).
  2. The polling cadence matches 3.6. Children and container ids are reused on a rerun.
  3. The quota wait reuses today's 15 minute defer.
  4. `alt_text` is sent only on images (single photos and carousel child photos). A child refused with code 100 is retried once without it (V-I10). Media come in as `MediaFile` (SOC-06 note).
  5. The meter and the wait use `quota_total` from I2, never a constant.
  6. The 8.1 row passes. Today's Instagram cases in `tests/content.test.ts` (owned by SOC-10) keep passing unchanged, because this package does not touch `publishers.ts` or `publish.ts`.

#### SOC-08: Live video server

- **Files:**
  - create `src/lib/live/{service,client,status,key,copy}.ts`;
  - replace the stub `src/lib/live/worker.ts`;
  - create `src/app/api/content/live/route.ts`, `src/app/api/content/live/[id]/route.ts`, `src/app/api/content/live/[id]/go-live/route.ts`, `src/app/api/content/live/[id]/end/route.ts`, `src/app/api/content/live/[id]/key/route.ts`, `src/app/api/content/live/[id]/comments/route.ts`;
  - create `tests/live-service.test.ts`, `tests/live-key.test.ts`, `tests/live-worker.test.ts`.
- **Depends on:** SOC-01, SOC-02, SOC-03.
- **Acceptance:**
  1. L0–L9 and L1b as in 3.2, with every VERIFY behind a small adapter in `client.ts`. Statuses map as in 5.4.
  2. The followers check comes before L1, L1b or L2. `start: "auto"` creates with `LIVE_NOW`, sets `autoStart`, and the worker moves the row to `live` without a Go live call.
  3. A second active live on the same Page gets 409 "You already have a live video set up on this Page." A fourth scheduled live is refused (5.7).
  4. Go live without `signalAt` gets 409 "Start your stream first."
  5. The key route meets 7.3, and a test proves the key is absent from every other response.
  6. End, cancel and failure wipe the key. The worker covers expiry, a disconnected Page and scheduled lives with no stream.
  7. Comments are cached 4 s per live.
  8. With `SPEND_TRIPWIRE=enforce`, every live call passes the tripwire (needs SOC-02).
  9. `LIVE_VIDEO=off` makes the routes answer 404.

#### SOC-09: Threads publisher, replies and remove

- **Files:**
  - create `src/lib/content/publishers/threads.ts`, `src/lib/threads/replies.ts`;
  - create `src/app/api/content/threads/[targetId]/replies/route.ts`, `src/app/api/content/threads/[targetId]/replies/[replyId]/route.ts`;
  - create `tests/content-publish-threads.test.ts`, `tests/threads-replies.test.ts`.
- **Depends on:** SOC-03, SOC-05.
- **Acceptance:**
  1. `publishThreadsTarget(...)` implements T7–T13: text, image, video and carousel. It waits 30 s, polls, and defers on quota.
  2. `removeThreadsPost` implements T14 with the delete quota.
  3. Replies: T15 list with `UntrustedText`-ready output, T16 hide and unhide, T17 reply with the reply quota. A missing permission returns "Edwyz can't {read | manage} replies. Connect Threads again and allow it."
  4. Every route checks `(targetId, tenantId, channel:'threads', status:'published')`.
  5. The 8.1 rows pass.

#### SOC-10: Publish pipeline, service and content routes

- **Files:**
  - change `src/lib/content/service.ts`, `src/lib/content/publish.ts`, `src/lib/content/publishers.ts` (now a barrel), `src/lib/content/limits.ts`;
  - change `src/app/api/content/posts/route.ts`, `src/app/api/content/posts/[id]/route.ts`, `src/app/api/content/targets/route.ts`;
  - create `src/app/api/content/posts/[id]/targets/[targetId]/remove/route.ts`, `src/app/api/content/posts/[id]/targets/[targetId]/retry/route.ts`, `src/app/api/content/quota/route.ts`;
  - change `tests/content.test.ts`, `tests/billing-content-limits.test.ts`;
  - create `tests/content-pipeline-v2.test.ts`.
- **Depends on:** SOC-04, SOC-06, SOC-07, SOC-09.
- **Acceptance:**
  1. The 3.7 request and response shapes. Old bodies still work, with formats from 2.1.
  2. Up to 20 media keys, `mediaAlt`, `link`, per-target `format`, `options` and `text`.
  3. `resolveTargets` accepts `ThreadsAccount` ids (`active` or `expiring`) and refuses `MetaAsset` rows of type `threads` (4.2). `listTargets` returns formats, `canPost`, reasons and quota. Instagram abilities come from the linked Page's `tasks` (5.1). `parsePostInput` lifts today's "at most one media file" rule to 20.
  3a. `publish.ts` builds `MediaFile` for each key (SOC-06 note) and reads `width`, `height` and `durationMs` through `mediaInfo()` (SOC-04).
  4. `attempt()` dispatches by channel and format through the barrel. The phase and heartbeat rules of 3.1 hold.
  5. A `SocialPostStat` row is written on publish (4.3). The permalink is saved.
  6. Remove and Retry behave as 2.4, with audit events.
  7. Plan limits are unchanged. Unverified members get 403 on every write.
  8. Existing content unit tests and `e2e/growth-content.spec.ts` API cases pass. The old Threads "not available" test is replaced.

#### SOC-11: Results server

- **Files:**
  - create `src/lib/social-insights/{catalog,facebook,instagram,threads,sync,service,best-time}.ts`;
  - replace the stub `src/lib/social-insights/worker.ts`;
  - create `src/app/api/content/results/summary/route.ts`, `src/app/api/content/results/posts/route.ts`, `src/app/api/content/results/posts/[statId]/route.ts`, `src/app/api/content/results/refresh/route.ts`;
  - change `tests/usage-scopes-alignment.test.ts` (step 1 of 5.1);
  - create `tests/social-insights-sync.test.ts`, `tests/social-results.test.ts`.
- **Depends on:** SOC-01, SOC-05, SOC-06. (critic) SOC-06 was added because R4–R6 use `getAssetUserAccess`, which SOC-06 adds. All three merge by wave 2.
- **Acceptance:**
  1. Every metric name lives only in `catalog.ts`.
  2. The jobs in 5.4 run with their caps and the 1 h rate-limit pause.
  3. An empty set is never stored as 0.
  4. Summary: tiles, change, views per day and freshness. Reached is hidden for All and Threads.
  5. Best posts and best time, which needs 10 posts.
  6. The `ANALYZE` task, missing permission and under-100-followers states.
  7. Refresh is throttled. Tenant isolation holds. `SOCIAL_RESULTS=off` gives 404.

#### SOC-12: Scopes, alignment test and App Review documents

- **Files:**
  - change `src/lib/meta-connect/scopes.ts`;
  - change `tests/usage-scopes-alignment.test.ts` (step 2 of 5.1). (critic) `tests/compat-scopes.test.ts` was removed from this list: it tests the public API keys' scopes (`contacts:read` …), not Meta permissions;
  - change `docs/meta-dashboard-requirements.md` (rows 62–64) and `docs/app-review/00-overview.md` (the Phase B line), which the alignment test reads;
  - change `docs/app-review/pages_manage_posts.md`, `docs/app-review/instagram_content_publish.md`, `docs/app-review/instagram_manage_insights.md`, `docs/app-review/pages_read_engagement.md`, `docs/app-review/pages_show_list.md`, `docs/app-review/status.md`;
  - create `docs/app-review/publish_video.md`, `docs/app-review/live_video_api.md`, `docs/app-review/read_insights.md`, `docs/app-review/instagram_basic.md`, `docs/app-review/threads_basic.md`, `docs/app-review/threads_content_publish.md`, `docs/app-review/threads_manage_insights.md`, `docs/app-review/threads_read_replies.md`, `docs/app-review/threads_manage_replies.md`, `docs/app-review/threads_delete.md`.
- **Depends on:** SOC-08, SOC-09, SOC-10, SOC-11.
- **Acceptance:**
  1. `META_CONNECT_SCOPES` and `SCOPE_PURPOSES` gain the 5.1 three, and the file's header comment no longer says there is no organic insights call. The alignment test matches 5.1 step 2: the `needs` map, the two removed tests, the `pages_manage_engagement`-only unused check, and the docs check passing against the rewritten rows. `scopeSummary` shows the three as missing on old tokens.
  2. Each App Review document carries its section 9 text verbatim (description, screencast, test calls, reviewer line) in the existing document layout.
  3. `status.md` marks each item as built, with its route, and as needing to be added to the draft.

#### SOC-13: Notices

- **Files:**
  - create `src/lib/notices/producers/social.ts`;
  - change `src/lib/notices/scan.ts`;
  - create `tests/notices-social.test.ts`.
- **Depends on:** SOC-05, SOC-08, SOC-10.
- **Acceptance:** each 5.8 kind is raised, deduplicated (one per post, account or live) and resolved when fixed. The producer makes no Meta call and respects `minRole`.

#### SOC-14: Composer v2

- **Files:**
  - change `src/components/content/Composer.tsx`, `src/components/content/ChannelPreview.tsx`, `src/components/content/calendar-helpers.ts`, `src/components/content/helpers.ts`;
  - create `src/components/content/FormatPicker.tsx`, `src/components/content/MediaTray.tsx`, `src/components/content/ChannelOptions.tsx`, `src/components/content/LimitMeter.tsx`;
  - change `tests/content-ui.test.ts`;
  - change `e2e/growth-content.spec.ts`;
  - create `e2e/content-formats.spec.ts`.
- **Depends on:** SOC-10, SOC-16 (the Threads chip's **Connect** reuses the popup `target` from SOC-16).
- **Acceptance:**
  1. Flow 2.3 with its exact copy, including the remembered account chips.
  2. Formats are chosen per 2.1, and disabled options carry their reasons.
  3. Media can be reordered by keyboard. Alt text and the Reel cover work.
  4. The Threads chip and quota meters show, and the meter's total is the API's `total`.
  5. (critic) **Make a JPEG copy** and **Crop to fit** work in the browser (canvas, then the existing `POST /api/content/media`), swap the new key into the post and can be undone. They are tested in `tests/content-ui.test.ts` with a stubbed canvas.
  6. No overflow at 360 px. axe shows nothing serious. A dark screenshot is taken.
  7. The `growth-content` scenarios still pass, with copy updated only where it changed. The step that seeded a `MetaAsset` of type `threads` now seeds a `ThreadsAccount` and expects a usable Threads chip.

#### SOC-15: Post details, content page and Threads replies UI

- **Files:**
  - change `src/components/content/ContentView.tsx`;
  - create `src/components/content/PostDetail.tsx`, `src/components/content/ThreadsReplies.tsx`, `src/components/content/PostNumbers.tsx`;
  - change `src/components/ui/status.ts`, `tests/ui-system.test.ts`;
  - create `tests/content-details-ui.test.ts`, `e2e/content-details.spec.ts`.
- **Depends on:** SOC-14, SOC-09, SOC-11 (`PostNumbers` reads `GET /api/content/results/posts/[statId]`).
- **Acceptance:**
  1. 2.4 and 2.7 with their exact copy: the unclear-outcome confirm, the Instagram and Story remove copy, and the replies as plain text.
  2. Header buttons Go live and Results, with Go live for admins only.
  3. The `removed` status pill.
  4. The e2e scenarios of 8.4.

#### SOC-16: Threads card in Connections

- **Files:**
  - create `src/components/meta-connect/ThreadsCard.tsx`;
  - change `src/components/meta-connect/ConnectionsPanel.tsx` (mounts the card) and `src/components/meta-connect/useFacebookLoginPopup.ts` (the optional `target` of 6.2: `startPath`, `isAllowedUrl`, the popup names and the window name, with today's Facebook values as the default; add `isThreadsAuthorizeUrl` and the `THREADS_POPUP` constants);
  - create `tests/threads-card-ui.test.ts`, `e2e/threads-connect.spec.ts`.
- **Depends on:** SOC-05.
- **Acceptance:**
  1. Every 2.2 Threads state, with the popup and its redirect fallback.
  2. Agents see "Ask an admin".
  3. The card is hidden when `THREADS` is off.
  4. The Facebook connect popup behaves as before. `tests/eddy-guides.test.ts` (which imports the hook) stays green, and so does `tests/meta-connect-popup.test.ts` once IG-PAGE-ADS PRM-07 has created it. With no `target`, `launchFacebookLogin` still refuses any URL that is not a Facebook dialog. With the Threads target it refuses a `facebook.com` URL, and a Threads outcome message never ends a Facebook attempt.

#### SOC-17: Live UI

- **Files:**
  - create `src/app/(app)/app/content/live/page.tsx`, `src/app/(app)/app/content/live/new/page.tsx`, `src/app/(app)/app/content/live/[id]/page.tsx`;
  - create `src/components/live/{LiveList,LiveSetup,StreamKeyCard,ControlRoom,LiveComments,LiveStats}.tsx`;
  - create `tests/live-ui.test.ts`, `e2e/content-live.spec.ts`.
- **Depends on:** SOC-08.
- **Acceptance:**
  1. 2.5 with its exact copy.
  2. The key is fetched only on Show or Copy, hidden after 60 s or when the tab is hidden, and never shown to agents.
  3. Polling every 5 s, paused while the tab is hidden.
  4. The comments live region is throttled. The pulse respects reduced motion.
  5. The 8.4 e2e scenarios pass.

#### SOC-18: Results UI and navigation

- **Files:**
  - create `src/app/(app)/app/content/results/page.tsx`;
  - create `src/components/results/{ResultsView,AccountChips,PeriodChips,DailyBars,BestPosts,BestTime,Freshness}.tsx`;
  - change `src/components/app/nav.ts`, `tests/auth-nav.test.ts`;
  - create `tests/results-ui.test.ts`, `e2e/content-results.spec.ts`.
- **Depends on:** SOC-11.
- **Acceptance:**
  1. 2.6 with its exact copy and every state in 6.3.
  2. The bars have a table alternative.
  3. The nav item is placed as in 6.1, and the nav counts are updated.
  4. The 8.4 e2e scenarios pass at 360 px in both themes.

#### SOC-19: Eddy actions

- **Files:**
  - create `src/lib/actions/defs/social.ts`;
  - change `src/lib/actions/defs/index.ts`, `src/lib/actions/not-exposed.ts`;
  - change `src/lib/eddy/copy/defs.ts`, `src/lib/eddy/copy/en.ts`, `src/lib/eddy/copy/hi.ts`, `src/lib/eddy/copy/hinglish.ts`;
  - create `tests/actions-defs-social.test.ts`;
  - create `evals/eddy/cases.social.en.jsonl`, `evals/eddy/cases.social.hi.jsonl`, `evals/eddy/cases.social.hinglish.jsonl`.
- **Depends on:** SOC-08, SOC-09, SOC-10, SOC-11.
- **Acceptance:**
  1. The 17 definitions match 5.6: roles, risk, routes, effects and untrusted paths.
  2. Cards show the per-channel text verbatim, the warnings and the 2.9 copy in three languages.
  3. No definition can return the key, and `get` and `list` results are scanned for it.
  4. `not-exposed.ts` replaces the `/api/content/**` `v2` wildcard with exact entries (5.6). Route coverage, role parity, risk and untrusted tests pass, and the toolset counts are updated.
  5. (critic) Corrected: `src/lib/actions/defs/content.ts` does not exist today, so there is nothing to annotate. The registry's duplicate-name invariant (`tests/actions-invariants.test.ts`) fails if EDDY-V2-02 later defines `publish_post` again. All 17 definitions are `version: "v1"`: none spends from a pot (`registry.ts` refuses only spending in v1), so Eddy offers them in today's `EDDY_PHASE=1`. External Meta writes already exist in v1, for example template submit and delete.
  6. At least 20 eval cases per language, including the five in 5.6.

#### SOC-20: Verification runbook and live check with the review user

- **Files:**
  - create `docs/social-verification-runbook.md`, `scripts/social-verify.ts`, `tests/social-verify-script.test.ts`;
  - change `src/lib/social-insights/catalog.ts`, `src/lib/content/errors.ts`, `src/lib/live/client.ts` and `src/lib/social/flags.ts` only as the VERIFY results require.
- **Depends on:** SOC-12, SOC-13, SOC-14, SOC-15, SOC-16, SOC-17, SOC-18, SOC-19, and owner inputs 11.1 items 1 to 6.
- **Acceptance:**
  1. Every 8.5 row is run with the review assets and recorded as passed or failed, with the date.
  2. Each failure is either fixed in the listed files or its option is switched off by flag, with the reason in the runbook.
  3. The script refuses to run without `SOCIAL_VERIFY=1` and refuses to touch any asset not on its allowlist (the test Page, Instagram and Threads ids from env).
  4. The screencasts of section 9 are recorded and the API test calls are visible as completed in the App Dashboard.

---

## 11. Decisions taken

The owner delegated these. Each can be changed later.

| # | Decision | Why |
|---|---|---|
| D1 | **Edwyz's worker does all post scheduling.** It never uses Meta's `scheduled_publish_time` for posts. Live video is the exception, because Meta schedules it. | One calendar, one approval flow and one missed-window rule for every channel. Instagram and Threads have no native scheduling in the API anyway. |
| D2 | **Threads accounts get their own `ThreadsAccount` table.** They are not stored as `MetaConnection` or `MetaAsset` rows. | Threads has its own OAuth, host, token lifetime and refresh. Putting it in `MetaConnection` would touch about 30 queries in the ads, spend and erasure code (the health worker would call Facebook's `debug_token` on a Threads token and mark it expired). |
| D3 | **Threads uses the same Meta app when the dashboard allows it.** Otherwise it gets a separate Threads-only app. | The code only needs `THREADS_APP_ID` and `THREADS_APP_SECRET`. V-S1 decides. |
| D4 | **Upload paths:** Facebook videos, Reels and Stories, and Instagram videos, use authenticated binary uploads (resumable and rupload). Instagram photos and all Threads media use signed URLs, with a robots rule for Meta's fetchers. | No long-lived public URLs for big files, and fewer fetch failures. Threads offers only URLs. |
| D5 | **One text, with an optional per-channel override.** The override is offered only when the text is too long, or when the owner asks. | Simple by default, and still fits Threads' 500 characters. |
| D6 | **Formats offered:** Facebook post (text, link, photo, album up to 10, video), Reel and Story. Instagram post (photo, carousel up to 20), Reel and Story. Threads text, link, photo, video and carousel. **Not offered (later):** Instagram collaborators, tags, location, trial Reels and product tags. Facebook targeting, backdating and places. Threads polls, ghost posts, spoilers, GIFs, quotes, geo-gating and sharing to Instagram. | These cover what small businesses post. Each extra is another permission or another screen. |
| D7 | **Media limits:** JPEG or PNG photos up to 8 MB (Instagram needs JPEG and the composer says so). MP4 or MOV videos up to `CONTENT_MAX_VIDEO_MB` (default 100, at most 300). Up to 20 files per post. The quota stays 500 MB. | The VPS disk is at 92% (ads spec D21). Raise the limit after the cleanup. |
| D8 | **Remove** is offered for Facebook posts and Threads posts. (critic) For Instagram, v1 gives an "Open on Instagram" link. Meta's reference now documents a media delete under `instagram_manage_contents`, but its method is inconsistent and the permission has no reference page (V-I11). Edwyz keeps the post in the calendar, marked Removed. | Meta's APIs, and no unconfirmed permission in the review draft. The calendar stays a true record. When V-I11 passes, "Remove from Instagram" is one call (`DELETE /{ig-media-id}`, user token) behind `IG_REMOVE`, plus one review item. |
| D9 | **Live:** Page only, one active live per Page, at most 3 scheduled per workspace. "Now" goes through an unpublished draft and an explicit **Go live** by default. (critic) Owners who stream from the same phone can pick "As soon as my stream starts" (L1b, `LIVE_NOW`), behind a confirm that says it goes public by itself. Comments are read only, polled every 5 s and never stored. Replying to comments waits for the comment-moderation spec. Nothing streams from the browser. | The owner explicitly controls going public. This keeps permissions minimal and protects privacy. |
| D10 | **The stream key is a secret.** It is sealed, admin only, fetched on tap, audited, wiped at the end, and never given to Eddy. | Anyone with the key can broadcast on the Page. |
| D11 | **Results show organic numbers only.** Four tiles, views per day, best posts and best time. No demographics in v1. Numbers are kept 400 days. | Small owners need a few clear numbers. Demographics need 100 or more followers and add privacy questions. |
| D12 | **Every metric name lives in one catalog** (`catalog.ts`), checked by the runbook before each release. | Meta deprecates Page metrics often (2025-06-15, 2025-11-15, by 2026-06-15). |
| D13 | **Story numbers are fetched 21 h after publishing.** Instagram webhooks are not used. | Stories keep insights for 24 h, and webhooks need extra setup and Advanced Access. |
| D14 | **`publish_post` and 16 other actions live in `defs/social.ts`.** EDDY-V2-02 does not define `publish_post`. | One owner per tool name. These flows are new here. |
| D15 | **One new nav item, "Social results", under Insights.** Live is reached from Content calendar. | Results are a destination. Live is a task started from content. |
| D16 | **No new webhooks in v1.** Live status, Story numbers and Threads replies are polled. | Avoids changing the shared Page subscription and the extra review the Threads webhooks need. |
| D17 | **Pages in English. Eddy cards in en, hi and hinglish.** | Same rule as the ads spec's D23 until a native-speaker review. |
| D18 | **Live videos do not count against the monthly post limit.** Threads accounts count as channels. | Live is rare and costs Edwyz nothing at Meta. The channel limit already counts any connected account that gets a post. |
| D19 | **Feature flags `CONTENT_V2`, `LIVE_VIDEO`, `SOCIAL_RESULTS` and `THREADS` default to on.** Threads switches off by itself without its credentials. An option whose VERIFY row fails is switched off in code until fixed. | Before Advanced Access, only users with an app role can use these anyway. The reviewer must see them. |
| D20 | **`pages_read_user_content` is not requested here.** Commenter names on Live show when Meta returns them, and "Someone" otherwise. | Keeps this spec's review list to what its features need. The comment-moderation spec owns that permission. |
| D21 | **Instagram uses the Facebook Login family** (`instagram_basic`, `instagram_content_publish`, `instagram_manage_insights` on `graph.facebook.com`), not Instagram Login. | It matches the existing Meta Connect, Page tokens and the ads spec. Resumable video upload (`upload_type=resumable`) is "Only for apps that have implemented Facebook Login for Business", which Edwyz has. |
| D22 | (critic) **Media problems are fixed with one tap in the browser**: **Make a JPEG copy** for a PNG on Instagram, and **Crop to fit** for a photo whose shape Instagram refuses. There is no server-side image processing. | The owner should not need another app to post. The VPS has no image library (ads spec D21). |
| D23 | (critic) **The Instagram meter and wait use Meta's `quota_total`**, never a hard-coded 100. | Meta's own pages disagree (100 versus 50). |
| D24 | (critic) **The social Eddy actions are v1** (5.6). | None spends money, and v2 tools stay hidden until `EDDY_PHASE=2`. |
| D25 | (critic) **Instagram insights use the connection's user token** (R4–R6), as both insights references name it. Publishing keeps the Page token. | Follows the docs. V-R6 records whether the Page token also works. |

### 11.1 Inputs needed from the owner

1. **Meta App Dashboard, Facebook side.**
   - Add `pages_manage_posts`, `publish_video` and `read_insights` to the app's Page use case.
   - Add `instagram_basic`, `instagram_content_publish` and `instagram_manage_insights` to the Instagram (Facebook Login) use case.
   - Edit the Login for Business configuration "Edwyz Connect Pages IG Ads" to include them, and trim the extras that `status.md` lists.
   - Request the **Live Video API** feature.
   - Reconnect the review workspace.
2. **Threads use case.**
   - Add "Access the Threads API" to the app, or create a Threads-only app if V-S1 says so.
   - Add the permissions `threads_basic`, `threads_content_publish`, `threads_manage_insights`, `threads_read_replies`, `threads_manage_replies` and `threads_delete`.
   - In the Threads use case Settings, set:
     - Redirect URI: `https://wa.edwyz.com/api/meta-connect/threads/callback`;
     - Deauthorize callback: `https://wa.edwyz.com/api/meta/threads/deauthorize`;
     - Data deletion URL: `https://wa.edwyz.com/api/meta/threads/data-deletion`.
   - Put the **Threads app ID** and **Threads app secret** into the server environment as `THREADS_APP_ID` and `THREADS_APP_SECRET`.
3. **Test assets.**
   - A test Facebook Page with **at least 100 followers**, managed by a Facebook account **at least 60 days old**. Meta requires both for live video from apps. Live cannot be demonstrated without them.
   - Its linked Instagram professional account, with Page Publishing Authorization completed if Facebook asks for it.
   - A Threads profile added under App roles as a **Threads Tester**, with the invitation accepted in Threads (Settings > Account > Website permissions).
   - A second Facebook account and a second Threads account to comment and reply in the screencasts.
4. **The review login.** Replace the `[OWNER: REVIEW EMAIL]` and `[OWNER: REVIEW PASSWORD]` placeholders. The user must have no two-step verification.
5. **OBS Studio** installed on the computer used for the screencasts. Optionally, Larix Broadcaster on a phone.
6. **Add the items to the App Review draft** (submission 1799953447868194): `pages_manage_posts`, `publish_video`, `read_insights`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `threads_manage_insights`, `threads_read_replies`, `threads_manage_replies` and `threads_delete`, next to the existing `threads_basic`, `threads_content_publish` and Live Video API items. Paste the section 9 texts, upload the screencasts and tick "I agree" on each.
7. **VPS disk cleanup.** Needed before raising `CONTENT_MAX_VIDEO_MB` above 100 (the ads spec's D21 shows the disk at 92%).
8. **Legal review** of the privacy policy additions in 7.7 (Threads, organic results, Live), and of the confirmation that Edwyz stores no comment or reply text.
9. (critic) **Optional, after V-I11.** If the Instagram use case in the App Dashboard offers `instagram_manage_contents`, decide whether to add "Remove from Instagram" (D8). That means adding the permission to the use case, the Login for Business configuration and the review draft. Edwyz then ships it behind `IG_REMOVE` with its own section 9 package. Doing nothing keeps "Open on Instagram".

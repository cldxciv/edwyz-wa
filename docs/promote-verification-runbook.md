# Instagram and Facebook Page ads: sandbox verification runbook (V-P0 to V-P18)

This runbook proves, against Meta itself, the Graph shapes that `docs/IG-PAGE-ADS-SPEC.md` takes from documentation or memory
(spec 9.6, 11.2 risk 2). Every catalog row starts at `docs` in `src/lib/promote/catalog/verified.ts`. A row moves to `sandbox`
only when every runbook step it depends on has passed here, and to `live` only after the owner-present check (V-P17). Rows at
`docs` stay hidden outside sandbox ad accounts (D22), so a goal whose step fails stays out of `PROMOTE_GOALS`.

**Owner decisions that bind this runbook:**

- 11.1a decision 6: the runbook waits for the owner's test assets, and Start (train P3) stays off in production until V-P0 to
  V-P7 pass. Nothing is activated with real money unless the owner is present.
- Phase 0 12.1a decision 5: real money is spent only with the owner present. V-P17 is the only step that spends, and it never
  runs through the script.

Related documents: `deploy/README-deploy.md` section D (the trains and their gates), `docs/spend-verification-runbook.md`
(Phase 0's own runbook, which shares the sandbox), `docs/app-review/00-overview.md` (the screencasts reuse these test assets).

## 1. Before you start

What the owner provides (spec 8.1 item 5, 11.1 question 11):

| Asset | Requirement | How it reaches Edwyz |
|---|---|---|
| Meta sandbox ad account | Created in the app dashboard (Marketing API > Tools > Sandbox ad account). One per app; Phase 0 uses the same one. | Connect it in a test workspace (Settings > Connections), then mark it: `UPDATE "MetaAsset" SET sandbox = true WHERE id = '<asset id>' AND type = 'ad_account';` |
| Test Facebook Page | The connecting person has the ADVERTISE task; Lead Ads terms accepted on the Page | Connected in the same workspace |
| Instagram professional account | Linked to the test Page, with a profile picture and at least one reel | Connected in the same workspace |
| Test WhatsApp number | Linked to the test Page (for V-P1 and V-P12); for the V-P12 addendum, a second number in the same business portfolio that is not linked | The linked one in international digits (`--whatsapp-number`), the unlinked one with `--unlinked-whatsapp-number` |
| A short public MP4 | Any https URL Meta can fetch (for V-P6 video) | `--video-url` |

Run from a checkout of the release under test, on a machine whose `DATABASE_URL` holds that test workspace (staging, or a
developer database with the sandbox connected). Never on a customer workspace: the script refuses any ad account that is not
marked `sandbox`.

Find the ids once:

```sql
SELECT a.id, a.type, a."externalId", a.name, a.sandbox, a."tenantId" FROM "MetaAsset" a
WHERE a."tenantId" = '<test workspace id>' AND a.type IN ('ad_account','page','instagram') AND a.status = 'active';
```

Build the script once per release (the same esbuild pattern as `scripts/spend-sim.ts`):

```sh
npx esbuild scripts/promote-verify-catalog.ts --bundle --platform=node --format=esm --packages=external \
  --outfile=node_modules/.cache/edwyz-verify/promote-verify.mjs
export V="node --env-file=.env node_modules/.cache/edwyz-verify/promote-verify.mjs \
  --tenant <tenantId> --account <ad account asset id> --page <Page asset id> --instagram <Instagram asset id> \
  --whatsapp-number <linked digits> --unlinked-whatsapp-number <unlinked digits> --video-url <https url> --operator '<your name>'"
```

A flag given twice counts once, with its last value, so `$V --steps V-P12 --whatsapp-number <other>` overrides `$V`'s own.

`GRAPH_BASE_URL` must be unset for a sandbox run (the script refuses it). `SPEND_DRY_RUN` and `SPEND_SIM` do not matter to
the script's own writes: they go through Phase 0's ads client with an empty environment, so they always reach the sandbox.

### 1.1 Rehearse first, with the fake

`--dry-run` runs every step against the in-process fake Meta (`tests/helpers/fake-meta-promote.ts`) with the fake's ids, so
the commands and the report can be rehearsed with no Meta call. It still checks the account is marked `sandbox` and still
takes the sandbox lock. A dry run writes nothing to the Spend Book: its Book reads the database (so a stopped workspace still
refuses) and holds every write in memory, so Phase 0's ledger and breaker checks on the sandbox workspace never see it. It
writes only to paths you name, and refuses any path inside a project or repository checkout (any folder at or above it that
holds `package.json` or `.git`, whatever the working directory or letter case), so use a temporary folder. The `verified.ts`
it writes starts with a `PRM-VERIFY DRY RUN` line; a sandbox run refuses a file that carries it, and a unit test fails if the
committed `verified.ts` does:

```sh
$V --dry-run --write --verified-path /tmp/verified.ts --fixtures-dir /tmp/prm-fixtures --report '/tmp/prm-report-{runId}.json'
```

The fake cannot read creatives or effective placements back, so V-P0, V-P2, V-P3, V-P9, V-P13, V-P14 and V-P15 fail in a
dry run. That is expected; only a sandbox run counts. `tests/promote-verify-script.test.ts` runs the same dry run in CI.

### 1.2 Sharing the sandbox with Phase 0

Meta gives one sandbox ad account per app, and Phase 0's runbook uses it too (Phase 0 risk 19). The two never run at the
same time, and neither do two promote runs. The script refuses to start when:

- PlatformSetting `sandbox:runbook-lock` is held by anyone else and has not expired. Each run takes it under its own name,
  `promote:<run id>:<nonce>@<host>` (2 hours), and gives back only that: a second promote run started at the same time is
  refused with the first one's name, and can never release the first one's lock. Phase 0's operator takes it the same way
  before working on the sandbox:
  ```sql
  INSERT INTO "PlatformSetting" (key, value, "updatedAt") VALUES ('sandbox:runbook-lock',
    jsonb_build_object('holder','phase0','startedAt',now(),'expiresAt',now() + interval '4 hours'), now())
  ON CONFLICT (key) DO NOTHING;            -- 0 rows: someone holds it; wait
  DELETE FROM "PlatformSetting" WHERE key = 'sandbox:runbook-lock' AND value->>'holder' = 'phase0';   -- when done
  ```
  Phase 0's own tooling (`scripts/spend-sim.ts`, `docs/spend-verification-runbook.md`) does not take this lock yet: that
  hand-off is with the Phase 0 owner. Until it lands, take the lock by hand as above before any Phase 0 work on the sandbox.
- `SPEND_SIM=1` is set in this shell (Phase 0's synthetic spend series is on).
- In any workspace that has the same sandbox ad account connected (Phase 0's own workspace included), in the last 2 hours:
  Phase 0's simulated spend rows (`SpendDaily.source = 'sim'`), or Spend Book rows about the sandbox
  (`SpendLedger.sandbox = true`) from any actor other than this script (`system` / `promote-verify-catalog`), such as Phase
  0's V-step creates and activations.

Every object the script makes is named `PRM-VERIFY <run id> <label>`, so Phase 0's fake spend series and its breaker exit
check can tell them apart, and anyone can find them in Ads Manager.

### 1.3 What the script does and never does

- Campaigns, ad sets and ads are created PAUSED through Phase 0's ads client, one `permitForPausedCreate` permit each (the
  transport tripwire sees a permitted `ads_create`), read back at once (status must be PAUSED), and archived at the end of
  the step through `recordLowering` (a ledgered lowering).
- Creatives carry no status (erratum 12.1b) and are deleted; audiences and videos are deleted.
- Lead forms belong to the Page: they are archived with the Page token, under the Spend Book's lead-form lowering, and never
  through an ad-level ledger row. Phase 0's Book has no lead-form lowering yet (hand-off to the Phase 0 owner), so for now
  the script keeps its forms, named `PRM-VERIFY`, and the report lists them under "Kept". A form cannot spend; archive them
  by hand in Meta Business Suite > Instant forms if the list gets long.
- Pixels, uploaded images and the Page-backed Instagram identity cannot be deleted through the API. They stay, named
  `PRM-VERIFY`, and the report lists them under "Kept".
- Every request is classified first (`src/lib/spend/classify.ts`). Only reads, PAUSED creates, archives and not-spend writes
  are sent; an activation, a budget raise, Meta's spending limit or a WhatsApp message is refused before it leaves the
  process. Nothing is ever set ACTIVE.
- Anything a step could not archive is printed as "Not archived (archive these by hand in Ads Manager)" and the script exits
  with code 2. Archive those by hand before the next run.

## 2. The steps

Run one step with `$V --steps V-P0`, several with `--steps V-P0,V-P1,V-P1+`, or all automated steps with no `--steps`.
Add `--write` to record. A step **passes** when every one of its checks passed; a catalog row moves when the checks that name
it passed in every step it needs (`rowRefs` in the script: goal, placement and question rows use the catalog's own
`verifyRefs`).

| Step | What it verifies | Command | Pass criteria | Recorded in | Gates |
|---|---|---|---|---|---|
| **V-P0** | `act_X/adcreatives` accepts a body without `status`; the whole PAUSED chain (campaign, ad set, ad using the creative) reads back PAUSED | `$V --steps V-P0 --write` | Creative created and read back; the ad reads back PAUSED. The response to `status: 'PAUSED'` on a creative is not sent by the script (the ads client refuses that body, which is P0-1); to record Meta's own answer, send it once by hand with Phase 0's `p` helper: `p "$ACT/adcreatives" -d name='PRM-VERIFY status probe' -d status=PAUSED ...` | Report and fixture `V-P0.<run id>.json`; `verified.ts` `VERIFIED_RUNBOOK_STEPS`; results table below | P0-1, `shape.single_image` (with V-P6), train P3 |
| **V-P1** | Each goal's campaign and ad set pairing (objective, optimization, destination, promoted object) on v26, and `special_ad_category_country` | `$V --steps V-P1 --write` | For each goal: both objects created PAUSED and read back with the objective, optimization goal and destination sent. A goal whose promoted object is missing (no WhatsApp number, no pixel) is skipped, not passed | `V-P1.<run id>.json`; each `goal.<key>` row it passes; results table | Every goal; P3 |
| **V-P1 addendum** (`V-P1+`) | A daily-budget ad set of 24 hours or less is refused, and the exact error, for the D31 copy | `$V --steps V-P1+ --write` | Meta refuses the 23-hour ad set; the code, subcode and message are in the report. Copy them into `docs/IG-PAGE-ADS-SPEC.md` 4.10 if they differ | `V-P1+.<run id>.json`; results table; the D31 note in MIGRATIONS-APPLIED at the P3 flip | D31; P3 |
| **V-P2** | The Instagram media boost creative (`object_id`, `instagram_user_id`, `source_instagram_media_id`), the Facebook promotable post boost, `is_instagram_eligible`; whether Creator accounts work | `$V --steps V-P2 --write` | Both creatives created and read back; `is_instagram_eligible` is a boolean. Creator accounts: repeat with a Creator test account by hand and note the answer | `V-P2.<run id>.json`; `shape.ig_media_boost`, `shape.fb_post_boost`; results table | Boost; P3 |
| **V-P3** | A WhatsApp, website, form, Page-like or profile button on boosted posts | `$V --steps V-P3 --write` | For each boost goal other than engagement: the creative with the goal's first button type is created and read back | `V-P3.<run id>.json`; `boost_cta.<goal>` rows (and the goal rows that list V-P3); results table | Boost goals other than engagement; P3 |
| **V-P4** | The Click-to-Instagram button name (`INSTAGRAM_MESSAGE` or `MESSAGE_PAGE`), the `INSTAGRAM_PROFILE` destination, `ice_breakers` in `page_welcome_message`, the Messenger button | `$V --steps V-P4 --write` | One of the two Instagram buttons is accepted (the report says which); the profile ad set reads back with its destination; the ice-breaker creative is accepted | `V-P4.<run id>.json`; `boost_cta.instagram_dms`, `feature.ice_breakers`, goal rows that list V-P4; results table | `instagram_dms`, `profile_visits`, quick questions; P3 |
| **V-P5** | `act_X/generatepreviews` for every `ad_format` Edwyz uses, on an unsaved spec; the iframe host | `$V --steps V-P5 --write` | Every format answers with an iframe whose host is `facebook.com` or a subdomain of it. Record the exact host in `src/lib/promote/previews.ts` if it differs (8.1 item 8) | `V-P5.<run id>.json`; `feature.previews`; results table | Meta previews; P3 |
| **V-P6** | `adimages` with base64 bytes; a two-card carousel; `advideos` with `file_url`, processing to ready, and thumbnails | `$V --steps V-P6 --write` | The image answers with a hash; the carousel creative reads back; the video reaches `ready` within 2 minutes and has thumbnails. A signed URL as `file_url`: try once by hand and note it | `V-P6.<run id>.json`; `shape.single_image` (with V-P0), `shape.carousel`, `shape.single_video`; results table | Images, video; P3 |
| **V-P7** | `leadgen_forms` create with every question type; `test_leads`; the lead fields `platform`, `is_organic` and `adset_id` | `$V --steps V-P7 --write`, then watch Leads > All leads | Both forms created and read back; the test lead is read with its fields (the report says which fields came back). By hand: the `leadgen` webhook delivers it to the Leads hub of the test workspace, tagged Test, with no WhatsApp message | `V-P7.<run id>.json`; every `question.<TYPE>` row; results table (note whether the webhook arrived) | Lead forms; P3 |
| **V-P7 addendum** (`V-P7+`) | The `test_leads` answer shape (does it return the lead id?); the consent checkbox as optional and not pre-ticked (`custom_disclaimer`); the CAPI fields for conversion leads | `$V --steps V-P7,V-P7+ --write` | The answer is recorded; the form with the optional, unticked box is created and read back. CAPI fields (`event_source`, `lead_event_source`): check Meta's current Conversions API for CRM docs by hand and note them | `V-P7+.<run id>.json`; results table | D33, D35, 3.11; P3 |
| **V-P8** | `customaudiences`: a customer list with one `users` session (100 hashed test emails), a lookalike, and every engagement and website rule | `$V --steps V-P8 --write` | Every audience is created and read back; the session answers `num_received`. All are deleted at the end | `V-P8.<run id>.json`; every `audience_event.<id>` row; results table | Audiences; P4 |
| **V-P9** | The `creative_features_spec` feature names on v26 | `$V --steps V-P9 --write` | Every feature in `OPTED_OUT_FEATURES` reads back as `OPT_OUT`. A missing name is listed: remove or rename it in `src/lib/promote/creative-shapes.ts` | `V-P9.<run id>.json`; `feature.enhancements`; results table | The enhancements block |
| **V-P10** | `reachestimate`; `adgeolocation` PIN code search for India; the `minimum_budgets` shape | `$V --steps V-P10 --write` | A size, a `zip` result for 411001, and `min_daily_budget_*` fields | `V-P10.<run id>.json`; results table | Sizes, PIN codes, defaults |
| **V-P11** | `act_X/connected_instagram_accounts` (or `instagram_accounts`) and what makes an Instagram account usable | `$V --steps V-P11 --write` | One edge answers and lists the test Instagram account | `V-P11.<run id>.json`; results table; then the readiness row stops being a warning | Readiness row |
| **V-P12** | The Page's `whatsapp_number` field | `$V --steps V-P12 --write` (needs `--whatsapp-number`, the number linked to the Page) | Read with the Page token, the field comes back and its digits equal `--whatsapp-number`. Graph leaves out a field that is not set, so a missing field fails, and without `--whatsapp-number` the step is skipped | `V-P12.<run id>.json`; results table | CTWA readiness |
| **V-P12 addendum** (`V-P12+`) | Whether a WhatsApp number in the same business portfolio works as `promoted_object.whatsapp_phone_number` without being linked to the Page | `$V --steps V-P12+ --write` (needs `--unlinked-whatsapp-number`) | The Click-to-WhatsApp ad set with the unlinked number is accepted. If it is, `link_whatsapp_to_page` is not needed for that case. Skipped when the number turns out to be linked | `V-P12+.<run id>.json`; results table | Removes `link_whatsapp_to_page` for that case |
| **V-P13** | `page_backed_instagram_accounts` create, and its use in a creative | `$V --steps V-P13 --write` | The identity is created (or the existing one returned) and a creative using it reads back | `V-P13.<run id>.json`; `feature.page_backed_instagram`; results table | Instagram identity fix |
| **V-P14** | Effective placements read back: `messenger_home`, explore, Messenger story dropped, `threads_stream`, every position in the catalog | `$V --steps V-P14 --write` | For each placement row, the ad set reads back with that position kept in `targeting` (its required companions are sent with it). A dropped position fails its row and the report shows what Meta kept | `V-P14.<run id>.json`; each `placement.<key>` row; results table | Placements |
| **V-P15** | `asset_feed_spec` placement customization: a square image for feeds and a 9:16 one for stories and reels | `$V --steps V-P15 --write` | The creative is created and reads back with its customization rules | `V-P15.<run id>.json`; `shape.placement_assets`; results table | The tall version |
| **V-P16** | The URL templates in `src/lib/meta-connect/meta-screens.ts` open the right screen | Manual (2.1 below), then `$V --steps V-P16 --attest V-P16 --write` | Each of the 10 links lands on the named screen for the test assets | Results table; the run report's attested step | Opens Meta |
| **V-P17** | **Owner-present live check** on one real INR account (2.2 below) | Manual, owner present, never the script. Afterwards `$V --steps V-P1,V-P4,V-P17 --attest V-P17 --write` on the sandbox | The 2.2 list is recorded | Results table; the owner's log in the P5 release notes; the attested step | Review mapping beyond docs, placement names, the free-entry-point fact. Nothing in P3 depends on it |
| **V-P18** | `POST act_X/adspixels` creates a pixel with the connecting person's role, and `code` returns the snippet | `$V --steps V-P18 --write` | The pixel is created and its code contains `fbq(`. If Meta refuses the create for that role, `events_manager_pixel` comes back to `meta-screens.ts` | `V-P18.<run id>.json`; results table | `create_pixel`; the return of `events_manager_pixel` if it fails |

### 2.1 V-P16: the Opens Meta links (a person, about 15 minutes)

Signed in to Meta as the person who connected the test assets, open each link the app builds for the test workspace (each
readiness row and card shows it; the templates are in `meta-screens.ts`) and confirm the screen: `payment_method`,
`business_verification`, `leadgen_tos`, `custom_audience_tos`, `link_whatsapp_to_page`, `link_instagram_to_page`,
`page_advertise_task`, `lead_access_manager`, `appeal_ad`, `account_quality`. A wrong landing is fixed in `meta-screens.ts`
with its test, then checked again. Record each key's result in the table below, then attest the step.

### 2.2 V-P17: the owner-present live check (real money, about ₹200)

Only with the owner present (Phase 0 12.1a decision 5, 11.1 question 10), on the one real INR ad account the owner chooses,
with the owner's daily ads limit set to cover ₹100 a day. Use the product itself (Settings > Spending limits must be set; the
Spend Book and the tripwire are in force): Boost a reel with WhatsApp chats for 2 days at ₹100 a day, then a lead form ad for
2 days at ₹100 a day. Pause both at the end of day 2 if Meta has not ended them.

Record, with screenshots where useful: the ad review states and the `ad_review_feedback` samples Meta sends; the effective
placements after delivery; the Facebook `platform_position` values in the placement breakdown; whether the
`onsite_conversion.messaging_conversation_started_7d` action appears; a real Instagram lead's `platform` and `is_organic`; and
the CTWA free-entry-point pricing shown on the delivery status. Until V-P17 passes, those screens show Meta's raw keys or
leave them out (spec 9.6), and `goal.profile_visits` stays at `docs`.

## 3. Where results are recorded

Each sandbox run with `--write` records, in files of its own (a later run, even a partial one such as V-P1 without
`--whatsapp-number`, never replaces an earlier run's evidence):

1. **The run report**: `tests/fixtures/promote-verified/run-report-<run id>.json` (every step and check, its evidence, the
   lock it held, what was kept and anything not archived). Commit it with the release; the P3 and P4 gates name it.
2. **Pinned fixtures**: `tests/fixtures/promote-verified/<step>.<run id>.json`, one per step and run, holding only the checks
   that passed and their requests and answers (no token, no secret). These become the fake's evidence for the shapes (spec
   9.6).
3. **`src/lib/promote/catalog/verified.ts`**, regenerated: the rows whose steps passed move from `docs` to `sandbox` (never
   down, never to `live`), `VERIFIED_RUNBOOK_STEPS` lists the steps that have passed in any run, and `VERIFIED_GENERATED_AT`
   is stamped. Do not edit it by hand; review the diff and commit it.
4. **The results table below**: date, operator, run id, outcome and notes per step.
5. **`/var/www/edwyz-wa/MIGRATIONS-APPLIED`** on the production server, at the flag flip a step gates (P3: V-P0 to V-P7 and
   the V-P1 addendum; P4: V-P8), with the run id and the commit that carries the regenerated `verified.ts`
   (`deploy/README-deploy.md` D.3).

A failed step changes nothing in `verified.ts` for its rows. Fix the cause (usually a field name in the builders or the
catalog, with its test), then run the step again.

## 4. Results

| Step | Date | Operator | Run id | Outcome | Notes |
|---|---|---|---|---|---|
| V-P0 | | | | not run | Waits for the owner's sandbox assets (11.1a decision 6) |
| V-P1 | | | | not run | |
| V-P1 addendum | | | | not run | |
| V-P2 | | | | not run | |
| V-P3 | | | | not run | |
| V-P4 | | | | not run | |
| V-P5 | | | | not run | |
| V-P6 | | | | not run | |
| V-P7 | | | | not run | |
| V-P7 addendum | | | | not run | |
| V-P8 | | | | not run | |
| V-P9 | | | | not run | |
| V-P10 | | | | not run | |
| V-P11 | | | | not run | |
| V-P12 | | | | not run | |
| V-P12 addendum | | | | not run | |
| V-P13 | | | | not run | |
| V-P14 | | | | not run | |
| V-P15 | | | | not run | |
| V-P16 | | | | not run | Manual |
| V-P17 | | | | not run | Owner present only |
| V-P18 | | | | not run | |

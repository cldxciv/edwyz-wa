# pages_read_engagement

Phase: A (draft, not submitted; request 1799953447868194)
Feature built: **Built**: the post picker of Boost a post at /app/ads/boost (Page posts with whether each can be promoted, and the Instagram tab), Page details for readiness (Lead Ads terms, picture), the linked Instagram account lookup, and the Campaign Launcher at /app/ads/new (`src/lib/promote/sources.ts`, `src/lib/promote/prereqs.ts`). Not yet exercised against live Meta with the review user.

> Built; needs a live test and the screencast below. Before submitting: run the flow with the review user on the test assets, record the screencast, make the API test calls in the App Dashboard, and re-check the text against the final UI. The request is a draft (1799953447868194, not submitted); state in `status.md`.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app read the business's Page posts and Page details, so the owner can pick a post to boost and Edwyz can say what is ready before an ad starts.

## Use-case description (paste into the review form)

Edwyz lets a business boost a post it already published. With pages_read_engagement we read the connected Page's published posts (text, picture, date, and whether Meta allows the post to be promoted) and show them in a picker, newest first, with a plain reason for posts that can't be boosted. We also read Page details the ad flows need: the name, picture, the linked Instagram account and whether the Page accepted the Lead Ads terms. We only read with this permission. Post data is shown during the session and not stored, except the id of the post the business chose for its ad; the Page id and name are kept until the business disconnects. Visible to the workspace's owners and admins. Not shared or sold.

Length: 710 characters (limit 1000).

## Screencast script

One short video (spec 8.2: the post picker with eligibility; it also shows `instagram_basic`, the Instagram tab). Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step. Start with the shared opening in `00-overview.md`.

1. Ads > **Boost a post**. The picker opens on the Page's posts (the **Facebook** tab), newest first, each with its picture and date.
2. Point at a post marked as not boostable: its tile is greyed and says why ("can't be boosted: ..."). Point at a post already boosted: it has the boosted badge.
3. Pick an eligible post; the next step shows it in the preview.
4. Switch to the **Reels** and **Posts** tabs: the linked Instagram account's reels and posts load the same way (this is the `instagram_basic` part of the video).
5. Show the readiness list on the goal step: "Facebook is connected", the Page's Lead Ads terms state, "The Instagram account is connected to this Page".
6. Disconnect the Page in Settings > Connections; open Boost a post again and show the posts no longer load. Show /data-deletion.

## What the reviewer needs (put in review notes)

- A test Page with two or three public test posts (one with licensed music, so it can't be boosted) and a linked Instagram professional account with at least one reel.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Private Page content, comments from real users.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.

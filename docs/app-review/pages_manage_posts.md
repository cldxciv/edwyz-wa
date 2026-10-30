# pages_manage_posts

Phase: B
Feature built: **Code present** (content calendar at /app/content and the publisher in `src/lib/content/publishers.ts`: `{page}/feed`, `/photos`, `/videos`). Not yet exercised against live Meta with the review user.

> Before submitting: run the flow below on a test Page, record the screencast, and re-check the text against the final UI. Do not add `pages_manage_engagement` or `read_insights` to this request or to the Login for Business configuration: no code uses them (see `status.md`).

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app publish posts to the Page on a schedule. Comment moderation (pages_manage_engagement) and Page analytics (read_insights) are not built and not requested.

## Use-case description (paste into the review form)

Edwyz Growth's Content Calendar lets a business schedule text and image posts to its connected Facebook Page after an approver confirms. We write posts to the Page and read back post IDs and status. The post content and schedule are stored in the workspace until the business deletes them or the workspace. Visible to workspace members with editor rights. We do not post without an explicit schedule or publish action. Not shared or sold.

Length: 438 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; show connect dialog with the permission.
2. Open Content calendar (/app/content).
3. Create a post with image for the test Page; schedule or Publish now.
4. Show it live on the Page.
5. Delete the scheduled item from our UI.
6. Disconnect; show deletion.

## What the reviewer needs (put in review notes)

- Test Page where posting is allowed.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Posts to a public production Page.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.

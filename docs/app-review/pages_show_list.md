# pages_show_list

Phase: A
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app list the Pages the user manages so the user can choose one to connect.

## Use-case description (paste into the review form)

In the Connections screen, the user chooses which Facebook Page to connect. We call the Pages list endpoint to read the name, ID and category of Pages the user manages, display them, and store only the Page the user selects. Nothing is written to Facebook. Stored Page ID and name remain in the workspace, visible to workspace admins, until the user disconnects the Page or deletes the workspace. Data is not shared or sold.

Length: 424 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in at https://wa.edwyz.com/login.
2. Open Connections and click Connect with Facebook; show the dialog with Page selection and permissions.
3. Show the list of Pages returned in our UI.
4. Select the test Page and save; show it as connected with its status.
5. Disconnect the Page and show it removed.
6. Show /data-deletion.

## What the reviewer needs (put in review notes)

- Test user who is admin of a test Page.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Pages that are not the test Page, page access tokens.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.

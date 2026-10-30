# Meta spending limit: live verification runbook (V1-V12)

This runbook checks how Meta's account spending limit (`spend_cap`) really behaves before Edwyz manages it for customers
(docs/SPEND-CONTROLS-SPEC.md 5, 10.6). Until V1-V9 pass and the results are recorded, `SPEND_CAP_MODE` stays `observe`:
Edwyz computes what it would write and records it, but never changes a customer's limit.

**Owner decision (SPEND-CONTROLS-SPEC 12.1a decision 5):** this runbook spends real money. It is run only with the owner
present, on one real INR ad account the owner chooses, with a ₹500 test monthly limit. Until then wall (a) stays in observe
mode and every assistant stays at Level 0. Nobody runs it alone or on a customer's account.

## Before you start

- **Account:** one INR ad account the owner chose, with a working payment method, no other live campaigns, and you as an
  admin of the ad account in Meta Business Settings. Write down its id as `act_<id>`.
- **Budget:** a ₹500 test monthly limit. The test campaign uses a ₹100 daily budget so the limit is reached in a few days
  at most. Expected total spend: at most about ₹550 (the limit plus the overshoot V4 measures).
- **Shell:** run the commands from a laptop, not the production server. Keep the token out of shell history and logs:

```sh
export ACT=act_1234567890
export V=v26.0                         # GRAPH_API_VERSION in src/lib/config.ts
read -s TOKEN && export TOKEN          # paste a user token with ads_management for this account; nothing is echoed
g()  { curl -sS -G "https://graph.facebook.com/$V/$1" -H "Authorization: Bearer $TOKEN" "${@:2}"; echo; }
p()  { curl -sS -X POST "https://graph.facebook.com/$V/$1" -H "Authorization: Bearer $TOKEN" "${@:2}"; echo; }
acct() { g "$ACT" --data-urlencode "fields=spend_cap,amount_spent,currency,timezone_name,account_status,is_prepay_account,min_campaign_group_spend_cap"; }
```

- **Log:** keep every request and response (without the token) in a dated text file. Each check below says what to copy
  into the results.
- **Undo at the end:** remove the test limit (`p "$ACT" -d spend_cap_action=delete`) or put the owner's original limit back,
  and archive the test campaign.

Throughout: `spend_cap` and `amount_spent` are READ as strings of minor units (paise for INR). Edwyz WRITES `spend_cap` as
major units with the currency's decimals ("500.00"). If Meta read a write as minor units, the limit would be 100 times
stricter, which is the safe direction.

## The checks

| Check | What it finds out | Commands | Pass criteria | Record in `spend:meta-verified` |
|---|---|---|---|---|
| **V1** Write unit | Whether a written value is read back as major units | `acct` (note `spend_cap` C0 and `amount_spent` A0); `p "$ACT" -d spend_cap=500.00`; `acct` right after | Read-back `spend_cap` is `50000` (±1 paise): `unitMode = major_write`. If it is `500`, Meta read minor units: `unitMode = minor_write` (stop; open an issue before anything else) | `unitMode`, the raw read-back, `checks.V1` |
| **V2** Reset on write | Whether a write resets `amount_spent` | With some spend already on the account (A > 0, run V4's campaign for a day first if needed): `acct`; `p "$ACT" -d spend_cap=600.00`; `acct` | `amount_spent` after equals before: `semantics = cumulative`. If it drops to about 0: `semantics = resets_on_write` (Edwyz then writes T = R, spec 5.3) | `semantics`, A before and after, `checks.V2` |
| **V3** Floor rule | How low a limit Meta accepts, and its exact error text | With A > 0: `p "$ACT" -d spend_cap=1.00` | An error whose text contains the floor ("must be at least ₹X"). Note whether X equals A, A plus pending charges, or 1.1 x A, and the error `code`, `error_subcode` and full message | `floorRule` (`spent` or `spent_1_1x` or `other`), the message, `checks.V3` |
| **V4** Delay and overshoot | How long a change takes to apply, and how far spend goes past the limit | Set `spend_cap` to A + ₹100; start a test campaign at ₹100 a day with an end date; read `acct` and `g "$ACT/insights" --data-urlencode "date_preset=today" --data-urlencode "fields=spend"` every 15 min until delivery stops | Delivery stops; the minutes from the write to the stop is about 15 (record it); overshoot = final `amount_spent` - `spend_cap` is under 10% of the limit | `applyDelayMin`, overshoot in paise, `checks.V4` |
| **V5** Role needed | Which ad account role may change the limit | Repeat a write as an ad account admin, then as an advertiser (a second test user) | The admin's write succeeds; record which roles get codes 10, 200 or 294 | `checks.V5` with the roles that work |
| **V6** Tax in amount_spent | Whether GST is included in `amount_spent` | Compare `amount_spent` with the insights `spend` for the same period (V4's campaign), and with the GST invoice | Record whether `amount_spent` equals spend, or spend + 18% GST | `taxIncluded` (true/false), `checks.V6` |
| **V7** Daily change limit | That the 11th change in a day is refused with 17 / 1885172 | Ten writes alternating `spend_cap=700.00` and `spend_cap=701.00`, then an 11th | The 11th returns `code 17`, `error_subcode 1885172`. Record whether Meta counts a calendar day (account time zone) or a rolling 24 hours: retry 1 minute after the account's midnight | `checks.V7` with the window (`calendar` or `rolling`) |
| **V8** Prepaid | That a prepaid account is detected | `acct` on the test account, and on a prepaid account if the owner has one | `is_prepay_account` is `false` for the test account and `true` for the prepaid one; a write on the prepaid account is refused | `checks.V8` |
| **V9** Insights day | That insights days follow the ad account's time zone | `g "$ACT/insights" --data-urlencode "time_increment=1" --data-urlencode "date_preset=last_7d" --data-urlencode "fields=spend"` just after the account's midnight, and `acct` (`timezone_name`) | Day boundaries match `timezone_name`, not UTC (resolves the VERIFY note in `src/lib/ads/insights-sync.ts`) | `checks.V9` with `timezone_name` |
| **V10** Lifetime budgets | The most a lifetime-budget ad set spends in one day | A second test ad set with a ₹300 lifetime budget over 3 days; insights per day | Record the highest day as a share of the remaining budget. Until measured, the book counts the whole remainder as today's risk (spec 4.5) | `checks.V10` with the highest daily share |
| **V11** Downward revisions | Whether `amount_spent` ever goes down without a write, and whether ad credits are included | `acct` once a day for the whole test, plus after any refund or invalid-click credit | Record every decrease with its date. If it decreases, Edwyz already waits for two agreeing reads before using a lower value (spec 3.1) | `checks.V11` |
| **V12** Shared budget quota | Whether Ads Manager edits and API edits share Meta's 4-an-hour budget-change limit per ad set | Make 2 budget edits in Ads Manager and then 3 through the API on the same ad set within an hour: `p <adSetId> -d daily_budget=10100` and so on | The 3rd API edit returns `code 613`, `error_subcode 1487632`: the quota is shared (spec 4.6 step 9) | `checks.V12` with `shared: true/false` |

V1-V9 gate `SPEND_CAP_MODE=enforce`. V10-V12 refine the book's maths and the breakers and can run later; record them the
same way.

## Recording the results

Write the results into PlatformSetting `spend:meta-verified` with psql on the production database (the deployer does this,
after the owner has seen the log). Every check keeps its evidence, so the next person can see why a value was chosen:

```sql
INSERT INTO "PlatformSetting" ("key", "value", "updatedAt") VALUES ('spend:meta-verified', '{
  "unitMode": "major_write",
  "semantics": "cumulative",
  "floorRule": "spent",
  "taxIncluded": false,
  "applyDelayMin": 15,
  "verifiedAt": "2026-11-02T10:30:00Z",
  "account": {"id": "act_1234567890", "currency": "INR", "timezone": "Asia/Kolkata"},
  "notes": "Run with the owner present. Overshoot 3.1% of the limit.",
  "checks": {
    "V1": {"passed": true, "readBack": "50000", "at": "2026-11-01T09:00:00Z"},
    "V2": {"passed": true, "amountSpentBefore": "12345", "amountSpentAfter": "12345"},
    "V3": {"passed": true, "message": "The spending limit must be at least ₹123.45.", "code": 100, "subcode": 1885650},
    "V4": {"passed": true, "applyDelayMin": 15, "overshootMinor": "1550"},
    "V5": {"passed": true, "roles": ["admin"]},
    "V6": {"passed": true, "taxIncluded": false},
    "V7": {"passed": true, "window": "rolling"},
    "V8": {"passed": true},
    "V9": {"passed": true, "timezone": "Asia/Kolkata"}
  }
}'::jsonb, now())
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now();
```

Field rules: `unitMode` is `major_write` or `minor_write`; `semantics` is `cumulative` or `resets_on_write`; `floorRule` is
`spent`, `spent_1_1x` or `other`; amounts are strings of minor units; times are ISO strings in UTC. The book reads
`unitMode` and `semantics` as the platform defaults for new accounts (spec 5.5). Each account still learns its own values
from its first read-back.

## After the run

1. Remove the test limit or restore the owner's original one, archive the test campaign, and confirm with `acct`.
2. Paste the log (without the token) into the release notes of the train that turns wall (a) on.
3. Only then may the deployer set `SPEND_CAP_MODE=enforce` (spec 4.14, train 4).

If any of V1-V9 fails or surprises you, leave `SPEND_CAP_MODE=observe`, record the result with `"passed": false`, and raise
it with the owner. The test double (`tests/helpers/fake-meta.ts`) models each switch (write unit, semantics, floor rule,
daily limit, prepaid, permissions), so a new finding can be added there as a test before the code changes.

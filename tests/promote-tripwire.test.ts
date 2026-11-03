import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/tokens", () => ({ getAccessToken: vi.fn(async () => "SECRET-TOKEN-123") }));

import { graphFetch, graphFetchAs, type AppGraphRequest } from "@/lib/graph";
import { classify } from "@/lib/spend/classify";
import { SpendGuardBypassError } from "@/lib/spend/errors";
import { mintPermit, permitUses, runWithPermit } from "@/lib/spend/permit";
import { setTripwireAuditSink, type TripwireAuditEvent } from "@/lib/spend/tripwire";
import type { SpendPermit } from "@/lib/spend/types";

/**
 * docs/IG-PAGE-ADS-SPEC.md 4.7, 6.1 rule 11, D25 and PRM-01 acceptance 3 and 4 (promote-tripwire.test.ts): in enforce mode,
 * with a spying fetch, every banned edge and parameter is refused before any network I/O, with no permit and inside every kind
 * of permit. The Instagram and Page ads writes that cannot spend still go out with no permit.
 */

const T = "tenant_1";
const ACT = "act_777";
const BIZ = "1800000000000001";
const PAGE = "104857600123";
const ADSET = "238500002";
const CAMPAIGN = "238500001";
const FORM = "5566778899001122";
const AUD = "23850000000000077";
const LATER = new Date("2027-12-31T00:00:00Z");
const times = () => ({ issuedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 10 * 60_000) });

/** Every banned request of PRM-01 acceptance 2, with the pattern its audit row may carry. */
const BANNED: [string, AppGraphRequest, string][] = [
  ["a budget schedule on an ad set", { method: "POST", path: `${ADSET}/budget_schedules`, body: { budget_value: 100, budget_value_type: "ABSOLUTE", time_start: 1761600000, time_end: 1761686400 } }, "{id}/budget_schedules"],
  ["a budget schedule on a campaign", { method: "POST", path: `${CAMPAIGN}/budget_schedules`, body: { budget_value: 200, budget_value_type: "MULTIPLIER" } }, "{id}/budget_schedules"],
  ["copies of an ad set", { method: "POST", path: `${ADSET}/copies`, body: { status_option: "ACTIVE", deep_copy: true } }, "{id}/copies"],
  ["copies with a PAUSED status option", { method: "POST", path: `${ADSET}/copies`, body: { status_option: "PAUSED" } }, "{id}/copies"],
  ["an async ad request set", { method: "POST", path: `${ACT}/asyncadrequestsets`, body: { name: "bulk", ad_specs: "[]" } }, "act_{id}/asyncadrequestsets"],
  ["a Graph batch POST /", { method: "POST", path: "/", body: { batch: JSON.stringify([{ method: "POST", relative_url: ADSET, body: "status=ACTIVE" }]) } }, "/"],
  ["daily_min_spend_target on an ad set", { method: "POST", path: ADSET, body: { daily_min_spend_target: 50_000 } }, "{id}"],
  ["daily_min_spend_target on an ad set create", { method: "POST", path: `${ACT}/adsets`, body: { name: "A", status: "PAUSED", daily_min_spend_target: 50_000 } }, "act_{id}/adsets"],
  ["daily_min_spend_target on a Page post", { method: "POST", path: `${PAGE}/feed`, body: { message: "Hi", daily_min_spend_target: 1 } }, "{id}/feed"],
  ["creative_test_config on an ad set", { method: "POST", path: ADSET, body: { creative_test_config: { test_budget: 5000 } } }, "{id}"],
  ["creative_test_config on an ad set create", { method: "POST", path: `${ACT}/adsets`, body: { name: "A", status: "PAUSED", creative_test_config: {} } }, "act_{id}/adsets"],
  ["creative_test_config inside JSON text", { method: "POST", path: ADSET, body: { name: "x", targeting: JSON.stringify({ x: [{ creative_test_config: 1 }] }) } }, "{id}"],
  ["creative_test_config as a form field", { method: "POST", path: ADSET, body: "creative_test_config[test_budget]=5000" }, "{id}"],
  [
    "a split test on the business (T1)",
    { method: "POST", path: `${BIZ}/ad_studies`, body: { name: "A vs B", type: "SPLIT_TEST", cells: [{ name: "A", treatment_percentage: 50, adsets: [ADSET] }], start_time: 1761600000, end_time: 1762204800 } },
    "{id}/ad_studies",
  ],
  ["a split test with a budget (T1')", { method: "POST", path: `${BIZ}/ad_studies`, body: { name: "x", cells: [{ name: "A", adsets: [ADSET], daily_budget: 1 }] } }, "{id}/ad_studies"],
  // A banned parameter inside a nested bracket key (Meta builds nested fields from them), in the query, the path query and a
  // urlencoded body, on an ad create, an ad set create and an ad set update.
  ["creative_test_config in a nested query key on an ad create", { method: "POST", path: `${ACT}/ads`, query: { "creative[creative_test_config]": "{}" }, body: { name: "A", status: "PAUSED", adset_id: ADSET } }, "act_{id}/ads"],
  ["creative_test_config in a nested path query key on an ad create", { method: "POST", path: `${ACT}/ads?cells[0][creative_test_config]=1`, body: { name: "A", status: "PAUSED" } }, "act_{id}/ads"],
  ["creative_test_config in a nested key of a urlencoded body on an ad create", { method: "POST", path: `${ACT}/ads`, body: "name=A&status=PAUSED&creative[creative_test_config]=1" }, "act_{id}/ads"],
  ["creative_test_config in a nested query key on an ad set create", { method: "POST", path: `${ACT}/adsets`, query: { "targeting[creative_test_config]": "1" }, body: { name: "A", status: "PAUSED" } }, "act_{id}/adsets"],
  ["creative_test_config in a nested path query key on an ad set create", { method: "POST", path: `${ACT}/adsets?targeting%5Bcreative_test_config%5D=1`, body: { name: "A", status: "PAUSED" } }, "act_{id}/adsets"],
  ["daily_min_spend_target in a nested key of a urlencoded body on an ad set create", { method: "POST", path: `${ACT}/adsets`, body: "name=A&status=PAUSED&x[daily_min_spend_target]=1" }, "act_{id}/adsets"],
  ["daily_min_spend_target in a nested query key on an ad set", { method: "POST", path: ADSET, query: { "x[daily_min_spend_target]": "1" } }, "{id}"],
  ["lifetime_min_spend_target in a nested path query key on an ad set", { method: "POST", path: `${ADSET}?x[lifetime_min_spend_target]=1` }, "{id}"],
  ["creative_test_config in a nested key of a urlencoded body on an ad set", { method: "POST", path: ADSET, body: "name=x&cells[0][creative_test_config]=1" }, "{id}"],
];

/** Every path the banned requests use, so a permit cannot fail them for the wrong path alone. */
const ALL_PATHS = [ADSET, CAMPAIGN, PAGE, `${ADSET}/budget_schedules`, `${CAMPAIGN}/budget_schedules`, `${ADSET}/copies`, `${ACT}/asyncadrequestsets`, `${ACT}/adsets`, `${ACT}/ads`, `${PAGE}/feed`, `${BIZ}/ad_studies`, "/"];
const wide = { status: "ACTIVE" as const, maxDailyMinor: 10n ** 12n, maxLifetimeMinor: 10n ** 12n, endsAt: LATER };

/** The most generous permit of each kind the book can mint, all naming every banned path. */
const PERMITS: [string, () => SpendPermit][] = [
  [
    "an activate permit for every object",
    () =>
      mintPermit({ type: "ads", kind: "activate", correlationId: "sc_a", tenantId: T, adAccountAssetId: "asset_1", accountExternalId: ACT, objects: { [ADSET]: wide, [CAMPAIGN]: wide, [PAGE]: wide, [BIZ]: wide }, paths: ALL_PATHS, maxUses: 99, ...times() }),
  ],
  ["a raise_budget permit", () => mintPermit({ type: "ads", kind: "raise_budget", correlationId: "sc_r", tenantId: T, adAccountAssetId: "asset_1", accountExternalId: ACT, objects: { [ADSET]: wide }, paths: ALL_PATHS, maxUses: 99, ...times() })],
  ["a create permit", () => mintPermit({ type: "create", correlationId: "sc_c", tenantId: T, adAccountExternalId: ACT, objectCount: 9, paths: ALL_PATHS, maxUses: 99, ...times() })],
  ["a pause permit", () => mintPermit({ type: "lowering", kind: "pause", correlationId: "sc_p", tenantId: T, metaObjectIds: [ADSET, CAMPAIGN], paths: ALL_PATHS, maxUses: 99, ...times() })],
  ["a cut_budget permit", () => mintPermit({ type: "lowering", kind: "cut_budget", correlationId: "sc_k", tenantId: T, metaObjectIds: [ADSET], maxBudgetMinor: 10n ** 12n, paths: ALL_PATHS, maxUses: 99, ...times() })],
  ["an end_earlier permit", () => mintPermit({ type: "lowering", kind: "end_earlier", correlationId: "sc_e", tenantId: T, metaObjectIds: [ADSET], endsAt: LATER, paths: ALL_PATHS, maxUses: 99, ...times() })],
];

let events: TripwireAuditEvent[];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  events = [];
  setTripwireAuditSink((e) => void events.push(e));
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: "1", success: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.env.SPEND_TRIPWIRE = "enforce";
});
afterEach(() => {
  setTripwireAuditSink(null);
  delete process.env.SPEND_TRIPWIRE;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("banned edges and parameters are refused in enforce mode with zero fetches (4.7, D25)", () => {
  it.each(BANNED)("%s: classified ads_raise_or_unknown", (_name, request) => {
    expect(classify(request).class).toBe("ads_raise_or_unknown");
  });

  it.each(BANNED)("%s: refused with no permit, audited by pattern only", async (_name, request, pattern) => {
    await expect(graphFetchAs("page-token", request)).rejects.toBeInstanceOf(SpendGuardBypassError);
    await expect(graphFetch({ tenantId: T, ...request })).rejects.toMatchObject({ code: "spend_bypass" });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(events).toHaveLength(2);
    for (const e of events) expect(e).toMatchObject({ action: "spend.tripwire.bypass", target: pattern, meta: { class: "ads_raise_or_unknown", mode: "enforce", blocked: true } });
    const text = JSON.stringify(events);
    for (const id of [ADSET, CAMPAIGN, BIZ, PAGE, "777", "page-token", "SECRET-TOKEN-123"]) expect(text).not.toContain(id);
  });

  it.each(PERMITS)("inside %s, every banned request is still refused before fetch, and no use is counted", async (_name, make) => {
    for (const [name, request] of BANNED) {
      const permit = make();
      await expect(runWithPermit(permit, () => graphFetchAs("page-token", request)), name).rejects.toBeInstanceOf(SpendGuardBypassError);
      expect(permitUses(permit), name).toBe(0);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(events.every((e) => e.meta.blocked && e.meta.class === "ads_raise_or_unknown")).toBe(true);
  });

  it("the same permits do cover what they were minted for (so the refusals above are about the banned request)", async () => {
    const [, activate] = PERMITS[0];
    await runWithPermit(activate(), () => graphFetchAs("page-token", { method: "POST", path: ADSET, body: { status: "ACTIVE" } }));
    const [, create] = PERMITS[2];
    await runWithPermit(create(), () => graphFetchAs("page-token", { method: "POST", path: `${ACT}/adsets`, body: { name: "A", status: "PAUSED" } }));
    // A nested bracket key that names no banned field is still a plain create.
    await runWithPermit(create(), () => graphFetchAs("page-token", { method: "POST", path: `${ACT}/ads`, query: { "creative[creative_id]": "1" }, body: { name: "A", status: "PAUSED" } }));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(events).toEqual([]);
  });

  it("a spend field given in bracket form cannot be read, so the permit that would cover the plain field refuses it", async () => {
    const [, activate] = PERMITS[0];
    const [, raise] = PERMITS[1];
    const [, create] = PERMITS[2];
    const [, pause] = PERMITS[3];
    const cases: [string, () => SpendPermit, AppGraphRequest, string][] = [
      ["a create whose status is also ACTIVE in bracket form", create, { method: "POST", path: `${ACT}/adsets`, body: { name: "A", status: "PAUSED", "status[0]": "ACTIVE" } }, "not_paused"],
      ["a budget in bracket form under raise_budget", raise, { method: "POST", path: ADSET, query: { "daily_budget[0]": "100" } }, "budget_over_permit"],
      ["a status in bracket form under activate", activate, { method: "POST", path: ADSET, body: "status[0]=ACTIVE" }, "status_not_permitted"],
      ["a pause that also says ACTIVE in bracket form under pause", pause, { method: "POST", path: ADSET, body: "status=PAUSED&status[]=ACTIVE" }, "status_not_permitted"],
    ];
    for (const [name, make, request, reason] of cases) {
      const permit = make();
      await expect(runWithPermit(permit, () => graphFetchAs("page-token", request)), name).rejects.toMatchObject({ reason });
      expect(permitUses(permit), name).toBe(0);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe("creates under the Instagram and Page ads flows (P0-1, already built)", () => {
  it("a creative needs a create permit but no PAUSED body; a split test is not a create until P0-7", async () => {
    // A create permit that also names <business>/ad_studies, as P0-7 would allow later.
    const permit = mintPermit({ type: "create", correlationId: "sc_c2", tenantId: T, adAccountExternalId: ACT, objectCount: 4, paths: [`${ACT}/adcreatives`, `${BIZ}/ad_studies`], maxUses: 9, ...times() });
    await runWithPermit(permit, () => graphFetchAs("page-token", { method: "POST", path: `${ACT}/adcreatives`, body: { name: "Reel boost", object_id: PAGE, instagram_user_id: "1784", source_instagram_media_id: "1790" } }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(graphFetchAs("page-token", { method: "POST", path: `${ACT}/adcreatives`, body: { name: "No permit" } })).rejects.toMatchObject({ reason: "no_permit" });
    // ads_raise_or_unknown on an edge: no permit of any kind can cover it, even one that names the path.
    await expect(runWithPermit(permit, () => graphFetchAs("page-token", { method: "POST", path: `${BIZ}/ad_studies`, body: { name: "A vs B", type: "SPLIT_TEST" } }))).rejects.toMatchObject({ reason: "not_coverable" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Instagram and Page ads writes that cannot spend go out with no permit (4.2, P0-2, P0-9, P0-12)", () => {
  const NOT_SPEND_WRITES: [string, AppGraphRequest][] = [
    ["C8 Page-backed Instagram", { method: "POST", path: `${PAGE}/page_backed_instagram_accounts` }],
    ["C9 pixel on the ad account", { method: "POST", path: `${ACT}/adspixels`, body: { name: "Shop pixel" } }],
    ["C9 pixel on the business", { method: "POST", path: `${BIZ}/adspixels`, body: { name: "Shop pixel" } }],
    ["M1 image", { method: "POST", path: `${ACT}/adimages`, body: { bytes: "iVBORw0KGgo=" } }],
    ["M2 video from a URL", { method: "POST", path: `${ACT}/advideos`, body: { file_url: "https://media.example.com/v.mp4", name: "Reel" } }],
    ["M2 resumable start", { method: "POST", path: `${ACT}/video_ads`, body: { upload_phase: "start", file_size: 1024 } }],
    ["M2 resumable finish", { method: "POST", path: `${ACT}/video_ads`, body: { upload_phase: "finish", video_id: "22" } }],
    ["L2 lead form", { method: "POST", path: `${PAGE}/leadgen_forms`, body: { name: "Form", questions: [{ type: "PHONE" }], privacy_policy: { url: "https://example.com/p", link_text: "Privacy" }, locale: "en_US" } }],
    ["L4 test lead", { method: "POST", path: `${FORM}/test_leads`, body: { field_data: [{ name: "full_name", values: ["Test"] }] } }],
    ["A1 customer list", { method: "POST", path: `${ACT}/customaudiences`, body: { name: "Buyers", subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY" } }],
    ["A2 add rows", { method: "POST", path: `${AUD}/users`, body: { payload: { schema: ["EMAIL"], data: [["a".repeat(64)]] }, session: { session_id: 1, batch_seq: 1, last_batch_flag: true } } }],
    ["A3 replace rows", { method: "POST", path: `${AUD}/usersreplace`, body: { payload: { schema: ["EMAIL"], data: [["a".repeat(64)]] }, session: { session_id: 2, batch_seq: 1, last_batch_flag: true } } }],
    ["A4 remove rows", { method: "DELETE", path: `${AUD}/users`, body: { payload: { schema: ["EMAIL"], data: [["a".repeat(64)]] } } }],
    ["A6 delete an audience", { method: "DELETE", path: AUD }],
  ];

  it.each(NOT_SPEND_WRITES)("%s", async (_name, request) => {
    await graphFetchAs("user-token", request);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });
});

/**
 * The parity ledger (docs/IG-PAGE-ADS-SPEC.md 1.1, 4.7, 8.5): what the Marketing API offers for Pages and Instagram that is
 * deliberately not built, each with its reason. Developer-facing text, never shown to owners.
 *
 * The names of the banned spend edges are written in words here, because rule B15 (tests/spend-bypass.test.ts) allows
 * their Graph spellings only in src/lib/spend/classify.ts. The two organic insights permissions (D24) are written in
 * words too, because tests/usage-scopes-alignment.test.ts allows their spellings only in src/lib/meta-connect/scopes.ts.
 */

export type NotBuilt = {
  key: string;
  what: string;
  reason: string;
  /** Where the decision is recorded. */
  ref: string;
  /** A permission it would need, when that is the blocker (8.5). */
  needsPermission?: string;
};

export const NOT_BUILT: readonly NotBuilt[] = [
  {
    key: "partnership_ads",
    what: "Partnership and branded-content ads",
    reason: "Needs instagram_branded_content_ads_brand, which is not requested, and the branded-content advertisable media edge is removed on 2026-12-01.",
    ref: "4.7, 8.5, 11.1a item 7",
    needsPermission: "instagram_branded_content_ads_brand",
  },
  {
    key: "catalog_ads",
    what: "Catalog and dynamic product ads",
    reason: "Needs catalog_management, which is not requested.",
    ref: "4.7, 8.5",
    needsPermission: "catalog_management",
  },
  {
    key: "budget_schedule_edge",
    what: "High-demand budget schedules",
    reason: "Meta's budget schedules edge can raise spend up to 8x the daily budget per period outside reserveAds, so it is a banned edge.",
    ref: "4.7, D25, rule B15",
  },
  {
    key: "meta_copies_edge",
    what: "Meta's copy edge for campaigns, ad sets and ads",
    reason: "It can create the copy already active (status_option), outside reserveAds. Make a copy is a local draft instead.",
    ref: "4.7, D25, rule B15",
  },
  {
    key: "graph_batch",
    what: "Graph batch requests",
    reason: "One batch POST hides many writes from the tripwire's per-request classification, so it is a banned edge.",
    ref: "4.7, D25, rule B15",
  },
  {
    key: "async_request_sets",
    what: "Async ad request sets",
    reason: "They apply many object writes later, outside reserveAds, so they are a banned edge.",
    ref: "4.7, D25, rule B15",
  },
  {
    key: "asc_aac",
    what: "Advantage shopping and app campaigns",
    reason: "Creating them through the API was removed in v25.",
    ref: "4.7",
  },
  {
    key: "messenger_lead_templates",
    what: "Messenger lead templates",
    reason: "No API since v24.",
    ref: "4.7",
  },
  {
    key: "reach_frequency",
    what: "Reach and frequency buying",
    reason: "A reserved buy commits money up front, which the daily-budget model and Phase 0 limits do not cover.",
    ref: "4.7",
  },
  {
    key: "poll_creatives",
    what: "Poll creatives",
    reason: "Blocked in v26.",
    ref: "4.7",
  },
  {
    key: "existing_post_asset_customization",
    what: "Placement asset customization on existing posts",
    reason: "Only Ads Manager offers it; the API takes per-placement assets on new creatives only.",
    ref: "4.7",
  },
  {
    key: "form_archive",
    what: "Archiving lead forms through the API",
    reason: "An archive POST would show up as an unledgered lowering in Phase 0's audit, so forms are hidden locally instead.",
    ref: "4.7, D13",
  },
  {
    key: "organic_insights",
    what: "Organic (free) results for posts",
    reason: "Needs the Page insights or the Instagram insights permission, which the scope test bans and which are not requested.",
    ref: "4.7, D24, 8.5",
  },
];

/** The ledger entry for a key, or null. */
export function notBuilt(key: string): NotBuilt | null {
  return NOT_BUILT.find((n) => n.key === key) ?? null;
}

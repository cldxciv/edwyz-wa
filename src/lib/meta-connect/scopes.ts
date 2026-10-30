/**
 * The single list of permissions the Login for Business configuration (META_LOGIN_CONFIG_ID) must request.
 * Phase A and B only (docs/PRODUCT-SPEC-GROWTH.md section 4); Phase C scopes are added when those features ship.
 * App Review documents reference this constant. A permission is listed only when code uses it: there is no comment moderation (pages_manage_engagement) and no
 * Page or Instagram organic insights call (read_insights, instagram_manage_insights); the only insights read is the ad account's, under ads_read.
 * Add each back in the commit that ships the feature, together with its review document. tests/usage-scopes-alignment.test.ts checks the list against the code.
 *
 * IMPORTANT: this list is not sent to Meta and does not change what Meta issues. startConnect sends only config_id, so the
 * permissions on a token come from the Login for Business configuration in the Meta app dashboard. Removing a scope here
 * does nothing to tokens or to the consent screen; an operator must also remove it from that configuration. The permissions
 * a token really carries are read back with debug_token (stored in MetaConnection.scopes at connect, refresh and by the health
 * worker); scopeSummary() compares them with this list so the Connections page can show them and flag unexpected extras.
 */
export const META_CONNECT_SCOPES = [
  "business_management",
  "ads_management",
  "ads_read",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_ads",
  "pages_manage_metadata",
  "leads_retrieval",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
] as const;

export type MetaScope = (typeof META_CONNECT_SCOPES)[number];

/** Plain-language use of each permission, shown on the Connections page. */
export const SCOPE_PURPOSES: Record<MetaScope, string> = {
  business_management: "Find your business portfolio and the assets in it.",
  // docs/SPEND-CONTROLS-SPEC.md 5.10: the permission also lets Edwyz keep Meta's spending limit in line with the owner's limits.
  ads_management: "Create and change ad campaigns, and keep Meta's spending limit in line with your limits.",
  ads_read: "Read ad performance for reports.",
  pages_show_list: "List the Facebook Pages you manage.",
  pages_read_engagement: "Read Page details and engagement.",
  pages_manage_ads: "Run ads and lead forms for your Page.",
  pages_manage_metadata: "Subscribe your Page to lead notifications.",
  leads_retrieval: "Fetch leads submitted through your lead forms.",
  pages_manage_posts: "Publish posts you schedule to your Page.",
  instagram_basic: "Read your linked Instagram professional account.",
  instagram_content_publish: "Publish posts you schedule to Instagram.",
};

export const missingScopes = (granted: readonly string[]): MetaScope[] => META_CONNECT_SCOPES.filter((s) => !granted.includes(s));

const BASELINE_SCOPES = new Set(["public_profile", "email"]);

/** Granted permissions this app does not use. Non-empty means the Login for Business configuration still requests more than the code needs. */
export const unusedScopes = (granted: readonly string[]): string[] =>
  granted.filter((s) => !BASELINE_SCOPES.has(s) && !(META_CONNECT_SCOPES as readonly string[]).includes(s));

export const SCOPE_SOURCE_NOTE =
  "These are the permissions Meta reports on the token (debug_token). They come from the Login for Business configuration in the Meta app, not from this app's code: removing a permission from the code does not remove it from the token.";

export type ScopeSummary = {
  source: "debug_token";
  /** Every permission Meta lists on the token, baseline ones included. */
  granted: string[];
  /** Needed by the app but not on the token: some features will not work until the user reconnects. */
  missing: MetaScope[];
  /** On the token but not used by the app: remove them from the Login for Business configuration. */
  unexpected: string[];
  note: string;
};

/** What the connection summary shows about permissions: the list actually granted, what is missing, and unexpected extras. Empty for a revoked connection. */
export const scopeSummary = (granted: readonly string[], revoked = false): ScopeSummary => ({
  source: "debug_token",
  granted: revoked ? [] : [...new Set(granted)].sort(),
  missing: revoked ? [] : missingScopes(granted),
  unexpected: revoked ? [] : unusedScopes(granted),
  note: SCOPE_SOURCE_NOTE,
});

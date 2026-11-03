/**
 * The shop's words (docs/specs/META-CATALOG-COMMERCE-SPEC.md 2.3, 2.5, 2.7, 2.18 and 3.8). Pure and safe in the browser.
 *
 * - productState() and STATE_COPY: the one map from a product's sync state, Meta review and status to a pill and a line.
 * - classifyItemIssue() and issueCopy(): Meta's product errors as one of nine plain problems, matched by code first and by
 *   keywords in Meta's message second, so a wording change on Meta's side only drops to "Any other item error".
 * - metaErrorCopy(): every row of 3.8 (catalog create, link, sync, sends, Shopify), each with its fix.
 * - SHOP_COPY: the key copy of 2.18.
 * Plain words only: never "catalog ID", "retailer", "items batch", "product set", "payload" or "WABA" (a test checks).
 * Meta's own text is untrusted: it is cut to 200 characters and only ever quoted.
 */
import type { IssueCode, ProductIssue, ProductState, ProductStatus, ProductSyncState, ReviewStatus, ShopFix, StateTone } from "./types";

// =====================================================================================================================
// Opens Meta screens the shop links to (registered with the `shop` tag in src/lib/meta-connect/meta-screens.ts by CAT-02)
// =====================================================================================================================

export const SHOP_META_SCREENS = Object.freeze([
  "whatsapp_manager_catalog",
  "commerce_manager",
  "commerce_manager_issues",
  "commerce_manager_create_catalog",
  "business_settings_people",
  "facebook_security_2fa",
] as const);
export type ShopMetaScreen = (typeof SHOP_META_SCREENS)[number];

/** A fix button. `retry` and `edit` act on the screen itself; the rest match ShopFix. */
export type CopyFix = ShopFix | { kind: "retry"; target: "retry"; label: string } | { kind: "edit"; target: string; label: string };

const connectAgain: CopyFix = { kind: "connect_facebook", target: "connect_facebook", label: "Connect again" };
const opensMeta = (target: ShopMetaScreen, label: string): CopyFix => ({ kind: "opens_meta", target, label });
const navigate = (target: string, label: string): CopyFix => ({ kind: "navigate", target, label });
const retry = (label = "Try again"): CopyFix => ({ kind: "retry", target: "retry", label });
const edit = (field: string, label = "Edit"): CopyFix => ({ kind: "edit", target: field, label });

// =====================================================================================================================
// 2.18 key copy
// =====================================================================================================================

export const SHOP_COPY = Object.freeze({
  "shop.nav": "Shop",
  "shop.setup.title": "Sell on WhatsApp",
  "shop.setup.intro": "Show your products in WhatsApp chats. Customers can browse, add to a cart and send you an order.",
  "shop.empty.products": "No products yet. Add your first product so customers can see it on WhatsApp.",
  "shop.empty.orders": "No orders yet. When a customer sends a cart on WhatsApp, it shows here.",
  "shop.state.live": "Live on WhatsApp",
  "shop.state.checking": "Meta is checking it",
  "shop.state.fix": "Needs a fix",
  "shop.sync.busy": "Meta is busy with your catalog. We'll send the rest at {time}.",
  "shop.token.expired": "Your Facebook connection has expired. Connect again to keep your products up to date.",
  "shop.window.closed": "This chat's 24-hour window is closed, so WhatsApp only allows an approved template.",
  "shop.order.new": "New order #{number}: {items} items, {total}",
  "shop.readonly": "This catalog is managed outside Edwyz. Change products where you do today.",
  "shop.coming_soon": "Selling on WhatsApp is coming soon to your workspace.",
  "shop.saved": "Saved. It shows on WhatsApp after Meta checks it, usually in a few minutes.",
});
export type ShopCopyKey = keyof typeof SHOP_COPY;

/** Fills {name} placeholders; a missing value leaves the placeholder visible rather than inventing one. */
export function fill(text: string, vars: Readonly<Record<string, string | number>> = {}): string {
  return text.replace(/\{([a-z_ ]+)\}/gi, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** A 2.18 line with its values filled in. */
export function shopCopy(key: ShopCopyKey, vars?: Readonly<Record<string, string | number>>): string {
  return fill(SHOP_COPY[key], vars);
}

// =====================================================================================================================
// Product states (2.3)
// =====================================================================================================================

export type StateCopy = { pill: string; tone: StateTone; text: string };

/** One pill and one line per state. "Read only" is a separate chip shown next to the state of a mirrored product. */
export const STATE_COPY: Readonly<Record<ProductState, StateCopy>> = Object.freeze({
  pending: { pill: "Waiting", tone: "info", text: "Waiting to send to Meta" },
  sending: { pill: "Checking", tone: "info", text: "Meta is checking it. This usually takes a few minutes." },
  checking: { pill: "Checking", tone: "info", text: "Meta is checking it. This usually takes a few minutes." },
  live: { pill: "Live", tone: "good", text: "Customers can see it on WhatsApp" },
  rejected: { pill: "Not allowed", tone: "bad", text: "Meta didn't allow this product on WhatsApp." },
  problem: { pill: "Needs a fix", tone: "warn", text: "Meta couldn't accept this product yet." },
  updating: { pill: "Updating", tone: "info", text: "Meta is updating it" },
  deleting: { pill: "Removing", tone: "neutral", text: "Removing from WhatsApp" },
  hidden: { pill: "Hidden", tone: "neutral", text: "Hidden from WhatsApp" },
});

export const READ_ONLY_CHIP = Object.freeze({ label: "Read only", tone: "neutral" as StateTone, text: "Managed outside Edwyz" });

/**
 * A product's plain state from its columns. Removing wins, then a failed send (the change did not reach Meta, so what
 * customers see is unknown), then hidden, then the send and review progress. A mirrored product (`external`) shows Meta's
 * review like a synced one.
 */
export function productState(p: { syncState: ProductSyncState | string; reviewStatus?: ReviewStatus | string | null; status?: ProductStatus | string | null }): ProductState {
  if (p.syncState === "deleting") return "deleting";
  if (p.syncState === "failed") return "problem";
  if (p.status === "archived") return "hidden";
  if (p.syncState === "pending") return "pending";
  if (p.syncState === "sending") return "sending";
  if (p.syncState === "checking") return "checking";
  switch (p.reviewStatus) {
    case "approved":
      return "live";
    case "rejected":
      return "rejected";
    case "outdated":
      return "updating";
    default:
      return "checking";
  }
}

// =====================================================================================================================
// Item problems (3.8 "Item error" rows)
// =====================================================================================================================

/** Meta's text, untrusted: control characters removed, at most 200 characters. */
export function untrustedMetaText(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}

/**
 * Error codes Meta's catalog answers carry for product problems, lower-cased (VERIFY V-C5 records the real ones from the
 * sandbox). A code that is not here falls through to the keywords.
 */
const ISSUE_BY_CODE: Readonly<Record<string, IssueCode>> = Object.freeze({
  image_too_small: "image",
  image_dimensions_too_small: "image",
  invalid_image_format: "image",
  unsupported_image_format: "image",
  image_fetch_failed: "image_link",
  image_download_failed: "image_link",
  image_url_unreachable: "image_link",
  broken_image_link: "image_link",
  invalid_price: "price",
  price_invalid: "price",
  invalid_currency: "price",
  missing_required_field: "missing",
  required_field_missing: "missing",
  invalid_url: "link",
  invalid_link: "link",
  broken_link: "link",
  duplicate_id: "duplicate",
  duplicate_retailer_id: "duplicate",
  text_too_long: "text",
  title_too_long: "text",
  description_too_long: "text",
  all_caps: "text",
  policy_violation: "policy",
  commerce_policy_violation: "policy",
});

/** Meta's field names to the words on the product form. */
const FIELD_WORDS: Readonly<Record<string, string>> = Object.freeze({
  id: "product code",
  retailer_id: "product code",
  title: "name",
  name: "name",
  description: "description",
  price: "price",
  sale_price: "sale price",
  currency: "price",
  availability: "stock",
  condition: "condition",
  link: "website link",
  url: "website link",
  image_link: "photo",
  image_url: "photo",
  image: "photo",
  additional_image_link: "extra photos",
  brand: "brand",
  google_product_category: "category",
  fb_product_category: "category",
  origin_country: "country it was made in",
  importer_name: "importer",
  importer_address: "importer",
  item_group_id: "variant group",
  color: "colour",
  size: "size",
});

/** The form's word for a field named in Meta's message, or undefined. */
function fieldIn(message: string): string | undefined {
  const lower = message.toLowerCase();
  const named = Object.keys(FIELD_WORDS)
    .sort((a, b) => b.length - a.length)
    .find((k) => new RegExp(`(^|[^a-z_])${k}([^a-z_]|$)`).test(lower));
  return named;
}

export type MetaItemError = { code?: string | number | null; subcode?: string | number | null; message?: string | null; field?: string | null };

/**
 * One product problem from Meta's error (an items_batch validation error, a check_batch_request_status entry or a review
 * sweep error): the code first, then keywords in Meta's message. Meta's words are kept as untrusted text.
 */
export function classifyItemIssue(error: MetaItemError): ProductIssue {
  const metaText = untrustedMetaText(error.message);
  const message = (error.message ?? "").toString();
  const lower = message.toLowerCase();
  const field = (error.field ? String(error.field).toLowerCase() : undefined) ?? fieldIn(message);
  const withField = (code: IssueCode): ProductIssue => ({ code, ...(field ? { field } : {}), ...(metaText ? { metaText } : {}) });

  const code = error.code === null || error.code === undefined ? "" : String(error.code).toLowerCase();
  if (code && ISSUE_BY_CODE[code]) return withField(ISSUE_BY_CODE[code]);

  const mentionsImage = /\bimage|photo|picture/.test(lower);
  if (/duplicate|already (exists|in use|used)|same (id|content id)/.test(lower)) return withField("duplicate");
  if (mentionsImage && /download|fetch|retriev|could ?n[o']t (be )?(access|load|open|read)|unreachable|broken|not (be )?found|404|time ?out/.test(lower)) return withField("image_link");
  if (mentionsImage && /small|size|dimension|resolution|pixel|format|type|jpe?g|png|500/.test(lower)) return withField("image");
  if (/required|missing|must (be )?(provided|specified|set|included)|is empty|cannot be empty|can't be empty/.test(lower)) return withField("missing");
  if (/\bprice|currency/.test(lower)) return withField("price");
  if (/too long|exceed|characters|all ?caps|capital|upper ?case|contains? (a )?(link|url)|links? (are|is) not allowed/.test(lower)) return withField("text");
  if (/\b(link|url)\b/.test(lower)) return withField("link");
  if (/polic|prohibit|not allowed|restricted|violat/.test(lower)) return withField("policy");
  return withField("unknown");
}

/** "missing" text for a field: "Add a photo." */
function addA(field: string | undefined): string {
  const word = field ? (FIELD_WORDS[field] ?? field.replace(/_/g, " ")) : "missing detail";
  return `Add ${/^[aeiou]/.test(word) ? "an" : "a"} ${word}.`;
}

/** What kind of text Meta refused, from its message. */
function whatText(metaText: string | undefined): string {
  const lower = (metaText ?? "").toLowerCase();
  if (/link|url/.test(lower)) return "links";
  if (/caps|capital|upper ?case/.test(lower)) return "all-capital text";
  return "this much text";
}

export type IssueCopy = { text: string; fix: CopyFix };

/** The plain words and the one fix for a product problem (3.8). `retailerId` fills "{code}" for a duplicate. */
export function issueCopy(issue: ProductIssue, retailerId?: string): IssueCopy {
  const fieldWord = issue.field ? (FIELD_WORDS[issue.field] ?? issue.field.replace(/_/g, " ")) : undefined;
  switch (issue.code) {
    case "image":
      return { text: "The photo is too small or not a JPG or PNG. Use one at least 500 x 500 pixels.", fix: edit("photo", "Change photo") };
    case "image_link":
      return { text: "Meta couldn't open the photo link. Upload the photo instead.", fix: edit("photo", "Change photo") };
    case "price":
      return { text: "The price isn't valid. Write it like 799 or 799.50.", fix: edit("price", "Edit price") };
    case "missing":
      return { text: addA(issue.field), fix: edit(issue.field ?? "product") };
    case "link":
      return { text: "The website link doesn't work. Use a full link starting with https://, or leave it empty to use your shop page.", fix: edit("link", "Edit link") };
    case "duplicate":
      return {
        text: retailerId ? `Another product already uses the code ${retailerId}. Change the product code.` : "Another product already uses this code. Change the product code.",
        fix: edit("retailerId", "Edit code"),
      };
    case "text":
      return { text: `Meta doesn't allow ${whatText(issue.metaText)} in the ${fieldWord ?? "description"}.`, fix: edit(issue.field ?? "description") };
    case "policy":
      return { text: REJECTED_TEXT, fix: opensMeta("commerce_manager_issues", "Ask Meta to review again") };
    case "unknown":
      return { text: issue.metaText ? `Meta couldn't accept this product: "${issue.metaText}"` : "Meta couldn't accept this product. Check its details and save it again.", fix: edit("product") };
  }
}

/** Review status `rejected` (3.8). */
export const REJECTED_TEXT =
  "Meta didn't allow this product on WhatsApp. Products like medicines, weapons, adult items, animals or alcohol aren't allowed. If you think this is a mistake, ask Meta to review it again.";

/** The copy and fix of a rejected review. */
export function rejectedCopy(): IssueCopy {
  return { text: REJECTED_TEXT, fix: opensMeta("commerce_manager_issues", "Ask Meta to review again") };
}

// =====================================================================================================================
// Meta answers in plain words (3.8)
// =====================================================================================================================

/** Where the answer came from: decides which row of 3.8 applies to a code. */
export type MetaAnswerContext =
  | "create_catalog" // K4
  | "use_new_catalog" // K5 or P1 on a catalog Edwyz just created
  | "link_whatsapp" // W1 (and W2)
  | "whatsapp_settings" // W5
  | "delete_catalog" // K7
  | "delete_collection" // S3
  | "catalog_sync" // P1, P2, S1, S2 and other catalog calls
  | "whatsapp_account" // other WhatsApp account calls (W4, W6, T1)
  | "send_products" // M1 to M4
  | "send_product_template" // M5
  | "shopify"; // SH1

export type MetaAnswer = {
  code?: number | string | null;
  subcode?: number | string | null;
  message?: string | null;
  /** HTTP status, for Shopify answers. */
  status?: number | null;
};

export type MetaAnswerVars = {
  /** The business portfolio's name. */
  business?: string;
  /** The suggested catalog name for the first catalog made in Commerce Manager. */
  catalogName?: string;
  /** When the next try runs, already formatted for people ("10:42"). */
  time?: string;
  /** The product's name or code. */
  product?: string;
};

export type MetaAnswerCopy = {
  /** A stable key for tests, logs and Eddy. */
  key: string;
  text: string;
  fixes: CopyFix[];
  /** True when Edwyz tries again by itself (a busy or limited answer). */
  automatic: boolean;
};

const BUSY_CODES = new Set(["80014", "80009", "4", "17", "32", "613"]);
const PERMISSION_CODES = new Set(["10", "200"]);

/** True when Meta's answer says the business has not accepted the catalog terms yet (VERIFY V-C1 records the real code). */
export function isTermsNotAccepted(answer: MetaAnswer): boolean {
  return /terms|tos\b|accept.*(agreement|conditions)/i.test(String(answer.message ?? ""));
}

const answer = (key: string, text: string, fixes: CopyFix[] = [], automatic = false): MetaAnswerCopy => ({ key, text, fixes, automatic });

/** The terms-not-accepted fallback of 2.2 step 4, with the suggested name when there is one. */
function termsCopy(vars: MetaAnswerVars): MetaAnswerCopy {
  const text = vars.catalogName
    ? `Meta asks every business to make its first catalog in Commerce Manager once. Tap below, choose E-commerce, name it '${vars.catalogName}', and come back. Edwyz takes it from there.`
    : "Meta asks every business to make its first catalog in Commerce Manager once. Tap below, choose E-commerce, and come back. Edwyz takes it from there.";
  return answer("catalog_terms", text, [opensMeta("commerce_manager_create_catalog", "Create it in Meta"), retry("Check again")]);
}

/**
 * The plain words for a Meta (or Shopify) answer, with its fixes, for every row of 3.8. Unknown answers fall back to a
 * general line for their context; Meta's own text is never shown here (the product rows quote it through issueCopy).
 */
export function metaErrorCopy(context: MetaAnswerContext, err: MetaAnswer, vars: MetaAnswerVars = {}): MetaAnswerCopy {
  const code = err.code === null || err.code === undefined ? "" : String(err.code);
  const time = vars.time ?? "a few minutes";

  if (context === "shopify") {
    if (err.status === 401 || err.status === 403) {
      if (/scope|access denied|read_products|read_inventory/i.test(String(err.message ?? "")) && err.status === 403) return shopifyScopeCopy();
      return answer("shopify_token", "Shopify rejected the access token. Paste a new Admin API token on the Shopify recovery page.", [navigate("/app/commerce", "Open Shopify settings")]);
    }
    if (/scope|read_products|read_inventory/i.test(String(err.message ?? ""))) return shopifyScopeCopy();
    return answer("shopify_failed", "We couldn't reach your Shopify store. We'll try again soon.", [], true);
  }

  // A connection that expired or was removed, whatever the call.
  if (code === "190") return answer("token_expired", SHOP_COPY["shop.token.expired"], [connectAgain]);
  if (code === "80008") return answer("whatsapp_limited", `WhatsApp is limiting changes to your account for a while. Try again after ${time}.`, [], true);
  if (BUSY_CODES.has(code)) return answer("catalog_busy", fill(SHOP_COPY["shop.sync.busy"], { time }), [], true);

  switch (context) {
    case "create_catalog":
      if (isTermsNotAccepted(err)) return termsCopy(vars);
      if (code === "415")
        return answer("two_factor", "Your business portfolio asks for two-factor authentication. Turn it on for your Facebook account, then try again.", [
          opensMeta("facebook_security_2fa", "Turn on two-factor"),
          retry(),
        ]);
      if (code === "200")
        return answer(
          "not_business_admin",
          `Only an admin of ${vars.business ?? "your business portfolio"} can create a catalog. Ask an admin to connect Facebook in Edwyz, or to make you an admin.`,
          [connectAgain, opensMeta("business_settings_people", "Open business settings")],
        );
      break;
    case "use_new_catalog":
      if (PERMISSION_CODES.has(code))
        return answer("new_catalog_no_access", "Facebook didn't let Edwyz use the new catalog. Connect again and, for catalogs, choose 'All current and future catalogs'.", [connectAgain]);
      break;
    case "link_whatsapp":
      if (code === "200" || code === "10")
        return answer(
          "whatsapp_no_access",
          "Facebook didn't give Edwyz access to your WhatsApp account. Connect again and select it, or connect the catalog in WhatsApp Manager.",
          [connectAgain, opensMeta("whatsapp_manager_catalog", "Open WhatsApp Manager")],
        );
      if (code === "100")
        return answer("whatsapp_other_business", "WhatsApp can only use a shop catalog from the same business as your WhatsApp number.", [navigate("/app/shop/setup", "Create a new catalog")]);
      return answer(
        "whatsapp_link_failed",
        "Meta didn't let Edwyz connect the catalog to your WhatsApp number. You can do it in WhatsApp Manager: Account tools > Catalog > Choose a catalog.",
        [opensMeta("whatsapp_manager_catalog", "Open WhatsApp Manager"), retry("Check again")],
      );
    case "whatsapp_settings":
      return answer("whatsapp_settings_failed", "We couldn't change your WhatsApp shop settings. Try again in a minute.", [retry()]);
    case "delete_catalog":
      return answer("catalog_in_use", "This catalog is used by running ads or other apps. Stop those ads first, or delete it in Commerce Manager.", [
        opensMeta("commerce_manager", "Open Commerce Manager"),
      ]);
    case "delete_collection":
      return answer("collection_in_use", "This collection is used by a running ad. Pause the ad first.");
    case "send_products":
      if (code === "131009" || code === "131026")
        return answer("product_not_found", `WhatsApp couldn't find ${vars.product ? `'${vars.product}'` : "this product"} in your shop yet. Wait until it shows 'Live on WhatsApp'.`);
      break;
    case "send_product_template":
      return answer("product_template_refused", "WhatsApp refused the product template. Check that the products are live and try again.");
    case "catalog_sync":
    case "whatsapp_account":
      break;
  }
  return fallbackCopy(context);
}

/** The line for an answer no row of 3.8 covers. */
function fallbackCopy(context: MetaAnswerContext): MetaAnswerCopy {
  switch (context) {
    case "create_catalog":
    case "use_new_catalog":
      return answer("catalog_create_failed", "Meta couldn't create your catalog right now. Try again in a few minutes.", [retry()]);
    case "send_products":
      return answer("send_failed", "WhatsApp couldn't send these products. Try again in a minute.", [retry()]);
    case "catalog_sync":
      return answer("sync_failed", "Meta didn't accept the last changes. We'll send them again soon.", [], true);
    default:
      return answer("meta_failed", "Meta didn't accept this change. Try again in a few minutes.", [retry()]);
  }
}

// ----- Shopify and plan copy (2.5) -----

export function shopifyScopeCopy(): MetaAnswerCopy {
  return answer(
    "shopify_scope",
    "Your Shopify app can't read products yet. In Shopify admin: Settings > Apps and sales channels > Develop apps > your app > Configuration. Under Admin API scopes tick read_products and read_inventory, save, then click Install app. Then press Sync now.",
    [navigate("/app/shop/settings", "Sync now")],
  );
}

/** "Your Shopify store uses USD but your WhatsApp shop uses INR. Products were not copied." */
export function shopifyCurrencyText(shopifyCurrency: string, shopCurrency: string): string {
  return `Your Shopify store uses ${shopifyCurrency} but your WhatsApp shop uses ${shopCurrency}. Products were not copied.`;
}

/** "Your plan allows up to 500 products. 37 Shopify products were not added. Upgrade your plan at /app/billing." */
export function planLimitText(limit: number, skipped: number, source: "Shopify" | "CSV" | null = "Shopify"): string {
  const what = source ? `${source} products` : "products";
  return `Your plan allows up to ${limit.toLocaleString("en-IN")} products. ${skipped.toLocaleString("en-IN")} ${skipped === 1 ? what.replace(/s$/, "") : what} ${skipped === 1 ? "was" : "were"} not added. Upgrade your plan at /app/billing.`;
}

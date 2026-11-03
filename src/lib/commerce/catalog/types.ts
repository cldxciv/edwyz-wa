/**
 * Shared shapes of the Meta catalog and WhatsApp commerce feature (docs/specs/META-CATALOG-COMMERCE-SPEC.md 3.10 and 4.4).
 *
 * Pure and safe in the browser: no database, no network, no Graph. The JSON columns (CommerceCatalog.settings,
 * CatalogProduct.extra and issues, CommerceOrder.items, address and history, Message.commerceRef, Broadcast.productParams)
 * are validated in TypeScript against these types (fields.ts, messages.ts, orders/parse.ts), never trusted as stored.
 */
import type { MoneyDTO } from "@/lib/spend/money";

export type { MoneyDTO };

// ----- Enumerations (the CHECK constraints of migration 0021, in the same order) -----

export const MANAGED_BY = ["edwyz", "external"] as const;
export type ManagedBy = (typeof MANAGED_BY)[number];

export const WA_LINK_STATES = ["linking", "linked", "failed", "needs_meta"] as const;
export type WaLinkState = (typeof WA_LINK_STATES)[number];

export const PRODUCT_SOURCES = ["manual", "csv", "shopify", "meta"] as const;
export type ProductSource = (typeof PRODUCT_SOURCES)[number];

export const AVAILABILITY = ["in stock", "out of stock"] as const;
export type Availability = (typeof AVAILABILITY)[number];

export const CONDITIONS = ["new", "refurbished", "used"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const PRODUCT_STATUSES = ["active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PRODUCT_SYNC_STATES = ["pending", "sending", "checking", "synced", "failed", "deleting", "external"] as const;
export type ProductSyncState = (typeof PRODUCT_SYNC_STATES)[number];

export const REVIEW_STATUSES = ["approved", "pending", "rejected", "outdated"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const GENDERS = ["female", "male", "unisex"] as const;
export type Gender = (typeof GENDERS)[number];

export const AGE_GROUPS = ["adult", "all ages", "teen", "kids", "toddler", "infant", "newborn"] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

export const ORDER_STATUSES = ["new", "confirmed", "packed", "shipped", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ["unpaid", "paid", "cod", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Meta's `wa_compliance_category`, case-sensitive. */
export const WA_COMPLIANCE_CATEGORIES = ["DEFAULT", "COUNTRY_ORIGIN_EXEMPT"] as const;
export type WaComplianceCategory = (typeof WA_COMPLIANCE_CATEGORIES)[number];

// ----- JSON columns (4.4) -----

/** CommerceCatalog.settings. */
export type CatalogSettings = {
  /** https only. */
  website: string | null;
  defaultBrand: string | null;
  /** A Google product category id (or full path). */
  defaultCategory: string | null;
  /** Hosted product pages, default true. */
  publicPages: boolean;
  shopify: {
    enabled: boolean;
    storeId: string | null;
    lastPullAt: string | null;
    lastFullPullAt: string | null;
    lastError: string | null;
    skippedByPlan: number;
  };
};

/** The importer of a product made outside India (Meta's importer_name and importer_address). */
export type ProductImporter = { name: string; street1: string; street2?: string; city: string; region?: string; postalCode?: string; country: string };

/** CatalogProduct.extra. */
export type ProductExtra = {
  color?: string;
  size?: string;
  gender?: Gender;
  ageGroup?: AgeGroup;
  importer?: ProductImporter;
  /** A service or a digital item: wa_compliance_category COUNTRY_ORIGIN_EXEMPT and no country of origin. */
  exempt?: boolean;
  shopifyInventoryItemId?: string;
};

export const ISSUE_CODES = ["image", "image_link", "price", "missing", "link", "duplicate", "text", "policy", "unknown"] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

/** CatalogProduct.issues entries. metaText is Meta's own words: untrusted, at most 200 characters. */
export type ProductIssue = { code: IssueCode; field?: string; metaText?: string };

/** CatalogSyncRun.sample entries. */
export type SyncSample = { retailerId: string; code: IssueCode; metaText?: string };

/** CommerceOrder.items entries. Title and photo are copied from the product mirror when the order arrives. */
export type OrderLine = {
  retailerId: string;
  quantity: number;
  /** Minor units as a decimal string, or null when Meta sent no usable price. */
  unitPriceMinor: string | null;
  currency: string | null;
  title: string | null;
  imageUrl: string | null;
};

/** CommerceOrder.address. */
export type OrderAddress = { name?: string; line1: string; line2?: string; city: string; state?: string; pincode: string; phone?: string };

/** CommerceOrder.history entries. */
export type OrderEvent = {
  status: OrderStatus;
  at: string;
  byUserId: string | null;
  via: "page" | "eddy" | "api";
  notified: boolean;
  messageId?: string;
  failure?: string;
};

export const COMMERCE_REF_KINDS = ["inquiry", "product", "product_list", "catalog", "carousel", "template", "order"] as const;
export type CommerceRefKind = (typeof COMMERCE_REF_KINDS)[number];

/** Message.commerceRef: product ids only, never text. */
export type CommerceRef = { kind: CommerceRefKind; catalogId: string | null; retailerIds: string[]; orderId?: string };

export const PRODUCT_TEMPLATE_KINDS = ["catalog", "mpm", "spm", "carousel"] as const;
export type ProductTemplateKind = (typeof PRODUCT_TEMPLATE_KINDS)[number];

/** Broadcast.productParams, and the product choice of a chat template send. */
export type ProductParams =
  | { kind: "catalog"; thumbnailRetailerId?: string }
  | { kind: "mpm"; thumbnailRetailerId: string; sections: { title: string; retailerIds: string[] }[] }
  | { kind: "spm"; retailerId: string }
  | { kind: "carousel"; retailerIds: string[] };

// ----- Response shapes (3.10), consumed by the UI packages -----

/** The plain state of a product, one per pill (2.3). */
export type ProductState = "live" | "checking" | "pending" | "sending" | "problem" | "rejected" | "updating" | "deleting" | "hidden";

/** The design system's status tones (src/components/ui/status.ts), repeated here so lib code does not import components. */
export type StateTone = "neutral" | "good" | "warn" | "bad" | "info";

export type ProductDTO = {
  id: string;
  retailerId: string;
  title: string;
  description: string;
  price: MoneyDTO;
  salePrice: MoneyDTO | null;
  availability: Availability;
  quantity: number | null;
  imageUrl: string | null;
  extraImageUrls: string[];
  link: string | null;
  brand: string | null;
  category: string | null;
  source: ProductSource;
  readOnly: boolean;
  lockedFields: string[];
  state: ProductState;
  issues: { code: string; text: string; metaText?: string }[];
  updatedAt: string;
};

/** A one-tap fix shown next to a readiness row or a Meta answer. `target` is a path, `connect_facebook` or an Opens Meta key. */
export type ShopFix = { kind: "navigate" | "connect_facebook" | "opens_meta"; target: string; label: string };

export type ShopStatusDTO = {
  enabled: boolean;
  readiness: { key: string; ok: boolean; text: string; fix?: ShopFix }[];
  catalog: null | {
    id: string;
    name: string;
    metaCatalogId: string;
    business: { id: string; name: string } | null;
    managedBy: ManagedBy;
    currency: string;
    publicSlug: string;
    shopPageUrl: string | null;
    /** wa.me/c/<number> */
    shopLink: string | null;
    whatsapp: {
      state: WaLinkState | null;
      linkedAt: string | null;
      numbers: { phoneNumberId: string; displayPhone: string; cartEnabled: boolean | null; catalogVisible: boolean | null }[];
    };
    counts: { products: number; live: number; checking: number; problems: number; pending: number };
    sync: { state: string; lastSyncAt: string | null; note: string | null };
    complianceNeeded: boolean;
  };
};

export type OrderDTO = {
  id: string;
  number: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  orderedAt: string;
  contact: { id: string; name: string | null; phoneMasked: string };
  conversationId: string;
  items: { retailerId: string; title: string | null; imageUrl: string | null; quantity: number; unitPrice: MoneyDTO | null; lineTotal: MoneyDTO | null }[];
  itemCount: number;
  total: MoneyDTO | null;
  customerNote: string | null;
  address: OrderAddress | null;
  internalNote: string | null;
  trackingUrl: string | null;
  cancelReason: string | null;
  history: { status: OrderStatus; at: string; by: { id: string; name: string } | null; notified: boolean; failure?: string }[];
  window: { open: boolean; closesAt: string | null };
  updatedAt: string;
};

// ----- Errors -----

/**
 * A request that breaks a commerce rule, with words a shop owner can act on. `status` is 400 so a route's error handler can
 * answer it like an HttpError; `field` names the input it is about, when there is one.
 */
export class CommerceInputError extends Error {
  readonly status = 400;
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "CommerceInputError";
  }
}

// ----- Small shared helpers -----

/** True for a value in a readonly list of literals, narrowing it. */
export function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/**
 * Text from outside (a form, a CSV cell, Shopify, Meta) made safe to store: control characters removed (tabs and line
 * breaks too unless `multiline`), Windows line breaks unified, and trimmed.
 */
export function cleanText(value: unknown, multiline = false): string {
  if (typeof value !== "string") return "";
  const unified = value.replace(/\r\n?/g, "\n");
  const stripped = multiline ? unified.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "") : unified.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
  return stripped.trim();
}

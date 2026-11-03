/**
 * Products for Meta (docs/specs/META-CATALOG-COMMERCE-SPEC.md 2.1, 2.3, 3.4 and 4.4). Pure and safe in the browser: no
 * database, no network, no Graph, no Node built-ins (the hash is computed here, so the product form can share these rules).
 *
 * - defaults(): the smart defaults of 2.1.
 * - validateProduct(): one rule set for the product form, CSV rows, Eddy and Shopify, with errors in plain words per field.
 * - toMetaItem(): a product as one `items_batch` UPDATE item, following the mapping table of 3.4.
 * - itemHash(): the sha256 stored as CatalogProduct.syncedHash, so an unchanged product is never sent again.
 * - parse and validate CommerceCatalog.settings (CatalogSettings) and CatalogProduct.extra (ProductExtra).
 */
import { type MinorInput, toMinor } from "@/lib/spend/money";
import { categoryFromText, categoryLabel } from "./categories";
import { DEFAULT_SHOP_CURRENCY, maxPriceMinor, metaPrice, parseRupees, priceExample, priceProblemText } from "./money";
import { retailerIdProblem } from "./retailer-id";
import {
  AGE_GROUPS,
  type AgeGroup,
  type Availability,
  AVAILABILITY,
  type CatalogSettings,
  cleanText,
  type Condition,
  CONDITIONS,
  GENDERS,
  type Gender,
  oneOf,
  type ProductExtra,
  type ProductImporter,
  type ProductStatus,
  PRODUCT_STATUSES,
  type WaComplianceCategory,
} from "./types";

export { metaPrice, parseRupees };

// =====================================================================================================================
// Limits
// =====================================================================================================================

export const FIELD_LIMITS = Object.freeze({
  title: 200,
  /** The name shows in full on WhatsApp up to about this length; the form's counter turns amber after it. */
  titleShowsFully: 65,
  description: 9999,
  brand: 100,
  link: 2000,
  /** Extra photos: 9 more (10 in all). Meta takes up to 50, but Edwyz keeps the list short. */
  extraImages: 9,
  /** additional_image_link is one comma-separated string of at most 2,000 characters. */
  extraImagesJoined: 2000,
  category: 250,
  itemGroupId: 100,
  color: 100,
  size: 100,
  quantity: 10_000_000,
  imageKey: 200,
  importerName: 128,
  importerLine: 200,
  importerCity: 100,
  importerRegion: 100,
  importerPostalCode: 20,
  catalogName: 100,
});

const SHOP_PAGE_DEFAULT_COUNTRY = "IN";

// =====================================================================================================================
// Smart defaults (2.1)
// =====================================================================================================================

export type DefaultsInput = {
  workspaceName: string;
  /** The workspace's WhatsApp number in any format ("+91 98765 43210", "919876543210"). */
  whatsappNumber?: string | null;
  /** The currency of the workspace's ad account, when it has one. */
  adAccountCurrency?: string | null;
  /** The business portfolios the person can act for (me/businesses). */
  businesses?: readonly { id: string; name?: string | null }[];
  /** The business that owns the WhatsApp account (Waba.businessId). */
  wabaBusinessId?: string | null;
};

export type ShopDefaults = {
  catalogName: string;
  currency: string;
  /** The portfolio to create the catalog in, or null when the owner must choose. */
  businessId: string | null;
  brand: string;
  condition: Condition;
  availability: Availability;
  originCountry: string;
  waComplianceCategory: WaComplianceCategory;
  catalogVisible: boolean;
  cartEnabled: boolean;
  orderAckEnabled: boolean;
  firstOrderNumber: number;
  collections: readonly { kind: "all" | "in_stock" | "on_sale"; name: string }[];
  productList: { header: string; body: string };
  catalogMessageBody: string;
};

/** The three collections made automatically (D-C22). */
export const AUTOMATIC_COLLECTIONS = Object.freeze([
  { kind: "all", name: "All products" },
  { kind: "in_stock", name: "In stock" },
  { kind: "on_sale", name: "On sale" },
] as const);

/** True when a WhatsApp number is an Indian (+91) number. No other country code starts with 91. */
export function isIndianNumber(number: string | null | undefined): boolean {
  return String(number ?? "").replace(/\D/g, "").startsWith("91");
}

/** "{Workspace name} shop", at most 100 characters; "My shop" without a name. */
export function defaultCatalogName(workspaceName: string | null | undefined): string {
  const name = cleanText(workspaceName);
  if (!name) return "My shop";
  const suffix = " shop";
  return `${name.slice(0, FIELD_LIMITS.catalogName - suffix.length).trim()}${suffix}`;
}

/** The smart defaults of 2.1 for a workspace. */
export function defaults(input: DefaultsInput): ShopDefaults {
  const ad = String(input.adAccountCurrency ?? "").toUpperCase();
  const currency = isIndianNumber(input.whatsappNumber) ? "INR" : /^[A-Z]{3}$/.test(ad) ? ad : DEFAULT_SHOP_CURRENCY;
  const businesses = input.businesses ?? [];
  const businessId =
    businesses.length === 1 ? businesses[0].id : input.wabaBusinessId && businesses.some((b) => b.id === input.wabaBusinessId) ? input.wabaBusinessId : null;
  return {
    catalogName: defaultCatalogName(input.workspaceName),
    currency,
    businessId,
    brand: cleanText(input.workspaceName).slice(0, FIELD_LIMITS.brand) || "My shop",
    condition: "new",
    availability: "in stock",
    originCountry: SHOP_PAGE_DEFAULT_COUNTRY,
    waComplianceCategory: "DEFAULT",
    catalogVisible: true,
    cartEnabled: true,
    orderAckEnabled: true,
    firstOrderNumber: 1001,
    collections: AUTOMATIC_COLLECTIONS,
    productList: { header: "Our picks for you", body: "Tap to see prices and add to cart." },
    catalogMessageBody: "Browse our shop and send us your order from here.",
  };
}

/**
 * The description sent when the owner leaves it empty (critic, 2.1): "{name}. {Category} from {brand}." Meta wants a
 * description that differs from the title, so the name alone is never used.
 */
export function defaultDescription(title: string, category: string | null | undefined, brand: string | null | undefined): string {
  const name = cleanText(title).replace(/[.\s]+$/, "");
  const label = categoryLabel(category);
  const who = cleanText(brand);
  if (label && who) return `${name}. ${label} from ${who}.`;
  if (label) return `${name}. ${label}.`;
  if (who) return `${name}. From ${who}.`;
  return `${name}. Available on WhatsApp.`;
}

// =====================================================================================================================
// Small validators
// =====================================================================================================================

const HTTPS_RE = /^https:\/\/[^\s<>"'`]+$/i;

/** A clean https link of at most 2,000 characters, or null. */
export function httpsLink(value: unknown): string | null {
  const link = typeof value === "string" ? value.trim() : "";
  return link && link.length <= FIELD_LIMITS.link && HTTPS_RE.test(link) ? link : null;
}

const LINK_IN_TEXT = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|in|net|org|shop|store|io|app|link|ly|me)\b/i;

/** True when the text holds a web link (Meta refuses links in descriptions). */
export function hasLink(text: string): boolean {
  return LINK_IN_TEXT.test(text);
}

/** True when the text is written in capital letters only (at least 8 Latin letters and none small). Other scripts never are. */
export function isAllCaps(text: string): boolean {
  const letters = text.match(/[A-Za-z]/g);
  return !!letters && letters.length >= 8 && letters.every((c) => c >= "A" && c <= "Z");
}

const lengthOf = (s: string) => [...s].length;

// =====================================================================================================================
// ProductExtra and CatalogSettings (4.4)
// =====================================================================================================================

export type FieldErrors = Record<string, string>;
export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function boundedText(value: unknown, max: number): string | null {
  const t = cleanText(value);
  return t && lengthOf(t) <= max ? t : null;
}

function importerOf(raw: unknown, errors: FieldErrors | null): ProductImporter | undefined {
  if (!isRec(raw)) {
    if (errors && raw !== undefined && raw !== null) errors.importer = "Add the importer's name and address.";
    return undefined;
  }
  const name = boundedText(raw.name, FIELD_LIMITS.importerName);
  const street1 = boundedText(raw.street1, FIELD_LIMITS.importerLine);
  const city = boundedText(raw.city, FIELD_LIMITS.importerCity);
  const country = cleanText(raw.country).toUpperCase();
  if (!name || !street1 || !city || !/^[A-Z]{2}$/.test(country)) {
    if (errors) errors.importer = "Add the importer's name, street, city and country (two letters, like AE).";
    return undefined;
  }
  const street2 = boundedText(raw.street2, FIELD_LIMITS.importerLine);
  const region = boundedText(raw.region, FIELD_LIMITS.importerRegion);
  const postalCode = boundedText(raw.postalCode, FIELD_LIMITS.importerPostalCode);
  return { name, street1, ...(street2 ? { street2 } : {}), city, ...(region ? { region } : {}), ...(postalCode ? { postalCode } : {}), country };
}

function extraOf(raw: unknown, errors: FieldErrors | null): ProductExtra {
  if (!isRec(raw)) return {};
  const out: ProductExtra = {};
  const text = (key: "color" | "size", max: number, label: string) => {
    const v = raw[key];
    if (v === undefined || v === null || v === "") return;
    const t = boundedText(v, max);
    if (t) out[key] = t;
    else if (errors) errors[key] = `Use at most ${max} characters for the ${label}.`;
  };
  text("color", FIELD_LIMITS.color, "colour");
  text("size", FIELD_LIMITS.size, "size");
  if (raw.gender !== undefined && raw.gender !== null && raw.gender !== "") {
    if (oneOf<Gender>(GENDERS, raw.gender)) out.gender = raw.gender;
    else if (errors) errors.gender = "Choose female, male or unisex.";
  }
  if (raw.ageGroup !== undefined && raw.ageGroup !== null && raw.ageGroup !== "") {
    if (oneOf<AgeGroup>(AGE_GROUPS, raw.ageGroup)) out.ageGroup = raw.ageGroup;
    else if (errors) errors.ageGroup = "Choose an age group from the list.";
  }
  if (raw.importer !== undefined && raw.importer !== null) {
    const importer = importerOf(raw.importer, errors);
    if (importer) out.importer = importer;
  }
  if (raw.exempt !== undefined && raw.exempt !== null) {
    if (typeof raw.exempt === "boolean") {
      if (raw.exempt) out.exempt = true;
    } else if (errors) errors.exempt = "Choose yes or no.";
  }
  if (typeof raw.shopifyInventoryItemId === "string" && /^[A-Za-z0-9:/._-]{1,100}$/.test(raw.shopifyInventoryItemId)) {
    out.shopifyInventoryItemId = raw.shopifyInventoryItemId;
  }
  return out;
}

/** CatalogProduct.extra as stored, with anything malformed dropped. Never throws. */
export function parseProductExtra(raw: unknown): ProductExtra {
  return extraOf(raw, null);
}

/** CatalogProduct.extra from a request: errors in plain words per field. */
export function validateProductExtra(raw: unknown): Validated<ProductExtra> {
  if (raw !== undefined && raw !== null && !isRec(raw)) return { ok: false, errors: { extra: "More details must be a list of fields." } };
  const errors: FieldErrors = {};
  const value = extraOf(raw ?? {}, errors);
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

export const DEFAULT_CATALOG_SETTINGS: CatalogSettings = Object.freeze({
  website: null,
  defaultBrand: null,
  defaultCategory: null,
  publicPages: true,
  shopify: Object.freeze({ enabled: false, storeId: null, lastPullAt: null, lastFullPullAt: null, lastError: null, skippedByPlan: 0 }),
}) as CatalogSettings;

const isoOrNull = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

/** CommerceCatalog.settings as stored, with defaults for anything missing or malformed. Never throws. */
export function parseCatalogSettings(raw: unknown): CatalogSettings {
  const r = isRec(raw) ? raw : {};
  const s = isRec(r.shopify) ? r.shopify : {};
  const skipped = typeof s.skippedByPlan === "number" && Number.isSafeInteger(s.skippedByPlan) && s.skippedByPlan >= 0 ? s.skippedByPlan : 0;
  return {
    website: httpsLink(r.website),
    defaultBrand: boundedText(r.defaultBrand, FIELD_LIMITS.brand),
    defaultCategory: boundedText(r.defaultCategory, FIELD_LIMITS.category),
    publicPages: typeof r.publicPages === "boolean" ? r.publicPages : true,
    shopify: {
      enabled: s.enabled === true,
      storeId: typeof s.storeId === "string" && s.storeId ? s.storeId.slice(0, 100) : null,
      lastPullAt: isoOrNull(s.lastPullAt),
      lastFullPullAt: isoOrNull(s.lastFullPullAt),
      lastError: typeof s.lastError === "string" && s.lastError ? cleanText(s.lastError).slice(0, 500) : null,
      skippedByPlan: skipped,
    },
  };
}

/** The settings an owner may change on Shop settings (Shopify sync has its own card and route). */
export type CatalogSettingsPatch = Partial<Pick<CatalogSettings, "website" | "defaultBrand" | "defaultCategory" | "publicPages">>;
const PATCHABLE = new Set(["website", "defaultBrand", "defaultCategory", "publicPages"]);

/** A change to CommerceCatalog.settings from a request. A null clears a text setting. */
export function validateCatalogSettingsPatch(raw: unknown): Validated<CatalogSettingsPatch> {
  if (!isRec(raw)) return { ok: false, errors: { settings: "Send the settings to change." } };
  const errors: FieldErrors = {};
  const out: CatalogSettingsPatch = {};
  for (const key of Object.keys(raw)) if (!PATCHABLE.has(key)) errors[key] = "This setting can't be changed here.";
  if ("website" in raw) {
    if (raw.website === null || raw.website === "") out.website = null;
    else {
      const link = httpsLink(raw.website);
      if (link) out.website = link;
      else errors.website = "Use a full website link starting with https://.";
    }
  }
  if ("defaultBrand" in raw) {
    if (raw.defaultBrand === null || cleanText(raw.defaultBrand) === "") out.defaultBrand = null;
    else {
      const brand = boundedText(raw.defaultBrand, FIELD_LIMITS.brand);
      if (brand) out.defaultBrand = brand;
      else errors.defaultBrand = `Use at most ${FIELD_LIMITS.brand} characters for the brand.`;
    }
  }
  if ("defaultCategory" in raw) {
    if (raw.defaultCategory === null || cleanText(raw.defaultCategory) === "") out.defaultCategory = null;
    else if (typeof raw.defaultCategory !== "string" || lengthOf(raw.defaultCategory.trim()) > FIELD_LIMITS.category) errors.defaultCategory = "Choose a category from the list.";
    else out.defaultCategory = categoryFromText(raw.defaultCategory);
  }
  if ("publicPages" in raw) {
    if (typeof raw.publicPages === "boolean") out.publicPages = raw.publicPages;
    else errors.publicPages = "Choose on or off.";
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

/** The stored settings with a validated patch applied. */
export function applyCatalogSettingsPatch(current: unknown, patch: CatalogSettingsPatch): CatalogSettings {
  const base = parseCatalogSettings(current);
  return { ...base, ...patch, shopify: { ...base.shopify } };
}

// =====================================================================================================================
// validateProduct
// =====================================================================================================================

/** A product as a request, a CSV row, Eddy or the Shopify mapping hands it in. Prices come typed (major units) or in minor units. */
export type ProductInput = {
  /** The product code; null or missing means "make one" (manual) or "keep the stored one" (edit). */
  retailerId?: string | null;
  title?: unknown;
  description?: unknown;
  /** The price as typed, in major units ("799", "₹1,299.00"). */
  price?: string | number | null;
  /** The price in minor units, for callers that already have it (Shopify, the mirror). Wins over `price`. */
  priceMinor?: MinorInput | null;
  salePrice?: string | number | null;
  salePriceMinor?: MinorInput | null;
  availability?: unknown;
  /** The form's "In stock" switch, used when `availability` is not given. */
  inStock?: boolean;
  quantity?: unknown;
  condition?: unknown;
  brand?: unknown;
  link?: unknown;
  /** An uploaded photo's file key, or a photo link (CSV, Shopify). One of them is needed. */
  imageKey?: unknown;
  imageUrl?: unknown;
  extraImageUrls?: unknown;
  extraImageKeys?: unknown;
  category?: unknown;
  itemGroupId?: unknown;
  originCountry?: unknown;
  extra?: unknown;
  status?: unknown;
};

export type ValidateProductOptions = {
  currency: string;
  /** Default true: a product needs a photo (Meta requires image_link). */
  requirePhoto?: boolean;
  /** Apply the stricter rule of codes Edwyz makes. */
  generatedCode?: boolean;
};

/** A product ready to store: the CatalogProduct columns this package decides. */
export type ValidProduct = {
  retailerId: string | null;
  title: string;
  description: string;
  brand: string | null;
  link: string | null;
  imageKey: string | null;
  imageUrl: string | null;
  extraImageUrls: string[];
  extraImageKeys: string[];
  priceMinor: bigint;
  salePriceMinor: bigint | null;
  currency: string;
  availability: Availability;
  quantity: number | null;
  condition: Condition;
  category: string | null;
  itemGroupId: string | null;
  originCountry: string | null;
  extra: ProductExtra;
  status: ProductStatus;
};

const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

function minorOf(value: MinorInput, currency: string): bigint | "bad" | "zero" | "large" {
  let minor: bigint;
  try {
    minor = toMinor(value);
  } catch {
    return "bad";
  }
  if (minor <= 0n) return "zero";
  return minor > maxPriceMinor(currency) ? "large" : minor;
}

function priceOf(minorInput: MinorInput | null | undefined, typed: unknown, currency: string, label: string): { minor: bigint | null; error?: string } {
  if (!blank(minorInput)) {
    const m = minorOf(minorInput as MinorInput, currency);
    if (m === "bad") return { minor: null, error: `The ${label} isn't a valid amount. Write it like ${priceExample(currency)}.` };
    if (m === "zero") return { minor: null, error: priceProblemText("zero", "", currency, label) };
    if (m === "large") return { minor: null, error: priceProblemText("too_large", String(minorInput), currency, label) };
    return { minor: m };
  }
  if (blank(typed)) return { minor: null };
  const parsed = parseRupees(typed as string | number, currency);
  return parsed.ok ? { minor: parsed.minor } : { minor: null, error: priceProblemText(parsed.problem, typed, currency, label) };
}

const IMAGE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function availabilityOf(value: unknown, inStock: boolean | undefined): Availability | null {
  if (blank(value)) return inStock === false ? "out of stock" : "in stock";
  const v = String(value).trim().toLowerCase().replace(/_/g, " ");
  return oneOf<Availability>(AVAILABILITY, v) ? v : null;
}

/**
 * Checks a product against the rules of 2.3 and 3.4 and returns it ready to store, or the errors in plain words per field
 * (title, description, price, salePrice, availability, quantity, condition, brand, link, photo, extraImages, category,
 * itemGroupId, originCountry, importer, retailerId, status and the extra fields).
 */
export function validateProduct(input: ProductInput, opts: ValidateProductOptions): Validated<ValidProduct> {
  const errors: FieldErrors = {};
  const currency = String(opts.currency || DEFAULT_SHOP_CURRENCY).toUpperCase();

  const title = cleanText(input.title);
  if (!title) errors.title = "Add a product name.";
  else if (lengthOf(title) > FIELD_LIMITS.title) errors.title = `Use at most ${FIELD_LIMITS.title} characters for the name.`;

  const description = cleanText(input.description, true);
  if (lengthOf(description) > FIELD_LIMITS.description) errors.description = "Use at most 9,999 characters for the description.";
  else if (description && (hasLink(description) || isAllCaps(description))) errors.description = "Meta doesn't allow links or all-capital text in descriptions.";

  const price = priceOf(input.priceMinor, input.price, currency, "price");
  if (price.error) errors.price = price.error;
  else if (price.minor === null) errors.price = "Add a price.";
  const sale = priceOf(input.salePriceMinor, input.salePrice, currency, "sale price");
  if (sale.error) errors.salePrice = sale.error;
  else if (sale.minor !== null && price.minor !== null && sale.minor >= price.minor) errors.salePrice = "The sale price must be lower than the price.";

  const availability = availabilityOf(input.availability, input.inStock);
  if (!availability) errors.availability = "Choose in stock or out of stock.";

  let quantity: number | null = null;
  if (!blank(input.quantity)) {
    const q = typeof input.quantity === "number" ? input.quantity : /^\s*\d{1,9}\s*$/.test(String(input.quantity)) ? Number(input.quantity) : NaN;
    if (Number.isSafeInteger(q) && q >= 0 && q <= FIELD_LIMITS.quantity) quantity = q;
    else errors.quantity = "Write how many you have as a whole number, like 12.";
  }

  const conditionRaw = blank(input.condition) ? "new" : String(input.condition).trim().toLowerCase();
  if (!oneOf<Condition>(CONDITIONS, conditionRaw)) errors.condition = "Choose new, refurbished or used.";

  let brand: string | null = null;
  if (!blank(input.brand)) {
    brand = cleanText(input.brand);
    if (lengthOf(brand) > FIELD_LIMITS.brand) errors.brand = `Use at most ${FIELD_LIMITS.brand} characters for the brand.`;
  }

  let link: string | null = null;
  if (!blank(input.link)) {
    link = httpsLink(input.link);
    if (!link) errors.link = "Use a full website link starting with https://, or leave it empty to use your shop page.";
  }

  let imageKey: string | null = null;
  let imageUrl: string | null = null;
  if (!blank(input.imageKey)) {
    if (typeof input.imageKey === "string" && IMAGE_KEY_RE.test(input.imageKey)) imageKey = input.imageKey;
    else errors.photo = "Upload the photo again.";
  }
  if (!blank(input.imageUrl)) {
    imageUrl = httpsLink(input.imageUrl);
    if (!imageUrl) errors.photo = "The photo link must start with https://.";
  }
  if (!errors.photo && !imageKey && !imageUrl && opts.requirePhoto !== false) errors.photo = "Add a photo.";

  const extraImageUrls: string[] = [];
  if (!blank(input.extraImageUrls)) {
    const list = Array.isArray(input.extraImageUrls) ? input.extraImageUrls : null;
    if (!list || list.length > FIELD_LIMITS.extraImages) errors.extraImages = `Add at most ${FIELD_LIMITS.extraImages} more photos.`;
    else
      for (const item of list) {
        const url = httpsLink(item);
        if (!url) {
          errors.extraImages = "Every photo link must start with https://.";
          break;
        }
        extraImageUrls.push(url);
      }
  }
  const extraImageKeys: string[] = [];
  if (!blank(input.extraImageKeys)) {
    const list = Array.isArray(input.extraImageKeys) ? input.extraImageKeys : null;
    if (!list || list.length > FIELD_LIMITS.extraImages) errors.extraImages = `Add at most ${FIELD_LIMITS.extraImages} more photos.`;
    else if (list.some((k) => typeof k !== "string" || !IMAGE_KEY_RE.test(k))) errors.extraImages = "Upload the extra photos again.";
    else extraImageKeys.push(...(list as string[]));
  }

  let category: string | null = null;
  if (!blank(input.category)) {
    if (typeof input.category !== "string" || lengthOf(input.category.trim()) > FIELD_LIMITS.category) errors.category = "Choose a category from the list.";
    else category = categoryFromText(input.category);
  }

  let itemGroupId: string | null = null;
  if (!blank(input.itemGroupId)) {
    itemGroupId = cleanText(input.itemGroupId);
    if (lengthOf(itemGroupId) > FIELD_LIMITS.itemGroupId) errors.itemGroupId = `Use at most ${FIELD_LIMITS.itemGroupId} characters for the variant group.`;
  }

  const extraResult = validateProductExtra(input.extra);
  const extra = extraResult.ok ? extraResult.value : {};
  if (!extraResult.ok) Object.assign(errors, extraResult.errors);

  let originCountry: string | null = null;
  if (!blank(input.originCountry)) {
    const c = String(input.originCountry).trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c)) originCountry = c;
    else errors.originCountry = "Choose the country it was made in.";
  }
  if (originCountry && originCountry !== SHOP_PAGE_DEFAULT_COUNTRY && !extra.exempt && !extra.importer && !errors.importer) {
    errors.importer = "Add the importer's name and address for products made outside India.";
  }

  const statusRaw = blank(input.status) ? "active" : input.status;
  if (!oneOf<ProductStatus>(PRODUCT_STATUSES, statusRaw)) errors.status = "Choose to show or hide the product.";

  let retailerId: string | null = null;
  if (!blank(input.retailerId)) {
    const code = String(input.retailerId).trim();
    const problem = retailerIdProblem(code, { generated: opts.generatedCode });
    if (problem) errors.retailerId = problem;
    else retailerId = code;
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      retailerId,
      title,
      description,
      brand,
      link,
      imageKey,
      imageUrl,
      extraImageUrls,
      extraImageKeys,
      priceMinor: price.minor as bigint,
      salePriceMinor: sale.minor,
      currency,
      availability: availability as Availability,
      quantity,
      condition: conditionRaw as Condition,
      category,
      itemGroupId,
      originCountry,
      extra,
      status: statusRaw as ProductStatus,
    },
  };
}

// =====================================================================================================================
// toMetaItem (3.4)
// =====================================================================================================================

/** A product as the sync engine reads it from CatalogProduct. */
export type ProductForMeta = {
  retailerId: string;
  title: string;
  description?: string | null;
  brand?: string | null;
  link?: string | null;
  imageUrl?: string | null;
  extraImageUrls?: readonly string[] | null;
  priceMinor: MinorInput;
  salePriceMinor?: MinorInput | null;
  currency: string;
  availability?: Availability | null;
  quantity?: number | null;
  condition?: Condition | null;
  category?: string | null;
  itemGroupId?: string | null;
  originCountry?: string | null;
  extra?: unknown;
  status?: ProductStatus | null;
};

export type MetaItemContext = {
  /** The brand when the product has none: the catalog's default brand, else the workspace name. */
  brand: string;
  /** The shop's own website (CatalogSettings.website), used when the product has no link. */
  website?: string | null;
  /** The hosted shop page base, "https://wa.edwyz.com/shop/<slug>", used when there is neither (V-C17). */
  shopPageBase?: string | null;
};

export type MetaImporterAddress = { street1: string; street2?: string; city: string; region?: string; postal_code?: string; country: string };
/** The `data` of one items_batch request. */
export type MetaItemData = Record<string, string | number | MetaImporterAddress>;
export type MetaItemRequest = { method: "UPDATE"; data: MetaItemData } | { method: "DELETE"; data: { id: string } };

/** The extra photo links Meta gets: https only, no repeats, at most 9 and at most 2,000 characters joined (the last are dropped). */
export function additionalImageLinks(urls: readonly unknown[] | null | undefined, mainImage?: string | null): string {
  const kept: string[] = [];
  let length = 0;
  for (const raw of urls ?? []) {
    if (kept.length >= FIELD_LIMITS.extraImages) break;
    const url = httpsLink(raw);
    if (!url || url.includes(",") || url === mainImage || kept.includes(url)) continue;
    const next = length + (kept.length ? 1 : 0) + url.length;
    if (next > FIELD_LIMITS.extraImagesJoined) break;
    kept.push(url);
    length = next;
  }
  return kept.join(",");
}

/** The product's link: its own, else the shop's website, else its hosted page; null when there is none of them. */
export function productLink(retailerId: string, link: string | null | undefined, ctx: MetaItemContext): string | null {
  const own = httpsLink(link);
  if (own) return own;
  const site = httpsLink(ctx.website);
  if (site) return site;
  const base = httpsLink(ctx.shopPageBase);
  return base ? `${base.replace(/\/+$/, "")}/${encodeURIComponent(retailerId)}` : null;
}

/**
 * One product as the `data` of an items_batch UPDATE (3.4). Every rule of the mapping table is here:
 * - prices as "799.00 INR"; a sale price only when lower than the price, and "" otherwise so an old one is cleared (V-C2);
 * - availability and condition with their defaults; quantity only when set;
 * - the default description when it is empty; the brand from the context when the product has none;
 * - India fields: origin_country (IN unless set), importer_name and importer_address only for a product made elsewhere,
 *   wa_compliance_category DEFAULT, or COUNTRY_ORIGIN_EXEMPT with no origin for a service or digital item;
 * - status "active" or "archived" (the current name of the old `visibility` field, D-C31);
 * - up to 9 extra photos in one comma-separated additional_image_link of at most 2,000 characters ("" clears them, V-C2).
 * The nested `status` is never seen by the spend tripwire, which reads only top-level parameters (3.9a).
 */
export function toMetaItem(product: ProductForMeta, ctx: MetaItemContext): MetaItemData {
  const currency = product.currency.toUpperCase();
  const priceMinor = toMinor(product.priceMinor);
  const saleMinor = product.salePriceMinor === null || product.salePriceMinor === undefined ? null : toMinor(product.salePriceMinor);
  const title = cleanText(product.title).slice(0, FIELD_LIMITS.title);
  const brand = (cleanText(product.brand) || cleanText(ctx.brand)).slice(0, FIELD_LIMITS.brand);
  const category = cleanText(product.category) || null;
  const description = cleanText(product.description, true).slice(0, FIELD_LIMITS.description) || defaultDescription(title, category, brand);
  const extra = parseProductExtra(product.extra);
  const imageLink = httpsLink(product.imageUrl);
  const link = productLink(product.retailerId, product.link, ctx);

  const data: MetaItemData = {
    id: product.retailerId,
    title,
    description,
    availability: product.availability ?? "in stock",
    condition: product.condition ?? "new",
    price: metaPrice(priceMinor, currency),
    sale_price: saleMinor !== null && saleMinor > 0n && saleMinor < priceMinor ? metaPrice(saleMinor, currency) : "",
  };
  if (link) data.link = link;
  if (imageLink) data.image_link = imageLink;
  data.additional_image_link = additionalImageLinks(product.extraImageUrls, imageLink);
  if (brand) data.brand = brand;
  if (category) data.google_product_category = category;
  if (product.quantity !== null && product.quantity !== undefined && Number.isSafeInteger(product.quantity) && product.quantity >= 0) {
    data.quantity_to_sell_on_facebook = product.quantity;
  }
  const group = cleanText(product.itemGroupId);
  if (group) data.item_group_id = group.slice(0, FIELD_LIMITS.itemGroupId);
  if (extra.color) data.color = extra.color;
  if (extra.size) data.size = extra.size;
  if (extra.gender) data.gender = extra.gender;
  if (extra.ageGroup) data.age_group = extra.ageGroup;
  if (extra.exempt) {
    data.wa_compliance_category = "COUNTRY_ORIGIN_EXEMPT";
  } else {
    const origin = /^[A-Za-z]{2}$/.test(String(product.originCountry ?? "")) ? String(product.originCountry).toUpperCase() : SHOP_PAGE_DEFAULT_COUNTRY;
    data.origin_country = origin;
    if (origin !== SHOP_PAGE_DEFAULT_COUNTRY && extra.importer) {
      const i = extra.importer;
      data.importer_name = i.name;
      data.importer_address = {
        street1: i.street1,
        ...(i.street2 ? { street2: i.street2 } : {}),
        city: i.city,
        ...(i.region ? { region: i.region } : {}),
        ...(i.postalCode ? { postal_code: i.postalCode } : {}),
        country: i.country,
      };
    }
    data.wa_compliance_category = "DEFAULT";
  }
  data.status = product.status === "archived" ? "archived" : "active";
  return data;
}

/** One items_batch UPDATE request for a product. */
export function toMetaRequest(product: ProductForMeta, ctx: MetaItemContext): MetaItemRequest {
  return { method: "UPDATE", data: toMetaItem(product, ctx) };
}

/** One items_batch DELETE request for a product code. */
export function toMetaDelete(retailerId: string): MetaItemRequest {
  return { method: "DELETE", data: { id: retailerId } };
}

// =====================================================================================================================
// itemHash
// =====================================================================================================================

/** JSON with object keys sorted at every level, so the same item always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
}

/** The sha256 of a Meta item (64 hex characters), stored as CatalogProduct.syncedHash. Same item, same hash; any sent field changes it. */
export function itemHash(item: MetaItemData): string {
  return sha256Hex(canonicalJson(item));
}

const K = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

const ror = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/**
 * SHA-256 of a text's UTF-8 bytes, as 64 lower-case hex characters (FIPS 180-4). Written out here so this file needs no
 * Node built-in and stays usable in the browser; tests compare it with node:crypto.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);
  const H = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const W = new Uint32Array(64);
  for (let block = 0; block < blocks; block++) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(block * 64 + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(W[i - 15], 7) ^ ror(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = ror(W[i - 2], 17) ^ ror(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] += a;
    H[1] += b;
    H[2] += c;
    H[3] += d;
    H[4] += e;
    H[5] += f;
    H[6] += g;
    H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}

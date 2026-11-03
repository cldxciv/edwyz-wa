/**
 * Product messages and product templates (docs/specs/META-CATALOG-COMMERCE-SPEC.md 3.5 and 3.6). Pure and safe in the browser:
 * no database, no network, no Graph.
 *
 * - The four `interactive` builders (catalog_message, product, product_list, carousel) return the object the send queue stores;
 *   the queue adds messaging_product, to and type. MESSAGE_LIMITS are checked before anything is queued, and
 *   normalizeProductInteractive re-checks a stored job, so a damaged job never reaches WhatsApp.
 * - describeProducts / describeProductMessage give the inbox text ("[products] Cotton kurta, Silk saree and 3 more");
 *   commerceRefFor gives Message.commerceRef (ids only).
 * - productTemplateKind, validateProductParams and buildProductTemplateComponents are shared by chat template sends and
 *   broadcasts, so neither has its own copy of the product rules.
 * - buildProductMessage and buildProductListMessage are the older builders, kept with their behaviour (catalog.ts re-exports them).
 */
import { isValidRetailerId } from "./catalog/retailer-id";
import { CommerceInputError, type CommerceRef, type ProductParams, type ProductTemplateKind } from "./catalog/types";

export const MESSAGE_LIMITS = Object.freeze({
  /** Message text of every product message. */
  body: 1024,
  footer: 60,
  /** The text header of a product list. */
  header: 60,
  /** A section title, required when a list has more than one section. */
  sectionTitle: 24,
  sections: 10,
  /** Products in one list (all sections together). */
  products: 30,
  carouselMin: 2,
  carouselMax: 10,
  /** Product codes and catalog ids. */
  code: 100,
});

// =====================================================================================================================
// Payload shapes (3.5)
// =====================================================================================================================

type Text = { text: string };

export type CatalogMessagePayload = {
  type: "catalog_message";
  body: Text;
  footer?: Text;
  action: { name: "catalog_message"; parameters?: { thumbnail_product_retailer_id: string } };
};
export type SingleProductPayload = {
  type: "product";
  body?: Text;
  footer?: Text;
  action: { catalog_id: string; product_retailer_id: string };
};
export type ProductListPayload = {
  type: "product_list";
  header: { type: "text"; text: string };
  body: Text;
  footer?: Text;
  action: { catalog_id: string; sections: { title?: string; product_items: { product_retailer_id: string }[] }[] };
};
export type ProductCarouselPayload = {
  type: "carousel";
  body: Text;
  action: { cards: { card_index: number; type: "product"; action: { product_retailer_id: string; catalog_id: string } }[] };
};
export type ProductInteractive = CatalogMessagePayload | SingleProductPayload | ProductListPayload | ProductCarouselPayload;

export const PRODUCT_INTERACTIVE_TYPES = ["catalog_message", "product", "product_list", "carousel"] as const;
export type ProductInteractiveType = (typeof PRODUCT_INTERACTIVE_TYPES)[number];

/** True for one of the four product message types (the inbox delegates these to normalizeProductInteractive). */
export function isProductInteractiveType(type: unknown): type is ProductInteractiveType {
  return typeof type === "string" && (PRODUCT_INTERACTIVE_TYPES as readonly string[]).includes(type);
}

// =====================================================================================================================
// Checks
// =====================================================================================================================

const fail = (message: string, field?: string): never => {
  throw new CommerceInputError(message, field);
};

/** What a text is called in the errors: "Add a message." and "The message can be at most 1,024 characters." */
type TextName = { add: string; name: string };
const MESSAGE: TextName = { add: "Add a message.", name: "The message" };
const FOOTER: TextName = { add: "Add a footer.", name: "The footer" };
const HEADER: TextName = { add: "Add a header.", name: "The header" };
const SECTION_TITLE: TextName = { add: "Add a title for each section.", name: "A section title" };

/** Trimmed text within `max` characters; undefined when empty and optional. */
function textOf(value: unknown, max: number, what: TextName, field: string, required: boolean): string | undefined {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t) return required ? fail(what.add, field) : undefined;
  if (t.length > max) fail(`${what.name} can be at most ${max.toLocaleString("en-IN")} characters.`, field);
  return t;
}

/** A product code Meta can match (1 to 100 characters, no spaces or "/"). */
function codeOf(value: unknown, field = "products"): string {
  if (!isValidRetailerId(value)) fail(`'${String(value ?? "").slice(0, 40)}' isn't a product code from your shop.`, field);
  return value as string;
}

/** The Meta catalog id the products live in. */
function catalogIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[^\s/]{1,100}$/.test(value)) fail("Connect your shop catalog to WhatsApp first.", "catalogId");
  return value as string;
}

/** Product codes in order, with repeats refused (WhatsApp would show the same product twice). */
function codesOf(values: unknown, field: string): string[] {
  if (!Array.isArray(values)) return fail("Choose the products to send.", field);
  const codes = values.map((v) => codeOf(v, field));
  const seen = new Set<string>();
  for (const c of codes) {
    if (seen.has(c)) fail(`'${c.slice(0, 40)}' is chosen twice. Choose each product once.`, field);
    seen.add(c);
  }
  return codes;
}

const opt = <K extends string>(key: K, value: string | undefined) => (value ? ({ [key]: { text: value } } as Record<K, Text>) : {});

// =====================================================================================================================
// Builders (3.5)
// =====================================================================================================================

export type CatalogMessageInput = { body: string; footer?: string | null; thumbnailRetailerId?: string | null };
export type SingleProductInput = { catalogId: string; retailerId: string; body?: string | null; footer?: string | null };
export type ProductListMessageInput = {
  catalogId: string;
  header: string;
  body: string;
  footer?: string | null;
  sections: readonly { title?: string | null; retailerIds: readonly string[] }[];
};
export type ProductCarouselInput = { catalogId: string; body: string; retailerIds: readonly string[] };

/** The whole shop (M1): a message, an optional footer and an optional cover product (else Meta shows the first item). */
export function buildCatalogMessage(input: CatalogMessageInput): CatalogMessagePayload {
  const body = textOf(input.body, MESSAGE_LIMITS.body, MESSAGE, "body", true) as string;
  const footer = textOf(input.footer, MESSAGE_LIMITS.footer, FOOTER, "footer", false);
  const thumb = input.thumbnailRetailerId ? codeOf(input.thumbnailRetailerId, "thumbnailRetailerId") : undefined;
  return {
    type: "catalog_message",
    body: { text: body },
    ...opt("footer", footer),
    action: { name: "catalog_message", ...(thumb ? { parameters: { thumbnail_product_retailer_id: thumb } } : {}) },
  };
}

/** One product (M2): message and footer optional, no header. */
export function buildSingleProduct(input: SingleProductInput): SingleProductPayload {
  const body = textOf(input.body, MESSAGE_LIMITS.body, MESSAGE, "body", false);
  const footer = textOf(input.footer, MESSAGE_LIMITS.footer, FOOTER, "footer", false);
  return {
    type: "product",
    ...opt("body", body),
    ...opt("footer", footer),
    action: { catalog_id: catalogIdOf(input.catalogId), product_retailer_id: codeOf(input.retailerId, "retailerId") },
  };
}

/** Several products (M3): text header and message required, 1 to 10 sections, at most 30 products in all. */
export function buildProductList(input: ProductListMessageInput): ProductListPayload {
  const header = textOf(input.header, MESSAGE_LIMITS.header, HEADER, "header", true) as string;
  const body = textOf(input.body, MESSAGE_LIMITS.body, MESSAGE, "body", true) as string;
  const footer = textOf(input.footer, MESSAGE_LIMITS.footer, FOOTER, "footer", false);
  const catalogId = catalogIdOf(input.catalogId);
  const raw = Array.isArray(input.sections) ? input.sections : [];
  if (raw.length === 0) fail("Choose at least one product.", "sections");
  if (raw.length > MESSAGE_LIMITS.sections) fail(`Group the products into at most ${MESSAGE_LIMITS.sections} sections.`, "sections");
  const several = raw.length > 1;
  const all = codesOf(
    raw.flatMap((s) => (Array.isArray(s?.retailerIds) ? s.retailerIds : [])),
    "sections",
  );
  if (all.length > MESSAGE_LIMITS.products) fail(`A list can hold at most ${MESSAGE_LIMITS.products} products.`, "sections");
  const sections = raw.map((s) => {
    const title = textOf(s?.title ?? undefined, MESSAGE_LIMITS.sectionTitle, SECTION_TITLE, "sections", several);
    const ids = Array.isArray(s?.retailerIds) ? s.retailerIds : [];
    if (ids.length === 0) fail("Each section needs at least one product.", "sections");
    return { ...(title ? { title } : {}), product_items: ids.map((id: string) => ({ product_retailer_id: id })) };
  });
  return { type: "product_list", header: { type: "text", text: header }, body: { text: body }, ...opt("footer", footer), action: { catalog_id: catalogId, sections } };
}

/** Product cards (M4): a message and 2 to 10 products, one card each, from one catalog. No header, footer or buttons. */
export function buildProductCarousel(input: ProductCarouselInput): ProductCarouselPayload {
  const body = textOf(input.body, MESSAGE_LIMITS.body, MESSAGE, "body", true) as string;
  const catalogId = catalogIdOf(input.catalogId);
  const codes = codesOf(input.retailerIds, "retailerIds");
  if (codes.length < MESSAGE_LIMITS.carouselMin || codes.length > MESSAGE_LIMITS.carouselMax) {
    fail(`Product cards need ${MESSAGE_LIMITS.carouselMin} to ${MESSAGE_LIMITS.carouselMax} products.`, "retailerIds");
  }
  return {
    type: "carousel",
    body: { text: body },
    action: { cards: codes.map((code, i) => ({ card_index: i, type: "product", action: { product_retailer_id: code, catalog_id: catalogId } })) },
  };
}

// =====================================================================================================================
// Re-checking a stored job
// =====================================================================================================================

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});

/**
 * Re-checks a product message read back from a queued job (or handed in by a caller) and returns a clean copy with only the
 * known fields. Anything outside MESSAGE_LIMITS, an unknown type, a header where none is allowed, a carousel with buttons,
 * repeated or out-of-range card numbers, or cards from two catalogs is refused.
 */
export function normalizeProductInteractive(raw: unknown): ProductInteractive {
  const p = rec(raw);
  const action = rec(p.action);
  const footerText = rec(p.footer).text;
  switch (p.type) {
    case "catalog_message": {
      if (p.header !== undefined) fail("A whole-shop message can't have a header.", "header");
      if (action.name !== "catalog_message") fail("This whole-shop message is damaged. Send it again.", "action");
      const thumb = rec(action.parameters).thumbnail_product_retailer_id;
      return buildCatalogMessage({ body: rec(p.body).text as string, footer: footerText as string | undefined, thumbnailRetailerId: (thumb as string | undefined) ?? null });
    }
    case "product":
      if (p.header !== undefined) fail("A single-product message can't have a header.", "header");
      return buildSingleProduct({
        catalogId: action.catalog_id as string,
        retailerId: action.product_retailer_id as string,
        body: rec(p.body).text as string | undefined,
        footer: footerText as string | undefined,
      });
    case "product_list": {
      const header = rec(p.header);
      if (header.type !== "text") fail("A product list needs a text header.", "header");
      const sections = (Array.isArray(action.sections) ? action.sections : []).map((s) => {
        const section = rec(s);
        const items = Array.isArray(section.product_items) ? section.product_items : [];
        return { title: section.title as string | undefined, retailerIds: items.map((i) => rec(i).product_retailer_id as string) };
      });
      return buildProductList({ catalogId: action.catalog_id as string, header: header.text as string, body: rec(p.body).text as string, footer: footerText as string | undefined, sections });
    }
    case "carousel": {
      if (p.header !== undefined || p.footer !== undefined) fail("Product cards can't have a header or a footer.", "header");
      if (action.buttons !== undefined) fail("Product cards can't have buttons.", "action");
      const cards = Array.isArray(action.cards) ? action.cards.map(rec) : [];
      const indexes = cards.map((c) => c.card_index);
      if (indexes.some((i) => typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= MESSAGE_LIMITS.carouselMax) || new Set(indexes).size !== indexes.length) {
        fail("Each product card needs its own number from 0 to 9.", "cards");
      }
      if (cards.some((c) => c.type !== "product")) fail("Every card must show a product.", "cards");
      const catalogIds = new Set(cards.map((c) => rec(c.action).catalog_id));
      if (catalogIds.size > 1) fail("All product cards must come from the same shop catalog.", "cards");
      const built = buildProductCarousel({
        catalogId: [...catalogIds][0] as string,
        body: rec(p.body).text as string,
        retailerIds: cards.map((c) => rec(c.action).product_retailer_id as string),
      });
      // Keep the card numbers as stored (already checked unique and in range).
      built.action.cards.forEach((card, i) => (card.card_index = indexes[i] as number));
      return built;
    }
    default:
      return fail("Product messages are a whole shop, one product, a list or product cards.", "type");
  }
}

// =====================================================================================================================
// Inbox text and commerceRef
// =====================================================================================================================

/** Every product code a product message names, in order (the cover product of a whole-shop message too). */
export function productRetailerIds(payload: ProductInteractive): string[] {
  switch (payload.type) {
    case "catalog_message":
      return payload.action.parameters ? [payload.action.parameters.thumbnail_product_retailer_id] : [];
    case "product":
      return [payload.action.product_retailer_id];
    case "product_list":
      return payload.action.sections.flatMap((s) => s.product_items.map((i) => i.product_retailer_id));
    case "carousel":
      return payload.action.cards.map((c) => c.action.product_retailer_id);
  }
}

const NAME_MAX = 60;
const nameOf = (s: string) => {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 1)}…` : t;
};

/** "[products] Cotton kurta", "[products] Cotton kurta and Silk saree", "[products] Cotton kurta, Silk saree and 3 more". */
export function describeProducts(names: readonly string[]): string {
  const shown = names.map(nameOf).filter(Boolean);
  if (shown.length === 0) return "[products]";
  if (shown.length === 1) return `[products] ${shown[0]}`;
  if (shown.length === 2) return `[products] ${shown[0]} and ${shown[1]}`;
  return `[products] ${shown[0]}, ${shown[1]} and ${shown.length - 2} more`;
}

/** The text kept as the inbox body of a sent product message. `titleOf` gives a product's name; its code stands in otherwise. */
export function describeProductMessage(payload: ProductInteractive, titleOf?: (retailerId: string) => string | null | undefined): string {
  if (payload.type === "catalog_message") return "[products] Whole shop";
  return describeProducts(productRetailerIds(payload).map((id) => titleOf?.(id) || id));
}

/** Message.commerceRef for a product message: the kind, the catalog and at most 30 product codes. */
export function commerceRefFor(payload: ProductInteractive, catalogId: string | null = null): CommerceRef {
  const kind = payload.type === "catalog_message" ? "catalog" : payload.type;
  const fromPayload = payload.type === "product" || payload.type === "product_list" ? payload.action.catalog_id : payload.type === "carousel" ? (payload.action.cards[0]?.action.catalog_id ?? null) : null;
  return { kind, catalogId: fromPayload ?? catalogId, retailerIds: productRetailerIds(payload).slice(0, MESSAGE_LIMITS.products) };
}

// =====================================================================================================================
// Product templates (3.6)
// =====================================================================================================================

const upper = (v: unknown) => (typeof v === "string" ? v.toUpperCase() : "");

/**
 * Which of the four product template kinds a template is, from its components as Meta stores them, or null when it is not
 * one (a plain template, a media-card carousel, or product buttons mixed with other buttons):
 * - catalog: one CATALOG button and no header;
 * - mpm: one MPM button, with a text header;
 * - spm: a PRODUCT header and one SPM button;
 * - carousel: a body and product cards, each card a PRODUCT header with SPM buttons only.
 */
export function productTemplateKind(components: unknown): ProductTemplateKind | null {
  if (!Array.isArray(components)) return null;
  const list = components.map(rec);
  const byType = (t: string) => list.filter((c) => upper(c.type) === t);
  const headers = byType("HEADER");
  const buttonsComps = byType("BUTTONS");
  const carousels = byType("CAROUSEL");
  if (headers.length > 1 || buttonsComps.length > 1 || carousels.length > 1) return null;
  const header = headers[0];

  if (carousels.length === 1) {
    if (header || buttonsComps.length) return null;
    const cards = Array.isArray(carousels[0].cards) ? carousels[0].cards.map(rec) : [];
    if (cards.length === 0) return null;
    const productCard = (card: Rec) => {
      const parts = Array.isArray(card.components) ? card.components.map(rec) : [];
      const cardHeader = parts.filter((c) => upper(c.type) === "HEADER");
      const cardButtons = parts.filter((c) => upper(c.type) === "BUTTONS");
      if (parts.some((c) => !["HEADER", "BUTTONS", "BODY"].includes(upper(c.type)))) return false;
      if (cardHeader.length !== 1 || upper(cardHeader[0].format) !== "PRODUCT" || cardButtons.length !== 1) return false;
      const buttons = Array.isArray(cardButtons[0].buttons) ? cardButtons[0].buttons.map(rec) : [];
      return buttons.length > 0 && buttons.every((b) => upper(b.type) === "SPM");
    };
    return cards.every(productCard) ? "carousel" : null;
  }

  if (buttonsComps.length !== 1) return null;
  const buttons = Array.isArray(buttonsComps[0].buttons) ? buttonsComps[0].buttons.map(rec) : [];
  if (buttons.length !== 1) return null;
  switch (upper(buttons[0].type)) {
    case "CATALOG":
      return header ? null : "catalog";
    case "MPM":
      return !header || upper(header.format) === "TEXT" ? "mpm" : null;
    case "SPM":
      return header && upper(header.format) === "PRODUCT" ? "spm" : null;
    default:
      return null;
  }
}

/**
 * Checks the products chosen for a product template (Broadcast.productParams, a chat template send) against its kind and
 * returns a clean copy. A Several-products choice without a cover product uses its first product.
 */
export function validateProductParams(kind: ProductTemplateKind, raw: unknown): ProductParams {
  const p = rec(raw);
  if (p.kind !== kind) fail("These products don't fit this template. Choose the products again.", "productParams");
  switch (kind) {
    case "catalog":
      return p.thumbnailRetailerId === undefined || p.thumbnailRetailerId === null || p.thumbnailRetailerId === ""
        ? { kind }
        : { kind, thumbnailRetailerId: codeOf(p.thumbnailRetailerId, "thumbnailRetailerId") };
    case "spm":
      return { kind, retailerId: codeOf(p.retailerId, "retailerId") };
    case "carousel": {
      const ids = codesOf(p.retailerIds, "retailerIds");
      if (ids.length < MESSAGE_LIMITS.carouselMin || ids.length > MESSAGE_LIMITS.carouselMax) {
        fail(`Product cards need ${MESSAGE_LIMITS.carouselMin} to ${MESSAGE_LIMITS.carouselMax} products.`, "retailerIds");
      }
      return { kind, retailerIds: ids };
    }
    case "mpm": {
      const raw = Array.isArray(p.sections) ? p.sections.map(rec) : [];
      if (raw.length === 0) fail("Choose at least one product.", "sections");
      if (raw.length > MESSAGE_LIMITS.sections) fail(`Group the products into at most ${MESSAGE_LIMITS.sections} sections.`, "sections");
      const all = codesOf(
        raw.flatMap((s) => (Array.isArray(s.retailerIds) ? s.retailerIds : [])),
        "sections",
      );
      if (all.length > MESSAGE_LIMITS.products) fail(`A list can hold at most ${MESSAGE_LIMITS.products} products.`, "sections");
      const sections = raw.map((s) => {
        const title = textOf(s.title, MESSAGE_LIMITS.sectionTitle, SECTION_TITLE, "sections", true) as string;
        const ids = Array.isArray(s.retailerIds) ? (s.retailerIds as string[]) : [];
        if (ids.length === 0) fail("Each section needs at least one product.", "sections");
        return { title, retailerIds: [...ids] };
      });
      const thumb = p.thumbnailRetailerId ? codeOf(p.thumbnailRetailerId, "thumbnailRetailerId") : all[0];
      return { kind, thumbnailRetailerId: thumb, sections };
    }
  }
}

/** A component of a template send (the `components` of a Cloud API template message). */
export type TemplateSendComponent = { type: string } & Record<string, unknown>;

/** Text values for the template's own placeholders, in order. */
export type TemplateTextVars = { header?: readonly string[]; body?: readonly string[] };

const textParams = (values: readonly string[]) => values.map((text) => ({ type: "text", text }));
const productParam = (retailerId: string, catalogId: string) => ({ type: "product", product: { product_retailer_id: retailerId, catalog_id: catalogId } });

/**
 * The send components of a product template (3.6), in Meta's order: header, body, then the product button or the cards.
 * - catalog: body values and a CATALOG button with the optional cover product;
 * - mpm: header and body values and an "mpm" button with the cover product and the sections (VERIFY V-C11 for the lower case);
 * - spm: a product header and body values, no button component (the button lives in the template);
 * - carousel: body values and one product header per card, 2 to 10 cards, no button component.
 * The catalog id is needed for spm and carousel.
 */
export function buildProductTemplateComponents(kind: ProductTemplateKind, params: ProductParams, metaCatalogId: string | null, vars: TemplateTextVars = {}): TemplateSendComponent[] {
  const clean = validateProductParams(kind, params);
  const out: TemplateSendComponent[] = [];
  const body = vars.body?.length ? [{ type: "body", parameters: textParams(vars.body) }] : [];
  switch (clean.kind) {
    case "catalog":
      out.push(...body, {
        type: "button",
        sub_type: "CATALOG",
        index: 0,
        parameters: [{ type: "action", action: clean.thumbnailRetailerId ? { thumbnail_product_retailer_id: clean.thumbnailRetailerId } : {} }],
      });
      break;
    case "mpm":
      if (vars.header?.length) out.push({ type: "header", parameters: textParams(vars.header) });
      out.push(...body, {
        type: "button",
        sub_type: "mpm",
        index: 0,
        parameters: [
          {
            type: "action",
            action: {
              thumbnail_product_retailer_id: clean.thumbnailRetailerId,
              sections: clean.sections.map((s) => ({ title: s.title, product_items: s.retailerIds.map((id) => ({ product_retailer_id: id })) })),
            },
          },
        ],
      });
      break;
    case "spm": {
      const catalogId = catalogIdOf(metaCatalogId);
      out.push({ type: "header", parameters: [productParam(clean.retailerId, catalogId)] }, ...body);
      break;
    }
    case "carousel": {
      const catalogId = catalogIdOf(metaCatalogId);
      out.push(...body, {
        type: "carousel",
        cards: clean.retailerIds.map((id, i) => ({ card_index: i, components: [{ type: "header", parameters: [productParam(id, catalogId)] }] })),
      });
      break;
    }
  }
  return out;
}

// =====================================================================================================================
// The older builders (unchanged behaviour; re-exported by src/lib/commerce/catalog.ts)
// =====================================================================================================================

const LEGACY_LIMITS = { header: 60, body: 1024, footer: 60, sectionTitle: 24, sections: 10, products: 30, id: 100 } as const;

type Common = { to: string; catalogId: string; body?: string; footer?: string };

export type ProductMessageInput = Common & { productRetailerId: string };
export type ProductListInput = Omit<Common, "body"> & {
  header: string;
  body: string;
  sections: { title?: string; productRetailerIds: string[] }[];
};

function legacyText(value: string | undefined, field: string, max: number, required = false): string | undefined {
  const v = value?.trim();
  if (!v) {
    if (required) throw new Error(`${field} is required.`);
    return undefined;
  }
  if (v.length > max) throw new Error(`${field} must be at most ${max} characters.`);
  return v;
}

function legacyId(value: string | undefined, field: string): string {
  const v = legacyText(value, field, LEGACY_LIMITS.id, true) as string;
  return v;
}

function legacyBase(to: string) {
  const digits = to.replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(digits)) throw new Error("to must be a phone number in international format.");
  return { messaging_product: "whatsapp", recipient_type: "individual", to: digits, type: "interactive" } as const;
}

/** Single-product message (interactive type "product"). Body and footer are optional. */
export function buildProductMessage(input: ProductMessageInput) {
  const body = legacyText(input.body, "body", LEGACY_LIMITS.body);
  const footer = legacyText(input.footer, "footer", LEGACY_LIMITS.footer);
  return {
    ...legacyBase(input.to),
    interactive: {
      type: "product",
      ...(body ? { body: { text: body } } : {}),
      ...(footer ? { footer: { text: footer } } : {}),
      action: { catalog_id: legacyId(input.catalogId, "catalogId"), product_retailer_id: legacyId(input.productRetailerId, "productRetailerId") },
    },
  };
}

/** Multi-product message (interactive type "product_list"): header and body required, up to 10 sections and 30 products in total. */
export function buildProductListMessage(input: ProductListInput) {
  const header = legacyText(input.header, "header", LEGACY_LIMITS.header, true) as string;
  const body = legacyText(input.body, "body", LEGACY_LIMITS.body, true) as string;
  const footer = legacyText(input.footer, "footer", LEGACY_LIMITS.footer);
  if (input.sections.length === 0 || input.sections.length > LEGACY_LIMITS.sections) throw new Error(`Use between 1 and ${LEGACY_LIMITS.sections} sections.`);

  const sections = input.sections.map((section) => {
    const title = legacyText(section.title, "section title", LEGACY_LIMITS.sectionTitle, input.sections.length > 1);
    if (section.productRetailerIds.length === 0) throw new Error("Each section needs at least one product.");
    return {
      ...(title ? { title } : {}),
      product_items: section.productRetailerIds.map((p) => ({ product_retailer_id: legacyId(p, "productRetailerId") })),
    };
  });
  const count = sections.reduce((n, s) => n + s.product_items.length, 0);
  if (count > LEGACY_LIMITS.products) throw new Error(`A product list holds at most ${LEGACY_LIMITS.products} products.`);

  return {
    ...legacyBase(input.to),
    interactive: {
      type: "product_list",
      header: { type: "text", text: header },
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: { catalog_id: legacyId(input.catalogId, "catalogId"), sections },
    },
  };
}

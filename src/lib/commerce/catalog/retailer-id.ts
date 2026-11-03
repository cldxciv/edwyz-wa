/**
 * Product codes (Meta's "Content ID", the `retailer_id` of a catalog item): docs/specs/META-CATALOG-COMMERCE-SPEC.md 2.1 and 3.4.
 * Pure and safe in the browser.
 *
 * - Codes Edwyz makes: a slug of the name plus 4 random characters ("cotton-kurta-7k3m"), only [a-z0-9_-].
 * - Codes from a CSV file or an existing catalog: 1 to 100 printable characters, no spaces and no "/" (the same rule as the
 *   CatalogProduct_retailerId_check constraint of migration 0021).
 * - Shopify variants: "shp-<variant number>", grouped by "shp-<product number>".
 * A code never changes after the first send: a change is a delete plus a create on Meta.
 */

export const RETAILER_ID_MAX = 100;
/** Characters of a generated code, before the random part. */
const SLUG_MAX = 40;
const RANDOM_LENGTH = 4;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Characters a generated code may use. */
export const GENERATED_CODE_RE = /^[a-z0-9_-]{1,100}$/;

/** Fills a byte array with random values. The default uses the Web Crypto API (Node and browsers). */
export type RandomBytes = (length: number) => Uint8Array;

const defaultRandom: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

/** A lower-case ASCII slug of a product name ("Cotton Kurta, Blue!" -> "cotton-kurta-blue"); "product" when nothing is left. */
export function codeSlug(name: string): string {
  const slug = String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "product";
}

/** Four random characters from a-z and 0-9, without modulo bias. */
function randomPart(random: RandomBytes): string {
  let out = "";
  while (out.length < RANDOM_LENGTH) {
    for (const byte of random(RANDOM_LENGTH * 2)) {
      // 252 is the largest multiple of 36 below 256: bytes above it would favour the first letters.
      if (byte < 252 && out.length < RANDOM_LENGTH) out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}

/** A new product code for a product name: "cotton-kurta-7k3m". */
export function generateRetailerId(name: string, random: RandomBytes = defaultRandom): string {
  return `${codeSlug(name)}-${randomPart(random)}`;
}

/** Whitespace (any script), "/" and invisible control or format characters are never part of a code. */
const FORBIDDEN_IN_CODE = /[\s/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * What is wrong with a product code, in plain words, or null when it is fine. `generated` applies the stricter rule of codes
 * Edwyz makes. The words never say "retailer id": owners know it as the product code.
 */
export function retailerIdProblem(code: unknown, opts: { generated?: boolean } = {}): string | null {
  if (typeof code !== "string" || code.length === 0) return "Add a product code.";
  if ([...code].length > RETAILER_ID_MAX) return `A product code can be at most ${RETAILER_ID_MAX} characters.`;
  if (FORBIDDEN_IN_CODE.test(code)) return "A product code can't have spaces or a '/'. Use letters, numbers and dashes.";
  if (opts.generated && !GENERATED_CODE_RE.test(code)) return "Use only small letters, numbers, '-' and '_' in the product code.";
  return null;
}

/** True when the code may be sent to Meta. */
export function isValidRetailerId(code: unknown, opts: { generated?: boolean } = {}): code is string {
  return retailerIdProblem(code, opts) === null;
}

/** The number at the end of a Shopify id ("gid://shopify/ProductVariant/123" or "123"), or null. */
export function shopifyNumericId(id: unknown): string | null {
  const m = /(?:^|\/)(\d{1,30})$/.exec(String(id ?? "").trim());
  return m ? m[1] : null;
}

/** The product code of a Shopify variant: "shp-<variant number>" (D-C10). */
export function shopifyRetailerId(variantId: unknown): string | null {
  const n = shopifyNumericId(variantId);
  return n ? `shp-${n}` : null;
}

/** The variant group of a Shopify product with more than one variant: "shp-<product number>". */
export function shopifyGroupId(productId: unknown): string | null {
  const n = shopifyNumericId(productId);
  return n ? `shp-${n}` : null;
}

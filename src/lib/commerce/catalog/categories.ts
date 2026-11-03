/**
 * "What do you sell?" chips (docs/specs/META-CATALOG-COMMERCE-SPEC.md 2.2 step 3): about 20 plain-word categories, each mapped
 * to a Google product category id that Meta reads as `google_product_category`. Pure and safe in the browser.
 *
 * "Other" sends no category until VERIFY V-C2 shows that WhatsApp-only catalogs refuse that (then "Other" asks for the
 * closest chip). The chip chosen in setup becomes the default category of every product; each product can change it.
 */

export type ShopCategory = {
  key: string;
  label: string;
  /** Google product category id, or null for "Other". */
  googleId: string | null;
};

export const SHOP_CATEGORIES: readonly ShopCategory[] = Object.freeze([
  { key: "clothes", label: "Clothes and accessories", googleId: "166" },
  { key: "jewellery", label: "Jewellery", googleId: "188" },
  { key: "beauty", label: "Beauty and health", googleId: "469" },
  { key: "home", label: "Home and kitchen", googleId: "536" },
  { key: "food", label: "Food and drinks", googleId: "412" },
  { key: "electronics", label: "Electronics", googleId: "222" },
  { key: "furniture", label: "Furniture", googleId: "436" },
  { key: "toys", label: "Toys and games", googleId: "1239" },
  { key: "baby", label: "Baby products", googleId: "537" },
  { key: "sports", label: "Sports", googleId: "988" },
  { key: "bags", label: "Bags and luggage", googleId: "5181" },
  { key: "books", label: "Books and media", googleId: "783" },
  { key: "hardware", label: "Hardware and tools", googleId: "632" },
  { key: "office", label: "Office supplies", googleId: "922" },
  { key: "pets", label: "Pet supplies", googleId: "1" },
  { key: "art", label: "Art and craft", googleId: "8" },
  { key: "religious", label: "Religious items", googleId: "5605" },
  { key: "vehicles", label: "Car and bike parts", googleId: "888" },
  { key: "other", label: "Other", googleId: null },
] satisfies ShopCategory[]);

/** The chip a [Skip] picks: Other, so this step never blocks setup. */
export const OTHER_CATEGORY_KEY = "other";

/** The line under the chips. */
export const CATEGORY_HINT = "This helps Meta show your products to the right people. You can change it per product.";

/** The chip with this Google id, or undefined. */
export function categoryByGoogleId(id: string | null | undefined): ShopCategory | undefined {
  if (!id) return undefined;
  return SHOP_CATEGORIES.find((c) => c.googleId === String(id).trim());
}

/** The chip with this key, or undefined. */
export function categoryByKey(key: string | null | undefined): ShopCategory | undefined {
  return SHOP_CATEGORIES.find((c) => c.key === key);
}

/** The plain label of a category id for the default description ("Clothes and accessories"), or null when it is not a chip. */
export function categoryLabel(id: string | null | undefined): string | null {
  const chip = categoryByGoogleId(id);
  return chip && chip.googleId ? chip.label : null;
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The category to store for what an owner wrote (a CSV cell, an Eddy request): a Google id ("166"), a chip label or key
 * ("Jewellery", "home"), or Meta's full path ("Apparel & Accessories > Clothing") kept as written (at most 250 characters).
 * Empty and "Other" give null (no category is sent).
 */
export function categoryFromText(text: string | null | undefined): string | null {
  const value = String(text ?? "").trim();
  if (!value) return null;
  if (/^\d{1,6}$/.test(value)) return value;
  const n = norm(value);
  const chip = SHOP_CATEGORIES.find((c) => norm(c.label) === n || c.key === n);
  if (chip) return chip.googleId;
  return value.slice(0, 250);
}

/**
 * Product spreadsheets (docs/specs/META-CATALOG-COMMERCE-SPEC.md 2.4 and 3.4). Pure and safe in the browser.
 *
 * The parser is parseCsv from src/lib/contacts/csv.ts (reused: quotes, CRLF, BOM). This file adds only the column names
 * (case and space insensitive aliases), the row rules (validateProduct, the same as the product form), the caps (2 MB and
 * 5,000 rows), a problem per row in plain words, and the "skipped rows" download with the formula-injection guard of
 * src/lib/reports/csv.ts. Image links are kept as given (https only): Edwyz never downloads them.
 */
import { parseCsv } from "@/lib/contacts/csv";
import { BOM, csvRow } from "@/lib/reports/csv";
import { type ProductInput, validateProduct, type ValidProduct } from "./fields";
import { DEFAULT_SHOP_CURRENCY } from "./money";
import { retailerIdProblem } from "./retailer-id";
import { cleanText } from "./types";

export const CSV_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxRows: 5000, previewRows: 20 });

export const CSV_FIELDS = [
  "id",
  "title",
  "description",
  "price",
  "sale_price",
  "availability",
  "quantity",
  "image",
  "link",
  "brand",
  "category",
  "item_group_id",
  "color",
  "size",
  "condition",
  "origin_country",
  "wa_compliance_category",
] as const;
export type CsvField = (typeof CSV_FIELDS)[number];

/** Column names each field is read from (3.4), compared after normalizeHeader. */
export const CSV_ALIASES: Readonly<Record<CsvField, readonly string[]>> = Object.freeze({
  id: ["id", "sku", "product code", "content id", "retailer id"],
  title: ["title", "name", "product", "product name"],
  description: ["description", "details", "desc"],
  price: ["price", "mrp", "rate", "amount"],
  sale_price: ["sale price", "offer price", "selling price", "discount price"],
  availability: ["availability", "stock", "in stock", "available"],
  quantity: ["quantity", "qty", "inventory"],
  image: ["image", "image link", "photo", "picture", "image url"],
  link: ["link", "url", "website", "product link"],
  brand: ["brand"],
  category: ["category", "google product category", "fb product category"],
  item_group_id: ["item group id"],
  color: ["color", "colour"],
  size: ["size"],
  condition: ["condition"],
  origin_country: ["origin country"],
  wa_compliance_category: ["wa compliance category"],
});

/** The plain name of each field, for the "We read your columns like this" box and the problems. */
export const CSV_FIELD_LABELS: Readonly<Record<CsvField, string>> = Object.freeze({
  id: "Product code",
  title: "Name",
  description: "Description",
  price: "Price",
  sale_price: "Sale price",
  availability: "In stock",
  quantity: "Quantity",
  image: "Photo link",
  link: "Website link",
  brand: "Brand",
  category: "Category",
  item_group_id: "Variant group",
  color: "Colour",
  size: "Size",
  condition: "Condition",
  origin_country: "Made in",
  wa_compliance_category: "Service or digital item",
});

/** Columns every row needs: a name, a price and a photo link. */
export const REQUIRED_CSV_FIELDS: readonly CsvField[] = ["title", "price", "image"];

/** Lower case, with underscores, dashes and runs of spaces turned into one space: "Image_Link " -> "image link". */
export function normalizeHeader(header: string): string {
  return String(header ?? "")
    .replace(/^﻿/, "")
    .toLowerCase()
    .replace(/[_\-\s]+/g, " ")
    .trim();
}

export type CsvMapping = Record<CsvField, number | null>;

/** Which column each field is read from. The first column that matches wins; a later duplicate is ignored. */
export function mapColumns(headers: readonly string[]): { mapping: CsvMapping; ignored: string[] } {
  const mapping = Object.fromEntries(CSV_FIELDS.map((f) => [f, null])) as CsvMapping;
  const ignored: string[] = [];
  headers.forEach((raw, index) => {
    const h = normalizeHeader(raw);
    const field = CSV_FIELDS.find((f) => CSV_ALIASES[f].includes(h));
    if (field && mapping[field] === null) mapping[field] = index;
    else if (h) ignored.push(String(raw).trim());
  });
  return { mapping, ignored };
}

/** Yes/no words owners write for stock. */
const IN_STOCK_WORDS = new Set(["yes", "y", "1", "true", "in stock", "instock", "available", "in", "haan", "ha"]);
const OUT_OF_STOCK_WORDS = new Set(["no", "n", "0", "false", "out of stock", "outofstock", "not available", "unavailable", "sold out", "out", "nahi"]);

export type CsvRowProblem = { row: number; field?: CsvField; text: string };

export type CsvRow = {
  /** The row number as a spreadsheet shows it (the header is row 1; blank lines are not counted). */
  row: number;
  /** The cells as read, for the preview table and the skipped-rows file. */
  cells: string[];
  /** The product, when the row has no problem. Its code is null when the row has none (one is made when it is added). */
  product: ValidProduct | null;
  problems: CsvRowProblem[];
};

export type CsvParseOptions = {
  /** The shop's currency; prices are read in it. */
  currency?: string;
  /** Column choices the owner changed in the preview, by field (null: not read). */
  mapping?: Partial<CsvMapping>;
};

export type CsvParseResult =
  | {
      ok: true;
      headers: string[];
      mapping: CsvMapping;
      /** Columns no field reads. */
      ignored: string[];
      /** Required fields with no column, each with a line for the mapping box. */
      missing: { field: CsvField; text: string }[];
      rows: CsvRow[];
      rowCount: number;
      readyCount: number;
      problemCount: number;
      /** "124 products found: 118 ready, 6 need a fix." */
      summary: string;
    }
  | { ok: false; error: string };

export const CSV_ERRORS = Object.freeze({
  tooLarge: "This file is larger than 2 MB. Split it into smaller files.",
  tooManyRows: "This file has more than 5,000 products. Split it into smaller files.",
  semicolons: "Save the file as 'CSV (Comma delimited)' and upload it again.",
  encoding: "Some letters in this file can't be read. Save it as 'CSV UTF-8 (Comma delimited)' and upload it again.",
  empty: "This file has no products. Put the column names in the first row and one product in each row below.",
});

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

/** "124 products found: 118 ready, 6 need a fix." */
export function csvSummary(total: number, ready: number, problems: number): string {
  return `${plural(total, "product", "products")} found: ${ready.toLocaleString("en-IN")} ready, ${plural(problems, "needs a fix", "need a fix")}.`;
}

/** Bytes to text: UTF-8 only, so a file saved in another encoding is refused instead of filling names with garbage. */
function decode(input: string | Uint8Array): string | null {
  if (typeof input === "string") return input;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return null;
  }
}

const byteLength = (input: string | Uint8Array) => (typeof input === "string" ? new TextEncoder().encode(input).length : input.length);

/** Lower-case first letter, for "Row 7: add a product name." */
const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The field a validateProduct error key belongs to. */
const ERROR_FIELD: Readonly<Record<string, CsvField>> = {
  retailerId: "id",
  title: "title",
  description: "description",
  price: "price",
  salePrice: "sale_price",
  availability: "availability",
  quantity: "quantity",
  photo: "image",
  link: "link",
  brand: "brand",
  category: "category",
  itemGroupId: "item_group_id",
  color: "color",
  size: "size",
  condition: "condition",
  originCountry: "origin_country",
  importer: "origin_country",
};

/**
 * Reads a product spreadsheet: file-level refusals (size, semicolons, encoding, rows) as `{ok: false}`, otherwise every row
 * with its product or its problems ("Row 7: the price '799/-' isn't a number. Write it like 799 or 799.50."). A code used
 * twice in the file is a problem on its later rows. Rows with every cell empty are skipped.
 */
export function parseProductCsv(input: string | Uint8Array, opts: CsvParseOptions = {}): CsvParseResult {
  if (byteLength(input) > CSV_LIMITS.maxBytes) return { ok: false, error: CSV_ERRORS.tooLarge };
  const text = decode(input);
  if (text === null) return { ok: false, error: CSV_ERRORS.encoding };
  const firstLine = (text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "").trim();
  if (!firstLine) return { ok: false, error: CSV_ERRORS.empty };
  if (!firstLine.includes(",") && /[;\t]/.test(firstLine)) return { ok: false, error: CSV_ERRORS.semicolons };

  const table = parseCsv(text);
  const [headerRow, ...body] = table;
  const headers = (headerRow ?? []).map((h) => cleanText(h));
  const dataRows = body.filter((cells) => cells.some((c) => c.trim() !== ""));
  if (dataRows.length === 0) return { ok: false, error: CSV_ERRORS.empty };
  if (dataRows.length > CSV_LIMITS.maxRows) return { ok: false, error: CSV_ERRORS.tooManyRows };

  const auto = mapColumns(headers);
  const mapping: CsvMapping = { ...auto.mapping };
  for (const field of CSV_FIELDS) {
    const choice = opts.mapping?.[field];
    if (choice === null) mapping[field] = null;
    else if (typeof choice === "number" && Number.isInteger(choice) && choice >= 0 && choice < headers.length) mapping[field] = choice;
  }
  const used = new Set(Object.values(mapping).filter((v): v is number => v !== null));
  const ignored = headers.filter((h, i) => h && !used.has(i));
  const missing = REQUIRED_CSV_FIELDS.filter((f) => mapping[f] === null).map((field) => ({
    field,
    text: `We couldn't find a column for the ${CSV_FIELD_LABELS[field].toLowerCase()}. Pick it below, or name a column '${CSV_ALIASES[field][0]}'.`,
  }));

  const currency = (opts.currency ?? DEFAULT_SHOP_CURRENCY).toUpperCase();
  const firstRowOf = new Map<string, number>();
  let rowNumber = 1;
  const rows: CsvRow[] = [];
  for (const cells of body) {
    rowNumber += 1;
    if (!cells.some((c) => c.trim() !== "")) continue;
    rows.push(readRow(rowNumber, cells, mapping, currency, firstRowOf));
  }
  const readyCount = rows.filter((r) => r.problems.length === 0).length;
  return {
    ok: true,
    headers,
    mapping,
    ignored,
    missing,
    rows,
    rowCount: rows.length,
    readyCount,
    problemCount: rows.length - readyCount,
    summary: csvSummary(rows.length, readyCount, rows.length - readyCount),
  };
}

function readRow(row: number, cells: string[], mapping: CsvMapping, currency: string, firstRowOf: Map<string, number>): CsvRow {
  const cell = (f: CsvField) => {
    const i = mapping[f];
    return i === null ? "" : (cells[i] ?? "").trim();
  };
  const problems: CsvRowProblem[] = [];
  const add = (field: CsvField | undefined, text: string) => problems.push({ row, ...(field ? { field } : {}), text: `Row ${row}: ${lowerFirst(text)}` });

  // Stock: words owners use; an empty cell with a quantity of 0 means out of stock.
  let availability: "in stock" | "out of stock" | undefined;
  const stock = cell("availability").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (stock) {
    if (IN_STOCK_WORDS.has(stock)) availability = "in stock";
    else if (OUT_OF_STOCK_WORDS.has(stock)) availability = "out of stock";
    else add("availability", `The stock value '${cell("availability").slice(0, 20)}' isn't clear. Write 'in stock' or 'out of stock'.`);
  } else if (/^\s*0+\s*$/.test(cell("quantity"))) availability = "out of stock";

  const exemptCell = cell("wa_compliance_category").toUpperCase();
  let exempt: boolean | undefined;
  if (exemptCell) {
    if (exemptCell === "COUNTRY_ORIGIN_EXEMPT") exempt = true;
    else if (exemptCell === "DEFAULT") exempt = false;
    else add("wa_compliance_category", "Write DEFAULT, or COUNTRY_ORIGIN_EXEMPT for a service or a digital item.");
  }

  const code = cell("id");
  if (code) {
    const problem = retailerIdProblem(code);
    const earlier = firstRowOf.get(code);
    if (!problem && earlier !== undefined) add("id", `The product code '${code.slice(0, 40)}' is also used in row ${earlier}. Use a different code.`);
    else if (!problem) firstRowOf.set(code, row);
  }

  const color = cell("color");
  const size = cell("size");
  const input: ProductInput = {
    retailerId: code || null,
    title: cell("title"),
    description: cell("description"),
    price: cell("price"),
    salePrice: cell("sale_price") || null,
    availability,
    quantity: cell("quantity") || null,
    condition: cell("condition").toLowerCase() || null,
    brand: cell("brand") || null,
    link: cell("link") || null,
    imageUrl: cell("image") || null,
    category: cell("category") || null,
    itemGroupId: cell("item_group_id") || null,
    originCountry: exempt ? null : cell("origin_country") || null,
    extra: { ...(color ? { color } : {}), ...(size ? { size } : {}), ...(exempt ? { exempt: true } : {}) },
  };
  const result = validateProduct(input, { currency });
  if (!result.ok) {
    for (const [key, text] of Object.entries(result.errors)) {
      // A missing or unreadable column is explained once in the mapping box; the row still says what it needs.
      add(ERROR_FIELD[key], key === "photo" && !cell("image") ? "Add a photo link that starts with https://." : text);
    }
  }
  return { row, cells, product: result.ok && problems.length === 0 ? result.value : null, problems };
}

/** The rows that were skipped, as a CSV the owner can fix and upload again: the original columns plus `problem`. */
export function skippedRowsCsv(headers: readonly string[], rows: readonly CsvRow[]): string {
  const skipped = rows.filter((r) => r.problems.length > 0);
  let out = BOM + csvRow([...headers, "problem"]);
  for (const r of skipped) {
    const cells = headers.map((_, i) => r.cells[i] ?? "");
    out += csvRow([...cells, r.problems.map((p) => p.text).join(" ")]);
  }
  return out;
}

/** The sample file of 2.4: every column and two sample rows. */
export function sampleProductCsv(): string {
  const header = ["id", "title", "description", "price", "sale price", "availability", "quantity", "image link", "link", "brand", "category", "item_group_id", "color", "size", "condition", "origin_country", "wa_compliance_category"];
  const rows = [
    ["cotton-kurta-blue-m", "Cotton kurta, blue", "Soft cotton kurta for daily wear.", "799", "699", "in stock", "12", "https://www.example.com/photos/kurta-blue.jpg", "https://www.example.com/kurta-blue", "Sharma Sarees", "166", "kurta-blue", "Blue", "M", "new", "IN", "DEFAULT"],
    ["silk-saree-red", "Silk saree, red", "Banarasi silk saree with a gold border.", "4,999", "", "in stock", "3", "https://www.example.com/photos/saree-red.jpg", "", "Sharma Sarees", "166", "", "Red", "", "new", "IN", "DEFAULT"],
  ];
  return BOM + csvRow(header) + rows.map(csvRow).join("");
}

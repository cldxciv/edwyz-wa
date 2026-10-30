import { parseCsv } from "@/lib/contacts/csv";
import { normalizePhone } from "@/lib/contacts/phone";

export const SAMPLE_CSV_HEADERS = ["phone", "name", "tags", "opt_in", "opt_in_source"] as const;

const SAMPLE_ROWS: string[][] = [
  ["+919876543210", "Asha Verma", "vip;north", "yes", "website_signup_form"],
  ["09123456789", "Ravi Kumar", "newsletter", "no", ""],
];

const escapeCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export function sampleCsv(): string {
  return [SAMPLE_CSV_HEADERS as readonly string[], ...SAMPLE_ROWS].map((r) => r.map(escapeCell).join(",")).join("\r\n") + "\r\n";
}

export type OptInView = { label: string; tone: "good" | "neutral" | "bad"; detail: string | null; status: string };

export function optInView(c: { optIn: boolean; optInSource: string | null; optInAt: string | null; optedOutAt: string | null }): OptInView {
  const date = (iso: string) => new Date(iso).toLocaleDateString();
  if (c.optedOutAt) return { label: "Opted out", tone: "bad", detail: date(c.optedOutAt), status: "opted_out" };
  if (c.optIn) {
    const parts = [c.optInSource, c.optInAt ? date(c.optInAt) : null].filter(Boolean);
    return { label: "Opted in", tone: "good", detail: parts.length ? parts.join(", ") : null, status: "active" };
  }
  return { label: "Not opted in", tone: "neutral", detail: null, status: "inactive" };
}

export function parseTagInput(input: string): string[] {
  return [...new Set(input.split(/[,;]/).map((t) => t.trim()).filter(Boolean))];
}

const TECHNICAL = /prisma|econn|enotfound|etimedout|stack|undefined|\bnull\b|\bat \S+\.(ts|js)|<!doctype|<html|[{}]|unexpected token/i;

/** The server's own message when it reads like plain language, otherwise the fallback. Never leaks raw errors or ids. */
export function friendlyError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message.trim() : typeof err === "string" ? err.trim() : "";
  if (!message || message.length > 200 || TECHNICAL.test(message)) return fallback;
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "We could not reach the server. Check your connection and try again.";
  return message;
}

export const PHONE_HINT = "Include the country code, like +91 98765 43210. Without one we assume an Indian number (+91).";
export const PHONE_ERROR = "Enter a valid phone number with country code, like +91 98765 43210.";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;
export const IMPORT_CHUNK = 500;

const KNOWN_COLUMNS = new Set(["phone", "name", "tags", "opt_in", "opt_in_source"]);
const TRUE_VALUES = new Set(["yes", "true", "1", "y"]);

export type ImportRowStatus = "ready" | "invalid" | "duplicate";

export type ImportRow = { row: number; cells: string[]; phone: string | null; status: ImportRowStatus; reason?: string };

export type ImportAnalysis =
  | { ok: false; problem: string }
  | {
      ok: true;
      header: string[];
      rows: ImportRow[];
      total: number;
      ready: number;
      invalid: number;
      duplicates: number;
      optInYes: number;
      extraColumns: string[];
      preview: { row: number; phone: string; name: string; tags: string; optIn: boolean }[];
    };

/** Dry run of the server import in the browser: same CSV parser and phone rules, so the summary matches what will happen. */
export function analyzeImport(text: string, defaultCountryCode = "91"): ImportAnalysis {
  if (!text.trim()) return { ok: false, problem: "The file is empty. Choose a CSV file with a header row and at least one contact." };
  const table = parseCsv(text);
  if (table.length < 2) return { ok: false, problem: "We found a header row but no contacts. Add one row per person under the header." };
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    return { ok: false, problem: `This file has ${(table.length - 1).toLocaleString()} rows. You can import up to ${MAX_IMPORT_ROWS.toLocaleString()} at a time, so split it into smaller files.` };
  }
  const header = table[0].map((h) => h.trim().toLowerCase());
  const phoneCol = header.indexOf("phone");
  if (phoneCol < 0) return { ok: false, problem: "We could not find a column named phone. Rename the phone number column to phone in the first row and try again." };

  const col = (name: string) => header.indexOf(name);
  const cell = (cells: string[], name: string) => {
    const i = col(name);
    return i >= 0 ? (cells[i] ?? "").trim() : "";
  };

  const seen = new Set<string>();
  const rows: ImportRow[] = table.slice(1).map((cells, index) => {
    const row = index + 2;
    const raw = (cells[phoneCol] ?? "").trim();
    const phone = normalizePhone(raw, defaultCountryCode);
    if (!phone) return { row, cells, phone: null, status: "invalid", reason: raw ? "Not a valid phone number" : "Phone number is empty" };
    if (seen.has(phone)) return { row, cells, phone, status: "duplicate", reason: "Same number appears earlier in the file" };
    seen.add(phone);
    return { row, cells, phone, status: "ready" };
  });

  const ready = rows.filter((r) => r.status === "ready");
  return {
    ok: true,
    header,
    rows,
    total: rows.length,
    ready: ready.length,
    invalid: rows.filter((r) => r.status === "invalid").length,
    duplicates: rows.filter((r) => r.status === "duplicate").length,
    optInYes: ready.filter((r) => TRUE_VALUES.has(cell(r.cells, "opt_in").toLowerCase())).length,
    extraColumns: header.filter((h) => h && !KNOWN_COLUMNS.has(h)),
    preview: ready.slice(0, 5).map((r) => ({
      row: r.row,
      phone: r.phone ?? "",
      name: cell(r.cells, "name"),
      tags: cell(r.cells, "tags")
        .split(";")
        .map((t) => t.trim())
        .filter(Boolean)
        .join(", "),
      optIn: TRUE_VALUES.has(cell(r.cells, "opt_in").toLowerCase()),
    })),
  };
}

export function serializeCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map(escapeCell).join(",")).join("\r\n") + "\r\n";
}

export type ImportChunk = { csv: string; rows: number[] };

/** Splits the importable rows into requests of at most `size` rows. Invalid and duplicate rows are left out (they are reported separately). */
export function buildImportChunks(analysis: Extract<ImportAnalysis, { ok: true }>, size = IMPORT_CHUNK): ImportChunk[] {
  const ready = analysis.rows.filter((r) => r.status === "ready");
  const chunks: ImportChunk[] = [];
  for (let i = 0; i < ready.length; i += size) {
    const part = ready.slice(i, i + size);
    chunks.push({ csv: serializeCsv(analysis.header, part.map((r) => r.cells)), rows: part.map((r) => r.row) });
  }
  return chunks;
}

export type ImportReport = { created: number; updated: number; skipped: number; errors: { row: number; reason: string }[] };

export function emptyReport(): ImportReport {
  return { created: 0, updated: 0, skipped: 0, errors: [] };
}

/** Adds a chunk's server report to the running total, translating the chunk's row numbers back to the original file's. */
export function addChunkReport(total: ImportReport, part: ImportReport, chunkRows: number[]): ImportReport {
  return {
    created: total.created + part.created,
    updated: total.updated + part.updated,
    skipped: total.skipped + part.skipped,
    errors: [...total.errors, ...part.errors.map((e) => ({ row: chunkRows[e.row - 2] ?? e.row, reason: e.reason }))],
  };
}

export function importProgress(done: number, total: number): number {
  return total <= 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** One sentence for the result toast. */
export function importSummary(report: ImportReport): string {
  const parts = [report.created > 0 && `${plural(report.created, "new contact")} added`, report.updated > 0 && `${plural(report.updated, "contact")} updated`].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "No contacts were added or changed.";
}

export const BOM = "﻿";
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: formula-injection neutralised with a leading single quote, quoted when needed. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",") + "\r\n";

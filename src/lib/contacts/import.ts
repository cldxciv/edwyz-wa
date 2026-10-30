import type { Prisma } from "@/generated/prisma/client";
import { assertWithinLimit } from "@/lib/billing";
import { type AutomationEvent, attributeChangeEvents, emitAutomationEvents, tagChangeEvents } from "@/lib/automation/v2/emit";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { parseCsv } from "./csv";
import { normalizePhone } from "./phone";

export const MAX_IMPORT_ROWS = 10_000;
export const DEFAULT_OPT_IN_SOURCE = "csv_import";
const CHUNK = 500;
const TRUE_VALUES = new Set(["yes", "true", "1", "y"]);
const KNOWN = new Set(["phone", "name", "tags", "opt_in", "opt_in_source"]);

export type ImportReport = { created: number; updated: number; skipped: number; errors: { row: number; reason: string }[] };

type ParsedRow = {
  row: number;
  phone: string;
  name?: string;
  tags: string[];
  optIn: boolean;
  optInSource: string;
  attributes: Record<string, string>;
};

type Existing = {
  id: string;
  phone: string;
  name: string | null;
  tags: string[];
  attributes: unknown;
  optIn: boolean;
  optedOutAt: Date | null;
};

function parseRows(table: string[][], report: ImportReport, defaultCountryCode: string): ParsedRow[] {
  const header = table[0].map((h) => h.trim().toLowerCase());
  const phoneCol = header.indexOf("phone");
  if (phoneCol < 0) throw new HttpError(400, "CSV must have a phone column.");
  const seen = new Set<string>();
  const parsed: ParsedRow[] = [];

  table.slice(1).forEach((cells, index) => {
    const row = index + 2;
    const phone = normalizePhone(cells[phoneCol] ?? "", defaultCountryCode);
    if (!phone) {
      report.errors.push({ row, reason: "Invalid phone number." });
      return;
    }
    if (seen.has(phone)) {
      report.skipped++;
      return;
    }
    seen.add(phone);
    const get = (name: string) => {
      const i = header.indexOf(name);
      return i >= 0 ? (cells[i] ?? "").trim() : "";
    };
    const attributes: Record<string, string> = {};
    header.forEach((h, i) => {
      const value = (cells[i] ?? "").trim();
      if (h && !KNOWN.has(h) && value) attributes[h] = value;
    });
    parsed.push({
      row,
      phone,
      name: get("name") || undefined,
      tags: [...new Set(get("tags").split(";").map((t) => t.trim()).filter(Boolean))],
      optIn: TRUE_VALUES.has(get("opt_in").toLowerCase()),
      optInSource: get("opt_in_source") || DEFAULT_OPT_IN_SOURCE,
      attributes,
    });
  });
  return parsed;
}

function buildUpdate(existing: Existing, row: ParsedRow, now: Date): Prisma.ContactUpdateInput {
  const data: Prisma.ContactUpdateInput = {
    tags: [...new Set([...existing.tags, ...row.tags])],
    attributes: { ...((existing.attributes as Record<string, unknown>) ?? {}), ...row.attributes } as Prisma.InputJsonObject,
  };
  if (row.name) data.name = row.name;
  if (row.optIn && !existing.optedOutAt && !existing.optIn) {
    data.optIn = true;
    data.optInSource = row.optInSource;
    data.optInAt = now;
  }
  return data;
}

/** Rules that start from "contact created" see people an import adds. Contacts that already existed are skipped by the database insert, so ids are looked up. */
async function createdEvents(tenantId: string, fresh: ParsedRow[]): Promise<AutomationEvent[]> {
  const found = await prisma.contact.findMany({ where: { tenantId, phone: { in: fresh.map((r) => r.phone) } }, select: { id: true } });
  return found.map((c) => ({ type: "contact_created" as const, tenantId, contactId: c.id }));
}

/** Rules that start from a tag or detail change see what an import changed on existing contacts. */
function changeEvents(tenantId: string, before: Existing, data: Prisma.ContactUpdateInput): AutomationEvent[] {
  const base = { tenantId, contactId: before.id };
  const tags = Array.isArray(data.tags) ? (data.tags as string[]) : before.tags;
  const attributes = (data.attributes ?? before.attributes) as Record<string, unknown>;
  return [...tagChangeEvents(base, before.tags, tags), ...attributeChangeEvents(base, (before.attributes as Record<string, unknown>) ?? {}, attributes ?? {})];
}

/** One consent record per person the import opted in, so the contact page can show the source and who ran the import. */
async function recordImportConsent(tenantId: string, userId: string | null, rows: ParsedRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const found = await prisma.contact.findMany({ where: { tenantId, phone: { in: rows.map((r) => r.phone) } }, select: { id: true, phone: true } });
    const idByPhone = new Map(found.flatMap((c): [string, string][] => (c.phone ? [[c.phone, c.id]] : [])));
    const data = rows.flatMap((r) => {
      const target = idByPhone.get(r.phone);
      return target ? [{ tenantId, userId, action: "contact.consent_recorded", target, meta: { source: r.optInSource.slice(0, 200) } }] : [];
    });
    if (data.length) await prisma.auditLog.createMany({ data });
  } catch {
    console.error("[contacts] could not write import consent records");
  }
}

export async function importContacts(
  tenantId: string,
  csvText: string,
  options: { defaultCountryCode?: string; now?: Date; recordedByUserId?: string | null } = {},
): Promise<ImportReport> {
  const now = options.now ?? new Date();
  const table = parseCsv(csvText);
  if (table.length === 0) throw new HttpError(400, "CSV is empty.");
  if (table.length - 1 > MAX_IMPORT_ROWS) throw new HttpError(400, `Imports are limited to ${MAX_IMPORT_ROWS} rows.`);

  const report: ImportReport = { created: 0, updated: 0, skipped: 0, errors: [] };
  const announce: AutomationEvent[] = [];
  const rows = parseRows(table, report, options.defaultCountryCode ?? "91");

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const existing = await prisma.contact.findMany({
      where: { tenantId, phone: { in: chunk.map((r) => r.phone) } },
      select: { id: true, phone: true, name: true, tags: true, attributes: true, optIn: true, optedOutAt: true },
    });
    const byPhone = new Map<string, Existing>(existing.flatMap((c): [string, Existing][] => (c.phone ? [[c.phone, { ...c, phone: c.phone }]] : [])));
    const fresh = chunk.filter((r) => !byPhone.has(r.phone));
    const consented: ParsedRow[] = fresh.filter((r) => r.optIn);

    if (fresh.length) {
      await assertWithinLimit(tenantId, "contacts", fresh.length);
      await prisma.contact.createMany({
        data: fresh.map((r) => ({
          tenantId,
          phone: r.phone,
          name: r.name,
          tags: r.tags,
          attributes: r.attributes as Prisma.InputJsonObject,
          ...(r.optIn ? { optIn: true, optInSource: r.optInSource, optInAt: now } : {}),
        })),
        skipDuplicates: true,
      });
      report.created += fresh.length;
      announce.push(...(await createdEvents(tenantId, fresh)));
    }
    for (const r of chunk) {
      const match = byPhone.get(r.phone);
      if (!match) continue;
      const data = buildUpdate(match, r, now);
      await prisma.contact.update({ where: { id: match.id, tenantId }, data });
      announce.push(...changeEvents(tenantId, match, data));
      if (data.optIn === true) consented.push(r);
      report.updated++;
    }
    if (options.recordedByUserId !== undefined) await recordImportConsent(tenantId, options.recordedByUserId, consented);
    await emitAutomationEvents(announce.splice(0));
  }
  return report;
}

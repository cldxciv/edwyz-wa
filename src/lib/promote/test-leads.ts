/**
 * Test leads of instant forms (docs/IG-PAGE-ADS-SPEC.md 3.5, D33, PRM-10).
 *
 * A test lead is recognised by what Meta returns, never by a time window:
 * - the lead id that `POST {form}/test_leads` answered with, stored here per Page for 30 days in PlatformSetting
 *   `promote:test-leads:<pageMetaId>`. The key names the Page, not a workspace, so every workspace that has the Page (an agency
 *   and its client) reads the same list;
 * - or an answer that starts with "Edwyz test lead" (what Edwyz fills in) or "<test lead" (Meta's dummy answers), or the dummy
 *   phone number or email Edwyz fills in (so a form with no free-text question is still caught when the webhook arrives before
 *   the id is stored).
 * Lead ingest marks such a lead `isTest`, and skips the WhatsApp sequence, the conversion event and the routing notice.
 * LeadForm.testLeadUntil only drives the "Test sent" label.
 *
 * The stored value is {leads: [{id, at}]}: Meta lead ids and times only, no personal data. Old entries are dropped on every
 * write, and reads ignore entries older than 30 days.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * Whether lead ingest (src/lib/leads/ingest.ts) marks test leads yet (D33): calls isTestLead and, for a test lead, sets
 * Lead.isTest and skips routing, the conversion event, automations and the WhatsApp sequence. While it is false, Edwyz sends no
 * test lead (409), because one would be handled as a real lead. The lead-ingest change sets it to true in the same commit;
 * tests/promote-lead-forms.test.ts fails while the two disagree.
 */
export const TEST_LEADS_MARKED_ON_INGEST = true;

/** What Edwyz writes into the name answer and every other free-text answer of a test lead it sends. */
export const TEST_LEAD_PREFIX = "Edwyz test lead";
/** How Meta's own dummy answers start ("<test lead: dummy data for full_name>"). */
export const META_TEST_LEAD_PREFIX = "<test lead";
/** The phone answer of a test lead Edwyz sends: a US 555-01xx number, reserved as fictional and a valid E.164 number for Meta. */
export const TEST_LEAD_PHONE = "+12025550142";
const TEST_LEAD_PHONE_DIGITS = TEST_LEAD_PHONE.slice(1); // 12025550142
/** The email answer of a test lead Edwyz sends (example.com is reserved, RFC 2606). */
export const testLeadEmail = (code: string) => `test.lead.${code.toLowerCase()}@example.com`;
const TEST_LEAD_EMAIL = /^test\.lead\.[a-z0-9]{1,20}@example\.com$/i;
const PHONE_TEXT = /^[+\d\s().-]{7,30}$/;
/** How long a test lead id is kept. */
export const TEST_LEAD_KEEP_DAYS = 30;
const KEEP_MS = TEST_LEAD_KEEP_DAYS * 86_400_000;
/** Ids kept per Page at most (10 an hour per form keeps any Page far below this). */
export const MAX_TEST_LEADS_PER_PAGE = 2_000;
const ATTEMPTS = 3;

const PAGE_ID = /^[0-9A-Za-z_]{1,64}$/;
const LEAD_ID = /^[0-9A-Za-z_-]{1,100}$/;

export const testLeadsKey = (pageMetaId: string) => `promote:test-leads:${pageMetaId}`;

export type StoredTestLead = { id: string; at: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The entries of a stored row that are still within 30 days of `now`, oldest first. */
export function liveEntries(raw: unknown, now: Date): StoredTestLead[] {
  const list = isObject(raw) && Array.isArray(raw.leads) ? raw.leads : [];
  const out: StoredTestLead[] = [];
  for (const e of list) {
    if (!isObject(e) || typeof e.id !== "string" || !LEAD_ID.test(e.id) || typeof e.at !== "string") continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || now.getTime() - at > KEEP_MS) continue;
    out.push({ id: e.id, at: e.at });
  }
  return out;
}

const isUniqueViolation = (e: unknown) => isObject(e) && (e as { code?: unknown }).code === "P2002";

/**
 * Remembers a test lead id for the Page. Concurrent writers do not lose each other's ids: the row is replaced only when it has
 * not changed since it was read (its updatedAt), with up to three tries, and a last plain write after that.
 */
export async function rememberTestLead(pageMetaId: string, leadId: string, now: Date = new Date()): Promise<void> {
  if (!PAGE_ID.test(pageMetaId) || !LEAD_ID.test(leadId)) return;
  const key = testLeadsKey(pageMetaId);
  const next = (raw: unknown) => {
    const kept = liveEntries(raw, now).filter((e) => e.id !== leadId);
    kept.push({ id: leadId, at: now.toISOString() });
    return { leads: kept.slice(-MAX_TEST_LEADS_PER_PAGE) } as unknown as Prisma.InputJsonValue;
  };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const row = await prisma.platformSetting.findUnique({ where: { key } });
    if (!row) {
      try {
        await prisma.platformSetting.create({ data: { key, value: next(null) } });
        return;
      } catch (e) {
        if (isUniqueViolation(e)) continue;
        throw e;
      }
    }
    const { count } = await prisma.platformSetting.updateMany({ where: { key, updatedAt: row.updatedAt }, data: { value: next(row.value) } });
    if (count === 1) return;
  }
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  const value = next(row?.value ?? null);
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/** The test lead ids stored for the Page within the last 30 days. */
export async function storedTestLeadIds(pageMetaId: string, now: Date = new Date()): Promise<string[]> {
  if (!PAGE_ID.test(pageMetaId)) return [];
  const row = await prisma.platformSetting.findUnique({ where: { key: testLeadsKey(pageMetaId) } });
  return liveEntries(row?.value ?? null, now).map((e) => e.id);
}

/** True when Meta answered `test_leads` with this lead id for the Page within the last 30 days. */
export async function isStoredTestLead(pageMetaId: string, leadId: string, now: Date = new Date()): Promise<boolean> {
  return (await storedTestLeadIds(pageMetaId, now)).includes(leadId);
}

/** An answer Edwyz or Meta filled into a test lead: the test text, Meta's dummy text, or Edwyz's dummy phone number or email. */
export function looksLikeTestAnswer(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.startsWith(TEST_LEAD_PREFIX) || v.toLowerCase().startsWith(META_TEST_LEAD_PREFIX)) return true;
  if (TEST_LEAD_EMAIL.test(v)) return true;
  if (!PHONE_TEXT.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  // With or without the +1 country code, in case Meta returns the number in national form.
  return digits === TEST_LEAD_PHONE_DIGITS || digits === TEST_LEAD_PHONE_DIGITS.slice(1);
}

/** Any answer of the lead (a field map, or Meta's field_data values) looks like a test answer. */
export function hasTestAnswers(fields: Record<string, unknown> | readonly { values?: unknown }[] | null | undefined): boolean {
  if (!fields) return false;
  const values: unknown[] = Array.isArray(fields)
    ? (fields as readonly { values?: unknown }[]).flatMap((f) => (Array.isArray(f?.values) ? f.values : []))
    : Object.values(fields as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v : [v]));
  return values.some(looksLikeTestAnswer);
}

/** D33 in one call, for lead ingest: a stored test lead id of the Page, or test answers. */
export async function isTestLead(input: { pageMetaId: string; leadId: string; fields?: Record<string, unknown> | readonly { values?: unknown }[] | null }, now: Date = new Date()): Promise<boolean> {
  if (hasTestAnswers(input.fields)) return true;
  return isStoredTestLead(input.pageMetaId, input.leadId, now);
}

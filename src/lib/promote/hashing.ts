/**
 * Hashing for customer-list audiences (docs/IG-PAGE-ADS-SPEC.md 3.7, 4.2 A2 to A4, D17, PRM-11). Every value is put in Meta's
 * normal form, then hashed with SHA-256 (lowercase hex), before it leaves Edwyz. promote/meta.ts refuses any row value that is
 * not already 64 hex characters, so plain text cannot reach Meta through it.
 *
 * Meta's normalisation:
 * - EMAIL: trimmed and lowercased.
 * - PHONE: digits only, with the country code and no leading zeros. A number without a country code gets the workspace's
 *   (+91 by default): "098765 43210" and "98765 43210" both become 919876543210. The rules are contacts/phone.ts
 *   normalizePhone, the same ones the inbox uses, so a contact hashes the way it is stored.
 * - FN and LN: lowercased, Unicode kept (NFC, so "José" typed either way hashes alike), punctuation and symbols removed.
 * - COUNTRY: the two-letter ISO code in lowercase ("in"). From the phone's calling code when it has one, else the workspace's.
 *
 * Pure: no database, no network, and nothing here logs. Plain values live only in the caller's memory for the length of one
 * batch; neither they nor their hashes are ever written to a log, a job error or a database row other than a forget job's
 * payload (promote/forget.ts), which is deleted once sent.
 */
import { createHash } from "node:crypto";
import { countryOfPhone } from "@/lib/broadcasts/country";
import { normalizePhone as normalizeContactPhone } from "@/lib/contacts/phone";

/** The columns of a customer-list upload (A2, A3), in this order. */
export const CUSTOMER_SCHEMA = ["EMAIL", "PHONE", "FN", "LN", "COUNTRY"] as const;
/** The columns of a removal (A4): the two that identify a person. */
export const IDENTITY_SCHEMA = ["EMAIL", "PHONE"] as const;
export type CustomerSchemaKey = (typeof CUSTOMER_SCHEMA)[number];

/** The workspace's calling code and country when a number has none (Edwyz workspaces are in India). */
export const DEFAULT_CALLING_CODE = "91";
export const DEFAULT_COUNTRY = "in";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** SHA-256 of the UTF-8 bytes, as lowercase hex. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A value already hashed the way Meta wants it. */
export const isHashed = (value: unknown): value is string => typeof value === "string" && HEX64.test(value);

/** "  John.Doe@Example.COM " -> "john.doe@example.com"; null when it is not an email address. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/** "+91 98765 43210", "098765 43210", "0091 9876543210" -> "919876543210"; null when it is not a phone number. */
export function normalizePhone(value: unknown, callingCode: string = DEFAULT_CALLING_CODE): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const e164 = normalizeContactPhone(String(value), /^\d{1,3}$/.test(callingCode) ? callingCode : DEFAULT_CALLING_CODE);
  return e164 ? e164.slice(1) : null;
}

/** "  Mary " -> "mary", "José" -> "josé", "O'Brien" -> "obrien", "राहुल" stays "राहुल"; null when nothing is left. */
export function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return name || null;
}

/** "IN" -> "in"; null unless it is two letters. */
export function normalizeCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const country = value.trim().toLowerCase();
  return /^[a-z]{2}$/.test(country) ? country : null;
}

/** A full name split the way people write it: the first word is the first name, the last word the last name. */
export function splitName(value: unknown): { first: string | null; last: string | null } {
  const words = typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean) : [];
  if (words.length === 0) return { first: null, last: null };
  return { first: normalizeName(words[0]), last: words.length > 1 ? normalizeName(words[words.length - 1]) : null };
}

const hashOrEmpty = (normal: string | null): string => (normal ? sha256Hex(normal) : "");

export type HashOptions = {
  /** The workspace's calling code for numbers without one. Default 91. */
  callingCode?: string;
  /** The workspace's country for a row whose phone names none. Default in. */
  country?: string;
};

export type CustomerInput = { email?: unknown; phone?: unknown; name?: unknown; country?: unknown };

/** The country of a normalised phone ("919876543210" -> "in"), or null when its calling code is not one we know. */
function countryOfDigits(digits: string | null): string | null {
  if (!digits) return null;
  const iso = countryOfPhone(`+${digits}`);
  return iso ? iso.toLowerCase() : null;
}

/**
 * One upload row in CUSTOMER_SCHEMA order, every value hashed (or "" when unknown). Null when the person has neither an email
 * nor a phone Meta could match: such a contact can't be included.
 */
export function customerRow(input: CustomerInput, options: HashOptions = {}): string[] | null {
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone, options.callingCode);
  if (!email && !phone) return null;
  const { first, last } = splitName(input.name);
  const country = normalizeCountry(input.country) ?? countryOfDigits(phone) ?? normalizeCountry(options.country ?? DEFAULT_COUNTRY);
  return [hashOrEmpty(email), hashOrEmpty(phone), hashOrEmpty(first), hashOrEmpty(last), hashOrEmpty(country)];
}

/** One removal row in IDENTITY_SCHEMA order (email, phone), hashed. Null when there is nothing to match the person by. */
export function identityRow(input: Pick<CustomerInput, "email" | "phone">, options: HashOptions = {}): string[] | null {
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone, options.callingCode);
  if (!email && !phone) return null;
  return [hashOrEmpty(email), hashOrEmpty(phone)];
}

/** The email Edwyz keeps for a contact: Contact.attributes.email (lead sync and imports write it there). */
export function contactEmail(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return null;
  const email = (attributes as Record<string, unknown>).email;
  return typeof email === "string" ? email : null;
}

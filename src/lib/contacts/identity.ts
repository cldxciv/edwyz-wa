/**
 * Contact identity under WhatsApp usernames. A person is known by a phone number, by a business-scoped user id (BSUID), or both.
 * The phone can be missing for people who message through a username, so nothing may assume a contact has one.
 */

export type IdentityLike = {
  phone?: string | null;
  bsuid?: string | null;
  username?: string | null;
  name?: string | null;
  waId?: string | null;
};

export type RecipientAddress = { phone: string } | { bsuid: string };

/** Longest BSUID we store. Meta documents a country prefix, a dot and up to 128 characters. */
export const MAX_BSUID_LENGTH = 140;
const BSUID_PATTERN = /^[A-Za-z]{2}\.[A-Za-z0-9]{1,128}$/;
const USERNAME_MAX = 60;

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export const hasPhone = (c: Pick<IdentityLike, "phone">): boolean => clean(c.phone).length > 0;
export const hasBsuid = (c: Pick<IdentityLike, "bsuid">): boolean => clean(c.bsuid).length > 0;

/** A BSUID is `<2-letter country>.<alphanumerics>`. Returns the trimmed value or null when it does not look like one. */
export function normalizeBsuid(value: unknown): string | null {
  const v = clean(value);
  if (!v || v.length > MAX_BSUID_LENGTH) return null;
  return BSUID_PATTERN.test(v) ? v : null;
}

/** Usernames are shown with a leading @ but stored without it. */
export function normalizeUsername(value: unknown): string | null {
  const v = clean(value).replace(/^@+/, "");
  if (!v || v.length > USERNAME_MAX || /\s/.test(v)) return null;
  return v;
}

/** `+<digits>` for a plausible phone (8 to 15 digits) or null. Digits only input (a wa_id) is read as already including the country code. */
export function phoneFromWaId(value: unknown): string | null {
  const v = clean(value);
  if (!/^\+?\d{8,15}$/.test(v)) return null;
  return `+${v.replace(/^\+/, "")}`;
}

export type NormalizedIdentity = { phone: string | null; bsuid: string | null; username: string | null; waId: string | null };

/**
 * Reads whatever identifiers an inbound payload carried and sorts them. A `from` or `wa_id` that is not a phone number (it has a
 * dot or letters) is treated as a BSUID, so a payload that puts the new id in the old field is still understood.
 */
export function normalizeIdentity(input: { from?: unknown; waId?: unknown; phone?: unknown; bsuid?: unknown; username?: unknown }): NormalizedIdentity {
  let bsuid = normalizeBsuid(input.bsuid);
  let phone: string | null = null;
  let waId: string | null = null;
  for (const raw of [input.waId, input.from, input.phone]) {
    const v = clean(raw);
    if (!v) continue;
    const asPhone = phoneFromWaId(v);
    if (asPhone) {
      phone = phone ?? asPhone;
      waId = waId ?? asPhone.slice(1);
    } else if (!bsuid) {
      bsuid = normalizeBsuid(v);
    }
  }
  return { phone, bsuid, username: normalizeUsername(input.username), waId };
}

/** A BSUID is long and opaque; people only need enough to tell two apart: `US.` plus the last six characters. */
export function shortBsuid(bsuid: string): string {
  const v = clean(bsuid);
  const dot = v.indexOf(".");
  const prefix = dot > 0 ? v.slice(0, dot + 1) : "";
  const rest = dot > 0 ? v.slice(dot + 1) : v;
  return rest.length <= 8 ? v : `${prefix}...${rest.slice(-6)}`;
}

/** What to call a contact: their name, then their username, then their phone number, then a short BSUID. */
export function displayName(c: IdentityLike): string {
  const name = clean(c.name);
  if (name) return name;
  const username = clean(c.username);
  if (username) return `@${username.replace(/^@+/, "")}`;
  const phone = clean(c.phone);
  if (phone) return phone;
  const bsuid = clean(c.bsuid);
  if (bsuid) return shortBsuid(bsuid);
  return "Unknown contact";
}

/** The line shown under the name: the most useful identifier that is not already the title. */
export function displaySubtitle(c: IdentityLike): string {
  const title = displayName(c);
  const options = [clean(c.phone), clean(c.username) ? `@${clean(c.username).replace(/^@+/, "")}` : "", clean(c.bsuid) ? shortBsuid(clean(c.bsuid)) : ""];
  return options.find((o) => o && o !== title) ?? "";
}

/** Text an avatar can draw initials from when a contact has no name: the phone, else the @username, else the BSUID. */
export function avatarHint(c: IdentityLike): string {
  const phone = clean(c.phone);
  if (phone) return phone;
  const username = clean(c.username).replace(/^@+/, "");
  if (username) return `@${username}`;
  return clean(c.bsuid);
}

/** How the Cloud API should address this contact: by phone when one is stored, otherwise by BSUID, otherwise nobody. */
export function recipientAddress(c: Pick<IdentityLike, "phone" | "bsuid">): RecipientAddress | null {
  const phone = clean(c.phone);
  if (phone) return { phone };
  const bsuid = clean(c.bsuid);
  return bsuid ? { bsuid } : null;
}

/** Plain-language reason shown when a contact cannot be messaged at all. */
export const NO_ADDRESS_MESSAGE = "This contact has no phone number or WhatsApp user id, so it cannot be messaged.";

/**
 * Prisma filter that matches a search string against every identifier a contact can have.
 * maskedPhone: the searcher sees phone numbers with the middle hidden, so a number query only matches the end of the number
 * and text containing digits never reaches the phone column. Otherwise a few digits could be slid along the number to read it.
 */
export function identitySearchFilter(q: string, opts: { maskedPhone?: boolean } = {}): Array<Record<string, unknown>> {
  const term = q.trim().slice(0, 100);
  if (!term) return [];
  const handle = term.replace(/^@+/, "");
  let phone: Array<Record<string, unknown>>;
  if (opts.maskedPhone) {
    const digits = /^[\d\s+().-]+$/.test(term) ? term.replace(/\D/g, "") : "";
    phone = digits ? [{ phone: { endsWith: digits } }] : [];
  } else {
    const digits = term.replace(/[^\d+]/g, "");
    phone = digits ? [{ phone: { contains: digits } }] : [];
  }
  return [{ name: { contains: term, mode: "insensitive" } }, ...phone, { username: { contains: handle, mode: "insensitive" } }, { bsuid: { contains: term, mode: "insensitive" } }];
}

/**
 * Why a template cannot go to this contact, or null when it can. Authentication (login code) templates need a phone number;
 * a contact known only by BSUID cannot receive them. Other categories reach BSUID-only contacts.
 */
export function templateBlockedFor(category: string | null | undefined, c: Pick<IdentityLike, "phone" | "bsuid">): string | null {
  if (!recipientAddress(c)) return NO_ADDRESS_MESSAGE;
  if (!hasPhone(c) && category?.toUpperCase() === "AUTHENTICATION") return "Login code templates need a phone number. This contact uses a WhatsApp username and has not shared theirs.";
  return null;
}

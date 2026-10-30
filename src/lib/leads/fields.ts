import { normalizePhone } from "@/lib/contacts/phone";

export const LEAD_STATUSES = ["new", "contacted", "qualified", "won", "lost", "invalid"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

const MAX_FIELDS = 60;
const MAX_VALUE = 500;
const PHONE_KEYS = ["phone_number", "phone", "mobile", "mobile_number", "whatsapp_number", "whatsapp"];
const EMAIL_KEYS = ["email", "email_address"];

const normalizeAnswer = (v: string) => v.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const NEGATION = new Set(["no", "not", "never", "don", "dont", "nope", "nein", "non", "nunca", "jamais", "nao", "kein", "keine", "nicht", "pas", "nahi", "nahin", "nhi"]);
const FILLER = /\b(please|thanks|thank you|gracias|por favor|merci|s il vous plait|danke|bitte)\b/g;
const AFFIRM_LEAD = new Set(["yes", "si", "oui", "ja", "haan"]);
/** Whole answers that are an explicit yes (English, Spanish, French, German), after lower-casing and removing accents and punctuation. */
const AFFIRMATIVE = new Set([
  "yes", "true", "1", "on", "checked", "agree", "agreed", "accept", "accepted", "consent", "consented",
  "i agree", "i consent", "i accept", "si", "acepto", "de acuerdo", "estoy de acuerdo", "doy mi consentimiento",
  "haan", "ha", "oui", "d accord", "j accepte", "je suis d accord", "je consens", "ja", "einverstanden", "zugestimmt", "akzeptiert",
  "ich stimme zu", "ich akzeptiere", "ich bin einverstanden", "ich willige ein",
]);
/** Statements of agreement that may continue with free text ("I agree to receive WhatsApp messages"); a negation anywhere still rejects. */
const AGREEMENT_PREFIX = ["i agree", "i consent", "i accept", "i give my consent", "acepto", "estoy de acuerdo", "doy mi consentimiento", "j accepte", "je suis d accord", "ich stimme zu", "ich bin einverstanden", "ich akzeptiere", "ich willige ein"];

const agreementPhrase = (core: string) => AFFIRMATIVE.has(core) || AGREEMENT_PREFIX.some((p) => core === p || core.startsWith(`${p} `));

/**
 * Only an explicit affirmative is consent: yes, true, 1, on, checked, agree(d), accept(ed), "I agree", "I consent" and the
 * Spanish, French, German and Hindi (haan, ha) equivalents, matched case-insensitively with punctuation and accents removed, optionally with "please" or a following statement of agreement ("yes, I agree").
 * Anything else, including unknown free text and any answer containing a negation ("not now", "yes but not WhatsApp"), is not.
 */
export function isAffirmative(value: string): boolean {
  const n = normalizeAnswer(value);
  if (!n || n.length > 200) return false;
  if (n.split(" ").some((t) => NEGATION.has(t))) return false;
  const core = n.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  if (agreementPhrase(core)) return true;
  const [lead, ...rest] = core.split(" ");
  return AFFIRM_LEAD.has(lead) && rest.length > 0 && agreementPhrase(rest.join(" "));
}

/** A clear no. It lets an explicit refusal in a marketing-style field veto consent even when the field name is not obviously a consent field. */
export function isNegative(value: string): boolean {
  const n = normalizeAnswer(value);
  const first = n.split(" ")[0];
  return ["false", "0", "off", "unchecked", "n"].includes(n) || ["no", "nope", "nein", "non", "never", "nunca", "jamais", "nao", "nahi", "nahin"].includes(first);
}

const words = (key: string) => key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const TERMS_WORDS = new Set(["terms", "conditions", "privacy", "policy", "tos", "tnc", "cookies", "cookie", "gdpr", "processing", "storage", "personal", "profiling"]);
/** Words that name a marketing channel or what is sent through it. On their own (no consent verb) they only make a "channel" field. */
const STRONG_CHANNEL = new Set([
  "whatsapp", "marketing", "update", "updates", "offer", "offers", "promotion", "promotions", "promotional", "newsletter", "notification", "notifications",
  "communication", "communications", "sms", "alert", "alerts", "reminder", "reminders", "subscribe", "subscription",
]);
/** Words too generic to identify a consent field alone: a free-text "message" or "contact" question is not one. They count only next to a consent verb. */
const WEAK_CHANNEL = new Set(["message", "messages", "messaging", "contact", "contacted", "call", "calls", "receive"]);
const CONSENT_VERBS = new Set(["consent", "consents", "agree", "permission", "accept", "allow", "ok", "okay", "authorize", "authorise", "permit"]);
/** A field about one of these is data, not a consent checkbox, even when the name also says whatsapp or updates ("whatsapp_number"). */
const DATA_WORDS = new Set(["number", "phone", "mobile", "email", "name", "budget", "time", "date", "address", "city", "country", "zip", "company", "title", "id"]);

const hasChannelWord = (w: string[]) => w.some((x) => STRONG_CHANNEL.has(x) || WEAK_CHANNEL.has(x));

export type ConsentKind = "consent" | "channel" | null;

/**
 * How a question reads, judged by its name and, when the form definition supplies one, its label.
 * "consent": an opt-in phrase, or a consent verb (consent, agree, accept, allow, ok, permission) together with a messaging word
 * (marketing, messages, whatsapp, updates, offers, contact and so on). A bare "consent" or "agree" names no purpose, so a data-sharing
 * checkbox is not marketing consent. "channel": a messaging word with no verb (whatsapp_updates, receive_offers, subscribe_to_offers);
 * it is a consent checkbox only when its answer is yes or no, because free-text questions use the same words (marketing_budget).
 * Terms, privacy and data-processing fields are neither unless they also name a messaging channel.
 */
export function consentKind(key: string, label?: string | null): ConsentKind {
  const text = label ? `${key} ${label.slice(0, 200)}` : key;
  const w = words(text);
  const channel = hasChannelWord(w);
  if (w.some((x) => TERMS_WORDS.has(x)) && !channel) return null;
  if (w.includes("optin") || w.some((x, i) => x === "opt" && w[i + 1] === "in")) return "consent";
  if (w.some((x) => CONSENT_VERBS.has(x)) && channel) return "consent";
  if (!w.some((x) => DATA_WORDS.has(x)) && w.some((x) => STRONG_CHANNEL.has(x))) return "channel";
  return null;
}

/** True for any field that can record marketing consent, judged by name and optional label. See consentKind. */
export function isConsentKey(key: string, label?: string | null): boolean {
  return consentKind(key, label) !== null;
}

/** A bare "consent" or "opt in" style name with no stated purpose: not evidence of marketing consent, but a form that has one is not a form without a consent question. */
export function isUnspecificConsentKey(key: string, label?: string | null): boolean {
  const w = words(label ? `${key} ${label.slice(0, 200)}` : key);
  return consentKind(key, label) === null && !w.some((x) => TERMS_WORDS.has(x)) && w.some((x) => x === "consent" || x === "consents");
}

const isContactKey = (k: string) => PHONE_KEYS.includes(k) || EMAIL_KEYS.includes(k);

export type FieldDataEntry = { name?: unknown; values?: unknown };

/** Turns Meta field_data into a flat map. Keys are lower-cased; multiple values are joined with ", ". */
export function mapFieldData(fieldData: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(fieldData)) return out;
  for (const entry of fieldData.slice(0, MAX_FIELDS) as FieldDataEntry[]) {
    if (!entry || typeof entry.name !== "string" || !Array.isArray(entry.values)) continue;
    const key = entry.name.trim().toLowerCase().slice(0, 100);
    const value = entry.values.filter((v): v is string => typeof v === "string").join(", ").trim().slice(0, MAX_VALUE);
    if (key && value) out[key] = value;
  }
  return out;
}

/** Names of every question in Meta field_data, including ones with an empty answer (which mapFieldData drops). */
export function mapFieldNames(fieldData: unknown): string[] {
  if (!Array.isArray(fieldData)) return [];
  const names = new Set<string>();
  for (const entry of fieldData.slice(0, MAX_FIELDS) as FieldDataEntry[]) {
    if (entry && typeof entry.name === "string" && entry.name.trim()) names.add(entry.name.trim().toLowerCase().slice(0, 100));
  }
  return [...names];
}

function firstOf(fields: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) if (fields[k]) return fields[k];
  return undefined;
}

export type Identity = { phone: string | null; name: string | null; email: string | null };

export function extractIdentity(fields: Record<string, string>): Identity {
  const rawPhone = firstOf(fields, PHONE_KEYS);
  const full = fields.full_name ?? fields.name;
  const joined = [fields.first_name, fields.last_name].filter(Boolean).join(" ");
  const email = firstOf(fields, EMAIL_KEYS);
  return {
    phone: rawPhone ? normalizePhone(rawPhone) : null,
    name: (full || joined || null)?.slice(0, 200) ?? null,
    email: email && /^\S+@\S+\.\S+$/.test(email) ? email.slice(0, 200) : null,
  };
}

export type Consent = { given: boolean; text: string | null };

export type ConsentOptions = {
  consentAssumed?: boolean;
  /** Every question name Meta sent, including empty answers. An optional consent checkbox sent empty then counts as not consenting. */
  presentKeys?: string[];
  /** Consent questions defined by the form itself (from the Meta form definition, labels included), so an unchecked box that Meta omits is still known. */
  formConsentKeys?: string[];
  /** Questions the form definition ties to a messaging channel without a consent verb (a "WhatsApp updates" checkbox). Evidence only when answered yes or no, or when no other consent question exists. */
  formChannelKeys?: string[];
  /** Only false, read from the form definition, lets consentAssumed apply: the form is known to have no consent question. Unknown never assumes consent. */
  formHasConsentField?: boolean;
};

const allKeys = (fields: Record<string, string>, options: ConsentOptions) =>
  [...new Set([...Object.keys(fields), ...(options.presentKeys ?? []), ...(options.formConsentKeys ?? []), ...(options.formChannelKeys ?? [])])];

type Classified = { consentKeys: string[]; unspecific: boolean };

/**
 * Which of the lead's questions (answered or not) and the form's questions record marketing consent.
 * - A consent question (opt-in phrase, or consent verb with a messaging word, or defined so by the form) always counts.
 * - A channel question (whatsapp_updates, receive_offers) counts when its answer is yes or no. When the form has no consent
 *   question at all it counts even if left empty or omitted, because then it is the only consent checkbox there is. A
 *   free-text answer ("marketing_budget: 5000") means it was never a checkbox and is ignored.
 * - Free-text fields that merely mention a message or contact never count, whatever the answer says.
 */
function classify(fields: Record<string, string>, options: ConsentOptions): Classified {
  const hardKnown = new Set(options.formConsentKeys ?? []);
  const channelKnown = new Set(options.formChannelKeys ?? []);
  const keys = allKeys(fields, options);
  const hard = keys.filter((k) => hardKnown.has(k) || (!isContactKey(k) && consentKind(k) === "consent"));
  const channel = keys.filter((k) => !hard.includes(k) && !isContactKey(k) && (channelKnown.has(k) || consentKind(k) === "channel"));
  const counted = channel.filter((k) => {
    const v = fields[k];
    return v === undefined ? hard.length === 0 : isAffirmative(v) || isNegative(v);
  });
  return { consentKeys: [...hard, ...counted], unspecific: keys.some((k) => isUnspecificConsentKey(k)) };
}

/** True when the lead or the form definition has at least one question that could record consent, answered or not. */
export function hasConsentField(fields: Record<string, string>, options: ConsentOptions = {}): boolean {
  const c = classify(fields, options);
  return c.consentKeys.length > 0 || c.unspecific;
}

/**
 * Opt-in is recorded only with evidence from the lead: every consent question answered with an explicit affirmative. An
 * answer that is anything else, or an empty or missing answer to a consent question the lead or the form has, is not
 * consent. The form's consent text alone is not evidence; it counts only when the form definition confirms there is no
 * consent question (no question that could be one, not even a vague "consent" field) and the tenant has explicitly set
 * consentAssumed for the form.
 */
export function detectConsent(fields: Record<string, string>, formConsentText: string | null | undefined, options: ConsentOptions = {}): Consent {
  const { consentKeys, unspecific } = classify(fields, options);
  if (consentKeys.length > 0) {
    const given = consentKeys.every((k) => fields[k] !== undefined && isAffirmative(fields[k]));
    return { given, text: given ? (formConsentText?.trim() || consentKeys[0]) : null };
  }
  const text = formConsentText?.trim();
  return options.consentAssumed === true && options.formHasConsentField === false && !unspecific && text ? { given: true, text } : { given: false, text: null };
}

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}

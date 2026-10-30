/**
 * Help and explanations (docs/EDDY-SPEC.md 4.6): search_help over src/lib/eddy/knowledge/help.json, and explain_error for
 * WhatsApp error codes. Both are instant reads with no side effects.
 *
 * help.json `source` URLs are never returned: they are where the facts were checked, not something to show (6.15). A fix that
 * can only be made in Meta's own settings returns a `metaScreen` id; the card turns it into the labelled "Opens Meta" link with
 * src/lib/eddy/meta-links.ts (12.1a decision 10), so no Meta URL ever reaches the model.
 */
import knowledge from "@/lib/eddy/knowledge/help.json";
import { metaScreenForError, type MetaLinkScreen } from "@/lib/eddy/meta-links";
import { define, int, obj, str } from "./shared";

// ===== WhatsApp error codes =====

/** The fix a failed message or recipient points to: a button or next step the panel and the inbox know. */
export type FixKey =
  | "pick_template"
  | "not_on_whatsapp"
  | "try_later"
  | "reconnect"
  | "opted_out"
  | "fix_template"
  | "check_attachment"
  | "meta_payment_method"
  | "meta_display_name"
  | "contact_support"
  | "none";

const FIX_FOR_CODE: Readonly<Record<string, FixKey>> = Object.freeze({
  "131047": "pick_template",
  "131026": "not_on_whatsapp",
  "131049": "try_later",
  "131048": "try_later",
  "131056": "try_later",
  "130429": "try_later",
  "80007": "try_later",
  "131016": "try_later",
  "131057": "try_later",
  "130472": "try_later",
  "131050": "opted_out",
  opted_out: "opted_out",
  "132000": "fix_template",
  "132001": "pick_template",
  "132005": "fix_template",
  "132012": "fix_template",
  "132015": "pick_template",
  "132016": "pick_template",
  missing_variable: "fix_template",
  "131053": "check_attachment",
  "131051": "check_attachment",
  "190": "reconnect",
  auth_expired: "reconnect",
  "131005": "reconnect",
  "131042": "meta_payment_method",
  "131037": "meta_display_name",
  "131000": "contact_support",
  "135000": "contact_support",
});

export const ERROR_CODE_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

export type ErrorExplanation = { code: string; text: string; hint: string; fix: FixKey; metaScreen: MetaLinkScreen | null };

/** Plain text, a hint and a fix key for a WhatsApp or Edwyz error code (errorCodeText first, then the inbox's failureHint). */
export async function explainCode(code: string): Promise<ErrorExplanation> {
  const key = code.trim();
  const [{ errorCodeText }, { failureHint }] = await Promise.all([import("@/lib/broadcasts/errors"), import("@/components/inbox/ux")]);
  const hint = failureHint(key);
  const text = errorCodeText(key) ?? hint;
  return { code: key, text, hint, fix: FIX_FOR_CODE[key] ?? "none", metaScreen: metaScreenForError(key) };
}

/** The fix key alone, without loading the text tables (for result rows). */
export const fixForCode = (code: string | null | undefined): FixKey => (code ? (FIX_FOR_CODE[code.trim()] ?? "none") : "none");

// ===== Help knowledge =====

export type HelpEntry = { id: string; title: string; keywords: string[]; body: string; source: string; lastReviewed: string };
export const HELP_ENTRIES: readonly HelpEntry[] = Object.freeze((knowledge as { entries: HelpEntry[] }).entries.map((e) => Object.freeze({ ...e, keywords: [...e.keywords] })));

const words = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1);

/** Keyword search: a keyword phrase in the query counts most, then title words, then body words. Best first, at most `limit`. */
export function searchHelp(query: string, limit = 3): { entry: HelpEntry; score: number }[] {
  const q = query.toLowerCase();
  const qWords = new Set(words(query));
  if (qWords.size === 0) return [];
  const scored = HELP_ENTRIES.map((entry) => {
    let score = 0;
    for (const k of entry.keywords) if (q.includes(k.toLowerCase())) score += 5;
    for (const w of words(entry.title)) if (qWords.has(w)) score += 2;
    for (const w of new Set(words(entry.body))) if (qWords.has(w) && w.length > 3) score += 1;
    return { entry, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1))
    .slice(0, limit);
}

// ===== Definitions =====

type HelpResult = { results: { id: string; title: string; body: string; lastReviewed: string }[] };

const searchHelpDef = define<{ query: string; limit?: number }, HelpResult>({
  name: "search_help",
  version: "v1",
  area: "help",
  surfaces: ["eddy"],
  titleKey: "status.search_help",
  description:
    "Searches Edwyz's help notes about WhatsApp rules and the product: the 24-hour window, template categories, opt-in, quality rating, messaging limits, pricing basics, coexistence, spending limits, template review and steps done in Meta. Use it before explaining a rule, and answer from what it returns. The notes are Edwyz's own text.",
  inputSchema: obj({ query: str("What the member asked about, in a few words.", 200, 2), limit: int("How many notes to return.", 1, 5) }, ["query"]),
  minRole: "agent",
  route: "virtual",
  effects: { writes: false },
  untrustedPaths: [],
  async authorize() {},
  async run(_ctx, a) {
    const results = searchHelp(a.query, a.limit ?? 3).map(({ entry }) => ({ id: entry.id, title: entry.title, body: entry.body, lastReviewed: entry.lastReviewed }));
    return { result: { results }, auditTarget: "help" };
  },
  forModel: (r) => (r.results.length ? r : { results: [], note: "No help note matches. Say what you know is certain, and suggest asking support for the rest." }),
});

const explainErrorDef = define<{ code: string }, ErrorExplanation>({
  name: "explain_error",
  version: "v1",
  area: "help",
  surfaces: ["eddy"],
  titleKey: "status.explain_error",
  description:
    "Explains a WhatsApp or Edwyz error code in plain words, with the fix to offer. `fix` is one of pick_template, not_on_whatsapp, try_later, reconnect, opted_out, fix_template, check_attachment, meta_payment_method, meta_display_name, contact_support, none. When `metaScreen` is set, the fix is done in Meta's own settings: say so; the app shows the labelled link itself, so never write a link.",
  inputSchema: obj({ code: { type: "string", pattern: "^[A-Za-z0-9_]{1,40}$", description: "The error code, for example 131047." } }, ["code"]),
  minRole: "agent",
  route: "virtual",
  effects: { writes: false },
  untrustedPaths: [],
  async authorize() {},
  async run(_ctx, a) {
    return { result: await explainCode(a.code), auditTarget: a.code };
  },
  forModel: (r) => r,
});

export const HELP_DEFS = [explainErrorDef, searchHelpDef];

/**
 * Language detection for Eddy (docs/EDDY-SPEC.md 5.7). Pure: no database, no network, no model call.
 *
 * Every member message is classified on its own, because people switch language in the middle of a conversation. The
 * result is passed to the model as `reply_language` in the context note and never left for the model to guess:
 *
 *   1. A saved preference other than `auto` wins.
 *   2. Code spans, URLs, emails, numbers, @mentions and the names of known templates are stripped first.
 *   3. When at least 30% of the letters are Devanagari, the language is `hi` (Latin product words inside Hindi are fine).
 *   4. Otherwise Roman-Hindi markers are scored against a curated lexicon (about 180 words, seeded from
 *      chatbots/escalation-detect.ts). English collisions are left out (to, me, he, band, par, ...), and `main` counts
 *      only when no English word follows it. At least 2 hits and at least 20% of the words gives `hinglish`, else `en`.
 *   5. A Latin message of 2 words or fewer, or only numbers, "ok", "yes" or "haan", keeps the previous language
 *      (confidence low). A short message in Devanagari is not ambiguous: its script decides.
 *   6. A message mostly in another script (Tamil, Bengali, Gujarati, Urdu, ...) gets `en` with `unsupported: true`; the reply
 *      then starts with the catalogue line `lang.unsupported`. Marathi and Nepali (Devanagari) get `hi`: a known limitation.
 *
 * customerLanguage() applies the same rules to the last 5 inbound messages of a chat, for drafts written to customers.
 */
import type { EddyLang, EddyLangPref } from "./contract";

export type LanguageConfidence = "high" | "low";

export type LanguageReason = "pref" | "devanagari" | "hinglish" | "english" | "short" | "other_script" | "empty";

export type DetectedLanguage = {
  lang: EddyLang;
  confidence: LanguageConfidence;
  /** Rule 6: the message was mostly in a script Eddy does not answer in; the reply starts with `lang.unsupported`. */
  unsupported: boolean;
  reason: LanguageReason;
};

export type DetectOptions = {
  /** Names of the workspace's templates (`diwali_offer`): stripped before scoring, so a name never counts as a word. */
  templateNames?: readonly string[];
};

/** Rule 3: the Devanagari share of the letters that makes a message Hindi. */
export const DEVANAGARI_SHARE = 0.3;
/** Rule 4: hits needed, and their share of the words. */
export const HINGLISH_MIN_HITS = 2;
export const HINGLISH_MIN_SHARE = 0.2;
/** Rule 5: messages with at most this many words keep the previous language. */
export const SHORT_MESSAGE_WORDS = 2;
/** Rule 6: the share of letters in another script that makes a message unsupported. */
export const OTHER_SCRIPT_SHARE = 0.5;

/**
 * Roman-Hindi markers. Seeded from src/lib/chatbots/escalation-detect.ts (insaan, baat, bekar, pareshan, shikayat, ...)
 * and the 5.7 list, then extended with the common function words, pronouns, question words and polite verb forms people
 * type on WhatsApp. Words that are also everyday English are deliberately absent (see ENGLISH_COLLISIONS).
 */
const LEXICON_WORDS = [
  // 5.7 seed list
  "hai", "hain", "kya", "nahi", "nahin", "kar", "karo", "karna", "kardo", "kijiye", "kariye", "karein", "mera", "meri", "mujhe",
  "aap", "aapka", "kitna", "kitne", "kaise", "kab", "kahan", "kyun", "wala", "wali", "abhi", "bhejo", "dikhao", "batao",
  "chahiye", "gaya", "gayi", "hua", "hui", "raha", "sabko", "logon", "mein", "aur", "bhi", "tha", "thi", "haan", "ji",
  "accha", "theek", "kal", "aaj", "pehle", "baad", "sirf", "wapas", "chalu", "naya", "nayi",
  // escalation-detect.ts
  "insaan", "insan", "baat", "banda", "bekar", "bekaar", "bakwas", "faltu", "pareshan", "shikayat", "bahut", "bura", "ghatiya", "samajh", "karni",
  // verbs and polite forms
  "karte", "karta", "karti", "karke", "karwa", "karwana", "kiya", "kiye", "kiyaa", "diya", "diye", "dijiye", "dena", "dedo", "de", "le", "lo",
  "lijiye", "lena", "ho", "hoga", "hogi", "honge", "hota", "hoti", "hote", "rahi", "rahe", "gaye", "hue", "chal", "chalo", "chalega", "bata",
  "bataiye", "batana", "batayein", "dikha", "dikhaiye", "dikhana", "dikhayein", "bhej", "bhejiye", "bhejna", "bhejein", "bhejdo", "bhejni",
  "bheja", "bheji", "bheje", "chahte", "chahta", "chahti", "dekho", "dekhiye", "dekhna", "dekha", "samjhao", "samjhaiye", "mila", "mili",
  "milega", "milegi", "aaya", "aayi", "aaye", "aana", "jayega", "jaega", "jaye", "jaana", "jaata", "lagta", "laga", "lagi", "lage",
  "padha", "padhe", "padhi", "bola", "bolo", "boliye", "likho", "likhiye", "likhna", "daalo", "daliye", "hatao", "hataiye", "ruko", "roko",
  "rokiye", "rakho", "rakhiye", "pahuncha", "pahunchi", "bachi", "bacha", "bache", "badal", "badlo", "badliye", "kholo", "kholiye",
  // pronouns, possessives, demonstratives
  "aapki", "aapke", "mere", "apna", "apni", "apne", "hum", "hume", "humein", "humara", "humari", "tum", "tumhara", "tumhe", "ye", "yeh", "woh", "wo",
  "isko", "usko", "unko", "inko", "iska", "uska", "unka", "inka", "iski", "uski", "unki", "iske", "uske", "unke", "ise", "unhe",
  "kisi", "kisko", "kiska", "kiske", "kaun", "kis", "kuch", "koi", "sab", "sabhi", "yahan", "wahan",
  // particles, conjunctions, question words
  "ka", "ki", "ke", "ko", "se", "ne", "bhi", "toh", "tho", "ya", "lekin", "magar", "kyunki", "isliye", "agar", "phir", "fir", "kyon", "kyu",
  "kaisa", "kaisi", "kitni", "ab", "bas", "mat", "nai", "acha", "achha", "thik", "sahi", "galat", "matlab", "pata", "zyada", "jyada", "kam",
  "jaldi", "der", "shuru", "khatam", "zaroor", "jarur", "shukriya", "dhanyavad", "namaste", "namaskar", "bhai", "bhaiya", "didi",
  // time and quantities
  "din", "hafte", "hafta", "mahine", "mahina", "saal", "parso", "subah", "shaam", "raat", "kharcha", "paisa", "paise", "kaam", "baje",
  "purana", "purani", "purane", "naye", "sabse", "pichle", "pichla", "agle", "agla", "tak", "liye", "saath", "bina", "wale", "waali",
  // verb stems that take "do" / "dijiye" ("bana do", "hata do", "rok do"), and more everyday forms
  "ek", "likh", "bana", "banao", "banaiye", "bani", "hata", "rok", "badli", "badla", "badle", "sudhare", "sudhar", "sudharo", "karun", "karu",
  "kisne", "jisne", "unhone", "maine", "humne", "aapne", "baar", "chhota", "chhoti", "bada", "badi", "toot", "atka", "atki", "ruka", "ruki",
  "ruke", "kharch", "kharidne", "sambhali", "lagega", "lagegi", "rahega", "rahegi", "sakte", "sakta", "sakti", "payega", "kaha", "kahi",
  "bolna", "bhejta", "bhejte", "poocha", "puch", "puchh", "pooch", "dekh", "dikh", "sa", "si",
] as const;

/** Words that look Hindi but are everyday English, or carry no signal; never counted (5.7 rule 4). */
const ENGLISH_COLLISIONS = new Set(["to", "me", "he", "band", "par", "the", "do", "in", "us", "is", "log", "tab", "jab", "hi", "ha", "na", "dal", "main"]);

export const HINGLISH_LEXICON: ReadonlySet<string> = new Set(LEXICON_WORDS.filter((w) => !ENGLISH_COLLISIONS.has(w)));

/** Common English words; `main` followed by one of these is English ("main menu", "main number"). */
const ENGLISH_AFTER_MAIN = new Set([
  "menu", "page", "number", "account", "branch", "office", "screen", "reason", "thing", "issue", "problem", "contact", "template",
  "broadcast", "list", "dashboard", "inbox", "chat", "team", "admin", "owner", "store", "shop", "product", "offer", "campaign", "one",
  "point", "goal", "line", "road", "door", "course", "app", "settings", "setting", "flow", "bot", "the", "a", "an", "and", "is", "was",
]);

/** Tokens that carry no language on their own (rule 5). */
const NEUTRAL_SHORT = new Set(["ok", "okay", "okk", "k", "yes", "yep", "yeah", "no", "haan", "han", "hmm", "hm", "thanks", "thank", "thx", "ty", "done", "sure", "fine", "great", "cool"]);

const DEVANAGARI = /\p{Script=Devanagari}/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/gu;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rule 2: the message without code spans, URLs, emails, @mentions, numbers and known template names. */
export function stripForDetection(text: string, templateNames: readonly string[] = []): string {
  let s = String(text ?? "");
  s = s.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  s = s.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ");
  s = s.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, " ");
  s = s.replace(/(^|\s)@[\p{L}\p{N}_.-]+/gu, " ");
  for (const name of templateNames) {
    const n = String(name ?? "").trim();
    if (n.length >= 2 && n.length <= 512) s = s.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(n)}(?=$|[^\\p{L}\\p{N}_])`, "giu"), "$1 ");
  }
  // Template-like snake_case identifiers are names, not words.
  s = s.replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi, " ");
  s = s.replace(/[\p{N}₹$%.,:;/+\-–—()#*]+/gu, (m) => (/\p{L}/u.test(m) ? m : " "));
  return s.replace(/\s+/g, " ").trim();
}

type ScriptCounts = { devanagari: number; latin: number; other: number; total: number };

/** Letters (with combining marks, so Devanagari matras count) by script. */
export function scriptCounts(text: string): ScriptCounts {
  const out: ScriptCounts = { devanagari: 0, latin: 0, other: 0, total: 0 };
  for (const ch of text.match(LETTER_OR_MARK) ?? []) {
    out.total++;
    if (DEVANAGARI.test(ch)) out.devanagari++;
    else if (LATIN.test(ch)) out.latin++;
    else if (/\p{M}/u.test(ch)) {
      // A combining mark of no script of its own counts with the letters around it; treat it as neutral.
      out.total--;
    } else out.other++;
  }
  return out;
}

/** Lower-case Latin words (apostrophes dropped: "what's" -> "whats"). */
export function latinWords(text: string): string[] {
  return (text.toLowerCase().replace(/['’]/g, "").match(/[a-z]+/g) ?? []).filter((w) => w.length > 0);
}

/** Rule 4: Roman-Hindi hits among the words. */
export function hinglishHits(words: readonly string[]): number {
  let hits = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "main") {
      const next = words[i + 1];
      if (next === undefined || !ENGLISH_AFTER_MAIN.has(next)) hits++;
      continue;
    }
    if (HINGLISH_LEXICON.has(w)) hits++;
    // "do" is English too, but after a Hindi verb stem it is the Hindi imperative: "bana do", "hata do", "rok do".
    else if (w === "do" && i > 0 && HINGLISH_LEXICON.has(words[i - 1])) hits++;
  }
  return hits;
}

function isShortNeutral(words: readonly string[]): boolean {
  return words.length > 0 && words.every((w) => NEUTRAL_SHORT.has(w));
}

/**
 * Decides the reply language of one member message (5.7). `prev` is the conversation's last language; `pref` the member's
 * saved preference.
 */
export function detectLanguage(text: string, prev: EddyLang | null, pref: EddyLangPref = "auto", opts: DetectOptions = {}): DetectedLanguage {
  // Rule 1
  if (pref === "en" || pref === "hi" || pref === "hinglish") return { lang: pref, confidence: "high", unsupported: false, reason: "pref" };

  // Rule 2
  const stripped = stripForDetection(text, opts.templateNames);
  const counts = scriptCounts(stripped);
  const keep = (reason: LanguageReason): DetectedLanguage => ({ lang: prev ?? "en", confidence: "low", unsupported: false, reason });

  if (counts.total === 0) return keep("empty");

  // Rule 3
  if (counts.devanagari / counts.total >= DEVANAGARI_SHARE) return { lang: "hi", confidence: "high", unsupported: false, reason: "devanagari" };

  // Rule 6
  if (counts.other / counts.total >= OTHER_SCRIPT_SHARE || (counts.other > 0 && counts.latin === 0)) {
    return { lang: "en", confidence: "high", unsupported: true, reason: "other_script" };
  }

  // Rule 5
  const words = latinWords(stripped);
  if (words.length === 0) return keep("empty");
  if (words.length <= SHORT_MESSAGE_WORDS || isShortNeutral(words)) {
    if (prev) return keep("short");
    const hits = hinglishHits(words);
    return { lang: hits >= 1 && hits === words.length ? "hinglish" : "en", confidence: "low", unsupported: false, reason: "short" };
  }

  // Rule 4
  const hits = hinglishHits(words);
  if (hits >= HINGLISH_MIN_HITS && hits / words.length >= HINGLISH_MIN_SHARE) {
    return { lang: "hinglish", confidence: hits >= 3 ? "high" : "low", unsupported: false, reason: "hinglish" };
  }
  // A short message with one marker after Hinglish stays Hinglish ("template approve hua?"): the stickiness of rule 5.
  if (prev === "hinglish" && hits === 1 && words.length <= 4) return { lang: "hinglish", confidence: "low", unsupported: false, reason: "short" };
  return { lang: "en", confidence: hits === 0 ? "high" : "low", unsupported: false, reason: "english" };
}

/** How many of a chat's newest inbound messages decide the customer's language. */
export const CUSTOMER_LANGUAGE_WINDOW = 5;

/**
 * The language a customer writes in, from the last 5 inbound messages (oldest first or newest first: the newest wins a
 * tie). Messages in an unsupported script count as English. No messages means English.
 */
export function customerLanguage(inboundTexts: readonly string[], opts: DetectOptions & { newestFirst?: boolean } = {}): EddyLang {
  const texts = (opts.newestFirst ? [...inboundTexts].reverse() : [...inboundTexts]).filter((t) => typeof t === "string" && t.trim().length > 0);
  const recent = texts.slice(-CUSTOMER_LANGUAGE_WINDOW);
  if (recent.length === 0) return "en";
  const votes: Record<EddyLang, number> = { en: 0, hi: 0, hinglish: 0 };
  const lastSeen: Record<EddyLang, number> = { en: -1, hi: -1, hinglish: -1 };
  let prev: EddyLang | null = null;
  recent.forEach((text, i) => {
    const d = detectLanguage(text, prev, "auto", opts);
    const weight = d.confidence === "high" ? 2 : 1;
    votes[d.lang] += weight;
    lastSeen[d.lang] = i;
    prev = d.lang;
  });
  const order: EddyLang[] = ["en", "hi", "hinglish"];
  return order.reduce((best, lang) => (votes[lang] > votes[best] || (votes[lang] === votes[best] && lastSeen[lang] > lastSeen[best]) ? lang : best), "en" as EddyLang);
}

/** The script Eddy replies in for a language (context note `reply_script`). */
export function replyScript(lang: EddyLang): "Latin" | "Devanagari" {
  return lang === "hi" ? "Devanagari" : "Latin";
}

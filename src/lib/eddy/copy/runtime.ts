/**
 * Copy of Eddy's loop and HTTP API (docs/EDDY-SPEC.md 5.9, 5.11, 6.11, 6.12), in English, Hindi and Hinglish. An area
 * catalogue: tests/eddy-i18n.test.ts scans it with the core rules (same keys and placeholders in all three languages, only
 * allowlisted Latin in Hindi, no Devanagari in Hinglish, no gendered first person, no banned words, emojis or "!").
 *
 * Most turn errors already have core keys (busy, service_down, refusal, error.*); this file adds the few lines only the loop
 * says, and maps every error state of a turn to its key, so the panel and the route render the same sentence.
 */
import type { EddyLang, EddyState } from "../contract";
import { CORE, defineCatalogue, makeTranslator, registerCatalogue, type CoreKey } from "../i18n";

export const catalogue = defineCatalogue({
  en: {
    "runtime.new_chat": "Eddy started a new chat, because the last one could not continue. Ask again if anything is missing.",
    "runtime.daily_turn_cap": "This workspace has used today's Eddy messages. The limit resets tomorrow.",
    "runtime.stopped": "Stopped. Anything already done stays done, and nothing else will run.",
    "runtime.turn_limit": "Eddy reached its limit for one message. Ask for the rest in your next message.",
    "runtime.empty": "Type a message first.",
  },
  hi: {
    "runtime.new_chat": "पिछली चैट आगे नहीं चल पाई, इसलिए Eddy ने नई चैट शुरू की है। कुछ छूट गया हो तो दोबारा पूछें।",
    "runtime.daily_turn_cap": "इस वर्कस्पेस में आज के Eddy मैसेज की सीमा पूरी हो गई है। यह कल फिर शुरू होगी।",
    "runtime.stopped": "रोक दिया गया। जो हो चुका है वह वैसा ही रहेगा, और आगे कुछ नहीं चलेगा।",
    "runtime.turn_limit": "एक मैसेज के लिए Eddy की सीमा पूरी हो गई है। बाकी काम अगले मैसेज में पूछें।",
    "runtime.empty": "पहले कोई मैसेज लिखें।",
  },
  hinglish: {
    "runtime.new_chat": "Pichli chat aage nahi chal payi, isliye Eddy ne nayi chat shuru ki hai. Kuch chhoot gaya ho to dobara poochhiye.",
    "runtime.daily_turn_cap": "Is workspace mein aaj ke Eddy messages ki limit poori ho gayi hai. Yeh kal phir shuru hogi.",
    "runtime.stopped": "Rok diya gaya. Jo ho chuka hai woh waisa hi rahega, aur aage kuch nahi chalega.",
    "runtime.turn_limit": "Ek message ke liye Eddy ki limit poori ho gayi hai. Baaki kaam agle message mein poochhiye.",
    "runtime.empty": "Pehle koi message likhiye.",
  },
});

registerCatalogue(catalogue);

export type RuntimeKey = keyof typeof catalogue.en;

/** Translates core and runtime keys. */
export const tr = makeTranslator(CORE, catalogue);

/** The catalogue key of every error state a turn can end in (the SSE `error` event). */
export const ERROR_STATE_KEY: Readonly<Record<EddyState, CoreKey | RuntimeKey>> = {
  platform_off: "off.platform",
  locked: "locked.admin",
  workspace_off: "eddy.state.workspace_off",
  paused: "spend.frozen",
  allowance_used: "allowance.needs",
  user_capped: "user_capped",
  ready: "eddy.state.ready",
  service_down: "service_down",
  busy: "error.busy",
  turn_in_progress: "busy",
  rate_limited: "error.rate_limited",
  message_too_long: "error.message_too_long",
  truncated: "error.truncated",
  refusal_pause: "error.refusal_pause",
  internal: "error.internal",
};

/**
 * The sentence for an error event in the member's language. `params` fill the placeholders (allowance.needs takes need and
 * left); a platform_off with reason paused uses off.platform_paused, an allowance_used without figures the plain line.
 */
export function errorText(lang: EddyLang, state: EddyState, params: Record<string, string | number> = {}): string {
  if (state === "platform_off" && params.reason === "paused") return tr(lang, "off.platform_paused");
  if (state === "allowance_used" && (params.need === undefined || params.left === undefined)) return tr(lang, params.period === "day" ? "allowance.used_today" : "allowance.used", { date: params.date });
  if (state === "rate_limited" && params.reason === "daily_turn_cap") return tr(lang, "runtime.daily_turn_cap");
  return tr(lang, ERROR_STATE_KEY[state] ?? "error.internal", params);
}

/**
 * Customer-facing order words (docs/specs/META-CATALOG-COMMERCE-SPEC.md 2.13, 2.16, 3.6 and D-C13, D-C14, D-C19).
 * Pure: no database, no network.
 *
 * - The order acknowledgement ("We got your order") in English, Hindi and Hinglish, sent free inside the 24-hour window.
 * - The in-window status messages a member sends with one tap (editable before sending), in the same three languages.
 * - The order-update templates for after the window: UTILITY templates named edwyz_order_<status>_<en|hi>, created and
 *   submitted with one tap. Meta refuses a body that starts or ends with a placeholder, so none does (tests check each with
 *   variableAtEdge from src/lib/templates/validate.ts). Change a body only together with a new template name: an approved
 *   template's text is fixed.
 */
import { formatMinor } from "@/lib/spend/money";
import type { OrderStatus } from "../catalog/types";

export const ORDER_LANGS = ["en", "hi", "hinglish"] as const;
export type OrderLang = (typeof ORDER_LANGS)[number];

/** Values a message can use, written in braces: {first name}, {number}, {items}, {total}, {tracking link}, {reason}. */
export const ORDER_PLACEHOLDERS = ["first name", "number", "items", "total", "tracking link", "reason"] as const;

// =====================================================================================================================
// Acknowledgement (2.13)
// =====================================================================================================================

export const ORDER_ACK_PRESETS: Readonly<Record<OrderLang, string>> = Object.freeze({
  en: "Thank you {first name}. We got your order #{number} for {items}, {total}. We will confirm it soon.",
  hi: "धन्यवाद {first name}। हमें आपका ऑर्डर #{number} मिल गया है: {items}, {total}। हम जल्द ही इसकी पुष्टि करेंगे।",
  hinglish: "Thank you {first name}. Aapka order #{number} mil gaya hai: {items}, {total}. Hum jaldi confirm karenge.",
});

/** {items}: "3 items" in each language. */
export function itemsText(count: number, lang: OrderLang): string {
  if (lang === "hi") return `${count} आइटम`;
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/** {total} when Meta sent no prices. */
export const TOTAL_UNKNOWN: Readonly<Record<OrderLang, string>> = Object.freeze({
  en: "price to be confirmed",
  hi: "कीमत बाद में बताएंगे",
  hinglish: "price baad mein batayenge",
});

/** {tracking link} and {reason} when the member gave none. */
export const NOT_SHARED: Readonly<Record<OrderLang, string>> = Object.freeze({
  en: "not shared",
  hi: "नहीं बताया गया",
  hinglish: "nahi bataya gaya",
});

export type OrderTextVars = {
  firstName?: string | null;
  number: number | string;
  itemCount?: number;
  totalMinor?: string | bigint | null;
  currency?: string | null;
  trackingUrl?: string | null;
  reason?: string | null;
};

/** A first name safe to put in a message: one line, at most 60 characters. */
function nameOf(name: string | null | undefined): string {
  return String(name ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .split(/\s+/)[0]
    ?.slice(0, 60) ?? "";
}

/**
 * Fills an order text in its language. Without a first name, "{first name}" goes away with the space before it
 * ("Thank you {first name}." becomes "Thank you."). An unknown total reads "price to be confirmed".
 */
export function renderOrderText(text: string, lang: OrderLang, vars: OrderTextVars): string {
  const first = nameOf(vars.firstName);
  const total =
    vars.totalMinor !== null && vars.totalMinor !== undefined && vars.currency ? formatMinor(vars.totalMinor, vars.currency) : TOTAL_UNKNOWN[lang];
  const values: Record<string, string> = {
    number: String(vars.number).replace(/^#/, ""),
    items: itemsText(vars.itemCount ?? 0, lang),
    total,
    "tracking link": vars.trackingUrl?.trim() || NOT_SHARED[lang],
    reason: vars.reason?.trim() || NOT_SHARED[lang],
  };
  const withName = first ? text.replace(/\{first name\}/g, first) : text.replace(/ ?\{first name\}/g, "");
  return withName.replace(/\{(number|items|total|tracking link|reason)\}/g, (_, key: string) => values[key]).slice(0, 4096);
}

/** The acknowledgement for a new order: the workspace's own text when it set one, else the preset of its language. */
export function renderOrderAck(lang: OrderLang, vars: OrderTextVars, customText?: string | null): string {
  const text = customText?.trim() ? customText : ORDER_ACK_PRESETS[lang];
  return renderOrderText(text, lang, vars);
}

// =====================================================================================================================
// In-window status messages (2.13: editable before sending)
// =====================================================================================================================

/** Statuses a member can tell the customer about. */
export type NotifyStatus = Exclude<OrderStatus, "new">;

export const ORDER_UPDATE_TEXTS: Readonly<Record<NotifyStatus, Readonly<Record<OrderLang, string>>>> = Object.freeze({
  confirmed: {
    en: "Your order #{number} is confirmed. We will tell you when it ships.",
    hi: "आपका ऑर्डर #{number} कन्फर्म हो गया है। शिप होने पर हम आपको बताएंगे।",
    hinglish: "Aapka order #{number} confirm ho gaya hai. Ship hone par hum aapko batayenge.",
  },
  packed: {
    en: "Your order #{number} is packed and will ship soon.",
    hi: "आपका ऑर्डर #{number} पैक हो गया है और जल्द ही शिप होगा।",
    hinglish: "Aapka order #{number} pack ho gaya hai aur jaldi ship hoga.",
  },
  shipped: {
    en: "Your order #{number} has shipped. Track it here: {tracking link}. Thank you for shopping with us.",
    hi: "आपका ऑर्डर #{number} शिप हो गया है। इसे यहां ट्रैक करें: {tracking link}। हमसे खरीदारी करने के लिए धन्यवाद।",
    hinglish: "Aapka order #{number} ship ho gaya hai. Yahan track karein: {tracking link}. Humse shopping karne ke liye thank you.",
  },
  delivered: {
    en: "Your order #{number} was delivered. Thank you for shopping with us.",
    hi: "आपका ऑर्डर #{number} डिलीवर हो गया है। हमसे खरीदारी करने के लिए धन्यवाद।",
    hinglish: "Aapka order #{number} deliver ho gaya hai. Humse shopping karne ke liye thank you.",
  },
  cancelled: {
    en: "Your order #{number} was cancelled: {reason}. Reply here if you have any questions.",
    hi: "आपका ऑर्डर #{number} रद्द कर दिया गया है: {reason}। कोई सवाल हो तो यहां जवाब दें।",
    hinglish: "Aapka order #{number} cancel ho gaya hai: {reason}. Koi sawal ho to yahan reply karein.",
  },
});

/** Shipped without a tracking link: the same message without the tracking sentence. */
export const SHIPPED_WITHOUT_TRACKING: Readonly<Record<OrderLang, string>> = Object.freeze({
  en: "Your order #{number} has shipped. Thank you for shopping with us.",
  hi: "आपका ऑर्डर #{number} शिप हो गया है। हमसे खरीदारी करने के लिए धन्यवाद।",
  hinglish: "Aapka order #{number} ship ho gaya hai. Humse shopping karne ke liye thank you.",
});

/** The message offered when a member changes an order's status inside the window. */
export function orderUpdateText(status: NotifyStatus, lang: OrderLang, vars: OrderTextVars): string {
  const text = status === "shipped" && !vars.trackingUrl?.trim() ? SHIPPED_WITHOUT_TRACKING[lang] : ORDER_UPDATE_TEXTS[status][lang];
  return renderOrderText(text, lang, vars);
}

// =====================================================================================================================
// Order-update templates (3.6), for after the 24-hour window
// =====================================================================================================================

export const ORDER_TEMPLATE_STATUSES = ["confirmed", "shipped", "delivered", "cancelled"] as const;
export type OrderTemplateStatus = (typeof ORDER_TEMPLATE_STATUSES)[number];
export const ORDER_TEMPLATE_LANGS = ["en", "hi"] as const;
export type OrderTemplateLang = (typeof ORDER_TEMPLATE_LANGS)[number];

export type OrderTemplatePreset = {
  status: OrderTemplateStatus;
  lang: OrderTemplateLang;
  /** edwyz_order_<status>_<en|hi> */
  name: string;
  category: "UTILITY";
  /** Meta's language code. */
  language: OrderTemplateLang;
  /** The body as submitted, with {{1}} first name, {{2}} order number ("#1024") and {{3}} tracking link or reason. */
  body: string;
  /** How many placeholders the body has. */
  params: 2 | 3;
  /** One sample value per placeholder (Meta asks for them). */
  example: readonly string[];
};

const BODIES: Readonly<Record<OrderTemplateStatus, Readonly<Record<OrderTemplateLang, string>>>> = {
  confirmed: {
    en: "Hi {{1}}, your order {{2}} is confirmed. We will message you when it ships.",
    hi: "नमस्ते {{1}}, आपका ऑर्डर {{2}} कन्फर्म हो गया है। शिप होने पर हम आपको मैसेज करेंगे।",
  },
  shipped: {
    en: "Hi {{1}}, your order {{2}} has shipped. Track it here: {{3}}. Thank you for shopping with us.",
    hi: "नमस्ते {{1}}, आपका ऑर्डर {{2}} शिप हो गया है। इसे यहां ट्रैक करें: {{3}}। हमसे खरीदारी करने के लिए धन्यवाद।",
  },
  delivered: {
    en: "Hi {{1}}, your order {{2}} was delivered. Thank you for shopping with us.",
    hi: "नमस्ते {{1}}, आपका ऑर्डर {{2}} डिलीवर हो गया है। हमसे खरीदारी करने के लिए धन्यवाद।",
  },
  cancelled: {
    en: "Hi {{1}}, your order {{2}} was cancelled: {{3}}. Reply here if you have any questions.",
    hi: "नमस्ते {{1}}, आपका ऑर्डर {{2}} रद्द कर दिया गया है: {{3}}। कोई सवाल हो तो यहां जवाब दें।",
  },
};

const EXAMPLES: Readonly<Record<OrderTemplateLang, { name: string; number: string; tracking: string; reason: string }>> = {
  en: { name: "Priya", number: "#1024", tracking: "https://www.indiapost.gov.in", reason: "the item is out of stock" },
  hi: { name: "प्रिया", number: "#1024", tracking: "https://www.indiapost.gov.in", reason: "सामान स्टॉक में नहीं है" },
};

/** First-name fallback in a template ({{1}} can't be empty). */
export const TEMPLATE_NAME_FALLBACK: Readonly<Record<OrderTemplateLang, string>> = Object.freeze({ en: "there", hi: "जी" });

export const ORDER_TEMPLATE_PRESETS: readonly OrderTemplatePreset[] = Object.freeze(
  ORDER_TEMPLATE_STATUSES.flatMap((status) =>
    ORDER_TEMPLATE_LANGS.map((lang): OrderTemplatePreset => {
      const ex = EXAMPLES[lang];
      const third = status === "shipped" ? ex.tracking : ex.reason;
      const params = status === "shipped" || status === "cancelled" ? 3 : 2;
      return Object.freeze({
        status,
        lang,
        name: `edwyz_order_${status}_${lang}`,
        category: "UTILITY",
        language: lang,
        body: BODIES[status][lang],
        params,
        example: Object.freeze(params === 3 ? [ex.name, ex.number, third] : [ex.name, ex.number]),
      });
    }),
  ),
);

/** The preset for a status and language. */
export function orderTemplatePreset(status: OrderTemplateStatus, lang: OrderTemplateLang): OrderTemplatePreset {
  return ORDER_TEMPLATE_PRESETS.find((p) => p.status === status && p.lang === lang) as OrderTemplatePreset;
}

/** The template as submitted to Meta (the input of the templates service): name, language, UTILITY and one BODY with examples. */
export function orderTemplateInput(preset: OrderTemplatePreset) {
  return {
    name: preset.name,
    language: preset.language,
    category: preset.category,
    components: [{ type: "BODY", text: preset.body, example: { body_text: [[...preset.example]] } }],
  };
}

/**
 * The values of a preset's placeholders for one order: {{1}} first name (fallback "there" or "जी"), {{2}} "#1024", {{3}} the
 * tracking link (shipped) or the reason (cancelled), "not shared" when there is none. Meta refuses empty values.
 */
export function orderTemplateParams(preset: OrderTemplatePreset, vars: OrderTextVars): string[] {
  const first = nameOf(vars.firstName) || TEMPLATE_NAME_FALLBACK[preset.lang];
  const number = `#${String(vars.number).replace(/^#/, "")}`;
  if (preset.params === 2) return [first, number];
  const third = preset.status === "shipped" ? vars.trackingUrl?.trim() : vars.reason?.trim();
  return [first, number, (third || NOT_SHARED[preset.lang]).slice(0, 200)];
}

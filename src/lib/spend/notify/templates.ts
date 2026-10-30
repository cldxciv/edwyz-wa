/**
 * The four WhatsApp templates the platform notifier sends to owners and approvers (docs/SPEND-CONTROLS-SPEC.md 7.4, 9.3;
 * docs/platform-notifier.md has the submission checklist). Bodies and buttons are VERBATIM from the spec: Meta approves them
 * as UTILITY only while they carry no promotional wording, so change them only together with a new template version
 * (spend_*_v2) and a fresh submission.
 *
 * Pure: no database, no network. platform-sender.ts turns a template plus its values into the Cloud API `components`.
 */

export const TEMPLATE_KEYS = ["approval", "alert", "digest", "optin"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export type TemplateButton =
  | { type: "URL"; text: string; url: string; dynamic: boolean }
  | { type: "QUICK_REPLY"; text: string };

export type NotifyTemplate = {
  key: TemplateKey;
  /** The default name in the notifier WABA ('spend:notify'.templates may name another). */
  name: string;
  category: "UTILITY";
  language: "en";
  /** The body as submitted to Meta, with {{1}}..{{n}} placeholders. */
  body: string;
  /** How many body placeholders the body has. */
  params: number;
  buttons: readonly TemplateButton[];
  /** Sample values for the submission (Meta asks for one example per placeholder). */
  example: readonly string[];
  /** The example for the dynamic URL suffix, when a URL button has one. */
  urlExample?: string;
};

/** The base of the URL buttons. The one-tap page lives at /s/<token>, the Spending page at /app/settings/spending. */
export const NOTIFY_BASE_URL = "https://wa.edwyz.com";

export const NOTIFY_TEMPLATES: Readonly<Record<TemplateKey, NotifyTemplate>> = Object.freeze({
  approval: {
    key: "approval",
    name: "spend_approval_v1",
    category: "UTILITY",
    language: "en",
    body: "{{1}} asks to {{2}} in {{3}}. It could add up to {{4}} this month. Reason: {{5}}. If nobody answers by {{6}}, it is declined.",
    params: 6,
    buttons: [
      { type: "URL", text: "Review", url: `${NOTIFY_BASE_URL}/s/{{1}}`, dynamic: true },
      { type: "QUICK_REPLY", text: "Decline" },
    ],
    example: ["Ad assistant", "raise the daily budget of 'Diwali leads' from ₹800 to ₹1,000", "Sharma Sweets", "₹4,550", "cost per lead is ₹62, well below your ₹100 target", "29 Oct, 21:05"],
    urlExample: "p6Zf0QmV2y7cX1sKq9wLrA4nT8bE3uHjD5gC0iO2kMs",
  },
  alert: {
    key: "alert",
    name: "spend_alert_v1",
    category: "UTILITY",
    language: "en",
    body: "Spending update for {{1}}: {{2}} was paused because {{3}}. Nothing else changed. Review it in Edwyz.",
    params: 3,
    buttons: [{ type: "URL", text: "Open Edwyz", url: `${NOTIFY_BASE_URL}/app/settings/spending`, dynamic: false }],
    example: ["Sharma Sweets", "'Diwali leads'", "it costs too much per lead"],
  },
  digest: {
    key: "digest",
    name: "spend_daily_v1",
    category: "UTILITY",
    language: "en",
    body: "Daily update for {{1}} on {{2}}: ads spent {{3}}, {{4}} new leads, {{5}} per lead. WhatsApp messages about {{6}}. Automatic changes: {{7}}. Requests waiting for you: {{8}}. Left this month for ads: {{9}}.",
    params: 9,
    buttons: [{ type: "URL", text: "Open Edwyz", url: `${NOTIFY_BASE_URL}/app/settings/spending`, dynamic: false }],
    example: ["Sharma Sweets", "28 Oct", "₹1,200", "4", "₹300", "₹45", "2", "1", "₹13,800"],
  },
  optin: {
    key: "optin",
    name: "spend_optin_v1",
    category: "UTILITY",
    language: "en",
    body: "You asked to get spending approvals and alerts for {{1}} on WhatsApp. Tap Yes to confirm.",
    params: 1,
    buttons: [
      { type: "QUICK_REPLY", text: "Yes, send me alerts" },
      { type: "QUICK_REPLY", text: "No" },
    ],
    example: ["Sharma Sweets"],
  },
});

/** What a slot reads for a workspace with no ad account (9.3: fixed slots, {{3}}-{{5}}). */
export const NO_ADS_CONNECTED = "no ads connected";

/** The consent text shown next to the number field (7.4), word for word. Its version is stored with the consent row. */
export const OWNER_WHATSAPP_CONSENT_TEXT =
  "I agree to get spending approvals, alerts and a daily summary from Edwyz on WhatsApp at this number. I can stop any time by replying STOP.";
/** Matches the NotifyCard's NOTIFY_CONSENT_VERSION: a new wording needs a new version. */
export const OWNER_WHATSAPP_CONSENT_VERSION = "owner-whatsapp-v1";

/** In-window replies to the owner's own taps (7.4): free text, inside the 24-hour window the tap opened. */
export const REPLY_DECLINED = "Declined. Nothing was changed.";
export const REPLY_VERIFIED = "Done. Spending approvals and alerts will come to this number. Reply STOP to stop them.";
export const REPLY_NO = "Okay. No spending alerts will come to this number.";

/**
 * A template parameter as Meta accepts it: one line, no tabs, no run of more than 3 spaces, not empty, at most `max`
 * characters (cut on a character boundary, never inside a surrogate pair).
 */
export function cleanParam(value: unknown, max = 200): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "-";
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The body with its placeholders filled in (what the person reads; also the in-app copy of an alert). */
export function renderTemplate(key: TemplateKey, params: readonly string[]): string {
  const t = NOTIFY_TEMPLATES[key];
  return t.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => cleanParam(params[Number(n) - 1]));
}

export type TemplateValues = {
  /** One value per body placeholder, in order. */
  params: readonly string[];
  /** The dynamic part of the first URL button (the approval link token). */
  urlSuffix?: string;
  /** Quick-reply payloads by button text ("Decline" -> "spdec:<id>:<hmac16>"). */
  payloads?: Readonly<Record<string, string>>;
};

/** Thrown when a template is filled with the wrong number of values: a programming error, never shown to anyone. */
export class TemplateValuesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateValuesError";
  }
}

/**
 * The Cloud API `components` for one send: the body parameters, the dynamic URL suffix and the quick-reply payloads.
 * Static URL buttons take no parameter. Button indexes follow the order the template was submitted with.
 */
export function templateComponents(key: TemplateKey, values: TemplateValues): unknown[] {
  const t = NOTIFY_TEMPLATES[key];
  if (values.params.length !== t.params) throw new TemplateValuesError(`${t.name} needs ${t.params} values, got ${values.params.length}.`);
  const components: unknown[] = [{ type: "body", parameters: values.params.map((p) => ({ type: "text", text: cleanParam(p) })) }];
  t.buttons.forEach((b, index) => {
    if (b.type === "URL" && b.dynamic) {
      if (!values.urlSuffix) throw new TemplateValuesError(`${t.name} needs the link for its ${b.text} button.`);
      components.push({ type: "button", sub_type: "url", index: String(index), parameters: [{ type: "text", text: values.urlSuffix }] });
    } else if (b.type === "QUICK_REPLY") {
      const payload = values.payloads?.[b.text];
      if (payload) components.push({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }] });
    }
  });
  return components;
}

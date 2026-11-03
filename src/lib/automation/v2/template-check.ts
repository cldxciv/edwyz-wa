/*
 * Which approved templates an automation rule can send. Pure (no database). A rule's Send template step fills the text values by
 * number ({{1}}, {{2}}...), a heading value or picture link and a link button value (lib/chatbots/template-build). Anything else a
 * template asks for cannot come from a rule, so the rule builder greys the template out with the reason, saving a rule with it is
 * refused with the same reason, and a rule saved earlier logs the reason instead of sending a message WhatsApp would refuse.
 * The broadcasts checker (lib/broadcasts/components) catches the parts no sender here can fill; named values and coupon codes are
 * filled by a broadcast's value mapping, which rules do not have.
 */
import { broadcastSupportReason, isLoginCodeTemplate } from "@/lib/broadcasts/components";
import { bodyText, MAX_VARIABLES, variableCount } from "@/lib/inbox/template-vars";
import { readPlaceholders } from "@/lib/templates/validate";

export type RuleTemplateProblem = {
  /** Follows "it", for the template list: "has a coupon code button". */
  short: string;
  /** Follows 'The template "name"', for a refused save and the run log. */
  long: string;
  /** What to do instead. */
  instead: string;
};

const BROADCAST_INSTEAD = "Choose another template, or send this one from a broadcast.";
const OTHER_INSTEAD = "Choose another template.";
/** Buttons a rule sends without a value (quick replies, calls) or fills from the step (a link with a gap). */
const RULE_BUTTONS = new Set(["QUICK_REPLY", "URL", "PHONE_NUMBER", "COPY_CODE"]);
const HEADER_FORMATS = new Set(["TEXT", "IMAGE", "VIDEO", "DOCUMENT"]);

type Component = Record<string, unknown>;
const list = (value: unknown): Component[] => (Array.isArray(value) ? value.filter((c): c is Component => Boolean(c) && typeof c === "object") : []);
const upper = (v: unknown) => (typeof v === "string" ? v.toUpperCase() : "");
const find = (all: Component[], type: string) => all.find((c) => upper(c.type) === type);

/** The heading text (only a text heading has one) and the body text, where values go. */
function valueTexts(all: Component[]): unknown[] {
  const header = find(all, "HEADER");
  return [header && (upper(header.format) || "TEXT") === "TEXT" ? header.text : undefined, find(all, "BODY")?.text];
}

/** What the broadcasts checker refused, said for a rule. */
function unsupportedPart(all: Component[]): string {
  if (all.some((c) => upper(c.type) === "CAROUSEL" || upper(c.type) === "LIMITED_TIME_OFFER")) return "is a carousel or limited-time-offer template";
  const header = find(all, "HEADER");
  if (header && !HEADER_FORMATS.has(upper(header.format) || "TEXT")) return "has a location or another kind of heading";
  if (list(find(all, "BUTTONS")?.buttons).some((b) => !RULE_BUTTONS.has(upper(b.type)))) return "has a form, catalog or other special button";
  if (valueTexts(all).some((text) => readPlaceholders(text).format === "mixed")) return "mixes numbered and named values";
  return "has a part WhatsApp needs filled in another way";
}

/** Why a rule can never send this template, or null when it can. */
export function ruleTemplateProblem(components: unknown): RuleTemplateProblem | null {
  const all = list(components);
  if (isLoginCodeTemplate(all)) return { short: "is a login-code template", long: "is a login-code template, which sends a new code to one person at a time", instead: OTHER_INSTEAD };
  if (broadcastSupportReason(all)) {
    const part = unsupportedPart(all);
    return { short: part, long: `${part}, which a rule cannot send`, instead: OTHER_INSTEAD };
  }
  const named = valueTexts(all)
    .map((text) => readPlaceholders(text).names[0])
    .find(Boolean);
  if (named) return { short: `has named values like {{${named}}}`, long: `has named values like {{${named}}}, which a rule cannot fill in yet`, instead: BROADCAST_INSTEAD };
  if (list(find(all, "BUTTONS")?.buttons).some((b) => upper(b.type) === "COPY_CODE")) {
    return { short: "has a coupon code button", long: "has a coupon code button, which a rule cannot fill in yet", instead: BROADCAST_INSTEAD };
  }
  if (variableCount(bodyText(all)) > MAX_VARIABLES) return { short: "has too many values", long: "has more values than a rule can fill in", instead: BROADCAST_INSTEAD };
  return null;
}

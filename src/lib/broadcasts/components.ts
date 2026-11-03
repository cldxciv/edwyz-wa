import { readPlaceholders } from "@/lib/templates/validate";

/** Button types a broadcast can send: quick replies and call buttons need nothing, links and coupon codes are filled by the value mapping. */
const SENDABLE_BUTTONS = new Set(["QUICK_REPLY", "URL", "PHONE_NUMBER", "COPY_CODE"]);
/** Meta lists the copy-code button of a login-code template as a URL button with this address. */
const OTP_URL = /^https:\/\/www\.whatsapp\.com\/otp\//i;
const BUTTON_NAMES: Record<string, string> = { FLOW: "form", CATALOG: "catalog", MPM: "product list", SPM: "product", VOICE_CALL: "WhatsApp call", APP: "app" };

type Component = Record<string, unknown>;
const list = (components: unknown): Component[] => (Array.isArray(components) ? (components as Component[]).filter((c) => c && typeof c === "object") : []);
const buttonsOf = (components: unknown): Component[] => ((list(components).find((c) => c.type === "BUTTONS")?.buttons as Component[] | undefined) ?? []).filter((b) => b && typeof b === "object");
const buttonType = (b: Component) => (typeof b.type === "string" ? b.type.toUpperCase() : "");

/** The copy-code button of a login-code template: OTP as saved here, or the WhatsApp OTP link Meta lists once it is synced. */
export const isLoginCodeButton = (b: Component): boolean => buttonType(b) === "OTP" || (buttonType(b) === "URL" && typeof b.url === "string" && OTP_URL.test(b.url));

/** True for a login-code (authentication) template. */
export const isLoginCodeTemplate = (components: unknown): boolean => buttonsOf(components).some(isLoginCodeButton);

/**
 * Why a template cannot be broadcast at all, or null. Media headers, header placeholders, named placeholders, link placeholders and
 * coupon codes are filled by the value mapping. The wizard greys out a template with a reason, so it is never sent and refused by Meta.
 * allowLoginCode is for a message to one person with the caller's own values (the compat API): the caller sends the code itself.
 */
export function broadcastSupportReason(components: unknown, { allowLoginCode = false }: { allowLoginCode?: boolean } = {}): string | null {
  const all = list(components);
  const header = all.find((c) => c.type === "HEADER");
  const format = typeof header?.format === "string" ? header.format.toUpperCase() : "TEXT";
  if (header && !["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(format)) return "This template has a header type that broadcasts cannot send yet (for example a location).";
  if (all.some((c) => c.type === "CAROUSEL" || c.type === "LIMITED_TIME_OFFER")) return "Carousel and limited-time-offer templates cannot be broadcast yet.";
  const body = all.find((c) => c.type === "BODY");
  if ([format === "TEXT" ? header?.text : undefined, body?.text].some((text) => readPlaceholders(text).format === "mixed")) {
    return "This template mixes numbered and named placeholders, so WhatsApp cannot fill it in. Make a new version of it.";
  }
  for (const b of buttonsOf(all)) {
    const type = buttonType(b);
    if (isLoginCodeButton(b)) {
      if (allowLoginCode) continue;
      return "Login-code templates send a new code to one person at a time, so they cannot be broadcast.";
    }
    if (type && !SENDABLE_BUTTONS.has(type)) return `This template has a ${BUTTON_NAMES[type] ?? type.toLowerCase().replace(/_/g, " ")} button, which broadcasts cannot fill in yet.`;
  }
  return null;
}

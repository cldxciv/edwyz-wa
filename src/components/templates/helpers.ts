import { MAX_BUTTONS } from "@/lib/templates/validate";

export type ButtonDraft = { type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER"; text: string; url: string; urlExample: string; phone: string };

export type HeaderKind = "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
export type HeaderMediaDraft = { type: Exclude<HeaderKind, "TEXT">; handle: string; mime?: string; filename?: string };

export const HEADER_KINDS: [HeaderKind, string][] = [
  ["TEXT", "Text"],
  ["IMAGE", "Image"],
  ["VIDEO", "Video"],
  ["DOCUMENT", "Document"],
];

export const MEDIA_ACCEPT: Record<Exclude<HeaderKind, "TEXT">, { accept: string; help: string }> = {
  IMAGE: { accept: "image/jpeg,image/png", help: "A JPG or PNG image up to 5 MB." },
  VIDEO: { accept: "video/mp4", help: "An MP4 video up to 16 MB." },
  DOCUMENT: { accept: "application/pdf", help: "A PDF up to 16 MB." },
};

export type TemplateDraft = {
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  header: string;
  headerExample: string;
  /** Text header (the default), or an image, video or document sample uploaded to Meta for review. */
  headerKind: HeaderKind;
  headerMedia: HeaderMediaDraft | null;
  body: string;
  bodyExamples: string[];
  footer: string;
  buttons: ButtonDraft[];
};

export const emptyDraft = (): TemplateDraft => ({
  name: "",
  language: "en_US",
  category: "UTILITY",
  header: "",
  headerExample: "",
  headerKind: "TEXT",
  headerMedia: null,
  body: "",
  bodyExamples: [],
  footer: "",
  buttons: [],
});

export const LANGUAGES: [string, string][] = [
  ["en_US", "English (US)"],
  ["en_GB", "English (UK)"],
  ["en", "English"],
  ["hi", "Hindi"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["pt_BR", "Portuguese (Brazil)"],
  ["ar", "Arabic"],
  ["id", "Indonesian"],
];

/** Variable numbers found in text, in order: "Hi {{1}}, {{2}}" gives [1, 2]. Never throws. */
export function detectVariables(text: string): number[] {
  return [...new Set([...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/** True when variables run 1..n with no gaps and no malformed placeholders such as {{name}}. */
export function variablesAreSequential(text: string): boolean {
  if ([...text.matchAll(/\{\{(\w+)\}\}/g)].some((m) => !/^[1-9]\d*$/.test(m[1]))) return false;
  return detectVariables(text).every((n, i) => n === i + 1);
}

/** Number of example values the body needs (one per variable). */
export function requiredExamples(text: string): number {
  return detectVariables(text).length;
}

export function fillExamples(text: string, examples: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (match, n: string) => examples[Number(n) - 1]?.trim() || match);
}

export type DraftErrors = Partial<Record<"name" | "language" | "header" | "headerExample" | "headerMedia" | "body" | "footer" | "buttons", string>> & {
  bodyExamples?: Record<number, string>;
  buttonErrors?: Record<number, string>;
};

export function validateDraft(d: TemplateDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.name) e.name = "Enter a name.";
  else if (!/^[a-z0-9_]+$/.test(d.name)) e.name = "Use only lowercase letters, numbers and underscores, like order_update.";
  else if (d.name.length > 512) e.name = "Make the name shorter (512 characters at most).";

  if (d.headerKind !== "TEXT" && !d.headerMedia) e.headerMedia = "Upload a sample file for the header, or remove the header.";
  if (d.headerKind === "TEXT" && d.header) {
    if (d.header.length > 60) e.header = "Make the header shorter (60 characters at most).";
    else if (detectVariables(d.header).length > 1) e.header = "A header can have only one placeholder.";
    else if (!variablesAreSequential(d.header)) e.header = "Use {{1}} for the header placeholder.";
    else if (detectVariables(d.header).length === 1 && !d.headerExample.trim()) e.headerExample = "Enter a sample value for the header placeholder.";
  }

  if (!d.body.trim()) e.body = "Write the message your customers will receive.";
  else if (d.body.length > 1024) e.body = "Make the message shorter (1024 characters at most).";
  else if (!variablesAreSequential(d.body)) e.body = "Number placeholders in order, starting with {{1}}, then {{2}}, and so on.";
  else {
    const missing: Record<number, string> = {};
    for (let i = 0; i < requiredExamples(d.body); i++) if (!d.bodyExamples[i]?.trim()) missing[i] = "Enter a sample value for this placeholder.";
    if (Object.keys(missing).length) e.bodyExamples = missing;
  }

  if (d.footer) {
    if (d.footer.length > 60) e.footer = "Make the footer shorter (60 characters at most).";
    else if (/\{\{/.test(d.footer)) e.footer = "A footer cannot have placeholders.";
  }

  if (d.buttons.length > MAX_BUTTONS) e.buttons = `A template can have at most ${MAX_BUTTONS} buttons. Remove one to continue.`;
  const buttonErrors: Record<number, string> = {};
  d.buttons.forEach((b, i) => {
    if (!b.text.trim()) buttonErrors[i] = "Give this button a label.";
    else if (b.text.length > 25) buttonErrors[i] = "Make the button label shorter (25 characters at most).";
    else if (b.type === "URL" && !/^https:\/\//.test(b.url)) buttonErrors[i] = "The website address must start with https://";
    else if (b.type === "URL" && detectVariables(b.url).length > 1) buttonErrors[i] = "The website address can have only one placeholder.";
    else if (b.type === "URL" && detectVariables(b.url).length === 1 && !b.urlExample.trim()) buttonErrors[i] = "Enter a sample address for the placeholder.";
    else if (b.type === "PHONE_NUMBER" && !/^\+\d{7,15}$/.test(b.phone)) buttonErrors[i] = "Enter the phone number with country code, like +919876543210.";
  });
  if (Object.keys(buttonErrors).length) e.buttonErrors = buttonErrors;
  return e;
}

export const hasErrors = (e: DraftErrors) => Object.keys(e).length > 0;

/** Draft to the Meta component shape the API validates. */
export function buildComponents(d: TemplateDraft): Record<string, unknown>[] {
  const components: Record<string, unknown>[] = [];
  if (d.headerKind !== "TEXT" && d.headerMedia) {
    components.push({ type: "HEADER", format: d.headerKind, example: { header_handle: [d.headerMedia.handle] } });
  } else if (d.header.trim()) {
    const header: Record<string, unknown> = { type: "HEADER", format: "TEXT", text: d.header };
    if (detectVariables(d.header).length) header.example = { header_text: [d.headerExample.trim()] };
    components.push(header);
  }
  const body: Record<string, unknown> = { type: "BODY", text: d.body };
  const n = requiredExamples(d.body);
  if (n) body.example = { body_text: [d.bodyExamples.slice(0, n).map((s) => s.trim())] };
  components.push(body);
  if (d.footer.trim()) components.push({ type: "FOOTER", text: d.footer });
  if (d.buttons.length) {
    components.push({
      type: "BUTTONS",
      buttons: d.buttons.map((b) => {
        if (b.type === "QUICK_REPLY") return { type: b.type, text: b.text };
        if (b.type === "PHONE_NUMBER") return { type: b.type, text: b.text, phone_number: b.phone };
        const out: Record<string, unknown> = { type: b.type, text: b.text, url: b.url };
        if (detectVariables(b.url).length) out.example = [b.urlExample.trim()];
        return out;
      }),
    });
  }
  return components;
}

export type StatusView = { label: string; tone: "neutral" | "good" | "warn" | "bad"; detail: string | null };

const REJECTION_TEXT: Record<string, string> = {
  ABUSIVE_CONTENT: "Meta found wording it considers abusive or inappropriate.",
  INVALID_FORMAT: "Meta could not read the format. Check placeholders such as {{1}} and the sample values.",
  PROMOTIONAL: "The message reads like a promotion, so it cannot be a utility template. Try the Marketing category.",
  SCAM: "Meta thinks the wording looks like a scam. Remove urgent or too-good-to-be-true language.",
  TAG_CONTENT_MISMATCH: "The content does not match the category you chose. Pick the category that fits the message.",
};

/**
 * Meta's rejection reason in words a shop owner can act on. Returns null when there is nothing useful to say.
 * A bare code (SOMETHING_NEW) becomes lower-case words; a sentence is shown as Meta wrote it, minus any leading code.
 */
export function rejectionText(reason: string | null | undefined): string | null {
  const code = (reason ?? "").trim();
  if (!code || code.toUpperCase() === "NONE") return null;
  const known = REJECTION_TEXT[code.toUpperCase()];
  if (known) return known;
  if (/^[A-Z0-9_]+$/i.test(code)) return `Meta gave this reason: ${code.replace(/_/g, " ").toLowerCase()}.`;
  const sentence = code.replace(/^[A-Z0-9_]+:\s*/, "").replace(/[.\s]+$/, "");
  return `Meta gave this reason: ${sentence}.`;
}

export function templateStatusView(status: string, reason?: string | null): StatusView {
  switch (status) {
    case "approved":
      return { label: "Approved", tone: "good", detail: "Ready to use in broadcasts." };
    case "pending":
      return { label: "Pending review", tone: "warn", detail: "Meta is reviewing this. It usually takes minutes to a day." };
    case "rejected":
      return { label: "Rejected", tone: "bad", detail: rejectionText(reason) ?? "Meta did not approve this template." };
    case "paused":
      return { label: "Paused", tone: "warn", detail: "Meta paused this because of low quality ratings. Broadcasts cannot use it for now." };
    case "disabled":
      return { label: "Disabled", tone: "bad", detail: "Meta turned this template off. Create a new one instead." };
    case "flagged":
      return { label: "Flagged", tone: "warn", detail: "Meta flagged this for low quality. Marketing broadcasts can't use it for now; other messages still go out. If it gets worse, Meta may pause it." };
    default:
      return { label: "Draft", tone: "neutral", detail: "Not sent to Meta yet." };
  }
}

export const CATEGORY_INFO: Record<TemplateDraft["category"], { label: string; help: string }> = {
  UTILITY: { label: "Utility", help: "Order updates, bookings, receipts and reminders about something the customer did." },
  MARKETING: { label: "Marketing", help: "Offers, promotions, announcements and anything meant to bring people back." },
  AUTHENTICATION: { label: "Authentication", help: "One-time passcodes to confirm someone's identity." },
};

export function categoryLabel(category: string): string {
  return CATEGORY_INFO[category as TemplateDraft["category"]]?.label ?? category.charAt(0) + category.slice(1).toLowerCase();
}

export function languageLabel(code: string): string {
  return LANGUAGES.find(([c]) => c === code)?.[1] ?? code;
}

/** Turns what a person types into a valid template name as they type: "Order Update!" becomes "order_update". */
export function slugifyTemplateName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 512);
}

export type TemplateListItem = { name: string; status: string; components?: { type: string; text?: string }[] };

export const bodyText = (t: Pick<TemplateListItem, "components">) => t.components?.find((c) => c.type === "BODY")?.text ?? "";

export type StatusFilter = "all" | "approved" | "pending" | "attention" | "draft";

export const STATUS_FILTERS: [StatusFilter, string][] = [
  ["all", "All templates"],
  ["approved", "Approved"],
  ["pending", "Waiting for review"],
  ["attention", "Needs attention"],
  ["draft", "Drafts"],
];

const matchesStatus = (status: string, filter: StatusFilter) => {
  if (filter === "all") return true;
  if (filter === "attention") return status === "rejected" || status === "paused" || status === "disabled" || status === "flagged";
  return status === filter;
};

export function filterTemplates<T extends TemplateListItem>(list: readonly T[], query: string, status: StatusFilter): T[] {
  const needle = query.trim().toLowerCase();
  return list.filter((t) => matchesStatus(t.status, status) && (!needle || t.name.toLowerCase().includes(needle) || bodyText(t).toLowerCase().includes(needle)));
}

/** "12 of 60" style counter for limited fields. */
export const countText = (value: string, max: number) => `${value.length} of ${max} characters used`;

/** Which field of a button the error in validateDraft refers to, so the message can sit next to it. */
export function buttonErrorTarget(b: ButtonDraft): "text" | "url" | "urlExample" | "phone" {
  if (!b.text.trim() || b.text.length > 25) return "text";
  if (b.type === "PHONE_NUMBER") return "phone";
  if (b.type === "URL") return !/^https:\/\//.test(b.url) || detectVariables(b.url).length > 1 ? "url" : "urlExample";
  return "text";
}

export function countErrors(e: DraftErrors): number {
  const { bodyExamples, buttonErrors, ...flat } = e;
  return Object.keys(flat).length + Object.keys(bodyExamples ?? {}).length + Object.keys(buttonErrors ?? {}).length;
}

export function insertAt(text: string, index: number, insert: string): { text: string; caret: number } {
  const at = Math.min(Math.max(index, 0), text.length);
  return { text: text.slice(0, at) + insert + text.slice(at), caret: at + insert.length };
}

export function nextVariable(text: string): number {
  return Math.max(0, ...detectVariables(text)) + 1;
}

export type LinkClick = {
  href: string;
  target?: string | null;
  download?: boolean;
  button?: number;
  modified?: boolean;
  defaultPrevented?: boolean;
};

/**
 * Path to navigate to when a click on a link should be guarded by an unsaved-changes warning, or null when the
 * click should go through untouched (new tab, download, modifier keys, same page, other site, hash-only link).
 */
export function guardedNavigationPath(click: LinkClick, origin: string, currentPath: string): string | null {
  if (click.defaultPrevented || click.download || click.modified || (click.button ?? 0) !== 0) return null;
  if (click.target && click.target !== "_self") return null;
  let url: URL;
  try {
    url = new URL(click.href, `${origin}${currentPath}`);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.pathname === currentPath) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Which control gets focus after Remove is used on button number `index`; `remaining` buttons are left. */
export function focusKeyAfterButtonRemoved(index: number, remaining: number): string {
  if (remaining === 0) return "add-button";
  return `remove-button-${Math.min(Math.max(index - 1, 0), remaining - 1)}`;
}

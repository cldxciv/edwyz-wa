/*
 * The chatbot template builder: turns the values a sender filled in into the components of a template send. Pure (no database),
 * shared by the chatbot Send template step (engine.ts) and the automation rule Send template action (automation/v2/actions.ts),
 * so both fill a template's heading, text and link button the same way.
 */
import { bodyText, cleanVariable, variableCount } from "@/lib/inbox/template-vars";

const MAX_PARAM = 1024;

type Component = { type?: unknown; format?: unknown; text?: unknown; buttons?: unknown };

const upper = (v: unknown) => (typeof v === "string" ? v.toUpperCase() : "");
const componentList = (v: unknown): Component[] => (Array.isArray(v) ? v.filter((c): c is Component => Boolean(c) && typeof c === "object") : []);
const hasGap = (v: unknown) => /\{\{/.test(String(v ?? ""));

export type HeaderMedia = "image" | "video" | "document";

/** What a template asks the sender to fill in, read from its components. */
export type TemplateFillNeeds = { headerText: boolean; headerMedia: HeaderMedia | null; buttonValue: boolean; bodyValues: number };

export function templateFillNeeds(components: unknown): TemplateFillNeeds {
  const list = componentList(components);
  const header = list.find((c) => upper(c.type) === "HEADER");
  const format = header ? upper(header.format) || "TEXT" : "";
  const media = format === "IMAGE" || format === "VIDEO" || format === "DOCUMENT" ? (format.toLowerCase() as HeaderMedia) : null;
  const buttons = componentList(list.find((c) => upper(c.type) === "BUTTONS")?.buttons);
  return {
    headerText: Boolean(header) && format === "TEXT" && hasGap(header?.text),
    headerMedia: media,
    buttonValue: buttons.some((b) => upper(b.type) === "URL" && hasGap((b as { url?: unknown }).url)),
    bodyValues: variableCount(bodyText(components)),
  };
}

/**
 * The values of one send, already filled from saved answers or contact details. header fills a heading's {{1}}, headerMediaUrl is
 * the https link of a picture, video or document heading, body fills the text's {{1}}, {{2}}... in order, button fills the {{1}}
 * of each link button whose web address has one.
 */
export type TemplateFill = { header?: string; headerMediaUrl?: string; body: string[]; button?: string };
export type TemplateBuildError = "missing_header_value" | "missing_header_media" | "missing_button_value";
export type TemplateBuild = { components: unknown[] } | { error: TemplateBuildError };

export function buildTemplateComponents(templateComponents: unknown, fill: TemplateFill): TemplateBuild {
  const list = componentList(templateComponents);
  const out: unknown[] = [];
  const header = list.find((c) => upper(c.type) === "HEADER");
  const format = header ? upper(header.format) || "TEXT" : "";
  if (header && format === "TEXT" && hasGap(header.text)) {
    const value = cleanVariable(fill.header ?? "").slice(0, MAX_PARAM);
    if (!value) return { error: "missing_header_value" };
    out.push({ type: "header", parameters: [{ type: "text", text: value }] });
  } else if (header && ["IMAGE", "VIDEO", "DOCUMENT"].includes(format)) {
    const link = (fill.headerMediaUrl ?? "").trim();
    if (!/^https:\/\/\S+$/i.test(link)) return { error: "missing_header_media" };
    const kind = format.toLowerCase();
    out.push({ type: "header", parameters: [{ type: kind, [kind]: { link } }] });
  }

  if (fill.body.length) out.push({ type: "body", parameters: fill.body.map((text) => ({ type: "text", text })) });

  const buttons = componentList(list.find((c) => upper(c.type) === "BUTTONS")?.buttons);
  for (const [index, button] of buttons.entries()) {
    if (upper(button.type) !== "URL" || !hasGap((button as { url?: unknown }).url)) continue;
    const value = cleanVariable(fill.button ?? "").slice(0, MAX_PARAM);
    if (!value) return { error: "missing_button_value" };
    out.push({ type: "button", sub_type: "url", index: String(index), parameters: [{ type: "text", text: value }] });
  }
  return { components: out };
}

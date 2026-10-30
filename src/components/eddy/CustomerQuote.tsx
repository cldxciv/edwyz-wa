/**
 * Customer text in Eddy (docs/EDDY-SPEC.md 2.5, 6.3, 7.2 item 8): always in a quote block on var(--surface) with a left
 * rule in var(--border-strong), labelled "From the customer" / "ग्राहक का मैसेज" / "Customer ka message", so it can never
 * look like Eddy's own words. The text is escaped plain text: never markdown, never a link, never HTML. Long text is cut by
 * grapheme (Devanagari conjuncts are never split) with an ellipsis.
 */
import { cn } from "@/components/ui";
import type { UntrustedText } from "@/lib/actions/types";
import { htmlLang, isMostlyDevanagari, t, type EddyLang } from "@/lib/eddy/i18n";

export const QUOTE_MAX_GRAPHEMES = 1200;

/** Plain text of a value that may be UntrustedText. */
export function untrustedPlain(value: string | UntrustedText | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return typeof value.text === "string" ? value.text : "";
}

/** Cuts text to at most `max` graphemes, adding an ellipsis when it was cut. */
export function cutGraphemes(text: string, max: number): string {
  if (max <= 0) return "";
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const graphemes = Seg ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment) : Array.from(text);
  return graphemes.length <= max ? text : `${graphemes.slice(0, max).join("")}…`;
}

export function CustomerQuote({ text, lang, label, maxGraphemes = QUOTE_MAX_GRAPHEMES, className }: { text: string | UntrustedText; lang: EddyLang; label?: string; maxGraphemes?: number; className?: string }) {
  const caption = label ?? t(lang, "customer.label");
  const body = cutGraphemes(untrustedPlain(text), maxGraphemes);
  return (
    <figure className={cn("m-0 rounded-md border-l-4 border-border-strong bg-surface px-3 py-2", className)} data-eddy-customer-quote>
      <figcaption className="text-xs font-medium text-muted" lang={htmlLang(lang)}>
        {caption}
      </figcaption>
      <blockquote className={cn("m-0 mt-1 whitespace-pre-wrap break-words text-foreground", isMostlyDevanagari(body) ? "text-base leading-[1.6]" : "text-sm")} dir="auto">
        {body}
      </blockquote>
    </figure>
  );
}

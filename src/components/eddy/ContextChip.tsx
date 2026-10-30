"use client";

/**
 * The context chip above the composer (docs/EDDY-SPEC.md 6.3): "Using: this chat · Ramesh K".
 *
 * The subject comes from page-context.ts (ids only). A name, when the caller has one, is untrusted text: it is rendered as
 * isolated plain text (<bdi>), cut by grapheme so a Devanagari conjunct is never split, and never parsed as markup. The x
 * drops the page context from the next message only; the chip comes back with the next page or selection.
 */
import { cn } from "@/components/ui";
import { tp, type PanelKey } from "@/lib/eddy/copy/panel";
import { htmlLang, type EddyLang } from "@/lib/eddy/i18n";
import { cutGraphemes } from "./CustomerQuote";
import type { ContextSubject } from "./page-context";

/** Names in the chip are cut at this many graphemes. */
export const CHIP_NAME_GRAPHEMES = 24;

const SUBJECT_KEY: Record<ContextSubject | "notice" | "message", PanelKey> = {
  chat: "panel.context.chat",
  contact: "panel.context.contact",
  lead: "panel.context.lead",
  broadcast: "panel.context.broadcast",
  template: "panel.context.template",
  segment: "panel.context.segment",
  page: "panel.context.page",
  notice: "panel.context.notice",
  message: "panel.context.message",
};

export type ChipSubject = ContextSubject | "notice" | "message";

/** The chip's label as plain text, e.g. "Using: this chat · Ramesh K". Control and bidi characters in the name are dropped. */
export function contextChipLabel(lang: EddyLang, subject: ChipSubject, name?: string | null): string {
  const what = tp(lang, SUBJECT_KEY[subject]);
  const clean = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim() : "";
  return clean ? tp(lang, "panel.context.using_named", { what, name: cutGraphemes(clean, CHIP_NAME_GRAPHEMES) }) : tp(lang, "panel.context.using", { what });
}

export function ContextChip({ lang, subject, name, onRemove, className }: { lang: EddyLang; subject: ChipSubject; name?: string | null; onRemove?: () => void; className?: string }) {
  const what = tp(lang, SUBJECT_KEY[subject]);
  const clean = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim() : "";
  const shown = clean ? cutGraphemes(clean, CHIP_NAME_GRAPHEMES) : "";
  return (
    <div className={cn("flex min-w-0 max-w-full items-center gap-1 self-start rounded-full border border-border bg-surface py-0.5 pl-3 pr-1 text-xs text-muted", className)} lang={htmlLang(lang)} data-eddy-context>
      <span className="min-w-0 truncate">
        {shown
          ? tp.parts(lang, "panel.context.using_named").map((part, i) =>
              part.kind === "text" ? (
                <span key={i}>{part.text}</span>
              ) : part.name === "name" ? (
                <bdi key={i} className="font-medium text-foreground">
                  {shown}
                </bdi>
              ) : (
                <span key={i}>{what}</span>
              ),
            )
          : tp(lang, "panel.context.using", { what })}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={tp(lang, "panel.context.remove", { what })}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground pointer-coarse:h-11 pointer-coarse:w-11"
          data-eddy-context-remove
        >
          <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

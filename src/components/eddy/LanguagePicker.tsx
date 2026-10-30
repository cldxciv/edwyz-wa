"use client";

/**
 * Menu > Language (docs/EDDY-SPEC.md 2.4, 5.7, 6.3): the language Eddy replies in. "Same as my message" (auto) follows each
 * message's language (5.7); English, Hindi and Hinglish fix it. A labelled radio group; each option names itself in its own
 * language and script with the right `lang`, so a screen reader reads it correctly. Saving is PUT /api/eddy/prefs
 * {language}, done by the caller; the result is announced by the menu's status region.
 */
import { useId } from "react";
import { Button } from "@/components/ui";
import type { EddyLang, EddyLangPref } from "@/lib/eddy/contract";
import { tp, type PanelKey } from "@/lib/eddy/copy/panel";
import { htmlLang, t } from "@/lib/eddy/i18n";

export const LANG_OPTIONS: readonly { value: EddyLangPref; key: PanelKey; lang?: string }[] = [
  { value: "auto", key: "panel.lang.auto" },
  { value: "en", key: "panel.lang.en", lang: "en" },
  { value: "hi", key: "panel.lang.hi", lang: "hi" },
  { value: "hinglish", key: "panel.lang.hinglish", lang: "hi-Latn" },
];

/** An option's label: the chrome language for "auto"; each fixed language in its own language (हिंदी, Hinglish). */
export function optionLabel(chrome: EddyLang, o: (typeof LANG_OPTIONS)[number]): string {
  return o.value === "auto" ? tp(chrome, o.key) : tp(o.value, o.key);
}

export function LanguagePicker({ lang, value, busy, onPick, onClose }: { lang: EddyLang; value: EddyLangPref; busy?: boolean; onPick: (value: EddyLangPref) => void; onClose?: () => void }) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-1 p-1" disabled={busy} lang={htmlLang(lang)} data-eddy-language>
      <legend className="px-2 pb-1 text-sm font-semibold">{tp(lang, "panel.menu.language")}</legend>
      {LANG_OPTIONS.map((o) => (
        <label key={o.value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm hover:bg-surface-2">
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onPick(o.value)} className="h-4 w-4 accent-(--accent)" />
          <span lang={o.lang}>{optionLabel(lang, o)}</span>
        </label>
      ))}
      {onClose && (
        <Button type="button" variant="ghost" size="sm" className="mt-1 self-start pointer-coarse:min-h-11" onClick={onClose}>
          {t(lang, "btn.close")}
        </Button>
      )}
    </fieldset>
  );
}

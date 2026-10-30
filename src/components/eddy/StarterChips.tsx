"use client";

/**
 * Starter chips above an empty transcript (docs/EDDY-SPEC.md 6.10, 6.11, 6.14), by page and in the member's language. A
 * tapped chip sends its own text as the member's message, so what Eddy receives is exactly what the member saw.
 *
 * In a workspace with no WhatsApp number yet, the dashboard chips become the setup guide's next step (6.14). While the AI
 * is unavailable the panel shows plain "Go to" buttons instead (GotoButtons), which need no model call (6.11).
 */
import { Button, cn } from "@/components/ui";
import type { EddyWhatsAppState } from "@/lib/eddy/contract";
import { tp } from "@/lib/eddy/copy/panel";
import { GOTO_KEYS, htmlLang, starterChips, starterPageOf, t, type EddyLang } from "@/lib/eddy/i18n";
import { NavChips } from "./ActionCard";

export type Starter = { key: string; label: string; query: string };

/** The chips for a page: 6.10's table, narrowed to the next setup step on a dashboard with no WhatsApp number (6.14). */
export function startersFor(lang: EddyLang, pageId: string | null | undefined, whatsapp: EddyWhatsAppState = "connected"): Starter[] {
  const chips = starterChips(lang, pageId);
  if (starterPageOf(pageId) === "dashboard" && whatsapp === "none") return chips.filter((c) => c.key === "start.dashboard.next_step");
  return chips;
}

export function StarterChips({ lang, pageId, whatsapp, onPick, disabled, className }: { lang: EddyLang; pageId: string | null | undefined; whatsapp?: EddyWhatsAppState; onPick: (query: string) => void; disabled?: boolean; className?: string }) {
  const chips = startersFor(lang, pageId, whatsapp);
  if (chips.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap gap-2", className)} lang={htmlLang(lang)} data-eddy-starters>
      {chips.map((c) => (
        <li key={c.key}>
          <Button type="button" variant="secondary" size="sm" className="min-h-9 whitespace-normal text-left pointer-coarse:min-h-11" disabled={disabled} onClick={() => onPick(c.query)}>
            {c.label}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The "Go to" buttons that stand in for the chips while the AI is unavailable (6.11): plain links, no model call. */
export function gotoChips(lang: EddyLang, pageId: string | null | undefined): { path: string; label: string }[] {
  const here = GOTO_KEYS[starterPageOf(pageId)];
  const all = [GOTO_KEYS.dashboard, GOTO_KEYS["inbox.chat"], GOTO_KEYS.templates, GOTO_KEYS.broadcasts, { key: "goto.setup" as const, path: "/app/getting-started" }];
  const ordered = [here, ...all.filter((g) => g.path !== here.path)];
  return ordered.map((g) => ({ path: g.path, label: t(lang, g.key) }));
}

export function GotoButtons({ lang, pageId, onNavigate, className }: { lang: EddyLang; pageId: string | null | undefined; onNavigate?: (path: string) => void; className?: string }) {
  return (
    <nav aria-label={tp(lang, "panel.goto")} className={className} lang={htmlLang(lang)} data-eddy-goto>
      <NavChips chips={gotoChips(lang, pageId)} onNavigate={onNavigate} />
    </nav>
  );
}

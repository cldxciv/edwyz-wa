"use client";

/**
 * The "Ask Eddy" button in the top bar (docs/EDDY-SPEC.md 6.1, 6.2, 6.13): the 20 px avatar, at every breakpoint. On phones
 * it sits after the search icon; on desktop, before Help (TopBar places it). No floating button, no seventh tab, no new
 * single-key shortcut: Ctrl/Cmd+K and the palette's "Ask Eddy" are the keyboard path.
 *
 * - A dot shows notices that need the member; the count is in the accessible name ("Ask Eddy, 2 things need you"), so it
 *   never relies on colour.
 * - While a turn runs with the panel closed, the avatar shows Eddy working and the name says so.
 * - The status comes from the shared store (useEddyStatus); the launcher itself never fetches.
 */
import { cn } from "@/components/ui";
import type { EddyLangPref } from "@/lib/eddy/contract";
import { tp } from "@/lib/eddy/copy/panel";
import { t, type EddyLang } from "@/lib/eddy/i18n";
import { useShell } from "@/components/app/shell-context";
import { EddyAvatar, type EddyAvatarState } from "./EddyAvatar";
import { useEddyStatus } from "./useEddyStatus";

/** The id of the open panel or sheet, for the launcher's aria-controls. */
export const EDDY_PANEL_ID = "eddy-panel";

/** The chrome language: the member's saved preference, else English (the shell's language). */
export const chromeLang = (pref: EddyLangPref | null | undefined, turnLang?: EddyLang | null): EddyLang => (pref && pref !== "auto" ? pref : (turnLang ?? "en"));

/** The launcher's accessible name. */
export function launcherLabel(lang: EddyLang, needsYou: number, working: boolean): string {
  if (working) return tp(lang, "panel.launcher.working");
  if (needsYou === 1) return t(lang, "launcher.needs.one");
  return needsYou > 0 ? t(lang, "launcher.needs", { count: needsYou }) : t(lang, "launcher");
}

/** The avatar's state: working, a needs-you dot, off while Eddy can't chat, otherwise idle. */
export function launcherAvatarState(opts: { working: boolean; needsYou: number; ready: boolean | null }): EddyAvatarState {
  if (opts.working) return "working";
  if (opts.needsYou > 0) return "needs_action";
  return opts.ready === false ? "off" : "idle";
}

export function EddyLauncher({ className }: { className?: string }) {
  const { openEddy, closeEddy, eddyOpen } = useShell();
  const { status, working } = useEddyStatus();
  const lang = chromeLang(status?.langPref);
  const needsYou = status?.needsYou ?? 0;
  const busy = working && !eddyOpen;
  return (
    <button
      type="button"
      onClick={() => (eddyOpen ? closeEddy() : openEddy())}
      aria-label={launcherLabel(lang, needsYou, busy)}
      aria-expanded={eddyOpen}
      title={t(lang, "launcher")}
      className={cn(
        "relative inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-foreground pointer-coarse:h-11 pointer-coarse:w-11",
        eddyOpen && "bg-surface text-foreground",
        className,
      )}
      data-eddy-launcher
    >
      <EddyAvatar size="launcher" state={launcherAvatarState({ working: busy, needsYou, ready: status ? status.state === "ready" : null })} />
    </button>
  );
}

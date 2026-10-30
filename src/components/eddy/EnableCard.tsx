"use client";

/**
 * The "Turn on Eddy" card (docs/EDDY-SPEC.md 6.11, 7.9, 12.1a decision 6). Eddy is off by default. Until the owner turns it
 * on, the launcher opens this short card: what Eddy does, and what it costs in AI credits.
 *
 * - Only the OWNER switches it on (`EddyStatusDTO.canEnable`), with one tap. That tap records the AI-processing consent:
 *   the server stores `enabledById`, `enabledAt` and `consentVersion = LEGAL.version` (PUT /api/eddy/settings). So the owner
 *   sees the disclosure (what is sent to Anthropic, how long chats are kept) right above the button.
 * - Admins and team members never get a button: they see the owner's name, "Ask the owner: {names}."
 * - The same switch is in Settings > AI tools (EddySettingsCard), so the card also links there.
 */
import { useState } from "react";
import { EDDY_DEFAULTS } from "@/lib/eddy/contract";
import { tp } from "@/lib/eddy/copy/panel";
import { t, type EddyLang } from "@/lib/eddy/i18n";
import { ActionCard, type ActionButton, type NavChip } from "./ActionCard";

/** Where the owner's on/off switch lives (12.1a decision 6: "in Settings"). */
export const EDDY_SETTINGS_PAGE = "/app/settings/ai-tools#eddy";

export type EnableCardProps = {
  lang: EddyLang;
  /** The owner only (EddyStatusDTO.canEnable). */
  canEnable: boolean;
  ownerNames: readonly string[];
  /** How long chats are kept ({days} in the disclosure). */
  historyDays: number;
  busy?: boolean;
  error?: string | null;
  onTurnOn?: () => void;
  onNotNow?: () => void;
  onNavigate?: (path: string) => void;
  /** Hide the Settings chip (the card shown on the Settings page itself). */
  hideSettingsLink?: boolean;
  className?: string;
};

/** The card's body as catalogue text: what Eddy does, its cost, then the disclosure and consent (owner) or who can (others). */
export function enableCardBody(lang: EddyLang, canEnable: boolean, ownerNames: readonly string[], historyDays: number): string {
  const what = t(lang, "turnon.what");
  const cost = t(lang, "turnon.cost", { perTurn: EDDY_DEFAULTS.maxCreditsPerTurn.toLocaleString("en-IN"), perDay: EDDY_DEFAULTS.maxCreditsPerUserDay.toLocaleString("en-IN") });
  const rest = canEnable ? [t(lang, "enable.body", { days: historyDays }), t(lang, "turnon.consent")] : [t(lang, "turnon.ask_owner", { names: ownerNames.join(", ") || "—" })];
  return [what, cost, ...rest].join("\n\n");
}

export function EnableCard({ lang, canEnable, ownerNames, historyDays, busy, error, onTurnOn, onNotNow, onNavigate, hideSettingsLink, className }: EnableCardProps) {
  const buttons: ActionButton[] = canEnable
    ? [
        { id: "turn-on", label: t(lang, "btn.turn_on"), variant: "primary", onClick: onTurnOn, loading: busy, disabled: !onTurnOn },
        ...(onNotNow ? [{ id: "not-now", label: t(lang, "btn.not_now"), variant: "secondary" as const, onClick: onNotNow, disabled: busy }] : []),
      ]
    : [];
  const chips: NavChip[] = canEnable && !hideSettingsLink ? [{ path: EDDY_SETTINGS_PAGE, label: t(lang, "btn.eddy_settings") }] : [];
  return (
    <ActionCard lang={lang} title={t(lang, "turnon.title")} body={enableCardBody(lang, canEnable, ownerNames, historyDays)} buttons={buttons} chips={chips} onNavigate={onNavigate} className={className}>
      <p role="status" aria-live="polite" className={error ? "text-sm font-medium text-bad-fg" : "sr-only"} data-eddy-enable-status>
        {error ?? ""}
      </p>
    </ActionCard>
  );
}

/** Switches Eddy on or off for the workspace (owner only; the server answers 403 to anyone else). */
export async function putEddyEnabled(enabled: boolean): Promise<boolean> {
  try {
    const res = await fetch("/api/eddy/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
      credentials: "same-origin",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The card with its tap wired up: one PUT, then `onEnabled` (the panel reloads the status). */
export function EnableCardController({ lang, canEnable, ownerNames, historyDays, onEnabled, onNotNow, onNavigate, className }: Omit<EnableCardProps, "busy" | "error" | "onTurnOn"> & { onEnabled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnOn = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const ok = await putEddyEnabled(true);
    setBusy(false);
    if (ok) onEnabled();
    else setError(tp(lang, "panel.enable.failed"));
  };
  return <EnableCard lang={lang} canEnable={canEnable} ownerNames={ownerNames} historyDays={historyDays} busy={busy} error={error} onTurnOn={canEnable ? turnOn : undefined} onNotNow={onNotNow} onNavigate={onNavigate} className={className} />;
}

"use client";

/**
 * Eddy's switch in Settings > AI tools (docs/EDDY-SPEC.md 7.1, 7.9, 7.10, 12.1a decision 6: "An owner turns it on with one
 * tap in Settings; the same tap records the AI-processing consent bound to LEGAL.version").
 *
 * - The OWNER (EddyStatusDTO.canEnable) gets the on/off switch. Above it, before turning on, the disclosure says what is
 *   sent to Anthropic and how long chats are kept, and that the tap records consent. Turning Eddy off is always allowed and
 *   takes effect at once; previews already on screen can still be confirmed or cancelled.
 * - Admins and team members see whether Eddy is on, and who can change it ("Ask the owner: {names}"). No switch.
 * - What Eddy does and what it costs in AI credits is said in both cases.
 *
 * The switch writes PUT /api/eddy/settings {enabled}; the server checks the owner, a verified email where required, same
 * origin, and stores enabledById, enabledAt and consentVersion = LEGAL.version.
 */
import { useEffect, useState } from "react";
import { Alert, Card, cn, Spinner } from "@/components/ui";
import { Toggle } from "@/components/automation/Toggle";
import { EDDY_DEFAULTS, type EddyStatusDTO } from "@/lib/eddy/contract";
import { tp } from "@/lib/eddy/copy/panel";
import { htmlLang, t, type EddyLang } from "@/lib/eddy/i18n";
import { putEddyEnabled } from "./EnableCard";
import { chromeLang } from "./EddyLauncher";
import { historyDaysOf, loadEddyStatus, useEddyStatus } from "./useEddyStatus";

/** The anchor of the card on the AI tools page. */
export const EDDY_SETTINGS_ANCHOR = "eddy";

/**
 * Whether Eddy is on for the workspace: the settings answer when the server gives one, else what the status implies
 * (workspace_off means off; a state past the workspace switch means on). Null when it cannot be known (platform off, locked).
 */
export function enabledFrom(settings: unknown, status: EddyStatusDTO | null): boolean | null {
  const s = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : null;
  const nested = s ? (s.setting ?? s.settings) : null;
  const inner = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : s;
  if (inner && typeof inner.enabled === "boolean") return inner.enabled;
  if (!status) return null;
  if (status.state === "workspace_off") return false;
  if (status.state === "platform_off" || status.state === "locked") return null;
  return true;
}

export type EddySettingsViewProps = {
  lang: EddyLang;
  status: EddyStatusDTO | null;
  enabled: boolean | null;
  busy?: boolean;
  /** The result of the last change, announced politely. */
  message?: string | null;
  error?: string | null;
  loading?: boolean;
  loadFailed?: boolean;
  onToggle?: (next: boolean) => void;
  /** How long chats are kept (the settings answer's historyDays); defaults to the status figure or 90. */
  historyDays?: number;
};

/** The card, without data loading (rendered by tests and by EddySettingsCard). */
export function EddySettingsView({ lang, status, enabled, busy, message, error, loading, loadFailed, onToggle, historyDays }: EddySettingsViewProps) {
  const owner = status?.canEnable === true;
  const days = historyDays ?? historyDaysOf(status);
  const cost = t(lang, "turnon.cost", { perTurn: EDDY_DEFAULTS.maxCreditsPerTurn.toLocaleString("en-IN"), perDay: EDDY_DEFAULTS.maxCreditsPerUserDay.toLocaleString("en-IN") });
  const textClass = lang === "hi" ? "text-base leading-[1.6]" : "text-sm";
  return (
    <Card id={EDDY_SETTINGS_ANCHOR} title={tp(lang, "panel.settings.title")} description={t(lang, "turnon.what")} className="scroll-mt-20" data-eddy-settings>
      <div className="flex flex-col gap-4" lang={htmlLang(lang)}>
        <p className={cn("text-muted", textClass)}>{cost}</p>
        {loading && !status ? (
          <Spinner label={tp(lang, "panel.settings.loading")} />
        ) : loadFailed && !status ? (
          <Alert tone="warn">{tp(lang, "panel.settings.load_failed")}</Alert>
        ) : (
          <>
            {status?.state === "platform_off" && <Alert tone="info">{t(lang, status.reason === "paused" ? "off.platform_paused" : "off.platform")}</Alert>}
            {owner ? (
              <>
                {enabled !== true && (
                  <div className={cn("rounded-card border border-border bg-surface p-3", textClass)} data-eddy-disclosure>
                    <p>{t(lang, "enable.body", { days })}</p>
                    <p className="mt-2 font-medium">{t(lang, "turnon.consent")}</p>
                  </div>
                )}
                {enabled === true && <p className={cn("text-muted", textClass)}>{tp(lang, "panel.settings.turn_off_note")}</p>}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm font-semibold">{tp(lang, "panel.settings.switch")}</span>
                  <Toggle checked={enabled === true} onChange={(next) => onToggle?.(next)} label={tp(lang, "panel.settings.switch")} disabled={busy || !onToggle} onText={tp(lang, "panel.settings.on")} offText={tp(lang, "panel.settings.off")} className="pointer-coarse:min-h-11" />
                </div>
              </>
            ) : (
              <>
                <p className={cn("font-medium", textClass)} data-eddy-settings-state>
                  {enabled === true ? tp(lang, "panel.settings.is_on") : enabled === false ? tp(lang, "panel.settings.is_off") : null}
                </p>
                <p className={cn("text-muted", textClass)}>{t(lang, "turnon.ask_owner", { names: status?.ownerNames.join(", ") || "—" })}</p>
              </>
            )}
          </>
        )}
        <p role="status" aria-live="polite" className={error ? "text-sm font-medium text-bad-fg" : message ? "text-sm text-muted" : "sr-only"}>
          {error ?? message ?? ""}
        </p>
      </div>
    </Card>
  );
}

/** The card with its data: the shared status store (EddyRoot keeps it fresh) and GET /api/eddy/settings when available. */
export function EddySettingsCard() {
  const { status, loading, error: statusError, refresh } = useEddyStatus();
  const [settings, setSettings] = useState<unknown>(null);
  const [override, setOverride] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lang = chromeLang(status?.langPref);

  useEffect(() => {
    let live = true;
    void refresh();
    fetch("/api/eddy/settings", { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => live && setSettings(json))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [refresh]);

  const enabled = override ?? enabledFrom(settings, status);
  const days = (settings as { historyDays?: unknown } | null)?.historyDays;
  const historyDays = typeof days === "number" && Number.isInteger(days) && days >= 30 && days <= 365 ? days : undefined;

  const toggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const ok = await putEddyEnabled(next);
    setBusy(false);
    if (!ok) {
      setError(tp(lang, next ? "panel.enable.failed" : "panel.settings.failed"));
      return;
    }
    setOverride(next);
    setMessage(tp(lang, next ? "panel.enable.done" : "panel.settings.saved_off"));
    void loadEddyStatus();
  };

  return <EddySettingsView lang={lang} status={status} enabled={enabled} busy={busy} message={message} error={error} loading={loading} loadFailed={!!statusError} historyDays={historyDays} onToggle={status?.canEnable ? (next) => void toggle(next) : undefined} />;
}

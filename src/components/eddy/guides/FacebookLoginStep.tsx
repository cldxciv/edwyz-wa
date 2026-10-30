"use client";

/**
 * The Facebook step of the guided setup (docs/EDDY-SPEC.md 6.8 step 4, 6.15, 12.1a decision 11): Facebook Login for
 * Business in a small window, launched synchronously from the member's tap, so people stay in the app. When the browser
 * blocks the window, Facebook opens in the same tab instead and comes back to the Connections page (the full-page redirect
 * stays the fallback). The outcome comes back as one word from the callback's closing page; the card then says what
 * happened in the member's language, never in Meta's words.
 *
 * Team members see that an admin is needed (the card does that, from STEP_MIN_ROLE). Nothing here names a Meta address: the
 * window opens our own start route's answer, which only ever is Facebook's consent dialog.
 */
import { Button, cn } from "@/components/ui";
import { CONNECTIONS_PATH, facebookResultText, guideButton, tg, type GuideCard } from "@/lib/eddy/guides";
import { htmlLang, type EddyLang } from "@/lib/eddy/i18n";
import { useFacebookLoginPopup, type FbPopupPhase, type FbPopupResult, type LaunchDeps, type WatchDeps } from "@/components/meta-connect/useFacebookLoginPopup";
import { GuideLink } from "./SetupGuide";

export type FacebookStepViewProps = {
  lang: EddyLang;
  card: GuideCard;
  phase: FbPopupPhase;
  result: FbPopupResult | null;
  /** The click handler: it must open the window synchronously (useFacebookLoginPopup().start). */
  onStart: () => void;
  onNavigate?: (path: string) => void;
};

export function FacebookStepView({ lang, card, phase, result, onStart, onNavigate }: FacebookStepViewProps) {
  const body = lang === "hi" ? "text-base leading-[1.6]" : "text-sm";
  const connected = result?.kind === "outcome" && result.outcome === "connected";
  const busy = phase === "opening" || phase === "waiting" || phase === "redirecting";
  const status =
    phase === "opening" ? tg(lang, "guides.facebook.opening") : phase === "waiting" ? tg(lang, "guides.facebook.waiting") : phase === "redirecting" ? tg(lang, "guides.facebook.redirecting") : result ? facebookResultText(lang, result) : "";
  return (
    <div className="flex flex-col gap-2" data-guide-facebook={connected ? "connected" : phase} lang={htmlLang(lang)}>
      <p className={cn("text-muted", body)}>{tg(lang, "guides.facebook.note")}</p>
      {!connected && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" className="pointer-coarse:min-h-11" onClick={onStart} loading={busy} data-guide-part="primary">
            {result ? tg(lang, "guides.fix.retry") : (card.primary?.label ?? guideButton.connectFacebook(lang))}
          </Button>
          {result && <GuideLink path={CONNECTIONS_PATH} label={tg(lang, "guides.facebook.connections")} onNavigate={onNavigate} part="fix" />}
        </div>
      )}
      <p role="status" aria-live="polite" className={status ? cn(body, connected ? "rounded-lg border border-good-line bg-good-soft px-3 py-2 text-good-fg" : "text-muted") : "sr-only"} data-guide-outcome={connected ? "connected" : undefined}>
        {status}
      </p>
    </div>
  );
}

export type FacebookLoginStepProps = {
  lang: EddyLang;
  card: GuideCard;
  onNavigate?: (path: string) => void;
  /** Facebook is connected: the guide announces it and re-reads the setup. */
  onConnected?: (announce?: string) => void;
  /** Test seams for the popup (window.open, the start route, the closing page's message). */
  launchDeps?: () => LaunchDeps;
  watchDeps?: () => WatchDeps;
};

export function FacebookLoginStep({ lang, card, onNavigate, onConnected, launchDeps, watchDeps }: FacebookLoginStepProps) {
  const popup = useFacebookLoginPopup({
    launchDeps,
    watchDeps,
    onResult: (r) => {
      // A closed window may still have finished: the guide re-reads the setup either way.
      if (r.kind === "outcome" && r.outcome === "connected") onConnected?.(facebookResultText(lang, r));
      else if (r.kind === "closed") onConnected?.();
    },
  });
  return <FacebookStepView lang={lang} card={card} phase={popup.phase} result={popup.result} onStart={popup.start} onNavigate={onNavigate} />;
}

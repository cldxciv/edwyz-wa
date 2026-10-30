"use client";

/**
 * Step 1 of the guided setup: Connect WhatsApp (docs/EDDY-SPEC.md 6.8 step 1, 6.15, EDDY-17 acceptance 2).
 *
 * The card shows Meta's five Embedded Signup screens and the preparation checklist (with coexistence), then [Connect
 * WhatsApp] opens /app/settings/connect?from=eddy, where the existing ConnectWhatsApp calls FB.login synchronously from the
 * member's click (createLoginPreloader prepare and take), so a popup blocker cannot stop it. On desktop the panel stays open
 * beside the page; on phones the sheet closes and the guide picks up again when it reopens (the wait is remembered for the
 * tab in sessionStorage, inside try/catch).
 *
 * While it waits it re-reads GET /api/onboarding/status and GET /api/onboarding/token-health every 5 seconds for up to 15
 * minutes, then posts the outcome: "WhatsApp is connected: +91 98xxx x4321. Next: your first template." A failed step gets
 * classifyFailure()'s case in the member's language with its fixes (try again, connect again, coexistence, email support).
 * Nothing here links to a Meta domain.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, apiFetch, Button, cn } from "@/components/ui";
import { COMPANY } from "@/lib/config";
import { CONNECT_PATH, CONNECT_POLL_LIMIT_MS, CONNECT_POLL_MS, connectCheck, connectFailure, connectScreens, guideButton, onboardingFailureMessage, prepareChecklist, tg, type ConnectFailure, type GuideCard, type OnboardingStatus, type TokenHealth } from "@/lib/eddy/guides";
import { htmlLang, type EddyLang } from "@/lib/eddy/i18n";
import { GuideLink } from "./SetupGuide";

export const CONNECT_WAIT_KEY = "eddy:guide:connect";
export const SUPPORT_HREF = `mailto:${COMPANY.email}?subject=${encodeURIComponent("Connecting WhatsApp")}`;

export type ConnectView =
  | { phase: "idle" }
  | { phase: "waiting"; since: number }
  | { phase: "checking"; since: number }
  | { phase: "connected"; text: string }
  | { phase: "reconnect"; text: string }
  | { phase: "stopped" }
  | { phase: "failed"; failure: ConnectFailure };

export type ConnectDeps = {
  status(): Promise<OnboardingStatus>;
  health(): Promise<TokenHealth>;
  /** The connected numbers (GET /api/inbox/numbers); the first one names the outcome. */
  numbers(): Promise<{ displayPhone?: string | null }[]>;
  now(): number;
};

export const defaultConnectDeps: ConnectDeps = {
  status: () => apiFetch<OnboardingStatus>("/api/onboarding/status"),
  health: () => apiFetch<TokenHealth>("/api/onboarding/token-health"),
  numbers: async () => (await apiFetch<{ numbers: { displayPhone?: string | null }[] }>("/api/inbox/numbers")).numbers,
  now: () => Date.now(),
};

/** One check of the onboarding status and token health: the view it leads to. Never throws (a failed read keeps waiting). */
export async function checkConnection(lang: EddyLang, deps: ConnectDeps, since: number, site: string): Promise<ConnectView> {
  let status: OnboardingStatus | null = null;
  try {
    status = await deps.status();
  } catch {
    status = null;
  }
  const failed = onboardingFailureMessage(status?.steps);
  if (failed && status?.status !== "live") return { phase: "failed", failure: connectFailure(failed, { lang, stage: 3, site, support: { href: SUPPORT_HREF } }) };
  if (status?.status === "live") {
    const [health, numbers] = await Promise.all([deps.health().catch(() => null), deps.numbers().catch(() => [])]);
    const check = connectCheck(lang, status, health, numbers[0]?.displayPhone ?? null);
    if (check.state === "connected") return { phase: "connected", text: check.text };
    if (check.state === "reconnect") return { phase: "reconnect", text: check.text };
  }
  if (deps.now() - since >= CONNECT_POLL_LIMIT_MS) return { phase: "stopped" };
  return { phase: "waiting", since };
}

function readWait(now: number): number | null {
  try {
    const raw = window.sessionStorage.getItem(CONNECT_WAIT_KEY);
    const since = raw ? Number(raw) : NaN;
    return Number.isFinite(since) && now - since >= 0 && now - since < CONNECT_POLL_LIMIT_MS ? since : null;
  } catch {
    return null;
  }
}

function writeWait(since: number | null): void {
  try {
    if (since === null) window.sessionStorage.removeItem(CONNECT_WAIT_KEY);
    else window.sessionStorage.setItem(CONNECT_WAIT_KEY, String(since));
  } catch {
    // Storage blocked: the wait simply isn't remembered across a reload.
  }
}

export type ConnectStepViewProps = {
  lang: EddyLang;
  card: GuideCard;
  view: ConnectView;
  site: string;
  onStart: () => void;
  onCheck: () => void;
  onNavigate?: (path: string) => void;
};

/** The step's markup for a given view: pure, so every state renders in tests. */
export function ConnectStepView({ lang, card, view, site, onStart, onCheck, onNavigate }: ConnectStepViewProps) {
  const deva = lang === "hi";
  const body = deva ? "text-base leading-[1.6]" : "text-sm";
  const screens = connectScreens(lang);
  const checklist = prepareChecklist(lang);
  const waiting = view.phase === "waiting" || view.phase === "checking";
  return (
    <div className="flex flex-col gap-3" data-guide-connect={view.phase} lang={htmlLang(lang)}>
      <div>
        <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">{tg(lang, "guides.connect.prepare")}</h5>
        <ul className={cn("mt-1 list-disc space-y-1 ps-5 text-foreground", body)} data-guide-checklist>
          {checklist.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <details className="rounded-lg border border-border bg-surface px-3 py-2" data-guide-screens>
        <summary className={cn("cursor-pointer font-semibold text-foreground pointer-coarse:min-h-11", body)}>{tg(lang, "guides.connect.screens")}</summary>
        <ol className="mt-2 flex list-decimal flex-col gap-2 ps-5">
          {screens.map((s) => (
            <li key={s.title} className={body}>
              <span className="block font-semibold text-foreground">{s.title}</span>
              <span className="block text-muted">{s.text}</span>
            </li>
          ))}
        </ol>
      </details>

      {(view.phase === "idle" || view.phase === "stopped" || waiting) && (
        <div className="flex flex-wrap items-center gap-2">
          <GuideLink path={CONNECT_PATH} label={card.primary?.label ?? guideButton.connectWhatsApp(lang)} primary onNavigate={onNavigate} onClick={onStart} part="primary" />
          {view.phase !== "idle" && (
            <Button type="button" variant="secondary" size="sm" className="pointer-coarse:min-h-11" onClick={onCheck} loading={view.phase === "checking"}>
              {tg(lang, "guides.connect.check")}
            </Button>
          )}
        </div>
      )}
      {view.phase === "idle" && <p className={cn("text-muted", deva ? "text-base leading-[1.6]" : "text-xs")}>{tg(lang, "guides.connect.opens")}</p>}

      <div role="status" aria-live="polite" className={cn(body)}>
        {view.phase === "waiting" && <p className="text-muted">{tg(lang, "guides.connect.waiting")}</p>}
        {view.phase === "checking" && <p className="text-muted">{tg(lang, "guides.connect.checking")}</p>}
        {view.phase === "stopped" && <p className="text-muted">{tg(lang, "guides.connect.stopped")}</p>}
        {view.phase === "connected" && (
          <p className="rounded-lg border border-good-line bg-good-soft px-3 py-2 text-good-fg" data-guide-outcome="connected">
            {view.text}
          </p>
        )}
      </div>

      {view.phase === "reconnect" && (
        <Alert tone="warn" action={<GuideLink path={CONNECT_PATH} label={tg(lang, "guides.fix.connect_again")} primary onNavigate={onNavigate} onClick={onStart} part="primary" />}>
          <span className={body}>{view.text}</span>
        </Alert>
      )}
      {view.phase === "failed" && <FailureBox lang={lang} failure={view.failure} site={site} onStart={onStart} onNavigate={onNavigate} />}
    </div>
  );
}

function FailureBox({ lang, failure, onStart, onNavigate }: { lang: EddyLang; failure: ConnectFailure; site: string; onStart: () => void; onNavigate?: (path: string) => void }) {
  const body = lang === "hi" ? "text-base leading-[1.6]" : "text-sm";
  return (
    <Alert tone="warn" title={failure.title}>
      <div className="flex flex-col gap-2" data-guide-failure={failure.kind}>
        <p className={body}>{failure.text}</p>
        {failure.fixes.some((f) => f.kind === "coexistence") && <p className={cn("text-muted", body)}>{tg(lang, "guides.fix.coexistence_note")}</p>}
        <div className="flex flex-wrap gap-2">
          {failure.fixes.map((f, i) =>
            f.path ? (
              <GuideLink key={f.kind} path={f.path} label={f.label} primary={i === 0} onNavigate={onNavigate} onClick={onStart} part={i === 0 ? "primary" : "fix"} />
            ) : f.href ? (
              <a key={f.kind} href={f.href} className="inline-flex min-h-8 items-center rounded-full border border-border-strong bg-raised px-3 text-xs font-semibold text-foreground no-underline pointer-coarse:min-h-11" data-guide-part="fix">
                {f.label}
              </a>
            ) : null,
          )}
        </div>
      </div>
    </Alert>
  );
}

export type ConnectStepProps = {
  lang: EddyLang;
  card: GuideCard;
  onNavigate?: (path: string) => void;
  /** WhatsApp is connected: the guide announces the line and re-reads the setup. */
  onConnected?: (announce?: string) => void;
  site?: string;
  deps?: ConnectDeps;
};

export function ConnectStep({ lang, card, onNavigate, onConnected, site, deps = defaultConnectDeps }: ConnectStepProps) {
  const [view, setView] = useState<ConnectView>({ phase: "idle" });
  const announced = useRef(false);
  const siteName = site ?? "wa.edwyz.com";

  // A wait started before the sheet closed (phones) or the page reloaded picks up again.
  useEffect(() => {
    const since = readWait(deps.now());
    if (since !== null) setView({ phase: "waiting", since });
  }, [deps]);

  const check = useCallback(
    async (since: number) => {
      setView((v) => (v.phase === "waiting" || v.phase === "stopped" || v.phase === "checking" ? { phase: "checking", since } : v));
      const next = await checkConnection(lang, deps, since, siteName);
      if (next.phase !== "waiting" && next.phase !== "checking") writeWait(null);
      setView(next);
      if (next.phase === "connected" && !announced.current) {
        announced.current = true;
        onConnected?.(next.text);
      }
    },
    [deps, lang, onConnected, siteName],
  );

  const waitingSince = view.phase === "waiting" ? view.since : null;
  useEffect(() => {
    if (waitingSince === null) return;
    const timer = window.setInterval(() => void check(waitingSince), CONNECT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [waitingSince, check]);

  const start = useCallback(() => {
    const since = deps.now();
    writeWait(since);
    announced.current = false;
    setView({ phase: "waiting", since });
  }, [deps]);

  const checkNow = useCallback(() => {
    const since = view.phase === "waiting" || view.phase === "checking" ? view.since : deps.now();
    if (view.phase === "stopped") writeWait(since);
    void check(since);
  }, [check, deps, view]);

  return <ConnectStepView lang={lang} card={card} view={view} site={siteName} onStart={start} onCheck={checkNow} onNavigate={onNavigate} />;
}

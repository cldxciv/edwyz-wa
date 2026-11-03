"use client";

/**
 * The guided setup in Eddy (docs/EDDY-SPEC.md 6.8, 6.11, EDDY-17): step cards from GET /api/setup, built with no model call
 * (src/lib/eddy/guides.ts), so the guide works in every off state (platform_off, paused, allowance_used, user_capped) as
 * plain buttons, and in the ready state below the greeting, where its template and broadcast steps hand Eddy a message.
 *
 * Every card has its title, a one-line reason, the minutes it takes, a primary button to the page that does it, "Ask Eddy
 * about this" and, for admins, "Skip for now". The next step opens with its flow (Connect WhatsApp, the first template, the
 * first broadcast, Facebook); the rest are compact link cards under "Later steps". Team members see who has to do an admin
 * step. No card ever links to a Meta domain (6.15).
 */
import { useCallback, useId, useState, type ReactNode } from "react";
import { apiFetch, Badge, Button, cn, Spinner } from "@/components/ui";
import { buttonSizes, buttonVariants } from "@/components/ui/Button";
import { useSetup } from "@/components/setup/useSetup";
import type { StepId } from "@/lib/setup/checklist";
import { tp } from "@/lib/eddy/copy/panel";
import { buildGuide, stepTitle, tg, type GuideCard, type GuideModel, type SetupData } from "@/lib/eddy/guides";
import { htmlLang, t, type EddyLang } from "@/lib/eddy/i18n";
import { openEddy } from "../events";
import { ProgressSteps, type ProgressStep } from "../ProgressSteps";
import { BroadcastStep } from "./BroadcastStep";
import { ConnectStep } from "./ConnectStep";
import { FacebookLoginStep } from "./FacebookLoginStep";
import { TemplateStep } from "./TemplateStep";

/** A link that looks like a design-system button, at least 44 px tall on touch screens and in the phone sheet (below md). */
export const guideLinkClass = (primary: boolean) =>
  cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold no-underline", buttonVariants[primary ? "primary" : "secondary"], buttonSizes.sm, "max-md:min-h-11 pointer-coarse:min-h-11");

/** A link to an /app page that the panel can turn into a client navigation (so a phone sheet closes on the way). */
export function GuideLink({ path, label, primary = false, onNavigate, onClick, part, ariaLabel }: { path: string; label: string; primary?: boolean; onNavigate?: (path: string) => void; onClick?: () => void; part?: string; ariaLabel?: string }) {
  return (
    <a
      href={path}
      className={guideLinkClass(primary)}
      data-guide-part={part}
      aria-label={ariaLabel}
      onClick={(e) => {
        onClick?.();
        if (onNavigate) {
          e.preventDefault();
          onNavigate(path);
        }
      }}
    >
      {label}
    </a>
  );
}

export type GuideActions = {
  canChat: boolean;
  /** Sends the member's own message to Eddy (a tap on a guide button counts as the member's message, 7.2 item 9). */
  onAsk: (query: string) => void;
  onNavigate?: (path: string) => void;
  /** "Skip for now" (admin dismiss). Resolves when saved; rejects when it couldn't be. */
  onSkip?: (id: StepId) => Promise<void>;
  /** The setup changed (a step got done): re-read GET /api/setup, and say what happened (the card itself may leave the list). */
  onChanged?: (announce?: string) => void;
  /** The site name for "Allow pop-ups for {site}". */
  site?: string;
};

type CardProps = { card: GuideCard; lang: EddyLang; actions: GuideActions; busy: boolean; flow: boolean };

function Flow({ card, lang, actions }: Omit<CardProps, "busy" | "flow">) {
  switch (card.kind) {
    case "connect":
      return <ConnectStep lang={lang} card={card} onNavigate={actions.onNavigate} onConnected={actions.onChanged} site={actions.site} />;
    case "template":
      return <TemplateStep lang={lang} card={card} canChat={actions.canChat} onAsk={actions.onAsk} onNavigate={actions.onNavigate} />;
    case "broadcast":
      return <BroadcastStep lang={lang} card={card} canChat={actions.canChat} onAsk={actions.onAsk} onNavigate={actions.onNavigate} />;
    case "facebook":
      return <FacebookLoginStep lang={lang} card={card} onNavigate={actions.onNavigate} onConnected={actions.onChanged} />;
    default:
      return null;
  }
}

/** One step card. `flow` opens the step's own flow (the next step, not blocked, and allowed for the member). */
export function GuideStepCard({ card, lang, actions, busy, flow }: CardProps) {
  const titleId = useId();
  const [note, setNote] = useState<string | null>(null);
  const deva = lang === "hi";
  const ask = () => {
    if (!actions.canChat) {
      setNote(tg(lang, "guides.ask.off"));
      return;
    }
    setNote(null);
    actions.onAsk(card.ask.query);
  };
  // The guide announces the result: a skipped card leaves the list at once, with its own status region.
  const skip = () => void actions.onSkip?.(card.id);
  const showFlow = flow && card.kind !== "link" && !card.blocked && !card.adminNeeded;
  return (
    <article role="group" aria-labelledby={titleId} className={cn("flex flex-col gap-2 rounded-card border border-border bg-raised p-3 shadow-raised", card.current && "border-accent")} data-guide-step={card.id} data-guide-kind={card.kind} lang={htmlLang(lang)}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={titleId} className={cn("font-semibold text-foreground", deva ? "text-base leading-[1.6]" : "text-sm")} data-guide-part="title">
          {card.title}
        </h4>
        {card.current && <Badge tone="info">{tg(lang, "guides.next")}</Badge>}
        {card.optional && !card.current && <Badge>{tg(lang, "guides.optional")}</Badge>}
      </div>
      <p className={cn("text-muted", deva ? "text-base leading-[1.6]" : "text-sm")} data-guide-part="reason">
        {card.reason}
      </p>
      <p className="text-xs text-muted" data-guide-part="minutes">
        {card.minutes}
      </p>
      {card.detail && (
        <p className="text-xs text-foreground" lang="en">
          {card.detail}
        </p>
      )}
      {card.blocked && (
        <p role="note" className="rounded-lg border border-warn-line bg-warn-soft px-2 py-1 text-xs text-warn-fg" data-guide-blocked>
          {card.blocked}
        </p>
      )}
      {card.adminNeeded && (
        <p role="note" className={cn("rounded-lg border border-info-line bg-info-soft px-2 py-1 text-info-fg", deva ? "text-base leading-[1.6]" : "text-sm")} data-guide-admin-needed>
          {card.adminNeeded}
        </p>
      )}
      {showFlow ? (
        <Flow card={card} lang={lang} actions={actions} />
      ) : (
        card.primary && (
          <div className="flex flex-wrap gap-2">
            <GuideLink path={card.primary.path} label={card.primary.label} primary onNavigate={actions.onNavigate} part="primary" />
          </div>
        )
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <Button type="button" variant="ghost" size="sm" className="pointer-coarse:min-h-11" aria-label={card.ask.a11y} onClick={ask} data-guide-part="ask">
          {card.ask.label}
        </Button>
        {card.skip && (
          <Button type="button" variant="ghost" size="sm" className="pointer-coarse:min-h-11" aria-label={card.skip.a11y} onClick={skip} disabled={busy} data-guide-part="skip">
            {card.skip.label}
          </Button>
        )}
      </div>
      <p role="status" aria-live="polite" className={note ? "text-xs text-muted" : "sr-only"}>
        {note}
      </p>
    </article>
  );
}

export type SetupGuideViewProps = {
  lang: EddyLang;
  role: string;
  data: SetupData | null;
  loading?: boolean;
  error?: string | null;
  busy?: StepId | null;
  onRetry?: () => void;
  /** Hide the whole guide once setup is complete (the ready state's greeting). */
  hideWhenComplete?: boolean;
} & GuideActions;

/** The guide from setup data: pure props, so it renders the same in tests and in every Eddy state. */
export function SetupGuideView(p: SetupGuideViewProps) {
  const { lang, role, data } = p;
  const headingId = useId();
  const model: GuideModel | null = data ? buildGuide(data, { lang, role }) : null;
  // Below the greeting the guide is extra: it appears once the setup is known to be unfinished, never as a spinner or an error.
  if (p.hideWhenComplete && (!model || model.complete || model.cards.length === 0)) return null;
  const [current, ...later] = model?.cards ?? [];
  // The steps asked of the owner, as the setup page counts them ("3 of 4 done"); optional ones are only in the cards below.
  const progress: ProgressStep[] = data ? data.steps.filter((s) => !s.dismissed && s.state !== "optional").map((s) => ({ id: s.id, label: stepTitle(lang, s.id), state: s.state === "done" ? "done" : s.id === data.summary.nextStepId ? "current" : "todo" })) : [];
  let body: ReactNode;
  if (p.loading && !data) body = <Spinner label={tp(lang, "panel.setup.loading")} />;
  else if (p.error && !data) {
    body = (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <span>{tp(lang, "panel.setup.failed")}</span>
        <Button type="button" variant="secondary" size="sm" className="pointer-coarse:min-h-11" onClick={p.onRetry}>
          {t(lang, "btn.retry")}
        </Button>
      </div>
    );
  } else if (!model || model.complete || !current) body = <p className="text-sm text-muted">{tp(lang, "panel.setup.complete")}</p>;
  else {
    const card = (c: GuideCard, flow: boolean) => <GuideStepCard key={c.id} card={c} lang={lang} actions={p} busy={p.busy === c.id} flow={flow} />;
    body = (
      <>
        <ProgressSteps steps={progress} lang={lang} label={tg(lang, "guides.region")} className="mb-1" />
        <div className="flex flex-col gap-3" data-guide-cards>
          {card(current, current.current)}
          {later.length > 0 && (
            <details className="group flex flex-col gap-3" data-guide-later>
              <summary className="cursor-pointer rounded-lg px-1 py-2 text-sm font-semibold text-foreground pointer-coarse:min-h-11">
                {tg(lang, "guides.more")} ({later.length})
              </summary>
              <div className="mt-2 flex flex-col gap-3">{later.map((c) => card(c, false))}</div>
            </details>
          )}
        </div>
      </>
    );
  }
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-card border border-border bg-surface p-3" data-eddy-setup data-eddy-guide lang={htmlLang(lang)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {tp(lang, "panel.setup.title")}
        </h3>
        {data && <span className="text-xs text-muted">{tp(lang, "panel.setup.progress", { done: data.summary.done, total: data.summary.asked ?? data.summary.total })}</span>}
      </div>
      {body}
    </section>
  );
}

export type SetupGuideProps = {
  lang: EddyLang;
  role: string;
  /** Eddy can chat right now (the ready state). Off states pass false: every card still works as plain buttons. */
  canChat: boolean;
  onNavigate?: (path: string) => void;
  /** Sends a message to Eddy; by default the wa:eddy-open event with the member's query. */
  onAsk?: (query: string) => void;
  hideWhenComplete?: boolean;
  className?: string;
};

/** "Skip for now": the same POST /api/setup/dismiss the Getting started page uses. Throws when it wasn't saved. */
export async function skipStep(id: StepId): Promise<void> {
  await apiFetch("/api/setup/dismiss", { method: "POST", body: { stepId: id, dismissed: true } });
}

/** The guide with its data: GET /api/setup through useSetup, and "Skip for now" through POST /api/setup/dismiss. */
export function SetupGuide({ lang, role, canChat, onNavigate, onAsk, hideWhenComplete, className }: SetupGuideProps) {
  const setup = useSetup();
  const { reload } = setup;
  const [busy, setBusy] = useState<StepId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ask = useCallback((query: string) => (onAsk ? onAsk(query) : void openEddy({ query })), [onAsk]);
  const skip = useCallback(
    async (id: StepId) => {
      setBusy(id);
      try {
        await skipStep(id);
        setNotice(tg(lang, "guides.skip.done"));
        reload();
      } catch {
        setNotice(tg(lang, "guides.skip.failed"));
      } finally {
        setBusy(null);
      }
    },
    [lang, reload],
  );
  const changed = useCallback(
    (announce?: string) => {
      if (announce) setNotice(announce);
      reload();
    },
    [reload],
  );
  const site = typeof window === "undefined" ? undefined : window.location.host;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <SetupGuideView
        lang={lang}
        role={role}
        data={setup.data ?? null}
        loading={setup.loading}
        error={setup.error}
        busy={busy}
        onRetry={reload}
        canChat={canChat}
        onAsk={ask}
        onNavigate={onNavigate}
        onSkip={skip}
        onChanged={changed}
        site={site}
        hideWhenComplete={hideWhenComplete}
      />
      <p role="status" aria-live="polite" className={notice ? "px-1 text-xs text-muted" : "sr-only"} lang={htmlLang(lang)}>
        {notice}
      </p>
    </div>
  );
}

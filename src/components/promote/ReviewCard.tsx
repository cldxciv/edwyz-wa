"use client";

/**
 * ReviewCard (docs/IG-PAGE-ADS-SPEC.md 3.3 step 4, 3.4 step 4, 6.5, 7.3, D4, D5): the review_promotion card, with the same
 * anatomy and words as Eddy's start_promotion card.
 *
 * - A verb title ("Boost your reel for 5 days?"), the facts (goal, who, where, when, budget, versions, form), then exactly what
 *   Meta will show, verbatim: the text and headline per version (clipped at 300 characters with [Show all]), the full link
 *   with its domain in bold, the button, and for chat goals the first message and quick questions. A post's caption is
 *   someone's text, shown as plain isolated text.
 * - The cost in Phase 0's words: "About ₹1,500 in total. At most ₹2,625 …", the months, and what is left.
 * - Warnings, each with an icon and its text (never colour alone).
 * - The state (running, done, failed with FixChips, changed, needs an approver, spending stopped, limits not set up, demo,
 *   not sure, waiting for the client's OK…) with its words and next steps. TypedConfirm only above the threshold.
 * The primary ("Start boost · up to ₹2,625") and "Save without starting" sit in the flow's sticky bar; useReview runs them.
 */
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Alert, buttonVariants, cn, Skeleton } from "@/components/ui";
import { promoteText } from "@/lib/promote/copy";
import type { PromoteLang } from "@/lib/promote/types";
import { useFacebookLoginPopup } from "@/components/meta-connect/useFacebookLoginPopup";
import {
  actOutcome,
  ADS_PATH,
  EDGE_WARNINGS,
  errorText,
  ownerLabel,
  SPENDING_PATH,
  isReviewCard,
  minorOf,
  needsTypedConfirm,
  PROMOTE_TEST_IDS,
  reviewView,
  startBody,
  type FixAction,
  type FixDto,
  type ReviewCardDto,
  type ReviewView,
  type StartOutcomeDto,
} from "./flow-helpers";
import { FixChips } from "./FixChips";
import { ReadinessList } from "./ReadinessList";
import { TypedConfirm } from "./TypedConfirm";
import { jsonRequest } from "./usePromoteDraft";
import { usePromoteCopy } from "./usePromoteCopy";

// =====================================================================================================================
// The controller: review, start, save without starting, fixes
// =====================================================================================================================

export type ReviewApi = {
  card: ReviewCardDto | null;
  outcome: StartOutcomeDto | null;
  loading: boolean;
  error: string | null;
  busy: "start" | "save" | "fix" | "pause" | null;
  /** When the current card appeared (the 600 ms guard starts here). */
  shownAt: number;
  typed: string;
  setTyped: (v: string) => void;
  review: () => Promise<void>;
  start: () => Promise<void>;
  savePaused: () => Promise<void>;
  applyFix: (action: Extract<FixAction, { kind: "set" | "retry" }>) => Promise<void>;
  pause: () => Promise<void>;
};

/**
 * Runs the card: POST review, POST start (with the total and worst case the card showed, its material hash and the typed figure
 * when asked), POST save-paused, and the fixes. `saveDraft` saves a fix's exact change before the review runs again.
 */
export function useReview(o: { draftId: string | null; saveDraft: (set: Record<string, unknown>) => Promise<unknown>; lang?: PromoteLang }): ReviewApi {
  const lang = o.lang ?? "en";
  const [card, setCard] = useState<ReviewCardDto | null>(null);
  const [outcome, setOutcome] = useState<StartOutcomeDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReviewApi["busy"]>(null);
  const [shownAt, setShownAt] = useState(() => Date.now());
  const [typed, setTyped] = useState("");
  const seq = useRef(0);

  const show = useCallback((next: ReviewCardDto) => {
    setCard(next);
    setShownAt(Date.now());
    setTyped("");
  }, []);

  const review = useCallback(async () => {
    if (!o.draftId) return;
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    const res = await jsonRequest("POST", `/api/promote/drafts/${encodeURIComponent(o.draftId)}/review`, { lang });
    if (id !== seq.current) return;
    setLoading(false);
    const body = res.body as { card?: unknown } | null;
    if (res.status === 200 && isReviewCard(body?.card)) {
      show(body.card);
      setOutcome(null);
    } else setError(errorText(res.body, "review.load_failed", lang));
  }, [o.draftId, lang, show]);

  useEffect(() => {
    void review();
  }, [review]);

  const act = useCallback(
    async (kind: "start" | "save") => {
      if (!o.draftId || !card || busy) return;
      setBusy(kind);
      const path = kind === "start" ? "start" : "save-paused";
      const body = kind === "start" ? startBody(card, needsTypedConfirm(card) ? typed : null) : { materialHash: card.materialHash, lang };
      const res = await jsonRequest("POST", `/api/promote/drafts/${encodeURIComponent(o.draftId)}/${path}`, body);
      setBusy(null);
      // An outcome as it came; a Start whose answer never arrived is "unknown" (no second tap, see the ad's status); a refusal
      // before the service (Start not open yet, too many starts) is its sentence, as a failure without fixes.
      const out = actOutcome(kind, res, lang);
      if ((out.state === "changed" || out.state === "typed_confirm") && isReviewCard(out.card)) show(out.card);
      setOutcome(out);
    },
    [o.draftId, card, busy, typed, lang, show],
  );

  const applyFix = useCallback(
    async (action: Extract<FixAction, { kind: "set" | "retry" }>) => {
      setBusy("fix");
      if (action.kind === "set") await o.saveDraft(action.set);
      setBusy(null);
      await review();
    },
    [o, review],
  );

  const pause = useCallback(async () => {
    const id = card?.campaignId ?? (outcome && "campaignId" in outcome ? outcome.campaignId : null);
    if (!id) return;
    setBusy("pause");
    const res = await jsonRequest("POST", `/api/ads/campaigns/${encodeURIComponent(id)}/pause`, {});
    setBusy(null);
    if (res.status >= 200 && res.status < 300) setOutcome({ state: "saved", campaignId: id, message: promoteText("review.paused", {}, lang), formCreated: false });
    else setError(errorText(res.body, "review.load_failed", lang));
  }, [card, outcome, lang]);

  return {
    card,
    outcome,
    loading,
    error,
    busy,
    shownAt,
    typed,
    setTyped,
    review,
    start: () => act("start"),
    savePaused: () => act("save"),
    applyFix,
    pause,
  };
}

// =====================================================================================================================
// The card
// =====================================================================================================================

function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" focusable="false">
      <path d="M8 2l6.5 11.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6.5v3M8 11.6v.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 7.2v4M8 4.8v.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Warnings that are about money or a stop: shown with the warning icon. The rest are notes. */
const WARN_CODES = new Set(["month_cross", "meta_limit_close", "contains_link_or_number", "needs_approval", "set_aside_from_today", "original_holds_room"]);

function LinkLine({ link, domain }: { link: string; domain: string | null }) {
  const i = domain ? link.indexOf(domain) : -1;
  if (!domain || i < 0) return <span className="break-all">{link}</span>;
  return (
    <span className="break-all">
      {link.slice(0, i)}
      <strong>{domain}</strong>
      {link.slice(i + domain.length)}
    </span>
  );
}

function VersionText({ v, showLetter, lang }: { v: ReviewCardDto["text"]["versions"][number]; showLetter: boolean; lang: PromoteLang }) {
  const t = usePromoteCopy(lang);
  const [all, setAll] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-surface p-3 text-sm">
      {showLetter && <p className="text-xs font-semibold text-muted">{t("ad.version", { letter: v.version })}</p>}
      {v.primary && (
        <p className="break-words whitespace-pre-wrap">
          <bdi>{all ? v.primary : v.primaryShort}</bdi>
        </p>
      )}
      {v.clipped && (
        <button type="button" className="min-h-11 self-start text-sm font-medium underline underline-offset-2 pointer-fine:min-h-0" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? t("review.show_less") : t("review.show_all")}
        </button>
      )}
      {v.headline && (
        <p className="font-semibold break-words">
          <bdi>{v.headline}</bdi>
        </p>
      )}
      {v.description && (
        <p className="text-muted break-words">
          <bdi>{v.description}</bdi>
        </p>
      )}
      {v.link && (
        <p className="min-w-0">
          <span className="text-muted">{t("review.link")}: </span>
          <LinkLine link={v.link} domain={v.linkDomain} />
        </p>
      )}
      {v.button && (
        <p>
          <span className="text-muted">{t("review.button")}: </span>
          {v.button}
        </p>
      )}
    </div>
  );
}

export type ReviewCardProps = {
  card: ReviewCardDto | null;
  view: ReviewView;
  loading?: boolean;
  error?: string | null;
  /** The guard's sentence after a tap inside the first 600 ms ("Check the card, then tap again."). */
  guardMessage?: string | null;
  typed: string;
  onTypedChange: (v: string) => void;
  onFix: (action: Extract<FixAction, { kind: "set" | "retry" }>, fix: FixDto) => void;
  onCheckAgain: () => void;
  onPause?: () => void;
  onSeePreviews?: () => void;
  busy?: boolean;
  isOwner: boolean;
  owner: string | null;
  tz: string;
  pageName?: string | null;
  /** The Page the ad runs from, for "Run Instagram ads using your Page" in the setup rows. */
  pageAssetId?: string | null;
  /** "Run on Facebook only" in the setup rows: saves Facebook-only places, then checks again. */
  onFacebookOnly?: () => void;
  lang?: PromoteLang;
  className?: string;
};

export function ReviewCard({ card, view, loading, error, guardMessage, typed, onTypedChange, onFix, onCheckAgain, onPause, onSeePreviews, busy, isOwner, owner, tz, pageName, pageAssetId, onFacebookOnly, lang = "en", className }: ReviewCardProps) {
  const t = usePromoteCopy(lang);
  const titleId = useId();
  const login = useFacebookLoginPopup({ onResult: () => onCheckAgain() });

  if (!card) {
    if (error) {
      return (
        <Alert tone="bad" action={<button type="button" className={cn("min-h-11 rounded-full px-4 text-sm font-semibold", buttonVariants.secondary)} onClick={onCheckAgain}>{t("review.check_again")}</button>}>
          {error}
        </Alert>
      );
    }
    return (
      <div className={cn("flex flex-col gap-3", className)} aria-busy="true">
        <p role="status" className="text-sm text-muted">
          {t("review.loading")}
        </p>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const cost = card.cost;
  const campaignHref = `${ADS_PATH}/${encodeURIComponent(card.campaignId)}`;
  const linkClass = cn("inline-flex min-h-11 max-w-full items-center justify-center rounded-full px-4 py-2 text-sm font-semibold", buttonVariants.secondary);
  const multi = card.text.versions.length > 1;

  return (
    <article role="group" aria-labelledby={titleId} aria-busy={loading || undefined} className={cn("flex min-w-0 flex-col gap-5 rounded-card border border-border bg-raised p-4 shadow-raised sm:p-5", className)} data-testid={PROMOTE_TEST_IDS.review} data-state={view.state}>
      <h3 id={titleId} className="text-lg font-semibold tracking-tight text-balance">
        {card.title}
      </h3>

      {(view.text || guardMessage) && (
        <div role="status" aria-live="polite" data-testid={PROMOTE_TEST_IDS.reviewState} data-state={view.state}>
          {view.text && (
            <Alert tone={view.tone === "neutral" ? "info" : view.tone}>
              <p className="break-words">{view.text}</p>
            </Alert>
          )}
          {guardMessage && <p className="mt-2 text-sm font-medium">{guardMessage}</p>}
        </div>
      )}

      {view.fixes.length > 0 && <FixChips fixes={view.fixes} onApply={onFix} isOwner={isOwner} owner={owner} tz={tz} busy={busy} lang={lang} />}

      {view.links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {view.links.map((l) => {
            switch (l) {
              case "pause":
                return onPause ? (
                  <button key={l} type="button" className={linkClass} onClick={onPause} disabled={busy}>
                    {t("card.pause")}
                  </button>
                ) : null;
              case "campaign":
                return (
                  <Link key={l} href={campaignHref} className={linkClass}>
                    {t("flow.see_campaign")}
                  </Link>
                );
              case "spending":
                return (
                  <Link key={l} href={SPENDING_PATH} className={linkClass}>
                    {t("fix.spending_limits")}
                  </Link>
                );
              case "ask_owner":
                return (
                  <p key={l} className="text-sm text-muted">
                    {t("review.ask_owner_note", { owner: ownerLabel(owner, lang) })}
                  </p>
                );
              case "send_for_approval":
                return (
                  <Link key={l} href={campaignHref} className={linkClass}>
                    {t("card.send_for_approval")}
                  </Link>
                );
              case "reconnect":
                return (
                  <button key={l} type="button" className={linkClass} onClick={() => login.start()}>
                    {t("readiness.reconnect")}
                  </button>
                );
              case "check_again":
                return (
                  <button key={l} type="button" className={linkClass} onClick={onCheckAgain} disabled={busy}>
                    {t("review.check_again")}
                  </button>
                );
            }
          })}
        </div>
      )}

      <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        {card.facts.map((f, i) => (
          <div key={`${f.key}-${i}`} className="contents">
            <dt className="text-muted">{f.label}</dt>
            <dd className="min-w-0 font-medium break-words">
              {f.value}
              {f.caption?.text && (
                <span className="mt-1 block font-normal text-muted">
                  <bdi>{f.caption.text.length > 120 ? `${f.caption.text.slice(0, 120)}…` : f.caption.text}</bdi>
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {(card.text.versions.some((v) => v.primary || v.headline || v.link) || card.text.firstMessage) && (
        <section className="flex min-w-0 flex-col gap-2" aria-label={t("review.what_people_see")}>
          <h4 className="text-sm font-semibold">{t("review.what_people_see")}</h4>
          {card.text.versions.map((v) => (
            <VersionText key={v.version} v={v} showLetter={multi} lang={lang} />
          ))}
          {card.text.firstMessage && (
            <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-surface p-3 text-sm">
              <p className="text-xs font-semibold text-muted">{t("chat.first_message")}</p>
              <p className="break-words">
                <bdi>{card.text.firstMessage}</bdi>
              </p>
              {card.text.quickQuestions.length > 0 && (
                <>
                  <p className="mt-1 text-xs font-semibold text-muted">{t("chat.quick_questions")}</p>
                  <ul className="flex flex-col gap-1">
                    {card.text.quickQuestions.map((q, i) => (
                      <li key={i} className="break-words">
                        <bdi>{q.title}</bdi>
                        <span className="text-muted"> → </span>
                        <bdi>{q.response}</bdi>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {onSeePreviews && (
            <button type="button" className={cn(linkClass, "self-start")} onClick={onSeePreviews}>
              {t("card.see_previews")}
            </button>
          )}
        </section>
      )}

      {cost && (
        <section className="flex min-w-0 flex-col gap-1 text-sm" aria-label={t("review.cost")} data-testid={PROMOTE_TEST_IDS.worstCase}>
          <p className="font-medium break-words">
            {cost.lines.about} {cost.lines.atMost}
          </p>
          <p className="text-muted break-words" data-testid={PROMOTE_TEST_IDS.worstCaseMonths}>
            {cost.lines.byMonth}
          </p>
          {cost.lines.left && <p className="text-muted break-words">{cost.lines.left}</p>}
        </section>
      )}

      {needsTypedConfirm(card) && view.start.visible && <TypedConfirm worstMinor={minorOf(card.worstCaseMinor)} currency={cost?.currency ?? "INR"} value={typed} onChange={onTypedChange} lang={lang} />}

      {card.readiness && card.readiness.rows.length > 0 && (
        <section className="flex min-w-0 flex-col gap-2">
          <h4 className="text-sm font-semibold">{t("goal.setup")}</h4>
          <ReadinessList rows={card.readiness.rows} onRefresh={onCheckAgain} onFacebookOnly={onFacebookOnly} pageAssetId={pageAssetId} pageName={pageName} lang={lang} />
        </section>
      )}

      {card.issues.length > 0 && (
        <section className="flex min-w-0 flex-col gap-2">
          <h4 className="text-sm font-semibold">{t("review.fix_first")}</h4>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {card.issues.map((issue, i) => (
              <li key={i} className="break-words">
                {issue}
              </li>
            ))}
          </ul>
        </section>
      )}

      {card.warnings.length > 0 && (
        <section className="flex min-w-0 flex-col gap-2" aria-label={t("review.warnings")}>
          <ul className="flex flex-col gap-2 text-sm">
            {card.warnings.map((w, i) => (
              <li
                key={`${w.code}-${i}`}
                className={cn("flex min-w-0 items-start gap-2", WARN_CODES.has(w.code) ? "text-warn-fg" : "text-muted")}
                data-warning={w.code}
                data-testid={EDGE_WARNINGS[w.code] ? PROMOTE_TEST_IDS.edge : undefined}
                data-edge={EDGE_WARNINGS[w.code]}
              >
                {WARN_CODES.has(w.code) ? <WarnIcon /> : <InfoIcon />}
                <span className="min-w-0 break-words">{w.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

export default ReviewCard;

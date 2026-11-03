"use client";

/**
 * GoalStep (docs/IG-PAGE-ADS-SPEC.md 3.3 step 2, 3.4 step 1, 3.6, 7.3, D15): what people should do after seeing the ad.
 *
 * - `cards` (a new ad): goal cards by tier, each with an icon and a one-line outcome. The simple tiles first ("Get WhatsApp
 *   chats", "Get leads with a form", "Get website visits"), then "More goals" behind a button with aria-expanded. The chosen
 *   card shows its readiness rows inline (ReadinessList) and its D15 note ("Replies happen in the Instagram app for now").
 *   All-settings goals stay in the old wizard, linked as "All settings (advanced)".
 * - `chips` (a boost): the 3.3 goal chips, pre-selected with the 3.1 goal. A goal Meta doesn't allow on a post yet keeps its
 *   chip and offers a new ad for this goal instead (3.3 edge case).
 * - Extra fields only when the goal needs them: the website link, or the first WhatsApp message with up to 3 quick questions.
 *
 * Native radio inputs carry the choice, so arrow keys move between goals and a screen reader hears "1 of 3".
 */
import Link from "next/link";
import { useId, useState } from "react";
import { buttonVariants, cn, Input } from "@/components/ui";
import type { GoalKey, PromoteLang, SourceKind } from "@/lib/promote/types";
import {
  ALL_SETTINGS_PATH,
  boostGoalChips,
  goalCards,
  goalNote,
  linkProblem,
  needsLink,
  needsWelcome,
  PROMOTE_TEST_IDS,
  type EdgeNote,
  type GoalCard,
  type WelcomeValue,
} from "./flow-helpers";
import { ReadinessList, useReadiness, type ReadinessQuery } from "./ReadinessList";
import { usePromoteCopy } from "./usePromoteCopy";
import { WelcomeMessageEditor } from "./WelcomeMessageEditor";

export type GoalStepProps = {
  variant: "cards" | "chips";
  offered: readonly GoalKey[];
  value: GoalKey | null;
  onChange: (goal: GoalKey) => void;
  /** chips: the post's source. */
  source?: Exclude<SourceKind, "new">;
  link: string;
  onLinkChange: (link: string) => void;
  welcome: WelcomeValue;
  onWelcomeChange: (welcome: WelcomeValue) => void;
  /** Show field problems (after the member tried to go on). */
  showErrors?: boolean;
  readinessQuery?: ReadinessQuery;
  onFacebookOnly?: () => void;
  pageName?: string | null;
  lang?: PromoteLang;
  className?: string;
};

const ICON_PATHS: Partial<Record<GoalKey, string>> = {
  whatsapp_chats: "M4 17l1.2-3.6A7 7 0 1110 18a7 7 0 01-3.4-.9L4 17z",
  instagram_dms: "M4 17l1.2-3.6A7 7 0 1110 18a7 7 0 01-3.4-.9L4 17z",
  messenger_chats: "M4 17l1.2-3.6A7 7 0 1110 18a7 7 0 01-3.4-.9L4 17z",
  lead_form: "M6 3h8v14H6zM8 7h4M8 10h4M8 13h2",
  website_visits: "M10 3a7 7 0 100 14 7 7 0 000-14zM3 10h14M10 3c2 2.2 2 11.8 0 14M10 3c-2 2.2-2 11.8 0 14",
  website_sales: "M4 5h2l2 8h7l2-6H7M9 17h.01M15 17h.01",
  profile_visits: "M10 10a3 3 0 100-6 3 3 0 000 6zM4 17c1-3 3.5-4.5 6-4.5s5 1.5 6 4.5",
  engagement: "M10 16s-6-3.6-6-8a3.3 3.3 0 016-1.8A3.3 3.3 0 0116 8c0 4.4-6 8-6 8z",
  video_views: "M5 4l11 6-11 6z",
  awareness: "M10 3a5 5 0 00-5 5c0 4 5 9 5 9s5-5 5-9a5 5 0 00-5-5zM10 10a2 2 0 100-4 2 2 0 000 4z",
};

function GoalIcon({ goal }: { goal: GoalKey }) {
  return (
    <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
      <svg viewBox="0 0 20 20" className="h-5 w-5" focusable="false">
        <path d={ICON_PATHS[goal] ?? ICON_PATHS.awareness} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function EdgeBox({ edge, lang }: { edge: EdgeNote; lang: PromoteLang }) {
  void lang;
  return (
    <div className="flex min-w-0 flex-col items-start gap-2 rounded-card border border-warn-line bg-warn-soft p-3 text-sm text-warn-fg" data-testid={PROMOTE_TEST_IDS.edge} data-edge={edge.code} role="status">
      <p className="break-words">{edge.text}</p>
      {edge.extra && <p className="break-words">{edge.extra}</p>}
      {edge.action && (
        <Link href={edge.action.href} className={cn("inline-flex min-h-11 max-w-full items-center rounded-full px-4 py-2 text-sm font-semibold", buttonVariants.secondary)}>
          {edge.action.label}
        </Link>
      )}
    </div>
  );
}

export function GoalStep({ variant, offered, value, onChange, source, link, onLinkChange, welcome, onWelcomeChange, showErrors = false, readinessQuery, onFacebookOnly, pageName, lang = "en", className }: GoalStepProps) {
  const t = usePromoteCopy(lang);
  const uid = useId();
  const cards = goalCards(offered, lang);
  const [moreOpen, setMoreOpen] = useState(() => !!value && cards.more.some((c) => c.key === value));
  const readiness = useReadiness(value, readinessQuery, lang);
  const linkId = `${uid}-link`;
  const linkErr = showErrors && value && needsLink(value) ? linkProblem(link, lang) : null;

  const extras =
    value && (needsLink(value) || needsWelcome(value)) ? (
      <div className="flex min-w-0 flex-col gap-4">
        {needsLink(value) && (
          <div className="flex flex-col gap-1.5" data-testid={PROMOTE_TEST_IDS.goalLink}>
            <label htmlFor={linkId} className="text-sm font-medium">
              {t("goal.link_label")}
            </label>
            <Input
              id={linkId}
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://"
              value={link}
              aria-invalid={linkErr ? true : undefined}
              aria-describedby={linkErr ? `${linkId}-hint ${linkId}-error` : `${linkId}-hint`}
              onChange={(e) => onLinkChange(e.target.value)}
            />
            <p id={`${linkId}-hint`} className="text-xs text-muted">
              {t("goal.link_hint")}
            </p>
            {linkErr && (
              <p id={`${linkId}-error`} role="alert" className="text-xs font-medium text-bad-fg">
                {linkErr}
              </p>
            )}
          </div>
        )}
        {needsWelcome(value) && <WelcomeMessageEditor value={welcome} onChange={onWelcomeChange} showErrors={showErrors} lang={lang} />}
      </div>
    ) : null;

  const readinessBlock = value ? (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-semibold">{t("goal.setup")}</h3>
      <ReadinessList rows={readiness.rows} loading={readiness.loading} error={readiness.error} onRefresh={() => void readiness.refresh()} onFacebookOnly={onFacebookOnly} pageAssetId={readinessQuery?.pageAssetId} pageName={pageName} lang={lang} />
    </div>
  ) : null;

  if (variant === "chips") {
    const chips = source ? boostGoalChips(offered, source, lang) : [];
    const chosen = chips.find((c) => c.key === value) ?? null;
    const note = value ? goalNote(value, lang) : null;
    return (
      <div className={cn("flex min-w-0 flex-col gap-5", className)}>
        <fieldset className="min-w-0">
          <legend className="sr-only">{t("goal.question")}</legend>
          <div className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <label
                key={c.key}
                data-testid={PROMOTE_TEST_IDS.goalChip}
                data-goal={c.key}
                className={cn(
                  "inline-flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-medium transition-colors duration-(--dur-fast) has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                  c.key === value ? "border-accent-ink bg-accent-soft text-accent-ink" : "border-border bg-raised text-foreground hover:bg-surface-2",
                )}
              >
                <input type="radio" name={`${uid}-goal`} value={c.key} checked={c.key === value} onChange={() => onChange(c.key)} className="sr-only" />
                {c.label}
              </label>
            ))}
          </div>
        </fieldset>
        {chosen?.edge && <EdgeBox edge={chosen.edge} lang={lang} />}
        {note && <p className="text-sm text-muted">{note}</p>}
        {!chosen?.edge && extras}
        {!chosen?.edge && readinessBlock}
      </div>
    );
  }

  const renderCard = (c: GoalCard) => {
    const on = c.key === value;
    return (
      <li key={c.key} className="min-w-0">
        <label
          data-testid={PROMOTE_TEST_IDS.goalCard}
          data-goal={c.key}
          className={cn(
            "flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-card border p-4 transition-colors duration-(--dur-fast) has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
            on ? "border-accent-ink bg-raised shadow-raised" : "border-border bg-surface hover:bg-surface-2",
          )}
        >
          <input type="radio" name={`${uid}-goal`} value={c.key} checked={on} onChange={() => onChange(c.key)} className="sr-only" />
          <GoalIcon goal={c.key} />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="font-semibold break-words">{c.title}</span>
            <span className="text-sm text-muted break-words">{c.outcome}</span>
            {c.note && <span className="text-sm text-muted break-words">{c.note}</span>}
          </span>
        </label>
        {on && (
          <div className="mt-3 flex min-w-0 flex-col gap-5 rounded-card border border-border p-4">
            {extras}
            {readinessBlock}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)}>
      <fieldset className="min-w-0">
        <legend className="sr-only">{t("goal.question")}</legend>
        <ul className="flex flex-col gap-3">{cards.simple.map(renderCard)}</ul>
        {cards.more.length > 0 && (
          <div className="mt-3 flex flex-col gap-3">
            <button
              type="button"
              aria-expanded={moreOpen}
              aria-controls={`${uid}-more`}
              onClick={() => setMoreOpen((o) => !o)}
              className="inline-flex min-h-11 items-center gap-2 self-start rounded-full px-2 text-sm font-semibold text-accent-ink hover:bg-surface-2"
            >
              <span aria-hidden>{moreOpen ? "−" : "+"}</span>
              {t("goal.more")}
            </button>
            <ul id={`${uid}-more`} hidden={!moreOpen} className="flex flex-col gap-3">
              {cards.more.map(renderCard)}
            </ul>
          </div>
        )}
      </fieldset>
      <Link href={ALL_SETTINGS_PATH} className="inline-flex min-h-11 items-center self-start text-sm font-medium underline underline-offset-2">
        {t("more.all_settings")}
      </Link>
    </div>
  );
}

export default GoalStep;

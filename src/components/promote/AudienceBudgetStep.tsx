"use client";

/**
 * AudienceBudgetStep (docs/IG-PAGE-ADS-SPEC.md 3.3 step 3, 3.4 step 3, 3.7, 3.12, 7.3, 7.5): who, where, when and how much,
 * shared by every flow.
 *
 * - AudienceCards with the size line.
 * - BudgetSteppers ("₹ per day" and "Days"), the CostLine ("About ₹1,500 in total. At most ₹2,625, because Meta can spend up
 *   to 75% more on a busy day.", debounced and announced politely) and the LimitChip ("₹1,475 left today · ₹17,900 left this
 *   month"), all from PRM-15a.
 * - "Where it shows: Automatic (recommended)" with [Change], which lists only the positions this goal and format can use,
 *   grouped by app, plus the "Instagram only" and "Facebook only" chips.
 * - More options (a button with aria-expanded, 3.12): the start date and time (in the ad account's zone), "Let Meta improve my
 *   ad", URL parameters for link goals, and the compare mode when there are versions. Days go up to 90 while it is open. With
 *   it closed, values it hides that differ from the defaults show as "2 extra settings changed · Reset".
 */
import { useId, useState } from "react";
import { Button, cn, Input } from "@/components/ui";
import { CTA_BY_GOAL } from "@/lib/promote/catalog/cta";
import { promoteText } from "@/lib/promote/copy";
import { validateRun, runDates } from "@/lib/promote/dates";
import type { AdFormat, CostView, PlacementKey, PromoteLang, PromotionDraft } from "@/lib/promote/types";
import { AudienceCards } from "./AudienceCards";
import { BudgetSteppers } from "./BudgetSteppers";
import { CostLine } from "./CostLine";
import {
  audienceHiddenScope,
  COMPARE_MODES,
  flowDefaults,
  hiddenChip,
  latestStart,
  localInputValue,
  minorOrNull,
  morePositions,
  placementSummary,
  PROMOTE_TEST_IDS,
  resetHiddenSet,
  startFromLocal,
  togglePosition,
  type FlowContext,
} from "./flow-helpers";
import { LimitChip } from "./LimitChip";
import { usePromoteCopy } from "./usePromoteCopy";

export type AudienceBudgetStepProps = {
  draft: PromotionDraft;
  onChange: (set: Record<string, unknown>) => void;
  ctx: Pick<FlowContext, "currency" | "tz" | "workspaceTz" | "minDailyMinor" | "leftTodayMinor" | "leftMonthMinor" | "shop" | "experimental" | "hasInstagram" | "country">;
  kind: "boost" | "ads";
  /** The ad's format (a boosted post is existing_post) and, for a post, whether it is a video. */
  format: AdFormat;
  mediaKind?: "image" | "video";
  lang?: PromoteLang;
  className?: string;
};

const chipClass = (on: boolean) =>
  cn("inline-flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-medium", on ? "border-accent-ink bg-accent-soft text-accent-ink" : "border-border bg-raised hover:bg-surface-2");

export function AudienceBudgetStep({ draft, onChange, ctx, kind, format, mediaKind, lang = "en", className }: AudienceBudgetStepProps) {
  const t = usePromoteCopy(lang);
  const uid = useId();
  const [moreOpen, setMoreOpen] = useState(false);
  const [placesOpen, setPlacesOpen] = useState(draft.placements.mode === "custom");
  const [view, setView] = useState<CostView | null>(null);
  const [startText, setStartText] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const versions = 1 + (draft.versions.B ? 1 : 0) + (draft.versions.C ? 1 : 0);
  const comparing = versions > 1 && draft.compare.mode !== "single";
  const leftToday = minorOrNull(ctx.leftTodayMinor);
  const leftMonth = minorOrNull(ctx.leftMonthMinor);
  const headroom = { currency: ctx.currency, today: { left: leftToday }, month: { left: leftMonth } };
  const startsAt = draft.run.startMode === "at" && draft.run.startsAt ? new Date(draft.run.startsAt) : null;
  const groups = morePositions(draft.goal, format, { hasInstagramIdentity: ctx.hasInstagram, formType: draft.formType, experimental: ctx.experimental, mediaKind }, lang);
  const valid = new Set<PlacementKey>(groups.flatMap((g) => g.positions.map((p) => p.key)));
  const chosen = draft.placements.positions.filter((k) => valid.has(k));
  const defaults = flowDefaults(draft.goal, ctx.country);
  // Only what this step hides counts (its closed More options, "People I choose" while another card is picked); the quick
  // questions and versions shown on other steps are theirs.
  const hiddenScope = audienceHiddenScope(draft, moreOpen);
  const chip = hiddenChip(draft, "simple", defaults, lang, hiddenScope);
  const apps = new Set(groups.map((g) => g.platform));
  const urlTags = CTA_BY_GOAL[draft.goal].urlTags;
  const now = new Date();

  const commitStart = (value: string) => {
    setStartText(value);
    const at = startFromLocal(value, ctx.tz);
    if (!at) {
      setStartError(promoteText("run.start_passed", {}, lang));
      return;
    }
    let endsAt: Date;
    try {
      endsAt = runDates({ runDays: draft.run.runDays, startMode: "at", startsAt: at, tz: ctx.tz, now }).endsAt;
    } catch {
      setStartError(promoteText("run.start_passed", {}, lang));
      return;
    }
    const issue = validateRun({ startMode: "at", startsAt: at, endsAt, now, tz: ctx.tz, runDays: draft.run.runDays }, lang)[0];
    setStartError(issue?.text ?? null);
    if (!issue) onChange({ "run.startMode": "at", "run.startsAt": at.toISOString() });
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-6", className)}>
      <AudienceCards audience={draft.audience} onChange={onChange} shop={ctx.shop} specialAdCategory={draft.specialAdCategory} lang={lang} />

      <section className="flex min-w-0 flex-col gap-3" aria-labelledby={`${uid}-money`}>
        <h3 id={`${uid}-money`} className="text-sm font-semibold">
          {t("card.fact.budget")}
        </h3>
        <BudgetSteppers
          dailyMinor={draft.budget.dailyMinor}
          onDailyChange={(minor) => onChange({ "budget.dailyMinor": minor })}
          days={draft.run.runDays}
          onDaysChange={(days) => onChange({ "run.runDays": days })}
          currency={ctx.currency}
          minDailyMinor={minorOrNull(ctx.minDailyMinor)}
          moreDays={moreOpen}
          lang={lang}
        />
        {comparing && <p className="text-sm text-muted">{t("version.fair")}</p>}
        <div data-testid={PROMOTE_TEST_IDS.worstCase}>
          <CostLine
            dailyMinor={draft.budget.dailyMinor}
            versions={comparing ? versions : 1}
            runDays={draft.run.runDays}
            startMode={draft.run.startMode}
            startsAt={startsAt}
            tz={ctx.tz}
            currency={ctx.currency}
            headroom={headroom}
            kind={kind}
            lang={lang}
            showMonthCross
            onView={setView}
          />
        </div>
        {view && <LimitChip leftTodayMinor={view.leftTodayMinor} leftMonthMinor={view.leftMonthMinor} currency={ctx.currency} lang={lang} className="self-start" />}
      </section>

      <section className="flex min-w-0 flex-col gap-3" aria-labelledby={`${uid}-where`} data-testid={PROMOTE_TEST_IDS.placements}>
        <h3 id={`${uid}-where`} className="sr-only">
          {t("placement.legend")}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 text-sm font-medium break-words">{placementSummary(draft.placements.mode, chosen, lang)}</p>
          <Button type="button" variant="ghost" className="pointer-coarse:min-h-11" aria-expanded={placesOpen} aria-controls={`${uid}-places`} onClick={() => setPlacesOpen((o) => !o)}>
            {t("placement.change")}
          </Button>
        </div>
        <div id={`${uid}-places`} hidden={!placesOpen} className="flex min-w-0 flex-col gap-4 rounded-card border border-border p-4">
          <div role="group" aria-label={t("placement.legend")} className="flex flex-wrap gap-2">
            <button type="button" aria-pressed={draft.placements.mode === "auto"} className={chipClass(draft.placements.mode === "auto")} onClick={() => onChange({ "placements.mode": "auto", "placements.positions": [] })}>
              {t("placement.use_auto")}
            </button>
            {apps.has("instagram") && (
              <button type="button" aria-pressed={draft.placements.mode === "instagram"} className={chipClass(draft.placements.mode === "instagram")} onClick={() => onChange({ "placements.mode": "instagram", "placements.positions": [] })}>
                {t("placement.instagram_only")}
              </button>
            )}
            {apps.has("facebook") && (
              <button type="button" aria-pressed={draft.placements.mode === "facebook"} className={chipClass(draft.placements.mode === "facebook")} onClick={() => onChange({ "placements.mode": "facebook", "placements.positions": [] })}>
                {t("placement.facebook_only")}
              </button>
            )}
          </div>
          <p className="text-xs text-muted">{t("placement.choose_note")}</p>
          {groups.map((g) => (
            <fieldset key={g.platform} className="flex min-w-0 flex-col gap-1">
              <legend className="text-sm font-semibold">{g.label}</legend>
              {g.positions.map((p) => (
                <label key={p.key} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                  <input type="checkbox" className="h-5 w-5 shrink-0 accent-accent" checked={draft.placements.mode === "custom" && chosen.includes(p.key)} onChange={(e) => onChange(togglePosition(draft.placements.mode === "custom" ? chosen : [], p.key, e.target.checked))} />
                  {p.label}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </section>

      <section className="flex min-w-0 flex-col gap-3" data-testid={PROMOTE_TEST_IDS.more}>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-expanded={moreOpen}
            aria-controls={`${uid}-more`}
            onClick={() => setMoreOpen((o) => !o)}
            className="inline-flex min-h-11 items-center gap-2 rounded-full px-2 text-sm font-semibold text-accent-ink hover:bg-surface-2"
          >
            <span aria-hidden>{moreOpen ? "−" : "+"}</span>
            {t("more.title")}
          </button>
          {chip && (
            <span className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-surface px-3 py-1 text-xs" data-testid={PROMOTE_TEST_IDS.hiddenChip}>
              <span>{chip.label}</span>
              <span aria-hidden>·</span>
              <button type="button" className="min-h-11 px-1 font-semibold underline underline-offset-2 pointer-fine:min-h-0" onClick={() => onChange(resetHiddenSet(draft, "simple", defaults, hiddenScope))}>
                {t("chips.reset")}
              </button>
            </span>
          )}
        </div>
        <div id={`${uid}-more`} hidden={!moreOpen} className="flex min-w-0 flex-col gap-5 rounded-card border border-border p-4">
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="text-sm font-semibold">{t("more.start")}</legend>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <input type="radio" name={`${uid}-start`} className="h-4 w-4 accent-accent" checked={draft.run.startMode === "now"} onChange={() => onChange({ "run.startMode": "now", "run.startsAt": null })} />
              {t("run.start_now")}
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <input
                type="radio"
                name={`${uid}-start`}
                className="h-4 w-4 accent-accent"
                checked={draft.run.startMode === "at"}
                onChange={() => commitStart(startText ?? localInputValue(new Date(now.getTime() + 86_400_000), ctx.tz))}
              />
              {t("more.start_later")}
            </label>
            {draft.run.startMode === "at" && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${uid}-start-at`} className="text-sm font-medium">
                  {t("more.start_date")}
                </label>
                <Input
                  id={`${uid}-start-at`}
                  type="datetime-local"
                  min={localInputValue(now, ctx.tz)}
                  max={localInputValue(latestStart(now), ctx.tz)}
                  value={startText ?? (startsAt ? localInputValue(startsAt, ctx.tz) : "")}
                  aria-invalid={startError ? true : undefined}
                  aria-describedby={startError ? `${uid}-start-hint ${uid}-start-error` : `${uid}-start-hint`}
                  onChange={(e) => commitStart(e.target.value)}
                />
                <p id={`${uid}-start-hint`} className="text-xs text-muted">
                  {t("more.start_hint", { zone: ctx.tz })}
                </p>
                {startError && (
                  <p id={`${uid}-start-error`} role="alert" className="text-xs font-medium text-bad-fg">
                    {startError}
                  </p>
                )}
              </div>
            )}
          </fieldset>

          <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-accent" checked={draft.enhancementsOptIn} onChange={(e) => onChange({ enhancementsOptIn: e.target.checked })} aria-describedby={`${uid}-improve`} />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="font-medium">{t("more.improve_my_ad")}</span>
              <span id={`${uid}-improve`} className="text-xs text-muted">
                {t("more.improve_note")}
              </span>
            </span>
          </label>

          {urlTags && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${uid}-utm`} className="text-sm font-medium">
                {t("more.url_params")}
              </label>
              <Input id={`${uid}-utm`} value={draft.urlTags ?? ""} maxLength={500} aria-describedby={`${uid}-utm-hint`} onChange={(e) => onChange({ urlTags: e.target.value.trim() ? e.target.value : null })} />
              <p id={`${uid}-utm-hint`} className="text-xs text-muted">
                {t("more.url_hint")}
              </p>
            </div>
          )}

          {versions > 1 && (
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="text-sm font-semibold">{t("more.compare")}</legend>
              {COMPARE_MODES.map((m) => (
                <label key={m} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                  <input type="radio" name={`${uid}-compare`} className="h-4 w-4 accent-accent" checked={draft.compare.mode === m} onChange={() => onChange({ "compare.mode": m })} />
                  {t(m === "fair_split" ? "more.compare_fair" : "version.meta_picks")}
                </label>
              ))}
            </fieldset>
          )}
        </div>
      </section>
    </div>
  );
}

export default AudienceBudgetStep;

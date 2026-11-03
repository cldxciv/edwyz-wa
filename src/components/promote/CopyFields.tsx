"use client";

/**
 * CopyFields (docs/IG-PAGE-ADS-SPEC.md 3.4 step 2, 4.6, 7.3, 7.6): the ad text, the headline and (carousels) the
 * description.
 *
 * - Visible-length counters per placement, from catalog/formats: Instagram 125 and 40, Facebook 50 and 27, Stories 125,
 *   Reels 44, carousel 80, 20 and 18. Past one, the counter turns amber: the text still runs, cut at "… more".
 * - Any Instagram placement turns on the hard stop at 2,200 characters, with the one-tap fix "Shorten to 2,200 characters
 *   for Instagram" (grapheme-safe), and the 30-hashtag counter; the 31st hashtag and later are named so they can be removed.
 * - Counting is by grapheme (Intl.Segmenter), so Devanagari counts as people see it; Devanagari text gets a 1.1x line height.
 * - Counters are linked to their field with aria-describedby; the stops are announced through Alert.
 */
import { useId, type ReactNode } from "react";
import { Alert, Button, cn, Input, Textarea } from "@/components/ui";
import { promoteText } from "@/lib/promote/copy";
import type { AdFormat, PlacementKey, PromoteLang } from "@/lib/promote/types";
import { copyCheck, hasDevanagari, shortenForInstagram, type CopyValue, type CounterRow } from "./creative-helpers";

export const COPY_TEST_IDS = {
  root: "copy-fields",
  primary: "copy-primary",
  headline: "copy-headline",
  description: "copy-description",
  counters: "copy-counters",
  shorten: "copy-shorten",
  hashtags: "copy-hashtags",
} as const;

export type CopyFieldsProps = {
  value: CopyValue;
  onChange: (value: CopyValue) => void;
  /** The chosen positions; empty means Automatic. */
  placements: readonly PlacementKey[];
  /** The ad runs with an Instagram account (Automatic then includes Instagram). */
  hasInstagramIdentity: boolean;
  format?: AdFormat;
  showHeadline?: boolean;
  showDescription?: boolean;
  disabled?: boolean;
  lang?: PromoteLang;
  className?: string;
};

function Counters({ id, rows, extra, testId }: { id: string; rows: CounterRow[]; extra?: ReactNode; testId?: string }) {
  if (rows.length === 0 && !extra) return null;
  return (
    <ul id={id} className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums" data-testid={testId}>
      {rows.map((r) => (
        <li key={r.id} className={r.over ? "font-medium text-warn-fg" : "text-muted"} data-over={r.over || undefined}>
          {r.text}
        </li>
      ))}
      {extra}
    </ul>
  );
}

export function CopyFields({ value, onChange, placements, hasInstagramIdentity, format, showHeadline = true, showDescription = false, disabled, lang = "en", className }: CopyFieldsProps) {
  const uid = useId();
  const ids = {
    primary: `${uid}-primary`,
    primaryCounters: `${uid}-primary-counters`,
    primaryProblems: `${uid}-primary-problems`,
    headline: `${uid}-headline`,
    headlineCounters: `${uid}-headline-counters`,
    description: `${uid}-description`,
    descriptionCounters: `${uid}-description-counters`,
  };
  const fields = { primary: value.primary, headline: value.headline, ...(showDescription ? { description: value.description ?? "" } : {}) };
  const check = copyCheck(fields, placements, { hasInstagramIdentity, format, lang });
  const rowsFor = (field: CounterRow["field"]) => check.counters.filter((c) => c.field === field);
  const tags = check.hashtags;

  const igExtra = check.instagram ? (
    <>
      <li className={check.instagramLength.over ? "font-medium text-bad-fg" : "text-muted"}>{promoteText("copy.ig_limit", { count: check.instagramLength.count, max: check.instagramLength.max }, lang)}</li>
      <li className={tags.over ? "font-medium text-bad-fg" : "text-muted"} data-testid={COPY_TEST_IDS.hashtags}>
        {promoteText("copy.hashtags", { count: tags.count, max: tags.max }, lang)}
      </li>
    </>
  ) : null;

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)} data-testid={COPY_TEST_IDS.root}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.primary} className="text-sm font-medium">
          {promoteText("copy.primary", {}, lang)}
        </label>
        <Textarea
          id={ids.primary}
          rows={4}
          value={value.primary}
          disabled={disabled}
          aria-describedby={`${ids.primaryCounters} ${ids.primaryProblems}`}
          aria-invalid={check.blocked || undefined}
          className={cn(hasDevanagari(value.primary) && "leading-[1.65]")}
          onChange={(e) => onChange({ ...value, primary: e.target.value })}
          data-testid={COPY_TEST_IDS.primary}
        />
        <Counters id={ids.primaryCounters} rows={rowsFor("primary")} extra={igExtra} testId={COPY_TEST_IDS.counters} />
        <div id={ids.primaryProblems} className="flex flex-col gap-2">
          {check.problems.map((p) => (
            <Alert
              key={p.code}
              tone="bad"
              action={
                p.fix ? (
                  <Button type="button" size="sm" variant="secondary" className="pointer-coarse:min-h-11" onClick={() => onChange({ ...value, primary: shortenForInstagram(value.primary) })} data-testid={COPY_TEST_IDS.shorten}>
                    {p.fix.label}
                  </Button>
                ) : undefined
              }
            >
              <p>{p.text}</p>
              {p.code === "too_many_hashtags" && tags.flagged.length > 0 && <p className="mt-1 break-words">{promoteText("copy.hashtags_remove", { tags: tags.flagged.join(" ") }, lang)}</p>}
            </Alert>
          ))}
        </div>
      </div>

      {showHeadline && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.headline} className="text-sm font-medium">
            {promoteText("copy.headline", {}, lang)}
          </label>
          <Input
            id={ids.headline}
            value={value.headline}
            disabled={disabled}
            autoComplete="off"
            aria-describedby={ids.headlineCounters}
            className={cn(hasDevanagari(value.headline) && "leading-[1.65]")}
            onChange={(e) => onChange({ ...value, headline: e.target.value })}
            data-testid={COPY_TEST_IDS.headline}
          />
          <Counters id={ids.headlineCounters} rows={rowsFor("headline")} />
        </div>
      )}

      {showDescription && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.description} className="text-sm font-medium">
            {promoteText("copy.description", {}, lang)}
          </label>
          <Input
            id={ids.description}
            value={value.description ?? ""}
            disabled={disabled}
            autoComplete="off"
            aria-describedby={ids.descriptionCounters}
            onChange={(e) => onChange({ ...value, description: e.target.value })}
            data-testid={COPY_TEST_IDS.description}
          />
          <Counters id={ids.descriptionCounters} rows={rowsFor("description")} />
        </div>
      )}
    </div>
  );
}

export default CopyFields;

"use client";

/**
 * ResultsByPlacement (docs/IG-PAGE-ADS-SPEC.md 3.10, 7.3, D24; PRM-15b): the Results tabs of the campaign page, each read
 * from GET /api/ads/insights/dimensions (stored rows, no Meta call) only when its tab is opened, over the run's days
 * (`range`, from results-helpers.resultsRange: the route refuses a request without from and to).
 *
 * - Overview: spent, results, cost per result, people reached over the whole run (the run total, never a sum of days), and
 *   "clicks per 100 views" and "cost per 1,000 views".
 * - Where it worked: placements sorted by cost per result, "Instagram Reels: 46 chats, ₹31 each"; an unknown position shows
 *   Meta's raw key.
 * - Which version worked: per ad and per part of the ad, with the compare verdict (CompareVersions).
 * - Who saw it: age and gender, and region.
 * - Leads: "Leads from this ad: 23 (Instagram 17, Facebook 6)", or Meta's own split labelled "From Meta's report".
 * Bars carry their text value, so colour is never the only signal. Boosted posts say "Free (organic) numbers need an extra
 * Meta permission that Edwyz hasn't asked for." (paid results only, D24).
 */
import { useId, useState } from "react";
import { Alert, Button, Skeleton, Stat, Tabs, cn } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { CompareVersions, ResultBars, type ComparisonLite } from "./CompareVersions";
import { RESULTS_TEXT, RESULT_TABS, leadsLine, overviewTiles, resultBars, resultsPath, type LeadsLite, type OverviewLite, type ResultRowLite, type ResultsRange, type ResultTabId } from "./results-helpers";

export const RESULTS_TEST_ID = "results-by-placement";

type Dimension = "overview" | "placement" | "creative" | "age_gender" | "region" | "leads";

/** The dimensions route's answer (DimensionResult), as far as the tabs read it. */
type DimensionLite = {
  resultNoun?: string;
  rows: ResultRowLite[];
  assets?: (ResultRowLite & { kind?: string })[];
  overview?: OverviewLite;
  leads?: LeadsLite & { ads?: (LeadsLite & { adMetaId: string; name: string })[] };
  notes?: string[];
  compare?: ComparisonLite | null;
};

export type ResultsByPlacementProps = {
  campaignId: string;
  /** The run's days, ad-account-local (results-helpers.resultsRange). */
  range: ResultsRange;
  /** A boosted post (an existing Facebook or Instagram post): paid results only, with the note. */
  boosted?: boolean;
  /** Owners and admins: [Keep …] in the compare card. */
  canWrite?: boolean;
  onChanged?: () => void;
  className?: string;
};

/** One tab's request. The path is a string, so a new range object with the same days doesn't ask again. */
type TabProps = { campaignId: string; range: ResultsRange };

function useDimension({ campaignId, range }: TabProps, dimension: Dimension) {
  return useApi<DimensionLite>(resultsPath(campaignId, dimension, range));
}

function Loading() {
  return (
    <div aria-busy="true" className="space-y-2">
      <span className="sr-only" role="status">
        {RESULTS_TEXT.loading}
      </span>
      <Skeleton className="h-5 w-56" />
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-2 w-full" />
    </div>
  );
}

function Failed({ retry }: { retry: () => void }) {
  return (
    <Alert tone="warn" action={<Button size="sm" variant="secondary" onClick={retry}>{RESULTS_TEXT.retry}</Button>}>
      {RESULTS_TEXT.failed}
    </Alert>
  );
}

/** The tab's own notes, without the organic note the card already shows once. */
function Notes({ notes }: { notes?: readonly string[] }) {
  const list = (notes ?? []).filter((n) => n && n !== RESULTS_TEXT.organicNote);
  if (list.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs text-muted">
      {list.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

function Overview(tab: TabProps) {
  const { data, error, loading, retry } = useDimension(tab, "overview");
  if (loading && !data) return <Loading />;
  if (error && !data) return <Failed retry={retry} />;
  const o = data?.overview;
  return (
    <div className="space-y-3" data-testid="results-overview">
      {o && (
        <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-3">
          {overviewTiles(o).map((t) => (
            <Stat key={t.key} label={t.label} value={<span data-testid={`results-overview-${t.key}`}>{t.value}</span>} />
          ))}
        </div>
      )}
      <Notes notes={data?.notes} />
    </div>
  );
}

function Breakdown({ campaignId, range, dimension, label, placements }: TabProps & { dimension: "placement" | "age_gender" | "region"; label: string; placements?: boolean }) {
  const { data, error, loading, retry } = useDimension({ campaignId, range }, dimension);
  if (loading && !data) return <Loading />;
  if (error && !data) return <Failed retry={retry} />;
  const bars = resultBars(data?.rows ?? [], { placements });
  return (
    <div className="space-y-3" data-testid={`results-${dimension}`}>
      {bars.length > 0 ? <ResultBars rows={bars} label={label} /> : null}
      <Notes notes={data?.notes} />
    </div>
  );
}

function Versions({ campaignId, range, canWrite, onChanged }: TabProps & { canWrite?: boolean; onChanged?: () => void }) {
  const { data, error, loading, retry, reload } = useDimension({ campaignId, range }, "creative");
  if (loading && !data) return <Loading />;
  if (error && !data) return <Failed retry={retry} />;
  const ads = resultBars(data?.rows ?? []);
  const assets = resultBars(data?.assets ?? []);
  return (
    <div className="space-y-4" data-testid="results-creative">
      {data?.compare ? (
        <CompareVersions
          comparison={data.compare}
          canWrite={canWrite}
          onChanged={() => {
            reload();
            onChanged?.();
          }}
        />
      ) : (
        ads.length > 0 && <ResultBars rows={ads} label={RESULT_TABS[2].label} />
      )}
      {assets.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{RESULTS_TEXT.assets}</h3>
          <ResultBars rows={assets} label={RESULTS_TEXT.assets} />
        </div>
      )}
      <Notes notes={data?.notes} />
    </div>
  );
}

function Who({ campaignId, range }: TabProps) {
  return (
    <div className="space-y-5" data-testid="results-who">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{RESULTS_TEXT.ageGender}</h3>
        <Breakdown campaignId={campaignId} range={range} dimension="age_gender" label={RESULTS_TEXT.ageGender} />
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{RESULTS_TEXT.region}</h3>
        <Breakdown campaignId={campaignId} range={range} dimension="region" label={RESULTS_TEXT.region} />
      </div>
    </div>
  );
}

function Leads(tab: TabProps) {
  const { data, error, loading, retry } = useDimension(tab, "leads");
  if (loading && !data) return <Loading />;
  if (error && !data) return <Failed retry={retry} />;
  const l = data?.leads;
  if (!l) return <Notes notes={data?.notes} />;
  const line = leadsLine(l);
  return (
    <div className="space-y-3" data-testid="results-leads">
      <p className="text-sm font-medium" data-testid="results-leads-line">
        {line.text}
      </p>
      {line.note && <p className="text-xs text-muted">{line.note}</p>}
      {(l.ads?.length ?? 0) > 1 && (
        <ul className="space-y-1 text-sm">
          {l.ads!.map((a) => (
            <li key={a.adMetaId} className="break-words">
              <span className="font-medium">{a.name}</span>: {leadsLine(a).text}
            </li>
          ))}
        </ul>
      )}
      {line.platformNote && <p className="text-xs text-muted">{line.platformNote}</p>}
      <Notes notes={data?.notes} />
    </div>
  );
}

export function ResultsByPlacement({ campaignId, range, boosted, canWrite, onChanged, className }: ResultsByPlacementProps) {
  const headingId = useId();
  const [tab, setTab] = useState<ResultTabId>("overview");
  const panel = (id: ResultTabId) => {
    switch (id) {
      case "overview":
        return <Overview campaignId={campaignId} range={range} />;
      case "placement":
        return <Breakdown campaignId={campaignId} range={range} dimension="placement" label={RESULT_TABS[1].label} placements />;
      case "creative":
        return <Versions campaignId={campaignId} range={range} canWrite={canWrite} onChanged={onChanged} />;
      case "who":
        return <Who campaignId={campaignId} range={range} />;
      case "leads":
        return <Leads campaignId={campaignId} range={range} />;
    }
  };
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0 space-y-3", className)} data-testid={RESULTS_TEST_ID}>
      <h2 id={headingId} className="text-base font-semibold tracking-tight">
        {RESULTS_TEXT.heading}
      </h2>
      {boosted && (
        <p className="text-xs text-muted" data-testid="results-organic-note">
          {RESULTS_TEXT.organicNote}
        </p>
      )}
      <Tabs
        label={RESULTS_TEXT.heading}
        value={tab}
        onChange={(id) => setTab(id as ResultTabId)}
        variant="pill"
        tabs={RESULT_TABS.map((t) => ({ id: t.id, label: t.label, content: panel(t.id) }))}
      />
    </section>
  );
}

export default ResultsByPlacement;

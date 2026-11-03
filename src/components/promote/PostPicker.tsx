"use client";

/**
 * PostPicker (docs/IG-PAGE-ADS-SPEC.md 3.3 step 1, 7.3, 8.3a): pick the post to boost.
 *
 * - Tabs Reels, Posts, Stories and Facebook, as the sources route offers them; a Page-backed identity has no Instagram tabs.
 * - A grid of 3 columns on phones and 5 on desktop, newest first, 25 at a time, loading more as the end comes into view (and
 *   with a [Show more posts] button, which keyboards and slow phones can use).
 * - Each tile: the thumbnail, a type badge, a ₹ badge for posts already boosted and "Made in Edwyz". Posts Meta won't boost
 *   are greyed out with the reason in plain words; picking one shows "Make a new ad instead".
 * - The grid is one radio group with a roving tabindex: arrows move by one or a row, Home and End to the ends, Space or Enter
 *   picks. Each tile's accessible name is "Reel from 21 Oct: 'Diwali offer…', can be boosted".
 * - "Also show on Facebook" (or on Instagram) is on when Meta says the post can run there.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Badge, Button, cn, Select, Skeleton, Tabs } from "@/components/ui";
import type { BoostableItem, SourceTab, SourcesResult } from "@/lib/promote/sources";
import type { GoalKey, PromoteLang } from "@/lib/promote/types";
import {
  alsoShowDefault,
  errorText,
  gridMove,
  mergeItems,
  PICKER_COLUMNS,
  postEdge,
  PROMOTE_TEST_IDS,
  sourcesHref,
  TAB_KEYS,
  tileName,
  tileState,
  visibleTabs,
} from "./flow-helpers";
import { jsonRequest } from "./usePromoteDraft";
import { usePromoteCopy } from "./usePromoteCopy";

export type PostPick = { item: BoostableItem; identity: SourcesResult["identity"]; alsoOtherApp: boolean };

export type PostPickerProps = {
  value: PostPick | null;
  onChange: (pick: PostPick | null) => void;
  /** Pre-select this post (/app/ads/boost?source=&id=). */
  initial?: { source: "instagram" | "facebook" | null; id: string | null };
  /** The goal the member came with, for "Make a new ad instead". */
  goal?: GoalKey | null;
  /** The ad account's zone, for the dates in the accessible names (D30). */
  tz: string;
  lang?: PromoteLang;
  className?: string;
};

type Loaded = { tab: SourceTab | null; items: BoostableItem[]; cursor: string | null; result: SourcesResult | null };

/** 5 columns from the desktop breakpoint, 3 below it (matches the grid's classes). */
function useColumns(): number {
  const [cols, setCols] = useState<number>(PICKER_COLUMNS.phone);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const set = () => setCols(mq.matches ? PICKER_COLUMNS.desktop : PICKER_COLUMNS.phone);
    set();
    mq.addEventListener?.("change", set);
    return () => mq.removeEventListener?.("change", set);
  }, []);
  return cols;
}

function KindIcon({ kind }: { kind: BoostableItem["kind"] }) {
  const d = kind === "reel" ? "M4 3h12v14H4zM8 7.5l4.5 2.5L8 12.5z" : kind === "story" ? "M10 3a7 7 0 110 14 7 7 0 010-14z" : "M4 4h12v12H4zM4 13l4-4 3 3 2-2 3 3";
  return (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function PostPicker({ value, onChange, initial, goal = null, tz, lang = "en", className }: PostPickerProps) {
  const t = usePromoteCopy(lang);
  const uid = useId();
  const columns = useColumns();
  const [loaded, setLoaded] = useState<Loaded>({ tab: null, items: [], cursor: null, result: null });
  const [page, setPage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);
  const wantInitial = useRef(initial?.id ?? null);

  const fetchPage = useCallback(
    async (tab: SourceTab, cursor: string | null, pageAssetId: string | null): Promise<void> => {
      const id = ++seq.current;
      setLoading(true);
      setError(null);
      const res = await jsonRequest("GET", sourcesHref(tab, { cursor, pageAssetId }));
      if (id !== seq.current) return;
      setLoading(false);
      const body = res.body as SourcesResult | null;
      if (res.status !== 200 || !body || !Array.isArray(body.items)) {
        setError(errorText(res.body, "media.picker.load_failed", lang));
        return;
      }
      const tabs = visibleTabs(body);
      // A tab this identity doesn't have (Instagram's, for a Page-backed identity): ask for the first one it does.
      if (!tabs.includes(tab) && tabs.length) {
        void fetchPage(tabs[0], null, pageAssetId);
        return;
      }
      const want = wantInitial.current;
      // The post the page was opened for may be on another Instagram tab: look there before showing this one.
      if (want && !cursor && !body.items.some((i) => i.id === want || i.promotableId === want)) {
        const next = tabs[tabs.indexOf(tab) + 1];
        if (next && next !== "facebook") {
          void fetchPage(next, null, pageAssetId);
          return;
        }
        wantInitial.current = null;
      }
      setLoaded((prev) => ({ tab, items: cursor ? mergeItems(prev.items, body.items) : body.items, cursor: body.cursor, result: body }));
    },
    [lang],
  );

  useEffect(() => {
    void fetchPage(initial?.source === "facebook" ? "facebook" : "reels", null, null);
    // Once, on open; tab and page changes load through their handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-select the post the page was opened for, once it is on the list.
  useEffect(() => {
    const want = wantInitial.current;
    if (!want || !loaded.result) return;
    const item = loaded.items.find((i) => i.id === want || i.promotableId === want);
    if (item) {
      wantInitial.current = null;
      onChange({ item, identity: loaded.result.identity, alsoOtherApp: alsoShowDefault(item) });
    }
  }, [loaded, onChange]);

  // Infinite scroll: the next 25 when the end of the grid comes into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined" || !loaded.cursor) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loading && loaded.cursor && loaded.tab) void fetchPage(loaded.tab, loaded.cursor, page);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loaded.cursor, loaded.tab, loading, page, fetchPage]);

  const tabs = loaded.result ? visibleTabs(loaded.result) : [];
  const items = loaded.items;
  const selectedId = value ? `${value.item.app}:${value.item.id}` : null;
  const activeIndex = Math.min(focus, Math.max(0, items.length - 1));

  const pick = (item: BoostableItem) => {
    if (!loaded.result) return;
    onChange({ item, identity: loaded.result.identity, alsoOtherApp: alsoShowDefault(item) });
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = gridMove(activeIndex, e.key, items.length, columns);
    if (next === null) return;
    e.preventDefault();
    setFocus(next);
    tiles.current[next]?.focus();
  };

  const grid = (
    <div className="flex min-w-0 flex-col gap-3">
      {loaded.result?.note && <p className="text-sm text-muted">{loaded.result.note}</p>}
      {loaded.result?.needsPageChoice && loaded.result.pages.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-page`} className="text-sm font-medium">
            {t("picker.page")}
          </label>
          <Select
            id={`${uid}-page`}
            value={page ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              setPage(id);
              void fetchPage(loaded.tab ?? "facebook", null, id);
            }}
          >
            <option value="">{t("picker.page_hint")}</option>
            {loaded.result.pages.map((p) => (
              <option key={p.assetId} value={p.assetId}>
                {p.name ?? p.assetId}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div
        role="radiogroup"
        aria-label={t("flow.step.post")}
        aria-busy={loading || undefined}
        onKeyDown={onGridKey}
        className="grid grid-cols-3 gap-2 lg:grid-cols-5"
        data-testid={PROMOTE_TEST_IDS.postGrid}
      >
        {items.map((item, i) => {
          const state = tileState(item, lang);
          const on = `${item.app}:${item.id}` === selectedId;
          return (
            <button
              key={`${item.app}:${item.id}`}
              ref={(el) => {
                tiles.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={tileName(item, tz, lang)}
              tabIndex={i === activeIndex ? 0 : -1}
              onFocus={() => setFocus(i)}
              onClick={() => pick(item)}
              data-testid={PROMOTE_TEST_IDS.postTile}
              data-eligibility={item.eligibility}
              className={cn(
                "relative aspect-square min-h-11 min-w-0 overflow-hidden rounded-md border-2 bg-surface-2 transition-colors duration-(--dur-fast)",
                on ? "border-accent-ink" : "border-transparent hover:border-border-strong",
                state.tone === "no" && "opacity-50 grayscale",
              )}
            >
              {item.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
              ) : (
                <span aria-hidden className="flex h-full w-full items-center justify-center text-muted">
                  <KindIcon kind={item.kind} />
                </span>
              )}
              <span aria-hidden className="absolute top-1 left-1 flex items-center rounded-full bg-raised/90 p-1 text-foreground">
                <KindIcon kind={item.kind} />
              </span>
              {item.boosted && (
                <span aria-hidden className="absolute top-1 right-1 rounded-full bg-raised/90 px-1.5 text-xs font-semibold text-foreground" title={t("boost.boosted")}>
                  ₹
                </span>
              )}
              {item.madeInEdwyz && (
                <span aria-hidden className="absolute inset-x-1 bottom-1 truncate rounded-full bg-raised/90 px-1.5 text-center text-xs text-foreground">
                  {t("boost.made_in_edwyz")}
                </span>
              )}
              {on && (
                <span aria-hidden className="absolute right-1 bottom-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-on-accent">
                  <svg viewBox="0 0 16 16" className="h-3 w-3" focusable="false">
                    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              )}
            </button>
          );
        })}
        {loading &&
          Array.from({ length: items.length ? columns : columns * 2 }, (_, i) => <Skeleton key={`s${i}`} className="aspect-square h-auto w-full" />)}
      </div>
      {loading && <p role="status" className="sr-only">{t("picker.loading")}</p>}
      {!loading && !error && items.length === 0 && loaded.result && <p className="text-sm text-muted">{t("picker.empty")}</p>}
      {error && (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-sm text-bad-fg">{error}</p>
          <Button type="button" variant="secondary" className="pointer-coarse:min-h-11" onClick={() => void fetchPage(loaded.tab ?? "reels", loaded.cursor, page)}>
            {t("media.picker.retry")}
          </Button>
        </div>
      )}
      <div ref={sentinel} aria-hidden className="h-px" />
      {loaded.cursor && !loading && (
        <Button type="button" variant="secondary" className="self-center pointer-coarse:min-h-11" onClick={() => loaded.tab && void fetchPage(loaded.tab, loaded.cursor, page)} data-testid={PROMOTE_TEST_IDS.postMore}>
          {t("picker.more")}
        </Button>
      )}
    </div>
  );

  const edge = value ? postEdge(value.item, goal, lang) : null;
  const also = value?.item.alsoShowOn;

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)}>
      {tabs.length > 1 ? (
        <Tabs
          variant="pill"
          label={t("picker.tabs")}
          value={loaded.tab ?? tabs[0]}
          onChange={(id) => {
            setFocus(0);
            void fetchPage(id as SourceTab, null, page);
          }}
          tabs={tabs.map((id) => ({ id, label: t(TAB_KEYS[id]), content: id === loaded.tab ? grid : null }))}
        />
      ) : (
        grid
      )}

      {value && (
        <div className="flex min-w-0 flex-col gap-3 rounded-card border border-border p-3" aria-live="polite">
          <p className="text-sm font-medium break-words">{tileName(value.item, tz, lang)}</p>
          {value.item.boosted && <Badge tone="info">{t("boost.boosted")}</Badge>}
          {edge ? (
            <div className="flex flex-col items-start gap-2 rounded-card border border-warn-line bg-warn-soft p-3 text-sm text-warn-fg" data-testid={PROMOTE_TEST_IDS.edge} data-edge={edge.code}>
              <p className="break-words">{edge.text}</p>
              {edge.extra && <p className="break-words">{edge.extra}</p>}
              {edge.action && (
                <a href={edge.action.href} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
                  {edge.action.label}
                </a>
              )}
            </div>
          ) : (
            also &&
            also.eligible !== false && (
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                <input type="checkbox" className="h-5 w-5 shrink-0 accent-accent" checked={value.alsoOtherApp} onChange={(e) => onChange({ ...value, alsoOtherApp: e.target.checked })} />
                {also.label}
              </label>
            )
          )}
        </div>
      )}
    </div>
  );
}

export default PostPicker;

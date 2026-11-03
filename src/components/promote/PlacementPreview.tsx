"use client";

/**
 * PlacementPreview (docs/IG-PAGE-ADS-SPEC.md 3.4, 7.4, 7.6, D18): one tab per place the ad shows.
 *
 * - Tabs: Instagram Feed, Stories and Reels; Facebook Feed, Stories and Reels; chosen manual positions add theirs after
 *   (creative-helpers previewTabs). They work by tapping, by the previous and next buttons, by the arrow keys (Home and End
 *   too, with roving focus) and by a horizontal swipe on the preview.
 * - Lazy per tab: only the shown tab is drawn, and Meta's preview for a tab is asked (POST /api/promote/previews with that
 *   one placement) the first time the tab shows, at most 6 per review (createPreviewLedger). A new reviewKey starts over.
 * - Meta's answer shows in MetaPreviewFrame, labelled "Meta's preview". Everything else (previews off, the cap, Meta busy
 *   or failing, a position without a Meta preview, an answer flagged approximate) is PhoneFrame, labelled "Our preview
 *   (approximate)", with a short reason. While Meta's preview loads, PhoneFrame shows with a status line.
 * - The page lazy-loads this component (7.6). Nothing slides with the finger; the panel's fade is off under reduced motion
 *   (motion-reduce:animate-none, and globals.css collapses every animation), so reduced motion turns the animation off.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { buttonVariants, cn } from "@/components/ui";
import { promoteText } from "@/lib/promote/copy";
import type { PlacementKey, PromoteLang } from "@/lib/promote/types";
import { createPreviewLedger, placementLabel, previewDisplay, previewTabs, swipeStep, tabIndexForKey, type PreviewAnswer, type PreviewPlan } from "./creative-helpers";
import { MetaPreviewFrame } from "./MetaPreviewFrame";
import { PhoneFrame, type PhoneFrameProps } from "./PhoneFrame";

export const PREVIEW_TEST_IDS = {
  root: "placement-preview",
  tabs: "preview-tabs",
  tab: (k: PlacementKey) => `preview-tab-${k}`,
  panel: "preview-panel",
  previous: "preview-previous",
  next: "preview-next",
} as const;

/** What to preview: a saved draft (and one of its ads), or an unsaved spec. */
export type PreviewSource = { draftId: string; adId?: string | null } | { spec: Record<string, unknown> };
export type PreviewFetch = (body: Record<string, unknown>) => Promise<{ previews: PreviewAnswer[] }>;

export type PlacementPreviewProps = {
  /** The chosen positions; empty means Automatic. */
  placements: readonly PlacementKey[];
  /** One review: one version of one draft, or one unsaved spec. Change it when the ad changes (6 Meta previews per review). */
  reviewKey: string;
  /** Null while the ad can't be built yet: only our drawing shows. */
  source: PreviewSource | null;
  /** PROMOTE_PREVIEWS (PromoteAccess.previews): 'local' never asks Meta. */
  mode?: "meta" | "local";
  carousel?: boolean;
  /** What PhoneFrame draws. */
  frame: Omit<PhoneFrameProps, "placement" | "mock" | "carousel" | "lang" | "className">;
  lang?: PromoteLang;
  /** Injected in tests; defaults to POST /api/promote/previews. */
  fetchPreview?: PreviewFetch;
  className?: string;
};

type TabState = { status: "loading" | "done" | "failed"; answer: PreviewAnswer | null; plan: PreviewPlan };

const fetchPreviews: PreviewFetch = async (body) => {
  const res = await fetch("/api/promote/previews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  if (!res.ok) throw new Error(`previews ${res.status}`);
  return (await res.json()) as { previews: PreviewAnswer[] };
};

const navButton = cn(
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors duration-(--dur-fast) disabled:cursor-not-allowed disabled:opacity-50",
  buttonVariants.ghost,
);

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true" focusable="false">
      <path d={dir === "left" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlacementPreview({ placements, reviewKey, source, mode = "meta", carousel = false, frame, lang = "en", fetchPreview = fetchPreviews, className }: PlacementPreviewProps) {
  const uid = useId();
  const tabs = previewTabs(placements);
  const [selected, setSelected] = useState<PlacementKey>(tabs[0]);
  const active = tabs.includes(selected) ? selected : tabs[0];
  const index = Math.max(0, tabs.indexOf(active));
  const [ledger] = useState(() => createPreviewLedger());
  const [states, setStates] = useState<Record<string, TabState>>({});
  const mounted = useRef(true);
  const tabList = useRef<HTMLDivElement>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const sourceRef = useRef(source);
  const fetchRef = useRef(fetchPreview);
  useEffect(() => {
    sourceRef.current = source;
    fetchRef.current = fetchPreview;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const hasSource = source !== null;

  // Lazy: Meta is asked for the shown tab only, once per review, within the cap.
  useEffect(() => {
    if (!active) return;
    const key = `${reviewKey}|${active}`;
    const plan = ledger.plan(reviewKey, active, hasSource ? mode : "local");
    if (plan === "asked") return;
    if (plan !== "fetch" || !sourceRef.current) {
      setStates((s) => (s[key] ? s : { ...s, [key]: { status: "done", answer: null, plan } }));
      return;
    }
    setStates((s) => ({ ...s, [key]: { status: "loading", answer: null, plan } }));
    fetchRef
      .current({ ...sourceRef.current, placements: [active] })
      .then((r) => {
        const answer = r.previews.find((p) => p.placement === active) ?? null;
        if (mounted.current) setStates((s) => ({ ...s, [key]: { status: "done", answer, plan } }));
      })
      .catch(() => {
        if (mounted.current) setStates((s) => ({ ...s, [key]: { status: "failed", answer: null, plan } }));
      });
  }, [active, reviewKey, hasSource, mode, ledger]);

  // Keep the shown tab in view when the buttons or a swipe move it.
  useEffect(() => {
    const el = tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const select = (i: number, focus = false) => {
    const next = tabs[(i + tabs.length) % tabs.length];
    if (!next) return;
    setSelected(next);
    if (focus) tabList.current?.querySelectorAll<HTMLElement>('[role="tab"]')[tabs.indexOf(next)]?.focus();
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = tabIndexForKey(tabs.length, index, e.key);
    if (next === null) return;
    e.preventDefault();
    select(next, true);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    swipeStart.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const step = swipeStep(e.clientX - start.x, e.clientY - start.y);
    if (step) select(index + step);
  };

  const stateKey = `${reviewKey}|${active}`;
  const state = states[stateKey];
  const display = state?.status === "done" ? previewDisplay(state.answer, lang, state.plan) : previewDisplay(null, lang);
  const status =
    state?.status === "loading" ? promoteText("preview.loading", {}, lang) : state?.status === "failed" ? promoteText("preview.failed", {}, lang) : display.kind === "local" ? display.note : null;
  const ids = (k: PlacementKey) => ({ tab: `${uid}-tab-${k}`, panel: `${uid}-panel-${k}` });
  const prev = tabs[(index - 1 + tabs.length) % tabs.length];
  const next = tabs[(index + 1) % tabs.length];
  const label = promoteText("preview.label", {}, lang);

  return (
    <section aria-label={label} className={cn("flex min-w-0 flex-col gap-3", className)} data-testid={PREVIEW_TEST_IDS.root}>
      <div className="flex min-w-0 items-center gap-1">
        <button type="button" className={navButton} aria-label={promoteText("preview.previous", { position: placementLabel(prev, lang) }, lang)} onClick={() => select(index - 1)} data-testid={PREVIEW_TEST_IDS.previous}>
          <Chevron dir="left" />
        </button>
        <div ref={tabList} role="tablist" aria-label={label} onKeyDown={onTabKey} className="flex min-w-0 flex-1 gap-1 overflow-x-auto" data-testid={PREVIEW_TEST_IDS.tabs}>
          {tabs.map((k) => {
            const on = k === active;
            return (
              <button
                key={k}
                id={ids(k).tab}
                type="button"
                role="tab"
                aria-selected={on}
                aria-controls={on ? ids(k).panel : undefined}
                tabIndex={on ? 0 : -1}
                onClick={() => setSelected(k)}
                data-testid={PREVIEW_TEST_IDS.tab(k)}
                className={cn(
                  "min-h-11 shrink-0 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors duration-(--dur-fast)",
                  on ? "border-accent-ink bg-raised text-foreground shadow-raised" : "border-transparent text-muted hover:text-foreground",
                )}
              >
                {placementLabel(k, lang)}
              </button>
            );
          })}
        </div>
        <button type="button" className={navButton} aria-label={promoteText("preview.next", { position: placementLabel(next, lang) }, lang)} onClick={() => select(index + 1)} data-testid={PREVIEW_TEST_IDS.next}>
          <Chevron dir="right" />
        </button>
      </div>
      <p className="text-center text-xs text-muted" aria-hidden>
        {promoteText("preview.count", { n: index + 1, total: tabs.length }, lang)}
      </p>
      <div
        id={ids(active).panel}
        role="tabpanel"
        aria-labelledby={ids(active).tab}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipeStart.current = null;
        }}
        className="flex touch-pan-y flex-col items-center gap-2"
        data-testid={PREVIEW_TEST_IDS.panel}
        data-preview={display.kind}
      >
        <div key={stateKey} className="ui-fade-in flex w-full flex-col items-center motion-reduce:animate-none">
          {display.kind === "meta" ? (
            <MetaPreviewFrame src={display.src} placement={active} lang={lang} />
          ) : (
            <PhoneFrame {...frame} placement={active} mock={state?.answer?.mock ?? null} carousel={carousel} lang={lang} />
          )}
        </div>
        <p aria-live="polite" className="min-h-4 text-center text-xs text-muted">
          {status}
        </p>
      </div>
      <p className="text-center text-xs text-muted">{promoteText("preview.swipe", {}, lang)}</p>
    </section>
  );
}

export default PlacementPreview;

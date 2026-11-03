"use client";

/**
 * MediaPicker (docs/IG-PAGE-ADS-SPEC.md 3.4 step 2, 4.8, 7.3, D21, D34): choose the picture or video of an ad.
 *
 * - Three sources, as tabs: the content media library (GET /api/content/media), Creative Studio (a brief's ready
 *   pictures or videos), or a new upload, which goes to the content library first (POST /api/content/media, raw bytes).
 * - Picking is the member's tap that sends the file to the ad account (D34): POST /api/promote/media (prepare_ad_media)
 *   with where the ad shows, so the answer carries this request's fit chips and problems.
 * - The chosen file shows its fit chips ("Feed 4:5 ✓", "Stories and Reels 9:16: missing") and its status, polled with
 *   GET /api/promote/media/[id] while it is on its way (pending, uploading, processing). A video Meta is still preparing
 *   says "Meta is still preparing your video. This usually takes 5 to 30 minutes."
 * - Errors are the server's plain sentences; a lost connection gets a plain retry line.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Alert, apiFetch, Badge, Button, cn, Select, Skeleton, Tabs } from "@/components/ui";
import { promoteText } from "@/lib/promote/copy";
import type { AdMediaView } from "@/lib/promote/media";
import type { AdFormat, PlacementKey, PromoteLang } from "@/lib/promote/types";
import {
  briefLabel,
  creativeAssetsOf,
  libraryFilesOf,
  MEDIA_POLL_LIMIT_MS,
  mediaChips,
  mediaFileUrl,
  mediaPollDelayMs,
  mediaProblems,
  mediaStatusLine,
  mergePolledMedia,
  prepareBody,
  uploadProblem,
  type CreativeAssetLite,
  type CreativeBriefLite,
  type PrepareSource,
} from "./creative-helpers";

export const MEDIA_PICKER_TEST_IDS = { root: "media-picker", chosen: "media-picker-chosen", status: "media-picker-status", change: "media-picker-change", upload: "media-picker-upload" } as const;

/** prepare_ad_media: sends a library file to the spending ad account and answers its AdMediaView. */
export async function prepareAdMedia(src: PrepareSource, placements: readonly PlacementKey[], format?: AdFormat | null): Promise<AdMediaView> {
  const { media } = await apiFetch<{ media: AdMediaView }>("/api/promote/media", { method: "POST", body: prepareBody(src, placements, format) });
  return media;
}

/** get_ad_media: one item's status, chips and problems. */
export async function getAdMedia(id: string): Promise<AdMediaView> {
  const { media } = await apiFetch<{ media: AdMediaView }>(`/api/promote/media/${encodeURIComponent(id)}`);
  return media;
}

/**
 * Raw bytes to the content media library (the only byte upload route). A crop is marked ?purpose=ad_crop (5.5). Both
 * addresses are literal same-origin paths, as the spend bypass rule B12 requires of fetch() outside its listed files.
 */
export async function uploadToLibrary(body: Blob, contentType: string, opts: { adCrop?: boolean } = {}): Promise<{ key: string }> {
  const init: RequestInit = { method: "POST", headers: { "content-type": contentType }, body, credentials: "same-origin" };
  const res = await (opts.adCrop ? fetch("/api/content/media?purpose=ad_crop", init) : fetch("/api/content/media", init)).catch(() => null);
  const json = res ? ((await res.json().catch(() => ({}))) as { key?: string; error?: string }) : {};
  if (!res || !res.ok || !json.key) throw new Error(json.error || promoteText("media.picker.upload_failed"));
  return { key: json.key };
}

export type MediaPickerProps = {
  kind: "image" | "video";
  /** Where the ad shows (empty: Automatic), so the server's check fits the request. */
  placements: readonly PlacementKey[];
  format?: AdFormat | null;
  value: AdMediaView | null;
  onChange: (media: AdMediaView | null) => void;
  /** The legend: "Picture", "Video", "Tall version for Stories and Reels". */
  label: string;
  /** Extra buttons under a chosen file (Crop, Add a tall version). */
  actions?: ReactNode;
  /** Words under the legend (for example "Videos can't be cropped here"). */
  hint?: string;
  lang?: PromoteLang;
  className?: string;
};

type LibraryFile = { key: string; kind?: string };
type PickFn = (src: PrepareSource, busyKey: string) => void;

/** GET a JSON list for a panel. The answer is kept with its path, so a new path never shows the old list. */
function useLoad<T>(path: string | null): { data: T | null; error: string | null; retry: () => void } {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string | null }>({ path: null, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    apiFetch<T>(path)
      .then((data) => live && setState({ path, data, error: null }))
      .catch((e: Error) => live && setState({ path, data: null, error: e.message }));
    return () => {
      live = false;
    };
  }, [path, tick]);
  const current = state.path === path;
  return { data: current ? state.data : null, error: current ? state.error : null, retry: () => setTick((n) => n + 1) };
}

function LoadProblem({ onRetry, lang }: { onRetry: () => void; lang: PromoteLang }) {
  return (
    <Alert
      tone="warn"
      action={
        <Button type="button" size="sm" variant="secondary" className="pointer-coarse:min-h-11" onClick={onRetry}>
          {promoteText("media.picker.retry", {}, lang)}
        </Button>
      }
    >
      {promoteText("media.picker.load_failed", {}, lang)}
    </Alert>
  );
}

function Grid({ items, kind, busy, onPick, lang }: { items: { key: string; url: string; src: PrepareSource }[]; kind: "image" | "video"; busy: string | null; onPick: PickFn; lang: PromoteLang }) {
  if (items.length === 0) return <p className="text-sm text-muted">{promoteText("media.picker.empty", {}, lang)}</p>;
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
      {items.slice(0, 60).map((it, i) => (
        <li key={it.key}>
          <button
            type="button"
            className="relative block w-full overflow-hidden rounded-control border border-border bg-surface-2 transition-colors duration-(--dur-fast) hover:border-accent disabled:cursor-not-allowed disabled:opacity-60 aria-busy:cursor-progress"
            aria-label={promoteText(kind === "image" ? "media.picker.use_image" : "media.picker.use_video", { n: i + 1 }, lang)}
            aria-busy={busy === it.key || undefined}
            disabled={busy !== null}
            onClick={() => onPick(it.src, it.key)}
          >
            {kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={it.url} alt="" loading="lazy" decoding="async" className="aspect-square w-full object-cover" />
            ) : (
              <video src={it.url} preload="metadata" muted playsInline aria-hidden className="aspect-square w-full object-cover" />
            )}
            {busy === it.key && <span aria-hidden className="ui-spinner absolute top-1 right-1 h-4 w-4 rounded-full border-2 border-border-strong border-t-accent" />}
          </button>
        </li>
      ))}
    </ul>
  );
}

function LibraryPanel({ kind, busy, onPick, lang }: { kind: "image" | "video"; busy: string | null; onPick: PickFn; lang: PromoteLang }) {
  const load = useLoad<{ media: LibraryFile[] }>("/api/content/media");
  if (load.error) return <LoadProblem onRetry={load.retry} lang={lang} />;
  if (!load.data) return <Skeleton className="h-24 w-full" />;
  const items = libraryFilesOf(load.data.media, kind).map((f) => ({ key: f.key, url: `/api/content/media/${encodeURIComponent(f.key)}`, src: { from: "content" as const, key: f.key } }));
  return <Grid items={items} kind={kind} busy={busy} onPick={onPick} lang={lang} />;
}

function CreativePanel({ kind, busy, onPick, lang }: { kind: "image" | "video"; busy: string | null; onPick: PickFn; lang: PromoteLang }) {
  const selectId = useId();
  const briefs = useLoad<{ items: CreativeBriefLite[] }>("/api/creative/briefs");
  const [briefId, setBriefId] = useState("");
  const brief = useLoad<{ item: { assets: CreativeAssetLite[] } }>(briefId ? `/api/creative/briefs/${encodeURIComponent(briefId)}` : null);
  if (briefs.error) return <LoadProblem onRetry={briefs.retry} lang={lang} />;
  if (!briefs.data) return <Skeleton className="h-10 w-full" />;
  if (briefs.data.items.length === 0) return <p className="text-sm text-muted">{promoteText("media.picker.empty", {}, lang)}</p>;
  const assets = brief.data ? creativeAssetsOf(brief.data.item.assets, kind) : [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={selectId} className="text-sm font-medium">
          {promoteText("media.picker.brief", {}, lang)}
        </label>
        <Select id={selectId} value={briefId} onChange={(e) => setBriefId(e.target.value)}>
          <option value="">{promoteText("media.picker.choose_brief", {}, lang)}</option>
          {briefs.data.items.map((b) => (
            <option key={b.id} value={b.id}>
              {briefLabel(b)}
            </option>
          ))}
        </Select>
      </div>
      {briefId &&
        (brief.error ? (
          <LoadProblem onRetry={brief.retry} lang={lang} />
        ) : !brief.data ? (
          <Skeleton className="h-24 w-full" />
        ) : assets.length === 0 ? (
          <p className="text-sm text-muted">{promoteText("media.picker.creative_empty", {}, lang)}</p>
        ) : (
          <Grid
            items={assets.map((a) => ({ key: a.id, url: `/api/creative/assets/${encodeURIComponent(a.id)}/file`, src: { from: "creative" as const, assetId: a.id } }))}
            kind={kind}
            busy={busy}
            onPick={onPick}
            lang={lang}
          />
        ))}
    </div>
  );
}

function UploadPanel({ kind, busy, onPick, onProblem, lang }: { kind: "image" | "video"; busy: string | null; onPick: PickFn; onProblem: (text: string | null) => void; lang: PromoteLang }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const accept = kind === "image" ? "image/jpeg,image/png" : "video/mp4,video/quicktime";

  async function upload(file: File) {
    const bad = uploadProblem(file, kind, lang);
    onProblem(bad);
    if (bad) return;
    setUploading(true);
    try {
      const { key } = await uploadToLibrary(file, file.type);
      onPick({ from: "content", key }, key);
    } catch (e) {
      onProblem(e instanceof Error && e.message ? e.message : promoteText("media.picker.upload_failed", {}, lang));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  const label = promoteText(kind === "image" ? "media.picker.upload_image" : "media.picker.upload_video", {}, lang);
  return (
    <div className="flex flex-col items-start gap-2">
      <input ref={input} type="file" accept={accept} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      <Button type="button" variant="secondary" className="pointer-coarse:min-h-11" loading={uploading || busy !== null} onClick={() => input.current?.click()} data-testid={MEDIA_PICKER_TEST_IDS.upload}>
        {label}
      </Button>
      <p className="text-xs text-muted">{promoteText(kind === "image" ? "media.picker.image_hint" : "media.picker.video_hint", {}, lang)}</p>
    </div>
  );
}

/**
 * Polls a file that is still on its way to Meta, and stops once it is settled, blocked for this ad, or after
 * MEDIA_POLL_LIMIT_MS. GET answers the row's progress; mergePolledMedia keeps this request's problems and block line.
 */
function useMediaPoll(value: AdMediaView | null, onChange: (media: AdMediaView) => void) {
  const latest = useRef({ value, onChange });
  const started = useRef<{ id: string; at: number } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    latest.current = { value, onChange };
  });
  const id = value?.id ?? null;
  const delay = value ? mediaPollDelayMs(value) : null;
  useEffect(() => {
    if (!id || delay === null) return;
    if (started.current?.id !== id) started.current = { id, at: Date.now() };
    if (Date.now() - started.current.at > MEDIA_POLL_LIMIT_MS) return;
    let live = true;
    const timer = setTimeout(() => {
      getAdMedia(id)
        .then((m) => {
          if (!live) return;
          const cur = latest.current.value;
          const next = cur ? mergePolledMedia(cur, m) : null;
          if (next) latest.current.onChange(next);
        })
        .catch(() => undefined)
        .finally(() => live && setTick((n) => n + 1));
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, delay, tick]);
}

function Chosen({ media, actions, onClear, lang }: { media: AdMediaView; actions?: ReactNode; onClear: () => void; lang: PromoteLang }) {
  const status = mediaStatusLine(media, lang);
  const chips = mediaChips(media, lang);
  // The problem the status line already says isn't repeated as an alert (it would be announced twice).
  const problems = mediaProblems(media, lang).filter((p) => p.code !== status.problemCode);
  const url = mediaFileUrl(media);
  const toneClass = status.tone === "good" ? "text-good-fg" : status.tone === "bad" ? "text-bad-fg" : "text-muted";
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-raised p-3" data-testid={MEDIA_PICKER_TEST_IDS.chosen} data-status={media.status}>
      <div className="flex min-w-0 items-start gap-3">
        {media.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={promoteText("media.picker.chosen_image", {}, lang)} className="size-24 shrink-0 rounded-control border border-border bg-surface-2 object-cover" />
        ) : (
          <video src={url} preload="metadata" muted playsInline aria-label={promoteText("media.picker.chosen_video", {}, lang)} className="size-24 shrink-0 rounded-control border border-border bg-surface-2 object-cover" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p aria-live="polite" className={cn("flex items-start gap-2 text-sm", toneClass)} data-testid={MEDIA_PICKER_TEST_IDS.status}>
            {status.busy && <span aria-hidden className="ui-spinner mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-border-strong border-t-accent" />}
            <span className="min-w-0 break-words">{status.text}</span>
          </p>
          {chips.length > 0 && (
            <ul aria-label={promoteText("media.picker.fits", {}, lang)} className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <li key={c.key}>
                  <Badge tone={c.ok ? "good" : "warn"}>{c.text}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {problems.map((p) => (
        <Alert key={p.code} tone={p.block ? "bad" : "warn"}>
          {p.text}
        </Alert>
      ))}
      <div className="flex flex-wrap gap-2">
        {actions}
        <Button type="button" variant="ghost" className="pointer-coarse:min-h-11" onClick={onClear} data-testid={MEDIA_PICKER_TEST_IDS.change}>
          {promoteText("media.picker.change", {}, lang)}
        </Button>
      </div>
    </div>
  );
}

export function MediaPicker({ kind, placements, format, value, onChange, label, actions, hint, lang = "en", className }: MediaPickerProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useMediaPoll(value, onChange);

  const pick: PickFn = (src, busyKey) => {
    setBusy(busyKey);
    setProblem(null);
    prepareAdMedia(src, placements, format)
      .then((media) => mounted.current && onChange(media))
      .catch((e: Error) => mounted.current && setProblem(e.message || promoteText("media.picker.prepare_failed", {}, lang)))
      .finally(() => mounted.current && setBusy(null));
  };

  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-3", className)} data-testid={MEDIA_PICKER_TEST_IDS.root} data-kind={kind}>
      <legend className="text-sm font-medium">
        {label}
      </legend>
      {hint && <p className="-mt-1 text-xs text-muted">{hint}</p>}
      {value ? (
        <Chosen media={value} actions={actions} onClear={() => onChange(null)} lang={lang} />
      ) : (
        <Tabs
          variant="pill"
          label={promoteText("media.picker.tabs", {}, lang)}
          tabs={[
            { id: "library", label: promoteText("media.picker.library", {}, lang), content: <LibraryPanel kind={kind} busy={busy} onPick={pick} lang={lang} /> },
            { id: "creative", label: promoteText("media.picker.creative", {}, lang), content: <CreativePanel kind={kind} busy={busy} onPick={pick} lang={lang} /> },
            { id: "upload", label: promoteText("media.picker.upload", {}, lang), content: <UploadPanel kind={kind} busy={busy} onPick={pick} onProblem={setProblem} lang={lang} /> },
          ]}
        />
      )}
      {problem && (
        <p role="alert" className="text-sm font-medium text-bad-fg">
          {problem}
        </p>
      )}
    </fieldset>
  );
}

export default MediaPicker;

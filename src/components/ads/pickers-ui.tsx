"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Alert, Button, FormField, Input, Select, Skeleton, apiFetch, toast } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { friendlyAdsError, pictureLinkError } from "./helpers";
import {
  CITY_RADII,
  DEFAULT_RADIUS_KM,
  addCity,
  addInterest,
  adPictures,
  audienceText,
  cityLabel,
  cityRadiusKm,
  pickerPath,
  pictureFileProblem,
  postLabel,
  type ChosenCity,
  type CityOption,
  type InterestOption,
} from "./picker-helpers";
import { checkboxClass, optionRowClass } from "./wizard-parts";

/*
 * The campaign wizard's pickers: Meta's own lists (posts, lead forms, interests, cities) through /api/ads/pickers, and
 * pictures from the media library or a new upload. Each keeps a way to type the value by hand, for when Meta refuses a read.
 */

const message = (e: unknown) => friendlyAdsError((e as Error)?.message);

/** Enter in a search box searches instead of submitting the wizard step. */
const onEnter = (run: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  run();
};

function useSearch<T>(path: (q: string) => string) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<T[] | null>(null);
  const [searched, setSearched] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function search() {
    const term = q.trim();
    if (term.length < 2) return setError("Type at least two letters to search.");
    setBusy(true);
    setError("");
    try {
      setResults((await apiFetch<{ items: T[] }>(path(term))).items);
      setSearched(term);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return { q, setQ, results, searched, busy, error, search };
}

/** Meta's interest search; chosen interests are listed with a Remove button each. */
export function InterestPicker({ accountId, value, onChange, disabled }: { accountId: string; value: { id: string; name: string }[]; onChange: (next: { id: string; name: string }[]) => void; disabled?: boolean }) {
  const s = useSearch<InterestOption>((q) => pickerPath("interests", { account: accountId, q }));
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">
        Interests <span className="font-normal text-muted">(optional)</span>
      </legend>
      <p className="text-xs text-muted">Search for what your customers care about, like yoga or home decor. Leave empty to let Meta find the right people.</p>
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1" aria-label="Search interests" value={s.q} onChange={(e) => s.setQ(e.target.value)} onKeyDown={onEnter(() => void s.search())} autoComplete="off" placeholder="e.g. yoga" />
        <Button type="button" variant="secondary" onClick={() => void s.search()} loading={s.busy}>
          Search interests
        </Button>
      </div>
      {s.error && (
        <p className="text-sm text-bad-fg" role="alert">
          {s.error}
        </p>
      )}
      {s.results &&
        (s.results.length === 0 ? (
          <p className="text-sm text-muted" role="status">
            No interests found for &quot;{s.searched}&quot;. Try another word.
          </p>
        ) : (
          <ul className="max-h-56 space-y-1 overflow-auto rounded-control border border-border p-2" aria-label="Interests found">
            {s.results.map((r) => {
              const chosen = value.some((v) => v.id === r.id);
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0">
                    <span className="block">{r.name}</span>
                    <span className="block text-xs text-muted">{audienceText(r.audienceLow, r.audienceHigh)}</span>
                  </span>
                  <Button type="button" size="sm" variant="secondary" disabled={chosen} aria-label={chosen ? `${r.name} is added` : `Add ${r.name}`} onClick={() => onChange(addInterest(value, r))}>
                    {chosen ? "Added" : "Add"}
                  </Button>
                </li>
              );
            })}
          </ul>
        ))}
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Chosen interests">
          {value.map((i) => (
            <li key={i.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface py-1 pl-3 pr-1 text-sm">
              {i.name}
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${i.name}`} onClick={() => onChange(value.filter((v) => v.id !== i.id))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/** Meta's city search; each chosen city gets a radius around it. */
export function CityPicker({ accountId, country, value, onChange, minRadiusKm }: { accountId: string; country: string; value: ChosenCity[]; onChange: (next: ChosenCity[]) => void; minRadiusKm?: number }) {
  const s = useSearch<CityOption>((q) => pickerPath("cities", { account: accountId, q, country: /^[A-Za-z]{2}$/.test(country) ? country : null }));
  const radii = CITY_RADII.filter((r) => !minRadiusKm || r >= minRadiusKm);
  const startRadius = radii.includes(DEFAULT_RADIUS_KM) ? DEFAULT_RADIUS_KM : radii[0];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1" aria-label="Search cities" value={s.q} onChange={(e) => s.setQ(e.target.value)} onKeyDown={onEnter(() => void s.search())} autoComplete="off" placeholder="e.g. Pune" />
        <Button type="button" variant="secondary" onClick={() => void s.search()} loading={s.busy}>
          Search cities
        </Button>
      </div>
      {s.error && (
        <p className="text-sm text-bad-fg" role="alert">
          {s.error}
        </p>
      )}
      {s.results &&
        (s.results.length === 0 ? (
          <p className="text-sm text-muted" role="status">
            No cities found for &quot;{s.searched}&quot;. Check the spelling, or try a bigger city nearby.
          </p>
        ) : (
          <ul className="max-h-56 space-y-1 overflow-auto rounded-control border border-border p-2" aria-label="Cities found">
            {s.results.map((r) => {
              const chosen = value.some((v) => v.key === r.key);
              return (
                <li key={r.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0">{cityLabel(r)}</span>
                  <Button type="button" size="sm" variant="secondary" disabled={chosen} aria-label={chosen ? `${r.name} is added` : `Add ${cityLabel(r)}`} onClick={() => onChange(addCity(value, r, startRadius))}>
                    {chosen ? "Added" : "Add"}
                  </Button>
                </li>
              );
            })}
          </ul>
        ))}
      {value.length > 0 && (
        <ul className="space-y-2" aria-label="Chosen cities">
          {value.map((c) => {
            // The radius the campaign is sent with: inside Meta's range and wide enough for a special category.
            const shown = cityRadiusKm(c.radiusKm, minRadiusKm);
            return (
              <li key={c.key} className="flex flex-wrap items-end gap-2 rounded-control border border-border p-2 text-sm">
                <span className="min-w-0 flex-1 self-center">{c.name}</span>
                <FormField label="Area around it" className="w-36">
                  <Select value={String(shown)} onChange={(e) => onChange(value.map((v) => (v.key === c.key ? { ...v, radiusKm: Number(e.target.value) } : v)))}>
                    {[...new Set([...radii, shown])].sort((a, b) => a - b).map((r) => (
                      <option key={r} value={r}>
                        {r} km
                      </option>
                    ))}
                  </Select>
                </FormField>
                <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${c.name}`} onClick={() => onChange(value.filter((v) => v.key !== c.key))}>
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type PostOption = { id: string; text?: string; caption?: string; createdAt: string | null; picture: string | null; eligible?: boolean | null };

/**
 * The post to boost: one of the Page's posts, or one of the Instagram account's (when an Instagram account is chosen).
 * Facebook posts can also be entered by ID.
 */
export function PostPicker({
  pageAssetId,
  instagramAssetId,
  postId,
  instagramMediaId,
  onPick,
}: {
  pageAssetId: string;
  instagramAssetId: string;
  postId: string;
  instagramMediaId: string;
  onPick: (pick: { postId: string; instagramMediaId: string }) => void;
}) {
  const [source, setSource] = useState<"facebook" | "instagram">(instagramMediaId ? "instagram" : "facebook");
  const path = source === "facebook" ? (pageAssetId ? pickerPath("posts", { page: pageAssetId }) : null) : instagramAssetId ? pickerPath("instagram_media", { instagram: instagramAssetId }) : null;
  const posts = useApi<{ items: PostOption[] }>(path);
  const chosen = source === "facebook" ? postId : instagramMediaId;
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">
        Post to boost<span aria-hidden className="ml-0.5 text-bad-fg">*</span>
      </legend>
      {instagramAssetId && (
        <div role="radiogroup" aria-label="Where the post is" className="flex flex-wrap gap-2">
          {(["facebook", "instagram"] as const).map((s) => (
            <Button key={s} type="button" size="sm" variant={source === s ? "primary" : "secondary"} aria-pressed={source === s} onClick={() => setSource(s)}>
              {s === "facebook" ? "Facebook Page" : "Instagram"}
            </Button>
          ))}
        </div>
      )}
      {!path ? (
        <p className="text-sm text-muted">Choose the Facebook Page above to see its posts.</p>
      ) : posts.error && !posts.data ? (
        <Alert tone="warn" action={<Button type="button" size="sm" variant="secondary" onClick={posts.retry}>Try again</Button>}>
          {message(new Error(posts.error))}
        </Alert>
      ) : !posts.data ? (
        <div aria-busy="true">
          <span className="sr-only" role="status">Loading your posts</span>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : posts.data.items.length === 0 ? (
        <p className="text-sm text-muted" role="status">
          {source === "facebook" ? "This Page has no published posts yet." : "This Instagram account has no posts yet."}
        </p>
      ) : (
        <ul className="max-h-80 space-y-1 overflow-auto rounded-control border border-border p-2">
          {posts.data.items.map((p) => (
            <li key={p.id}>
              <label className={optionRowClass}>
                <input
                  type="radio"
                  name="boost-post"
                  className={checkboxClass}
                  checked={chosen === p.id}
                  disabled={p.eligible === false}
                  onChange={() => onPick(source === "facebook" ? { postId: p.id, instagramMediaId: "" } : { postId: "", instagramMediaId: p.id })}
                />
                {p.picture && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.picture} alt="" className="size-12 shrink-0 rounded-control object-cover" loading="lazy" referrerPolicy="no-referrer" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm">{postLabel(p)}</span>
                  {p.eligible === false && <span className="block text-xs text-muted">Meta does not allow this post to be boosted.</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {source === "facebook" && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Enter a post ID instead</summary>
          <FormField label="Facebook post ID" className="mt-2" hint="It looks like 1234567890_9876543210.">
            <Input value={postId} onChange={(e) => onPick({ postId: e.target.value.trim(), instagramMediaId: "" })} autoComplete="off" />
          </FormField>
        </details>
      )}
    </fieldset>
  );
}

type FormOption = { id: string; metaFormId: string; name: string; active: boolean };

/** The Page's lead forms (read from Meta, and added to the Lead forms page). A form ID can still be typed by hand. */
export function LeadFormPicker({ pageAssetId, value, onChange }: { pageAssetId: string; value: string; onChange: (metaFormId: string) => void }) {
  const forms = useApi<{ items: FormOption[] }>(pageAssetId ? pickerPath("lead_forms", { page: pageAssetId }) : null);
  const list = forms.data?.items ?? [];
  const known = list.some((f) => f.metaFormId === value);
  return (
    <div className="space-y-2">
      {!pageAssetId ? (
        <FormField label="Lead form" required hint="Choose the Facebook Page above to see its lead forms.">
          <Select value="" disabled>
            <option value="">Choose a Page first</option>
          </Select>
        </FormField>
      ) : forms.error && !forms.data ? (
        <Alert tone="warn" action={<Button type="button" size="sm" variant="secondary" onClick={forms.retry}>Try again</Button>}>
          {message(new Error(forms.error))}
        </Alert>
      ) : (
        <FormField label="Lead form" required hint={list.length === 0 && forms.data ? "This Page has no lead forms yet. Make one in Meta Business Suite, then check again." : "The form people fill in when they tap your ad."}>
          <Select value={known ? value : ""} onChange={(e) => onChange(e.target.value)} disabled={!forms.data}>
            <option value="">{forms.data ? "Choose a lead form" : "Loading your lead forms"}</option>
            {list.map((f) => (
              <option key={f.metaFormId} value={f.metaFormId} disabled={!f.active}>
                {f.name}
                {f.active ? "" : " (not active)"}
              </option>
            ))}
          </Select>
        </FormField>
      )}
      {pageAssetId && forms.data && list.length === 0 && (
        <Button type="button" size="sm" variant="secondary" onClick={forms.retry}>
          Check again
        </Button>
      )}
      <details className="text-sm" open={!!value && !known && !!forms.data}>
        <summary className="cursor-pointer font-medium">Enter a form ID instead</summary>
        <FormField label="Lead form ID" className="mt-2" hint="The ID of a lead form on your Facebook Page.">
          <Input value={known ? "" : value} onChange={(e) => onChange(e.target.value.trim())} autoComplete="off" />
        </FormField>
      </details>
    </div>
  );
}

type MediaItem = { key: string; kind?: string; createdAt?: string };

/**
 * The ad picture: upload a JPG or PNG (it goes to the media library), pick one already there, or paste a public link.
 * A library picture is sent to Meta through a fresh signed link at launch.
 */
export function PicturePicker({ mediaKey, imageUrl, onMediaKey, onImageUrl, required }: { mediaKey: string; imageUrl: string; onMediaKey: (key: string) => void; onImageUrl: (url: string) => void; required: boolean }) {
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const library = useApi<{ media: MediaItem[] }>(libraryOpen ? "/api/content/media" : null);
  const pictures = adPictures(library.data?.media ?? []);

  async function upload(file: File) {
    const bad = pictureFileProblem(file);
    if (bad) return setProblem(bad);
    setProblem("");
    setUploading(true);
    try {
      const res = await fetch("/api/content/media", { method: "POST", headers: { "content-type": file.type }, body: file, credentials: "same-origin" });
      const json = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (!res.ok || !json.key) return setProblem(json.error ?? "We could not upload that picture. Check your connection and try again.");
      onMediaKey(json.key);
      onImageUrl("");
      library.reload();
      toast.success("Picture added");
    } catch {
      setProblem("We could not upload that picture. Check your connection and try again.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">
        Picture
        {required ? <span aria-hidden className="ml-0.5 text-bad-fg">*</span> : <span className="font-normal text-muted"> (optional)</span>}
      </legend>
      <p className="text-xs text-muted">A JPG or PNG. Square pictures of at least 1080 by 1080 pixels look best.</p>
      {mediaKey ? (
        <div className="flex flex-wrap items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/content/media/${encodeURIComponent(mediaKey)}`} alt="The picture chosen for your ad" className="size-24 rounded-control border border-border object-cover" />
          <Button type="button" size="sm" variant="secondary" onClick={() => onMediaKey("")}>
            Remove picture
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInput} id="ad-picture-file" type="file" accept="image/jpeg,image/png" aria-label="Upload a picture" aria-hidden="true" className="sr-only" tabIndex={-1} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          <Button type="button" variant="secondary" loading={uploading} onClick={() => fileInput.current?.click()}>
            Upload a picture
          </Button>
        </div>
      )}
      {problem && (
        <p className="text-sm text-bad-fg" role="alert">
          {problem}
        </p>
      )}
      <details className="text-sm" onToggle={(e) => e.currentTarget.open && setLibraryOpen(true)}>
        <summary className="cursor-pointer font-medium">Choose from your media library</summary>
        {library.error && !library.data ? (
          <p className="mt-2 text-muted">We could not load your media library.</p>
        ) : libraryOpen && !library.data ? (
          <Skeleton className="mt-2 h-24 w-full" />
        ) : pictures.length === 0 ? (
          <p className="mt-2 text-muted">No JPG or PNG pictures in your library yet. Upload one above.</p>
        ) : (
          <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5" aria-label="Pictures in your media library">
            {pictures.slice(0, 30).map((m, i) => (
              <li key={m.key}>
                <button
                  type="button"
                  className="block w-full overflow-hidden rounded-control border border-border aria-pressed:border-accent aria-pressed:ring-2 aria-pressed:ring-accent"
                  aria-pressed={mediaKey === m.key}
                  aria-label={`Use picture ${i + 1}`}
                  onClick={() => {
                    onMediaKey(m.key);
                    onImageUrl("");
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/content/media/${encodeURIComponent(m.key)}`} alt="" className="aspect-square w-full object-cover" loading="lazy" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>
      {!mediaKey && (
        <FormField label="Picture link" error={pictureLinkError(imageUrl)} hint="Or paste a public web address that starts with https and points to your JPG or PNG. Meta must be able to open it.">
          <Input type="url" inputMode="url" value={imageUrl} onChange={(e) => onImageUrl(e.target.value)} autoComplete="off" />
        </FormField>
      )}
    </fieldset>
  );
}

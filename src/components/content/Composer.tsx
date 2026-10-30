"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/components/contacts/hooks";
import { Alert, Badge, Button, Card, CopyButton, EmptyState, FormField, Input, Skeleton, Tabs, Textarea, apiFetch, cn, tabIds, toast } from "@/components/ui";
import { ChoiceCard } from "@/components/creative/ChoiceCard";
import { friendlyMessage } from "@/components/creative/messages";
import { channelProblems, type Channel } from "@/lib/content/limits";
import { charCounter, defaultSchedule, MEDIA_LIMIT_TEXT, quickSlots, scheduledAtField, scheduleProblem } from "./calendar-helpers";
import { ChannelPreview } from "./ChannelPreview";
import { CHANNEL_NAME, formatWhen, fromLocalInput, mediaUrl, toLocalInput, type AssetOption, type MediaItem, type Post } from "./helpers";

/** 16 px text in fields on phones, so iOS does not zoom the page when a field gets focus. */
const PHONE_TEXT = "max-sm:[&_input]:text-base! max-sm:[&_textarea]:text-base!";

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_VIDEO = 100 * 1024 * 1024;

function SectionTitle({ id, n, title, help }: { id: string; n: number; title: string; help?: string }) {
  return (
    <div className="mb-3">
      <h2 id={id} className="flex items-center gap-2 text-base font-semibold">
        <span aria-hidden className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-ink">
          {n}
        </span>
        {title}
      </h2>
      {help && <p className="mt-0.5 pl-8 text-sm text-muted">{help}</p>}
    </div>
  );
}

/**
 * onCancel is called for Cancel; the parent decides whether to ask "Discard this post?" using the dirty state reported
 * through onDirtyChange (true once the text, accounts, media or time differ from what the composer opened with).
 */
export function Composer({ post, defaultDate, onDone, onCancel, onDirtyChange }: { post?: Post; defaultDate?: string; onDone: () => void; onCancel: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const targets = useApi<{ targets: AssetOption[] }>("/api/content/targets");
  const library = useApi<{ media: MediaItem[] }>("/api/content/media");
  const fileInput = useRef<HTMLInputElement>(null);
  const [body, setBody] = useState(post?.body ?? "");
  const [assetIds, setAssetIds] = useState<string[]>(post?.targets.map((t) => t.assetId) ?? []);
  const [mediaKey, setMediaKey] = useState<string | undefined>(post?.mediaKeys[0]);
  const [when, setWhen] = useState(() => (post ? toLocalInput(post.scheduledAt) : defaultSchedule(defaultDate)));
  const [approval, setApproval] = useState(false);
  const [busy, setBusy] = useState<"schedule" | "draft" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvalLink, setApprovalLink] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string>("");
  const [initial] = useState(() => ({ body, assetIds, mediaKey, when }));
  const approvalCard = useRef<HTMLDivElement>(null);
  const errorBox = useRef<HTMLDivElement>(null);
  const dirty = body !== initial.body || mediaKey !== initial.mediaKey || when !== initial.when || assetIds.length !== initial.assetIds.length || assetIds.some((id) => !initial.assetIds.includes(id));
  const finished = !!approvalLink;

  useEffect(() => {
    onDirtyChange?.(dirty && !finished);
  }, [dirty, finished, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Closing the tab or reloading would lose the post too.
  useEffect(() => {
    if (!dirty || finished) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, finished]);

  // Once the link exists the form is replaced by the link card, so move focus there.
  useEffect(() => {
    if (approvalLink) approvalCard.current?.focus();
  }, [approvalLink]);

  // The bar with the buttons is always on screen, but the message may be scrolled away. Bring it into view.
  useEffect(() => {
    if (error) errorBox.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  const options = targets.data?.targets ?? [];
  const chosen = options.filter((o) => assetIds.includes(o.id));
  const slots = useMemo(() => quickSlots(), []);
  const problems = useMemo(() => [...new Set(chosen.flatMap((o) => channelProblems(o.channel, body, mediaKey ? [mediaKey] : [])))], [chosen, body, mediaKey]);
  const timeProblem = scheduleProblem(when);
  const whenText = timeProblem ? "Not scheduled yet" : formatWhen(fromLocalInput(when));
  const tabs = chosen.map((o) => ({ id: o.id, label: `${CHANNEL_NAME[o.channel]}${chosen.filter((x) => x.channel === o.channel).length > 1 ? `: ${o.name ?? "Account"}` : ""}` }));
  const activePreview = chosen.find((o) => o.id === previewId) ?? chosen[0];
  const scheduleBlocker = assetIds.length === 0 ? "Choose where to post." : problems.length > 0 ? "Fix the items above first." : timeProblem;
  const draftBlocker = assetIds.length === 0 ? "Choose where to post." : null;
  // A draft can be saved without a usable time. The server then keeps the old time or uses now.
  const draftNote = timeProblem && !draftBlocker ? "You can still save a draft without a time." : "";

  async function upload(file: File) {
    setMediaError(null);
    const isVideo = file.type.startsWith("video/");
    if (!/^(image\/(jpeg|png)|video\/(mp4|quicktime))$/.test(file.type)) return setMediaError("Use a JPEG or PNG picture, or an MP4 or MOV video.");
    if (file.size > (isVideo ? MAX_VIDEO : MAX_IMAGE)) return setMediaError(isVideo ? "That video is too large. Videos can be up to 100 MB." : "That picture is too large. Pictures can be up to 8 MB.");
    setUploading(true);
    try {
      const res = await fetch("/api/content/media", { method: "POST", headers: { "content-type": file.type }, body: file, credentials: "same-origin" });
      const json = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (!res.ok || !json.key) {
        setMediaError(friendlyMessage(json.error, "We could not upload that file. Check your connection and try again."));
        return;
      }
      setMediaKey(json.key);
      library.reload();
      toast.success(isVideo ? "Video added" : "Picture added");
    } catch {
      setMediaError("We could not upload that file. Check your connection and try again.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function save(draft: boolean) {
    setBusy(draft ? "draft" : "schedule");
    setError(null);
    try {
      const sendTime = !draft || timeProblem === null;
      const payload = { body, mediaKeys: mediaKey ? [mediaKey] : [], assetIds, ...scheduledAtField(when, draft, timeProblem), draft, requireApproval: approval };
      const res = post
        ? await apiFetch<{ post: Post; approvalUrl?: string | null }>(`/api/content/posts/${post.id}`, { method: "PATCH", body: payload })
        : await apiFetch<{ approvalUrl?: string | null }>("/api/content/posts", { method: "POST", body: payload });
      if (res.approvalUrl) {
        setApprovalLink(res.approvalUrl);
        toast.success("Saved as a draft. Send the approval link to your client.");
      } else {
        toast.success(draft ? "Draft saved" : post ? "Changes saved" : `Post scheduled for ${whenText}`);
        onDone();
      }
    } catch (e) {
      const message = friendlyMessage(e, "We could not save this post. Check your connection and try again.");
      setError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  if (approvalLink) {
    return (
      <div ref={approvalCard} tabIndex={-1} role="region" aria-label="Approval link ready" className="rounded-card">
        <Card title="Approval link ready" description="Send this link to your client by WhatsApp or email. They can approve with one tap, no login needed. The post is scheduled once they approve. We show the link only once, so copy it now.">
          <FormField label="Link for your client">
            <Input className="max-sm:text-base!" readOnly value={approvalLink} onFocus={(e) => e.currentTarget.select()} />
          </FormField>
          <div className="mt-4 flex flex-wrap gap-2">
            <CopyButton value={approvalLink} label="Copy link" size="md" />
            <Button variant="secondary" onClick={onDone}>
              Done
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <Card padded={false}>
      <div className={`grid gap-8 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] ${PHONE_TEXT}`}>
        <div className="space-y-8">
          <section aria-labelledby="c-where">
            <SectionTitle id="c-where" n={1} title="Where should it go?" help="Pick one or more accounts. One post goes to all of them." />
            {targets.loading ? (
              <div aria-hidden className="grid gap-2 sm:grid-cols-2">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : targets.error ? (
              <Alert tone="bad" action={<Button size="sm" variant="secondary" onClick={targets.reload}>Try again</Button>}>
                We could not load your accounts.
              </Alert>
            ) : options.length === 0 ? (
              <EmptyState
                compact
                title="No accounts connected yet"
                body="Connect a Facebook Page or Instagram account, then you can schedule posts to it."
                action={
                  <Link href="/app/settings/connections" className="inline-flex min-h-10 items-center rounded-full bg-accent px-5 text-sm font-semibold text-on-accent hover:bg-accent-strong">
                    Connect an account
                  </Link>
                }
              />
            ) : (
              <fieldset>
                <legend className="sr-only">Accounts to post to</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {options.map((o) => (
                    <ChoiceCard
                      key={o.id}
                      type="checkbox"
                      disabled={!o.available}
                      checked={assetIds.includes(o.id)}
                      onChange={(v) => setAssetIds((ids) => (v ? [...ids, o.id] : ids.filter((i) => i !== o.id)))}
                      title={o.name ?? "Account"}
                      help={
                        <span className="flex flex-wrap items-center gap-2">
                          {CHANNEL_NAME[o.channel]}
                          {!o.available && <Badge tone="warn">{o.channel === "threads" ? "Not available yet" : "Reconnect needed"}</Badge>}
                        </span>
                      }
                    />
                  ))}
                </div>
                {options.some((o) => !o.available && o.channel !== "threads") && (
                  <p className="mt-2 text-xs text-muted">
                    An account marked Reconnect needed lost its link to Meta. <Link className="underline" href="/app/settings/connections">Reconnect it in Settings</Link>.
                  </p>
                )}
              </fieldset>
            )}
          </section>

          <section aria-labelledby="c-what">
            <SectionTitle id="c-what" n={2} title="What do you want to say?" />
            <div className="space-y-4">
              <FormField label="Post text" hint={chosen.length > 0 ? `${chosen.map((o) => `${CHANNEL_NAME[o.channel]}: ${charCounter(o.channel, body).text}`).filter((v, i, a) => a.indexOf(v) === i).join(". ")}` : "Write what you want people to read."}>
                <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
              </FormField>
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium">
                  Picture or video <span className="ml-1 text-xs font-normal text-muted">{chosen.some((o) => o.channel === "instagram") ? "(Instagram needs one)" : "(optional)"}</span>
                </legend>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,video/mp4,video/quicktime"
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="Choose a picture or video from your device"
                  onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" loading={uploading} onClick={() => fileInput.current?.click()}>
                    {mediaKey ? "Choose a different file" : "Add a picture or video"}
                  </Button>
                  {mediaKey && (
                    <Button type="button" variant="ghost" onClick={() => setMediaKey(undefined)}>
                      Remove media
                    </Button>
                  )}
                </div>
                {mediaError ? (
                  <p role="alert" className="mt-1.5 text-xs font-medium text-bad-fg">
                    {mediaError}
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-muted">{MEDIA_LIMIT_TEXT} Instagram needs JPEG for pictures.</p>
                )}
                {(library.data?.media.length ?? 0) > 0 && (
                  <div className="mt-3">
                    <p className="mb-1.5 text-xs font-medium text-muted">Or use one you added before</p>
                    <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Your uploaded media">
                      {library.data!.media.slice(0, 24).map((m, i) => (
                        <li key={m.key} className="shrink-0">
                          <button
                            type="button"
                            onClick={() => setMediaKey(m.key)}
                            aria-pressed={mediaKey === m.key}
                            aria-label={`Use ${m.kind === "image" ? "picture" : "video"} ${i + 1}`}
                            className={cn("flex h-16 w-16 items-center justify-center overflow-hidden rounded-control border bg-surface text-xs", mediaKey === m.key ? "border-accent ring-2 ring-accent" : "border-border-strong")}
                          >
                            {m.kind === "image" ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={mediaUrl(m.key)} alt="" loading="lazy" className="h-full w-full object-cover" />
                            ) : (
                              <span>Video</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </fieldset>
            </div>
          </section>

          <section aria-labelledby="c-when">
            <SectionTitle id="c-when" n={3} title="When should it go out?" help="Pick a time that suits your audience, or choose your own." />
            <div className="space-y-4">
              <div role="group" aria-label="Quick times" className="flex flex-wrap gap-2">
                {slots.map((s) => (
                  <Button key={s.id} type="button" size="md" variant={when === s.value ? "primary" : "secondary"} aria-pressed={when === s.value} onClick={() => setWhen(s.value)}>
                    {s.label}
                  </Button>
                ))}
              </div>
              <FormField label="Or choose a date and time" hint="In your local time. You can schedule up to 90 days ahead." error={timeProblem && assetIds.length > 0 ? timeProblem : null}>
                <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              </FormField>
              <label className="flex min-h-10 cursor-pointer items-start gap-3 text-sm">
                <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-accent" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
                <span>
                  <span className="font-medium">Get approval first</span>
                  <span className="block text-muted">We save it as a draft and give you a link for your client. It is scheduled once they approve.</span>
                </span>
              </label>
            </div>
          </section>
        </div>

        <aside aria-label="Preview" className="lg:sticky lg:top-4 lg:self-start">
          <h2 className="mb-3 text-base font-semibold">How it will look</h2>
          {chosen.length === 0 || !activePreview ? (
            <p className="rounded-control border border-dashed border-border-strong p-4 text-sm text-muted">Choose an account to see a preview of your post.</p>
          ) : (
            <div className="space-y-3">
              {chosen.length > 1 && <Tabs label="Preview for" variant="pill" tabs={tabs} value={activePreview.id} onChange={setPreviewId} idPrefix="composer-preview" />}
              <div role={chosen.length > 1 ? "tabpanel" : undefined} id={chosen.length > 1 ? tabIds("composer-preview", activePreview.id).panel : undefined} aria-labelledby={chosen.length > 1 ? tabIds("composer-preview", activePreview.id).tab : undefined}>
                <ChannelPreview channel={activePreview.channel as Channel} account={activePreview.name ?? "Account"} body={body} mediaKey={mediaKey} whenText={whenText} />
              </div>
            </div>
          )}
        </aside>
      </div>

      {(problems.length > 0 || error) && (
        <div ref={errorBox} className="space-y-3 px-5 pb-4">
          {problems.length > 0 && (
            <Alert tone="warn" title="Fix these before you schedule">
              <ul className="list-disc pl-5">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          )}
          {error && <Alert tone="bad">{error}</Alert>}
        </div>
      )}

      <div className="sticky bottom-0 z-(--z-sticky) flex flex-wrap items-center gap-3 rounded-b-card border-t border-border bg-raised px-5 py-3">
        <Button type="button" loading={busy === "schedule"} disabled={!!busy || !!scheduleBlocker} onClick={() => void save(false)}>
          {approval ? "Save and get approval link" : post ? "Save changes" : "Schedule post"}
        </Button>
        <Button type="button" variant="secondary" loading={busy === "draft"} disabled={!!busy || !!draftBlocker} onClick={() => void save(true)}>
          Save as draft
        </Button>
        <Button type="button" variant="ghost" disabled={!!busy} onClick={onCancel}>
          Cancel
        </Button>
        <p role="status" className="min-w-0 flex-1 text-xs text-muted">
          {busy ? "" : [scheduleBlocker, draftNote].filter(Boolean).join(" ")}
        </p>
      </div>
    </Card>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import { Button, cn } from "@/components/ui";
import { EDDY_ID, openEddy } from "@/components/eddy/events";
import { splitMentions } from "@/lib/inbox/mentions";
import { bodyText } from "@/lib/inbox/template-vars";
import { Icon } from "./Avatar";
import { statusLabel, statusTicks } from "./helpers";
import type { Member, TemplateOption } from "./types";
import { documentName, documentTypeLabel, downloadFileName, failureHint, loadMediaBlob, mediaCaption, mediaPreview, type ChatMessage, type NoteItem } from "./ux";

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Ticks({ m }: { m: ChatMessage }) {
  const label = statusLabel(m.status);
  return (
    <span title={label} className={cn("ml-1.5 text-[11px] tracking-tighter", m.status === "read" && "text-[#e0f2fe]", m.status === "failed" && "font-semibold text-white")}>
      <span aria-hidden>{statusTicks(m.status)}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function MediaTile({ kind, caption }: { kind: string; caption?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-black/5 px-3 py-2 text-xs">
      <Icon name={kind === "video" ? "play" : "paperclip"} />
      <span>{caption ?? `${kind[0].toUpperCase()}${kind.slice(1)} received. Preview is not available.`}</span>
    </div>
  );
}

function MediaFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-black/5 px-3 py-2 text-xs">
      <span>Could not load this file.</span>
      <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-semibold underline">
        <Icon name="retry" className="h-3 w-3" /> Try again
      </button>
    </div>
  );
}

function DocumentLink({ src, name, type }: { src: string; name: string | null; type: string }) {
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const run = async () => {
    setState("loading");
    const blob = await loadMediaBlob(src);
    if (!blob) {
      setState("failed");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadFileName(name);
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setState("idle");
  };
  if (state === "failed") return <MediaFailed onRetry={() => void run()} />;
  return (
    <button type="button" onClick={() => void run()} disabled={state === "loading"} aria-busy={state === "loading"} className="flex items-center gap-2 rounded-lg bg-black/5 px-3 py-2 text-left text-xs underline disabled:opacity-60">
      <Icon name="paperclip" />
      <span className="min-w-0 break-words">{name ?? "Document"}</span>
      <span className="shrink-0 opacity-70">{state === "loading" ? "Loading..." : type}</span>
    </button>
  );
}

function Media({ m, onOpen }: { m: ChatMessage; onOpen: (src: string) => void }) {
  const preview = mediaPreview(m);
  const [broken, setBroken] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (!preview) return null;
  if (!preview.src) return <MediaTile kind={preview.kind} />;
  if (broken) return <MediaFailed onRetry={() => { setBroken(false); setAttempt((n) => n + 1); }} />;
  const src = preview.src;
  const fail = () => setBroken(true);
  if (preview.kind === "image") {
    return (
      <button type="button" aria-label="Open photo" onClick={() => onOpen(src)} className="block overflow-hidden rounded-lg focus-visible:outline-2 focus-visible:outline-accent">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={attempt} src={src} alt="Photo in the conversation" loading="lazy" decoding="async" onError={fail} className="max-h-64 max-w-full object-cover" />
      </button>
    );
  }
  if (preview.kind === "video") {
    return (
      <div className="relative">
        <video key={attempt} src={src} controls preload="metadata" onError={fail} className="max-h-64 max-w-full rounded-lg" />
        <button type="button" aria-label="Open video larger" onClick={() => onOpen(src)} className="absolute right-1 top-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">Expand</button>
      </div>
    );
  }
  if (preview.kind === "audio") return <audio key={attempt} src={src} controls preload="none" className="max-w-full" onError={fail} />;
  const name = documentName(m.body);
  const type = documentTypeLabel(preview.mime);
  return <DocumentLink key={attempt} src={src} name={name} type={type} />;
}

function TemplateBody({ m, templates }: { m: ChatMessage; templates: TemplateOption[] }) {
  const stored = m.body && !m.body.startsWith("[template]") ? m.body : null;
  const known = templates.find((t) => t.name === m.templateName);
  const text = stored ?? (known ? bodyText(known.components) : "");
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-80">
        <Icon name="template" className="h-3 w-3" /> Template{m.templateName ? `: ${m.templateName.replace(/_/g, " ")}` : ""}
      </p>
      {text ? <p className="whitespace-pre-wrap break-words">{text}</p> : <p className="text-xs opacity-80">Template message</p>}
    </div>
  );
}

/**
 * [Explain] on a failed bubble (docs/EDDY-SPEC.md 6.1, 6.7, 7.2 item 9, EDDY-15 acceptance 4): opens Eddy with an id-only
 * reference to the message. The error text and the message body never go into the member's chat: Eddy reads them with a
 * tool, so they arrive as untrusted data. Only messages the server stored have an id Eddy can look up.
 */
export function canExplain(m: Pick<ChatMessage, "status" | "local" | "id">): boolean {
  return m.status === "failed" && !m.local && typeof m.id === "string" && EDDY_ID.test(m.id);
}

export function explainWithEddy(m: Pick<ChatMessage, "id">, target?: Parameters<typeof openEddy>[1]): boolean {
  return openEddy({ ref: { kind: "message", messageId: m.id } }, target);
}

export function Bubble({
  m,
  first,
  last,
  templates,
  onOpenMedia,
  onRetry,
  onDiscard,
}: {
  m: ChatMessage;
  first: boolean;
  last: boolean;
  templates: TemplateOption[];
  onOpenMedia: (src: string) => void;
  onRetry: (m: ChatMessage) => void;
  onDiscard: (m: ChatMessage) => void;
}) {
  const out = m.direction === "outbound";
  const failed = m.status === "failed";
  const isTemplate = m.type === "template";
  const hasMedia = mediaPreview(m) !== null;
  const caption = isTemplate ? null : hasMedia ? mediaCaption(m.body) : m.body || null;
  const canResend = failed && m.type === "text" && !!m.body;
  return (
    <div className={cn("flex", out ? "justify-end" : "justify-start", first ? "mt-3" : "mt-0.5")}>
      <div className="max-w-[85%] sm:max-w-[70%]">
        <div
          className={cn(
            "px-3.5 py-2 text-sm",
            out ? "bg-accent text-white" : "border border-border bg-surface",
            failed && "bg-danger-strong",
            m.local && !failed && "opacity-70",
            first && last ? "rounded-2xl" : out ? cn("rounded-2xl", first ? "rounded-br-md" : last ? "rounded-tr-md" : "rounded-r-md") : cn("rounded-2xl", first ? "rounded-bl-md" : last ? "rounded-tl-md" : "rounded-l-md"),
          )}
        >
          {hasMedia && <div className={cn(caption && "mb-1.5")}><Media m={m} onOpen={onOpenMedia} /></div>}
          {isTemplate && <TemplateBody m={m} templates={templates} />}
          {caption && <p className="whitespace-pre-wrap break-words">{caption}</p>}
          {!isTemplate && !hasMedia && !caption && <p className="text-xs opacity-80">[{m.type}]</p>}
          {last && (
            <p className={cn("mt-1 text-right text-[11px]", out ? "text-white" : "text-muted")}>
              {timeOf(m.createdAt)}
              {out && <Ticks m={m} />}
            </p>
          )}
        </div>
        {failed && (
          <div role="alert" className="mt-1 flex flex-wrap items-center justify-end gap-2 text-xs text-red-800">
            <span>{m.localError ?? failureHint(m.errorCode)}</span>
            {m.local ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => onRetry(m)}><Icon name="retry" /> Retry</Button>
                <Button variant="ghost" size="sm" onClick={() => onDiscard(m)}>Discard</Button>
              </>
            ) : (
              canResend && <Button variant="secondary" size="sm" onClick={() => onRetry(m)}><Icon name="retry" /> Send again</Button>
            )}
            {canExplain(m) && (
              <Button variant="ghost" size="sm" aria-label="Explain why this message failed" onClick={() => explainWithEddy(m)} data-eddy-explain={m.id}>
                Explain
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The red line that marks where the unread messages start when a chat is opened. */
export function UnreadLine() {
  return (
    <div role="separator" aria-label="Unread messages start here" className="my-3 flex items-center gap-2 text-xs font-semibold text-bad-fg">
      <span aria-hidden className="h-px flex-1 bg-bad" />
      <span>Unread messages</span>
      <span aria-hidden className="h-px flex-1 bg-bad" />
    </div>
  );
}

export function NoteBubble({ note, author, first, last, onUndo, members = [] }: { note: NoteItem; author: string; first: boolean; last: boolean; onUndo: (note: NoteItem) => void; members?: Member[] }) {
  return (
    <div className={cn("mx-auto w-full max-w-[90%]", first ? "mt-3" : "mt-0.5")}>
      <div className={cn("border border-dashed border-amber-400 bg-amber-50 px-3.5 py-2 text-sm text-amber-950", first && last ? "rounded-2xl" : "rounded-xl", note.pending && "opacity-80")}>
        {first && (
          <p className="mb-0.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
            <Icon name="lock" className="h-3 w-3" /> Internal note, only your team sees this
          </p>
        )}
        <p className="whitespace-pre-wrap break-words">
          {splitMentions(note.body, members).map((part, i) =>
            part.mention ? <strong key={i} className="rounded bg-amber-200 px-0.5 font-semibold">{part.text}</strong> : <span key={i}>{part.text}</span>,
          )}
        </p>
        <p className="mt-1 flex items-center justify-between gap-2 text-[11px] text-amber-800">
          <span>{author}, {timeOf(note.createdAt)}</span>
          {note.pending && (
            <span className="flex items-center gap-2">
              <span>Saving...</span>
              <button type="button" onClick={() => onUndo(note)} className="inline-flex items-center gap-1 font-semibold underline">
                <Icon name="undo" className="h-3 w-3" /> Undo
              </button>
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

export type LightboxItem = { src: string; kind: "image" | "video" };

export function Lightbox({ items, index, onIndex, onClose }: { items: LightboxItem[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const item = items[index];
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndex]);
  if (!item) return null;
  return (
    <dialog ref={dialog} onClose={onClose} aria-label="Media viewer" className="m-0 h-dvh max-h-none w-dvw max-w-none bg-transparent p-0 backdrop:bg-black/85">
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-4" onClick={(e) => { if (e.target === e.currentTarget) dialog.current?.close(); }}>
        {item.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.src} alt="Photo, full size" className="max-h-[80dvh] max-w-full rounded-lg object-contain" />
        ) : (
          <video src={item.src} controls autoPlay className="max-h-[80dvh] max-w-full rounded-lg" />
        )}
        <div className="flex items-center gap-2 text-white">
          <Button variant="secondary" size="sm" onClick={() => onIndex(index - 1)} disabled={index === 0} aria-label="Previous">Previous</Button>
          <span className="text-xs" aria-live="polite">{index + 1} of {items.length}</span>
          <Button variant="secondary" size="sm" onClick={() => onIndex(index + 1)} disabled={index >= items.length - 1} aria-label="Next">Next</Button>
          <a className="rounded-full border border-white/40 px-3 py-1.5 text-xs font-semibold" href={item.src} target="_blank" rel="noopener noreferrer">Open original</a>
          <Button size="sm" autoFocus onClick={() => dialog.current?.close()}>Close</Button>
        </div>
      </div>
    </dialog>
  );
}

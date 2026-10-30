"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiFetch, Button, cn } from "@/components/ui";
import { EDDY_EVENTS, onEddyEvent, type EddyDraftDetail, type EddyOpenTemplatesDetail } from "@/components/eddy/events";
import type { AttachmentKind } from "@/lib/inbox/attachments";
import { mentionMatches, mentionQuery } from "@/lib/inbox/mentions";
import { inlineSendable } from "@/lib/inbox/template-vars";
import { renderReplyVariables } from "@/lib/inbox/variables";
import { formatWindowRemaining } from "./helpers";
import { Icon } from "./Avatar";
import { TemplatePanel } from "./TemplatePanel";
import type { Member, QuickReply, TemplateOption } from "./types";
import {
  draftKey,
  emojiMatches,
  emojiQuery,
  expandShortcodes,
  formatAgo,
  formatBytes,
  parseSendKey,
  readStore,
  SEND_KEY_KEY,
  slashMatches,
  validateAttachment,
  ALLOWED_UPLOADS,
  windowPercent,
  windowTone,
  wantsSend,
  writeStore,
  type SendKeyPref,
  type SentAttachment,
} from "./ux";

type Attachment = { key?: string; mediaId?: string; kind: AttachmentKind; name: string; bytes: number; mime: string; preview: string | null };
type Upload = { name: string; progress: number };
type Suggest = { state: "idle" } | { state: "loading" } | { state: "ready"; drafts: string[]; note: string | null } | { state: "error"; message: string };

export type ComposerProps = {
  conversationId: string;
  windowOpen: boolean;
  remainingMs: number;
  lastInboundAt: string | null;
  now: Date;
  disabled: boolean;
  contactName: string | null;
  contactPhone: string;
  /** The signed-in agent's name, for {{agent}} in quick replies. */
  agentName: string;
  members: Member[];
  templates: TemplateOption[] | null;
  templatesError: string | null;
  onReloadTemplates: () => void;
  onSendText: (body: string) => void;
  onSendMedia: (file: SentAttachment, caption: string) => Promise<void>;
  onSendTemplate: (templateId: string, variables: string[]) => Promise<void>;
  onAddNote: (body: string) => void;
  restore: { text: string; nonce: number } | null;
};

function WindowBar({ open, remainingMs, lastInboundAt, now }: { open: boolean; remainingMs: number; lastInboundAt: string | null; now: Date }) {
  const tone = windowTone(remainingMs);
  const closedAgo = lastInboundAt ? formatAgo(now.getTime() - new Date(lastInboundAt).getTime() - 24 * 3600_000) : null;
  if (!open || tone === "closed") {
    return (
      <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <Icon name="lock" className="mt-0.5" />
        <p>
          <span className="font-semibold">Template-only mode.</span> The 24-hour reply window {closedAgo ? `closed ${closedAgo}` : "is closed"}, so WhatsApp only allows an approved template now. When the customer replies, free typing comes back.
        </p>
      </div>
    );
  }
  return (
    <div role="status" className={cn("rounded-lg border px-3 py-1.5 text-xs", tone === "soon" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900")}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{tone === "soon" ? "Reply window closing soon" : "Reply window open"}</span>
        <span>{formatWindowRemaining(remainingMs)}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/10" aria-hidden>
        <div className={cn("h-full rounded-full", tone === "soon" ? "bg-amber-500" : "bg-emerald-600")} style={{ width: `${windowPercent(remainingMs)}%` }} />
      </div>
    </div>
  );
}

/**
 * Eddy's composer hooks (docs/EDDY-SPEC.md 4.6 draft_reply, EDDY-15 acceptance 1). A `wa:eddy-draft` puts Eddy's text into
 * the reply box of the chat it names, and only when that chat is the one open here; a `wa:eddy-open-templates` opens the
 * template picker for it (the 131047 fix). Neither ever sends: the member reads the draft and presses Send.
 */
export function eddyDraftFor(detail: EddyDraftDetail, conversationId: string): string | null {
  return detail.conversationId === conversationId && detail.text.trim() ? detail.text : null;
}

export function eddyOpensTemplatesFor(detail: EddyOpenTemplatesDetail, conversationId: string): boolean {
  return detail.conversationId === conversationId;
}

/** The composer's text after a draft arrives: an empty box takes the draft; otherwise it goes on a new line, once. */
export function withEddyDraft(current: string, draft: string): string {
  if (!current.trim()) return draft;
  return current.includes(draft) ? current : `${current.trimEnd()}\n${draft}`;
}

export function Composer(props: ComposerProps) {
  const { conversationId, windowOpen, disabled } = props;
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState(() => readStore(draftKey(conversationId)) ?? "");
  const [noteText, setNoteText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [replies, setReplies] = useState<QuickReply[] | null>(null);
  const [active, setActive] = useState(0);
  const [caret, setCaret] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTemplate, setPanelTemplate] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<Suggest>({ state: "idle" });
  const [sendKey, setSendKey] = useState<SendKeyPref>("enter");
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const latestText = useRef(text);

  const inReply = mode === "reply";
  const value = inReply ? text : noteText;
  const setValue = inReply ? setText : setNoteText;
  const templateOnly = inReply && !windowOpen;

  useEffect(() => setSendKey(parseSendKey(readStore(SEND_KEY_KEY))), []);

  useEffect(() => {
    latestText.current = text;
    const t = setTimeout(() => writeStore(draftKey(conversationId), text.trim() ? text : null), 300);
    return () => clearTimeout(t);
  }, [text, conversationId]);
  useEffect(() => () => writeStore(draftKey(conversationId), latestText.current.trim() ? latestText.current : null), [conversationId]);

  useEffect(() => {
    if (!props.restore) return;
    setMode("note");
    setNoteText(props.restore.text);
    area.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.restore?.nonce]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value, mode, templateOnly]);

  const slash = value.startsWith("/") && !/\s/.test(value);
  useEffect(() => {
    if (!slash || replies) return;
    apiFetch<{ items: QuickReply[] }>("/api/quick-replies").then((r) => setReplies(r.items), () => setReplies([]));
  }, [slash, replies]);

  const sendableTemplates = (props.templates ?? []).filter((t) => t.status === "approved" && inlineSendable(t.components).ok);
  const slashItems = slash ? slashMatches(value.slice(1), replies ?? [], inReply ? sendableTemplates : []) : [];
  const emoji = !slash ? emojiQuery(value, caret) : null;
  const emojiItems = emoji ? emojiMatches(emoji.query) : [];
  const mention = !inReply ? mentionQuery(value, caret) : null;
  const mentionItems = mention && emojiItems.length === 0 ? mentionMatches(mention.query, props.members) : [];
  const menuCount = slashItems.length || emojiItems.length || mentionItems.length;
  useEffect(() => setActive(0), [value, menuCount]);

  function focusArea() {
    requestAnimationFrame(() => area.current?.focus());
  }

  function pickSlash(i: number) {
    const item = slashItems[i];
    if (!item) return;
    if (item.kind === "reply") {
      const filled = renderReplyVariables(item.body, { contactName: props.contactName, phone: props.contactPhone, agentName: props.agentName });
      setValue(filled);
      pendingCaret.current = filled.length;
      focusArea();
    } else {
      setValue("");
      setPanelTemplate(item.id);
      setPanelOpen(true);
    }
  }

  function pickEmoji(i: number) {
    const item = emojiItems[i];
    if (!item || !emoji) return;
    const next = value.slice(0, emoji.start) + item.char + value.slice(caret);
    pendingCaret.current = emoji.start + item.char.length;
    setValue(next);
    focusArea();
  }

  function pickMention(i: number) {
    const item = mentionItems[i];
    if (!item || !mention) return;
    const insert = `@${item.name} `;
    pendingCaret.current = mention.start + insert.length;
    setValue(value.slice(0, mention.start) + insert + value.slice(caret));
    focusArea();
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const raw = e.target.value;
    const next = expandShortcodes(raw);
    const at = e.target.selectionStart - (raw.length - next.length);
    if (next !== raw) pendingCaret.current = at;
    setCaret(at);
    setValue(next);
  }

  function insertDraft(draft: string) {
    setText((cur) => withEddyDraft(cur, draft));
    setMode("reply");
    focusArea();
  }

  // Eddy's draft and template picker for this chat (EDDY-15). The listeners only fill the box or open the picker; they
  // never call send().
  const eddyDraft = useRef(insertDraft);
  useEffect(() => {
    eddyDraft.current = insertDraft;
  });
  useEffect(() => {
    const offDraft = onEddyEvent(EDDY_EVENTS.draft, (d) => {
      const draft = eddyDraftFor(d, conversationId);
      if (draft !== null) eddyDraft.current(draft);
    });
    const offTemplates = onEddyEvent(EDDY_EVENTS.openTemplates, (d) => {
      if (!eddyOpensTemplatesFor(d, conversationId)) return;
      setMode("reply");
      setPanelTemplate(null);
      setPanelOpen(true);
    });
    return () => {
      offDraft();
      offTemplates();
    };
  }, [conversationId]);

  async function send() {
    if (sending || disabled) return;
    setError(null);
    if (!inReply) {
      const body = noteText.trim();
      if (!body) return;
      setNoteText("");
      props.onAddNote(body);
      return;
    }
    if (!windowOpen) return;
    if (attachment) {
      setSending(true);
      try {
        await props.onSendMedia({ kind: attachment.kind, key: attachment.key, mediaId: attachment.mediaId, filename: attachment.name, mime: attachment.mime }, text.trim());
        setAttachment(null);
        setText("");
        writeStore(draftKey(conversationId), null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not send the attachment.");
      } finally {
        setSending(false);
      }
      return;
    }
    const body = text.trim();
    if (!body) return;
    setText("");
    writeStore(draftKey(conversationId), null);
    setSuggest({ state: "idle" });
    props.onSendText(body);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const items = slashItems.length || emojiItems.length || mentionItems.length;
    if (items > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % items); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + items) % items); return; }
      if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
        e.preventDefault();
        if (slashItems.length) pickSlash(active);
        else if (emojiItems.length) pickEmoji(active);
        else pickMention(active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (slashItems.length) setValue("");
        else setCaret(0);
        return;
      }
    }
    if (wantsSend({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing }, sendKey)) {
      e.preventDefault();
      void send();
    }
  }

  const startUpload = useCallback(
    (file: File) => {
      const problem = validateAttachment(file);
      if (problem) return setError(problem);
      setError(null);
      setUpload({ name: file.name, progress: 0 });
      const req = new XMLHttpRequest();
      xhr.current = req;
      req.open("POST", `/api/inbox/conversations/${conversationId}/attachments`);
      req.setRequestHeader("content-type", file.type);
      req.setRequestHeader("x-file-name", encodeURIComponent(file.name));
      req.upload.onprogress = (ev) => {
        if (ev.lengthComputable) setUpload({ name: file.name, progress: Math.round((ev.loaded / ev.total) * 100) });
      };
      req.onload = () => {
        xhr.current = null;
        setUpload(null);
        let json: { key?: string; mediaId?: string; kind?: string; bytes?: number; filename?: string; error?: string } = {};
        try {
          json = JSON.parse(req.responseText) as typeof json;
        } catch {
          json = {};
        }
        const kinds: string[] = ["image", "video", "audio", "document", "sticker"];
        if (req.status >= 200 && req.status < 300 && (json.key || json.mediaId) && json.kind && kinds.includes(json.kind)) {
          setAttachment({ key: json.key, mediaId: json.mediaId, kind: json.kind as AttachmentKind, name: file.name, bytes: json.bytes ?? file.size, mime: file.type, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
          focusArea();
        } else setError(json.error ?? "The upload failed. Check your connection and try again.");
      };
      req.onerror = () => {
        xhr.current = null;
        setUpload(null);
        setError("The upload failed. Check your connection and try again.");
      };
      req.onabort = () => setUpload(null);
      req.send(file);
    },
    [conversationId],
  );

  useEffect(() => () => xhr.current?.abort(), []);
  useEffect(() => () => { if (attachment?.preview) URL.revokeObjectURL(attachment.preview); }, [attachment]);

  async function askForSuggestions() {
    setSuggest({ state: "loading" });
    try {
      const r = await apiFetch<{ drafts: string[]; handoff: boolean; grounded: boolean; agentName: string | null }>(`/api/inbox/conversations/${conversationId}/suggest`, { method: "POST", body: {} });
      if (r.drafts.length === 0) {
        setSuggest({ state: "error", message: r.handoff ? "There is not enough information to suggest a reply. Write one yourself, or add the answer to your AI agent's knowledge." : "No suggestion this time. Try again." });
      } else {
        setSuggest({ state: "ready", drafts: r.drafts, note: r.grounded ? `Based on ${r.agentName ?? "your AI agent"} knowledge` : "General drafts, check the facts" });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setSuggest({ state: "error", message: /not configured/i.test(message) ? "AI suggestions are not switched on for this workspace yet. Ask an admin to set up AI." : message || "Could not get suggestions." });
    }
  }

  async function sendTemplate(templateId: string, variables: string[]) {
    await props.onSendTemplate(templateId, variables);
    setPanelOpen(false);
    setPanelTemplate(null);
  }

  const canSend = !disabled && !sending && !upload && (inReply ? windowOpen && (attachment !== null || text.trim().length > 0) : noteText.trim().length > 0);
  const showTemplates = templateOnly || (inReply && panelOpen);

  return (
    <div className="relative space-y-2 border-t border-border bg-background p-3">
      <WindowBar open={windowOpen} remainingMs={props.remainingMs} lastInboundAt={props.lastInboundAt} now={props.now} />

      <div className="flex items-center justify-between gap-2">
        <div role="group" aria-label="Message type" className="inline-flex rounded-full border border-border p-0.5 text-xs font-medium">
          <button type="button" aria-pressed={inReply} onClick={() => setMode("reply")} className={cn("rounded-full px-3 py-1", inReply ? "bg-accent text-white" : "hover:bg-surface")}>Reply</button>
          <button type="button" aria-pressed={!inReply} onClick={() => setMode("note")} className={cn("rounded-full px-3 py-1", !inReply ? "bg-amber-700 text-white" : "hover:bg-surface")}>Internal note</button>
        </div>
        {inReply && windowOpen && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => void askForSuggestions()} disabled={disabled || suggest.state === "loading"} title="Draft replies with AI. You review and edit before sending.">
              <Icon name="sparkle" /> Suggest reply
            </Button>
            <Button variant="ghost" size="sm" aria-expanded={panelOpen} onClick={() => { setPanelTemplate(null); setPanelOpen((v) => !v); }} title="Send an approved template">
              <Icon name="template" /> Template
            </Button>
          </div>
        )}
      </div>

      {inReply && suggest.state !== "idle" && (
        <div aria-live="polite" className="rounded-lg border border-border bg-surface p-2">
          {suggest.state === "loading" && <p className="text-xs text-muted">Writing suggestions...</p>}
          {suggest.state === "error" && (
            <p className="flex items-start justify-between gap-2 text-xs text-muted">
              <span>{suggest.message}</span>
              <button type="button" className="shrink-0 font-semibold underline" onClick={() => setSuggest({ state: "idle" })}>Dismiss</button>
            </p>
          )}
          {suggest.state === "ready" && (
            <>
              <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted">
                <span>{suggest.note}. Click one to edit it before sending.</span>
                <button type="button" className="shrink-0 font-semibold underline" onClick={() => setSuggest({ state: "idle" })}>Dismiss</button>
              </div>
              <ul className="flex flex-col gap-1.5">
                {suggest.drafts.map((d) => (
                  <li key={d}>
                    <button type="button" onClick={() => insertDraft(d)} title={d} className="line-clamp-3 w-full rounded-xl border border-border bg-background px-3 py-1.5 text-left text-xs hover:border-accent">
                      {d}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {showTemplates && (
        <div className="rounded-lg border border-border p-2">
          <TemplatePanel
            templates={props.templates}
            error={props.templatesError}
            onRetry={props.onReloadTemplates}
            initialId={panelTemplate}
            contactName={props.contactName}
            onSend={sendTemplate}
            onCancel={templateOnly ? undefined : () => { setPanelOpen(false); setPanelTemplate(null); }}
          />
        </div>
      )}

      {(attachment || upload) && inReply && (
        <div className="flex items-center gap-3 rounded-lg border border-border p-2 text-xs">
          {attachment?.preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={attachment.preview} alt="" className="h-12 w-12 rounded-md object-cover" />
          ) : (
            <span className="flex h-12 w-12 items-center justify-center rounded-md bg-surface"><Icon name="play" /></span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{attachment?.name ?? upload?.name}</p>
            {upload ? (
              <div className="mt-1" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={upload.progress}>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface"><div className="h-full bg-accent transition-all" style={{ width: `${upload.progress}%` }} /></div>
                <span className="text-muted">Uploading {upload.progress}%</span>
              </div>
            ) : (
              <p className="text-muted">{attachment && formatBytes(attachment.bytes)}. {attachment && (attachment.kind === "audio" || attachment.kind === "sticker") ? "Press send when you are ready." : "Type a caption below, then send."}</p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => { if (upload) xhr.current?.abort(); setAttachment(null); }}>{upload ? "Cancel" : "Remove"}</Button>
        </div>
      )}

      {!templateOnly && (
        <div className="relative">
          {(slashItems.length > 0 || emojiItems.length > 0 || mentionItems.length > 0) && (
            <ul role="listbox" aria-label={slashItems.length ? "Quick replies and templates" : emojiItems.length ? "Emoji" : "Teammates to mention"} className="absolute inset-x-0 bottom-full z-10 mb-1 max-h-52 overflow-y-auto rounded-xl border border-border bg-background shadow-lg">
              {/* The option itself is the clickable thing: a button inside role=option is a nested control. Keyboard picks happen in the textarea. */}
              {slashItems.length > 0
                ? slashItems.map((item, i) => (
                    <li
                      key={`${item.kind}:${item.id}`}
                      role="option"
                      aria-selected={i === active}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickSlash(i)}
                      className={cn("flex w-full cursor-pointer items-baseline gap-2 px-3 py-2 text-left text-sm", i === active && "bg-surface")}
                    >
                      <span className="shrink-0 font-semibold">{item.label}</span>
                      <span className="truncate text-muted">{item.detail}</span>
                    </li>
                  ))
                : emojiItems.length > 0
                  ? emojiItems.map((item, i) => (
                    <li
                      key={item.name}
                      role="option"
                      aria-selected={i === active}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickEmoji(i)}
                      className={cn("flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm", i === active && "bg-surface")}
                    >
                      <span aria-hidden>{item.char}</span>
                      <span className="text-muted">:{item.name}:</span>
                    </li>
                  ))
                  : mentionItems.map((item, i) => (
                    <li
                      key={item.userId}
                      role="option"
                      aria-selected={i === active}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickMention(i)}
                      className={cn("flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm", i === active && "bg-surface")}
                    >
                      <span className="font-medium">@{item.name}</span>
                      <span className="text-muted">gets a notice</span>
                    </li>
                  ))}
            </ul>
          )}
          <div className={cn("flex items-end gap-2 rounded-2xl border p-2", inReply ? "border-border bg-background" : "border-amber-300 bg-amber-50")}>
            {inReply && (
              <>
                <input ref={fileInput} type="file" aria-label="Attach file" aria-hidden="true" className="sr-only" tabIndex={-1} accept={ALLOWED_UPLOADS.join(",")} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) startUpload(f); }} />
                <Button variant="ghost" size="sm" aria-label="Attach a photo, video, document or audio file" onClick={() => fileInput.current?.click()} disabled={disabled || !!upload || !!attachment}>
                  <Icon name="paperclip" />
                </Button>
              </>
            )}
            <textarea
              id="inbox-composer"
              ref={area}
              rows={1}
              aria-label={inReply ? "Message" : "Internal note"}
              aria-describedby="inbox-composer-hint"
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm placeholder:text-muted focus:outline-none"
              placeholder={inReply ? "Type a message, / for quick replies and templates, :smile: for emoji" : "Private note. Only your team sees it. Type @ to mention a teammate."}
              value={value}
              disabled={disabled}
              maxLength={inReply ? 4096 : 4000}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onPaste={(e) => {
                const file = inReply ? e.clipboardData.files[0] : undefined;
                if (file && file.type.startsWith("image/")) { e.preventDefault(); startUpload(file); }
              }}
            />
            <Button size="sm" onClick={() => void send()} disabled={!canSend} className={cn(!inReply && "bg-amber-700 hover:brightness-90")}>
              <Icon name={inReply ? "send" : "note"} /> {sending ? "Sending" : inReply ? "Send" : "Add note"}
            </Button>
          </div>
          <p id="inbox-composer-hint" className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
            <span>{sendKey === "enter" ? "Enter sends, Shift+Enter adds a line." : "Ctrl+Enter sends, Enter adds a line."}</span>
            <button type="button" className="underline" aria-label={`Use ${sendKey === "enter" ? "Ctrl+Enter" : "Enter"} to send`} onClick={() => { const next = sendKey === "enter" ? "mod-enter" : "enter"; setSendKey(next); writeStore(SEND_KEY_KEY, next); }}>
              Use {sendKey === "enter" ? "Ctrl+Enter" : "Enter"} to send
            </button>
          </p>
        </div>
      )}

      {templateOnly && (
        <p className="text-xs text-muted">
          Need to leave a private message for your team? Switch to <button type="button" className="font-semibold underline" onClick={() => setMode("note")}>Internal note</button>.
        </p>
      )}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

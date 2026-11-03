import { ACCEPTED_ATTACHMENT_TYPES, attachmentProblem, type AttachmentKind } from "@/lib/inbox/attachments";
import { dayLabel, truncatePreview, WINDOW_MS, type InboxMessage } from "./helpers";

/* ---------- storage (every access can throw in private windows) ---------- */

export function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the feature simply does not persist
  }
}

export const UNREAD_REFRESH_EVENT = "wa:unread-refresh";

/** Tells the app shell the number of chats with unread messages, or, without a count, to fetch it again. */
export function notifyUnreadRefresh(count?: number): void {
  try {
    window.dispatchEvent(new CustomEvent(UNREAD_REFRESH_EVENT, { detail: typeof count === "number" ? { count } : null }));
  } catch {
    // not in a browser
  }
}

/** The count carried by a `wa:unread-refresh` event, or null when the sender did not know it and the shell must fetch. */
export function unreadCountFrom(event: Event): number | null {
  const detail = (event as Partial<CustomEvent<unknown>>).detail;
  if (!detail || typeof detail !== "object") return null;
  const count = (detail as { count?: unknown }).count;
  return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null;
}

export const LIST_WIDTH_KEY = "inbox:list-width";
export const PANEL_KEY = "inbox:panel-open";
export const SEND_KEY_KEY = "inbox:send-key";
export const draftKey = (conversationId: string) => `inbox:draft:${conversationId}`;

export const LIST_MIN = 260;
export const LIST_MAX = 520;
export const LIST_DEFAULT = 336;

export function clampListWidth(width: number): number {
  if (!Number.isFinite(width)) return LIST_DEFAULT;
  return Math.min(Math.max(Math.round(width), LIST_MIN), LIST_MAX);
}

export function parseStoredWidth(raw: string | null): number {
  if (raw === null || raw.trim() === "") return LIST_DEFAULT;
  return clampListWidth(Number(raw));
}

/* ---------- avatars ---------- */

export function hashString(value: string): number {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  return h;
}

/** A stable colour pair per id, readable text on a soft background. */
export function avatarColor(id: string): { background: string; color: string } {
  const hue = hashString(id) % 360;
  return { background: `hsl(${hue} 60% 90%)`, color: `hsl(${hue} 55% 24%)` };
}

export function initials(name: string | null | undefined, fallback = ""): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length === 0 ? [] : words.length === 1 ? [Array.from(words[0])[0]] : [Array.from(words[0])[0], Array.from(words[words.length - 1])[0]];
  const text = letters.join("").toUpperCase();
  if (text && /[\p{L}\p{N}]/u.test(text)) return text;
  if (fallback.startsWith("@")) {
    const letter = Array.from(fallback.slice(1))[0];
    if (letter && /[\p{L}\p{N}]/u.test(letter)) return letter.toUpperCase();
  }
  const digits = fallback.replace(/\D/g, "");
  return digits ? digits.slice(-2) : "#";
}

/* ---------- windowed rendering ---------- */

export const ROW_HEIGHT = 92;

export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 6): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(scrollTop, 0) / rowHeight);
  const last = Math.ceil((Math.max(scrollTop, 0) + Math.max(viewport, 0)) / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}

/** The scrollTop that brings a row fully into view, or the current one when it already is. */
export function scrollTopFor(index: number, scrollTop: number, viewport: number, rowHeight: number): number {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewport) return bottom - viewport;
  return scrollTop;
}

/* ---------- search highlighting ---------- */

export type Part = { text: string; match: boolean };

export function highlightParts(text: string, query: string): Part[] {
  const q = query.trim();
  if (!q || !text) return [{ text, match: false }];
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index === undefined || m[0] === "") continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index), match: false });
    parts.push({ text: m[0], match: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

/* ---------- list previews ---------- */

type PreviewSource = { direction: string; type: string; body: string | null };

const TYPE_LABEL: Record<string, string> = { image: "Photo", video: "Video", audio: "Voice message", document: "Document", sticker: "Sticker", location: "Location", contacts: "Contact card", order: "Order" };
/** The "[image]", "[document: name]", "[contacts]" or "[order]" label the webhook stores in front of the text; the preview names the type itself. */
const STORED_LABEL = /^\[[a-z_]+(?:: [^\]\r\n]*)?\]\s*/;

export function previewText(m: PreviewSource | undefined): string {
  if (!m) return "No messages yet";
  const prefix = m.direction === "outbound" ? "You: " : "";
  if (m.type === "template") return `${prefix}${truncatePreview(m.body?.replace(/^\[template\]\s*/, "") || "Template message")}`;
  const label = TYPE_LABEL[m.type];
  const body = truncatePreview(label ? m.body?.replace(STORED_LABEL, "") : m.body);
  if (label) return `${prefix}${label}${body ? `: ${body}` : ""}`;
  return `${prefix}${body || `[${m.type}]`}`;
}

/* ---------- timeline: messages and notes, day separators, grouping ---------- */

export type ChatMessage = InboxMessage & { local?: boolean; localError?: string };
export type NoteItem = { id: string; authorId: string; body: string; createdAt: string; pending?: boolean };

export type TimelineEntry =
  | { kind: "message"; id: string; at: number; message: ChatMessage; first: boolean; last: boolean }
  | { kind: "note"; id: string; at: number; note: NoteItem; first: boolean; last: boolean };

export type TimelineDay = { key: string; label: string; entries: TimelineEntry[] };

export const GROUP_GAP_MS = 3 * 60_000;

const dayKeyOf = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const senderOf = (e: TimelineEntry) => (e.kind === "message" ? `m:${e.message.direction}` : `n:${e.note.authorId}`);

export function buildTimeline(messages: ChatMessage[], notes: NoteItem[], now: Date = new Date()): TimelineDay[] {
  const entries: TimelineEntry[] = [
    ...messages.map((message): TimelineEntry => ({ kind: "message", id: message.id, at: new Date(message.createdAt).getTime(), message, first: true, last: true })),
    ...notes.map((note): TimelineEntry => ({ kind: "note", id: `note:${note.id}`, at: new Date(note.createdAt).getTime(), note, first: true, last: true })),
  ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  const days: TimelineDay[] = [];
  for (const entry of entries) {
    const date = new Date(entry.at);
    const key = dayKeyOf(date);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(date, now), entries: [] };
      days.push(day);
    }
    const prev = day.entries[day.entries.length - 1];
    if (prev && senderOf(prev) === senderOf(entry) && entry.at - prev.at <= GROUP_GAP_MS) {
      prev.last = false;
      entry.first = false;
    }
    day.entries.push(entry);
  }
  return days;
}

/** Newest inbound message after the first load, for the screen-reader announcement. */
export function newInbound(prevIds: Set<string>, messages: Pick<InboxMessage, "id" | "direction" | "body" | "type">[]): { id: string; text: string } | null {
  const fresh = messages.filter((m) => m.direction === "inbound" && !prevIds.has(m.id));
  const last = fresh[fresh.length - 1];
  return last ? { id: last.id, text: previewText(last) } : null;
}

/* ---------- media ---------- */

export type MediaPreview = { kind: "image" | "video" | "audio" | "document"; src: string | null; mime: string | null };

const UPLOADED = /\/api\/content\/media-public\/[A-Za-z0-9_-]+\/([a-f0-9]{32}\.(?:jpg|png|mp4|mov))(?:\?|$)/;
const META_REF = /^meta-media:[A-Za-z0-9_-]{1,64}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The tenant-checked proxy route for the media of one message. */
export const inboundMediaSrc = (messageId: string) => `/api/inbox/media/${encodeURIComponent(messageId)}`;

/**
 * Where an authenticated viewer can load a message's media. Files sent from the media library (and inbox photos and videos
 * sent before attachments went straight to WhatsApp) use the tenant-checked library route, since the signed link expires;
 * https links load directly; Meta media ids, which every inbox attachment now is, load through the inbox media proxy, which
 * needs the message id.
 */
export function mediaPreview(m: Pick<InboxMessage, "type" | "mediaUrl" | "mediaMime"> & { id?: string }): MediaPreview | null {
  const kind = m.type === "sticker" ? "image" : m.type;
  if (kind !== "image" && kind !== "video" && kind !== "audio" && kind !== "document") return null;
  const url = m.mediaUrl ?? "";
  const uploaded = UPLOADED.exec(url);
  let src: string | null = null;
  if (uploaded) src = `/api/content/media/${uploaded[1]}`;
  else if (/^https:\/\//i.test(url)) src = url;
  else if (META_REF.test(url) && m.id && MESSAGE_ID.test(m.id)) src = inboundMediaSrc(m.id);
  return { kind, src, mime: m.mediaMime };
}

const DOC_LABEL: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "Word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/vnd.ms-excel": "Excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "application/vnd.ms-powerpoint": "PowerPoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
  "text/plain": "Text",
  "text/csv": "CSV",
};

/** A short type label for a document download, such as "PDF". */
export function documentTypeLabel(mime: string | null | undefined): string {
  return DOC_LABEL[(mime ?? "").split(";")[0].trim().toLowerCase()] ?? "File";
}

/** The customer's own caption: the "[image]" or "[document: name]" label the webhook stores in front of it is dropped. */
export function mediaCaption(body: string | null | undefined): string | null {
  const text = (body ?? "").replace(/^\[(?:image|video|audio|document|sticker)(?:: [^\]\r\n]*)?\]\s*/, "").trim();
  return text || null;
}

/** The file name WhatsApp reported for a document, taken from the stored body "[document: name.pdf] caption". */
export function documentName(body: string | null | undefined): string | null {
  const m = /^\[document: ([^\]\r\n]{1,200})\]/.exec(body ?? "");
  return m ? m[1].trim() || null : null;
}

/** A safe download name: the name WhatsApp reported with path characters and control characters removed, or a plain fallback. */
export function downloadFileName(name: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  const clean = (name ?? "").replace(/[\x00-\x1f\\/:*?"<>|]+/g, "_").trim().slice(0, 150);
  return clean && clean !== "." && clean !== ".." ? clean : "document";
}

/**
 * Fetches a proxied file as a blob. Returns null for anything but a successful response, so a JSON error body from the
 * proxy (404, 413, 429, 502) is never saved as if it were the document.
 */
export async function loadMediaBlob(src: string, fetchImpl: typeof fetch = fetch): Promise<Blob | null> {
  try {
    const res = await fetchImpl(src, { credentials: "same-origin" });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    return await res.blob();
  } catch {
    return null;
  }
}

/** What the file picker offers: every type WhatsApp accepts (see lib/inbox/attachments.ts for the limits). */
export const ALLOWED_UPLOADS = ACCEPTED_ATTACHMENT_TYPES;

/** An uploaded file ready to send: the WhatsApp media id POST ../attachments returned, whatever the file type. */
export type SentAttachment = { kind: AttachmentKind; mediaId: string; filename?: string; mime?: string };

/* ---------- templates a chat can send ---------- */

/** The WhatsApp Business Account an API row (a business number, a template) belongs to, when the row says. */
export function wabaOf(row: unknown): string | null {
  const id = row && typeof row === "object" ? (row as { wabaRefId?: unknown }).wabaRefId : null;
  return typeof id === "string" && id ? id : null;
}

/**
 * The templates a number can send: those of its own WhatsApp Business Account, since WhatsApp refuses a template that exists
 * only under another account (error 132001). While the number's account is not known nothing is hidden; the server refuses a
 * mismatch either way (lib/inbox/template-send.ts).
 */
export function templatesForWaba<T>(templates: T[] | null, wabaRefId: string | null): T[] | null {
  if (!templates || !wabaRefId) return templates;
  return templates.filter((t) => {
    const own = wabaOf(t);
    return own === null || own === wabaRefId;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${Number((bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0))} MB`;
}

export function validateAttachment(file: { type: string; size: number }): string | null {
  return attachmentProblem(file);
}

/* ---------- delivery failures ---------- */

const FAILURE_HINTS: Record<string, string> = {
  "131047": "The 24-hour window had closed. Send a template message instead.",
  "131026": "This number cannot receive WhatsApp messages, or has not accepted the latest terms.",
  "131049": "WhatsApp chose not to deliver this message to protect recipients from unwanted messages.",
  "131048": "Sending is paused because too many recipients reported messages as spam.",
  "131056": "Too many messages were sent to this customer in a short time. Wait a moment and try again.",
  "131051": "WhatsApp does not support this message type.",
  "131053": "The attachment could not be processed. Check its format and size.",
  "132001": "This template no longer exists. Pick another.",
  "132015": "This template is paused. Pick another.",
  "132016": "This template is disabled. Pick another.",
  "190": "The WhatsApp connection has expired, so nothing can be sent. An owner or admin needs to reconnect WhatsApp in Settings.",
  auth_expired: "The WhatsApp connection has expired, so nothing can be sent. An owner or admin needs to reconnect WhatsApp in Settings.",
  send_unconfirmed: "We could not confirm delivery. Check the customer's phone before sending again.",
  send_error: "The message could not be sent. Try again.",
  no_recipient: "This contact has no phone number or WhatsApp user id, so there is nobody to send to.",
  bsuid_auth_template: "Login code templates need a phone number. This contact uses a WhatsApp username and has not shared theirs.",
  // Codes the app itself sets while a message waits in the queue.
  tenant_blocked: "This workspace was suspended or read-only while the message waited, so it was never sent.",
  opted_out: "This contact sent STOP or was marked opted out, so marketing templates are not sent to them. Order updates and replies to their own messages still go.",
  // More WhatsApp codes (same wording as the broadcast report where it already had one).
  "131050": "This person chose to stop receiving marketing messages.",
  "130429": "Sending was too fast, so WhatsApp refused this message.",
  "130472": "WhatsApp chose not to deliver this marketing message to this person.",
  "130497": "WhatsApp does not allow this business to send marketing messages to this country.",
  "131042": "There is a payment problem on the WhatsApp Business account.",
  "132000": "The template values did not match the template.",
  "132005": "The translated template text is too long.",
  "132012": "A template value was in the wrong format.",
  "131000": "WhatsApp had an unknown problem sending this message. Try again in a minute; if it keeps failing, contact support.",
  "131005": "The WhatsApp connection no longer has permission to send messages. Reconnect WhatsApp in Settings and approve all permissions.",
  "131008": "The message was sent without a required detail. This is a problem on our side; report it.",
  "131009": "A value in the message is not valid. Check that the recipient number is in full international format.",
  "131016": "WhatsApp's service is temporarily down. Wait and try again later.",
  "131021": "The recipient is this business number itself. Send to a different number, for example a personal one.",
  "131031": "This WhatsApp business account is locked, for a policy issue or a wrong two-step PIN. Open WhatsApp Manager to see why.",
  "131037": "The business display name has not been approved by WhatsApp yet. Submit or correct it in WhatsApp Manager.",
  "131045": "This phone number's registration with WhatsApp is incomplete. Re-register the number in setup and try again.",
  "131052": "WhatsApp could not fetch an attachment the customer sent. Ask them to resend it.",
  "131054": "WhatsApp returned an error it does not document (131054). Try once more; if it keeps happening, contact Meta support.",
  "131057": "This WhatsApp business account is being maintained or upgraded by Meta right now. Wait a short while and try again.",
  "131058": "WhatsApp returned an error it does not document (131058). It happened on a template send, so pick a template that shows as approved for this workspace and try again; if it keeps happening, contact Meta support.",
  "133010": "This business phone number is not registered with WhatsApp's API yet. Finish registering it (two-step PIN) in setup.",
  "135000": "WhatsApp rejected the message for an unspecified reason. Try a different approved template; if it keeps happening, contact support.",
  "100": "Something in the message request was malformed. This is a problem on our side, not yours.",
  "368": "Meta has temporarily blocked this account for a policy violation. Check the notice in WhatsApp Manager.",
  "80007": "You are sending faster than WhatsApp allows right now. Wait a little and try again.",
};

export const UNKNOWN_FAILURE_HINT = "The message could not be delivered.";

export function failureHint(code: string | null | undefined): string {
  return (code && FAILURE_HINTS[code]) || UNKNOWN_FAILURE_HINT;
}

/* ---------- 24-hour window ---------- */

export type WindowTone = "ok" | "soon" | "closed";

export const SOON_MS = 2 * 60 * 60 * 1000;

export function windowTone(remainingMs: number): WindowTone {
  if (remainingMs <= 0) return "closed";
  return remainingMs <= SOON_MS ? "soon" : "ok";
}

export const windowPercent = (remainingMs: number) => Math.round((Math.min(Math.max(remainingMs, 0), WINDOW_MS) / WINDOW_MS) * 100);

export function formatAgo(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/* ---------- composer ---------- */

export type SendKeyPref = "enter" | "mod-enter";

export const parseSendKey = (raw: string | null): SendKeyPref => (raw === "mod-enter" ? "mod-enter" : "enter");

export function wantsSend(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean }, pref: SendKeyPref): boolean {
  if (e.key !== "Enter" || e.isComposing) return false;
  if (e.ctrlKey || e.metaKey) return true;
  return pref === "enter" && !e.shiftKey;
}

export const EMOJI: Record<string, string> = {
  smile: "\u{1F604}",
  grin: "\u{1F601}",
  joy: "\u{1F602}",
  wink: "\u{1F609}",
  blush: "\u{1F60A}",
  heart: "\u2764\uFE0F",
  heart_eyes: "\u{1F60D}",
  thumbsup: "\u{1F44D}",
  thumbsdown: "\u{1F44E}",
  "+1": "\u{1F44D}",
  ok: "\u{1F44C}",
  clap: "\u{1F44F}",
  pray: "\u{1F64F}",
  wave: "\u{1F44B}",
  tada: "\u{1F389}",
  party: "\u{1F973}",
  fire: "\u{1F525}",
  star: "\u2B50",
  sparkles: "\u2728",
  check: "\u2705",
  done: "\u2705",
  x: "\u274C",
  warning: "\u26A0\uFE0F",
  thinking: "\u{1F914}",
  sad: "\u{1F622}",
  sorry: "\u{1F64F}",
  cry: "\u{1F62D}",
  sunglasses: "\u{1F60E}",
  muscle: "\u{1F4AA}",
  eyes: "\u{1F440}",
  rocket: "\u{1F680}",
  gift: "\u{1F381}",
  phone: "\u{1F4F1}",
  mail: "\u2709\uFE0F",
  calendar: "\u{1F4C5}",
  clock: "\u{1F552}",
  money: "\u{1F4B0}",
  package: "\u{1F4E6}",
  truck: "\u{1F69A}",
  house: "\u{1F3E0}",
  pin: "\u{1F4CD}",
  hundred: "\u{1F4AF}",
  coffee: "\u2615",
  sun: "\u2600\uFE0F",
  thanks: "\u{1F64F}",
  handshake: "\u{1F91D}",
  point_right: "\u{1F449}",
  smiley: "\u{1F603}",
};

const SHORTCODE = /(^|[^\w:/])(:([a-z0-9_+]{2,20}):)/g;

/** Turns complete :name: tokens into emoji. Unknown names and things like URLs are left alone. */
export function expandShortcodes(text: string): string {
  return text.replace(SHORTCODE, (match, pre: string, _token: string, name: string) => (EMOJI[name] ? `${pre}${EMOJI[name]}` : match));
}

/** The unfinished :query right before the caret, if any. */
export function emojiQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^\w:/]):([a-z0-9_+]{2,20})$/.exec(before);
  return m ? { query: m[2], start: before.length - m[2].length - 1 } : null;
}

export function emojiMatches(query: string, limit = 6): { name: string; char: string }[] {
  const q = query.toLowerCase();
  const names = Object.keys(EMOJI);
  const starts = names.filter((n) => n.startsWith(q));
  const contains = names.filter((n) => !n.startsWith(q) && n.includes(q));
  return [...starts, ...contains].slice(0, limit).map((name) => ({ name, char: EMOJI[name] }));
}

export type SlashItem =
  | { kind: "reply"; id: string; label: string; detail: string; body: string }
  | { kind: "template"; id: string; label: string; detail: string };

/** Quick replies by shortcut prefix first, then templates by name; the query is whatever follows the "/". */
export function slashMatches(
  query: string,
  replies: { id: string; shortcut: string; body: string }[],
  templates: { id: string; name: string }[],
  limit = 8,
): SlashItem[] {
  const q = query.toLowerCase();
  const fromReplies = replies
    .filter((r) => r.shortcut.includes(q))
    .sort((a, b) => Number(b.shortcut.startsWith(q)) - Number(a.shortcut.startsWith(q)) || a.shortcut.localeCompare(b.shortcut))
    .map((r): SlashItem => ({ kind: "reply", id: r.id, label: `/${r.shortcut}`, detail: truncatePreview(r.body, 70), body: r.body }));
  const fromTemplates = templates
    .filter((t) => t.name.includes(q))
    .map((t): SlashItem => ({ kind: "template", id: t.id, label: t.name.replace(/_/g, " "), detail: "Template" }));
  return [...fromReplies, ...fromTemplates].slice(0, limit);
}

/* ---------- side panel ---------- */

export type AdSource = { headline: string | null; sourceType: string | null; sourceId: string | null; sourceUrl: string | null };

const short = (value: unknown, max = 200): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** Click-to-WhatsApp referral, reduced to what an agent should see. Only https links are kept; the click id is internal. */
export function parseReferral(raw: unknown): AdSource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const url = short(r.sourceUrl, 500);
  const out: AdSource = { headline: short(r.headline), sourceType: short(r.sourceType, 40), sourceId: short(r.sourceId, 80), sourceUrl: url && /^https:\/\//i.test(url) ? url : null };
  return out.headline || out.sourceType || out.sourceId || out.sourceUrl ? out : null;
}

/** Attribute values for display; objects and empty values are skipped. */
export function attributeRows(attributes: unknown): { key: string; value: string }[] {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return [];
  return Object.entries(attributes as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([key, v]) => ({ key, value: String(v) }))
    .filter((r) => r.value.trim() !== "")
    .slice(0, 50);
}

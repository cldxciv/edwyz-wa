"use client";

/**
 * Eddy's turn stream (docs/EDDY-SPEC.md 5.12, 6.3, 6.4, 6.11, 9.4 scenario 12).
 *
 * - `postTurn()` POSTs `{text, page, conversationId?, ref?}` to /api/eddy/turn and reads the `text/event-stream` answer with
 *   `fetch` and a ReadableStream reader. It never uses EventSource (which cannot POST, send a body or carry the session the
 *   same way, and reconnects on its own).
 * - `createSseParser()` is a small WHATWG-style parser: `event:` and `data:` fields, multi-line data, `: ka` keepalive
 *   comments ignored, CRLF tolerated, events split across chunks reassembled. Only events of the 5.12 union get through.
 * - `streamReducer` turns the events into transcript items. Deltas grow one Eddy bubble; `message` replaces them with the
 *   final text; `reset` discards streamed text (refusal or fallback); cards, done rows, refusals and errors become items,
 *   and so do navigate and connect intents, as chips the member taps (Eddy never navigates on its own).
 *   A stream that ends without `end` or `error` (Stop, a dropped connection) marks the reply "This reply was interrupted."
 * - On a 401 the unsent text is saved to localStorage before the sign-in redirect, and taken back after sign-in.
 * - `historyFromJson()` rebuilds the transcript from the server after a reload or a new sign-in.
 *
 * The state lives in EddyRoot, which stays mounted, so a turn keeps running when the panel is closed (6.2).
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { EDDY_AVAILABILITY_ORDER, EDDY_EVENT_TYPES, EDDY_HTML_LANG, safeAppPath, type EddyEvent, type EddyLang, type EddyState, type PageContext, type PendingCardDTO } from "@/lib/eddy/contract";
import { hasKey, t, translateKey } from "@/lib/eddy/i18n";
import type { EddyEntity, EddyOpenRef } from "./events";
import type { TranscriptItem } from "./MessageView";

// ===== Draft kept across a sign-in redirect =====

export const EDDY_DRAFT_KEY = "eddy:draft";
/** A saved draft older than this is dropped instead of restored. */
export const DRAFT_TTL_MS = 60 * 60_000;

type LocalLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function localStore(): LocalLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Saves the member's unsent text before a sign-in redirect. Storage errors are ignored. */
export function saveDraft(text: string, storage: LocalLike | null = localStore(), now = Date.now()): void {
  try {
    if (storage && text.trim()) storage.setItem(EDDY_DRAFT_KEY, JSON.stringify({ text: text.slice(0, 2000), at: now }));
  } catch {
    // storage unavailable: the draft is lost, as it would be without this feature
  }
}

/** True when a fresh draft is waiting (EddyRoot reopens Eddy for it after sign-in). Does not remove it. */
export function hasDraft(storage: LocalLike | null = localStore(), now = Date.now()): boolean {
  try {
    const raw = storage?.getItem(EDDY_DRAFT_KEY);
    if (!raw) return false;
    const { text, at } = JSON.parse(raw) as { text?: unknown; at?: unknown };
    return typeof text === "string" && text.trim().length > 0 && typeof at === "number" && now - at < DRAFT_TTL_MS;
  } catch {
    return false;
  }
}

/** Takes the saved draft once (it is removed), or null when there is none or it is stale. */
export function takeDraft(storage: LocalLike | null = localStore(), now = Date.now()): string | null {
  try {
    if (!storage) return null;
    const fresh = hasDraft(storage, now);
    const raw = storage.getItem(EDDY_DRAFT_KEY);
    storage.removeItem(EDDY_DRAFT_KEY);
    if (!fresh || !raw) return null;
    return (JSON.parse(raw) as { text: string }).text;
  } catch {
    return null;
  }
}

// ===== SSE parsing =====

/** Turn-level states the panel can show as an error item (5.9, 5.11). */
const TURN_ERRORS: readonly EddyState[] = ["service_down", "busy", "turn_in_progress", "rate_limited", "message_too_long", "truncated", "refusal_pause", "internal"];
const EDDY_STATES: readonly EddyState[] = [...EDDY_AVAILABILITY_ORDER, ...TURN_ERRORS];

export const isEddyState = (v: unknown): v is EddyState => typeof v === "string" && (EDDY_STATES as readonly string[]).includes(v);
const isLang = (v: unknown): v is EddyLang => typeof v === "string" && v in EDDY_HTML_LANG;
const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An event of the 5.12 union with the fields its type needs, or null. Unknown fields are kept; unknown types are dropped. */
export function checkEvent(value: unknown): EddyEvent | null {
  if (!isObj(value) || !(EDDY_EVENT_TYPES as readonly string[]).includes(value.type as string)) return null;
  const e = value as Record<string, unknown> & { type: EddyEvent["type"] };
  switch (e.type) {
    case "turn":
      return isStr(e.turnId) && isStr(e.conversationId) && isLang(e.lang) ? (e as unknown as EddyEvent) : null;
    case "status":
      return (e.text === undefined || isStr(e.text)) && (e.key === undefined || isStr(e.key)) ? (e as unknown as EddyEvent) : null;
    case "delta":
      return isStr(e.text) ? (e as unknown as EddyEvent) : null;
    case "message":
      return isStr(e.text) ? ({ ...e, lang: isLang(e.lang) ? e.lang : "en" } as unknown as EddyEvent) : null;
    case "reset":
      return { type: "reset" };
    case "card": {
      const c = e.card as Partial<PendingCardDTO> | undefined;
      return isObj(c) && isStr(c.actionId) && isStr(c.action) && isStr(c.nonce) && isObj(c.preview) ? (e as unknown as EddyEvent) : null;
    }
    case "done_action":
      return isStr(e.actionId) && isStr(e.summaryKey) ? ({ ...e, vars: isObj(e.vars) ? e.vars : {} } as unknown as EddyEvent) : null;
    case "refused_action":
      return isStr(e.action) && isStr(e.code) ? (e as unknown as EddyEvent) : null;
    case "intent":
      return isStr(e.kind) ? (e as unknown as EddyEvent) : null;
    case "end":
      return { ...e, credits: typeof e.credits === "number" && Number.isFinite(e.credits) ? e.credits : 0 } as unknown as EddyEvent;
    case "error":
      return isEddyState(e.state) ? (e as unknown as EddyEvent) : { type: "error", state: "internal" };
  }
  return null;
}

/** Largest single event the parser keeps; anything bigger is dropped instead of growing without bound. */
export const MAX_EVENT_CHARS = 1_000_000;

export type SseParser = { push(chunk: string): void; end(): void };

/**
 * A server-sent events parser for the POST response. `onEvent` gets each checked EddyEvent in order. The `event:` field
 * names the type when the JSON lacks one.
 */
export function createSseParser(onEvent: (event: EddyEvent) => void): SseParser {
  let buffer = "";
  let name = "";
  let data: string[] = [];
  let size = 0;

  const dispatch = () => {
    if (data.length === 0) {
      name = "";
      return;
    }
    const raw = data.join("\n");
    const eventName = name;
    data = [];
    name = "";
    size = 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (isObj(parsed) && parsed.type === undefined && eventName) parsed = { ...parsed, type: eventName };
    const event = checkEvent(parsed);
    if (event) onEvent(event);
  };

  const line = (l: string) => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return; // comment, for example the `: ka` keepalive
    const colon = l.indexOf(":");
    const field = colon === -1 ? l : l.slice(0, colon);
    let value = colon === -1 ? "" : l.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") name = value;
    else if (field === "data") {
      size += value.length;
      if (size > MAX_EVENT_CHARS) {
        data = [];
        size = 0;
        return;
      }
      data.push(value);
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let at: number;
      while ((at = buffer.search(/\r\n|\n|\r/)) !== -1) {
        // A lone \r at the very end may be the first half of \r\n: wait for the next chunk.
        if (buffer[at] === "\r" && at === buffer.length - 1) break;
        const sep = buffer[at] === "\r" && buffer[at + 1] === "\n" ? 2 : 1;
        line(buffer.slice(0, at));
        buffer = buffer.slice(at + sep);
      }
      if (buffer.length > MAX_EVENT_CHARS) buffer = "";
    },
    end() {
      if (buffer) line(buffer);
      buffer = "";
      dispatch();
    },
  };
}

/**
 * Reads an SSE body with a ReadableStream reader. Resolves `true` when the stream finished normally and `false` when it was
 * aborted or broke. Events are delivered in order as they arrive.
 */
export async function readEddyStream(body: ReadableStream<Uint8Array>, onEvent: (event: EddyEvent) => void, signal?: AbortSignal): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = createSseParser(onEvent);
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      if (signal?.aborted) return false;
      const { value, done } = await reader.read();
      if (done) break;
      if (value) parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
    return true;
  } catch {
    return false;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

// ===== The turn request =====

export type TurnRequest = {
  text: string;
  page: PageContext | null;
  conversationId?: string | null;
  /** A server-trusted reference (ids only) from a notice's [Fix with Eddy] or a failed bubble's [Explain] (6.7). */
  ref?: EddyOpenRef;
  /** Start a new conversation instead of continuing the active one (menu > New chat). */
  newChat?: boolean;
};

export type TurnOutcome =
  /** The stream ran; `finished` is false when it ended without `end` or `error` (Stop, a dropped connection). */
  | { kind: "streamed"; finished: boolean }
  /** The session expired: the draft is saved and the caller redirects to sign-in. */
  | { kind: "signed_out" }
  /** Refused before any stream (409 turn running, 402 limit, 429, 503 ...): shown as an error item. */
  | { kind: "refused"; state: EddyState; params?: Record<string, string | number> };

/** The error item for a refused request, from the HTTP status and the JSON body the route sends with it. */
export function refusedState(status: number, json: unknown): { state: EddyState; params?: Record<string, string | number> } {
  const body = isObj(json) ? json : {};
  const params = isObj(body.params) ? (body.params as Record<string, string | number>) : undefined;
  if (isEddyState(body.state)) return { state: body.state, params };
  const code = typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : "";
  if (status === 409) return { state: "turn_in_progress" };
  // The billing paywall's sentence ("Your subscription is inactive. Your data is read-only ...") is the locked state too.
  if (status === 402) return /lock|paywall|subscri|read-only/i.test(code) ? { state: "locked" } : { state: "allowance_used", params };
  if (status === 403 && /suspended/i.test(code)) return { state: "locked" };
  if (status === 413) return { state: "message_too_long" };
  if (status === 429) return { state: "rate_limited" };
  if (status === 503) return code.includes("busy") ? { state: "busy" } : { state: "service_down" };
  return { state: "internal" };
}

/** The request body, with only what the server needs. The page context and ref carry ids only. */
export function turnBody(req: TurnRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { text: req.text, page: req.page };
  if (req.conversationId) body.conversationId = req.conversationId;
  if (req.ref) body.ref = req.ref;
  if (req.newChat) body.newChat = true;
  return body;
}

/**
 * POSTs a turn and streams its events to `onEvent`. A 401 saves `req.text` as the draft first. Never throws: a network
 * failure before the stream is `service_down`.
 */
export async function postTurn(req: TurnRequest, opts: { onEvent: (event: EddyEvent) => void; signal?: AbortSignal; storage?: LocalLike | null }): Promise<TurnOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/eddy/turn", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(turnBody(req)),
      credentials: "same-origin",
      cache: "no-store",
      signal: opts.signal,
    });
  } catch {
    if (opts.signal?.aborted) return { kind: "streamed", finished: false };
    return { kind: "refused", state: "service_down" };
  }
  if (res.status === 401) {
    saveDraft(req.text, opts.storage === undefined ? localStore() : opts.storage);
    return { kind: "signed_out" };
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body || !type.includes("text/event-stream")) {
    const json = await res.json().catch(() => null);
    return { kind: "refused", ...refusedState(res.ok ? 500 : res.status, json) };
  }
  let ended = false;
  const finished = await readEddyStream(
    res.body,
    (event) => {
      if (event.type === "end" || event.type === "error") ended = true;
      opts.onEvent(event);
    },
    opts.signal,
  );
  return { kind: "streamed", finished: finished && ended };
}

// ===== Transcript state =====

export type Activity = { key?: string; text?: string } | null;

export type StreamState = {
  items: TranscriptItem[];
  conversationId: string | null;
  turnId: string | null;
  /** The language of the latest turn (the panel chrome follows it when the preference is auto). */
  lang: EddyLang | null;
  working: boolean;
  activity: Activity;
  /** The Eddy bubble that receives deltas, while a reply streams. */
  streamingId: string | null;
  /** The member's last message, for Up-arrow recall (6.3). */
  lastSent: string | null;
  /** The next turn starts a new conversation (menu > New chat). */
  newChat: boolean;
  seq: number;
};

export const initialStreamState: StreamState = { items: [], conversationId: null, turnId: null, lang: null, working: false, activity: null, streamingId: null, lastSent: null, newChat: false, seq: 0 };

export type StreamAction =
  | { type: "member"; text: string; lang: EddyLang }
  | { type: "event"; event: EddyEvent }
  /** The stream ended without end/error: the reply was interrupted (Stop or a dropped connection). */
  | { type: "interrupted" }
  /** The request was refused before any stream. */
  | { type: "refused"; state: EddyState; params?: Record<string, string | number> }
  | { type: "new_chat" }
  | { type: "restore"; items: TranscriptItem[]; conversationId: string | null; lang: EddyLang | null }
  /** Removes local items (for example a card that was replaced elsewhere). */
  | { type: "drop"; ids: string[] };

const fallbackLang = (s: StreamState): EddyLang => s.lang ?? "en";

/** Finishes the streaming bubble: drops it when it never got text, otherwise marks it final (and optionally interrupted). */
function closeStreaming(s: StreamState, interrupted: boolean): StreamState {
  if (!s.streamingId) {
    if (!interrupted || !s.working) return s;
    const id = `e${s.seq + 1}`;
    return { ...s, seq: s.seq + 1, items: [...s.items, { kind: "eddy", id, text: "", lang: fallbackLang(s), interrupted: true }] };
  }
  const items = s.items.flatMap((it): TranscriptItem[] => {
    if (it.id !== s.streamingId || it.kind !== "eddy") return [it];
    if (!it.text && !interrupted) return [];
    return [{ ...it, streaming: false, ...(interrupted ? { interrupted: true } : {}) }];
  });
  return { ...s, items, streamingId: null };
}

export function streamReducer(s: StreamState, a: StreamAction): StreamState {
  switch (a.type) {
    case "member": {
      const id = `m${s.seq + 1}`;
      return { ...s, seq: s.seq + 1, items: [...s.items, { kind: "member", id, text: a.text, lang: a.lang }], working: true, activity: null, lastSent: a.text, newChat: false };
    }
    case "interrupted":
      return { ...closeStreaming(s, true), working: false, activity: null };
    case "refused": {
      const closed = closeStreaming(s, false);
      const id = `x${closed.seq + 1}`;
      return { ...closed, seq: closed.seq + 1, working: false, activity: null, items: [...closed.items, { kind: "error", id, lang: fallbackLang(s), state: a.state, params: a.params }] };
    }
    case "new_chat":
      return { ...initialStreamState, lastSent: s.lastSent, lang: s.lang, newChat: true, seq: s.seq };
    case "restore":
      return { ...initialStreamState, items: a.items, conversationId: a.conversationId, lang: a.lang, lastSent: s.lastSent, seq: s.seq + a.items.length };
    case "drop":
      return { ...s, items: s.items.filter((it) => !a.ids.includes(it.id)) };
    case "event":
      return applyEvent(s, a.event);
  }
}

function applyEvent(s: StreamState, e: EddyEvent): StreamState {
  const lang = fallbackLang(s);
  switch (e.type) {
    case "turn":
      return { ...s, turnId: e.turnId, conversationId: e.conversationId, lang: e.lang, working: true };
    case "status":
      return { ...s, activity: e.key || e.text ? { key: e.key, text: e.text } : null };
    case "delta": {
      if (!e.text) return s;
      if (s.streamingId) return { ...s, activity: null, items: s.items.map((it) => (it.id === s.streamingId && it.kind === "eddy" ? { ...it, text: it.text + e.text } : it)) };
      const id = `e${s.seq + 1}`;
      return { ...s, seq: s.seq + 1, activity: null, streamingId: id, items: [...s.items, { kind: "eddy", id, text: e.text, lang, streaming: true }] };
    }
    case "message": {
      if (s.streamingId) {
        const items = s.items.map((it) => (it.id === s.streamingId && it.kind === "eddy" ? { ...it, text: e.text, lang: e.lang, streaming: false } : it));
        return { ...s, items, streamingId: null, lang: e.lang, activity: null };
      }
      if (!e.text) return s;
      const id = `e${s.seq + 1}`;
      return { ...s, seq: s.seq + 1, lang: e.lang, activity: null, items: [...s.items, { kind: "eddy", id, text: e.text, lang: e.lang }] };
    }
    case "reset":
      return s.streamingId ? { ...s, items: s.items.map((it) => (it.id === s.streamingId && it.kind === "eddy" ? { ...it, text: "" } : it)) } : s;
    case "card": {
      const item: TranscriptItem = { kind: "card", id: `c-${e.card.actionId}`, lang: e.card.lang ?? lang, card: e.card };
      const closed = closeStreaming(s, false);
      const at = e.card.supersedes ? closed.items.findIndex((it) => it.kind === "card" && it.card.actionId === e.card.supersedes) : -1;
      if (at >= 0) return { ...closed, items: closed.items.map((it, i) => (i === at ? item : it)) };
      if (closed.items.some((it) => it.id === item.id)) return closed;
      return { ...closed, items: [...closed.items, item] };
    }
    case "done_action": {
      const closed = closeStreaming(s, false);
      const id = `d-${e.actionId}`;
      if (closed.items.some((it) => it.id === id)) return closed;
      return { ...closed, items: [...closed.items, { kind: "done", id, lang, actionId: e.actionId, summaryKey: e.summaryKey, vars: e.vars, undoUntil: e.undoUntil ?? null }] };
    }
    case "refused_action": {
      const closed = closeStreaming(s, false);
      const id = `r${closed.seq + 1}`;
      return { ...closed, seq: closed.seq + 1, items: [...closed.items, { kind: "refused", id, lang, action: e.action, code: e.code, who: e.who }] };
    }
    case "intent":
      return applyIntent(s, e);
    case "end":
      return { ...closeStreaming(s, false), working: false, activity: null };
    case "error": {
      const closed = closeStreaming(s, false);
      const id = `x${closed.seq + 1}`;
      return { ...closed, seq: closed.seq + 1, working: false, activity: null, items: [...closed.items, { kind: "error", id, lang, state: e.state, params: e.params }] };
    }
  }
}

// ===== Intents the member taps (4.6, 6.15) =====

/** Where the connect cards lead in v1: the existing connect pages, where Meta's window opens from the member's click (12.2 risk 15). */
export const CONNECT_WHATSAPP_PATH = "/app/settings/connect?from=eddy";
export const CONNECT_FACEBOOK_PATH = "/app/settings/connections?from=eddy";

/**
 * A `navigate` or connect intent becomes a transcript item with a chip, and nothing moves until the member taps it:
 * open_page "returns a navigate chip ... Eddy navigates only when the member taps it" (4.6), and Meta's consent screens
 * "start from a member's tap on an intent card, never from the model" (6.15). The tool also tells the model "A button to
 * open the page is shown. The member taps it." `composer_draft` and `open_templates` only fill or open something on the
 * current page, so EddyRoot carries them out (runIntent). A path that fails safeAppPath() shows nothing.
 */
function applyIntent(s: StreamState, e: Extract<EddyEvent, { type: "intent" }>): StreamState {
  const lang = fallbackLang(s);
  const p = isObj(e.payload) ? e.payload : {};
  const id = `i${s.seq + 1}`;
  let item: TranscriptItem | null = null;
  if (e.kind === "navigate") {
    const path = safeAppPath(p.path);
    const label = typeof p.labelKey === "string" && hasKey(p.labelKey) ? translateKey(lang, p.labelKey) : t(lang, "btn.open_page");
    if (path) item = { kind: "chips", id, lang, chips: [{ path, label }] };
  } else if (e.kind === "connect_whatsapp") {
    item = { kind: "action", id, lang, title: t(lang, "done.connect_whatsapp"), chips: [{ path: CONNECT_WHATSAPP_PATH, label: t(lang, "btn.connect_whatsapp") }] };
  } else if (e.kind === "connect_facebook") {
    item = { kind: "action", id, lang, title: t(lang, "done.connect_facebook"), chips: [{ path: CONNECT_FACEBOOK_PATH, label: t(lang, "btn.connect_facebook") }] };
  }
  if (!item) return s;
  const closed = closeStreaming(s, false);
  return { ...closed, seq: s.seq + 1, items: [...closed.items, item] };
}

// ===== Entities for wa:eddy-did (6.4) =====

const ENTITY_OF: Readonly<Record<string, EddyEntity>> = {
  tag_conversations: "conversation",
  assign_conversation: "conversation",
  set_conversation_status: "conversation",
  move_conversation_to_team: "conversation",
  stop_bot_on_conversation: "conversation",
  send_text_reply: "conversation",
  add_internal_note: "conversation",
  block_conversation: "conversation",
  tag_contacts: "contact",
  update_contact: "contact",
  set_contact_owner_stage: "contact",
  create_contact: "contact",
  delete_contact: "contact",
  record_opt_out: "contact",
  record_opt_in: "contact",
  create_template_draft: "template",
  submit_template: "template",
  delete_template: "template",
  create_broadcast_draft: "broadcast",
  pause_broadcast: "broadcast",
  cancel_broadcast: "broadcast",
  create_segment: "segment",
  delete_segment: "segment",
  disable_automation: "automation",
  enable_automation: "automation",
  create_quick_reply: "quick_reply",
  invite_teammate: "team",
  set_my_availability: "team",
  revoke_approval_link: "approval",
  decline_spend_request: "approval",
  stop_spending: "spending",
};

/** The entity an action changes ("done.tag_contacts" or "tag_contacts" both work), or null for read-only and unknown ones. */
export function entityForAction(actionOrKey: string | null | undefined): EddyEntity | null {
  if (typeof actionOrKey !== "string") return null;
  const name = actionOrKey.replace(/^(done|card)\./, "").replace(/\.(done|title|confirm|running)$/, "");
  return ENTITY_OF[name] ?? null;
}

/** The ids a card's preview names as its target (material.targetId), checked like every event id. */
export function targetIdsOf(card: Pick<PendingCardDTO, "preview"> | null | undefined): string[] {
  const id = card?.preview?.material?.targetId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? [id] : [];
}

// ===== History from the server (reload, new sign-in) =====

type HistoryDisplay = { text?: unknown; lang?: unknown; interrupted?: unknown; refusal?: unknown };
type HistoryMessage = { id?: unknown; role?: unknown; kind?: unknown; text?: unknown; content?: unknown; lang?: unknown; language?: unknown; interrupted?: unknown; status?: unknown; display?: HistoryDisplay };

/** Only these stored kinds are transcript; tool results and context notes never are (the server filters too). */
const TRANSCRIPT_KINDS = ["user_text", "assistant", "placeholder"];

function textOf(m: HistoryMessage): string {
  if (isObj(m.display) && typeof m.display.text === "string") return m.display.text;
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b): b is { type: string; text: string } => isObj(b) && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n\n");
  }
  return "";
}

/**
 * Transcript items from `GET /api/eddy/conversations/[id]` ({conversation, messages: [{id, role, kind, display}]}). The
 * member's own messages and Eddy's final replies come back, from the display projection; tool results, context notes and
 * anything that is not plain text are left out. A reply the server marks interrupted shows "This reply was interrupted."
 * Cards come back only when the answer carries full cards (ids alone cannot be confirmed: the nonce is never re-sent).
 */
export function historyFromJson(json: unknown): { conversationId: string | null; lang: EddyLang | null; items: TranscriptItem[] } | null {
  if (!isObj(json)) return null;
  const conv = isObj(json.conversation) ? json.conversation : json;
  const conversationId = typeof conv.id === "string" ? conv.id : typeof json.conversationId === "string" ? json.conversationId : null;
  const convLang = isLang(conv.language) ? conv.language : isLang(conv.lang) ? conv.lang : null;
  const messages = Array.isArray(json.messages) ? (json.messages as HistoryMessage[]) : [];
  const items: TranscriptItem[] = [];
  let n = 0;
  for (const m of messages) {
    if (!isObj(m)) continue;
    if (typeof m.kind === "string" && !TRANSCRIPT_KINDS.includes(m.kind)) continue;
    const display: HistoryDisplay = isObj(m.display) ? m.display : {};
    const role = m.role;
    const lang = isLang(display.lang) ? display.lang : isLang(m.lang) ? m.lang : isLang(m.language) ? m.language : (convLang ?? "en");
    const interrupted = display.interrupted === true || m.interrupted === true || m.status === "interrupted" || m.kind === "placeholder";
    const text = display.refusal === true && !textOf(m).trim() ? t(lang, "refusal") : m.kind === "placeholder" ? "" : textOf(m);
    const id = typeof m.id === "string" ? `h-${m.id}` : `h${++n}`;
    if ((role === "user" || role === "member") && text.trim()) items.push({ kind: "member", id, text, lang });
    else if ((role === "assistant" || role === "eddy") && (text.trim() || interrupted)) items.push({ kind: "eddy", id, text, lang, ...(interrupted ? { interrupted: true } : {}) });
  }
  const cards = Array.isArray(json.cards) ? json.cards : [];
  for (const c of cards) {
    const event = checkEvent({ type: "card", card: c });
    if (event?.type === "card") items.push({ kind: "card", id: `c-${event.card.actionId}`, lang: event.card.lang ?? convLang ?? "en", card: event.card });
  }
  return { conversationId, lang: convLang, items };
}

/** The member's latest conversation id from `GET /api/eddy/conversations` (newest first, or the active one). */
export function latestConversationId(json: unknown): string | null {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.conversations) ? json.conversations : [];
  const rows = list.filter((c): c is Record<string, unknown> => isObj(c) && typeof c.id === "string");
  const active = rows.find((c) => c.status === "active" || c.active === true);
  const pick = active ?? [...rows].sort((a, b) => String(b.lastMessageAt ?? "").localeCompare(String(a.lastMessageAt ?? "")))[0];
  return pick ? (pick.id as string) : null;
}

const GET_JSON: RequestInit = { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } };

async function jsonOf(res: Response): Promise<unknown> {
  return res.ok ? res.json().catch(() => null) : null;
}

// ===== The hook =====

export type UseEddyStreamOptions = {
  /** Every event, after the reducer (EddyRoot uses it for intents, wa:eddy-did and the closed-panel toast). */
  onEvent?: (event: EddyEvent, state: StreamState) => void;
  /** The session expired; the draft is saved. Defaults to the sign-in redirect. */
  onSignedOut?: () => void;
};

export type SendInput = { text: string; lang?: EddyLang; page: PageContext | null; ref?: EddyOpenRef };

export function useEddyStream(opts: UseEddyStreamOptions = {}) {
  const [state, dispatch] = useReducer(streamReducer, initialStreamState);
  const latest = useRef(state);
  latest.current = state;
  const options = useRef(opts);
  options.current = opts;
  const controller = useRef<AbortController | null>(null);
  const restored = useRef(false);

  useEffect(() => () => controller.current?.abort(), []);

  const send = useCallback(async (input: SendInput): Promise<TurnOutcome | null> => {
    const text = input.text.trim();
    if (latest.current.working || (!text && !input.ref)) return null;
    const lang = input.lang ?? latest.current.lang ?? "en";
    dispatch({ type: "member", text, lang });
    const ac = new AbortController();
    controller.current = ac;
    const outcome = await postTurn(
      { text, page: input.page, conversationId: latest.current.newChat ? null : latest.current.conversationId, ref: input.ref, newChat: latest.current.newChat },
      {
        signal: ac.signal,
        onEvent: (event) => {
          dispatch({ type: "event", event });
          options.current.onEvent?.(event, latest.current);
        },
      },
    );
    if (controller.current === ac) controller.current = null;
    if (outcome.kind === "signed_out") {
      dispatch({ type: "interrupted" });
      if (options.current.onSignedOut) options.current.onSignedOut();
      else if (typeof window !== "undefined") window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    } else if (outcome.kind === "refused") dispatch({ type: "refused", state: outcome.state, params: outcome.params });
    else if (!outcome.finished) dispatch({ type: "interrupted" });
    return outcome;
  }, []);

  /** Stop: aborts the stream; the reply is marked interrupted. Anything the server already did stays done. */
  const stop = useCallback(() => controller.current?.abort(), []);

  const newChat = useCallback(() => {
    controller.current?.abort();
    dispatch({ type: "new_chat" });
  }, []);

  /** Loads the member's latest conversation from the server once (after a reload or a new sign-in). */
  const restore = useCallback(async (force = false) => {
    if ((restored.current && !force) || latest.current.items.length > 0) return;
    restored.current = true;
    try {
      const id = latestConversationId(await jsonOf(await fetch("/api/eddy/conversations", GET_JSON)));
      if (!id) return;
      const history = historyFromJson(await jsonOf(await fetch(`/api/eddy/conversations/${encodeURIComponent(id)}`, GET_JSON)));
      if (history && latest.current.items.length === 0) dispatch({ type: "restore", items: history.items, conversationId: history.conversationId ?? id, lang: history.lang });
    } catch {
      // history is a convenience: the panel works without it
    }
  }, []);

  return { state, dispatch, send, stop, newChat, restore };
}

export type EddySession = ReturnType<typeof useEddyStream>;

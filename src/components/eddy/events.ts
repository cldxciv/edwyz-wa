/**
 * Window events between Eddy and the rest of the app (docs/EDDY-SPEC.md 4.6, 6.1, 6.4, 6.7, D12, EDDY-13 acceptance 6),
 * following the existing `wa:unread-refresh` pattern:
 *
 * - `wa:eddy-draft`          Eddy -> inbox composer: put a draft reply in the open chat's composer. Nothing is sent.
 * - `wa:eddy-open-templates` Eddy -> inbox: open the template picker for a chat (the 131047 fix).
 * - `wa:eddy-did`            Eddy -> pages: something changed through Eddy; refetch these ids.
 * - `wa:eddy-selection`      pages -> Eddy: the lead, contact, broadcast or template the member has open (null clears it).
 * - `wa:eddy-open`           anywhere -> Eddy: open the panel, optionally with the member's own query or a server-trusted
 *                            reference. A reference carries ids only, never customer, Meta or template text (6.7, 7.2 item 9).
 *
 * Every detail is checked on both sides: a malformed one is not dispatched, and a listener ignores one that fails the check,
 * so nothing outside these shapes reaches Eddy or the composer.
 */

export const EDDY_EVENTS = {
  draft: "wa:eddy-draft",
  openTemplates: "wa:eddy-open-templates",
  did: "wa:eddy-did",
  selection: "wa:eddy-selection",
  open: "wa:eddy-open",
} as const;

export type EddyEventName = (typeof EDDY_EVENTS)[keyof typeof EDDY_EVENTS];

/** Ids that may travel in an event, the same rule page-context.ts applies (EDDY-13 acceptance 7). */
export const EDDY_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A draft is at most what the inbox composer takes in one message. */
export const MAX_DRAFT_CHARS = 4096;
/** A query is at most one Eddy message (5.9). */
export const MAX_QUERY_CHARS = 2000;

export const EDDY_ENTITIES = ["conversation", "contact", "template", "broadcast", "segment", "automation", "chatbot", "lead", "quick_reply", "team", "approval", "spending", "notice"] as const;
export type EddyEntity = (typeof EDDY_ENTITIES)[number];

export const SELECTION_TYPES = ["lead", "contact", "broadcast", "template", "conversation", "segment"] as const;
export type SelectionType = (typeof SELECTION_TYPES)[number];

export type EddyDraftDetail = { conversationId: string; text: string };
export type EddyOpenTemplatesDetail = { conversationId: string };
export type EddyDidDetail = { entity: EddyEntity; ids: string[] };
export type EddySelectionDetail = { type: SelectionType; id: string } | null;
export type EddyOpenRef = { kind: "notice"; noticeId: string } | { kind: "message"; messageId: string };
export type EddyOpenDetail = { query?: string; ref?: EddyOpenRef };

export type EddyEventDetails = {
  "wa:eddy-draft": EddyDraftDetail;
  "wa:eddy-open-templates": EddyOpenTemplatesDetail;
  "wa:eddy-did": EddyDidDetail;
  "wa:eddy-selection": EddySelectionDetail;
  "wa:eddy-open": EddyOpenDetail;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && EDDY_ID.test(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));

/** The checked detail of an event, or undefined when it does not match its shape (null is a valid selection clear). */
export function checkDetail<N extends EddyEventName>(name: N, detail: unknown): EddyEventDetails[N] | undefined {
  switch (name) {
    case EDDY_EVENTS.draft: {
      if (!isObj(detail) || !onlyKeys(detail, ["conversationId", "text"]) || !isId(detail.conversationId)) return undefined;
      if (typeof detail.text !== "string" || detail.text.length === 0 || detail.text.length > MAX_DRAFT_CHARS) return undefined;
      return { conversationId: detail.conversationId, text: detail.text } as EddyEventDetails[N];
    }
    case EDDY_EVENTS.openTemplates: {
      if (!isObj(detail) || !onlyKeys(detail, ["conversationId"]) || !isId(detail.conversationId)) return undefined;
      return { conversationId: detail.conversationId } as EddyEventDetails[N];
    }
    case EDDY_EVENTS.did: {
      if (!isObj(detail) || !onlyKeys(detail, ["entity", "ids"])) return undefined;
      if (!(EDDY_ENTITIES as readonly string[]).includes(detail.entity as string)) return undefined;
      if (!Array.isArray(detail.ids) || detail.ids.length > 100 || !detail.ids.every(isId)) return undefined;
      return { entity: detail.entity as EddyEntity, ids: [...new Set(detail.ids as string[])] } as EddyEventDetails[N];
    }
    case EDDY_EVENTS.selection: {
      if (detail === null) return null as EddyEventDetails[N];
      if (!isObj(detail) || !onlyKeys(detail, ["type", "id"]) || !isId(detail.id)) return undefined;
      if (!(SELECTION_TYPES as readonly string[]).includes(detail.type as string)) return undefined;
      return { type: detail.type as SelectionType, id: detail.id } as EddyEventDetails[N];
    }
    case EDDY_EVENTS.open: {
      if (detail === undefined || detail === null) return {} as EddyEventDetails[N];
      if (!isObj(detail) || !onlyKeys(detail, ["query", "ref"])) return undefined;
      const out: EddyOpenDetail = {};
      if (detail.query !== undefined) {
        if (typeof detail.query !== "string" || detail.query.length > MAX_QUERY_CHARS) return undefined;
        const query = detail.query.trim();
        if (query) out.query = query;
      }
      if (detail.ref !== undefined) {
        const ref = detail.ref;
        if (!isObj(ref)) return undefined;
        if (ref.kind === "notice" && onlyKeys(ref, ["kind", "noticeId"]) && isId(ref.noticeId)) out.ref = { kind: "notice", noticeId: ref.noticeId };
        else if (ref.kind === "message" && onlyKeys(ref, ["kind", "messageId"]) && isId(ref.messageId)) out.ref = { kind: "message", messageId: ref.messageId };
        else return undefined;
      }
      return out as EddyEventDetails[N];
    }
    default:
      return undefined;
  }
}

type Target = Pick<EventTarget, "dispatchEvent" | "addEventListener" | "removeEventListener">;

function defaultTarget(): Target | null {
  return typeof window === "undefined" ? null : window;
}

/** Dispatches a checked event. Returns false (and dispatches nothing) when the detail does not match its shape. */
export function dispatchEddyEvent<N extends EddyEventName>(name: N, detail: EddyEventDetails[N], target: Target | null = defaultTarget()): boolean {
  const checked = checkDetail(name, detail);
  if (checked === undefined || !target) return false;
  target.dispatchEvent(new CustomEvent(name, { detail: checked }));
  return true;
}

/** Listens for a checked event; returns the unsubscribe function. Malformed details never reach the handler. */
export function onEddyEvent<N extends EddyEventName>(name: N, handler: (detail: EddyEventDetails[N]) => void, target: Target | null = defaultTarget()): () => void {
  if (!target) return () => undefined;
  const listener = (event: Event) => {
    const checked = checkDetail(name, (event as CustomEvent).detail);
    if (checked !== undefined) handler(checked);
  };
  target.addEventListener(name, listener);
  return () => target.removeEventListener(name, listener);
}

/** Opens Eddy, with the member's own query or an id reference. */
export const openEddy = (detail: EddyOpenDetail = {}, target?: Target | null) => dispatchEddyEvent(EDDY_EVENTS.open, detail, target === undefined ? defaultTarget() : target);
/** Tells the open pages what changed through Eddy (6.4). */
export const announceEddyDid = (entity: EddyEntity, ids: string[], target?: Target | null) => dispatchEddyEvent(EDDY_EVENTS.did, { entity, ids }, target === undefined ? defaultTarget() : target);

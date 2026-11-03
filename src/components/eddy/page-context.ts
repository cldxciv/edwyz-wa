/**
 * What the member is looking at, as Eddy's turn request carries it (docs/EDDY-SPEC.md 5.6, D12, EDDY-13 acceptance 7).
 *
 * - The route map turns a /app path into a stable page id ("inbox.chat", "broadcasts.detail", "settings.spending") plus the
 *   ids the path holds. The inbox's `?c=<conversationId>` names the open chat.
 * - Every id is checked against /^[A-Za-z0-9_-]{1,64}$/; anything else is dropped, never sent.
 * - The latest `wa:eddy-selection {type, id}` (the lead or contact a page opened) is kept until the route changes.
 *
 * The browser only proposes: the server verifies every id with verifyPageContext() and silently drops what the member may
 * not see. Nothing here carries a name or any other text a customer or teammate wrote.
 */
import { useEffect, useState } from "react";
import type { PageContext } from "@/lib/eddy/contract";
import { EDDY_EVENTS, EDDY_ID, onEddyEvent, type EddySelectionDetail, type SelectionType } from "./events";

export const PAGE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;

/** An id that may travel to the server, or undefined. */
export function safeId(value: unknown): string | undefined {
  return typeof value === "string" && EDDY_ID.test(value) ? value : undefined;
}

type IdField = "conversationId" | "contactId" | "broadcastId" | "templateId" | "leadId";

/** [pattern over the path below /app, page id, the field the captured id goes to]. First match wins. */
const ROUTES: readonly (readonly [RegExp, string, IdField?])[] = [
  [/^$/, "dashboard"],
  [/^getting-started$/, "setup"],
  [/^inbox$/, "inbox.list"],
  [/^contacts$/, "contacts"],
  [/^contacts\/segments$/, "contacts.segments"],
  [/^templates$/, "templates"],
  [/^templates\/new$/, "templates.new"],
  [/^templates\/([^/]+)$/, "templates.detail", "templateId"],
  [/^broadcasts$/, "broadcasts"],
  [/^broadcasts\/new$/, "broadcasts.new"],
  [/^broadcasts\/([^/]+)$/, "broadcasts.detail", "broadcastId"],
  [/^leads$/, "leads"],
  [/^leads\/forms$/, "leads.forms"],
  // E-R4 (docs/IG-PAGE-ADS-SPEC.md 6.3): the lead form builder.
  [/^leads\/forms\/new$/, "leads.forms_new"],
  [/^leads\/sequences$/, "leads.sequences"],
  [/^automation$/, "automation"],
  [/^automation\/ai-agent$/, "automation.ai_agent"],
  [/^automation\/chatbots$/, "automation.chatbots"],
  [/^automation\/chatbots\/new$/, "automation.chatbots_new"],
  [/^automation\/chatbots\/[^/]+$/, "automation.chatbot"],
  [/^automation\/materials$/, "automation.materials"],
  [/^automation\/rules\/new$/, "automation.rules_new"],
  [/^automation\/rules\/log$/, "automation.rules_log"],
  [/^automation\/rules\/[^/]+$/, "automation.rule"],
  [/^reports$/, "reports"],
  [/^billing$/, "billing"],
  [/^billing\/invoices\/[^/]+$/, "billing.invoice"],
  [/^settings\/spending(\/.*)?$/, "settings.spending"],
  [/^settings\/ai-tools$/, "settings.ai_tools"],
  [/^settings\/([a-z-]+)$/, "settings"],
  [/^ads$/, "ads"],
  [/^ads\/new$/, "ads.new"],
  [/^ads\/insights$/, "ads.insights"],
  [/^ads\/optimizer$/, "ads.optimizer"],
  // E-R4 (docs/IG-PAGE-ADS-SPEC.md 6.3): Boost a post, New ad and Audiences come before the campaign-id pattern, so
  // /app/ads/boost is never read as a campaign called "boost".
  [/^ads\/boost$/, "ads.boost"],
  [/^ads\/create$/, "ads.create"],
  [/^ads\/audiences$/, "ads.audiences"],
  [/^ads\/[^/]+$/, "ads.detail"],
  [/^commerce$/, "commerce"],
  [/^content$/, "content"],
  [/^conversions$/, "conversions"],
  [/^creative(\/.*)?$/, "creative"],
];

/** The page id and ids for a path (no query). Anything outside /app is "app". */
export function routePage(pathname: string | null | undefined): { id: string; field?: IdField; value?: string } {
  const path = typeof pathname === "string" ? pathname.split(/[?#]/, 1)[0] : "";
  if (path !== "/app" && !path.startsWith("/app/")) return { id: "app" };
  const rest = path.slice("/app".length).replace(/^\/+|\/+$/g, "");
  for (const [re, id, field] of ROUTES) {
    const m = re.exec(rest);
    if (!m) continue;
    if (id === "settings") {
      const sub = (m[1] ?? "").replace(/-/g, "_");
      return { id: /^[a-z][a-z0-9_]*$/.test(sub) ? `settings.${sub}` : "settings" };
    }
    if (field) {
      const value = safeId(m[1]);
      return value ? { id, field, value } : { id: id.replace(/\.detail$/, "") };
    }
    return { id };
  }
  return { id: "app" };
}

/** Where a selection's id goes in the page context. */
const SELECTION_FIELD: Partial<Record<SelectionType, IdField>> = {
  lead: "leadId",
  contact: "contactId",
  broadcast: "broadcastId",
  template: "templateId",
  conversation: "conversationId",
};

export type Selection = Exclude<EddySelectionDetail, null>;

/**
 * The page context for a location: the route's page id and ids, the inbox's `?c=` chat, and the latest selection. Every id
 * is re-checked here, so a malformed one never reaches the request.
 */
export function pageContextFromLocation(pathname: string | null | undefined, search: string | URLSearchParams | null | undefined, selection?: Selection | null): PageContext {
  const route = routePage(pathname);
  const page: PageContext = { id: route.id };
  if (route.field && route.value) page[route.field] = route.value;
  if (route.id === "inbox.list") {
    const params = typeof search === "string" ? new URLSearchParams(search) : (search ?? new URLSearchParams());
    const c = safeId(params.get("c"));
    if (c) {
      page.id = "inbox.chat";
      page.conversationId = c;
    }
  }
  const sel = selection && safeId(selection.id) ? selection : null;
  if (sel) {
    page.selection = { type: sel.type, id: sel.id };
    const field = SELECTION_FIELD[sel.type];
    if (field && !page[field]) page[field] = sel.id;
  }
  return page;
}

/** What the context chip calls the subject of a page context (6.3). */
export type ContextSubject = "chat" | "contact" | "lead" | "broadcast" | "template" | "segment" | "page";

export function contextSubject(page: PageContext | null | undefined): ContextSubject | null {
  if (!page) return null;
  if (page.conversationId) return "chat";
  if (page.leadId) return "lead";
  if (page.contactId) return "contact";
  if (page.broadcastId) return "broadcast";
  if (page.templateId) return "template";
  if (page.selection?.type === "segment") return "segment";
  return page.id === "app" || page.id === "dashboard" ? null : "page";
}

/** The page context with only its page id: what is sent after the member taps the chip's x (6.3). */
export function withoutIds(page: PageContext): PageContext {
  return { id: page.id };
}

// ===== Selection tracking: the latest wa:eddy-selection until the route changes =====

export type SelectionTracker = {
  /** The selection for this path, or null when the route changed since it was made. */
  current(pathname: string | null | undefined): Selection | null;
  /** Records a checked selection (null clears it) for the path it was made on. */
  set(detail: EddySelectionDetail, pathname: string | null | undefined): void;
};

export function createSelectionTracker(): SelectionTracker {
  let held: { selection: Selection; path: string } | null = null;
  const pathOf = (p: string | null | undefined) => (typeof p === "string" ? p.split(/[?#]/, 1)[0] : "");
  return {
    current(pathname) {
      if (!held) return null;
      if (held.path !== pathOf(pathname)) {
        held = null;
        return null;
      }
      return held.selection;
    },
    set(detail, pathname) {
      held = detail && safeId(detail.id) ? { selection: { type: detail.type, id: detail.id }, path: pathOf(pathname) } : null;
    },
  };
}

/** React hook: the latest selection on this route; cleared when the path changes. */
export function useEddySelection(pathname: string | null | undefined): Selection | null {
  const [held, setHeld] = useState<{ selection: Selection; path: string } | null>(null);
  const path = typeof pathname === "string" ? pathname : "";
  useEffect(() => onEddyEvent(EDDY_EVENTS.selection, (detail) => setHeld(detail ? { selection: detail, path: window.location.pathname } : null)), []);
  // A route change drops the selection for good, so coming back to the same path does not revive a stale one.
  useEffect(() => setHeld((h) => (h && h.path !== path ? null : h)), [path]);
  return held && held.path === path ? held.selection : null;
}

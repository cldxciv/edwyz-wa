/**
 * UI intents (docs/EDDY-SPEC.md 4.6, 6.8, 6.15, 12.1a decision 11). Nothing is written: each returns a hint the panel turns
 * into a chip or a card, and the member's tap does the rest.
 *
 * - open_page: a navigate chip for an allowlisted /app page (src/components/app/nav.ts), only when the member's role may open
 *   it. Eddy never navigates by itself.
 * - connect_whatsapp: an intent card that runs Embedded Signup from the member's click (/app/settings/connect?from=eddy).
 * - connect_facebook: an intent card that opens Facebook Login for Business as a popup launched synchronously from the click
 *   (decision 11), with the full-page redirect through POST /api/meta-connect/start as the fallback when popups are blocked.
 * Both connect intents are Meta consent screens, so they are refused in the demo workspace (callsMeta, 6.14).
 */
import { HOME_ITEM, NAV_ITEMS, type NavItem } from "@/components/app/nav";
import { safeAppPath } from "@/lib/eddy/contract";
import { hasRole, HttpError } from "@/lib/tenancy";
import { actorOf, define, id, obj, oneOf } from "./shared";

/** Pages that are not in the main navigation but that Eddy may open. */
const EXTRA_PAGES: NavItem[] = [{ href: "/app/settings/spending", label: "Spending limits", minRole: "agent" }];

/** Every page open_page can lead to, with the role it needs. Static, so the toolset is the same for every workspace. */
export const OPEN_PAGES: readonly NavItem[] = Object.freeze([HOME_ITEM, ...NAV_ITEMS, ...EXTRA_PAGES].filter((p, i, all) => all.findIndex((q) => q.href === p.href) === i));

export const CONNECT_WHATSAPP_PATH = "/app/settings/connect?from=eddy";
export const CONNECT_FACEBOOK_RETURN = "/app/settings/connections";

const openPage = define<{ page: string; conversationId?: string }, { path: string; label: string }>({
  name: "open_page",
  version: "v1",
  area: "help",
  surfaces: ["eddy"],
  titleKey: "status.open_page",
  description: "Offers a button that opens a page of the app. The member taps it; Eddy never navigates by itself. With conversationId and the inbox page, it opens that chat. Pages above the member's role are refused.",
  inputSchema: obj({ page: oneOf("The page.", OPEN_PAGES.map((p) => p.href)), conversationId: id("Open this chat (inbox page only).") }, ["page"]),
  minRole: "agent",
  route: "virtual",
  effects: { writes: false },
  untrustedPaths: [],
  async authorize(ctx, a) {
    const page = OPEN_PAGES.find((p) => p.href === a.page);
    if (!page) throw new HttpError(404, "That page was not found.");
    if (!hasRole(actorOf(ctx), page.minRole)) throw new HttpError(403, "Your role can't open that page. Ask an admin.");
    if (a.conversationId) {
      if (a.page !== "/app/inbox") throw new HttpError(400, "A chat can only be opened on the inbox page.");
      const { assertConversationVisible } = await import("@/lib/teams/visibility");
      await assertConversationVisible(actorOf(ctx), a.conversationId);
    }
  },
  async run(_ctx, a) {
    const page = OPEN_PAGES.find((p) => p.href === a.page) as NavItem;
    const path = safeAppPath(a.conversationId ? `${page.href}?c=${encodeURIComponent(a.conversationId)}` : page.href) ?? "/app";
    return { result: { path, label: page.label }, auditTarget: path };
  },
  forModel: (r) => ({ status: "button_shown", page: r.label, note: "A button to open the page is shown. The member taps it." }),
  forUi: (r) => ({ kind: "navigate", path: r.path, labelKey: "btn.open_page" }),
});

const connectWhatsApp = define<Record<string, never>, { path: string }>({
  name: "connect_whatsapp",
  version: "v1",
  area: "setup",
  surfaces: ["eddy"],
  titleKey: "status.connect_whatsapp",
  description: "Shows a card that connects WhatsApp (Meta's Embedded Signup window opens when the member taps it). If the number is already on the WhatsApp Business app, tell them to choose coexistence. Owners and admins only.",
  inputSchema: obj({}),
  minRole: "admin",
  route: { method: "GET", path: "/api/onboarding/start" },
  effects: { writes: false },
  untrustedPaths: [],
  callsMeta: true,
  async authorize() {},
  async run() {
    return { result: { path: CONNECT_WHATSAPP_PATH }, auditTarget: "connect_whatsapp" };
  },
  forModel: () => ({ status: "card_shown", note: "A Connect WhatsApp card is shown. Meta's window opens when the member taps it." }),
  forUi: (r) => ({ kind: "intent", intent: "connect_whatsapp", payload: { path: r.path } }),
});

const connectFacebook = define<Record<string, never>, { start: string; returnPath: string }>({
  name: "connect_facebook",
  version: "v1",
  area: "setup",
  surfaces: ["eddy"],
  titleKey: "status.connect_facebook",
  description: "Shows a card that connects Facebook and Instagram (pages and ad accounts). Tapping it opens Facebook's permission window in a small popup and brings the member back to Edwyz. Owners and admins only.",
  inputSchema: obj({}),
  minRole: "admin",
  route: { method: "POST", path: "/api/meta-connect/start" },
  effects: { writes: false },
  untrustedPaths: [],
  callsMeta: true,
  async authorize() {},
  async run() {
    return { result: { start: "/api/meta-connect/start", returnPath: CONNECT_FACEBOOK_RETURN }, auditTarget: "connect_facebook" };
  },
  forModel: () => ({ status: "card_shown", note: "A Connect Facebook card is shown. It opens Facebook's permission window as a popup when the member taps it, then brings them back." }),
  forUi: (r) => ({ kind: "intent", intent: "connect_facebook", payload: { mode: "popup", fallback: "redirect", start: r.start, returnPath: r.returnPath } }),
});

export const NAVIGATION_DEFS = [connectFacebook, connectWhatsApp, openPage];

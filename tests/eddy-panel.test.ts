import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/app" }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import { askEddyLabel, buildCommands } from "@/components/app/commands";
import { ShellProvider, type ShellState } from "@/components/app/shell-context";
import { Composer, COMPOSER_MAX, COUNTER_FROM, autogrowHeight, composerKeyAction, luhnValid, pasteWarning, showCounter } from "@/components/eddy/Composer";
import { CHIP_NAME_GRAPHEMES, ContextChip, contextChipLabel } from "@/components/eddy/ContextChip";
import { EddyLauncher, chromeLang, launcherAvatarState, launcherLabel } from "@/components/eddy/EddyLauncher";
import { EddyFooter, EddyPanel, FirstUseNotice, chipSubject, obscuredBy, pillState, usageLines, type EddyController } from "@/components/eddy/EddyPanel";
import { CONNECT_FACEBOOK_PATH, CONNECT_WHATSAPP_PATH, memberLang, runIntent } from "@/components/eddy/EddyRoot";
import { EddySettingsView, enabledFrom } from "@/components/eddy/EddySettingsCard";
import { createSheetHistory, isSheetEntry, keyboardInset, sheetHistoryState } from "@/components/eddy/EddySheet";
import { EDDY_SETTINGS_PAGE, EnableCard, enableCardBody, putEddyEnabled } from "@/components/eddy/EnableCard";
import { EDDY_EVENTS, onEddyEvent } from "@/components/eddy/events";
import { attachKeyguard, isInsideEddy, isPaletteKey, keyguardListener } from "@/components/eddy/keyguard";
import type { TranscriptItem } from "@/components/eddy/MessageView";
import { OffState, dayLimitUsed, offKindOf, offText, resetDate, type OffKind } from "@/components/eddy/OffState";
import { contextSubject, createSelectionTracker, pageContextFromLocation, routePage, safeId, withoutIds } from "@/components/eddy/page-context";
import { StarterChips, gotoChips, startersFor } from "@/components/eddy/StarterChips";
import { Transcript, announcementFor, didFor, onScreenItems } from "@/components/eddy/Transcript";
import {
  EDDY_OPEN_KEY,
  historyDaysOf,
  loadEddyStatus,
  parseStatus,
  patchEddyStatus,
  readEddyStatusSnapshot,
  rememberPanelOpen,
  rememberedPanelOpen,
  resetEddyStatusStore,
  setEddyWorking,
} from "@/components/eddy/useEddyStatus";
import {
  EDDY_DRAFT_KEY,
  createSseParser,
  entityForAction,
  hasDraft,
  historyFromJson,
  initialStreamState,
  latestConversationId,
  postTurn,
  readEddyStream,
  refusedState,
  saveDraft,
  streamReducer,
  takeDraft,
  targetIdsOf,
  turnBody,
  type EddySession,
  type StreamState,
} from "@/components/eddy/useEddyStream";
import type { Preview } from "@/lib/actions/types";
import { u } from "@/lib/actions/untrusted";
import { CARD_CONFIRM_GUARD_MS, EDDY_LANGS, type EddyEvent, type EddyLang, type EddyStatusDTO, type PendingCardDTO } from "@/lib/eddy/contract";
import { catalogue as panelCatalogue, tp } from "@/lib/eddy/copy/panel";
import { spendMessage, t } from "@/lib/eddy/i18n";
import { KEEPALIVE_FRAME, sseFrame } from "@/lib/eddy/sse";

/**
 * docs/EDDY-SPEC.md 6.1 to 6.3, 6.10, 6.11, 6.13, 9.1 (eddy-ui), 12.1a decision 6, EDDY-13 and EDDY-14: the panel, the
 * phone sheet's Back contract, the off states, the "Turn on Eddy" card and the owner's switch, the composer, the context
 * chip, the keyguard, the page context, the status store and the turn stream. Rendered with renderToStaticMarkup; DOM
 * behaviour (event propagation, history, storage) runs against small fakes, since the unit project has no browser.
 */

const html = (node: ReactElement) => renderToStaticMarkup(node);
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const noop = () => undefined;

// ===== Fixtures =====

function status(over: Partial<EddyStatusDTO> = {}): EddyStatusDTO {
  return {
    state: "ready",
    readOnly: false,
    canEnable: false,
    ownerNames: ["Asha Owner"],
    allowance: { usedToday: 5, limitToday: 40, usedMonth: 120, limitMonth: 500, resetsOn: "2026-11-01", memberUsedToday: 4, memberLimitToday: 40 },
    langPref: "auto",
    needsYou: 0,
    demo: false,
    whatsapp: "connected",
    phase: 1,
    firstUse: false,
    spendingStopped: false,
    ...over,
  };
}

const NOW = Date.parse("2026-10-28T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function preview(over: Partial<Preview> = {}): Preview {
  return {
    titleKey: "card.send_text_reply.title",
    vars: { name: u("contact_name", "Ramesh") },
    facts: [{ labelKey: "fact.chat", value: u("contact_name", "Ramesh K") }],
    message: { kind: "text", body: "Your order ships tomorrow." },
    cost: { state: "free", reason: "service_window" },
    warnings: [],
    editable: [{ field: "text", kind: "text" }],
    confirmLabelKey: "card.send_text_reply.confirm",
    danger: false,
    material: { targetId: "cv1" },
    ...over,
  };
}

function card(over: Partial<PendingCardDTO> = {}): PendingCardDTO {
  return { actionId: "ar_1", action: "send_text_reply", nonce: "n".repeat(43), previewHash: "h".repeat(64), preview: preview(), lang: "en", state: "pending", createdAt: iso(NOW), expiresAt: iso(NOW + 15 * 60_000), confirmGuardMs: CARD_CONFIRM_GUARD_MS, ...over };
}

function session(state: StreamState = initialStreamState): EddySession {
  return { state, dispatch: noop, send: async () => null, stop: noop, newChat: noop, restore: async () => undefined } as unknown as EddySession;
}

function controller(over: Partial<EddyController> = {}): EddyController {
  return {
    session: session(),
    status: status(),
    statusError: null,
    refreshStatus: noop,
    lang: "en",
    role: "owner",
    userName: "Anshu Attri",
    workspaceName: "Shop",
    page: { id: "inbox.chat", conversationId: "cv1" },
    openRef: null,
    contextDropped: false,
    dropContext: noop,
    draft: "",
    setDraft: noop,
    draftRestored: false,
    send: noop,
    close: noop,
    navigate: noop,
    ...over,
  };
}

const shell = (over: Partial<ShellState> = {}): ShellState => ({ role: "owner", unread: 0, openPalette: noop, openShortcuts: noop, openDrawer: noop, signOut: async () => undefined, openEddy: noop, closeEddy: noop, eddyOpen: false, ...over });

// ===== Theme tokens (6.13): the same check as eddy-render, for this package's markup =====

const CSS = readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8");
function cssBlock(selector: string): string {
  const start = CSS.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  return CSS.slice(start, CSS.indexOf("\n}", start));
}
const defined = (b: string) => new Set([...b.matchAll(/^\s*--([a-z0-9-]+):/gm)].map((m) => m[1]));
const LIGHT = defined(cssBlock(":root {"));
const DARK = defined(cssBlock(':root[data-theme="dark"] {'));
const THEME_COLORS = new Map([...cssBlock("@theme inline {").matchAll(/--color-([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)/g)].map((m) => [m[1], m[2]]));
const PALETTE = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$|^(white|black)$/;
const COLOR_UTILITY = /^(?:bg|text|border(?:-[trblxy])?|ring|fill|stroke|decoration|outline|divide|placeholder|from|to|via)-(.+?)(?:\/\d+)?$/;

function themeProblems(markup: string): string[] {
  const problems: string[] = [];
  for (const m of markup.matchAll(/class="([^"]*)"/g)) {
    for (const raw of m[1].split(/\s+/).filter(Boolean)) {
      if (/(^|:)dark:/.test(raw)) problems.push(`dark variant ${raw}`);
      const utility = raw.replace(/^(?:[a-z0-9-]+:)+/, "").replace(/!$/, "");
      const cm = COLOR_UTILITY.exec(utility);
      if (!cm) continue;
      if (PALETTE.test(cm[1])) problems.push(`palette colour ${raw}`);
      const token = THEME_COLORS.get(cm[1]);
      if (token && !(LIGHT.has(token) && DARK.has(token))) problems.push(`token --${token} missing in a theme (${raw})`);
    }
    for (const ref of m[1].matchAll(/\(--([a-z0-9-]+)\)/g)) if (!LIGHT.has(ref[1])) problems.push(`unknown token --${ref[1]}`);
  }
  return problems;
}

// =====================================================================================================================
// Keyguard (6.2, EDDY-13 acceptance 5)
// =====================================================================================================================

type FakeEvent = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; stopped: boolean; prevented: boolean; stopPropagation(): void; preventDefault(): void };

class FakeNode {
  listeners = new Map<string, Set<(e: FakeEvent) => void>>();
  constructor(public parent: FakeNode | null) {}
  addEventListener(type: string, fn: (e: FakeEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: FakeEvent) => void) {
    this.listeners.get(type)?.delete(fn);
  }
}

/** Bubbles a keydown from `target` up the tree, the way the browser does after the target phase. */
function press(target: FakeNode, key: string, mods: Partial<Pick<FakeEvent, "ctrlKey" | "metaKey" | "altKey">> = {}): FakeEvent {
  const e: FakeEvent = {
    key,
    ctrlKey: !!mods.ctrlKey,
    metaKey: !!mods.metaKey,
    altKey: !!mods.altKey,
    stopped: false,
    prevented: false,
    stopPropagation() {
      this.stopped = true;
    },
    preventDefault() {
      this.prevented = true;
    },
  };
  for (let n: FakeNode | null = target; n && !e.stopped; n = n.parent) for (const fn of n.listeners.get("keydown") ?? []) fn(e);
  return e;
}

describe("keyguard: keys typed inside Eddy never reach the page, except Ctrl/Cmd+K (6.2)", () => {
  const doc = new FakeNode(null);
  const root = new FakeNode(doc); // [data-eddy-root]
  const button = new FakeNode(root);
  const pageListener = vi.fn();
  doc.addEventListener("keydown", pageListener);
  const detach = attachKeyguard(root as unknown as EventTarget);

  it("stops every inbox and shell shortcut key before a document listener hears it", () => {
    for (const key of ["j", "k", "e", "a", "p", "o", "x", "/", "f", "?", "g", "Enter", "Escape", "ArrowDown", " "]) {
      pageListener.mockClear();
      const e = press(button, key);
      expect(pageListener, key).not.toHaveBeenCalled();
      expect(e.prevented, `${key} keeps its default action`).toBe(false);
    }
    for (const mods of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }] as const) {
      pageListener.mockClear();
      press(button, "e", mods as Partial<FakeEvent>);
      expect(pageListener).not.toHaveBeenCalled();
    }
  });

  it("lets Ctrl+K and Cmd+K through, so the palette opens from inside Eddy", () => {
    pageListener.mockClear();
    press(button, "k", { ctrlKey: true });
    press(button, "K", { metaKey: true });
    expect(pageListener).toHaveBeenCalledTimes(2);
    pageListener.mockClear();
    press(button, "k", { ctrlKey: true, altKey: true });
    expect(pageListener).not.toHaveBeenCalled();
  });

  it("detaches cleanly, and a key outside Eddy is untouched", () => {
    const outside = new FakeNode(doc);
    pageListener.mockClear();
    press(outside, "e");
    expect(pageListener).toHaveBeenCalledTimes(1);
    detach();
    pageListener.mockClear();
    press(button, "e");
    expect(pageListener).toHaveBeenCalledTimes(1);
  });

  it("isPaletteKey, keyguardListener and isInsideEddy", () => {
    expect(isPaletteKey({ key: "k", ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isPaletteKey({ key: "k", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    const stop = vi.fn();
    keyguardListener({ key: "e", ctrlKey: false, metaKey: false, altKey: false, stopPropagation: stop });
    expect(stop).toHaveBeenCalledTimes(1);
    keyguardListener({ key: "k", ctrlKey: false, metaKey: true, altKey: false, stopPropagation: stop });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(isInsideEddy({ closest: (s: string) => (s === "[data-eddy-root]" ? {} : null) })).toBe(true);
    expect(isInsideEddy({ closest: () => null })).toBe(false);
    expect(isInsideEddy(null)).toBe(false);
    expect(attachKeyguard(null)()).toBeUndefined();
  });

  it("Eddy's own key handling uses the capture phase (the guard stops bubbling React handlers)", () => {
    for (const f of ["Composer.tsx", "EddyPanel.tsx"]) {
      const src = readFileSync(path.resolve(__dirname, `../src/components/eddy/${f}`), "utf8");
      expect(src, f).toContain("onKeyDownCapture");
      expect(src, f).not.toMatch(/\sonKeyDown=\{/);
    }
  });
});

// =====================================================================================================================
// Page context (5.6, EDDY-13 acceptance 7)
// =====================================================================================================================

describe("page context: route map, inbox ?c=, id check, latest selection until the route changes", () => {
  it("maps the known /app routes to stable page ids and ids", () => {
    expect(routePage("/app")).toEqual({ id: "dashboard" });
    expect(routePage("/app/")).toEqual({ id: "dashboard" });
    expect(routePage("/app/inbox")).toEqual({ id: "inbox.list" });
    expect(routePage("/app/getting-started")).toEqual({ id: "setup" });
    expect(routePage("/app/templates")).toEqual({ id: "templates" });
    expect(routePage("/app/templates/new")).toEqual({ id: "templates.new" });
    expect(routePage("/app/broadcasts/new")).toEqual({ id: "broadcasts.new" });
    expect(routePage("/app/broadcasts/b_9")).toEqual({ id: "broadcasts.detail", field: "broadcastId", value: "b_9" });
    expect(routePage("/app/settings/spending")).toEqual({ id: "settings.spending" });
    expect(routePage("/app/settings/ai-tools")).toEqual({ id: "settings.ai_tools" });
    expect(routePage("/app/settings/team")).toEqual({ id: "settings.team" });
    expect(routePage("/app/automation/chatbots/abc")).toEqual({ id: "automation.chatbot" });
    expect(routePage("/app/leads")).toEqual({ id: "leads" });
    expect(routePage("/app/something/else")).toEqual({ id: "app" });
    expect(routePage("/login")).toEqual({ id: "app" });
    expect(routePage(null)).toEqual({ id: "app" });
  });

  it("(E-R4, IG-PAGE-ADS-SPEC 6.3) maps Boost a post, New ad, Audiences and the form builder before the campaign pattern", () => {
    expect(routePage("/app/ads/boost")).toEqual({ id: "ads.boost" });
    expect(routePage("/app/ads/create")).toEqual({ id: "ads.create" });
    expect(pageContextFromLocation("/app/ads/create", "?goal=lead_form")).toEqual({ id: "ads.create" });
    expect(routePage("/app/ads/audiences")).toEqual({ id: "ads.audiences" });
    expect(routePage("/app/leads/forms/new")).toEqual({ id: "leads.forms_new" });
    expect(routePage("/app/leads/forms")).toEqual({ id: "leads.forms" });
    // /app/ads/boost is a page, never a campaign called "boost"; a real campaign id still reads as the campaign page.
    expect(routePage("/app/ads/boost")).not.toEqual({ id: "ads.detail" });
    expect(routePage("/app/ads/cmp_42")).toEqual({ id: "ads.detail" });
    expect(routePage("/app/ads/new")).toEqual({ id: "ads.new" });
    expect(routePage("/app/ads/boost/extra")).toEqual({ id: "app" });
  });

  it("checks every id against /^[A-Za-z0-9_-]{1,64}$/ and drops anything else", () => {
    expect(safeId("cv_1-A")).toBe("cv_1-A");
    for (const bad of ["", "a".repeat(65), "a.b", "a b", "<x>", "../x", "%2e", 5, null]) expect(safeId(bad), String(bad)).toBeUndefined();
    expect(routePage("/app/broadcasts/b.9")).toEqual({ id: "broadcasts" });
    expect(pageContextFromLocation("/app/inbox", "?c=bad%20id")).toEqual({ id: "inbox.list" });
  });

  it("reads the inbox's ?c= as the open chat", () => {
    expect(pageContextFromLocation("/app/inbox", "?c=cv_42")).toEqual({ id: "inbox.chat", conversationId: "cv_42" });
    expect(pageContextFromLocation("/app/inbox", new URLSearchParams("c=cv_42&x=1"))).toEqual({ id: "inbox.chat", conversationId: "cv_42" });
    expect(pageContextFromLocation("/app/contacts", "?c=cv_42")).toEqual({ id: "contacts" });
  });

  it("adds the selection a page announced, in its id field", () => {
    expect(pageContextFromLocation("/app/leads", "", { type: "lead", id: "ld_1" })).toEqual({ id: "leads", leadId: "ld_1", selection: { type: "lead", id: "ld_1" } });
    expect(pageContextFromLocation("/app/contacts", "", { type: "contact", id: "ct_1" })).toEqual({ id: "contacts", contactId: "ct_1", selection: { type: "contact", id: "ct_1" } });
    expect(pageContextFromLocation("/app/contacts", "", { type: "contact", id: "bad id" })).toEqual({ id: "contacts" });
    expect(pageContextFromLocation("/app/contacts/segments", "", { type: "segment", id: "sg_1" })).toEqual({ id: "contacts.segments", selection: { type: "segment", id: "sg_1" } });
  });

  it("keeps the latest selection until the route changes, and not after coming back", () => {
    const tracker = createSelectionTracker();
    tracker.set({ type: "lead", id: "ld_1" }, "/app/leads");
    expect(tracker.current("/app/leads")).toEqual({ type: "lead", id: "ld_1" });
    tracker.set({ type: "lead", id: "ld_2" }, "/app/leads");
    expect(tracker.current("/app/leads?x=1")).toEqual({ type: "lead", id: "ld_2" });
    expect(tracker.current("/app/contacts")).toBeNull();
    expect(tracker.current("/app/leads")).toBeNull();
    tracker.set({ type: "lead", id: "ld_3" }, "/app/leads");
    tracker.set(null, "/app/leads");
    expect(tracker.current("/app/leads")).toBeNull();
  });

  it("names the chip's subject and drops ids when the chip's x is tapped", () => {
    expect(contextSubject({ id: "inbox.chat", conversationId: "c1" })).toBe("chat");
    expect(contextSubject({ id: "leads", leadId: "l1" })).toBe("lead");
    expect(contextSubject({ id: "broadcasts.detail", broadcastId: "b1" })).toBe("broadcast");
    expect(contextSubject({ id: "templates" })).toBe("page");
    expect(contextSubject({ id: "dashboard" })).toBeNull();
    expect(withoutIds({ id: "inbox.chat", conversationId: "c1", selection: { type: "lead", id: "l" } })).toEqual({ id: "inbox.chat" });
  });

  it("carries no names or text, only ids (5.6)", () => {
    const page = pageContextFromLocation("/app/inbox", "?c=cv_1&q=Ramesh%20Kumar", { type: "contact", id: "ct_1" });
    expect(JSON.stringify(page)).not.toContain("Ramesh");
  });
});

// =====================================================================================================================
// Status store (5.11, 6.13)
// =====================================================================================================================

describe("useEddyStatus: the status call and the per-tab panel memory", () => {
  beforeEach(() => resetEddyStatusStore());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetEddyStatusStore();
  });

  it("parses the status DTO and falls back to safe values", () => {
    expect(parseStatus(status())).toEqual(status());
    expect(parseStatus({ state: "nope" })).toBeNull();
    expect(parseStatus(null)).toBeNull();
    const min = parseStatus({ state: "workspace_off", adminNames: ["Old Field"] })!;
    expect(min.canEnable).toBe(false);
    expect(min.ownerNames).toEqual(["Old Field"]);
    expect(min.needsYou).toBe(0);
    expect(min.langPref).toBe("auto");
    expect(min.whatsapp).toBe("none");
    expect(parseStatus({ state: "platform_off" })!.reason).toBe("not_configured");
    expect(parseStatus({ state: "platform_off", reason: "paused" })!.reason).toBe("paused");
    expect(parseStatus({ state: "ready", needsYou: 250 })!.needsYou).toBe(99);
    expect(historyDaysOf(status())).toBe(90);
    expect(historyDaysOf({ ...status(), historyDays: 120 } as EddyStatusDTO)).toBe(120);
    expect(historyDaysOf({ ...status(), historyDays: 5 } as EddyStatusDTO)).toBe(90);
  });

  it("loads GET /api/eddy/status once for concurrent callers and publishes it", async () => {
    const fetchMock = vi.fn(async () => Response.json(status({ needsYou: 2 })));
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([loadEddyStatus(), loadEddyStatus()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("/api/eddy/status");
    expect(a?.needsYou).toBe(2);
    expect(b?.needsYou).toBe(2);
    expect(readEddyStatusSnapshot().status?.needsYou).toBe(2);
    expect(readEddyStatusSnapshot().error).toBeNull();
  });

  it("keeps the last good status on a failure, and marks a 401 as signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(status())));
    await loadEddyStatus();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await loadEddyStatus();
    expect(readEddyStatusSnapshot().status?.state).toBe("ready");
    expect(readEddyStatusSnapshot().error).toBe("failed");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await loadEddyStatus();
    expect(readEddyStatusSnapshot().error).toBe("signed_out");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await loadEddyStatus();
    expect(readEddyStatusSnapshot().error).toBe("failed");
  });

  it("carries the working flag for the launcher, and local patches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(status({ firstUse: true }))));
    await loadEddyStatus();
    setEddyWorking(true);
    expect(readEddyStatusSnapshot().working).toBe(true);
    patchEddyStatus({ firstUse: false, langPref: "hi" });
    expect(readEddyStatusSnapshot().status).toMatchObject({ firstUse: false, langPref: "hi" });
  });

  it("remembers the open panel per tab, and survives storage that throws", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    expect(rememberedPanelOpen(storage)).toBe(false);
    rememberPanelOpen(true, storage);
    expect(store.get(EDDY_OPEN_KEY)).toBe("1");
    expect(rememberedPanelOpen(storage)).toBe(true);
    rememberPanelOpen(false, storage);
    expect(rememberedPanelOpen(storage)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => rememberPanelOpen(true, broken)).not.toThrow();
    expect(rememberedPanelOpen(broken)).toBe(false);
    expect(rememberedPanelOpen(null)).toBe(false);
  });
});

// =====================================================================================================================
// Turn stream (5.12): POST plus a ReadableStream reader, never EventSource
// =====================================================================================================================

const enc = new TextEncoder();
function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      c.close();
    },
  });
}
const sse = (e: EddyEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

describe("SSE parsing", () => {
  it("reassembles events split across chunks, ignores keepalive comments and tolerates CRLF", () => {
    const seen: EddyEvent[] = [];
    const p = createSseParser((e) => seen.push(e));
    p.push(": ka\n\n");
    p.push('event: delta\ndata: {"type":"delta","te');
    p.push('xt":"Hel"}\n');
    p.push("\n");
    p.push('data: {"type":"delta","text":"lo"}\r\n\r\n');
    p.push('event: end\r');
    p.push('\ndata: {"credits":2}\r\n\r\n');
    p.end();
    expect(seen).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "end", credits: 2 },
    ]);
  });

  it("joins multi-line data and drops malformed or unknown events", () => {
    const seen: EddyEvent[] = [];
    const p = createSseParser((e) => seen.push(e));
    p.push('data: {"type":"message",\ndata: "text":"Hi","lang":"hi"}\n\n');
    p.push("data: not json\n\n");
    p.push('data: {"type":"exfiltrate","text":"x"}\n\n');
    p.push('data: {"type":"delta"}\n\n');
    p.push('data: {"type":"card","card":{"actionId":"a"}}\n\n');
    p.end();
    expect(seen).toEqual([{ type: "message", text: "Hi", lang: "hi" }]);
  });

  it("reads a body with a reader, including a Devanagari character split across chunks", async () => {
    const bytes = enc.encode(sse({ type: "delta", text: "नमस्ते" }) + sse({ type: "end", credits: 1 }));
    const cut = bytes.indexOf(0xe0, 30) + 1; // inside a 3-byte character
    const seen: EddyEvent[] = [];
    const finished = await readEddyStream(streamOf([bytes.slice(0, cut), bytes.slice(cut)]), (e) => seen.push(e));
    expect(finished).toBe(true);
    expect(seen).toEqual([
      { type: "delta", text: "नमस्ते" },
      { type: "end", credits: 1 },
    ]);
  });

  it("reads exactly what the server writes (sseFrame and the keepalive comment of src/lib/eddy/sse.ts)", async () => {
    const events: EddyEvent[] = [
      { type: "turn", turnId: "t1", conversationId: "c1", lang: "hinglish" },
      { type: "status", key: "status.list_templates" },
      { type: "delta", text: "Aapke " },
      { type: "message", text: "Aapke **3** templates", lang: "hinglish" },
      { type: "card", card: card() },
      { type: "done_action", actionId: "a1", summaryKey: "done.tag_contacts", vars: { count: 2 }, undoUntil: iso(NOW) },
      { type: "refused_action", action: "delete_template", code: "role", who: ["Asha"] },
      { type: "intent", kind: "navigate", payload: { path: "/app/templates" } },
      { type: "error", state: "allowance_used", params: { need: 4, left: 1 } },
      { type: "end", credits: 3 },
    ];
    const body = events.map((e, i) => (i === 3 ? KEEPALIVE_FRAME : "") + sseFrame(e)).join("");
    const seen: EddyEvent[] = [];
    expect(await readEddyStream(streamOf([body.slice(0, 77), body.slice(77)]), (e) => seen.push(e))).toBe(true);
    expect(seen).toEqual(events);
  });

  it("the stream hook uses fetch and getReader, never EventSource", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/eddy/useEddyStream.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bEventSource\b/);
    expect(src).toContain("getReader()");
    expect(src).toMatch(/fetch\("\/api\/eddy\/turn"/);
  });
});

describe("postTurn: the POST, its events and its refusals", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs {text, page, conversationId, ref} and streams the events in order", async () => {
    const fetchMock = vi.fn(async () => new Response(streamOf([sse({ type: "turn", turnId: "t1", conversationId: "c1", lang: "en" }), sse({ type: "delta", text: "Hi" }), sse({ type: "message", text: "Hi there", lang: "en" }), sse({ type: "end", credits: 3 })]), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const seen: string[] = [];
    const out = await postTurn({ text: "Hello", page: { id: "inbox.chat", conversationId: "cv1" }, conversationId: "c1", ref: { kind: "notice", noticeId: "n1" } }, { onEvent: (e) => seen.push(e.type) });
    expect(out).toEqual({ kind: "streamed", finished: true });
    expect(seen).toEqual(["turn", "delta", "message", "end"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/eddy/turn");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).accept).toBe("text/event-stream");
    expect(JSON.parse(init.body as string)).toEqual({ text: "Hello", page: { id: "inbox.chat", conversationId: "cv1" }, conversationId: "c1", ref: { kind: "notice", noticeId: "n1" } });
  });

  it("a stream that ends without end or error is unfinished (the reply shows as interrupted)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamOf([sse({ type: "delta", text: "Hal" })]), { headers: { "content-type": "text/event-stream" } })));
    expect(await postTurn({ text: "x", page: null }, { onEvent: noop })).toEqual({ kind: "streamed", finished: false });
  });

  it("saves the unsent text before a 401 sign-in redirect", async () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    expect(await postTurn({ text: "Tag Ramesh as vip", page: null }, { onEvent: noop, storage })).toEqual({ kind: "signed_out" });
    expect(JSON.parse(store.get(EDDY_DRAFT_KEY)!).text).toBe("Tag Ramesh as vip");
    expect(hasDraft(storage)).toBe(true);
    expect(takeDraft(storage)).toBe("Tag Ramesh as vip");
    expect(takeDraft(storage)).toBeNull();
  });

  it("maps refusals before any stream to the panel's error states", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "busy" }, { status: 409 })));
    expect(await postTurn({ text: "x", page: null }, { onEvent: noop })).toEqual({ kind: "refused", state: "turn_in_progress" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await postTurn({ text: "x", page: null }, { onEvent: noop })).toEqual({ kind: "refused", state: "service_down" });
    expect(refusedState(402, { code: "ai_quota" }).state).toBe("allowance_used");
    expect(refusedState(402, { code: "workspace_locked" }).state).toBe("locked");
    // The billing paywall's own sentence, and a suspended workspace, are the locked state, never "the AI limit is used up".
    expect(refusedState(402, { error: "Your subscription is inactive. Your data is read-only until you subscribe at /app/billing." }).state).toBe("locked");
    expect(refusedState(403, { error: "This workspace has been suspended." }).state).toBe("locked");
    expect(refusedState(429, {}).state).toBe("rate_limited");
    expect(refusedState(413, {}).state).toBe("message_too_long");
    expect(refusedState(503, { code: "spend.busy" }).state).toBe("busy");
    expect(refusedState(503, {}).state).toBe("service_down");
    expect(refusedState(403, { state: "workspace_off" }).state).toBe("workspace_off");
    expect(refusedState(500, null).state).toBe("internal");
    expect(turnBody({ text: "x", page: null, newChat: true })).toEqual({ text: "x", page: null, newChat: true });
  });

  it("drafts expire and storage errors are swallowed", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    saveDraft("old", storage, 0);
    expect(hasDraft(storage, 2 * 60 * 60_000)).toBe(false);
    expect(takeDraft(storage, 2 * 60 * 60_000)).toBeNull();
    saveDraft("   ", storage);
    expect(store.size).toBe(0);
    const broken = {
      getItem: () => {
        throw new Error("x");
      },
      setItem: () => {
        throw new Error("x");
      },
      removeItem: () => {
        throw new Error("x");
      },
    };
    expect(() => saveDraft("x", broken)).not.toThrow();
    expect(takeDraft(broken)).toBeNull();
  });
});

// =====================================================================================================================
// Transcript state and the polite status region (6.3)
// =====================================================================================================================

const run = (events: EddyEvent[], start: StreamState = streamReducer(initialStreamState, { type: "member", text: "Kya haal hai?", lang: "hinglish" })) =>
  events.reduce((s, event) => streamReducer(s, { type: "event", event }), start);

describe("transcript state", () => {
  it("grows one Eddy bubble from deltas, then replaces it with the final message", () => {
    let s = run([{ type: "turn", turnId: "t1", conversationId: "c1", lang: "hinglish" }, { type: "status", key: "status.list_templates" }]);
    expect(s.working).toBe(true);
    expect(s.activity).toEqual({ key: "status.list_templates", text: undefined });
    s = run([{ type: "delta", text: "Aapke " }, { type: "delta", text: "templates" }], s);
    const eddy = s.items.filter((i) => i.kind === "eddy");
    expect(eddy).toHaveLength(1);
    expect(eddy[0]).toMatchObject({ text: "Aapke templates", streaming: true, lang: "hinglish" });
    s = run([{ type: "message", text: "Aapke **3** templates hain.", lang: "hinglish" }, { type: "end", credits: 2 }], s);
    expect(s.items.filter((i) => i.kind === "eddy")).toEqual([expect.objectContaining({ text: "Aapke **3** templates hain.", streaming: false })]);
    expect(s.working).toBe(false);
    expect(s.conversationId).toBe("c1");
    expect(s.lastSent).toBe("Kya haal hai?");
  });

  it("reset discards streamed text; cards, done rows, refusals and errors become items", () => {
    let s = run([{ type: "delta", text: "partial" }, { type: "reset" }, { type: "delta", text: "Safe" }]);
    expect(s.items.find((i) => i.kind === "eddy")).toMatchObject({ text: "Safe" });
    s = run([{ type: "card", card: card() }, { type: "done_action", actionId: "ar_2", summaryKey: "done.tag_contacts", vars: {}, undoUntil: iso(NOW + 60_000) }, { type: "refused_action", action: "delete_template", code: "role", who: ["Asha"] }, { type: "error", state: "service_down" }], s);
    expect(s.items.map((i) => i.kind)).toEqual(["member", "eddy", "card", "done", "refused", "error"]);
    expect(s.working).toBe(false);
    const replaced = run([{ type: "card", card: card({ actionId: "ar_9", supersedes: "ar_1" }) }], s);
    expect(replaced.items.filter((i) => i.kind === "card").map((i) => (i as Extract<TranscriptItem, { kind: "card" }>).card.actionId)).toEqual(["ar_9"]);
  });

  it("an interrupted reply keeps its text and says so; New chat starts over but keeps Up-arrow recall", () => {
    let s = run([{ type: "delta", text: "Half a rep" }]);
    s = streamReducer(s, { type: "interrupted" });
    expect(s.items.find((i) => i.kind === "eddy")).toMatchObject({ text: "Half a rep", interrupted: true, streaming: false });
    expect(s.working).toBe(false);
    s = streamReducer(s, { type: "new_chat" });
    expect(s.items).toEqual([]);
    expect(s.newChat).toBe(true);
    expect(s.lastSent).toBe("Kya haal hai?");
    const refused = streamReducer(streamReducer(initialStreamState, { type: "member", text: "x", lang: "en" }), { type: "refused", state: "turn_in_progress" });
    expect(refused.items.at(-1)).toMatchObject({ kind: "error", state: "turn_in_progress" });
  });

  it("the status region announces finished replies and new cards, never tokens", () => {
    const start = streamReducer(initialStreamState, { type: "member", text: "Send Ramesh a reply", lang: "en" });
    let prev = start;
    const said: (string | null)[] = [];
    for (const event of [{ type: "turn", turnId: "t", conversationId: "c", lang: "en" }, { type: "delta", text: "Here is " }, { type: "delta", text: "a draft" }, { type: "delta", text: " for you." }] as EddyEvent[]) {
      const next = streamReducer(prev, { type: "event", event });
      said.push(announcementFor(prev.items, next.items));
      prev = next;
    }
    expect(said).toEqual([null, null, null, null]);
    const done = streamReducer(prev, { type: "event", event: { type: "message", text: "Here is **a draft** for you.", lang: "en" } });
    expect(announcementFor(prev.items, done.items)).toBe("Eddy replied: Here is a draft for you.");
    const withCard = streamReducer(done, { type: "event", event: { type: "card", card: card() } });
    expect(announcementFor(done.items, withCard.items)).toBe("Preview ready: Send this reply to Ramesh. Send reply or cancel.");
    expect(announcementFor(withCard.items, withCard.items)).toBeNull();
    const row = streamReducer(withCard, { type: "event", event: { type: "done_action", actionId: "a2", summaryKey: "done.tag_contacts", vars: {} } });
    expect(announcementFor(withCard.items, row.items)).toBe(t("en", "done.tag_contacts"));
    const err = streamReducer(row, { type: "event", event: { type: "error", state: "service_down" } });
    expect(announcementFor(row.items, err.items)).toBe(t("en", "service_down"));
  });

  it("caps the reply announcement at 140 characters", () => {
    const long = "word ".repeat(80);
    const prev = run([{ type: "delta", text: long }]);
    const next = streamReducer(prev, { type: "event", event: { type: "message", text: long, lang: "en" } });
    const line = announcementFor(prev.items, next.items)!;
    expect(line.startsWith("Eddy replied: ")).toBe(true);
    expect(line.length).toBeLessThanOrEqual("Eddy replied: ".length + 141);
  });

  it("tells pages what changed (wa:eddy-did) for confirmed cards and done rows", () => {
    const s = run([{ type: "card", card: card() }, { type: "done_action", actionId: "ar_2", summaryKey: "done.tag_contacts", vars: {} }]);
    expect(didFor(s.items, "ar_1")).toEqual({ entity: "conversation", ids: ["cv1"] });
    expect(didFor(s.items, "ar_2")).toEqual({ entity: "contact", ids: [] });
    expect(didFor(s.items, "nope")).toBeNull();
    expect(entityForAction("done.delete_template")).toBe("template");
    expect(entityForAction("list_templates")).toBeNull();
    expect(targetIdsOf(card({ preview: preview({ material: { targetId: "bad id" } }) }))).toEqual([]);
    expect(onScreenItems(s.items).map((i) => i.kind)).toEqual(["card", "done"]);
  });

  it("rebuilds the transcript from the server's history after a sign-in", () => {
    expect(latestConversationId({ conversations: [{ id: "old", status: "closed", lastMessageAt: "2026-10-01" }, { id: "cur", status: "active" }] })).toBe("cur");
    expect(latestConversationId([{ id: "a", lastMessageAt: "2026-10-01" }, { id: "b", lastMessageAt: "2026-10-20" }])).toBe("b");
    expect(latestConversationId(null)).toBeNull();
    // The shape of GET /api/eddy/conversations/[id]: {conversation, messages: [{id, role, kind, display}]}.
    const h = historyFromJson({
      conversation: { id: "c1", language: "hi", status: "active" },
      messages: [
        { id: "m1", seq: 0, role: "user", kind: "user_text", display: { text: "टेम्पलेट दिखाइए", lang: "hi" } },
        { id: "m2", seq: 2, role: "assistant", kind: "assistant", display: { text: "ये रहे", lang: "hi" } },
        { id: "m3", seq: 3, role: "user", kind: "tool_results", display: { text: "Customer said <b>hi</b>" } },
        { id: "m4", seq: 4, role: "system", kind: "context_note", display: { text: "<eddy_context>" } },
        { id: "m5", seq: 5, role: "assistant", kind: "placeholder", display: { interrupted: true } },
        { id: "m6", seq: 6, role: "assistant", kind: "assistant", display: { refusal: true, lang: "en" } },
      ],
    })!;
    expect(h.conversationId).toBe("c1");
    expect(h.items.map((i) => i.kind)).toEqual(["member", "eddy", "eddy", "eddy"]);
    expect(h.items[0]).toMatchObject({ text: "टेम्पलेट दिखाइए", lang: "hi" });
    expect(h.items[2]).toMatchObject({ interrupted: true, text: "" });
    expect(h.items[3]).toMatchObject({ text: t("en", "refusal") });
    expect(JSON.stringify(h.items)).not.toContain("Customer said");
    expect(JSON.stringify(h.items)).not.toContain("eddy_context");
    // An older raw shape (content blocks) still works, and a full card comes back as a card.
    const raw = historyFromJson({ conversationId: "c2", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Hi" }] }], cards: [card({ lang: "hi" })] })!;
    expect(raw.items.map((i) => i.kind)).toEqual(["eddy", "card"]);
    expect(JSON.stringify(raw.items)).not.toContain("secret");
    const restored = streamReducer(initialStreamState, { type: "restore", items: h.items, conversationId: h.conversationId, lang: h.lang });
    expect(restored.items).toHaveLength(4);
    expect(latestConversationId({ conversations: [{ id: "x", status: "closed" }, { id: "y", active: true, status: "weird" }] })).toBe("y");
    expect(restored.conversationId).toBe("c1");
  });
});

// =====================================================================================================================
// Composer (6.3)
// =====================================================================================================================

describe("composer", () => {
  const ctx = { value: "hello", working: false, lastSent: "previous" };

  it("Enter and Shift+Enter follow the inbox setting; Ctrl/Cmd+Enter always sends; IME composition is left alone", () => {
    expect(composerKeyAction({ key: "Enter" }, "enter", ctx)).toBe("send");
    expect(composerKeyAction({ key: "Enter", shiftKey: true }, "enter", ctx)).toBeNull();
    expect(composerKeyAction({ key: "Enter" }, "mod-enter", ctx)).toBeNull();
    expect(composerKeyAction({ key: "Enter", ctrlKey: true }, "mod-enter", ctx)).toBe("send");
    expect(composerKeyAction({ key: "Enter", metaKey: true }, "mod-enter", ctx)).toBe("send");
    expect(composerKeyAction({ key: "Enter", isComposing: true }, "enter", ctx)).toBeNull();
    expect(composerKeyAction({ key: "Enter" }, "enter", { ...ctx, working: true })).toBeNull();
  });

  it("Up arrow recalls the last message only in an empty composer", () => {
    expect(composerKeyAction({ key: "ArrowUp" }, "enter", { ...ctx, value: "" })).toBe("recall");
    expect(composerKeyAction({ key: "ArrowUp" }, "enter", ctx)).toBeNull();
    expect(composerKeyAction({ key: "ArrowUp" }, "enter", { ...ctx, value: "", lastSent: null })).toBeNull();
  });

  it("warns locally about card numbers (Luhn) and one-time codes", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(pasteWarning("my card 4111 1111 1111 1111 exp 12/28")).toBe("card");
    expect(pasteWarning("4111-1111-1111-1111")).toBe("card");
    expect(pasteWarning("4111 1111 1111 1112")).toBeNull();
    expect(pasteWarning("482913")).toBe("otp");
    expect(pasteWarning("Your OTP is 482913. Do not share it.")).toBe("otp");
    expect(pasteWarning("आपका ओटीपी 4829 है")).toBe("otp");
    expect(pasteWarning("Order 12345 shipped to Pune")).toBeNull();
    expect(pasteWarning("+91 98765 43210")).toBeNull();
    expect(pasteWarning("Rs 2,000 per month")).toBeNull();
    expect(pasteWarning("OTP: valid till 10.5 hours")).toBeNull();
    expect(pasteWarning("")).toBeNull();
  });

  it("shows the counter from 1,800 and grows to 5 lines", () => {
    expect(COMPOSER_MAX).toBe(2000);
    expect(showCounter(COUNTER_FROM - 1)).toBe(false);
    expect(showCounter(COUNTER_FROM)).toBe(true);
    expect(autogrowHeight(10, 24, 20)).toBe(44);
    expect(autogrowHeight(80, 24, 20)).toBe(80);
    expect(autogrowHeight(900, 24, 20)).toBe(140);
  });

  it("renders a labelled 16 px textarea with a 2,000 limit, Send 44 px, and Stop while working", () => {
    const idle = html(h(Composer, { lang: "en", value: "", onChange: noop, onSend: noop, onStop: noop, working: false, lastSent: null }));
    expect(idle).toMatch(/<label[^>]*>Message to Eddy<\/label>/);
    expect(idle).toContain('maxLength="2000"');
    expect(idle).toContain('enterKeyHint="send"');
    expect(idle).toContain("text-base!");
    expect(idle).toContain('placeholder="Ask Eddy anything about Edwyz"');
    expect(idle).toMatch(/aria-label="Send to Eddy"[^>]*|class="[^"]*h-11 w-11[^"]*"[^>]*aria-label="Send to Eddy"/);
    expect(idle).not.toContain("Stop Eddy");
    expect(idle).not.toContain("of 2,000 characters");
    const busy = html(h(Composer, { lang: "en", value: "x".repeat(1850), onChange: noop, onSend: noop, onStop: noop, working: true, lastSent: null }));
    expect(busy).toContain('aria-label="Stop Eddy&#x27;s reply"');
    expect(textOf(busy)).toContain("1,850 of 2,000 characters");
    expect(themeProblems(busy)).toEqual([]);
    const hi = html(h(Composer, { lang: "hi", value: "", onChange: noop, onSend: noop, onStop: noop, working: false, lastSent: null }));
    expect(hi).toContain('lang="hi"');
    expect(textOf(hi)).toContain("Eddy के लिए मैसेज");
  });
});

// =====================================================================================================================
// Context chip, starter chips (6.3, 6.10)
// =====================================================================================================================

describe("context chip and starter chips", () => {
  it("renders an untrusted name as plain text, cut by grapheme, with an x that drops context", () => {
    const markup = html(h(ContextChip, { lang: "en", subject: "chat", name: '<img src=x onerror="alert(1)">Ramesh', onRemove: noop }));
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    expect(markup).toContain("<bdi");
    expect(markup).toContain('aria-label="Don&#x27;t use this chat in the next message"');
    expect(contextChipLabel("en", "chat", "Ramesh K")).toBe("Using: this chat · Ramesh K");
    expect(contextChipLabel("en", "lead")).toBe("Using: this lead");
    expect(contextChipLabel("en", "chat", "Rame‮sh\u0007")).toBe("Using: this chat · Ramesh");
    const long = "नमस्ते क्षत्रिय ".repeat(10);
    const label = contextChipLabel("hi", "chat", long);
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const name = label.split(" · ")[1];
    expect(Array.from(seg.segment(name)).length).toBeLessThanOrEqual(CHIP_NAME_GRAPHEMES + 1);
    expect(label.startsWith("इस्तेमाल हो रहा है: यह चैट")).toBe(true);
  });

  it("starter chips follow the page and the member's language; no WhatsApp turns the dashboard into the next setup step", () => {
    expect(startersFor("en", "inbox.chat").map((c) => c.label)).toEqual(["Summarize this chat", "Draft a polite reply", "Why did my message fail?"]);
    expect(startersFor("hi", "inbox.chat")[0].label).toBe("इस चैट का सार बताइए");
    expect(startersFor("hinglish", "broadcasts.detail")[0].label).toBe("Kitna kharcha aayega?");
    expect(startersFor("en", "dashboard", "none").map((c) => c.key)).toEqual(["start.dashboard.next_step"]);
    const markup = html(h(StarterChips, { lang: "hi", pageId: "dashboard", onPick: noop }));
    expect(markup).toContain('lang="hi"');
    expect(textOf(markup)).toContain("आज क्या देखना है?");
    expect(gotoChips("en", "templates")[0]).toEqual({ path: "/app/templates", label: "Go to Templates" });
    expect(gotoChips("en", "templates").every((g) => g.path.startsWith("/app"))).toBe(true);
  });
});

// =====================================================================================================================
// Off states, the enable card and the first-use notice, per role (6.11, 12.1a decision 6)
// =====================================================================================================================

const OFF: { kind: OffKind; status: EddyStatusDTO | null }[] = [
  { kind: "platform_off", status: status({ state: "platform_off", reason: "not_configured" }) },
  { kind: "platform_off", status: status({ state: "platform_off", reason: "paused" }) },
  { kind: "locked", status: status({ state: "locked" }) },
  { kind: "workspace_off", status: status({ state: "workspace_off" }) },
  { kind: "paused", status: status({ state: "paused" }) },
  { kind: "allowance_used", status: status({ state: "allowance_used", allowance: { ...status().allowance, usedMonth: 500, limitMonth: 500 } }) },
  { kind: "user_capped", status: status({ state: "user_capped" }) },
  { kind: "offline", status: null },
  { kind: "error", status: null },
];

const offState = (kind: OffKind, s: EddyStatusDTO | null, role: string, lang: EddyLang = "en") => html(h(OffState, { kind, lang, status: s, role, pageId: "dashboard", setup: h("p", { "data-test-setup": "" }, "setup list"), onScreen: h("p", { "data-test-on-screen": "" }, "cards"), notices: h("p", { "data-test-notices": "" }, "notices") }));

describe("off states (6.11): plain buttons, no input box", () => {
  it("picks the off state from the status or the load error", () => {
    expect(offKindOf(status(), null)).toBeNull();
    expect(offKindOf(null, null)).toBeNull();
    expect(offKindOf(null, "failed")).toBe("error");
    expect(offKindOf(status(), "offline")).toBe("offline");
    expect(offKindOf(status({ state: "user_capped" }), null)).toBe("user_capped");
  });

  it.each(OFF.flatMap((o) => (["owner", "admin", "agent"] as const).map((role) => [o.kind, o.status?.reason ?? "", role, o.status] as const)))("%s %s renders for %s, in every language, with tokens only", (kind, _reason, role, s) => {
    for (const lang of EDDY_LANGS) {
      const markup = offState(kind, s, role, lang);
      expect(markup).not.toContain("<textarea");
      expect(markup).toContain(`data-eddy-off="${kind}"`);
      expect(textOf(markup)).not.toMatch(/\{[a-z]+\}/);
      expect(themeProblems(markup)).toEqual([]);
    }
  });

  it("platform_off says not set up yet, or paused by the team, then the setup list, notices, cards and Go to buttons", () => {
    const a = textOf(offState("platform_off", OFF[0].status, "agent"));
    expect(a).toContain(t("en", "off.platform"));
    for (const part of ["setup list", "notices", "cards", "Go to Dashboard", "Go to Inbox"]) expect(a).toContain(part);
    expect(textOf(offState("platform_off", OFF[1].status, "agent"))).toContain(t("en", "off.platform_paused"));
  });

  it("locked: admins get Go to billing, team members are told to ask", () => {
    const admin = offState("locked", OFF[2].status, "admin");
    expect(textOf(admin)).toContain(t("en", "locked.admin"));
    expect(admin).toContain('href="/app/billing"');
    const agent = offState("locked", OFF[2].status, "agent");
    expect(textOf(agent)).toContain(t("en", "locked.agent"));
    expect(agent).not.toContain('href="/app/billing"');
  });

  it("allowance_used names the reset date (month) or tomorrow (day); admins get See spending limits", () => {
    const month = offState("allowance_used", OFF[5].status, "owner");
    expect(textOf(month)).toContain(t("en", "allowance.used", { date: "1 Nov" }));
    expect(month).toContain('href="/app/settings/spending"');
    expect(offState("allowance_used", OFF[5].status, "agent")).not.toContain('href="/app/settings/spending"');
    const day = status({ state: "allowance_used", allowance: { ...status().allowance, usedToday: 40, limitToday: 40 } });
    expect(dayLimitUsed(day)).toBe(true);
    expect(offText("en", "allowance_used", day, "agent")).toBe(t("en", "allowance.used_today"));
    // 95 of 100 used today, less left than the smallest turn: the server says "day", and the panel says today's limit,
    // never "this month's limit resets <tomorrow>".
    const nearly = status({ state: "allowance_used", allowance: { ...status().allowance, usedToday: 95, limitToday: 100, resetsOn: "2026-10-30", period: "day" } });
    expect(dayLimitUsed(nearly)).toBe(true);
    expect(offText("en", "allowance_used", nearly, "owner")).toBe(t("en", "allowance.used_today"));
    const monthly = status({ state: "allowance_used", allowance: { ...status().allowance, usedToday: 40, limitToday: 40, resetsOn: "2026-11-01", period: "month" } });
    expect(dayLimitUsed(monthly)).toBe(false);
    expect(resetDate("2026-11-01")).toBe("1 Nov");
    expect(resetDate("nope")).toBeNull();
  });

  it("paused shows Phase 0's freeze copy; user_capped and the network states have their own lines and Retry", () => {
    expect(textOf(offState("paused", OFF[4].status, "agent"))).toContain(spendMessage("en", "spend.frozen"));
    expect(textOf(offState("user_capped", OFF[6].status, "agent"))).toContain(t("en", "user_capped"));
    for (const kind of ["offline", "error"] as const) {
      const m = textOf(offState(kind, null, "agent"));
      expect(m).toContain(t("en", kind === "offline" ? "offline" : "status_error"));
      expect(m).toContain("Retry");
    }
  });
});

describe("Turn on Eddy (12.1a decision 6): only the owner switches it on, with one tap that records consent", () => {
  it("the owner gets the disclosure, the consent line and one button; admins and agents get the owner's name and no button", () => {
    const owner = html(h(EnableCard, { lang: "en", canEnable: true, ownerNames: ["Asha Owner"], historyDays: 90, onTurnOn: noop, onNotNow: noop }));
    const text = textOf(owner);
    expect(text).toContain("Turn on Eddy");
    expect(text).toContain(t("en", "turnon.what"));
    expect(text).toContain("One message uses at most 30 credits, and each person at most 40 credits a day.");
    expect(text).toContain(t("en", "enable.body", { days: 90 }));
    expect(text).toContain(t("en", "turnon.consent"));
    expect(owner.match(/<button/g)?.length).toBe(2);
    expect(owner).toContain(`href="${EDDY_SETTINGS_PAGE}"`);
    for (const lang of EDDY_LANGS) {
      const other = html(h(EnableCard, { lang, canEnable: false, ownerNames: ["Asha Owner"], historyDays: 90 }));
      expect(other).not.toContain("<button");
      expect(textOf(other)).toContain(t(lang, "turnon.ask_owner", { names: "Asha Owner" }));
      expect(textOf(other)).not.toContain(t(lang, "turnon.consent"));
    }
    expect(enableCardBody("en", false, [], 90)).toContain("Ask the owner: —.");
  });

  it("the workspace_off off state shows the card per role", () => {
    const off = status({ state: "workspace_off", canEnable: true });
    const owner = offState("workspace_off", off, "owner");
    expect(owner.match(/<button/g)?.length).toBe(1);
    expect(textOf(owner)).toContain("Turn on Eddy");
    expect(html(h(OffState, { kind: "workspace_off", lang: "en", status: off, role: "owner", onNotNow: noop })).match(/<button/g)?.length).toBe(2);
    expect(offState("workspace_off", status({ state: "workspace_off", canEnable: false }), "admin")).not.toContain("<button");
    expect(textOf(offState("workspace_off", status({ state: "workspace_off", canEnable: false }), "agent"))).toContain("Ask the owner: Asha Owner.");
  });

  it("the tap is one PUT /api/eddy/settings {enabled: true}", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await putEddyEnabled(true)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/eddy/settings");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    expect(await putEddyEnabled(true)).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("Settings > AI tools: the owner's switch (12.1a decision 6)", () => {
  it("only the owner gets the switch; others see the state and who can change it", () => {
    const owner = html(h(EddySettingsView, { lang: "en", status: status({ state: "workspace_off", canEnable: true }), enabled: false, onToggle: noop }));
    expect(owner).toContain('role="switch"');
    expect(owner).toContain('aria-checked="false"');
    expect(textOf(owner)).toContain(t("en", "enable.body", { days: 90 }));
    expect(textOf(owner)).toContain(t("en", "turnon.consent"));
    const on = html(h(EddySettingsView, { lang: "en", status: status({ canEnable: true }), enabled: true, onToggle: noop }));
    expect(on).toContain('aria-checked="true"');
    expect(textOf(on)).toContain(tp("en", "panel.settings.turn_off_note"));
    expect(textOf(on)).not.toContain(t("en", "turnon.consent"));
    for (const s of [status({ canEnable: false }), status({ state: "workspace_off", canEnable: false })]) {
      const other = html(h(EddySettingsView, { lang: "en", status: s, enabled: s.state === "ready" }));
      expect(other).not.toContain('role="switch"');
      expect(textOf(other)).toContain("Ask the owner: Asha Owner.");
      expect(textOf(other)).toContain(s.state === "ready" ? "Eddy is on for this workspace." : "Eddy is off for this workspace.");
    }
    expect(themeProblems(owner)).toEqual([]);
  });

  it("knows whether Eddy is on from the settings answer or the status", () => {
    expect(enabledFrom({ enabled: true }, null)).toBe(true);
    expect(enabledFrom({ settings: { enabled: false } }, status())).toBe(false);
    expect(enabledFrom(null, status({ state: "workspace_off" }))).toBe(false);
    expect(enabledFrom(null, status({ state: "allowance_used" }))).toBe(true);
    expect(enabledFrom(null, status({ state: "platform_off" }))).toBeNull();
    expect(enabledFrom(null, null)).toBeNull();
  });
});

describe("the first-use notice (6.11)", () => {
  it("shows above the composer the first time a member opens Eddy, with Got it, and not after", () => {
    const first = html(h(EddyFooter, { c: controller({ status: status({ firstUse: true }) }) }));
    expect(textOf(first)).toContain(t("en", "notice.first_use", { days: 90 }));
    expect(textOf(first)).toContain("Got it");
    expect(first.indexOf("data-eddy-first-use")).toBeLessThan(first.indexOf("<textarea"));
    expect(html(h(EddyFooter, { c: controller() }))).not.toContain("data-eddy-first-use");
    expect(textOf(html(h(FirstUseNotice, { lang: "hinglish", days: 120, onAck: noop })))).toContain("120 din");
  });

  it("is not shown in an off state, where there is no composer at all", () => {
    expect(html(h(EddyFooter, { c: controller({ status: status({ state: "platform_off", firstUse: true }) }) }))).toBe("");
  });
});

// =====================================================================================================================
// The desktop panel (6.2, 6.3, 6.13)
// =====================================================================================================================

describe("desktop panel", () => {
  it("is a labelled non-modal aside that overlays below 2xl (z-overlay, elev-3) and pushes at 2xl", () => {
    const markup = html(h(EddyPanel, { c: controller() }));
    expect(markup).toMatch(/^<aside[^>]*id="eddy-panel"/);
    expect(markup).toMatch(/<aside[^>]*data-eddy-root=/);
    expect(markup).not.toContain('aria-modal="true"');
    expect(markup).toContain("z-(--z-overlay)");
    expect(markup).toContain("shadow-modal");
    expect(markup).toContain("2xl:sticky");
    expect(markup).toContain("width:384px");
    expect(markup).toMatch(/font-family:system-ui, &#x27;Nirmala UI&#x27;, &#x27;Noto Sans Devanagari&#x27;/);
    expect(markup).toMatch(/<h2 id="[^"]+"[^>]*>Eddy<\/h2>/);
    expect(markup).toContain('aria-label="Close Eddy"');
    expect(markup).toContain('aria-label="Eddy menu"');
    expect(themeProblems(markup)).toEqual([]);
  });

  it("has the log, the polite status region, the greeting with starter chips, the context chip and the composer", () => {
    const markup = html(h(EddyPanel, { c: controller() }));
    expect(markup).toMatch(/role="log" aria-live="off"/);
    expect(markup).toMatch(/role="status" aria-live="polite" aria-atomic="true"/);
    expect(textOf(markup)).toContain("Hi Anshu, I'm Eddy.");
    expect(textOf(markup)).toContain("Summarize this chat");
    expect(textOf(markup)).toContain("Using: this chat");
    expect(markup).toContain("<textarea");
    expect(textOf(markup)).toContain(t("en", "eddy.state.ready"));
  });

  it("renders transcript items through the cards package, each with its lang", () => {
    const items: TranscriptItem[] = [
      { kind: "member", id: "m1", text: "Templates dikhaiye", lang: "hinglish" },
      { kind: "eddy", id: "e1", text: "**Aapke 3 templates** hain.", lang: "hinglish" },
      { kind: "eddy", id: "e2", text: "ये रहे", lang: "hi" },
      { kind: "card", id: "c-ar_1", lang: "en", card: card({ expiresAt: iso(Date.now() + 15 * 60_000) }) },
    ];
    const markup = html(h(EddyPanel, { c: controller({ session: session({ ...initialStreamState, items }) }) }));
    expect(markup).toContain('lang="hi-Latn"');
    expect(markup).toContain('lang="hi"');
    expect(markup).toContain("<strong");
    expect(markup).toContain("Send reply");
    expect(markup).not.toContain("data-eddy-greeting");
  });

  it("shows banners for read-only members and a spending stop", () => {
    const markup = textOf(html(h(EddyPanel, { c: controller({ status: status({ readOnly: true, spendingStopped: true }) }) })));
    expect(markup).toContain(t("en", "verify.readonly"));
    expect(markup).toContain(t("en", "spending_banner"));
  });

  it("an off state replaces the transcript and the composer; cards on screen stay usable", () => {
    const items: TranscriptItem[] = [{ kind: "card", id: "c-ar_1", lang: "en", card: card({ expiresAt: iso(Date.now() + 15 * 60_000) }) }];
    const markup = html(h(EddyPanel, { c: controller({ status: status({ state: "allowance_used" }), session: session({ ...initialStreamState, items }) }) }));
    expect(markup).not.toContain("<textarea");
    expect(markup).toContain("data-eddy-on-screen");
    expect(textOf(markup)).toContain("Send reply");
    expect(markup).not.toMatch(/role="log"/);
  });

  it("status pill, chip subject, usage lines and the obscured-focus geometry", () => {
    expect(pillState(status(), true)).toBe("working");
    expect(pillState(status({ state: "workspace_off" }), false)).toBe("workspace_off");
    expect(pillState(null, false)).toBeNull();
    expect(chipSubject(controller({ openRef: { kind: "message", messageId: "m1" } }))).toBe("message");
    expect(chipSubject(controller({ contextDropped: true }))).toBeNull();
    expect(chipSubject(controller({ page: { id: "dashboard" } }))).toBeNull();
    expect(usageLines("en", status())).toEqual(["You've used 4 of 40 Eddy credits today.", "This workspace has used 120 of 500 AI credits this month.", "Eddy and the AI agent share the workspace's AI limit."]);
    expect(usageLines("en", status({ allowance: { ...status().allowance, limitMonth: null } }))[1]).toBe("This workspace has used 120 AI credits this month.");
    const panel = { left: 896, right: 1280, top: 0, bottom: 800 };
    expect(obscuredBy({ left: 900, right: 1000, top: 10, bottom: 40 }, panel)).toBe(true);
    expect(obscuredBy({ left: 100, right: 800, top: 10, bottom: 40 }, panel)).toBe(false);
  });
});

// =====================================================================================================================
// The phone sheet: Back closes it, keyboard inset (6.2, 9.4 scenario 18)
// =====================================================================================================================

function fakeWindow() {
  const listeners = new Map<string, Set<() => void>>();
  const timers: (() => void)[] = [];
  return {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
    flush: () => {
      while (timers.length) timers.shift()!();
    },
    listening: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

function fakeHistory(win: ReturnType<typeof fakeWindow>) {
  const stack: unknown[] = [{ __NA: true, tree: "page" }];
  return {
    stack,
    get state() {
      return stack[stack.length - 1];
    },
    pushState(s: unknown) {
      stack.push(s);
    },
    back() {
      stack.pop();
      win.setTimeout(() => win.fire("popstate")); // the browser fires popstate later
    },
  };
}

describe("phone sheet: Back closes it and keeps the draft (EddyRoot holds it)", () => {
  it("pushes one entry that keeps the router's state keys", () => {
    expect(sheetHistoryState({ __NA: true, tree: "t" })).toEqual({ __NA: true, tree: "t", eddy: true });
    expect(sheetHistoryState(null)).toEqual({ eddy: true });
    expect(isSheetEntry({ eddy: true })).toBe(true);
    expect(isSheetEntry({ __NA: true })).toBe(false);
  });

  it("Android Back pops the entry and closes the sheet once", () => {
    const win = fakeWindow();
    const hist = fakeHistory(win);
    const onClose = vi.fn();
    const c = createSheetHistory(hist as unknown as History, win as unknown as Window, onClose);
    c.mount();
    expect(hist.stack).toHaveLength(2);
    expect(hist.state).toEqual({ __NA: true, tree: "page", eddy: true });
    hist.back();
    win.flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    c.unmount();
    win.flush();
    expect(hist.stack).toHaveLength(1);
    expect(win.listening("popstate")).toBe(0);
  });

  it("closing another way pops the entry first, then navigates (no race with the route change)", () => {
    const win = fakeWindow();
    const hist = fakeHistory(win);
    const order: string[] = [];
    const c = createSheetHistory(hist as unknown as History, win as unknown as Window, () => order.push("close"));
    c.mount();
    c.requestClose(() => order.push(`navigate with ${hist.stack.length} entries`));
    expect(order).toEqual([]);
    win.flush();
    expect(order).toEqual(["close", "navigate with 1 entries"]);
    c.unmount();
    win.flush();
    expect(hist.stack).toHaveLength(1);
  });

  it("a remount (development) keeps a single entry, and an unmount without Back pops it", () => {
    const win = fakeWindow();
    const hist = fakeHistory(win);
    const a = createSheetHistory(hist as unknown as History, win as unknown as Window, noop);
    a.mount();
    a.unmount();
    const b = createSheetHistory(hist as unknown as History, win as unknown as Window, noop);
    b.mount();
    win.flush();
    expect(hist.stack).toHaveLength(2);
    b.unmount();
    win.flush();
    expect(hist.stack).toHaveLength(1);
  });

  it("keeps the composer above the on-screen keyboard", () => {
    expect(keyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
    expect(keyboardInset(800, { height: 800, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(800, null)).toBe(0);
  });
});

// =====================================================================================================================
// Shell integration (6.1, EDDY-14)
// =====================================================================================================================

describe("shell integration", () => {
  it("the launcher: Ask Eddy with the 20 px avatar, a needs-you count for screen readers, working while closed", () => {
    const markup = html(h(ShellProvider, { value: shell() }, h(EddyLauncher)));
    expect(markup).toContain('aria-label="Ask Eddy"');
    expect(markup).toContain("data-eddy-launcher");
    expect(markup).toContain('width="20"');
    expect(markup).toContain('aria-expanded="false"');
    expect(launcherLabel("en", 2, false)).toBe("Ask Eddy, 2 things need you");
    expect(launcherLabel("en", 1, false)).toBe("Ask Eddy, 1 thing needs you");
    expect(launcherLabel("hinglish", 1, false)).toBe("Eddy se poochhiye, 1 cheez aapka wait kar rahi hai");
    expect(launcherLabel("hi", 0, false)).toBe("Eddy से पूछें");
    expect(launcherLabel("en", 0, true)).toBe("Ask Eddy, still working on your last message");
    expect(launcherAvatarState({ working: false, needsYou: 2, ready: true })).toBe("needs_action");
    expect(launcherAvatarState({ working: true, needsYou: 2, ready: true })).toBe("working");
    expect(launcherAvatarState({ working: false, needsYou: 0, ready: false })).toBe("off");
    expect(chromeLang("auto", null)).toBe("en");
    expect(chromeLang("auto", "hinglish")).toBe("hinglish");
    expect(chromeLang("hi", "en")).toBe("hi");
  });

  it("the palette always lists Ask Eddy and offers Ask Eddy: \"query\" when nothing matches", () => {
    for (const role of ["agent", "admin", "owner"] as const) {
      const ask = buildCommands(role).find((c) => c.id === "ask-eddy");
      expect(ask, role).toMatchObject({ label: "Ask Eddy", run: "ask-eddy", group: "Quick actions" });
    }
    expect(askEddyLabel("  how much is left  ")).toBe('Ask Eddy: "how much is left"');
    const palette = readFileSync(path.resolve(__dirname, "../src/components/app/CommandPalette.tsx"), "utf8");
    expect(palette).toContain("askEddyLabel(query)");
    expect(palette).toMatch(/run === "ask-eddy"/);
  });

  it("is wired into the shell without a floating button, a seventh tab or a new single-key shortcut", () => {
    const read = (f: string) => readFileSync(path.resolve(__dirname, `../src/components/app/${f}`), "utf8");
    expect(read("AppShell.tsx")).toMatch(/<\/main>\s*<\/div>\s*<EddyRoot /);
    expect(read("AppShell.tsx")).toContain("onEddyEvent(EDDY_EVENTS.open");
    expect(read("TopBar.tsx").match(/<EddyLauncher/g)).toHaveLength(2);
    expect(read("HelpMenu.tsx")).toContain('label: "Ask Eddy"');
    expect(read("MobileDrawer.tsx")).toContain("Ask Eddy");
    expect(read("MobileTabBar.tsx")).not.toMatch(/eddy/i);
    expect(read("shortcuts.ts")).not.toMatch(/eddy/i);
    expect(read("shell-context.tsx")).toMatch(/openEddy: [\s\S]*closeEddy: \(\) => void;\s*eddyOpen: boolean;/);
  });

  it("the panel bundle loads lazily (next/dynamic) and nothing else imports it statically", () => {
    const root = readFileSync(path.resolve(__dirname, "../src/components/eddy/EddyRoot.tsx"), "utf8");
    expect(root).toMatch(/dynamic\(\(\) => import\("\.\/EddyPanel"\)/);
    expect(root).toMatch(/dynamic\(\(\) => import\("\.\/EddySheet"\)/);
    expect(root).not.toMatch(/^import \{[^}]*\bEddyPanel\b[^}]*\} from "\.\/EddyPanel"/m);
    const shellFiles = ["AppShell.tsx", "TopBar.tsx", "CommandPalette.tsx", "HelpMenu.tsx", "MobileDrawer.tsx"].map((f) => readFileSync(path.resolve(__dirname, `../src/components/app/${f}`), "utf8"));
    for (const src of shellFiles) expect(src).not.toMatch(/from "@\/components\/eddy\/(EddyPanel|EddySheet|Transcript|PreviewCard|MessageView)"/);
  });

  it("the phone sheet's close button speaks the member's language (Dialog closeLabel), like the desktop panel's", () => {
    const sheet = readFileSync(path.resolve(__dirname, "../src/components/eddy/EddySheet.tsx"), "utf8");
    expect(sheet).toContain('closeLabel={tp(c.lang, "panel.close")}');
    const dialog = readFileSync(path.resolve(__dirname, "../src/components/ui/Dialog.tsx"), "utf8");
    expect(dialog).toContain('closeLabel = "Close dialog"');
    expect(dialog).toContain("aria-label={closeLabel}");
    expect([tp("en", "panel.close"), tp("hi", "panel.close"), tp("hinglish", "panel.close")]).toEqual(["Close Eddy", "Eddy बंद करें", "Eddy band kariye"]);
  });

  it("the Leads and Contacts pages say which lead or contact is open (wa:eddy-selection)", () => {
    expect(readFileSync(path.resolve(__dirname, "../src/components/leads/LeadsView.tsx"), "utf8")).toMatch(/dispatchEddyEvent\("wa:eddy-selection", \{ type: "lead", id: open \}\)/);
    expect(readFileSync(path.resolve(__dirname, "../src/components/contacts/ContactsView.tsx"), "utf8")).toMatch(/dispatchEddyEvent\("wa:eddy-selection", \{ type: "contact", id: dialog\.contact\.id \}\)/);
  });
});

describe("EddyRoot: intents and the member's bubble language", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tags the member's own bubble hi for Devanagari, else the conversation's Latin language", () => {
    expect(memberLang("टेम्पलेट दिखाइए", null)).toBe("hi");
    expect(memberLang("templates dikhaiye", "hinglish")).toBe("hinglish");
    expect(memberLang("show templates", "hi")).toBe("en");
  });

  it("acts on intents only for /app paths and checked ids; drafts go to the open chat's composer", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", Object.assign(target, { setTimeout: (fn: () => void) => (fn(), 1) }));
    const navigate = vi.fn();
    // Integration fix (wave 4): navigate and connect intents never move the member on their own. EDDY-SPEC 4.6 open_page
    // "returns a navigate chip ... Eddy navigates only when the member taps it", and 6.15 says Meta's consent screens start
    // "from a member's tap on an intent card, never from the model". They become transcript chips (applyIntent in
    // useEddyStream.ts, tested in tests/eddy-integration-seams.test.ts) whose tap navigates to the same paths.
    runIntent({ type: "intent", kind: "navigate", payload: { path: "/app/templates" } }, navigate, undefined);
    runIntent({ type: "intent", kind: "navigate", payload: { path: "https://evil.example/app" } }, navigate, undefined);
    runIntent({ type: "intent", kind: "navigate", payload: { path: "//evil.example" } }, navigate, undefined);
    runIntent({ type: "intent", kind: "connect_whatsapp", payload: {} }, navigate, undefined);
    runIntent({ type: "intent", kind: "connect_facebook", payload: {} }, navigate, undefined);
    expect(navigate).not.toHaveBeenCalled();
    const s = [
      { type: "intent", kind: "navigate", payload: { path: "/app/templates" } },
      { type: "intent", kind: "navigate", payload: { path: "//evil.example" } },
      { type: "intent", kind: "connect_whatsapp", payload: {} },
      { type: "intent", kind: "connect_facebook", payload: {} },
    ].reduce((st, event) => streamReducer(st, { type: "event", event: event as EddyEvent }), initialStreamState);
    const paths = s.items.flatMap((it) => (it.kind === "chips" || it.kind === "action" ? (it.chips ?? []).map((c) => c.path) : []));
    expect(paths).toEqual(["/app/templates", CONNECT_WHATSAPP_PATH, CONNECT_FACEBOOK_PATH]);

    const drafts: unknown[] = [];
    const off = onEddyEvent(EDDY_EVENTS.draft, (d) => drafts.push(d), target);
    navigate.mockClear();
    runIntent({ type: "intent", kind: "composer_draft", payload: { conversationId: "cv1", text: "Namaste" } }, navigate, "cv1");
    expect(drafts).toEqual([{ conversationId: "cv1", text: "Namaste" }]);
    expect(navigate).not.toHaveBeenCalled();
    runIntent({ type: "intent", kind: "composer_draft", payload: { conversationId: "cv2", text: "Hi" } }, navigate, "cv1");
    expect(navigate).toHaveBeenCalledWith("/app/inbox?c=cv2");
    runIntent({ type: "intent", kind: "composer_draft", payload: { conversationId: "bad id", text: "x" } }, navigate, "cv1");
    expect(drafts).toHaveLength(2);
    off();
  });
});

// =====================================================================================================================
// Tokens only and the panel catalogue (6.12, 6.13)
// =====================================================================================================================

describe("this package's files: tokens only, no inner HTML, no Meta host, no user actor, no EventSource", () => {
  const FILES = [
    "src/components/eddy/EddyRoot.tsx",
    "src/components/eddy/EddyPanel.tsx",
    "src/components/eddy/EddySheet.tsx",
    "src/components/eddy/EddyLauncher.tsx",
    "src/components/eddy/Transcript.tsx",
    "src/components/eddy/Composer.tsx",
    "src/components/eddy/ContextChip.tsx",
    "src/components/eddy/StarterChips.tsx",
    "src/components/eddy/OffState.tsx",
    "src/components/eddy/EnableCard.tsx",
    "src/components/eddy/EddySettingsCard.tsx",
    "src/components/eddy/useEddyStream.ts",
    "src/components/eddy/useEddyStatus.ts",
    "src/components/eddy/page-context.ts",
    "src/components/eddy/keyguard.ts",
    "src/lib/eddy/copy/panel.ts",
  ];
  it.each(FILES)("%s", (file) => {
    const src = readFileSync(path.resolve(__dirname, "..", file), "utf8");
    expect(src).not.toMatch(/\bdark:/);
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(src).not.toMatch(/\bz-(\d+|\[)/);
    expect(src).not.toMatch(/zIndex/);
    expect(src).not.toContain("dangerouslySetInnerHTML");
    expect(src).not.toMatch(/facebook\.com|business\.facebook|meta\.com|fb\.me/i);
    expect(src).not.toMatch(/\btype\s*:\s*["']user["']/);
    expect(src).not.toMatch(/new EventSource/);
  });

  it("the panel catalogue has every key in all three languages, and the panel strings read naturally", () => {
    const keys = Object.keys(panelCatalogue.en).sort();
    expect(Object.keys(panelCatalogue.hi).sort()).toEqual(keys);
    expect(Object.keys(panelCatalogue.hinglish).sort()).toEqual(keys);
    expect(tp("en", "panel.close")).toBe("Close Eddy");
    expect(tp("hi", "panel.composer.label")).toBe("Eddy के लिए मैसेज");
    expect(tp("hinglish", "panel.composer.send")).toBe("Eddy ko bhejiye");
  });
});

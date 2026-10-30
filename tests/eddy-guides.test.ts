import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/EDDY-SPEC.md 6.1, 6.2, 6.8, 6.15, 12.1a decision 11, EDDY-15 and EDDY-17: the guided setup (step cards from
 * GET /api/setup with no AI), the Connect WhatsApp, first template, first broadcast and Facebook steps, Facebook Login for
 * Business in a popup (the start route's popup marker, the callback's closing page, the full-page fallback), the setup
 * page's "Do this with Eddy", and the inbox hooks (the composer's draft and template picker, the list's keyboard pause, the
 * refetch on wa:eddy-did, [Explain] on failed bubbles).
 *
 * Rendered with renderToStaticMarkup; the popup and the events run against fakes. No network, no database.
 */

const h0 = vi.hoisted(() => ({
  db: {
    platformSetting: { create: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  } as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
  getActor: vi.fn(),
  completeConnect: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: h0.db }));
vi.mock("@/lib/auth", () => ({ getActor: (...a: unknown[]) => h0.getActor(...a) }));
vi.mock("@/lib/meta-connect/service", async (orig) => {
  const real = await orig<typeof import("@/lib/meta-connect/service")>();
  return { ...real, completeConnect: (...a: unknown[]) => h0.completeConnect(...a) };
});

import { POPUP_SCREENS, PREPARE_CHECKLIST } from "@/components/connect/helpers";
import { EDDY_EVENTS, onEddyEvent } from "@/components/eddy/events";
import { BroadcastStep } from "@/components/eddy/guides/BroadcastStep";
import { checkConnection, ConnectStepView, SUPPORT_HREF, type ConnectDeps, type ConnectView } from "@/components/eddy/guides/ConnectStep";
import { FacebookStepView } from "@/components/eddy/guides/FacebookLoginStep";
import { GuideStepCard, SetupGuideView, type GuideActions } from "@/components/eddy/guides/SetupGuide";
import { TemplateStep } from "@/components/eddy/guides/TemplateStep";
import { OffState, type OffKind } from "@/components/eddy/OffState";
import { eddyDidRefreshesInbox } from "@/components/inbox/InboxApp";
import { listShortcutsPaused } from "@/components/inbox/ConversationList";
import { eddyDraftFor, eddyOpensTemplatesFor, withEddyDraft } from "@/components/inbox/Composer";
import { Bubble, canExplain, explainWithEddy } from "@/components/inbox/MessageBubble";
import type { ChatMessage } from "@/components/inbox/ux";
import { FB_POPUP, isFacebookDialogUrl, launchFacebookLogin, outcomeOf, readPopupOutcome, useFacebookLoginPopup, watchPopup, type LaunchDeps, type PopupLike, type WatchDeps } from "@/components/meta-connect/useFacebookLoginPopup";
import { doWithEddy, DO_WITH_EDDY, StepCard } from "@/components/setup/StepCard";
import { actionByName, deriveRisk } from "@/lib/actions";
import { safeAppPath, type EddyStatusDTO } from "@/lib/eddy/contract";
import { catalogue as guidesCatalogue } from "@/lib/eddy/copy/guides";
import {
  AUDIENCES,
  audienceName,
  BROADCAST_FLOW_TOOLS,
  broadcastQuery,
  buildGuide,
  categoryNote,
  connectCheck,
  connectFailure,
  connectScreens,
  facebookResultText,
  guideAskQuery,
  maskGuidePhone,
  onboardingFailureMessage,
  prepareChecklist,
  reviewPath,
  STEP_MIN_ROLE,
  STEP_PATH,
  TEMPLATE_FLOW_TOOLS,
  templateQuery,
  tg,
  type GuideCard,
  type SetupData,
} from "@/lib/eddy/guides";
import { EDDY_LANGS, type EddyLang } from "@/lib/eddy/contract";
import { computeSteps, summarize, type SetupFacts, type StepId } from "@/lib/setup/checklist";
import { CONNECT_POPUP, POPUP_STATE_MARKER, splitConnectState, startConnect } from "@/lib/meta-connect/service";
import { verifyState } from "@/lib/oauth-state";

vi.setConfig({ testTimeout: 30_000 });

const html = (el: ReactElement) => renderToStaticMarkup(el);
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const META_HOST = /facebook\.com|business\.facebook|meta\.com|fb\.me/i;
const noop = () => undefined;

// ===== Theme tokens (6.13): every colour class is a token defined in both themes =====

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
  }
  return problems;
}

/** Every href in the markup is an /app path or the support mail link: never a Meta domain (6.15). */
function hrefProblems(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&")).filter((href) => !(safeAppPath(href) !== null || href.startsWith("mailto:")) || META_HOST.test(href));
}

// ===== GET /api/setup fixtures =====

const FACTS: SetupFacts = {
  onboardingLive: false,
  approvedTemplates: 0,
  pendingTemplates: 0,
  rejectedTemplates: 0,
  contacts: 0,
  optedInContacts: 0,
  startedBroadcasts: 0,
  sentTemplateMessages: 0,
  members: 1,
  pendingInvites: 0,
  autoAssign: false,
  publishedChatbots: 0,
  enabledAiAgents: 0,
  metaConnections: 0,
  billing: { state: "trialing" as never, daysLeftInTrial: 10, planName: null },
};

function setupData(facts: Partial<SetupFacts> = {}, dismissed: StepId[] = [], canDismiss = true): SetupData {
  const steps = computeSteps({ ...FACTS, ...facts }, dismissed);
  return { steps, summary: summarize(steps), canDismiss };
}

/** The clinic: nothing connected yet (the eval fixture's state). */
const CLINIC = setupData();
/** Connected, a template approved, contacts in: the first broadcast is next. */
const READY_TO_BROADCAST = setupData({ onboardingLive: true, approvedTemplates: 1, contacts: 40, optedInContacts: 35 });
/** Connected only: the first template is next. */
const CONNECTED = setupData({ onboardingLive: true });

const actions = (over: Partial<GuideActions> = {}): GuideActions => ({ canChat: false, onAsk: vi.fn(), onNavigate: vi.fn(), onSkip: vi.fn(async () => undefined), onChanged: vi.fn(), site: "wa.edwyz.com", ...over });

afterEach(() => {
  vi.unstubAllGlobals();
});

// =====================================================================================================================
// buildGuide: step cards from GET /api/setup, no model call (6.8, EDDY-17 acceptance 1)
// =====================================================================================================================

describe("buildGuide: every card has its parts, from GET /api/setup alone", () => {
  it("the clinic's next step is Connect WhatsApp, first, with its reason, minutes, a page, Ask Eddy and Skip", () => {
    for (const lang of EDDY_LANGS) {
      const g = buildGuide(CLINIC, { lang, role: "owner" });
      expect(g.nextStepId).toBe("connect");
      expect(g.cards[0]).toMatchObject({ id: "connect", kind: "connect", current: true, primary: { path: "/app/settings/connect?from=eddy" } });
      for (const card of g.cards) {
        expect(card.title.length, `${lang} ${card.id} title`).toBeGreaterThan(3);
        expect(card.reason.length, `${lang} ${card.id} reason`).toBeGreaterThan(10);
        expect(card.minutes).toMatch(/\d/);
        expect(card.primary, `${lang} ${card.id} primary`).not.toBeNull();
        expect(safeAppPath(card.primary!.path), card.primary!.path).not.toBeNull();
        expect(card.ask.label).toBe(tg(lang, "guides.ask"));
        expect(card.ask.query).toBe(guideAskQuery(lang, card.id));
        expect(card.skip?.label).toBe(tg(lang, "guides.skip"));
        expect(card.adminNeeded).toBeNull();
      }
    }
  });

  it("a blocked step's button leads to the step that must come first, with the reason", () => {
    const g = buildGuide(CLINIC, { lang: "en", role: "admin" });
    const template = g.cards.find((c) => c.id === "template")!;
    expect(template.blocked).toBe("Connect your WhatsApp number first.");
    expect(template.primary).toEqual({ label: "Connect WhatsApp", path: STEP_PATH.connect });
    const hi = buildGuide(CLINIC, { lang: "hi", role: "admin" }).cards.find((c) => c.id === "broadcast")!;
    expect(hi.blocked).toBe(tg("hi", "guides.blocked.connect"));
  });

  it("done and skipped steps leave the guide; the next step after connecting is the template, then the broadcast", () => {
    expect(buildGuide(CONNECTED, { lang: "en", role: "owner" }).cards.map((c) => c.id)).not.toContain("connect");
    expect(buildGuide(CONNECTED, { lang: "en", role: "owner" }).cards[0].id).toBe("template");
    expect(buildGuide(READY_TO_BROADCAST, { lang: "en", role: "owner" }).cards[0]).toMatchObject({ id: "broadcast", kind: "broadcast", blocked: null });
    const skipped = setupData({}, ["connect"]);
    expect(buildGuide(skipped, { lang: "en", role: "owner" }).cards.map((c) => c.id)).not.toContain("connect");
  });

  it("team members see that an admin is needed, with no button for admin steps and no Skip; contacts stay theirs", () => {
    const g = buildGuide(CLINIC, { lang: "en", role: "agent" });
    const connect = g.cards.find((c) => c.id === "connect")!;
    expect(connect.adminNeeded).toBe("An admin needs to connect WhatsApp.");
    expect(connect.primary).toBeNull();
    expect(connect.skip).toBeNull();
    expect(g.cards.find((c) => c.id === "facebook")!.adminNeeded).toBe("An admin needs to connect Facebook.");
    expect(g.cards.find((c) => c.id === "contacts")).toMatchObject({ adminNeeded: null, primary: { path: "/app/contacts" } });
    for (const lang of EDDY_LANGS) expect(buildGuide(CLINIC, { lang, role: "agent" }).cards.find((c) => c.id === "connect")!.adminNeeded).toBe(tg(lang, "guides.admin_needed.connect"));
    // Skip is the admin dismiss, so it follows the server's canDismiss too.
    expect(buildGuide(setupData({}, [], false), { lang: "en", role: "owner" }).cards[0].skip).toBeNull();
    expect(STEP_MIN_ROLE.contacts).toBe("agent");
  });

  it("the setup API's English detail is shown only in English", () => {
    const withDetail = setupData({ onboardingLive: true, pendingTemplates: 1 });
    expect(buildGuide(withDetail, { lang: "en", role: "owner" }).cards[0].detail).toContain("waiting for Meta to review");
    expect(buildGuide(withDetail, { lang: "hi", role: "owner" }).cards[0].detail).toBeNull();
  });
});

// =====================================================================================================================
// The rendered guide with Eddy off (EDDY-17 acceptance 1 and 5)
// =====================================================================================================================

const guide = (data: SetupData | null, role: string, lang: EddyLang = "en", over: Partial<GuideActions> & { loading?: boolean; error?: string | null } = {}) =>
  html(h(SetupGuideView, { lang, role, data, ...actions(over), loading: over.loading, error: over.error }));

describe("SetupGuideView renders from setup data with the AI off", () => {
  it.each(EDDY_LANGS.flatMap((lang) => (["owner", "admin", "agent"] as const).map((role) => [lang, role] as const)))("%s, %s: the heading, every card's parts, tokens only, no Meta link", (lang, role) => {
    const markup = guide(CLINIC, role, lang);
    expect(markup).toContain("data-eddy-guide");
    expect(markup).not.toContain("<textarea");
    expect(themeProblems(markup)).toEqual([]);
    expect(hrefProblems(markup)).toEqual([]);
    expect(META_HOST.test(markup)).toBe(false);
    const cards = [...markup.matchAll(/data-guide-step="([a-z]+)"/g)].map((m) => m[1]);
    expect(cards.length).toBe(buildGuide(CLINIC, { lang, role }).cards.length);
    for (const part of ["title", "reason", "minutes", "ask"]) expect((markup.match(new RegExp(`data-guide-part="${part}"`, "g")) ?? []).length, part).toBe(cards.length);
    const skips = (markup.match(/data-guide-part="skip"/g) ?? []).length;
    expect(skips).toBe(role === "agent" ? 0 : cards.length);
    if (role !== "agent") expect((markup.match(/data-guide-part="primary"/g) ?? []).length).toBeGreaterThanOrEqual(cards.length);
    else expect(textOf(markup)).toContain(tg(lang, "guides.admin_needed.connect"));
  });

  it("says the setup list's own heading and progress, and the later steps sit under one disclosure", () => {
    const markup = guide(CLINIC, "owner");
    expect(textOf(markup)).toContain("Your setup list");
    expect(textOf(markup)).toContain(`0 of 9 done`);
    expect(markup).toContain("data-guide-later");
    expect(markup).toContain('aria-current="step"');
  });

  it("loading, a load failure with Retry, and a complete setup", () => {
    expect(textOf(guide(null, "owner", "en", { loading: true }))).toContain("Loading your setup list");
    const failed = textOf(guide(null, "owner", "en", { error: "x" }));
    expect(failed).toContain("Your setup list couldn't be loaded.");
    expect(failed).toContain("Retry");
    const done = setupData({ onboardingLive: true, approvedTemplates: 1, contacts: 3, optedInContacts: 3, startedBroadcasts: 1 });
    expect(textOf(guide(done, "owner"))).toContain("Your setup is complete.");
    // Below the greeting it stays out of the way: nothing until the setup is known to be unfinished.
    expect(html(h(SetupGuideView, { lang: "en", role: "owner", data: done, hideWhenComplete: true, ...actions() }))).toBe("");
    expect(html(h(SetupGuideView, { lang: "en", role: "owner", data: null, loading: true, hideWhenComplete: true, ...actions() }))).toBe("");
  });

  it("Ask Eddy about this works only as a message when Eddy can chat; off, it says so and the card still works", () => {
    const card = buildGuide(CLINIC, { lang: "en", role: "owner" }).cards.find((c) => c.id === "invite")!;
    const off = html(h(GuideStepCard, { card, lang: "en", actions: actions(), busy: false, flow: false }));
    expect(off).toContain('aria-label="Ask Eddy about: Invite a teammate"');
    expect(off).toContain('href="/app/settings/team"');
    expect(guideAskQuery("hinglish", "invite")).toBe("Setup ke is step mein madad kariye: Team ke kisi saathi ko bulaiye.");
  });

  it("the off states mount the guide: platform_off, paused, allowance_used and user_capped, never locked or workspace_off", () => {
    const status = { state: "platform_off", reason: "not_configured", readOnly: false, canEnable: false, ownerNames: ["Asha"], allowance: { usedToday: 0, limitToday: null, usedMonth: 0, limitMonth: 500, resetsOn: "2026-11-01", memberUsedToday: 0, memberLimitToday: 40 }, langPref: "auto", needsYou: 0, demo: false, whatsapp: "none", phase: 1, firstUse: false, spendingStopped: false } as EddyStatusDTO;
    for (const kind of ["platform_off", "paused", "allowance_used", "user_capped", "locked", "workspace_off"] as OffKind[]) {
      const markup = html(h(OffState, { kind, lang: "en", status: { ...status, state: kind === "platform_off" ? "platform_off" : (kind as never) }, role: "owner", pageId: "dashboard" }));
      const shows = ["platform_off", "paused", "allowance_used", "user_capped"].includes(kind);
      expect(markup.includes("data-eddy-guide"), kind).toBe(shows);
      expect(markup).not.toContain("<textarea");
    }
  });
});

// =====================================================================================================================
// 1. Connect WhatsApp (EDDY-17 acceptance 2)
// =====================================================================================================================

const cardOf = (data: SetupData, id: StepId, role = "owner", lang: EddyLang = "en"): GuideCard => buildGuide(data, { lang, role }).cards.find((c) => c.id === id)!;
const connectView = (view: ConnectView, lang: EddyLang = "en") => html(h(ConnectStepView, { lang, card: cardOf(CLINIC, "connect", "owner", lang), view, site: "wa.edwyz.com", onStart: noop, onCheck: noop }));

describe("ConnectStep: Meta's screens, the checklist, the connect page, the outcome and fixes", () => {
  it("English is POPUP_SCREENS and PREPARE_CHECKLIST word for word, plus coexistence; Hindi and Hinglish have the same count", () => {
    expect(connectScreens("en")).toEqual(POPUP_SCREENS);
    expect(prepareChecklist("en")).toEqual([...PREPARE_CHECKLIST, "If your number is already on the WhatsApp Business app, choose coexistence."]);
    for (const lang of ["hi", "hinglish"] as const) {
      expect(connectScreens(lang)).toHaveLength(POPUP_SCREENS.length);
      expect(prepareChecklist(lang)).toHaveLength(PREPARE_CHECKLIST.length + 1);
    }
  });

  it("the card shows the screens and the checklist, and [Connect WhatsApp] opens /app/settings/connect?from=eddy", () => {
    for (const lang of EDDY_LANGS) {
      const markup = connectView({ phase: "idle" }, lang);
      const text = textOf(markup);
      for (const s of connectScreens(lang)) expect(text).toContain(s.title);
      for (const item of prepareChecklist(lang)) expect(text).toContain(item);
      expect(markup).toContain('href="/app/settings/connect?from=eddy"');
      expect(markup).toContain('data-guide-part="primary"');
      expect(themeProblems(markup)).toEqual([]);
      expect(META_HOST.test(markup)).toBe(false);
    }
  });

  it("waiting and checking say so politely, with Check again; connected posts the outcome", () => {
    const waiting = connectView({ phase: "waiting", since: 1 });
    expect(waiting).toContain('aria-live="polite"');
    expect(textOf(waiting)).toContain("Waiting for WhatsApp to connect.");
    expect(textOf(waiting)).toContain("Check again");
    const done = connectView({ phase: "connected", text: "WhatsApp is connected: +91 98xxx x4321. Next: your first template." });
    expect(done).toContain('data-guide-outcome="connected"');
    expect(textOf(done)).toContain("WhatsApp is connected: +91 98xxx x4321. Next: your first template.");
  });

  it("polls the onboarding status and token health: waiting, connected with the masked number, reconnect, a failed step, stopped", async () => {
    let now = 1_000;
    const deps = (status: unknown, health: unknown = { state: "ok" }, numbers = [{ displayPhone: "+91 98765 54321" }]): ConnectDeps => ({
      status: vi.fn(async () => {
        if (status instanceof Error) throw status;
        return status as never;
      }),
      health: vi.fn(async () => health as never),
      numbers: vi.fn(async () => numbers),
      now: () => now,
    });
    expect(await checkConnection("en", deps({ status: "not_started", steps: [] }), 1_000, "wa.edwyz.com")).toEqual({ phase: "waiting", since: 1_000 });
    expect(await checkConnection("en", deps(new Error("offline")), 1_000, "wa.edwyz.com")).toEqual({ phase: "waiting", since: 1_000 });
    expect(await checkConnection("en", deps({ status: "live", steps: [] }), 1_000, "wa.edwyz.com")).toEqual({ phase: "connected", text: "WhatsApp is connected: +91 98xxx x4321. Next: your first template." });
    expect(await checkConnection("hinglish", deps({ status: "live", steps: [] }), 1_000, "x")).toEqual({ phase: "connected", text: "WhatsApp jud gaya hai: +91 98xxx x4321. Agla step: aapka pehla template." });
    expect(await checkConnection("en", deps({ status: "live", steps: [] }, { state: "expired" }), 1_000, "x")).toMatchObject({ phase: "reconnect" });
    const failed = await checkConnection("en", deps({ status: "in_progress", steps: [{ step: "exchange_code", status: "failed" }] }), 1_000, "wa.edwyz.com");
    expect(failed).toMatchObject({ phase: "failed", failure: { kind: "expired" } });
    now = 1_000 + 15 * 60_000;
    expect(await checkConnection("en", deps({ status: "in_progress", steps: [] }), 1_000, "x")).toEqual({ phase: "stopped" });
  });

  it("connectCheck and the masked number", () => {
    expect(maskGuidePhone("+91 98765 54321")).toBe("+91 98xxx x4321");
    expect(maskGuidePhone("9876554321")).toBe("98xxx x4321");
    expect(maskGuidePhone("123")).toBeNull();
    expect(connectCheck("en", { status: "live" }, null, null).text).toBe("WhatsApp is connected. Next: your first template.");
    expect(connectCheck("hi", { status: "pending" }, null, null).state).toBe("waiting");
    expect(onboardingFailureMessage([{ step: "register_number", status: "failed" }])).toBe("meta said");
    expect(onboardingFailureMessage([{ step: "verify_ids", status: "done" }])).toBeNull();
  });

  it("every classifyFailure case has its text in all three languages and fixes that never link to a Meta domain", () => {
    const messages = ["expired", "another workspace", "already running", "not configured", "facebook sign-in", "did not return", "too many", "permission", "meta said", "something else"];
    const kinds = new Set<string>();
    for (const m of messages) {
      for (const lang of EDDY_LANGS) {
        const f = connectFailure(m, { lang, stage: 3, site: "wa.edwyz.com", support: { href: SUPPORT_HREF } });
        kinds.add(f.kind);
        expect(f.text.length).toBeGreaterThan(20);
        expect(f.fixes.length, `${m} ${lang}`).toBeGreaterThan(0);
        for (const fix of f.fixes) {
          if (fix.path) expect(safeAppPath(fix.path)).toBe(fix.path);
          if (fix.href) expect(fix.href.startsWith("mailto:")).toBe(true);
        }
        expect(META_HOST.test(JSON.stringify(f)), `${m} ${lang}`).toBe(false);
      }
    }
    expect(kinds.size).toBe(10);
    expect(connectFailure("facebook sign-in", { lang: "en", site: "wa.edwyz.com" }).text).toBe("Your browser blocked Meta's window. Allow pop-ups for wa.edwyz.com and tap again.");
    // Fixable only inside Meta: say what is needed and offer [Connect again], the one allowed Meta screen.
    expect(connectFailure("not authorized", { lang: "en", site: "x" }).fixes.map((f) => f.kind)).toEqual(["connect_again"]);
    expect(connectFailure("meta said", { lang: "en", site: "x" }).fixes.map((f) => f.kind)).toEqual(["connect_again", "coexistence"]);
  });

  it("a failure renders its fixes, the coexistence note and the support mail link; never a Meta link", () => {
    const failure = connectFailure("meta said", { lang: "en", site: "wa.edwyz.com", support: { href: SUPPORT_HREF } });
    const markup = connectView({ phase: "failed", failure });
    expect(textOf(markup)).toContain("Meta stopped the setup.");
    expect(textOf(markup)).toContain("Connect with coexistence");
    expect(textOf(markup)).toContain(tg("en", "guides.fix.coexistence_note"));
    expect(hrefProblems(markup)).toEqual([]);
    const unavailable = connectView({ phase: "failed", failure: connectFailure("not configured", { lang: "hi", site: "x", support: { href: SUPPORT_HREF } }) }, "hi");
    expect(unavailable).toContain('href="mailto:');
    expect(META_HOST.test(unavailable)).toBe(false);
  });
});

// =====================================================================================================================
// 2. First template, 3. first broadcast (EDDY-17 acceptance 3 and 4)
// =====================================================================================================================

describe("TemplateStep: purpose, the customers' language, then Eddy drafts and shows the Submit card", () => {
  const card = cardOf(CONNECTED, "template");

  it("with Eddy off it says so and links to the templates page", () => {
    for (const lang of EDDY_LANGS) {
      const markup = html(h(TemplateStep, { lang, card, canChat: false, onAsk: noop }));
      expect(textOf(markup)).toContain(tg(lang, "guides.template.ai_off"));
      expect(markup).toContain('href="/app/templates/new"');
      expect(markup).toContain('data-guide-part="primary"');
    }
  });

  it("one question at a time: purpose chips first; then the language; then [Draft it with Eddy]", () => {
    const first = html(h(TemplateStep, { lang: "en", card, canChat: true, onAsk: noop }));
    expect((first.match(/data-guide-chip=/g) ?? []).length).toBe(4);
    expect(first).toContain('aria-pressed="false"');
    expect(textOf(first)).not.toContain("Which language do your customers read?");
    const second = html(h(TemplateStep, { lang: "en", card, canChat: true, onAsk: noop, initial: { purpose: "offer" } }));
    expect(textOf(second)).toContain("An offer goes in the Marketing category.");
    expect(textOf(second)).toContain("Which language do your customers read?");
    const third = html(h(TemplateStep, { lang: "hi", card, canChat: true, onAsk: noop, initial: { purpose: "offer", customers: "hi" } }));
    expect(textOf(third)).toContain("Eddy से ड्राफ़्ट बनवाएँ");
    expect(themeProblems(third)).toEqual([]);
    const sent = html(h(TemplateStep, { lang: "en", card, canChat: true, onAsk: noop, initial: { purpose: "offer", customers: "hi", sent: true } }));
    expect(textOf(sent)).toContain("Asked Eddy for a draft.");
  });

  it("the message is the member's own words in the member's language, naming the customers' language", () => {
    expect(templateQuery("en", "offer", "hi")).toBe("Draft a template for an offer for my customers in Hindi, with sample values. Then show me the card to submit it to Meta.");
    expect(templateQuery("hinglish", "reminder", "en")).toBe("Mere customers ke liye English mein reminder ka template draft kariye, sample values ke saath. Phir Meta ko submit karne wala card dikhaiye.");
    expect(templateQuery("hi", "order", "hi")).toContain("हिंदी");
    expect(categoryNote("en", "reminder")).toBe("Order updates and reminders go in the Utility category.");
  });

  it("the flow's tools exist: search_help reads, the draft is undoable, Submit is a card that goes to Meta", () => {
    expect(TEMPLATE_FLOW_TOOLS).toEqual(["search_help", "create_template_draft", "submit_template"]);
    const risk = (name: string) => {
      const def = actionByName(name)!;
      return deriveRisk(typeof def.effects === "function" ? { writes: true } : def.effects);
    };
    expect(risk("search_help")).toBe("instant");
    expect(risk("create_template_draft")).toBe("undoable");
    expect(risk("submit_template")).toBe("confirm");
  });
});

describe("BroadcastStep: audience, reach, an undoable draft, the estimate, then Review and start on the page", () => {
  const card = cardOf(READY_TO_BROADCAST, "broadcast");

  it("with Eddy off it links to the broadcast page, and says only opted-in contacts get marketing", () => {
    const markup = html(h(BroadcastStep, { lang: "en", card, canChat: false, onAsk: noop }));
    expect(markup).toContain('href="/app/broadcasts/new"');
    expect(textOf(markup)).toContain("Marketing messages go only to contacts who opted in.");
  });

  it("audience chips, a labelled name field for a tag, and [Plan it with Eddy]", () => {
    const first = html(h(BroadcastStep, { lang: "en", card, canChat: true, onAsk: noop }));
    expect((first.match(/data-guide-chip=/g) ?? []).length).toBe(AUDIENCES.length);
    const tag = html(h(BroadcastStep, { lang: "hinglish", card, canChat: true, onAsk: noop, initial: { audience: "tag", name: "vip" } }));
    expect(tag).toMatch(/<label for="[^"]+"[^>]*>Tag ka naam<\/label>/);
    expect(textOf(tag)).toContain("Eddy ke saath plan kariye");
    expect(themeProblems(tag)).toEqual([]);
  });

  it("v1 ends at [Review and start] on the broadcast Eddy drafted; Eddy never starts one", () => {
    const sent = html(h(BroadcastStep, { lang: "en", card, canChat: true, onAsk: noop, initial: { audience: "opted_in", sent: true, draftId: "b_9" } }));
    expect(sent).toContain('href="/app/broadcasts/b_9"');
    expect(textOf(sent)).toContain("Review and start");
    expect(reviewPath(null)).toBe("/app/broadcasts");
    expect(reviewPath("../x")).toBe("/app/broadcasts");
    expect(BROADCAST_FLOW_TOOLS).toEqual(["preview_audience", "create_broadcast_draft", "estimate_broadcast"]);
    for (const name of BROADCAST_FLOW_TOOLS) expect(actionByName(name), name).toBeDefined();
    expect(actionByName("start_broadcast")).toBeUndefined();
  });

  it("the plan message names the audience in the member's language; a tag or segment needs a name", () => {
    expect(broadcastQuery("en", "opted_in")).toContain("everyone who opted in");
    expect(broadcastQuery("hi", "tag", "vip")).toContain("vip टैग");
    expect(broadcastQuery("hinglish", "segment", "  Delhi‮ VIPs ")).toContain("Delhi VIPs segment");
    expect(broadcastQuery("en", "tag", "   ")).toBeNull();
    expect(audienceName("a".repeat(80))).toHaveLength(60);
  });
});

// =====================================================================================================================
// Facebook Login for Business in a popup (12.1a decision 11)
// =====================================================================================================================

const FB_URL = "https://www.facebook.com/v21.0/dialog/oauth?client_id=1&state=s";

function fakePopup(): PopupLike & { replaced: string[]; closeCount: number; doc: { meta: string | null } | null; throwOnRead: boolean } {
  const p = {
    closed: false,
    replaced: [] as string[],
    closeCount: 0,
    doc: null as { meta: string | null } | null,
    throwOnRead: true,
    close() {
      p.closed = true;
      p.closeCount++;
    },
    location: { replace: (url: string) => void p.replaced.push(url) },
    get document() {
      if (p.throwOnRead) throw new Error("SecurityError: cross-origin");
      return p.doc ? { querySelector: (sel: string) => (sel.includes(FB_POPUP.meta) && p.doc!.meta !== null ? { getAttribute: () => p.doc!.meta } : null) } : null;
    },
  };
  return p;
}

describe("launchFacebookLogin: the window opens synchronously from the click, before anything is awaited", () => {
  it("open() runs first and synchronously, then the start route is asked for a popup URL, then the window goes there", async () => {
    const order: string[] = [];
    const popup = fakePopup();
    let resolveStart!: (v: { url: string }) => void;
    const deps: LaunchDeps = {
      open: vi.fn((url: string, target: string, features: string) => {
        order.push(`open:${url}|${target}|${features}`);
        return popup;
      }),
      fetchStart: vi.fn((asPopup: boolean) => {
        order.push(`start:${asPopup}`);
        return new Promise<{ url: string }>((r) => (resolveStart = r));
      }),
      redirect: vi.fn(),
    };
    const { popup: opened, started } = launchFacebookLogin(deps);
    // Still inside the click: the window is open and nothing has been awaited.
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("open:|edwyz-facebook-login|popup=yes,width=600,height=720");
    expect(opened).toBe(popup);
    resolveStart({ url: FB_URL });
    expect(await started).toEqual({ kind: "opened" });
    expect(order).toEqual(["open:|edwyz-facebook-login|popup=yes,width=600,height=720", "start:true"]);
    expect(popup.replaced).toEqual([FB_URL]);
    expect(deps.redirect).not.toHaveBeenCalled();
  });

  it("when the browser blocks the window, the whole page goes to Facebook instead (the full-page redirect fallback)", async () => {
    const deps: LaunchDeps = { open: vi.fn(() => null), fetchStart: vi.fn(async () => ({ url: FB_URL })), redirect: vi.fn() };
    const { popup, started } = launchFacebookLogin(deps);
    expect(popup).toBeNull();
    expect(await started).toEqual({ kind: "redirected" });
    expect(deps.fetchStart).toHaveBeenCalledWith(false);
    expect(deps.redirect).toHaveBeenCalledWith(FB_URL);
  });

  it("a failed start closes the window; a URL that is not Facebook's consent dialog is never opened", async () => {
    const popup = fakePopup();
    const failed = launchFacebookLogin({ open: () => popup, fetchStart: async () => Promise.reject(new Error("Meta connection is not configured yet.")), redirect: vi.fn() });
    expect(await failed.started).toEqual({ kind: "error", message: "Meta connection is not configured yet." });
    expect(popup.closeCount).toBe(1);
    const evil = fakePopup();
    const redirect = vi.fn();
    expect((await launchFacebookLogin({ open: () => evil, fetchStart: async () => ({ url: "https://evil.example/dialog/oauth" }), redirect }).started).kind).toBe("error");
    expect(evil.replaced).toEqual([]);
    for (const bad of ["javascript:alert(1)", "http://www.facebook.com/v21.0/dialog/oauth", "https://www.facebook.com.evil.example/dialog/oauth", "/api/x"]) expect(isFacebookDialogUrl(bad)).toBe(false);
    expect(isFacebookDialogUrl(FB_URL)).toBe(true);
  });

  it("the hook's start() is the click handler and opens the window before it returns", () => {
    const open = vi.fn(() => fakePopup());
    let start: (() => void) | null = null;
    function Probe() {
      const popup = useFacebookLoginPopup({ launchDeps: () => ({ open, fetchStart: () => new Promise(() => undefined), redirect: vi.fn() }), watchDeps: () => fakeWatchDeps().deps });
      start = popup.start;
      return null;
    }
    html(h(Probe));
    expect(start).not.toBeNull();
    try {
      start!();
    } catch {
      // A server render ignores state updates after it finished; the window opened before them.
    }
    expect(open).toHaveBeenCalledTimes(1);
    // The source keeps it that way: nothing is awaited in start() before launchFacebookLogin.
    const src = readFileSync(path.resolve(__dirname, "../src/components/meta-connect/useFacebookLoginPopup.ts"), "utf8");
    const body = src.slice(src.indexOf("const start = useCallback(() => {"), src.indexOf("const reset = useCallback"));
    expect(body.indexOf("launchFacebookLogin(")).toBeGreaterThan(0);
    expect(body.slice(0, body.indexOf("launchFacebookLogin("))).not.toMatch(/\bawait\b|\.then\(/);
  });
});

function fakeWatchDeps() {
  const listeners: ((e: { origin: string; data: unknown }) => void)[] = [];
  const intervals: (() => void)[] = [];
  const timeouts: (() => void)[] = [];
  const channel = { onmessage: null as ((e: { data: unknown }) => void) | null, closed: false, close() {
    channel.closed = true;
  } };
  const deps: WatchDeps = {
    origin: "https://wa.edwyz.com",
    onMessage: (fn) => {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
    channel: () => channel,
    setInterval: (fn) => (intervals.push(fn), intervals.length),
    clearInterval: () => undefined,
    setTimeout: (fn) => (timeouts.push(fn), timeouts.length),
    clearTimeout: () => undefined,
  };
  return { deps, post: (e: { origin: string; data: unknown }) => listeners.forEach((l) => l(e)), tick: () => intervals.forEach((f) => f()), expire: () => timeouts.forEach((f) => f()), channel, listeners };
}

describe("watchPopup: the outcome comes back as one word, from this site only", () => {
  it("a message from this origin with the right source ends it; anything else is ignored", async () => {
    const popup = fakePopup();
    const w = fakeWatchDeps();
    const done = watchPopup(popup, w.deps);
    w.post({ origin: "https://evil.example", data: { source: FB_POPUP.source, outcome: "connected" } });
    w.post({ origin: "https://wa.edwyz.com", data: { source: "other", outcome: "connected" } });
    w.post({ origin: "https://wa.edwyz.com", data: { source: FB_POPUP.source, outcome: "pwned" } });
    w.post({ origin: "https://wa.edwyz.com", data: { source: FB_POPUP.source, outcome: "connected" } });
    expect(await done).toEqual({ kind: "outcome", outcome: "connected" });
    expect(popup.closeCount).toBe(1);
    expect(w.listeners).toHaveLength(0);
    expect(w.channel.closed).toBe(true);
  });

  it("the BroadcastChannel and, when the page's script could not run, the meta tag read from the opener", async () => {
    const a = fakeWatchDeps();
    const p1 = watchPopup(fakePopup(), a.deps);
    a.channel.onmessage!({ data: { source: FB_POPUP.source, outcome: "cancelled" } });
    expect(await p1).toEqual({ kind: "outcome", outcome: "cancelled" });

    const popup = fakePopup();
    const b = fakeWatchDeps();
    const p2 = watchPopup(popup, b.deps);
    b.tick(); // still on Facebook: cross-origin, not readable
    popup.throwOnRead = false;
    popup.doc = { meta: "failed" };
    b.tick();
    expect(await p2).toEqual({ kind: "outcome", outcome: "failed" });
    expect(popup.closed).toBe(true);
  });

  it("a window closed early ends as closed; a long one times out and is closed", async () => {
    const popup = fakePopup();
    const w = fakeWatchDeps();
    const p = watchPopup(popup, w.deps);
    popup.closed = true;
    w.tick();
    expect(await p).toEqual({ kind: "closed" });
    const slow = fakePopup();
    const t = fakeWatchDeps();
    const q = watchPopup(slow, t.deps);
    t.expire();
    expect(await q).toEqual({ kind: "timeout" });
    expect(slow.closed).toBe(true);
    expect(outcomeOf({ source: FB_POPUP.source, outcome: "connected", token: "x" })).toBe("connected");
    expect(readPopupOutcome(fakePopup())).toBeNull();
  });

  it("the browser hook and the server's closing page agree on the message", () => {
    expect(FB_POPUP).toEqual(CONNECT_POPUP);
  });
});

/** Finds the React element whose props carry data-guide-part=part. */
function findPart(node: ReactNode, part: string): ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findPart(n, part);
      if (f) return f;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.props?.["data-guide-part"] === part) return el;
  return findPart(el.props?.children as ReactNode, part);
}

describe("FacebookLoginStep: the button is the click handler, and the card says how it ended", () => {
  const card = cardOf(setupData({ onboardingLive: true, approvedTemplates: 1, contacts: 2, startedBroadcasts: 1 }), "facebook");

  it("[Connect Facebook] calls the popup's start directly from its onClick", () => {
    const start = vi.fn();
    const tree = FacebookStepView({ lang: "en", card, phase: "idle", result: null, onStart: start });
    const button = findPart(tree, "primary")!;
    expect(button.props.onClick).toBe(start);
    const markup = html(h(FacebookStepView, { lang: "en", card, phase: "idle", result: null, onStart: start }));
    expect(textOf(markup)).toContain("Connect Facebook");
    expect(textOf(markup)).toContain("This opens Facebook in a small window to give permission, then brings you back here.");
    expect(META_HOST.test(markup)).toBe(false);
  });

  it("each outcome in each language, with Connections as the way out after a failure", () => {
    for (const lang of EDDY_LANGS) {
      const connected = html(h(FacebookStepView, { lang, card, phase: "done", result: { kind: "outcome", outcome: "connected" }, onStart: noop }));
      expect(connected).toContain('data-guide-outcome="connected"');
      expect(textOf(connected)).toContain(tg(lang, "guides.facebook.connected"));
      expect(connected).not.toContain('data-guide-part="primary"');
      const failed = html(h(FacebookStepView, { lang, card, phase: "done", result: { kind: "outcome", outcome: "failed" }, onStart: noop }));
      expect(textOf(failed)).toContain(tg(lang, "guides.facebook.failed"));
      expect(failed).toContain('href="/app/settings/connections"');
      expect(textOf(html(h(FacebookStepView, { lang, card, phase: "redirecting", result: null, onStart: noop })))).toContain(tg(lang, "guides.facebook.redirecting"));
    }
    expect(facebookResultText("en", { kind: "closed" })).toContain("Facebook's window was closed.");
    expect(facebookResultText("hi", { kind: "error", message: "closed" })).toBe(tg("hi", "guides.facebook.cancelled"));
  });

  it("team members see that an admin is needed, and no button", () => {
    const agentCard = cardOf(setupData({ onboardingLive: true, approvedTemplates: 1, contacts: 2, startedBroadcasts: 1 }), "facebook", "agent");
    const markup = html(h(GuideStepCard, { card: agentCard, lang: "en", actions: actions(), busy: false, flow: true }));
    expect(textOf(markup)).toContain("An admin needs to connect Facebook.");
    expect(markup).not.toContain('data-guide-part="primary"');
    expect(markup).not.toContain('data-guide-part="skip"');
  });
});

// =====================================================================================================================
// The start route's popup marker and the callback's closing page (12.1a decision 11)
// =====================================================================================================================

const ORIGIN = "https://wa.example.test";
const ADMIN = { userId: "u1", tenantId: "t1", role: "admin" as const };

describe("POST /api/meta-connect/start and GET /api/meta-connect/callback", () => {
  beforeEach(() => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("STATE_SECRET", "state-secret-for-tests-0123456789abcdef");
    vi.stubEnv("META_APP_ID", "123");
    vi.stubEnv("META_LOGIN_CONFIG_ID", "cfg1");
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    h0.db.platformSetting.create.mockResolvedValue({});
    h0.db.platformSetting.deleteMany.mockResolvedValue({ count: 1 });
    h0.db.auditLog.create.mockResolvedValue({});
    h0.getActor.mockReset().mockResolvedValue(ADMIN);
    h0.completeConnect.mockReset().mockResolvedValue({ connectionId: "c1" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("startConnect carries the popup marker after the signed state, and the signed part still verifies", async () => {
    const plain = new URL((await startConnect(ADMIN)).url).searchParams.get("state")!;
    expect(plain.endsWith(POPUP_STATE_MARKER)).toBe(false);
    const popup = new URL((await startConnect(ADMIN, { popup: true })).url).searchParams.get("state")!;
    expect(popup.endsWith(POPUP_STATE_MARKER)).toBe(true);
    const split = splitConnectState(popup);
    expect(split.popup).toBe(true);
    expect(split.state).toMatch(/^[0-9a-f]{32}\.\d+\.[0-9a-f]{64}$/);
    // The signed part is the same session-bound state as before: it verifies with the labelled, tenant and user derived key.
    const derived = createHmac("sha256", createHmac("sha256", "state-secret-for-tests-0123456789abcdef").update("meta-connect-state-v1").digest()).update(["t1", "u1"].join(String.fromCharCode(10))).digest("hex");
    expect(verifyState(split.state!, derived)).toBe(true);
    expect(verifyState(popup, derived)).toBe(false);
    expect(splitConnectState(null)).toEqual({ state: null, popup: false });
    expect(splitConnectState("abc")).toEqual({ state: "abc", popup: false });
  });

  it("the route asks for a popup on ?popup=1 or a JSON {popup: 1}, and a redirect otherwise", async () => {
    const { POST } = await import("@/app/api/meta-connect/start/route");
    const call = async (url: string, body?: unknown) => {
      const res = await POST(new Request(url, { method: "POST", headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }));
      expect(res.status).toBe(200);
      return new URL(((await res.json()) as { url: string }).url).searchParams.get("state")!;
    };
    expect((await call(`${ORIGIN}/api/meta-connect/start?popup=1`)).endsWith(POPUP_STATE_MARKER)).toBe(true);
    expect((await call(`${ORIGIN}/api/meta-connect/start`, { popup: 1 })).endsWith(POPUP_STATE_MARKER)).toBe(true);
    expect((await call(`${ORIGIN}/api/meta-connect/start`, {})).endsWith(POPUP_STATE_MARKER)).toBe(false);
    expect((await call(`${ORIGIN}/api/meta-connect/start`)).endsWith(POPUP_STATE_MARKER)).toBe(false);
    // Still same-origin and admin only.
    const cross = await POST(new Request(`${ORIGIN}/api/meta-connect/start?popup=1`, { method: "POST", headers: { origin: "https://evil.example" } }));
    expect(cross.status).toBe(403);
    h0.getActor.mockResolvedValueOnce({ ...ADMIN, role: "agent" });
    expect((await POST(new Request(`${ORIGIN}/api/meta-connect/start?popup=1`, { method: "POST", headers: { origin: ORIGIN } }))).status).toBe(403);
  });

  it("a popup attempt ends on a small page that posts the outcome to the opener and closes", async () => {
    const { GET } = await import("@/app/api/meta-connect/callback/route");
    const state = `abc.123.def${POPUP_STATE_MARKER}`;
    const res = await GET(new Request(`${ORIGIN}/api/meta-connect/callback?code=C&state=${encodeURIComponent(state)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h0.completeConnect).toHaveBeenCalledWith(ADMIN, "C", state);
    const body = await res.text();
    expect(body).toContain(`<meta name="${CONNECT_POPUP.meta}" content="connected">`);
    expect(body).toContain(`window.opener.postMessage(m,o)`);
    expect(body).toContain(`"source":"${CONNECT_POPUP.source}","outcome":"connected"`);
    expect(body).toContain(`new BroadcastChannel("${CONNECT_POPUP.channel}")`);
    expect(body).toContain(`o="${ORIGIN}"`);
    expect(body).toContain("window.close()");
    expect(body).toContain(`href="${ORIGIN}/app/settings/connections?status=connected"`);
    expect(META_HOST.test(body)).toBe(false);
    // The script is allowed by its own hash, and nothing else runs.
    const script = /<script>([\s\S]*)<\/script>/.exec(body)![1];
    const hash = createHash("sha256").update(script, "utf8").digest("base64");
    expect(res.headers.get("content-security-policy")).toBe(`default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  });

  it("a cancel, a failure and a signed-out popup each get the page with their word; never Meta's text", async () => {
    const { GET } = await import("@/app/api/meta-connect/callback/route");
    const state = encodeURIComponent(`abc.123.def${POPUP_STATE_MARKER}`);
    const word = async (url: string) => /content="(connected|cancelled|failed)"/.exec(await (await GET(new Request(url))).text())?.[1];
    expect(await word(`${ORIGIN}/api/meta-connect/callback?error=access_denied&error_description=User+said+no&state=${state}`)).toBe("cancelled");
    const { HttpError } = await import("@/lib/tenancy");
    h0.completeConnect.mockRejectedValueOnce(new HttpError(502, "Meta did not confirm the login: <secret detail>"));
    const failed = await GET(new Request(`${ORIGIN}/api/meta-connect/callback?code=C&state=${state}`));
    const text = await failed.text();
    expect(text).toContain('content="failed"');
    expect(text).not.toContain("secret detail");
    h0.getActor.mockRejectedValueOnce(new HttpError(401, "Sign in"));
    expect(await word(`${ORIGIN}/api/meta-connect/callback?code=C&state=${state}`)).toBe("failed");
  });

  it("without the marker the full-page redirect is kept: connected, cancelled, failed, and 401 as before", async () => {
    const { GET } = await import("@/app/api/meta-connect/callback/route");
    const ok = await GET(new Request(`${ORIGIN}/api/meta-connect/callback?code=C&state=abc.123.def`));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`${ORIGIN}/app/settings/connections?status=connected`);
    expect((await GET(new Request(`${ORIGIN}/api/meta-connect/callback?error=x&state=abc`))).headers.get("location")).toContain("status=cancelled");
    const { HttpError } = await import("@/lib/tenancy");
    h0.completeConnect.mockRejectedValueOnce(new HttpError(400, "expired"));
    expect((await GET(new Request(`${ORIGIN}/api/meta-connect/callback?code=C&state=abc`))).headers.get("location")).toContain("status=failed");
    h0.getActor.mockRejectedValueOnce(new HttpError(401, "Sign in"));
    expect((await GET(new Request(`${ORIGIN}/api/meta-connect/callback?code=C&state=abc`))).status).toBe(401);
  });
});

// =====================================================================================================================
// "Do this with Eddy" on the setup page (6.1)
// =====================================================================================================================

describe("StepCard: Do this with Eddy opens Eddy with the member's request for that step", () => {
  const step = computeSteps(FACTS)[0];

  it("renders the button with a full-sentence label next to the step's own action", () => {
    const markup = html(h(StepCard, { step, index: 1, blocker: null, canDismiss: true, busy: false, onDismiss: noop }));
    expect(markup).toContain(`aria-label="${DO_WITH_EDDY}: ${step.title}"`);
    expect(textOf(markup)).toContain("Do this with Eddy");
    expect(markup).toContain(`href="${step.href}"`);
  });

  it("dispatches wa:eddy-open with the catalogue's text only", () => {
    const target = new EventTarget();
    const seen: unknown[] = [];
    onEddyEvent(EDDY_EVENTS.open, (d) => seen.push(d), target);
    expect(doWithEddy(step, target)).toBe(true);
    expect(seen).toEqual([{ query: "Help me with this setup step: Connect WhatsApp." }]);
  });
});

// =====================================================================================================================
// Inbox hooks (EDDY-15)
// =====================================================================================================================

describe("Composer: an Eddy draft goes into the open chat's box only, and nothing is ever sent", () => {
  it("only the chat it names takes the draft; the template picker opens for that chat only", () => {
    expect(eddyDraftFor({ conversationId: "cv1", text: "Namaste" }, "cv1")).toBe("Namaste");
    expect(eddyDraftFor({ conversationId: "cv2", text: "Namaste" }, "cv1")).toBeNull();
    expect(eddyDraftFor({ conversationId: "cv1", text: "   " }, "cv1")).toBeNull();
    expect(eddyOpensTemplatesFor({ conversationId: "cv1" }, "cv1")).toBe(true);
    expect(eddyOpensTemplatesFor({ conversationId: "cv9" }, "cv1")).toBe(false);
  });

  it("an empty box takes the draft; otherwise it is added on a new line, once", () => {
    expect(withEddyDraft("", "Hello")).toBe("Hello");
    expect(withEddyDraft("Hi there  ", "Hello")).toBe("Hi there\nHello");
    expect(withEddyDraft("Hi Hello", "Hello")).toBe("Hi Hello");
  });

  it("the composer's Eddy listeners only fill the box or open the picker: no send call in them", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/inbox/Composer.tsx"), "utf8");
    const start = src.indexOf("const offDraft = onEddyEvent(EDDY_EVENTS.draft");
    const block = src.slice(start, src.indexOf("}, [conversationId]);", start));
    expect(start).toBeGreaterThan(0);
    expect(block).toContain("eddyDraft.current(draft)");
    expect(block).toContain("setPanelOpen(true)");
    expect(block).not.toMatch(/\bsend\(|onSendText|onSendTemplate|onSendMedia|apiFetch/);
  });
});

describe("ConversationList: keys from inside Eddy never move the highlighted chat, nor while a modal is open", () => {
  const doc = (selector: string | null) => ({ querySelector: (s: string) => (selector && s.includes(selector) ? {} : null) }) as unknown as Pick<Document, "querySelector">;
  const inside = { closest: (s: string) => (s === "[data-eddy-root]" ? {} : null) } as unknown as EventTarget;
  const outside = { closest: () => null } as unknown as EventTarget;

  it("pauses for a target inside [data-eddy-root], and for any [aria-modal=true] or open dialog", () => {
    expect(listShortcutsPaused(inside, doc(null))).toBe(true);
    expect(listShortcutsPaused(outside, doc('[aria-modal="true"]'))).toBe(true);
    expect(listShortcutsPaused(outside, doc("dialog[open]"))).toBe(true);
    expect(listShortcutsPaused(outside, doc(null))).toBe(false);
    expect(listShortcutsPaused(null, null)).toBe(false);
  });

  it("the list's own handler checks it before acting on a key", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/inbox/ConversationList.tsx"), "utf8");
    const handler = src.slice(src.indexOf("keyHandler.current = (e) => {"), src.indexOf("const action = shortcutFor("));
    expect(handler).toContain("if (listShortcutsPaused(e.target, document)) return;");
  });
});

describe("InboxApp and MessageBubble", () => {
  it("refetches the list and the open chat on wa:eddy-did for what the inbox shows", () => {
    for (const entity of ["conversation", "contact", "quick_reply", "team"] as const) expect(eddyDidRefreshesInbox({ entity, ids: ["x"] })).toBe(true);
    for (const entity of ["spending", "segment", "approval"] as const) expect(eddyDidRefreshesInbox({ entity, ids: ["x"] })).toBe(false);
  });

  const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: "msg_1", direction: "outbound", type: "text", body: "Your bill is attached", status: "failed", errorCode: "131047", createdAt: "2026-10-28T10:00:00Z", ...over }) as ChatMessage;
  const bubble = (m: ChatMessage) => html(h(Bubble, { m, first: true, last: true, templates: [], onOpenMedia: noop, onRetry: noop, onDiscard: noop }));

  it("a failed message the server stored shows Explain; a local, a sent or a malformed one does not", () => {
    const failed = bubble(message());
    expect(failed).toContain('aria-label="Explain why this message failed"');
    expect(textOf(failed)).toContain("Explain");
    expect(bubble(message({ local: true }))).not.toContain("Explain");
    expect(bubble(message({ status: "delivered" }))).not.toContain("Explain");
    expect(canExplain(message({ id: "bad id" }))).toBe(false);
  });

  it("Explain opens Eddy with the message id only: never its text or the error", () => {
    const target = new EventTarget();
    const seen: unknown[] = [];
    onEddyEvent(EDDY_EVENTS.open, (d) => seen.push(d), target);
    expect(explainWithEddy(message(), target)).toBe(true);
    expect(seen).toEqual([{ ref: { kind: "message", messageId: "msg_1" } }]);
    expect(JSON.stringify(seen)).not.toContain("bill");
  });
});

// =====================================================================================================================
// Copy and files
// =====================================================================================================================

describe("the guides' catalogue and files", () => {
  it("has every key in all three languages", () => {
    const keys = Object.keys(guidesCatalogue.en).sort();
    expect(Object.keys(guidesCatalogue.hi).sort()).toEqual(keys);
    expect(Object.keys(guidesCatalogue.hinglish).sort()).toEqual(keys);
    expect(keys.length).toBeGreaterThan(100);
  });

  it.each([
    "src/lib/eddy/guides.ts",
    "src/lib/eddy/copy/guides.ts",
    "src/components/eddy/guides/SetupGuide.tsx",
    "src/components/eddy/guides/ConnectStep.tsx",
    "src/components/eddy/guides/TemplateStep.tsx",
    "src/components/eddy/guides/BroadcastStep.tsx",
    "src/components/eddy/guides/FacebookLoginStep.tsx",
  ])("%s: tokens only, no inner HTML, no Meta host, no user actor", (file) => {
    const src = readFileSync(path.resolve(__dirname, "..", file), "utf8");
    expect(src).not.toMatch(/\bdark:/);
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(src).not.toMatch(/\bz-(\d+|\[)/);
    expect(src).not.toContain("dangerouslySetInnerHTML");
    expect(src).not.toMatch(/facebook\.com|business\.facebook|meta\.com|fb\.me/i);
    expect(src).not.toMatch(/\btype\s*:\s*["']user["']/);
  });
});

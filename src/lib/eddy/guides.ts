/**
 * Eddy's guided setup (docs/EDDY-SPEC.md 6.8, 6.15, 12.1a decision 11, EDDY-17): deterministic first, AI second, and never
 * strands anyone.
 *
 * Pure: the step cards are built from GET /api/setup (steps, state, blockedBy, nextStepId) with no model call, so the guide
 * works while Eddy is off (platform_off, paused, allowance_used, user_capped). Every card has a title, a one-line reason,
 * the minutes it takes, a primary button that leads to a real page, "Ask Eddy about this" and, for admins, "Skip for now".
 * When Eddy can chat, the template and broadcast steps hand Eddy a message in the member's own words (a chip tap is the
 * member's message, 7.2 item 9); when Eddy can't, the same card links to the page that does the job by hand.
 *
 * Nothing here links to a Meta domain (6.15). The only Meta screens the guide reaches are Embedded Signup, through the
 * connect page where FB.login runs synchronously from the click, and Facebook Login for Business, through our own start
 * route (src/components/meta-connect/useFacebookLoginPopup.ts).
 */
import { classifyFailure, type Failure } from "@/components/connect/helpers";
import type { SetupStep, StepId } from "@/lib/setup/checklist";
import { safeAppPath, type EddyLang } from "./contract";
import { tg, type GuidesKey } from "./copy/guides";
import { t } from "./i18n";

export { tg };

export type GuideRole = "owner" | "admin" | "agent";
export type GuideKind = "connect" | "template" | "broadcast" | "facebook" | "link";

/** GET /api/setup's answer, as the guide reads it. */
export type SetupData = {
  steps: SetupStep[];
  /** asked: the steps asked of the owner (done plus todo), the count the setup page shows. */
  summary: { done: number; total: number; asked?: number; nextStepId: StepId | null; complete: boolean };
  canDismiss: boolean;
};

/** Steps with their own flow inside the card; every other step is a link card (6.8 step 4). */
export const GUIDE_KIND: Record<StepId, GuideKind> = {
  connect: "connect",
  template: "template",
  contacts: "link",
  broadcast: "broadcast",
  invite: "link",
  routing: "link",
  automation: "link",
  facebook: "facebook",
  plan: "link",
};

/**
 * Who can do each step, as the pages behind them require: adding contacts is open to the whole team; connecting accounts,
 * templates, broadcasts, invites, routing, automations and billing are for admins and the owner.
 */
export const STEP_MIN_ROLE: Record<StepId, GuideRole> = {
  connect: "admin",
  template: "admin",
  contacts: "agent",
  broadcast: "admin",
  invite: "admin",
  routing: "admin",
  automation: "admin",
  facebook: "admin",
  plan: "admin",
};

/** Where each step's work is done by hand. The connect step adds ?from=eddy so the connect page knows who sent the member. */
export const STEP_PATH: Record<StepId, string> = {
  connect: "/app/settings/connect?from=eddy",
  template: "/app/templates/new",
  contacts: "/app/contacts",
  broadcast: "/app/broadcasts/new",
  invite: "/app/settings/team",
  routing: "/app/settings/routing",
  automation: "/app/automation/chatbots/new",
  facebook: "/app/settings/connections",
  plan: "/app/billing",
};

export const CONNECT_PATH = STEP_PATH.connect;
export const CONNECTIONS_PATH = "/app/settings/connections";
export const TEMPLATES_NEW_PATH = STEP_PATH.template;
export const BROADCASTS_PATH = "/app/broadcasts";

const isAdmin = (role: GuideRole | string) => role === "owner" || role === "admin";
const canDo = (role: GuideRole | string, step: StepId) => STEP_MIN_ROLE[step] === "agent" || isAdmin(role);

export type GuideButton = { label: string; path: string };

export type GuideCard = {
  id: StepId;
  kind: GuideKind;
  title: string;
  reason: string;
  minutes: string;
  optional: boolean;
  /** The next step (summary.nextStepId): it opens with its flow; the others are compact. */
  current: boolean;
  /** The page that does this step (or its blocker) by hand. Null only when the member's role can't do it. */
  primary: GuideButton | null;
  /** The blocker's sentence, when another step must come first; `primary` then leads to that step. */
  blocked: string | null;
  /** For team members on an admin step: who has to do it. */
  adminNeeded: string | null;
  /** The setup API's own detail line (English only: it is written by the setup checklist). */
  detail: string | null;
  ask: { label: string; a11y: string; query: string };
  skip: { label: string; a11y: string } | null;
};

export type GuideModel = { done: number; total: number; complete: boolean; nextStepId: StepId | null; cards: GuideCard[] };

export const stepTitle = (lang: EddyLang, id: StepId) => tg(lang, `guides.step.${id}.title` as GuidesKey);
export const stepReason = (lang: EddyLang, id: StepId) => tg(lang, `guides.step.${id}.reason` as GuidesKey);
const stepCta = (lang: EddyLang, id: StepId) => tg(lang, `guides.step.${id}.cta` as GuidesKey);

/** "About 5 min" in the member's language. */
export function minutesLabel(lang: EddyLang, minutes: number): string {
  const n = Number.isFinite(minutes) && minutes > 0 ? Math.max(1, Math.round(minutes)) : 1;
  return tg(lang, "guides.minutes", { minutes: n });
}

function adminNeededText(lang: EddyLang, id: StepId): string {
  if (id === "connect") return tg(lang, "guides.admin_needed.connect");
  if (id === "facebook") return tg(lang, "guides.admin_needed.facebook");
  return tg(lang, "guides.admin_needed.generic");
}

function blockedText(lang: EddyLang, by: StepId): string {
  if (by === "connect" || by === "template" || by === "contacts") return tg(lang, `guides.blocked.${by}` as GuidesKey);
  return stepTitle(lang, by);
}

/** The message "Ask Eddy about this" sends, in the member's words and language. Built from the catalogue only. */
export function guideAskQuery(lang: EddyLang, id: StepId): string {
  return tg(lang, "guides.ask.query", { step: stepTitle(lang, id) });
}

/**
 * The step cards, from GET /api/setup. Done and skipped steps are left out (the full list stays on the Getting started
 * page); the next step comes first. No model call, so this works whatever Eddy's state.
 */
export function buildGuide(setup: SetupData, o: { lang: EddyLang; role: GuideRole | string }): GuideModel {
  const { lang, role } = o;
  const open = setup.steps.filter((s) => s.state !== "done" && !s.dismissed);
  const nextId = setup.summary.nextStepId;
  const ordered = [...open.filter((s) => s.id === nextId), ...open.filter((s) => s.id !== nextId)];
  const byId = new Map(setup.steps.map((s) => [s.id, s]));
  const cards = ordered.map((s): GuideCard => {
    const allowed = canDo(role, s.id);
    const blocker = s.blockedBy ? byId.get(s.blockedBy) ?? null : null;
    const target = blocker && blocker.state !== "done" ? blocker.id : null;
    const primaryStep = target ?? s.id;
    const primary = allowed && canDo(role, primaryStep) ? { label: stepCta(lang, primaryStep), path: STEP_PATH[primaryStep] } : null;
    const title = stepTitle(lang, s.id);
    return {
      id: s.id,
      kind: GUIDE_KIND[s.id],
      title,
      reason: stepReason(lang, s.id),
      minutes: minutesLabel(lang, s.minutes),
      optional: s.state === "optional",
      current: s.id === nextId,
      primary,
      blocked: target ? blockedText(lang, target) : null,
      adminNeeded: allowed ? null : adminNeededText(lang, s.id),
      detail: lang === "en" ? s.detail : null,
      ask: { label: tg(lang, "guides.ask"), a11y: tg(lang, "guides.ask.a11y", { step: title }), query: guideAskQuery(lang, s.id) },
      skip: setup.canDismiss && isAdmin(role) ? { label: tg(lang, "guides.skip"), a11y: tg(lang, "guides.skip.a11y", { step: title }) } : null,
    };
  });
  return { done: setup.summary.done, total: setup.summary.total, complete: setup.summary.complete, nextStepId: nextId, cards };
}

// ===== 1. Connect WhatsApp =====

/** Meta's five Embedded Signup screens, in the member's language (English is POPUP_SCREENS word for word). */
export function connectScreens(lang: EddyLang): { title: string; text: string }[] {
  return ([1, 2, 3, 4, 5] as const).map((n) => ({ title: tg(lang, `guides.connect.screen${n}.title`), text: tg(lang, `guides.connect.screen${n}.text`) }));
}

/** PREPARE_CHECKLIST in the member's language, plus the coexistence line (6.8). */
export function prepareChecklist(lang: EddyLang): string[] {
  return [tg(lang, "guides.connect.prepare1"), tg(lang, "guides.connect.prepare2"), tg(lang, "guides.connect.prepare3"), tg(lang, "guides.connect.prepare4"), tg(lang, "guides.connect.coexistence")];
}

/** How often the connect step re-reads the onboarding status while it waits, and for how long. */
export const CONNECT_POLL_MS = 5_000;
export const CONNECT_POLL_LIMIT_MS = 15 * 60_000;

export type OnboardingStatus = { status: string; steps?: { step: string; status: string }[]; token?: { state?: string | null } | null };
export type TokenHealth = { state?: string | null };
export type ConnectCheck = { state: "connected" | "reconnect" | "waiting"; text: string };

/** A business number for the outcome line, masked like "+91 98xxx x4321" (only the country code, 2 and 4 digits show). */
export function maskGuidePhone(display: string | null | undefined): string | null {
  if (typeof display !== "string") return null;
  const digits = display.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  const national = digits.length > 10 ? digits.slice(-10) : digits;
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 10) : "";
  const masked = `${national.slice(0, 2)}xxx x${national.slice(-4)}`;
  return cc ? `+${cc} ${masked}` : masked;
}

/**
 * What the connect step posts after reading GET /api/onboarding/status (and GET /api/onboarding/token-health):
 * "WhatsApp is connected: +91 98xxx x4321. Next: your first template." once the workspace is live with a usable token;
 * a reconnect line when the token expired or Meta refused it; otherwise it keeps waiting.
 */
export function connectCheck(lang: EddyLang, status: OnboardingStatus | null, health: TokenHealth | null, phone: string | null): ConnectCheck {
  const token = health?.state ?? status?.token?.state ?? null;
  if (status?.status === "live") {
    if (token === "expired" || token === "rejected") return { state: "reconnect", text: tg(lang, "guides.connect.reconnect") };
    const masked = maskGuidePhone(phone);
    return { state: "connected", text: masked ? tg(lang, "guides.connect.done", { phone: masked }) : tg(lang, "guides.connect.done_plain") };
  }
  return { state: "waiting", text: tg(lang, "guides.connect.not_yet") };
}

/**
 * GET /api/onboarding/status reports which server step failed, not Meta's words. The step decides which classifyFailure()
 * case it is: the one-time code ran out (exchange_code), Meta sent no account details (verify_ids), Meta refused the number
 * (subscribe_app, register_number), or something on our side (the rest). Null while nothing failed.
 */
export function onboardingFailureMessage(steps: readonly { step: string; status: string }[] | null | undefined): string | null {
  const failed = (steps ?? []).find((s) => s.status === "failed");
  if (!failed) return null;
  if (failed.step === "exchange_code") return "expired";
  if (failed.step === "verify_ids") return "did not return account details";
  if (failed.step === "subscribe_app" || failed.step === "register_number") return "meta said";
  return "failed";
}

export type FixKind = "retry" | "connect_again" | "coexistence" | "support";
export type ConnectFix = { kind: FixKind; label: string; path?: string; href?: string };
export type ConnectFailure = { kind: Failure["kind"]; title: string; text: string; fixes: ConnectFix[] };

const FAIL_KEY: Record<Failure["kind"], GuidesKey> = {
  blocked: "guides.fail.blocked",
  expired: "guides.fail.expired",
  taken: "guides.fail.taken",
  busy: "guides.fail.busy",
  unavailable: "guides.fail.unavailable",
  "no-details": "guides.fail.no_details",
  limit: "guides.fail.limit",
  permission: "guides.fail.permission",
  meta: "guides.fail.meta",
  generic: "guides.fail.generic",
};

/** The support address as a mail link; set by the caller (src/lib/config COMPANY), never a Meta address. */
export type SupportLink = { href: string };

/**
 * A connect failure in the member's language, from the same classifyFailure() the connect page uses (6.8): what happened in
 * one line and the fixes: retry, connect again (the Embedded Signup popup, on the connect page), coexistence, or support.
 * A failure that can only be fixed inside Meta (the person is not an admin of the business) says what is needed and offers
 * [Connect again]; there is never a link to a Meta domain (6.15).
 */
export function connectFailure(message: string, o: { lang: EddyLang; stage?: 2 | 3; site: string; support?: SupportLink | null }): ConnectFailure {
  const f = classifyFailure(message, o.stage);
  const text = tg(o.lang, FAIL_KEY[f.kind], { site: o.site });
  const again: ConnectFix = { kind: "connect_again", label: tg(o.lang, "guides.fix.connect_again"), path: CONNECT_PATH };
  const retry: ConnectFix = { kind: "retry", label: tg(o.lang, "guides.fix.retry"), path: CONNECT_PATH };
  const support: ConnectFix | null = o.support && /^mailto:/i.test(o.support.href) ? { kind: "support", label: tg(o.lang, "guides.fix.support"), href: o.support.href } : null;
  const coexistence: ConnectFix = { kind: "coexistence", label: tg(o.lang, "guides.fix.coexistence"), path: CONNECT_PATH };
  const byKind: Record<Failure["kind"], (ConnectFix | null)[]> = {
    // Only fixable inside Meta: say what is needed, then reopen the Embedded Signup popup (the one allowed Meta screen).
    permission: [again],
    "no-details": [again],
    taken: [again],
    // The number may still sit on the WhatsApp Business app or with another provider: coexistence keeps the app.
    meta: [again, coexistence],
    unavailable: [support],
    blocked: [retry],
    expired: [retry, support],
    busy: [retry, support],
    limit: [retry, support],
    generic: [retry, support],
  };
  const fixes = byKind[f.kind].filter((x): x is ConnectFix => x !== null && (!x.path || safeAppPath(x.path) !== null));
  return { kind: f.kind, title: tg(o.lang, "guides.connect.failed"), text, fixes };
}

// ===== 2. First template =====

export const TEMPLATE_PURPOSES = ["offer", "order", "reminder", "other"] as const;
export type TemplatePurpose = (typeof TEMPLATE_PURPOSES)[number];
export const CUSTOMER_LANGS = ["en", "hi"] as const;
export type CustomerLang = (typeof CUSTOMER_LANGS)[number];

/** The tools the template flow leads Eddy through (6.8 step 2): category guidance, the undoable draft, the Submit card. */
export const TEMPLATE_FLOW_TOOLS = ["search_help", "create_template_draft", "submit_template"] as const;

export const purposeLabel = (lang: EddyLang, p: TemplatePurpose) => tg(lang, `guides.template.purpose.${p}` as GuidesKey);
export const customerLangLabel = (lang: EddyLang, l: CustomerLang) => tg(lang, `guides.template.lang.${l}` as GuidesKey);

/** Marketing for an offer, Utility for order updates and reminders (the same rule search_help's entry states). */
export function categoryNote(lang: EddyLang, p: TemplatePurpose): string {
  if (p === "offer") return tg(lang, "guides.template.category.marketing");
  if (p === "order" || p === "reminder") return tg(lang, "guides.template.category.utility");
  return tg(lang, "guides.template.category.other");
}

/** The member's message that asks Eddy for the draft, in the member's language; the customers' language is a separate answer. */
export function templateQuery(lang: EddyLang, p: TemplatePurpose, customers: CustomerLang): string {
  return tg(lang, "guides.template.query", { purpose: tg(lang, `guides.template.word.${p}` as GuidesKey), language: tg(lang, `guides.template.word.${customers}` as GuidesKey) });
}

// ===== 3. First broadcast =====

export const AUDIENCES = ["opted_in", "tag", "segment"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** The tools the broadcast flow leads Eddy through (6.8 step 3). v1 never starts a broadcast: the member does, on its page. */
export const BROADCAST_FLOW_TOOLS = ["preview_audience", "create_broadcast_draft", "estimate_broadcast"] as const;

export const audienceLabel = (lang: EddyLang, a: Audience) => tg(lang, `guides.broadcast.audience.${a}` as GuidesKey);

/** A tag or segment name the member typed: one line, trimmed, at most 60 characters. Null when nothing usable is left. */
export function audienceName(raw: string): string | null {
  const s = raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return s ? Array.from(s).slice(0, 60).join("") : null;
}

export function broadcastQuery(lang: EddyLang, a: Audience, name?: string | null): string | null {
  if (a === "opted_in") return tg(lang, "guides.broadcast.query.opted_in");
  const n = audienceName(name ?? "");
  if (!n) return null;
  return tg(lang, a === "tag" ? "guides.broadcast.query.tag" : "guides.broadcast.query.segment", { name: n });
}

/** [Review and start]: the broadcast Eddy drafted (told by wa:eddy-did), else the broadcasts list. Never a start call. */
export function reviewPath(broadcastId?: string | null): string {
  if (broadcastId && /^[A-Za-z0-9_-]{1,64}$/.test(broadcastId)) return `${BROADCASTS_PATH}/${broadcastId}`;
  return BROADCASTS_PATH;
}

// ===== Facebook Login for Business =====

export type FacebookResult = { kind: "outcome"; outcome: "connected" | "cancelled" | "failed" } | { kind: "closed" } | { kind: "timeout" } | { kind: "error"; message: string };

/** The line the Facebook step shows for an attempt's end, in the member's language. Never Meta's own text. */
export function facebookResultText(lang: EddyLang, r: FacebookResult): string {
  switch (r.kind) {
    case "outcome":
      return tg(lang, r.outcome === "connected" ? "guides.facebook.connected" : r.outcome === "cancelled" ? "guides.facebook.cancelled" : "guides.facebook.failed");
    case "closed":
      return tg(lang, "guides.facebook.closed");
    case "timeout":
      return tg(lang, "guides.facebook.timeout");
    case "error":
      return tg(lang, r.message === "closed" ? "guides.facebook.cancelled" : "guides.facebook.error");
  }
}

/** The core button labels the guide reuses, so the guide and the rest of Eddy name things the same way. */
export const guideButton = {
  connectWhatsApp: (lang: EddyLang) => t(lang, "btn.connect_whatsapp"),
  connectFacebook: (lang: EddyLang) => t(lang, "btn.connect_facebook"),
};

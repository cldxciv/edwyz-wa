import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ActionCard, MetaLinkButton, NavChips, TurnOnEddyCard, safeChips, safeMetaLink } from "@/components/eddy/ActionCard";
import { CustomerQuote, cutGraphemes } from "@/components/eddy/CustomerQuote";
import { EddyAvatar } from "@/components/eddy/EddyAvatar";
import { EDDY_EVENTS, announceEddyDid, checkDetail, dispatchEddyEvent, onEddyEvent, openEddy } from "@/components/eddy/events";
import { MessageView, errorText, type TranscriptItem } from "@/components/eddy/MessageView";
import {
  CONNECT_PATH,
  PreviewCard,
  RECONNECT_PATH,
  SPENDING_PATH,
  cardAnnouncement,
  confirmArmed,
  costText,
  guardTap,
  initialFocusTarget,
  isDangerCard,
  stateMessage,
  viewFromOutcome,
  type CardView,
} from "@/components/eddy/PreviewCard";
import { ProgressSteps, type ProgressStep } from "@/components/eddy/ProgressSteps";
import { ResultRow, undoAvailable, type ResultRowState } from "@/components/eddy/ResultRow";
import { MD_MAX_TABLE_COLUMNS, SafeMarkdown, markdownPlainText, parseInline, parseMarkdown } from "@/components/eddy/SafeMarkdown";
import { CardStatusChip, EddyStatusChip, cardChip, eddyChip, type CardChipState, type EddyChipState } from "@/components/eddy/StatusChip";
import type { Preview } from "@/lib/actions/types";
import { u } from "@/lib/actions/untrusted";
import { CARD_CONFIRM_GUARD_MS, EDDY_AVAILABILITY_ORDER, EDDY_LANGS, type EddyLang, type PendingCardDTO } from "@/lib/eddy/contract";
import { t } from "@/lib/eddy/i18n";
import { spendCopy } from "@/lib/spend/copy";

/**
 * docs/EDDY-SPEC.md 2.5, 6.3 to 6.5, 6.12, 6.13, 6.15, 12.1a decisions 0 and 10, EDDY-13 (the renderer and the cards this
 * package owns). Rendered with renderToStaticMarkup, in light and dark, in all three languages.
 */

const html = (node: ReactElement) => renderToStaticMarkup(node);
/** What React's server renderer turns text into. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
/** The text a person sees: tags removed, entities decoded. */
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// ===== Themes: light and dark come only from tokens =====

const CSS = readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8");
function block(selector: string): string {
  const start = CSS.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  return CSS.slice(start, CSS.indexOf("\n}", start));
}
const defined = (b: string) => new Set([...b.matchAll(/^\s*--([a-z0-9-]+):/gm)].map((m) => m[1]));
const LIGHT = defined(block(":root {"));
const DARK = defined(block(':root[data-theme="dark"] {'));
const THEME_COLORS = new Map([...block("@theme inline {").matchAll(/--color-([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)/g)].map((m) => [m[1], m[2]]));
const PALETTE = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$|^(white|black)$/;
const COLOR_UTILITY = /^(?:bg|text|border(?:-[trblxy])?|ring|fill|stroke|decoration|outline|divide|placeholder|from|to|via)-(.+?)(?:\/\d+)?$/;

/** Every colour in the markup must be a design token defined in both themes; no palette colours, hex or dark: variants. */
function themeProblems(markup: string): string[] {
  const problems: string[] = [];
  for (const m of markup.matchAll(/class="([^"]*)"/g)) {
    for (const raw of m[1].split(/\s+/).filter(Boolean)) {
      if (/(^|:)dark:/.test(raw) || raw.startsWith("dark:")) problems.push(`dark variant ${raw}`);
      const utility = raw.replace(/^(?:[a-z0-9-]+:)+/, "");
      const cm = COLOR_UTILITY.exec(utility);
      if (!cm) continue;
      const name = cm[1];
      if (PALETTE.test(name)) problems.push(`palette colour ${raw}`);
      if (/#[0-9a-f]{3,8}/i.test(name)) problems.push(`raw hex ${raw}`);
      const token = THEME_COLORS.get(name);
      if (token && !(LIGHT.has(token) && DARK.has(token))) problems.push(`token --${token} missing in a theme (${raw})`);
    }
    for (const ref of m[1].matchAll(/\(--([a-z0-9-]+)\)/g)) if (!LIGHT.has(ref[1])) problems.push(`unknown token --${ref[1]}`);
  }
  for (const m of markup.matchAll(/style="([^"]*)"/g)) {
    const style = m[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    if (style.includes("#")) problems.push(`hex in style ${style}`);
    for (const ref of m[1].matchAll(/var\(--([a-z0-9-]+)\)/g)) if (!LIGHT.has(ref[1])) problems.push(`unknown token --${ref[1]}`);
  }
  for (const m of markup.matchAll(/(?:fill|stroke)="([^"]*)"/g)) {
    if (!/^(none|currentColor|var\(--[a-z0-9-]+\))$/.test(m[1])) problems.push(`svg colour ${m[1]}`);
  }
  return problems;
}

/** Renders the node in light and in dark, checks both are token-only, and returns the markup. */
function inBothThemes(node: ReactElement): string {
  const out: string[] = [];
  for (const theme of ["light", "dark"]) {
    const markup = html(h("div", { "data-theme": theme }, node));
    const inner = markup.slice(markup.indexOf(">") + 1, markup.lastIndexOf("</div>"));
    expect(themeProblems(inner), theme).toEqual([]);
    out.push(inner);
  }
  // Tokens flip by theme, so the markup itself is identical.
  expect(out[0]).toBe(out[1]);
  return out[0];
}

// ===== Fixtures =====

const NOW = Date.parse("2026-10-28T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function preview(over: Partial<Preview> = {}): Preview {
  return {
    titleKey: "card.send_text_reply.title",
    vars: { name: u("contact_name", "Ramesh") },
    facts: [{ labelKey: "fact.chat", value: u("contact_name", "Ramesh K") }],
    recipients: { count: 1, sample: [{ name: u("contact_name", "Ramesh"), phoneMasked: "+91 98xxx x4321" }] },
    message: { kind: "text", body: "Your order ships tomorrow." },
    cost: { state: "free", reason: "service_window" },
    warnings: ["contains_link_or_number"],
    editable: [{ field: "text", kind: "text" }],
    confirmLabelKey: "card.send_text_reply.confirm",
    danger: false,
    material: { targetId: "cv1" },
    ...over,
  };
}

function card(over: Partial<PendingCardDTO> = {}, p: Partial<Preview> = {}): PendingCardDTO {
  return {
    actionId: "ar_1",
    action: "send_text_reply",
    nonce: "n".repeat(43),
    previewHash: "h".repeat(64),
    preview: preview(p),
    lang: "en",
    state: "pending",
    createdAt: iso(NOW),
    expiresAt: iso(NOW + 15 * 60_000),
    confirmGuardMs: CARD_CONFIRM_GUARD_MS,
    ...over,
  };
}

const noop = () => undefined;
const previewCard = (c: PendingCardDTO, lang: EddyLang, view?: CardView, extra: Record<string, unknown> = {}) =>
  h(PreviewCard, { card: c, lang, view, now: NOW, onConfirm: noop, onCancel: noop, onRevise: noop, onRefresh: noop, onAsk: noop, ...extra });

const ALL_STATES: { view: CardView; en: string[] }[] = [
  { view: { state: "pending" }, en: ["Send reply", "Nothing happens until you tap Send reply.", "Expires in 15 min"] },
  { view: { state: "running" }, en: ["Sending…"] },
  { view: { state: "done", path: "/app/inbox?c=cv1" }, en: ["Sent to Ramesh.", 'href="/app/inbox?c=cv1"'] },
  { view: { state: "failed", code: "invalid", message: "This contact has opted out of messages." }, en: ["This contact has opted out of messages."] },
  { view: { state: "changed", params: { count: "140", cost: "About ₹1,430" } }, en: ["Something changed since this preview: now 140 contacts, About ₹1,430. Check and confirm again."] },
  { view: { state: "expired" }, en: ["This preview expired.", "Refresh preview"] },
  { view: { state: "cancelled" }, en: ["Cancelled. Nothing was sent."] },
  { view: { state: "unknown" }, en: ["It isn't certain whether this went through. It's being checked, and it won't be tried again automatically."] },
  { view: { state: "needs_approver", names: ["Omar"], path: "/app/broadcasts/b1" }, en: ["Only Omar can confirm spending that Eddy prepares. You can start it yourself on its page, or ask them.", "Ask Omar", 'href="/app/broadcasts/b1"'] },
  { view: { state: "awaiting_approval", params: { approver: "Omar", time: "3:40 pm" } }, en: ["Waiting for Omar's approval. It expires at 3:40 pm; if nobody answers, it is declined."] },
  { view: { state: "spend_frozen", code: "spend.frozen" }, en: [spendCopy("spend.frozen")] },
  { view: { state: "spend_frozen", code: "spend.platform_frozen" }, en: [spendCopy("spend.platform_frozen")] },
  { view: { state: "spend_not_set_up" }, en: [spendCopy("spend.no_limit"), `href="${SPENDING_PATH}"`, "Spending limits"] },
  { view: { state: "spend_refused", code: "spend.broadcast", params: { cost: "₹1,430", left: "₹900" } }, en: ["This broadcast could cost about ₹1,430, but only ₹900 is left in your WhatsApp limit this month. Send to fewer people or raise the limit."] },
  { view: { state: "spend_refused", code: "spend_blocked", message: "Phase 0 sentence." }, en: ["Phase 0 sentence."] },
  { view: { state: "demo" }, en: ["This is a demo workspace, so nothing is sent to Meta or to customers."] },
  { view: { state: "not_connected" }, en: ["WhatsApp isn't connected to this workspace yet.", `href="${CONNECT_PATH.replace(/&/g, "&amp;")}"`, "Connect WhatsApp"] },
  { view: { state: "not_connected", names: ["Priya", "Omar"] }, en: ["WhatsApp isn't connected yet. Ask an admin to connect it: Priya, Omar."] },
  { view: { state: "reconnect" }, en: ["WhatsApp needs to be connected again.", `href="${RECONNECT_PATH.replace(/&/g, "&amp;")}"`, "Reconnect"] },
  { view: { state: "refused", code: "workspace_locked" }, en: ["Your plan has ended, so changes are paused. Renew it in Billing to carry on."] },
  { view: { state: "undone" }, en: ["Undone."] },
];

// ===== Tests =====

describe("preview cards: every 6.5 state in light and dark, in every language", () => {
  it("covers every card state the contract names, plus undone and refused", () => {
    const states = new Set(ALL_STATES.map((s) => s.view.state));
    for (const s of ["pending", "running", "done", "failed", "changed", "expired", "cancelled", "unknown", "needs_approver", "awaiting_approval", "spend_frozen", "spend_not_set_up", "spend_refused", "demo", "not_connected", "reconnect", "undone", "refused"]) expect(states.has(s as CardChipState), s).toBe(true);
  });

  it.each(ALL_STATES.map((s) => [`${s.view.state}${s.view.code ? ` (${s.view.code})` : ""}${s.view.names ? " with names" : ""}`, s] as const))("%s renders its English copy", (_name, s) => {
    const markup = inBothThemes(previewCard(card(), "en", s.view, { isAdmin: s.view.names === undefined }));
    expect(markup).toContain(`data-eddy-card="${s.view.state}"`);
    expect(markup).toContain(esc(cardChip("en", s.view.state).label));
    for (const text of s.en) expect(markup, text).toContain(text.startsWith("href=") ? text : esc(text));
    // Only a pending card can be confirmed, and no card ever offers "Confirm all".
    expect(count(markup, "data-eddy-confirm")).toBe(s.view.state === "pending" ? 1 : 0);
    expect(markup.toLowerCase()).not.toContain("confirm all");
  });

  it.each(EDDY_LANGS.filter((l) => l !== "en"))("every state renders in %s from the catalogue, never a raw key", (lang) => {
    for (const s of ALL_STATES) {
      const markup = inBothThemes(previewCard(card({ lang }), lang, s.view));
      const message = stateMessage(lang, card(), s.view);
      if (message) expect(markup).toContain(esc(message));
      expect(markup).not.toMatch(/\b(card|refuse|warn|cost|fact|btn)\.[a-z_]+/);
      if (lang === "hinglish") expect(/\p{Script=Devanagari}/u.test(markup.replace(/<[^>]+>/g, ""))).toBe(false);
    }
    expect(stateMessage(lang, card(), { state: "cancelled" })).toBe(t(lang, "card.cancelled"));
  });

  it("the not_connected card shows Connect WhatsApp to admins and the admins' names to team members", () => {
    expect(html(previewCard(card(), "en", { state: "not_connected" }, { isAdmin: true }))).toContain(CONNECT_PATH.replace(/&/g, "&amp;"));
    const agent = html(previewCard(card(), "en", { state: "not_connected", names: ["Priya"] }, { isAdmin: false }));
    expect(agent).not.toContain("/app/settings/connect");
    expect(agent).toContain("Priya");
  });

  it("a pending card shows the verb title, facts, masked recipients, the WhatsApp bubble, the cost and each warning with an icon and text", () => {
    const c = card({}, { recipients: { count: 1240, sample: [{ name: u("contact_name", "Ramesh"), phoneMasked: "+91 98xxx x4321" }, { name: null, phoneMasked: "+91 99xxx x0001" }, { name: u("contact_name", "Riya"), phoneMasked: "+91 97xxx x2222" }] }, warnings: ["irreversible", "external_meta", "window_closes_soon"], vars: { name: u("contact_name", "Ramesh"), windowMinutes: 12 } });
    const markup = inBothThemes(previewCard(c, "en"));
    expect(markup).toMatch(/role="group" aria-labelledby="[^"]+"/);
    expect(markup).toContain("Send this reply to ");
    expect(markup).toContain(">Ramesh</bdi>");
    expect(markup).toContain("1,240 contacts");
    expect(markup).toContain("+91 98xxx x4321");
    expect(markup).toContain("and 1,237 more");
    expect(markup).toContain("data-eddy-bubble");
    expect(markup).toContain("Exactly what will be sent");
    expect(markup).toContain("Your order ships tomorrow.");
    expect(markup).toContain("No WhatsApp charge (inside the 24-hour window)");
    for (const w of ["This can&#x27;t be undone.", "This goes to Meta.", "The 24-hour window closes in 12 min."]) expect(markup).toContain(w);
    // Each warning has an icon and words, never colour alone.
    expect(count(markup, "data-warning=")).toBe(3);
    expect(count(markup, '<span class="sr-only">Warning: </span>')).toBe(3);
    // The primary's name is its visible label (Label in Name); the card's title describes it with the full sentence.
    expect(markup).not.toContain('aria-label="Send this reply to Ramesh"');
    expect(markup).toMatch(/aria-describedby="([^"]+)"[^>]*data-eddy-sentence="Send this reply to Ramesh"[^>]*data-eddy-confirm/);
    const describedBy = /aria-describedby="([^"]+)"[^>]*data-eddy-confirm/.exec(markup)![1];
    expect(markup).toContain(`<h3 id="${describedBy}"`);
    // On phones the primary is full width; Edit and Cancel share the row below it.
    expect(markup).toMatch(/class="[^"]*w-full[^"]*sm:w-auto[^"]*"[^>]*data-eddy-confirm/);
    expect(markup).toContain(">Edit</button>");
    expect(markup).toContain(">Cancel</button>");
  });

  it("cost lines use Phase 0's words: free, about, partial, not available yet, and the worst case with what is left", () => {
    expect(costText("en", { state: "free", reason: "service_window" })).toBe("No WhatsApp charge (inside the 24-hour window)");
    expect(costText("en", { state: "free", reason: "internal" })).toBe("No charge");
    expect(costText("en", { state: "estimate", minor: "143000", currency: "INR", formatted: "₹1,430", partial: false, worstCase: false })).toBe("About ₹1,430");
    expect(costText("en", { state: "estimate", minor: "143000", currency: "INR", formatted: "₹1,430", partial: true, worstCase: false })).toBe("About ₹1,430, for the contacts that have a price");
    expect(costText("en", { state: "unknown", reason: "no_rate_card" })).toBe("Not available yet");
    expect(costText("en", { state: "estimate", minor: "450000", currency: "INR", formatted: "₹4,500", partial: false, worstCase: true })).toBe("Could add up to ₹4,500 this month (worst case)");
    expect(costText("en", { state: "estimate", minor: "450000", currency: "INR", formatted: "₹4,500", partial: false, worstCase: true }, "₹900")).toBe("Could add up to ₹4,500 this month (worst case) · ₹900 left");
    expect(costText("hi", { state: "unknown", reason: "no_rate_card" })).toBe("अभी पता नहीं");
    expect(costText("hinglish", { state: "unknown", reason: "not_computable" })).toBe("Abhi pata nahi");
    const worst = html(previewCard(card({}, { cost: { state: "estimate", minor: "450000", currency: "INR", formatted: "₹4,500", partial: false, worstCase: true }, vars: { name: "Ramesh", left: "₹900" } }), "en"));
    expect(worst).toContain("Could add up to ₹4,500 this month (worst case) · ₹900 left");
    expect(worst).toContain('data-eddy-cost="estimate"');
  });

  it("Confirm stays aria-disabled for 600 ms after the card appears, and a tap in that time says Check the preview first once", () => {
    expect(CARD_CONFIRM_GUARD_MS).toBe(600);
    const fresh = html(previewCard(card(), "en"));
    expect(fresh).toMatch(/aria-disabled="true"[^>]*data-eddy-confirm/);
    const armed = html(previewCard(card(), "en", undefined, { armed: true }));
    expect(armed).not.toMatch(/aria-disabled="true"[^>]*data-eddy-confirm/);
    expect(confirmArmed(NOW, NOW + 599)).toBe(false);
    expect(confirmArmed(NOW, NOW + 600)).toBe(true);
    expect(confirmArmed(NOW, NOW + 100, card().confirmGuardMs)).toBe(false);
    expect(guardTap(false, false)).toEqual({ run: false, announce: true });
    expect(guardTap(false, true)).toEqual({ run: false, announce: false });
    expect(guardTap(true, true)).toEqual({ run: true, announce: false });
    expect(t("en", "card.too_fast")).toBe("Check the preview first");
    // The announcement goes to the card's own polite status region.
    expect(fresh).toMatch(/role="status" aria-live="polite" aria-atomic="true" class="sr-only" data-eddy-card-status/);
  });

  it("delete and irreversible cards use the danger variant and focus Cancel first; other cards do not move focus", () => {
    const danger = card({ action: "delete_template" }, { titleKey: "card.delete_template.title", vars: { template: "old_offer" }, confirmLabelKey: "card.delete_template.confirm", danger: true, warnings: ["irreversible", "external_meta"], message: undefined, recipients: undefined, editable: [] });
    const markup = inBothThemes(previewCard(danger, "en"));
    expect(textOf(markup)).toContain("Delete template old_offer?");
    expect(markup).toMatch(/<code class="[^"]*font-mono[^"]*"><span>old_offer<\/span><\/code>/);
    expect(markup).toContain('data-eddy-sentence="Delete template old_offer"');
    expect(markup).not.toContain('aria-label="Delete template old_offer"');
    expect(markup).toMatch(/class="[^"]*bg-danger[^"]*"[^>]*data-eddy-confirm/);
    expect(markup).toMatch(/data-eddy-cancel="true" data-initial-focus="true"/);
    expect(markup).toContain('data-danger="true"');
    expect(initialFocusTarget(danger.preview, "pending")).toBe("cancel");
    expect(isDangerCard({ danger: false, warnings: ["irreversible"] })).toBe(true);
    const plain = html(previewCard(card({}, { warnings: [] }), "en"));
    expect(plain).not.toContain("data-initial-focus");
    expect(initialFocusTarget(card({}, { warnings: [] }).preview, "pending")).toBeNull();
    expect(initialFocusTarget(danger.preview, "done")).toBeNull();
  });

  it("cards carry the lang of their language, and Devanagari cards read at 16 px with line-height 1.6", () => {
    const hi = html(previewCard(card({ lang: "hi" }), "hi"));
    expect(hi).toMatch(/^<section role="group" aria-labelledby="[^"]+" lang="hi"/);
    expect(hi).toMatch(/<h3 id="[^"]+" class="[^"]*text-base leading-\[1\.6\]/);
    expect(html(previewCard(card({ lang: "hinglish" }), "hinglish"))).toMatch(/lang="hi-Latn"/);
    const en = html(previewCard(card(), "en"));
    expect(en).toMatch(/<h3 id="[^"]+" class="[^"]*text-sm/);
    expect(html(h(CustomerQuote, { text: "मेरा ऑर्डर कब आएगा?", lang: "en" }))).toContain("text-base leading-[1.6]");
    expect(html(h(ResultRow, { lang: "hi", summaryKey: "done.tag", vars: { name: "Riya", tag: "vip" }, now: NOW }))).toMatch(/^<div lang="hi" class="[^"]*text-base leading-\[1\.6\]/);
  });

  it("a card past its expiry shows expired with Refresh preview, which needs no AI", () => {
    const markup = html(previewCard(card({ expiresAt: iso(NOW - 1) }), "en"));
    expect(markup).toContain('data-eddy-card="expired"');
    expect(markup).toContain("Refresh preview");
    expect(markup).not.toContain("data-eddy-confirm");
  });

  it("announces a new card as a sentence and maps endpoint answers to states", () => {
    expect(cardAnnouncement("en", card())).toBe("Preview ready: Send this reply to Ramesh. Send reply or cancel.");
    expect(viewFromOutcome({ status: 409, state: "refused", code: "spend.frozen" }).state).toBe("spend_frozen");
    expect(viewFromOutcome({ status: 409, state: "refused", code: "spend.no_limit" }).state).toBe("spend_not_set_up");
    expect(viewFromOutcome({ status: 409, state: "failed", code: "spend.broadcast" }).state).toBe("spend_refused");
    expect(viewFromOutcome({ status: 200, state: "done", note: "cost_lower" })).toMatchObject({ state: "done", costLower: true });
    expect(viewFromOutcome({ status: 409, state: "needs_approver", who: ["Omar"] })).toMatchObject({ state: "needs_approver", names: ["Omar"] });
    expect(viewFromOutcome(null)).toEqual({ state: "failed", code: "internal" });
    expect(viewFromOutcome({ state: "bogus" }).state).toBe("failed");
  });
});

describe("untrusted text renders literally", () => {
  const NASTY = `<img src=x onerror=alert(1)><script>alert(2)</script> **bold** _it_ [click](/app/inbox) \`code\` # heading`;

  it("CustomerQuote shows escaped plain text, labelled From the customer, in a quote block", () => {
    const markup = inBothThemes(h(CustomerQuote, { text: NASTY, lang: "en" }));
    expect(markup).toContain(esc(NASTY));
    const scrubbed = u("customer_message", NASTY);
    expect(html(h(CustomerQuote, { text: scrubbed, lang: "en" }))).toContain(esc(scrubbed.text));
    expect(markup).not.toMatch(/<(img|script|strong|em|a|code|h3)\b/);
    expect(markup).toContain("From the customer");
    expect(markup).toContain("border-border-strong");
    expect(markup).toContain("bg-surface");
    expect(html(h(CustomerQuote, { text: "x", lang: "hi" }))).toContain("ग्राहक का मैसेज");
    expect(html(h(CustomerQuote, { text: "x", lang: "hinglish" }))).toContain("Customer ka message");
  });

  it("long customer text is cut by grapheme, never inside a Devanagari conjunct", () => {
    const word = "क्षत्रिय नमस्ते";
    for (let n = 1; n < 6; n++) {
      const cut = cutGraphemes(word, n);
      expect(cut.endsWith("…")).toBe(true);
      const kept = cut.slice(0, -1);
      expect(word.startsWith(kept)).toBe(true);
      // Never ends on a virama, and never leaves a vowel sign or other mark behind.
      expect(kept.endsWith("्")).toBe(false);
      expect(/^\p{M}/u.test(word.slice(kept.length))).toBe(false);
    }
    expect(cutGraphemes("abc", 5)).toBe("abc");
    expect(cutGraphemes("abcdef", 3)).toBe("abc…");
  });

  it("names, facts and the drafted message on a card render literally", () => {
    const c = card({}, { vars: { name: u("contact_name", NASTY) }, facts: [{ labelKey: "fact.note", value: u("teammate_note", NASTY) }], message: { kind: "text", body: u("external_text", NASTY) }, recipients: { count: 1, sample: [{ name: u("contact_name", NASTY), phoneMasked: "+91 9xxxx" }] } });
    const markup = html(previewCard(c, "en"));
    expect(markup).not.toMatch(/<(img|script|strong|em|code)\b/);
    expect(markup).not.toContain('href="/app/inbox"');
    expect(markup).toContain(esc(u("contact_name", NASTY).text).slice(0, 40));
    expect(markup).toContain("‹script›alert(2)‹/script›");
    expect(markup).toContain("**bold**");
    expect(markup).toContain("[click](/app/inbox)");
  });

  it("the member's own bubble is plain text too", () => {
    const markup = html(h(MessageView, { item: { kind: "member", id: "m1", text: NASTY, lang: "en" } }));
    expect(markup).toContain(esc(NASTY));
    expect(markup).not.toMatch(/<(img|script|strong)\b/);
  });

  it("raw HTML in Eddy's own markdown shows as characters, never as markup", () => {
    const markup = html(h(SafeMarkdown, { text: "Hello <b>there</b> <script>alert(1)</script> <a href='https://evil.example'>x</a>", lang: "en" }));
    expect(markup).not.toMatch(/<(b|script|a)\b/);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(readFileSync(path.resolve(__dirname, "../src/components/eddy/SafeMarkdown.tsx"), "utf8")).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("SafeMarkdown: richly styled replies (decision 0)", () => {
  const RICH = [
    "### Your week",
    "",
    "**186** new chats, *first reply* in `14 min`.",
    "",
    "- Tuesday was busiest",
    "- 3 chats waited over 2 hours",
    "  - 2 are unassigned",
    "",
    "1. Open unassigned",
    "2. Assign them",
    "",
    "#### Details",
    "---",
    "> a quoted line",
    "> stays a paragraph",
  ].join("\n");

  it("renders bold, italics, inline code, lists, nested lists, h3/h4 and a rule, with tokens only", () => {
    const markup = inBothThemes(h(SafeMarkdown, { text: RICH, lang: "en" }));
    expect(markup).toContain("<h3");
    expect(markup).toContain("<h4");
    expect(markup).not.toMatch(/<h[1256]\b/);
    expect(markup).toContain("<strong");
    expect(markup).toContain("<em>first reply</em>");
    expect(markup).toContain(">14 min</code>");
    expect(count(markup, "<ul")).toBe(2);
    expect(markup).toContain("<ol");
    expect(markup).toContain("<hr");
    // A markdown quote never looks like a CustomerQuote.
    expect(markup).not.toContain("<blockquote");
    expect(markup).toContain("a quoted line");
  });

  it("# and ## render at h3 size; a closing run of # is dropped; #hashtag is a paragraph", () => {
    expect(parseMarkdown("# Big")[0]).toMatchObject({ type: "h", level: 3 });
    expect(parseMarkdown("## Title ##")[0]).toMatchObject({ type: "h", level: 3, c: [{ t: "text", v: "Title" }] });
    expect(parseMarkdown("###### Small")[0]).toMatchObject({ type: "h", level: 4 });
    expect(parseMarkdown("#hashtag")[0]).toMatchObject({ type: "p" });
  });

  it("a 7-column table is capped at 6 columns inside a horizontally scrollable region", () => {
    const table = ["| A | B | C | D | E | F | G |", "|---|---|---|---|---|---|---|", "| 1 | 2 | 3 | 4 | 5 | 6 | 7 |", "| 8 | 9 | 10 | 11 | 12 | 13 | 14 |"].join("\n");
    const markup = inBothThemes(h(SafeMarkdown, { text: table, lang: "en" }));
    expect(MD_MAX_TABLE_COLUMNS).toBe(6);
    expect(count(markup, "<th ")).toBe(6);
    expect(count(markup, "<td ")).toBe(12);
    expect(markup).not.toContain(">G</th>");
    expect(markup).not.toContain(">7</td>");
    expect(markup).toMatch(/<div role="region" aria-label="Table" tabindex="0" class="[^"]*max-w-full[^"]*overflow-x-auto[^"]*" data-eddy-table-scroll="true"><table/);
    expect(markup).toContain("1 more column is not shown.");
    expect(markup).toContain('scope="col"');
  });

  it("links render as buttons only for allowlisted /app paths; other sites, Meta and tricks render as text", () => {
    const md = [
      "[Open unassigned](/app/inbox?filter=unassigned)",
      "[Meta settings](https://business.facebook.com/settings)",
      "[Facebook](https://www.facebook.com)",
      "[Tricky](javascript:alert(1))",
      "[Protocol relative](//evil.example/app)",
      "[API](/api/admin/tenants)",
      "[Dots](/app/../api/admin)",
      "[Absolute app](https://wa.edwyz.com/app/inbox)",
      "Bare https://meta.com/x and fb.me/y",
      "![logo](/app/logo.png)",
    ].join("\n\n");
    const markup = html(h(SafeMarkdown, { text: md, lang: "en" }));
    expect(count(markup, "<a ")).toBe(1);
    expect(markup).toMatch(/<a href="\/app\/inbox\?filter=unassigned" class="[^"]*rounded-full[^"]*" data-eddy-link="true">Open unassigned<\/a>/);
    for (const host of ["facebook.com", "javascript:", "evil.example", "/api/admin", "wa.edwyz.com"]) expect(markup).not.toMatch(new RegExp(`href="[^"]*${host.replace(/[.]/g, "\\.")}`));
    for (const label of ["Meta settings", "Facebook", "Tricky", "Protocol relative", "API", "Dots", "Absolute app", "logo"]) expect(markup).toContain(label);
    expect(markup).not.toContain("<img");
  });

  it("a long or crafted line never stalls the parser", () => {
    const started = Date.now();
    parseMarkdown(`# ${" ".repeat(19_000)}x`);
    parseMarkdown(`a | b\n${"| ".repeat(5000)}x`);
    parseMarkdown(`${"> ".repeat(2000)}\n> b\n> c`);
    parseMarkdown("*a ".repeat(3000));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("inline emphasis, code spans and links stay linear at the 20,000-character cap (the crafted cases that took 5 to 9 s)", () => {
    const crafted = [
      "*a ".repeat(6666),
      "**a ".repeat(5000),
      "**a *b **c *d ".repeat(1430),
      "*a**".repeat(5000),
      "_a ".repeat(6666),
      "__a _b ".repeat(2850),
      `${"[".repeat(19_990)}](/app/x)`,
      "`a ``b ".repeat(2850),
      `**${"*a ".repeat(6000)}**`,
    ];
    for (const md of crafted) expect(md.length, md.slice(0, 12)).toBeGreaterThan(10_000);
    const started = performance.now();
    for (const md of crafted) parseMarkdown(md);
    // Quadratic inputs at this size take seconds each; linear ones take milliseconds even on a busy test runner.
    expect(performance.now() - started).toBeLessThan(1500);
    // Still parses the same: matched pairs are emphasis, a lone opener stays text.
    expect(parseInline("*a* b *c")).toEqual([{ t: "em", c: [{ t: "text", v: "a" }] }, { t: "text", v: " b *c" }]);
    expect(parseInline("**bold** and *it* and `code` and [Inbox](/app/inbox)")).toEqual([
      { t: "strong", c: [{ t: "text", v: "bold" }] },
      { t: "text", v: " and " },
      { t: "em", c: [{ t: "text", v: "it" }] },
      { t: "text", v: " and " },
      { t: "code", v: "code" },
      { t: "text", v: " and " },
      { t: "link", path: "/app/inbox", c: [{ t: "text", v: "Inbox" }] },
    ]);
    expect(parseInline("[a [b](/app/x)")).toEqual([{ t: "text", v: "[a " }, { t: "link", path: "/app/x", c: [{ t: "text", v: "b" }] }]);
  });

  it("each message carries lang hi, hi-Latn or en; Devanagari renders at 16 px with line-height 1.6", () => {
    const hi = html(h(SafeMarkdown, { text: "आपका **टेम्पलेट** अप्रूव हो गया।", lang: "hi" }));
    expect(hi).toMatch(/^<div lang="hi" dir="auto" class="[^"]*text-base leading-\[1\.6\]/);
    expect(html(h(SafeMarkdown, { text: "Aapka template approve ho gaya.", lang: "hinglish" }))).toMatch(/^<div lang="hi-Latn"/);
    const en = html(h(SafeMarkdown, { text: "Your template was approved.", lang: "en" }));
    expect(en).toMatch(/^<div lang="en"/);
    expect(en).toContain("text-sm");
    expect(markdownPlainText("**Hi** there\n\n- one\n- two")).toBe("Hi there one; two");
  });
});

describe("status chips, undo bars and progress steps", () => {
  it.each(EDDY_LANGS)("every Eddy state and card state has a labelled chip in %s, in light and dark", (lang) => {
    for (const state of [...EDDY_AVAILABILITY_ORDER, "working"] as EddyChipState[]) {
      const markup = inBothThemes(h(EddyStatusChip, { lang, state }));
      expect(markup).toContain(esc(eddyChip(lang, state).label));
    }
    for (const s of ALL_STATES) {
      const markup = inBothThemes(h(CardStatusChip, { lang, state: s.view.state }));
      expect(markup).toContain(esc(cardChip(lang, s.view.state).label));
      expect(markup).toMatch(/rounded-full border/);
    }
    expect(html(h(EddyStatusChip, { lang, state: "ready", live: true }))).toContain('role="status" aria-live="polite"');
  });

  it("the undo bar offers Undo until undoUntil, then turns into plain text", () => {
    const until = iso(NOW + 10 * 60_000);
    const open = inBothThemes(h(ResultRow, { lang: "en", summaryKey: "done.tag", vars: { name: "Riya", tag: "vip" }, undoUntil: until, now: NOW, onUndo: noop }));
    expect(open).toContain("Done. I tagged Riya as vip.");
    expect(open).toContain("data-eddy-undo-bar");
    expect(open).toContain('aria-label="Undo: Done. I tagged Riya as vip."');
    expect(open).toContain(">Undo</button>");
    expect(open).toContain("Undo is available until");
    const closed = html(h(ResultRow, { lang: "en", summaryKey: "done.tag", vars: { name: "Riya", tag: "vip" }, undoUntil: until, now: NOW + 10 * 60_000 }));
    expect(closed).not.toContain("data-eddy-undo-bar");
    expect(closed).toContain("Done. I tagged Riya as vip.");
    expect(undoAvailable(until, NOW)).toBe(true);
    expect(undoAvailable(until, NOW + 10 * 60_000)).toBe(false);
    expect(undoAvailable(null, NOW)).toBe(false);
  });

  const ROW_STATES: [ResultRowState, string][] = [
    ["undone", "Undone."],
    ["conflict", "Someone changed it since, so it was not undone."],
    ["undo_expired", "Undo is no longer available for this action."],
    ["undo_failed", "This couldn&#x27;t be undone."],
    ["needs_card", "Undoing this would message customers or spend, so it needs its own preview."],
    ["undoing", "Undoing…"],
  ];
  it.each(ROW_STATES)("the result row in state %s says so in a polite status line", (state, text) => {
    const markup = inBothThemes(h(ResultRow, { lang: "en", summaryKey: "done.pause_broadcast", undoUntil: iso(NOW + 60_000), now: NOW, state, onUndo: noop }));
    expect(markup).toContain(`data-eddy-result="${state}"`);
    expect(markup).toMatch(new RegExp(`role="status" aria-live="polite" aria-atomic="true" class="[^"]*">${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`));
  });

  it("an unknown summary key never shows the raw key", () => {
    expect(html(h(ResultRow, { lang: "hi", summaryKey: "done.not_a_key", now: NOW }))).toContain("हो गया");
  });

  it.each(EDDY_LANGS)("progress steps show each step's state in words, with aria-current on the current step (%s)", (lang) => {
    const steps: ProgressStep[] = [
      { id: "connect", label: "Connect WhatsApp", state: "done" },
      { id: "template", label: "First template", state: "current", detail: "About 5 min" },
      { id: "broadcast", label: "First broadcast", state: "todo" },
      { id: "retry", label: "Invite your team", state: "failed" },
    ];
    const markup = inBothThemes(h(ProgressSteps, { steps, lang }));
    expect(markup).toMatch(/^<ol aria-label="[^"]+"/);
    expect(count(markup, 'aria-current="step"')).toBe(1);
    for (const s of ["done", "current", "todo", "failed"] as const) expect(markup).toContain(esc(t(lang, `step.${s}`)));
    expect(markup).toContain('data-step-state="failed"');
    expect(html(h(ProgressSteps, { steps: [], lang }))).toBe("");
  });
});

describe("action cards, Meta links and the Turn on Eddy card", () => {
  it("renders a button row and navigate chips; chips accept only /app paths", () => {
    const markup = inBothThemes(
      h(ActionCard, {
        lang: "en",
        title: "Connect WhatsApp",
        body: "Takes **about 5 minutes**.",
        chip: { tone: "warn", label: "Needs you" },
        buttons: [{ id: "go", label: "Connect WhatsApp", variant: "primary", onClick: noop }, { id: "later", label: "Not now" }],
        chips: [{ path: "/app/settings/connect?from=eddy", label: "Open settings" }, { path: "https://business.facebook.com", label: "Meta" }, { path: "/api/x", label: "API" }],
      }),
    );
    expect(markup).toMatch(/role="group" aria-labelledby="[^"]+"/);
    expect(markup).toContain("<strong");
    expect(count(markup, "<button")).toBe(2);
    expect(count(markup, "data-eddy-nav-chip")).toBe(1);
    expect(markup).not.toContain("facebook");
    expect(safeChips([{ path: "/app", label: "Home" }, { path: "//x.y/app", label: "x" }, { path: "javascript:alert(1)", label: "j" }])).toEqual([{ path: "/app", label: "Home" }]);
    expect(html(h(NavChips, { chips: [] }))).toBe("");
  });

  it("shows an 'Opens Meta' link only for a server-provided link to a screen Meta offers no API for", () => {
    const link = { screen: "payment_method", url: "https://meta.example/billing" };
    const markup = inBothThemes(h(ActionCard, { lang: "en", title: "Payment problem", metaLink: link }));
    expect(markup).toContain("Opens Meta");
    expect(markup).toContain("Add a payment method");
    expect(markup).toContain('target="_blank" rel="noopener noreferrer external"');
    expect(markup).toContain('aria-label="Add a payment method (Opens Meta)"');
    expect(html(h(ActionCard, { lang: "en", title: "No link" }))).not.toContain("Opens Meta");
    for (const bad of [{ screen: "ads_manager", url: "https://meta.example/x" }, { screen: "payment_method", url: "javascript:alert(1)" }, { screen: "payment_method", url: "http://meta.example/x" }, { screen: "payment_method", url: "https://u:p@meta.example/" }, "https://meta.example", null]) {
      expect(safeMetaLink(bad)).toBeNull();
      expect(html(h(MetaLinkButton, { link: bad, lang: "en" }))).toBe("");
    }
    expect(html(h(MetaLinkButton, { link: { screen: "business_verification", url: "https://meta.example/v" }, lang: "hi" }))).toContain(esc(t("hi", "link.opens_meta")));
  });

  it("the Turn on Eddy card says what Eddy does and what it costs; only the owner gets the switch (decision 6)", () => {
    const owner = inBothThemes(h(TurnOnEddyCard, { lang: "en", isOwner: true, ownerNames: ["Omar"], perTurn: 30, perDay: 40, onTurnOn: noop, onNotNow: noop }));
    expect(owner).toContain("Turn on Eddy");
    expect(owner).toContain("AI credits");
    expect(owner).toContain("30 credits");
    expect(owner).toContain("40 credits");
    expect(owner).toContain(">Turn on Eddy</button>");
    const agent = html(h(TurnOnEddyCard, { lang: "en", isOwner: false, ownerNames: ["Omar"], perTurn: 30, perDay: 40 }));
    expect(agent).toContain("Only the owner can turn on Eddy. Ask the owner: Omar.");
    expect(agent).not.toContain("<button");
    const ownerNoTap = html(h(TurnOnEddyCard, { lang: "hinglish", isOwner: true, ownerNames: [], perTurn: 30, perDay: 40 }));
    // Integration fix (wave 4): the Eddy switch lives on Settings > AI tools (P13's EddySettingsCard, #eddy); there is no
    // /app/settings/eddy page, so the old default link was a 404.
    expect(ownerNoTap).toContain('href="/app/settings/ai-tools#eddy"');
  });
});

describe("MessageView: every transcript item", () => {
  const items: TranscriptItem[] = [
    { kind: "member", id: "1", text: "मेरा template approve हुआ?", lang: "hi" },
    { kind: "eddy", id: "2", text: "Haan, **approve** ho gaya.", lang: "hinglish" },
    { kind: "eddy", id: "2b", text: "", lang: "en", streaming: true },
    { kind: "activity", id: "3", key: "status.list_templates", lang: "en" },
    { kind: "card", id: "4", card: card(), lang: "en" },
    { kind: "done", id: "5", actionId: "ar_2", summaryKey: "done.tag", vars: { name: "Riya", tag: "vip" }, undoUntil: iso(Date.now() + 60_000), lang: "en" },
    { kind: "refused", id: "6", action: "delete_template", code: "role", who: ["Priya", "Omar"], lang: "en" },
    { kind: "chips", id: "7", lang: "en", starters: [{ label: "What needs my attention?", query: "What needs my attention?" }], chips: [{ path: "/app/inbox", label: "Go to Inbox" }] },
    { kind: "steps", id: "8", lang: "en", title: "Setup", steps: [{ id: "a", label: "Connect", state: "current" }] },
    { kind: "quote", id: "9", text: u("customer_message", "<b>hello</b>"), lang: "en" },
    { kind: "action", id: "10", lang: "en", title: "Next step", body: "Pick a **template**." },
    { kind: "error", id: "11", lang: "en", state: "service_down" },
  ];

  it.each(items.map((i) => [i.kind + i.id, i] as const))("%s renders in light and dark", (_k, item) => {
    const markup = inBothThemes(h(MessageView, { item, onNavigate: noop, onStarter: noop }));
    expect(markup).toContain(`data-eddy-item="${item.kind}"`);
  });

  it("puts the member on the right and Eddy on the left with the avatar, each message with its lang", () => {
    const member = html(h(MessageView, { item: items[0] }));
    expect(member).toContain("justify-end");
    expect(member).toContain('lang="hi"');
    expect(member).toContain("bg-accent-soft");
    expect(member).toContain("text-accent-ink");
    const eddy = html(h(MessageView, { item: items[1] }));
    expect(eddy).toContain('lang="hi-Latn"');
    expect(eddy).toContain("bg-surface-2");
    expect(eddy).toContain("data-eddy-avatar");
    expect(eddy).toContain("Nirmala UI");
    expect(html(h(MessageView, { item: items[2] }))).toContain("Working…");
    expect(html(h(MessageView, { item: items[3] }))).toContain("Checking your templates…");
    expect(html(h(MessageView, { item: items[6] }))).toContain("Only Priya, Omar can do this.");
    expect(html(h(MessageView, { item: items[11] }))).toContain("Can&#x27;t reach the AI service right now.");
  });

  it("the off and error states have copy in every language", () => {
    for (const lang of EDDY_LANGS) {
      for (const state of ["service_down", "busy", "turn_in_progress", "rate_limited", "message_too_long", "truncated", "refusal_pause", "internal", "platform_off", "locked", "workspace_off", "paused", "allowance_used", "user_capped"] as const) {
        const text = errorText(lang, state, { names: "Omar", date: "1 Nov" });
        expect(text.length, `${lang} ${state}`).toBeGreaterThan(5);
        expect(text).not.toMatch(/\{[a-z]/);
      }
    }
    expect(errorText("en", "platform_off", { reason: "paused" })).toBe(t("en", "off.platform_paused"));
    expect(errorText("en", "allowance_used", { need: 12, left: 4 })).toBe("This needs about 12 AI credits; 4 are left this month.");
  });
});

describe("the avatar", () => {
  it("draws on var(--accent) at 20, 28 and 56 px; off uses var(--surface) and var(--muted)", () => {
    for (const [size, px] of [["launcher", 20], ["gutter", 28], ["hero", 56]] as const) {
      const markup = inBothThemes(h(EddyAvatar, { size }));
      expect(markup).toContain(`width="${px}"`);
      expect(markup).toContain('fill="var(--accent)"');
      expect(markup).toContain('aria-hidden="true"');
    }
    const off = inBothThemes(h(EddyAvatar, { state: "off", label: "Eddy is off" }));
    expect(off).toContain('fill="var(--surface)"');
    expect(off).toContain('stroke="var(--muted)"');
    expect(off).toContain('role="img" aria-label="Eddy is off"');
    expect(inBothThemes(h(EddyAvatar, { state: "needs_action" }))).toContain("background:var(--bad)");
    expect(inBothThemes(h(EddyAvatar, { state: "working" }))).toContain("motion-safe:");
  });
});

describe("window events (EDDY-13 acceptance 6)", () => {
  it("defines wa:eddy-draft, wa:eddy-open-templates, wa:eddy-did, wa:eddy-selection and wa:eddy-open", () => {
    expect(Object.values(EDDY_EVENTS).sort()).toEqual(["wa:eddy-did", "wa:eddy-draft", "wa:eddy-open", "wa:eddy-open-templates", "wa:eddy-selection"]);
  });

  it("checks every detail; a malformed one is never dispatched or delivered", () => {
    expect(checkDetail("wa:eddy-draft", { conversationId: "cv1", text: "Hi" })).toEqual({ conversationId: "cv1", text: "Hi" });
    expect(checkDetail("wa:eddy-draft", { conversationId: "../x", text: "Hi" })).toBeUndefined();
    expect(checkDetail("wa:eddy-draft", { conversationId: "cv1", text: "Hi", send: true })).toBeUndefined();
    expect(checkDetail("wa:eddy-open-templates", { conversationId: "cv1" })).toEqual({ conversationId: "cv1" });
    expect(checkDetail("wa:eddy-did", { entity: "contact", ids: ["k1", "k1", "k2"] })).toEqual({ entity: "contact", ids: ["k1", "k2"] });
    expect(checkDetail("wa:eddy-did", { entity: "nuke", ids: [] })).toBeUndefined();
    expect(checkDetail("wa:eddy-selection", null)).toBeNull();
    expect(checkDetail("wa:eddy-selection", { type: "lead", id: "l1" })).toEqual({ type: "lead", id: "l1" });
    expect(checkDetail("wa:eddy-selection", { type: "lead", id: "l 1" })).toBeUndefined();
    expect(checkDetail("wa:eddy-open", { query: "  hi  " })).toEqual({ query: "hi" });
    expect(checkDetail("wa:eddy-open", { ref: { kind: "notice", noticeId: "n1" } })).toEqual({ ref: { kind: "notice", noticeId: "n1" } });
    // A reference carries ids only, never text (6.7).
    expect(checkDetail("wa:eddy-open", { ref: { kind: "notice", noticeId: "n1", text: "rejected because…" } })).toBeUndefined();
    expect(checkDetail("wa:eddy-open", { query: "x".repeat(2001) })).toBeUndefined();
  });

  it("dispatches and listens on a target, and drops malformed events", () => {
    const target = new EventTarget();
    const seen = vi.fn();
    const off = onEddyEvent("wa:eddy-did", seen, target);
    expect(announceEddyDid("conversation", ["cv1"], target)).toBe(true);
    target.dispatchEvent(new CustomEvent("wa:eddy-did", { detail: { entity: "conversation", ids: ["<bad>"] } }));
    expect(dispatchEddyEvent("wa:eddy-did", { entity: "nope" as "contact", ids: [] }, target)).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ entity: "conversation", ids: ["cv1"] });
    off();
    announceEddyDid("conversation", ["cv2"], target);
    expect(seen).toHaveBeenCalledTimes(1);
    const opened = vi.fn();
    onEddyEvent("wa:eddy-open", opened, target);
    expect(openEddy({ ref: { kind: "message", messageId: "msg1" } }, target)).toBe(true);
    expect(opened).toHaveBeenCalledWith({ ref: { kind: "message", messageId: "msg1" } });
    expect(openEddy({}, null)).toBe(false);
  });
});

describe("tokens only: a grep over src/components/eddy (6.13)", () => {
  const DIR = path.resolve(__dirname, "../src/components/eddy");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : [path.join(dir, f)]));
  const files = walk(DIR).filter((f) => /\.(tsx?|css)$/.test(f));

  it("finds the package's component files", () => {
    const names = files.map((f) => path.basename(f));
    for (const f of ["SafeMarkdown.tsx", "CustomerQuote.tsx", "PreviewCard.tsx", "ActionCard.tsx", "ResultRow.tsx", "StatusChip.tsx", "ProgressSteps.tsx", "MessageView.tsx", "EddyAvatar.tsx", "events.ts"]) expect(names).toContain(f);
  });

  it.each(files.map((f) => [path.relative(DIR, f), f] as const))("%s has no dark: variant, raw hex, raw z-index, inner HTML or Meta host", (_name, file) => {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(/\bdark:/);
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(src).not.toMatch(/\bz-(\d+|\[)/);
    expect(src).not.toMatch(/zIndex/);
    expect(src).not.toContain("dangerouslySetInnerHTML");
    expect(src).not.toMatch(/facebook\.com|business\.facebook|meta\.com|fb\.me/i);
  });

  it("the grep itself catches what it bans", () => {
    expect("dark:bg-black").toMatch(/\bdark:/);
    expect("color: #0f172a".match(/#[0-9a-fA-F]{3,8}\b/g)).toEqual(["#0f172a"]);
    expect("z-50").toMatch(/\bz-(\d+|\[)/);
    expect("z-[60]").toMatch(/\bz-(\d+|\[)/);
    expect("z-(--z-overlay)").not.toMatch(/\bz-(\d+|\[)/);
    expect(themeProblems('<p class="bg-red-500 dark:text-white text-good-fg"></p>')).toEqual(["palette colour bg-red-500", "dark variant dark:text-white", "palette colour dark:text-white"]);
  });
});

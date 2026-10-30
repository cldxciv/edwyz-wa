/**
 * The per-turn context note (docs/EDDY-SPEC.md 5.6, 7.2 item 9, 9.1 cases 2, 15 and 20).
 *
 * Each member message is appended as a `user` turn followed by one mid-conversation `{role:'system'}` message:
 *
 *   <eddy_context>
 *   reply_language: hinglish   reply_script: Latin   (Hindi grammar in Roman script; ...)
 *   member: { firstName: "Anshuman", role: "owner", emailVerified: true }
 *   page: { id: "broadcasts.detail", broadcastId: "b_9", status: "draft" }
 *   setup: { percent: 67, nextStepId: "broadcast" }
 *   spending: { freeze: "none", eddySpend: "off" }
 *   recent_notices: [{ kind: "template_approved", ref: "t_31" }]
 *   card_outcomes: [{ cardRef: "a_77", action: "send_text_reply", outcome: "done" }]
 *   time: 28 Oct 2026, 2:05 pm IST
 *   eddy: { phase: 1, autonomy: 0 }
 *   </eddy_context>
 *
 * Server-trusted facts only: ids, statuses, codes and labels from code, each checked against a strict shape here. It never
 * carries contact names, message text, tag names or anything else a customer or teammate wrote; those reach the model only
 * inside tool results as UntrustedText. Page ids come from the browser and are verified (verifyPageContext) before they get
 * here; whatever the member may not see is dropped silently. Card taps arrive through card_outcomes, never as fake user text.
 *
 * Notes are never deleted (that would edit history). When a turn hits a limit a second note (the wrap-up note) follows the
 * tool results, and the final round runs with tool_choice none.
 */
import type { Actor } from "@/lib/actions";
import type { EddyLang, PageContext, VerifiedPageContext } from "./contract";
import { replyScript } from "./language";
import type { EddyMessageParam } from "./request";

export const WRAPUP_NOTE = "Tool limit for this turn reached. Briefly tell the member what is done, what waits on a card, and what is left.";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_ID = /^[a-z][a-z0-9_.-]{0,63}$/i;
const CODE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const ACTION = /^[a-z][a-z0-9_]{2,63}$/;

const LANGUAGE_GUIDE: Readonly<Record<EddyLang, string>> = {
  en: "(plain Indian-English business register; short words, no idioms)",
  hi: "(everyday spoken Hindi in Devanagari, not Sanskritised; product words in Devanagari; keep template names, ids, numbers and amounts exactly as tools return them; aap forms; gender-neutral self-reference)",
  hinglish: "(Hindi grammar in Roman script; keep template/broadcast/chat in English; aap forms; gender-neutral self-reference; no Devanagari)",
};

/** The line Eddy starts with when the member wrote in a language it does not answer in (5.7 rule 6, catalogue lang.unsupported). */
export const UNSUPPORTED_LINE = "Replies are in English, Hindi or Hinglish, so this one is in English.";

export type CardOutcomeFact = { cardRef: string; action: string; outcome: string };
export type NoticeFact = { kind: string; ref: string | null };

export type ContextFacts = {
  lang: EddyLang;
  unsupported?: boolean;
  member: { firstName: string | null; role: Actor["role"]; emailVerified: boolean; readOnly?: boolean };
  page: VerifiedPageContext | null;
  /** The status the page check read for the page's subject (a broadcast's "draft"), when there is one. */
  pageStatus?: string | null;
  setup: { percent: number; nextStepId: string | null } | null;
  spending: { freeze: "none" | "assistants" | "all"; eddySpend: "off" | "on" };
  recentNotices: readonly NoticeFact[];
  cardOutcomes: readonly CardOutcomeFact[];
  now: Date;
  timezone: string;
  phase: 1 | 2;
  /** The first turn of the conversation: Eddy introduces itself once, using the first name only here (2.2). */
  firstTurn: boolean;
  /**
   * What a notice's [Fix with Eddy] or a failed bubble's [Explain] points at (6.7, 7.2 item 9): an id only. Eddy fetches the
   * text itself with a tool, so it arrives as UntrustedText and never as if the member had typed it.
   */
  focus?: TurnRef | null;
};

/** A server-trusted reference a button puts into a turn: ids only. */
export type TurnRef = { kind: "notice"; noticeId: string } | { kind: "message"; messageId: string };

/** Parses the `ref` of a turn request; anything but an id-only reference is dropped. */
export function parseTurnRef(raw: unknown): TurnRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "notice" && typeof r.noticeId === "string" && ID.test(r.noticeId)) return { kind: "notice", noticeId: r.noticeId };
  if (r.kind === "message" && typeof r.messageId === "string" && ID.test(r.messageId)) return { kind: "message", messageId: r.messageId };
  return null;
}

const CARD_OUTCOMES = new Set(["done", "failed", "cancelled", "expired", "superseded", "undone", "unknown", "awaiting_approval", "refused", "running"]);

/** A string literal for the note: JSON-quoted, so nothing in it can close the tag or start a line. */
const q = (s: string) => JSON.stringify(s);

/**
 * The member's first name, from User.name (trusted, 2.2), reduced to its first word of letters. Anything that is not a
 * plain name (digits, punctuation, markup) gives null, so the greeting simply leaves the name out.
 */
export function safeFirstName(name: string | null | undefined): string | null {
  const first = String(name ?? "").trim().split(/\s+/, 1)[0] ?? "";
  if (!first || first.length > 30) return null;
  return /^[\p{L}\p{M}][\p{L}\p{M}'’-]*$/u.test(first) ? first : null;
}

/** "28 Oct 2026, 2:05 pm IST" in the workspace time zone. */
export function formatNoteTime(at: Date, timeZone: string): string {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: tz });
  } catch {
    tz = "Asia/Kolkata";
  }
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const zone = tz === "Asia/Kolkata" ? "IST" : get("timeZoneName");
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()} ${zone}`.replace(/\s+/g, " ").trim();
}

function pageLine(page: VerifiedPageContext | null, status: string | null | undefined): string | null {
  if (!page || !PAGE_ID.test(page.id)) return null;
  const fields: string[] = [`id: ${q(page.id)}`];
  for (const key of ["conversationId", "contactId", "broadcastId", "templateId", "leadId"] as const) {
    const v = page[key];
    if (typeof v === "string" && ID.test(v)) fields.push(`${key}: ${q(v)}`);
  }
  if (page.selection && CODE.test(page.selection.type) && ID.test(page.selection.id)) fields.push(`selection: { type: ${q(page.selection.type)}, id: ${q(page.selection.id)} }`);
  if (typeof status === "string" && /^[a-z_]{1,32}$/.test(status)) fields.push(`status: ${q(status)}`);
  return `page: { ${fields.join(", ")} }`;
}

/** The note's text. Every value is checked against a strict shape; anything else is left out. */
export function buildContextNote(f: ContextFacts): string {
  const lines: string[] = ["<eddy_context>"];
  lines.push(`reply_language: ${f.lang}   reply_script: ${replyScript(f.lang)}   ${LANGUAGE_GUIDE[f.lang]}`);
  if (f.unsupported) lines.push(`reply_note: the member wrote in a language Eddy does not answer in. Start the reply with this line: ${q(UNSUPPORTED_LINE)}`);
  const firstName = f.firstTurn ? safeFirstName(f.member.firstName) : null;
  const member = [
    ...(firstName ? [`firstName: ${q(firstName)}`] : []),
    `role: ${q(f.member.role)}`,
    `emailVerified: ${f.member.emailVerified ? "true" : "false"}`,
    ...(f.member.readOnly ? ["readOnly: true"] : []),
  ];
  lines.push(`member: { ${member.join(", ")} }`);
  const page = pageLine(f.page, f.pageStatus);
  if (page) lines.push(page);
  if (f.focus?.kind === "notice" && ID.test(f.focus.noticeId)) lines.push(`focus: { kind: "notice", noticeId: ${q(f.focus.noticeId)} }`);
  if (f.focus?.kind === "message" && ID.test(f.focus.messageId)) lines.push(`focus: { kind: "message", messageId: ${q(f.focus.messageId)} }`);
  if (f.setup && Number.isFinite(f.setup.percent)) {
    const pct = Math.max(0, Math.min(100, Math.round(f.setup.percent)));
    const next = f.setup.nextStepId && /^[a-z_]{1,32}$/.test(f.setup.nextStepId) ? q(f.setup.nextStepId) : "null";
    lines.push(`setup: { percent: ${pct}, nextStepId: ${next} }`);
  }
  lines.push(`spending: { freeze: ${q(f.spending.freeze)}, eddySpend: ${q(f.spending.eddySpend)} }`);
  const notices = f.recentNotices.filter((n) => CODE.test(n.kind)).slice(0, 5);
  if (notices.length > 0) lines.push(`recent_notices: [${notices.map((n) => `{ kind: ${q(n.kind)}, ref: ${n.ref && ID.test(n.ref) ? q(n.ref) : "null"} }`).join(", ")}]`);
  const outcomes = f.cardOutcomes.filter((c) => ID.test(c.cardRef) && ACTION.test(c.action) && CARD_OUTCOMES.has(c.outcome)).slice(0, 10);
  if (outcomes.length > 0) lines.push(`card_outcomes: [${outcomes.map((c) => `{ cardRef: ${q(c.cardRef)}, action: ${q(c.action)}, outcome: ${q(c.outcome)} }`).join(", ")}]`);
  lines.push(`time: ${formatNoteTime(f.now, f.timezone)}`);
  lines.push(`eddy: { phase: ${f.phase}, autonomy: 0${f.firstTurn ? ", firstTurn: true" : ""} }`);
  lines.push("</eddy_context>");
  return lines.join("\n");
}

/** The note as a mid-conversation system message (no beta header on these models). */
export function contextNoteMessage(f: ContextFacts): EddyMessageParam {
  return { role: "system", content: buildContextNote(f) } as EddyMessageParam;
}

/** The second note of a turn that hit a limit (5.6), placed after the tool results. */
export function wrapUpMessage(): EddyMessageParam {
  return { role: "system", content: WRAPUP_NOTE } as EddyMessageParam;
}

// ===== Page context from the browser =====

/** Parses the `page` field of a turn request: ids only, each with the strict id shape; anything else is dropped. */
export function parsePageContext(raw: unknown): PageContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !PAGE_ID.test(r.id)) return null;
  const out: PageContext = { id: r.id };
  for (const key of ["conversationId", "contactId", "broadcastId", "templateId", "leadId"] as const) {
    const v = r[key];
    if (typeof v === "string" && ID.test(v)) out[key] = v;
  }
  const sel = r.selection as Record<string, unknown> | undefined;
  if (sel && typeof sel === "object" && typeof sel.type === "string" && typeof sel.id === "string" && CODE.test(sel.type) && ID.test(sel.id)) out.selection = { type: sel.type, id: sel.id };
  return out;
}

/** One check per kind of id: may this member see it? `status` is the subject's status, for the note (a broadcast's draft). */
export type PageCheckResult = { ok: boolean; status?: string | null };
export type PageChecks = {
  conversation(actor: Actor, id: string): Promise<PageCheckResult>;
  contact(actor: Actor, id: string): Promise<PageCheckResult>;
  broadcast(actor: Actor, id: string): Promise<PageCheckResult>;
  template(actor: Actor, id: string): Promise<PageCheckResult>;
  lead(actor: Actor, id: string): Promise<PageCheckResult>;
};

const SELECTION_KIND: Readonly<Record<string, keyof PageChecks>> = {
  conversation: "conversation",
  chat: "conversation",
  contact: "contact",
  broadcast: "broadcast",
  template: "template",
  lead: "lead",
};

/**
 * Keeps only the ids the member may see (5.6): runs the conversation and contact visibility checks and the ownership
 * checks, and silently drops anything that fails or throws. The page id itself is a label and stays.
 */
export async function verifyPageContext(actor: Actor, page: PageContext | null, checks: PageChecks): Promise<{ page: VerifiedPageContext | null; status: string | null }> {
  if (!page) return { page: null, status: null };
  const run = async (kind: keyof PageChecks, id: string): Promise<PageCheckResult> => {
    try {
      return await checks[kind](actor, id);
    } catch {
      return { ok: false };
    }
  };
  const out: PageContext = { id: page.id };
  let status: string | null = null;
  const pairs: [keyof PageContext & ("conversationId" | "contactId" | "broadcastId" | "templateId" | "leadId"), keyof PageChecks][] = [
    ["conversationId", "conversation"],
    ["contactId", "contact"],
    ["broadcastId", "broadcast"],
    ["templateId", "template"],
    ["leadId", "lead"],
  ];
  const results = await Promise.all(pairs.map(async ([key, kind]) => [key, page[key] ? await run(kind, page[key] as string) : null] as const));
  for (const [key, result] of results) {
    if (!result?.ok) continue;
    out[key] = page[key];
    if (!status && typeof result.status === "string") status = result.status;
  }
  if (page.selection) {
    const kind = SELECTION_KIND[page.selection.type];
    if (kind && (await run(kind, page.selection.id)).ok) out.selection = { ...page.selection };
  }
  return { page: { ...out, verified: true }, status };
}

"use client";

/**
 * Preview cards for confirm-class actions (docs/EDDY-SPEC.md 4.5, 6.5, 6.13, 6.14, 4.10a).
 *
 * Every word on a card comes from the server's Preview, rendered from the catalogue in the turn's language. The model
 * writes nothing on a card; the only exception is content it drafted (a reply, a template body), shown verbatim in a
 * WhatsApp-style bubble as exactly what will be sent. Names and other text people wrote arrive as UntrustedText and are
 * rendered as isolated plain text (<bdi>), never as markup.
 *
 * Anatomy: role="group" labelled by the verb title; facts; recipients (masked as the server sent them); the message
 * bubble; the cost line in Phase 0's words (free / about / not available yet / worst case); warnings, each with an icon
 * and text; buttons: the specific verb, then [Edit] when there are editable fields, then [Cancel]. Danger cards use the
 * danger variant and put focus on Cancel first. Confirm stays aria-disabled for 600 ms after the card appears, and a tap
 * in that time is not silent: the card's status line reads "Check the preview first" once. There is no "Confirm all".
 * On phones the primary is full width with Edit and Cancel on one row below it. Footer: "Expires in 14 min", updated each
 * minute and not announced.
 *
 * States after a tap follow the 6.5 table: running, done, failed, changed, expired (with Refresh preview, no AI), cancelled,
 * unknown, needs_approver, awaiting_approval, spend_frozen, spend_not_set_up, spend refusals, demo, not_connected and
 * reconnect. CardController calls the card endpoints (/api/actions/[id]/confirm, cancel, revise, refresh); only a human
 * tap ever reaches them.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, cn, Input, Select, Textarea } from "@/components/ui";
import type { CostLine, Preview, UntrustedText, Warning } from "@/lib/actions/types";
import { CARD_CONFIRM_GUARD_MS, safeAppPath, type CardState, type PendingCardDTO } from "@/lib/eddy/contract";
import { hasKey, htmlLang, isSpendCode, spendMessage, t, templateParts, translateKey, type EddyLang, type SpendVars, type Vars } from "@/lib/eddy/i18n";
import { NavChips, type NavChip } from "./ActionCard";
import { cutGraphemes, untrustedPlain } from "./CustomerQuote";
import { cardTextClass } from "./SafeMarkdown";
import { CardStatusChip, type CardChipState } from "./StatusChip";

// ===== Pure helpers (exported for tests and for the transcript's status region) =====

export const CONNECT_PATH = "/app/settings/connect?from=eddy";
export const RECONNECT_PATH = "/app/settings/connect?from=eddy&reconnect=1";
export const SPENDING_PATH = "/app/settings/spending";

const isUntrusted = (v: unknown): v is UntrustedText => !!v && typeof v === "object" && typeof (v as UntrustedText).$untrusted === "string" && typeof (v as UntrustedText).text === "string";

/** Preview vars as plain strings (UntrustedText becomes its text, cut at 80 graphemes). */
export function plainVars(vars: Preview["vars"] | undefined): Vars {
  const out: Vars = {};
  for (const [k, v] of Object.entries(vars ?? {})) out[k] = isUntrusted(v) ? cutGraphemes(v.text, 80) : typeof v === "number" || typeof v === "string" ? v : "";
  return out;
}

/** The catalogue key of a card's title: the preview's, else the action's, else the generic "Preview". */
function titleKeyOf(card: Pick<PendingCardDTO, "preview" | "action">): string {
  return hasKey(card.preview.titleKey) ? card.preview.titleKey : hasKey(`card.${card.action}.title`) ? `card.${card.action}.title` : "card.preview";
}

/** The card's title as plain text (for labels and announcements): `code` marks around a name are dropped. */
export function cardTitle(lang: EddyLang, card: Pick<PendingCardDTO, "preview" | "action">): string {
  return translateKey(lang, titleKeyOf(card), plainVars(card.preview.vars)).replace(/`([^`\n]*)`/g, "$1");
}

/** The specific verb of the primary button. */
export function confirmLabel(lang: EddyLang, card: Pick<PendingCardDTO, "preview" | "action">): string {
  const vars = plainVars(card.preview.vars);
  if (hasKey(card.preview.confirmLabelKey)) return translateKey(lang, card.preview.confirmLabelKey, vars);
  if (hasKey(`card.${card.action}.confirm`)) return translateKey(lang, `card.${card.action}.confirm`, vars);
  return t(lang, "btn.send");
}

/**
 * The full sentence of the primary: the title without its question mark. The button's accessible name stays its visible
 * label ("Send reply", WCAG 2.5.3 Label in Name, so "tap Send reply" works by voice); the title describes it
 * (aria-describedby), so a screen reader hears "Send reply, Send this reply to Ramesh?".
 */
export function confirmSentence(lang: EddyLang, card: Pick<PendingCardDTO, "preview" | "action">): string {
  return cardTitle(lang, card).replace(/[?？]\s*$/u, "").trim();
}

/**
 * The cost line in Phase 0's words (6.5): free, "About {amount}", "Not available yet", or the v2 worst case "Could add up
 * to {amount} this month (worst case)" followed by "{left} left" when the pot has a limit (the server's formatted
 * `left`, from the preview's vars). Eddy never computes an amount itself.
 */
export function costText(lang: EddyLang, cost: CostLine | undefined, left?: string | null): string {
  if (!cost) return t(lang, "cost.unknown");
  if (cost.state === "free") return t(lang, cost.reason === "service_window" ? "cost.free_window" : "cost.free_internal");
  if (cost.state === "unknown") return t(lang, "cost.unknown");
  const amount = cost.formatted;
  if (cost.worstCase) {
    const worst = t(lang, "cost.worst_case", { amount });
    return typeof left === "string" && left.trim() ? `${worst} · ${t(lang, "cost.left", { left: left.trim() })}` : worst;
  }
  return t(lang, cost.partial ? "cost.estimate_partial" : "cost.estimate", { amount });
}

/** The pot's formatted `left` the server put in the preview's vars for a worst-case line, if any. */
export function costLeftOf(preview: Pick<Preview, "vars">): string | null {
  const v = preview.vars?.left;
  return typeof v === "string" && v.length > 0 && v.length <= 40 ? v : null;
}

/** A warning's text; the window warning uses vars.windowMinutes when the server sent it. */
export function warningText(lang: EddyLang, w: Warning, vars: Vars = {}): string {
  if (w === "window_closes_soon") {
    const n = vars.windowMinutes;
    return n !== undefined && n !== null && String(n) !== "" ? t(lang, "warn.window_closes_soon", { n }) : t(lang, "warn.window_closes_soon_generic");
  }
  const key = `warn.${w}`;
  return hasKey(key) ? translateKey(lang, key) : t(lang, "warn.irreversible");
}

/** Delete and irreversible cards use the danger variant (6.5). */
export function isDangerCard(preview: Pick<Preview, "danger" | "warnings">): boolean {
  return Boolean(preview.danger) || (preview.warnings ?? []).includes("irreversible");
}

/** Where focus goes when a card appears: Cancel first on a pending danger card (6.5); otherwise focus stays where it was. */
export function initialFocusTarget(preview: Pick<Preview, "danger" | "warnings">, state: CardChipState): "cancel" | null {
  return isDangerCard(preview) && state === "pending" ? "cancel" : null;
}

/** Confirm becomes active `guardMs` after the card appears (6.5). */
export function confirmArmed(shownAt: number, now: number, guardMs: number = CARD_CONFIRM_GUARD_MS): boolean {
  return now - shownAt >= Math.max(0, guardMs);
}

/** What a tap on Confirm does: run it, or (inside the guard) announce "Check the preview first" once per card. */
export function guardTap(armed: boolean, alreadyAnnounced: boolean): { run: boolean; announce: boolean } {
  if (armed) return { run: true, announce: false };
  return { run: false, announce: !alreadyAnnounced };
}

/** "Expires in 14 min", or "Expires in less than a minute"; null once expired. */
export function expiresLabel(lang: EddyLang, expiresAt: string, now: number): string | null {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left) || left <= 0) return null;
  const min = Math.floor(left / 60_000);
  return min >= 1 ? t(lang, "card.expires_in", { min }) : t(lang, "card.expires_soon");
}

/** The polite announcement for a new card (6.3): "Preview ready: send this reply to Ramesh. Send reply or cancel." */
export function cardAnnouncement(lang: EddyLang, card: Pick<PendingCardDTO, "preview" | "action">): string {
  return t(lang, "card.preview_ready", { title: confirmSentence(lang, card), confirm: confirmLabel(lang, card) });
}

/** What a card shows besides its preview: the state and the details the state needs. */
export type CardView = {
  state: CardChipState;
  /** A refusal or spend code (refuse.<code> or a Phase 0 spend code). */
  code?: string;
  /** The server's own sentence, used when the catalogue has nothing for the code. */
  message?: string;
  /** needs_approver: who may confirm; not_connected: the admins to ask. */
  names?: string[];
  /** awaiting_approval {approver, time}, changed {count, cost}, spend refusals (SpendVars). */
  params?: Record<string, string | number>;
  /** done: a link to the object; failed: the fix; needs_approver: the page to do it by hand. */
  path?: string;
  costLower?: boolean;
  /** A line shown above a replacement card (409 changed). */
  notice?: string;
};

export function viewFromCard(card: Pick<PendingCardDTO, "state" | "stateDetail">): CardView {
  const d = card.stateDetail ?? {};
  return { state: card.state, ...(d.code ? { code: d.code } : {}), ...(d.params ? { params: d.params } : {}), ...(d.names ? { names: d.names } : {}) };
}

/** The JSON a card endpoint answers (src/lib/actions/invoke.ts CardOutcome). */
export type CardOutcomeJson = {
  status?: number;
  state?: string;
  code?: string;
  message?: string;
  card?: PendingCardDTO;
  who?: string[];
  note?: string;
  error?: string;
  undoUntil?: string;
};

const CARD_STATES: readonly string[] = ["pending", "running", "done", "failed", "changed", "expired", "cancelled", "unknown", "needs_approver", "awaiting_approval", "spend_frozen", "spend_not_set_up", "spend_refused", "demo", "not_connected", "reconnect", "undone", "refused"];

/** Maps an endpoint answer to what the card shows. A spend code from Phase 0 becomes spend_refused with its copy. */
export function viewFromOutcome(o: CardOutcomeJson | null | undefined): CardView {
  if (!o || typeof o !== "object") return { state: "failed", code: "internal" };
  const state = typeof o.state === "string" && CARD_STATES.includes(o.state) ? (o.state as CardChipState) : "failed";
  const base: CardView = { state, ...(o.code ? { code: o.code } : {}), ...(o.message ? { message: o.message } : o.error ? { message: o.error } : {}), ...(o.who?.length ? { names: o.who } : {}) };
  if (state === "done" && o.note === "cost_lower") base.costLower = true;
  if ((state === "refused" || state === "failed") && isSpendCode(o.code)) base.state = o.code === "spend.frozen" || o.code === "spend.platform_frozen" ? "spend_frozen" : o.code === "spend.no_limit" ? "spend_not_set_up" : "spend_refused";
  if (state === "pending" && o.status === 409 && o.code === "not_expired") base.state = "pending";
  return base;
}

/**
 * The catalogue key for a refusal or failure code from the action layer (invoke.ts ACTION_COPY, the card routes), so a card
 * always speaks the member's language. Null for a code the catalogue does not know.
 */
const CODE_KEYS: Readonly<Record<string, string>> = {
  expired: "card.expired",
  changed: "card.changed",
  outcome_unknown: "card.unknown",
  undo_expired: "undo.expired",
  undo_changed: "undo.conflict",
  demo: "demo.refused",
  reconnect: "card.reconnect",
  not_connected: "not_connected.admin",
  not_connected_agent: "not_connected.agent",
  needs_approver: "card.needs_approver",
  invalid_args: "refuse.invalid",
  failed: "card.failed.generic",
  error: "refuse.internal",
};

export function refusalKey(code: string | null | undefined, names: readonly string[] = []): string | null {
  if (typeof code !== "string" || !code) return null;
  if (code === "role" && names.length > 0) return "refuse.role_who";
  if (code === "not_connected" && names.length > 0) return "not_connected.agent";
  const mapped = CODE_KEYS[code];
  if (mapped && hasKey(mapped)) return mapped;
  return hasKey(`refuse.${code}`) ? `refuse.${code}` : null;
}

/** A refusal or failure in the member's language; a Phase 0 spend code renders Phase 0's copy. */
export function refusalText(lang: EddyLang, code: string | null | undefined, opts: { names?: readonly string[]; params?: Record<string, string | number> } = {}): string | null {
  if (isSpendCode(code)) return spendMessage(lang, code, (opts.params ?? {}) as SpendVars);
  if (code === "spend_frozen") return spendMessage(lang, "spend.frozen");
  const key = refusalKey(code, opts.names ?? []);
  return key ? translateKey(lang, key, { names: (opts.names ?? []).join(", ") || "—" }) : null;
}

/** The sentence for a non-pending state (6.5 table). */
export function stateMessage(lang: EddyLang, card: Pick<PendingCardDTO, "preview" | "action">, view: CardView): string | null {
  const vars = plainVars(card.preview.vars);
  // A route's own sentence (a failure) is more specific, so English shows it; other languages show the catalogue line.
  const byCode = (fallback: string, preferServer = false) => {
    if (preferServer && lang === "en" && view.message) return view.message;
    const text = refusalText(lang, view.code, { names: view.names, params: view.params });
    if (text) return text;
    return lang === "en" && view.message ? view.message : fallback;
  };
  switch (view.state) {
    case "pending":
      return null;
    case "running":
      return hasKey(`card.${card.action}.running`) ? translateKey(lang, `card.${card.action}.running`, vars) : t(lang, "card.running");
    case "done":
      return hasKey(`card.${card.action}.done`) ? translateKey(lang, `card.${card.action}.done`, vars) : t(lang, "card.done.generic");
    case "failed":
      return byCode(t(lang, "card.failed.generic"), true);
    case "refused":
      return byCode(t(lang, "card.failed.generic"));
    case "changed": {
      const p = view.params ?? {};
      return p.count !== undefined && p.cost !== undefined ? t(lang, "card.changed.detail", { count: p.count, cost: p.cost }) : t(lang, "card.changed");
    }
    case "expired":
      return t(lang, "card.expired");
    case "cancelled":
      return t(lang, "card.cancelled");
    case "unknown":
      return t(lang, "card.unknown");
    case "needs_approver":
      return t(lang, "card.needs_approver", { names: (view.names ?? []).join(", ") || "—" });
    case "awaiting_approval":
      return t(lang, "card.awaiting_approval", { approver: String(view.params?.approver ?? (view.names ?? []).join(", ")), time: String(view.params?.time ?? "") });
    case "spend_frozen":
      return spendMessage(lang, view.code === "spend.platform_frozen" || view.code === "platform_frozen" ? "spend.platform_frozen" : "spend.frozen");
    case "spend_not_set_up":
      return spendMessage(lang, "spend.no_limit");
    case "spend_refused":
      // Phase 0's own code renders Phase 0's copy; a refusal that only carries Phase 0's English sentence (code
      // spend_blocked) shows that sentence in English and the catalogue line in Hindi and Hinglish.
      if (isSpendCode(view.code)) return spendMessage(lang, view.code, (view.params ?? {}) as SpendVars);
      return lang === "en" && view.message ? view.message : t(lang, "refuse.spend_blocked");
    case "demo":
      return t(lang, "demo.refused");
    case "not_connected":
      return view.names?.length ? t(lang, "not_connected.agent", { names: view.names.join(", ") }) : t(lang, "not_connected.admin");
    case "reconnect":
      return t(lang, "card.reconnect");
    case "undone":
      return t(lang, "undo.done");
  }
}

/** States that still show the card's preview (facts, message, cost, warnings). */
const SHOWS_PREVIEW: ReadonlySet<CardChipState> = new Set(["pending", "running", "needs_approver", "awaiting_approval", "changed"]);
const TONE_FOR: Partial<Record<CardChipState, "warn" | "bad" | "good" | "neutral">> = {
  failed: "bad",
  refused: "bad",
  spend_frozen: "bad",
  spend_refused: "bad",
  done: "good",
  unknown: "warn",
  needs_approver: "warn",
  awaiting_approval: "warn",
  spend_not_set_up: "warn",
  not_connected: "warn",
  reconnect: "warn",
  changed: "warn",
};

// ===== Pieces =====

/** A value someone wrote: isolated plain text, never markup. */
function Untrusted({ value, className }: { value: UntrustedText | string; className?: string }) {
  return (
    <bdi className={cn("break-words", className)} data-untrusted={typeof value === "string" ? undefined : value.$untrusted}>
      {untrustedPlain(value)}
    </bdi>
  );
}

/**
 * The title with each variable as its own node (UntrustedText as isolated text). A variable the catalogue wraps in
 * backticks ("Delete template `{template}`?") renders as inline code without the backticks.
 */
function Title({ lang, card }: { lang: EddyLang; card: Pick<PendingCardDTO, "preview" | "action"> }) {
  const parts = templateParts(translateKey(lang, titleKeyOf(card)));
  const vars = card.preview.vars ?? {};
  const coded = new Set<number>();
  parts.forEach((part, i) => {
    const before = parts[i - 1];
    const after = parts[i + 1];
    if (part.kind === "var" && before?.kind === "text" && before.text.endsWith("`") && after?.kind === "text" && after.text.startsWith("`")) coded.add(i);
  });
  return (
    <>
      {parts.map((part, i) => {
        if (part.kind === "text") {
          let text = part.text;
          if (coded.has(i + 1)) text = text.slice(0, -1);
          if (coded.has(i - 1)) text = text.slice(1);
          return text ? <span key={i}>{text}</span> : null;
        }
        const v = vars[part.name];
        const node =
          v === undefined || v === null ? (
            <span>{`{${part.name}}`}</span>
          ) : isUntrusted(v) ? (
            <Untrusted value={{ ...v, text: cutGraphemes(v.text, 80) }} />
          ) : (
            <span>{String(v)}</span>
          );
        return coded.has(i) ? (
          <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[0.95em] font-medium">
            {node}
          </code>
        ) : (
          <span key={i}>{node}</span>
        );
      })}
    </>
  );
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" focusable="false">
      <path d="M8 1.8l6.6 11.7H1.4L8 1.8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6.2v3.4M8 11.6v.01" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Facts({ lang, preview }: { lang: EddyLang; preview: Preview }) {
  const rows: { label: string; value: ReactNode; mono?: boolean }[] = [];
  if (preview.recipients) {
    const { count, sample } = preview.recipients;
    const shown = sample.slice(0, 3);
    const rest = count - shown.length;
    rows.push({
      label: t(lang, "fact.to"),
      value: (
        <span className="flex flex-col gap-0.5">
          <span>{count === 1 ? t(lang, "recipients.one") : t(lang, "recipients.count", { count: count.toLocaleString("en-IN") })}</span>
          {shown.length > 0 && (
            <span className="text-xs text-muted">
              {shown.map((s, i) => (
                <span key={i}>
                  {i > 0 && ", "}
                  {s.name ? <Untrusted value={{ ...s.name, text: cutGraphemes(s.name.text, 40) }} /> : null}
                  {s.name ? " " : ""}
                  <span className="font-mono">{s.phoneMasked}</span>
                </span>
              ))}
              {rest > 0 && ` ${t(lang, "recipients.more", { count: rest.toLocaleString("en-IN") })}`}
            </span>
          )}
        </span>
      ),
    });
  }
  for (const f of preview.facts ?? []) {
    rows.push({ label: translateKey(lang, f.labelKey, {}, f.labelKey.replace(/^fact\./, "")), value: <Untrusted value={typeof f.value === "string" ? f.value : { ...f.value, text: cutGraphemes(f.value.text, 300) }} />, mono: f.mono });
  }
  if (rows.length === 0) return null;
  return (
    <dl className={cn("mt-3 grid grid-cols-[minmax(4.5rem,auto)_1fr] gap-x-3 gap-y-1.5", cardTextClass(lang))}>
      {rows.map((r, i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{r.label}</dt>
          <dd className={cn("m-0 min-w-0 break-words", r.mono && "font-mono text-xs")}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MessageBubble({ lang, message }: { lang: EddyLang; message: NonNullable<Preview["message"]> }) {
  return (
    <div className="mt-3" data-eddy-bubble>
      <p className="mb-1 text-xs font-medium text-muted">
        {t(lang, "message.label")}
        {message.templateName && (
          <>
            {" · "}
            <code className="rounded bg-surface-2 px-1 font-mono">{message.templateName}</code>
          </>
        )}
      </p>
      <div className={cn("max-w-full rounded-2xl rounded-tl-sm border border-border bg-accent-soft px-3 py-2 text-foreground shadow-raised", cardTextClass(lang, untrustedPlain(message.body)))}>
        <p className="m-0 whitespace-pre-wrap break-words" dir="auto">
          {untrustedPlain(message.body)}
        </p>
      </div>
    </div>
  );
}

function EditFields({ lang, preview, onSave, onClose }: { lang: EddyLang; preview: Preview; onSave: (edits: Record<string, string>) => void; onClose: () => void }) {
  const initial = (field: string) => (field === "text" || field === "body") && preview.message ? untrustedPlain(preview.message.body) : "";
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(preview.editable.map((e) => [e.field, initial(e.field)])));
  const baseId = useId();
  const save = () => {
    const edits: Record<string, string> = {};
    for (const e of preview.editable) {
      const v = values[e.field] ?? "";
      if (v.trim() && v !== initial(e.field)) edits[e.field] = v;
    }
    if (Object.keys(edits).length > 0) onSave(edits);
    else onClose();
  };
  return (
    <div className="mt-3 flex flex-col gap-3" data-eddy-edit>
      {preview.editable.map((e) => {
        const id = `${baseId}-${e.field}`;
        const fieldLabel = hasKey(`fact.${e.field}`) ? translateKey(lang, `fact.${e.field}`) : e.field;
        const set = (v: string) => setValues((cur) => ({ ...cur, [e.field]: v }));
        return (
          <div key={e.field} className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-sm font-medium">
              {t(lang, "edit.label", { field: fieldLabel })}
            </label>
            {e.kind === "text" ? (
              <Textarea id={id} value={values[e.field] ?? ""} onChange={(ev) => set(ev.target.value)} rows={4} className="text-base sm:text-sm" />
            ) : e.kind === "select" ? (
              <Select id={id} value={values[e.field] ?? ""} onChange={(ev) => set(ev.target.value)}>
                <option value="" />
                {(e.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {translateKey(lang, o.labelKey, {}, o.value)}
                  </option>
                ))}
              </Select>
            ) : (
              <Input id={id} type={e.kind === "datetime" ? "datetime-local" : "text"} value={values[e.field] ?? ""} onChange={(ev) => set(ev.target.value)} />
            )}
          </div>
        );
      })}
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button onClick={save} className="min-h-11">
          {t(lang, "btn.save")}
        </Button>
        <Button variant="secondary" onClick={onClose} className="min-h-11">
          {t(lang, "btn.cancel")}
        </Button>
      </div>
    </div>
  );
}

// ===== The card =====

export type PreviewCardProps = {
  card: PendingCardDTO;
  lang: EddyLang;
  view?: CardView;
  /** A request for this card is in flight. */
  busy?: boolean;
  /** The member is an admin (not_connected shows Connect WhatsApp) or a team member (the admins' names). */
  isAdmin?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
  onRevise?: (edits: Record<string, string>) => void;
  onRefresh?: () => void;
  /** v2 hand-over to an approver (4.10a). The button shows only when this is passed. */
  onAsk?: (name: string) => void;
  onNavigate?: (path: string) => void;
  /** Test seams: the clock, and the Confirm guard forced on or off. */
  now?: number;
  armed?: boolean;
  className?: string;
};

export function PreviewCard({ card, lang, view: viewIn, busy, isAdmin, onConfirm, onCancel, onRevise, onRefresh, onAsk, onNavigate, now: nowIn, armed: armedIn, className }: PreviewCardProps) {
  const titleId = useId();
  const [shownAt] = useState(() => Date.now());
  const [armedState, setArmed] = useState(false);
  const [announced, setAnnounced] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [editing, setEditing] = useState(false);
  const [clock, setClock] = useState(() => nowIn ?? Date.now());
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const preview = card.preview;
  const danger = isDangerCard(preview);
  const guardMs = typeof card.confirmGuardMs === "number" ? card.confirmGuardMs : CARD_CONFIRM_GUARD_MS;
  const armed = armedIn ?? armedState;
  const now = nowIn ?? clock;

  let view: CardView = viewIn ?? viewFromCard(card);
  // A pending card past its time shows as expired, with Refresh preview (no AI).
  if (view.state === "pending" && Date.parse(card.expiresAt) <= now) view = { ...view, state: "expired" };
  const pending = view.state === "pending";
  const focusCancel = initialFocusTarget(preview, view.state) === "cancel";

  // Confirm becomes active after the guard (6.5).
  useEffect(() => {
    if (armedIn !== undefined || !pending) return;
    const left = Math.max(0, guardMs - (Date.now() - shownAt));
    const timer = setTimeout(() => setArmed(true), left);
    return () => clearTimeout(timer);
  }, [armedIn, pending, guardMs, shownAt]);

  // The expiry footer updates each minute, silently.
  useEffect(() => {
    if (nowIn !== undefined || !pending) return;
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [nowIn, pending]);

  // Danger cards put focus on Cancel first (6.5).
  useEffect(() => {
    if (focusCancel && !editing) cancelRef.current?.focus({ preventScroll: true });
    // Only when the card first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = useCallback(() => {
    if (busy || !pending) return;
    const tap = guardTap(armed || confirmArmed(shownAt, Date.now(), guardMs), announced);
    if (tap.run) {
      onConfirm?.();
      return;
    }
    if (tap.announce) {
      setAnnounced(true);
      setAnnouncement(t(lang, "card.too_fast"));
    }
  }, [busy, pending, armed, shownAt, guardMs, announced, onConfirm, lang]);

  const confirmText = confirmLabel(lang, card);
  const sentence = confirmSentence(lang, card);
  const message = stateMessage(lang, card, view);
  const expires = pending ? expiresLabel(lang, card.expiresAt, now) : null;

  // A state that changes after a tap (sent, cancelled, refused, being checked) is read once by the card's polite status
  // region; the state a card arrives in is not, so a reloaded transcript stays quiet.
  const previousState = useRef(view.state);
  useEffect(() => {
    if (previousState.current === view.state) return;
    previousState.current = view.state;
    if (message) setAnnouncement(message);
  }, [view.state, message]);
  const tone = danger && pending ? "bad" : TONE_FOR[view.state];
  const frame =
    tone === "bad" ? "border-bad-line bg-bad-soft" : tone === "warn" && !pending ? "border-warn-line bg-raised" : "border-border bg-raised";

  const stateButtons: ReactNode[] = [];
  const stateChips: NavChip[] = [];
  if (view.state === "expired" && onRefresh) {
    stateButtons.push(
      <Button key="refresh" variant="primary" onClick={onRefresh} loading={busy} className="w-full min-h-11 sm:w-auto">
        {t(lang, "btn.refresh_preview")}
      </Button>,
    );
  }
  if (view.state === "needs_approver") {
    if (onAsk) {
      for (const name of (view.names ?? []).slice(0, 2)) {
        stateButtons.push(
          <Button key={`ask-${name}`} variant="secondary" onClick={() => onAsk(name)} className="w-full min-h-11 sm:w-auto">
            {t(lang, "btn.ask_name", { name })}
          </Button>,
        );
      }
    }
    if (view.path) stateChips.push({ path: view.path, label: t(lang, "btn.open_page") });
  }
  if (view.state === "not_connected" && (isAdmin ?? !view.names?.length)) stateChips.push({ path: CONNECT_PATH, label: t(lang, "btn.connect_whatsapp") });
  if (view.state === "reconnect") stateChips.push({ path: RECONNECT_PATH, label: t(lang, "btn.reconnect") });
  if (view.state === "spend_not_set_up") stateChips.push({ path: SPENDING_PATH, label: t(lang, "btn.spending_limits") });
  if ((view.state === "done" || view.state === "failed") && view.path) stateChips.push({ path: view.path, label: t(lang, view.state === "done" ? "btn.open" : "btn.review") });

  return (
    <section role="group" aria-labelledby={titleId} lang={htmlLang(lang)} aria-busy={busy || view.state === "running" || undefined} className={cn("rounded-card border p-4 shadow-raised", frame, className)} data-eddy-card={view.state} data-danger={danger || undefined}>
      {view.notice && <p className="mb-2 rounded-md border border-warn-line bg-warn-soft px-2.5 py-1.5 text-xs text-warn-fg">{view.notice}</p>}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={titleId} className={cn("min-w-0 flex-1 font-semibold break-words", cardTextClass(lang))}>
          <Title lang={lang} card={card} />
        </h3>
        <CardStatusChip lang={lang} state={view.state} />
      </div>

      {SHOWS_PREVIEW.has(view.state) && !editing && (
        <>
          <Facts lang={lang} preview={preview} />
          {preview.message && <MessageBubble lang={lang} message={preview.message} />}
          <p className={cn("mt-3", cardTextClass(lang))} data-eddy-cost={preview.cost?.state}>
            <span className="text-muted">{t(lang, "fact.cost")}: </span>
            <span className="font-medium">{costText(lang, preview.cost, costLeftOf(preview))}</span>
          </p>
          {preview.warnings.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1.5" data-eddy-warnings>
              {preview.warnings.map((w) => (
                <li key={w} className={cn("flex items-start gap-2 rounded-md border border-warn-line bg-warn-soft px-2.5 py-1.5 text-warn-fg", cardTextClass(lang))} data-warning={w}>
                  <WarnIcon />
                  <span>
                    <span className="sr-only">{t(lang, "warn.a11y")}: </span>
                    {warningText(lang, w, plainVars(preview.vars))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {editing && pending && (
        <EditFields
          lang={lang}
          preview={preview}
          onClose={() => setEditing(false)}
          onSave={(edits) => {
            setEditing(false);
            onRevise?.(edits);
          }}
        />
      )}

      {message && (
        <p className={cn("mt-3", cardTextClass(lang), view.state === "failed" || view.state === "refused" || view.state === "spend_frozen" || view.state === "spend_refused" ? "text-bad-fg" : "text-foreground")} data-eddy-state-message>
          {view.state === "running" && <span className="ui-spinner mr-2 inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent align-[-2px]" aria-hidden />}
          {message}
        </p>
      )}
      {view.state === "done" && view.costLower && <p className="mt-1 text-xs text-muted">{t(lang, "card.cost_lower")}</p>}

      {pending && !editing && (
        <>
          <p className="mt-3 text-xs text-muted">{t(lang, "card.nothing_yet", { confirm: confirmText })}</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center" data-eddy-card-buttons>
            <Button
              variant={danger ? "danger" : "primary"}
              aria-disabled={!armed || busy ? true : undefined}
              aria-describedby={titleId}
              data-eddy-sentence={sentence}
              onClick={confirm}
              loading={busy}
              className={cn("w-full min-h-11 sm:w-auto", !armed && "opacity-60")}
              data-eddy-confirm
            >
              {confirmText}
            </Button>
            <div className={cn("grid gap-2 sm:flex", preview.editable.length > 0 ? "grid-cols-2" : "grid-cols-1")}>
              {preview.editable.length > 0 && onRevise && (
                <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy} className="min-h-11">
                  {t(lang, "btn.edit")}
                </Button>
              )}
              <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy} aria-label={t(lang, "btn.cancel_card.a11y")} className="min-h-11" data-eddy-cancel data-initial-focus={focusCancel ? "true" : undefined}>
                {t(lang, "btn.cancel")}
              </Button>
            </div>
          </div>
          {expires && (
            <p className="mt-2 text-xs text-muted" data-eddy-expires>
              {expires}
            </p>
          )}
        </>
      )}

      {stateButtons.length > 0 && <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">{stateButtons}</div>}
      {stateChips.length > 0 && <NavChips chips={stateChips} onNavigate={onNavigate} className="mt-3" />}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-eddy-card-status>
        {announcement}
      </p>
    </section>
  );
}

// ===== Controller: the card endpoints, called only by a human tap =====

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

async function postCard(fetcher: Fetcher, actionId: string, op: "confirm" | "cancel" | "revise" | "refresh", body: Record<string, unknown>): Promise<CardOutcomeJson> {
  try {
    const res = await fetcher(`/api/actions/${encodeURIComponent(actionId)}/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    const json = (await res.json().catch(() => ({}))) as CardOutcomeJson;
    return { ...json, status: json.status ?? res.status };
  } catch {
    return { status: 0, state: "failed", code: "internal" };
  }
}

export type CardControllerProps = Omit<PreviewCardProps, "view" | "busy" | "onConfirm" | "onCancel" | "onRevise" | "onRefresh"> & {
  /** Called when the server replaced the card (changed, revise, refresh) or decided it, so the transcript can keep it. */
  onChange?: (card: PendingCardDTO, view: CardView) => void;
  /** Called after a confirmed action is done, so pages can refresh (wa:eddy-did). */
  onDone?: (card: PendingCardDTO, outcome: CardOutcomeJson) => void;
  fetcher?: Fetcher;
};

export function CardController({ card: initial, lang, onChange, onDone, fetcher, ...rest }: CardControllerProps) {
  const [card, setCard] = useState(initial);
  const [view, setView] = useState<CardView>(() => viewFromCard(initial));
  const [busy, setBusy] = useState(false);
  const doFetch: Fetcher = fetcher ?? ((input, init) => fetch(input, init));

  const apply = (next: PendingCardDTO, nextView: CardView) => {
    setCard(next);
    setView(nextView);
    onChange?.(next, nextView);
  };

  const run = async (op: "confirm" | "cancel" | "revise" | "refresh", body: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    if (op === "confirm") setView({ state: "running" });
    const out = await postCard(doFetch, card.actionId, op, body);
    setBusy(false);
    if (out.card) {
      // 409 changed, revise and refresh hand back a new card; a changed preview says so above it.
      const notice = op === "confirm" || out.state === "changed" ? stateMessage(lang, out.card, { state: "changed" }) ?? undefined : undefined;
      apply(out.card, { state: "pending", ...(notice ? { notice } : {}) });
      return;
    }
    const nextView = viewFromOutcome(out);
    apply(card, nextView);
    if (nextView.state === "done") onDone?.(card, out);
  };

  return (
    <PreviewCard
      {...rest}
      card={card}
      lang={lang}
      view={view}
      busy={busy}
      onConfirm={() => run("confirm", { nonce: card.nonce, previewHash: card.previewHash })}
      onCancel={() => run("cancel", { nonce: card.nonce })}
      onRevise={(edits) => run("revise", { nonce: card.nonce, edits, lang })}
      onRefresh={() => run("refresh", { lang })}
    />
  );
}

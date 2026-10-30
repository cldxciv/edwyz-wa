"use client";

/**
 * One item of Eddy's transcript (docs/EDDY-SPEC.md 2.5, 6.3, 6.4, 6.5, 12.1a decision 0). Replies are richly styled, never
 * plain text: Eddy's words render through SafeMarkdown, and the transcript also carries action cards, status chips,
 * preview and confirm cards with their cost, done rows with an undo bar, and progress steps.
 *
 * - The member's bubbles sit on the right (var(--accent-soft), var(--accent-ink) text) and show exactly what was typed.
 * - Eddy's bubbles sit on the left (var(--surface-2)) with the 28 px avatar in the gutter.
 * - Every message carries `lang`: hi for Devanagari, hi-Latn for Hinglish, en otherwise; Devanagari renders at 16 px with
 *   line-height 1.6; the font stack is the Eddy root's (system fonts with the Devanagari faces each OS ships).
 * - Customer text only ever appears inside CustomerQuote, as escaped, labelled plain text.
 * - Activity lines (progress notes, a tool's activity label) are muted; with reduced motion the dots do not pulse.
 *
 * The transcript itself (role="log" and the polite status region) lives in Transcript.tsx; this file renders one item.
 */
import { useState, type ReactNode } from "react";
import { Alert, Button, cn } from "@/components/ui";
import type { UntrustedText } from "@/lib/actions/types";
import type { EddyState, PendingCardDTO } from "@/lib/eddy/contract";
import { hasKey, htmlLang, spendMessage, t, translateKey, type CoreKey, type EddyLang, type Vars } from "@/lib/eddy/i18n";
import { ActionCard, NavChips, type ActionButton, type NavChip } from "./ActionCard";
import { CustomerQuote } from "./CustomerQuote";
import { EddyAvatar } from "./EddyAvatar";
import { CardController, refusalText, type CardOutcomeJson, type CardView, viewFromOutcome } from "./PreviewCard";
import { ProgressSteps, type ProgressStep } from "./ProgressSteps";
import { ResultRow, type ResultRowState } from "./ResultRow";
import { EDDY_FONT_STACK, messageTypeClass, SafeMarkdown } from "./SafeMarkdown";

export type StarterChip = { label: string; query: string };

export type TranscriptItem =
  | { kind: "member"; id: string; text: string; lang: EddyLang }
  | { kind: "eddy"; id: string; text: string; lang: EddyLang; streaming?: boolean; interrupted?: boolean }
  | { kind: "activity"; id: string; lang: EddyLang; text?: string; key?: string }
  | { kind: "card"; id: string; lang: EddyLang; card: PendingCardDTO; view?: CardView }
  | { kind: "done"; id: string; lang: EddyLang; actionId: string | null; summaryKey: string; vars?: Vars; undoUntil?: string | null; state?: ResultRowState }
  | { kind: "refused"; id: string; lang: EddyLang; action: string; code: string; who?: string[] }
  | { kind: "chips"; id: string; lang: EddyLang; chips?: NavChip[]; starters?: StarterChip[] }
  | { kind: "steps"; id: string; lang: EddyLang; steps: ProgressStep[]; title?: string }
  | { kind: "quote"; id: string; lang: EddyLang; text: UntrustedText | string }
  | { kind: "action"; id: string; lang: EddyLang; title: string; body?: string; buttons?: ActionButton[]; chips?: NavChip[]; metaLink?: unknown }
  | { kind: "error"; id: string; lang: EddyLang; state: EddyState; params?: Record<string, string | number> };

/** The catalogue sentence for a turn error or an off state (5.9, 5.11, 6.11). */
export function errorText(lang: EddyLang, state: EddyState, params: Record<string, string | number> = {}): string {
  const p = params as Vars;
  switch (state) {
    case "service_down":
      return t(lang, "service_down");
    case "busy":
      return t(lang, "error.busy");
    case "turn_in_progress":
      return t(lang, "busy");
    case "rate_limited":
      return t(lang, "error.rate_limited");
    case "message_too_long":
      return t(lang, "error.message_too_long");
    case "truncated":
      return t(lang, "error.truncated");
    case "refusal_pause":
      return t(lang, "error.refusal_pause");
    case "internal":
      return t(lang, "error.internal");
    case "platform_off":
      return t(lang, params.reason === "paused" ? "off.platform_paused" : "off.platform");
    case "locked":
      return t(lang, params.role === "agent" ? "locked.agent" : "locked.admin");
    case "workspace_off":
      return t(lang, "off.workspace.agent", { names: p.names ?? "" });
    case "paused":
      return spendMessage(lang, params.code === "spend.platform_frozen" ? "spend.platform_frozen" : "spend.frozen");
    case "allowance_used":
      if (p.need !== undefined && p.left !== undefined) return t(lang, "allowance.needs", { need: p.need, left: p.left });
      return params.period === "day" || p.date === undefined ? t(lang, "allowance.used_today") : t(lang, "allowance.used", { date: p.date });
    case "user_capped":
      return t(lang, "user_capped");
    case "ready":
      return "";
  }
}

const ERROR_TONE: Partial<Record<EddyState, "warn" | "bad" | "info" | "neutral">> = {
  service_down: "warn",
  internal: "bad",
  locked: "bad",
  paused: "warn",
  allowance_used: "warn",
  user_capped: "warn",
  platform_off: "neutral",
  workspace_off: "neutral",
};

function Working({ lang, label }: { lang: EddyLang; label: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted" lang={htmlLang(lang)} data-eddy-activity>
      <span aria-hidden className="inline-flex gap-1 motion-reduce:hidden">
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60 motion-safe:animate-pulse" />
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60 motion-safe:animate-pulse [animation-delay:160ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60 motion-safe:animate-pulse [animation-delay:320ms]" />
      </span>
      <span>{label}</span>
    </p>
  );
}

/** A done row whose [Undo] calls /api/actions/[id]/undo; an inverse that is itself a card shows that card below. */
function UndoableResult({ item, onNavigate, onDid, fetcher }: { item: Extract<TranscriptItem, { kind: "done" }>; onNavigate?: (path: string) => void; onDid?: (actionId: string) => void; fetcher?: (input: string, init: RequestInit) => Promise<Response> }) {
  const [state, setState] = useState<ResultRowState>(item.state ?? "done");
  const [card, setCard] = useState<PendingCardDTO | null>(null);
  const undo = async () => {
    if (!item.actionId || state !== "done") return;
    setState("undoing");
    let out: CardOutcomeJson;
    try {
      const res = await (fetcher ?? ((i: string, init: RequestInit) => fetch(i, init)))(`/api/actions/${encodeURIComponent(item.actionId)}/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lang: item.lang }),
        credentials: "same-origin",
      });
      out = (await res.json().catch(() => ({}))) as CardOutcomeJson;
      out.status = out.status ?? res.status;
    } catch {
      out = { status: 0, state: "failed", code: "internal" };
    }
    if (out.card) {
      setCard(out.card);
      setState("needs_card");
      return;
    }
    if (out.state === "undone") {
      setState("undone");
      onDid?.(item.actionId);
      return;
    }
    const code = out.code ?? viewFromOutcome(out).code;
    setState(code === "undo_changed" ? "conflict" : code === "undo_expired" ? "undo_expired" : code === "already_undone" ? "undone" : "undo_failed");
  };
  return (
    <div className="flex flex-col gap-2">
      <ResultRow lang={item.lang} summaryKey={item.summaryKey} vars={item.vars} undoUntil={item.undoUntil ?? null} state={state} onUndo={item.actionId ? undo : undefined} />
      {card && <CardController card={card} lang={item.lang} onNavigate={onNavigate} fetcher={fetcher} />}
    </div>
  );
}

export type MessageViewProps = {
  item: TranscriptItem;
  /** In-app navigation for /app chips and links (the panel may close the phone sheet first). */
  onNavigate?: (path: string) => void;
  /** A starter chip was tapped: send its text as the member's message. */
  onStarter?: (query: string) => void;
  /** Something changed through Eddy (a confirmed card, an undo): dispatch wa:eddy-did. */
  onDid?: (actionId: string) => void;
  /** The member is an admin or the owner (cards show Connect WhatsApp instead of the admins' names). */
  isAdmin?: boolean;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  className?: string;
};

export function MessageView({ item, onNavigate, onStarter, onDid, isAdmin, fetcher, className }: MessageViewProps) {
  const lang = item.lang;
  const root = cn("flex w-full", className);
  const font = { fontFamily: EDDY_FONT_STACK };

  if (item.kind === "member") {
    return (
      <div className={cn(root, "justify-end")} style={font} data-eddy-item="member">
        <div className={cn("max-w-[85%] rounded-2xl rounded-br-sm bg-accent-soft px-3 py-2 text-accent-ink", messageTypeClass(lang, item.text))} lang={htmlLang(lang)} dir="auto">
          <span className="sr-only">{t(lang, "a11y.you_said")}: </span>
          <p className="m-0 whitespace-pre-wrap break-words">{item.text}</p>
        </div>
      </div>
    );
  }

  const gutter = (body: ReactNode, kind: string, avatar = true) => (
    <div className={cn(root, "items-start gap-2")} style={font} data-eddy-item={kind}>
      <span className="w-7 shrink-0">{avatar && <EddyAvatar size="gutter" state={item.kind === "eddy" && item.streaming ? "working" : "idle"} />}</span>
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );

  switch (item.kind) {
    case "eddy":
      return gutter(
        <div className="max-w-full rounded-2xl rounded-tl-sm bg-surface-2 px-3 py-2 text-foreground">
          <SafeMarkdown text={item.text} lang={lang} onNavigate={onNavigate} />
          {item.streaming && !item.text && <Working lang={lang} label={t(lang, "working")} />}
          {item.interrupted && <p className="mt-1 text-xs text-muted">{t(lang, "interrupted")}</p>}
        </div>,
        "eddy",
      );
    case "activity": {
      const label = item.key && hasKey(item.key) ? translateKey(lang, item.key) : item.text?.trim() ? item.text : t(lang, "working");
      return gutter(<Working lang={lang} label={label} />, "activity", false);
    }
    case "card":
      return gutter(<CardController card={item.card} lang={lang} onNavigate={onNavigate} isAdmin={isAdmin} fetcher={fetcher} onDone={(c) => onDid?.(c.actionId)} />, "card", false);
    case "done":
      return gutter(<UndoableResult item={item} onNavigate={onNavigate} onDid={onDid} fetcher={fetcher} />, "done", false);
    case "refused": {
      const text = refusalText(lang, item.code, { names: item.who ?? [] }) ?? t(lang, "refuse.not_allowed");
      return gutter(
        <Alert tone="warn" className="text-sm">
          <span lang={htmlLang(lang)}>{text}</span>
        </Alert>,
        "refused",
        false,
      );
    }
    case "chips":
      return gutter(
        <div className="flex flex-col gap-2">
          {item.starters && item.starters.length > 0 && (
            <div className="flex flex-wrap gap-2" data-eddy-starters lang={htmlLang(lang)}>
              {item.starters.map((s) => (
                <Button key={s.query} variant="secondary" size="sm" className="pointer-coarse:min-h-11" onClick={() => onStarter?.(s.query)}>
                  {s.label}
                </Button>
              ))}
            </div>
          )}
          {item.chips && <NavChips chips={item.chips} onNavigate={onNavigate} />}
        </div>,
        "chips",
        false,
      );
    case "steps":
      return gutter(
        <div className="rounded-card border border-border bg-raised p-3 shadow-raised" lang={htmlLang(lang)}>
          {item.title && <p className="mb-2 text-sm font-semibold">{item.title}</p>}
          <ProgressSteps steps={item.steps} lang={lang} label={item.title} />
        </div>,
        "steps",
        false,
      );
    case "quote":
      return gutter(<CustomerQuote text={item.text} lang={lang} />, "quote", false);
    case "action":
      return gutter(<ActionCard lang={lang} title={item.title} body={item.body} buttons={item.buttons} chips={item.chips} metaLink={item.metaLink} onNavigate={onNavigate} />, "action", false);
    case "error": {
      const text = errorText(lang, item.state, item.params);
      if (!text) return null;
      return gutter(
        <Alert tone={ERROR_TONE[item.state] ?? "warn"}>
          <span lang={htmlLang(lang)}>{text}</span>
        </Alert>,
        "error",
        false,
      );
    }
  }
}

/** Keys an off state needs, for components that render plain buttons when the AI is unavailable (6.11). */
export const OFF_STATE_KEYS: Readonly<Record<string, CoreKey>> = {
  platform_off: "off.platform",
  platform_paused: "off.platform_paused",
  workspace_off: "off.workspace.agent",
  locked_admin: "locked.admin",
  locked_agent: "locked.agent",
  allowance_used: "allowance.used",
  user_capped: "user_capped",
};

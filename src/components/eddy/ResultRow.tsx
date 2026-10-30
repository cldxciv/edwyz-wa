"use client";

/**
 * Result rows for instant and undoable actions (docs/EDDY-SPEC.md 4.5, 6.4, 6.6): a check icon, then a summary the server
 * builds from the catalogue (never the model's words), then an undo bar with [Undo] until `undoUntil`. After the window the
 * button turns into plain text. After an undo: "Undone." On conflict: "Someone changed it since, so it was not undone."
 * An undo whose inverse would message customers or spend (Resume, Turn back on) opens a card instead; the caller gets that
 * card from the undo endpoint and renders it, and the row says why.
 *
 * The status line is aria-live polite, so the result of an undo is announced once; the countdown is not announced.
 */
import { useEffect, useState } from "react";
import { Button, cn } from "@/components/ui";
import { htmlLang, t, translateKey, type EddyLang, type Vars } from "@/lib/eddy/i18n";
import { cardTextClass } from "./SafeMarkdown";

export type ResultRowState = "done" | "undoing" | "undone" | "conflict" | "undo_expired" | "undo_failed" | "needs_card";

/** True while the undo bar should still offer [Undo]. */
export function undoAvailable(undoUntil: string | Date | null | undefined, now: number = Date.now()): boolean {
  if (!undoUntil) return false;
  const at = undoUntil instanceof Date ? undoUntil.getTime() : Date.parse(undoUntil);
  return Number.isFinite(at) && at > now;
}

/** "2:05 pm" in the member's zone, for "Undo is available until {time}." */
export function formatUndoTime(undoUntil: string | Date, lang: EddyLang): string {
  const d = undoUntil instanceof Date ? undoUntil : new Date(undoUntil);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-IN", { hour: "numeric", minute: "2-digit", hour12: true, numberingSystem: "latn" })
    .format(d)
    .replace(/\s?(AM|PM)$/i, (m) => ` ${m.trim().toLowerCase()}`);
}

function Check({ tone }: { tone: "good" | "neutral" | "warn" }) {
  const cls = tone === "good" ? "border-good-line bg-good-soft text-good-fg" : tone === "warn" ? "border-warn-line bg-warn-soft text-warn-fg" : "border-border bg-surface text-muted";
  return (
    <span aria-hidden className={cn("mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border", cls)}>
      <svg viewBox="0 0 16 16" className="h-3 w-3" focusable="false">
        {tone === "warn" ? (
          <path d="M8 4v5M8 11.5v.01" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        ) : (
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </span>
  );
}

export type ResultRowProps = {
  lang: EddyLang;
  /** The catalogue key of the summary (done.<action>); unknown keys fall back to "Done." */
  summaryKey: string;
  vars?: Vars;
  undoUntil?: string | null;
  state?: ResultRowState;
  /** Called by [Undo]. The caller posts /api/actions/[id]/undo and sets the state from the answer. */
  onUndo?: () => void;
  /** Test seam: the clock the countdown reads. */
  now?: number;
  className?: string;
};

export function ResultRow({ lang, summaryKey, vars = {}, undoUntil, state = "done", onUndo, now, className }: ResultRowProps) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  const open = state === "done" && undoAvailable(undoUntil, now ?? clock);

  // The [Undo] button turns into plain text when the window closes (6.4).
  useEffect(() => {
    if (now !== undefined || state !== "done" || !undoUntil) return;
    const left = Date.parse(undoUntil) - Date.now();
    if (!(left > 0)) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(left + 50, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [undoUntil, state, now]);

  const summary = translateKey(lang, summaryKey, vars);
  const line =
    state === "undone"
      ? t(lang, "undo.done")
      : state === "conflict"
        ? t(lang, "undo.conflict")
        : state === "undo_expired"
          ? t(lang, "undo.expired")
          : state === "undo_failed"
            ? t(lang, "undo.failed")
            : state === "needs_card"
              ? t(lang, "undo.needs_card")
              : state === "undoing"
                ? t(lang, "undo.undoing")
                : null;
  const tone = state === "undone" ? "neutral" : state === "conflict" || state === "undo_failed" || state === "undo_expired" ? "warn" : "good";

  return (
    <div lang={htmlLang(lang)} className={cn("flex items-start gap-2.5 rounded-lg border border-border bg-raised px-3 py-2 shadow-raised", cardTextClass(lang), className)} data-eddy-result={state}>
      <Check tone={tone} />
      <div className="min-w-0 flex-1">
        <p className={cn("break-words", state === "undone" && "text-muted line-through decoration-1")}>{summary}</p>
        <p role="status" aria-live="polite" aria-atomic="true" className={cn("text-xs", line ? "mt-0.5 text-muted" : "sr-only")}>
          {line ?? ""}
        </p>
        {state === "done" && undoUntil && open && <p className="mt-0.5 text-xs text-muted">{t(lang, "undo.until", { time: formatUndoTime(undoUntil, lang) })}</p>}
      </div>
      {(open || state === "undoing") && (
        <div className="shrink-0" data-eddy-undo-bar>
          <Button variant="secondary" size="sm" className="pointer-coarse:min-h-11" onClick={onUndo} loading={state === "undoing"} aria-label={t(lang, "undo.a11y", { summary })}>
            {t(lang, "btn.undo")}
          </Button>
        </div>
      )}
    </div>
  );
}

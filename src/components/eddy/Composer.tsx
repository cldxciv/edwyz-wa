"use client";

/**
 * Eddy's composer (docs/EDDY-SPEC.md 6.2, 6.3, 6.13).
 *
 * - An autogrowing textarea, up to 5 lines, with a 2,000-character limit and a counter from 1,800.
 * - Enter sends and Shift+Enter adds a line, following the inbox's own send setting (localStorage inbox:send-key);
 *   Ctrl/Cmd+Enter always sends. While an IME is composing, Enter is left alone.
 * - Up arrow in an empty composer recalls the last message. While Eddy works, Send becomes Stop.
 * - A local warning appears when a paste looks like a card number (13 to 19 digits passing the Luhn check) or a one-time
 *   code. Nothing is blocked or sent anywhere: the warning only tells the member to remove it.
 * - The input is 16 px (no iOS zoom), `enterKeyHint="send"`, and Send and Stop are 44 x 44 px.
 *
 * Key handling uses the capture phase, because the keyguard on [data-eddy-root] stops bubbling keydown events (keyguard.ts).
 * The value is controlled by the caller, so the draft lives in EddyRoot and survives the sheet closing (Back keeps it).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Alert, Button, cn, Textarea } from "@/components/ui";
import { parseSendKey, readStore, SEND_KEY_KEY, wantsSend, type SendKeyPref } from "@/components/inbox/ux";
import { EDDY_DEFAULTS } from "@/lib/eddy/contract";
import { tp } from "@/lib/eddy/copy/panel";
import { htmlLang, t, type EddyLang } from "@/lib/eddy/i18n";

export const COMPOSER_MAX = EDDY_DEFAULTS.maxMessageChars;
export const COUNTER_FROM = 1800;
export const COMPOSER_MAX_LINES = 5;

/** The counter shows from 1,800 characters (6.3). */
export const showCounter = (length: number): boolean => length >= COUNTER_FROM;

/** What a key press in the composer does. */
export function composerKeyAction(
  e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean },
  pref: SendKeyPref,
  ctx: { value: string; working: boolean; lastSent: string | null },
): "send" | "recall" | null {
  if (e.isComposing) return null;
  if (e.key === "ArrowUp" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && ctx.value === "" && ctx.lastSent) return "recall";
  if (wantsSend(e, pref)) return ctx.working ? null : "send";
  return null;
}

/** The Luhn check card numbers pass. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const CARD_RUN = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const OTP_WORDS = /\b(otp|one[- ]?time|passcode|verification code|security code|login code|pin)\b|ओटीपी|ओ\.टी\.पी|वन-टाइम/i;
const SHORT_CODE = /(?<![\d,]|\d\.)\d{4,8}(?![\d,]|\.\d)/;

/** Whether pasted text looks like a card number or a one-time code (6.3), or neither. */
export function pasteWarning(text: string): "card" | "otp" | null {
  if (typeof text !== "string" || !text) return null;
  for (const m of text.matchAll(CARD_RUN)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return "card";
  }
  const trimmed = text.trim();
  if (/^\d{4,8}$/.test(trimmed)) return "otp";
  if (OTP_WORDS.test(text) && SHORT_CODE.test(text)) return "otp";
  return null;
}

/** The textarea height for its content: one line minimum, `maxLines` maximum (then it scrolls). */
export function autogrowHeight(scrollHeight: number, lineHeight: number, paddingY: number, maxLines = COMPOSER_MAX_LINES): number {
  const max = lineHeight * maxLines + paddingY;
  const min = lineHeight + paddingY;
  return Math.max(min, Math.min(Number.isFinite(scrollHeight) ? scrollHeight : min, max));
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" focusable="false">
      <path d="M4 12l15-7-5 15-2.5-6.5L4 12z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

export type ComposerProps = {
  lang: EddyLang;
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  working: boolean;
  lastSent: string | null;
  /** No input at all (the off states never show one); kept for a status that is still loading. */
  disabled?: boolean;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  /** A line above the input, for example "Your unsent message is back in the box." */
  notice?: ReactNode;
  className?: string;
};

export function Composer({ lang, value, onChange, onSend, onStop, working, lastSent, disabled, autoFocus, inputRef, notice, className }: ComposerProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;
  const local = useRef<HTMLTextAreaElement | null>(null);
  const [pref, setPref] = useState<SendKeyPref>("enter");
  const [warning, setWarning] = useState<"card" | "otp" | null>(null);

  useEffect(() => setPref(parseSendKey(readStore(SEND_KEY_KEY))), []);

  // Autogrow to 5 lines (6.3). Runs before paint so the box never flickers to the wrong height.
  useLayoutEffect(() => {
    const el = local.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = window.getComputedStyle(el);
    const line = Number.parseFloat(cs.lineHeight) || 24;
    const pad = (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0) + (Number.parseFloat(cs.borderTopWidth) || 0) + (Number.parseFloat(cs.borderBottomWidth) || 0);
    el.style.height = `${autogrowHeight(el.scrollHeight, line, pad)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) local.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const setRef = (el: HTMLTextAreaElement | null) => {
    local.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef && typeof inputRef === "object") (inputRef as { current: HTMLTextAreaElement | null }).current = el;
  };

  const submit = () => {
    const text = value.trim();
    if (!text || working) return;
    onSend(text);
    setWarning(null);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKeyAction({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing }, pref, { value, working, lastSent });
    if (action === "send") {
      e.preventDefault();
      submit();
    } else if (action === "recall" && lastSent) {
      e.preventDefault();
      onChange(lastSent.slice(0, COMPOSER_MAX));
    } else if (e.key === "Enter" && working && !e.shiftKey && (pref === "enter" || e.ctrlKey || e.metaKey)) {
      // Enter while Eddy works does nothing (Stop is a button); the text stays for the next message.
      e.preventDefault();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData?.getData("text") ?? "";
    setWarning(pasteWarning(text));
  };

  const len = value.length;
  const hint = tp(lang, pref === "enter" ? "panel.composer.enter" : "panel.composer.mod_enter");

  return (
    <div className={cn("flex flex-col gap-2", className)} lang={htmlLang(lang)} data-eddy-composer>
      {notice}
      {warning && (
        <Alert tone="warn" className="text-sm">
          {tp(lang, warning === "card" ? "panel.paste.card" : "panel.paste.otp")}
        </Alert>
      )}
      <div className="flex items-end gap-2">
        <label htmlFor={id} className="sr-only">
          {tp(lang, "panel.composer.label")}
        </label>
        <Textarea
          id={id}
          ref={setRef}
          rows={1}
          value={value}
          maxLength={COMPOSER_MAX}
          disabled={disabled}
          enterKeyHint="send"
          autoComplete="off"
          placeholder={t(lang, "composer.placeholder")}
          aria-describedby={showCounter(len) ? `${hintId} ${countId}` : hintId}
          onChange={(e) => onChange(e.target.value.slice(0, COMPOSER_MAX))}
          onKeyDownCapture={onKey}
          onPaste={onPaste}
          dir="auto"
          // The design-system field, at 16 px (no iOS zoom) and one line high until it grows.
          className="min-h-11! resize-none overflow-y-auto py-2.5! text-base! leading-6"
          data-eddy-input
        />
        {/* px-0! because the Button's own px-5 comes later in the stylesheet and would squeeze the icon to 4 px. */}
        {working ? (
          <Button type="button" variant="secondary" onClick={onStop} aria-label={tp(lang, "panel.composer.stop")} className="h-11 w-11 shrink-0 px-0!" data-eddy-stop>
            <StopIcon />
          </Button>
        ) : (
          <Button type="button" onClick={submit} disabled={disabled || !value.trim()} aria-label={tp(lang, "panel.composer.send")} className="h-11 w-11 shrink-0 px-0!" data-eddy-send>
            <SendIcon />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted">
        <span id={hintId} className="max-md:sr-only">
          {hint}
        </span>
        {showCounter(len) && (
          <span id={countId} className={cn("ml-auto tabular-nums", len >= COMPOSER_MAX && "font-semibold text-warn-fg")}>
            <span aria-hidden="true">
              {len.toLocaleString("en-IN")}/{COMPOSER_MAX.toLocaleString("en-IN")}
            </span>
            <span className="sr-only">{tp(lang, "panel.composer.count", { count: len.toLocaleString("en-IN"), max: COMPOSER_MAX.toLocaleString("en-IN") })}</span>
          </span>
        )}
      </div>
    </div>
  );
}

"use client";

/**
 * Eddy's desktop panel and the parts the phone sheet shares (docs/EDDY-SPEC.md 6.2, 6.3, 6.6, 6.11, 6.13).
 *
 * Desktop (md and up): a non-modal `<aside aria-label="Eddy" data-eddy-root>`, 384 px wide and full height, scrolling
 * inside itself. At 2xl (1536 px) and wider it sits beside the content and pushes it; below 2xl it overlays the right edge
 * at z-(--z-overlay) with the --elev-3 shadow (shadow-modal) and never resizes `main`, so the inbox's chat column keeps its
 * width. The palette (z 60) and toasts (z 70) stay above it.
 *
 * - Esc with focus inside closes it and returns focus to the launcher; the close button does the same.
 * - The open state is remembered per tab (sessionStorage eddy:open, inside try/catch).
 * - Focus not obscured (WCAG 2.4.11): while it overlays, the page gets `scroll-padding-inline-end: 384px`, and a `focusin`
 *   listener on `main` scrolls a focused element that sits under the panel into view. Where that cannot help (layouts that
 *   do not scroll sideways, such as the inbox's fixed columns), the panel closes when focus moves there with the keyboard
 *   (not on a mouse click); the launcher then shows if Eddy is still working.
 * - The keyguard stops keys from leaking to the page; Ctrl/Cmd+K still opens the palette (keyguard.ts).
 *
 * Header: the avatar, "Eddy", the status pill and a menu (New chat, Language, Team activity, My usage, Delete my Eddy
 * history, and Eddy settings for owners and admins). Language, Team activity and My usage open their views inside the menu
 * (LanguagePicker, TeamActivity, UsageMeter; none of them calls the model). Then the "Needs you" strip (NoticeList), banners,
 * the transcript or an off state, and the footer: the first-use notice, the context chip and the composer.
 */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Alert, Button, cn, Spinner } from "@/components/ui";
import type { EddyLangPref, EddyStatusDTO, PageContext } from "@/lib/eddy/contract";
import { tp } from "@/lib/eddy/copy/panel";
import { htmlLang, t, type EddyLang } from "@/lib/eddy/i18n";
import { Composer } from "./Composer";
import { ContextChip, type ChipSubject } from "./ContextChip";
import { EddyAvatar } from "./EddyAvatar";
import { EDDY_PANEL_ID } from "./EddyLauncher";
import { EDDY_SETTINGS_PAGE } from "./EnableCard";
import type { EddyOpenRef } from "./events";
import { useKeyguard } from "./keyguard";
import { LanguagePicker } from "./LanguagePicker";
import { NoticeList } from "./NoticeList";
import { OffState, offKindOf } from "./OffState";
import { contextSubject } from "./page-context";
import { EDDY_FONT_STACK } from "./SafeMarkdown";
import { StarterChips } from "./StarterChips";
import { SetupGuide } from "./guides/SetupGuide";
import { EddyStatusChip } from "./StatusChip";
import { TeamActivity } from "./TeamActivity";
import { OnScreenItems, Transcript } from "./Transcript";
import { UsageMeter } from "./UsageMeter";
import { historyDaysOf, patchEddyStatus, rememberPanelOpen, type StatusError } from "./useEddyStatus";
import type { EddySession } from "./useEddyStream";

/** The panel width (6.2). */
export const PANEL_WIDTH_PX = 384;
/** Tailwind's 2xl: from here the panel pushes the content instead of overlaying it. */
export const PUSH_MEDIA = "(min-width: 96rem)";

/** Everything the panel and the sheet need, built by EddyRoot (which stays mounted, so a turn survives closing). */
export type EddyController = {
  session: EddySession;
  status: EddyStatusDTO | null;
  statusError: StatusError | null;
  refreshStatus: () => void;
  /** The chrome language: the saved preference, else the latest turn's, else English. */
  lang: EddyLang;
  role: string;
  userName: string;
  workspaceName: string;
  /** The current page context (ids only). */
  page: PageContext;
  /** The id-only reference Eddy was opened with (a notice, a failed message), used by the next message. */
  openRef: EddyOpenRef | null;
  contextDropped: boolean;
  /** The chip's x: the next message goes without page context (and without the reference). */
  dropContext: () => void;
  draft: string;
  setDraft: (value: string) => void;
  /** The draft came back after a sign-in. */
  draftRestored: boolean;
  send: (text: string) => void;
  /** Closes Eddy. `restoreFocus` returns focus to the launcher (Esc, the close button). */
  close: (opts?: { restoreFocus?: boolean }) => void;
  navigate: (path: string) => void;
};

export type MenuView = null | "root" | "language" | "usage" | "team" | "delete";

const isAdminRole = (role: string) => role === "owner" || role === "admin";

/** The subject the context chip names: the reference Eddy was opened with, else the page's. Null hides the chip. */
export function chipSubject(c: Pick<EddyController, "openRef" | "contextDropped" | "page">): ChipSubject | null {
  if (c.contextDropped) return null;
  if (c.openRef) return c.openRef.kind === "notice" ? "notice" : "message";
  return contextSubject(c.page);
}

/** The status pill's state (6.3): Working… while a turn runs, otherwise the availability. Null before the first load. */
export function pillState(status: EddyStatusDTO | null, working: boolean) {
  if (working) return "working" as const;
  return status ? status.state : null;
}

// ===== Header controls (shared by the panel header and the sheet's Dialog header) =====

export function HeaderControls({ c, menu, setMenu, menuId }: { c: EddyController; menu: MenuView; setMenu: (v: MenuView) => void; menuId: string }) {
  const pill = pillState(c.status, c.session.state.working);
  return (
    <>
      {/* Below 360 px (the phone sheet at 320 px) the pill gives way so the header never scrolls sideways. */}
      {pill && (
        <span className="inline-flex max-[359px]:hidden">
          <EddyStatusChip lang={c.lang} state={pill} />
        </span>
      )}
      <button
        type="button"
        onClick={() => setMenu(menu ? null : "root")}
        aria-expanded={menu !== null}
        aria-controls={menu ? menuId : undefined}
        aria-label={tp(c.lang, "panel.menu")}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground"
        data-eddy-menu-button
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" focusable="false">
          <circle cx="12" cy="5.5" r="1.6" fill="currentColor" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
          <circle cx="12" cy="18.5" r="1.6" fill="currentColor" />
        </svg>
      </button>
    </>
  );
}

// ===== Menu =====

async function putPrefs(body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/eddy/prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteHistory(): Promise<boolean> {
  try {
    const res = await fetch("/api/eddy/conversations", { method: "DELETE", credentials: "same-origin" });
    return res.ok;
  } catch {
    return false;
  }
}

const itemClass = "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-surface-2 focus-visible:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50";

/** The usage lines (My usage): the member's Eddy credits today and the workspace's AI credits this month. No model call. */
export function usageLines(lang: EddyLang, status: EddyStatusDTO | null): string[] {
  if (!status) return [];
  const a = status.allowance;
  const fmt = (n: number) => n.toLocaleString("en-IN");
  const lines = [tp(lang, "panel.usage.me", { used: fmt(a.memberUsedToday), limit: fmt(a.memberLimitToday) })];
  lines.push(a.limitMonth === null ? tp(lang, "panel.usage.month_open", { used: fmt(a.usedMonth) }) : tp(lang, "panel.usage.month", { used: fmt(a.usedMonth), limit: fmt(a.limitMonth) }));
  lines.push(tp(lang, "panel.usage.note"));
  return lines;
}

export function PanelMenu({ c, view, setView, id, focusInput }: { c: EddyController; view: Exclude<MenuView, null>; setView: (v: MenuView) => void; id: string; focusInput?: () => void }) {
  const lang = c.lang;
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = c.status?.state === "ready";
  const days = historyDaysOf(c.status);

  const newChat = () => {
    c.session.newChat();
    setView(null);
    focusInput?.();
  };
  const pickLanguage = async (value: EddyLangPref) => {
    setBusy(true);
    const ok = await putPrefs({ language: value });
    setBusy(false);
    if (ok) patchEddyStatus({ langPref: value });
    setMessage(tp(ok && value !== "auto" ? value : lang, ok ? "panel.lang.saved" : "panel.lang.failed"));
  };
  const remove = async () => {
    setBusy(true);
    const ok = await deleteHistory();
    setBusy(false);
    if (ok) {
      c.session.newChat();
      setView("root");
    }
    setMessage(tp(lang, ok ? "panel.delete.done" : "panel.delete.failed", { days }));
  };

  return (
    <section id={id} aria-label={tp(lang, "panel.menu")} lang={htmlLang(lang)} className="rounded-card border border-border bg-raised p-2 shadow-raised" data-eddy-menu>
      {view === "root" && (
        <ul className="flex flex-col">
          <li>
            <button type="button" className={itemClass} onClick={newChat}>
              {t(lang, "btn.new_chat")}
            </button>
          </li>
          <li>
            <button type="button" className={itemClass} onClick={() => setView("language")}>
              {tp(lang, "panel.menu.language")}
            </button>
          </li>
          <li>
            <button type="button" className={itemClass} onClick={() => setView("team")}>
              {tp(lang, "panel.menu.team")}
            </button>
          </li>
          <li>
            <button type="button" className={itemClass} onClick={() => setView("usage")}>
              {tp(lang, "panel.menu.usage")}
            </button>
          </li>
          <li>
            <button type="button" className={cn(itemClass, "text-bad-fg")} onClick={() => setView("delete")}>
              {tp(lang, "panel.menu.delete")}
            </button>
          </li>
          {isAdminRole(c.role) && (
            <li>
              <button type="button" className={itemClass} onClick={() => c.navigate(EDDY_SETTINGS_PAGE)}>
                {tp(lang, "panel.menu.settings")}
              </button>
            </li>
          )}
        </ul>
      )}

      {view === "language" && <LanguagePicker lang={lang} value={c.status?.langPref ?? "auto"} busy={busy} onPick={(value) => void pickLanguage(value)} onClose={() => setView("root")} />}

      {view === "usage" && <UsageMeter lang={lang} status={c.status} onClose={() => setView("root")} />}

      {view === "team" && (
        <TeamActivity
          lang={lang}
          eddyReady={ready && !c.session.state.working}
          onNavigate={c.navigate}
          onAsk={(query) => {
            setView(null);
            c.send(query);
            focusInput?.();
          }}
          onClose={() => setView("root")}
        />
      )}

      {view === "delete" && (
        <div className="flex flex-col gap-3 p-2 text-sm">
          <p>{tp(lang, "panel.delete.ask", { days })}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="danger" loading={busy} className="min-h-11" onClick={() => void remove()}>
              {tp(lang, "panel.delete.yes")}
            </Button>
            <Button type="button" variant="secondary" disabled={busy} className="min-h-11" onClick={() => setView("root")}>
              {t(lang, "btn.cancel")}
            </Button>
          </div>
        </div>
      )}

      <p role="status" aria-live="polite" className={message ? "px-2 pt-2 text-xs text-muted" : "sr-only"}>
        {message}
      </p>
    </section>
  );
}

// ===== Main area and footer =====

function Greeting({ c }: { c: EddyController }) {
  const first = c.userName.trim().split(/\s+/)[0] ?? "";
  return (
    <div className="flex flex-col items-start gap-3" data-eddy-greeting>
      <EddyAvatar size="hero" />
      <p className={cn("text-foreground", c.lang === "hi" ? "text-base leading-[1.6]" : "text-sm")} lang={htmlLang(c.lang)}>
        {first ? t(c.lang, "greet.first", { name: first }) : t(c.lang, "greet.noname")}
      </p>
      <StarterChips lang={c.lang} pageId={c.page.id} whatsapp={c.status?.whatsapp} onPick={c.send} disabled={c.session.state.working} />
      {/* The guided setup (6.8): step cards from GET /api/setup until setup is complete; their chips message Eddy. */}
      <SetupGuide lang={c.lang} role={c.role} canChat onAsk={c.send} onNavigate={c.navigate} hideWhenComplete className="w-full" />
    </div>
  );
}

/** Banners, then the transcript, or an off state with its plain buttons. */
export function EddyMain({ c, menu, setMenu, menuId, notices: noticesSlot, focusInput }: { c: EddyController; menu: MenuView; setMenu: (v: MenuView) => void; menuId: string; notices?: ReactNode; focusInput?: () => void }) {
  const kind = offKindOf(c.status, c.statusError);
  const admin = isAdminRole(c.role);
  const { state } = c.session;
  // The "Needs you" strip (6.7) shows in every state, the off states included: it needs no AI.
  const notices = noticesSlot === undefined ? <NoticeList lang={c.lang} onNavigate={c.navigate} /> : noticesSlot;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {menu && <PanelMenu c={c} view={menu} setView={setMenu} id={menuId} focusInput={focusInput} />}
      {!c.status && !kind ? (
        <Spinner label={tp(c.lang, "panel.loading")} />
      ) : kind ? (
        <OffState
          kind={kind}
          lang={c.lang}
          status={c.status}
          role={c.role}
          pageId={c.page.id}
          onNavigate={c.navigate}
          onRetry={c.refreshStatus}
          onEnabled={c.refreshStatus}
          onNotNow={() => c.close({ restoreFocus: true })}
          notices={notices}
          onScreen={<OnScreenItems items={state.items} isAdmin={admin} onNavigate={c.navigate} />}
        />
      ) : (
        <>
          {c.status?.readOnly && (
            <Alert tone="info">
              <span lang={htmlLang(c.lang)}>{t(c.lang, "verify.readonly")}</span>
            </Alert>
          )}
          {c.status?.spendingStopped && (
            <Alert tone="warn">
              <span lang={htmlLang(c.lang)}>{t(c.lang, "spending_banner")}</span>
            </Alert>
          )}
          {notices}
          <Transcript items={state.items} lang={c.lang} working={state.working} activity={state.activity} isAdmin={admin} onNavigate={c.navigate} onStarter={c.send} empty={<Greeting c={c} />} />
        </>
      )}
    </div>
  );
}

/** First use by each member (6.11): what is sent to Anthropic and how long chats are kept, until [Got it]. */
export function FirstUseNotice({ lang, days, onAck }: { lang: EddyLang; days: number; onAck: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-info-line bg-info-soft p-3 text-sm text-info-fg" lang={htmlLang(lang)} data-eddy-first-use>
      <p className={lang === "hi" ? "text-base leading-[1.6]" : undefined}>{t(lang, "notice.first_use", { days })}</p>
      <Button type="button" variant="secondary" size="sm" className="self-start pointer-coarse:min-h-11" onClick={onAck}>
        {t(lang, "btn.got_it")}
      </Button>
    </div>
  );
}

/** The footer when Eddy can chat: first-use notice, context chip, composer. Null in the off states (no input box). */
export function EddyFooter({ c, autoFocus, inputRef }: { c: EddyController; autoFocus?: boolean; inputRef?: RefObject<HTMLTextAreaElement | null> }) {
  const [acked, setAcked] = useState(false);
  const kind = offKindOf(c.status, c.statusError);
  if (!c.status || kind) return null;
  const subject = chipSubject(c);
  const { state } = c.session;
  const ack = () => {
    setAcked(true);
    patchEddyStatus({ firstUse: false });
    void putPrefs({ firstUseAck: true });
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {c.status.firstUse && !acked && <FirstUseNotice lang={c.lang} days={historyDaysOf(c.status)} onAck={ack} />}
      {subject && <ContextChip lang={c.lang} subject={subject} onRemove={c.dropContext} />}
      <Composer
        lang={c.lang}
        value={c.draft}
        onChange={c.setDraft}
        onSend={c.send}
        onStop={c.session.stop}
        working={state.working}
        lastSent={state.lastSent}
        autoFocus={autoFocus}
        inputRef={inputRef}
        notice={
          c.draftRestored ? (
            <p role="status" className="text-xs text-muted">
              {tp(c.lang, "panel.composer.restored")}
            </p>
          ) : undefined
        }
      />
    </div>
  );
}

// ===== Focus not obscured (6.2, WCAG 2.4.11) =====

/** True when an element's box sits (partly) under the panel's box. */
export function obscuredBy(el: Pick<DOMRect, "left" | "right" | "top" | "bottom">, panel: Pick<DOMRect, "left" | "right" | "top" | "bottom">): boolean {
  return el.right > panel.left && el.left < panel.right && el.bottom > panel.top && el.top < panel.bottom;
}

function useFocusNotObscured(panel: RefObject<HTMLElement | null>, onObscured: () => void): void {
  const latest = useRef(onObscured);
  latest.current = onObscured;
  useEffect(() => {
    const mq = window.matchMedia?.(PUSH_MEDIA);
    if (mq?.matches) return;
    const html = document.documentElement;
    const main = document.getElementById("main-content");
    const before = { html: html.style.scrollPaddingInlineEnd, main: main?.style.scrollPaddingInlineEnd ?? "" };
    html.style.scrollPaddingInlineEnd = `${PANEL_WIDTH_PX}px`;
    if (main) main.style.scrollPaddingInlineEnd = `${PANEL_WIDTH_PX}px`;
    let pointerAt = 0;
    const onPointer = () => {
      pointerAt = Date.now();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      const box = panel.current?.getBoundingClientRect();
      if (!el || !box || typeof el.getBoundingClientRect !== "function") return;
      if (!obscuredBy(el.getBoundingClientRect(), box)) return;
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      // Still under the panel and reached with the keyboard: the layout can't scroll it out, so the panel steps aside.
      if (obscuredBy(el.getBoundingClientRect(), box) && Date.now() - pointerAt > 600) latest.current();
    };
    document.addEventListener("pointerdown", onPointer, true);
    main?.addEventListener("focusin", onFocusIn);
    return () => {
      html.style.scrollPaddingInlineEnd = before.html;
      if (main) main.style.scrollPaddingInlineEnd = before.main;
      document.removeEventListener("pointerdown", onPointer, true);
      main?.removeEventListener("focusin", onFocusIn);
    };
  }, [panel]);
}

// ===== The desktop panel =====

export function EddyPanel({ c, notices }: { c: EddyController; notices?: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const [menu, setMenu] = useState<MenuView>(null);
  const menuId = useId();
  const titleId = useId();
  useKeyguard(root);
  useFocusNotObscured(root, () => c.close({ restoreFocus: false }));

  useEffect(() => {
    rememberPanelOpen(true);
    // Focus moves into Eddy when it opens: the composer when Eddy can chat, otherwise the panel itself.
    const target = input.current ?? root.current;
    target?.focus({ preventScroll: true });
  }, []);

  const close = () => {
    rememberPanelOpen(false);
    c.close({ restoreFocus: true });
  };

  return (
    <aside
      ref={root}
      id={EDDY_PANEL_ID}
      aria-labelledby={titleId}
      tabIndex={-1}
      data-eddy-root
      style={{ fontFamily: EDDY_FONT_STACK, width: PANEL_WIDTH_PX }}
      className="fixed inset-y-0 right-0 z-(--z-overlay) flex max-w-full flex-col border-l border-border bg-background text-foreground shadow-modal outline-none 2xl:sticky 2xl:top-0 2xl:z-auto 2xl:h-screen 2xl:shrink-0 2xl:shadow-none"
      onKeyDownCapture={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        if (menu) {
          setMenu(null);
          root.current?.querySelector<HTMLElement>("[data-eddy-menu-button]")?.focus();
          return;
        }
        close();
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2 md:h-16">
        <EddyAvatar size="gutter" state={c.session.state.working ? "working" : "idle"} />
        <h2 id={titleId} className="text-base font-semibold tracking-tight">
          {t(c.lang, "name")}
        </h2>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <HeaderControls c={c} menu={menu} setMenu={setMenu} menuId={menuId} />
          <button type="button" onClick={close} aria-label={tp(c.lang, "panel.close")} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground" data-eddy-close>
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" focusable="false">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        <EddyMain c={c} menu={menu} setMenu={setMenu} menuId={menuId} notices={notices} focusInput={() => (input.current ?? root.current)?.focus()} />
      </div>
      <EddyFooterFrame>
        <EddyFooter c={c} inputRef={input} />
      </EddyFooterFrame>
    </aside>
  );
}

/** The bordered strip that holds the footer; it disappears when the footer renders nothing (off states). */
function EddyFooterFrame({ children }: { children: ReactNode }) {
  return <div className="shrink-0 border-t border-border px-4 py-3 empty:hidden">{children}</div>;
}

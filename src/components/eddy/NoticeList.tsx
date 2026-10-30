"use client";

/**
 * The "Needs you" strip (docs/EDDY-SPEC.md 6.7, 6.3, 6.11, 6.13): at the top of Eddy, and in every off state (it needs no AI).
 *
 * - At most 3 notices, action needed first, then heads-up, then for your information; [See all] shows the rest.
 * - Each notice: a severity chip, its text in the member's language (names filled from ids by the server, rendered as plain
 *   text; a `template_name` in backticks shows as code), its buttons, [Dismiss] and [Don't show these] (mutes the kind).
 * - Buttons never write and never carry text (6.7 critic): a navigation to an allowlisted /app path (safeAppPath again
 *   here), opening Eddy with the notice's id as the reference (Eddy then reads any text through a tool, as UntrustedText),
 *   or a fresh card, which Eddy builds on the server from the same id reference. Nothing is typed into the member's chat.
 * - Changes are announced in a polite status region. Tokens only (light and dark), 44 px targets on touch, wraps at 360 px.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Badge, Button, buttonSizes, buttonVariants, cn, type Tone } from "@/components/ui";
import { safeAppPath, type EddyLang, type NoticeAction, type NoticeDTO, type NoticeSeverity } from "@/lib/eddy/contract";
import { tn } from "@/lib/eddy/copy/notices";
import { htmlLang, isMostlyDevanagari, t, translateKey } from "@/lib/eddy/i18n";
import { openEddy } from "./events";
import { noticeText, useNotices } from "./useNotices";

/** Notices shown before [See all]. */
export const STRIP_LIMIT = 3;

const SEVERITY_TONE: Record<NoticeSeverity, Tone> = { action_needed: "warn", heads_up: "info", fyi: "neutral" };

/** A link that looks like the design-system Button (the variant and size classes are added per action). */
const linkBase = "inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap no-underline select-none transition-colors duration-(--dur-fast)";

/** What a notice button does, as data (tested without a DOM). Unknown or unsafe actions do nothing. */
export type NoticeIntent = { kind: "navigate"; path: string } | { kind: "open_eddy"; ref: { kind: "notice"; noticeId: string } | { kind: "message"; messageId: string } } | null;

export function intentFor(notice: Pick<NoticeDTO, "id">, action: NoticeAction): NoticeIntent {
  if (action.kind === "navigate") {
    const path = safeAppPath(action.path);
    return path ? { kind: "navigate", path } : null;
  }
  // A notice button only refers to its own notice; a card is built fresh by Eddy on the server from that reference.
  if (action.kind === "open_eddy") return { kind: "open_eddy", ref: action.ref.kind === "message" ? action.ref : { kind: "notice", noticeId: notice.id } };
  if (action.kind === "card") return { kind: "open_eddy", ref: { kind: "notice", noticeId: notice.id } };
  return null;
}

/** Runs a notice intent: navigation through the app router, or opening Eddy with the id reference. */
export function runNoticeIntent(intent: NoticeIntent, navigate: (path: string) => void): void {
  if (!intent) return;
  if (intent.kind === "navigate") navigate(intent.path);
  else openEddy({ ref: intent.ref });
}

/** Text with `backtick` spans shown as inline code (template names); everything else stays plain, escaped text. */
export function NoticeText({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 && i < parts.length - 1 ? (
          <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[0.92em]">
            {part}
          </code>
        ) : (
          <span key={i}>{i % 2 === 1 ? `\`${part}` : part}</span>
        ),
      )}
    </>
  );
}

export type NoticeListViewProps = {
  notices: readonly NoticeDTO[];
  lang: EddyLang;
  expanded: boolean;
  onToggle: () => void;
  onAction: (notice: NoticeDTO, action: NoticeAction) => void;
  onDismiss: (id: string) => void;
  onMute: (id: string) => void;
  /** The last change, announced politely ("Dismissed."). */
  message?: string;
};

function NoticeItem({ n, lang, onAction, onDismiss, onMute }: { n: NoticeDTO; lang: EddyLang } & Pick<NoticeListViewProps, "onAction" | "onDismiss" | "onMute">) {
  const text = noticeText(lang, n);
  const deva = lang === "hi" || isMostlyDevanagari(text);
  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background p-3" data-notice-id={n.id} data-notice-kind={n.kind}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Badge tone={SEVERITY_TONE[n.severity]} dot className="self-start">
            {tn(lang, `notices.severity.${n.severity}`)}
          </Badge>
          <p className={cn("min-w-0 break-words text-foreground", deva ? "text-base leading-[1.6]" : "text-sm")} lang={htmlLang(lang)}>
            <NoticeText text={text} />
          </p>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(n.id)}
          aria-label={tn(lang, "notices.dismiss.a11y")}
          title={tn(lang, "notices.dismiss")}
          className="-mr-1 -mt-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground"
          data-notice-dismiss
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {n.actions.map((a, i) => {
          const key = `${a.kind}-${a.labelKey}-${i}`;
          const variant = i === 0 ? "secondary" : "ghost";
          const label = translateKey(lang, a.labelKey, {}, t(lang, "btn.open"));
          // A navigation is a real link to its /app page (9.4 scenario 9); the tap still goes through the app router.
          const path = a.kind === "navigate" ? safeAppPath(a.path) : null;
          return path ? (
            <a
              key={key}
              href={path}
              className={cn(linkBase, buttonVariants[variant], buttonSizes.sm, "max-w-full pointer-coarse:min-h-11")}
              onClick={(e) => {
                e.preventDefault();
                onAction(n, a);
              }}
              data-notice-action={a.kind}
            >
              {label}
            </a>
          ) : (
            <Button key={key} type="button" size="sm" variant={variant} className="max-w-full pointer-coarse:min-h-11" onClick={() => onAction(n, a)} data-notice-action={a.kind}>
              {label}
            </Button>
          );
        })}
        <Button type="button" size="sm" variant="ghost" className="max-w-full text-muted pointer-coarse:min-h-11" onClick={() => onMute(n.id)} data-notice-mute>
          {t(lang, "btn.dismiss")}
        </Button>
      </div>
    </article>
  );
}

/** The strip itself, from props (rendered on the server in tests, in light and dark). Nothing to show renders nothing. */
export function NoticeListView({ notices, lang, expanded, onToggle, onAction, onDismiss, onMute, message }: NoticeListViewProps) {
  const headingId = useId();
  if (notices.length === 0) {
    return message ? (
      <p role="status" aria-live="polite" className="sr-only">
        {message}
      </p>
    ) : null;
  }
  const shown = expanded ? notices : notices.slice(0, STRIP_LIMIT);
  const more = notices.length - STRIP_LIMIT;
  return (
    <section aria-labelledby={headingId} lang={htmlLang(lang)} className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-raised p-3 shadow-raised" data-eddy-notices>
      <h3 id={headingId} className="text-sm font-semibold tracking-tight">
        {tn(lang, "notices.strip.title")}
      </h3>
      <ul className="flex min-w-0 flex-col gap-2">
        {shown.map((n) => (
          <li key={n.id} className="min-w-0">
            <NoticeItem n={n} lang={lang} onAction={onAction} onDismiss={onDismiss} onMute={onMute} />
          </li>
        ))}
      </ul>
      {more > 0 && (
        <Button type="button" size="sm" variant="ghost" className="self-start pointer-coarse:min-h-11" aria-expanded={expanded} onClick={onToggle} data-notice-see-all>
          {expanded ? tn(lang, "notices.strip.less") : `${t(lang, "btn.see_all")} (${tn(lang, "notices.strip.more", { count: more })})`}
        </Button>
      )}
      <p role="status" aria-live="polite" className={message ? "text-xs text-muted" : "sr-only"}>
        {message ?? ""}
      </p>
    </section>
  );
}

/** The strip with its data: the shared notices store, kept fresh by useNoticesPoller in EddyRoot. */
export function NoticeList({ lang, onNavigate }: { lang: EddyLang; onNavigate: (path: string) => void }) {
  const { notices, dismiss, mute, markSeen, refresh, loadedAt } = useNotices();
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const seen = useRef(new Set<string>());

  // The strip loads with Eddy (on open), so a member never waits a full minute for the first list.
  useEffect(() => {
    if (loadedAt === null) void refresh();
  }, [loadedAt, refresh]);

  // Notices on screen are marked seen once (the receipt keeps the first time).
  const shown = expanded ? notices : notices.slice(0, STRIP_LIMIT);
  useEffect(() => {
    for (const n of shown) {
      if (n.seenAt || seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      void markSeen(n.id);
    }
  }, [shown, markSeen]);

  return (
    <NoticeListView
      notices={notices}
      lang={lang}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      message={message}
      onAction={(n, a) => runNoticeIntent(intentFor(n, a), onNavigate)}
      onDismiss={(id) => void dismiss(id).then((ok) => setMessage(tn(lang, ok ? "notices.dismissed" : "notices.update_failed")))}
      onMute={(id) => void mute(id).then((ok) => setMessage(tn(lang, ok ? "notices.muted" : "notices.update_failed")))}
    />
  );
}

"use client";

/**
 * Action cards in Eddy's replies (docs/EDDY-SPEC.md 6.3, 6.8, 6.14, 6.15, 12.1a decisions 0 and 10): a titled card with an
 * optional styled body, a row of buttons, next-step navigate chips, and, only when the server provides one, a clearly
 * labelled "Opens Meta" link for the few screens Meta offers no API for (adding a payment method after 131042, business
 * verification, display-name review).
 *
 * Every word comes from the caller, which renders it from the catalogue. Navigate chips accept only allowlisted /app paths
 * (safeAppPath); a path it refuses shows no chip. Meta links accept only a known screen and an https URL, and they are
 * built by server code, never from model text; this file names no Meta host.
 */
import { useId, type ReactNode } from "react";
import { Button, cn, type Tone } from "@/components/ui";
import { safeAppPath } from "@/lib/eddy/contract";
import { htmlLang, t, type EddyLang } from "@/lib/eddy/i18n";
import { cardTextClass, SafeMarkdown } from "./SafeMarkdown";
import { StatusChip } from "./StatusChip";

export type ActionButton = {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  /** A full sentence for screen readers when the visible label is short. */
  ariaLabel?: string;
};

export type NavChip = { path: string; label: string };

export const META_SCREENS = ["payment_method", "business_verification", "display_name"] as const;
export type MetaScreen = (typeof META_SCREENS)[number];
export type MetaLink = { screen: MetaScreen; url: string };

/** A server-provided Meta link, checked: a known screen and a plain https URL with no credentials. Otherwise null. */
export function safeMetaLink(link: unknown): MetaLink | null {
  if (!link || typeof link !== "object") return null;
  const { screen, url } = link as Record<string, unknown>;
  if (typeof screen !== "string" || !(META_SCREENS as readonly string[]).includes(screen)) return null;
  if (typeof url !== "string" || url.length > 1024) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
    return { screen: screen as MetaScreen, url: u.toString() };
  } catch {
    return null;
  }
}

/** Only chips whose path passes the /app allowlist. */
export function safeChips(chips: readonly NavChip[] | undefined): NavChip[] {
  return (chips ?? []).flatMap((c) => {
    const path = safeAppPath(c?.path);
    return path && typeof c.label === "string" && c.label ? [{ path, label: c.label }] : [];
  });
}

const chipClass =
  "inline-flex min-h-9 items-center gap-1 rounded-full border border-border-strong bg-raised px-3 text-xs font-semibold text-foreground no-underline shadow-raised transition-colors duration-(--dur-fast) hover:bg-surface-2 pointer-coarse:min-h-11";

/** Next-step chips that navigate inside the app when tapped (Eddy never navigates on its own). */
export function NavChips({ chips, onNavigate, className }: { chips: readonly NavChip[]; onNavigate?: (path: string) => void; className?: string }) {
  const safe = safeChips(chips);
  if (safe.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)} data-eddy-chips>
      {safe.map((c) => (
        <a
          key={`${c.path}|${c.label}`}
          href={c.path}
          className={chipClass}
          data-eddy-nav-chip
          onClick={
            onNavigate
              ? (e) => {
                  e.preventDefault();
                  onNavigate(c.path);
                }
              : undefined
          }
        >
          {c.label}
          <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true" focusable="false">
            <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      ))}
    </div>
  );
}

/** The labelled "Opens Meta" link (decision 10). Renders nothing for a link that fails safeMetaLink. */
export function MetaLinkButton({ link, lang }: { link: unknown; lang: EddyLang }) {
  const safe = safeMetaLink(link);
  if (!safe) return null;
  const label = t(lang, `meta.screen.${safe.screen}`);
  const opens = t(lang, "link.opens_meta");
  return (
    <div className="flex flex-col gap-1" data-eddy-meta>
      <a href={safe.url} target="_blank" rel="noopener noreferrer external" className={chipClass} aria-label={`${label} (${opens})`} data-eddy-meta-link>
        {label}
        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[0.7rem] font-medium text-muted">{opens}</span>
        <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true" focusable="false">
          <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
      <p className="text-xs text-muted">{t(lang, "meta.screen.note")}</p>
    </div>
  );
}

const TONE_FRAME: Record<Tone, string> = {
  neutral: "border-border bg-raised",
  info: "border-border bg-raised",
  good: "border-good-line bg-raised",
  warn: "border-warn-line bg-warn-soft",
  bad: "border-bad-line bg-bad-soft",
};

export type ActionCardProps = {
  lang: EddyLang;
  title: string;
  /** Catalogue text, rendered through SafeMarkdown. */
  body?: string;
  tone?: Tone;
  chip?: { tone: Tone; label: string };
  buttons?: readonly ActionButton[];
  chips?: readonly NavChip[];
  metaLink?: unknown;
  onNavigate?: (path: string) => void;
  children?: ReactNode;
  className?: string;
  headingId?: string;
};

/**
 * Where the owner switches Eddy on (12.1a decision 6: one tap in Settings). The shell may pass its own path. It is the
 * Eddy card on Settings > AI tools (src/app/(app)/app/settings/ai-tools/page.tsx, EddySettingsCard, anchor #eddy), the same
 * page EnableCard's EDDY_SETTINGS_PAGE opens; there is no /app/settings/eddy page.
 */
export const EDDY_SETTINGS_PATH = "/app/settings/ai-tools#eddy";

export type TurnOnEddyCardProps = {
  lang: EddyLang;
  /** Only the owner turns Eddy on; the tap records the AI-processing consent (12.1a decision 6). */
  isOwner: boolean;
  /** The owner's name(s), for "Ask the owner: {names}" (EddyStatusDTO.ownerNames). */
  ownerNames: readonly string[];
  /** Credits one message can use at most, and one person a day (EDDY_DEFAULTS). */
  perTurn: number;
  perDay: number;
  /** The owner's tap. Without it the owner gets a chip to Settings instead. */
  onTurnOn?: () => void;
  onNotNow?: () => void;
  busy?: boolean;
  settingsPath?: string;
  onNavigate?: (path: string) => void;
  className?: string;
};

/**
 * The short "Turn on Eddy" card the launcher shows while Eddy is off for the workspace (12.1a decision 6): what Eddy does
 * and what it costs in AI credits. The owner gets [Turn on Eddy] (or a chip to Settings); everyone else is told who can.
 */
export function TurnOnEddyCard({ lang, isOwner, ownerNames, perTurn, perDay, onTurnOn, onNotNow, busy, settingsPath = EDDY_SETTINGS_PATH, onNavigate, className }: TurnOnEddyCardProps) {
  const cost = t(lang, "turnon.cost", { perTurn: perTurn.toLocaleString("en-IN"), perDay: perDay.toLocaleString("en-IN") });
  const next = isOwner ? [...(onTurnOn ? [] : [t(lang, "turnon.where")]), t(lang, "turnon.consent")] : [t(lang, "turnon.ask_owner", { names: ownerNames.join(", ") || "—" })];
  const body = [t(lang, "turnon.what"), cost, ...next].join("\n\n");
  const buttons: ActionButton[] = isOwner && onTurnOn ? [{ id: "turn-on", label: t(lang, "btn.turn_on"), variant: "primary", onClick: onTurnOn, loading: busy }, ...(onNotNow ? [{ id: "not-now", label: t(lang, "btn.not_now"), variant: "secondary" as const, onClick: onNotNow, disabled: busy }] : [])] : [];
  const chips: NavChip[] = isOwner && !onTurnOn ? [{ path: settingsPath, label: t(lang, "btn.eddy_settings") }] : [];
  return <ActionCard lang={lang} title={t(lang, "turnon.title")} body={body} buttons={buttons} chips={chips} onNavigate={onNavigate} className={className} />;
}

export function ActionCard({ lang, title, body, tone = "neutral", chip, buttons = [], chips, metaLink, onNavigate, children, className, headingId }: ActionCardProps) {
  const generated = useId();
  const id = headingId ?? `eddy-ac-${generated}`;
  return (
    <section role="group" aria-labelledby={id} lang={htmlLang(lang)} className={cn("rounded-card border p-4 shadow-raised", TONE_FRAME[tone], className)} data-eddy-action-card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={id} className={cn("min-w-0 flex-1 font-semibold", cardTextClass(lang, title))}>
          {title}
        </h3>
        {chip && <StatusChip tone={chip.tone} label={chip.label} />}
      </div>
      {body && <SafeMarkdown text={body} lang={lang} onNavigate={onNavigate} className="mt-1.5 text-foreground" />}
      {children && <div className="mt-2">{children}</div>}
      {buttons.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap" data-eddy-buttons>
          {buttons.map((b) => (
            <Button key={b.id} variant={b.variant ?? "secondary"} onClick={b.onClick} disabled={b.disabled} loading={b.loading} aria-label={b.ariaLabel} className="w-full min-h-11 sm:w-auto">
              {b.label}
            </Button>
          ))}
        </div>
      )}
      {chips && chips.length > 0 && <NavChips chips={chips} onNavigate={onNavigate} className="mt-3" />}
      {metaLink !== undefined && (
        <div className="mt-3">
          <MetaLinkButton link={metaLink} lang={lang} />
        </div>
      )}
    </section>
  );
}

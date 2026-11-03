"use client";

/**
 * What the panel shows instead of the transcript and composer when Eddy can't chat (docs/EDDY-SPEC.md 5.11, 6.11, 6.14,
 * 12.1a decision 6). There is never an input box in an off state, so nothing pretends to be a chat.
 *
 * | State            | Shows                                                                                         |
 * |------------------|-----------------------------------------------------------------------------------------------|
 * | platform_off     | off.platform, or off.platform_paused when the Edwyz team paused it; the setup list; notices   |
 * | locked           | Admins: "Your plan has ended…" with [Go to billing]. Team members: ask the admin to renew      |
 * | workspace_off    | The "Turn on Eddy" card: the owner's one-tap switch, or the owner's name for everyone else     |
 * | paused           | Phase 0's freeze copy                                                                          |
 * | allowance_used   | This month's (or today's) AI limit is used up, when it resets; admins get [See spending limits] |
 * | user_capped      | Today's Eddy limit is used, it resets tomorrow                                                  |
 * | offline / error  | "You're offline." / the status couldn't be loaded, with [Retry]                                |
 *
 * Plain buttons that need no AI stay available (6.11): the guided setup (guides/SetupGuide.tsx: step cards from
 * GET /api/setup, each with its reason, minutes, a button to the page that does it, and Skip for now), the notices (a slot
 * the notices package fills), the cards and done rows already on screen (a slot: they can still be confirmed or undone),
 * and "Go to" buttons for the pages the starter chips would have used. The guide shows in platform_off, paused,
 * allowance_used and user_capped (6.11), so nobody is stranded while Eddy can't chat.
 */
import { useId, type ReactNode } from "react";
import { Alert, Button, cn, Spinner } from "@/components/ui";
import type { EddyStatusDTO } from "@/lib/eddy/contract";
import { tp } from "@/lib/eddy/copy/panel";
import { htmlLang, spendMessage, t, type EddyLang } from "@/lib/eddy/i18n";
import { useSetup } from "@/components/setup/useSetup";
import { NavChips } from "./ActionCard";
import { EnableCardController } from "./EnableCard";
import { SPENDING_PATH } from "./PreviewCard";
import { ProgressSteps, type ProgressStep } from "./ProgressSteps";
import { GotoButtons } from "./StarterChips";
import { SetupGuide } from "./guides/SetupGuide";
import { historyDaysOf, type StatusError } from "./useEddyStatus";

export type OffKind = "platform_off" | "locked" | "workspace_off" | "paused" | "allowance_used" | "user_capped" | "offline" | "error";

export const BILLING_PATH = "/app/billing";

/** Which off state applies, or null when Eddy can chat (or the first status load is still running). */
export function offKindOf(status: EddyStatusDTO | null, error: StatusError | null): OffKind | null {
  if (error === "offline") return "offline";
  if (!status) return error ? "error" : null;
  return status.state === "ready" ? null : status.state;
}

/** "1 Nov" for an ISO date, the way Phase 0's copy writes dates. */
export function resetDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
}

/**
 * True when today's AI limit, not the month's, is the one used up. The server's `period` decides (it uses the same threshold
 * as the gate: less left than the smallest possible turn); the figures are the fallback for an older server.
 */
export function dayLimitUsed(status: Pick<EddyStatusDTO, "allowance">): boolean {
  const a = status.allowance;
  if (a.period === "day") return true;
  if (a.period === "month") return false;
  const dayUsed = a.limitToday !== null && a.usedToday >= a.limitToday;
  const monthUsed = a.limitMonth !== null && a.usedMonth >= a.limitMonth;
  return dayUsed && !monthUsed;
}

const isAdminRole = (role: string) => role === "owner" || role === "admin";

/** The off state's sentence in the member's language. */
export function offText(lang: EddyLang, kind: OffKind, status: EddyStatusDTO | null, role: string): string {
  switch (kind) {
    case "platform_off":
      return t(lang, status?.reason === "paused" ? "off.platform_paused" : "off.platform");
    case "locked":
      return t(lang, isAdminRole(role) ? "locked.admin" : "locked.agent");
    case "workspace_off":
      return t(lang, "off.workspace.agent", { names: status?.ownerNames.join(", ") || "—" });
    case "paused":
      return spendMessage(lang, "spend.frozen");
    case "allowance_used": {
      if (status && dayLimitUsed(status)) return t(lang, "allowance.used_today");
      const date = resetDate(status?.allowance.resetsOn);
      return date ? t(lang, "allowance.used", { date }) : t(lang, "allowance.used_today");
    }
    case "user_capped":
      return t(lang, "user_capped");
    case "offline":
      return t(lang, "offline");
    case "error":
      return t(lang, "status_error");
  }
}

const TONE: Record<OffKind, "neutral" | "info" | "warn" | "bad"> = {
  platform_off: "info",
  locked: "bad",
  workspace_off: "info",
  paused: "warn",
  allowance_used: "warn",
  user_capped: "warn",
  offline: "warn",
  error: "warn",
};

/** The setup checklist from GET /api/setup, as progress steps with a button for the next step. No model call. */
export function SetupList({ lang }: { lang: EddyLang }) {
  const setup = useSetup();
  const titleId = useId();
  // The steps asked of the owner, counted as the setup page counts them ("3 of 4 done"), not every optional extra.
  const steps = setup.data?.steps.filter((s) => !s.dismissed && s.state !== "optional") ?? [];
  const nextId = setup.data?.summary.nextStepId ?? null;
  const progress: ProgressStep[] = steps.map((s) => ({ id: s.id, label: s.title, state: s.state === "done" ? "done" : s.id === nextId ? "current" : "todo" }));
  const next = steps.find((s) => s.id === nextId);
  return (
    <section aria-labelledby={titleId} className="rounded-card border border-border bg-raised p-4 shadow-raised" data-eddy-setup>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={titleId} className="text-sm font-semibold" lang={htmlLang(lang)}>
          {tp(lang, "panel.setup.title")}
        </h3>
        {setup.data && (
          <span className="text-xs text-muted" lang={htmlLang(lang)}>
            {tp(lang, "panel.setup.progress", { done: setup.data.summary.done, total: setup.data.summary.asked })}
          </span>
        )}
      </div>
      {setup.loading && !setup.data ? (
        <Spinner label={tp(lang, "panel.setup.loading")} />
      ) : setup.error && !setup.data ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted" lang={htmlLang(lang)}>
          <span>{tp(lang, "panel.setup.failed")}</span>
          <Button type="button" variant="secondary" size="sm" className="pointer-coarse:min-h-11" onClick={setup.reload}>
            {t(lang, "btn.retry")}
          </Button>
        </div>
      ) : setup.data?.summary.complete ? (
        <p className="text-sm text-muted" lang={htmlLang(lang)}>
          {tp(lang, "panel.setup.complete")}
        </p>
      ) : (
        <>
          {/* The step titles come from the setup checklist, which the app writes in English. */}
          <ProgressSteps steps={progress} lang="en" label={tp(lang, "panel.setup.title")} />
          {next && <NavChips chips={[{ path: next.href, label: next.cta }]} className="mt-3" />}
        </>
      )}
    </section>
  );
}

export type OffStateProps = {
  kind: OffKind;
  lang: EddyLang;
  status: EddyStatusDTO | null;
  role: string;
  pageId?: string | null;
  onNavigate?: (path: string) => void;
  onRetry?: () => void;
  /** The owner switched Eddy on: reload the status. */
  onEnabled?: () => void;
  /** [Not now] on the Turn on Eddy card. */
  onNotNow?: () => void;
  /** The "Needs you" notices (filled by the notices package). */
  notices?: ReactNode;
  /** Cards and done rows already on screen; they keep working without the AI. */
  onScreen?: ReactNode;
  /** Replaces the live setup list (tests, or a caller that already has it). */
  setup?: ReactNode;
  className?: string;
};

export function OffState({ kind, lang, status, role, pageId, onNavigate, onRetry, onEnabled, onNotNow, notices, onScreen, setup, className }: OffStateProps) {
  const admin = isAdminRole(role);
  const plain = kind === "platform_off" || kind === "paused" || kind === "allowance_used" || kind === "user_capped";
  const showSetup = kind === "platform_off" || kind === "paused" || kind === "allowance_used" || kind === "user_capped";
  const text = offText(lang, kind, status, role);

  return (
    <div className={cn("flex flex-col gap-4", className)} data-eddy-off={kind} lang={htmlLang(lang)}>
      {kind === "workspace_off" ? (
        <EnableCardController lang={lang} canEnable={status?.canEnable === true} ownerNames={status?.ownerNames ?? []} historyDays={historyDaysOf(status)} onEnabled={onEnabled ?? (() => undefined)} onNotNow={onNotNow} onNavigate={onNavigate} />
      ) : (
        <Alert
          tone={TONE[kind]}
          action={
            kind === "offline" || kind === "error" ? (
              <Button type="button" variant="secondary" size="sm" className="pointer-coarse:min-h-11" onClick={onRetry}>
                {t(lang, "btn.retry")}
              </Button>
            ) : undefined
          }
        >
          <span className={lang === "hi" ? "text-base leading-[1.6]" : undefined}>{text}</span>
        </Alert>
      )}

      {kind === "locked" && admin && <NavChips chips={[{ path: BILLING_PATH, label: t(lang, "btn.go_to_billing") }]} onNavigate={onNavigate} />}
      {kind === "allowance_used" && admin && <NavChips chips={[{ path: SPENDING_PATH, label: t(lang, "btn.see_spending_limits") }]} onNavigate={onNavigate} />}

      {notices}

      {onScreen && (
        <section aria-label={tp(lang, "panel.on_screen")} className="flex flex-col gap-3" data-eddy-on-screen>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{tp(lang, "panel.on_screen")}</h3>
          {onScreen}
        </section>
      )}

      {showSetup && (setup ?? <SetupGuide lang={lang} role={role} canChat={false} onNavigate={onNavigate} />)}
      {plain && <GotoButtons lang={lang} pageId={pageId} onNavigate={onNavigate} />}
    </div>
  );
}

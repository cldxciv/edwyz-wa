"use client";

/**
 * ReadinessList (docs/IG-PAGE-ADS-SPEC.md 3.2, 7.3, 8.3a, D19, D20): a goal's setup checklist, shown inline on the chosen goal
 * card and on the review card.
 *
 * Each row has an ok, missing or unknown icon with its words (never colour alone) and exactly one fix:
 * - an in-app action: "Run on Facebook only", re-check Meta's lead ad terms, "Run Instagram ads using your Page" and "Create a
 *   pixel" (both after a confirm, since Meta can't undo them);
 * - Reconnect, through the Facebook Login popup (D20), after which the list checks again;
 * - OpensMetaButton, with the address the server resolved from the allowlist (8.4);
 * - a settings page, or "Ask {owner}".
 * A warning row (an unknown that waits on a VERIFY step) says it won't stop the ads.
 */
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, buttonVariants, cn, confirm, CopyButton, Spinner } from "@/components/ui";
import type { GoalKey, PromoteLang } from "@/lib/promote/types";
import { useFacebookLoginPopup } from "@/components/meta-connect/useFacebookLoginPopup";
import { OpensMetaButton } from "./OpensMetaButton";
import { errorText, orderedRows, PROMOTE_TEST_IDS, READINESS_STATUS_KEYS, readinessRun, type ReadinessRowDto } from "./flow-helpers";
import { jsonRequest } from "./usePromoteDraft";
import { usePromoteCopy } from "./usePromoteCopy";

export type ReadinessQuery = {
  placements?: "auto" | "instagram" | "facebook";
  nearShop?: boolean;
  pageAssetId?: string | null;
  igAssetId?: string | null;
};

/** GET /api/promote/prereqs for a goal (check_promotion_setup). */
export function prereqsHref(goal: GoalKey, q: ReadinessQuery = {}): string {
  const p = new URLSearchParams({ goal, lang: "en" });
  if (q.placements) p.set("placements", q.placements);
  if (q.nearShop) p.set("nearShop", "1");
  if (q.pageAssetId) p.set("pageAssetId", q.pageAssetId);
  if (q.igAssetId) p.set("igAssetId", q.igAssetId);
  return `/api/promote/prereqs?${p.toString()}`;
}

/** The goal's rows, loaded when the goal or the query changes, and again on refresh(). */
export function useReadiness(goal: GoalKey | null, q: ReadinessQuery = {}, lang: PromoteLang = "en") {
  const [rows, setRows] = useState<ReadinessRowDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const href = goal ? prereqsHref(goal, q) : null;
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!href) return;
    const id = ++seq.current;
    setLoading(true);
    const res = await jsonRequest("GET", href);
    if (id !== seq.current) return;
    setLoading(false);
    const body = res.body && typeof res.body === "object" ? (res.body as { rows?: unknown }) : {};
    if (res.status === 200 && Array.isArray(body.rows)) {
      setRows(body.rows as ReadinessRowDto[]);
      setError(null);
    } else setError(errorText(res.body, "media.picker.load_failed", lang));
  }, [href, lang]);
  useEffect(() => {
    setRows(null);
    void refresh();
  }, [refresh]);
  const ready = !!rows && !rows.some((r) => r.blocks);
  return { rows, loading, error, refresh, ready };
}

export type ReadinessListProps = {
  rows: readonly ReadinessRowDto[] | null;
  loading?: boolean;
  error?: string | null;
  /** Load the rows again (after a fix, a popup, or [I've accepted]). */
  onRefresh: () => void;
  /** "Run on Facebook only". */
  onFacebookOnly?: () => void;
  pageAssetId?: string | null;
  pageName?: string | null;
  /** Show the rows that are ready too (the goal card shows only what needs a fix). */
  showOk?: boolean;
  lang?: PromoteLang;
  className?: string;
};

function StatusIcon({ status }: { status: ReadinessRowDto["status"] }) {
  if (status === "ok") {
    return (
      <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0 text-good-fg" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "missing") {
    return (
      <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0 text-bad-fg" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.5v4.2M8 11.2v.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0 text-warn-fg" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.3 6.2a1.8 1.8 0 113 1.4c-.6.4-1.3.8-1.3 1.7M8 11.3v.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const fixButton = cn(
  "inline-flex min-h-11 max-w-full items-center justify-center rounded-full px-4 py-2 text-left text-sm font-semibold transition-colors duration-(--dur-fast)",
  buttonVariants.secondary,
);

export function ReadinessList({ rows, loading, error, onRefresh, onFacebookOnly, pageAssetId, pageName, showOk = false, lang = "en", className }: ReadinessListProps) {
  const t = usePromoteCopy(lang);
  const statusId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pixelCode, setPixelCode] = useState<string | null>(null);
  const login = useFacebookLoginPopup({ onResult: () => onRefresh() });

  useEffect(() => {
    setNote(null);
  }, [rows]);

  const post = useCallback(
    async (key: string, url: string, body: Record<string, unknown>, question: { title: string; confirmLabel: string }) => {
      const ok = await confirm({ title: question.title, confirmLabel: question.confirmLabel, cancelLabel: t("card.cancel"), tone: "danger" });
      if (!ok) return;
      setBusy(key);
      const res = await jsonRequest("POST", url, body);
      setBusy(null);
      if (res.status >= 200 && res.status < 300) {
        // POST /api/promote/pixel answers { pixel: { code } }: the install code, shown with [Copy code].
        const pixel = res.body && typeof res.body === "object" ? (res.body as { pixel?: { code?: unknown } | null }).pixel : null;
        if (pixel && typeof pixel.code === "string" && pixel.code.trim()) setPixelCode(pixel.code);
        setNote(t("readiness.done"));
        onRefresh();
      } else setNote(errorText(res.body, "flow.create_failed", lang));
    },
    [lang, onRefresh, t],
  );

  if (loading && !rows) return <Spinner label={t("readiness.checking")} />;
  if (error && !rows) {
    return (
      <div className={cn("flex flex-col items-start gap-2", className)} role="alert">
        <p className="text-sm text-bad-fg">{error}</p>
        <Button type="button" variant="secondary" className="pointer-coarse:min-h-11" onClick={onRefresh}>
          {t("media.picker.retry")}
        </Button>
      </div>
    );
  }
  const shown = orderedRows((rows ?? []).filter((r) => showOk || r.status !== "ok"));
  if (!shown.length) {
    return (
      <p className={cn("flex items-center gap-2 text-sm text-muted", className)} data-testid={PROMOTE_TEST_IDS.readiness}>
        <StatusIcon status="ok" />
        {t("readiness.all_ok")}
      </p>
    );
  }

  const fixOf = (row: ReadinessRowDto, index: number) => {
    const run = readinessRun(row.fix);
    const key = `${row.check}-${index}`;
    switch (run.kind) {
      case "opens_meta":
        return <OpensMetaButton href={run.href} screen={run.screen} label={row.fix.label} lang={lang} />;
      case "reconnect":
        return (
          <button type="button" className={fixButton} onClick={() => login.start()} aria-busy={login.phase === "opening" || login.phase === "waiting" || undefined}>
            {row.fix.label}
          </button>
        );
      case "link":
        return (
          <Link href={run.href} className={fixButton}>
            {row.fix.label}
          </Link>
        );
      case "refresh":
        return (
          <button type="button" className={fixButton} onClick={onRefresh}>
            {row.fix.label}
          </button>
        );
      case "facebook_only":
        return onFacebookOnly ? (
          <button type="button" className={fixButton} onClick={onFacebookOnly}>
            {row.fix.label}
          </button>
        ) : null;
      case "create_identity":
        return (
          <button
            type="button"
            className={fixButton}
            aria-busy={busy === key || undefined}
            disabled={busy !== null || !pageAssetId}
            onClick={() => void post(key, "/api/promote/fix/instagram-identity", { pageAssetId }, { title: t("readiness.identity_confirm", { page: pageName?.trim() || t("picker.page") }), confirmLabel: t("readiness.identity_create") })}
          >
            {row.fix.label}
          </button>
        );
      case "create_pixel":
        return (
          <button
            type="button"
            className={fixButton}
            aria-busy={busy === key || undefined}
            disabled={busy !== null}
            onClick={() => void post(key, "/api/promote/pixel", { name: pageName?.trim() || t("readiness.pixel_name") }, { title: t("readiness.pixel_confirm"), confirmLabel: t("readiness.pixel_create") })}
          >
            {row.fix.label}
          </button>
        );
      case "note":
        return <p className="text-sm text-muted">{run.text}</p>;
    }
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} data-testid={PROMOTE_TEST_IDS.readiness}>
      <ul className="flex flex-col gap-3" aria-describedby={statusId}>
        {shown.map((row, i) => (
          <li key={`${row.check}-${i}`} className="flex min-w-0 items-start gap-2" data-testid={PROMOTE_TEST_IDS.readinessRow} data-check={row.check} data-status={row.status}>
            <StatusIcon status={row.status} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="text-sm font-medium break-words">
                {row.label}
                <span className="sr-only">: {t(READINESS_STATUS_KEYS[row.status])}</span>
              </p>
              {row.detail && <p className="text-sm text-muted break-words">{row.detail}</p>}
              {row.warningOnly && row.status !== "ok" && <p className="text-xs text-muted">{t("readiness.warning_note")}</p>}
              {row.status !== "ok" && (
                <div className="flex flex-wrap items-start gap-2">
                  {fixOf(row, i)}
                  {row.more
                    .filter((m) => m.kind !== "in_app" || m.key !== "recheck_leadgen_terms" || row.fix.kind === "opens_meta")
                    .map((m, j) => {
                      const extra = { ...row, fix: m } as ReadinessRowDto;
                      return <span key={`${m.kind}-${j}`}>{fixOf(extra, i * 10 + j + 1)}</span>;
                    })}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p id={statusId} role="status" aria-live="polite" className="text-sm text-muted">
        {note}
      </p>
      {pixelCode && (
        <div className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-surface p-3">
          <p className="text-sm">{t("readiness.pixel_install")}</p>
          <pre className="max-h-40 overflow-auto rounded-md bg-surface-2 p-2 text-xs break-all whitespace-pre-wrap">{pixelCode}</pre>
          <CopyButton value={pixelCode} label={t("readiness.copy_code")} />
        </div>
      )}
    </div>
  );
}

export default ReadinessList;

"use client";

/**
 * PromoteTiles (docs/IG-PAGE-ADS-SPEC.md 7.1, 7.3; PRM-15b): the Ads page's tiles row, the running promotions with a status
 * chip and [Pause], and the drafts with [Resume] and [Discard] (Undo for 15 minutes).
 *
 * - The tiles: "Boost a post", "Get WhatsApp chats", "Get leads", then "More goals" and "All settings (advanced)", which is the
 *   old wizard at /app/ads/new (D2, D5). Their names never repeat the old list's buttons ("New campaign", "Create a campaign",
 *   "Connect ad account"), so e2e/growth-ads.spec.ts finds exactly what it did before.
 * - [Pause] is the existing POST /api/ads/campaigns/[id]/pause, a lowering that is never refused.
 * - [Discard] is DELETE /api/promote/drafts/[id], a soft discard; [Undo] is PATCH { restore: true } while the server still
 *   restores it (15 minutes).
 * CampaignsView mounts it only when promoteAccess says the feature is visible to this member. The rows come from the list
 * CampaignsView already loads, so the tiles add no request of their own.
 */
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Button, StatusPill, apiFetch, cn, toast } from "@/components/ui";
import { formatMinor } from "@/components/ads/helpers";
import { LinkButton } from "@/components/ads/LinkButton";
import { AUDIENCES_PATH, TILES_TEXT, draftHref, editLabel, promoteTiles, promotionChip, promotionDrafts, runningPromotions, undoOpen, type PromotionItem } from "./results-helpers";
import { promoteText } from "@/lib/promote/copy";

export const PROMOTE_TILES_TEST_ID = "promote-tiles";

export type PromoteTilesProps = {
  /** The rows of GET /api/ads/campaigns. */
  campaigns: readonly PromotionItem[];
  /** The goals open to this member (promoteAccess.goals); a goal tile shows only while its goal is offered. */
  goals?: readonly string[] | null;
  /** Owners and admins: pause and discard. */
  canWrite?: boolean;
  /** Reload the list after a change. */
  onChanged?: () => void;
  className?: string;
};

type Discarded = { id: string; name: string; until: string };

const tileClass = cn(
  "flex h-full min-h-24 flex-col gap-1 rounded-card border border-border bg-raised p-4 text-left shadow-raised no-underline transition-colors duration-(--dur-fast)",
  "hover:border-accent hover:bg-surface-2",
);

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden="true" focusable="false">
      <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PromoteTiles({ campaigns, goals, canWrite = true, onChanged, className }: PromoteTilesProps) {
  const headingId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState<Discarded[]>([]);
  const [status, setStatus] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const tiles = promoteTiles(goals);
  const running = runningPromotions(campaigns);
  const hidden = new Set(discarded.map((d) => d.id));
  const drafts = promotionDrafts(campaigns).filter((d) => !hidden.has(d.id));
  const undoable = discarded.filter((d) => undoOpen(d.until, new Date(now)));

  // Undo rows close by themselves once the server would no longer restore the draft.
  useEffect(() => {
    if (discarded.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [discarded.length]);

  async function pause(c: PromotionItem) {
    setBusy(`pause:${c.id}`);
    try {
      await apiFetch(`/api/ads/campaigns/${encodeURIComponent(c.id)}/pause`, { method: "POST" });
      const text = TILES_TEXT.paused(c.name);
      setStatus(text);
      toast.success(text);
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function discard(c: PromotionItem) {
    setBusy(`discard:${c.id}`);
    try {
      const res = await apiFetch<{ restorableUntil?: string }>(`/api/promote/drafts/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      const until = res.restorableUntil ?? new Date(Date.now() + 15 * 60_000).toISOString();
      setDiscarded((list) => [{ id: c.id, name: c.name, until }, ...list.filter((d) => d.id !== c.id)]);
      setNow(Date.now());
      setStatus(TILES_TEXT.discarded(c.name));
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function restore(d: Discarded) {
    setBusy(`undo:${d.id}`);
    try {
      await apiFetch(`/api/promote/drafts/${encodeURIComponent(d.id)}`, { method: "PATCH", body: { restore: true } });
      setDiscarded((list) => list.filter((x) => x.id !== d.id));
      const text = TILES_TEXT.restored(d.name);
      setStatus(text);
      toast.success(text);
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby={headingId} className={cn("mb-6 min-w-0 space-y-4", className)} data-testid={PROMOTE_TILES_TEST_ID}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-base font-semibold tracking-tight">
            {TILES_TEXT.heading}
          </h2>
          <p className="mt-0.5 text-sm text-muted">{TILES_TEXT.intro}</p>
        </div>
        <Link href={AUDIENCES_PATH} className="inline-flex min-h-10 items-center text-sm font-medium underline underline-offset-2" data-testid="promote-audiences-link">
          {TILES_TEXT.audiences}
        </Link>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <li key={t.id} className="min-w-0">
            <Link href={t.href} className={tileClass} data-testid={`promote-tile-${t.id}`}>
              <span className="flex items-center justify-between gap-2 text-sm font-semibold text-foreground">
                <span className="min-w-0 break-words">{t.title}</span>
                <Arrow />
              </span>
              <span className="text-xs text-muted break-words">{t.body}</span>
            </Link>
          </li>
        ))}
      </ul>

      {running.length > 0 && (
        <div className="min-w-0" data-testid="promote-running">
          <h3 className="text-sm font-semibold">{TILES_TEXT.running}</h3>
          <ul className="mt-2 divide-y divide-border rounded-card border border-border bg-raised">
            {running.map((c) => {
              const chip = promotionChip(c);
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-testid={`promote-running-${c.id}`}>
                  <div className="min-w-0 flex-1">
                    <Link href={`/app/ads/${encodeURIComponent(c.id)}`} className="font-medium break-words underline-offset-2 hover:underline">
                      {c.name}
                    </Link>
                    <p className="text-xs text-muted tabular-nums">{TILES_TEXT.perDay(formatMinor(c.totalDailyBudgetMinor, c.currency))}</p>
                  </div>
                  <StatusPill status={c.status} label={chip.label} tone={chip.tone} />
                  {canWrite && c.status === "active" && (
                    <Button size="sm" variant="secondary" loading={busy === `pause:${c.id}`} disabled={busy !== null} aria-label={TILES_TEXT.pauseLabel(c.name)} onClick={() => void pause(c)}>
                      {editLabel("pause")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {drafts.length > 0 && (
        <div className="min-w-0" data-testid="promote-drafts">
          <h3 className="text-sm font-semibold">{TILES_TEXT.drafts}</h3>
          <ul className="mt-2 divide-y divide-border rounded-card border border-border bg-raised">
            {drafts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-testid={`promote-draft-${c.id}`}>
                <span className="min-w-0 flex-1 font-medium break-words">{c.name}</span>
                <LinkButton href={draftHref(c)} variant="secondary" size="sm" aria-label={TILES_TEXT.resumeLabel(c.name)} data-testid={`promote-draft-resume-${c.id}`}>
                  {TILES_TEXT.resume}
                </LinkButton>
                {canWrite && (
                  <Button size="sm" variant="ghost" loading={busy === `discard:${c.id}`} disabled={busy !== null} aria-label={TILES_TEXT.discardLabel(c.name)} onClick={() => void discard(c)}>
                    {TILES_TEXT.discard}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div aria-live="polite" role="status" className="min-w-0 space-y-2 empty:hidden" data-testid="promote-tiles-status">
        {undoable.map((d) => (
          <p key={d.id} className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 break-words">{TILES_TEXT.discarded(d.name)}</span>
            <Button size="sm" variant="secondary" loading={busy === `undo:${d.id}`} disabled={busy !== null} aria-label={TILES_TEXT.undoLabel(d.name)} onClick={() => void restore(d)}>
              {promoteText("edit.undo")}
            </Button>
          </p>
        ))}
        {undoable.length === 0 && status && <span className="sr-only">{status}</span>}
      </div>
    </section>
  );
}

export default PromoteTiles;

"use client";

import { displayName, displaySubtitle } from "@/lib/contacts/identity";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, FormField, Input, ProgressBar, Skeleton, Stat, StatusPill, apiFetch, buttonSizes, buttonVariants, cn, confirm, toast, type Column } from "@/components/ui";
import { PAUSE_COPY, type PauseReasonCode } from "@/lib/broadcasts/pause-copy";
import { FollowUpDialog, type Outcome } from "./FollowUpDialog";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import type { Funnel } from "@/lib/broadcasts/funnel";
import { FunnelChart } from "./OverviewPanels";
import { LinkButton } from "./LinkButton";
import { audienceLabel, broadcastStatusView, errorCodeText, formatWhen, friendlyError, handledCount, isLive, progressPercent, recipientStatusView, scheduleBounds, startCopy, validateSchedule } from "./helpers";

type Recipient = { id: string; status: string; errorCode: string | null; sentAt: string | null; contact: { phone: string | null; bsuid?: string | null; username?: string | null; name: string | null } };
type Detail = {
  broadcast: { id: string; name: string; status: string; segmentTags: string[]; scheduledAt: string | null; retryDays?: number; audienceFilter?: { segmentId?: string; filter?: unknown; fixed?: boolean } | null };
  pauseReason?: { reason: PauseReasonCode; at: string } | null;
  failures?: { code: string; status: string; count: number }[];
  counts: Record<string, number>;
  report: { total: number; sent: number; delivered: number; read: number; failed: number; skipped: number };
  recipients: Recipient[];
  nextCursor: string | null;
};

type Action = "start" | "pause" | "cancel";

const COLUMNS: Column<Recipient>[] = [
  {
    key: "contact",
    header: "Contact",
    primary: true,
    cell: (r) => (
      <div className="min-w-0">
        <span className="font-medium">{displayName(r.contact)}</span>
        {displaySubtitle(r.contact) && <span className="block text-xs text-muted">{displaySubtitle(r.contact)}</span>}
      </div>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (r) => {
      const v = recipientStatusView(r.status);
      return <StatusPill status={r.status} label={v.label} tone={v.tone} />;
    },
  },
  {
    key: "what",
    header: "What happened",
    cell: (r) => {
      if (r.status === "skipped" && r.errorCode) return <span className="text-sm">{errorCodeText(r.errorCode)}</span>;
      if (r.status === "skipped") return <span className="text-sm text-muted">They opted out, or the broadcast was canceled, before their turn.</span>;
      const reason = errorCodeText(r.errorCode);
      if (r.status !== "failed" || !reason) return <span className="text-muted">-</span>;
      return (
        <div className="min-w-0 text-sm">
          <p>{reason}</p>
          {r.errorCode && (
            <details className="mt-0.5 text-xs text-muted">
              <summary className="cursor-pointer">Details</summary>
              <p className="mt-0.5">Reference code: {r.errorCode}</p>
            </details>
          )}
        </div>
      );
    },
  },
  { key: "sent", header: "Sent at", cell: (r) => (r.sentAt ? formatWhen(r.sentAt) : <span className="text-muted">-</span>) },
];

function DetailSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeader title="Broadcast" breadcrumbs={[{ label: "Broadcasts", href: "/app/broadcasts" }, { label: "Loading" }]} />
      <span className="sr-only" role="status">
        Loading broadcast
      </span>
      <Card className="mb-6">
        <Skeleton className="mb-4 h-2.5 w-full" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </Card>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export function BroadcastDetail({ id }: { id: string }) {
  const role = useRole();
  const admin = canManage(role);
  const [pollMs, setPollMs] = useState<number | undefined>(3000);
  const { data, error, loading, reload } = useApi<Detail>(`/api/broadcasts/${id}`, pollMs);
  // A wrong or deleted id answers 404 "Broadcast not found.": say so plainly and stop asking every few seconds.
  const missing = !data && !!error && /not found/i.test(error);
  const funnel = useApi<{ funnel: Funnel }>(missing ? null : `/api/broadcasts/${id}/funnel`, 15_000);
  const [when, setWhen] = useState("");
  const [whenError, setWhenError] = useState<string | null>(null);
  const [extra, setExtra] = useState<Recipient[]>([]);
  const [more, setMore] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<Action | "schedule" | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [followUp, setFollowUp] = useState<Outcome | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const latest = useRef<Detail | null>(null);
  useEffect(() => {
    latest.current = data;
  }, [data]);

  const focusHeading = () => {
    const h1 = page.current?.querySelector("h1");
    if (!h1) return;
    h1.tabIndex = -1;
    h1.focus();
  };

  const status = data?.broadcast.status;
  useEffect(() => {
    setPollMs(missing || (status && !isLive(status)) ? undefined : 3000);
  }, [status, missing]);

  const recipients = data?.recipients;
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return [...(recipients ?? []), ...extra].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }, [recipients, extra]);

  async function act(action: Action, done: string, undo?: { label: string; onAction: () => void }) {
    setBusy(action);
    try {
      await apiFetch(`/api/broadcasts/${id}/${action}`, { method: "POST" });
      toast.success(done, undo ? { action: undo } : undefined);
      focusHeading();
      reload();
    } catch (e) {
      toast.error("That did not work", { description: friendlyError((e as Error).message) });
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    const current = latest.current;
    if (!current) return;
    const { broadcast, report, counts } = current;
    const copy = startCopy({ name: broadcast.name, status: broadcast.status, scheduledAt: broadcast.scheduledAt, total: report.total, handled: handledCount(counts) });
    const ok = await confirm({ title: copy.title, body: copy.body, confirmLabel: copy.confirmLabel });
    if (ok) await act("start", copy.done);
  }

  async function pause() {
    await act("pause", "Broadcast paused", { label: "Resume", onAction: () => void resumeFromToast() });
  }

  async function resumeFromToast() {
    const current = latest.current;
    if (!current || handledCount(current.counts) === 0) return start();
    await act("start", "Sending resumed");
  }

  async function cancel() {
    if (!data) return;
    const ok = await confirm({
      title: `Cancel "${data.broadcast.name}"?`,
      body: "Messages that have not been sent yet will not be sent. Messages already sent cannot be taken back, and a canceled broadcast cannot be restarted.",
      confirmLabel: "Cancel broadcast",
      cancelLabel: "Keep broadcast",
      tone: "danger",
    });
    if (ok) await act("cancel", "Broadcast canceled");
  }

  async function reschedule() {
    const problem = validateSchedule(when);
    setWhenError(problem);
    if (problem) return;
    setBusy("schedule");
    try {
      await apiFetch(`/api/broadcasts/${id}`, { method: "PATCH", body: { scheduledAt: new Date(when).toISOString() } });
      toast.success("Schedule updated");
      setWhen("");
      reload();
    } catch (e) {
      setWhenError(friendlyError((e as Error).message, "We could not change the schedule. Try again."));
    } finally {
      setBusy(null);
    }
  }

  async function loadMore(cursor: string) {
    setLoadingMore(true);
    try {
      const next = await apiFetch<Detail>(`/api/broadcasts/${id}?cursor=${encodeURIComponent(cursor)}`);
      setExtra((prev) => [...prev, ...next.recipients]);
      setMore(next.nextCursor);
    } catch (e) {
      toast.error("We could not load more people", { description: friendlyError((e as Error).message, "Check your connection and try again.") });
    } finally {
      setLoadingMore(false);
      requestAnimationFrame(() => (footer.current?.querySelector("button") ?? footer.current)?.focus());
    }
  }

  if (missing) {
    return (
      <div>
        <PageHeader title="Broadcast not found" breadcrumbs={[{ label: "Broadcasts", href: "/app/broadcasts" }, { label: "Not found" }]} />
        <EmptyState title="This broadcast does not exist" body="It may have been deleted, or the link is wrong." action={<LinkButton href="/app/broadcasts">Back to broadcasts</LinkButton>} />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div>
        <PageHeader title="Broadcast" breadcrumbs={[{ label: "Broadcasts", href: "/app/broadcasts" }, { label: "Not available" }]} />
        <ErrorState
          title="We could not load this broadcast"
          message={`${friendlyError(error, "Something went wrong on our side.")} It may have been removed, or your connection may be down.`}
          action={<Button variant="secondary" onClick={reload}>Try again</Button>}
        />
      </div>
    );
  }
  if (loading || !data) return <DetailSkeleton />;

  const { broadcast, counts, report } = data;
  const view = broadcastStatusView(broadcast.status);
  const pct = progressPercent(counts);
  const nextCursor = more === undefined ? data.nextCursor : more;
  const bounds = scheduleBounds();
  const isDraftOrScheduled = ["draft", "scheduled"].includes(broadcast.status);

  return (
    <div ref={page}>
      <PageHeader
        title={broadcast.name}
        breadcrumbs={[{ label: "Broadcasts", href: "/app/broadcasts" }, { label: broadcast.name }]}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusPill status={broadcast.status} label={view.label} />
            <span>{audienceLabel(broadcast.segmentTags, broadcast.audienceFilter?.fixed ? "People from an earlier broadcast" : broadcast.audienceFilter?.segmentId ? "A saved segment" : broadcast.audienceFilter?.filter ? "Contacts that match rules" : null)}</span>
            {isLive(broadcast.status) && <span>Updates automatically</span>}
          </span>
        }
        actions={
          admin && (
            <>
              {["draft", "paused"].includes(broadcast.status) && (
                <Button loading={busy === "start"} disabled={busy !== null} onClick={() => void start()}>
                  {broadcast.status === "paused" ? "Resume sending" : "Send broadcast"}
                </Button>
              )}
              {broadcast.status === "sending" && (
                <Button variant="secondary" loading={busy === "pause"} disabled={busy !== null} onClick={() => void pause()}>
                  Pause
                </Button>
              )}
              {!["completed", "canceled", "failed"].includes(broadcast.status) && (
                <Button variant="secondary" loading={busy === "cancel"} disabled={busy !== null} onClick={() => void cancel()}>
                  Cancel broadcast
                </Button>
              )}
              {broadcast.status !== "draft" && (
                <a href={`/api/broadcasts/${broadcast.id}/report`} download className={cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap", buttonVariants.secondary, buttonSizes.md)}>
                  Download report
                </a>
              )}
            </>
          )
        }
      />

      {error && <Alert tone="warn" className="mb-4">We could not refresh just now. You are seeing the last results we loaded.</Alert>}

      {broadcast.status === "paused" && (
        <Alert
          tone="warn"
          title={data.pauseReason ? PAUSE_COPY[data.pauseReason.reason].title : "This broadcast is paused"}
          className="mb-4"
          action={
            admin && (data.pauseReason?.reason === "template_paused" || data.pauseReason?.reason === "template_quality") ? (
              <Button size="sm" variant="secondary" onClick={() => setFollowUp("unsent")}>
                Send with another template
              </Button>
            ) : undefined
          }
        >
          {data.pauseReason ? (
            PAUSE_COPY[data.pauseReason.reason].body
          ) : (
            <>It also pauses by itself when your number&apos;s quality rating drops to low or its template is paused. Resume it once that is fixed.</>
          )}
          {handledCount(counts) === 0 && " Nothing has been sent yet, so resuming starts sending right away, not at the scheduled time."}
        </Alert>
      )}

      {admin && isDraftOrScheduled && (
        <Card className="mb-4" title={broadcast.scheduledAt ? `Scheduled for ${formatWhen(broadcast.scheduledAt)}` : "Not scheduled yet"} description="Pick a new time, up to 90 days ahead, in your local time.">
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="New date and time" error={whenError} className="w-full sm:w-72">
              <Input type="datetime-local" value={when} min={bounds.min} max={bounds.max} onChange={(e) => (setWhen(e.target.value), setWhenError(null))} />
            </FormField>
            <Button variant="secondary" loading={busy === "schedule"} disabled={busy !== null || !when} onClick={() => void reschedule()}>
              {broadcast.scheduledAt ? "Change schedule" : "Set schedule"}
            </Button>
          </div>
        </Card>
      )}

      <Card className="mb-6" title="Progress">
        <ProgressBar value={pct} label="Broadcast progress" />
        <p className="mt-2 text-sm text-muted" aria-live="polite">
          {report.total === 0 ? "No one has been queued yet. People are added when the broadcast starts." : `${pct}% handled, out of ${report.total.toLocaleString()} people`}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Sent" value={report.sent.toLocaleString()} />
          <Stat label="Delivered" value={report.delivered.toLocaleString()} />
          <Stat label="Read" value={report.read.toLocaleString()} />
          <Stat label="Failed" value={report.failed.toLocaleString()} />
          <Stat label="Not sent" value={report.skipped.toLocaleString()} />
        </div>
        <p className="mt-3 text-xs text-muted">Sent includes delivered and read. Not sent means the person opted out, or the broadcast was canceled before their turn.</p>
      </Card>

      {funnel.data && (
        <Card className="mb-6" title="Results" description="How far each message got.">
          <FunnelChart funnel={funnel.data.funnel} />
          {(broadcast.retryDays ?? 0) > 0 && (
            <p className="mt-3 text-xs text-muted">
              Retries are on. Messages WhatsApp held back because someone received too many marketing messages are tried again daily for up to {broadcast.retryDays} day{broadcast.retryDays === 1 ? "" : "s"}.
            </p>
          )}
        </Card>
      )}

      {(data.failures?.length ?? 0) > 0 && (
        <Card className="mb-6" title="Why some people did not get it" description="Reasons from WhatsApp, with how many people each affected.">
          <ul className="space-y-2 text-sm">
            {data.failures!.map((f) => (
              <li key={`${f.status}-${f.code}`} className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span>{errorCodeText(f.code)}</span>
                <span className="font-medium">{f.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          {admin && (
            <p className="mt-3 text-xs">
              <a href={`/api/broadcasts/${broadcast.id}/report?only=problems`} download className="font-medium text-accent-ink underline-offset-2 hover:underline">
                Download only the people who did not get it
              </a>
            </p>
          )}
        </Card>
      )}

      {admin && broadcast.status !== "draft" && report.total > 0 && (
        <Card className="mb-6" title="Next steps" description="Reach part of this broadcast's people again, with another template. You review a draft before anything is sent.">
          {["sending", "scheduled"].includes(broadcast.status) && <p className="mb-3 text-sm text-muted">To send the people who have not received it yet with another template, pause this broadcast first so nobody gets two messages.</p>}
          <div className="flex flex-wrap gap-2">
            {!["sending", "scheduled"].includes(broadcast.status) && (
              <Button variant="secondary" onClick={() => setFollowUp("unsent")}>
                Send the rest with another template
              </Button>
            )}
            <Button variant="secondary" onClick={() => setFollowUp("unread")}>
              Follow up with people who did not read it
            </Button>
          </div>
        </Card>
      )}

      <section aria-labelledby="people-heading">
        <h2 id="people-heading" className="text-base font-semibold tracking-tight">
          People
        </h2>
        <p className="mb-3 mt-0.5 text-sm text-muted">Each person this broadcast was sent to, and what happened.</p>
        <DataTable
          caption="People in this broadcast"
          columns={COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          empty={<EmptyState compact title="No people yet" body="People appear here once the broadcast starts sending." />}
          footer={
            rows.length > 0 && (nextCursor || more !== undefined) ? (
              <div ref={footer} tabIndex={-1} className="p-3 text-center outline-none">
                {nextCursor ? (
                  <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore(nextCursor)}>
                    Show more people
                  </Button>
                ) : (
                  <p className="text-sm text-muted">All {rows.length.toLocaleString()} people are shown.</p>
                )}
              </div>
            ) : undefined
          }
        />
      </section>
      {followUp && <FollowUpDialog broadcastId={broadcast.id} outcome={followUp} onClose={() => setFollowUp(null)} />}
    </div>
  );
}

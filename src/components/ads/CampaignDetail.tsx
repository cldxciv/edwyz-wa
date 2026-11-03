"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, CopyButton, Dialog, EmptyState, ErrorState, FormField, Input, Select, Skeleton, Stat, StatusPill, apiFetch, confirm, toast } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { ApprovalsPanel } from "@/components/approvals/ApprovalsPanel";
import { reviewView, type AdReview } from "@/lib/ads/review";
import { LinkButton } from "./LinkButton";
import { TermsAckBox } from "./wizard-parts";
import { budgetChangeKind, endChangeKind, endProblem, toDateTimeLocal } from "./campaign-edit";
import { TEMPLATE_LABELS, campaignNotice, campaignStatusView, categoryName, formatMinor, friendlyAdsError, isCategoryTermsMismatch, isMetaLoginProblem, isNotFoundError, minorToText, toMinor, typedTotalMatches } from "./helpers";
import { CampaignEdits } from "@/components/promote/CampaignEdits";
import { CompareVersions } from "@/components/promote/CompareVersions";
import { ResultsByPlacement } from "@/components/promote/ResultsByPlacement";
import { StatusTimeline } from "@/components/promote/StatusTimeline";
import {
  PROMOTE_ACCESS_PATH,
  draftHref,
  fixHref,
  headroomFrom,
  isPromoteSurface,
  pauseCauseOf,
  promoteVisible,
  resultsRange,
  statusTimeline,
  type AccessLite,
  type TimelineButton,
  type TimelineReview,
} from "@/components/promote/results-helpers";
import type { SpendSummaryView } from "@/lib/spend/summary";

type Ad = { id: string; name: string; status: string; metaAdId: string | null; review?: AdReview | null };
type AdSet = { id: string; name: string; status: string; metaAdSetId: string | null; dailyBudgetMinor: number | null; lifetimeBudgetMinor?: number | null; variantKey?: string | null; ads: Ad[] };
type Campaign = {
  id: string;
  name: string;
  template: string;
  status: string;
  currency: string;
  specialAdCategory: string;
  lastError: string | null;
  metaCampaignId: string | null;
  totalDailyBudgetMinor: number;
  /** What the person confirms to turn it on (daily budgets plus lifetime-only budgets). */
  confirmTotalMinor?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  /** When it was first put on Meta, and made: the Results tabs read from the run's start (startsAt, else these). */
  launchedAt?: string | null;
  createdAt?: string | null;
  editable?: boolean;
  /** Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 5.1): who made it, what it boosts, and the compare test. */
  surface?: string | null;
  sourceKind?: string | null;
  reviewState?: string | null;
  adTest?: { id: string; mode?: string | null; status?: string | null; winnerAdSetId?: string | null } | null;
  adSets: AdSet[];
};

/** Opens Meta addresses for the status timeline, resolved on the server from the allowlist (meta-screens.ts). */
export type CampaignMetaLinks = Partial<Record<"appeal_ad" | "account_quality", string | null>>;
type Caps = { maxDailyBudgetMinor: number | null; currency: string | null };

/** Ways to change a campaign that is on Meta. */
type Editing = "budget" | "end" | null;

/** Statuses where the campaign exists on Meta and can be changed (not while launching, not once archived). */
const ON_META = ["active", "paused"];

function ActivateDialog({ campaign, capText, busy, onCancel, onConfirm }: { campaign: Campaign; capText: string | null; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState("");
  const amount = campaign.confirmTotalMinor ?? campaign.totalDailyBudgetMinor;
  const total = formatMinor(amount, campaign.currency);
  const matches = typedTotalMatches(typed, amount, campaign.currency);
  const wrong = typed.trim() !== "" && !matches;
  return (
    <Dialog
      title="Start spending money?"
      description={`${campaign.name} will start showing ads and spending from your ad account.`}
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={!matches} loading={busy}>
            Activate campaign
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !busy) onConfirm();
        }}
      >
        <Alert tone="warn" title={`Up to ${total} a day`}>
          This is the total daily budget of the campaign. {capText ?? ""}{" "}It keeps spending every day until you pause it.
        </Alert>
        <FormField
          label={`Type the daily total to confirm: ${total}`}
          hint="Type the number only, like the amount shown above. This makes sure you have checked it."
          error={wrong ? "That does not match the daily total shown above." : null}
          required
        >
          <Input inputMode="decimal" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} data-autofocus="" />
        </FormField>
      </form>
    </Dialog>
  );
}

/** A new daily budget for one ad set on Meta. A raise is checked against the spending limits on the server. */
export function BudgetDialog({ campaign, busy, onCancel, onSave }: { campaign: Campaign; busy: boolean; onCancel: () => void; onSave: (adSetId: string, dailyBudgetMinor: number) => void }) {
  const sets = campaign.adSets.filter((s) => s.metaAdSetId && (s.lifetimeBudgetMinor === null || s.lifetimeBudgetMinor === undefined || s.dailyBudgetMinor !== null));
  const [setId, setSetId] = useState(sets[0]?.id ?? "");
  const set = sets.find((s) => s.id === setId);
  const current = set?.dailyBudgetMinor ?? campaign.totalDailyBudgetMinor;
  const [text, setText] = useState(minorToText(current, campaign.currency));
  const minor = toMinor(text, campaign.currency);
  const kind = minor === null ? null : budgetChangeKind(current, minor);
  const ready = !!set && minor !== null && kind !== "same";
  const save = () => {
    if (ready && !busy) onSave(set!.id, minor!);
  };
  return (
    <Dialog
      title="Change the daily budget"
      description={`Now ${formatMinor(current, campaign.currency)} a day.`}
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!ready} loading={busy}>
            Save budget
          </Button>
        </>
      }
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {sets.length === 0 && <Alert tone="warn">This campaign has no ad set with a daily budget on Meta, so there is nothing to change here.</Alert>}
        {sets.length > 1 && (
          <FormField label="Ad set">
            <Select
              value={setId}
              onChange={(e) => {
                const next = sets.find((s) => s.id === e.target.value);
                setSetId(e.target.value);
                if (next) setText(minorToText(next.dailyBudgetMinor ?? campaign.totalDailyBudgetMinor, campaign.currency));
              }}
            >
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label={`New daily budget (${campaign.currency})`} required error={text.trim() !== "" && minor === null ? "Enter an amount above zero, like 500 or 499.50." : null}>
          <Input inputMode="decimal" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} data-autofocus="" />
        </FormField>
        {kind === "raise" && (
          <Alert tone="warn" title="This raises your spending">
            Meta may spend up to 1.75 times the daily budget on a busy day. We check the new budget against your spending limits first. If it does not fit, nothing changes and we tell you how much room is left.
          </Alert>
        )}
        {kind === "cut" && <Alert tone="info">A lower budget takes effect on Meta right away.</Alert>}
      </form>
    </Dialog>
  );
}

/** A new end date for every ad set on Meta. A later end is checked against the spending limits on the server. */
export function EndDialog({ campaign, busy, onCancel, onSave }: { campaign: Campaign; busy: boolean; onCancel: () => void; onSave: (endsAt: Date) => void }) {
  const current = campaign.endsAt ? new Date(campaign.endsAt) : null;
  const [text, setText] = useState(current ? toDateTimeLocal(current) : "");
  const [now] = useState(() => new Date());
  const problem = endProblem(text, now, campaign.startsAt ? new Date(campaign.startsAt) : null);
  const next = problem ? null : new Date(text);
  const kind = next ? endChangeKind(current, next) : null;
  const ready = next !== null && kind !== "same";
  const save = () => {
    if (ready && !busy) onSave(next!);
  };
  return (
    <Dialog
      title="Change the end date"
      description={current ? `Now it runs until ${current.toLocaleString()}.` : "Now it has no end date and runs until you pause it."}
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!ready} loading={busy}>
            Save end date
          </Button>
        </>
      }
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <FormField label="New end" required hint="The campaign stops showing at this time, in your own time zone." error={text.trim() !== "" ? problem : null}>
          <Input type="datetime-local" value={text} onChange={(e) => setText(e.target.value)} data-autofocus="" />
        </FormField>
        {kind === "later" && (
          <Alert tone="warn" title="This lets it spend for longer">
            We check the later end against your spending limits first. If it does not fit, nothing changes and we tell you how much room is left.
          </Alert>
        )}
        {kind === "earlier" && <Alert tone="info">An earlier end takes effect on Meta right away.</Alert>}
      </form>
    </Dialog>
  );
}

/** Meta's review of one ad, next to its own status. Nothing until Meta has said something. */
function AdReviewNote({ review }: { review: AdReview | null | undefined }) {
  const view = reviewView(review ?? null);
  if (!view) return null;
  return (
    <div className="w-full space-y-1">
      <StatusPill status={review!.state} label={view.label} tone={view.tone} />
      {(review!.state === "rejected" || review!.state === "issues" || review!.state === "billing" || review!.state === "in_review") && <p className="break-words text-xs text-muted">{view.detail}</p>}
    </div>
  );
}

export function CampaignDetail({ id, metaLinks }: { id: string; metaLinks?: CampaignMetaLinks }) {
  const role = useRole();
  const router = useRouter();
  const [pollMs, setPollMs] = useState<number | undefined>(8000);
  const { data, error, loading, reload, retry } = useApi<{ campaign: Campaign }>(`/api/ads/campaigns/${id}`, pollMs);
  // A wrong or deleted id (or another workspace's campaign) answers 404: say so and stop asking every few seconds.
  const missing = !data && isNotFoundError(error);
  const caps = useApi<{ caps: Caps }>("/api/ads/caps");
  const [busy, setBusy] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [termsMismatch, setTermsMismatch] = useState(false);
  const [termsAck, setTermsAck] = useState(false);
  const statusRegion = useRef<HTMLDivElement>(null);
  const focusStatus = useRef(false);
  const status = data?.campaign.status;
  // Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 3.9, 3.10, 7.1): the status timeline, the edits, the results
  // tabs and the compare card show only when promoteAccess says the feature is visible (404 while hidden leaves it null).
  const promote = useApi<{ access: AccessLite }>(canManage(role) ? PROMOTE_ACCESS_PATH : null);
  const visible = promoteVisible(promote.data?.access);
  const review = useApi<{ review: TimelineReview }>(visible && data?.campaign.metaCampaignId ? `/api/ads/campaigns/${encodeURIComponent(id)}/review-status` : null, 60_000);
  const spend = useApi<{ summary: SpendSummaryView }>(visible ? "/api/spend/summary" : null);
  const [timelineBusy, setTimelineBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!focusStatus.current) return;
    focusStatus.current = false;
    statusRegion.current?.focus();
  }, [status]);

  useEffect(() => {
    setPollMs(missing ? undefined : 8000);
  }, [missing]);

  if (role !== null && !canManage(role)) {
    return (
      <div>
        <PageHeader title="Campaign" />
        <EmptyState title="Ad campaigns are for owners and admins" body="Ask an owner or admin of your workspace to manage ads, or to give you access." />
      </div>
    );
  }
  if (loading && !data) {
    return (
      <div aria-busy="true">
        <span className="sr-only" role="status">Loading campaign</span>
        <Skeleton className="mb-2 h-8 w-64" />
        <Skeleton className="mb-6 h-4 w-96 max-w-full" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Total daily budget" value="" loading />
          <Stat label="Status" value="" loading />
          <Stat label="Ads" value="" loading />
        </div>
      </div>
    );
  }
  if (missing) {
    return (
      <div>
        <PageHeader title="Campaign not found" breadcrumbs={[{ label: "Ad campaigns", href: "/app/ads" }, { label: "Not found" }]} />
        <EmptyState title="This campaign does not exist" body="It may have been deleted, or the link is wrong." action={<LinkButton href="/app/ads">Back to ad campaigns</LinkButton>} />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div>
        <PageHeader title="Campaign" breadcrumbs={[{ label: "Ad campaigns", href: "/app/ads" }, { label: "Campaign" }]} />
        <ErrorState title="We could not load this campaign" message="Check your connection and try again." action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
      </div>
    );
  }
  if (!data) return null;

  const c = data.campaign;
  const view = campaignStatusView(c.status);
  const notice = campaignNotice(c.status);
  const total = formatMinor(c.totalDailyBudgetMinor, c.currency);
  const capMinor = caps.data?.caps.maxDailyBudgetMinor ?? null;
  const capCurrency = caps.data?.caps.currency ?? c.currency;
  const capText = capMinor ? `Your workspace limit is ${formatMinor(capMinor, capCurrency)} a day across all active campaigns.` : null;
  const adCount = c.adSets.reduce((n, s) => n + s.ads.length, 0);
  const onMeta = ON_META.includes(c.status) && !!c.metaCampaignId;
  const ends = c.endsAt ? new Date(c.endsAt) : null;
  const rejected = c.adSets.flatMap((s) => s.ads).filter((a) => a.review?.state === "rejected").length;
  const promotion = isPromoteSurface(c.surface);
  const summary = spend.data?.summary ?? null;
  const tz = summary?.timezones.ads ?? null;
  const launchedSets = c.adSets.filter((s) => s.metaAdSetId);
  // What a campaign pause stops: the ad sets on Meta still running (a version paused by "Keep B" spends nothing already).
  const runningSets = launchedSets.filter((s) => s.status !== "paused" && s.status !== "archived");
  // Paused by a person, a limit, a stop and which one, or not known yet (3.9). Until the summary has loaded, [Resume] waits:
  // the 2.3.13 check must not fail open.
  const cause = pauseCauseOf({ id: c.id, metaCampaignId: c.metaCampaignId, adSetIds: c.adSets.flatMap((s) => [s.id, s.metaAdSetId]) }, summary, { failed: !!spend.error });
  const timeline = visible
    ? statusTimeline({
        status: c.status,
        endsAt: c.endsAt,
        now: new Date(),
        timeZone: tz,
        review: review.data?.review ?? null,
        pausedBy: cause.pausedBy,
        safetyReason: cause.safetyReason,
        stoppedBy: cause.stoppedBy,
        // The page pauses through the campaign: [Pause and free] only when that frees exactly what is held.
        launchedAdSetIds: (runningSets.length ? runningSets : launchedSets).map((s) => s.id),
      })
    : null;

  /** After a change: the campaign, its review and the spend summary (who may resume, the room left for the cost line). */
  function refresh() {
    reload();
    review.reload();
    spend.reload();
  }

  /** [Fix the ad] makes an edited copy (D29) of the named ads, then opens it; [Pause and free X] pauses (a lowering). */
  async function timelineAction(b: Exclude<TimelineButton, { kind: "opens_meta" }>) {
    if (b.kind === "pause_and_free") {
      setTimelineBusy(`free-${b.adSetId ?? "campaign"}`);
      try {
        await apiFetch(`/api/ads/campaigns/${encodeURIComponent(id)}/pause`, { method: "POST" });
        toast.success("Paused. The money set aside for it is free again.");
        refresh();
      } catch (e) {
        toast.error(friendlyAdsError((e as Error).message));
      } finally {
        setTimelineBusy(null);
      }
      return;
    }
    setTimelineBusy("fix_ad");
    try {
      const copy = await apiFetch<{ campaignId: string }>(`/api/ads/campaigns/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: { fixOf: b.adIds.length ? b.adIds : true } });
      // A special-category reason: the copy has the category set, so Meta's rules for it apply (3.9).
      if (b.category && promotion) {
        try {
          const draft = await apiFetch<{ updatedAt: string }>(`/api/promote/drafts/${encodeURIComponent(copy.campaignId)}`);
          await apiFetch(`/api/promote/drafts/${encodeURIComponent(copy.campaignId)}`, { method: "PATCH", body: { expectedUpdatedAt: draft.updatedAt, set: { specialAdCategory: b.category } } });
        } catch {
          toast.info("Choose the special category in the copy before you start it.");
        }
      }
      router.push(fixHref(copy.campaignId, c.surface));
    } catch (e) {
      toast.error(friendlyAdsError((e as Error).message));
      setTimelineBusy(null);
    }
  }

  async function run(action: string, body: unknown, success: string) {
    setBusy(action);
    try {
      await apiFetch(`/api/ads/campaigns/${id}/${action}`, { method: "POST", body });
      toast.success(success);
      setActivating(false);
      setEditing(null);
      setTermsMismatch(false);
      setTermsAck(false);
      focusStatus.current = true;
      reload();
    } catch (e) {
      const raw = (e as Error).message;
      if (action === "launch" && isCategoryTermsMismatch(raw)) setTermsMismatch(true);
      toast.error(friendlyAdsError(raw));
    } finally {
      setBusy(null);
    }
  }

  async function archive() {
    const ok = await confirm({
      title: `Archive "${c.name}"?`,
      body: "It stops showing right away and cannot be restarted. You can still see its history here.",
      confirmLabel: "Archive campaign",
      tone: "danger",
    });
    if (ok) await run("archive", undefined, "Campaign archived");
  }

  return (
    <div>
      <PageHeader
        title={c.name}
        breadcrumbs={[{ label: "Ad campaigns", href: "/app/ads" }, { label: c.name }]}
        description={`${TEMPLATE_LABELS[c.template]?.title ?? "Campaign"}${c.specialAdCategory !== "none" ? `. Special category: ${categoryName(c.specialAdCategory)}.` : ""}`}
        actions={<StatusPill status={c.status} label={view.label} tone={view.tone} />}
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Total daily budget" value={<span data-testid="total-budget">{total}</span>} hint={capText ?? undefined} />
        <Stat label="Status" value={view.label} hint={c.status === "active" ? "Spending each day" : c.status === "paused" ? "Nothing is being spent" : undefined} />
        <Stat label="Ads" value={adCount} hint={ends ? `Runs until ${ends.toLocaleString()}` : c.adSets.length === 1 ? "In 1 ad set" : `In ${c.adSets.length} ad sets`} />
      </div>

      {timeline && timeline.state !== "draft" && (
        <Card className="mb-4">
          <StatusTimeline view={timeline} metaLinks={metaLinks} busy={timelineBusy} onAction={(b) => void timelineAction(b)} />
        </Card>
      )}

      <Card title="What you can do" className="mb-4">
        <div className="space-y-4">
          <div ref={statusRegion} tabIndex={-1} className="space-y-4 outline-none empty:hidden">
            {notice && (
              <Alert tone={notice.tone} title={notice.title}>
                {notice.body}
              </Alert>
            )}
          </div>
          {rejected > 0 && !timeline && (
            <Alert tone="bad" title={rejected === 1 ? "Meta did not approve one of the ads" : `Meta did not approve ${rejected} of the ads`}>
              The reason is shown under the ad below. An ad Meta did not approve does not show to anyone, even when the campaign is active.
            </Alert>
          )}
          {termsMismatch && (
            <Alert tone="warn" title="Check the special category">
              The wording of this draft looks like it is about housing, jobs or credit, but no special category was chosen. If it is about one of those, edit the draft and choose the matching category. If it is not, confirm below and try again.
              <TermsAckBox className="-mx-2 mt-2" checked={termsAck} onChange={setTermsAck} />
            </Alert>
          )}
          {c.lastError && (
            <Alert tone="bad" title="Something needs your attention">
              {friendlyAdsError(c.lastError)}
              {isMetaLoginProblem(c.lastError) && (
                <div className="mt-2">
                  <LinkButton href="/app/settings/connections" size="sm">
                    Open Meta connections
                  </LinkButton>
                </div>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium underline">Details</summary>
                <p className="mt-1 break-words text-xs">{c.lastError}</p>
              </details>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            {(c.status === "draft" || c.status === "error") && (
              <Button loading={busy === "launch"} disabled={busy !== null || (termsMismatch && !termsAck)} onClick={() => void run("launch", termsMismatch && termsAck ? { acknowledgeSpecialCategoryTerms: true } : undefined, "Created on Meta and paused. Nothing is spent yet.")}>
                {c.status === "error" ? "Try creating on Meta again" : "Create on Meta (paused)"}
              </Button>
            )}
            {c.editable && (
              <LinkButton href={promotion ? draftHref(c) : `/app/ads/new?draft=${encodeURIComponent(c.id)}`} variant="secondary">
                Edit draft
              </LinkButton>
            )}
            {/* Promotions resume through CampaignEdits' confirm sheet; the old wizard keeps its typed activation (D5). */}
            {c.status === "paused" && c.metaCampaignId && !(visible && promotion) && (
              <Button disabled={busy !== null} onClick={() => setActivating(true)}>
                Activate campaign
              </Button>
            )}
            {c.status === "active" && !visible && (
              <Button variant="secondary" loading={busy === "pause"} disabled={busy !== null} onClick={() => void run("pause", undefined, "Campaign paused. Nothing is being spent.")}>
                Pause campaign
              </Button>
            )}
            {onMeta && !visible && (
              <>
                <Button variant="secondary" disabled={busy !== null} onClick={() => setEditing("budget")}>
                  Change budget
                </Button>
                <Button variant="secondary" disabled={busy !== null} onClick={() => setEditing("end")}>
                  Change end date
                </Button>
              </>
            )}
            {c.status !== "archived" && c.status !== "launching" && (
              <Button variant="secondary" loading={busy === "archive"} disabled={busy !== null} onClick={() => void archive()} className="text-bad-fg">
                Archive campaign
              </Button>
            )}
          </div>
        </div>
      </Card>

      {visible && (((c.status === "active" || c.status === "paused") && c.metaCampaignId) || c.status === "archived") && (
        <Card className="mb-4">
          <CampaignEdits
            campaign={c}
            timeZone={tz}
            headroom={headroomFrom(summary?.pots.ads)}
            blocksStart={timeline?.blocksStart}
            showResume={promotion}
            canResume={cause.canResume}
            resumeNote={cause.resumeNote}
            raisesBlocked={cause.raisesBlocked}
            canStart={promote.data?.access.canStart !== false}
            onChanged={() => {
              focusStatus.current = true;
              refresh();
            }}
            onCopied={(copyId) => router.push(draftHref({ id: copyId, template: c.template, surface: c.surface }))}
          />
        </Card>
      )}
      {visible && c.adTest?.id && (
        <Card className="mb-4">
          <CompareVersions testId={c.adTest.id} onChanged={refresh} />
        </Card>
      )}
      {visible && c.metaCampaignId && (
        <Card className="mb-6">
          <ResultsByPlacement
            campaignId={c.id}
            range={resultsRange(c, tz, new Date())}
            boosted={c.template === "boost_post" || c.sourceKind === "fb_post" || c.sourceKind === "ig_media"}
            onChanged={refresh}
          />
        </Card>
      )}

      <section aria-labelledby="ad-sets-heading" className="space-y-3">
        <h2 id="ad-sets-heading" className="text-base font-semibold">
          Ads in this campaign
        </h2>
        {c.adSets.map((s) => (
          <Card key={s.id} title={s.name} headingLevel="h3" description={`${formatMinor(s.dailyBudgetMinor ?? c.totalDailyBudgetMinor, c.currency)} a day`}>
            <ul className="divide-y divide-border text-sm">
              {s.ads.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="min-w-0 break-words">{a.name}</span>
                  <StatusPill status={a.status} label={campaignStatusView(a.status).label} tone={campaignStatusView(a.status).tone} />
                  <AdReviewNote review={a.review} />
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </section>

      <div className="mt-6">
        <ApprovalsPanel
          subjectType="ad_campaign"
          subjectId={c.id}
          canSend={c.status === "draft" || c.status === "paused" || c.status === "error"}
          description="Send your client a link to approve this campaign. They do not need to log in. Once you send one, the campaign can be turned on only after they approve it."
        />
      </div>

      {c.metaCampaignId && (
        <details className="mt-6 text-sm">
          <summary className="cursor-pointer font-medium">Details for support</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-muted">
            <span>Meta campaign ID: {c.metaCampaignId}</span>
            <CopyButton value={c.metaCampaignId} label="Copy campaign ID" />
          </div>
        </details>
      )}

      {activating && (
        <ActivateDialog
          campaign={c}
          capText={capText}
          busy={busy === "activate"}
          onCancel={() => setActivating(false)}
          onConfirm={() => void run("activate", { confirm: true, confirmedTotalMinor: c.confirmTotalMinor ?? c.totalDailyBudgetMinor }, "Campaign is active. It will spend up to " + total + " a day.")}
        />
      )}
      {editing === "budget" && (
        <BudgetDialog
          campaign={c}
          busy={busy === "budget"}
          onCancel={() => setEditing(null)}
          onSave={(adSetId, dailyBudgetMinor) => void run("budget", { adSetId, dailyBudgetMinor }, `Daily budget changed to ${formatMinor(dailyBudgetMinor, c.currency)}.`)}
        />
      )}
      {editing === "end" && <EndDialog campaign={c} busy={busy === "end"} onCancel={() => setEditing(null)} onSave={(endsAt) => void run("end", { endsAt: endsAt.toISOString() }, `End date changed to ${endsAt.toLocaleString()}.`)} />}
    </div>
  );
}

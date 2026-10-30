"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, CopyButton, Dialog, EmptyState, ErrorState, FormField, Input, Skeleton, Stat, StatusPill, apiFetch, confirm, toast } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { LinkButton } from "./LinkButton";
import { TermsAckBox } from "./wizard-parts";
import { TEMPLATE_LABELS, campaignNotice, campaignStatusView, categoryName, formatMinor, friendlyAdsError, isCategoryTermsMismatch, isMetaLoginProblem, typedTotalMatches } from "./helpers";

type Ad = { id: string; name: string; status: string; metaAdId: string | null };
type AdSet = { id: string; name: string; status: string; metaAdSetId: string | null; dailyBudgetMinor: number | null; ads: Ad[] };
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
  adSets: AdSet[];
};
type Caps = { maxDailyBudgetMinor: number | null; currency: string | null };

function ActivateDialog({ campaign, capText, busy, onCancel, onConfirm }: { campaign: Campaign; capText: string | null; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState("");
  const total = formatMinor(campaign.totalDailyBudgetMinor, campaign.currency);
  const matches = typedTotalMatches(typed, campaign.totalDailyBudgetMinor, campaign.currency);
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
          This is the total daily budget of the campaign. {capText ?? ""} It keeps spending every day until you pause it.
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

export function CampaignDetail({ id }: { id: string }) {
  const role = useRole();
  const { data, error, loading, reload, retry } = useApi<{ campaign: Campaign }>(`/api/ads/campaigns/${id}`, 8000);
  const caps = useApi<{ caps: Caps }>("/api/ads/caps");
  const [busy, setBusy] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [termsMismatch, setTermsMismatch] = useState(false);
  const [termsAck, setTermsAck] = useState(false);
  const statusRegion = useRef<HTMLDivElement>(null);
  const focusStatus = useRef(false);
  const status = data?.campaign.status;

  useEffect(() => {
    if (!focusStatus.current) return;
    focusStatus.current = false;
    statusRegion.current?.focus();
  }, [status]);

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
  if (error && !data) {
    return (
      <div>
        <PageHeader title="Campaign" breadcrumbs={[{ label: "Ad campaigns", href: "/app/ads" }, { label: "Campaign" }]} />
        <ErrorState title="We could not load this campaign" message="It may have been removed, or your connection dropped. Try again." action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
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

  async function run(action: string, body: unknown, success: string) {
    setBusy(action);
    try {
      await apiFetch(`/api/ads/campaigns/${id}/${action}`, { method: "POST", body });
      toast.success(success);
      setActivating(false);
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
        <Stat label="Ads" value={adCount} hint={c.adSets.length === 1 ? "In 1 ad set" : `In ${c.adSets.length} ad sets`} />
      </div>

      <Card title="What you can do" className="mb-4">
        <div className="space-y-4">
          <div ref={statusRegion} tabIndex={-1} className="space-y-4 outline-none empty:hidden">
            {notice && (
              <Alert tone={notice.tone} title={notice.title}>
                {notice.body}
              </Alert>
            )}
          </div>
          {termsMismatch && (
            <Alert tone="warn" title="Check the special category">
              The wording of this draft looks like it is about housing, jobs or credit, but no special category was chosen. A draft cannot be edited here. If it is about one of those, archive it and start a new campaign with the matching category. If it is not, confirm below and try again.
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
            {c.status === "paused" && c.metaCampaignId && (
              <Button disabled={busy !== null} onClick={() => setActivating(true)}>
                Activate campaign
              </Button>
            )}
            {c.status === "active" && (
              <Button variant="secondary" loading={busy === "pause"} disabled={busy !== null} onClick={() => void run("pause", undefined, "Campaign paused. Nothing is being spent.")}>
                Pause campaign
              </Button>
            )}
            {c.status !== "archived" && c.status !== "launching" && (
              <Button variant="secondary" loading={busy === "archive"} disabled={busy !== null} onClick={() => void archive()} className="text-bad-fg">
                Archive campaign
              </Button>
            )}
          </div>
        </div>
      </Card>

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
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </section>

      {c.metaCampaignId && (
        <details className="mt-6 text-sm">
          <summary className="cursor-pointer font-medium">Details for support</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-muted">
            <span>Meta campaign ID: {c.metaCampaignId}</span>
            <CopyButton value={c.metaCampaignId} label="Copy campaign ID" />
          </div>
        </details>
      )}

      {activating && <ActivateDialog campaign={c} capText={capText} busy={busy === "activate"} onCancel={() => setActivating(false)} onConfirm={() => void run("activate", { confirm: true, confirmedTotalMinor: c.totalDailyBudgetMinor }, "Campaign is active. It will spend up to " + total + " a day.")} />}
    </div>
  );
}

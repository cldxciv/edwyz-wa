"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, EmptyState, ErrorState, FormField, Input, Skeleton, StatusPill, apiFetch, confirm, toast } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { ApprovalsPanel } from "@/components/approvals/ApprovalsPanel";
import { formatMinor } from "@/lib/ads/insights-money";
import { LinkButton } from "../ads/LinkButton";
import {
  KIND_LABEL,
  SETTING_SPECS,
  approveCopy,
  canRevert,
  describeProposal,
  effectText,
  friendlyOptimizerError,
  isAdvisory,
  numbersFor,
  proposalStatusLabel,
  rejectCopy,
  revertCopy,
  revertDeadline,
  settingLabel,
  settingToText,
  sharedCurrency,
  validateSettings,
  type Money,
} from "./helpers";

type Proposal = {
  id: string;
  kind: string;
  targetMetaId: string;
  rationale: string;
  payload: Record<string, unknown>;
  revertPayload: unknown;
  status: string;
  appliedAt: string | null;
  createdAt: string;
  clientDecision?: { decision: string; approved: boolean; at: string } | null;
};
type Settings = Record<string, number | boolean>;
type SettingsResponse = { settings: Settings; defaults: Settings; budgetCapMinor: number | null };
type Action = "approve" | "reject" | "revert";

const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

type CardProps = { p: Proposal; busy: string | null; onAct: (p: Proposal, action: Action) => void; revertDays: number; money: Money };

/**
 * Asking the client about a suggestion: the approvals panel opens (and loads) only when someone expands it, so a long list
 * of suggestions does not load one approval list each. The client's answer is advice: nothing changes on Meta until an
 * owner or admin approves here.
 */
export function ClientApproval({ id, title }: { id: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-4" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="inline-flex min-h-10 cursor-pointer items-center text-sm font-medium">
        Ask your client first<span className="sr-only"> about {title}</span>
      </summary>
      {open && (
        <div className="mt-2">
          <ApprovalsPanel subjectType="optimizer_proposal" subjectId={id} headingLevel="h4" description="Send your client a link to approve this suggestion. Their answer shows here; you still make the change yourself." />
        </div>
      )}
    </details>
  );
}

const ProposalCard = memo(function ProposalCard({ p, busy, onAct, revertDays, money }: CardProps) {
  const described = describeProposal(p.kind, p.payload, p.rationale, money);
  const title = described?.title ?? KIND_LABEL[p.kind] ?? "Suggestion";
  const numbers = numbersFor(p.kind, p.payload, money);
  const mine = busy === p.id;
  const locked = busy !== null;
  const deadline = revertDeadline(p.appliedAt, revertDays);
  const approveLabel = isAdvisory(p.kind) ? "Mark as done" : p.kind === "pause_ad" ? "Approve and pause ad" : "Approve and move budget";
  return (
    <Card
      headingLevel="h3"
      title={title}
      description={`${KIND_LABEL[p.kind] ?? "Suggestion"}${p.status === "applied" ? `. Applied ${date(p.appliedAt)}.` : `. Found ${date(p.createdAt)}.`}`}
      actions={<StatusPill status={p.status} label={proposalStatusLabel(p.status)} tone={p.status === "proposed" || p.status === "approved" ? "warn" : p.status === "applied" ? "good" : "neutral"} />}
    >
      <p className="text-sm">{described?.why ?? p.rationale}</p>
      {typeof p.payload.suggestion === "string" && (
        <p className="mt-3 rounded-control border border-border bg-surface p-3 text-sm">
          <span className="font-medium">Idea: </span>
          {p.payload.suggestion}
        </p>
      )}
      {numbers.length > 0 && (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
          {numbers.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {p.clientDecision && (p.status === "proposed" || p.status === "approved") && (
        <p className="mt-3 text-sm" role="status">
          <span className="font-medium">Your client {p.clientDecision.decision === "approved" ? "approved this suggestion" : p.clientDecision.decision === "rejected" ? "did not approve this suggestion" : "asked for changes"}. </span>
          <span className="text-muted">Nothing changes on Meta until you approve it here.</span>
        </p>
      )}
      {(p.status === "proposed" || p.status === "approved") && (
        <>
          <p className="mt-4 text-sm text-muted">
            <span className="font-medium text-foreground">If you approve: </span>
            {effectText(p.kind, p.payload, money, revertDays)}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button loading={mine} disabled={locked} aria-label={`${approveLabel}: ${title}`} onClick={() => onAct(p, "approve")}>
              {approveLabel}
            </Button>
            <Button variant="secondary" disabled={locked} aria-label={`Reject: ${title}`} onClick={() => onAct(p, "reject")}>
              Reject
            </Button>
          </div>
          {p.status === "proposed" && <ClientApproval id={p.id} title={title} />}
        </>
      )}
      {canRevert(p, revertDays) && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="secondary" disabled={locked} loading={mine} aria-label={`Undo this change: ${title}`} onClick={() => onAct(p, "revert")}>
            Undo this change
          </Button>
          {deadline && <span className="text-xs text-muted">You can undo it until {date(deadline.toISOString())}.</span>}
        </div>
      )}
      <details className="mt-4 text-xs text-muted">
        <summary className="inline-flex min-h-10 cursor-pointer items-center font-medium">
          Details<span className="sr-only"> for {title}</span>
        </summary>
        <p className="mt-1 break-words">{p.rationale}</p>
      </details>
    </Card>
  );
});

function SettingsForm({ data, currency, isOwner, onSaved }: { data: SettingsResponse; currency: string | null; isOwner: boolean; onSaved: () => void }) {
  const initial = useMemo(() => Object.fromEntries(SETTING_SPECS.map((s) => [s.key, settingToText(s, data.settings[s.key] as number, currency)])), [data.settings, currency]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [enabled, setEnabled] = useState(Boolean(data.settings.enabled));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function save() {
    const checked = validateSettings(values, currency);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length) {
      toast.error("Some settings need a different value. Check the highlighted fields.");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/api/optimizer/settings", { method: "PUT", body: { enabled, ...checked.body } });
      toast.success("Settings saved");
      onSaved();
    } catch (e) {
      toast.error(friendlyOptimizerError((e as Error).message));
    } finally {
      setSaving(false);
    }
  }

  function useRecommended() {
    setValues(Object.fromEntries(SETTING_SPECS.map((s) => [s.key, settingToText(s, data.defaults[s.key] as number, currency)])));
    setErrors({});
  }

  return (
    <Card title="Settings" description="Choose how the optimiser checks your ads. The recommended values suit most businesses." headingLevel="h2">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!isOwner || saving} className="space-y-4">
          <legend className="sr-only">Optimiser settings</legend>
          {data.budgetCapMinor === null ? (
            <Alert tone="warn" title="No daily spending limit is set">
              The optimiser will not suggest moving budget until an owner sets a limit on the Ad campaigns page.
            </Alert>
          ) : (
            <p className="text-sm text-muted">Your daily spending limit is {formatMinor(data.budgetCapMinor, currency)}. The optimiser never goes above it.</p>
          )}
          <label className="flex min-h-10 cursor-pointer items-center gap-2.5 text-sm font-medium">
            <input type="checkbox" className="size-4 accent-accent" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Check my ads every day and suggest improvements
          </label>
          <details className="rounded-card border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">Fine-tune the rules (optional)</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {SETTING_SPECS.map((spec) => (
                <FormField key={spec.key} label={settingLabel(spec, currency)} hint={spec.hint} error={errors[spec.key]}>
                  <Input inputMode="decimal" value={values[spec.key]} onChange={(e) => setValues({ ...values, [spec.key]: e.target.value })} autoComplete="off" />
                </FormField>
              ))}
            </div>
            <div className="mt-4">
              <Button type="button" variant="ghost" size="sm" onClick={useRecommended}>
                Use recommended values
              </Button>
            </div>
          </details>
        </fieldset>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="submit" loading={saving} disabled={!isOwner}>
            Save settings
          </Button>
          {!isOwner && <span className="text-sm text-muted">Only an owner can change these settings.</span>}
        </div>
      </form>
    </Card>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" className="space-y-3">
      <span className="sr-only" role="status">Loading suggestions</span>
      {[0, 1].map((i) => (
        <Card key={i}>
          <Skeleton className="mb-3 h-5 w-48" />
          <Skeleton className="mb-2 h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </Card>
      ))}
    </div>
  );
}

export function OptimizerView() {
  const role = useRole();
  const open = useApi<{ proposals: Proposal[] }>("/api/optimizer/proposals?status=proposed,approved");
  const applied = useApi<{ proposals: Proposal[] }>("/api/optimizer/proposals?status=applied");
  const settings = useApi<SettingsResponse>("/api/optimizer/settings");
  const caps = useApi<{ caps: { currency: string | null } }>("/api/ads/caps");
  // Money settings and suggestions are in the ad account's currency. Before an owner sets the limit (which carries one),
  // take it from the connected ad accounts when they all use the same one.
  const options = useApi<{ adAccounts: { currency: string | null }[] }>(caps.data && !caps.data.caps.currency ? "/api/ads/options" : null);
  const [busy, setBusy] = useState<string | null>(null);
  const openHeading = useRef<HTMLHeadingElement>(null);
  const appliedHeading = useRef<HTMLHeadingElement>(null);
  const currency = caps.data?.caps.currency ?? sharedCurrency(options.data?.adAccounts);
  // The settings form waits for the currency, so it does not show amounts and then remount with another unit.
  const currencyReady = !!caps.error || !!caps.data?.caps.currency || !!options.data || !!options.error;
  const money = useCallback<Money>((n) => formatMinor(n, currency), [currency]);
  const revertDays = Number(settings.data?.settings.revertDays ?? 14);
  const { reload: reloadOpen } = open;
  const { reload: reloadApplied } = applied;

  const act = useCallback(
    async (p: Proposal, action: Action) => {
      const name = String(p.payload.adName ?? "");
      const copy = action === "approve" ? approveCopy(p.kind, name, effectText(p.kind, p.payload, money, revertDays)) : action === "reject" ? rejectCopy : revertCopy;
      const ok = await confirm({ title: copy.title, body: copy.body, confirmLabel: copy.confirmLabel, tone: copy.tone });
      if (!ok) return;
      setBusy(p.id);
      try {
        await apiFetch(`/api/optimizer/proposals/${p.id}`, { method: "PATCH", body: { action, confirm: true } });
        toast.success(action === "reject" ? "Suggestion rejected" : action === "revert" ? "Change undone" : isAdvisory(p.kind) ? "Marked as done" : p.kind === "pause_ad" ? "Ad paused on Meta" : "Budget moved");
        (action === "revert" ? appliedHeading : openHeading).current?.focus();
      } catch (e) {
        toast.error(friendlyOptimizerError((e as Error).message));
      } finally {
        setBusy(null);
        reloadOpen();
        reloadApplied();
      }
    },
    [money, revertDays, reloadOpen, reloadApplied],
  );

  const crumbs = [{ label: "Ad campaigns", href: "/app/ads" }, { label: "Optimiser" }];

  if (role !== null && !canManage(role)) {
    return (
      <div>
        <PageHeader title="Optimiser" breadcrumbs={crumbs} />
        <EmptyState title="The optimiser is for owners and admins" body="Ask an owner or admin of your workspace to review its suggestions, or to give you access." />
      </div>
    );
  }

  const openList = open.data?.proposals ?? [];
  const appliedList = applied.data?.proposals ?? [];

  return (
    <div className="space-y-8">
      <PageHeader title="Optimiser" breadcrumbs={crumbs} description="Suggestions to get more from your ad budget, based on your results. Nothing changes on Meta until you approve it." />

      <section aria-labelledby="open-heading" className="space-y-3">
        <h2 id="open-heading" ref={openHeading} tabIndex={-1} className="text-lg font-semibold outline-none">
          Waiting for your decision
        </h2>
        {open.error && !open.data ? (
          <ErrorState title="We could not load your suggestions" message="Check your connection and try again." action={<Button variant="secondary" onClick={open.retry}>Try again</Button>} />
        ) : (open.loading && !open.data) || role === null ? (
          <ListSkeleton />
        ) : openList.length === 0 ? (
          <EmptyState
            title="No suggestions right now"
            body="The optimiser checks your active ads once a day and suggests changes when it finds one worth making. Check back tomorrow, or see how your ads are doing."
            action={<LinkButton href="/app/ads/insights" variant="secondary">View ad insights</LinkButton>}
          />
        ) : (
          openList.map((p) => <ProposalCard key={p.id} p={p} busy={busy} onAct={act} revertDays={revertDays} money={money} />)
        )}
      </section>

      <section aria-labelledby="applied-heading" className="space-y-3">
        <h2 id="applied-heading" ref={appliedHeading} tabIndex={-1} className="text-lg font-semibold outline-none">
          Changes already made
        </h2>
        {applied.error && !applied.data ? (
          <Alert tone="bad" action={<Button size="sm" variant="secondary" onClick={applied.retry}>Try again</Button>}>
            We could not load the changes already made.
          </Alert>
        ) : applied.loading && !applied.data ? (
          <Skeleton className="h-24 w-full" />
        ) : appliedList.length === 0 ? (
          <p className="text-sm text-muted">Nothing has been changed yet. When you approve a suggestion, it appears here and you can undo it.</p>
        ) : (
          appliedList.map((p) => <ProposalCard key={p.id} p={p} busy={busy} onAct={act} revertDays={revertDays} money={money} />)
        )}
      </section>

      {settings.data && currencyReady ? (
        <SettingsForm key={currency ?? "none"} data={settings.data} currency={currency} isOwner={role === "owner"} onSaved={settings.reload} />
      ) : settings.error ? (
        <Alert tone="bad" action={<Button size="sm" variant="secondary" onClick={settings.retry}>Try again</Button>}>
          We could not load the optimiser settings.
        </Alert>
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
    </div>
  );
}

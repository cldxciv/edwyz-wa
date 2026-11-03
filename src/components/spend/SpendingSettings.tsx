"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, ErrorState, FormField, Input, Select, Skeleton, apiFetch, cn, toast } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { useApi } from "@/components/contacts/hooks";
import { parseMajorInput } from "@/lib/spend/money";
import type { ControlSettingsDTO } from "@/lib/spend/types";
import type { SpendSummaryView } from "@/lib/spend/summary";
import { timeZoneList } from "@/lib/timezones";
import { ActivityTable } from "./ActivityTable";
import { ApprovalsCard } from "./ApprovalsCard";
import { AssistantsCard } from "./AssistantsCard";
import { KillSwitch } from "./KillSwitch";
import { MetaLimitCard } from "./MetaLimitCard";
import { NotifyCard } from "./NotifyCard";
import { NOT_SET, PotCard, toMajorInput } from "./PotCard";

/*
 * Settings > Spending limits, for every member (docs/SPEND-CONTROLS-SPEC.md 8.1, 8.4). The page reads GET /api/spend/summary,
 * which is built for the caller's role: the owner edits everything, an admin lowers and stops, a team member reads. It
 * works in every workspace state (no Meta connection, no WhatsApp number, the demo workspace, locked or suspended), and
 * never shows a number nobody set: "Not set" instead.
 */

export const SPENDING_TITLE = "Spending limits";
export const SPENDING_SUBTITLE =
  "Choose the most Edwyz can spend for you each month and each day. Every ad change, automatic WhatsApp message and AI reply is checked against these limits first. Meta and WhatsApp bill you directly; Edwyz never holds your ad money.";
export const PAUSED_WORKSPACE_NOTE = "Your workspace is paused, so you can lower limits and stop spending, but not raise them until it is active again.";

type ViewProps = {
  summary: SpendSummaryView;
  /** A fresh summary from a save, or nothing to reload. */
  onSaved: (summary?: SpendSummaryView) => void;
  focusApprovalId?: string | null;
};

/** The whole page for one summary (rendered by tests without any fetch). */
export function SpendingSettingsView({ summary, onSaved, focusApprovalId }: ViewProps) {
  const caps = summary.capabilities;
  const manager = caps.role === "owner" || caps.role === "admin";
  const reload = () => onSaved();
  const control = "controlSettings" in summary ? summary.controlSettings : undefined;
  const owner = summary.role === "owner" ? summary : null;
  const managerView = summary.role === "owner" || summary.role === "admin" ? summary : null;
  return (
    <div className="space-y-6">
      <PageHeader
        title={SPENDING_TITLE}
        description={SPENDING_SUBTITLE}
        actions={summary.demo ? <Badge tone="info">Sample data</Badge> : undefined}
      />
      {summary.roleNote && <Alert tone="info">{summary.roleNote}</Alert>}
      {summary.workspaceState !== "active" && <Alert tone="warn">{PAUSED_WORKSPACE_NOTE}</Alert>}
      <p className="text-sm text-muted" data-testid="timezone-line">
        {summary.timezones.text}
        {summary.pendingTimezone ? ` ${summary.pendingTimezone.text}` : ""}
      </p>

      <KillSwitch freeze={summary.freeze} capabilities={caps} pausedByStop={summary.pausedByStop} onChanged={reload} />

      {summary.probation.note && (
        <Alert tone="info" title="New-workspace limits">
          {summary.probation.note}
        </Alert>
      )}

      {summary.breakers.length > 0 && (
        <Card title="Safety stops on now" description="Edwyz paused or held something to protect your limits.">
          <ul className="space-y-2 text-sm">
            {summary.breakers.map((b) => (
              <li key={b.id}>
                <span className="font-medium">{b.label}</span>
                {b.scopeName && <span className="text-muted"> · {b.scopeName}</span>}
                <span className="block text-muted">{b.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <section aria-label="Limits" className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
        <PotCard key="ads" pot={summary.pots.ads} capabilities={caps} spendingAccount={summary.spendingAccount} controlVersion={control?.version} onSaved={onSaved} />
        <PotCard key="messaging" pot={summary.pots.messaging} capabilities={caps} onSaved={onSaved} />
        <PotCard key="ai" pot={summary.pots.ai} capabilities={caps} onSaved={onSaved} />
      </section>

      {summary.metaLimit && <MetaLimitCard meta={summary.metaLimit} capabilities={caps} onChanged={reload} />}

      <AssistantsCard
        assistants={summary.assistants}
        assistantSpendEnabled={summary.assistantSpendEnabled}
        capabilities={caps}
        currency={summary.pots.ads.currency}
        onChanged={reload}
      />

      {managerView && (
        <ApprovalsCard key={`approvals-${control?.version ?? 0}`} approvals={managerView.approvals} capabilities={caps} controlSettings={control} admins={owner?.admins ?? []} focusId={focusApprovalId} onChanged={reload} />
      )}
      {managerView && <NotifyCard key={`notify-${control?.version ?? 0}`} notify={managerView.notify} capabilities={caps} controlVersion={control?.version ?? 0} onChanged={reload} />}
      {owner && control && <MoreSettingsCard key={`more-${control.version}`} settings={control} currency={summary.pots.ads.currency} timezone={summary.timezones.workspace} onChanged={reload} />}
      {manager && <ActivityTable capabilities={caps} yesterday={managerView?.yesterday ?? null} refreshKey={summary.generatedAt} onChanged={reload} />}
    </div>
  );
}

/** Time zones for the select: the browser's list when it has one, one entry per zone under its current name. */
export function timeZoneOptions(current: string): string[] {
  return timeZoneList(current);
}

/** The owner's other settings: time zone, target cost per lead, and whether safety stops may pause the team's campaigns. */
function MoreSettingsCard({ settings, currency, timezone, onChanged }: { settings: ControlSettingsDTO; currency: string; timezone: string; onChanged: () => void }) {
  const [tz, setTz] = useState(timezone);
  const [target, setTarget] = useState(toMajorInput(settings.targetCostPerLead));
  const [pauseHuman, setPauseHuman] = useState(settings.breakersMayPauseHumanCampaigns);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    let targetMinor: bigint | null;
    try {
      targetMinor = parseMajorInput(target, settings.targetCostPerLead?.currency ?? currency);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiFetch("/api/spend/control", {
        method: "PUT",
        body: { version: settings.version, timezone: tz, targetCostPerLeadMinor: targetMinor === null ? null : targetMinor.toString(), breakersMayPauseHumanCampaigns: pauseHuman },
      });
      setDone(tz !== timezone ? "Saved. The new time zone starts at midnight." : "Saved.");
      toast.success("Settings saved.");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card id="settings" title="More settings">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={save}>
        <FormField label="Time zone for WhatsApp and AI days" hint="A change starts at the next midnight, so no day is counted twice.">
          <Select value={tz} onChange={(e) => setTz(e.target.value)}>
            {timeZoneOptions(tz).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Target cost per lead" hint={`In ${settings.targetCostPerLead?.currency ?? currency}. Safety stops use it to spot ads that cost too much. Leave empty for ${NOT_SET}.`}>
          <Input type="text" inputMode="decimal" autoComplete="off" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={NOT_SET} />
        </FormField>
        <label className={cn("flex min-h-10 items-start gap-2 text-sm sm:col-span-2")}>
          <input type="checkbox" className="mt-1" checked={pauseHuman} onChange={(e) => setPauseHuman(e.target.checked)} />
          <span>
            Let safety stops pause campaigns my team made
            <span className="block text-xs text-muted">Otherwise they only tell you. Limits that are used up always pause every campaign.</span>
          </span>
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" variant="secondary" loading={saving}>
            Save settings
          </Button>
        </div>
      </form>
      <div aria-live="polite" className="mt-2 text-sm">
        {error ? <p className="text-bad-fg">{error}</p> : done && <p className="text-good-fg">{done}</p>}
      </div>
    </Card>
  );
}

/** The element "Sign in to approve" focuses: the request's own heading (ApprovalReview), falling back to the card. Pure. */
export function approvalFocusTarget(approvalId: string): string {
  return `approval-${approvalId}`;
}

function readFocusApproval(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("approval");
  } catch {
    return null;
  }
}

export function SpendingSettings() {
  const { data, error, loading, retry, reload } = useApi<{ summary: SpendSummaryView }>("/api/spend/summary");
  const [summary, setSummary] = useState<SpendSummaryView | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    if (data?.summary) setSummary(data.summary);
  }, [data]);

  useEffect(() => {
    setFocus(readFocusApproval());
  }, []);

  // "Sign in to approve" from WhatsApp lands here with ?approval=<id>: once the requests are on screen (the summary has
  // loaded), the request's heading is scrolled to and focused, so a screen reader announces it too. Once per visit.
  const focused = useRef(false);
  useEffect(() => {
    if (!summary || !focus || focused.current) return;
    focused.current = true;
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(approvalFocusTarget(focus)) ?? document.getElementById("approvals");
      if (!el) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      if (typeof (el as HTMLElement).focus === "function") (el as HTMLElement).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [summary, focus]);

  if (!summary) {
    if (error) {
      return (
        <div className="space-y-6">
          <PageHeader title={SPENDING_TITLE} description={SPENDING_SUBTITLE} />
          <ErrorState title="We could not load your spending limits" message={error} action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
        </div>
      );
    }
    return (
      <div className="space-y-6" aria-busy={loading || undefined}>
        <PageHeader title={SPENDING_TITLE} description={SPENDING_SUBTITLE} />
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
        <span className="sr-only" role="status">
          Loading your spending limits
        </span>
      </div>
    );
  }
  return <SpendingSettingsView summary={summary} focusApprovalId={focus} onSaved={(s) => (s ? setSummary(s) : reload())} />;
}

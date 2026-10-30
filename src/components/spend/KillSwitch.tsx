"use client";

import { useRef, useState } from "react";
import { Badge, Button, Card, apiFetch, confirm, toast } from "@/components/ui";
import type { FreezeDTO, FreezeLevel, SpendCapabilities } from "@/lib/spend/types";
import type { PausedByStopRow } from "@/lib/spend/summary";

/*
 * The status strip of Settings > Spending limits (docs/SPEND-CONTROLS-SPEC.md 8.1, 4.11, 2.3.13): whether spending is on,
 * [Stop assistants] and [Stop all spending] for admins and the owner, [Turn spending back on] for the owner only, and,
 * after a stop, the campaigns it paused with a guarded [Resume] (each resume is a raise through the limits).
 * Toggles go to PUT /api/spend/freeze; the answer ("Paused 2 of 2 campaigns.") is announced politely.
 */

export const STOP_ALL_DIALOG = {
  title: "Stop all spending?",
  body: "We'll pause every ad Edwyz started and hold automatic WhatsApp messages and AI replies. Messages your team types still go out. Only the owner can turn spending back on.",
  confirmLabel: "Stop all spending",
} as const;

export const STOP_ASSISTANTS_DIALOG = {
  title: "Stop assistants?",
  body: "Assistants won't start ads, raise budgets or send messages until the owner turns them back on. Your team can keep working as usual.",
  confirmLabel: "Stop assistants",
} as const;

export const RESUME_DIALOG = {
  title: "Turn spending back on?",
  body: "Nothing restarts by itself: ads the stop paused stay paused until you resume them, each one checked against your limits.",
  confirmLabel: "Turn spending back on",
} as const;

export const RESUME_ASSISTANTS_DIALOG = {
  title: "Turn assistants back on?",
  body: "Assistants can work again at the levels you chose, within your limits. Nothing they paused restarts by itself.",
  confirmLabel: "Turn assistants back on",
} as const;

/** The question for a toggle: turning back on from "assistants" is about assistants, not all spending. Pure. */
export function dialogFor(level: FreezeLevel, workspace: FreezeLevel): { title: string; body: string; confirmLabel: string } {
  if (level === "all") return STOP_ALL_DIALOG;
  if (level === "assistants") return STOP_ASSISTANTS_DIALOG;
  return workspace === "assistants" ? RESUME_ASSISTANTS_DIALOG : RESUME_DIALOG;
}

export const OWNER_ONLY_RESUME = "Only the owner can turn spending back on.";
export const RESUME_LIST_INTRO = "Turning spending back on doesn't restart anything. Resume what you need; each campaign is checked against your limits first.";

type Props = {
  freeze: FreezeDTO;
  capabilities: SpendCapabilities;
  pausedByStop: PausedByStopRow[];
  /** Called after a change, to reload the page's figures. */
  onChanged: () => void;
};

const TONE: Record<FreezeLevel, "good" | "warn" | "bad"> = { none: "good", assistants: "warn", all: "bad" };
const LABEL: Record<FreezeLevel, string> = { none: "On", assistants: "Assistants stopped", all: "Stopped" };

export function KillSwitch({ freeze, capabilities, pausedByStop, onChanged }: Props) {
  const [busy, setBusy] = useState<FreezeLevel | null>(null);
  const [announce, setAnnounce] = useState("");
  const statusRef = useRef<HTMLParagraphElement>(null);
  const ws = freeze.workspace;
  const platformStopped = freeze.platform !== "none";

  async function toggle(level: FreezeLevel) {
    const dialog = dialogFor(level, ws);
    const ok = await confirm({ title: dialog.title, body: dialog.body, confirmLabel: dialog.confirmLabel, tone: level === "none" ? "default" : "danger" });
    if (!ok) return;
    setBusy(level);
    try {
      const res = await apiFetch<{ freeze: { text: string } }>("/api/spend/freeze", { method: "PUT", body: { level } });
      setAnnounce(res.freeze.text);
      toast.success(res.freeze.text);
      // The pressed button goes away with the new state: focus moves to the status line instead of the page body.
      statusRef.current?.focus({ preventScroll: true });
      onChanged();
    } catch (e) {
      setAnnounce((e as Error).message);
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const manager = capabilities.canStopSpending;
  const owner = capabilities.canResumeSpending;

  return (
    <Card
      id="status"
      title="Spending status"
      actions={
        <Badge tone={TONE[freeze.effective]} dot>
          {LABEL[freeze.effective]}
        </Badge>
      }
    >
      {/* Not a live region: a change is announced once, by the polite line below. */}
      <p ref={statusRef} tabIndex={-1} className="text-sm font-medium focus:outline-none" data-testid="spend-status">
        {freeze.text}
      </p>
      {freeze.reason && ws !== "none" && <p className="mt-1 text-sm text-muted">Reason: {freeze.reason}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {manager && ws === "none" && (
          <Button variant="secondary" loading={busy === "assistants"} onClick={() => void toggle("assistants")}>
            Stop assistants
          </Button>
        )}
        {manager && ws !== "all" && (
          <Button variant="danger" loading={busy === "all"} onClick={() => void toggle("all")}>
            Stop all spending
          </Button>
        )}
        {owner && ws !== "none" && (
          <Button loading={busy === "none"} onClick={() => void toggle("none")}>
            {ws === "assistants" ? "Turn assistants back on" : "Turn spending back on"}
          </Button>
        )}
      </div>
      {!owner && ws !== "none" && <p className="mt-3 text-sm text-muted">{OWNER_ONLY_RESUME}</p>}
      {platformStopped && ws === "none" && <p className="mt-3 text-sm text-muted">Edwyz will turn this back on. You don&apos;t need to do anything.</p>}
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>

      {freeze.effective !== "all" && pausedByStop.length > 0 && <ResumeList rows={pausedByStop} onChanged={onChanged} />}
    </Card>
  );
}

/** The campaigns a stop paused (decision 2.3.13), with [Resume all] and a [Resume] per campaign. */
export function ResumeList({ rows, onChanged }: { rows: PausedByStopRow[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const resumable = rows.filter((r) => r.canResume);

  async function resume(list: PausedByStopRow[]) {
    const names = list.length === 1 ? `'${list[0].name}'` : `${list.length} campaigns`;
    const ok = await confirm({
      title: `Turn ${names} back on?`,
      body: list.length === 1 && list[0].dailyBudget ? `Its daily budget is ${list[0].dailyBudget.formatted}. It's checked against your limits first.` : "Each one is checked against your limits first. Anything that doesn't fit stays paused.",
      confirmLabel: list.length === 1 ? "Resume" : "Resume all",
    });
    if (!ok) return;
    setBusy(list.length === 1 ? list[0].campaignId : "all");
    let done = 0;
    let firstError: string | null = null;
    for (const r of list) {
      try {
        await apiFetch(`/api/ads/campaigns/${encodeURIComponent(r.campaignId)}/resume`, { method: "POST", body: { confirm: true, confirmedTotalMinor: r.confirmTotalMinor } });
        done++;
      } catch (e) {
        firstError ??= (e as Error).message;
      }
    }
    const text = firstError ? `Resumed ${done} of ${list.length}. ${firstError}` : list.length === 1 ? `'${list[0].name}' is back on.` : `Resumed ${done} of ${list.length} campaigns.`;
    setResult(text);
    if (firstError) toast.error(text);
    else toast.success(text);
    setBusy(null);
    onChanged();
  }

  return (
    <section className="mt-5 border-t border-border pt-4" aria-labelledby="paused-by-stop">
      <h3 id="paused-by-stop" className="text-sm font-semibold">
        Paused by the stop
      </h3>
      <p className="mt-1 text-sm text-muted">{RESUME_LIST_INTRO}</p>
      <ul className="mt-3 divide-y divide-border rounded-control border border-border">
        {rows.map((r) => (
          <li key={r.campaignId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{r.name}</span>
              {r.dailyBudget && <span className="text-muted"> · {r.dailyBudget.formatted} a day</span>}
              {r.adAccountName && <span className="text-muted"> · {r.adAccountName}</span>}
            </span>
            {r.canResume && (
              <Button size="sm" variant="secondary" loading={busy === r.campaignId} onClick={() => void resume([r])} aria-label={`Resume ${r.name}`}>
                Resume
              </Button>
            )}
          </li>
        ))}
      </ul>
      {resumable.length > 1 && (
        <Button size="sm" className="mt-3" loading={busy === "all"} onClick={() => void resume(resumable)}>
          Resume all
        </Button>
      )}
      {resumable.length === 0 && <p className="mt-2 text-xs text-muted">Only the owner or an approver can resume these.</p>}
      <p aria-live="polite" className="mt-2 text-sm">
        {result}
      </p>
    </section>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, Card } from "@/components/ui";
import { formatMinutes, type SetupStep } from "@/lib/setup/checklist";
import { actionLinkClass } from "./EmptyState";
import { Illustration } from "./Illustrations";
import { ProgressRing } from "./ProgressRing";
import { Skeleton, SkeletonGroup } from "./Skeleton";
import { useSetup, type SetupResponse } from "./useSetup";

const COLLAPSE_KEY = "edwyz.setupCard.collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0");
  } catch {
    // the choice still applies for this visit
  }
}

export function SetupCardSkeleton() {
  return (
    <SkeletonGroup label="Loading your setup progress" className="rounded-2xl border border-border p-5">
      <div className="flex items-center gap-4">
        <Skeleton className="h-[72px] w-[72px] rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      </div>
    </SkeletonGroup>
  );
}

function NextStep({ step, canDismiss, busy, onDismiss }: { step: SetupStep; canDismiss: boolean; busy: boolean; onDismiss: () => void }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl bg-surface p-4 sm:flex-row sm:items-center">
      <Illustration name={step.id} className="hidden h-20 w-28 shrink-0 sm:block" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">Do this next</p>
        <h3 className="mt-0.5 font-semibold">{step.title}</h3>
        <p className="mt-1 text-sm text-muted">{step.why}</p>
        {step.detail && <p className="mt-1 text-sm">{step.detail}</p>}
        <p className="mt-1 text-xs text-muted">{formatMinutes(step.minutes)}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link href={step.href} className={actionLinkClass(true)}>
            {step.cta}
          </Link>
          {canDismiss && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onDismiss}>
              Not now
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function OtherStep({ step, canDismiss, busy, onDismiss }: { step: SetupStep; canDismiss: boolean; busy: boolean; onDismiss: () => void }) {
  const blocked = step.blockedReason;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium">{step.title}</p>
        <p className="text-xs text-muted">{blocked ?? formatMinutes(step.minutes)}</p>
      </div>
      <div className="flex items-center gap-1">
        {canDismiss && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onDismiss} aria-label={`Not now: ${step.title}`}>
            Not now
          </Button>
        )}
        <Link href={step.href} className={actionLinkClass(false) + " !px-3 !py-1.5 !text-xs"} aria-label={`${step.cta}: ${step.title}`}>
          {step.cta}
        </Link>
      </div>
    </li>
  );
}

function Body({ data, busy, dismiss, actionError }: { data: SetupResponse; busy: string | null; dismiss: (id: SetupStep["id"], v: boolean) => void; actionError: string | null }) {
  const { steps, summary, canDismiss } = data;
  const open = steps.filter((s) => s.state === "todo" && !s.dismissed);
  const next = open.find((s) => s.id === summary.nextStepId) ?? open[0] ?? null;
  const others = open.filter((s) => s !== next);
  const skipped = steps.filter((s) => s.state === "todo" && s.dismissed).length;
  return (
    <div className="mt-4 space-y-3">
      {next ? (
        <NextStep step={next} canDismiss={canDismiss} busy={busy === next.id} onDismiss={() => dismiss(next.id, true)} />
      ) : (
        <p className="rounded-xl bg-surface p-4 text-sm">
          You have set aside the remaining steps for now. They are waiting on the Getting started page whenever you are ready.
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-red-700">
          {actionError}
        </p>
      )}
      {others.length > 0 && (
        <ul className="divide-y divide-border" aria-label="Other steps still to do">
          {others.map((s) => (
            <OtherStep key={s.id} step={s} canDismiss={canDismiss} busy={busy === s.id} onDismiss={() => dismiss(s.id, true)} />
          ))}
        </ul>
      )}
      <p className="text-sm">
        <Link href="/app/getting-started" className="font-medium text-accent underline underline-offset-2">
          See all steps{skipped > 0 ? ` (${skipped} set aside)` : ""}
        </Link>
      </p>
    </div>
  );
}

/** Collapsible progress card for the dashboard. Hides itself once every step that was asked of the owner is done. */
export function SetupCard() {
  const { data, error, loading, reload, dismiss, busy, actionError } = useSetup();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readCollapsed()), []);

  if (loading) return <SetupCardSkeleton />;
  if (error || !data) {
    return (
      <Card>
        <p role="alert" className="text-sm text-red-700">
          We could not load your setup progress.{" "}
          <button type="button" className="underline" onClick={reload}>
            Try again
          </button>
        </p>
      </Card>
    );
  }
  const { summary } = data;
  if (summary.complete) return null;

  const toggle = () => {
    setCollapsed(!collapsed);
    writeCollapsed(!collapsed);
  };
  const headline = summary.remaining > 0 ? "Finish setting up" : "Setup paused";
  const sub =
    summary.remaining > 0
      ? `${summary.done} of ${summary.asked} steps done, about ${summary.minutesLeft} min left`
      : "Remaining steps are set aside for now";

  return (
    <section aria-labelledby="setup-card-title" className="rounded-2xl border border-border bg-background p-5">
      <div className="flex items-center gap-4">
        <ProgressRing percent={summary.percent} label={`Setup ${summary.percent} percent complete`} />
        <div className="min-w-0 flex-1">
          <h2 id="setup-card-title" className="text-lg font-semibold">
            {headline}
          </h2>
          <p className="text-sm text-muted">{sub}</p>
        </div>
        <Button variant="secondary" size="sm" aria-expanded={!collapsed} aria-controls="setup-card-body" onClick={toggle}>
          {collapsed ? "Show steps" : "Hide steps"}
        </Button>
      </div>
      <div id="setup-card-body" hidden={collapsed}>
        <Body data={data} busy={busy} dismiss={dismiss} actionError={actionError} />
      </div>
    </section>
  );
}

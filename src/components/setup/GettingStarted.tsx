"use client";

import Link from "next/link";
import { Button, PageHeader } from "@/components/ui";
import type { SetupStep } from "@/lib/setup/checklist";
import { actionLinkClass, EmptyState } from "./EmptyState";
import { ProgressRing } from "./ProgressRing";
import { Skeleton, SkeletonGroup } from "./Skeleton";
import { StepCard } from "./StepCard";
import { useSetup, type SetupResponse } from "./useSetup";

function Loading() {
  return (
    <SkeletonGroup label="Loading your steps" className="space-y-4">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-36 w-full" />
    </SkeletonGroup>
  );
}

function Hero({ data }: { data: SetupResponse }) {
  const { summary, steps } = data;
  const next = steps.find((s) => s.id === summary.nextStepId);
  const target = next?.blockedBy ? steps.find((s) => s.id === next.blockedBy) : null;
  const go = target ?? next ?? null;
  return (
    <div className="mb-8 flex flex-wrap items-center gap-5 rounded-2xl border border-border bg-surface p-5">
      <ProgressRing percent={summary.percent} label={`Setup ${summary.percent} percent complete`} size={96} />
      <div className="min-w-0 flex-1">
        {summary.complete ? (
          <>
            <h2 className="text-lg font-semibold">You are all set</h2>
            <p className="mt-1 text-sm text-muted">Everything you need is in place. The ideas below are optional extras whenever you want them.</p>
          </>
        ) : summary.remaining === 0 ? (
          <>
            <h2 className="text-lg font-semibold">Steps set aside for now</h2>
            <p className="mt-1 text-sm text-muted">Bring any of them back below when you are ready.</p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">
              {summary.remaining} {summary.remaining === 1 ? "step" : "steps"} to go
            </h2>
            <p className="mt-1 text-sm text-muted">About {summary.minutesLeft} minutes in total. You can do them in any order and come back anytime.</p>
          </>
        )}
      </div>
      {go && !summary.complete && (
        <Link href={go.href} className={actionLinkClass(true)}>
          {go.cta}
        </Link>
      )}
    </div>
  );
}

function Section({
  title,
  intro,
  steps,
  all,
  start,
  data,
  busy,
  dismiss,
}: {
  title: string;
  intro?: string;
  steps: SetupStep[];
  all: SetupStep[];
  start: number;
  data: SetupResponse;
  busy: string | null;
  dismiss: (id: SetupStep["id"], v: boolean) => void;
}) {
  if (steps.length === 0) return null;
  return (
    <section className="mb-8" aria-label={title}>
      <h2 className="text-lg font-semibold">{title}</h2>
      {intro && <p className="mt-1 text-sm text-muted">{intro}</p>}
      <ol className="mt-4 space-y-3">
        {steps.map((s, i) => (
          <StepCard
            key={s.id}
            step={s}
            index={start + i + 1}
            blocker={s.blockedBy ? (all.find((x) => x.id === s.blockedBy && x.state !== "done") ?? null) : null}
            canDismiss={data.canDismiss}
            busy={busy === s.id}
            onDismiss={(v) => dismiss(s.id, v)}
          />
        ))}
      </ol>
    </section>
  );
}

export function GettingStarted() {
  const { data, error, loading, reload, dismiss, busy, actionError } = useSetup();

  return (
    <>
      <PageHeader title="Getting started" description="A short list to get you from sign-up to your first customer conversation. Nothing here is hard, and every step explains why it matters." />
      {loading ? (
        <Loading />
      ) : error || !data ? (
        <EmptyState tone="error" title="We could not load your steps" body={error ?? "Please check your connection and try again."} action={<Button onClick={reload}>Try again</Button>} />
      ) : (
        <>
          <Hero data={data} />
          {actionError && (
            <p role="alert" className="mb-4 text-sm text-red-700">
              {actionError}
            </p>
          )}
          {!data.canDismiss && <p className="mb-6 text-sm text-muted">You can see how setup is going. Ask a workspace admin to complete or set aside the steps.</p>}
          <GroupedSteps data={data} busy={busy} dismiss={dismiss} />
        </>
      )}
    </>
  );
}

function GroupedSteps({ data, busy, dismiss }: { data: SetupResponse; busy: string | null; dismiss: (id: SetupStep["id"], v: boolean) => void }) {
  const active = data.steps.filter((s) => !s.dismissed);
  const launch = active.filter((s) => s.group === "launch");
  const grow = active.filter((s) => s.group === "grow");
  const aside = data.steps.filter((s) => s.dismissed);
  const shared = { all: data.steps, data, busy, dismiss };
  return (
    <>
      <Section title="Get ready to message customers" intro="These four steps take you from nothing to your first message." steps={launch} start={0} {...shared} />
      <Section title="Grow further" intro="Optional, but they save time and bring in more customers." steps={grow} start={launch.length} {...shared} />
      <Section title="Set aside for now" steps={aside} start={launch.length + grow.length} {...shared} />
    </>
  );
}

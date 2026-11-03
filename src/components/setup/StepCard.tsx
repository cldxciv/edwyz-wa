"use client";

import Link from "next/link";
import { Badge, Button, cn } from "@/components/ui";
import { openEddy } from "@/components/eddy/events";
import { guideAskQuery } from "@/lib/eddy/guides";
import { t } from "@/lib/eddy/i18n";
import { formatMinutes, type SetupStep } from "@/lib/setup/checklist";
import { actionLinkClass } from "./EmptyState";
import { Illustration } from "./Illustrations";

type Props = {
  step: SetupStep;
  index: number;
  blocker: SetupStep | null;
  canDismiss: boolean;
  busy: boolean;
  onDismiss: (dismissed: boolean) => void;
  /** Eddy can chat right now (status "ready"). While it is off or paused, "Do this with Eddy" is not offered. */
  eddyReady?: boolean;
};

function Check({ done, index }: { done: boolean; index: number }) {
  return (
    <span
      aria-hidden
      className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold", done ? "border-accent bg-accent text-white" : "border-border text-muted")}
    >
      {done ? (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      ) : (
        index
      )}
    </span>
  );
}

function DoneRow({ step, index }: Pick<Props, "step" | "index">) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Check done index={index} />
        <div className="min-w-0">
          <h3 className="text-sm font-medium">
            {step.title} <span className="sr-only">(done)</span>
          </h3>
          {step.detail && <p className="text-xs text-muted">{step.detail}</p>}
        </div>
      </div>
      <Link href={step.reviewHref ?? step.href} className="text-xs font-semibold text-accent underline underline-offset-2" aria-label={`Review: ${step.title}`}>
        Review
      </Link>
    </li>
  );
}

/**
 * "Do this with Eddy" (docs/EDDY-SPEC.md 6.1): opens Eddy through the wa:eddy-open event with the member's own request for
 * this step. The text is the catalogue's, never anything a customer or Meta wrote, so it is safe to send as the member's
 * message (7.2 item 9). The button only shows while Eddy can chat: when Eddy is off, paused or out of allowance the query
 * would only wait in a composer that cannot send, so the step's own page buttons are the way.
 */
export function doWithEddy(step: Pick<SetupStep, "id">, target?: Parameters<typeof openEddy>[1]): boolean {
  return openEddy({ query: guideAskQuery("en", step.id) }, target);
}

export const DO_WITH_EDDY = t("en", "btn.do_with_eddy");

function Actions({ step, blocker, canDismiss, busy, onDismiss, eddyReady = false }: Omit<Props, "index">) {
  const primaryHref = blocker ? blocker.href : step.href;
  const primaryLabel = blocker ? blocker.cta : step.cta;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Link href={primaryHref} className={actionLinkClass(true)}>
        {primaryLabel}
      </Link>
      {!blocker && step.alt && (
        <Link href={step.alt.href} className={actionLinkClass(false)}>
          {step.alt.cta}
        </Link>
      )}
      {eddyReady && (
        <Button variant="secondary" size="sm" className="pointer-coarse:min-h-11" onClick={() => doWithEddy(step)} aria-label={`${DO_WITH_EDDY}: ${step.title}`} data-do-with-eddy={step.id}>
          {DO_WITH_EDDY}
        </Button>
      )}
      {canDismiss && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDismiss(!step.dismissed)} aria-label={`${step.dismissed ? "Bring back" : "Dismiss for now"}: ${step.title}`}>
          {step.dismissed ? "Bring back" : "Dismiss for now"}
        </Button>
      )}
    </div>
  );
}

/** One setup step: drawing, plain-language reason, time estimate and the single next action. Finished steps shrink to a row. */
export function StepCard(props: Props) {
  const { step, index, blocker } = props;
  if (step.state === "done") return <DoneRow step={step} index={index} />;
  return (
    <li className={cn("rounded-2xl border p-5", step.dismissed ? "border-border opacity-80" : "border-border")}>
      <div className="flex gap-4">
        <Illustration name={step.id} className="hidden h-24 w-32 shrink-0 sm:block" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Check done={false} index={index} />
            <h3 className="font-semibold">{step.title}</h3>
            {step.state === "optional" && <Badge>Optional</Badge>}
            {step.dismissed && <Badge tone="warn">Set aside</Badge>}
          </div>
          <p className="mt-2 text-sm text-muted">{step.why}</p>
          {step.detail && <p className="mt-1 text-sm">{step.detail}</p>}
          {blocker && (
            <p className="mt-2 text-sm text-amber-900" role="note">
              {step.blockedReason}
            </p>
          )}
          <p className="mt-2 text-xs text-muted">{formatMinutes(step.minutes)}</p>
          <Actions {...props} />
        </div>
      </div>
    </li>
  );
}

"use client";

import Link from "next/link";
import { useId } from "react";
import { Badge, Button, StatusPill, buttonSizes, buttonVariants, cn } from "@/components/ui";
import type { ProjectSummary } from "@/lib/projects/types";
import { billingLine, countText, roleText, spendText, whatsappText } from "./helpers";

type Props = {
  project: ProjectSummary;
  leadsWindowDays: number;
  /** This card's switch is running. */
  switching: boolean;
  /** Another card's switch is running: one at a time. */
  disabled: boolean;
  onSwitch: (project: ProjectSummary) => void;
};

const linkButton = cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap", buttonVariants.secondary, buttonSizes.md);

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 break-words font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** One project (workspace): its name, your role, its plan and the figures that say whether it needs you, and the way in. */
export function ProjectCard({ project, leadsWindowDays, switching, disabled, onSwitch }: Props) {
  const headingId = useId();
  const plan = billingLine(project.billing);
  return (
    <article
      aria-labelledby={headingId}
      className={cn("flex h-full flex-col rounded-card border bg-raised p-4 shadow-raised sm:p-5", project.current ? "border-accent" : "border-border")}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="min-w-0 break-words text-base font-semibold tracking-tight">
          {project.name}
        </h2>
        {project.current && <Badge tone="info">Current</Badge>}
      </div>
      <p className="mt-0.5 text-xs text-muted">Your role: {roleText(project.role)}</p>

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill status={project.billing.state} label={plan.label} tone={plan.tone} />
        {plan.plan && <span className="text-sm font-medium">{plan.plan}</span>}
      </div>
      {plan.date && <p className="mt-1 text-xs text-muted">{plan.date}</p>}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Figure label="WhatsApp number" value={whatsappText(project.whatsapp)} />
        <Figure label="Unread chats" value={countText(project.unreadConversations)} />
        <Figure label={`New leads, last ${leadsWindowDays} days`} value={countText(project.newLeads)} />
        <Figure label="Ad spend this month" value={spendText(project.adSpendMonth)} />
      </dl>

      <div className="mt-auto pt-4">
        {project.current ? (
          <Link href="/app" className={cn(linkButton, "w-full sm:w-auto")}>
            Open dashboard
          </Link>
        ) : (
          <Button type="button" variant="secondary" className="w-full sm:w-auto" loading={switching} disabled={disabled} onClick={() => onSwitch(project)}>
            Switch<span className="sr-only"> to {project.name}</span>
          </Button>
        )}
      </div>
    </article>
  );
}

"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { Badge, buttonSizes, buttonVariants, cn } from "@/components/ui";
import { explainFindings, POLICY_RESULT_LABEL, summarizePolicy, type RawCheck } from "./policy-explain";

export type PolicyCheck = RawCheck;
export type PolicyFinding = NonNullable<RawCheck>["findings"][number];

export type Brand = {
  id: string;
  name: string;
  websiteUrl: string | null;
  logoUrl: string | null;
  colors: string[];
  fonts: string[];
  tone: string | null;
  bannedWords: string[];
  industry: string | null;
  specialAdCategory: string;
  suggestedSpecialAdCategory?: string;
};

export type Angle = { id: string; hook: string; audience: string; cta: string; rationale: string | null; selected: boolean };

export type Asset = {
  id: string;
  angleId: string | null;
  kind: string;
  placement: string;
  headline: string | null;
  body: string | null;
  storageKey: string | null;
  provider: string | null;
  aiGenerated: boolean;
  creditCost: number;
  status: string;
  policyCheck: PolicyCheck;
  /** The newest approval request for this ad, as the client left it. Absent or null when it was never sent. */
  clientFeedback?: ClientFeedback | null;
};

export type ClientFeedback = { status: string; comment: string | null; decidedAt: string | null };

export const CATEGORY_LABEL: Record<string, string> = {
  none: "None",
  housing: "Housing",
  employment: "Jobs",
  credit: "Credit and finance",
  social_issues: "Social issues, elections or politics",
};

type LinkButtonProps = ComponentProps<typeof Link> & { variant?: keyof typeof buttonVariants; size?: keyof typeof buttonSizes };

/** A link that looks like a Button. Use for navigation; use Button for actions. */
export function LinkButton({ variant = "secondary", size = "md", className, ...props }: LinkButtonProps) {
  return (
    <Link
      className={cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap select-none transition-colors duration-(--dur-fast)", buttonVariants[variant], buttonSizes[size], className)}
      {...props}
    />
  );
}

export function PolicyBadge({ check }: { check: PolicyCheck }) {
  if (!check) return <Badge dot>Not checked yet</Badge>;
  const tone = check.result === "pass" ? "good" : check.result === "warn" ? "warn" : "bad";
  return (
    <Badge dot tone={tone}>
      Policy check: {POLICY_RESULT_LABEL[check.result].toLowerCase()}
    </Badge>
  );
}

const SEVERITY_BORDER = { block: "border-bad-line", warn: "border-warn-line", info: "border-border" } as const;
const SEVERITY_TONE = { block: "bad", warn: "warn", info: "neutral" } as const;

/**
 * The policy check in plain language: what we found, why it matters and how to fix it. The original technical
 * message stays inside a Details element.
 */
export function PolicyReport({ check, expanded }: { check: PolicyCheck; expanded?: boolean }) {
  if (!check) return null;
  const summary = summarizePolicy(check);
  const items = explainFindings(check);
  const list = (
    <ul className="mt-2 space-y-2">
      {items.map((e, i) => (
        <li key={`${e.rule}-${i}`} className={cn("rounded-control border bg-raised p-3 text-sm", SEVERITY_BORDER[e.severity])}>
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={SEVERITY_TONE[e.severity]}>{e.label}</Badge>
            <span className="font-semibold">{e.title}</span>
          </p>
          {e.found && (
            <p className="mt-1.5 text-muted">
              We found: <q className="font-medium text-foreground">{e.found}</q>
            </p>
          )}
          <p className="mt-1.5 text-muted">{e.why}</p>
          <p className="mt-1.5">
            <span className="font-medium">How to fix it: </span>
            {e.fix}
          </p>
          <details className="mt-1.5 text-xs text-muted">
            <summary className="cursor-pointer rounded py-1 hover:text-foreground">Details</summary>
            <p className="mt-1 break-words">{e.detail}</p>
          </details>
        </li>
      ))}
    </ul>
  );
  const note = <p className="mt-2 text-xs text-muted">This is a helper that looks for common problems. Meta makes the final decision on every ad.</p>;

  if (items.length === 0) {
    return (
      <div className="mt-3 text-sm">
        <p className="text-muted">
          {summary.headline}. {summary.detail}
        </p>
        {note}
      </div>
    );
  }

  return (
    <div className="mt-3">
      <details open={expanded} className="group text-sm">
        <summary className="cursor-pointer rounded py-1 font-medium">
          {summary.headline}: {summary.detail} <span className="text-muted">({items.length} {items.length === 1 ? "item" : "items"})</span>
        </summary>
        {list}
        {note}
      </details>
    </div>
  );
}

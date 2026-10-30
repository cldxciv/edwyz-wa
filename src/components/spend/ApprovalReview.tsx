"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Button, apiFetch, cn, toast, type Tone } from "@/components/ui";
import type { ApprovalDTO, SpendApprovalStatus } from "@/lib/spend/types";

/*
 * One spending request (docs/SPEND-CONTROLS-SPEC.md 7.3, 7.4, 8.1): the action, "Could add up to ₹4,550 this month (worst
 * case)", the reason and the time left, with [Approve] and [Decline]. A signed-in approver needs one tap and no extra dialog.
 * Declining only lowers risk, so on the one-tap link it works with the token alone; approving always needs a signed-in
 * approver (logged out, the link sends the person to sign in first). Decisions go to POST /api/spend/approvals/[id] in the
 * app and POST /api/spend/approvals/token on the link.
 */

export const ONLY_OWNER_APPROVES = "Only the owner can approve spending";
export const SIGN_IN_TO_APPROVE = "Sign in to approve";

const STATUS: Record<SpendApprovalStatus, { label: string; tone: Tone }> = {
  pending: { label: "Waiting", tone: "warn" },
  approved: { label: "Approved", tone: "good" },
  applied: { label: "Approved", tone: "good" },
  declined: { label: "Declined", tone: "neutral" },
  expired: { label: "Declined automatically", tone: "neutral" },
  failed: { label: "Couldn't be applied", tone: "bad" },
  superseded: { label: "Withdrawn", tone: "neutral" },
};

/** The line shown once a request is decided. Pure. */
export function decidedText(a: ApprovalDTO): string | null {
  const by = a.decidedByName ? ` by ${a.decidedByName}` : "";
  switch (a.status) {
    case "pending":
      return null;
    case "approved":
    case "applied":
      return `Approved${by}.`;
    case "declined":
      return `Declined${by}. Nothing was changed.`;
    case "expired":
      return a.expiryText || "Declined automatically.";
    case "failed":
      return a.failureReason ?? "This couldn't be applied, so nothing was changed.";
    case "superseded":
      return a.failureReason ?? "This request was replaced by a newer one.";
  }
}

type Props = {
  approval: ApprovalDTO;
  /** app: Settings > Spending limits (signed in). link: the one-tap page /s/<token>. */
  mode: "app" | "link";
  token?: string;
  /** Link mode: whether someone of this workspace is signed in. */
  signedIn?: boolean;
  /** Link mode: where "Sign in to approve" goes. */
  loginHref?: string;
  highlight?: boolean;
  onDecided?: (approval: ApprovalDTO | null) => void;
};

export function ApprovalReview({ approval, mode, token, signedIn = mode === "app", loginHref, highlight, onDecided }: Props) {
  const [a, setA] = useState(approval);
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [result, setResult] = useState("");
  const pending = a.status === "pending";
  const status = STATUS[a.status];
  const headingId = `approval-${a.id}`;

  async function decide(decision: "approve" | "decline") {
    setBusy(decision);
    try {
      const res =
        mode === "link"
          ? await apiFetch<{ approval?: ApprovalDTO; text?: string }>("/api/spend/approvals/token", { method: "POST", body: { token, decision } })
          : await apiFetch<{ approval?: ApprovalDTO; text?: string }>(`/api/spend/approvals/${encodeURIComponent(a.id)}`, { method: "POST", body: { decision } });
      const next = res.approval ?? { ...a, status: decision === "approve" ? "approved" : "declined", canApprove: false, canDecline: false };
      setA(next);
      const text = res.text ?? (decision === "approve" ? "Approved. The change is being applied within your limits." : "Declined. Nothing was changed.");
      setResult(text);
      toast.success(text);
      onDecided?.(next);
    } catch (e) {
      setResult((e as Error).message);
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <article aria-labelledby={headingId} className={cn("rounded-control border p-4", highlight ? "border-accent" : "border-border")} data-testid="approval">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={headingId} tabIndex={highlight ? -1 : undefined} className="min-w-0 scroll-mt-20 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {a.summary}
        </h3>
        <Badge tone={status.tone} dot>
          {status.label}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-muted">Asked by the {a.assistantLabel}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {a.forecastText && <li className="font-medium">{a.forecastText}</li>}
        {a.reason && <li>{a.reason}</li>}
        {pending && a.expiryText && <li className="text-muted">{a.expiryText}</li>}
      </ul>
      {!pending && <p className="mt-2 text-sm">{decidedText(a)}</p>}

      {pending && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {a.canApprove && signedIn ? (
            <Button loading={busy === "approve"} disabled={busy !== null} onClick={() => void decide("approve")}>
              Approve
            </Button>
          ) : mode === "link" && !signedIn && a.direction === "raise" && loginHref ? (
            <Link href={loginHref} className="inline-flex min-h-10 items-center rounded-full bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-strong">
              {SIGN_IN_TO_APPROVE}
            </Link>
          ) : null}
          {a.canDecline && (
            <Button variant="secondary" loading={busy === "decline"} disabled={busy !== null} onClick={() => void decide("decline")}>
              Decline
            </Button>
          )}
        </div>
      )}
      {pending && !a.canApprove && signedIn && a.direction === "raise" && <p className="mt-2 text-sm text-muted">{ONLY_OWNER_APPROVES}</p>}
      <p aria-live="polite" className="mt-2 text-sm">
        {result}
      </p>
    </article>
  );
}

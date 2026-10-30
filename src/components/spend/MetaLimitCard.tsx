"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Badge, Button, Card, Dialog, apiFetch, toast, type Tone } from "@/components/ui";
import type { MetaLimitDTO, MetaLimitState, MetaOffboardChoice, SpendCapabilities } from "@/lib/spend/types";

/*
 * "Spending limit on Meta" (docs/SPEND-CONTROLS-SPEC.md 8.1, 5.1, 5.7, 5.8): wall (a), Meta's own stop. Every state line
 * comes from the server (8.1 copy). The owner turns it on through the consent dialog (5.1 copy, textVersion meta-cap-v1)
 * and off through the three-choice dialog (5.8). Everything happens here, in Edwyz; the only Meta screen is its login
 * ([Connect again with an admin account]). Changes go to PUT /api/spend/meta-limit.
 */

export const META_CARD_TITLE = "Spending limit on Meta";
export const META_EXPLAINER = "Meta itself stops your ads when this limit is reached, even if something goes wrong on our side.";
export const META_CONSENT_VERSION = "meta-cap-v1";
export const META_CONSENT = {
  title: "Let Edwyz manage the spending limit on this ad account",
  body: [
    "Meta will stop every ad on this account, including ads you make yourself in Meta Ads Manager, once it has spent your monthly ads limit.",
    "Edwyz updates this limit for you, at most a few times a day. A change can take a few hours to reach Meta.",
    "If you press Stop all spending and an ad can't be paused, we set the limit so the account stops.",
    "You can turn this off here at any time, or remove the limit in Meta Ads Manager > Billing > Payment settings.",
  ],
  checkbox: "I'm the owner of this workspace and I agree.",
  button: "Turn on Meta's limit",
} as const;

export const TURN_OFF = {
  title: "Turn off Meta's limit?",
  body: "Your Edwyz limits keep working either way. Choose what happens to the limit on Meta.",
  button: "Turn off Meta's limit",
} as const;

/** The three 5.8 choices; "Put back my old limit" names the old amount. */
export function offboardLabel(choice: MetaOffboardChoice, meta: Pick<MetaLimitDTO, "previousCap">): string {
  if (choice === "keep") return "Keep the current limit on Meta";
  if (choice === "restore") return meta.previousCap ? `Put back my old limit (${meta.previousCap.formatted})` : "Put back my old limit";
  return "Remove the limit";
}

const TONE: Partial<Record<MetaLimitState, Tone>> = {
  managed: "good",
  ready: "info",
  pending_owner: "warn",
  no_permission: "warn",
  error: "bad",
  deferred: "info",
  loose: "warn",
  needs_monthly_limit: "warn",
  kept_while_paused: "info",
};
const BADGE: Partial<Record<MetaLimitState, string>> = {
  managed: "On",
  ready: "Ready",
  pending_owner: "Waiting for the owner",
  deferred: "Updating",
  loose: "Slightly above",
  needs_monthly_limit: "Needs a monthly limit",
  no_permission: "Needs an admin",
  error: "Needs a check",
  kept_while_paused: "Kept",
};

export function metaBadge(state: MetaLimitState): { label: string; tone: Tone } {
  return { label: BADGE[state] ?? (state === "demo" || state === "sandbox" ? "Not used" : "Off"), tone: TONE[state] ?? "neutral" };
}

/**
 * A refusal inside the open dialog (the dialog is modal, so a line on the card behind it is neither seen nor read out). An
 * Alert with tone bad is role="alert". Exported for tests.
 */
export function DialogError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert tone="bad" className="mt-4">
      {message}
    </Alert>
  );
}

/** The consent text as the dialog shows it (also used by tests to check the copy). */
export function MetaConsentText() {
  return (
    <div className="space-y-2 text-sm">
      {META_CONSENT.body.map((p) => (
        <p key={p}>{p}</p>
      ))}
    </div>
  );
}

type Props = { meta: MetaLimitDTO; capabilities: SpendCapabilities; onChanged: () => void };

export function MetaLimitCard({ meta, capabilities, onChanged }: Props) {
  const [dialog, setDialog] = useState<"on" | "off" | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [choice, setChoice] = useState<MetaOffboardChoice>("keep");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const badge = metaBadge(meta.state);
  const owner = capabilities.canManageMetaLimit;

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setDialogError(null);
    try {
      await apiFetch("/api/spend/meta-limit", { method: "PUT", body: { adAccountAssetId: meta.adAccountAssetId, ...body } });
      setMessage(done);
      toast.success(done);
      setDialog(null);
      onChanged();
    } catch (e) {
      // Shown in the dialog, which stays open so the owner can read it and choose again.
      setDialogError((e as Error).message || "That didn't work. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      id="meta-limit"
      title={META_CARD_TITLE}
      description={META_EXPLAINER}
      actions={
        <Badge tone={badge.tone} dot>
          {badge.label}
        </Badge>
      }
    >
      <p className="text-sm font-medium" data-testid="meta-limit-state">
        {meta.text}
      </p>
      {meta.accountName && <p className="mt-1 text-sm text-muted">Ad account: {meta.accountName}</p>}
      {meta.state === "pending_owner" && !owner && <p className="mt-2 text-sm text-muted">Only the workspace owner can turn on Meta&apos;s spending limit. We&apos;ve let them know.</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {meta.action?.kind === "connect_again" && (
          <Link href="/app/settings/connections" className="inline-flex min-h-10 items-center rounded-full border border-border-strong px-4 text-sm font-medium hover:bg-surface-2">
            {meta.action.label}
          </Link>
        )}
        {meta.action?.kind === "set_monthly_limit" && (
          <Link href="#ads" className="inline-flex min-h-10 items-center rounded-full border border-border-strong px-4 text-sm font-medium hover:bg-surface-2">
            {meta.action.label}
          </Link>
        )}
        {owner && meta.canTurnOn && (
          <Button
            onClick={() => {
              setAgreed(false);
              setDialogError(null);
              setDialog("on");
            }}
          >
            {META_CONSENT.button}
          </Button>
        )}
        {owner && meta.canTurnOff && (
          <Button
            variant="secondary"
            onClick={() => {
              setChoice("keep");
              setDialogError(null);
              setDialog("off");
            }}
          >
            Turn off
          </Button>
        )}
      </div>
      <p aria-live="polite" className="mt-2 text-sm">
        {message}
      </p>

      {dialog === "on" && (
        <Dialog
          title={META_CONSENT.title}
          onClose={() => setDialog(null)}
          dismissible={!busy}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button disabled={!agreed} loading={busy} onClick={() => void send({ action: "turn_on", consent: true, textVersion: META_CONSENT_VERSION }, "Meta's limit is being turned on.")}>
                {META_CONSENT.button}
              </Button>
            </>
          }
        >
          <MetaConsentText />
          <label className="mt-4 flex min-h-10 items-start gap-2 text-sm font-medium">
            <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            {META_CONSENT.checkbox}
          </label>
          <DialogError message={dialogError} />
        </Dialog>
      )}

      {dialog === "off" && (
        <Dialog
          title={TURN_OFF.title}
          description={TURN_OFF.body}
          onClose={() => setDialog(null)}
          dismissible={!busy}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} onClick={() => void send({ action: "turn_off", consent: false, choice }, "Meta's limit is turned off.")}>
                {TURN_OFF.button}
              </Button>
            </>
          }
        >
          <fieldset className="grid gap-2">
            <legend className="sr-only">What happens to the limit on Meta</legend>
            {(["keep", "restore", "remove"] as const)
              .filter((c) => c !== "restore" || meta.offboardChoices.includes("restore"))
              .map((c) => (
                <label key={c} className="flex min-h-10 items-center gap-2 text-sm">
                  <input type="radio" name="meta-offboard" value={c} checked={choice === c} onChange={() => setChoice(c)} />
                  {offboardLabel(c, meta)}
                </label>
              ))}
          </fieldset>
          <DialogError message={dialogError} />
        </Dialog>
      )}
    </Card>
  );
}

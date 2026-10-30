"use client";

import { useState, type FormEvent } from "react";
import { Button, Card, FormField, Input, apiFetch, cn, toast } from "@/components/ui";
import type { NotifySettingsDTO, SpendCapabilities } from "@/lib/spend/types";

/*
 * WhatsApp alerts for the owner and approvers (docs/SPEND-CONTROLS-SPEC.md 8.1, 7.4, 9.3). The person enters their number,
 * agrees to the consent text and asks for a confirmation; Edwyz's own number sends spend_optin_v1 and the "Yes" reply
 * finishes it. The owner turns the 9:00 daily summary on or off. Email alerts are off for now (12.1a decision 2: no SMTP),
 * so the card says alerts come in the app and on WhatsApp. Sign-up goes to POST /api/spend/notify; the summary toggle to
 * PUT /api/spend/control.
 */

export const NOTIFY_TITLE = "Get approvals, safety alerts and a daily summary on WhatsApp";
export const NOTIFY_CONSENT_VERSION = "owner-whatsapp-v1";
export const NOTIFY_CONSENT = "I agree to get spending approvals, alerts and a daily summary from Edwyz on WhatsApp at this number. I can stop any time by replying STOP.";
export const NOTIFY_BUTTON = "Send me a confirmation";
export const DIGEST_LABEL = "Daily summary at 9:00";
export const STOP_ALERTS_BUTTON = "Stop WhatsApp alerts";
export const ALERTS_STOPPED_TEXT = "WhatsApp alerts are off for your number. Approvals and alerts still come here in the app. Send a new confirmation to turn them back on.";

/** Whether the person can turn their own WhatsApp alerts off here (a pending or verified number). Pure. */
export function canStopAlerts(status: string | null | undefined): boolean {
  return status === "verified" || status === "pending";
}

/** "We sent a message from Edwyz (+1 711-268-5789). Tap 'Yes, send me alerts' to finish." */
export function pendingText(sender: string): string {
  return `We sent a message from Edwyz (${sender}). Tap 'Yes, send me alerts' to finish.`;
}

/** The person's channel state in words. Pure. */
export function channelText(notify: NotifySettingsDTO): string | null {
  const own = notify.own;
  if (!own) return null;
  if (own.status === "verified") return `Alerts go to ${own.phone} on WhatsApp.`;
  if (own.status === "opted_out") return "You stopped WhatsApp alerts by replying STOP. Send a new confirmation to turn them back on.";
  return pendingText(own.senderDisplay);
}

/** A number with country code: + and 8 to 15 digits (spaces and dashes allowed). */
export function phoneProblem(text: string): string | null {
  const digits = text.replace(/[\s()-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(digits) ? null : "Enter a number with country code, like +91 98765 43210.";
}

type Props = { notify: NotifySettingsDTO; capabilities: SpendCapabilities; controlVersion: number; onChanged: () => void };

export function NotifyCard({ notify, capabilities, controlVersion, onChanged }: Props) {
  const [phone, setPhone] = useState(notify.own?.status === "verified" ? "" : (notify.own?.phone ?? ""));
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(channelText(notify));
  const [sending, setSending] = useState(false);
  const [digest, setDigest] = useState(notify.digestEnabled);
  const [digestBusy, setDigestBusy] = useState(false);
  const [status, setStatus] = useState(notify.own?.status ?? null);
  const [stopping, setStopping] = useState(false);
  const owner = capabilities.canEditControlSettings;

  async function stopAlerts() {
    setStopping(true);
    setError(null);
    try {
      await apiFetch("/api/spend/notify", { method: "DELETE" });
      setStatus("opted_out");
      setState(ALERTS_STOPPED_TEXT);
      toast.success("WhatsApp alerts are off.");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStopping(false);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const problem = phoneProblem(phone);
    if (problem) return setError(problem);
    if (!agreed) return setError("Tick the box to agree first.");
    setError(null);
    setSending(true);
    try {
      const res = await apiFetch<{ channel?: { senderDisplay?: string } }>("/api/spend/notify", { method: "POST", body: { phone: phone.replace(/[\s()-]/g, ""), consent: true, textVersion: NOTIFY_CONSENT_VERSION } });
      const text = pendingText(res.channel?.senderDisplay ?? notify.own?.senderDisplay ?? "+1 711-268-5789");
      setState(text);
      setStatus("pending");
      toast.success("Confirmation sent on WhatsApp.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function toggleDigest() {
    const next = !digest;
    setDigestBusy(true);
    try {
      await apiFetch("/api/spend/control", { method: "PUT", body: { version: controlVersion, digestEnabled: next } });
      setDigest(next);
      toast.success(next ? "Daily summary is on." : "Daily summary is off.");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDigestBusy(false);
    }
  }

  return (
    <Card id="alerts" title={NOTIFY_TITLE}>
      {notify.emailFallbackText && <p className="text-sm text-muted">{notify.emailFallbackText}</p>}
      <p aria-live="polite" className="mt-2 text-sm font-medium" data-testid="notify-state">
        {state}
      </p>
      {capabilities.canSetOwnAlertsNumber ? (
        <form className="mt-3 grid gap-3" onSubmit={send}>
          <FormField label="Your WhatsApp number" hint="With country code, like +91 98765 43210." error={error}>
            <Input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </FormField>
          <label className="flex min-h-10 items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            {NOTIFY_CONSENT}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="secondary" loading={sending}>
              {NOTIFY_BUTTON}
            </Button>
            {canStopAlerts(status) && (
              <Button type="button" variant="ghost" loading={stopping} onClick={() => void stopAlerts()}>
                {STOP_ALERTS_BUTTON}
              </Button>
            )}
          </div>
        </form>
      ) : (
        <p className="mt-3 text-sm text-muted">The owner and the people they name as approvers get these alerts.</p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <span id="digest-label" className="text-sm font-medium">
          {DIGEST_LABEL}
        </span>
        {owner ? (
          <button
            type="button"
            role="switch"
            aria-checked={digest}
            aria-labelledby="digest-label"
            disabled={digestBusy}
            onClick={() => void toggleDigest()}
            className={cn("inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-border-strong p-0.5 transition-colors duration-(--dur-fast)", digest ? "bg-accent" : "bg-surface-2")}
          >
            <span aria-hidden className={cn("h-5 w-5 rounded-full bg-raised shadow-raised transition-transform duration-(--dur-fast)", digest ? "translate-x-5" : "translate-x-0")} />
          </button>
        ) : (
          <span className="text-sm text-muted">{digest ? "On" : "Off"}</span>
        )}
      </div>
    </Card>
  );
}

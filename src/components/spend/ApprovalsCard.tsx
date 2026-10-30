"use client";

import { useState, type FormEvent } from "react";
import { Button, Card, FormField, Input, apiFetch, toast } from "@/components/ui";
import type { ApprovalDTO, ControlSettingsDTO, SpendCapabilities } from "@/lib/spend/types";
import { ApprovalReview } from "./ApprovalReview";

/*
 * "Waiting for you" (docs/SPEND-CONTROLS-SPEC.md 8.1, 7.3): the spending requests assistants made, each with one-tap
 * [Approve] and [Decline]. Raises need the owner or an admin the owner named as an approver; anyone else sees "Only the
 * owner can approve spending". The owner also chooses who can approve and when requests expire (1 to 48 hours), saved
 * through PUT /api/spend/control.
 */

export const APPROVALS_TITLE = "Waiting for you";
export const NO_REQUESTS = "No spending requests are waiting.";
export const APPROVERS_LABEL = "Who can approve spending";
export const EXPIRY_LABEL = "Requests expire after";

type Props = {
  approvals: ApprovalDTO[];
  capabilities: SpendCapabilities;
  controlSettings?: ControlSettingsDTO;
  admins: { userId: string; name: string }[];
  /** The request to bring into view (after signing in from a one-tap link). */
  focusId?: string | null;
  onChanged: () => void;
};

export function ApprovalsCard({ approvals, capabilities, controlSettings, admins, focusId, onChanged }: Props) {
  return (
    <Card id="approvals" title={APPROVALS_TITLE} description="Requests from assistants that need a person. They are declined automatically when nobody answers in time.">
      {approvals.length === 0 ? (
        <p className="text-sm text-muted">{NO_REQUESTS}</p>
      ) : (
        <ul className="space-y-3">
          {approvals.map((a) => (
            <li key={a.id}>
              <ApprovalReview approval={a} mode="app" highlight={a.id === focusId} onDecided={() => onChanged()} />
            </li>
          ))}
        </ul>
      )}
      {capabilities.canEditControlSettings && controlSettings && <ApproverSettings settings={controlSettings} admins={admins} onChanged={onChanged} />}
      {!capabilities.canEditControlSettings && controlSettings && (
        <p className="mt-4 text-xs text-muted">
          Requests expire after {controlSettings.approvalTtlHours} {controlSettings.approvalTtlHours === 1 ? "hour" : "hours"}.
          {controlSettings.approvers.length > 0 ? ` Besides the owner, ${controlSettings.approvers.map((a) => a.name).join(", ")} can approve.` : " Only the owner can approve raises."}
        </p>
      )}
    </Card>
  );
}

function ApproverSettings({ settings, admins, onChanged }: { settings: ControlSettingsDTO; admins: { userId: string; name: string }[]; onChanged: () => void }) {
  const [approvers, setApprovers] = useState<string[]>(settings.approverUserIds);
  const [hours, setHours] = useState(String(settings.approvalTtlHours));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const h = Number(hours);
    if (!Number.isInteger(h) || h < 1 || h > 48) {
      setError("Choose between 1 and 48 hours.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiFetch("/api/spend/control", { method: "PUT", body: { version: settings.version, approverUserIds: approvers, approvalTtlHours: h } });
      setDone("Saved.");
      toast.success("Approval settings saved.");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="mt-5 grid gap-4 border-t border-border pt-4" onSubmit={save}>
      <fieldset>
        <legend className="text-sm font-medium">{APPROVERS_LABEL}</legend>
        <p className="mt-0.5 text-xs text-muted">You can always approve. Add admins who may approve raises too.</p>
        {admins.length === 0 ? (
          <p className="mt-2 text-sm text-muted">There are no admins in this workspace yet.</p>
        ) : (
          <div className="mt-2 grid gap-1">
            {admins.map((a) => (
              <label key={a.userId} className="flex min-h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={approvers.includes(a.userId)}
                  onChange={(e) => setApprovers((list) => (e.target.checked ? [...list, a.userId] : list.filter((id) => id !== a.userId)))}
                />
                {a.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <FormField label={EXPIRY_LABEL} hint="Between 1 and 48 hours. A request nobody answers is declined.">
        <Input type="number" inputMode="numeric" min="1" max="48" step="1" value={hours} onChange={(e) => setHours(e.target.value)} className="max-w-32" />
      </FormField>
      <div>
        <Button type="submit" variant="secondary" loading={saving}>
          Save approval settings
        </Button>
      </div>
      <div aria-live="polite" className="text-sm">
        {error ? <p className="text-bad-fg">{error}</p> : done && <p className="text-good-fg">{done}</p>}
      </div>
    </form>
  );
}

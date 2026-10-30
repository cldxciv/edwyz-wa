"use client";

import { useId, useState } from "react";
import { Alert, Button, Card, Dialog, FormField, Input, apiFetch, toast } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import type { MetaOffboardChoice } from "@/lib/spend/types";
import { formatDate } from "./helpers";

type DeletionState = { request: { status: string; requestedAt: string; deleteBy: string } | null };
/** One ad account where Edwyz manages Meta's spending limit, with the three 5.8 choices (GET /api/spend/meta-limit). */
export type CloseMetaAccount = { adAccountAssetId: string; accountName: string | null; accountExternalId: string; choices: { choice: MetaOffboardChoice; label: string }[]; selected: MetaOffboardChoice };
type MetaLimitState = { offboard: CloseMetaAccount[] };

/** The choices to send: every account listed, "Keep the current limit on Meta" unless the owner picked another. */
export function closeChoices(accounts: CloseMetaAccount[], picked: Record<string, MetaOffboardChoice>): Record<string, MetaOffboardChoice> {
  return Object.fromEntries(accounts.map((a) => [a.adAccountAssetId, picked[a.adAccountAssetId] ?? a.selected ?? "keep"]));
}

/**
 * Owner only. Asking to delete the workspace records a request; the platform team carries it out, nothing is erased on the spot.
 * Where Edwyz manages Meta's spending limit, the owner chooses what happens to it (docs/SPEND-CONTROLS-SPEC.md 5.8, 4.17):
 * keep it (the default), put back the old limit, or remove it. The choice is applied before the Meta connection is removed.
 */
export function CloseWorkspace() {
  const me = useApi<{ role: string; workspace: { name: string } | null }>("/api/auth/me");
  const isOwner = me.data?.role === "owner";
  const workspaceName = me.data?.workspace?.name ?? "";
  const { data, error, loading, reload } = useApi<DeletionState>(isOwner ? "/api/billing/workspace-deletion" : null);
  const meta = useApi<MetaLimitState>(isOwner ? "/api/spend/meta-limit" : null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Record<string, MetaOffboardChoice>>({});
  const matches = typed.trim().toLowerCase() === workspaceName.trim().toLowerCase();
  const accounts = meta.data?.offboard ?? [];

  async function send(method: "POST" | "DELETE") {
    setBusy(true);
    try {
      if (method === "POST" && accounts.length > 0) {
        const choices = closeChoices(accounts, picked);
        await apiFetch("/api/spend/meta-limit", { method: "POST", body: { action: "offboard_choice", trigger: "close", choices } });
      }
      await apiFetch("/api/billing/workspace-deletion", { method, body: method === "POST" ? { confirmName: typed } : undefined });
      toast.success(method === "POST" ? "We received your request. Check your email for the details." : "Your workspace will be kept.");
      setOpen(false);
      setTyped("");
      reload();
    } catch (err) {
      toast.error(`That did not work. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const pending = data?.request ?? null;
  if (!isOwner) return null;
  return (
    <Card title="Delete your workspace" description="Ask us to delete this workspace and all the data in it, including contacts and messages.">
      {loading ? (
        <p className="text-sm text-muted">Checking…</p>
      ) : error ? (
        <Alert tone="warn">We could not check whether a deletion request is open. Reload the page to try again.</Alert>
      ) : pending ? (
        <div className="space-y-3">
          <Alert tone="warn" title="Deletion requested">
            You asked for this workspace to be deleted on {formatDate(pending.requestedAt)}. We will delete it by {formatDate(pending.deleteBy)}. Nothing has been deleted yet.
          </Alert>
          <Button variant="secondary" loading={busy} onClick={() => send("DELETE")}>
            Keep my workspace
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Download your data from Reports first if you want a copy. If you pay by subscription, cancel it above so you are not charged again. We keep invoices as the law requires.
          </p>
          <Button variant="danger" onClick={() => setOpen(true)}>
            Request deletion
          </Button>
        </div>
      )}
      {open && (
        <Dialog
          title="Delete this workspace?"
          description="We will delete the workspace and its data within 30 days. You can change your mind until then."
          role="alertdialog"
          dismissible={!busy}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={!matches} loading={busy} onClick={() => send("POST")}>
                Request deletion
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <MetaLimitChoices accounts={accounts} picked={picked} onPick={(id, c) => setPicked((p) => ({ ...p, [id]: c }))} />
            <FormField label={`Type "${workspaceName}" to confirm`}>
              <Input data-autofocus autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </FormField>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

/** The three 5.8 choices per ad account where Edwyz manages Meta's limit. Renders nothing when there is none. */
export function MetaLimitChoices({ accounts, picked, onPick }: { accounts: CloseMetaAccount[]; picked: Record<string, MetaOffboardChoice>; onPick: (adAccountAssetId: string, choice: MetaOffboardChoice) => void }) {
  const hintId = useId();
  if (accounts.length === 0) return null;
  return (
    <div className="space-y-3 text-sm">
      <p id={hintId} className="text-muted">
        Edwyz manages Meta&apos;s spending limit on your ad account. Choose what happens to it when the workspace is deleted. Your ads are paused first either way.
      </p>
      {accounts.map((a) => {
        const current = picked[a.adAccountAssetId] ?? a.selected ?? "keep";
        return (
          <fieldset key={a.adAccountAssetId} className="space-y-1" aria-describedby={hintId}>
            <legend className="font-medium">Meta&apos;s spending limit on {a.accountName ?? a.accountExternalId}</legend>
            {a.choices.map((c) => (
              <label key={c.choice} className="flex min-h-10 items-center gap-2">
                <input type="radio" name={`close-meta-${a.adAccountAssetId}`} value={c.choice} checked={current === c.choice} onChange={() => onPick(a.adAccountAssetId, c.choice)} />
                <span>{c.label}</span>
              </label>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

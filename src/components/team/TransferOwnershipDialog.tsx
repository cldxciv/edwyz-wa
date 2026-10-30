"use client";

import { useRef, useState } from "react";
import { Alert, Button, Dialog, FormField, Input, apiFetch, toast } from "@/components/ui";

type Candidate = { userId: string; name: string };

export function TransferOwnershipDialog({ candidate, onClose, onDone }: { candidate: Candidate; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [keepOwner, setKeepOwner] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) {
      setProblem("Enter your password to confirm.");
      passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await apiFetch("/api/workspace/ownership", { method: "POST", body: { userId: candidate.userId, password, keepOwner } });
      toast.success(`${candidate.name} is now an owner`);
      onDone();
      onClose();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "We could not transfer ownership. Check your connection and try again.");
      requestAnimationFrame(() => passwordRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Make ${candidate.name} the owner?`}
      description={keepOwner ? "They become an owner too. You stay an owner." : "They take over the workspace. You become an admin and can no longer manage owners or billing."}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="transfer-form" variant="danger" loading={busy}>{keepOwner ? "Add as owner" : "Transfer ownership"}</Button>
        </>
      }
    >
      <form id="transfer-form" onSubmit={submit} noValidate className="space-y-4">
        {problem && <Alert tone="bad">{problem}</Alert>}
        <FormField label="Your password" required hint="We ask so nobody else can hand over your workspace from an open browser.">
          <Input ref={passwordRef} type="password" name="password" autoComplete="current-password" value={password} data-autofocus onChange={(e) => setPassword(e.target.value)} />
        </FormField>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={keepOwner} onChange={(e) => setKeepOwner(e.target.checked)} />
          <span>Keep me as an owner as well</span>
        </label>
      </form>
    </Dialog>
  );
}

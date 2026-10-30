"use client";

import { useRef, useState } from "react";
import { Alert, Button, CopyButton, Dialog, FormField, Input, Select, apiFetch, toast } from "@/components/ui";
import { ROLE_INFO, emailError, type Role } from "./helpers";

type Created = { email: string; emailed?: boolean; acceptUrl?: string };

export function InviteDialog({ isOwner, onClose, onCreated }: { isOwner: boolean; onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("agent");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const invalid = emailError(email);
    setFieldError(invalid);
    setProblem(null);
    if (invalid) {
      emailRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<Created>("/api/workspace/invites", { method: "POST", body: { email: email.trim(), role } });
      setCreated(res);
      onCreated();
      toast.success("Invite created");
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "We could not create the invite. Check your connection and try again.");
      requestAnimationFrame(() => emailRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  function another() {
    setCreated(null);
    setEmail("");
    setProblem(null);
  }

  if (created) {
    const link = created.acceptUrl;
    return (
      <Dialog
        key="done"
        title={link ? "Invite ready" : "Invite sent"}
        description={link ? `Send this link to ${created.email}. They choose a password and join your workspace.` : `We emailed ${created.email}. They open the link, choose a password and join your workspace.`}
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={another}>Invite another person</Button>
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        {link ? (
          <div className="space-y-3">
            <FormField label="Invite link" hint="This server cannot send email, so copy this link and send it yourself. It works once and expires in 7 days.">
              <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} data-autofocus />
            </FormField>
            <CopyButton value={link} label="Copy link" className="max-sm:min-h-10" />
          </div>
        ) : (
          <p className="text-sm text-muted">The link works once and expires in 7 days. If it does not arrive, ask them to check their spam folder, then invite them again.</p>
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      key="form"
      title="Invite a teammate"
      description="They get a link to join this workspace with the role you choose."
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="invite-form" loading={busy}>Create invite</Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} noValidate className="space-y-4">
        {problem && <Alert tone="bad">{problem}</Alert>}
        <FormField label="Email address" required error={fieldError}>
          <Input ref={emailRef} type="email" name="email" value={email} autoComplete="off" inputMode="email" placeholder="name@company.com" data-autofocus onChange={(e) => setEmail(e.target.value)} />
        </FormField>
        <FormField label="Role" hint={ROLE_INFO[role].description}>
          <Select name="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="agent">{ROLE_INFO.agent.label}</option>
            {isOwner && <option value="admin">{ROLE_INFO.admin.label}</option>}
          </Select>
        </FormField>
        {!isOwner && <p className="text-xs text-muted">Only an owner can invite admins.</p>}
      </form>
    </Dialog>
  );
}

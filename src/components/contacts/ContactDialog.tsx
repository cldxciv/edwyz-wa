"use client";

import { useId, useRef, useState } from "react";
import { Alert, Button, Dialog, FormField, Input, apiFetch } from "@/components/ui";
import { normalizePhone } from "@/lib/contacts/phone";
import { ConsentHistory } from "./ConsentHistory";
import { OPTED_OUT_NOTE, OPT_OUT_WARNING, PHONE_ERROR, PHONE_HINT, friendlyError, parseTagInput } from "./helpers";
import { OwnerStageFields, ownerStagePatch, useOwnerStageOptions } from "./OwnerStage";

export type ContactRow = {
  id: string;
  phone: string | null;
  bsuid?: string | null;
  username?: string | null;
  name: string | null;
  tags: string[];
  optIn: boolean;
  optInSource: string | null;
  optInAt: string | null;
  optedOutAt: string | null;
  ownerUserId?: string | null;
  leadStage?: string | null;
};

type Props = {
  contact: ContactRow | null;
  /** Owners and admins can record consent; agents cannot. */
  canRecordConsent: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
};

export function ContactDialog({ contact, canRecordConsent, onClose, onSaved }: Props) {
  const formId = useId();
  const editing = contact !== null;
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [name, setName] = useState(contact?.name ?? "");
  const [tags, setTags] = useState(contact?.tags.join(", ") ?? "");
  const [optIn, setOptIn] = useState(contact?.optIn ?? false);
  const [source, setSource] = useState(contact?.optInSource ?? "");
  const [owner, setOwner] = useState(contact?.ownerUserId ?? "");
  const [stage, setStage] = useState(contact?.leadStage ?? "");
  const options = useOwnerStageOptions();
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const phoneInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLInputElement>(null);

  const optedOut = !!contact?.optedOutAt;
  const newlyOptingIn = optIn && !contact?.optIn;
  const phoneError = !editing && tried && !normalizePhone(phone) ? PHONE_ERROR : null;
  const sourceError = tried && newlyOptingIn && !source.trim() ? "Say where this person gave consent, for example a website form or an in-store sign-up." : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError("");
    const invalid = !editing && !normalizePhone(phone) ? phoneInput : newlyOptingIn && !source.trim() ? sourceInput : null;
    if (invalid) {
      invalid.current?.focus(); // keyboard and screen-reader users land on the field to fix; its error is announced and tied to it
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: name.trim(), tags: parseTagInput(tags) };
      if (!editing) body.phone = phone;
      if (canRecordConsent && !optedOut && (!editing || optIn !== contact.optIn)) {
        body.optIn = optIn;
        if (optIn) body.optInSource = source.trim();
      }
      const saved = editing ? null : await apiFetch<{ contact: { id: string } }>("/api/contacts", { method: "POST", body });
      if (editing) await apiFetch(`/api/contacts/${contact.id}`, { method: "PATCH", body });
      const extra = ownerStagePatch({ owner: contact?.ownerUserId ?? "", stage: contact?.leadStage ?? "" }, { owner, stage });
      if (extra) await apiFetch(`/api/teams/contacts/${contact?.id ?? saved?.contact.id}`, { method: "PATCH", body: extra });
      onSaved(editing ? "Contact updated" : "Contact added");
    } catch (err) {
      setError(friendlyError(err, "We could not save this contact. Check your connection and try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={editing ? "Edit contact" : "Add contact"}
      description={editing ? undefined : "Add one person you can message on WhatsApp."}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {editing ? "Save changes" : "Add contact"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <FormField label="Phone number" required={!editing} hint={editing ? (contact?.phone ? "The phone number cannot be changed. Add a new contact instead." : "This person messages you through a WhatsApp username and has not shared a phone number.") : PHONE_HINT} error={phoneError}>
          <Input ref={phoneInput} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={editing} autoComplete="off" data-autofocus={editing ? undefined : ""} placeholder="+91 98765 43210" />
        </FormField>
        {editing && (contact?.username || contact?.bsuid) && (
          <p className="break-all text-xs text-muted">
            {contact?.username ? `WhatsApp username: @${contact.username}. ` : ""}
            {contact?.bsuid ? `WhatsApp user id: ${contact.bsuid}` : ""}
          </p>
        )}
        <FormField label="Name" optional>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="off" data-autofocus={editing ? "" : undefined} />
        </FormField>
        <FormField label="Tags" optional hint="Use tags to group people, like vip or newsletter. Separate them with commas.">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} autoComplete="off" />
        </FormField>

        <OwnerStageFields owner={owner} stage={stage} onOwner={setOwner} onStage={setStage} people={options.people} stages={options.stages} />

        {optedOut ? (
          <Alert tone="bad" title="This person opted out of marketing">
            {OPTED_OUT_NOTE}
          </Alert>
        ) : canRecordConsent ? (
          <fieldset className="space-y-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium">Permission to message</legend>
            <label className="flex min-h-10 items-start gap-3 text-sm">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-(--accent)" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
              <span>This person agreed to receive WhatsApp messages from my business.</span>
            </label>
            {contact?.optIn && !optIn && <Alert tone="warn">{OPT_OUT_WARNING}</Alert>}
            {optIn && (
              <FormField label="Where did they agree?" required={newlyOptingIn} error={sourceError} hint="For example: website form, in-store sign-up or order checkout. Keep proof of their consent.">
                <Input ref={sourceInput} value={source} onChange={(e) => setSource(e.target.value)} readOnly={!newlyOptingIn} />
              </FormField>
            )}
          </fieldset>
        ) : (
          <p className="text-sm text-muted">
            {contact?.optIn ? "This person has agreed to receive your messages." : "Only owners and admins can record that someone agreed to receive messages."}
          </p>
        )}

        {contact && <ConsentHistory contactId={contact.id} />}

        {contact && canRecordConsent && (
          <div className="space-y-1 rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">Their data</p>
            <p className="text-muted">If this person asks what you hold about them, download it here: their details, consent record, chats, notes and campaign history.</p>
            <p className="flex flex-wrap gap-x-4">
              <a href={`/api/export/contact/${contact.id}`} download className="inline-flex min-h-10 items-center font-medium text-accent-ink underline underline-offset-2">
                Download everything (JSON)
              </a>
              <a href={`/api/export/contact/${contact.id}?format=csv`} download className="inline-flex min-h-10 items-center font-medium text-accent-ink underline underline-offset-2">
                Download chat history (spreadsheet)
              </a>
            </p>
          </div>
        )}

        {error && (
          <Alert tone="bad" title="Contact not saved">
            {error}
          </Alert>
        )}
      </form>
    </Dialog>
  );
}

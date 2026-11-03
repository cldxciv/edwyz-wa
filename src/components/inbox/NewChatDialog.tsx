"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { displayName, displaySubtitle } from "@/lib/contacts/identity";
import { normalizePhone } from "@/lib/contacts/phone";
import { apiFetch, Button, Dialog, FormField, Input, Select, toast } from "@/components/ui";
import { TemplatePanel } from "./TemplatePanel";
import type { BusinessNumber, TemplateOption } from "./types";
import { templatesForWaba, wabaOf } from "./ux";

type ContactHit = { id: string; name: string | null; phone: string | null; bsuid?: string | null; username?: string | null; optedOutAt?: string | null };
type Mode = "phone" | "contact";

const PHONE_ERROR = "Enter a number with country code, like +91 98765 43210.";

/** What is wrong with the typed number, by the server's own rule (normalizePhone), or null when it is empty or fine. */
export function phoneProblem(value: string): string | null {
  return value.trim() && !normalizePhone(value) ? PHONE_ERROR : null;
}

/** Starts a chat by sending an approved template to a phone number or a saved contact. */
export function NewChatDialog({ isAdmin, onClose, onStarted }: { isAdmin: boolean; onClose: () => void; onStarted: (conversationId: string) => void }) {
  const [mode, setMode] = useState<Mode>("phone");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ContactHit[] | null>(null);
  const [picked, setPicked] = useState<ContactHit | null>(null);
  const [numbers, setNumbers] = useState<BusinessNumber[] | null>(null);
  const [numberId, setNumberId] = useState("");
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [confirmOptIn, setConfirmOptIn] = useState(false);
  // The number is checked once the field is left (or on send), then again on every change, so the message goes as soon as it is fixed.
  const [phoneChecked, setPhoneChecked] = useState(false);
  const phoneError = phoneChecked ? phoneProblem(phone) : null;

  const loadTemplates = useCallback(() => {
    setTemplatesError(null);
    apiFetch<{ templates: TemplateOption[] }>("/api/templates").then(
      (r) => setTemplates(r.templates),
      (e: unknown) => setTemplatesError(e instanceof Error ? e.message : "Could not load templates."),
    );
  }, []);

  useEffect(() => {
    loadTemplates();
    apiFetch<{ numbers: BusinessNumber[] }>("/api/inbox/numbers").then(
      (r) => {
        setNumbers(r.numbers);
        if (r.numbers.length === 1) setNumberId(r.numbers[0].id);
      },
      () => setNumbers([]),
    );
  }, [loadTemplates]);

  useEffect(() => {
    if (mode !== "contact") return;
    const t = setTimeout(() => {
      const q = search.trim();
      apiFetch<{ items: ContactHit[] }>(`/api/contacts?limit=8${q ? `&q=${encodeURIComponent(q)}` : ""}`).then(
        (r) => setHits(r.items),
        () => setHits([]),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [mode, search]);

  async function send(templateId: string, variables: string[]) {
    if (mode === "phone" && !phone.trim()) throw new Error("Enter the customer's number first, with the country code, like +91 98765 43210.");
    if (mode === "phone" && phoneProblem(phone)) {
      setPhoneChecked(true);
      throw new Error(PHONE_ERROR);
    }
    if (mode === "contact" && !picked) throw new Error("Pick a contact first.");
    if (numbers && numbers.length > 1 && !numberId) throw new Error("Choose which of your numbers to send from.");
    const body = {
      templateId,
      variables,
      ...(mode === "phone" ? { phone: phone.trim(), ...(name.trim() ? { name: name.trim() } : {}) } : { contactId: picked?.id }),
      ...(numberId ? { phoneNumberId: numberId } : {}),
      ...(isAdmin && confirmOptIn ? { confirmOptIn: true } : {}),
    };
    const r = await apiFetch<{ conversation: { id: string } }>("/api/inbox/conversations", { method: "POST", body });
    toast.success("Message sent. This chat is now assigned to you.");
    onStarted(r.conversation.id);
    onClose();
  }

  const noNumbers = numbers !== null && numbers.length === 0;
  // Only the chosen number's own WhatsApp Business Account templates can be sent from it. Until a number is chosen (or when the
  // list does not say which account a number belongs to) every template shows, and the server refuses a mismatch.
  const numberWaba = wabaOf(numbers?.find((n) => n.id === numberId));
  const sendable = useMemo(() => templatesForWaba(templates, numberWaba), [templates, numberWaba]);

  return (
    <Dialog title="Start a new chat" description="WhatsApp only lets you open a chat with an approved template. The customer can reply once they get it." onClose={onClose} size="lg">
      {noNumbers ? (
        <p role="alert" className="rounded-control border border-warn-line bg-warn-soft p-3 text-sm text-warn-fg">
          No WhatsApp number is connected yet. <a className="font-semibold underline" href="/app/settings/connect">Connect a number</a>{" "}to start chats.
        </p>
      ) : (
        <div className="space-y-4">
          <div role="group" aria-label="Who to message" className="inline-flex rounded-full border border-border-strong p-0.5 text-sm font-medium">
            {(["phone", "contact"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`rounded-full px-4 py-1.5 ${mode === m ? "bg-accent text-on-accent" : "hover:bg-surface-2"}`}
              >
                {m === "phone" ? "Phone number" : "Saved contact"}
              </button>
            ))}
          </div>

          {mode === "phone" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="WhatsApp number" hint="With country code, like +91 98765 43210" required error={phoneError}>
                <Input type="tel" inputMode="tel" autoComplete="off" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} onBlur={() => setPhoneChecked(true)} data-autofocus="" />
              </FormField>
              <FormField label="Name" optional hint="Saved with the contact">
                <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
              </FormField>
            </div>
          ) : (
            <div className="space-y-2">
              <FormField label="Find a contact" hint="Search by name, number or WhatsApp username">
                <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} data-autofocus="" />
              </FormField>
              <ul aria-label="Contacts" className="max-h-44 space-y-1 overflow-y-auto">
                {hits === null && <li className="p-2 text-sm text-muted">Loading contacts...</li>}
                {hits?.length === 0 && <li className="p-2 text-sm text-muted">No contact matches. Switch to Phone number to add someone new.</li>}
                {hits?.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-pressed={picked?.id === c.id}
                      onClick={() => setPicked(c)}
                      className={`flex w-full items-center justify-between gap-3 rounded-control border px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60 ${picked?.id === c.id ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2"}`}
                    >
                      <span className="truncate font-medium">{displayName(c)}</span>
                      <span className="shrink-0 text-xs text-muted">{c.optedOutAt ? "Opted out of marketing" : displaySubtitle(c)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {numbers && numbers.length > 1 && (
            <FormField label="Send from" required>
              <Select value={numberId} onChange={(e) => setNumberId(e.target.value)}>
                <option value="">Choose a number</option>
                {numbers.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.displayPhone}
                    {n.verifiedName ? ` (${n.verifiedName})` : ""}
                  </option>
                ))}
              </Select>
            </FormField>
          )}

          <div>
            <p className="mb-1.5 text-sm font-medium">Message</p>
            <div className="rounded-control border border-border p-2">
              <TemplatePanel
                templates={sendable}
                error={templatesError}
                onRetry={loadTemplates}
                contactName={mode === "contact" ? (picked?.name ?? null) : name.trim() || null}
                onSend={send}
              />
            </div>
          </div>

          {isAdmin && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={confirmOptIn} onChange={(e) => setConfirmOptIn(e.target.checked)} />
              <span>
                This person has agreed to get marketing messages from us
                <span className="block text-xs text-muted">Tick this only if you have their permission. We record that you confirmed it.</span>
              </span>
            </label>
          )}
          {!isAdmin && <p className="text-xs text-muted">Marketing templates need the customer&apos;s opt-in. Ask an admin to record it, or use a utility template.</p>}
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

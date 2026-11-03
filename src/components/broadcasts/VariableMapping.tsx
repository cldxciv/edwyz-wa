"use client";

import { useId, useState } from "react";
import { Alert, FormField, Input, Select } from "@/components/ui";
import {
  type MissingValuePolicy,
  POLICY_CHOICES,
  type Slot,
  type SourceChoice,
  UPLOAD_ACCEPT,
  type VariableMap,
  choiceLabel,
  choiceOf,
  choicesFor,
  fromChoice,
  mappingProblems,
} from "./mappingForm";

type Props = {
  slots: Slot[];
  map: VariableMap;
  onChange: (next: VariableMap) => void;
  policy: MissingValuePolicy;
  onPolicyChange: (next: MissingValuePolicy) => void;
  attributeKeys: readonly string[];
  /** The number the broadcast is sent from: an uploaded header file is uploaded to WhatsApp for this number. */
  phoneNumberId?: string;
  /** Show the "fill this in" messages (after the person tried to continue). */
  showProblems?: boolean;
};

type UploadedMedia = { id: string; filename: string; uploadedAt: string; phoneNumberId: string };

/**
 * Where each placeholder's value comes from, per person. A body placeholder can be the contact's name, phone number, a saved detail
 * (an attribute, like city) or fixed text. A header image, video or document is a file uploaded here, or a link (the same for
 * everyone or saved on each contact). A coupon-code button copies the same code for everyone or a code saved on each contact.
 */
export function VariableMapping({ slots, map, onChange, policy, onPolicyChange, attributeKeys, phoneNumberId, showProblems }: Props) {
  const id = useId();
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<Record<string, string>>({});
  const problems = showProblems ? mappingProblems(slots, map, policy, { phoneNumberId }) : {};
  const set = (key: string, src: VariableMap[string]) => onChange({ ...map, [key]: src });
  const needsFallback = policy === "fallback";

  async function upload(slot: Slot, file: File | undefined, input: HTMLInputElement) {
    if (!file || slot.kind !== "header_media") return;
    setUploadError((e) => ({ ...e, [slot.key]: "" }));
    if (!phoneNumberId) {
      setUploadError((e) => ({ ...e, [slot.key]: "Choose the number you send from first." }));
      return;
    }
    setUploading(slot.key);
    try {
      const res = await fetch(`/api/broadcasts/media?phoneNumberId=${encodeURIComponent(phoneNumberId)}&type=${slot.mediaType}`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
        body: file,
        credentials: "same-origin",
      });
      const json = (await res.json().catch(() => ({}))) as { media?: UploadedMedia; error?: string };
      if (!res.ok || !json.media) throw new Error(json.error ?? "The upload did not work. Try again.");
      const m = json.media;
      set(slot.key, { ...(map[slot.key]?.fallback ? { fallback: map[slot.key].fallback } : {}), source: "upload", value: m.id, filename: m.filename, uploadedAt: m.uploadedAt, phoneNumberId: m.phoneNumberId });
    } catch (e) {
      const message = e instanceof Error && !/failed to fetch|networkerror|load failed/i.test(e.message) ? e.message : "We could not reach the server. Check your connection and try again.";
      setUploadError((errs) => ({ ...errs, [slot.key]: message }));
      input.value = "";
    } finally {
      setUploading(null);
    }
  }

  return (
    <fieldset className="space-y-4 rounded-card border border-border p-4">
      <legend className="px-1 text-sm font-semibold">Fill in the placeholders</legend>
      <p className="text-sm text-muted">Each person gets their own values. Choose where each one comes from.</p>
      <datalist id={`${id}-keys`}>
        {attributeKeys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>

      {slots.map((slot, i) => {
        const src = map[slot.key];
        const choice = choiceOf(src);
        const rowId = `${id}-s${i}`;
        const error = uploadError[slot.key] || problems[slot.key] || null;
        const media = slot.kind === "header_media";
        const coupon = slot.kind === "button_copy_code";
        return (
          <div key={`${slot.kind}-${slot.key}`} className="space-y-3 rounded-control bg-surface p-3">
            <p className="text-sm font-medium">{slot.label}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Where it comes from">
                <Select value={choice} onChange={(e) => set(slot.key, fromChoice(e.target.value as SourceChoice, src))}>
                  {choicesFor(slot).map((c) => (
                    <option key={c} value={c}>
                      {choiceLabel(slot, c)}
                    </option>
                  ))}
                </Select>
              </FormField>
              {choice === "upload" && slot.kind === "header_media" && (
                <FormField label="File to send" error={error} hint={`${UPLOAD_ACCEPT[slot.mediaType].help} Everyone gets this file. WhatsApp keeps it for 30 days; we upload it again for long or scheduled broadcasts.`}>
                  <div className="space-y-2">
                    <input
                      id={rowId}
                      type="file"
                      accept={UPLOAD_ACCEPT[slot.mediaType].accept}
                      disabled={uploading !== null}
                      onChange={(e) => void upload(slot, e.target.files?.[0], e.target)}
                      className="block w-full text-sm file:mr-3 file:min-h-10 file:rounded-full file:border file:border-border-strong file:bg-raised file:px-4 file:text-sm file:font-semibold"
                    />
                    <p role="status" aria-live="polite" className="text-sm">
                      {uploading === slot.key ? "Uploading to WhatsApp..." : src?.value ? `Ready: ${src.filename ?? "your file"}` : "No file added yet."}
                    </p>
                  </div>
                </FormField>
              )}
              {choice === "attribute" && (
                <FormField
                  label={media ? "Name of the saved link" : coupon ? "Name of the saved code" : "Name of the saved detail"}
                  error={error}
                  hint={media ? "The detail on each contact that holds the link, like photo_url." : coupon ? "The detail on each contact that holds their code, like coupon." : "For example city or order_number. It must be saved on the contacts."}
                >
                  <Input id={rowId} list={`${id}-keys`} value={src?.key ?? ""} onChange={(e) => set(slot.key, { ...(src ?? { source: "attribute" }), source: "attribute", key: e.target.value })} autoComplete="off" maxLength={60} />
                </FormField>
              )}
              {choice === "static" && (
                <FormField
                  label={media ? "Link to the file" : coupon ? "Coupon code" : "Text to send"}
                  error={error}
                  hint={media ? "Must start with https:// and open without signing in. WhatsApp downloads it when the message is sent." : coupon ? "Up to 15 letters and numbers, without spaces, like SAVE20." : undefined}
                >
                  <Input
                    id={rowId}
                    type={media ? "url" : "text"}
                    inputMode={media ? "url" : undefined}
                    value={src?.value ?? ""}
                    onChange={(e) => set(slot.key, { ...(src ?? { source: "static" }), source: "static", value: e.target.value })}
                    autoComplete="off"
                    maxLength={media ? 2000 : coupon ? 15 : 1024}
                    placeholder={media ? "https://example.com/offer.jpg" : coupon ? "SAVE20" : undefined}
                  />
                </FormField>
              )}
              {choice.startsWith("field:") && error && <p role="alert" className="self-end text-sm text-bad-fg">{error}</p>}
            </div>
            {needsFallback && choice !== "static" && choice !== "upload" && (
              <FormField label={media ? "Fallback link" : coupon ? "Fallback code" : "Fallback text"} required error={choice === "attribute" ? null : error} hint="Used when a contact has no value.">
                <Input value={src?.fallback ?? ""} onChange={(e) => set(slot.key, { ...(src ?? { source: "attribute" }), fallback: e.target.value })} autoComplete="off" maxLength={media ? 2000 : coupon ? 15 : 1024} />
              </FormField>
            )}
            {needsFallback && choice === "attribute" && error && /fallback|coupon code/i.test(error) && <p role="alert" className="text-sm text-bad-fg">{error}</p>}
          </div>
        );
      })}

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">If a contact has no value for a placeholder</legend>
        {POLICY_CHOICES.map((p) => (
          <label key={p.value} className="flex min-h-10 cursor-pointer items-start gap-3 text-sm">
            <input type="radio" name={`${id}-policy`} value={p.value} checked={policy === p.value} onChange={() => onPolicyChange(p.value)} className="mt-1 h-4 w-4 shrink-0 accent-accent" />
            <span>
              <span className="block font-medium">{p.label}</span>
              <span className="block text-muted">{p.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Alert tone="info">WhatsApp does not allow line breaks, tabs or long runs of spaces inside a value. We tidy those up for you.</Alert>
    </fieldset>
  );
}

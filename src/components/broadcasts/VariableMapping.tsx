"use client";

import { useId } from "react";
import { Alert, FormField, Input, Select } from "@/components/ui";
import {
  CHOICE_LABELS,
  MEDIA_CHOICE_LABELS,
  type MissingValuePolicy,
  POLICY_CHOICES,
  type Slot,
  type SourceChoice,
  type VariableMap,
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
  /** Show the "fill this in" messages (after the person tried to continue). */
  showProblems?: boolean;
};

/**
 * Where each placeholder's value comes from, per person. A body placeholder can be the contact's name, phone number, a saved detail
 * (an attribute, like city) or fixed text. A header image, video or document is a link, the same for everyone or saved on each contact.
 */
export function VariableMapping({ slots, map, onChange, policy, onPolicyChange, attributeKeys, showProblems }: Props) {
  const id = useId();
  const problems = showProblems ? mappingProblems(slots, map, policy) : {};
  const set = (key: string, src: VariableMap[string]) => onChange({ ...map, [key]: src });
  const needsFallback = policy === "fallback";

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
        const error = problems[slot.key] ?? null;
        const media = slot.kind === "header_media";
        return (
          <div key={`${slot.kind}-${slot.key}`} className="space-y-3 rounded-control bg-surface p-3">
            <p className="text-sm font-medium">{slot.label}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Where it comes from">
                <Select value={choice} onChange={(e) => set(slot.key, fromChoice(e.target.value as SourceChoice, src))}>
                  {choicesFor(slot).map((c) => (
                    <option key={c} value={c}>
                      {media ? (MEDIA_CHOICE_LABELS[c] ?? CHOICE_LABELS[c]) : CHOICE_LABELS[c]}
                    </option>
                  ))}
                </Select>
              </FormField>
              {choice === "attribute" && (
                <FormField label={media ? "Name of the saved link" : "Name of the saved detail"} error={error} hint={media ? "The detail on each contact that holds the link, like photo_url." : "For example city or order_number. It must be saved on the contacts."}>
                  <Input id={rowId} list={`${id}-keys`} value={src?.key ?? ""} onChange={(e) => set(slot.key, { ...(src ?? { source: "attribute" }), source: "attribute", key: e.target.value })} autoComplete="off" maxLength={60} />
                </FormField>
              )}
              {choice === "static" && (
                <FormField label={media ? "Link to the file" : "Text to send"} error={error} hint={media ? "Must start with https:// and open without signing in. WhatsApp downloads it when the message is sent." : undefined}>
                  <Input
                    id={rowId}
                    type={media ? "url" : "text"}
                    inputMode={media ? "url" : undefined}
                    value={src?.value ?? ""}
                    onChange={(e) => set(slot.key, { ...(src ?? { source: "static" }), source: "static", value: e.target.value })}
                    autoComplete="off"
                    maxLength={media ? 2000 : 1024}
                    placeholder={media ? "https://example.com/offer.jpg" : undefined}
                  />
                </FormField>
              )}
              {choice.startsWith("field:") && error && <p role="alert" className="self-end text-sm text-bad-fg">{error}</p>}
            </div>
            {needsFallback && choice !== "static" && (
              <FormField label={media ? "Fallback link" : "Fallback text"} required error={choice === "attribute" ? null : error} hint="Used when a contact has no value.">
                <Input value={src?.fallback ?? ""} onChange={(e) => set(slot.key, { ...(src ?? { source: "attribute" }), fallback: e.target.value })} autoComplete="off" maxLength={media ? 2000 : 1024} />
              </FormField>
            )}
            {needsFallback && choice === "attribute" && error && /fallback/i.test(error) && <p role="alert" className="text-sm text-bad-fg">{error}</p>}
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

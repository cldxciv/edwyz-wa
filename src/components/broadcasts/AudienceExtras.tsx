"use client";

import Link from "next/link";
import { FormField, Select } from "@/components/ui";

type Named = { id: string; name: string; description?: string };

/** Picker for a saved or ready-made segment. */
export function SegmentPicker({ value, onChange, segments, presets }: { value: string; onChange: (id: string) => void; segments: Named[]; presets: Named[] }) {
  const chosen = [...segments, ...presets].find((s) => s.id === value);
  return (
    <div className="space-y-2">
      <FormField label="Segment" hint="The group is worked out again when you send, so it always reflects your latest contacts.">
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a segment</option>
          {segments.length > 0 && (
            <optgroup label="Your segments">
              {segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Ready-made">
            {presets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </optgroup>
        </Select>
      </FormField>
      {chosen?.description && <p className="text-sm text-muted">{chosen.description}</p>}
      <p className="text-sm">
        <Link href="/app/contacts/segments" className="font-medium text-accent-ink underline-offset-2 hover:underline">
          Make or change segments
        </Link>
      </p>
    </div>
  );
}

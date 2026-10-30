"use client";

import { Skeleton } from "@/components/ui";
import { useApi } from "./hooks";

type Event = { at: string; kind: "opt_in" | "withdrawn" | "opted_out"; source: string | null; by: { id: string; name: string | null; email: string } | "contact" | null };
type Consent = { events: Event[]; current: { optIn: boolean; optInSource: string | null; optInAt: string | null; optedOutAt: string | null } };

export function consentLine(e: Event): string {
  const who = e.by === "contact" ? "by the contact" : e.by ? `by ${e.by.name || e.by.email}` : "";
  const via = e.source ? (e.kind === "opt_in" ? `, ${e.source}` : ` (${e.source})`) : "";
  if (e.kind === "opt_in") return `Agreed to receive messages${via}${who ? `, recorded ${who}` : ""}`;
  if (e.kind === "withdrawn") return `Permission removed${who ? ` ${who}` : ""}`;
  return `Opted out${via}${who && e.by !== "contact" ? ` ${who}` : ""}`;
}

/** Proof of consent for one contact: when and how they agreed, and who recorded it. */
export function ConsentHistory({ contactId }: { contactId: string }) {
  const { data, error, loading } = useApi<Consent>(`/api/contacts/${contactId}/consent`);
  return (
    <details className="rounded-lg border border-border p-3 text-sm">
      <summary className="min-h-8 cursor-pointer font-medium">Consent record</summary>
      <div className="mt-2" aria-live="polite">
        {loading ? (
          <Skeleton className="h-10 w-full" />
        ) : error || !data ? (
          <p className="text-muted">We could not load the consent record. Close this window and try again.</p>
        ) : data.events.length === 0 ? (
          <p className="text-muted">
            {data.current.optIn ? `Agreed${data.current.optInSource ? `: ${data.current.optInSource}` : ""}${data.current.optInAt ? ` on ${new Date(data.current.optInAt).toLocaleString()}` : ""}. No other details were recorded.` : "Nothing has been recorded yet."}
          </p>
        ) : (
          <ol className="space-y-2">
            {data.events.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <p>{consentLine(e)}</p>
                <p className="text-xs text-muted">{new Date(e.at).toLocaleString()}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

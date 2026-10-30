"use client";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, cn, Input } from "@/components/ui";
import { bodyText, fillTemplate, inlineSendable } from "@/lib/inbox/template-vars";
import type { TemplateOption } from "./types";

const footerOf = (components: unknown) => {
  const f = Array.isArray(components) ? components.find((c) => c && typeof c === "object" && String((c as { type?: unknown }).type).toUpperCase() === "FOOTER") : null;
  const text = f && typeof f === "object" ? (f as { text?: unknown }).text : null;
  return typeof text === "string" ? text : "";
};

/** Approved templates with variable inputs and a live preview. Used inline in the composer. */
export function TemplatePanel({
  templates,
  error,
  onRetry,
  initialId,
  contactName,
  onSend,
  onCancel,
}: {
  templates: TemplateOption[] | null;
  error: string | null;
  onRetry: () => void;
  initialId?: string | null;
  contactName: string | null;
  onSend: (templateId: string, variables: string[]) => Promise<void>;
  onCancel?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const approved = useMemo(() => (templates ?? []).filter((t) => t.status === "approved"), [templates]);
  const shown = approved.filter((t) => t.name.includes(query.trim().toLowerCase().replace(/\s+/g, "_")) || bodyText(t.components).toLowerCase().includes(query.trim().toLowerCase()));
  const selected = approved.find((t) => t.id === selectedId) ?? null;
  const fit = selected ? inlineSendable(selected.components) : null;

  function choose(t: TemplateOption) {
    const f = inlineSendable(t.components);
    if (!f.ok) return;
    const first = contactName?.trim().split(/\s+/)[0] ?? "";
    setSelectedId(t.id);
    setValues(Array.from({ length: f.variables }, (_, i) => (i === 0 ? first : "")));
    setFailure(null);
  }

  // Selecting through choose() (not the initial state) is what fills in the variable values.
  useEffect(() => {
    if (initialId && !selected) {
      const t = approved.find((x) => x.id === initialId);
      if (t) choose(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId, approved.length]);

  async function send() {
    if (!selected || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSend(selected.id, values);
      setSelectedId(null);
      setValues([]);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Could not send the template.");
    } finally {
      setBusy(false);
    }
  }

  const ready = fit?.ok && values.length === fit.variables && values.every((v) => v.trim());

  if (templates === null && !error) return <div role="status" className="space-y-2" aria-label="Loading templates"><div className="h-8 animate-pulse rounded-lg bg-surface" /><div className="h-8 animate-pulse rounded-lg bg-surface" /></div>;
  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
        Could not load templates: {error}{" "}
        <button type="button" className="font-semibold underline" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  if (approved.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted">
        No approved templates yet. Create one and wait for WhatsApp to approve it, then it appears here.{" "}
        <a className="font-semibold text-accent underline" href="/app/templates">Open templates</a>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {!selected && (
        <>
          <Input aria-label="Search templates" type="search" placeholder="Search templates" value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul className="max-h-44 space-y-1 overflow-y-auto" aria-label="Approved templates">
            {shown.length === 0 && <li className="p-2 text-xs text-muted">No template matches.</li>}
            {shown.map((t) => {
              const f = inlineSendable(t.components);
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={!f.ok}
                    onClick={() => choose(t)}
                    className="block w-full rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{t.name.replace(/_/g, " ")}</span>
                      <Badge>{t.language}</Badge>
                    </span>
                    <span className="line-clamp-2 block text-xs text-muted">{f.ok ? bodyText(t.components) : f.reason}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {selected && fit?.ok && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-semibold">{selected.name.replace(/_/g, " ")}</p>
            <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>Change</Button>
          </div>
          {fit.variables > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {values.map((v, i) => (
                <Input key={i} aria-label={`Value for {{${i + 1}}}`} placeholder={`Value for {{${i + 1}}}`} maxLength={1024} value={v} onChange={(e) => setValues((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} />
              ))}
            </div>
          )}
          <div className={cn("rounded-lg border border-border bg-surface p-3 text-sm")} aria-label="Template preview">
            <p className="whitespace-pre-wrap break-words">{fillTemplate(bodyText(selected.components), values)}</p>
            {footerOf(selected.components) && <p className="mt-1 text-xs text-muted">{footerOf(selected.components)}</p>}
          </div>
          {selected.category === "MARKETING" && <p className="text-xs text-muted">Marketing template: the contact must have opted in.</p>}
          {failure && <p role="alert" className="text-xs text-red-700">{failure}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void send()} disabled={!ready || busy}>{busy ? "Sending" : "Send template"}</Button>
            {onCancel && <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
          </div>
        </div>
      )}
      {!selected && onCancel && <Button variant="ghost" size="sm" onClick={onCancel}>Close</Button>}
    </div>
  );
}

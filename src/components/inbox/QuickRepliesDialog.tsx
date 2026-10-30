"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, Button, Field, Input, Spinner, Textarea } from "@/components/ui";
import { REPLY_VARIABLES } from "@/lib/inbox/variables";
import type { QuickReply } from "./types";

export function QuickRepliesDialog({ canDelete, onClose }: { canDelete: boolean; onClose: () => void }) {
  const [items, setItems] = useState<QuickReply[] | null>(null);
  const [editing, setEditing] = useState<QuickReply | null>(null);
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    try {
      setItems((await apiFetch<{ items: QuickReply[] }>("/api/quick-replies")).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load quick replies.");
    }
  }, []);

  useEffect(() => {
    dialog.current?.showModal();
    void load();
  }, [load]);

  function reset() {
    setEditing(null);
    setShortcut("");
    setBody("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing) await apiFetch(`/api/quick-replies/${editing.id}`, { method: "PATCH", body: { shortcut, body } });
      else await apiFetch("/api/quick-replies", { method: "POST", body: { shortcut, body } });
      reset();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: QuickReply) {
    setError(null);
    try {
      await apiFetch(`/api/quick-replies/${item.id}`, { method: "DELETE" });
      if (editing?.id === item.id) reset();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete.");
    }
  }

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="qr-title" className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-border bg-background p-0 text-foreground backdrop:bg-black/40">
      <div className="max-h-[85dvh] overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="qr-title" className="text-lg font-semibold">Quick replies</h2>
          <Button variant="ghost" size="sm" onClick={() => dialog.current?.close()}>Close</Button>
        </div>
        <p className="mb-2 text-xs text-muted">Type / in the message box, then the shortcut, to insert a saved reply.</p>
        <p className="mb-4 text-xs text-muted">
          You can personalise a reply. We fill these in when you insert it:{" "}
          {REPLY_VARIABLES.map((v, i) => (
            <span key={v.token}>
              <code title={v.help} className="rounded bg-surface px-1">{v.token}</code>
              {i < REPLY_VARIABLES.length - 1 ? ", " : "."}
            </span>
          ))}
        </p>

        <form onSubmit={save} className="space-y-3 rounded-xl border border-border p-3">
          <Field label="Shortcut" htmlFor="qr-shortcut" hint="Letters, numbers, dashes. Example: hours">
            <Input id="qr-shortcut" value={shortcut} maxLength={40} onChange={(e) => setShortcut(e.target.value)} required />
          </Field>
          <Field label="Reply text" htmlFor="qr-body">
            <Textarea id="qr-body" rows={3} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} required />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>{editing ? "Save changes" : "Add quick reply"}</Button>
            {editing && <Button type="button" variant="secondary" size="sm" onClick={reset}>Cancel</Button>}
          </div>
        </form>

        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}

        <ul className="mt-4 space-y-2">
          {items === null && !error && <li><Spinner /></li>}
          {items?.length === 0 && <li className="text-sm text-muted">No quick replies yet.</li>}
          {items?.map((q) => (
            <li key={q.id} className="flex items-start justify-between gap-3 rounded-lg border border-border p-2.5 text-sm">
              <div className="min-w-0">
                <p className="font-semibold">/{q.shortcut}</p>
                <p className="line-clamp-2 break-words text-muted">{q.body}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="secondary" size="sm" onClick={() => { setEditing(q); setShortcut(q.shortcut); setBody(q.body); }}>Edit</Button>
                {canDelete && <Button variant="danger" size="sm" onClick={() => void remove(q)}>Delete</Button>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  );
}

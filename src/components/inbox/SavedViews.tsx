"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, Button, confirm, Dialog, FormField, Input, Select, toast } from "@/components/ui";
import type { SavedView } from "./types";

type Query = SavedView["query"];

/** Pick a saved view, save the current tab, tag and search as a view, or delete one. */
export function SavedViews({ current, canShare, onApply }: { current: Query; canShare: boolean; onApply: (query: Query) => void }) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [chosen, setChosen] = useState("");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setViews((await apiFetch<{ filters: SavedView[] }>("/api/inbox/filters")).filters);
    } catch {
      setViews([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const selected = views.find((v) => v.id === chosen) ?? null;
  const worthSaving = current.tab !== "all" || !!current.tag || !!current.q;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ filter: SavedView }>("/api/inbox/filters", { method: "POST", body: { name: name.trim(), query: current, shared } });
      toast.success(`Saved the view "${r.filter.name}"`);
      setSaving(false);
      setName("");
      setShared(false);
      await load();
      setChosen(r.filter.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not save this view. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(view: SavedView) {
    const ok = await confirm({ title: `Delete the view "${view.name}"?`, body: view.shared ? "It disappears for everyone in your workspace." : "Your chats are not affected.", confirmLabel: "Delete view", tone: "danger" });
    if (!ok) return;
    try {
      await apiFetch(`/api/inbox/filters/${view.id}`, { method: "DELETE" });
      setChosen("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "We could not delete this view.");
    }
  }

  if (views.length === 0 && !worthSaving) return null;

  return (
    <div className="flex items-center gap-1.5">
      {views.length > 0 && (
        <Select
          aria-label="Saved views"
          className="min-w-0 flex-1 py-1 text-xs"
          value={chosen}
          onChange={(e) => {
            setChosen(e.target.value);
            const v = views.find((x) => x.id === e.target.value);
            if (v) onApply(v.query);
          }}
        >
          <option value="">Saved views</option>
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.shared ? " (team)" : ""}
            </option>
          ))}
        </Select>
      )}
      {selected && (selected.mine || canShare) && (
        <Button variant="ghost" size="sm" onClick={() => void remove(selected)} aria-label={`Delete the view ${selected.name}`}>Delete</Button>
      )}
      {worthSaving && <Button variant="ghost" size="sm" onClick={() => setSaving(true)}>Save view</Button>}
      {saving && (
        <Dialog
          title="Save this view"
          description="Come back to these filters in one click."
          size="sm"
          onClose={() => setSaving(false)}
          dismissible={!busy}
          footer={
            <>
              <Button variant="secondary" onClick={() => setSaving(false)} disabled={busy}>Cancel</Button>
              <Button onClick={() => void save()} loading={busy} disabled={!name.trim()}>Save view</Button>
            </>
          }
        >
          <div className="space-y-3">
            <FormField label="Name" error={error}>
              <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} data-autofocus="" onKeyDown={(e) => e.key === "Enter" && name.trim() && void save()} />
            </FormField>
            {canShare && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
                Share with everyone in the workspace
              </label>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}

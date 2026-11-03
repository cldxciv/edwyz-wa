"use client";
import { useEffect, useState } from "react";
import { apiFetch, Button, Dialog, FormField, Skeleton, Textarea, toast } from "@/components/ui";
import { StopWordsEditor } from "@/components/contacts/StopWordsEditor";
import type { InboxSettings } from "./types";

/** Workspace-wide inbox options. Admins only. */
export function InboxSettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<InboxSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<{ settings: InboxSettings }>("/api/inbox/settings").then(
      (r) => setSettings(r.settings),
      (e: unknown) => setError(e instanceof Error ? e.message : "Could not load the settings."),
    );
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch("/api/inbox/settings", { method: "PUT", body: settings });
      toast.success("Inbox settings saved");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? `We could not save the settings. ${e.message}` : "We could not save the settings. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title="Inbox settings"
      description="These apply to everyone in your workspace."
      onClose={onClose}
      dismissible={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void save()} loading={saving} disabled={!settings}>Save settings</Button>
        </>
      }
    >
      {!settings && !error && <Skeleton className="h-32 w-full" />}
      {error && <p role="alert" className="mb-3 text-sm text-bad-fg">{error}</p>}
      {settings && (
        <div className="space-y-5">
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1" checked={settings.agentSignature} onChange={(e) => setSettings({ ...settings, agentSignature: e.target.checked })} />
            <span>
              <span className="font-medium">Show the agent&apos;s name in replies</span>
              <span className="block text-muted">Customers see who is writing: the name appears in bold above each text message your team sends.</span>
            </span>
          </label>
          <StopWordsEditor words={settings.stopWords ?? []} onChange={(stopWords) => setSettings({ ...settings, stopWords })} />
          <FormField
            label="When a customer sends a STOP word"
            hint="We send this once. Say that they get no marketing messages, that order updates and replies to their own messages can still arrive, and that START brings offers back. Leave empty to send nothing."
          >
            <Textarea rows={3} maxLength={500} value={settings.optOutReply} onChange={(e) => setSettings({ ...settings, optOutReply: e.target.value })} />
          </FormField>
          <FormField label="When they send START to get offers again" hint="Only sent to people who had opted out. Leave empty to send nothing.">
            <Textarea rows={3} maxLength={500} value={settings.optInReply} onChange={(e) => setSettings({ ...settings, optInReply: e.target.value })} />
          </FormField>
        </div>
      )}
    </Dialog>
  );
}

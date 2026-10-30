"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Alert, Button, Dialog, FormField, Select, Skeleton, apiFetch, toast } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { categoryLabel, friendlyError, humanizeName, languageName } from "./helpers";

export type Outcome = "unsent" | "unread" | "read" | "failed";

const COPY: Record<Outcome, { title: string; intro: string; button: string }> = {
  unsent: {
    title: "Send the rest with another template",
    intro: "This starts a new draft for the people who have not received a message yet, or whose message failed. People who already got it are left out, so nobody is messaged twice. If the original broadcast is paused, it stays paused until you send the new draft, and sending the draft cancels it.",
    button: "Create the new draft",
  },
  unread: {
    title: "Follow up with people who did not read it",
    intro: "This starts a new draft for the people the message reached but who have not opened it. Some people turn off read receipts, so a few may have read it.",
    button: "Create the follow-up draft",
  },
  read: { title: "Follow up with people who read it", intro: "This starts a new draft for the people who opened the message.", button: "Create the follow-up draft" },
  failed: { title: "Try the people it failed for", intro: "This starts a new draft for the people whose message failed, using another template.", button: "Create the new draft" },
};

type Template = { id: string; name: string; language: string; category: string };

/** Picks another approved template for part of a broadcast's people, then opens the new draft. Nothing is sent until the draft is started. */
export function FollowUpDialog({ broadcastId, outcome, onClose }: { broadcastId: string; outcome: Outcome; onClose: () => void }) {
  const router = useRouter();
  const copy = COPY[outcome];
  const formId = useId();
  const { data, error, loading } = useApi<{ templates: Template[] }>(`/api/broadcasts/${broadcastId}/follow-up`);
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!templateId) return setProblem("Choose a template.");
    setBusy(true);
    setProblem("");
    try {
      const result = await apiFetch<{ broadcast: { id: string }; people: number }>(`/api/broadcasts/${broadcastId}/follow-up`, { method: "POST", body: { templateId, outcome } });
      toast.success("Draft created", { description: `${result.people.toLocaleString()} ${result.people === 1 ? "person" : "people"} added. Check it, then press Send.` });
      router.push(`/app/broadcasts/${result.broadcast.id}`);
    } catch (err) {
      setProblem(friendlyError((err as Error).message, "We could not create the draft. Check your connection and try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={copy.title}
      description={copy.intro}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy} disabled={loading || !data || data.templates.length === 0}>
            {copy.button}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4" noValidate>
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : error || !data ? (
          <Alert tone="bad">{friendlyError(error, "We could not load your templates. Close this window and try again.")}</Alert>
        ) : data.templates.length === 0 ? (
          <Alert tone="warn" title="No other template can be used yet">
            Only approved templates whose placeholders you already filled in can be used here. Create or get another template approved under Templates, then come back.
          </Alert>
        ) : (
          <FormField label="Template" required hint="Only approved templates that fit the values you already chose are listed.">
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} data-autofocus="">
              <option value="">Choose a template</option>
              {data.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {humanizeName(t.name)} ({languageName(t.language)}, {categoryLabel(t.category)})
                </option>
              ))}
            </Select>
          </FormField>
        )}
        {problem && <Alert tone="bad">{problem}</Alert>}
      </form>
    </Dialog>
  );
}

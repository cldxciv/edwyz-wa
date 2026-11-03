"use client";

import { displayName } from "@/lib/contacts/identity";
import { useId, useMemo, useState } from "react";
import { Alert, Button, Card, DataTable, Dialog, EmptyState, ErrorState, FormField, Input, apiFetch, confirm, toast, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { friendlyError } from "@/components/contacts/helpers";
import { LinkButton } from "@/components/broadcasts/LinkButton";
import type { Filter } from "@/lib/segments/filter";
import { FilterBuilder } from "./FilterBuilder";
import { type Draft, draftProblems, draftToFilter, emptyDraft, filterToDraft, previewSentence, summarizeFilter } from "./helpers";
import { usePreview } from "./usePreview";

type Segment = { id: string; name: string; filter: Filter; updatedAt: string };
type Preset = { id: string; name: string; description: string; filter: Filter };
type Listing = { segments: Segment[]; presets: Preset[]; attributeKeys: string[]; tags: string[] };

const BACK = [{ label: "Contacts", href: "/app/contacts" }, { label: "Segments" }];

function SegmentDialog({ segment, attributeKeys, tags, onClose, onSaved }: { segment: Segment | null; attributeKeys: string[]; tags: string[]; onClose: () => void; onSaved: (message: string) => void }) {
  const formId = useId();
  const [name, setName] = useState(segment?.name ?? "");
  const [draft, setDraft] = useState<Draft>(segment ? filterToDraft(segment.filter) : emptyDraft());
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const problems = draftProblems(draft);
  const filter = draftToFilter(draft);
  const ready = problems.length === 0;
  const { preview, pending, error: previewError, retry } = usePreview("/api/segments/preview", ready ? { filter } : null);
  const nameError = tried && !name.trim() ? "Give the segment a name." : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError("");
    if (!name.trim() || !ready) return;
    setBusy(true);
    try {
      if (segment) await apiFetch(`/api/segments/${segment.id}`, { method: "PATCH", body: { name: name.trim(), filter } });
      else await apiFetch("/api/segments", { method: "POST", body: { name: name.trim(), filter } });
      onSaved(segment ? "Segment updated" : "Segment saved");
    } catch (err) {
      setError(friendlyError(err, "We could not save this segment. Check your connection and try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={segment ? "Edit segment" : "New segment"}
      description="A segment is a saved group of contacts that updates itself. Use it for broadcasts, or to look at the group in Contacts."
      size="lg"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {segment ? "Save changes" : "Save segment"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <FormField label="Name" required error={nameError} hint="For example Delhi customers or Bought in the last 30 days.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" data-autofocus="" />
        </FormField>
        <FilterBuilder value={draft} onChange={setDraft} attributeKeys={attributeKeys} tags={tags} showProblems={tried} idPrefix={`${formId}-f`} />
        <div role="status" aria-live="polite" className="rounded-control bg-surface p-3 text-sm">
          {!ready ? (
            <span className="text-muted">Finish the rules above to see who matches.</span>
          ) : previewError ? (
            <span>
              We could not count the people.{" "}
              <button type="button" className="font-medium text-accent-ink underline" onClick={retry}>
                Try again
              </button>
            </span>
          ) : pending || !preview ? (
            <span className="text-muted">Counting people...</span>
          ) : (
            <>
              <p>{previewSentence(preview, "segment")}</p>
              {preview.sample.length > 0 && <p className="mt-1 text-xs text-muted">For example: {preview.sample.map((s) => displayName(s)).join(", ")}</p>}
            </>
          )}
        </div>
        {error && (
          <Alert tone="bad" title="Segment not saved">
            {error}
          </Alert>
        )}
      </form>
    </Dialog>
  );
}

export function SegmentsView() {
  const role = useRole();
  const admin = canManage(role);
  const { data, error, loading, reload, retry } = useApi<Listing>("/api/segments");
  const [dialog, setDialog] = useState<null | { segment: Segment | null }>(null);

  async function remove(segment: Segment) {
    const ok = await confirm({
      title: `Delete "${segment.name}"?`,
      body: "The contacts stay as they are. Broadcasts that have not finished and use this segment must be finished or canceled first.",
      confirmLabel: "Delete segment",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/segments/${segment.id}`, { method: "DELETE" });
      toast.success("Segment deleted");
      reload();
    } catch (e) {
      toast.error("We could not delete this segment", { description: friendlyError(e, "Check your connection and try again.") });
    }
  }

  const columns = useMemo<Column<Segment>[]>(
    () => [
      { key: "name", header: "Segment", primary: true, cell: (s) => <span className="font-medium">{s.name}</span> },
      { key: "rules", header: "Who is in it", cell: (s) => <span className="text-sm">{summarizeFilter(s.filter)}</span> },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        align: "right",
        cell: (s) => (
          <span className="flex flex-wrap justify-end gap-1">
            <LinkButton href={`/app/contacts?segment=${encodeURIComponent(s.id)}`} variant="ghost" size="sm" className="max-sm:min-h-10" aria-label={`See contacts in ${s.name}`}>
              See contacts
            </LinkButton>
            {admin && (
              <>
                <LinkButton href={`/app/broadcasts/new?segment=${encodeURIComponent(s.id)}`} variant="ghost" size="sm" className="max-sm:min-h-10" aria-label={`Send a broadcast to ${s.name}`}>
                  Send a broadcast
                </LinkButton>
                <Button size="sm" variant="ghost" className="max-sm:min-h-10" onClick={() => setDialog({ segment: s })} aria-label={`Edit ${s.name}`}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" className="max-sm:min-h-10" onClick={() => void remove(s)} aria-label={`Delete ${s.name}`}>
                  Delete
                </Button>
              </>
            )}
          </span>
        ),
      },
    ],
    [admin], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Segments" breadcrumbs={BACK} />
        <ErrorState title="We could not load your segments" message={`${friendlyError(error, "Something went wrong on our side.")} Check your connection and try again.`} action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Segments"
        breadcrumbs={BACK}
        description="Saved groups of contacts, like everyone in Delhi who bought this month. They update by themselves as your contacts change."
        actions={admin && <Button className="max-sm:min-h-11" onClick={() => setDialog({ segment: null })}>New segment</Button>}
      />

      <Card className="mb-6" title="Your segments" padded={false}>
        <DataTable
          caption="Your segments"
          columns={columns}
          rows={data?.segments ?? []}
          rowKey={(s) => s.id}
          loading={loading}
          empty={
            <EmptyState
              compact
              title="No segments yet"
              body="Make a segment to message the same group again and again without picking tags each time."
              action={admin ? <Button onClick={() => setDialog({ segment: null })}>New segment</Button> : undefined}
            />
          }
        />
      </Card>

      <Card title="Ready-made segments" description="These are always up to date. They are based on when people last wrote to you.">
        <ul className="grid gap-3 sm:grid-cols-2">
          {(data?.presets ?? []).map((p) => (
            <li key={p.id} className="rounded-control border border-border p-3">
              <p className="font-medium">{p.name}</p>
              <p className="mt-0.5 text-sm text-muted">{p.description}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <LinkButton href={`/app/contacts?segment=${encodeURIComponent(p.id)}`} variant="secondary" size="sm" className="max-sm:min-h-10" aria-label={`See contacts in ${p.name}`}>
                  See contacts
                </LinkButton>
                {admin && (
                  <LinkButton href={`/app/broadcasts/new?segment=${encodeURIComponent(p.id)}`} variant="ghost" size="sm" className="max-sm:min-h-10" aria-label={`Send a broadcast to ${p.name}`}>
                    Send a broadcast
                  </LinkButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {dialog && (
        <SegmentDialog
          segment={dialog.segment}
          attributeKeys={data?.attributeKeys ?? []}
          tags={data?.tags ?? []}
          onClose={() => setDialog(null)}
          onSaved={(message) => {
            toast.success(message);
            setDialog(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

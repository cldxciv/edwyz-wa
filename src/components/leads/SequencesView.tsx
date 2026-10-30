"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, EmptyState, ErrorState, PageHeader, Skeleton, StatusPill, apiFetch, confirm, toast } from "@/components/ui";
import { canManage, useRole } from "@/components/contacts/hooks";
import { LeadsNav } from "./LeadsNav";
import { SequenceBuilder, type Option, type Sequence } from "./SequenceBuilder";
import { buildTimeline, describeStep, formatDelay, friendlyError, sequenceLength, sequenceScope } from "./helpers";
import type { StepDraft } from "./types";

function StepList({ steps, templates, chatbots }: { steps: Partial<StepDraft>[]; templates: Option[]; chatbots: Option[] }) {
  const full = steps.map((s) => ({ delayMinutes: s.delayMinutes ?? 0, templateId: s.templateId ?? "", chatbotId: s.chatbotId ?? "", stopOnReply: s.stopOnReply !== false }));
  const timeline = buildTimeline(full);
  return (
    <ol className="mt-3 space-y-2 border-l-2 border-border-strong pl-4">
      {full.map((s, i) => (
        <li key={i} className="relative text-sm">
          <span aria-hidden className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-accent" />
          <span className="font-medium">{timeline[i].at === 0 ? "Right away" : `After ${formatDelay(timeline[i].at)}`}</span>
          <span className="text-muted">: {describeStep(s, i, templates, chatbots)}</span>
        </li>
      ))}
    </ol>
  );
}

export function SequencesView() {
  const role = useRole();
  const admin = canManage(role);
  const [items, setItems] = useState<Sequence[] | null>(null);
  const [templates, setTemplates] = useState<Option[]>([]);
  const [chatbots, setChatbots] = useState<Option[]>([]);
  const [forms, setForms] = useState<Option[]>([]);
  const [editing, setEditing] = useState<Sequence | "new" | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [back, setBack] = useState<string | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    try {
      setItems((await apiFetch<{ items: Sequence[] }>("/api/leads/sequences")).items);
      setError("");
    } catch (e) {
      setError(friendlyError(e));
    }
  }, []);

  useEffect(() => {
    if (!admin) return;
    void load();
    apiFetch<{ templates: (Option & { status: string })[] }>("/api/templates")
      .then((r) => setTemplates(r.templates.filter((t) => t.status === "approved")))
      .catch(() => undefined);
    apiFetch<{ chatbots: Option[] }>("/api/chatbots")
      .then((r) => setChatbots(r.chatbots))
      .catch(() => undefined);
    apiFetch<{ items: { id: string; name: string | null; metaFormId: string }[] }>("/api/leads/forms")
      .then((r) => setForms(r.items.map((f) => ({ id: f.id, name: f.name ?? "Untitled form" }))))
      .catch(() => undefined);
  }, [admin, load]);

  useEffect(() => {
    if (editing || !back) return;
    const target = back === "list" ? listHeading.current : document.querySelector<HTMLElement>(back === "new" ? "[data-seq-new]" : `[data-seq-edit="${CSS.escape(back)}"]`);
    (target ?? listHeading.current)?.focus();
    setBack(null);
  }, [editing, back, items]);

  async function toggle(s: Sequence) {
    setBusyId(s.id);
    try {
      await apiFetch(`/api/leads/sequences/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } });
      toast.success(s.enabled ? `"${s.name}" is off` : `"${s.name}" is on`);
      await load();
    } catch (e) {
      toast.error("We could not change that sequence", { description: friendlyError(e) });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(s: Sequence) {
    const ok = await confirm({
      title: `Delete "${s.name}"?`,
      body: "Follow-ups already running for leads stop right away. This cannot be undone.",
      confirmLabel: "Delete sequence",
      tone: "danger",
    });
    if (!ok) return;
    setBusyId(s.id);
    try {
      await apiFetch(`/api/leads/sequences/${s.id}`, { method: "DELETE" });
      toast.success(`Deleted "${s.name}"`);
      await load();
      setBack("list");
    } catch (e) {
      toast.error("We could not delete that sequence", { description: friendlyError(e) });
    } finally {
      setBusyId(null);
    }
  }

  const header = (
    <>
      <PageHeader
        title="Follow-up sequences"
        description="Automatic messages for new leads. The first goes out the moment a lead arrives and later ones wait. By default the sequence stops as soon as the lead replies, and you can change that for each step."
        actions={
          admin && !editing && items && items.length > 0 && (
            <Button data-seq-new="" onClick={() => setEditing("new")}>
              New sequence
            </Button>
          )
        }
      />
      <LeadsNav current="/app/leads/sequences" />
    </>
  );

  if (role !== null && !admin) {
    return (
      <div>
        {header}
        <Alert tone="info" title="Only owners and admins manage follow-ups">
          Ask an owner or admin to set up or change automatic messages. Anything they set up still shows on each lead.
        </Alert>
      </div>
    );
  }

  return (
    <div>
      {header}
      {editing ? (
        <SequenceBuilder
          initial={editing === "new" ? null : editing}
          templates={templates}
          chatbots={chatbots}
          forms={forms}
          onCancel={() => {
            setBack(editing === "new" ? "new" : editing.id);
            setEditing(null);
          }}
          onSaved={async () => {
            await load();
            setBack(editing === "new" ? "list" : editing.id);
            setEditing(null);
          }}
        />
      ) : error && !items ? (
        <ErrorState
          title="We could not load your sequences"
          message={error}
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : !items ? (
        <div aria-busy="true" role="status" className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <span className="sr-only">Loading sequences</span>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No follow-up sequences yet"
          body="A sequence messages every new lead for you, for example a welcome message right away and a reminder the next day. By default it stops as soon as the lead replies."
          action={
            <Button data-seq-new="" onClick={() => setEditing("new")}>
              Create your first sequence
            </Button>
          }
        />
      ) : (
        <>
        <h2 ref={listHeading} tabIndex={-1} className="sr-only">
          Your follow-up sequences
        </h2>
        <ul className="space-y-3">
          {items.map((s) => (
            <li key={s.id}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold">{s.name}</h3>
                    <p className="mt-0.5 text-sm text-muted">
                      {sequenceLength(s.steps)}. {sequenceScope(s.appliesTo, forms)}.
                    </p>
                  </div>
                  <StatusPill status={s.enabled ? "enabled" : "disabled"} label={s.enabled ? "On" : "Off"} />
                </div>
                <StepList steps={s.steps} templates={templates} chatbots={chatbots} />
                {admin && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" loading={busyId === s.id} aria-label={`${s.enabled ? "Turn off" : "Turn on"} ${s.name}`} onClick={() => void toggle(s)}>
                      {s.enabled ? "Turn off" : "Turn on"}
                    </Button>
                    <Button size="sm" variant="secondary" data-seq-edit={s.id} aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busyId === s.id} aria-label={`Delete ${s.name}`} onClick={() => void remove(s)}>
                      Delete
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
        </>
      )}
    </div>
  );
}

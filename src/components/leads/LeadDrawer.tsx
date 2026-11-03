"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Alert, Badge, Button, Dialog, ErrorState, Select, SkeletonText, StatusPill, apiFetch, buttonSizes, buttonVariants, cn, toast } from "@/components/ui";
import { ConsentBadge, ResponseBadge } from "./LeadParts";
import { STATUSES, fieldLabel, friendlyError, leadDisplayName, leadStatusLabel, leadStatusMeaning, responseHighlight, runStateLabel } from "./helpers";
import { useNow } from "./useNow";
import type { Agent, LeadDetail } from "./types";

type Patch = { status?: string; assignedToId?: string | null };

/** The label of a lead that came from a chat started from a click-to-WhatsApp ad (source ctwa). */
export const CTWA_LABEL = "From a WhatsApp ad";

/** Where a lead came from, for the list and the drawer: a WhatsApp ad, its lead form's name, or "Lead form" when the form is unknown. */
export function leadOrigin(lead: Pick<LeadDetail, "source" | "form">): string {
  if (lead.source === "ctwa") return CTWA_LABEL;
  return lead.form?.name ?? "Lead form";
}

/**
 * The Permission to message note when no consent wording was saved with the lead (always so for a WhatsApp ad lead). It follows the
 * contact's own opt-in (needsOptIn), like the badge above it: a contact who agreed elsewhere still gets marketing messages.
 */
export function consentNote(lead: Pick<LeadDetail, "source" | "needsOptIn">): string {
  if (lead.source === "ctwa") {
    return lead.needsOptIn
      ? "Writing to you from an ad is not agreement to marketing messages, so only service messages will be sent until they agree."
      : "They have already agreed to marketing messages. Writing to you from an ad did not change that.";
  }
  return lead.needsOptIn
    ? "No proof that this lead agreed to marketing messages was saved, so only service messages will be sent. Set the consent wording for this form under Forms."
    : "They have already agreed to marketing messages, so marketing messages can be sent. This form saved no consent wording. Set it under Forms to keep proof for new leads.";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border pt-4">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * A select that only commits when the person presses the button. Arrow keys on a closed select change its value at once in some
 * browsers, so saving on change would save every option a keyboard user passes through.
 */
function SaveSelect({ label, hint, value, saved, onPick, disabled, actionLabel, onSave, children }: { label: string; hint: string; value: string; saved: string; onPick: (v: string) => void; disabled: boolean; actionLabel: string; onSave: () => void; children: ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const select = useRef<HTMLSelectElement>(null);
  const clicked = useRef(false);
  useEffect(() => {
    if (!disabled && clicked.current) {
      clicked.current = false;
      select.current?.focus();
    }
  }, [disabled]);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Select ref={select} id={id} aria-describedby={hintId} className="min-w-0 flex-1" value={value} disabled={disabled} onChange={(e) => onPick(e.target.value)}>
          {children}
        </Select>
        <Button variant="secondary" className="shrink-0" disabled={disabled || value === saved} onClick={() => { clicked.current = true; onSave(); }}>
          {actionLabel}
        </Button>
      </div>
      <p id={hintId} className="text-xs text-muted">
        {hint}
      </p>
    </div>
  );
}

const linkButton = cn("inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap", buttonVariants.secondary, buttonSizes.md);

export function LeadDrawer({ id, admin, agents, onClose, onChanged }: { id: string; admin: boolean; agents: Agent[]; onClose: () => void; onChanged: (lead: LeadDetail) => void }) {
  const now = useNow();
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [stage, setStage] = useState("");
  const [assignee, setAssignee] = useState("");

  useEffect(() => {
    let live = true;
    setLead(null);
    setError("");
    apiFetch<{ lead: LeadDetail }>(`/api/leads/${id}`)
      .then((r) => live && setLead(r.lead))
      .catch((e: unknown) => live && setError(friendlyError(e)));
    return () => {
      live = false;
    };
  }, [id, attempt]);

  const savedStatus = lead?.status;
  const savedAssignee = lead ? (lead.assignedToId ?? "") : undefined;
  useEffect(() => {
    if (savedStatus !== undefined) setStage(savedStatus);
  }, [savedStatus]);
  useEffect(() => {
    if (savedAssignee !== undefined) setAssignee(savedAssignee);
  }, [savedAssignee]);

  const patch = useCallback(
    async (body: Patch, done: string) => {
      setSaving(true);
      try {
        const r = await apiFetch<{ lead: LeadDetail }>(`/api/leads/${id}`, { method: "PATCH", body });
        setLead(r.lead);
        onChanged(r.lead);
        toast.success(done);
      } catch (e) {
        toast.error("We could not save that change", { description: friendlyError(e) });
      } finally {
        setSaving(false);
      }
    },
    [id, onChanged],
  );

  const title = lead ? leadDisplayName(lead) : "Lead details";
  const phone = lead?.contact?.phone;
  const answers = lead ? Object.entries(lead.fields) : [];
  const highlight = lead ? responseHighlight(lead, now) : null;

  return (
    <Dialog
      title={title}
      description={lead ? `Received ${new Date(lead.createdAt).toLocaleString()}` : undefined}
      onClose={onClose}
      size="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {error ? (
        <ErrorState
          title="We could not open this lead"
          message={error}
          action={
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          }
        />
      ) : !lead ? (
        <div aria-busy="true" role="status">
          <SkeletonText lines={5} />
          <span className="sr-only">Loading lead</span>
        </div>
      ) : (
        <div className="space-y-5 text-sm">
          <div>
            <div className="flex flex-wrap gap-2">
              <StatusPill status={lead.status} label={leadStatusLabel(lead.status)} />
              <ConsentBadge needsOptIn={lead.needsOptIn} />
              <ResponseBadge lead={lead} now={now} />
              {lead.source === "ctwa" && <Badge tone="info">{CTWA_LABEL}</Badge>}
            </div>
            {highlight?.attention && (
              <Alert className="mt-3" tone={highlight.tone === "bad" ? "bad" : "warn"} title="Waiting for a first reply">
                {highlight.hint}
              </Alert>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {phone ? (
                <a className={linkButton} href={`tel:${phone}`}>
                  Call {phone}
                </a>
              ) : (
                <span className="text-muted">No phone number saved</span>
              )}
              {lead.email && (
                <a className={linkButton} href={`mailto:${lead.email}`}>
                  Email
                </a>
              )}
            </div>
            {lead.email && <p className="mt-2 break-all text-muted">{lead.email}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <SaveSelect
              label="Stage"
              hint={leadStatusMeaning(stage)}
              value={stage}
              saved={lead.status}
              onPick={setStage}
              disabled={saving}
              actionLabel="Save stage"
              onSave={() => void patch({ status: stage }, `Moved to ${leadStatusLabel(stage).toLowerCase()}`)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {leadStatusLabel(s)}
                </option>
              ))}
            </SaveSelect>
            <SaveSelect
              label="Assigned to"
              hint={admin ? "The teammate who follows up with this lead." : "Only owners and admins can reassign leads."}
              value={assignee}
              saved={lead.assignedToId ?? ""}
              onPick={setAssignee}
              disabled={saving || !admin}
              actionLabel="Save assignment"
              onSave={() => void patch({ assignedToId: assignee || null }, assignee ? "Lead assigned" : "Lead unassigned")}
            >
              <option value="">Unassigned</option>
              {agents.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.name ?? a.email}
                </option>
              ))}
            </SaveSelect>
          </div>
          <p className="-mt-2 text-xs text-muted">Marking a lead as qualified or won may report that result back to Meta, which helps your ads find similar people. Nothing is saved until you choose the save button.</p>

          <Section title="What they told you">
            {answers.length === 0 ? (
              <p className="text-muted">No form answers were saved for this lead.</p>
            ) : (
              <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[10rem_1fr]">
                {answers.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted">{fieldLabel(k)}</dt>
                    <dd className="break-words">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Section>

          <Section title="Permission to message">
            {lead.consentText ? (
              <>
                <p>
                  <Badge tone="good">Agreed</Badge> {lead.consentAt ? `on ${new Date(lead.consentAt).toLocaleString()}` : ""}
                </p>
                <p className="mt-2 text-muted">The lead saw this wording: {lead.consentText}</p>
              </>
            ) : (
              <p className="text-muted">{consentNote(lead)}</p>
            )}
          </Section>

          <Section title="Automatic follow-ups">
            {lead.sequences.length === 0 ? (
              <p className="text-muted">No automatic follow-up has run for this lead.</p>
            ) : (
              <ul className="space-y-2">
                {lead.sequences.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{s.name}</span>
                    <Badge tone={s.status === "active" ? "info" : "neutral"}>{runStateLabel(s.status)}</Badge>
                    <span className="text-muted">
                      Step {s.stepIndex + 1}
                      {s.nextRunAt ? `, next message ${new Date(s.nextRunAt).toLocaleString()}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <details className="border-t border-border pt-4">
            <summary className="min-h-10 cursor-pointer text-sm font-semibold">Details</summary>
            <dl className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted">{lead.source === "ctwa" ? "Came from" : "Lead form"}</dt>
              <dd className="break-words">{lead.source === "ctwa" ? CTWA_LABEL : (lead.form?.name ?? "Unknown")}</dd>
              <dt className="text-muted">Campaign ID</dt>
              <dd className="break-all">{lead.campaignMetaId ?? "Not linked to a campaign"}</dd>
              <dt className="text-muted">Ad ID</dt>
              <dd className="break-all">{lead.adMetaId ?? "Not linked to an ad"}</dd>
            </dl>
          </details>
        </div>
      )}
    </Dialog>
  );
}

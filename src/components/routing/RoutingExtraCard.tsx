"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/components/contacts/hooks";
import { BusyButton } from "@/components/integrations/BusyButton";
import { CheckRow } from "@/components/integrations/CheckRow";
import { Alert, Button, Card, ErrorState, FormField, Input, Skeleton, Textarea, apiFetch, toast } from "@/components/ui";
import type { RoutingExtra } from "@/lib/routing/extra-config";
import { extraSummary, isExtraDirty, toExtraBody, toExtraForm, validateExtraForm, type ExtraErrors, type ExtraForm } from "./extra-helpers";

type Person = { userId: string; name: string; email: string; role: string };

function PeoplePicker({ legend, ids, onChange, people }: { legend: string; ids: string[]; onChange: (ids: string[]) => void; people: Person[] }) {
  if (people.length === 0) return <p className="text-xs text-muted">You have no agents yet. Owners and admins are never limited.</p>;
  return (
    <fieldset className="rounded-control border border-border bg-surface p-3">
      <legend className="px-1 text-xs font-medium text-muted">{legend}</legend>
      <ul className="grid gap-x-4 sm:grid-cols-2">
        {people.map((p) => (
          <li key={p.userId}>
            <CheckRow label={p.name} forWhat={legend} checked={ids.includes(p.userId)} onChange={(on) => onChange(on ? [...ids, p.userId] : ids.filter((x) => x !== p.userId))} />
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** Extra routing rules and agent privacy. Saved together with one button; owners and admins only. */
export function RoutingExtraCard() {
  const extra = useApi<{ extra: RoutingExtra }>("/api/routing/extra");
  const members = useApi<{ members: Person[] }>("/api/workspace/members");
  const [form, setForm] = useState<ExtraForm | null>(null);
  const [saved, setSaved] = useState<ExtraForm | null>(null);
  const [errors, setErrors] = useState<ExtraErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (extra.data) {
      const next = toExtraForm(extra.data.extra);
      setForm(next);
      setSaved(next);
    }
  }, [extra.data]);

  const agents = useMemo(() => (members.data?.members ?? []).filter((m) => m.role === "agent"), [members.data]);

  if (extra.loading && !form) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-72 w-full" />
        <span role="status" className="sr-only">
          Loading routing rules
        </span>
      </div>
    );
  }
  if (!form || !saved || !extra.data) return <ErrorState title="We could not load your routing rules" message="Check your connection and try again." action={<Button onClick={extra.retry}>Try again</Button>} />;

  const current = form;
  const base = saved;
  const dirty = isExtraDirty(current, base);
  const set = (patch: Partial<ExtraForm>) => setForm({ ...current, ...patch });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !dirty) return;
    const found = validateExtraForm(current);
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus());
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{ extra: RoutingExtra }>("/api/routing/extra", { method: "PUT", body: toExtraBody(current, extra.data!.extra) });
      const next = toExtraForm(res.extra);
      setForm(next);
      setSaved(next);
      toast.success("Routing rules saved");
      extra.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "We could not save your rules. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={save} noValidate>
      <Card
        title="Smarter routing and privacy"
        description={extraSummary(extra.data.extra)}
        footer={
          <div className="flex flex-wrap items-center gap-3">
            <BusyButton type="submit" busy={busy} inactive={!dirty}>
              Save changes
            </BusyButton>
            <BusyButton
              type="button"
              variant="ghost"
              inactive={!dirty || busy}
              onClick={() => {
                setForm(base);
                setErrors({});
                setProblem(null);
              }}
            >
              Discard changes
            </BusyButton>
            <span role="status" className="text-xs text-muted">
              {dirty ? "You have changes that are not saved yet." : ""}
            </span>
          </div>
        }
      >
        <div className="space-y-8">
          {problem && <Alert tone="bad">{problem}</Alert>}

          <section aria-labelledby="who-gets-heading" className="space-y-2">
            <h3 id="who-gets-heading" className="text-sm font-semibold">
              Who gets a new chat
            </h3>
            <p className="text-xs text-muted">These apply when chats are shared automatically. Anyone who is away or full is skipped.</p>
            <CheckRow label="Send returning customers back to the same person" description="If a team member recently talked to this customer, they get the chat again." checked={form.lastOn} onChange={(on) => set({ lastOn: on })} />
            {form.lastOn && (
              <FormField label="Counts as returning for" error={errors.lastHours} hint="Hours since that person last replied." className="max-w-xs">
                <Input inputMode="numeric" value={form.lastHours} maxLength={3} aria-invalid={errors.lastHours ? true : undefined} onChange={(e) => set({ lastHours: e.target.value.replace(/\D/g, "") })} />
              </FormField>
            )}
            <CheckRow label="Give customers to their owner first" description="If a contact has an owner on the Contacts page, that person gets their chats." checked={form.ownerFirst} onChange={(on) => set({ ownerFirst: on })} />
            <CheckRow label="Make the person who takes a chat the contact's owner" description="Only when the contact has no owner yet." checked={form.ownerOnAssign} onChange={(on) => set({ ownerOnAssign: on })} />
          </section>

          <section aria-labelledby="move-heading" className="space-y-2">
            <h3 id="move-heading" className="text-sm font-semibold">
              When nobody answers
            </h3>
            <CheckRow
              label="Move a chat on if the person does not answer"
              description="Only chats we shared automatically are moved, and only during working hours. Chats you gave to a named person stay with them."
              checked={form.reassignOn}
              onChange={(on) => set({ reassignOn: on })}
            />
            {form.reassignOn && (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Wait this many minutes" error={errors.reassignMinutes} hint="Counted from the customer's last message.">
                  <Input inputMode="numeric" value={form.reassignMinutes} maxLength={4} aria-invalid={errors.reassignMinutes ? true : undefined} onChange={(e) => set({ reassignMinutes: e.target.value.replace(/\D/g, "") })} />
                </FormField>
                <FormField label="Move at most" error={errors.reassignMoves} hint="Times for each customer message, so a chat never loops.">
                  <Input inputMode="numeric" value={form.reassignMoves} maxLength={2} aria-invalid={errors.reassignMoves ? true : undefined} onChange={(e) => set({ reassignMoves: e.target.value.replace(/\D/g, "") })} />
                </FormField>
              </div>
            )}
          </section>

          <section aria-labelledby="privacy-heading" className="space-y-3">
            <h3 id="privacy-heading" className="text-sm font-semibold">
              What agents can see
            </h3>
            <p className="text-xs text-muted">These limits apply to people with the Agent role. Owners and admins always see everything.</p>
            <CheckRow label="Agents only see chats of their own teams" description="They also see chats assigned to them. Chats with no team show for members of the default team." checked={form.teamVisibility} onChange={(on) => set({ teamVisibility: on })} />
            <CheckRow label="All agents only see chats assigned to them" checked={form.viewAll} onChange={(on) => set({ viewAll: on })} />
            {!form.viewAll && <PeoplePicker legend="Only these agents are limited to their own chats" ids={form.viewIds} onChange={(ids) => set({ viewIds: ids })} people={agents} />}
            <CheckRow label="Hide the middle of phone numbers from all agents" description="They see the first 3 and last 4 digits, and can still search by the last 4." checked={form.maskAll} onChange={(on) => set({ maskAll: on })} />
            {!form.maskAll && <PeoplePicker legend="Hide phone numbers from these agents" ids={form.maskIds} onChange={(ids) => set({ maskIds: ids })} people={agents} />}
          </section>

          <section aria-labelledby="stages-heading" className="space-y-2">
            <h3 id="stages-heading" className="text-sm font-semibold">
              Lead stages
            </h3>
            <FormField label="Stages for your customers" error={errors.stages} hint="One per line, in order. Shown on the Contacts page. Leads on the Leads page have their own fixed stages.">
              <Textarea rows={6} value={form.stages} aria-invalid={errors.stages ? true : undefined} onChange={(e) => set({ stages: e.target.value })} />
            </FormField>
          </section>
        </div>
      </Card>
    </form>
  );
}

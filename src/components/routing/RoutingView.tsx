"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, FormField, Input, Select, Skeleton, Spinner, StatusPill, apiFetch, toast, type Column } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { BusyButton } from "@/components/integrations/BusyButton";
import { CheckRow } from "@/components/integrations/CheckRow";
import { RoleGate } from "@/components/team/RoleGate";
import { roleLabel } from "@/components/team/helpers";
import type { RoutingSettings } from "@/lib/routing/config";
import { timeZoneList } from "@/lib/timezones";
import { AvailabilityToggle, announceAvailability, useAvailabilityChanged } from "./AvailabilityToggle";
import { RoutingExtraCard } from "./RoutingExtraCard";
import { DAY_NAMES, DISPLAY_ORDER, MODE_INFO, effectiveForm, isDirty, parseLimit, routingSummary, toBody, toForm, validateForm, type FormErrors, type FormState } from "./helpers";

type Agent = { userId: string; name: string; email: string; role: string; available: boolean; maxOpen: number | null; openCount: number; lastAssignedAt: string | null; disabled: boolean };

const touch = "max-sm:min-h-10";

export function RoutingView() {
  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Chat routing"
        description="Share new conversations with your team automatically. Chats that already have an owner are never moved."
        actions={<AvailabilityToggle />}
      />
      <RoleGate
        loadingLabel="Loading routing settings"
        skeletonClass="h-64"
        denied={<Alert tone="info">Only owners and admins can change routing. Use the Available for new chats switch above to tell the team whether you can take new chats.</Alert>}
      >
        <ManagerView />
      </RoleGate>
    </div>
  );
}

/**
 * Chat limit for one person. Saves when the field loses focus or Enter is pressed. While saving the field becomes read-only
 * instead of disabled, so keyboard focus is not lost.
 */
function LimitInput({ agent, busy, onSave }: { agent: Agent; busy: boolean; onSave: (value: number | null) => Promise<unknown> }) {
  const shown = agent.maxOpen === null ? "" : String(agent.maxOpen);
  const [text, setText] = useState(shown);
  const sent = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    setText(shown);
    sent.current = undefined;
  }, [shown]);

  function commit() {
    const parsed = parseLimit(text);
    if (!parsed.ok) {
      setText(shown);
      toast.error("Enter a whole number from 1 up, or leave it empty for no limit");
      return;
    }
    if (busy || parsed.value === agent.maxOpen || parsed.value === sent.current) return;
    sent.current = parsed.value;
    void onSave(parsed.value).then((ok) => {
      if (!ok) sent.current = undefined;
    });
  }

  return (
    <Input
      aria-label={`Open chat limit for ${agent.name}`}
      aria-busy={busy || undefined}
      className="w-24"
      inputMode="numeric"
      value={text}
      readOnly={busy}
      placeholder="No limit"
      maxLength={3}
      onChange={(e) => {
        if (!busy) setText(e.target.value.replace(/\D/g, ""));
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

/** Suggestions for the time zone box: one per zone under its current name (Asia/Kolkata, not also Asia/Calcutta). */
function timezoneChoices(): string[] {
  return timeZoneList();
}

function ManagerView() {
  const config = useApi<{ config: RoutingSettings }>("/api/routing/config");
  const agents = useApi<{ agents: Agent[] }>("/api/routing/agents", 15000);
  const [form, setForm] = useState<FormState | null>(null);
  const [saved, setSaved] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAgent, setBusyAgent] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (config.data) {
      const next = toForm(config.data.config);
      setForm(next);
      setSaved(next);
    }
  }, [config.data]);

  useAvailabilityChanged(agents.reload);

  const zones = useMemo(timezoneChoices, []);
  const list = useMemo(() => agents.data?.agents ?? [], [agents.data]);

  async function updateAgent(agent: Agent, patch: { available?: boolean; maxOpen?: number | null }, success: string): Promise<boolean> {
    if (busyAgent) return false;
    setBusyAgent(agent.userId);
    try {
      await apiFetch(`/api/routing/agents/${agent.userId}`, { method: "PUT", body: patch });
      toast.success(success);
      agents.reload();
      if (patch.available !== undefined) announceAvailability();
      return true;
    } catch (err) {
      toast.error(`We could not update ${agent.name}`, { description: err instanceof Error ? err.message : "Please try again." });
      agents.reload();
      return false;
    } finally {
      setBusyAgent(null);
    }
  }

  const columns = useMemo<Column<Agent>[]>(
    () => [
      {
        key: "name",
        header: "Person",
        primary: true,
        cell: (a) => (
          <div>
            <p className="font-medium">{a.name}</p>
            <p className="break-all text-xs text-muted">{a.email}</p>
          </div>
        ),
      },
      { key: "role", header: "Role", cell: (a) => roleLabel(a.role) },
      { key: "open", header: "Open chats", cell: (a) => a.openCount },
      {
        key: "limit",
        header: "Own chat limit",
        cell: (a) => (
          <LimitInput
            agent={a}
            busy={busyAgent === a.userId}
            onSave={(value) => updateAgent(a, { maxOpen: value }, value === null ? `${a.name} has no chat limit` : `${a.name} can have up to ${value} open chats`)}
          />
        ),
      },
      { key: "last", header: "Last given a chat", cell: (a) => <span className="text-muted">{a.lastAssignedAt ? new Date(a.lastAssignedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never"}</span> },
      {
        key: "available",
        header: "Taking new chats",
        cell: (a) =>
          a.disabled ? (
            <StatusPill status="disabled" label="Account disabled" />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center">
                <input
                  type="checkbox"
                  aria-label={`${a.name} is available for new chats`}
                  checked={a.available}
                  aria-busy={busyAgent === a.userId || undefined}
                  onChange={(e) => {
                    if (busyAgent) return;
                    void updateAgent(a, { available: e.target.checked }, e.target.checked ? `${a.name} is available` : `${a.name} is away`);
                  }}
                  className="h-5 w-5 cursor-pointer accent-accent"
                />
              </label>
              <StatusPill status={a.available ? "active" : "inactive"} label={a.available ? "Available" : "Away"} />
              {busyAgent === a.userId && <Spinner label="Saving" size="sm" />}
            </div>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyAgent],
  );

  if (config.loading && !form) {
    return (
      <div aria-busy="true" className="space-y-4">
        <Skeleton className="h-72 w-full" />
        <span role="status" className="sr-only">
          Loading routing settings
        </span>
      </div>
    );
  }
  if (!form || !saved) {
    return <ErrorState title="We could not load your routing settings" message="Check your connection and try again." action={<Button onClick={config.retry}>Try again</Button>} />;
  }

  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const setDay = (i: number, patch: Partial<FormState["days"][number]>) => set({ days: form.days.map((d, n) => (n === i ? { ...d, ...patch } : d)) });
  const dirty = isDirty(effectiveForm(form, saved), saved);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !saved || busy || !dirty) return;
    const target = effectiveForm(form, saved);
    const found = validateForm(target);
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => (formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]") ?? formRef.current?.querySelector<HTMLElement>("#hours-fieldset"))?.focus());
      return;
    }
    const built = toBody(target);
    if ("error" in built) return setProblem(built.error);
    setBusy(true);
    try {
      await apiFetch("/api/routing/config", { method: "PUT", body: built.body });
      toast.success("Routing settings saved");
      setSaved(target);
      setForm(target);
      config.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "We could not save your settings. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <form ref={formRef} onSubmit={save} noValidate>
        <Card
          title="How new chats are shared"
          description={routingSummary(saved, list.find((a) => a.userId === saved.fallbackUserId)?.name)}
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
                  setForm(saved);
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
          <div className="space-y-6">
            {problem && <Alert tone="bad">{problem}</Alert>}
            <CheckRow
              label="Share new chats automatically"
              description="When someone messages you, we pick a teammate who is available and give them the chat."
              checked={form.autoAssign}
              onChange={(on) => set({ autoAssign: on })}
            />

            {form.autoAssign && (
              <>
                <fieldset>
                  <legend className="text-sm font-medium">How should we choose?</legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {(Object.keys(MODE_INFO) as FormState["mode"][]).map((m) => (
                      <label key={m} className="flex min-h-10 cursor-pointer items-start gap-3 rounded-control border border-border-strong bg-raised p-3 has-checked:border-accent has-checked:bg-accent-soft">
                        <input type="radio" name="mode" value={m} checked={form.mode === m} onChange={() => set({ mode: m })} className="mt-0.5 h-5 w-5 shrink-0 accent-accent" />
                        <span className="text-sm">
                          <span className="block font-medium">{MODE_INFO[m].label}</span>
                          <span className="block text-xs text-muted">{MODE_INFO[m].description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label="Most open chats per person" optional error={errors.maxOpenPerAgent} hint="Someone with this many open chats is skipped. Leave empty for no limit. You can set a lower limit for one person below.">
                    <Input inputMode="numeric" value={form.maxOpenPerAgent} maxLength={3} placeholder="No limit" onChange={(e) => set({ maxOpenPerAgent: e.target.value.replace(/\D/g, "") })} />
                  </FormField>
                  <FormField label="When nobody is free, give the chat to" hint="Used when everyone is away, full, or it is outside working hours.">
                    <Select value={form.fallbackUserId} onChange={(e) => set({ fallbackUserId: e.target.value })}>
                      <option value="">Nobody, leave it unassigned</option>
                      {list
                        .filter((a) => !a.disabled)
                        .map((a) => (
                          <option key={a.userId} value={a.userId}>
                            {a.name}
                          </option>
                        ))}
                    </Select>
                  </FormField>
                </div>

                <fieldset id="hours-fieldset" tabIndex={-1} className="space-y-2" aria-describedby={errors.hours ? "hours-error" : undefined}>
                  <legend className="text-sm font-medium">When should this run?</legend>
                  <CheckRow label="All day, every day" description="Turn this off to set working hours." checked={form.alwaysOn} onChange={(on) => set({ alwaysOn: on })} />
                  {!form.alwaysOn && (
                    <div className="space-y-4 rounded-control border border-border bg-surface p-3 sm:p-4">
                      <ul className="space-y-1">
                        {DISPLAY_ORDER.map((d) => (
                          <li key={d} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <CheckRow label={DAY_NAMES[d]} checked={form.days[d].enabled} onChange={(on) => setDay(d, { enabled: on })} className="w-36" />
                            <Input type="time" aria-label={`${DAY_NAMES[d]} start time`} className="w-28" disabled={!form.days[d].enabled} value={form.days[d].start} onChange={(e) => setDay(d, { start: e.target.value })} />
                            <span className="text-sm text-muted" aria-hidden>
                              to
                            </span>
                            <Input type="time" aria-label={`${DAY_NAMES[d]} end time`} className="w-28" disabled={!form.days[d].enabled} value={form.days[d].end} onChange={(e) => setDay(d, { end: e.target.value })} />
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-muted">If the end time is earlier than the start time, the shift runs overnight into the next day.</p>
                      <FormField label="Time zone" error={errors.timezone} hint="Working hours follow this time zone.">
                        <Input list="routing-zones" value={form.timezone} maxLength={64} autoComplete="off" onChange={(e) => set({ timezone: e.target.value })} />
                      </FormField>
                      <datalist id="routing-zones">
                        {zones.map((z) => (
                          <option key={z} value={z} />
                        ))}
                      </datalist>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className={touch}
                        onClick={() => set({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
                      >
                        Use my device&apos;s time zone
                      </Button>
                    </div>
                  )}
                  {errors.hours && (
                    <p id="hours-error" role="alert" className="text-xs font-medium text-bad-fg">
                      {errors.hours}
                    </p>
                  )}
                </fieldset>
              </>
            )}
          </div>
        </Card>
      </form>

      <RoutingExtraCard />

      <section aria-labelledby="agents-heading">
        <h2 id="agents-heading" className="mb-1 text-lg font-semibold">
          Your team
        </h2>
        <p className="mb-1 text-sm text-muted">Switch someone to away when they cannot take chats. They keep the chats they already have.</p>
        <p className="mb-3 text-sm text-muted">An open chat limit saves when you press Enter or leave the field.</p>
        {agents.error && !agents.data ? (
          <ErrorState title="We could not load your team" action={<Button onClick={agents.reload}>Try again</Button>} />
        ) : (
          <DataTable
            caption="Team members and their chat limits"
            columns={columns}
            rows={list}
            rowKey={(a) => a.userId}
            loading={agents.loading && !agents.data}
            skeletonRows={3}
            empty={<EmptyState compact title="No teammates yet" body="Invite people on the Team page, then come back to decide how chats are shared." />}
          />
        )}
      </section>
    </div>
  );
}

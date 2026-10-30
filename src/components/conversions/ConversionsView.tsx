"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, DataTable, EmptyState, ErrorState, FormField, Select, Skeleton, apiFetch, toast, type Column } from "@/components/ui";
import { PageHeader } from "@/components/app/PageHeader";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";
import { EVENT_STATUSES, canRequeue, eventLabel, eventStatusView, friendlyError, reasonText } from "./helpers";

type Settings = { enabled: boolean; datasetAssetId: string | null };
type Dataset = { id: string; name: string; externalId: string; status: string };
type EventRow = { id: string; eventName: string; eventTime: string; status: string; attempts: number; reason: string | null; createdAt: string };
type Events = { events: EventRow[]; counts: Record<string, number>; settings: Settings };

function SettingsCard({ settings, datasets, onSaved }: { settings: Settings; datasets: Dataset[]; onSaved: () => void }) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setDraft(settings), [settings]);
  const dirty = draft.enabled !== settings.enabled || draft.datasetAssetId !== settings.datasetAssetId;

  async function save() {
    setSaving(true);
    setError("");
    try {
      await apiFetch("/api/conversions/settings", { method: "PUT", body: draft });
      toast.success("Conversion settings saved");
      onSaved();
    } catch (e) {
      setError(friendlyError(e, "We could not save these settings."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Settings" description="Tell Meta when a chat turns into a lead or a sale, so your ads can find more people like them.">
      <div className="flex items-start gap-3">
        <input id="conversions-enabled" type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-accent" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} aria-describedby="conversions-enabled-hint" />
        <label htmlFor="conversions-enabled" className="text-sm">
          <span className="font-medium">Report conversions to Meta</span>
          <span id="conversions-enabled-hint" className="mt-0.5 block text-xs text-muted">
            Customers who asked not to be messaged are never reported.
          </span>
        </label>
      </div>
      <div className="mt-4 max-w-md">
        <FormField label="Dataset" hint={datasets.length === 0 ? "No dataset is connected yet. Connect one under Meta connections." : "The Meta dataset that receives the events."}>
          <Select value={draft.datasetAssetId ?? ""} onChange={(e) => setDraft({ ...draft, datasetAssetId: e.target.value || null })} disabled={datasets.length === 0}>
            <option value="">Choose automatically</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      {error && (
        <Alert className="mt-4" tone="bad" title="We could not save these settings">
          {error}
        </Alert>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} loading={saving} disabled={!dirty}>
          Save settings
        </Button>
        {dirty && <span className="text-sm text-muted">You have unsaved changes.</span>}
      </div>
    </Card>
  );
}

export function ConversionsView() {
  const role = useRole();
  const allowed = role !== null && canManage(role);
  const [status, setStatus] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const events = useApi<Events>(allowed ? `/api/conversions${status ? `?status=${status}` : ""}` : null);
  const options = useApi<{ settings: Settings; datasets: Dataset[] }>(allowed ? "/api/conversions/settings" : null);

  if (role !== null && !canManage(role)) {
    return (
      <div>
        <PageHeader title="Conversions" />
        <EmptyState title="Conversions are for owners and admins" body="Ask an owner or admin of your workspace to review them, or to give you access." />
      </div>
    );
  }

  async function requeue(row: EventRow) {
    setBusyId(row.id);
    try {
      await apiFetch(`/api/conversions/${row.id}/requeue`, { method: "POST" });
      toast.success("Queued to send again");
      events.reload();
    } catch (e) {
      toast.error("We could not queue this event", { description: friendlyError(e) });
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<EventRow>[] = [
    {
      key: "event",
      header: "Event",
      primary: true,
      cell: (r) => (
        <div>
          <div>{eventLabel(r.eventName)}</div>
          <div className="text-xs font-normal text-muted">{new Date(r.eventTime).toLocaleString()}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => {
        const v = eventStatusView(r.status);
        return (
          <Badge dot tone={v.tone}>
            {v.label}
          </Badge>
        );
      },
    },
    { key: "attempts", header: "Tries", accessor: (r) => String(r.attempts) },
    { key: "reason", header: "Why", cell: (r) => <span className="break-words">{reasonText(r.reason) || "None"}</span> },
    {
      key: "actions",
      header: "Action",
      cell: (r) =>
        canRequeue(r.status) ? (
          <Button size="sm" variant="secondary" loading={busyId === r.id} aria-label={`Send ${eventLabel(r.eventName)} from ${new Date(r.eventTime).toLocaleString()} again`} onClick={() => void requeue(r)}>
            Send again
          </Button>
        ) : (
          <span className="text-muted">None</span>
        ),
    },
  ];

  const counts = events.data?.counts ?? {};

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Conversions" description="Leads and sales we report back to Meta. If something could not be sent, you can see why and send it again." />
      {role === null || (!events.data && !events.error) ? (
        <div aria-busy="true" role="status" className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
          <span className="sr-only">Loading conversions</span>
        </div>
      ) : events.error && !events.data ? (
        <ErrorState
          title="We could not load your conversions"
          message={events.error}
          action={
            <Button variant="secondary" onClick={events.retry}>
              Try again
            </Button>
          }
        />
      ) : (
        <>
          {options.data && (
            <SettingsCard
              settings={options.data.settings}
              datasets={options.data.datasets}
              onSaved={() => {
                options.reload();
                events.reload();
              }}
            />
          )}
          {options.data && !options.data.settings.enabled && (
            <Alert tone="warn" title="Conversions are switched off">
              New leads and sales are not reported to Meta until you turn this back on.
            </Alert>
          )}
          <Card
            title="Events"
            description={EVENT_STATUSES.map((s) => `${counts[s] ?? 0} ${eventStatusView(s).label.toLowerCase()}`).join(", ")}
            actions={
              <div className="w-44">
                <FormField label="Status">
                  <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="">All statuses</option>
                    {EVENT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {eventStatusView(s).label}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
            }
          >
            <DataTable
              caption="Conversion events"
              columns={columns}
              rows={events.data?.events ?? []}
              rowKey={(r) => r.id}
              empty={
                <EmptyState
                  compact
                  title={status ? `No ${eventStatusView(status).label.toLowerCase()} events` : "No conversions yet"}
                  body={status ? "No events have this status." : "When a lead is qualified or a customer buys after a chat, it shows up here."}
                />
              }
            />
          </Card>
        </>
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, DataTable, Dialog, EmptyState, ErrorState, FormField, Input, Skeleton, StatusPill, apiFetch, confirm, toast, type Column } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { BusyButton } from "./BusyButton";
import { CheckRow } from "./CheckRow";
import { SecretDialog } from "./SecretDialog";
import { deliveryDisplay, deliverySummary, endpointNotice, eventDescription, eventLabel, hasUnsettledDeliveries, webhookUrlError } from "./helpers";

type Endpoint = { id: string; url: string; events: string[]; enabled: boolean; failureCount: number; createdAt: string };
type Delivery = { id: string; event: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string };
type BusyKind = "toggle" | "test" | "rotate" | "delete";

const when = (d: string) => new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const touch = "max-sm:min-h-10";
const POLL_WHILE_WAITING_MS = 3000;

function Deliveries({ id, refreshKey, url }: { id: string; refreshKey: number; url: string }) {
  const [waiting, setWaiting] = useState(false);
  const { data, error, loading, reload, retry } = useApi<{ deliveries: Delivery[] }>(`/api/integrations/webhooks/${id}/deliveries`, waiting ? POLL_WHILE_WAITING_MS : undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState("");
  const announceNext = useRef(false);
  const wasWaiting = useRef(false);

  // A test event was just sent: fetch again so the new row shows up without pressing Refresh.
  useEffect(() => {
    if (refreshKey > 0) {
      announceNext.current = true;
      reload();
    }
  }, [refreshKey, reload]);

  useEffect(() => {
    if (!data) return;
    const unsettled = hasUnsettledDeliveries(data.deliveries);
    if (announceNext.current || (wasWaiting.current && !unsettled)) {
      announceNext.current = false;
      setNote(`Deliveries updated. ${deliverySummary(data.deliveries)}`);
    }
    wasWaiting.current = unsettled;
    setWaiting(unsettled);
    setRefreshing(false);
  }, [data]);

  useEffect(() => {
    if (error) setRefreshing(false);
  }, [error]);

  function refresh() {
    announceNext.current = true;
    setNote("");
    setRefreshing(true);
    reload();
  }

  const columns = useMemo<Column<Delivery>[]>(
    () => [
      { key: "event", header: "What happened", primary: true, cell: (d) => eventLabel(d.event) },
      { key: "when", header: "When", cell: (d) => <span className="text-muted">{when(d.createdAt)}</span> },
      {
        key: "result",
        header: "Result",
        cell: (d) => {
          const shown = deliveryDisplay(d.status);
          return (
            <div className="space-y-1">
              <StatusPill status={shown.status} label={shown.label} />
              {(d.lastStatus || d.lastError) && (
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer">Details</summary>
                  {d.lastStatus ? <p>Your server answered with code {d.lastStatus}.</p> : null}
                  {d.lastError ? <p className="break-words">{d.lastError}</p> : null}
                </details>
              )}
            </div>
          );
        },
      },
      { key: "attempts", header: "Attempts", align: "right", cell: (d) => d.attempts },
    ],
    [],
  );

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Recent deliveries</h3>
        <div className="flex items-center gap-2">
          {waiting && <span className="text-xs text-muted">Checking again every few seconds</span>}
          <BusyButton size="sm" variant="ghost" className={touch} busy={refreshing} onClick={refresh}>
            Refresh<span className="sr-only"> deliveries for {url}</span>
          </BusyButton>
        </div>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {note}
      </p>
      {error && data && (
        <Alert tone="warn" className="mb-2">
          We could not check for updates. What you see may be out of date.
        </Alert>
      )}
      {error && !data ? (
        <ErrorState title="We could not load deliveries" action={<Button onClick={retry}>Try again</Button>} />
      ) : (
        <DataTable
          caption="Recent deliveries"
          columns={columns}
          rows={data?.deliveries ?? []}
          rowKey={(d) => d.id}
          loading={loading && !data}
          skeletonRows={3}
          empty={<EmptyState compact title="Nothing sent yet" body="Send a test event to see how a delivery looks." />}
        />
      )}
    </div>
  );
}

function AddEndpointDialog({ events, onClose, onCreated }: { events: string[]; onClose: () => void; onCreated: (secret: string) => void }) {
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const ue = webhookUrlError(url);
    const ee = picked.length === 0 ? "Choose at least one event to send." : null;
    setUrlError(ue);
    setEventError(ee);
    setProblem(null);
    if (ue || ee) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ secret: string }>("/api/integrations/webhooks", { method: "POST", body: { url: url.trim(), events: picked } });
      onCreated(r.secret);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "We could not add the endpoint. Check your connection and try again.");
      setBusy(false);
      requestAnimationFrame(() => form.querySelector<HTMLElement>("input")?.focus());
    }
  }

  return (
    <Dialog
      title="Add a webhook endpoint"
      description="We will send a short message to this address whenever one of the events you pick happens."
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="add-endpoint-form" loading={busy}>
            Add endpoint
          </Button>
        </>
      }
    >
      <form id="add-endpoint-form" onSubmit={submit} noValidate className="space-y-5">
        {problem && <Alert tone="bad">{problem}</Alert>}
        <FormField label="Address that receives events" required error={urlError} hint="Must be a public address starting with https://. Your developer will know what to enter.">
          <Input type="url" inputMode="url" value={url} placeholder="https://example.com/webhooks/edwyz" data-autofocus onChange={(e) => setUrl(e.target.value)} />
        </FormField>
        <fieldset aria-describedby={eventError ? "event-error" : undefined}>
          <legend className="text-sm font-medium">
            Which events should we send?
            <span aria-hidden className="ml-0.5 text-bad-fg">
              *
            </span>
          </legend>
          <div className="mt-1 divide-y divide-border">
            {events.map((ev) => (
              <CheckRow
                key={ev}
                label={eventLabel(ev)}
                description={eventDescription(ev)}
                checked={picked.includes(ev)}
                onChange={(on) => setPicked((cur) => (on ? [...cur, ev] : cur.filter((x) => x !== ev)))}
              />
            ))}
          </div>
          {eventError && (
            <p id="event-error" role="alert" className="mt-1 text-xs font-medium text-bad-fg">
              {eventError}
            </p>
          )}
        </fieldset>
      </form>
    </Dialog>
  );
}

export function WebhooksSection() {
  const { data, error, loading, reload } = useApi<{ endpoints: Endpoint[]; events: string[] }>("/api/integrations/webhooks");
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ title: string; intro: string; value: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ id: string; kind: BusyKind } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const addButton = useRef<HTMLButtonElement>(null);

  async function run<T>(id: string, kind: BusyKind, fn: () => Promise<T>, success: string, failure: string, then?: (r: T) => void): Promise<boolean> {
    if (busy?.id === id) return false;
    setBusy({ id, kind });
    try {
      const r = await fn();
      then?.(r);
      toast.success(success);
      reload();
      return true;
    } catch (err) {
      toast.error(failure, { description: err instanceof Error ? err.message : "Please try again." });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function rotate(ep: Endpoint) {
    const ok = await confirm({
      title: "Create a new signing secret?",
      body: "The old secret stops working immediately. Update your server with the new one straight away, or it will reject our events.",
      confirmLabel: "Create new secret",
      tone: "danger",
    });
    if (!ok) return;
    await run(
      ep.id,
      "rotate",
      () => apiFetch<{ secret: string }>(`/api/integrations/webhooks/${ep.id}/rotate`, { method: "POST", body: {} }),
      "New signing secret created",
      "We could not create a new secret",
      (r) => setSecret({ title: "Your new signing secret", intro: "Your server uses it to check that events really come from us.", value: r.secret }),
    );
  }

  async function remove(ep: Endpoint) {
    const ok = await confirm({
      title: "Delete this endpoint?",
      body: `We will stop sending events to ${ep.url}.`,
      confirmLabel: "Delete endpoint",
      tone: "danger",
    });
    if (!ok) return;
    const done = await run(ep.id, "delete", () => apiFetch(`/api/integrations/webhooks/${ep.id}`, { method: "DELETE" }), "Endpoint deleted", "We could not delete the endpoint");
    if (done) addButton.current?.focus();
  }

  return (
    <Card
      title="Webhook endpoints"
      description="For developers. A webhook tells your own system the moment something happens here, like a customer replying."
      actions={
        <BusyButton ref={addButton} size="sm" className={touch} onClick={() => setAdding(true)} inactive={!data}>
          Add endpoint
        </BusyButton>
      }
    >
      <div className="space-y-3">
        {loading && !data && (
          <div aria-busy="true" className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <span className="sr-only" role="status">
              Loading endpoints
            </span>
          </div>
        )}
        {error && !data && <ErrorState title="We could not load your endpoints" message="Check your connection and try again." action={<Button onClick={reload}>Try again</Button>} />}
        {data && data.endpoints.length === 0 && (
          <EmptyState
            compact
            title="No endpoints yet"
            body="Add one if you want your own software to hear about new messages and delivery results as they happen."
            action={<Button onClick={() => setAdding(true)}>Add endpoint</Button>}
          />
        )}
        {data?.endpoints.map((ep) => {
          const notice = endpointNotice(ep);
          const mine = busy?.id === ep.id;
          const panelId = `deliveries-${ep.id}`;
          return (
            <article key={ep.id} aria-label={`Endpoint ${ep.url}`} className="rounded-card border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all text-sm font-semibold">{ep.url}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {ep.events.map((ev) => (
                      <Badge key={ev}>{eventLabel(ev)}</Badge>
                    ))}
                  </div>
                </div>
                <StatusPill status={ep.enabled ? "enabled" : "disabled"} label={ep.enabled ? "Sending events" : "Paused"} />
              </div>
              {notice && (
                <Alert tone="warn" className="mt-3">
                  {notice}
                </Alert>
              )}
              <CheckRow
                className="mt-2"
                label="Send events to this address"
                forWhat={ep.url}
                checked={ep.enabled}
                busy={mine && busy?.kind === "toggle"}
                onChange={(on) => {
                  if (mine) return;
                  void run(ep.id, "toggle", () => apiFetch(`/api/integrations/webhooks/${ep.id}`, { method: "PATCH", body: { enabled: on } }), on ? "Endpoint turned on" : "Endpoint paused", "We could not update the endpoint");
                }}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <BusyButton
                  size="sm"
                  variant="secondary"
                  className={touch}
                  busy={mine && busy?.kind === "test"}
                  inactive={mine}
                  onClick={() =>
                    void run(
                      ep.id,
                      "test",
                      () => apiFetch(`/api/integrations/webhooks/${ep.id}/test`, { method: "POST", body: {} }),
                      "Test event sent. See the result below.",
                      "We could not send the test event",
                      () => {
                        setOpen(ep.id);
                        setRefreshKey((k) => k + 1);
                      },
                    )
                  }
                >
                  Send test event<span className="sr-only"> to {ep.url}</span>
                </BusyButton>
                <Button size="sm" variant="secondary" className={touch} aria-expanded={open === ep.id} aria-controls={open === ep.id ? panelId : undefined} onClick={() => setOpen(open === ep.id ? null : ep.id)}>
                  {open === ep.id ? "Hide deliveries" : "Show deliveries"}
                  <span className="sr-only"> for {ep.url}</span>
                </Button>
                <BusyButton size="sm" variant="secondary" className={touch} busy={mine && busy?.kind === "rotate"} inactive={mine} onClick={() => void rotate(ep)}>
                  Create new secret<span className="sr-only"> for {ep.url}</span>
                </BusyButton>
                <BusyButton size="sm" variant="secondary" className={touch} busy={mine && busy?.kind === "delete"} inactive={mine} onClick={() => void remove(ep)}>
                  Delete<span className="sr-only"> endpoint {ep.url}</span>
                </BusyButton>
              </div>
              {open === ep.id && (
                <div id={panelId}>
                  <Deliveries id={ep.id} refreshKey={refreshKey} url={ep.url} />
                </div>
              )}
            </article>
          );
        })}
      </div>
      {adding && data && (
        <AddEndpointDialog
          events={data.events}
          onClose={() => setAdding(false)}
          onCreated={(value) => {
            setAdding(false);
            setSecret({ title: "Your signing secret", intro: "Your server uses it to check that events really come from us (the X-Edwyz-Signature header).", value });
            reload();
          }}
        />
      )}
      {secret && (
        <SecretDialog
          title={secret.title}
          intro={secret.intro}
          value={secret.value}
          lostHint="We show the secret only once. If you lose it, create a new secret for this endpoint."
          onClose={() => setSecret(null)}
        />
      )}
    </Card>
  );
}

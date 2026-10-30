"use client";

import { useMemo, useRef, useState } from "react";
import { Alert, Button, Card, DataTable, Dialog, EmptyState, ErrorState, FormField, Input, StatusPill, apiFetch, confirm, toast, type Column } from "@/components/ui";
import { useApi } from "@/components/contacts/hooks";
import { BusyButton } from "./BusyButton";
import { CheckRow } from "./CheckRow";
import { SecretDialog } from "./SecretDialog";
import { DEFAULT_SCOPES, SCOPES, SCOPE_INFO, keyNameError, scopeLabel } from "./helpers";

type Key = { id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; revokedAt: string | null; createdAt: string };

const when = (d: string | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never used");
const touch = "max-sm:min-h-10";

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [nameError, setNameError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const ne = keyNameError(name);
    const se = scopes.length === 0 ? "Choose at least one thing this key may do." : null;
    setNameError(ne);
    setScopeError(se);
    setProblem(null);
    if (ne || se) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ key: string }>("/api/integrations/api-keys", { method: "POST", body: { name: name.trim(), scopes } });
      onCreated(r.key);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "We could not create the key. Check your connection and try again.");
      setBusy(false);
      requestAnimationFrame(() => form.querySelector<HTMLElement>("input")?.focus());
    }
  }

  return (
    <Dialog
      title="Create an API key"
      description="A key lets another system act on your account. Give each system its own key so you can turn one off without breaking the others."
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="create-key-form" loading={busy}>
            Create key
          </Button>
        </>
      }
    >
      <form id="create-key-form" onSubmit={submit} noValidate className="space-y-5">
        {problem && <Alert tone="bad">{problem}</Alert>}
        <FormField label="Key name" required error={nameError} hint="For example: Website checkout, or Accounting sync.">
          <Input value={name} maxLength={60} placeholder="Website checkout" data-autofocus onChange={(e) => setName(e.target.value)} />
        </FormField>
        <fieldset aria-describedby={scopeError ? "scope-error" : undefined}>
          <legend className="text-sm font-medium">
            What can this key do?<span aria-hidden className="ml-0.5 text-bad-fg">*</span>
          </legend>
          <p className="mb-1 text-xs text-muted">Pick only what the other system needs. You cannot change this later, but you can create a new key.</p>
          <div className="divide-y divide-border">
            {SCOPES.map((s) => (
              <CheckRow
                key={s}
                label={SCOPE_INFO[s].label}
                description={SCOPE_INFO[s].description}
                detail={s}
                checked={scopes.includes(s)}
                onChange={(on) => setScopes((cur) => (on ? [...cur, s] : cur.filter((x) => x !== s)))}
              />
            ))}
          </div>
          {scopeError && (
            <p id="scope-error" role="alert" className="mt-1 text-xs font-medium text-bad-fg">
              {scopeError}
            </p>
          )}
        </fieldset>
      </form>
    </Dialog>
  );
}

export function KeysSection() {
  const { data, error, loading, reload } = useApi<{ keys: Key[] }>("/api/integrations/api-keys");
  const [creating, setCreating] = useState(false);
  const [reveal, setReveal] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);

  async function revoke(k: Key) {
    const ok = await confirm({
      title: `Turn off "${k.name}"?`,
      body: "Anything using this key stops working right away. You cannot turn a key back on, but you can create a new one.",
      confirmLabel: "Turn off key",
      tone: "danger",
    });
    if (!ok || busyId) return;
    setBusyId(k.id);
    try {
      await apiFetch(`/api/integrations/api-keys/${k.id}`, { method: "DELETE" });
      toast.success(`"${k.name}" was turned off`);
      reload();
      createButton.current?.focus();
    } catch (err) {
      toast.error("We could not turn off the key", { description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(k: Key) {
    const ok = await confirm({
      title: `Remove "${k.name}" from the list?`,
      body: "This key is already turned off, so nothing that used it changes. It only disappears from this list.",
      confirmLabel: "Remove key",
      tone: "danger",
    });
    if (!ok || busyId) return;
    setBusyId(k.id);
    try {
      await apiFetch(`/api/integrations/api-keys/${k.id}`, { method: "DELETE" });
      toast.success(`"${k.name}" was removed`);
      reload();
      createButton.current?.focus();
    } catch (err) {
      toast.error("We could not remove the key", { description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setBusyId(null);
    }
  }

  const columns = useMemo<Column<Key>[]>(
    () => [
      { key: "name", header: "Name", primary: true, cell: (k) => <span className="font-medium">{k.name}</span> },
      {
        key: "prefix",
        header: "Key starts with",
        cell: (k) => (
          <code className="font-mono text-xs">
            {k.prefix}
            <span aria-hidden>...</span>
          </code>
        ),
      },
      {
        key: "scopes",
        header: "Can do",
        cell: (k) => <span className="text-sm">{k.scopes.map(scopeLabel).join(", ")}</span>,
      },
      { key: "used", header: "Last used", cell: (k) => <span className="text-muted">{when(k.lastUsedAt)}</span> },
      { key: "status", header: "Status", cell: (k) => <StatusPill status={k.revokedAt ? "revoked" : "active"} label={k.revokedAt ? "Turned off" : "Active"} /> },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        align: "right",
        cell: (k) =>
          k.revokedAt ? (
            <BusyButton size="sm" variant="ghost" className={touch} busy={busyId === k.id} inactive={busyId !== null} onClick={() => void remove(k)}>
              Remove<span className="sr-only"> key {k.name} from the list</span>
            </BusyButton>
          ) : (
            <BusyButton size="sm" variant="secondary" className={touch} busy={busyId === k.id} inactive={busyId !== null} onClick={() => void revoke(k)}>
              Turn off<span className="sr-only"> key {k.name}</span>
            </BusyButton>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId],
  );

  return (
    <Card
      title="API keys"
      description="Let your own website or software send messages and manage contacts here, without anyone logging in."
      actions={
        <Button ref={createButton} size="sm" className={touch} onClick={() => setCreating(true)}>
          Create API key
        </Button>
      }
    >
      {error && !data ? (
        <ErrorState title="We could not load your keys" message="Check your connection and try again." action={<Button onClick={reload}>Try again</Button>} />
      ) : (
        <DataTable
          caption="API keys"
          columns={columns}
          rows={data?.keys ?? []}
          rowKey={(k) => k.id}
          loading={loading && !data}
          skeletonRows={2}
          empty={
            <EmptyState
              compact
              title="No API keys yet"
              body="Create a key when you want another system, like your website or accounting tool, to send messages or read contacts."
              action={<Button onClick={() => setCreating(true)}>Create API key</Button>}
            />
          }
        />
      )}
      {creating && (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setReveal(key);
            reload();
          }}
        />
      )}
      {reveal && (
        <SecretDialog
          title="Your new API key"
          intro="Paste it into the system that will use it."
          value={reveal}
          lostHint="For your security we show the key only once. If you lose it, turn it off and create a new one."
          onClose={() => setReveal(null)}
        />
      )}
    </Card>
  );
}

"use client";

import { useState } from "react";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Spinner, apiFetch } from "@/components/ui";
import { canManage, useApi, useRole } from "@/components/contacts/hooks";

type Connection = { id: string; name: string; url: string; hasAuth: boolean; allowedTools: string[]; customerTools: string[]; enabled: boolean };
type Tool = { name: string; description: string; risky: boolean; allowed: boolean; customerExposed: boolean };
type TestResult = { ok: boolean; serverName?: string; error?: string; tools: Tool[] };

export function AiToolsView() {
  const role = useRole();
  if (!role) return <Spinner label="Loading" />;
  return (
    <div>
      <PageHeader
        title="AI tools"
        description="Connect your own MCP servers so the AI agent can look things up or act in your systems. Nothing is callable until you tick the tool. Only tools that clearly look read-only (a lookup-style name, or marked read-only by the server) are offered to customers. Every other tool stays hidden from the customer-facing AI agent unless you also switch on customer exposure. Only connect servers you trust."
      />
      {canManage(role) ? <Manager /> : <p className="text-sm text-muted">Only admins and owners can manage AI tools.</p>}
    </div>
  );
}

function Manager() {
  const list = useApi<{ connections: Connection[] }>("/api/mcp-connections");
  if (list.loading) return <Spinner label="Loading connections" />;
  if (list.error || !list.data) return <EmptyState title="Could not load connections" body={list.error ?? undefined} action={<Button size="sm" onClick={list.reload}>Retry</Button>} />;
  return (
    <div className="flex flex-col gap-6">
      <AddForm onAdded={list.reload} />
      {list.data.connections.length === 0 ? (
        <EmptyState title="No servers connected" body="Add the URL of an MCP server that speaks Streamable HTTP. It must be a public https address." />
      ) : (
        list.data.connections.map((c) => <ConnectionCard key={c.id} connection={c} onChanged={list.reload} />)
      )}
    </div>
  );
}

function AddForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/mcp-connections", { method: "POST", body: { name, url, authToken: token || null } });
      setName("");
      setUrl("");
      setToken("");
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="mcp-name">
          <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </Field>
        <Field label="Server URL" htmlFor="mcp-url" hint="https only, port 443 or 8443.">
          <Input id="mcp-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://tools.example.com/mcp" required />
        </Field>
        <Field label="Access token (optional)" htmlFor="mcp-token" hint="Sent as a bearer token. Stored encrypted and never shown again.">
          <Input id="mcp-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <div className="flex items-end gap-3">
          <Button type="submit" disabled={busy}>{busy ? "Adding" : "Add server"}</Button>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </div>
      </form>
    </Card>
  );
}

function ConnectionCard({ connection, onChanged }: { connection: Connection; onChanged: () => void }) {
  const [result, setResult] = useState<TestResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(connection.allowedTools));
  const [exposed, setExposed] = useState<Set<string>>(new Set(connection.customerTools));
  const [busy, setBusy] = useState<"test" | "save" | "remove" | "toggle" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function run<T>(kind: NonNullable<typeof busy>, fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
    setBusy(kind);
    setMessage(null);
    try {
      const value = await fn();
      if (ok) setMessage({ tone: "ok", text: ok });
      return value;
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : "Something went wrong." });
    } finally {
      setBusy(null);
    }
  }

  const test = async () => {
    const r = await run("test", () => apiFetch<TestResult>(`/api/mcp-connections/${connection.id}/test`, { method: "POST" }));
    if (!r) return;
    setResult(r);
    if (r.ok) setExposed(new Set(r.tools.filter((t) => t.customerExposed).map((t) => t.name)));
    if (!r.ok) setMessage({ tone: "error", text: r.error ?? "Could not connect." });
  };
  const save = async () => {
    await run("save", () => apiFetch(`/api/mcp-connections/${connection.id}`, { method: "PATCH", body: { allowedTools: [...selected], customerTools: [...exposed].filter((t) => selected.has(t)) } }), "Allowed tools saved.");
    onChanged();
  };
  const toggle = async () => {
    await run("toggle", () => apiFetch(`/api/mcp-connections/${connection.id}`, { method: "PATCH", body: { enabled: !connection.enabled } }));
    onChanged();
  };
  const remove = async () => {
    if (!window.confirm(`Remove ${connection.name}?`)) return;
    const done = await run("remove", () => apiFetch(`/api/mcp-connections/${connection.id}`, { method: "DELETE" }));
    if (done) onChanged();
  };
  const flip = (name: string) => {
    const next = new Set(selected);
    if (!next.delete(name)) next.add(name);
    setSelected(next);
  };
  const flipExposed = (name: string) => {
    const next = new Set(exposed);
    if (!next.delete(name)) next.add(name);
    setExposed(next);
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">{connection.name}</h2>
          <p className="break-all text-xs text-muted">{connection.url}</p>
          <div className="mt-2 flex gap-2">
            <Badge tone={connection.enabled ? "good" : "neutral"}>{connection.enabled ? "Enabled" : "Disabled"}</Badge>
            <Badge>{connection.hasAuth ? "Token set" : "No token"}</Badge>
            <Badge>{connection.allowedTools.length} allowed</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={test} disabled={busy !== null}>{busy === "test" ? "Testing" : "Test and list tools"}</Button>
          <Button size="sm" variant="secondary" onClick={toggle} disabled={busy !== null}>{connection.enabled ? "Disable" : "Enable"}</Button>
          <Button size="sm" variant="danger" onClick={remove} disabled={busy !== null}>Remove</Button>
        </div>
      </div>
      {message && <p role={message.tone === "error" ? "alert" : "status"} className={`mt-3 text-sm ${message.tone === "error" ? "text-red-700" : "text-emerald-800"}`}>{message.text}</p>}
      {result?.ok && (
        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Tools the AI agent may call{result.serverName ? ` on ${result.serverName}` : ""}</legend>
          {result.tools.length === 0 ? (
            <p className="mt-2 text-sm text-muted">This server lists no tools.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {result.tools.map((t) => (
                <li key={t.name} className="rounded-lg border border-border p-3">
                  <label className="flex items-start gap-3 text-sm">
                    <input type="checkbox" className="mt-1" checked={selected.has(t.name)} onChange={() => flip(t.name)} />
                    <span className="min-w-0">
                      <span className="font-medium">{t.name}</span>
                      {t.risky && <span className="ml-2 align-middle"><Badge tone="warn">Not known to be read-only</Badge></span>}
                      {t.description && <span className="mt-0.5 block text-xs text-muted">{t.description}</span>}
                    </span>
                  </label>
                  {t.risky && (
                    <div className="mt-2 ml-7 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                      <p>
                        Warning: customers can steer the AI agent with their WhatsApp messages. By default this tool is hidden from the customer-facing agent. Expose it only if
                        your server checks every request itself (for example amounts and order ownership).
                      </p>
                      <label className="mt-1 flex items-start gap-2">
                        <input type="checkbox" className="mt-0.5" checked={exposed.has(t.name)} disabled={!selected.has(t.name)} onChange={() => flipExposed(t.name)} />
                        <span>Let customers trigger {t.name} through the AI agent</span>
                      </label>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3">
            <Button size="sm" onClick={save} disabled={busy !== null}>{busy === "save" ? "Saving" : "Save allowed tools"}</Button>
          </div>
        </fieldset>
      )}
    </Card>
  );
}

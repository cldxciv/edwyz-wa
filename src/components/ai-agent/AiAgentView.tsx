"use client";

import { useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Textarea, apiFetch } from "@/components/ui";
import { canManage, useApi, useRole, type ApiState } from "@/components/contacts/hooks";
import { AI_OFF_MESSAGE } from "@/lib/ai-configured";
import { AI_OFF_BODY, AI_OFF_TITLE, testChatProblem } from "./helpers";
import type { Agent, ChatLine, Source, Usage } from "./types";

const ACTIVATION_LABEL: Record<Agent["activation"], string> = {
  always: "Always",
  outside_hours: "Outside working hours",
  no_human_reply_minutes: "When no teammate has replied recently",
};

function UsageMeter({ data, error }: Pick<ApiState<Usage>, "data" | "error">) {
  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!data) return <Spinner label="Loading usage" />;
  const pct = data.limit ? Math.min(100, Math.round((data.used / data.limit) * 100)) : 0;
  return (
    <Card>
      <h2 className="text-base font-semibold">AI credits this month</h2>
      <p className="mt-1 text-sm text-muted">
        {data.used} used{data.limit !== null ? ` of ${data.limit}` : " (no monthly limit set)"}. {data.replies} AI replies sent.
      </p>
      {data.limit !== null && (
        <div role="progressbar" aria-label="AI credits used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-3 h-2 overflow-hidden rounded-full bg-surface">
          <div className={pct >= 90 ? "h-full bg-red-700" : "h-full bg-accent"} style={{ width: `${pct}%` }} />
        </div>
      )}
      {data.limit !== null && data.remaining === 0 && <p className="mt-2 text-xs text-red-700">Credits are used up. New chats are handed to your team.</p>}
    </Card>
  );
}

function SettingsForm({ agent, editable, aiOff, onSaved, onDeleted }: { agent: Agent; editable: boolean; aiOff: boolean; onSaved: () => void; onDeleted: () => void }) {
  // The form is a draft: it is filled once per agent (the parent keys it by id) and from the saved answer, never from the
  // list reload after a save, which would wipe whatever the person typed while that reload was on its way.
  const [form, setForm] = useState({ ...agent, keywords: agent.handoffKeywords.join(", ") });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const { agent: saved } = await apiFetch<{ agent: Agent }>(`/api/ai-agent/agents/${agent.id}`, {
        method: "PATCH",
        body: {
          name: form.name,
          enabled: form.enabled,
          instructions: form.instructions,
          tone: form.tone ?? "",
          language: form.language || "auto",
          activation: form.activation,
          noHumanReplyMinutes: Number(form.noHumanReplyMinutes),
          maxRepliesPerConversation: Number(form.maxRepliesPerConversation),
          handoffKeywords: form.keywords.split(",").map((k) => k.trim()).filter(Boolean),
        },
      });
      // show what the server kept (keywords trimmed and lower-cased)
      setForm({ ...saved, keywords: saved.handoffKeywords.join(", ") });
      setMsg({ ok: true, text: "Saved." });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete the AI agent "${agent.name}" and its knowledge?`)) return;
    try {
      await apiFetch(`/api/ai-agent/agents/${agent.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Could not delete." });
    }
  }

  return (
    <Card>
      <form onSubmit={save} className="space-y-4" aria-label="AI agent settings">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Settings</h2>
          <label className="inline-flex items-center gap-2 text-sm font-medium">
            {/* An agent that is already on can still be turned off while AI is off; it just cannot be turned on. */}
            <input type="checkbox" checked={form.enabled} disabled={!editable || (aiOff && !form.enabled)} aria-describedby={aiOff ? "ai-enabled-note" : undefined} onChange={(e) => set("enabled", e.target.checked)} />
            Enabled
          </label>
        </div>
        {aiOff && (
          <p id="ai-enabled-note" className="text-sm text-muted">
            {AI_OFF_MESSAGE} The agent cannot be enabled until then.
          </p>
        )}
        <Field label="Name" htmlFor="ai-name">
          <Input id="ai-name" value={form.name} maxLength={80} disabled={!editable} onChange={(e) => set("name", e.target.value)} required />
        </Field>
        <Field label="Instructions" htmlFor="ai-instructions" hint="Who the assistant is and what it should help with. It only answers from the knowledge below and hands off otherwise.">
          <Textarea id="ai-instructions" rows={5} value={form.instructions} maxLength={4000} disabled={!editable} onChange={(e) => set("instructions", e.target.value)} required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tone" htmlFor="ai-tone">
            <Input id="ai-tone" value={form.tone ?? ""} maxLength={200} placeholder="Warm and professional" disabled={!editable} onChange={(e) => set("tone", e.target.value)} />
          </Field>
          <Field label="Language" htmlFor="ai-language" hint='Use "auto" to match the customer.'>
            <Input id="ai-language" value={form.language} maxLength={40} disabled={!editable} onChange={(e) => set("language", e.target.value)} />
          </Field>
          <Field label="Reply when" htmlFor="ai-activation">
            <Select id="ai-activation" value={form.activation} disabled={!editable} onChange={(e) => set("activation", e.target.value as Agent["activation"])}>
              {Object.entries(ACTIVATION_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
          </Field>
          {form.activation === "no_human_reply_minutes" && (
            <Field label="Minutes without a teammate reply" htmlFor="ai-minutes">
              <Input id="ai-minutes" type="number" min={1} max={1440} value={form.noHumanReplyMinutes} disabled={!editable} onChange={(e) => set("noHumanReplyMinutes", Number(e.target.value))} />
            </Field>
          )}
          <Field label="Max AI replies per chat" htmlFor="ai-max">
            <Input id="ai-max" type="number" min={1} max={50} value={form.maxRepliesPerConversation} disabled={!editable} onChange={(e) => set("maxRepliesPerConversation", Number(e.target.value))} />
          </Field>
        </div>
        {agent.model && agent.effectiveModel && agent.model !== agent.effectiveModel && (
          <p className="text-xs text-amber-800">This agent was set to the model {agent.model}, which is no longer allowed on this platform. Replies use {agent.effectiveModel} instead.</p>
        )}
        <Field label="Handoff keywords" htmlFor="ai-keywords" hint="Comma separated. A customer message containing one goes straight to your team.">
          <Input id="ai-keywords" value={form.keywords} disabled={!editable} onChange={(e) => set("keywords", e.target.value)} placeholder="refund, complaint, lawyer" />
        </Field>
        {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm text-emerald-800" : "text-sm text-red-700"}>{msg.text}</p>}
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>{busy ? "Saving" : "Save settings"}</Button>
            <Button type="button" variant="danger" onClick={() => void remove()}>Delete agent</Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function Knowledge({ agentId, editable }: { agentId: string; editable: boolean }) {
  const { data, error, loading, reload } = useApi<{ sources: Source[] }>(`/api/ai-agent/agents/${agentId}/sources`);
  const [kind, setKind] = useState<"text" | "faq" | "url">("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const body = kind === "text" ? { kind, title, content } : kind === "url" ? { kind, title, url } : { kind, title, faq: [{ q, a }] };
    try {
      await apiFetch(`/api/ai-agent/agents/${agentId}/sources`, { method: "POST", body });
      setTitle(""); setContent(""); setUrl(""); setQ(""); setA("");
      reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not add the source.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await apiFetch(`/api/ai-agent/agents/${agentId}/sources/${id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not delete.");
    }
  }

  return (
    <Card>
      <h2 className="text-base font-semibold">Knowledge</h2>
      <p className="mt-1 text-sm text-muted">The assistant answers only from this. Web pages are read once when you add them; add them again to refresh.</p>
      {loading && <Spinner label="Loading sources" />}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      {data && data.sources.length === 0 && <p className="mt-3 text-sm text-muted">No knowledge yet. Without it the assistant hands every question to your team.</p>}
      <ul className="mt-3 divide-y divide-border">
        {data?.sources.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{s.title}</p>
              <p className="text-xs text-muted"><Badge>{s.kind}</Badge> {s.chars.toLocaleString()} characters</p>
            </div>
            {editable && <Button size="sm" variant="secondary" aria-label={`Delete ${s.title}`} onClick={() => void remove(s.id)}>Delete</Button>}
          </li>
        ))}
      </ul>
      {editable && (
        <form onSubmit={add} className="mt-4 space-y-3 border-t border-border pt-4" aria-label="Add knowledge">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type" htmlFor="ks-kind">
              <Select id="ks-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="text">Text</option>
                <option value="faq">FAQ</option>
                <option value="url">Web page</option>
              </Select>
            </Field>
            <Field label="Title" htmlFor="ks-title">
              <Input id="ks-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>
          {kind === "text" && (
            <Field label="Text" htmlFor="ks-content">
              <Textarea id="ks-content" rows={5} value={content} onChange={(e) => setContent(e.target.value)} required />
            </Field>
          )}
          {kind === "url" && (
            <Field label="Page address" htmlFor="ks-url" hint="Public https pages only.">
              <Input id="ks-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/faq" required />
            </Field>
          )}
          {kind === "faq" && (
            <>
              <Field label="Question" htmlFor="ks-q">
                <Input id="ks-q" value={q} maxLength={500} onChange={(e) => setQ(e.target.value)} required />
              </Field>
              <Field label="Answer" htmlFor="ks-a">
                <Textarea id="ks-a" rows={3} value={a} maxLength={2000} onChange={(e) => setA(e.target.value)} required />
              </Field>
            </>
          )}
          {msg && <p role="alert" className="text-sm text-red-700">{msg}</p>}
          <Button type="submit" disabled={busy}>{busy ? "Adding" : "Add knowledge"}</Button>
        </form>
      )}
    </Card>
  );
}

function TestChat({ agentId, aiOff }: { agentId: string; aiOff: boolean }) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // A failed test is a notice from us, not a reply: it never goes into a bubble as if the assistant had said it.
  const [problem, setProblem] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || aiOff) return;
    setText("");
    setProblem(null);
    setLines((l) => [...l, { role: "you", text: message }]);
    setBusy(true);
    try {
      const r = await apiFetch<{ text: string; handoff: boolean; sources: string[] }>(`/api/ai-agent/agents/${agentId}/test`, { method: "POST", body: { message } });
      const note = r.handoff ? "Would hand off to your team." : r.sources.length ? `Used: ${r.sources.join(", ")}` : undefined;
      setLines((l) => [...l, { role: "ai", text: r.text || "(no reply, the chat would be handed to your team)", note }]);
    } catch (err) {
      setProblem(testChatProblem(err instanceof Error ? err.message : null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-base font-semibold">Test chat</h2>
      <p className="mt-1 text-sm text-muted">{aiOff ? `${AI_OFF_MESSAGE} The test chat cannot answer until then.` : "Nothing is sent to customers. Each test uses one AI credit."}</p>
      <div className="mt-3 max-h-80 space-y-2 overflow-y-auto" aria-live="polite">
        {lines.map((line, i) => (
          <div key={i} className={line.role === "you" ? "ml-auto max-w-[85%] rounded-2xl bg-accent px-3 py-2 text-sm text-white" : "max-w-[85%] rounded-2xl border border-border bg-surface px-3 py-2 text-sm"}>
            <p className="whitespace-pre-wrap">{line.text}</p>
            {line.note && <p className="mt-1 text-xs opacity-70">{line.note}</p>}
          </div>
        ))}
        {busy && <Spinner label="Thinking" />}
      </div>
      {problem && <p role="alert" className="mt-3 text-sm text-red-700">{problem}</p>}
      <form onSubmit={send} className="mt-3 flex gap-2" aria-label="Test message">
        <Input aria-label="Test message" value={text} maxLength={1000} disabled={aiOff} onChange={(e) => setText(e.target.value)} placeholder="Ask a customer question" />
        <Button type="submit" disabled={busy || aiOff || !text.trim()}>Send</Button>
      </form>
    </Card>
  );
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("Support assistant");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setMsg("Give the agent a name.");
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch("/api/ai-agent/agents", { method: "POST", body: { name, instructions } });
      onCreated();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not create the agent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={create} className="space-y-3" aria-label="Create AI agent">
        <Field label="Name" htmlFor="new-name">
          <Input id="new-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Instructions" htmlFor="new-instructions" hint="For example: You answer questions for a dental clinic. Offer to book appointments.">
          <Textarea id="new-instructions" rows={4} value={instructions} maxLength={4000} onChange={(e) => setInstructions(e.target.value)} required />
        </Field>
        {msg && <p role="alert" className="text-sm text-red-700">{msg}</p>}
        <Button type="submit" disabled={busy}>{busy ? "Creating" : "Create AI agent"}</Button>
      </form>
    </Card>
  );
}

export function AiAgentView() {
  const role = useRole();
  const editable = canManage(role);
  const { data, error, loading, reload } = useApi<{ agents: Agent[] }>("/api/ai-agent/agents");
  const usage = useApi<Usage>("/api/ai-agent/usage");
  const aiOff = usage.data?.aiConfigured === false;
  const [selected, setSelected] = useState<string | null>(null);
  const agents = data?.agents ?? [];
  const agent = agents.find((a) => a.id === selected) ?? agents[0] ?? null;

  return (
    <div>
      <PageHeader
        title="AI agent"
        description="Let an assistant answer customers from your own knowledge, inside the 24-hour window. It hands the chat to your team when it cannot help."
      />
      {aiOff && (
        <Alert tone="warn" className="mb-4" title={AI_OFF_TITLE}>
          {AI_OFF_BODY}
        </Alert>
      )}
      {role && !editable && <p className="mb-4 text-sm text-muted">You can view the AI agent. Only admins and owners can change it.</p>}
      {loading && <Spinner label="Loading AI agents" />}
      {error && !data && <EmptyState title="Could not load AI agents" body={error} action={<Button size="sm" onClick={reload}>Retry</Button>} />}
      {data && agents.length === 0 && (editable ? <CreateForm onCreated={reload} /> : <EmptyState title="No AI agent yet" body="Ask an admin to set one up." />)}
      {agent && (
        <div className="space-y-4">
          {agents.length > 1 && (
            <Field label="Agent" htmlFor="agent-select">
              <Select id="agent-select" value={agent.id} onChange={(e) => setSelected(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </Select>
            </Field>
          )}
          {/* A credit budget means nothing while AI is off, so it is not shown then. */}
          {!aiOff && <UsageMeter data={usage.data} error={usage.error} />}
          <SettingsForm key={agent.id} agent={agent} editable={editable} aiOff={aiOff} onSaved={reload} onDeleted={() => { setSelected(null); reload(); }} />
          <Knowledge agentId={agent.id} editable={editable} />
          {editable && <TestChat agentId={agent.id} aiOff={aiOff} />}
        </div>
      )}
    </div>
  );
}

"use client";

import { useRef, useState, type FormEvent, type RefObject } from "react";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, ProgressBar, Select, Spinner, Textarea, apiFetch, confirm } from "@/components/ui";
import { canManage, useApi, useRole, type ApiState } from "@/components/contacts/hooks";
import { AI_OFF_MESSAGE } from "@/lib/ai-configured";
import { AI_OFF_BODY, AI_OFF_TITLE, agentProblems, languageOptions, sourceProblems, splitKeywords, testChatProblem } from "./helpers";
import type { Agent, ChatLine, Source, Usage } from "./types";

/** After a refused submit, moves the keyboard focus to the first field that needs fixing (rendered on the next frame). */
function focusFirstProblem(form: RefObject<HTMLFormElement | null>) {
  requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}

type Activation = Agent["activation"];

const ACTIVATION_LABEL: Record<Activation, string> = {
  always: "Always",
  outside_hours: "Outside working hours",
  no_human_reply_minutes: "When no teammate has replied recently",
  when_started: "Only when an automation rule starts it",
};

const ACTIVATION_HINT: Partial<Record<Activation, string>> = {
  when_started: "The agent stays quiet until a rule with the step \"Let the AI agent answer\" runs, for example when a message mentions prices.",
};

/** AI replies in the last 60 minutes against the plan's AI replies per hour (/api/ai-agent/usage `hour`). */
export type HourlyUse = { used: number; limit: number; source?: "plan" | "plan_default" | "trial" | "no_plan" | "fallback" };

/** The words of the hourly meter: what is used, where the allowance comes from, and what happens at the limit. */
export function hourlyUseText(hour: HourlyUse): { summary: string; allowance: string; full: boolean; fullNote: string | null } {
  const n = (v: number) => v.toLocaleString("en-IN");
  const allowance =
    hour.source === "trial" ? `Your free trial allows ${n(hour.limit)} AI replies an hour.`
    : hour.source === "no_plan" ? `Without a paid plan, the AI agent can send ${n(hour.limit)} replies an hour.`
    : hour.source === "fallback" ? `This workspace can send ${n(hour.limit)} AI replies an hour.`
    : `Your plan allows ${n(hour.limit)} AI replies an hour.`;
  const full = hour.used >= hour.limit;
  return {
    summary: `${n(hour.used)} of ${n(hour.limit)} used in the last hour.`,
    allowance,
    full,
    fullNote: full ? "Limit reached. New chats wait for your team until replies sent more than an hour ago drop off." : null,
  };
}

function HourlyMeter({ hour, canUpgrade }: { hour: HourlyUse; canUpgrade: boolean }) {
  const text = hourlyUseText(hour);
  const percent = hour.limit > 0 ? Math.min(100, Math.floor((hour.used * 100) / hour.limit)) : 100;
  return (
    <div className="mt-4 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">AI replies this hour</h3>
      <p className="mt-1 text-sm text-muted">
        {text.summary} {text.allowance}
      </p>
      <ProgressBar className="mt-3" label={`AI replies in the last hour: ${percent}% of the hourly limit used`} value={percent} tone="auto" warnAt={80} dangerAt={100} valueText={`${percent}%`} />
      <p role="status" className={text.fullNote ? "mt-2 text-xs text-bad-fg" : "sr-only"}>
        {text.fullNote}
        {text.fullNote && canUpgrade && (
          <>
            {" "}
            <a href="/app/billing#plans" className="font-medium underline underline-offset-2">A bigger plan allows more replies.</a>
          </>
        )}
      </p>
    </div>
  );
}

function UsageMeter({ data, error, canUpgrade }: Pick<ApiState<Usage & { hour?: HourlyUse }>, "data" | "error"> & { canUpgrade: boolean }) {
  if (error) return <p role="alert" className="text-sm text-bad-fg">{error}</p>;
  if (!data) return <Spinner label="Loading usage" />;
  const pct = data.limit ? Math.min(100, Math.round((data.used / data.limit) * 100)) : 0;
  return (
    <Card>
      <h2 className="text-base font-semibold">AI credits this month</h2>
      <p className="mt-1 text-sm text-muted">
        {data.used} used{data.limit !== null ? ` of ${data.limit}` : " (no monthly limit set)"}. {data.replies}{" "}AI replies sent.
      </p>
      {data.limit !== null && (
        <ProgressBar className="mt-3" label="AI credits used" value={pct} tone="auto" warnAt={80} dangerAt={90} valueText={`${pct}%`} />
      )}
      {data.limit !== null && data.remaining === 0 && <p className="mt-2 text-xs text-bad-fg">Credits are used up. New chats are handed to your team.</p>}
      {data.hour && <HourlyMeter hour={data.hour} canUpgrade={canUpgrade} />}
    </Card>
  );
}

function SettingsForm({ agent, editable, aiOff, onSaved, onDeleted }: { agent: Agent; editable: boolean; aiOff: boolean; onSaved: () => void; onDeleted: () => void }) {
  // The form is a draft: it is filled once per agent (the parent keys it by id) and from the saved answer, never from the
  // list reload after a save, which would wipe whatever the person typed while that reload was on its way.
  const [form, setForm] = useState({ ...agent, keywords: agent.handoffKeywords.join(", ") });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const problems = attempted ? agentProblems(form) : {};

  async function save(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (Object.keys(agentProblems(form)).length) {
      setMsg(null);
      focusFirstProblem(formRef);
      return;
    }
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
          handoffKeywords: splitKeywords(form.keywords),
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
    const ok = await confirm({
      title: `Delete "${agent.name}"?`,
      body: "The AI agent stops answering customers, and the knowledge you added to it is deleted too. This cannot be undone.",
      confirmLabel: "Delete agent",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/ai-agent/agents/${agent.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Could not delete." });
    }
  }

  return (
    <Card>
      <form ref={formRef} onSubmit={save} noValidate className="space-y-4" aria-label="AI agent settings">
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
            {AI_OFF_MESSAGE}{" "}The agent cannot be enabled until then.
          </p>
        )}
        <Field label="Name" htmlFor="ai-name" required error={problems.name}>
          <Input id="ai-name" value={form.name} maxLength={80} disabled={!editable} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Instructions" htmlFor="ai-instructions" required error={problems.instructions} hint="Who the assistant is and what it should help with. It only answers from the knowledge below and hands off otherwise.">
          <Textarea id="ai-instructions" rows={5} value={form.instructions} maxLength={4000} disabled={!editable} onChange={(e) => set("instructions", e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tone" htmlFor="ai-tone" optional>
            <Input id="ai-tone" value={form.tone ?? ""} maxLength={200} placeholder="e.g. Warm and professional" disabled={!editable} onChange={(e) => set("tone", e.target.value)} />
          </Field>
          <Field label="Language" htmlFor="ai-language" hint="The language of its replies.">
            <Select id="ai-language" value={form.language || "auto"} disabled={!editable} onChange={(e) => set("language", e.target.value)}>
              {languageOptions(form.language).map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Reply when" htmlFor="ai-activation" hint={ACTIVATION_HINT[form.activation]}>
            <Select id="ai-activation" value={form.activation} disabled={!editable} onChange={(e) => set("activation", e.target.value as Agent["activation"])}>
              {Object.entries(ACTIVATION_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
          </Field>
          {form.activation === "no_human_reply_minutes" && (
            <Field label="Minutes without a teammate reply" htmlFor="ai-minutes" required error={problems.minutes}>
              <Input id="ai-minutes" type="number" min={1} max={1440} value={form.noHumanReplyMinutes} disabled={!editable} onChange={(e) => set("noHumanReplyMinutes", Number(e.target.value))} />
            </Field>
          )}
          <Field label="Max AI replies per chat in a day" htmlFor="ai-max" required error={problems.max} hint="From 1 to 50 in any 24 hours. After that the chat goes to your team.">
            <Input id="ai-max" type="number" min={1} max={50} value={form.maxRepliesPerConversation} disabled={!editable} onChange={(e) => set("maxRepliesPerConversation", Number(e.target.value))} />
          </Field>
        </div>
        <p className="text-xs text-muted">
          After the agent hands a chat to your team, it stays quiet in that chat. It answers again when the customer writes after the chat was marked solved, or after a day without writing.
          A teammate can also press Let the AI answer again at the top of the chat.
        </p>
        {agent.model && agent.effectiveModel && agent.model !== agent.effectiveModel && (
          <p className="text-xs text-amber-800">This agent was set to the model {agent.model}, which is no longer allowed on this platform. Replies use {agent.effectiveModel} instead.</p>
        )}
        <Field label="Handoff keywords" htmlFor="ai-keywords" optional error={problems.keywords} hint="Comma separated, up to 20. A customer message containing one goes straight to your team. Asking for a person always does, even with none set.">
          <Input id="ai-keywords" value={form.keywords} disabled={!editable} onChange={(e) => set("keywords", e.target.value)} placeholder="e.g. refund, complaint" />
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

/** Same limits as the server (src/lib/ai-agent/agents.ts): text files only, up to 100 000 characters each. */
const FILE_TYPES = /\.(txt|text|md|markdown)$/i;
const MAX_FILE_CHARS = 100_000;
type PickedFile = { name: string; content: string };

/** What is wrong with the chosen file, in words, or undefined when it can be added. */
export function fileProblem(file: PickedFile | null): string | undefined {
  if (!file) return "Choose a .txt or .md file.";
  if (!FILE_TYPES.test(file.name)) return "Only .txt and .md files can be added. For a PDF or Word file, copy its text into a Text source.";
  if (!file.content.trim()) return "This file has no text in it.";
  if (file.content.length > MAX_FILE_CHARS) return `This file has ${file.content.length.toLocaleString("en")} characters. One source can hold up to ${MAX_FILE_CHARS.toLocaleString("en")}, so split it into smaller files.`;
  return undefined;
}

const KIND_LABEL: Record<string, string> = { text: "Text", faq: "FAQ", url: "Web page", file: "File" };

function Knowledge({ agentId, editable }: { agentId: string; editable: boolean }) {
  const { data, error, loading, reload } = useApi<{ sources: Source[] }>(`/api/ai-agent/agents/${agentId}/sources`);
  const [kind, setKind] = useState<"text" | "faq" | "url" | "file">("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [file, setFile] = useState<PickedFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // The outcome of the last Refresh, shown under the list next to the button that was pressed.
  const [refreshNote, setRefreshNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const check = (): Record<string, string | undefined> => {
    if (kind !== "file") return sourceProblems(kind, { content, url, q, a });
    const problem = fileProblem(file);
    return problem ? { file: problem } : {};
  };
  const problems = attempted ? check() : {};

  async function pick(chosen: File | undefined) {
    setMsg(null);
    if (!chosen) return setFile(null);
    try {
      setFile({ name: chosen.name, content: await chosen.text() });
    } catch {
      setFile(null);
      setMsg("We could not read that file. Try again, or paste its text into a Text source.");
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    setMsg(null);
    setRefreshNote(null);
    if (Object.keys(check()).length) {
      focusFirstProblem(formRef);
      return;
    }
    setBusy(true);
    const body =
      kind === "text" ? { kind, title, content }
      : kind === "url" ? { kind, title, url }
      : kind === "file" ? { kind, title, fileName: file?.name ?? "", content: file?.content ?? "" }
      : { kind, title, faq: [{ q, a }] };
    try {
      await apiFetch(`/api/ai-agent/agents/${agentId}/sources`, { method: "POST", body });
      setTitle(""); setContent(""); setUrl(""); setQ(""); setA(""); setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setAttempted(false);
      reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not add the source.");
    } finally {
      setBusy(false);
    }
  }

  async function refresh(source: Source) {
    setRefreshNote(null);
    setRefreshing(source.id);
    try {
      await apiFetch(`/api/ai-agent/agents/${agentId}/sources`, { method: "PATCH", body: { sourceId: source.id } });
      setRefreshNote({ ok: true, text: `"${source.title}" was read again. The assistant now uses the page as it is today.` });
      reload();
    } catch (err) {
      const reason = err instanceof Error && err.message ? ` ${err.message}` : "";
      setRefreshNote({ ok: false, text: `We could not read "${source.title}" again.${reason} The text from before is still used.` });
    } finally {
      setRefreshing(null);
    }
  }

  async function remove(source: Source) {
    const ok = await confirm({ title: `Delete "${source.title}"?`, body: "The assistant stops using it to answer. To use it again, add it again.", confirmLabel: "Delete knowledge", tone: "danger" });
    if (!ok) return;
    try {
      await apiFetch(`/api/ai-agent/agents/${agentId}/sources/${source.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not delete.");
    }
  }

  return (
    <Card>
      <h2 className="text-base font-semibold">Knowledge</h2>
      <p className="mt-1 text-sm text-muted">The assistant answers only from this. Web pages are read when you add them; press Refresh to read one again after it changes.</p>
      {loading && <Spinner label="Loading sources" />}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      {data && data.sources.length === 0 && <p className="mt-3 text-sm text-muted">No knowledge yet. Without it the assistant hands every question to your team.</p>}
      <ul className="mt-3 divide-y divide-border">
        {data?.sources.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{s.title}</p>
              <p className="text-xs text-muted"><Badge>{KIND_LABEL[s.kind] ?? s.kind}</Badge> {s.chars.toLocaleString()} characters</p>
            </div>
            {editable && (
              <div className="flex gap-2">
                {s.kind === "url" && (
                  <Button size="sm" variant="secondary" aria-label={`Refresh ${s.title}`} disabled={refreshing !== null} onClick={() => void refresh(s)}>
                    {refreshing === s.id ? "Refreshing" : "Refresh"}
                  </Button>
                )}
                <Button size="sm" variant="secondary" aria-label={`Delete ${s.title}`} onClick={() => void remove(s)}>Delete</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {refreshNote && <p role={refreshNote.ok ? "status" : "alert"} className={refreshNote.ok ? "mt-2 text-sm text-emerald-800" : "mt-2 text-sm text-red-700"}>{refreshNote.text}</p>}
      {editable && (
        <form ref={formRef} onSubmit={add} noValidate className="mt-4 space-y-3 border-t border-border pt-4" aria-label="Add knowledge">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type" htmlFor="ks-kind">
              <Select id="ks-kind" value={kind} onChange={(e) => (setKind(e.target.value as typeof kind), setAttempted(false))}>
                <option value="text">Text</option>
                <option value="faq">FAQ</option>
                <option value="url">Web page</option>
                <option value="file">Text file (.txt or .md)</option>
              </Select>
            </Field>
            <Field label="Title" htmlFor="ks-title" optional>
              <Input id="ks-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>
          {kind === "text" && (
            <Field label="Text" htmlFor="ks-content" required error={problems.content}>
              <Textarea id="ks-content" rows={5} value={content} onChange={(e) => setContent(e.target.value)} />
            </Field>
          )}
          {kind === "url" && (
            <Field label="Page address" htmlFor="ks-url" required error={problems.url} hint="Public https pages only.">
              <Input id="ks-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/faq" />
            </Field>
          )}
          {kind === "file" && (
            <Field label="File" htmlFor="ks-file" required error={problems.file} hint="A .txt or .md file of up to 100,000 characters. For a PDF or Word file, copy its text into a Text source.">
              <Input id="ks-file" ref={fileRef} type="file" accept=".txt,.text,.md,.markdown,text/plain,text/markdown" onChange={(e) => void pick(e.target.files?.[0])} />
            </Field>
          )}
          {kind === "faq" && (
            <>
              <Field label="Question" htmlFor="ks-q" required error={problems.q}>
                <Input id="ks-q" value={q} maxLength={500} onChange={(e) => setQ(e.target.value)} />
              </Field>
              <Field label="Answer" htmlFor="ks-a" required error={problems.a}>
                <Textarea id="ks-a" rows={3} value={a} maxLength={2000} onChange={(e) => setA(e.target.value)} />
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
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const problems = attempted ? agentProblems({ name, instructions }) : {};

  async function create(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (Object.keys(agentProblems({ name, instructions })).length) {
      setMsg(null);
      focusFirstProblem(formRef);
      return;
    }
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
      <form ref={formRef} onSubmit={create} noValidate className="space-y-3" aria-label="Create AI agent">
        <Field label="Name" htmlFor="new-name" required error={problems.name}>
          <Input id="new-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Instructions" htmlFor="new-instructions" required error={problems.instructions} hint="For example: You answer questions for a dental clinic. Offer to book appointments.">
          <Textarea id="new-instructions" rows={4} value={instructions} maxLength={4000} onChange={(e) => setInstructions(e.target.value)} />
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
  const usage = useApi<Usage & { hour?: HourlyUse }>("/api/ai-agent/usage");
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
          {!aiOff && <UsageMeter data={usage.data} error={usage.error} canUpgrade={editable} />}
          <SettingsForm key={agent.id} agent={agent} editable={editable} aiOff={aiOff} onSaved={reload} onDeleted={() => { setSelected(null); reload(); }} />
          <Knowledge agentId={agent.id} editable={editable} />
          {editable && <TestChat agentId={agent.id} aiOff={aiOff} />}
        </div>
      )}
    </div>
  );
}

"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, Badge, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { TeamAssign, useTeams } from "@/components/teams/InboxTeamControls";
import { peopleForTeam } from "@/components/teams/helpers";
import { avatarHint } from "@/lib/contacts/identity";
import { Avatar, Icon } from "./Avatar";
import { statusDisplay } from "./helpers";
import { fetchNotes } from "./notes-cache";
import type { ConversationContext, ConversationDetail, Member, Note } from "./types";
import { usePolling } from "./usePolling";
import { attributeRows, parseReferral } from "./ux";

type Conv = ConversationDetail["conversation"];

const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Tags the platform keeps for itself, never shown as the team's own tags. "ai:stopped" is the AI agent's pause marker (STOP_TAG in
 * src/lib/ai-agent); the chat header offers "Let the AI answer again" instead. Hidden tags are kept when the list is saved.
 */
const SYSTEM_TAGS = new Set(["ai:stopped"]);
export const visibleTags = (tags: string[]) => tags.filter((t) => !SYSTEM_TAGS.has(t));

/** The lead stages a teammate can set from the chat: qualified, unless it already is or was won, and a sale (won), unless it was. */
export function leadQuickActions(status: string): { status: "qualified" | "won"; label: string }[] {
  const out: { status: "qualified" | "won"; label: string }[] = [];
  if (status !== "qualified" && status !== "won") out.push({ status: "qualified", label: "Mark as qualified" });
  if (status !== "won") out.push({ status: "won", label: "Mark as sale" });
  return out;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Skeleton() {
  return (
    <div role="status" aria-label="Loading details" className="animate-pulse space-y-2">
      <div className="h-3 w-2/3 rounded bg-surface" />
      <div className="h-3 w-1/2 rounded bg-surface" />
    </div>
  );
}

/** canBlock: owners and admins may block a chat (the server refuses it for agents), so the menu offers Blocked to them, as the header does. */
export function SidePanel({ conversation, members, canBlock = false, onClose, onChanged }: { conversation: Conv; members: Member[]; canBlock?: boolean; onClose: () => void; onChanged: () => void }) {
  const id = conversation.id;
  const c = conversation.contact;
  const teams = useTeams();
  const conversationTeamId = (conversation as { teamId?: string | null }).teamId ?? null;
  const assignable = peopleForTeam(teams, conversationTeamId, members, conversation.assignedToId);
  const [tags, setTags] = useState<string[]>(conversation.tags);
  const [tagInput, setTagInput] = useState("");
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [noteText, setNoteText] = useState("");
  const [context, setContext] = useState<ConversationContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [attrKey, setAttrKey] = useState("");
  const [attrValue, setAttrValue] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(c.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [leadBusy, setLeadBusy] = useState<"qualified" | "won" | null>(null);
  const [leadNote, setLeadNote] = useState("");

  useEffect(() => setTags(conversation.tags), [conversation.tags]);
  useEffect(() => setLeadNote(""), [id]);

  // Shares the request with the chat timeline, which shows the same notes.
  const loadNotes = useCallback(
    async (fresh = false) => {
      setNotes(await fetchNotes(id, { fresh }));
    },
    [id],
  );
  usePolling(loadNotes, 10_000);

  const loadContext = useCallback(async () => {
    try {
      setContext(await apiFetch<ConversationContext>(`/api/inbox/conversations/${id}/context`));
      setContextError(null);
    } catch (e) {
      setContextError(e instanceof Error ? e.message : "Could not load contact history.");
    }
  }, [id]);
  usePolling(loadContext, 30_000);

  async function act(path: string, method: string, body: unknown) {
    setError(null);
    try {
      await apiFetch(`/api/inbox/conversations/${id}/${path}`, { method, body });
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
      return false;
    }
  }

  async function patchContact(body: Record<string, unknown>) {
    setError(null);
    try {
      await apiFetch(`/api/contacts/${c.id}`, { method: "PATCH", body });
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the contact.");
      return false;
    }
  }

  async function saveTags(next: string[]) {
    const previous = tags;
    setTags(next);
    if (!(await act("tags", "PUT", { tags: next }))) setTags(previous);
  }

  async function addTag(e: React.FormEvent) {
    e.preventDefault();
    const t = tagInput.trim();
    if (!t || tags.includes(t)) return setTagInput("");
    setTagInput("");
    await saveTags([...tags, t]);
  }

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteText.trim()) return;
    setError(null);
    try {
      await apiFetch(`/api/inbox/conversations/${id}/notes`, { method: "POST", body: { body: noteText } });
      setNoteText("");
      // Fetch the new list first, so the chat timeline's refresh that onChanged triggers finds it already there.
      await loadNotes(true).catch(() => undefined);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    }
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (await patchContact({ name: nameInput.trim() })) setEditingName(false);
  }

  const attrs = attributeRows(c.attributes);
  const allAttrs = c.attributes && typeof c.attributes === "object" && !Array.isArray(c.attributes) ? (c.attributes as Record<string, unknown>) : {};

  async function setAttribute(e: React.FormEvent) {
    e.preventDefault();
    const key = attrKey.trim();
    if (!key || !attrValue.trim()) return;
    if (await patchContact({ attributes: { ...allAttrs, [key]: attrValue.trim() } })) {
      setAttrKey("");
      setAttrValue("");
    }
  }

  async function removeAttribute(key: string) {
    const next = { ...allAttrs };
    delete next[key];
    await patchContact({ attributes: next });
  }

  /** Moves the contact's lead on from the chat; the leads API reports qualified and won (a sale) to Meta for the ads. */
  async function markLead(next: "qualified" | "won") {
    const leadId = context?.lead?.id;
    if (!leadId) return;
    setError(null);
    setLeadNote("");
    setLeadBusy(next);
    try {
      await apiFetch(`/api/leads/${leadId}`, { method: "PATCH", body: { status: next } });
      setLeadNote(next === "won" ? "Lead marked as a sale." : "Lead marked as qualified.");
      await loadContext();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the lead.");
    } finally {
      setLeadBusy(null);
    }
  }

  const author = (uid: string) => (members.find((m) => m.userId === uid)?.name ?? "Teammate");
  const ad = parseReferral(conversation.referral);
  const optStatus = c.optedOutAt ? <Badge tone="bad">Opted out of marketing</Badge> : c.optIn ? <Badge tone="good">Opted in</Badge> : <Badge tone="warn">No opt-in recorded</Badge>;
  const lead = context?.lead ?? null;

  return (
    <aside aria-label="Contact details" className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Contact</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close details"><Icon name="close" /> Close</Button>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <section className="flex items-start gap-3">
          <Avatar id={c.id} name={c.name} phone={avatarHint(c)} size="lg" />
          <div className="min-w-0 flex-1">
            {editingName ? (
              <form onSubmit={saveName} className="flex gap-1.5">
                <Input aria-label="Contact name" value={nameInput} maxLength={120} onChange={(e) => setNameInput(e.target.value)} autoFocus />
                <Button type="submit" size="sm">Save</Button>
              </form>
            ) : (
              <p className="flex items-center gap-2 font-semibold">
                <span className="truncate">{c.name || (c.username ? `@${c.username}` : "Unnamed contact")}</span>
                <button type="button" className="text-xs font-normal text-accent underline" onClick={() => { setNameInput(c.name ?? ""); setEditingName(true); }}>Edit</button>
              </p>
            )}
            <p className="text-muted">{c.phone ?? "No phone number shared"}</p>
            {c.username && c.name && <p className="text-xs text-muted">@{c.username}</p>}
            {c.bsuid && <p className="break-all text-[11px] text-muted" title="WhatsApp user id. It stays the same even if the person hides their phone number.">ID {c.bsuid}</p>}
            <div className="mt-1.5">{optStatus}</div>
          </div>
        </section>

        {error && <p role="alert" className="text-xs text-red-700">{error}</p>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Assigned to" htmlFor="panel-assign">
            <Select id="panel-assign" value={conversation.assignedToId ?? ""} onChange={(e) => void act("assign", "PUT", { userId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {assignable.map((m) => (
                <option key={m.userId} value={m.userId}>{m.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Status" htmlFor="panel-status">
            <Select id="panel-status" value={conversation.status === "resolved" ? "solved" : conversation.status} onChange={(e) => void act("status", "PATCH", { status: e.target.value })}>
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="solved">Solved</option>
              {(canBlock || conversation.status === "blocked") && <option value="blocked">Blocked</option>}
            </Select>
          </Field>
          <TeamAssign conversationId={id} teamId={conversationTeamId} assignedToId={conversation.assignedToId} members={members} onChanged={onChanged} />
        </div>

        {ad && (
          <Section title="Came from an ad">
            <div className="rounded-lg border border-border bg-surface p-3 text-xs">
              {ad.headline && <p className="text-sm font-medium">{ad.headline}</p>}
              <dl className="mt-1 space-y-0.5 text-muted">
                {ad.sourceType && <div className="flex gap-2"><dt>Source</dt><dd className="font-medium text-foreground">{ad.sourceType}</dd></div>}
                {ad.sourceId && <div className="flex gap-2"><dt>Ad ID</dt><dd className="break-all font-medium text-foreground">{ad.sourceId}</dd></div>}
              </dl>
              {ad.sourceUrl && <a href={ad.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1 font-semibold text-accent underline"><Icon name="external" className="h-3 w-3" /> Open the ad</a>}
            </div>
          </Section>
        )}

        {lead && (
          <Section title="Lead">
            <div className="space-y-2 rounded-lg border border-border bg-surface p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={lead.status === "won" || lead.status === "qualified" ? "good" : lead.status === "lost" || lead.status === "invalid" ? "bad" : "neutral"}>{statusDisplay(lead.status)}</Badge>
                <span className="text-muted">{lead.formName ? `${lead.formName}, ` : ""}{dateOf(lead.createdAt)}</span>
              </div>
              {lead.fields.length > 0 && (
                <dl className="space-y-0.5">
                  {lead.fields.map((f) => (
                    <div key={f.label} className="flex gap-2"><dt className="shrink-0 capitalize text-muted">{f.label}</dt><dd className="min-w-0 break-words font-medium">{f.value}</dd></div>
                  ))}
                </dl>
              )}
              {lead.consentAt && <p className="text-muted">Consent recorded {dateOf(lead.consentAt)}</p>}
              {leadQuickActions(lead.status).length > 0 && (
                <div className="space-y-1.5 border-t border-border pt-2">
                  <div className="flex flex-wrap gap-2">
                    {leadQuickActions(lead.status).map((a) => (
                      <Button key={a.status} type="button" size="sm" variant="secondary" className="max-sm:min-h-10" loading={leadBusy === a.status} disabled={leadBusy !== null} onClick={() => void markLead(a.status)}>
                        {a.label}
                      </Button>
                    ))}
                  </div>
                  <p className="text-muted">This may report the result back to Meta, which helps your ads find similar people.</p>
                </div>
              )}
              <p role="status" aria-live="polite" className="text-muted">{leadNote}</p>
              <a href="/app/leads" className="inline-block font-semibold text-accent underline">Open in Leads</a>
            </div>
          </Section>
        )}

        <Section title="Tags">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {visibleTags(tags).length === 0 && <span className="text-xs text-muted">No tags yet. Tags help you find and group conversations.</span>}
            {visibleTags(tags).map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs">
                {t}
                <button type="button" aria-label={`Remove tag ${t}`} className="text-muted hover:text-foreground" onClick={() => void saveTags(tags.filter((x) => x !== t))}>
                  <Icon name="close" className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <form onSubmit={addTag} className="flex gap-2">
            <Input aria-label="New tag" placeholder="Add a tag" maxLength={40} value={tagInput} onChange={(e) => setTagInput(e.target.value)} />
            <Button type="submit" variant="secondary" size="sm" disabled={!tagInput.trim()}>Add</Button>
          </form>
        </Section>

        <Section title="Attributes">
          {attrs.length === 0 && <p className="mb-2 text-xs text-muted">No details saved. Add things like city or order number.</p>}
          {/* Each attribute is a div straight under the dl holding only dt and dd; the remove button lives inside the dd so the list stays valid. */}
          <dl className="mb-2 space-y-1">
            {attrs.map((a) => (
              <div key={a.key} className="text-xs">
                <dt className="text-muted">{a.key}</dt>
                <dd className="flex items-start justify-between gap-2">
                  <span className="min-w-0 break-words font-medium">{a.value}</span>
                  <button type="button" aria-label={`Remove ${a.key}`} className="shrink-0 text-muted hover:text-foreground" onClick={() => void removeAttribute(a.key)}><Icon name="close" className="h-3 w-3" /></button>
                </dd>
              </div>
            ))}
          </dl>
          <form onSubmit={setAttribute} className="flex gap-2">
            <Input aria-label="Attribute name" placeholder="Name" maxLength={40} value={attrKey} onChange={(e) => setAttrKey(e.target.value)} />
            <Input aria-label="Attribute value" placeholder="Value" maxLength={200} value={attrValue} onChange={(e) => setAttrValue(e.target.value)} />
            <Button type="submit" variant="secondary" size="sm" disabled={!attrKey.trim() || !attrValue.trim()}>Save</Button>
          </form>
        </Section>

        <Section title="History">
          {!context && !contextError && <Skeleton />}
          {contextError && !context && (
            <p className="text-xs text-red-700" role="alert">{contextError} <button type="button" className="font-semibold underline" onClick={() => void loadContext()}>Try again</button></p>
          )}
          {context && (
            <div className="space-y-2 text-xs">
              <p className="text-muted">First contact {dateOf(context.stats.firstContactAt)}. {context.stats.messages} messages in this chat, {context.stats.received} from the customer.</p>
              {context.otherChats.length > 0 && (
                <ul className="space-y-1">
                  {context.otherChats.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5">
                      <span className="truncate">Also chats on {o.number ?? "another number"}</span>
                      <span className="shrink-0 text-muted">{statusDisplay(o.status)}, {dateOf(o.lastMessageAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Section>

        <Section title="Internal notes">
          <form onSubmit={addNote} className="space-y-2">
            <Textarea aria-label="New internal note" rows={2} placeholder="Only your team sees notes" maxLength={4000} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
            <Button type="submit" variant="secondary" size="sm" disabled={!noteText.trim()}>Add note</Button>
          </form>
          <ul className="mt-3 space-y-2">
            {notes === null && <li><Skeleton /></li>}
            {notes?.length === 0 && <li className="text-xs text-muted">No notes yet</li>}
            {notes?.map((n) => (
              <li key={n.id} className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-2.5 text-amber-950">
                <p className="whitespace-pre-wrap break-words">{n.body}</p>
                <p className="mt-1 text-xs text-amber-800">{author(n.authorId)} · {new Date(n.createdAt).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </aside>
  );
}

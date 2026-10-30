/**
 * Eddy's conversation history (docs/EDDY-SPEC.md 5.8, 5.9). One of the three persistence files Eddy's import boundary
 * allows (4.8): it reads and writes EddyMessage.
 *
 * Append-only. Every request's `messages` is a byte prefix of the next request's (tests/eddy-loop.test.ts case 1):
 * - assistant content is stored and replayed exactly as the API returned it, thinking blocks and their signatures included,
 *   and fallback-model turns as returned, except that after a mid-stream fallback the declined attempt's thinking and
 *   tool_use blocks before the last `fallback` block are left out, as the API's echo rule asks (echoForm). EddyMessage.content
 *   is JSON (not JSONB), so the text keeps its key order;
 * - nothing inside a conversation is trimmed, summarised, edited or deleted; EddyMessage has an UPDATE trigger
 *   (edwyz_append_only) and this file only inserts;
 * - one round's tool results go in a single user message.
 *
 * Tail repair after an abort, a refusal or a failure (repairTail): a system note left last gets the assistant placeholder
 * "(This reply was interrupted.)", and a tool_use without a result gets an is_error result "Stopped before this ran.". So
 * every system note is followed by an assistant turn and every tool_use is paired with its result.
 *
 * Tool calls of one round (runToolBatch): reads run in parallel, at most 4 at a time; writes run one after another in the
 * model's order. Results always come back in the model's order.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { EddyLang } from "./contract";
import type { EddyMessageParam } from "./request";

export type StoredRole = "user" | "assistant" | "system";
export type StoredKind = "user_text" | "context_note" | "assistant" | "tool_results" | "placeholder" | "wrapup_note";

/** What the transcript shows for a stored message (EddyMessage.display). Never needed to replay the conversation. */
export type MessageDisplay = {
  text?: string;
  lang?: EddyLang;
  cardIds?: string[];
  /** The reply was cut short (abort, refusal, failure): the panel shows the catalogue's "This reply was interrupted." */
  interrupted?: true;
  refusal?: true;
};

export type NewEntry = {
  role: StoredRole;
  kind: StoredKind;
  content: unknown;
  display?: MessageDisplay | null;
  contactIds?: string[];
  conversationIds?: string[];
};

export type HistoryEntry = NewEntry & { id: string; seq: number; turnId: string | null; createdAt: Date };

/** The assistant placeholder that closes an interrupted turn (5.8 tail repair, 5.9 refusal). Model-facing, so English. */
export const INTERRUPTED_PLACEHOLDER = "(This reply was interrupted.)";
/** The result of a tool_use that never ran (abort, failure). */
export const STOPPED_TOOL_RESULT = "Stopped before this ran.";
/** The result of a tool_use in a reply that hit max_tokens (5.9). */
export const CUT_OFF_TOOL_RESULT = "Not run: the reply was cut off";

/** At most this many read tools run at once (5.8). */
export const MAX_PARALLEL_READS = 4;

// ===== Pure helpers =====

/** A stored entry as the API takes it. The content object is passed as stored: never rebuilt, so the bytes stay the same. */
export function toParam(entry: Pick<NewEntry, "role" | "content">): EddyMessageParam {
  return { role: entry.role, content: entry.content } as EddyMessageParam;
}

export function toParams(entries: readonly Pick<NewEntry, "role" | "content">[]): EddyMessageParam[] {
  return entries.map(toParam);
}

/** A JSON round trip: what the database will hand back, so in-memory history and stored history are the same bytes. */
export function storedForm<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type Block = { type?: string; id?: string; tool_use_id?: string; text?: string };

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);

type AnyBlock = { type?: unknown; id?: unknown; tool_use_id?: unknown };

/**
 * An assistant message as it may be sent back after a server-side fallback (the API's echo rule): of the blocks before the
 * LAST `fallback` block (the declined attempt), only text blocks, the fallback markers and server-tool calls paired with
 * their results are kept; thinking, redacted_thinking, tool_use and any other model-internal block are left out, so a
 * declined attempt's tool call is never run and never echoed. Everything after the boundary is kept as returned. Content
 * with no fallback block, or with it first (a switch before any output), comes back unchanged. Pure.
 */
export function echoForm<T>(content: T): T {
  if (!Array.isArray(content)) return content;
  const blocks = content as AnyBlock[];
  let boundary = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === "fallback") {
      boundary = i;
      break;
    }
  }
  if (boundary <= 0) return content;
  const before = blocks.slice(0, boundary);
  const serverCalls = new Set(before.filter((b) => b?.type === "server_tool_use" && typeof b.id === "string").map((b) => b.id as string));
  const serverResults = new Set(
    before.filter((b) => typeof b?.type === "string" && (b.type as string).endsWith("_tool_result") && typeof b.tool_use_id === "string").map((b) => b.tool_use_id as string),
  );
  const keep = (b: AnyBlock): boolean => {
    if (b?.type === "text" || b?.type === "fallback") return true;
    if (b?.type === "server_tool_use") return typeof b.id === "string" && serverResults.has(b.id);
    if (typeof b?.type === "string" && b.type !== "tool_result" && b.type.endsWith("_tool_result")) return typeof b.tool_use_id === "string" && serverCalls.has(b.tool_use_id);
    return false;
  };
  return [...before.filter(keep), ...blocks.slice(boundary)] as unknown as T;
}

/** The tool_use ids of an assistant message. */
export function toolUseIds(content: unknown): string[] {
  return blocksOf(content)
    .filter((b) => b?.type === "tool_use" && typeof b.id === "string")
    .map((b) => b.id as string);
}

/** The text of an assistant message (its text blocks joined), for the transcript and the `message` event. */
export function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

export type ToolResult = { toolUseId: string; content: string; isError?: boolean };

/** One user message holding every tool_result of a round, in the model's order. */
export function toolResultsContent(results: readonly ToolResult[]): unknown[] {
  return results.map((r) => ({ type: "tool_result", tool_use_id: r.toolUseId, content: r.content, ...(r.isError ? { is_error: true } : {}) }));
}

/** is_error results for tool_use blocks that did not run. */
export function errorResults(ids: readonly string[], text: string): ToolResult[] {
  return ids.map((toolUseId) => ({ toolUseId, content: text, isError: true }));
}

export function placeholderEntry(display: MessageDisplay = { interrupted: true }): NewEntry {
  return { role: "assistant", kind: "placeholder", content: [{ type: "text", text: INTERRUPTED_PLACEHOLDER }], display };
}

/**
 * What to append so the history ends cleanly (5.8): results for any tool_use left without one, and the placeholder after a
 * system note left last. Pure: the caller appends what it returns.
 */
export function repairTail(entries: readonly Pick<NewEntry, "role" | "kind" | "content">[]): NewEntry[] {
  const out: NewEntry[] = [];
  const last = entries[entries.length - 1];
  if (!last) return out;
  if (last.role === "assistant") {
    const pending = toolUseIds(last.content);
    if (pending.length > 0) out.push({ role: "user", kind: "tool_results", content: toolResultsContent(errorResults(pending, STOPPED_TOOL_RESULT)), display: null });
    return out;
  }
  if (last.role === "system") out.push(placeholderEntry());
  return out;
}

/** Checks the 5.6 placement rules on a history: a note follows a user message and is last or followed by an assistant turn. */
export function placementProblems(messages: readonly { role: string }[]): string[] {
  const problems: string[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "system") return;
    if (i === 0) problems.push("a system note is messages[0]");
    else if (messages[i - 1].role !== "user") problems.push(`system note ${i} follows ${messages[i - 1].role}`);
    const next = messages[i + 1];
    if (next && next.role !== "assistant") problems.push(`system note ${i} is followed by ${next.role}`);
  });
  return problems;
}

/**
 * Runs one round's tool calls: consecutive reads in parallel (at most 4 at a time), writes one after another in the
 * model's order, each write after every call before it has finished. Results come back in the model's order. A call
 * that has started always runs to its end; once `shouldStop()` is true, calls that have not started are skipped (null).
 */
export async function runToolBatch<T>(calls: readonly { isRead: boolean; start: () => Promise<T> }[], o: { maxParallelReads?: number; shouldStop?: () => boolean } = {}): Promise<(T | null)[]> {
  const limit = Math.max(1, o.maxParallelReads ?? MAX_PARALLEL_READS);
  const stop = o.shouldStop ?? (() => false);
  const results: (T | null)[] = calls.map(() => null);
  let i = 0;
  while (i < calls.length) {
    if (stop()) break;
    if (!calls[i].isRead) {
      results[i] = await calls[i].start();
      i++;
      continue;
    }
    // A run of consecutive reads, in windows of at most `limit` running at once.
    let end = i;
    while (end < calls.length && calls[end].isRead) end++;
    let next = i;
    const worker = async () => {
      for (;;) {
        if (stop()) return;
        const at = next++;
        if (at >= end) return;
        results[at] = await calls[at].start();
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, end - i) }, worker));
    i = end;
  }
  return results;
}

// ===== Persistence =====

type Db = typeof prisma;
type Tx = Prisma.TransactionClient;
type Client = Db | Tx;

const asEntry = (row: { id: string; seq: number; role: string; kind: string; content: unknown; display: unknown; turnId: string | null; contactIds?: string[] | null; conversationIds?: string[] | null; createdAt: Date }): HistoryEntry => ({
  id: row.id,
  seq: row.seq,
  role: row.role as StoredRole,
  kind: row.kind as StoredKind,
  content: row.content,
  display: (row.display as MessageDisplay | null) ?? null,
  turnId: row.turnId,
  contactIds: row.contactIds ?? [],
  conversationIds: row.conversationIds ?? [],
  createdAt: row.createdAt,
});

/** The conversation's messages in order. */
export async function loadHistory(conversationId: string, tenantId: string, db: Client = prisma): Promise<HistoryEntry[]> {
  const rows = await db.eddyMessage.findMany({
    where: { conversationId, tenantId },
    orderBy: { seq: "asc" },
    select: { id: true, seq: true, role: true, kind: true, content: true, display: true, turnId: true, contactIds: true, conversationIds: true, createdAt: true },
  });
  return rows.map((r) => asEntry(r as Parameters<typeof asEntry>[0]));
}

/** The ids a stored entry mentions, for contact erasure (EddyMessage.contactIds, conversationIds). */
function idsIn(entry: NewEntry): { contactIds: string[]; conversationIds: string[] } {
  return { contactIds: [...new Set(entry.contactIds ?? [])].slice(0, 200), conversationIds: [...new Set(entry.conversationIds ?? [])].slice(0, 200) };
}

/**
 * Appends entries in one transaction: each gets the conversation's next seq, and nextSeq moves on with a conditional
 * update, so two writers can never interleave inside one conversation.
 */
export async function appendEntries(conversation: { id: string; tenantId: string }, turnId: string | null, entries: readonly NewEntry[], db: Db = prisma, now: Date = new Date()): Promise<void> {
  if (entries.length === 0) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ok = await db.$transaction(async (tx: Tx) => {
      const conv = await tx.eddyConversation.findFirst({ where: { id: conversation.id, tenantId: conversation.tenantId }, select: { nextSeq: true } });
      if (!conv) throw new Error("Eddy conversation not found.");
      const start = conv.nextSeq;
      const moved = await tx.eddyConversation.updateMany({
        where: { id: conversation.id, tenantId: conversation.tenantId, nextSeq: start },
        data: { nextSeq: start + entries.length, lastMessageAt: now },
      });
      if (moved.count !== 1) return false;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        await tx.eddyMessage.create({
          data: {
            conversationId: conversation.id,
            tenantId: conversation.tenantId,
            turnId,
            seq: start + i,
            role: e.role,
            kind: e.kind,
            content: e.content as never,
            ...(e.display ? { display: e.display as never } : {}),
            ...idsIn(e),
          },
        });
      }
      return true;
    });
    if (ok) return;
  }
  throw new Error("Could not append to the Eddy conversation.");
}

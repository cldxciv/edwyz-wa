/**
 * Eddy conversations and turns (docs/EDDY-SPEC.md 5.8, 5.9, 7.5, 7.8, EDDY-10, EDDY-11). One of the three persistence files
 * Eddy's import boundary allows (4.8): it reads and writes EddyConversation and EddyTurn, and reads ActionRecord for the
 * card outcomes of the context note.
 *
 * Lifecycle (5.8): one active conversation per member per workspace (a partial unique index). A new one starts when the
 * role class, the model, TOOLSET_VERSION or the prompt version changes; at 40 turns; when lastInputTokens passes 120,000;
 * after 24 hours idle; when the member taps New chat; after a 400 that names the history; and (critic) when the member's
 * visibilityHash changes. Old conversations stay readable until retention deletes them, but only while their
 * visibilityHash still equals the member's current one, so scroll-back never shows what the member can no longer see.
 *
 * The turn lock (5.9): EddyTurn {status:'running'} with a partial unique index on conversationId. A second turn is refused
 * (409 "Eddy is still answering your last message."). The turn route clears a running turn older than 3 minutes itself,
 * in the same transaction as the new turn, and repairs the tail, so a stopped worker never locks a member out.
 */
import { createHash } from "node:crypto";
import type { Prisma, Role } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { createLimiter } from "@/lib/ratelimit";
import type { CardOutcomeFact } from "./context-note";
import type { EddyLang } from "./contract";
import { appendEntries, loadHistory, repairTail, type HistoryEntry, type MessageDisplay, type NewEntry } from "./history";

export const MAX_TURNS_PER_CONVERSATION = 40;
export const MAX_CONVERSATION_INPUT_TOKENS = 120_000;
export const CONVERSATION_IDLE_MS = 24 * 60 * 60_000;
/** A running turn older than this is cleared by the next turn request (5.9). */
export const STALE_TURN_MS = 3 * 60_000;

export const TURN_IN_PROGRESS_MESSAGE = "Eddy is still answering your last message.";

/** 7.8: 20 turns per member per 10 minutes, 300 per workspace per hour (shared Postgres limiter). */
export const MEMBER_TURNS_PER_10_MIN = 20;
export const TENANT_TURNS_PER_HOUR = 300;

// The names are written out as literals: tests/ratelimit-migration.test.ts reads every createLimiter() call for a stable name.
const memberLimiter = createLimiter(MEMBER_TURNS_PER_10_MIN, 600_000, "eddy-turn-user");
const tenantLimiter = createLimiter(TENANT_TURNS_PER_HOUR, 3_600_000, "eddy-turn-tenant");

export type TurnLimiter = { consumeShared(key: string, now?: number): Promise<boolean> };

/** The two turn limiters of 5.9 step 2. */
export const TURN_LIMITERS: { member: TurnLimiter; tenant: TurnLimiter } = { member: memberLimiter, tenant: tenantLimiter };

/** Clears the in-process limiter windows (tests). */
export async function resetTurnLimiters(): Promise<void> {
  await Promise.all([memberLimiter.clear(), tenantLimiter.clear()]);
}

// ===== Visibility hash (5.8, critic) =====

/** What the member may see right now (teams/visibility.ts viewerRules, plus the role class). */
export type VisibilityFacts = {
  roleClass: "agent" | "admin";
  /** null: no team restriction (team visibility off, or an admin). */
  teamIds: readonly string[] | null;
  includeUnteamed: boolean;
  onlyAssigned: boolean;
  maskPhone: boolean;
};

/** sha256 of the role class, team ids, team visibility, view-only-assigned and masking. */
export function visibilityHashOf(f: VisibilityFacts): string {
  const canonical = JSON.stringify({
    roleClass: f.roleClass,
    teamVisibility: f.teamIds !== null,
    teamIds: f.teamIds === null ? null : [...new Set(f.teamIds)].sort(),
    includeUnteamed: f.includeUnteamed,
    viewOnlyAssigned: f.onlyAssigned,
    maskPhone: f.maskPhone,
  });
  return `vh_${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 40)}`;
}

// ===== Conversations =====

export type ConversationRow = {
  id: string;
  tenantId: string;
  userId: string;
  roleAtStart: Role;
  roleClass: string;
  model: string;
  toolsetVersion: string;
  promptVersion: string;
  visibilityHash: string;
  language: EddyLang;
  title: string | null;
  status: string;
  closedReason: string | null;
  turnCount: number;
  nextSeq: number;
  lastInputTokens: number;
  lastCallAt: Date | null;
  createdAt: Date;
  lastMessageAt: Date;
};

export type RolloverReason = "role_class" | "model" | "toolset" | "prompt" | "visibility" | "turns" | "tokens" | "idle" | "new_chat" | "api_400";

export type ConversationShape = {
  roleClass: "agent" | "admin";
  model: string;
  toolsetVersion: string;
  promptVersion: string;
  visibilityHash: string;
};

/** Why the active conversation can't take another turn (5.8), or null when it can. */
export function rolloverReason(c: Pick<ConversationRow, "roleClass" | "model" | "toolsetVersion" | "promptVersion" | "visibilityHash" | "turnCount" | "lastInputTokens" | "lastMessageAt">, want: ConversationShape, now: Date): RolloverReason | null {
  if (c.roleClass !== want.roleClass) return "role_class";
  if (c.model !== want.model) return "model";
  if (c.toolsetVersion !== want.toolsetVersion) return "toolset";
  if (c.promptVersion !== want.promptVersion) return "prompt";
  if (c.visibilityHash !== want.visibilityHash) return "visibility";
  if (c.turnCount >= MAX_TURNS_PER_CONVERSATION) return "turns";
  if (c.lastInputTokens > MAX_CONVERSATION_INPUT_TOKENS) return "tokens";
  if (now.getTime() - c.lastMessageAt.getTime() >= CONVERSATION_IDLE_MS) return "idle";
  return null;
}

const CONVERSATION_SELECT = {
  id: true,
  tenantId: true,
  userId: true,
  roleAtStart: true,
  roleClass: true,
  model: true,
  toolsetVersion: true,
  promptVersion: true,
  visibilityHash: true,
  language: true,
  title: true,
  status: true,
  closedReason: true,
  turnCount: true,
  nextSeq: true,
  lastInputTokens: true,
  lastCallAt: true,
  createdAt: true,
  lastMessageAt: true,
} as const;

const asConversation = (row: Record<string, unknown>): ConversationRow => row as unknown as ConversationRow;
const isUniqueViolation = (e: unknown) => !!e && typeof e === "object" && (e as { code?: unknown }).code === "P2002";

export type OpenConversationInput = ConversationShape & {
  tenantId: string;
  userId: string;
  role: Role;
  language: EddyLang;
  now: Date;
  /** The member tapped New chat. */
  newChat?: boolean;
};

export async function activeConversation(tenantId: string, userId: string): Promise<ConversationRow | null> {
  const row = await prisma.eddyConversation.findFirst({ where: { tenantId, userId, status: "active" }, select: CONVERSATION_SELECT, orderBy: { createdAt: "desc" } });
  return row ? asConversation(row) : null;
}

export async function closeConversation(c: { id: string; tenantId: string }, reason: string): Promise<void> {
  await prisma.eddyConversation.updateMany({ where: { id: c.id, tenantId: c.tenantId, status: "active" }, data: { status: "closed", closedReason: reason.slice(0, 40) } });
}

async function createConversation(o: OpenConversationInput): Promise<ConversationRow> {
  try {
    const row = await prisma.eddyConversation.create({
      data: {
        tenantId: o.tenantId,
        userId: o.userId,
        roleAtStart: o.role,
        roleClass: o.roleClass,
        model: o.model,
        toolsetVersion: o.toolsetVersion,
        promptVersion: o.promptVersion,
        visibilityHash: o.visibilityHash,
        language: o.language,
        status: "active",
        title: null,
        closedReason: null,
        turnCount: 0,
        nextSeq: 0,
        lastInputTokens: 0,
        lastCallAt: null,
        createdAt: o.now,
        lastMessageAt: o.now,
      },
      select: CONVERSATION_SELECT,
    });
    return asConversation(row);
  } catch (e) {
    // Another request opened one at the same moment (the partial unique index): use it.
    if (isUniqueViolation(e)) {
      const existing = await activeConversation(o.tenantId, o.userId);
      if (existing) return existing;
    }
    throw e;
  }
}

/** The member's active conversation, rolled over first when any 5.8 trigger applies. */
export async function openConversation(o: OpenConversationInput): Promise<{ conversation: ConversationRow; closedReason: RolloverReason | null }> {
  const current = await activeConversation(o.tenantId, o.userId);
  if (current) {
    const reason: RolloverReason | null = o.newChat ? "new_chat" : rolloverReason(current, o, o.now);
    if (!reason) return { conversation: current, closedReason: null };
    await closeConversation(current, reason);
    return { conversation: await createConversation(o), closedReason: reason };
  }
  return { conversation: await createConversation(o), closedReason: null };
}

// ===== Turns =====

export type StartTurnInput = { conversation: ConversationRow; userId: string; model: string; language: EddyLang; now: Date };
export type StartTurnResult = { ok: true; turnId: string; cleared: number } | { ok: false };

/**
 * Takes the turn lock (5.9 step 3). Running turns of this conversation older than 3 minutes are marked aborted and the tail
 * is repaired in the same transaction, so a dead worker never locks the member out; a fresh running turn refuses.
 */
export async function startTurn(o: StartTurnInput): Promise<StartTurnResult> {
  const { conversation: c, now } = o;
  try {
    return await prisma.$transaction(async (tx) => {
      const staleBefore = new Date(now.getTime() - STALE_TURN_MS);
      const cleared = await tx.eddyTurn.updateMany({
        where: { conversationId: c.id, tenantId: c.tenantId, status: "running", startedAt: { lt: staleBefore } },
        data: { status: "aborted", errorCode: "stale", endedAt: now },
      });
      const running = await tx.eddyTurn.findFirst({ where: { conversationId: c.id, tenantId: c.tenantId, status: "running" }, select: { id: true } });
      if (running) return { ok: false } as const;
      if (cleared.count > 0) {
        const fixes = repairTail(await loadHistory(c.id, c.tenantId, tx));
        if (fixes.length > 0) await appendInTx(tx, c, null, fixes, now);
      }
      const turn = await tx.eddyTurn.create({
        data: { conversationId: c.id, tenantId: c.tenantId, userId: o.userId, status: "running", model: o.model, language: o.language, startedAt: now, creditsCharged: 0, rounds: 0, toolCalls: 0, cardsCreated: 0 },
        select: { id: true },
      });
      return { ok: true, turnId: turn.id, cleared: cleared.count } as const;
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false };
    throw e;
  }
}

type Tx = Prisma.TransactionClient;

/** Appends inside a caller's transaction (the stale-turn repair). */
async function appendInTx(tx: Tx, c: { id: string; tenantId: string }, turnId: string | null, entries: readonly NewEntry[], now: Date): Promise<void> {
  const conv = await tx.eddyConversation.findFirst({ where: { id: c.id, tenantId: c.tenantId }, select: { nextSeq: true } });
  if (!conv) return;
  await tx.eddyConversation.updateMany({ where: { id: c.id, tenantId: c.tenantId, nextSeq: conv.nextSeq }, data: { nextSeq: conv.nextSeq + entries.length, lastMessageAt: now } });
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    await tx.eddyMessage.create({
      data: { conversationId: c.id, tenantId: c.tenantId, turnId, seq: conv.nextSeq + i, role: e.role, kind: e.kind, content: e.content as never, ...(e.display ? { display: e.display as never } : {}) },
    });
  }
}

export type TurnFinish = {
  status: "done" | "error" | "aborted" | "refused" | "limit" | "truncated";
  rounds: number;
  toolCalls: number;
  cardsCreated: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  platformMicroUsd: number;
  creditsCharged: number;
  stopReason: string | null;
  refusalCategory: string | null;
  errorCode: string | null;
  requestIds: string[];
  firstTokenMs: number | null;
  durationMs: number;
  endedAt: Date;
};

const int = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

export async function finishTurn(turnId: string, tenantId: string, f: TurnFinish): Promise<void> {
  await prisma.eddyTurn.updateMany({
    where: { id: turnId, tenantId },
    data: {
      status: f.status,
      rounds: int(f.rounds),
      toolCalls: int(f.toolCalls),
      cardsCreated: int(f.cardsCreated),
      inputTokens: int(f.inputTokens),
      cacheWriteTokens: int(f.cacheWriteTokens),
      cacheReadTokens: int(f.cacheReadTokens),
      outputTokens: int(f.outputTokens),
      costMicroUsd: BigInt(int(f.costMicroUsd)),
      platformMicroUsd: BigInt(int(f.platformMicroUsd)),
      creditsCharged: int(f.creditsCharged),
      stopReason: f.stopReason?.slice(0, 40) ?? null,
      refusalCategory: f.refusalCategory?.slice(0, 40) ?? null,
      errorCode: f.errorCode?.slice(0, 40) ?? null,
      requestIds: f.requestIds.slice(0, 16).map((r) => r.slice(0, 80)),
      firstTokenMs: f.firstTokenMs === null ? null : int(f.firstTokenMs),
      durationMs: int(f.durationMs),
      endedAt: f.endedAt,
    },
  });
}

/** Moves a turn to a fresh conversation (the one retry after a 400 that names the history, 5.11). */
export async function moveTurn(turnId: string, tenantId: string, conversationId: string): Promise<void> {
  await prisma.eddyTurn.updateMany({ where: { id: turnId, tenantId }, data: { conversationId } });
}

export type ConversationTouch = { lastInputTokens?: number; lastCallAt?: Date; language?: EddyLang; turnCountDelta?: number; title?: string; now: Date };

/** Updates the conversation after a round or a turn (5.9 step 7). Never touches its messages. */
export async function touchConversation(c: { id: string; tenantId: string; turnCount: number; title: string | null }, t: ConversationTouch): Promise<void> {
  await prisma.eddyConversation.updateMany({
    where: { id: c.id, tenantId: c.tenantId },
    data: {
      ...(t.lastInputTokens !== undefined ? { lastInputTokens: int(t.lastInputTokens) } : {}),
      ...(t.lastCallAt ? { lastCallAt: t.lastCallAt } : {}),
      ...(t.language ? { language: t.language } : {}),
      ...(t.turnCountDelta ? { turnCount: c.turnCount + t.turnCountDelta } : {}),
      ...(t.title && !c.title ? { title: t.title.slice(0, 120) } : {}),
      lastMessageAt: t.now,
    },
  });
}

/** When the conversation's previous turn started (card outcomes since then go into the note). */
export async function previousTurnStart(conversationId: string, tenantId: string, beforeTurnId: string): Promise<Date | null> {
  const rows = await prisma.eddyTurn.findMany({ where: { conversationId, tenantId, NOT: { id: beforeTurnId } }, orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } });
  return rows[0]?.startedAt ?? null;
}

const OUTCOME_OF: Readonly<Record<string, string>> = {
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
  superseded: "superseded",
  undone: "undone",
  unknown: "unknown",
  awaiting_approval: "awaiting_approval",
  refused: "refused",
  running: "running",
};

/**
 * Card decisions in this conversation since `since` (5.6 card_outcomes): ids, action names and states only. An instant write
 * the member undid (Undo on its done row) is an outcome too: the model's history still says it was done.
 */
export async function cardOutcomesSince(o: { tenantId: string; userId: string; conversationId: string; since: Date | null }): Promise<CardOutcomeFact[]> {
  const after = o.since ? { gt: o.since } : { not: null };
  const rows = await prisma.actionRecord.findMany({
    where: { tenantId: o.tenantId, userId: o.userId, conversationId: o.conversationId, OR: [{ risk: "confirm", decidedAt: after }, { undoneAt: after }] },
    orderBy: { decidedAt: "asc" },
    take: 10,
    select: { id: true, action: true, status: true, undoneAt: true },
  });
  return rows.flatMap((r) => {
    const outcome = r.undoneAt ? "undone" : OUTCOME_OF[r.status];
    return outcome ? [{ cardRef: r.id, action: r.action, outcome }] : [];
  });
}

/** Refusals by this member since `since` (5 in an hour pause Eddy for them for an hour, 5.11). */
export async function refusalsSince(tenantId: string, userId: string, since: Date): Promise<number> {
  return prisma.eddyTurn.count({ where: { tenantId, userId, status: "refused", startedAt: { gte: since } } });
}

/** Turns in the workspace since `since` (the optional EddyWorkspaceSetting.dailyTurnCap). */
export async function tenantTurnsSince(tenantId: string, since: Date): Promise<number> {
  return prisma.eddyTurn.count({ where: { tenantId, startedAt: { gte: since } } });
}

/** Credits this member's turns were charged since `since` (the member's daily cap, 5.10). */
export async function memberCreditsSince(tenantId: string, userId: string, since: Date): Promise<number> {
  const rows = await prisma.eddyTurn.findMany({ where: { tenantId, userId, startedAt: { gte: since } }, select: { creditsCharged: true }, take: 2000 });
  return rows.reduce((n, r) => n + (r.creditsCharged ?? 0), 0);
}

/** Credits per member since `since`, for the owner's Eddy settings (admins see usage per member, never per reply). */
export async function creditsByMemberSince(tenantId: string, since: Date): Promise<{ userId: string; credits: number }[]> {
  const rows = await prisma.eddyTurn.findMany({ where: { tenantId, startedAt: { gte: since } }, select: { userId: true, creditsCharged: true }, take: 20_000 });
  const by = new Map<string, number>();
  for (const r of rows) if (r.userId) by.set(r.userId, (by.get(r.userId) ?? 0) + (r.creditsCharged ?? 0));
  return [...by.entries()].map(([userId, credits]) => ({ userId, credits })).sort((a, b) => b.credits - a.credits);
}

// ===== The member's own history (GET and DELETE /api/eddy/conversations) =====

export type ConversationSummaryDTO = {
  id: string;
  title: string | null;
  status: string;
  language: EddyLang;
  turnCount: number;
  createdAt: string;
  lastMessageAt: string;
  active: boolean;
};

export type TranscriptMessageDTO = { id: string; seq: number; role: "user" | "assistant"; kind: string; display: MessageDisplay; createdAt: string };

const summary = (c: ConversationRow): ConversationSummaryDTO => ({
  id: c.id,
  title: c.title,
  status: c.status,
  language: c.language,
  turnCount: c.turnCount,
  createdAt: c.createdAt.toISOString(),
  lastMessageAt: c.lastMessageAt.toISOString(),
  active: c.status === "active",
});

/** The member's own conversations whose visibilityHash still matches (5.8 critic): newest first, at most 50. */
export async function listConversations(tenantId: string, userId: string, visibilityHash: string): Promise<ConversationSummaryDTO[]> {
  const rows = await prisma.eddyConversation.findMany({
    where: { tenantId, userId, visibilityHash, status: { in: ["active", "closed"] } },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
    select: CONVERSATION_SELECT,
  });
  return rows.map((r) => summary(asConversation(r)));
}

/** One own conversation and its transcript (what the member typed and Eddy's replies), or null. */
export async function readConversation(tenantId: string, userId: string, id: string, visibilityHash: string): Promise<{ conversation: ConversationSummaryDTO; messages: TranscriptMessageDTO[] } | null> {
  const row = await prisma.eddyConversation.findFirst({ where: { id, tenantId, userId, visibilityHash, status: { in: ["active", "closed"] } }, select: CONVERSATION_SELECT });
  if (!row) return null;
  const history = await loadHistory(id, tenantId);
  const messages = history.filter(isTranscriptEntry).map(toTranscript);
  return { conversation: summary(asConversation(row)), messages };
}

const isTranscriptEntry = (e: HistoryEntry) => e.kind === "user_text" || e.kind === "assistant" || e.kind === "placeholder";

function toTranscript(e: HistoryEntry): TranscriptMessageDTO {
  return { id: e.id, seq: e.seq, role: e.role === "user" ? "user" : "assistant", kind: e.kind, display: e.display ?? {}, createdAt: e.createdAt.toISOString() };
}

/**
 * Deletes the member's own history at once ("Delete my Eddy history", 7.6): one conversation, or all of them. Messages go
 * with their conversation (ON DELETE CASCADE); EddyTurn keeps its usage row (conversationId set to null by the FK).
 * ActionRecord rows stay for actionRecordDays as the audit trail.
 */
export async function deleteOwnConversations(tenantId: string, userId: string, id?: string): Promise<number> {
  const where = { tenantId, userId, ...(id ? { id } : {}) };
  const ids = (await prisma.eddyConversation.findMany({ where, select: { id: true }, take: 10_000 })).map((r) => r.id);
  if (ids.length === 0) return 0;
  await prisma.eddyMessage.deleteMany({ where: { tenantId, conversationId: { in: ids } } });
  await prisma.eddyTurn.updateMany({ where: { tenantId, conversationId: { in: ids }, status: { not: "running" } }, data: { conversationId: null } });
  const deleted = await prisma.eddyConversation.deleteMany({ where: { tenantId, userId, id: { in: ids } } });
  return deleted.count;
}

// ===== The store the loop uses =====

/** Everything runTurn needs from the database, so the loop itself stays free of Prisma (tests inject their own). */
export interface EddyStore {
  openConversation(o: OpenConversationInput): Promise<{ conversation: ConversationRow; closedReason: RolloverReason | null }>;
  closeConversation(c: { id: string; tenantId: string }, reason: string): Promise<void>;
  startTurn(o: StartTurnInput): Promise<StartTurnResult>;
  moveTurn(turnId: string, tenantId: string, conversationId: string): Promise<void>;
  loadHistory(c: { id: string; tenantId: string }): Promise<HistoryEntry[]>;
  append(c: { id: string; tenantId: string }, turnId: string | null, entries: readonly NewEntry[], now: Date): Promise<void>;
  finishTurn(turnId: string, tenantId: string, f: TurnFinish): Promise<void>;
  touchConversation(c: { id: string; tenantId: string; turnCount: number; title: string | null }, t: ConversationTouch): Promise<void>;
  previousTurnStart(c: { id: string; tenantId: string }, beforeTurnId: string): Promise<Date | null>;
  cardOutcomesSince(o: { tenantId: string; userId: string; conversationId: string; since: Date | null }): Promise<CardOutcomeFact[]>;
  refusalsSince(tenantId: string, userId: string, since: Date): Promise<number>;
  tenantTurnsSince(tenantId: string, since: Date): Promise<number>;
}

export const PRISMA_EDDY_STORE: EddyStore = {
  openConversation,
  closeConversation,
  startTurn,
  moveTurn,
  loadHistory: (c) => loadHistory(c.id, c.tenantId),
  append: (c, turnId, entries, now) => appendEntries(c, turnId, entries, prisma, now),
  finishTurn,
  touchConversation,
  previousTurnStart: (c, before) => previousTurnStart(c.id, c.tenantId, before),
  cardOutcomesSince,
  refusalsSince,
  tenantTurnsSince,
};

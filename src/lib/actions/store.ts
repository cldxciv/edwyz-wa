/**
 * ActionRecord and ActionInvocation persistence (docs/EDDY-SPEC.md 4.3 G14/G15/G17, 4.5, 8.1, 8.4).
 * - ActionRecord holds cards (pending -> running -> done | failed | unknown, or cancelled / expired / superseded) and
 *   undoable writes (inserted as done with undo and undoUntil; done -> undone).
 * - The confirm claim is one conditional UPDATE (id, tenant, user, pending, not expired, nonceHash, previewHash), so two
 *   concurrent confirms with the same nonce run the action exactly once.
 * - Limits: at most 3 new cards per turn and 5 pending per member; a new card for the same action and target supersedes the
 *   older one.
 * - ActionInvocation is append-only: one row per call for its final stage, two for an execute (started, then the outcome).
 * Only invoke.ts writes through this module. argsRedacted keeps ids, enums and lengths, never message bodies (7.5).
 */
import { randomBytes } from "node:crypto";
import type { ActionInvocation, ActionRecord } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { MAX_NEW_CARDS_PER_TURN, MAX_PENDING_CARDS_PER_MEMBER } from "@/lib/eddy/contract";
import type { JsonSchema } from "./schema";
import type { ActionStatus, InvocationOutcome, InvocationStage, Preview, Risk, Surface } from "./types";

export { MAX_NEW_CARDS_PER_TURN, MAX_PENDING_CARDS_PER_MEMBER };
export type { ActionInvocation, ActionRecord };

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
export const newActionId = () => `ar_${hex(12)}`;
export const newInvocationId = () => `ai_${hex(12)}`;
export const newOpId = () => `op_${hex(12)}`;

/** Prisma JSON input: a plain JSON value (Date and bigint already converted). */
type JsonInput = NonNullable<Parameters<typeof prisma.actionRecord.create>[0]["data"]["args"]>;
/** Plain JSON for a JSONB column: bigints (money in minor units) become decimal strings, Dates ISO strings. */
const json = (value: unknown) => JSON.parse(JSON.stringify(value ?? null, (_key, v) => (typeof v === "bigint" ? v.toString() : v))) as JsonInput;

export type NewActionRecord = {
  id: string;
  tenantId: string;
  userId: string;
  via: Surface;
  principalId: string;
  conversationId?: string | null;
  turnId?: string | null;
  toolUseId?: string | null;
  action: string;
  risk: Risk;
  status: ActionStatus;
  args: unknown;
  argsHash: string;
  preview?: Preview | null;
  previewHash?: string | null;
  nonceHash?: string | null;
  expiresAt?: Date | null;
  decidedAt?: Date | null;
  result?: unknown;
  error?: string | null;
  undo?: unknown;
  undoUntil?: Date | null;
  spendPot?: "messaging" | "ads" | "ai" | null;
  spendCorrelationId?: string | null;
  supersededById?: string | null;
  contactIds?: string[];
};

export async function insertActionRecord(row: NewActionRecord): Promise<ActionRecord> {
  return prisma.actionRecord.create({
    data: {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      via: row.via,
      principalId: row.principalId,
      conversationId: row.conversationId ?? null,
      turnId: row.turnId ?? null,
      toolUseId: row.toolUseId ?? null,
      action: row.action,
      risk: row.risk,
      status: row.status,
      args: json(row.args),
      argsHash: row.argsHash,
      ...(row.preview ? { preview: json(row.preview) } : {}),
      previewHash: row.previewHash ?? null,
      nonceHash: row.nonceHash ?? null,
      expiresAt: row.expiresAt ?? null,
      decidedAt: row.decidedAt ?? null,
      ...(row.result !== undefined ? { result: json(row.result) } : {}),
      error: row.error ?? null,
      ...(row.undo !== undefined && row.undo !== null ? { undo: json(row.undo) } : {}),
      undoUntil: row.undoUntil ?? null,
      spendPot: row.spendPot ?? null,
      spendCorrelationId: row.spendCorrelationId ?? null,
      supersededById: row.supersededById ?? null,
      contactIds: [...new Set(row.contactIds ?? [])].slice(0, 200),
    },
  });
}

export async function findActionRecord(tenantId: string, id: string): Promise<ActionRecord | null> {
  if (typeof id !== "string" || !id || id.length > 64) return null;
  return prisma.actionRecord.findFirst({ where: { id, tenantId } });
}

export type ClaimInput = { id: string; tenantId: string; userId: string; nonceHash: string; previewHash: string; now: Date };

/**
 * The confirm claim of 4.5: pending -> running in one conditional UPDATE. Returns the claimed row, or null when nothing
 * matched (wrong id, tenant, user, nonce or previewHash, expired, or already decided).
 */
export async function claimPending(c: ClaimInput): Promise<ActionRecord | null> {
  const { count } = await prisma.actionRecord.updateMany({
    where: { id: c.id, tenantId: c.tenantId, userId: c.userId, status: "pending", expiresAt: { gt: c.now }, nonceHash: c.nonceHash, previewHash: c.previewHash },
    data: { status: "running", decidedAt: c.now, updatedAt: c.now },
  });
  if (count !== 1) return null;
  return prisma.actionRecord.findFirst({ where: { id: c.id, tenantId: c.tenantId } });
}

/** The same claim as raw SQL (4.5), for the database test and any caller that needs RETURNING in one round trip. */
export const CLAIM_SQL = `UPDATE "ActionRecord" SET "status"='running', "decidedAt"=now(), "updatedAt"=now()
WHERE "id"=$1 AND "tenantId"=$2 AND "userId"=$3 AND "status"='pending'
  AND "expiresAt">now() AND "nonceHash"=$4 AND "previewHash"=$5
RETURNING *`;

export type MissReason = "not_found" | "expired" | "decided";

/**
 * Why a card action matched nothing: not found (or the nonce, user, tenant or previewHash is wrong: all 404, so nothing
 * leaks), expired (410; a pending row past its time is marked expired on the way), or already decided.
 */
export async function explainMiss(c: { id: string; tenantId: string; userId: string; nonceHash: string | null; previewHash?: string | null; now: Date }): Promise<{ reason: MissReason; row: ActionRecord | null }> {
  const row = await findActionRecord(c.tenantId, c.id);
  if (!row || row.userId !== c.userId) return { reason: "not_found", row: null };
  if (c.nonceHash !== null && row.nonceHash !== c.nonceHash) return { reason: "not_found", row: null };
  if (c.previewHash && row.previewHash !== c.previewHash) return { reason: "not_found", row: null };
  if (row.status === "expired") return { reason: "expired", row };
  if (row.status === "pending" && row.expiresAt && row.expiresAt.getTime() <= c.now.getTime()) {
    await transition(row.tenantId, row.id, ["pending"], { status: "expired" }, c.now);
    return { reason: "expired", row: { ...row, status: "expired" } };
  }
  if (row.status === "pending") return { reason: "not_found", row: null };
  return { reason: "decided", row };
}

export type RecordPatch = {
  status?: ActionStatus;
  result?: unknown;
  error?: string | null;
  undo?: unknown;
  undoUntil?: Date | null;
  undoneAt?: Date | null;
  decidedAt?: Date | null;
  supersededById?: string | null;
  spendCorrelationId?: string | null;
  /** The record's full list of contacts it mentions (what it ran on and what its result named), for erasure. */
  contactIds?: string[];
};

/** Moves a record from one of `from` to the patch, atomically. Returns how many rows changed (0 or 1). */
export async function transition(tenantId: string, id: string, from: readonly ActionStatus[], patch: RecordPatch, now: Date = new Date(), extraWhere: Record<string, unknown> = {}): Promise<number> {
  const data: Record<string, unknown> = { updatedAt: now };
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.result !== undefined) data.result = json(patch.result);
  if (patch.error !== undefined) data.error = patch.error;
  if (patch.undo !== undefined) data.undo = patch.undo === null ? undefined : json(patch.undo);
  if (patch.undoUntil !== undefined) data.undoUntil = patch.undoUntil;
  if (patch.undoneAt !== undefined) data.undoneAt = patch.undoneAt;
  if (patch.decidedAt !== undefined) data.decidedAt = patch.decidedAt;
  if (patch.supersededById !== undefined) data.supersededById = patch.supersededById;
  if (patch.spendCorrelationId !== undefined) data.spendCorrelationId = patch.spendCorrelationId;
  if (patch.contactIds !== undefined) data.contactIds = [...new Set(patch.contactIds)].slice(0, 200);
  for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
  const { count } = await prisma.actionRecord.updateMany({ where: { id, tenantId, status: { in: [...from] }, ...extraWhere }, data });
  return count;
}

/** The target a card is about, for "a new card for the same action and target supersedes the old one" (4.5). */
export function cardTarget(preview: unknown, argsHashValue: string): string {
  const material = (preview as { material?: Record<string, unknown> } | null)?.material ?? {};
  const target = material.targetId ?? material.target;
  return typeof target === "string" || typeof target === "number" ? `t:${target}` : `a:${argsHashValue}`;
}

export type CardSlots = { ok: true; supersede: string[] } | { ok: false; code: "turn_budget" | "too_many_pending" };

/** G14 limits for a new card: 3 per turn, 5 pending per member (a card it supersedes does not count). */
export async function reserveCardSlot(c: { tenantId: string; userId: string; turnId?: string | null; action: string; target: string; now: Date }): Promise<CardSlots> {
  if (c.turnId) {
    const inTurn = await prisma.actionRecord.count({ where: { tenantId: c.tenantId, turnId: c.turnId, risk: "confirm", status: { notIn: ["refused"] } } });
    if (inTurn >= MAX_NEW_CARDS_PER_TURN) return { ok: false, code: "turn_budget" };
  }
  const pending = await prisma.actionRecord.findMany({
    where: { tenantId: c.tenantId, userId: c.userId, status: "pending", expiresAt: { gt: c.now } },
    select: { id: true, action: true, preview: true, argsHash: true },
    take: 50,
  });
  const supersede = pending.filter((r) => r.action === c.action && cardTarget(r.preview, r.argsHash) === c.target).map((r) => r.id);
  if (pending.length - supersede.length >= MAX_PENDING_CARDS_PER_MEMBER) return { ok: false, code: "too_many_pending" };
  return { ok: true, supersede };
}

/** Marks older cards for the same action and target superseded by the new one. */
export async function supersedeCards(tenantId: string, ids: readonly string[], byId: string, now: Date): Promise<void> {
  for (const id of ids) if (id !== byId) await transition(tenantId, id, ["pending"], { status: "superseded", supersededById: byId, decidedAt: now }, now);
}

/** The member's newest action in this conversation that can still be undone (undo_last_action). */
export async function latestUndoable(c: { tenantId: string; userId: string; conversationId: string; now: Date }): Promise<ActionRecord | null> {
  return prisma.actionRecord.findFirst({
    where: { tenantId: c.tenantId, userId: c.userId, conversationId: c.conversationId, status: "done", undoneAt: null, undoUntil: { gt: c.now } },
    orderBy: { createdAt: "desc" },
  });
}

// ===== ActionInvocation =====

export type InvocationRow = {
  tenantId: string;
  userId: string | null;
  via: Surface | "undo";
  principalId: string;
  opId: string;
  action: string;
  risk: Risk;
  stage: InvocationStage;
  outcome: InvocationOutcome;
  code?: string | null;
  argsHash: string;
  argsRedacted?: Record<string, unknown>;
  resultRef?: string | null;
  conversationId?: string | null;
  turnId?: string | null;
  actionRecordId?: string | null;
  spendCorrelationId?: string | null;
  piiItems?: number | null;
  durationMs?: number | null;
};

const safeAction = (name: string) => (typeof name === "string" ? name.replace(/[^\w.:-]/g, "_").slice(0, 64) || "unknown" : "unknown");

function invocationData(row: InvocationRow) {
  return {
    id: newInvocationId(),
    tenantId: row.tenantId,
    userId: row.userId,
    via: row.via,
    principalId: row.principalId,
    opId: row.opId,
    action: safeAction(row.action),
    risk: row.risk,
    stage: row.stage,
    outcome: row.outcome,
    code: row.code ?? null,
    argsHash: row.argsHash,
    argsRedacted: json(row.argsRedacted ?? {}),
    resultRef: row.resultRef ?? null,
    conversationId: row.conversationId ?? null,
    turnId: row.turnId ?? null,
    actionRecordId: row.actionRecordId ?? null,
    spendCorrelationId: row.spendCorrelationId ?? null,
    piiItems: row.piiItems ?? null,
    durationMs: row.durationMs ?? null,
  };
}

/** The `started` row of an execute (G17). Throws when it cannot be written, so nothing runs without its record. */
export async function writeInvocationStrict(row: InvocationRow): Promise<void> {
  await prisma.actionInvocation.create({ data: invocationData(row) });
}

/** Every other row: retried once, then logged. The action has already been decided by then. */
export async function writeInvocation(row: InvocationRow): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await prisma.actionInvocation.create({ data: invocationData(row) });
      return;
    } catch {
      // retry once below
    }
  }
  console.error("[actions] could not write the invocation record", safeAction(row.action), row.stage, row.outcome);
}

// ===== Redaction (7.5) =====

const ID_KEY = /(^id$|Id$|Ids$|^ids$)/;
const ID_VALUE = /^[A-Za-z0-9_:-]{1,64}$/;

/** Keeps ids, enums, numbers and booleans; replaces any other text with its length. Never stores a message body. */
export function redactArgs(args: unknown, schema?: JsonSchema, key = ""): unknown {
  if (args === null || args === undefined) return null;
  if (typeof args === "number" || typeof args === "boolean") return args;
  if (typeof args === "string") {
    if (schema?.enum?.includes(args)) return args;
    if (ID_KEY.test(key) && ID_VALUE.test(args)) return args;
    return { len: [...args].length };
  }
  if (Array.isArray(args)) return args.slice(0, 50).map((item) => redactArgs(item, schema?.items, key));
  if (typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (schema?.type === "object" && schema.properties && !(k in schema.properties)) continue;
      out[k] = redactArgs(v, schema?.properties?.[k], k);
    }
    return out;
  }
  return null;
}

export { subjectIdsIn, type SubjectIds } from "./subjects";

/** Contact ids a call mentions, for erasure (ActionRecord.contactIds). */
export function contactIdsIn(args: unknown, extra: readonly string[] = []): string[] {
  const out = new Set(extra);
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.contactId === "string") out.add(a.contactId);
  if (Array.isArray(a.contactIds)) for (const id of a.contactIds) if (typeof id === "string") out.add(id);
  return [...out].filter((id) => ID_VALUE.test(id)).slice(0, 200);
}

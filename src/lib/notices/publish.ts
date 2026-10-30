/**
 * publishNotice(): the product's in-app notification store (docs/EDDY-SPEC.md 6.7, EDDY-16, request E6).
 *
 * This is Phase 0's "in-app, always" channel, offered under request E6: src/lib/spend/notify/index.ts (deliverInApp) may
 * call publishNotice({ ..., source: 'spend' }) instead of writing Notice rows itself, and gets the same guarantees as Eddy's
 * producers. Until it does, Eddy's producers read Phase 0's tables read-only, and rows Phase 0 wrote keep their own source:
 * publishNotice never edits a row written by another source (it answers `foreign`).
 *
 * The guarantees:
 * - One notice per (tenantId, dedupeKey) (6.7 coalescing; the unique index Notice_tenantId_dedupeKey_key). Publishing the
 *   same key again updates the count, payload, severity and buttons IN PLACE; nothing changes (no write, no new
 *   `updatedAt`) when they are the same, so a 2-minute scan never makes an old notice look new.
 * - A notice resolves itself when its condition clears (resolveNotices) and expires 7 days after it starts. Publishing a
 *   key whose notice resolved or expired starts it again as a new occurrence: new dates, and every member's receipts
 *   (seen, dismissed, toast) cleared, so it can be noticed again.
 * - The payload holds ids, counts and codes only, and the buttons only navigate to /app paths, open Eddy by id or ask for a
 *   fresh card (kinds.ts cleanPayload, cleanActions). Anything else is dropped before the write, never stored.
 * - Audience: a role floor for workspace notices (audienceMinRole) or one member (audienceUserId). The service applies it,
 *   plus each member's mutes and dismissals.
 * Never throws for a notice that cannot be stored: it logs ids only and answers `failed`, so the caller's own work stands.
 */
import { prisma } from "@/lib/db";
import type { Role } from "@/generated/prisma/client";
import type { NoticeAction, NoticeSeverity, NoticeSource } from "@/lib/eddy/contract";
import { describeError } from "@/lib/safe-error";
import { DEDUPE_KEY, NOTICE_TTL_MS, cleanActions, cleanPayload, isSeverity, type NoticePayload } from "./kinds";

export type NoticeAudience = { minRole?: Role; userId?: string | null };

export type PublishInput = {
  tenantId: string;
  kind: string;
  severity: NoticeSeverity;
  dedupeKey: string;
  audience?: NoticeAudience;
  subjectType?: string | null;
  subjectId?: string | null;
  /** Ids, counts and codes only. */
  payload?: Record<string, unknown>;
  actions?: readonly NoticeAction[];
  count?: number;
  source?: NoticeSource;
  /** Default 7 days. */
  ttlMs?: number;
};

export type PublishOutcome = "created" | "updated" | "unchanged" | "reopened" | "foreign" | "failed";
export type PublishResult = { id: string | null; outcome: PublishOutcome };

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Delegate = {
  findFirst(args: { where: Where; select?: Record<string, boolean> }): Promise<Row | null>;
  create(args: { data: Row; select?: Record<string, boolean> }): Promise<Row>;
  updateMany(args: { where: Where; data: Row }): Promise<{ count: number }>;
  deleteMany(args: { where: Where }): Promise<{ count: number }>;
};
/** The two tables the store writes. The app client by default; a transaction client works too. */
export type NoticeDb = { notice: Delegate; noticeReceipt: Pick<Delegate, "deleteMany"> };

const dbOf = (db?: NoticeDb): NoticeDb => db ?? (prisma as unknown as NoticeDb);

const KIND = /^[a-z][a-z0-9_]{1,40}$/;
const SUBJECT_TYPE = /^[a-z][a-z_]{0,30}$/;
const SUBJECT_ID = /^[A-Za-z0-9_.:\-]{1,128}$/;

const json = (v: unknown) => JSON.stringify(v ?? null);

function invalid(input: PublishInput): string | null {
  if (!input.tenantId || typeof input.tenantId !== "string" || input.tenantId.length > 64) return "tenant";
  if (!KIND.test(input.kind)) return "kind";
  if (!isSeverity(input.severity)) return "severity";
  if (!DEDUPE_KEY.test(input.dedupeKey)) return "dedupe_key";
  if (input.subjectType != null && !SUBJECT_TYPE.test(input.subjectType)) return "subject_type";
  if (input.subjectId != null && !SUBJECT_ID.test(input.subjectId)) return "subject_id";
  return null;
}

const isUniqueViolation = (e: unknown) => (e as { code?: unknown })?.code === "P2002";

/** Creates or updates the one notice for (tenantId, dedupeKey). See the module comment. Never throws. */
export async function publishNotice(input: PublishInput, opts: { db?: NoticeDb; now?: Date } = {}): Promise<PublishResult> {
  const problem = invalid(input);
  if (problem) {
    // Only the reason and a kind that passed its own check are logged: never a raw string a caller handed in.
    console.warn(`[notices] notice refused (${problem})${problem === "kind" ? "" : `: ${input.kind}`}`);
    return { id: null, outcome: "failed" };
  }
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  const source: NoticeSource = input.source ?? "eddy";
  const payload: NoticePayload = cleanPayload(input.payload ?? {});
  const actions = cleanActions(input.actions ?? []);
  const count = Number.isInteger(input.count) && (input.count as number) >= 0 ? (input.count as number) : 1;
  const fields = {
    kind: input.kind,
    severity: input.severity,
    audienceUserId: input.audience?.userId ?? null,
    audienceMinRole: input.audience?.minRole ?? "agent",
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    payload,
    actions,
    count,
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await db.notice.findFirst({ where: { tenantId: input.tenantId, dedupeKey: input.dedupeKey } });
      if (existing) return await updateExisting(db, existing, fields, source, now, input.ttlMs ?? NOTICE_TTL_MS);
      try {
        const row = await db.notice.create({
          data: { tenantId: input.tenantId, dedupeKey: input.dedupeKey, source, ...fields, createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + (input.ttlMs ?? NOTICE_TTL_MS)), resolvedAt: null },
          select: { id: true },
        });
        return { id: String(row.id), outcome: "created" };
      } catch (e) {
        // A concurrent scan created it first: that is the same notice, so update it instead.
        if (!isUniqueViolation(e) || attempt > 0) throw e;
      }
    }
    return { id: null, outcome: "failed" };
  } catch (error) {
    console.error(`[notices] ${input.kind} not stored: ${describeError(error)}`);
    return { id: null, outcome: "failed" };
  }
}

type Fields = { kind: string; severity: string; audienceUserId: string | null; audienceMinRole: string; subjectType: string | null; subjectId: string | null; payload: NoticePayload; actions: NoticeAction[]; count: number };

async function updateExisting(db: NoticeDb, existing: Row, fields: Fields, source: NoticeSource, now: Date, ttlMs: number): Promise<PublishResult> {
  const id = String(existing.id);
  const tenantId = String(existing.tenantId);
  if (existing.source !== source) return { id, outcome: "foreign" };
  const resolved = existing.resolvedAt instanceof Date;
  const expired = existing.expiresAt instanceof Date && existing.expiresAt.getTime() <= now.getTime();
  if (resolved || expired) {
    // A new occurrence of a condition that had cleared: new dates, and every receipt goes so it can be seen again.
    await db.notice.updateMany({ where: { id, tenantId }, data: { ...fields, createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + ttlMs), resolvedAt: null } });
    await db.noticeReceipt.deleteMany({ where: { noticeId: id, tenantId } });
    return { id, outcome: "reopened" };
  }
  const same =
    existing.count === fields.count &&
    existing.severity === fields.severity &&
    json(existing.payload) === json(fields.payload) &&
    json(existing.actions) === json(fields.actions) &&
    (existing.audienceUserId ?? null) === fields.audienceUserId &&
    existing.audienceMinRole === fields.audienceMinRole;
  if (same) return { id, outcome: "unchanged" };
  // Counts update in place; the notice keeps its start and its expiry (7 days after it started).
  await db.notice.updateMany({ where: { id, tenantId, resolvedAt: null }, data: { ...fields, updatedAt: now } });
  return { id, outcome: "updated" };
}

export type ResolveFilter = {
  /** Only notices of these kinds. */
  kinds?: readonly string[];
  /** Only these dedupe keys. */
  keys?: readonly string[];
  /** Only dedupe keys starting with this. */
  prefix?: string;
  /** Keep these dedupe keys open (the conditions that still hold). */
  except?: readonly string[];
};

/**
 * Marks open notices resolved: their condition cleared (6.7). A producer passes the kinds it owns and the keys whose
 * condition it still sees, and every other open notice of those kinds resolves. Never throws; answers how many resolved.
 */
export async function resolveNotices(tenantId: string, filter: ResolveFilter, opts: { db?: NoticeDb; now?: Date } = {}): Promise<number> {
  if (!filter.kinds?.length && !filter.keys?.length && !filter.prefix) return 0;
  const db = dbOf(opts.db);
  const now = opts.now ?? new Date();
  const and: Where[] = [];
  if (filter.kinds?.length) and.push({ kind: { in: [...filter.kinds] } });
  if (filter.keys?.length) and.push({ dedupeKey: { in: [...filter.keys] } });
  if (filter.prefix) and.push({ dedupeKey: { startsWith: filter.prefix } });
  if (filter.except?.length) and.push({ dedupeKey: { notIn: [...filter.except] } });
  try {
    const { count } = await db.notice.updateMany({ where: { tenantId, resolvedAt: null, AND: and }, data: { resolvedAt: now, updatedAt: now } });
    return count;
  } catch (error) {
    console.error(`[notices] resolve failed: ${describeError(error)}`);
    return 0;
  }
}

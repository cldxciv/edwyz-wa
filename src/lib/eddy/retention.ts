/**
 * Eddy's retention (docs/EDDY-SPEC.md 7.6, 8.3, EDDY-16 acceptance 7 and 8): the daily `eddy.retention` task.
 *
 * Applies the retention keys of src/lib/lifecycle/personal-data.ts, as the platform admin configured them (getRetentionConfig),
 * with the lifecycle batch helpers (deleteBatched), so lifecycle/retention.ts itself is not edited:
 * - EddyConversation and EddyMessage: `eddyHistoryDays` (default 90) after the conversation's last message;
 * - ActionRecord: `actionRecordDays` (90) after it was decided, or expired when it never was;
 * - ActionInvocation: `actionInvocationDays` (400) after it was written (append-only rows: deletes only);
 * - EddyTurn: the UsageLedger key, `usageLedgerDays` (400), never a running turn;
 * - Notice (and its NoticeReceipt rows): `noticeDays` (30) after it resolved or expired.
 * It also deletes conversations whose `visibilityHash` no longer matches their member's current one (5.8 critic): after a
 * demotion, a team change or phone masking, a transcript may hold what the member can no longer see. The member's current
 * hash comes from the caller (src/worker/eddy.ts), which reads teams/visibility.ts; a member who left is skipped here and
 * handled by the erasure sweep.
 *
 * This file reaches the database only through src/lib/lifecycle (the retention and erasure helpers), never @/lib/db
 * directly (tests/actions-import-boundary.test.ts allows that only to Eddy's three persistence files).
 */
import { BATCH, deleteBatched, delegateFor } from "@/lib/lifecycle/batch";
import { getRetentionConfig, type RetentionConfig } from "@/lib/lifecycle/retention";

const DAY_MS = 24 * 60 * 60_000;

type Where = Record<string, unknown>;
type Row = Record<string, unknown>;

/** The Prisma operations Eddy's retention and erasure use, on one model (the app client or a transaction client). */
export type EddyTable = {
  findMany(args: { where?: Where; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc">; take?: number; distinct?: string[] }): Promise<Row[]>;
  deleteMany(args: { where: Where }): Promise<{ count: number }>;
  updateMany(args: { where: Where; data: Row }): Promise<{ count: number }>;
};

export const EDDY_MODELS = {
  eddyConversation: "EddyConversation",
  eddyMessage: "EddyMessage",
  eddyTurn: "EddyTurn",
  eddyUserPref: "EddyUserPref",
  actionRecord: "ActionRecord",
  actionInvocation: "ActionInvocation",
  notice: "Notice",
  noticeReceipt: "NoticeReceipt",
  membership: "Membership",
  contact: "Contact",
  conversation: "Conversation",
} as const;

export type EddyTables = { [K in keyof typeof EDDY_MODELS]: EddyTable };

/** The app client's delegates, looked up when used (so a test's mocked client is the one used). */
export function eddyTables(): EddyTables {
  const out = {} as EddyTables;
  for (const [key, model] of Object.entries(EDDY_MODELS) as [keyof EddyTables, string][]) {
    Object.defineProperty(out, key, { get: () => delegateFor(model) as unknown as EddyTable, enumerable: true });
  }
  return out;
}

export type VisibilityHashFor = (tenantId: string, userId: string) => Promise<string | null>;

export type EddyRetentionOptions = {
  now?: Date;
  config?: RetentionConfig;
  /** The member's current visibility hash, or null when they are no longer a member (left to the erasure sweep). */
  visibilityHashFor?: VisibilityHashFor;
  db?: EddyTables;
};

/** Deletes a set of conversations: their messages first, then the rows. Usage rows (EddyTurn) keep, unlinked by the FK. */
export async function deleteConversations(db: EddyTables, ids: readonly string[], extra: Where = {}): Promise<number> {
  if (ids.length === 0) return 0;
  await db.eddyMessage.deleteMany({ where: { conversationId: { in: [...ids] } } });
  return (await db.eddyConversation.deleteMany({ where: { id: { in: [...ids] }, ...extra } })).count;
}

/** Conversations whose last message is older than the cutoff, a page at a time. */
async function purgeOldConversations(db: EddyTables, cutoff: Date): Promise<number> {
  let total = 0;
  for (let page = 0; page < 50; page++) {
    const rows = await db.eddyConversation.findMany({ where: { lastMessageAt: { lt: cutoff } }, select: { id: true }, take: BATCH });
    if (rows.length === 0) break;
    const deleted = await deleteConversations(db, rows.map((r) => String(r.id)), { lastMessageAt: { lt: cutoff } });
    total += deleted;
    if (rows.length < BATCH || deleted === 0) break;
  }
  return total;
}

/** Notices that resolved or expired before the cutoff, with their receipts. */
async function purgeOldNotices(db: EddyTables, cutoff: Date): Promise<number> {
  const where = { OR: [{ resolvedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }] };
  let total = 0;
  for (let page = 0; page < 50; page++) {
    const rows = await db.notice.findMany({ where, select: { id: true }, take: BATCH });
    if (rows.length === 0) break;
    const ids = rows.map((r) => String(r.id));
    await db.noticeReceipt.deleteMany({ where: { noticeId: { in: ids } } });
    const { count } = await db.notice.deleteMany({ where: { AND: [where, { id: { in: ids } }] } });
    total += count;
    if (rows.length < BATCH || count === 0) break;
  }
  return total;
}

/** Conversations whose visibilityHash no longer matches their member's, skipping any with a turn still running. */
export async function purgeMismatchedVisibility(db: EddyTables, hashFor: VisibilityHashFor): Promise<number> {
  let total = 0;
  let after = "";
  const current = new Map<string, Promise<string | null>>();
  for (let page = 0; page < 50; page++) {
    const rows = await db.eddyConversation.findMany({
      where: { status: { in: ["active", "closed"] }, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, tenantId: true, userId: true, visibilityHash: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (rows.length === 0) break;
    after = String(rows[rows.length - 1].id);
    const stale: string[] = [];
    for (const r of rows) {
      const member = `${r.tenantId}:${r.userId}`;
      if (!current.has(member)) current.set(member, hashFor(String(r.tenantId), String(r.userId)).catch(() => null));
      const hash = await current.get(member);
      if (hash !== null && hash !== undefined && hash !== r.visibilityHash) stale.push(String(r.id));
    }
    if (stale.length) {
      const running = new Set((await db.eddyTurn.findMany({ where: { conversationId: { in: stale }, status: "running" }, select: { conversationId: true } })).map((t) => String(t.conversationId)));
      total += await deleteConversations(
        db,
        stale.filter((id) => !running.has(id)),
      );
    }
    if (rows.length < BATCH) break;
  }
  return total;
}

/** The `eddy.retention` task. Returns how many rows each rule deleted. */
export async function runEddyRetention(opts: EddyRetentionOptions = {}): Promise<Record<string, number>> {
  const now = opts.now ?? new Date();
  const cfg = opts.config ?? (await getRetentionConfig());
  const db = opts.db ?? eddyTables();
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const records = ago(cfg.actionRecordDays);
  const out: Record<string, number> = {
    eddyConversations: await purgeOldConversations(db, ago(cfg.eddyHistoryDays)),
    actionRecords: await deleteBatched("ActionRecord", {
      status: { notIn: ["pending", "running"] },
      OR: [{ decidedAt: { lt: records } }, { decidedAt: null, expiresAt: { lt: records } }, { decidedAt: null, expiresAt: null, createdAt: { lt: records } }],
    }),
    actionInvocations: await deleteBatched("ActionInvocation", { createdAt: { lt: ago(cfg.actionInvocationDays) } }),
    eddyTurns: await deleteBatched("EddyTurn", { startedAt: { lt: ago(cfg.usageLedgerDays) }, status: { not: "running" } }),
    notices: await purgeOldNotices(db, ago(cfg.noticeDays)),
  };
  out.mismatchedVisibility = opts.visibilityHashFor ? await purgeMismatchedVisibility(db, opts.visibilityHashFor) : 0;
  return out;
}

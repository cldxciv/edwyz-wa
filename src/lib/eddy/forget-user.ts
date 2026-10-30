/**
 * eddyForgetUser (docs/EDDY-SPEC.md 7.6 critic, 8.3, EDDY-16 acceptance 8): what Eddy keeps about a member goes when they
 * leave a workspace or are anonymised.
 *
 * In that workspace it:
 * - stops any turn of theirs still running (aborted), then deletes their EddyConversation and EddyMessage rows;
 * - deletes their EddyUserPref and NoticeReceipt rows, and notices meant for them alone;
 * - cancels their pending cards, then deletes their decided ActionRecord rows (a record still `running` or `unknown` is
 *   left to the reconcile job, and the daily sweep removes it once it is settled);
 * - sets userId to NULL on their EddyTurn and ActionInvocation rows: the usage and the audit log stay, without the person
 *   (the one change the ActionInvocation trigger allows).
 * Afterwards no Eddy row holds their userId except a running or unknown ActionRecord, which the next sweep clears.
 *
 * Called by src/lib/lifecycle/erasure.ts anonymiseUser (eddyForgetUserEverywhere) and, for members removed from a workspace,
 * by the daily erasure sweep (erasure-sweep.ts), so no workspace route has to change. Works on the app client or inside a
 * caller's transaction (`db`). Database access goes through the lifecycle helpers (retention.ts eddyTables).
 */
import { eddyTables, type EddyTables } from "./retention";

export type ForgetCounts = { conversations: number; messages: number; prefs: number; receipts: number; notices: number; cancelled: number; actionRecords: number; turns: number; invocations: number };

const SETTLING = ["running", "unknown"];

/** Forgets one member in one workspace. Idempotent. */
export async function eddyForgetUser(tenantId: string, userId: string, opts: { db?: EddyTables; now?: Date } = {}): Promise<ForgetCounts> {
  const db = opts.db ?? eddyTables();
  const now = opts.now ?? new Date();
  const convIds = (await db.eddyConversation.findMany({ where: { tenantId, userId }, select: { id: true } })).map((r) => String(r.id));
  if (convIds.length) await db.eddyTurn.updateMany({ where: { tenantId, conversationId: { in: convIds }, status: "running" }, data: { status: "aborted", errorCode: "member_left", endedAt: now } });
  const messages = convIds.length ? (await db.eddyMessage.deleteMany({ where: { tenantId, conversationId: { in: convIds } } })).count : 0;
  const turns = (await db.eddyTurn.updateMany({ where: { tenantId, userId }, data: { userId: null } })).count;
  const conversations = (await db.eddyConversation.deleteMany({ where: { tenantId, userId } })).count;
  const prefs = (await db.eddyUserPref.deleteMany({ where: { tenantId, userId } })).count;
  const receipts = (await db.noticeReceipt.deleteMany({ where: { tenantId, userId } })).count;
  const own = (await db.notice.findMany({ where: { tenantId, audienceUserId: userId }, select: { id: true } })).map((r) => String(r.id));
  if (own.length) await db.noticeReceipt.deleteMany({ where: { tenantId, noticeId: { in: own } } });
  const notices = own.length ? (await db.notice.deleteMany({ where: { tenantId, id: { in: own } } })).count : 0;
  const cancelled = (await db.actionRecord.updateMany({ where: { tenantId, userId, status: { in: ["pending", "awaiting_approval"] } }, data: { status: "cancelled", decidedAt: now, updatedAt: now } })).count;
  const actionRecords = (await db.actionRecord.deleteMany({ where: { tenantId, userId, status: { notIn: SETTLING } } })).count;
  const invocations = (await db.actionInvocation.updateMany({ where: { tenantId, userId }, data: { userId: null } })).count;
  return { conversations, messages, prefs, receipts, notices, cancelled, actionRecords, turns, invocations };
}

/** Forgets a member in every workspace where Eddy holds something of theirs (anonymiseUser). */
export async function eddyForgetUserEverywhere(userId: string, opts: { db?: EddyTables; now?: Date } = {}): Promise<number> {
  const db = opts.db ?? eddyTables();
  const tenants = new Set<string>();
  for (const table of [db.eddyConversation, db.eddyUserPref, db.noticeReceipt, db.actionRecord, db.eddyTurn, db.actionInvocation]) {
    for (const r of await table.findMany({ where: { userId }, select: { tenantId: true }, distinct: ["tenantId"], take: 1000 })) tenants.add(String(r.tenantId));
  }
  for (const tenantId of tenants) await eddyForgetUser(tenantId, userId, { db, now: opts.now });
  return tenants.size;
}

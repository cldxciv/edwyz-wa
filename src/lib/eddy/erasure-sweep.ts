/**
 * Eddy's erasure (docs/EDDY-SPEC.md 7.6, EDDY-16 acceptance 6 and 8): contact erasure, and the daily `eddy.erasure-sweep`.
 *
 * eraseContactFromEddy(tenantId, contactId) is what contact erasure (src/lib/lifecycle/erasure.ts deleteContactData) runs for
 * Eddy, inside the same transaction when the caller passes its client as `db`:
 * - every Eddy conversation with a message that mentions the contact (EddyMessage.contactIds), or one of the contact's chats
 *   when the caller passes them (EddyMessage.conversationIds; the loop tags each round with both), loses ALL its messages and is
 *   marked `erased` (closedReason contact_erased), so it can never continue: a thread with a hole in it would fail the
 *   preserved-thinking replay (12.2 risk 3). A turn still running in it is aborted;
 * - ActionRecord rows whose contactIds hold the contact are deleted;
 * - Notice rows whose subject is the contact (or one of the contact's chats, when the caller passes them) are deleted.
 *
 * The daily sweep is the backstop for anything missed:
 * - contacts that no longer exist but are still mentioned by EddyMessage, ActionRecord or Notice rows are erased as above;
 * - notices about chats that no longer exist are deleted;
 * - members who left a workspace (no Membership) but still have Eddy rows there are forgotten (forget-user.ts), which is how
 *   member removal is covered without editing any workspace route.
 * Database access goes through the lifecycle helpers (retention.ts eddyTables), never @/lib/db directly.
 */
import { eddyForgetUser } from "./forget-user";
import { eddyTables, type EddyTables } from "./retention";

const PAGE = 1000;
/** Pages read per table per run; the next day's run carries on. */
const MAX_PAGES = 20;
const CHUNK = 500;

export type ContactEraseCounts = { conversations: number; messages: number; actionRecords: number; notices: number };

/** Removes what Eddy holds about one contact (see the module comment). Idempotent. */
export async function eraseContactFromEddy(tenantId: string, contactId: string, opts: { db?: EddyTables; conversationIds?: readonly string[]; now?: Date } = {}): Promise<ContactEraseCounts> {
  const db = opts.db ?? eddyTables();
  const now = opts.now ?? new Date();
  // A message that names the contact, or one of the contact's chats (a tool result about a chat may name only the chat).
  const chats = [...(opts.conversationIds ?? [])];
  const mentions = await db.eddyMessage.findMany({
    where: { tenantId, ...(chats.length ? { OR: [{ contactIds: { has: contactId } }, { conversationIds: { hasSome: chats } }] } : { contactIds: { has: contactId } }) },
    select: { conversationId: true },
    take: 10_000,
  });
  const convIds = [...new Set(mentions.map((m) => String(m.conversationId)))];
  let messages = 0;
  let conversations = 0;
  if (convIds.length) {
    await db.eddyTurn.updateMany({ where: { tenantId, conversationId: { in: convIds }, status: "running" }, data: { status: "aborted", errorCode: "erased", endedAt: now } });
    messages = (await db.eddyMessage.deleteMany({ where: { tenantId, conversationId: { in: convIds } } })).count;
    conversations = (await db.eddyConversation.updateMany({ where: { tenantId, id: { in: convIds } }, data: { status: "erased", closedReason: "contact_erased" } })).count;
  }
  const actionRecords = (await db.actionRecord.deleteMany({ where: { tenantId, contactIds: { has: contactId } } })).count;
  const subjects: Record<string, unknown>[] = [{ subjectType: "contact", subjectId: contactId }];
  if (opts.conversationIds?.length) subjects.push({ subjectType: "conversation", subjectId: { in: [...opts.conversationIds] } });
  const noticeIds = (await db.notice.findMany({ where: { tenantId, OR: subjects }, select: { id: true } })).map((n) => String(n.id));
  let notices = 0;
  if (noticeIds.length) {
    await db.noticeReceipt.deleteMany({ where: { tenantId, noticeId: { in: noticeIds } } });
    notices = (await db.notice.deleteMany({ where: { tenantId, id: { in: noticeIds } } })).count;
  }
  return { conversations, messages, actionRecords, notices };
}

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** tenantId -> ids mentioned, read page by page from one table. */
async function mentionedIds(table: EddyTables[keyof EddyTables], where: Record<string, unknown>, field: string, pick: (row: Record<string, unknown>) => string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  let after = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await table.findMany({ where: { ...where, ...(after ? { id: { gt: after } } : {}) }, select: { id: true, tenantId: true, [field]: true }, orderBy: { id: "asc" }, take: PAGE });
    if (rows.length === 0) break;
    after = String(rows[rows.length - 1].id);
    for (const r of rows) {
      const set = out.get(String(r.tenantId)) ?? new Set<string>();
      for (const id of pick(r)) if (id) set.add(id);
      out.set(String(r.tenantId), set);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

const merge = (into: Map<string, Set<string>>, from: Map<string, Set<string>>) => {
  for (const [tenant, ids] of from) {
    const set = into.get(tenant) ?? new Set<string>();
    for (const id of ids) set.add(id);
    into.set(tenant, set);
  }
  return into;
};

/** Ids of `ids` that no longer exist in `table` for the workspace. */
async function missing(table: EddyTables[keyof EddyTables], tenantId: string, ids: readonly string[]): Promise<string[]> {
  const gone: string[] = [];
  for (const part of chunks(ids)) {
    const found = new Set((await table.findMany({ where: { tenantId, id: { in: part } }, select: { id: true } })).map((r) => String(r.id)));
    for (const id of part) if (!found.has(id)) gone.push(id);
  }
  return gone;
}

const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

export type SweepResult = { contactsErased: number; noticesDeleted: number; membersForgotten: number };

/** The daily `eddy.erasure-sweep` (see the module comment). Never throws for one workspace's failure. */
export async function runEddyErasureSweep(opts: { db?: EddyTables; now?: Date } = {}): Promise<SweepResult> {
  const db = opts.db ?? eddyTables();
  const now = opts.now ?? new Date();
  const result: SweepResult = { contactsErased: 0, noticesDeleted: 0, membersForgotten: 0 };

  // 1. Contacts erased elsewhere that Eddy rows still mention.
  const contacts = merge(
    merge(await mentionedIds(db.eddyMessage, { NOT: { contactIds: { isEmpty: true } } }, "contactIds", (r) => arr(r.contactIds)), await mentionedIds(db.actionRecord, { NOT: { contactIds: { isEmpty: true } } }, "contactIds", (r) => arr(r.contactIds))),
    await mentionedIds(db.notice, { subjectType: "contact" }, "subjectId", (r) => [String(r.subjectId ?? "")]),
  );
  for (const [tenantId, ids] of contacts) {
    try {
      for (const contactId of await missing(db.contact, tenantId, [...ids])) {
        await eraseContactFromEddy(tenantId, contactId, { db, now });
        result.contactsErased++;
      }
    } catch (error) {
      console.error(`[eddy] erasure sweep failed for ${tenantId}: ${error instanceof Error ? error.name : "error"}`);
    }
  }

  // 2. Notices about chats that no longer exist.
  const chats = await mentionedIds(db.notice, { subjectType: "conversation" }, "subjectId", (r) => [String(r.subjectId ?? "")]);
  for (const [tenantId, ids] of chats) {
    const gone = await missing(db.conversation, tenantId, [...ids]);
    if (!gone.length) continue;
    const noticeIds = (await db.notice.findMany({ where: { tenantId, subjectType: "conversation", subjectId: { in: gone } }, select: { id: true } })).map((n) => String(n.id));
    if (!noticeIds.length) continue;
    await db.noticeReceipt.deleteMany({ where: { tenantId, noticeId: { in: noticeIds } } });
    result.noticesDeleted += (await db.notice.deleteMany({ where: { tenantId, id: { in: noticeIds } } })).count;
  }

  // 3. Members who left: Eddy rows of a user with no membership in that workspace.
  const members = new Map<string, Set<string>>();
  const owned: [EddyTables[keyof EddyTables], Record<string, unknown>][] = [
    [db.eddyConversation, {}],
    [db.eddyUserPref, {}],
    [db.noticeReceipt, {}],
    [db.actionRecord, {}],
    // EddyTurn.userId is nullable (a forgotten member's usage rows keep, without the person).
    [db.eddyTurn, { userId: { not: null } }],
  ];
  for (const [table, where] of owned) {
    const rows = await table.findMany({ where, select: { tenantId: true, userId: true }, distinct: ["tenantId", "userId"], take: 10_000 });
    for (const r of rows) {
      const userId = String(r.userId ?? "");
      if (!userId || userId.startsWith("system:")) continue;
      const set = members.get(String(r.tenantId)) ?? new Set<string>();
      set.add(userId);
      members.set(String(r.tenantId), set);
    }
  }
  for (const [tenantId, users] of members) {
    try {
      for (const part of chunks([...users])) {
        const present = new Set((await db.membership.findMany({ where: { tenantId, userId: { in: part } }, select: { userId: true } })).map((m) => String(m.userId)));
        for (const userId of part) {
          if (present.has(userId)) continue;
          await eddyForgetUser(tenantId, userId, { db, now });
          result.membersForgotten++;
        }
      }
    } catch (error) {
      console.error(`[eddy] member sweep failed for ${tenantId}: ${error instanceof Error ? error.name : "error"}`);
    }
  }
  return result;
}

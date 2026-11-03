/**
 * Erasure and opt-out for customer-list audiences on Meta (docs/IG-PAGE-ADS-SPEC.md 5.5, D17, PRM-11). PRM-00 wired the calls;
 * this file does the work.
 *
 * - forgetContact: normalises and hashes the contact's email and phone (SHA-256, promote/hashing.ts), then queues
 *   `promote.audience.forget` with {tenantId, hashes, audienceIds}. Nothing is queued when the workspace has no customer list on
 *   Meta, or when the contact has no email or phone to match by.
 * - The job (handleForgetJob) sends `DELETE {aud}/users` (A4) for every customer-list audience of the workspace on Meta at the
 *   time it runs, the ones made since included (Meta ignores people who are not members; membership is never stored). It is
 *   retried with backoff for up to 7 days while Meta is busy or does not answer, and also while the workspace's Meta connection
 *   has expired or been disconnected or lacks a permission (a reconnect within the 7 days still removes the person). Only an
 *   audience that can never be reached again is skipped. Its payload is deleted as soon as the job is done (runForgetQueue
 *   purges done jobs right after each run), is kept at most 7 days whatever happens, and is never logged: a failure records
 *   only a count (runDueJobs stores the error message, which never carries the payload).
 * - The opt-out sweep (sweepOptOuts, the nightly promote.audiences.optout task): contacts of workspaces with customer lists
 *   whose marketing opt-in was withdrawn go through the same job, grouped per workspace. A withdrawal is either an opt-out
 *   (Contact.optedOutAt; contacts/opt-out.ts: an opt-out blocks marketing) or a consent withdrawn without one: the public API
 *   (integrations/v1-service.ts, also behind the compat API) sets optIn false and audits `contact.consent_withdrawn`, so the
 *   sweep also reads the audit log's withdrawals of the window and takes those contacts that are still not consented. Each run
 *   covers at least the last 26 hours; when the stored cursor (PlatformSetting `promote:optout-cursor`, written only once every
 *   job is queued) is older, because a run was skipped, failed or ran late, it covers everything since the cursor, so no
 *   withdrawal is missed for good. The first run starts at the oldest customer list. A refresh (usersreplace) only ever
 *   includes consented contacts, so a withdrawal is never put back. People who never consented are never sent, not even
 *   hashed for a removal.
 * - queueWorkspaceAudienceDeletes: a best-effort `DELETE {aud}` (A6) for each customer-list audience of a workspace being
 *   erased, sent directly (erasure also deletes the workspace's queued jobs).
 * - queueAdAccountAudienceDeletes: the same for the customer-list audiences of the ad accounts of one Meta connection that the
 *   Meta data-deletion callback erases (lifecycle/erase-meta.ts).
 *
 * Removing a person who withdrew consent or was erased is a privacy duty, not a feature, so none of this follows PROMOTE_ENABLED
 * or PROMOTE_AUDIENCES: not forgetContact, not the `promote.audience.forget` queue (worker.ts runs it every minute whatever the
 * switches say), and not the opt-out sweep (worker.ts runs it whenever customerListAudiencesExist()). A kill switch or a
 * rollback must never strand someone in an audience on Meta.
 *
 * Every path that deletes a Contact row calls forgetContact first, while the email and phone can still be read
 * (tests/lifecycle-erase.test.ts fails on a new path that does not):
 * - lib/lifecycle/erasure.ts deleteContactData: erasure by phone or BSUID, inside its transaction ({db: tx});
 * - lib/contacts/service.ts deleteContact: DELETE /api/contacts/[id], the compat API (lib/compat/contacts.ts) and Eddy's
 *   delete_contact;
 * - lib/actions/defs/contacts.ts: the undo of Eddy's create_contact;
 * - lib/lifecycle/erase-meta.ts eraseLeads: contacts created only by the leads of an erased Meta connection.
 * Not called, by design: lib/contacts/resolve.ts mergeContacts (the person stays, as the merge target), and the rollbacks of a
 * contact the same request created after a refused send (lib/admin/service.ts, lib/inbox/new-chat.ts), and the Edwyz notifier
 * workspace's own contacts (lib/spend/notify/platform-sender.ts), which runs no ads.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { runDueJobs } from "@/lib/queue";
import { HttpError } from "@/lib/tenancy";
import { contactEmail, identityRow, IDENTITY_SCHEMA, isHashed } from "./hashing";
import type { PromoteMeta } from "./meta";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The job queue of 5.5. */
export const FORGET_QUEUE = "promote.audience.forget";
/** A forget job is deleted after at most this long, sent or not. */
export const FORGET_KEEP_MS = 7 * DAY;
/**
 * Tries per job: runDueJobs backs off 1, 2, 4, 8 and 16 minutes, then 30 minutes between tries, so 336 tries span about 6.9 days,
 * the whole of the 7 days a payload may be kept. A connection that is reconnected within that time still gets the removal.
 */
export const FORGET_MAX_ATTEMPTS = 336;
/** Jobs a run takes at most. */
export const FORGET_BATCH = 10;
/** People per job and per A4 request (Meta's limit for a users request). */
export const FORGET_ROWS_PER_JOB = 10_000;
/** The opt-out sweep always covers at least this much (5.5). */
export const OPTOUT_WINDOW_MS = 26 * HOUR;
/** Where the sweep keeps how far it got. */
export const OPTOUT_CURSOR_KEY = "promote:optout-cursor";
const OPTOUT_PAGE = 1_000;

export type ForgetDeps = {
  meta: Pick<PromoteMeta, "removeAudienceUsers" | "deleteAudience">;
  now: () => number;
};

async function forgetDeps(overrides: Partial<ForgetDeps>): Promise<ForgetDeps> {
  const meta = overrides.meta ?? (await import("./meta")).promoteMeta;
  return { meta, now: overrides.now ?? Date.now };
}

/** What a forget job carries: hashes only, never an email or a phone number. */
export type ForgetPayload = {
  tenantId: string;
  hashes: { schema: ["EMAIL", "PHONE"]; rows: string[][] };
  /** The workspace's customer-list audiences when the job was queued (AdAudience ids). */
  audienceIds: string[];
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A payload as stored, checked again before anything is sent; null when it is not one. */
export function parseForgetPayload(value: unknown): ForgetPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const hashes = v.hashes as Record<string, unknown> | null | undefined;
  if (typeof v.tenantId !== "string" || !ID.test(v.tenantId) || !hashes || typeof hashes !== "object") return null;
  const schema = hashes.schema;
  if (!Array.isArray(schema) || schema.length !== 2 || schema[0] !== "EMAIL" || schema[1] !== "PHONE") return null;
  const rows = Array.isArray(hashes.rows) ? hashes.rows : [];
  const valid = rows.filter((r): r is string[] => Array.isArray(r) && r.length === 2 && r.every((x) => x === "" || isHashed(x)) && r.some((x) => x !== ""));
  if (valid.length === 0) return null;
  const audienceIds = Array.isArray(v.audienceIds) ? v.audienceIds.filter((id): id is string => typeof id === "string" && ID.test(id)) : [];
  return { tenantId: v.tenantId, hashes: { schema: ["EMAIL", "PHONE"], rows: valid.map((r) => [...r]) }, audienceIds };
}

const payloadOf = (tenantId: string, rows: string[][], audienceIds: string[]): Prisma.InputJsonObject => ({
  tenantId,
  hashes: { schema: [...IDENTITY_SCHEMA], rows },
  audienceIds,
});

type Db = Pick<Prisma.TransactionClient, "adAudience" | "contact" | "job">;

/** The workspace's customer-list audiences that exist on Meta. */
async function customerListIds(db: Db, tenantId: string): Promise<string[]> {
  const rows = await db.adAudience.findMany({ where: { tenantId, kind: "customer_list", deletedAt: null, metaAudienceId: { not: null } }, select: { id: true } });
  return rows.map((r) => r.id);
}

export type ForgetContactOptions = {
  /**
   * The erasure's transaction. lifecycle/erasure.ts calls forgetContact inside it, before anything of the contact is deleted,
   * so the contact's email and phone can still be read, and a failure rolls the whole erasure back instead of leaving the person
   * in an audience with no way left to find them. Callers without a transaction call it before their delete, so a failure stops
   * the delete and the request can run again. The job is written in the same transaction.
   */
  db?: Prisma.TransactionClient;
};

export type ForgetContactResult = { queued: boolean; audiences: number };

/**
 * Removes one contact from every customer-list audience of the workspace on Meta: queues the hashed email and phone. A contact
 * id the workspace does not have is a no-op (contacts/service.deleteContact calls it before its own tenant-scoped delete finds
 * out), and so is a workspace without customer lists on Meta (one lookup).
 */
export async function forgetContact(tenantId: string, contactId: string, options: ForgetContactOptions = {}): Promise<ForgetContactResult> {
  const db: Db = options.db ?? prisma;
  const audienceIds = await customerListIds(db, tenantId);
  if (audienceIds.length === 0) return { queued: false, audiences: 0 };
  const contact = await db.contact.findFirst({ where: { id: contactId, tenantId }, select: { phone: true, attributes: true } });
  const row = contact ? identityRow({ email: contactEmail(contact.attributes), phone: contact.phone }) : null;
  if (!row) return { queued: false, audiences: audienceIds.length };
  await db.job.create({ data: { queue: FORGET_QUEUE, payload: payloadOf(tenantId, [row], audienceIds), maxAttempts: FORGET_MAX_ATTEMPTS } });
  return { queued: true, audiences: audienceIds.length };
}

/** Meta's "object does not exist" (error 100, subcode 33), read off the Graph error without loading the Graph client here. */
function isGone(error: unknown): boolean {
  const e = error as { code?: unknown; subcode?: unknown } | null;
  return typeof e === "object" && e !== null && e.code === 100 && e.subcode === 33;
}

/**
 * Trying again can never help, so the audience is skipped: Meta no longer has it (100/33), or our own check refused the call for
 * good before anything was sent (400 from promote/meta.ts: the id is not a customer list of this ad account, or the ad account
 * can't be used; 404: the ad account is no longer in the workspace, which only happens once its audiences were deleted on Meta).
 * Everything else is a failure the job retries: Meta busy or down, the Meta connection expired or disconnected or the asset
 * inactive (409 from getAssetAccess), a missing permission (403, or Meta's 190, 10 or 2xx), and any other Meta error.
 */
function permanent(error: unknown): boolean {
  if (isGone(error)) return true;
  return error instanceof HttpError && (error.status === 400 || error.status === 404);
}

export type ForgetJobResult = { audiences: number; sent: number; skipped: number };

/**
 * The promote.audience.forget job: A4 for every customer-list audience of the workspace on Meta. An audience that can never be
 * reached again is skipped; any other failure throws (after trying every audience) so the job runs again, for up to 7 days.
 * The error says how many failed and nothing else: never a hash, an id of a person, or Meta's text.
 */
export async function handleForgetJob(payload: unknown, overrides: Partial<ForgetDeps> = {}): Promise<ForgetJobResult> {
  const job = parseForgetPayload(payload);
  if (!job) return { audiences: 0, sent: 0, skipped: 0 };
  const deps = await forgetDeps(overrides);
  const audiences = await prisma.adAudience.findMany({
    where: { tenantId: job.tenantId, kind: "customer_list", deletedAt: null, metaAudienceId: { not: null }, adAccountAssetId: { not: null } },
    select: { id: true, adAccountAssetId: true, metaAudienceId: true },
  });
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const a of audiences) {
    try {
      for (let i = 0; i < job.hashes.rows.length; i += FORGET_ROWS_PER_JOB) {
        await deps.meta.removeAudienceUsers({ tenantId: job.tenantId, adAccountAssetId: a.adAccountAssetId as string }, a.metaAudienceId as string, {
          schema: [...IDENTITY_SCHEMA],
          rows: job.hashes.rows.slice(i, i + FORGET_ROWS_PER_JOB),
        });
      }
      sent++;
    } catch (error) {
      if (permanent(error)) skipped++;
      else failed++;
    }
  }
  if (failed > 0) throw new Error(`Could not remove people from ${failed} customer list ${failed === 1 ? "audience" : "audiences"} on Meta yet. The job will try again.`);
  return { audiences: audiences.length, sent, skipped };
}

export type ForgetQueueResult = { sent: number; purged: number };

/**
 * The promote.audience.forget task (every minute, whatever PROMOTE_ENABLED says): runs the due jobs, then deletes every job of
 * the queue that is done (its payload goes with it) or older than 7 days.
 */
export async function runForgetQueue(overrides: Partial<ForgetDeps> = {}): Promise<ForgetQueueResult> {
  const now = (overrides.now ?? Date.now)();
  const sent = await runDueJobs(FORGET_QUEUE, async (payload) => void (await handleForgetJob(payload, overrides)), FORGET_BATCH);
  const purged = await prisma.job.deleteMany({ where: { queue: FORGET_QUEUE, OR: [{ status: "done" }, { createdAt: { lt: new Date(now - FORGET_KEEP_MS) } }] } });
  return { sent, purged: purged.count };
}

export type OptOutSweepResult = { contacts: number; queued: number };

function cursorOf(value: unknown): number | null {
  const at = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).at : null;
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** The audit actions that withdraw a marketing consent (contacts/consent.ts): a consent withdrawn, and an opt-out. */
export const WITHDRAWAL_ACTIONS = ["contact.consent_withdrawn", "contact.opted_out"] as const;

type SweptContact = { id: string; tenantId: string; phone: string | null; attributes: unknown };

/**
 * The nightly opt-out sweep: every contact of a workspace with customer lists on Meta whose marketing opt-in was withdrawn since
 * the window start (the last 26 hours, or the cursor when it is older) is queued for A4, grouped per workspace, 10,000 people a
 * job. A withdrawal is an opt-out in the window (optedOutAt), or an audited withdrawal in the window (`contact.consent_withdrawn`
 * or `contact.opted_out`) of a contact who is still not consented (optIn false or opted out), which covers the API's optIn false
 * that leaves optedOutAt empty. Each contact is queued once. The cursor moves to the run's start only once every job is queued.
 */
export async function sweepOptOuts(overrides: Partial<Pick<ForgetDeps, "now">> = {}): Promise<OptOutSweepResult> {
  const now = (overrides.now ?? Date.now)();
  const lists = await prisma.adAudience.findMany({ where: { kind: "customer_list", deletedAt: null, metaAudienceId: { not: null } }, select: { id: true, tenantId: true, createdAt: true } });
  if (lists.length === 0) return { contacts: 0, queued: 0 };
  const byTenant = new Map<string, string[]>();
  let oldest = now;
  for (const l of lists) {
    byTenant.set(l.tenantId, [...(byTenant.get(l.tenantId) ?? []), l.id]);
    oldest = Math.min(oldest, new Date(l.createdAt).getTime());
  }
  const setting = await prisma.platformSetting.findUnique({ where: { key: OPTOUT_CURSOR_KEY } });
  const cursor = cursorOf(setting?.value) ?? oldest;
  const since = new Date(Math.min(now - OPTOUT_WINDOW_MS, cursor));
  let contacts = 0;
  let queued = 0;
  const pending = new Map<string, string[][]>();
  const flush = async (tenantId: string) => {
    const rows = pending.get(tenantId) ?? [];
    pending.delete(tenantId);
    if (rows.length === 0) return;
    await prisma.job.create({ data: { queue: FORGET_QUEUE, payload: payloadOf(tenantId, rows, byTenant.get(tenantId) ?? []), maxAttempts: FORGET_MAX_ATTEMPTS } });
    queued += rows.length;
  };
  const tenants = [...byTenant.keys()];
  const window = { gte: since, lte: new Date(now) };
  const seen = new Set<string>();
  const take = async (c: SweptContact) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    contacts++;
    const row = identityRow({ email: contactEmail(c.attributes), phone: c.phone });
    if (!row) return;
    const rows = pending.get(c.tenantId) ?? [];
    rows.push(row);
    pending.set(c.tenantId, rows);
    if (rows.length >= FORGET_ROWS_PER_JOB) await flush(c.tenantId);
  };
  // Opt-outs: optedOutAt in the window.
  let after: string | null = null;
  for (;;) {
    const page: SweptContact[] = await prisma.contact.findMany({
      where: { tenantId: { in: tenants }, optedOutAt: window, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" },
      take: OPTOUT_PAGE,
      select: { id: true, tenantId: true, phone: true, attributes: true },
    });
    for (const c of page) await take(c);
    if (page.length < OPTOUT_PAGE) break;
    after = page[page.length - 1].id;
  }
  // Consents withdrawn without an opt-out (the API's optIn false): the audit log of the window names them. Only contacts that
  // are still not consented, of the workspace that audited them, are taken: one who agreed again since stays in the list.
  let auditAfter: string | null = null;
  for (;;) {
    const logs: { id: string; tenantId: string | null; target: string | null }[] = await prisma.auditLog.findMany({
      where: { tenantId: { in: tenants }, action: { in: [...WITHDRAWAL_ACTIONS] }, createdAt: window, ...(auditAfter ? { id: { gt: auditAfter } } : {}) },
      orderBy: { id: "asc" },
      take: OPTOUT_PAGE,
      select: { id: true, tenantId: true, target: true },
    });
    const tenantOf = new Map<string, string>();
    for (const l of logs) if (l.target && l.tenantId && ID.test(l.target) && !seen.has(l.target)) tenantOf.set(l.target, l.tenantId);
    if (tenantOf.size > 0) {
      const withdrawn: SweptContact[] = await prisma.contact.findMany({
        where: { tenantId: { in: tenants }, id: { in: [...tenantOf.keys()] }, OR: [{ optIn: false }, { optedOutAt: { not: null } }] },
        orderBy: { id: "asc" },
        select: { id: true, tenantId: true, phone: true, attributes: true },
      });
      for (const c of withdrawn) if (tenantOf.get(c.id) === c.tenantId) await take(c);
    }
    if (logs.length < OPTOUT_PAGE) break;
    auditAfter = logs[logs.length - 1].id;
  }
  for (const tenantId of [...pending.keys()]) await flush(tenantId);
  const value = { at: new Date(now).toISOString() };
  await prisma.platformSetting.upsert({ where: { key: OPTOUT_CURSOR_KEY }, create: { key: OPTOUT_CURSOR_KEY, value }, update: { value } });
  return { contacts, queued };
}

export type WorkspaceAudienceDeletesResult = { audiences: number; queued: number; failed: number };

async function deleteOnMeta(rows: { adAccountAssetId: string | null; metaAudienceId: string | null; tenantId: string }[], overrides: Partial<ForgetDeps>): Promise<WorkspaceAudienceDeletesResult> {
  if (rows.length === 0) return { audiences: 0, queued: 0, failed: 0 };
  const deps = await forgetDeps(overrides);
  let queued = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.adAccountAssetId || !r.metaAudienceId) continue;
    try {
      await deps.meta.deleteAudience({ tenantId: r.tenantId, adAccountAssetId: r.adAccountAssetId }, r.metaAudienceId);
      queued++;
    } catch (error) {
      // Meta no longer has it: as good as deleted.
      if (isGone(error)) queued++;
      else failed++;
    }
  }
  return { audiences: rows.length, queued, failed };
}

const LIST_SELECT = { tenantId: true, adAccountAssetId: true, metaAudienceId: true } as const;

/**
 * Deletes every customer-list audience of a workspace on Meta, best effort. lib/lifecycle/erase-workspace.ts calls it before the
 * workspace's Meta connections are revoked (the token still works then) and before its rows are deleted, logs the result and
 * carries on if it fails. Erasure also deletes the workspace's queued jobs, so the deletes are sent directly rather than left
 * in a job.
 */
export async function queueWorkspaceAudienceDeletes(tenantId: string, overrides: Partial<ForgetDeps> = {}): Promise<WorkspaceAudienceDeletesResult> {
  const rows = await prisma.adAudience.findMany({ where: { tenantId, kind: "customer_list", deletedAt: null, metaAudienceId: { not: null }, adAccountAssetId: { not: null } }, select: LIST_SELECT });
  return deleteOnMeta(rows, overrides);
}

/**
 * Deletes the customer-list audiences of these ad accounts (MetaAsset ids) on Meta, best effort. lib/lifecycle/erase-meta.ts calls
 * it when Meta's data-deletion callback erases one connection: before that connection is revoked (its token still works) and
 * before the accounts' AdAudience rows go. A failure is counted and never stops the erasure.
 */
export async function queueAdAccountAudienceDeletes(tenantId: string, adAccountAssetIds: readonly string[], overrides: Partial<ForgetDeps> = {}): Promise<WorkspaceAudienceDeletesResult> {
  if (adAccountAssetIds.length === 0) return { audiences: 0, queued: 0, failed: 0 };
  const rows = await prisma.adAudience.findMany({
    where: { tenantId, kind: "customer_list", deletedAt: null, metaAudienceId: { not: null }, adAccountAssetId: { in: [...adAccountAssetIds] } },
    select: LIST_SELECT,
  });
  return deleteOnMeta(rows, overrides);
}

/**
 * Whether any workspace has a live customer-list audience: one indexed lookup of at most one row, no Meta call. The opt-out sweep
 * (worker.ts) runs only when this is true, and runs then even while PROMOTE_ENABLED is off.
 */
export async function customerListAudiencesExist(): Promise<boolean> {
  return (await prisma.adAudience.findFirst({ where: { kind: "customer_list", deletedAt: null }, select: { id: true } })) !== null;
}

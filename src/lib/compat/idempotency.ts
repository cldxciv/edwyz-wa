import { createHash } from "node:crypto";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { deleteBatched } from "@/lib/lifecycle/batch";
import { HttpError } from "@/lib/tenancy";
import { IDEMPOTENCY_HOURS } from "./spec";

export type Sent = { id: string; conversationId: string; status: string };
export type SentOnce = Sent & { duplicate: boolean };

type IdemRecord = { bodyHash: string; state: "pending" | "done"; result?: { message_id: string; conversation_id: string; status: string } };

const inflight = new Map<string, Promise<Sent>>();
const POLL_MS = 250;
const POLL_ATTEMPTS = 12;
/**
 * A send finishes in seconds. A claim still pending after this long is treated as abandoned (its process died, or lost the completion
 * write): the next caller replaces it and sends, instead of polling for it and then being refused. A claim younger than this is
 * in flight and keeps its exactly-once guarantee: callers wait for its result and never send.
 */
export const PENDING_STALE_MS = 60_000;
/** Rows are only needed for IDEMPOTENCY_HOURS; the retention job removes whatever the in-process sweep missed after this long. */
export const IDEMPOTENCY_PRUNE_HOURS = 48;
const SWEEP_EVERY_MS = 10 * 60_000;
const KEY_PREFIX = "compat:idem:";
let lastSweep = 0;

export function parseLocalMessageId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 100) throw new HttpError(400, "local_message_id must be a string up to 100 characters.");
  return value;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** No PII in the key: the phone and the caller's id are hashed together. */
export const idempotencyKey = (tenantId: string, phone: string, localId: string) => `${KEY_PREFIX}${tenantId}:${sha(`${phone}\n${localId}`).slice(0, 40)}`;

function parseRecord(value: unknown): IdemRecord | null {
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r.bodyHash !== "string" || (r.state !== "pending" && r.state !== "done")) return null;
  return r as unknown as IdemRecord;
}

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";

function fromRecord(record: IdemRecord): Sent | null {
  const r = record.result;
  if (!r || typeof r.message_id !== "string" || typeof r.conversation_id !== "string") return null;
  return { id: r.message_id, conversationId: r.conversation_id, status: typeof r.status === "string" ? r.status : "queued" };
}

async function claim(key: string, value: IdemRecord, since: Date): Promise<boolean> {
  try {
    await prisma.platformSetting.create({ data: { key, value } });
    return true;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  const { count } = await prisma.platformSetting.deleteMany({ where: { key, updatedAt: { lt: since } } });
  if (count === 0) return false;
  try {
    await prisma.platformSetting.create({ data: { key, value } });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

async function waitForResult(key: string): Promise<IdemRecord | null> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const row = await prisma.platformSetting.findUnique({ where: { key } });
    const record = row ? parseRecord(row.value) : null;
    if (!record) return null;
    if (record.state === "done") return record;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return null;
}

/** Claims past the window are deleted in bulk, at most once per SWEEP_EVERY_MS per process, so the table does not grow without bound. */
async function sweepExpired(since: Date, now: number): Promise<void> {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  await prisma.platformSetting.deleteMany({ where: { key: { startsWith: KEY_PREFIX }, updatedAt: { lt: since } } }).catch(() => undefined);
}

export const resetIdempotencySweep = () => {
  lastSweep = 0;
};

/**
 * Answers a caller whose claim lost. Returns the original result, or null when the claim it lost to was pending past
 * PENDING_STALE_MS and has just been deleted by this call (the caller may now claim and send; at most one caller wins that delete,
 * because a live sender's completion write moves updatedAt and so defeats the conditional delete).
 */
async function replay(key: string, bodyHash: string, now: number, mayTakeOver: boolean): Promise<Sent | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  const record = row ? parseRecord(row.value) : null;
  if (!record) throw new HttpError(409, "A send with this local_message_id is being recorded. Retry shortly.");
  if (record.bodyHash !== bodyHash) throw new HttpError(422, "This local_message_id was already used with a different message.");
  if (record.state === "pending" && row && now - row.updatedAt.getTime() > PENDING_STALE_MS && mayTakeOver) {
    const staleBefore = new Date(now - PENDING_STALE_MS);
    const { count } = await prisma.platformSetting.deleteMany({ where: { key, updatedAt: { lt: staleBefore } } });
    if (count > 0) return null;
  }
  const settled = record.state === "done" ? record : await waitForResult(key);
  const earlier = settled ? fromRecord(settled) : null;
  if (!earlier) throw new HttpError(409, "A send with this local_message_id is still in progress. Retry in a few seconds; do not send it again.");
  return earlier;
}

/** Deletes idempotency claims last written before the cutoff, in batches. Used by the retention job; returns only a count. */
export function pruneIdempotencyClaims(cutoff: Date): Promise<number> {
  return deleteBatched("PlatformSetting", { key: { startsWith: KEY_PREFIX }, updatedAt: { lt: cutoff } }, "key");
}

/**
 * Runs send() unless the same local_message_id was already used for this recipient in the last 24 hours, in which case the
 * original result is returned and nothing is sent; the same id with a different body is a 422. The claim is a PlatformSetting row
 * with a unique key, created before the send (so two processes cannot both send) and completed after it. If the process dies
 * between send and completion the row stays pending: retries get a 409 while it is fresh (under PENDING_STALE_MS), after which it
 * is treated as abandoned and replaced by the next caller. A send that throws releases its claim so the caller can retry.
 */
export async function sendOnce(
  tenantId: string,
  phone: string,
  localId: string | undefined,
  fingerprint: unknown,
  send: () => Promise<Sent>,
  now = new Date(),
): Promise<SentOnce> {
  if (!localId) {
    const sent = await send();
    await audit({ tenantId, action: "compat.send", target: sent.id, meta: { idempotent: false } });
    return { ...sent, duplicate: false };
  }
  const key = idempotencyKey(tenantId, phone, localId);
  const bodyHash = sha(JSON.stringify(fingerprint ?? null));
  const flightKey = `${key}|${bodyHash}`;

  const running = inflight.get(flightKey);
  if (running) return { ...(await running), duplicate: true };

  let duplicate = false;
  const job = (async (): Promise<Sent> => {
    const since = new Date(now.getTime() - IDEMPOTENCY_HOURS * 60 * 60 * 1000);
    await sweepExpired(since, now.getTime());
    let claimed = await claim(key, { bodyHash, state: "pending" }, since);
    if (!claimed) {
      duplicate = true;
      const earlier = await replay(key, bodyHash, now.getTime(), true);
      if (earlier) return earlier;
      // The earlier claim was abandoned and is gone. Claim again; if another caller got there first, wait for that one instead.
      claimed = await claim(key, { bodyHash, state: "pending" }, since);
      if (!claimed) return (await replay(key, bodyHash, now.getTime(), false)) as Sent;
      duplicate = false;
    }
    let sent: Sent;
    try {
      sent = await send();
    } catch (e) {
      await prisma.platformSetting.deleteMany({ where: { key } }).catch(() => undefined);
      throw e;
    }
    const done: IdemRecord = { bodyHash, state: "done", result: { message_id: sent.id, conversation_id: sent.conversationId, status: sent.status } };
    await prisma.platformSetting.update({ where: { key }, data: { value: done } }).catch(() => undefined);
    await audit({ tenantId, action: "compat.send", target: sent.id, meta: { idempotent: true } });
    return sent;
  })();
  inflight.set(flightKey, job);
  try {
    return { ...(await job), duplicate };
  } finally {
    inflight.delete(flightKey);
  }
}

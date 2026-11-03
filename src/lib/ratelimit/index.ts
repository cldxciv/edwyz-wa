import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";

/**
 * Fixed-window limiter that survives restarts and is shared by every process on the database. Same shape as
 * `createLimiter` in `@/lib/auth/ratelimit`: (max, windowMs), the window starts at the first hit for a key, and
 * `consume(key, now?)` answers synchronously, so a module switches by changing its import.
 *
 * - `consume` decides from memory and writes its hits to Postgres in the background (one batched upsert per key per round
 *   trip). Counts from other processes, and from before a restart, arrive with the first reply, so enforcement converges
 *   within a few milliseconds; the very first hit for a key in a fresh process is always allowed.
 * - `consumeShared` waits for the database and answers from the shared count. Use it where an extra attempt matters
 *   (password, TOTP and approval-token guessing) and the route can already await.
 *
 * Backends (env RATELIMIT_BACKEND): `settings` is the default, one PlatformSetting row per key ("rl:<name>:<sha256(key)>",
 * value {count, exp}), no schema change. `table` uses the RateLimitBucket table requested in docs/schema-requests.md, which has
 * no migration yet: scripts/check-env.mjs refuses the value, and if it is set anyway the first "table does not exist" answer moves
 * every limiter to `settings` (one warning), instead of leaving them all on per-process counts.
 * `memory` stays in the process (so does a limiter created with { memoryOnly: true }, for public endpoints whose hits should not write rows); it is also the default under NODE_ENV=test. If the database fails the limiter degrades
 * to its local counts and logs one warning a minute. Keys are hashed, so emails and IPs never reach the database.
 */
export type Limiter = {
  /** False when the key is over its limit. `now` only affects the local clock (tests). */
  consume(key: string, now?: number): boolean;
  consumeShared(key: string, now?: number): Promise<boolean>;
  reset(key: string): Promise<void>;
  clear(): Promise<void>;
  /** Resolves when pending background writes have finished (tests, graceful shutdown). */
  flush(): Promise<void>;
};

type Entry = { resetAt: number; shared: number; flushing: number; pending: number; inflight: boolean };
type Backend = "settings" | "table" | "memory";
type Row = { count: number | bigint | string; ttlMs: number | bigint | string };

const MAX_LOCAL = 50_000;
const SWEEP_EVERY_MS = 5 * 60_000;
const WARN_EVERY_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 5000;

let lastSweep = 0;
let lastWarn = 0;
/** Set once the RateLimitBucket table turned out not to exist; `table` then means `settings` for the life of the process. */
let tableMissing = false;

function backend(): Backend {
  const value = process.env.RATELIMIT_BACKEND;
  if (value === "table") return tableMissing ? "settings" : "table";
  if (value === "memory" || value === "settings") return value;
  return process.env.NODE_ENV === "test" ? "memory" : "settings";
}

/** Postgres 42P01 (undefined_table) for RateLimitBucket, as the pg driver or Prisma reports it. */
function isMissingBucketTable(error: unknown): boolean {
  const text = [error, (error as { cause?: unknown } | null)?.cause]
    .map((e) => (e && typeof e === "object" ? `${(e as { code?: unknown }).code ?? ""} ${(e as { message?: unknown }).message ?? ""}` : ""))
    .join(" ");
  return /RateLimitBucket/.test(text) && /42P01|does not exist/i.test(text);
}

/** Test hook: forget that the RateLimitBucket table was found missing. */
export function resetRateLimitBackend() {
  tableMissing = false;
}

/** True when the error means the RateLimitBucket table is missing; from then on `table` is served by the settings rows. */
function switchToSettings(error: unknown): boolean {
  if (!isMissingBucketTable(error)) return false;
  if (!tableMissing) log.warn("ratelimit.table_missing", { fallback: "settings" });
  tableMissing = true;
  return true;
}

const safeName = (name: string) => name.replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 48);
const hashKey = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

function warnOnce(error: unknown) {
  const now = Date.now();
  if (now - lastWarn < WARN_EVERY_MS) return;
  lastWarn = now;
  log.warn("ratelimit.degraded", { err: error });
}

async function addSettings(rowKey: string, delta: number, windowMs: number): Promise<Row> {
  const rows = await prisma.$queryRaw<Row[]>`
    INSERT INTO "PlatformSetting" (key, value, "updatedAt")
    VALUES (${rowKey}, jsonb_build_object('count', ${delta}::int, 'exp', (extract(epoch from clock_timestamp()) * 1000)::bigint + ${windowMs}::bigint), now())
    ON CONFLICT (key) DO UPDATE SET
      value = CASE
        WHEN ("PlatformSetting".value->>'exp')::bigint <= (extract(epoch from clock_timestamp()) * 1000)::bigint THEN EXCLUDED.value
        ELSE jsonb_build_object('count', ("PlatformSetting".value->>'count')::int + ${delta}::int, 'exp', ("PlatformSetting".value->>'exp')::bigint)
      END,
      "updatedAt" = now()
    RETURNING (value->>'count')::int AS count, ((value->>'exp')::bigint - (extract(epoch from clock_timestamp()) * 1000)::bigint) AS "ttlMs"`;
  return rows[0];
}

async function addTable(rowKey: string, delta: number, windowMs: number): Promise<Row> {
  const rows = await prisma.$queryRaw<Row[]>`
    INSERT INTO "RateLimitBucket" (key, count, "expiresAt")
    VALUES (${rowKey}, ${delta}::int, clock_timestamp() + ${windowMs}::double precision * interval '1 millisecond')
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN "RateLimitBucket"."expiresAt" <= clock_timestamp() THEN EXCLUDED.count ELSE "RateLimitBucket".count + ${delta}::int END,
      "expiresAt" = CASE WHEN "RateLimitBucket"."expiresAt" <= clock_timestamp() THEN EXCLUDED."expiresAt" ELSE "RateLimitBucket"."expiresAt" END
    RETURNING count, (extract(epoch from "expiresAt" - clock_timestamp()) * 1000)::bigint AS "ttlMs"`;
  return rows[0];
}

async function deleteRows(key: string, exact: boolean) {
  if (backend() === "memory") return;
  if (backend() === "table") {
    if (exact) await prisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE key = ${key}`;
    else await prisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE starts_with(key, ${key})`;
  } else if (exact) {
    await prisma.$executeRaw`DELETE FROM "PlatformSetting" WHERE key = ${key}`;
  } else {
    await prisma.$executeRaw`DELETE FROM "PlatformSetting" WHERE starts_with(key, ${key})`;
  }
}

/**
 * Deletes expired rows (a minute past expiry). The limiter calls this opportunistically every few minutes; a
 * worker periodic task may call it too. Returns the number of rows removed.
 */
export async function sweepExpiredLimits(batch = 1000): Promise<number> {
  if (backend() === "memory") return 0;
  if (backend() === "table") {
    return prisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE key IN (SELECT key FROM "RateLimitBucket" WHERE "expiresAt" < clock_timestamp() - interval '1 minute' LIMIT ${batch})`;
  }
  return prisma.$executeRaw`
    DELETE FROM "PlatformSetting" WHERE key IN (
      SELECT key FROM "PlatformSetting"
      WHERE key LIKE 'rl:%' AND (value->>'exp')::bigint < (extract(epoch from clock_timestamp()) * 1000)::bigint - 60000
      LIMIT ${batch})`;
}

function maybeSweep(now: number) {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  sweepExpiredLimits().catch(() => undefined);
}

export function createLimiter(max: number, windowMs: number, name = `w${windowMs}m${max}`, options: { memoryOnly?: boolean } = {}): Limiter {
  const local = new Map<string, Entry>();
  const syncs = new Set<Promise<void>>();
  let downUntil = 0;
  const inMemory = () => options.memoryOnly === true || backend() === "memory";
  const prefix = `rl:${safeName(name)}:`;
  const rowKeyOf = (key: string) => `${prefix}${hashKey(key)}`;
  const total = (e: Entry) => e.shared + e.flushing + e.pending;

  const prune = (now: number) => {
    if (local.size <= 10_000) return;
    for (const [k, v] of local) if (v.resetAt <= now) local.delete(k);
    while (local.size > MAX_LOCAL) local.delete(local.keys().next().value as string);
  };

  const entryFor = (key: string, now: number): Entry => {
    const existing = local.get(key);
    if (existing && existing.resetAt > now) return existing;
    prune(now);
    const fresh: Entry = { resetAt: now + windowMs, shared: 0, flushing: 0, pending: 0, inflight: false };
    local.set(key, fresh);
    return fresh;
  };

  const apply = (entry: Entry, row: Row, now: number) => {
    entry.shared = Number(row.count);
    entry.resetAt = now + Math.max(0, Number(row.ttlMs));
  };

  const push = async (key: string, delta: number): Promise<Row> => {
    if (backend() !== "table") return addSettings(rowKeyOf(key), delta, windowMs);
    try {
      return await addTable(rowKeyOf(key), delta, windowMs);
    } catch (error) {
      // The same hit goes to the settings rows at once, so no count is lost and no 5 s pause starts.
      if (switchToSettings(error)) return addSettings(rowKeyOf(key), delta, windowMs);
      throw error;
    }
  };

  const background = (key: string, entry: Entry, now: number) => {
    if (entry.inflight || entry.pending === 0 || inMemory() || Date.now() < downUntil) return;
    entry.inflight = true;
    entry.flushing = entry.pending;
    entry.pending = 0;
    const delta = entry.flushing;
    const job = push(key, delta)
      .then((row) => {
        entry.flushing = 0;
        apply(entry, row, now);
        maybeSweep(now);
      })
      .catch((error) => {
        entry.pending += entry.flushing;
        entry.flushing = 0;
        downUntil = Date.now() + RETRY_AFTER_FAILURE_MS;
        warnOnce(error);
      })
      .finally(() => {
        entry.inflight = false;
        syncs.delete(job);
        if (entry.pending > 0 && local.get(key) === entry) background(key, entry, Date.now());
      });
    syncs.add(job);
  };

  const consume = (key: string, now = Date.now()): boolean => {
    const entry = entryFor(key, now);
    if (total(entry) >= max) return false;
    entry.pending += 1;
    background(key, entry, now);
    return true;
  };

  return {
    consume,

    async consumeShared(key, now = Date.now()) {
      if (inMemory()) return consume(key, now);
      const entry = entryFor(key, now);
      if (total(entry) >= max) return false;
      if (Date.now() < downUntil) {
        entry.pending += 1;
        return total(entry) <= max;
      }
      try {
        apply(entry, await push(key, 1), now);
        maybeSweep(now);
      } catch (error) {
        downUntil = Date.now() + RETRY_AFTER_FAILURE_MS;
        warnOnce(error);
        entry.pending += 1;
      }
      return total(entry) <= max;
    },

    async reset(key) {
      local.delete(key);
      if (!options.memoryOnly) await deleteRows(rowKeyOf(key), true).catch(warnOnce);
    },

    async clear() {
      local.clear();
      if (!options.memoryOnly) await deleteRows(prefix, false).catch(warnOnce);
    },

    async flush() {
      while (syncs.size > 0) await Promise.all([...syncs]);
    },
  };
}

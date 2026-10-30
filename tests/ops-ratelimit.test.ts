import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { count: number; expiresAt: number };
const store = vi.hoisted(() => new Map<string, { count: number; expiresAt: number }>());
const calls = vi.hoisted(() => ({ query: [] as { sql: string; values: unknown[] }[], exec: [] as { sql: string; values: unknown[] }[], fail: false }));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.query.push({ sql: strings.join("?"), values });
      if (calls.fail) throw new Error("connection refused");
      const [key, delta, windowMs] = values as [string, number, number];
      const now = Date.now();
      let row: Row | undefined = store.get(key);
      if (!row || row.expiresAt <= now) row = { count: Number(delta), expiresAt: now + Number(windowMs) };
      else row = { count: row.count + Number(delta), expiresAt: row.expiresAt };
      store.set(key, row);
      return [{ count: row.count, ttlMs: BigInt(row.expiresAt - now) }];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.exec.push({ sql: strings.join("?"), values });
      return 0;
    }),
  },
}));

import { createLimiter, sweepExpiredLimits } from "@/lib/ratelimit";

beforeEach(() => {
  store.clear();
  calls.query.length = 0;
  calls.exec.length = 0;
  calls.fail = false;
  process.env.RATELIMIT_BACKEND = "settings";
});
afterEach(() => vi.useRealTimers());

describe("synchronous consume (drop-in)", () => {
  it("allows up to max and then denies", async () => {
    const limiter = createLimiter(3, 60_000, "t1");
    const results = [1, 2, 3, 4, 5].map(() => limiter.consume("k"));
    expect(results).toEqual([true, true, true, false, false]);
    await limiter.flush();
    expect(store.get(calls.query[0].values[0] as string)?.count).toBe(3);
  });

  it("batches hits into few upserts", async () => {
    const limiter = createLimiter(100, 60_000, "batch");
    for (let i = 0; i < 5; i++) limiter.consume("k");
    await limiter.flush();
    expect(calls.query.map((q) => q.values[1])).toEqual([1, 4]);
  });

  it("learns the shared count from other processes and denies once it is reached", async () => {
    const a = createLimiter(3, 60_000, "shared");
    const b = createLimiter(3, 60_000, "shared");
    a.consume("ip");
    a.consume("ip");
    await a.flush();
    expect(b.consume("ip")).toBe(true);
    await b.flush();
    expect(b.consume("ip")).toBe(false);
    expect(a.consume("ip")).toBe(true);
    await a.flush();
    expect(a.consume("ip")).toBe(false);
  });

  it("survives a restart: a new instance picks the count up from the database", async () => {
    const before = createLimiter(3, 60_000, "restart");
    for (let i = 0; i < 3; i++) before.consume("k");
    await before.flush();
    const after = createLimiter(3, 60_000, "restart");
    expect(after.consume("k")).toBe(true);
    await after.flush();
    expect(after.consume("k")).toBe(false);
  });

  it("answers saturated keys from memory without another database call", async () => {
    const limiter = createLimiter(2, 60_000, "t2");
    limiter.consume("k");
    limiter.consume("k");
    await limiter.flush();
    const before = calls.query.length;
    expect(limiter.consume("k")).toBe(false);
    expect(limiter.consume("k")).toBe(false);
    await limiter.flush();
    expect(calls.query.length).toBe(before);
  });

  it("starts a new window after the old one expires", () => {
    const limiter = createLimiter(1, 1000, "win");
    expect(limiter.consume("k", 0)).toBe(true);
    expect(limiter.consume("k", 500)).toBe(false);
    expect(limiter.consume("k", 1500)).toBe(true);
  });

  it("keeps working from local counts when the database fails", async () => {
    calls.fail = true;
    const limiter = createLimiter(2, 60_000, "down");
    expect(limiter.consume("k")).toBe(true);
    await limiter.flush();
    expect(limiter.consume("k")).toBe(true);
    await limiter.flush();
    expect(limiter.consume("k")).toBe(false);
  });

  it("never touches the database in memory mode", async () => {
    process.env.RATELIMIT_BACKEND = "memory";
    const limiter = createLimiter(1, 60_000, "mem");
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(false);
    expect(await limiter.consumeShared("other")).toBe(true);
    await limiter.flush();
    expect(calls.query).toHaveLength(0);
  });

  it("defaults to memory under NODE_ENV=test so other suites need no database", async () => {
    delete process.env.RATELIMIT_BACKEND;
    const limiter = createLimiter(5, 60_000, "dflt");
    limiter.consume("k");
    await limiter.flush();
    expect(calls.query).toHaveLength(0);
  });
});

describe("consumeShared (authoritative)", () => {
  it("counts across instances using the database count", async () => {
    const a = createLimiter(3, 60_000, "auth");
    const b = createLimiter(3, 60_000, "auth");
    expect(await a.consumeShared("ip")).toBe(true);
    expect(await a.consumeShared("ip")).toBe(true);
    expect(await b.consumeShared("ip")).toBe(true);
    expect(await b.consumeShared("ip")).toBe(false);
  });

  it("falls back to local counting when the database fails", async () => {
    calls.fail = true;
    const limiter = createLimiter(1, 60_000, "authdown");
    expect(await limiter.consumeShared("k")).toBe(true);
    expect(await limiter.consumeShared("k")).toBe(false);
  });
});

describe("storage", () => {
  it("never stores the raw key (emails, IPs) in the database", async () => {
    const limiter = createLimiter(5, 60_000, "pii");
    limiter.consume("person@example.com|203.0.113.9");
    await limiter.flush();
    expect(String(calls.query[0].values[0])).toMatch(/^rl:pii:[0-9a-f]{32}$/);
    expect(JSON.stringify(calls.query[0].values)).not.toContain("example.com");
  });

  it("keeps limiter names and keys apart", async () => {
    const a = createLimiter(1, 60_000, "alpha");
    const b = createLimiter(1, 60_000, "beta");
    expect(a.consume("k")).toBe(true);
    expect(b.consume("k")).toBe(true);
    expect(a.consume("other")).toBe(true);
    await Promise.all([a.flush(), b.flush()]);
    expect(store.size).toBe(3);
  });

  it("uses one atomic upsert per write", async () => {
    const limiter = createLimiter(5, 60_000, "sql");
    limiter.consume("k");
    await limiter.flush();
    expect(calls.query).toHaveLength(1);
    expect(calls.query[0].sql).toContain('INSERT INTO "PlatformSetting"');
    expect(calls.query[0].sql).toContain("ON CONFLICT (key) DO UPDATE");
    expect(calls.query[0].sql).toContain("RETURNING");
  });

  it("targets the RateLimitBucket table when RATELIMIT_BACKEND=table", async () => {
    process.env.RATELIMIT_BACKEND = "table";
    const limiter = createLimiter(5, 60_000, "tbl");
    limiter.consume("k");
    await limiter.flush();
    expect(calls.query[0].sql).toContain('INSERT INTO "RateLimitBucket"');
  });

  it("reset and clear delete the shared rows and the local count", async () => {
    const limiter = createLimiter(1, 60_000, "rst");
    limiter.consume("k");
    await limiter.flush();
    expect(limiter.consume("k")).toBe(false);
    await limiter.reset("k");
    expect(calls.exec[0].sql).toContain("key =");
    expect(limiter.consume("k")).toBe(true);
    await limiter.clear();
    expect(calls.exec[1].sql).toContain("starts_with");
    expect(calls.exec[1].values[0]).toBe("rl:rst:");
  });

  it("sweeps only expired rows", async () => {
    await sweepExpiredLimits(50);
    expect(calls.exec[0].sql).toContain("'rl:%'");
    expect(calls.exec[0].sql).toContain("- 60000");
  });
});

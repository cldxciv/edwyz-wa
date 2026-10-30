import { fork, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { reserveAds } from "@/lib/spend/book";
import { SpendBusyError } from "@/lib/spend/errors";
import { SPEND_LOCK_SQL, spendLockKey } from "@/lib/spend/lock";
import { createTestDb, DATABASE_URL_TEST, HAS_TEST_DB, type TestDb } from "../helpers/pg";

/**
 * reserveAds against real Postgres (docs/SPEND-CONTROLS-SPEC.md 10.2 ads-concurrency): 2 forked Node processes, each with its
 * own Prisma client, connection pool and module state (permit cache, freeze cache, lock tracking), run 25 parallel
 * activations each against a daily limit that fits exactly 10. Exactly 10 succeed, the other 40 are refused with
 * spend.daily_limit, and nothing deadlocks: the advisory lock (21328, tenant:ads) is the only thing ordering them. A lock held
 * elsewhere gives SpendBusyError. The database part skips cleanly when DATABASE_URL_TEST is not set; the check that the
 * child process bundles and starts runs everywhere.
 *
 * The child is bundled from CHILD_SOURCE with esbuild exactly as deploy/build-worker.mjs bundles the worker (packages stay
 * external, the @/ paths come from tsconfig), into node_modules/.cache (one file per run, removed afterwards), and talks to this
 * file over the IPC channel:
 *   ping -> pong;  prepare(job) -> ready (client connected);  go -> done(results) and exit.
 */

const NOW = new Date("2026-10-28T06:30:00Z");
const ENV = { SPEND_ENFORCE: "enforce" };
const ROOT = path.resolve(__dirname, "../..");
// One file per test process: other runs (other developers, other agents) may bundle at the same moment.
const CHILD_FILE = path.join(ROOT, "node_modules", ".cache", "edwyz-db-tests", `reserve-child-${process.pid}.mjs`);

const CHILD_SOURCE = `
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { reserveAds } from "@/lib/spend/book";
import { SpendBlockedError, SpendBusyError } from "@/lib/spend/errors";

type TargetSet = { campaignId: string; adSetId: string; metaAdSetId: string };
type Job = { url: string; schema: string; tenantId: string; now: string; env: Record<string, string>; sets: TargetSet[] };
type Msg = { type: "ping" | "prepare" | "go"; job?: Job };

const send = (m: unknown) => new Promise<void>((resolve) => process.send!(m, () => resolve()));
let client: PrismaClient | null = null;
let job: Job | null = null;

/** One activation as a caller would make it: a busy lock is retried, a refusal is final. */
async function attempt(set: TargetSet): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      await reserveAds(job!.tenantId, { kind: "activate", campaignId: set.campaignId, sets: [{ adSetId: set.adSetId, metaAdSetId: set.metaAdSetId }] }, { type: "user", userId: "u_owner", role: "owner" }, {
        idempotencyKey: "activate:" + set.campaignId,
        reason: "Concurrency test",
        db: client as never,
        now: new Date(job!.now),
        env: job!.env,
      });
      return "ok";
    } catch (error) {
      if (error instanceof SpendBusyError) {
        await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
        continue;
      }
      if (error instanceof SpendBlockedError) return "refused:" + error.code;
      return "error:" + ((error as { code?: string }).code ?? (error as Error).message);
    }
  }
  return "busy";
}

process.on("message", async (msg: Msg) => {
  try {
    if (msg.type === "ping") {
      await send({ type: "pong", pid: process.pid, book: typeof reserveAds });
      process.exit(0);
    }
    if (msg.type === "prepare") {
      job = msg.job!;
      client = new PrismaClient({ adapter: new PrismaPg({ connectionString: job.url, options: "-c search_path=" + job.schema, max: 30 }, { schema: job.schema }) });
      await client.$queryRawUnsafe("SELECT 1");
      await send({ type: "ready", pid: process.pid });
      return;
    }
    if (msg.type === "go") {
      const results = await Promise.all(job!.sets.map((s) => attempt(s)));
      await send({ type: "done", results });
      await client!.$disconnect();
      process.exit(0);
    }
  } catch (error) {
    await send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
});
`;

type ChildMsg = { type: "pong" | "ready" | "done" | "error"; pid?: number; book?: string; results?: string[]; message?: string };
type Child = { proc: ChildProcess; send: (m: unknown) => void; next: (type: ChildMsg["type"], timeoutMs?: number) => Promise<ChildMsg>; kill: () => void };

let bundled: Promise<string> | null = null;

/** Bundles the child once per run (esbuild, as the worker build does). */
function bundleChild(): Promise<string> {
  bundled ??= build({
    stdin: { contents: CHILD_SOURCE, resolveDir: ROOT, sourcefile: "reserve-child.ts", loader: "ts" },
    outfile: CHILD_FILE,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    tsconfig: path.join(ROOT, "tsconfig.json"),
    logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  }).then(() => CHILD_FILE);
  return bundled;
}

/** Forks one child process with an IPC channel. Messages are queued until a test waits for them. */
function startChild(file: string, env: Record<string, string | undefined> = {}): Child {
  const proc = fork(file, [], { cwd: ROOT, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, ...env } });
  const inbox: ChildMsg[] = [];
  const waiters: { type: ChildMsg["type"]; resolve: (m: ChildMsg) => void; reject: (e: Error) => void }[] = [];
  let stderr = "";
  proc.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4_000);
  });
  const deliver = () => {
    for (let i = 0; i < waiters.length; i++) {
      const hit = inbox.findIndex((m) => m.type === waiters[i].type || m.type === "error");
      if (hit < 0) continue;
      const [m] = inbox.splice(hit, 1);
      const [w] = waiters.splice(i--, 1);
      if (m.type === "error" && w.type !== "error") w.reject(new Error(`child ${proc.pid} failed: ${m.message}`));
      else w.resolve(m);
    }
  };
  proc.on("message", (m: ChildMsg) => {
    inbox.push(m);
    deliver();
  });
  proc.on("exit", (code) => {
    for (const w of waiters.splice(0)) w.reject(new Error(`child ${proc.pid} exited with ${code} before "${w.type}". ${stderr}`));
  });
  return {
    proc,
    send: (m) => proc.send(m as never),
    next: (type, timeoutMs = 90_000) =>
      new Promise<ChildMsg>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child ${proc.pid} sent no "${type}" in ${timeoutMs} ms. ${stderr}`)), timeoutMs);
        waiters.push({
          type,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        deliver();
      }),
    kill: () => {
      if (proc.exitCode === null) proc.kill();
    },
  };
}

function clientFor(schema: string, max = 30): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL_TEST, options: `-c search_path=${schema}`, max }, { schema }) });
}

async function seedWorkspace(db: TestDb, t: string, dailyMinor: number, monthlyMinor: number | null): Promise<void> {
  await db.query(`INSERT INTO "Tenant" ("id","name","slug") VALUES ($1,$1,$1)`, [t]);
  await db.query(`INSERT INTO "MetaConnection" ("id","tenantId","metaUserId","tokenEnc","connectedByUserId","updatedAt") VALUES ($1,$2,'mu','sealed','u',now())`, [`mc_${t}`, t]);
  await db.query(`INSERT INTO "MetaAsset" ("id","tenantId","connectionId","type","externalId","name","meta","updatedAt") VALUES ($1,$2,$3,'ad_account','act_1','Ads',$4::jsonb,now())`, [`acc_${t}`, t, `mc_${t}`, JSON.stringify({ currency: "INR", timezone: "Asia/Kolkata" })]);
  await db.query(
    `INSERT INTO "SpendControl" ("tenantId","probation","spendingAdAccountAssetId","timezone","updatedAt") VALUES ($1,'lifted',$2,'Asia/Kolkata',now())
     ON CONFLICT ("tenantId") DO UPDATE SET "probation" = 'lifted', "spendingAdAccountAssetId" = EXCLUDED."spendingAdAccountAssetId"`,
    [t, `acc_${t}`],
  );
  await db.query(`INSERT INTO "SpendAllowance" ("id","tenantId","pot","currency","dailyLimitMinor","monthlyLimitMinor","updatedAt") VALUES ($1,$2,'ads','INR',$3,$4,now())`, [`sa_${t}`, t, dailyMinor, monthlyMinor]);
}

async function seedCampaign(db: TestDb, t: string, i: number, dailyMinor: number): Promise<{ campaignId: string; adSetId: string; metaAdSetId: string }> {
  const c = `c${i}_${t}`;
  await db.query(
    `INSERT INTO "AdCampaign" ("id","tenantId","adAccountAssetId","metaCampaignId","name","template","objective","status","dailyBudgetMinor","currency","updatedAt")
     VALUES ($1,$2,$3,$4,$1,'lead_generation','OUTCOME_LEADS','paused',$5,'INR',now())`,
    [c, t, `acc_${t}`, `mc_${c}`, dailyMinor],
  );
  await db.query(`INSERT INTO "AdSet" ("id","tenantId","campaignId","metaAdSetId","name","status","targeting","dailyBudgetMinor") VALUES ($1,$2,$3,$4,$1,'paused','{}'::jsonb,$5)`, [`s_${c}`, t, c, `ms_${c}`, dailyMinor]);
  await db.query(`INSERT INTO "Ad" ("id","tenantId","adSetId","metaAdId","name","status","creative") VALUES ($1,$2,$3,$4,$1,'paused','{}'::jsonb)`, [`a_${c}`, t, `s_${c}`, `ma_${c}`]);
  return { campaignId: c, adSetId: `s_${c}`, metaAdSetId: `ms_${c}` };
}

afterAll(() => rmSync(CHILD_FILE, { force: true }));

describe("the reserving child process", () => {
  it("bundles with esbuild, starts as its own process and answers over IPC (no database needed)", async () => {
    const file = await bundleChild();
    const child = startChild(file);
    try {
      child.send({ type: "ping" });
      const pong = await child.next("pong", 60_000);
      expect(pong.book).toBe("function");
      expect(pong.pid).not.toBe(process.pid);
    } finally {
      child.kill();
    }
  }, 120_000);
});

describe.skipIf(!HAS_TEST_DB)("reserveAds on Postgres", () => {
  let db: TestDb;
  let a: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    a = clientFor(db.schema);
  }, 120_000);
  afterAll(async () => {
    await a?.$disconnect();
    await db?.close();
  });

  it("2 forked processes x 25 parallel activations against a daily limit that fits exactly 10 give exactly 10, with no deadlock", async () => {
    const t = "t_conc";
    // Each campaign has a ₹4 daily budget: its worst case today is ceil(1.75 x 400) = 700, and the limit is 7,000.
    await seedWorkspace(db, t, 7_000, null);
    const sets: { campaignId: string; adSetId: string; metaAdSetId: string }[] = [];
    for (let i = 0; i < 50; i++) sets.push(await seedCampaign(db, t, i, 400));
    const file = await bundleChild();
    const children = [startChild(file), startChild(file)];
    try {
      children.forEach((child, n) => child.send({ type: "prepare", job: { url: DATABASE_URL_TEST, schema: db.schema, tenantId: t, now: NOW.toISOString(), env: ENV, sets: sets.slice(n * 25, n * 25 + 25) } }));
      const ready = await Promise.all(children.map((c) => c.next("ready")));
      expect(new Set(ready.map((r) => r.pid)).size).toBe(2);
      // Both start at the same moment.
      children.forEach((c) => c.send({ type: "go" }));
      const done = await Promise.all(children.map((c) => c.next("done", 110_000)));
      const all = done.flatMap((d) => d.results ?? []);
      expect(all).toHaveLength(50);
      expect(all.filter((r) => r === "ok")).toHaveLength(10);
      expect(all.filter((r) => r === "refused:spend.daily_limit")).toHaveLength(40);
      expect(all.filter((r) => r.startsWith("error") || r === "busy")).toEqual([]);
    } finally {
      children.forEach((c) => c.kill());
    }
    const reserved = await db.query<{ n: string; risk: string }>(`SELECT count(*)::text AS n, COALESCE(sum("peakDailyBudgetMinor"), 0)::text AS risk FROM "SpendCommitment" WHERE "tenantId" = $1 AND "status" = 'reserved'`, [t]);
    expect(reserved.rows[0]).toEqual({ n: "10", risk: "4000" });
    const requested = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "SpendLedger" WHERE "tenantId" = $1 AND "phase" = 'requested'`, [t]);
    expect(requested.rows[0].n).toBe("10");
    const refused = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "SpendLedger" WHERE "tenantId" = $1 AND "phase" = 'refused'`, [t]);
    expect(refused.rows[0].n).toBe("40");
  }, 180_000);

  it("a lock held by another transaction gives SpendBusyError, and nothing is reserved", async () => {
    const t = "t_busy";
    await seedWorkspace(db, t, 1_000_000, null);
    const set = await seedCampaign(db, t, 0, 400);
    const other = await db.connect();
    await other.query("BEGIN");
    await other.query(SPEND_LOCK_SQL.lock, [spendLockKey(t, "ads")]);
    const started = Date.now();
    const error = await reserveAds(t, { kind: "activate", campaignId: set.campaignId, sets: [{ adSetId: set.adSetId, metaAdSetId: set.metaAdSetId }] }, { type: "user", userId: "u", role: "owner" }, {
      idempotencyKey: "busy:1",
      reason: "Busy test",
      db: a as never,
      now: NOW,
      env: ENV,
    }).catch((e: unknown) => e);
    await other.query("ROLLBACK");
    expect(error).toBeInstanceOf(SpendBusyError);
    expect(Date.now() - started).toBeLessThan(10_000);
    const n = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "SpendCommitment" WHERE "tenantId" = $1`, [t]);
    expect(n.rows[0].n).toBe("0");
  }, 60_000);
});

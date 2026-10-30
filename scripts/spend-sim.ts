/**
 * Synthetic ads spend for SANDBOX ad accounts (docs/SPEND-CONTROLS-SPEC.md 10.3, 10.5). A Meta sandbox account delivers
 * nothing, so with SPEND_SIM=1 the breakers, the digest and the Spending page are exercised with these series instead.
 *
 * Scenarios (per ad set with daily budget D; history days are full days, today is sampled every 15 minutes up to now):
 * - normal:    spends 85-100% of D a day; CPM about ₹150, CTR about 1.2%, cost per lead about ₹250.
 * - runaway:   history normal; today spends at a normal pace until 10:00, jumps by 60% of D in one 15-minute sample
 *              (spend_jump), then reaches 1.75 x D by 14:00 (pacing over 120%).
 * - zero_lead: normal spend, no leads on any day (efficiency breaker: cost per lead infinite).
 * - cpm_spike: history CPM about ₹150 and CTR about 1.2%; in the last hour 1,500 impressions at CPM 3 x the median and CTR
 *              a quarter of it (cpm_ctr_anomaly needs at least 1,000 impressions in the hour).
 * Rows written: SpendDaily `adset` rows (origin platform) and one `account` row per day (origin all; scopeId = the ad
 * account's MetaAsset id unless --account-scope-id says otherwise), source `sim`, SET never incremented; and
 * IntradaySpendSample cumulative rows for today, with deterministic ids so a re-run replaces them.
 *
 * Run (the same esbuild pattern as eval:eddy; esbuild resolves the @/ paths from tsconfig):
 *   npx esbuild scripts/spend-sim.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/edwyz-sim/spend-sim.mjs
 *   node node_modules/.cache/edwyz-sim/spend-sim.mjs --tenant <tenantId> --account <MetaAsset id> --scenario runaway [--days 7]
 *        [--adset <metaAdSetId>:<dailyBudgetMinor>]... [--seed 1] [--account-scope-id <id>] [--dry-run]
 * Without --adset it uses the open ad set commitments (SpendCommitment) of that account. It refuses any ad account that is
 * not marked as a test ad account (MetaAsset.sandbox), and refuses production unless SPEND_SIM=1.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { addDays, dayKey, startOfLocalDay } from "@/lib/spend/periods";

export type SimScenario = "normal" | "runaway" | "zero_lead" | "cpm_spike";
export const SIM_SCENARIOS: readonly SimScenario[] = ["normal", "runaway", "zero_lead", "cpm_spike"];

export type SimAdSet = { metaId: string; dailyBudgetMinor: bigint };

export type SimInput = {
  scenario: SimScenario;
  tenantId: string;
  adAccountAssetId: string;
  /** scopeId of the SpendDaily account rows (default: the MetaAsset id). */
  accountScopeId?: string;
  adSets: SimAdSet[];
  currency: string;
  timezone: string;
  /** Full days of history before today (default 7). */
  days?: number;
  now: Date;
  seed?: number;
  sampleEveryMin?: number;
};

export type SimDailyRow = {
  tenantId: string;
  pot: "ads";
  scopeType: "account" | "adset";
  scopeId: string;
  day: string;
  currency: string;
  amountMinor: bigint;
  origin: "all" | "platform";
  results: number;
  impressions: bigint;
  clicks: bigint;
  source: "sim";
  syncedAt: Date;
};

export type SimSampleRow = {
  id: string;
  tenantId: string;
  adAccountAssetId: string;
  entityType: "account" | "adset";
  entityMetaId: string;
  accountDate: string;
  sampledAt: Date;
  spendMinor: bigint;
  impressions: bigint;
  clicks: bigint;
  results: number;
};

/** Deterministic PRNG (mulberry32), so a seed always gives the same series. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CPM_MINOR = 15_000n; // ₹150 per 1,000 impressions
const CTR_BPS = 120n; // 1.2%
const CPL_MINOR = 25_000n; // ₹250 per lead
const ceil175 = (x: bigint) => (7n * x + 3n) / 4n;
const frac = (x: bigint, f: number) => (x * BigInt(Math.round(f * 1_000_000))) / 1_000_000n;

type Point = { spend: bigint; impressions: bigint; clicks: bigint; results: number };

function metricsFor(spend: bigint, scenario: SimScenario, cpmMinor = CPM_MINOR, ctrBps = CTR_BPS): Point {
  const impressions = cpmMinor > 0n ? (spend * 1000n) / cpmMinor : 0n;
  const clicks = (impressions * ctrBps) / 10_000n;
  const results = scenario === "zero_lead" ? 0 : Number(spend / CPL_MINOR);
  return { spend, impressions, clicks, results };
}

/** Today's cumulative spend of one ad set at elapsed fraction `f` of the account day (0..1). */
function todayCurve(scenario: SimScenario, d: bigint, f: number, base: number): bigint {
  const normal = frac(d, base * f);
  if (scenario !== "runaway") return normal;
  const jumpAt = 10 / 24;
  const capAt = 14 / 24;
  if (f < jumpAt) return normal;
  const atJump = frac(d, base * jumpAt) + frac(d, 0.6);
  if (f >= capAt) return ceil175(d);
  const rest = ceil175(d) - atJump;
  return atJump + frac(rest, (f - jumpAt) / (capAt - jumpAt));
}

const sampleId = (tenantId: string, entity: string, at: Date) => `sim_${createHash("sha256").update(`${tenantId}:${entity}:${at.toISOString()}`).digest("hex").slice(0, 24)}`;

/** The series of one scenario (pure; nothing is written). */
export function simulateSpend(input: SimInput): { daily: SimDailyRow[]; samples: SimSampleRow[] } {
  if (!SIM_SCENARIOS.includes(input.scenario)) throw new RangeError(`Unknown scenario ${String(input.scenario)}`);
  if (input.adSets.length === 0) throw new RangeError("Give at least one ad set.");
  const rand = prng(input.seed ?? 1);
  const days = input.days ?? 7;
  const step = (input.sampleEveryMin ?? 15) * 60_000;
  const today = dayKey(input.now, input.timezone);
  const accountScopeId = input.accountScopeId ?? input.adAccountAssetId;
  const daily: SimDailyRow[] = [];
  const samples: SimSampleRow[] = [];
  const row = (scopeType: "account" | "adset", scopeId: string, day: string, p: Point): SimDailyRow => ({
    tenantId: input.tenantId,
    pot: "ads",
    scopeType,
    scopeId,
    day,
    currency: input.currency,
    amountMinor: p.spend,
    origin: scopeType === "account" ? "all" : "platform",
    results: p.results,
    impressions: p.impressions,
    clicks: p.clicks,
    source: "sim",
    syncedAt: input.now,
  });
  const sum = (ps: Point[]): Point => ps.reduce((a, b) => ({ spend: a.spend + b.spend, impressions: a.impressions + b.impressions, clicks: a.clicks + b.clicks, results: a.results + b.results }), { spend: 0n, impressions: 0n, clicks: 0n, results: 0 });

  // History: full days.
  for (let back = days; back >= 1; back--) {
    const day = addDays(today, -back);
    const points = input.adSets.map((s) => {
      const p = metricsFor(frac(s.dailyBudgetMinor, 0.85 + rand() * 0.15), input.scenario);
      daily.push(row("adset", s.metaId, day, p));
      return p;
    });
    daily.push(row("account", accountScopeId, day, sum(points)));
  }

  // Today: cumulative samples from local midnight up to now.
  const start = startOfLocalDay(today, input.timezone).getTime();
  const end = input.now.getTime();
  const dayMs = startOfLocalDay(addDays(today, 1), input.timezone).getTime() - start;
  const bases = input.adSets.map(() => 0.85 + rand() * 0.15);
  let lastBySet: Point[] = input.adSets.map(() => ({ spend: 0n, impressions: 0n, clicks: 0n, results: 0 }));
  for (let t = start + step; t <= end; t += step) {
    const at = new Date(t);
    const f = Math.min(1, (t - start) / dayMs);
    const lastHour = input.scenario === "cpm_spike" && end - t < 3_600_000;
    lastBySet = input.adSets.map((s, i) => {
      const prev = lastBySet[i];
      if (lastHour) {
        // 1,500 impressions over the hour (375 a sample) at 3x CPM and a quarter of the CTR.
        const imp = 375n;
        const spend = (imp * CPM_MINOR * 3n) / 1000n;
        const clicks = (imp * (CTR_BPS / 4n)) / 10_000n;
        return { spend: prev.spend + spend, impressions: prev.impressions + imp, clicks: prev.clicks + clicks, results: prev.results };
      }
      const cumulative = todayCurve(input.scenario, s.dailyBudgetMinor, f, bases[i]);
      const p = metricsFor(cumulative > prev.spend ? cumulative : prev.spend, input.scenario);
      return { ...p, results: Math.max(prev.results, p.results) };
    });
    input.adSets.forEach((s, i) => {
      const p = lastBySet[i];
      samples.push({ id: sampleId(input.tenantId, s.metaId, at), tenantId: input.tenantId, adAccountAssetId: input.adAccountAssetId, entityType: "adset", entityMetaId: s.metaId, accountDate: today, sampledAt: at, spendMinor: p.spend, impressions: p.impressions, clicks: p.clicks, results: p.results });
    });
    const acc = sum(lastBySet);
    samples.push({ id: sampleId(input.tenantId, accountScopeId, at), tenantId: input.tenantId, adAccountAssetId: input.adAccountAssetId, entityType: "account", entityMetaId: accountScopeId, accountDate: today, sampledAt: at, spendMinor: acc.spend, impressions: acc.impressions, clicks: acc.clicks, results: acc.results });
  }
  input.adSets.forEach((s, i) => daily.push(row("adset", s.metaId, today, lastBySet[i])));
  daily.push(row("account", accountScopeId, today, sum(lastBySet)));
  return { daily, samples };
}

/** SET, never incremented: Meta revises spend for up to 28 days, and a re-run replaces the series. */
export const SPEND_DAILY_UPSERT_SQL = `INSERT INTO "SpendDaily" ("tenantId","pot","scopeType","scopeId","day","currency","amountMinor","origin","results","impressions","clicks","source","syncedAt")
VALUES ($1,'ads',$2,$3,$4::date,$5,$6,$7,$8,$9,$10,'sim',$11)
ON CONFLICT ("tenantId","pot","scopeType","scopeId","day","origin")
DO UPDATE SET "amountMinor" = EXCLUDED."amountMinor", "results" = EXCLUDED."results", "impressions" = EXCLUDED."impressions",
              "clicks" = EXCLUDED."clicks", "currency" = EXCLUDED."currency", "source" = 'sim', "syncedAt" = EXCLUDED."syncedAt"`;

/** Deterministic ids, so a re-run replaces today's samples instead of adding more. */
export const SAMPLE_UPSERT_SQL = `INSERT INTO "IntradaySpendSample" ("id","tenantId","adAccountAssetId","entityType","entityMetaId","accountDate","sampledAt","spendMinor","impressions","clicks","results")
VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11)
ON CONFLICT ("id") DO UPDATE SET "spendMinor" = EXCLUDED."spendMinor", "impressions" = EXCLUDED."impressions", "clicks" = EXCLUDED."clicks", "results" = EXCLUDED."results"`;

/** The parameters of SPEND_DAILY_UPSERT_SQL and SAMPLE_UPSERT_SQL for one row. */
export const dailyParams = (r: SimDailyRow): unknown[] => [r.tenantId, r.scopeType, r.scopeId, r.day, r.currency, r.amountMinor.toString(), r.origin, r.results, r.impressions.toString(), r.clicks.toString(), r.syncedAt];
export const sampleParams = (s: SimSampleRow): unknown[] => [s.id, s.tenantId, s.adAccountAssetId, s.entityType, s.entityMetaId, s.accountDate, s.sampledAt, s.spendMinor.toString(), s.impressions.toString(), s.clicks.toString(), s.results];

// ===== CLI =====

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
}
const all = (args: string[], name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile?.(".env");
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log("Usage: spend-sim --tenant <id> --account <MetaAsset id> --scenario normal|runaway|zero_lead|cpm_spike [--days 7] [--adset <metaAdSetId>:<dailyBudgetMinor>]... [--seed 1] [--account-scope-id <id>] [--dry-run]");
    return;
  }
  if ((process.env.NODE_ENV ?? "") === "production" && process.env.SPEND_SIM !== "1") throw new Error("Refusing to simulate spend in production without SPEND_SIM=1.");
  const tenantId = arg(args, "tenant");
  const assetId = arg(args, "account");
  const scenario = arg(args, "scenario") as SimScenario | undefined;
  if (!tenantId || !assetId || !scenario || !SIM_SCENARIOS.includes(scenario)) throw new Error("Give --tenant, --account and --scenario (normal, runaway, zero_lead or cpm_spike).");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (put it in .env or the environment).");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const asset = (await client.query(`SELECT "id","type","sandbox","meta" FROM "MetaAsset" WHERE "id" = $1 AND "tenantId" = $2`, [assetId, tenantId])).rows[0];
    if (!asset || asset.type !== "ad_account") throw new Error("That ad account does not belong to this workspace.");
    if (asset.sandbox !== true) throw new Error("This ad account is not marked as a test ad account (MetaAsset.sandbox). spend-sim only writes for test ad accounts.");
    const meta = (asset.meta ?? {}) as { currency?: string; timezone?: string };
    let adSets: SimAdSet[] = all(args, "adset").map((s) => {
      const [metaId, budget] = s.split(":");
      if (!metaId || !/^\d+$/.test(budget ?? "")) throw new Error(`--adset must look like <metaAdSetId>:<dailyBudgetMinor>, got ${s}`);
      return { metaId, dailyBudgetMinor: BigInt(budget) };
    });
    if (adSets.length === 0) {
      const rows = (
        await client.query(
          `SELECT "metaObjectId", COALESCE("dailyBudgetMinor", 0)::text AS d FROM "SpendCommitment"
           WHERE "tenantId" = $1 AND "adAccountAssetId" = $2 AND "status" <> 'stopped' AND "objectLevel" = 'adset' AND "dailyBudgetMinor" IS NOT NULL`,
          [tenantId, assetId],
        )
      ).rows as { metaObjectId: string; d: string }[];
      adSets = rows.map((r) => ({ metaId: r.metaObjectId, dailyBudgetMinor: BigInt(r.d) }));
    }
    if (adSets.length === 0) throw new Error("No open ad set commitments on this account. Pass --adset <metaAdSetId>:<dailyBudgetMinor>.");
    const { daily, samples } = simulateSpend({
      scenario,
      tenantId,
      adAccountAssetId: assetId,
      accountScopeId: arg(args, "account-scope-id"),
      adSets,
      currency: meta.currency ?? "INR",
      timezone: meta.timezone ?? "Asia/Kolkata",
      days: Number(arg(args, "days") ?? 7),
      seed: Number(arg(args, "seed") ?? 1),
      now: new Date(),
    });
    if (args.includes("--dry-run")) {
      console.log(`Would write ${daily.length} SpendDaily rows and ${samples.length} IntradaySpendSample rows (${scenario}).`);
      return;
    }
    await client.query("BEGIN");
    for (const r of daily) await client.query(SPEND_DAILY_UPSERT_SQL, dailyParams(r));
    for (const s of samples) await client.query(SAMPLE_UPSERT_SQL, sampleParams(s));
    await client.query("COMMIT");
    console.log(`Wrote ${daily.length} SpendDaily rows and ${samples.length} IntradaySpendSample rows (${scenario}) for ${assetId}.`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

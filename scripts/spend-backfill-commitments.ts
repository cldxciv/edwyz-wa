/**
 * Commitments backfill (docs/SPEND-CONTROLS-SPEC.md 3.2 note 4, 11 train 1 step 3). Every DB-active AdCampaign (and every ad
 * set under it that is not archived) without an open SpendCommitment becomes a `live` commitment at its DB budget, in the
 * ad account's time zone (MetaAsset.meta.timezone, then SpendControl.timezone, then Asia/Kolkata), with today's peak and the
 * week's peak at the current budget. Campaigns whose end date has passed can no longer spend and are left out.
 *
 * Run it right after 0009 is applied and BEFORE the train 1 build serves traffic, so the first request on the new code already
 * sees every running campaign as committed. It is idempotent: it only adds rows for objects with no open commitment (the
 * partial unique index makes a second run a no-op), and the book counts any DB-active campaign it missed (the orphan rule).
 *
 * Run (the same esbuild pattern as eval:eddy; esbuild resolves the @/ paths from tsconfig):
 *   npx esbuild scripts/spend-backfill-commitments.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/edwyz-backfill/backfill.mjs
 *   node node_modules/.cache/edwyz-backfill/backfill.mjs [--dry-run] [--tenant <tenantId>]
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { prisma } from "@/lib/db";
import { loadAdAccounts, loadOrphans, OPEN_STATUSES, toBookCommitment, type BookCommitment } from "@/lib/spend/commitments";
import { controlDefaults, toControlState, type SpendControlState, type SpendDb } from "@/lib/spend/control";
import { dayKeyToDate } from "@/lib/spend/periods";

export type BackfillOptions = {
  db?: SpendDb;
  now?: Date;
  /** Only this workspace (default: every workspace with an active campaign). */
  tenantId?: string;
  /** Plan only; write nothing. */
  dryRun?: boolean;
  log?: (message: string) => void;
};

export type BackfillRow = Pick<
  BookCommitment,
  "tenantId" | "adAccountAssetId" | "campaignId" | "adSetId" | "metaObjectId" | "objectLevel" | "origin" | "currency" | "timezone" | "dailyBudgetMinor" | "lifetimeBudgetMinor" | "dayKey" | "weekStart" | "peakDailyBudgetMinor" | "endsAt"
>;

export type BackfillResult = { tenants: number; planned: number; created: number; skipped: number; rows: BackfillRow[] };

/** The workspace's control row without creating it (a dry run writes nothing). */
async function readControl(tenantId: string, db: SpendDb): Promise<SpendControlState> {
  const row = (await db.spendControl.findUnique({ where: { tenantId } })) as Record<string, unknown> | null;
  if (row) return toControlState(row);
  const d = await controlDefaults(tenantId, db);
  return toControlState({ tenantId, freeze: "none", probation: "auto", timezone: d.timezone, spendingAdAccountAssetId: d.spendingAdAccountAssetId, approverUserIds: [], approvalTtlHours: 12, version: 1 });
}

/** The live commitments one workspace is missing (pure planning on top of the DB reads). */
export async function planTenantBackfill(tenantId: string, db: SpendDb, now: Date): Promise<BookCommitment[]> {
  const control = await readControl(tenantId, db);
  const accounts = await loadAdAccounts(tenantId, control, db);
  const open = (((await db.spendCommitment.findMany({ where: { tenantId, status: { in: [...OPEN_STATUSES] } } })) ?? []) as Record<string, unknown>[]).map(toBookCommitment);
  return loadOrphans(tenantId, open, accounts, control, now, db);
}

/** Turns every DB-active campaign without an open commitment into live commitments. Returns what it planned and wrote. */
export async function backfillCommitments(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((m: string) => console.log(m));
  const tenants = opts.tenantId
    ? [opts.tenantId]
    : [...new Set((((await db.adCampaign.findMany({ where: { status: "active" }, select: { tenantId: true } })) ?? []) as { tenantId: string }[]).map((r) => r.tenantId))];
  const result: BackfillResult = { tenants: tenants.length, planned: 0, created: 0, skipped: 0, rows: [] };
  for (const tenantId of tenants) {
    const planned = await planTenantBackfill(tenantId, db, now);
    result.planned += planned.length;
    for (const c of planned) {
      result.rows.push({
        tenantId: c.tenantId,
        adAccountAssetId: c.adAccountAssetId,
        campaignId: c.campaignId,
        adSetId: c.adSetId,
        metaObjectId: c.metaObjectId,
        objectLevel: c.objectLevel,
        origin: c.origin,
        currency: c.currency,
        timezone: c.timezone,
        dailyBudgetMinor: c.dailyBudgetMinor,
        lifetimeBudgetMinor: c.lifetimeBudgetMinor,
        dayKey: c.dayKey,
        weekStart: c.weekStart,
        peakDailyBudgetMinor: c.peakDailyBudgetMinor,
        endsAt: c.endsAt,
      });
      if (opts.dryRun) continue;
      const { count } = await db.spendCommitment.createMany({
        data: [
          {
            tenantId: c.tenantId,
            adAccountAssetId: c.adAccountAssetId,
            campaignId: c.campaignId,
            adSetId: c.adSetId,
            metaObjectId: c.metaObjectId,
            objectLevel: c.objectLevel,
            origin: c.origin,
            assistantKey: c.assistantKey,
            currency: c.currency,
            timezone: c.timezone,
            dailyBudgetMinor: c.dailyBudgetMinor,
            lifetimeBudgetMinor: c.lifetimeBudgetMinor,
            dayKey: c.dayKey ? dayKeyToDate(c.dayKey) : null,
            dayStartBudgetMinor: c.dayStartBudgetMinor,
            peakDailyBudgetMinor: c.peakDailyBudgetMinor,
            weekStart: c.weekStart ? dayKeyToDate(c.weekStart) : null,
            weekPeakDailyBudgetMinor: c.weekPeakDailyBudgetMinor,
            startsAt: c.startsAt,
            endsAt: c.endsAt,
            status: "live",
            sandbox: c.sandbox,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 1) result.created++;
      else result.skipped++;
    }
  }
  log(`${opts.dryRun ? "Would add" : "Added"} ${opts.dryRun ? result.planned : result.created} live commitments for ${result.tenants} workspaces${result.skipped ? ` (${result.skipped} already had one)` : ""}.`);
  return result;
}

// ===== CLI =====

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile?.(".env");
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: spend-backfill-commitments [--dry-run] [--tenant <tenantId>]");
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (put it in .env or the environment).");
  try {
    await backfillCommitments({ dryRun: args.includes("--dry-run"), tenantId: arg(args, "tenant") });
  } finally {
    await prisma.$disconnect();
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

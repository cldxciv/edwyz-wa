import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { decimalToMinor } from "./insights-money";
import { entityIdOf, type InsightLevel, type RawInsightRow } from "./insights-fetch";
import { normalizeRanking, parseCount, pickResults } from "./insights-map";

export type SnapshotData = {
  tenantId: string;
  entityType: InsightLevel;
  entityMetaId: string;
  date: Date;
  spendMinor: number;
  impressions: number;
  clicks: number;
  results: number;
  frequency: number | null;
  qualityRanking: string | null;
  raw: Record<string, unknown>;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Maps one Graph row to a snapshot, or null when the row has no usable id, date or spend. Spend is converted with integer arithmetic. */
export function toSnapshot(tenantId: string, level: InsightLevel, row: RawInsightRow, exponent: number): SnapshotData | null {
  const id = entityIdOf(level, row);
  if (!id || !row.date_start || !YMD.test(row.date_start)) return null;
  const { results, actionType } = pickResults(row.objective, row.actions);
  const freq = Number(row.frequency);
  let spendMinor = 0;
  try {
    spendMinor = decimalToMinor(row.spend, exponent);
  } catch {
    return null;
  }
  return {
    tenantId,
    entityType: level,
    entityMetaId: id,
    date: new Date(`${row.date_start}T00:00:00.000Z`),
    spendMinor,
    impressions: parseCount(row.impressions),
    clicks: parseCount(row.clicks),
    results,
    frequency: Number.isFinite(freq) && freq > 0 ? Math.round(freq * 100) / 100 : null,
    qualityRanking: level === "ad" ? normalizeRanking(row.quality_ranking) : null,
    raw: { objective: row.objective ?? null, resultAction: actionType, campaignId: row.campaign_id ?? null, adSetId: row.adset_id ?? null },
  };
}

const CHUNK = 25;

/** Idempotent: re-running the same window overwrites the same rows by (tenantId, entityType, entityMetaId, date). */
export async function upsertSnapshots(items: SnapshotData[]): Promise<number> {
  for (let i = 0; i < items.length; i += CHUNK) {
    await Promise.all(
      items.slice(i, i + CHUNK).map((d) => {
        const { tenantId, entityType, entityMetaId, date, raw, ...rest } = d;
        const values = { ...rest, raw: raw as Prisma.InputJsonObject };
        return prisma.insightSnapshot.upsert({
          where: { tenantId_entityType_entityMetaId_date: { tenantId, entityType, entityMetaId, date } },
          create: { tenantId, entityType, entityMetaId, date, ...values },
          update: values,
        });
      }),
    );
  }
  return items.length;
}

export type AccountState = { backfilledAt?: string; backoffUntil?: string };
export type SyncState = { lastSyncAt?: string; lastManualAt?: string; lastError?: string | null; accounts: Record<string, AccountState> };

const stateKey = (tenantId: string) => `ads:insights:state:${tenantId}`;

export async function loadState(tenantId: string): Promise<SyncState> {
  const row = await prisma.platformSetting.findUnique({ where: { key: stateKey(tenantId) } });
  const v = (row?.value ?? {}) as Partial<SyncState>;
  return { ...v, accounts: v.accounts ?? {} };
}

export async function patchState(tenantId: string, patch: (s: SyncState) => void): Promise<SyncState> {
  const state = await loadState(tenantId);
  patch(state);
  await prisma.platformSetting.upsert({
    where: { key: stateKey(tenantId) },
    create: { key: stateKey(tenantId), value: state as object },
    update: { value: state as object },
  });
  return state;
}

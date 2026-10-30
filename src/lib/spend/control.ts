/**
 * The per-workspace control row (SpendControl, docs/SPEND-CONTROLS-SPEC.md 3.2, invariant I11) and small helpers the other
 * Spend Book modules share.
 *
 * I11: a missing row means the safe default, never "no limits". getControl() creates the row on first read with freeze `none`,
 * probation `auto`, the time zone of the active ad account, then RoutingConfig, then Asia/Kolkata, and the spending ad account
 * when the workspace has exactly one active ad account. The insert is ON CONFLICT DO NOTHING, so two first readers never clash
 * and it is safe inside a caller's transaction.
 *
 * approverUserIds are pruned on read to people who are still admins (or the owner) of the workspace (7.3): someone who lost
 * the role can never approve, even before the membership code removes them from the list.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { appendOutcome, appendRequest, type LedgerDb } from "./ledger";
import { DEFAULT_TIMEZONE, isValidTimeZone } from "./periods";
import type { FreezeLevel, FrozenByKind, LedgerRowInput, ProbationSetting, SpendActor } from "./types";

/** A Prisma client or an interactive-transaction client. */
export type SpendDb = Prisma.TransactionClient;

/** Ledger rows about the whole platform (FX, platform ceilings, the platform switch) carry this workspace id. */
export const PLATFORM_LEDGER_TENANT = "*";

export type SpendControlState = {
  tenantId: string;
  freeze: FreezeLevel;
  frozenByKind: FrozenByKind | null;
  frozenByUserId: string | null;
  frozenReason: string | null;
  frozenAt: Date | null;
  probation: ProbationSetting;
  probationReason: string | null;
  probationChangedByUserId: string | null;
  verifiedAt: Date | null;
  spendingAdAccountAssetId: string | null;
  /** Messaging and AI day and month keys, and the digest. Always a valid IANA zone. */
  timezone: string;
  /** Pruned to current admins (and the owner). */
  approverUserIds: string[];
  approvalTtlHours: number;
  targetCostPerLeadMinor: bigint | null;
  breakersMayPauseHumanCampaigns: boolean;
  digestEnabled: boolean;
  version: number;
  updatedAt: Date | null;
};

export type GetControlOptions = {
  db?: SpendDb;
  /** Prune approverUserIds to current admins (default true). */
  prune?: boolean;
};

const FREEZES: readonly FreezeLevel[] = ["none", "assistants", "all"];
const PROBATIONS: readonly ProbationSetting[] = ["auto", "lifted", "forced"];
const FROZEN_BY: readonly FrozenByKind[] = ["owner", "admin", "platform_admin", "breaker"];

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(v as number | string));
const date = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);

/** Maps a SpendControl row to the typed state, with every unknown value read as its safe default. */
export function toControlState(row: Record<string, unknown>): SpendControlState {
  const freeze = FREEZES.includes(row.freeze as FreezeLevel) ? (row.freeze as FreezeLevel) : "none";
  const probation = PROBATIONS.includes(row.probation as ProbationSetting) ? (row.probation as ProbationSetting) : "auto";
  const tz = typeof row.timezone === "string" && isValidTimeZone(row.timezone) ? row.timezone : DEFAULT_TIMEZONE;
  const ttl = Number(row.approvalTtlHours);
  return {
    tenantId: String(row.tenantId),
    freeze,
    frozenByKind: FROZEN_BY.includes(row.frozenByKind as FrozenByKind) ? (row.frozenByKind as FrozenByKind) : null,
    frozenByUserId: (row.frozenByUserId as string | null) ?? null,
    frozenReason: (row.frozenReason as string | null) ?? null,
    frozenAt: date(row.frozenAt),
    probation,
    probationReason: (row.probationReason as string | null) ?? null,
    probationChangedByUserId: (row.probationChangedByUserId as string | null) ?? null,
    verifiedAt: date(row.verifiedAt),
    spendingAdAccountAssetId: (row.spendingAdAccountAssetId as string | null) ?? null,
    timezone: tz,
    approverUserIds: Array.isArray(row.approverUserIds) ? (row.approverUserIds as unknown[]).filter((v): v is string => typeof v === "string") : [],
    approvalTtlHours: Number.isInteger(ttl) && ttl >= 1 && ttl <= 48 ? ttl : 12,
    targetCostPerLeadMinor: big(row.targetCostPerLeadMinor),
    breakersMayPauseHumanCampaigns: row.breakersMayPauseHumanCampaigns === true,
    digestEnabled: row.digestEnabled !== false,
    version: Number.isInteger(Number(row.version)) ? Number(row.version) : 1,
    updatedAt: date(row.updatedAt),
  };
}

/**
 * The defaults a new row gets (I11, the same order as the 0009 backfill): the time zone of the oldest active ad account, then
 * RoutingConfig.timezone, then Asia/Kolkata; the spending ad account only when there is exactly one active ad account.
 */
export async function controlDefaults(tenantId: string, db: SpendDb = prisma): Promise<{ timezone: string; spendingAdAccountAssetId: string | null }> {
  const accounts = ((await db.metaAsset.findMany({
    where: { tenantId, type: "ad_account", status: "active" },
    orderBy: { createdAt: "asc" },
    select: { id: true, meta: true, createdAt: true },
    take: 50,
  })) ?? []) as { id: string; meta: unknown; createdAt?: Date }[];
  const sorted = [...accounts].sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  const accountTz = sorted
    .map((a) => (a.meta && typeof a.meta === "object" ? (a.meta as { timezone?: unknown }).timezone : undefined))
    .find((tz): tz is string => isValidTimeZone(tz));
  let timezone = accountTz ?? null;
  if (!timezone) {
    const routing = (await db.routingConfig.findUnique({ where: { tenantId }, select: { timezone: true } })) as { timezone?: unknown } | null;
    timezone = isValidTimeZone(routing?.timezone) ? (routing!.timezone as string) : DEFAULT_TIMEZONE;
  }
  return { timezone, spendingAdAccountAssetId: accounts.length === 1 ? accounts[0].id : null };
}

/** Keeps only ids that are still admins or the owner of the workspace. */
export async function pruneApprovers(tenantId: string, ids: string[], db: SpendDb = prisma): Promise<string[]> {
  if (ids.length === 0) return [];
  const members = ((await db.membership.findMany({
    where: { tenantId, userId: { in: ids }, role: { in: ["admin", "owner"] } },
    select: { userId: true },
  })) ?? []) as { userId: string }[];
  const keep = new Set(members.map((m) => m.userId));
  return ids.filter((id, i) => keep.has(id) && ids.indexOf(id) === i);
}

/**
 * The workspace's SpendControl row, created with safe defaults when it does not exist yet (I11). Works on the app client or
 * inside a caller's transaction.
 */
export async function getControl(tenantId: string, opts: GetControlOptions = {}): Promise<SpendControlState> {
  if (!tenantId) throw new RangeError("getControl needs a workspace.");
  const db = opts.db ?? prisma;
  let row = (await db.spendControl.findUnique({ where: { tenantId } })) as Record<string, unknown> | null;
  if (!row) {
    const defaults = await controlDefaults(tenantId, db);
    await db.spendControl.createMany({
      data: [{ tenantId, freeze: "none", probation: "auto", timezone: defaults.timezone, spendingAdAccountAssetId: defaults.spendingAdAccountAssetId }],
      skipDuplicates: true,
    });
    row = (await db.spendControl.findUnique({ where: { tenantId } })) as Record<string, unknown> | null;
    if (!row) throw new Error("[spend] SpendControl row was neither created nor found");
  }
  const state = toControlState(row);
  if (opts.prune !== false) state.approverUserIds = await pruneApprovers(tenantId, state.approverUserIds, db);
  return state;
}

// ===== Shared helpers =====

type TxCapable = { $transaction?: <R>(fn: (tx: SpendDb) => Promise<R>, options?: { timeout?: number }) => Promise<R> };

/** Runs `fn` in a new transaction on the app client, or directly when `db` is already a transaction client. */
export async function inSpendTransaction<T>(db: SpendDb | undefined, fn: (tx: SpendDb) => Promise<T>): Promise<T> {
  const client = (db ?? prisma) as unknown as TxCapable;
  if (typeof client.$transaction === "function") return client.$transaction((tx) => fn(tx));
  return fn((db ?? prisma) as SpendDb);
}

/**
 * Applies a change and writes its `requested` ledger row in one transaction, then the `applied` outcome. `run` returns the
 * row to ledger (or null for a no-op, which writes nothing). Returns the correlationId of the pair.
 */
export async function applyLedgered<T>(
  db: SpendDb | undefined,
  run: (tx: SpendDb) => Promise<{ result: T; row: LedgerRowInput | null }>,
): Promise<{ result: T; correlationId: string | null }> {
  const done = await inSpendTransaction(db, async (tx) => {
    const out = await run(tx);
    if (!out.row) return { result: out.result, row: null, correlationId: null as string | null };
    const { record } = await appendRequest(tx as unknown as LedgerDb, out.row);
    return { result: out.result, row: out.row, correlationId: record.correlationId };
  });
  if (done.row && done.correlationId) {
    // The unique index is per (tenant, key, phase), so the outcome may carry the request's idempotency key.
    await appendOutcome(done.correlationId, { ...done.row, phase: "applied" }, { db: (db ?? prisma) as unknown as LedgerDb });
  }
  return { result: done.result, correlationId: done.correlationId };
}

/** Only a platform admin may change platform ceilings, new-workspace limits, FX and probation (8.3). */
export function requirePlatformAdmin(actor: SpendActor): asserts actor is Extract<SpendActor, { type: "platform_admin" }> {
  if (actor.type !== "platform_admin") throw new HttpError(403, "Only Edwyz support can change this.");
}

/** A required plain-language reason, trimmed and bounded. */
export function requireReason(reason: string | null | undefined, fallback?: string): string {
  const text = (reason ?? "").trim() || (fallback ?? "").trim();
  if (!text) throw new HttpError(400, "Add a short reason for this change.");
  return text.slice(0, 500);
}

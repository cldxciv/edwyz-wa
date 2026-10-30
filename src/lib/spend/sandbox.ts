/**
 * Sandbox ad accounts (docs/SPEND-CONTROLS-SPEC.md 3.3, 5.7, 10.5). A Meta sandbox ad account (MetaAsset.sandbox) delivers
 * nothing. Wall (a) is never written for it (mode `sandbox`), every ledger row and commitment about it is flagged
 * `sandbox = true` so reports and the digest can leave test money out, and with SPEND_SIM=1 its spend comes from the
 * simulator (scripts/spend-sim.ts) instead of Meta.
 */
import { prisma } from "@/lib/db";
import type { SpendDb } from "./control";
import { spendDryRun, spendSim } from "./flags";

type Env = Record<string, string | undefined>;

/** True for a MetaAsset (or anything with its `sandbox` column) marked as a Meta test ad account. Never throws. */
export function isSandboxAccount(asset: { sandbox?: unknown } | null | undefined): boolean {
  return asset?.sandbox === true;
}

/** Whether the ad account is a sandbox account. A missing asset is not a sandbox (the safe reading for counting). */
export async function sandboxFlagFor(tenantId: string, adAccountAssetId: string | null | undefined, db: SpendDb = prisma): Promise<boolean> {
  if (!tenantId || !adAccountAssetId) return false;
  const asset = (await db.metaAsset.findFirst({ where: { id: adAccountAssetId, tenantId }, select: { sandbox: true } })) as { sandbox?: unknown } | null;
  return isSandboxAccount(asset);
}

/** The same row with the sandbox flag set when it is about a sandbox account (ledger rows, commitments). */
export function flagSandbox<T extends Record<string, unknown>>(row: T, sandbox: boolean): T & { sandbox: boolean } {
  return { ...row, sandbox: sandbox || row.sandbox === true };
}

/**
 * Whether a Meta write for this guard may be faked instead of sent (4.8): SPEND_DRY_RUN=1 outside production, or a sandbox
 * account with SPEND_SIM=1.
 */
export function fakeMetaWrites(sandbox: boolean, env: Env = process.env): boolean {
  return spendDryRun(env) || (sandbox && spendSim(env));
}

/** The ledger reason code every sandbox row carries. */
export const SANDBOX_REASON_CODE = "sandbox";

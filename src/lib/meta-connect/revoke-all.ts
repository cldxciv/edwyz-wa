import { stopCommitments } from "@/lib/ads/stop";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import type { Actor } from "@/lib/tenancy";
import { disconnect } from "./service";

const MAX_PER_RUN = 200;

/** `deferred` is only set by revokeAllConnections: connections kept on purpose because a live campaign still needs their token. */
export type BulkResult = { done: number; failed: number; deferred?: number };

const systemActor = (tenantId: string, userId: string): Actor => ({ userId, tenantId, role: "admin" });
/** How the Spend Book records these pauses (docs/SPEND-CONTROLS-SPEC.md 4.8): a system job, never a person. */
const STOP_ACTOR = { type: "system", job: "meta-connect.revoke-all" } as const;

/**
 * Flags a campaign that could not be paused. The audit row is written once per campaign (not on every 15 minute retry),
 * and the campaign row carries the message so the owner sees it. Never throws.
 */
async function flagPauseFailure(tenantId: string, userId: string, id: string): Promise<void> {
  try {
    const already = await prisma.auditLog.findFirst({ where: { tenantId, action: "ads.campaign.pause_failed", target: id }, select: { id: true } });
    if (already) return;
  } catch {
    // Cannot tell whether it was flagged; write the row rather than lose the signal.
  }
  await audit({ tenantId, userId, action: "ads.campaign.pause_failed", target: id, meta: { reason: "workspace_inactive" } }).catch(() => undefined);
  try {
    await prisma.adCampaign.updateMany({
      where: { id, tenantId, status: "active" },
      data: { lastError: "Could not pause on Meta while the workspace is inactive. Pause it in Meta Ads Manager." },
    });
  } catch {
    // The audit row is the durable flag.
  }
}

/**
 * Pauses everything of a workspace that can still spend on Meta, through the Spend Book's stopCommitments (whole campaigns at
 * campaign level, every pause ledgered, never refused). Never throws: each campaign that could not be paused (Meta failed, or
 * its connection can no longer give a token) is counted as failed and audited once, and it stays counted against the limits.
 * A campaign that is already paused or gone is simply not selected. Call this before revokeAllConnections, because pausing
 * needs the Meta token that revoking deletes.
 */
export async function pauseAllCampaigns(tenantId: string, userId: string): Promise<BulkResult> {
  const stop = await stopCommitments(tenantId, { origin: "all" }, STOP_ACTOR, "Paused before the Meta connections are removed.").catch(() => null);
  if (!stop) return { done: 0, failed: 1 };
  const flagged = new Set<string>();
  for (const item of stop.items) {
    if ((item.result !== "failed" && item.result !== "unreachable") || flagged.has(item.campaignId)) continue;
    flagged.add(item.campaignId);
    await flagPauseFailure(tenantId, userId, item.campaignId);
  }
  return { done: stop.done, failed: stop.failed + stop.unreachable };
}

/**
 * Connection ids whose token is still needed because a campaign launched through one of their ad accounts is active on Meta.
 * Returns null when this cannot be determined, which callers treat as "keep every connection".
 */
async function connectionsInUse(tenantId: string): Promise<Set<string> | null> {
  try {
    const live = await prisma.adCampaign.findMany({ where: { tenantId, status: "active", metaCampaignId: { not: null } }, select: { adAccountAssetId: true }, take: MAX_PER_RUN });
    if (!live.length) return new Set();
    const assets = await prisma.metaAsset.findMany({ where: { tenantId, id: { in: [...new Set(live.map((c) => c.adAccountAssetId))] } }, select: { connectionId: true } });
    return new Set(assets.map((a) => a.connectionId));
  } catch {
    return null;
  }
}

/**
 * Disconnects every Meta connection of a workspace through the normal disconnect service (Meta revoke is best effort there,
 * tokens are deleted whatever Meta answers). Never throws. Connections already revoked are not selected, so it is idempotent.
 *
 * A connection that backs a campaign which is still active (its pause failed) is NOT revoked: revoking deletes the token, after
 * which that campaign could never be paused and would keep spending. Those are reported as `deferred`; the periodic sweep
 * (pauseAdsForBlockedTenants) pauses the campaign and calls this again once none are left.
 */
export async function revokeAllConnections(tenantId: string, userId: string): Promise<BulkResult> {
  const result: BulkResult = { done: 0, failed: 0, deferred: 0 };
  let ids: { id: string }[] = [];
  try {
    ids = await prisma.metaConnection.findMany({ where: { tenantId, status: { not: "revoked" } }, select: { id: true }, take: MAX_PER_RUN });
  } catch {
    return { done: 0, failed: 1, deferred: 0 };
  }
  if (!ids.length) return result;
  const inUse = await connectionsInUse(tenantId);
  const actor = systemActor(tenantId, userId);
  for (const { id } of ids) {
    if (inUse === null || inUse.has(id)) {
      result.deferred = (result.deferred ?? 0) + 1;
      continue;
    }
    try {
      await disconnect(actor, id);
      result.done++;
    } catch {
      result.failed++;
      await audit({ tenantId, userId, action: "meta_connect.disconnect_failed", target: id, meta: { reason: "workspace_inactive" } }).catch(() => undefined);
    }
  }
  return result;
}

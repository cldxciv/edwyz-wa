import { stopCommitments } from "@/lib/ads/stop";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { disconnect } from "@/lib/meta-connect/service";
import { blockedState, type Blocked } from "@/lib/tenant-lifecycle-state";
import type { Actor } from "@/lib/tenancy";

export { blockedState, type Blocked } from "@/lib/tenant-lifecycle-state";

const MAX_PER_RUN = 200;
const SYSTEM_USER = "system:tenant-state";
/** The Spend Book's actor for pauses made because the workspace is locked, suspended or closing (docs/SPEND-CONTROLS-SPEC.md 4.8, 4.17). */
const STOP_ACTOR = { type: "system", job: "tenant-state" } as const;
const STOP_REASON = "Paused because the workspace is locked, suspended or closing.";
const USABLE_CONNECTION = new Set(["active", "expiring"]);
/** A failure that is still current is not audited again within this time, even if its message on the campaign was overwritten. */
const REFLAG_AFTER_MS = 24 * 3_600_000;
const SWEEP_PAGE = 500;
const SWEEP_PAGES = 10;

export type PauseResult = { done: number; failed: number; unreachable: number };
export type WindDownResult = { paused: number; pauseFailed: number; unreachable: number; revoked: number; revokeFailed: number; deferred: number };

type FailureState = "pause_failed" | "pause_unreachable";

const FAILURE_TEXT: Record<FailureState, string> = {
  pause_failed: "Could not pause on Meta while the workspace is inactive. Pause it in Meta Ads Manager.",
  pause_unreachable: "The Meta connection for this campaign is no longer usable, so it could not be paused. Pause it in Meta Ads Manager.",
};

/**
 * One audit row per campaign and failure state, however many sweeps run: a campaign that cannot be paused for a transient reason
 * and one whose connection is gone are two distinct states. The campaign row carries the message so the owner sees it, and that
 * message is also the marker for "this failure is already flagged": while it is there nothing is written. The sweep clears it when
 * the workspace is allowed again (clearStaleFlags), so a later suspend or lock is a new episode and is flagged again. If the message
 * was overwritten by something else, an audit row from the last 24 hours still prevents a second row. Never throws.
 */
async function flagFailure(tenantId: string, id: string, state: FailureState, lastError?: string | null): Promise<void> {
  const text = FAILURE_TEXT[state];
  if (lastError === text) return;
  const action = `ads.campaign.${state}`;
  try {
    const recent = await prisma.auditLog.findFirst({ where: { tenantId, action, target: id, createdAt: { gte: new Date(Date.now() - REFLAG_AFTER_MS) } }, select: { id: true } });
    if (recent) return;
  } catch {
    // Cannot tell whether it was flagged; write the row rather than lose the signal.
  }
  await audit({ tenantId, userId: SYSTEM_USER, action, target: id, meta: { reason: "workspace_inactive" } });
  try {
    await prisma.adCampaign.updateMany({ where: { id, tenantId, status: "active" }, data: { lastError: text } });
  } catch {
    // The audit row is the durable flag.
  }
}

/** Removes our own failure messages from campaigns of workspaces that are usable again, so a later episode is flagged afresh. */
async function clearStaleFlags(tenantIds: string[]): Promise<void> {
  if (!tenantIds.length) return;
  try {
    await prisma.adCampaign.updateMany({ where: { tenantId: { in: tenantIds }, status: "active", lastError: { in: Object.values(FAILURE_TEXT) } }, data: { lastError: null } });
  } catch {
    // The next sweep tries again.
  }
}

/** Ad account asset id -> its connection id, for assets whose Meta connection can still produce a token. Null when this cannot be determined. */
async function usableAssets(tenantId: string, assetIds: string[]): Promise<Map<string, string> | null> {
  try {
    const assets = await prisma.metaAsset.findMany({
      where: { tenantId, id: { in: assetIds } },
      select: { id: true, connectionId: true, status: true, connection: { select: { tenantId: true, status: true, tokenEnc: true, tokenExpiresAt: true } } },
    });
    const now = Date.now();
    return new Map(
      assets
        .filter((a) => {
          const c = a.connection;
          const lapsed = c.tokenExpiresAt != null && c.tokenExpiresAt.getTime() <= now;
          return a.status === "active" && c.tenantId === tenantId && USABLE_CONNECTION.has(c.status) && !lapsed && !!c.tokenEnc;
        })
        .map((a) => [a.id, a.connectionId] as [string, string]),
    );
  } catch {
    return null;
  }
}

/**
 * Pauses everything of a workspace that can still spend on Meta, through the Spend Book's stopCommitments (whole campaigns at
 * campaign level, each pause ledgered, never refused). Never throws. A campaign whose connection can no longer give a token is
 * not called at all (nothing could succeed) and is flagged once; one that failed for another reason is flagged once and tried
 * again on the next sweep. Either way it stays counted against the limits until it is paused. A campaign that is already
 * paused, or never reached Meta, is not selected.
 */
export async function pauseTenantAds(tenantId: string, userId: string = SYSTEM_USER): Promise<PauseResult> {
  void userId;
  const stop = await stopCommitments(tenantId, { origin: "all" }, STOP_ACTOR, STOP_REASON).catch(() => null);
  if (!stop) return { done: 0, failed: 1, unreachable: 0 };
  const flagged = new Set<string>();
  for (const item of stop.items) {
    if (item.result !== "failed" && item.result !== "unreachable") continue;
    if (flagged.has(item.campaignId)) continue;
    flagged.add(item.campaignId);
    await flagFailure(tenantId, item.campaignId, item.result === "unreachable" ? "pause_unreachable" : "pause_failed", item.lastError);
  }
  return { done: stop.done, failed: stop.failed, unreachable: stop.unreachable };
}

/** Connection ids whose token a live campaign can still use to be paused. Null when this cannot be determined (callers then keep every connection). */
async function connectionsInUse(tenantId: string): Promise<Set<string> | null> {
  try {
    const live = await prisma.adCampaign.findMany({ where: { tenantId, status: "active", metaCampaignId: { not: null } }, select: { adAccountAssetId: true }, take: MAX_PER_RUN });
    if (!live.length) return new Set();
    if (live.length >= MAX_PER_RUN) return null;
    const usable = await usableAssets(tenantId, [...new Set(live.map((c) => c.adAccountAssetId))]);
    if (!usable) return null;
    // A campaign whose connection is already unusable cannot be paused with that token, so it does not keep the connection alive.
    return new Set(live.map((c) => usable.get(c.adAccountAssetId)).filter((id): id is string => !!id));
  } catch {
    return null;
  }
}

/** Audited once per connection per 24 hours, not once per sweep. Never throws. */
async function flagDisconnectFailure(tenantId: string, userId: string, id: string): Promise<void> {
  const action = "meta_connect.disconnect_failed";
  try {
    const recent = await prisma.auditLog.findFirst({ where: { tenantId, action, target: id, createdAt: { gte: new Date(Date.now() - REFLAG_AFTER_MS) } }, select: { id: true } });
    if (recent) return;
  } catch {
    // Cannot tell; write the row rather than lose the signal.
  }
  await audit({ tenantId, userId, action, target: id, meta: { reason: "workspace_inactive" } }).catch(() => undefined);
}

type RevokeResult = { done: number; failed: number; deferred: number };

/**
 * Disconnects (through the normal disconnect service: Meta revoke is best effort, the token is deleted whatever Meta answers)
 * every Meta connection that no live campaign can still use to be paused. A connection whose campaign is active and reachable is
 * deferred: revoking would delete the token and that campaign could never be paused. A connection that only backs unreachable
 * campaigns (expired, revoked or lapsed token) is revoked: nothing can be paused through it, and its stored token should go.
 * Never throws; failures are audited once, and the sweep retries them.
 */
async function revokeConnections(tenantId: string, userId: string): Promise<RevokeResult> {
  const result: RevokeResult = { done: 0, failed: 0, deferred: 0 };
  let ids: { id: string }[] = [];
  try {
    ids = await prisma.metaConnection.findMany({ where: { tenantId, status: { not: "revoked" } }, select: { id: true }, take: MAX_PER_RUN });
  } catch {
    return { done: 0, failed: 1, deferred: 0 };
  }
  if (!ids.length) return result;
  const inUse = await connectionsInUse(tenantId);
  const actor: Actor = { userId, tenantId, role: "admin" };
  for (const { id } of ids) {
    if (inUse === null || inUse.has(id)) {
      result.deferred++;
      continue;
    }
    try {
      await disconnect(actor, id);
      result.done++;
    } catch {
      result.failed++;
      await flagDisconnectFailure(tenantId, userId, id);
    }
  }
  return result;
}

/**
 * Ads first (pausing needs the Meta token), then, when asked, the Meta connections that no live campaign needs any more.
 * A connection whose campaign could not be paused is kept: revoking deletes the token and the campaign would keep spending with
 * no way to pause it. Best effort and never throws; the sweep retries what failed.
 */
export async function windDownTenant(tenantId: string, userId: string, opts: { revoke: boolean }): Promise<WindDownResult> {
  const ads = await pauseTenantAds(tenantId, userId).catch((): PauseResult => ({ done: 0, failed: 1, unreachable: 0 }));
  const meta = opts.revoke ? await revokeConnections(tenantId, userId).catch((): RevokeResult => ({ done: 0, failed: 1, deferred: 0 })) : { done: 0, failed: 0, deferred: 0 };
  return { paused: ads.done, pauseFailed: ads.failed, unreachable: ads.unreachable, revoked: meta.done, revokeFailed: meta.failed, deferred: meta.deferred };
}

/**
 * Workspaces that are suspended or deleted but still hold a Meta connection, even though none of their campaigns is active any
 * more: the connection could not be revoked at wind-down (disconnect failed) and would otherwise never be visited again. Bounded
 * (SWEEP_PAGES x SWEEP_PAGE connections) and best effort.
 */
async function inactiveTenantsWithConnections(): Promise<string[]> {
  const found: string[] = [];
  try {
    let after: string | undefined;
    for (let page = 0; page < SWEEP_PAGES; page++) {
      const rows = await prisma.metaConnection.findMany({
        where: { status: { not: "revoked" }, ...(after ? { tenantId: { gt: after } } : {}) },
        distinct: ["tenantId"],
        orderBy: { tenantId: "asc" },
        select: { tenantId: true },
        take: SWEEP_PAGE,
      });
      if (!rows.length) break;
      const inactive = await prisma.tenant.findMany({
        where: { id: { in: rows.map((r) => r.tenantId) }, OR: [{ status: "suspended" }, { deletedAt: { not: null } }] },
        select: { id: true },
      });
      found.push(...inactive.map((t) => t.id));
      if (rows.length < SWEEP_PAGE) break;
      after = rows[rows.length - 1].tenantId;
    }
  } catch {
    // The campaign-based part of the sweep still runs.
  }
  return found;
}

/**
 * Safety net for suspension, deletion and billing lock. Billing lock is computed on read and has no transition event, so this
 * sweep is what notices it; billing/worker.ts runs it every few minutes and the optimizer worker keeps its 15 minute copy.
 * It visits workspaces with a live campaign and also suspended or deleted workspaces that still hold a Meta connection (so a
 * revoke that failed once is retried, and an unusable connection behind an unreachable campaign is finally removed).
 * Idempotent: a workspace with nothing left costs a few reads; campaigns that are paused or unreachable cause no Meta call, and each
 * failure state is audited once (see flagFailure). A suspended or deleted workspace gets the connections that no live campaign
 * needs revoked; a billing-locked one keeps them so it can resume after paying. A campaign that stays unreachable stays active
 * here on purpose: if its connection is repaired, the next sweep pauses it.
 */
export async function pauseAdsForBlockedTenants(): Promise<{ tenants: number; paused: number; revoked: number; unreachable: number }> {
  const rows = await prisma.adCampaign.findMany({ where: { status: "active" }, distinct: ["tenantId"], select: { tenantId: true } });
  const withCampaigns = new Set(rows.map((r) => r.tenantId));
  const visit = [...withCampaigns, ...(await inactiveTenantsWithConnections()).filter((id) => !withCampaigns.has(id))];
  const total = { tenants: 0, paused: 0, revoked: 0, unreachable: 0 };
  const usable: string[] = [];
  for (const tenantId of visit) {
    const state = await blockedState(tenantId);
    if (!state) {
      if (withCampaigns.has(tenantId)) usable.push(tenantId);
      continue;
    }
    total.tenants++;
    const res = await windDownTenant(tenantId, SYSTEM_USER, { revoke: state === "inactive" });
    total.paused += res.paused;
    total.revoked += res.revoked;
    total.unreachable += res.unreachable;
  }
  await clearStaleFlags(usable);
  return total;
}
